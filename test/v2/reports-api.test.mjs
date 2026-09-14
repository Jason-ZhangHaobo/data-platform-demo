import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MetadataStore } from "../../src/v2/store.mjs";
import { LandingStore, identityPositionMapping } from "../../src/v2/ingestion.mjs";
import { StreamStateStore } from "../../src/v2/realtime.mjs";
import { ReportDataStore } from "../../src/v2/reports.mjs";
import { createV2Server } from "../../src/v2/server.mjs";

const csv =
  "position_id,client_id,security_code,asset_class,industry,market_value,trade_date\n" +
  "POS-001,CLIENT-001,SEC-DEMO-001,股票,金融,1000.00,2026-09-10\n" +
  "POS-002,CLIENT-001,SEC-DEMO-002,债券,公共事业,500.00,2026-09-10\n";
const widgets = [
  { id: "holding_value", type: "KPI", title: "持仓市值", aggregation: "SUM", field: "market_value" },
  { id: "asset_class_distribution", type: "PIE", title: "资产类别分布", aggregation: "SUM", field: "market_value", dimension: "asset_class" },
];

async function request(base, path, body, key = "reports-api") {
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
    const response = await request(base, `/reports/agent/plans/${id}`);
    if (!["QUEUED", "RUNNING"].includes(response.body.status)) return response.body;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("报表Agent方案未完成");
}

test("V2 report API materializes a snapshot, runs widgets, exports and applies Agent as draft", async () => {
  const root = mkdtempSync(join(tmpdir(), "shuzhan-reports-api-")),
    fixtureRoot = join(root, "sources"),
    streamRoot = join(root, "streams"),
    store = new MetadataStore(join(root, "platform.sqlite")),
    landingStore = new LandingStore(join(root, "landing.sqlite")),
    stateStore = new StreamStateStore(":memory:"),
    reportStore = new ReportDataStore(join(root, "reports.sqlite"));
  mkdirSync(fixtureRoot, { recursive: true });
  mkdirSync(streamRoot, { recursive: true });
  writeFileSync(join(fixtureRoot, "positions.csv"), csv);
  let datasetId;
  const app = createV2Server({
    store,
    landingStore,
    streamStateStore: stateStore,
    reportStore,
    fixtureRoot,
    streamFixtureRoot: streamRoot,
    env: { V2_LOCAL_DEVELOPMENT: "true" },
    reportPlanner: async ({ datasets }) => ({
      plan: {
        kind: "REPORT",
        name: "Agent持仓结构报告",
        code: "agent_holdings_report",
        datasetId: datasets[0].id,
        description: "基于已就绪数据集生成聚合报告草稿",
        widgets,
      },
      explanation: "只生成草稿，不运行或导出",
      model: "TEST_DOUBLE",
      usage: { total_tokens: 140 },
    }),
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}/api/v2`;
  try {
    const source = await request(base, "/sources", {
      name: "报表API持仓源",
      sourceType: "LOCAL_CSV",
      fileName: "positions.csv",
    }, "report-source");
    await request(base, `/sources/${source.body.id}/test`, {}, "report-source-test");
    await request(base, `/sources/${source.body.id}/metadata`, {}, "report-source-meta");
    const sync = await request(base, "/sync/tasks", {
      name: "报表API持仓落地",
      sourceId: source.body.id,
      targetTable: "report_positions",
      mode: "FULL",
      mapping: identityPositionMapping,
      keyFields: ["position_id"],
      watermarkField: "trade_date",
    }, "report-sync");
    await request(base, `/sync/tasks/${sync.body.id}/run`, {}, "report-sync-run");

    const dataset = await request(base, "/reports/datasets", {
      name: "报表API数据集",
      code: "report_api_dataset",
      assetId: "landing:report_positions",
      fields: ["security_code", "asset_class", "market_value"],
    }, "report-dataset");
    datasetId = dataset.body.id;
    assert.equal(dataset.body.status, "DRAFT");
    const refreshed = await request(
      base,
      `/reports/datasets/${dataset.body.id}/refresh`,
      {},
      "report-refresh",
    );
    assert.equal(refreshed.body.currentSnapshot.rowCount, 2);
    const report = await request(base, "/reports", {
        name: "持仓结构报告",
        code: "holdings_structure",
        datasetId: dataset.body.id,
        description: "实际聚合持仓市值和资产类别",
        widgets,
      }, "report-create"),
      run = await request(
        base,
        `/reports/${report.body.id}/run`,
        {},
        "report-run",
      );
    assert.equal(run.body.status, "VERIFIED_LOCAL");
    assert.equal(run.body.runs[0].widgets[0].value, "1500.00");
    const exported = await request(base, `/reports/${report.body.id}/export`);
    assert.match(exported.body.content, /holding_value,持仓市值,ALL,1500\.00/);
    assert.doesNotMatch(exported.body.content, /CLIENT|POS-/);

    const started = await request(
        base,
        "/reports/agent/plans",
        { message: "基于当前数据集生成持仓结构报表草稿" },
        "report-agent",
      ),
      complete = await waitForPlan(base, started.body.id);
    assert.equal(complete.status, "SUCCEEDED");
    assert.equal(complete.completionScope, "REPORT_DESIGN");
    assert.equal(store.list("report", "project-securities-lab").length, 1);
    const applied = await request(
      base,
      `/reports/agent/plans/${complete.id}/apply`,
      {},
      "report-agent-apply",
    );
    assert.equal(applied.status, 201);
    assert.equal(applied.body.runs.length, 0);
    assert.equal(store.list("report", "project-securities-lab").length, 2);
    const overview = await request(base, "/reports/overview");
    assert.equal(overview.body.counts.readyDatasets, 1);
    assert.equal(overview.body.counts.verifiedReports, 1);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    reportStore.close();
    stateStore.close();
    landingStore.close();
    store.close();
  }
});
