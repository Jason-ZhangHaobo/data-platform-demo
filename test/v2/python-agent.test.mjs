import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createV2Server, PROJECT } from "../../src/v2/server.mjs";
import { MetadataStore } from "../../src/v2/store.mjs";
import { getContext } from "../../src/v2/context.mjs";
import { generatePython } from "../../src/v2/model.mjs";

const code = `def transform(data, params):
    return [{"client_id": "C1", "holding_market_value": Decimal("150"), "available_cash": Decimal("25"), "total_assets": Decimal("175"), "security_count": 2}]`;

const eventually = async (read, status) => {
  for (let attempt = 0; attempt < 80; attempt++) {
    const value = await read();
    if (value.body.status === status) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`等待Python Agent达到${status}超时`);
};

async function setup(options = {}) {
  const root = mkdtempSync(join(tmpdir(), "shuduo-python-agent-")),
    store = new MetadataStore(join(root, "metadata.sqlite")),
    app = createV2Server({
      root,
      store,
      env: { V2_LOCAL_DEVELOPMENT: "true" },
      ...options,
    });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}/api/v2`,
    call = async (path, body, key = "python-agent-test") => {
      const response = await fetch(base + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shuduo-Client": "workbench",
          "Idempotency-Key": key,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    };
  return {
    store,
    call,
    close: async () => {
      await new Promise((resolve) => app.server.close(resolve));
      store.close();
    },
  };
}

test("Python Agent creates a model revision and passes five governed assertions", async () => {
  const app = await setup({
    releaseTimeUnitMs: 5,
    pythonGenerator: async () => ({
      code,
      explanation: "按position_id去重并独立聚合现金",
      model: "TEST_PYTHON_MODEL",
      usage: { total_tokens: 120 },
    }),
    pythonRunner: async () => ({
      status: "SUCCEEDED",
      engine: "CPython",
      engineVersion: "3.12.14",
      rows: [{ client_id: "C1" }],
      validation: {
        passed: true,
        issues: [],
        regressions: [
          "holdings-t1",
          "cash-change",
          "duplicate-position",
          "equal-value-positions",
          "cash-only-client",
        ].map((contextId) => ({ contextId, passed: true })),
      },
      resourceLimits: { cpu: true, addressSpace: true, fileSize: true },
    }),
  });
  try {
    const created = await app.call("/agent/tasks", {
      message: "用Python加工客户资产并验证五套证券场景",
      language: "PYTHON",
      code,
      contextId: "holdings-t1",
    });
    assert.equal(created.status, 202);
    const completed = await eventually(
      () => app.call(`/agent/tasks/${created.body.id}`),
      "SUCCEEDED",
    );
    assert.equal(completed.body.language, "PYTHON");
    assert.equal(completed.body.completionScope, "PYTHON_DEVELOPMENT");
    assert.equal(completed.body.fullLifecycleE2E, false);
    assert.equal(completed.body.attempts.length, 1);
    const revisions = app.store.list("python_revision", PROJECT),
      runs = app.store.list("python_run", PROJECT);
    assert.equal(revisions.length, 1);
    assert.equal(revisions[0].source, "LIVE_MODEL");
    assert.equal(runs.length, 1);
    assert.equal(runs[0].validation.regressions.length, 5);
    const journey = await app.call(`/agent/tasks/${created.body.id}/journey`);
    assert.equal(journey.status, 200);
    assert.equal(
      journey.body.stages.find((item) => item.id === "CODE").status,
      "SUCCEEDED",
    );
    assert.equal(
      journey.body.stages.find((item) => item.id === "DEBUG").status,
      "SUCCEEDED",
    );
    assert.equal(journey.body.localEvidenceComplete, false);
    const delivery = await app.call(
      `/agent/tasks/${created.body.id}/prepare-delivery`,
      {},
      "python-delivery-package",
    );
    assert.equal(delivery.status, 202);
    const prepared = await eventually(
      () => app.call(`/agent/deliveries/${delivery.body.id}`),
      "SUCCEEDED",
    );
    assert.equal(prepared.body.completionScope, "PYTHON_DELIVERY_PREPARATION");
    assert.equal(prepared.body.publicDeployed, false);
    const packages = app.store.list("delivery_package", PROJECT),
      verifications = app.store.list("delivery_verification", PROJECT);
    assert.equal(packages.length, 1);
    assert.equal(packages[0].manifest.format, "shuduo-python-delivery/v1");
    assert.equal(packages[0].releaseEligible, true);
    assert.equal(packages[0].publicReleaseEligible, false);
    assert.equal(verifications[0].mode, "LOCAL_PYTHON_FILE_REHEARSAL");
    const completedJourney = await app.call(
      `/agent/tasks/${created.body.id}/journey`,
    );
    assert.equal(
      completedJourney.body.stages.find((item) => item.id === "SCHEDULE_FILE")
        .status,
      "SUCCEEDED",
    );
    assert.equal(
      completedJourney.body.stages.find((item) => item.id === "DEPLOY_FILE")
        .status,
      "SUCCEEDED",
    );
    assert.equal(completedJourney.body.localEvidenceComplete, false);
    const review = await app.call(
        `/delivery/packages/${packages[0].id}/review`,
        {
          packageDigest: packages[0].digest,
          verificationId: verifications[0].id,
          reviewNote: "已审阅Python代码、五套断言与本机范围",
          attestations: {
            code: true,
            assertions: true,
            deliveryFiles: true,
            localScope: true,
          },
        },
        "python-review",
      ),
      approval = await app.call(
        `/delivery/packages/${packages[0].id}/approve`,
        {
          packageDigest: packages[0].digest,
          reviewId: review.body.id,
        },
        "python-approval",
      ),
      release = await app.call(
        "/releases",
        {
          approvalId: approval.body.id,
          triggerAfterSeconds: 1,
          intervalSeconds: 1,
          runCount: 2,
        },
        "python-release",
      );
    assert.equal(review.status, 201);
    assert.equal(approval.status, 201);
    assert.equal(release.status, 201);
    assert.equal(release.body.publicDeployed, false);
    let releaseRuns = [];
    for (let attempt = 0; attempt < 100; attempt++) {
      releaseRuns = (await app.call("/release/runs")).body.filter(
        (item) => item.releaseId === release.body.id,
      );
      if (
        releaseRuns.length === 2 &&
        releaseRuns.every((item) => item.status === "SUCCEEDED")
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(releaseRuns.length, 2);
    assert.equal(
      releaseRuns.every(
        (item) =>
          item.status === "SUCCEEDED" &&
          item.engine === "CPython" &&
          item.schedulerTriggered === true,
      ),
      true,
    );
    const monitoring = await app.call("/monitoring/overview"),
      finalJourney = await app.call(`/agent/tasks/${created.body.id}/journey`);
    assert.equal(monitoring.body.counts.succeeded >= 2, true);
    assert.equal(monitoring.body.counts.openAlerts, 0);
    assert.equal(finalJourney.body.localEvidenceComplete, true);
    assert.equal(finalJourney.body.agentIndependentE2E, false);
    assert.equal(finalJourney.body.publicDeployed, false);
  } finally {
    await app.close();
  }
});

test("Python model adapter sends schema but never independent expected rows", async () => {
  let request;
  const result = await generatePython(
    {
      message: "生成客户资产Python加工",
      context: getContext("holdings-t1"),
      currentCode: code,
      remainingBudget: 20_000,
    },
    {
      DASHSCOPE_API_KEY: "sk-synthetic-key-for-test",
      V2_MODEL: "synthetic-model",
    },
    async (_url, init) => {
      request = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  code,
                  explanation: "受限Python加工",
                }),
              },
            },
          ],
          usage: { total_tokens: 100 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  );
  assert.equal(result.code, code);
  assert.equal(JSON.stringify(request).includes("expected"), false);
  assert.match(JSON.stringify(request), /transform\(data, params\)/);
  assert.match(JSON.stringify(request), /禁止import/);
});
