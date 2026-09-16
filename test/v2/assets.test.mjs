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
import { RealtimeManager, StreamStateStore } from "../../src/v2/realtime.mjs";
import { BusinessQueryStore, DataServiceManager } from "../../src/v2/data-services.mjs";
import { AssetCatalogManager } from "../../src/v2/assets.mjs";
import { generateAssetInsight } from "../../src/v2/model.mjs";
import { PROJECT } from "../../src/v2/server.mjs";

const csv =
  "position_id,client_id,security_code,asset_class,industry,market_value,trade_date\n" +
  "POS-001,CLIENT-001,SEC-DEMO-001,股票,金融,1000.00,2026-09-10\n" +
  "POS-002,CLIENT-001,SEC-DEMO-002,债券,公共事业,500.00,2026-09-10\n";
const events =
  '{"event_id":"EVT-Q-001","sequence":1,"security_code":"SEC-DEMO-001","event_time":"2026-09-14T09:30:00.000Z","price":"10.00","volume":100}\n' +
  '{"event_id":"EVT-Q-002","sequence":2,"security_code":"SEC-DEMO-002","event_time":"2026-09-14T09:30:01.000Z","price":"101.50","volume":200}\n';

function setup() {
  const root = mkdtempSync(join(tmpdir(), "shuzhan-assets-")),
    sourceRoot = join(root, "sources"),
    streamRoot = join(root, "streams"),
    store = new MetadataStore(join(root, "platform.sqlite")),
    landingStore = new LandingStore(join(root, "landing.sqlite")),
    stateStore = new StreamStateStore(join(root, "state.sqlite")),
    businessStore = new BusinessQueryStore(":memory:");
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(streamRoot, { recursive: true });
  writeFileSync(join(sourceRoot, "positions.csv"), csv);
  writeFileSync(join(streamRoot, "quotes.jsonl"), events);
  const ingestion = new IngestionManager({
      store,
      landingStore,
      project: PROJECT,
      fixtureRoot: sourceRoot,
    }),
    source = ingestion.createSource({
      name: "虚构证券持仓源",
      sourceType: "LOCAL_CSV",
      fileName: "positions.csv",
    });
  ingestion.testConnection(source.id);
  ingestion.collectMetadata(source.id);
  const task = ingestion.createTask({
    name: "持仓全量落地",
    sourceId: source.id,
    targetTable: "raw_positions",
    mode: "FULL",
    mapping: identityPositionMapping,
    keyFields: ["position_id"],
    watermarkField: "trade_date",
  });
  ingestion.runTask(task.id);
  const realtime = new RealtimeManager({
      store,
      stateStore,
      project: PROJECT,
      fixtureRoot: streamRoot,
      eventDelayMs: 0,
    }),
    streamSource = realtime.createSource({
      name: "虚构证券行情源",
      adapter: "local-event-log-v1",
      topic: "market.quotes.demo",
      fileName: "quotes.jsonl",
    }),
    streamJob = realtime.createJob({
      name: "行情状态同步",
      sourceId: streamSource.id,
      targetTable: "realtime_quotes",
      checkpointEvery: 1,
      maxOutOfOrderSeconds: 1,
    });
  realtime.startJob(streamJob.id);
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
    });
  return {
    store,
    landingStore,
    stateStore,
    businessStore,
    realtime,
    assets,
    source,
    task,
    streamSource,
    streamJob,
    async ready() {
      await realtime.waitForIdle();
    },
    close() {
      realtime.shutdown();
      businessStore.close();
      stateStore.close();
      landingStore.close();
      store.close();
    },
  };
}

test("asset inventory and lineage derive from actual version bindings", async () => {
  const app = setup();
  try {
    await app.ready();
    const inventory = app.assets.listAssets(),
      source = inventory.find((asset) => asset.id === `source:${app.source.id}`),
      landing = inventory.find((asset) => asset.id === "landing:raw_positions"),
      stream = inventory.find((asset) => asset.id === `stream:${app.streamJob.id}`);
    assert.ok(source);
    assert.equal(source.rowCount, 2);
    assert.equal(landing.rowCount, 2);
    assert.equal(stream.rowCount, 2);
    assert.equal(stream.eventCount, 2);
    assert.ok(
      app.assets
        .listAssets({ q: "market_value" })
        .some((asset) => asset.id === landing.id),
    );
    const lineage = app.assets.lineage(landing.id);
    assert.ok(
      lineage.edges.some(
        (edge) =>
          edge.from === source.id &&
          edge.to === landing.id &&
          edge.fieldMappings.some(
            (mapping) =>
              mapping.source === "market_value" &&
              mapping.target === "market_value",
          ),
      ),
    );
    assert.equal(lineage.sqlColumnLineageParsed, false);
    const streamLineage = app.assets.lineage(stream.id);
    assert.ok(
      streamLineage.edges.some(
        (edge) =>
          edge.from === `stream-source:${app.streamSource.id}` &&
          edge.to === stream.id,
      ),
    );
    const annotated = app.assets.annotate(landing.id, {
      businessName: "证券持仓明细",
      description: "财富顾问资产分析使用的虚构持仓明细",
      domain: "财富管理",
      owner: "数据产品负责人",
      classification: "INTERNAL_DEMO",
      tags: ["持仓", "T+1"],
    });
    assert.equal(annotated.annotation.revision, 1);
    assert.equal(app.assets.detail(landing.id).businessName, "证券持仓明细");
  } finally {
    app.close();
  }
});

