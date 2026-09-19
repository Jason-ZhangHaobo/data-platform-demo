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
import { QualityManager } from "../../src/v2/quality.mjs";
import { generateQualityPlan } from "../../src/v2/model.mjs";
import { PROJECT } from "../../src/v2/server.mjs";

const csv =
  "position_id,client_id,security_code,asset_class,industry,market_value,trade_date\n" +
  "POS-001,CLIENT-001,SEC-DEMO-001,股票,金融,1000.00,2026-09-10\n" +
  "POS-002,CLIENT-001,SEC-DEMO-002,债券,公共事业,500.00,2026-09-10\n" +
  "POS-003,CLIENT-002,SEC-DEMO-003,基金,多元金融,9000.00,2026-09-10\n";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "shuduo-quality-")),
    fixtureRoot = join(root, "sources"),
    store = new MetadataStore(join(root, "platform.sqlite")),
    landingStore = new LandingStore(join(root, "landing.sqlite")),
    stateStore = new StreamStateStore(":memory:"),
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
      name: "质量测试持仓源",
      sourceType: "LOCAL_CSV",
      fileName: "positions.csv",
    });
  ingestion.testConnection(source.id);
  ingestion.collectMetadata(source.id);
  const task = ingestion.createTask({
    name: "质量测试持仓落地",
    sourceId: source.id,
    targetTable: "quality_positions",
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
    quality = new QualityManager({ store, assets, project: PROJECT });
  return {
    store,
    landingStore,
    stateStore,
    businessStore,
    assets,
    quality,
    close() {
      businessStore.close();
      stateStore.close();
      landingStore.close();
      store.close();
    },
  };
}

test("quality rule failure opens an alert and a corrected version resolves it", () => {
  const app = setup();
  try {
    const rule = app.quality.createRule({
        name: "持仓市值合理范围",
        code: "holding_value_range",
        assetId: "landing:quality_positions",
        field: "market_value",
        type: "VALUE_RANGE",
        config: { min: "0.00", max: "5000.00" },
        description: "受控低阈值用于验证失败、告警和恢复",
      }),
      first = app.quality.runRule(rule.id);
    assert.equal(first.run.status, "FAILED");
    assert.equal(first.run.evaluatedCount, 3);
    assert.equal(first.run.failedCount, 1);
    assert.equal(first.rule.health, "FAILED");
    assert.equal(first.rule.alerts[0].status, "OPEN");
    assert.equal(first.run.invalidRowHashes.length, 1);
    assert.doesNotMatch(JSON.stringify(first.run), /POS-003/);

    const versioned = app.quality.createVersion(rule.id, {
        config: { min: "0.00", max: "10000.00" },
        description: "校准后允许当前虚构证券持仓范围",
      }),
      recovered = app.quality.runRule(rule.id);
    assert.equal(versioned.currentVersion.versionNumber, 2);
    assert.equal(versioned.versions.length, 2);
    assert.equal(recovered.run.status, "PASSED");
    assert.equal(recovered.run.passedCount, 3);
    assert.equal(recovered.rule.health, "HEALTHY");
    assert.equal(recovered.rule.alerts[0].status, "RESOLVED");
    assert.equal(recovered.rule.alerts[0].recoveryRunId, recovered.run.id);
    assert.equal(recovered.rule.runs.length, 2);
  } finally {
    app.close();
  }
});

test("quality rules reject unknown fields and unsafe configurations", () => {
  const app = setup();
  try {
    assert.throws(
      () =>
        app.quality.createRule({
          name: "未知字段规则",
          code: "unknown_field_rule",
          assetId: "landing:quality_positions",
          field: "real_client_name",
          type: "NOT_NULL",
          config: {},
          description: "必须拒绝未登记字段",
        }),
      { status: 400, code: "QUALITY_FIELD_NOT_FOUND" },
    );
    assert.throws(
      () =>
        app.quality.createRule({
          name: "错误范围规则",
          code: "invalid_range_rule",
          assetId: "landing:quality_positions",
          field: "market_value",
          type: "VALUE_RANGE",
          config: { min: "100.00", max: "10.00" },
          description: "必须拒绝反向范围",
        }),
      { status: 400, code: "INVALID_QUALITY_RANGE" },
    );
  } finally {
    app.close();
  }
});

test("quality Agent plan is grounded to executable asset fields", () => {
  const app = setup();
  try {
    const proposal = app.quality.validateAgentPlan({
      kind: "QUALITY_RULE",
      name: "证券代码非空",
      code: "security_code_not_null",
      assetId: "landing:quality_positions",
      field: "security_code",
      type: "NOT_NULL",
      config: {},
      description: "证券代码必须存在",
    });
    assert.equal(proposal.type, "NOT_NULL");
    assert.throws(
      () =>
        app.quality.validateAgentPlan({
          kind: "QUALITY_RULE",
          name: "虚构规则",
          code: "invented_asset_rule",
          assetId: "company:positions",
          field: "security_code",
          type: "NOT_NULL",
          config: {},
          description: "不得引用未知资产",
        }),
      { status: 404, code: "ASSET_NOT_FOUND" },
    );
  } finally {
    app.close();
  }
});

test("quality model adapter never receives business rows or invalid samples", async () => {
  let requestBody;
  const generated = await generateQualityPlan(
    {
      message: "为证券代码生成非空规则",
      assets: [
        {
          id: "landing:quality_positions",
          name: "quality_positions",
          businessName: "质量持仓表",
          kind: "LANDING_TABLE",
          rowCount: 3,
          fields: [{ name: "security_code", type: "STRING", nullable: false }],
          hiddenRows: [{ client_id: "CLIENT-SHOULD-NOT-LEAK" }],
        },
      ],
      rules: [
        {
          id: "rule-id",
          code: "old_rule",
          assetId: "landing:quality_positions",
          health: "FAILED",
          currentVersion: { type: "NOT_NULL", field: "security_code", config: {} },
          latestRun: { status: "FAILED", evaluatedCount: 3, failedCount: 1 },
          invalidRows: ["POS-SHOULD-NOT-LEAK"],
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
                  kind: "QUALITY_RULE",
                  name: "证券代码非空",
                  code: "security_code_not_null",
                  assetId: "landing:quality_positions",
                  field: "security_code",
                  type: "NOT_NULL",
                  config: {},
                  description: "证券代码必须存在",
                  explanation: "根据字段不可空属性建议",
                }),
              },
            },
          ],
          usage: { total_tokens: 230 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  );
  const sent = requestBody.messages[1].content;
  assert.match(sent, /quality_positions/);
  assert.doesNotMatch(sent, /CLIENT-SHOULD-NOT-LEAK|POS-SHOULD-NOT-LEAK/);
  assert.equal(generated.plan.type, "NOT_NULL");
});
