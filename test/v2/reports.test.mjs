import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MetadataStore } from "../../src/v2/store.mjs";
import {
  IngestionManager,
  LandingStore,
  identityPositionMapping,
} from "../../src/v2/ingestion.mjs";
import { StreamStateStore } from "../../src/v2/realtime.mjs";
import { BusinessQueryStore, DataServiceManager } from "../../src/v2/data-services.mjs";
import { AssetCatalogManager } from "../../src/v2/assets.mjs";
import { ReportDataStore, ReportManager } from "../../src/v2/reports.mjs";
import { generateReportPlan } from "../../src/v2/model.mjs";
import { PROJECT } from "../../src/v2/server.mjs";

const csv =
  "position_id,client_id,security_code,asset_class,industry,market_value,trade_date\n" +
  "POS-001,CLIENT-001,SEC-DEMO-001,股票,金融,1000.00,2026-09-10\n" +
  "POS-002,CLIENT-001,SEC-DEMO-002,债券,公共事业,500.00,2026-09-10\n" +
  "POS-003,CLIENT-002,SEC-DEMO-003,基金,多元金融,750.00,2026-09-10\n" +
  "POS-004,CLIENT-003,SEC-DEMO-004,股票,信息技术,9000.00,2026-09-10\n";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "shuzhan-reports-")),
    fixtureRoot = join(root, "sources"),
    store = new MetadataStore(join(root, "platform.sqlite")),
    landingStore = new LandingStore(join(root, "landing.sqlite")),
    stateStore = new StreamStateStore(":memory:"),
    reportStore = new ReportDataStore(join(root, "reports.sqlite")),
    businessStore = new BusinessQueryStore(":memory:");
  mkdirSync(fixtureRoot, { recursive: true });
  writeFileSync(join(fixtureRoot, "positions.csv"), csv);
  const ingestion = new IngestionManager({
      store,
      landingStore,
      project: PROJECT,
      fixtureRoot,
    }),
    source = ingestion.createSource({
      name: "报表测试持仓源",
      sourceType: "LOCAL_CSV",
      fileName: "positions.csv",
    });
  ingestion.testConnection(source.id);
  ingestion.collectMetadata(source.id);
  const task = ingestion.createTask({
    name: "报表测试持仓落地",
    sourceId: source.id,
    targetTable: "report_positions",
    mode: "FULL",
    mapping: identityPositionMapping,
    keyFields: ["position_id"],
    watermarkField: "trade_date",
  });
  ingestion.runTask(task.id);
  const dataServices = new DataServiceManager({
      store,
      businessStore,
      project: PROJECT,
      releaseRunFor: () => undefined,
    }),
    assets = new AssetCatalogManager({
      store,
      landingStore,
      stateStore,
      dataServices,
      project: PROJECT,
    }),
    reports = new ReportManager({
      store,
      reportStore,
      assets,
      project: PROJECT,
    });
  return {
    store,
    landingStore,
    stateStore,
    reportStore,
    businessStore,
    assets,
    reports,
    close() {
      businessStore.close();
      reportStore.close();
      stateStore.close();
      landingStore.close();
      store.close();
    },
  };
}

const widgets = [
  {
    id: "holding_value",
    type: "KPI",
    title: "持仓市值",
    aggregation: "SUM",
    field: "market_value",
  },
  {
    id: "security_count",
    type: "KPI",
    title: "证券数量",
    aggregation: "COUNT_DISTINCT",
    field: "security_code",
  },
  {
    id: "asset_class_distribution",
    type: "PIE",
    title: "资产类别分布",
    aggregation: "SUM",
    field: "market_value",
    dimension: "asset_class",
  },
  {
    id: "industry_distribution",
    type: "BAR",
    title: "行业分布",
    aggregation: "SUM",
    field: "market_value",
    dimension: "industry",
  },
];

test("report dataset snapshots actual rows and renders four securities widgets", () => {
  const app = setup();
  try {
    const dataset = app.reports.createDataset({
      name: "证券持仓报表数据集",
      code: "holdings_report_dataset",
      assetId: "landing:report_positions",
      fields: [
        "client_id",
        "security_code",
        "asset_class",
        "industry",
        "market_value",
        "trade_date",
      ],
    });
    assert.equal(dataset.status, "DRAFT");
    const ready = app.reports.refreshDataset(dataset.id);
    assert.equal(ready.status, "READY");
    assert.equal(ready.currentSnapshot.rowCount, 4);
    assert.equal(ready.currentSnapshot.actualMaterialization, true);
    const report = app.reports.createReport({
        name: "财富顾问持仓结构报告",
        code: "advisor_holdings_structure",
        datasetId: dataset.id,
        description: "展示虚构证券持仓市值、证券数、资产类别和行业分布",
        widgets,
      }),
      executed = app.reports.runReport(report.id),
      byId = new Map(executed.run.widgets.map((widget) => [widget.id, widget]));
    assert.equal(executed.run.status, "SUCCEEDED");
    assert.equal(byId.get("holding_value").value, "11250.00");
    assert.equal(byId.get("security_count").value, "4");
    assert.deepEqual(byId.get("asset_class_distribution").series, [
      { group: "股票", value: "10000.00" },
      { group: "基金", value: "750.00" },
      { group: "债券", value: "500.00" },
    ]);
    assert.equal(executed.report.status, "VERIFIED_LOCAL");
    assert.equal(executed.run.publicDeployed, false);
    const exported = app.reports.exportReport(report.id);
    assert.match(exported.content, /持仓市值,ALL,11250\.00/);
    assert.match(exported.content, /资产类别分布,股票,10000\.00/);
    assert.doesNotMatch(exported.content, /CLIENT-001|POS-001/);
    assert.equal(exported.contentHash.length, 64);
  } finally {
    app.close();
  }
});