test("metrics and standards execute against actual landing rows", async () => {
  const app = setup();
  try {
    await app.ready();
    const marketValue = app.assets.createMetric({
        name: "持仓市值",
        code: "holding_market_value",
        assetId: "landing:raw_positions",
        aggregation: "SUM",
        field: "market_value",
        groupBy: "asset_class",
        definition: "按资产类别汇总持仓明细market_value，不含现金",
      }),
      metricRun = app.assets.runMetric(marketValue.id);
    assert.equal(metricRun.status, "SUCCEEDED");
    assert.equal(metricRun.rowCount, 2);
    assert.deepEqual(metricRun.values, [
      { group: "股票", value: "1000.00" },
      { group: "债券", value: "500.00" },
    ]);
    const standard = app.assets.createStandard({
        name: "证券代码格式",
        code: "security_code_format",
        assetId: "landing:raw_positions",
        field: "security_code",
        semanticType: "SECURITY_CODE",
        description: "虚构证券代码必须使用SEC-前缀",
      }),
      check = app.assets.checkStandard(standard.id);
    assert.equal(check.status, "PASSED");
    assert.equal(check.evaluatedCount, 2);
    assert.equal(check.failedCount, 0);
    assert.equal(check.actualExecution, true);
  } finally {
    app.close();
  }
});

test("asset Agent accepts only known asset citations", async () => {
  const app = setup();
  try {
    await app.ready();
    const insight = app.assets.validateAgentInsight({
      answer: "证券持仓落地表可用于持仓市值指标，来源是版本化CSV同步。",
      assetIds: ["landing:raw_positions"],
      lineageFocusAssetId: "landing:raw_positions",
      caveats: ["当前为本机合成数据"],
    });
    assert.deepEqual(insight.assetIds, ["landing:raw_positions"]);
    assert.throws(
      () =>
        app.assets.validateAgentInsight({
          answer: "虚构答案",
          assetIds: ["company:secret"],
        }),
      { status: 422, code: "UNKNOWN_AGENT_ASSET" },
    );
  } finally {
    app.close();
  }
});

test("asset model adapter receives summaries and never business rows", async () => {
  let requestBody;
  const generated = await generateAssetInsight(
    {
      message: "找出持仓市值可用资产并解释来源",
      assets: [
        {
          id: "landing:raw_positions",
          name: "raw_positions",
          kind: "LANDING_TABLE",
          fields: [{ name: "market_value", type: "DECIMAL(18,2)" }],
          hiddenRows: [{ client_id: "CLIENT-SHOULD-NOT-LEAK" }],
        },
      ],
      lineage: [
        {
          from: "source:positions",
          to: "landing:raw_positions",
          type: "FULL",
        },
      ],
      contracts: [
        {
          id: "contract-positions-v1",
          code: "positions_contract",
          assetId: "landing:raw_positions",
          compatibility: "BACKWARD",
          schemaHash: "schema-evidence",
          fields: [
            { name: "market_value", type: "DECIMAL(18,2)", nullable: false },
          ],
          latestCheck: { status: "PASSED", missing: [], typeMismatch: [] },
          downstreamCount: 1,
          hiddenRows: [{ client_id: "CLIENT-CONTRACT-MUST-NOT-LEAK" }],
        },
      ],
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
                  answer: "使用raw_positions计算持仓市值。",
                  assetIds: ["landing:raw_positions"],
                  lineageFocusAssetId: "landing:raw_positions",
                  caveats: ["当前为版本绑定血缘"],
                }),
              },
            },
          ],
          usage: { total_tokens: 210 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  );
  const sent = requestBody.messages[1].content;
  assert.match(sent, /landing:raw_positions/);
  assert.match(sent, /positions_contract/);
  assert.match(sent, /schema-evidence/);
  assert.doesNotMatch(sent, /CLIENT-SHOULD-NOT-LEAK/);
  assert.doesNotMatch(sent, /CLIENT-CONTRACT-MUST-NOT-LEAK/);
  assert.equal(generated.insight.assetIds[0], "landing:raw_positions");
});
