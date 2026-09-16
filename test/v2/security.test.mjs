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
import { SecurityManager } from "../../src/v2/security.mjs";
import { generateSecurityPlan } from "../../src/v2/model.mjs";
import { PROJECT } from "../../src/v2/server.mjs";

const csv =
  "position_id,client_id,security_code,asset_class,industry,market_value,trade_date\n" +
  "POS-001,CLIENT-001,SEC-DEMO-001,股票,金融,1000.00,2026-09-10\n" +
  "POS-002,CLIENT-001,SEC-DEMO-002,债券,公共事业,500.00,2026-09-10\n" +
  "POS-003,CLIENT-002,SEC-DEMO-003,基金,多元金融,750.00,2026-09-10\n" +
  "POS-004,CLIENT-003,SEC-DEMO-004,股票,信息技术,9000.00,2026-09-10\n";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "shuzhan-security-")),
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
      name: "安全测试持仓源",
      sourceType: "LOCAL_CSV",
      fileName: "positions.csv",
    });
  ingestion.testConnection(source.id);
  ingestion.collectMetadata(source.id);
  const task = ingestion.createTask({
    name: "安全测试持仓落地",
    sourceId: source.id,
    targetTable: "secure_positions",
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
    security = new SecurityManager({ store, assets, project: PROJECT });
  return {
    store,
    landingStore,
    stateStore,
    businessStore,
    assets,
    security,
    close() {
      businessStore.close();
      stateStore.close();
      landingStore.close();
      store.close();
    },
  };
}

const advisorPolicy = {
  name: "财富顾问持仓最小权限",
  code: "advisor_positions_minimum",
  assetId: "landing:secure_positions",
  roles: ["WEALTH_ADVISOR"],
  rowScope: "ADVISOR_CLIENTS",
  defaultAction: "DENY",
  fieldActions: {
    position_id: "MASK_FULL",
    client_id: "MASK_PARTIAL",
    security_code: "ALLOW",
    asset_class: "ALLOW",
    industry: "ALLOW",
    market_value: "ALLOW",
    trade_date: "ALLOW",
  },
  description: "财富顾问只看名下虚构客户，客户和持仓标识脱敏",
};

test("versioned policy enforces advisor row scope and column masking on actual rows", () => {
  const app = setup();
  try {
    const policy = app.security.createPolicy(advisorPolicy),
      result = app.security.query(
        "user-wealth-advisor",
        "landing:secure_positions",
      );
    assert.equal(policy.currentVersion.versionNumber, 1);
    assert.equal(result.rowCount, 3);
    assert.deepEqual(result.maskedFields.sort(), ["client_id", "position_id"]);
    assert.ok(result.rows.every((row) => row.client_id.includes("***")));
    assert.ok(result.rows.every((row) => row.position_id === "******"));
    assert.ok(result.rows.every((row) => !JSON.stringify(row).includes("CLIENT-003")));
    assert.equal(result.publicEnforced, false);
    const audit = app.security.listAudits()[0];
    assert.equal(audit.decision, "ALLOW");
    assert.equal(audit.rowCount, 3);
    assert.equal(audit.containsRowData, false);
    assert.doesNotMatch(JSON.stringify(audit), /CLIENT-001|SEC-DEMO/);
  } finally {
    app.close();
  }
});

test("denied identity can request temporary masked access and owner approval is audited", () => {
  const app = setup();
  try {
    assert.throws(
      () => app.security.query("user-auditor", "landing:secure_positions"),
      { status: 403, code: "SECURITY_ACCESS_DENIED" },
    );
    const request = app.security.createRequest("user-auditor", {
      assetId: "landing:secure_positions",
      scope: "READ_MASKED",
      reason: "核对虚构证券安全审计流程",
    });
    assert.throws(
      () =>
        app.security.reviewRequest("user-wealth-advisor", request.id, {
          decision: "APPROVE",
          reviewNote: "越权审批",
        }),
      { status: 403, code: "SECURITY_REVIEW_FORBIDDEN" },
    );
    const approved = app.security.reviewRequest("user-data-owner", request.id, {
      decision: "APPROVE",
      durationHours: 24,
      reviewNote: "仅限本机合成数据验收",
    });
    assert.equal(approved.request.status, "APPROVED");
    assert.equal(approved.grant.status, "ACTIVE");
    const result = app.security.query(
      "user-auditor",
      "landing:secure_positions",
    );
    assert.equal(result.rowCount, 4);
    assert.equal(result.grantId, approved.grant.id);
    assert.ok(result.maskedFields.includes("client_id"));
    assert.equal(result.rows[0].position_id, "******");
    assert.ok(app.security.listAudits().some((audit) => audit.decision === "DENY"));
    assert.ok(app.security.listAudits().some((audit) => audit.decision === "APPROVE"));
  } finally {
    app.close();
  }
});

test("security Agent plan rejects unknown roles, assets and fields", () => {
  const app = setup();
  try {
    const proposal = app.security.validateAgentPlan({
      kind: "SECURITY_POLICY",
      ...advisorPolicy,
      code: "advisor_positions_agent",
    });
    assert.equal(proposal.rowScope, "ADVISOR_CLIENTS");
    assert.throws(
      () =>
        app.security.validateAgentPlan({
          kind: "SECURITY_POLICY",
          ...advisorPolicy,
          code: "unknown_role_policy",
          roles: ["SUPER_ADMIN"],
        }),
      { status: 400, code: "INVALID_POLICY_ROLES" },
    );
    assert.throws(
      () =>
        app.security.validateAgentPlan({
          kind: "SECURITY_POLICY",
          ...advisorPolicy,
          code: "unknown_field_policy",
          fieldActions: { real_client_name: "ALLOW" },
        }),
      { status: 400, code: "SECURITY_FIELD_NOT_FOUND" },
    );
  } finally {
    app.close();
  }
});

test("security model adapter receives metadata and never business rows", async () => {
  let requestBody;
  const generated = await generateSecurityPlan(
    {
      message: "为财富顾问生成持仓最小权限策略",
      personas: [
        {
          id: "user-wealth-advisor",
          displayName: "虚构财富顾问A",
          role: "WEALTH_ADVISOR",
          advisorId: "ADVISOR-DEMO-A",
          password: "SHOULD_NOT_LEAK",
        },
      ],
      assets: [
        {
          id: "landing:secure_positions",
          businessName: "安全持仓表",
          kind: "LANDING_TABLE",
          fields: [{ name: "client_id", type: "STRING" }],
          rows: [{ client_id: "CLIENT-SHOULD-NOT-LEAK" }],
        },
      ],
      policies: [],
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
                  kind: "SECURITY_POLICY",
                  name: "顾问持仓最小权限",
                  code: "advisor_minimum",
                  assetId: "landing:secure_positions",
                  roles: ["WEALTH_ADVISOR"],
                  rowScope: "ADVISOR_CLIENTS",
                  fieldActions: { client_id: "MASK_PARTIAL" },
                  defaultAction: "DENY",
                  description: "顾问只看名下客户且客户号脱敏",
                  explanation: "按最小权限设计",
                }),
              },
            },
          ],
          usage: { total_tokens: 260 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    },
  );
  const sent = requestBody.messages[1].content;
  assert.match(sent, /WEALTH_ADVISOR/);
  assert.doesNotMatch(sent, /SHOULD_NOT_LEAK|CLIENT-SHOULD-NOT-LEAK/);
  assert.equal(generated.plan.rowScope, "ADVISOR_CLIENTS");
});
