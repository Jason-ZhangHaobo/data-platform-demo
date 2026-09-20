import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createV2Server } from "../../src/v2/server.mjs";
import { MetadataStore } from "../../src/v2/store.mjs";

const code = `def transform(data, params):
    allowed = set()
    for row in data["accounts"]:
        if row["advisor_id"] == params["advisor_id"]:
            allowed.add(row["client_id"])
    holdings = {}
    securities = {}
    seen = set()
    for row in data["positions"]:
        if row["client_id"] in allowed and row["trade_date"] == params["business_date"] and row["position_id"] not in seen:
            seen.add(row["position_id"])
            client_id = row["client_id"]
            holdings[client_id] = holdings.get(client_id, Decimal("0")) + Decimal(row.get("market_value") or "0")
            securities.setdefault(client_id, set()).add(row["security_code"])
    cash = {}
    for row in data["cash"]:
        if row["client_id"] in allowed and row["trade_date"] == params["business_date"]:
            client_id = row["client_id"]
            cash[client_id] = cash.get(client_id, Decimal("0")) + Decimal(row.get("available_cash") or "0")
    result = []
    for client_id in sorted(allowed):
        holding = holdings.get(client_id, Decimal("0"))
        available = cash.get(client_id, Decimal("0"))
        result.append({"client_id": client_id, "holding_market_value": holding, "available_cash": available, "total_assets": holding + available, "security_count": len(securities.get(client_id, set()))})
    return result`;

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "shuduo-python-api-")),
    store = new MetadataStore(join(root, "platform.sqlite")),
    app = createV2Server({
      root: process.cwd(),
      store,
      env: {
        V2_LOCAL_DEVELOPMENT: "true",
        V2_PYTHON:
          process.env.V2_PYTHON ??
          join(process.cwd(), ".runtime/python/bin/python"),
        V2_ARTIFACT_ROOT: root,
      },
    });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}/api/v2`;
  let sequence = 0;
  const call = async (path, body) => {
    const response = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shuduo-Client": "workbench",
        "Idempotency-Key": `python-api-${++sequence}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  return {
    call,
    close: async () => {
      await new Promise((resolve) => app.server.close(resolve));
      store.close();
    },
  };
}

async function waitFor(call, id, statuses) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const current = await call(`/python/runs/${id}`);
    if (statuses.includes(current.body.status)) return current.body;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("等待Python运行超时");
}

test("Python API versions and executes real securities code with five assertions", async () => {
  const app = await setup();
  try {
    const revision = await app.call("/python/revisions", {
      code,
      contextId: "holdings-t1",
    });
    assert.equal(revision.status, 201);
    assert.equal(revision.body.language, "PYTHON");
    assert.equal(revision.body.executionScope, "LOCAL_RESTRICTED_PYTHON");
    const created = await app.call("/python/runs", {
      revisionId: revision.body.id,
    });
    assert.equal(created.status, 202);
    const completed = await waitFor(app.call, created.body.id, [
      "SUCCEEDED",
      "FAILED",
      "VALIDATION_FAILED",
    ]);
    assert.equal(completed.status, "SUCCEEDED");
    assert.equal(completed.validation.passed, true);
    assert.equal(completed.validation.regressions.length, 5);
    assert.equal(completed.publicDeployed, false);
    assert.equal((await app.call("/python/revisions")).body.length, 1);
    assert.equal((await app.call("/python/runs")).body.length, 1);
  } finally {
    await app.close();
  }
});

test("Python API retains unsafe-code failure and cancels a running subprocess", async () => {
  const app = await setup();
  try {
    const unsafeRevision = await app.call("/python/revisions", {
        code: `def transform(data, params):
    import os
    return []`,
        contextId: "holdings-t1",
      }),
      unsafeRun = await app.call("/python/runs", {
        revisionId: unsafeRevision.body.id,
      }),
      failed = await waitFor(app.call, unsafeRun.body.id, ["FAILED"]);
    assert.match(failed.error, /不允许的语法：Import/);

    const slowRevision = await app.call("/python/revisions", {
        code: `def transform(data, params):
    total = 0
    for first in range(10000):
        for second in range(10000):
            total += first + second
    return []`,
        contextId: "holdings-t1",
      }),
      slowRun = await app.call("/python/runs", {
        revisionId: slowRevision.body.id,
      });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const cancelled = await app.call(
      `/python/runs/${slowRun.body.id}/cancel`,
      {},
    );
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.status, "CANCELLED");
    const retained = await waitFor(app.call, slowRun.body.id, ["CANCELLED"]);
    assert.equal(retained.status, "CANCELLED");
  } finally {
    await app.close();
  }
});