test("report definitions reject unknown fields and unrefreshed datasets", () => {
  const app = setup();
  try {
    const dataset = app.reports.createDataset({
      name: "待刷新报表数据集",
      code: "unready_report_dataset",
      assetId: "landing:report_positions",
      fields: ["market_value", "asset_class"],
    });
    assert.throws(
      () =>
        app.reports.createReport({
          name: "未就绪报表",
          code: "unready_report",
          datasetId: dataset.id,
          description: "数据集未刷新时不能创建",
          widgets: [widgets[0]],
        }),
      { status: 409, code: "REPORT_DATASET_NOT_READY" },
    );
    app.reports.refreshDataset(dataset.id);
    assert.throws(
      () =>
        app.reports.createReport({
          name: "未知字段报表",
          code: "unknown_report_field",
          datasetId: dataset.id,
          description: "不得引用数据集以外字段",
          widgets: [{ ...widgets[0], field: "total_assets" }],
        }),
      { status: 400, code: "REPORT_FIELD_NOT_FOUND" },
    );
  } finally {
    app.close();
  }
});

test("identifier dimensions are masked before report results and export", () => {
  const app = setup();
  try {
    const dataset = app.reports.createDataset({
      name: "客户持仓聚合数据集",
      code: "client_holdings_dataset",
      assetId: "landing:report_positions",
      fields: ["client_id", "market_value"],
    });
    app.reports.refreshDataset(dataset.id);
    const report = app.reports.createReport({
        name: "客户持仓分布",
        code: "client_holdings_distribution",
        datasetId: dataset.id,
        description: "客户标识必须在聚合输出前脱敏",
        widgets: [
          {
            id: "client_distribution",
            type: "BAR",
            title: "客户持仓分布",
            aggregation: "SUM",
            field: "market_value",
            dimension: "client_id",
          },
        ],
      }),
      executed = app.reports.runReport(report.id),
      series = executed.run.widgets[0].series,
      exported = app.reports.exportReport(report.id);
    assert.deepEqual(series, [
      { group: "CLI***001", value: "1500.00" },
      { group: "CLI***002", value: "750.00" },
      { group: "CLI***003", value: "9000.00" },
    ]);
    assert.doesNotMatch(JSON.stringify(executed.run), /CLIENT-00/);
    assert.doesNotMatch(exported.content, /CLIENT-00/);
  } finally {
    app.close();
  }
});

test("report Agent plan is pinned to a ready dataset snapshot", () => {
  const app = setup();
  try {
    const dataset = app.reports.createDataset({
      name: "Agent持仓数据集",
      code: "agent_holdings_dataset",
      assetId: "landing:report_positions",
      fields: ["security_code", "asset_class", "market_value"],
    });
    app.reports.refreshDataset(dataset.id);
    const proposal = app.reports.validateAgentPlan({
      kind: "REPORT",
      name: "Agent持仓报告",
      code: "agent_holdings_report",
      datasetId: dataset.id,
      description: "聚合展示持仓市值与资产类别分布",
      widgets: [widgets[0], widgets[2]],
    });
    assert.equal(proposal.datasetSnapshotId, app.reports.datasetDetail(dataset.id).currentSnapshotId);
    assert.throws(
      () =>
        app.reports.validateAgentPlan({
          kind: "REPORT",
          name: "Agent错误报告",
          code: "agent_invalid_report",
          datasetId: dataset.id,
          description: "不得引用未知维度",
          widgets: [{ ...widgets[2], dimension: "real_customer_name" }],
        }),
      { status: 400, code: "REPORT_DIMENSION_NOT_FOUND" },
    );
  } finally {
    app.close();
  }
});

test("report model adapter never receives dataset rows", async () => {
  let requestBody;
  const generated = await generateReportPlan(
    {
      message: "生成持仓结构报告",
      datasets: [
        {
          id: "dataset-id",
          name: "持仓数据集",
          code: "holdings",
          assetId: "landing:report_positions",
          fields: ["asset_class", "market_value"],
          rowCount: 4,
          snapshotId: "snapshot-id",
          contentHash: "abc",
          rows: [{ client_id: "CLIENT-SHOULD-NOT-LEAK" }],
        },
      ],
      reports: [],
    },
    { DASHSCOPE_API_KEY: "sk-test", V2_MODEL: "test-model" },
    async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  kind: "REPORT",
                  name: "持仓结构报告",
                  code: "holdings_structure",
                  datasetId: "dataset-id",
                  description: "展示资产类别持仓市值",
                  widgets: [widgets[2]],
                  explanation: "按资产类别聚合",
                }),
              },
            },
          ],
          usage: { total_tokens: 250 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  );
  const sent = requestBody.messages[1].content;
  assert.match(sent, /dataset-id/);
  assert.doesNotMatch(sent, /CLIENT-SHOULD-NOT-LEAK/);
  assert.equal(generated.plan.kind, "REPORT");
});
