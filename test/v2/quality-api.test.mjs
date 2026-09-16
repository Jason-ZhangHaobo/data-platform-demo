import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MetadataStore } from "../../src/v2/store.mjs";
import { LandingStore, identityPositionMapping } from "../../src/v2/ingestion.mjs";
import { StreamStateStore } from "../../src/v2/realtime.mjs";
import { createV2Server } from "../../src/v2/server.mjs";

const csv =
  "position_id,client_id,security_code,asset_class,industry,market_value,trade_date\n" +
  "POS-001,CLIENT-001,SEC-DEMO-001,股票,金融,1000.00,2026-09-10\n" +
  "POS-002,CLIENT-001,SEC-DEMO-002,债券,公共事业,9000.00,2026-09-10\n";

async function request(base, path, body, key = "quality-api") {
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shuzhan-Client": "workbench",
      "Idempotency-Key": key,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
async function waitForPlan(base, id) {
  for (let index = 0; index < 100; index++) {
    const response = await request(base, `/quality/agent/plans/${id}`);
    if (!["QUEUED", "RUNNING"].includes(response.body.status)) return response.body;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("质量Agent方案未完成");
}

test("V2 quality API retains failure, versioned recovery, alerts and Agent draft boundary", async () => {
  const root = mkdtempSync(join(tmpdir(), "shuzhan-quality-api-")),
    fixtureRoot = join(root, "sources"),
    streamRoot = join(root, "streams"),
    store = new MetadataStore(join(root, "platform.sqlite")),
    landingStore = new LandingStore(join(root, "landing.sqlite")),
    stateStore = new StreamStateStore(":memory:");
  mkdirSync(fixtureRoot, { recursive: true });
  mkdirSync(streamRoot, { recursive: true });
  writeFileSync(join(fixtureRoot, "positions.csv"), csv);
  const app = createV2Server({
    store,
    landingStore,
    streamStateStore: stateStore,
    fixtureRoot,
    streamFixtureRoot: streamRoot,
    env: { V2_LOCAL_DEVELOPMENT: "true" },
    qualityPlanner: async ({ assets }) => ({
      plan: {
        kind: "QUALITY_RULE",
        name: "Agent证券代码非空",
        code: "agent_security_code_not_null",
        assetId: assets.find((asset) => asset.id === "landing:quality_positions").id,
        field: "security_code",
        type: "NOT_NULL",
        config: {},
        description: "证券代码必须存在",
      },
      explanation: "依据字段元数据生成，不自动执行",
      model: "TEST_DOUBLE",
      usage: { total_tokens: 120 },
    }),
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}/api/v2`;
  try {
    const source = await request(
      base,
      "/sources",
      { name: "质量API持仓源", sourceType: "LOCAL_CSV", fileName: "positions.csv" },
      "quality-source",
    );
    await request(base, `/sources/${source.body.id}/test`, {}, "quality-test");
    await request(base, `/sources/${source.body.id}/metadata`, {}, "quality-meta");
    const sync = await request(
      base,
      "/sync/tasks",
      {
        name: "质量API持仓落地",
        sourceId: source.body.id,
        targetTable: "quality_positions",
        mode: "FULL",
        mapping: identityPositionMapping,
        keyFields: ["position_id"],
        watermarkField: "trade_date",
      },
      "quality-sync",
    );
    await request(base, `/sync/tasks/${sync.body.id}/run`, {}, "quality-sync-run");

    const created = await request(
        base,
        "/quality/rules",
        {
          name: "持仓市值合理范围",
          code: "holding_value_range",
          assetId: "landing:quality_positions",
          field: "market_value",
          type: "VALUE_RANGE",
          config: { min: "0.00", max: "5000.00" },
          description: "受控低阈值用于验证失败",
        },
        "quality-rule",
      ),
      failed = await request(
        base,
        `/quality/rules/${created.body.id}/run`,
        {},
        "quality-fail-run",
      );
    assert.equal(created.status, 201);
    assert.equal(failed.body.health, "FAILED");
    assert.equal(failed.body.runs[0].failedCount, 1);
    assert.equal(failed.body.alerts[0].status, "OPEN");

    const versioned = await request(
        base,
        `/quality/rules/${created.body.id}/versions`,
        {
          config: { min: "0.00", max: "10000.00" },
          description: "校准后允许当前虚构持仓范围",
        },
        "quality-version",
      ),
      recovered = await request(
        base,
        `/quality/rules/${created.body.id}/run`,
        {},
        "quality-recovery-run",
      );
    assert.equal(versioned.body.currentVersion.versionNumber, 2);
    assert.equal(recovered.body.health, "HEALTHY");
    assert.equal(recovered.body.runs[0].status, "PASSED");
    assert.equal(recovered.body.alerts[0].status, "RESOLVED");
    assert.equal(recovered.body.runs.length, 2);

    const started = await request(
        base,
        "/quality/agent/plans",
        { message: "为证券代码生成非空质量规则草稿" },
        "quality-agent",
      ),
      complete = await waitForPlan(base, started.body.id);
    assert.equal(complete.status, "SUCCEEDED");
    assert.equal(complete.completionScope, "QUALITY_RULE_DESIGN");
    assert.equal(complete.fullLifecycleE2E, false);
    assert.equal(store.list("quality_rule", "project-securities-lab").length, 1);
    const applied = await request(
      base,
      `/quality/agent/plans/${complete.id}/apply`,
      {},
      "quality-agent-apply",
    );
    assert.equal(applied.status, 201);
    assert.equal(applied.body.runs.length, 0);
    assert.equal(store.list("quality_rule", "project-securities-lab").length, 2);
    const overview = await request(base, "/quality/overview");
    assert.equal(overview.body.counts.rules, 2);
    assert.equal(overview.body.counts.openAlerts, 0);
    assert.equal(overview.body.counts.resolvedAlerts, 1);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    stateStore.close();
    landingStore.close();
    store.close();
  }
});
