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
  "POS-002,CLIENT-001,SEC-DEMO-002,债券,公共事业,500.00,2026-09-10\n";

async function request(base, path, body, key = "asset-api") {
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
}
async function waitForTask(base, id) {
  for (let index = 0; index < 100; index++) {
    const response = await request(base, `/assets/agent/tasks/${id}`);
    if (!["QUEUED", "RUNNING"].includes(response.body.status)) return response.body;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("资产Agent任务未完成");
}

test("V2 asset API searches lineage, executes metrics/standards and grounds Agent", async () => {
  const root = mkdtempSync(join(tmpdir(), "shuduo-assets-api-")),
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
    assetPlanner: async ({ assets }) => ({
      insight: {
        answer: "证券持仓落地表来自真实CSV同步，可用于持仓市值指标。",
        assetIds: [assets.find((asset) => asset.id === "landing:raw_positions").id],
        lineageFocusAssetId: "landing:raw_positions",
        caveats: ["当前只证明本机版本绑定血缘"],
      },
      model: "TEST_DOUBLE",
      usage: { total_tokens: 100 },
    }),
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}/api/v2`;
  try {
    const source = await request(
      base,
      "/sources",
      {
        name: "资产目录持仓源",
        sourceType: "LOCAL_CSV",
        fileName: "positions.csv",
      },
      "asset-source",
    );
    await request(base, `/sources/${source.body.id}/test`, {}, "asset-source-test");
    await request(base, `/sources/${source.body.id}/metadata`, {}, "asset-source-meta");
    const task = await request(
      base,
      "/sync/tasks",
      {
        name: "资产目录持仓落地",
        sourceId: source.body.id,
        targetTable: "raw_positions",
        mode: "FULL",
        mapping: identityPositionMapping,
        keyFields: ["position_id"],
        watermarkField: "trade_date",
      },
      "asset-sync-task",
    );
    await request(base, `/sync/tasks/${task.body.id}/run`, {}, "asset-sync-run");

    const search = await request(base, "/assets?q=market_value");
    assert.equal(search.status, 200);
    assert.ok(search.body.some((asset) => asset.id === "landing:raw_positions"));
    const encoded = encodeURIComponent("landing:raw_positions"),
      annotation = await request(
        base,
        `/assets/${encoded}/annotation`,
        {
          businessName: "证券持仓明细",
          description: "财富顾问资产分析使用的虚构持仓明细",
          domain: "财富管理",
          owner: "数据产品负责人",
          classification: "INTERNAL_DEMO",
          tags: ["持仓", "T+1"],
        },
        "asset-annotation",
      );
    assert.equal(annotation.status, 201);
    assert.equal(annotation.body.businessName, "证券持仓明细");
    const lineage = await request(base, `/assets/${encoded}/lineage`);
    assert.ok(lineage.body.edges.some((edge) => edge.type === "FULL"));

    const metric = await request(
        base,
        "/metrics",
        {
          name: "持仓市值",
          code: "holding_market_value",
          assetId: "landing:raw_positions",
          aggregation: "SUM",
          field: "market_value",
          groupBy: "asset_class",
          definition: "按资产类别汇总持仓明细market_value，不含现金",
        },
        "asset-metric",
      ),
      metricRun = await request(
        base,
        `/metrics/${metric.body.id}/run`,
        {},
        "asset-metric-run",
      );
    assert.equal(metricRun.body.status, "SUCCEEDED");
    assert.deepEqual(metricRun.body.values, [
      { group: "股票", value: "1000.00" },
      { group: "债券", value: "500.00" },
    ]);

    const standard = await request(
        base,
        "/standards",
        {
          name: "证券代码格式",
          code: "security_code_format",
          assetId: "landing:raw_positions",
          field: "security_code",
          semanticType: "SECURITY_CODE",
          description: "虚构证券代码必须使用SEC-前缀",
        },
        "asset-standard",
      ),
      check = await request(
        base,
        `/standards/${standard.body.id}/check`,
        {},
        "asset-standard-check",
      );
    assert.equal(check.body.status, "PASSED");
    assert.equal(check.body.evaluatedCount, 2);

    const started = await request(
        base,
        "/assets/agent/tasks",
        { message: "找出能计算持仓市值的资产并解释来源" },
        "asset-agent",
      ),
      completed = await waitForTask(base, started.body.id);
    assert.equal(started.status, 202);
    assert.equal(completed.status, "SUCCEEDED");
    assert.equal(completed.completionScope, "ASSET_DISCOVERY");
    assert.deepEqual(completed.insight.assetIds, ["landing:raw_positions"]);
    assert.equal(completed.fullLifecycleE2E, false);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    stateStore.close();
    landingStore.close();
    store.close();
  }
});
