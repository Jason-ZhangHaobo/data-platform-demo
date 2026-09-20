import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getContext, contextIds } from "../../src/v2/context.mjs";
import {
  pythonRuntimeConfig,
  runRestrictedPython,
} from "../../src/v2/python.mjs";

const python = process.env.V2_PYTHON ?? "python3";
const config = () => ({
  python,
  root: process.cwd(),
  artifactRoot: mkdtempSync(join(tmpdir(), "shuduo-python-")),
  retainArtifacts: false,
  requireMemoryLimit: false,
  available: true,
});

const code = `def transform(data, params):
    allowed = set()
    for row in data["accounts"]:
        if row["advisor_id"] == params["advisor_id"]:
            allowed.add(row["client_id"])
    position_totals = {}
    securities = {}
    seen = set()
    for row in data["positions"]:
        if row["client_id"] in allowed and row["trade_date"] == params["business_date"] and row["position_id"] not in seen:
            seen.add(row["position_id"])
            client_id = row["client_id"]
            position_totals[client_id] = position_totals.get(client_id, Decimal("0")) + Decimal(row.get("market_value") or "0")
            securities.setdefault(client_id, set()).add(row["security_code"])
    cash_totals = {}
    for row in data["cash"]:
        if row["client_id"] in allowed and row["trade_date"] == params["business_date"]:
            client_id = row["client_id"]
            cash_totals[client_id] = cash_totals.get(client_id, Decimal("0")) + Decimal(row.get("available_cash") or "0")
    result = []
    for client_id in sorted(allowed):
        holding = position_totals.get(client_id, Decimal("0"))
        cash = cash_totals.get(client_id, Decimal("0"))
        result.append({"client_id": client_id, "holding_market_value": holding, "available_cash": cash, "total_assets": holding + cash, "security_count": len(securities.get(client_id, set()))})
    return result`;

test("PATH Python resolution is test-only and fails closed by default", () => {
  assert.equal(
    pythonRuntimeConfig({ V2_PYTHON: "python3" }, process.cwd()).available,
    false,
  );
  assert.equal(
    pythonRuntimeConfig(
      { V2_PYTHON: "python3", V2_ALLOW_PATH_PYTHON: "true" },
      process.cwd(),
    ).available,
    true,
  );
});

test("restricted Python executes real customer-asset logic across five fixtures", async () => {
  const result = await runRestrictedPython(
    {
      code,
      context: getContext("holdings-t1"),
      validationContexts: contextIds.map(getContext),
    },
    config(),
  );
  assert.equal(result.status, "SUCCEEDED");
  assert.equal(result.engine, "CPython");
  assert.equal(result.validation.passed, true);
  assert.equal(result.validation.regressions.length, 5);
  assert.ok(result.validation.regressions.every((item) => item.passed));
  assert.deepEqual(result.rows[0], getContext("holdings-t1").expected[0]);
  assert.equal("directory" in result, false);
  assert.equal(result.resourceLimits.cpu, true);
  assert.equal(typeof result.resourceLimits.addressSpace, "boolean");
});

test("restricted Python rejects imports and unsafe builtins before execution", async () => {
  const unsafe = `def transform(data, params):
    import os
    return open("/tmp/private", "w")`;
  const result = await runRestrictedPython(
    { code: unsafe, context: getContext(), validationContexts: [] },
    config(),
  );
  assert.equal(result.status, "FAILED");
  assert.match(result.error, /不允许的语法：Import/);
  assert.equal(result.error.includes("/tmp/private"), false);
});

test("restricted Python names the rejected identifier without echoing code", async () => {
  const result = await runRestrictedPython(
    {
      code: `def transform(data, params):
    value = print(params.get("advisor_id"))
    return []`,
      context: getContext("holdings-t1"),
      validationContexts: contextIds.map(getContext),
    },
    config(),
  );
  assert.equal(result.status, "FAILED");
  assert.equal(result.error, "Python代码调用了不允许的函数：print");
  assert.equal(result.error.includes("advisor_id"), false);
});

test("restricted Python marks incorrect business output as validation failure", async () => {
  const wrong = `def transform(data, params):
    return [{"client_id": "CLIENT-001", "holding_market_value": "1.00", "available_cash": "2.00", "total_assets": "3.00", "security_count": 1}]`;
  const result = await runRestrictedPython(
    { code: wrong, context: getContext(), validationContexts: [] },
    config(),
  );
  assert.equal(result.status, "VALIDATION_FAILED");
  assert.equal(result.validation.passed, false);
  assert.ok(result.validation.issues.length > 0);
});

test("restricted Python cancellation terminates the subprocess", async () => {
  const slow = `def transform(data, params):
    total = 0
    for first in range(10000):
        for second in range(10000):
            total += first + second
    return []`,
    controller = new AbortController(),
    running = runRestrictedPython(
      {
        code: slow,
        context: getContext(),
        validationContexts: [],
        signal: controller.signal,
        timeoutMs: 5000,
      },
      config(),
    );
  setTimeout(() => controller.abort(), 25);
  await assert.rejects(running, /运行已取消/);
});
