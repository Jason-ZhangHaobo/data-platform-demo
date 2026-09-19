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
  "POS-002,CLIENT-002,SEC-DEMO-002,基金,多元金融,750.00,2026-09-10\n" +
  "POS-003,CLIENT-003,SEC-DEMO-003,股票,信息技术,9000.00,2026-09-10\n";

async function request(base, path, body, key = "security-api", actorId) {
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shuduo-Client": "workbench",
      "Idempotency-Key": key,
      ...(actorId ? { "X-Actor-Id": actorId } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
async function waitForPlan(base, id) {
  for (let index = 0; index < 100; index++) {
    const response = await request(base, `/security/agent/plans/${id}`);
    if (!["QUEUED", "RUNNING"].includes(response.body.status)) return response.body;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("安全Agent方案未完成");
}

test("V2 security API enforces masking, denial, approved grant and Agent no-execute boundary", async () => {
  const root = mkdtempSync(join(tmpdir(), "shuduo-security-api-")),
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
    securityPlanner: async ({ assets }) => ({
      plan: {
        kind: "SECURITY_POLICY",
        name: "Agent工程师只读策略",
        code: "agent_engineer_read",
        assetId: assets.find((asset) => asset.id === "landing:secure_positions").id,
        roles: ["DATA_ENGINEER"],
        rowScope: "ALL",
        defaultAction: "DENY",
        fieldActions: {
          position_id: "ALLOW",
          client_id: "MASK_PARTIAL",
          security_code: "ALLOW",
          asset_class: "ALLOW",
          industry: "ALLOW",
          market_value: "ALLOW",
          trade_date: "ALLOW",
        },
        description: "工程师读取合成持仓，客户号脱敏",
      },
      explanation: "最小权限草稿，不自动查询",
      model: "TEST_DOUBLE",
      usage: { total_tokens: 130 },
    }),
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}/api/v2`;
  try {
    const source = await request(
      base,
      "/sources",
      { name: "安全API持仓源", sourceType: "LOCAL_CSV", fileName: "positions.csv" },
      "security-source",
    );
    await request(base, `/sources/${source.body.id}/test`, {}, "security-source-test");
    await request(base, `/sources/${source.body.id}/metadata`, {}, "security-source-meta");
    const sync = await request(
      base,
      "/sync/tasks",
      {
        name: "安全API持仓落地",
        sourceId: source.body.id,
        targetTable: "secure_positions",
        mode: "FULL",
        mapping: identityPositionMapping,
        keyFields: ["position_id"],
        watermarkField: "trade_date",
      },
      "security-sync",
    );
    await request(base, `/sync/tasks/${sync.body.id}/run`, {}, "security-sync-run");

    const policy = await request(
      base,
      "/security/policies",
      {
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
          market_value: "ALLOW",
          trade_date: "ALLOW",
        },
        description: "财富顾问只看名下虚构客户并脱敏标识",
      },
      "security-policy",
    );
    assert.equal(policy.status, 201);
    const advisor = await request(
      base,
      `/security/query/${encodeURIComponent("landing:secure_positions")}`,
      {},
      "advisor-query",
      "user-wealth-advisor",
    );
    assert.equal(advisor.status, 200);
    assert.equal(advisor.body.rowCount, 2);
    assert.ok(advisor.body.rows.every((row) => row.client_id.includes("***")));
    assert.ok(advisor.body.rows.every((row) => row.position_id === "******"));
    assert.doesNotMatch(JSON.stringify(advisor.body.rows), /CLIENT-003/);

    const denied = await request(
      base,
      `/security/query/${encodeURIComponent("landing:secure_positions")}`,
      {},
      "auditor-denied",
      "user-auditor",
    );
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, "SECURITY_ACCESS_DENIED");
    assert.ok(denied.body.auditId);
    const accessRequest = await request(
        base,
        "/security/requests",
        {
          assetId: "landing:secure_positions",
          scope: "READ_MASKED",
          reason: "核对本机虚构证券安全流程",
        },
        "auditor-request",
        "user-auditor",
      ),
      approved = await request(
        base,
        `/security/requests/${accessRequest.body.id}/review`,
        {
          decision: "APPROVE",
          durationHours: 24,
          reviewNote: "仅限本机合成验收",
        },
        "owner-review",
        "user-data-owner",
      );
    assert.equal(approved.body.request.status, "APPROVED");
    const granted = await request(
      base,
      `/security/query/${encodeURIComponent("landing:secure_positions")}`,
      {},
      "auditor-granted",
      "user-auditor",
    );
    assert.equal(granted.body.rowCount, 3);
    assert.equal(granted.body.grantId, approved.body.grant.id);
    assert.equal(granted.body.publicEnforced, false);

    const started = await request(
        base,
        "/security/agent/plans",
        { message: "为数据工程师生成持仓最小权限策略草稿" },
        "security-agent",
      ),
      complete = await waitForPlan(base, started.body.id);
    assert.equal(complete.status, "SUCCEEDED");
    assert.equal(complete.completionScope, "SECURITY_POLICY_DESIGN");
    assert.equal(store.list("security_policy", "project-securities-lab").length, 1);
    const applied = await request(
      base,
      `/security/agent/plans/${complete.id}/apply`,
      {},
      "security-agent-apply",
    );
    assert.equal(applied.status, 201);
    assert.equal(store.list("security_policy", "project-securities-lab").length, 2);
    assert.equal(store.list("security_audit", "project-securities-lab").filter((audit) => audit.action === "SECURE_QUERY").length, 3);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    stateStore.close();
    landingStore.close();
    store.close();
  }
});
