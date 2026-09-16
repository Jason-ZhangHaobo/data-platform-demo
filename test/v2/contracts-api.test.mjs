import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MetadataStore } from "../../src/v2/store.mjs";
import {
  LandingStore,
  identityPositionMapping,
} from "../../src/v2/ingestion.mjs";
import { createV2Server } from "../../src/v2/server.mjs";
import { runV2Cli } from "../../bin/shuzhan.mjs";

const csv =
  "position_id,client_id,security_code,asset_class,industry,market_value,trade_date\n" +
  "POS-001,CLIENT-001,SEC-DEMO-001,股票,金融,1000.00,2026-09-10\n" +
  "POS-002,CLIENT-001,SEC-DEMO-002,债券,公共事业,500.00,2026-09-10\n";

async function request(base, path, body, key = crypto.randomUUID()) {
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

test("contract API assesses, versions and checks a real synthetic securities asset", async () => {
  const root = mkdtempSync(join(tmpdir(), "shuzhan-contract-api-")),
    fixtureRoot = join(root, "fixtures"),
    store = new MetadataStore(join(root, "platform.sqlite")),
    landingStore = new LandingStore(join(root, "landing.sqlite"));
  mkdirSync(fixtureRoot, { recursive: true });
  writeFileSync(join(fixtureRoot, "positions.csv"), csv);
  const app = createV2Server({
    root,
    store,
    landingStore,
    fixtureRoot,
    env: { V2_LOCAL_DEVELOPMENT: "true" },
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}/api/v2`;
  try {
    const source = await request(base, "/sources", {
      name: "虚构证券持仓",
      sourceType: "LOCAL_CSV",
      fileName: "positions.csv",
    });
    await request(base, `/sources/${source.body.id}/test`, {});
    await request(base, `/sources/${source.body.id}/metadata`, {});
    const task = await request(base, "/sync/tasks", {
      name: "虚构持仓全量同步",
      sourceId: source.body.id,
      targetTable: "raw_positions",
      mode: "FULL",
      mapping: identityPositionMapping,
      keyFields: ["position_id"],
      watermarkField: "trade_date",
    });
    await request(base, `/sync/tasks/${task.body.id}/run`, {});

    const created = await request(
      base,
      "/contracts",
      {
        name: "证券持仓落地契约",
        code: "positions_landing_contract",
        assetId: "landing:raw_positions",
        owner: "虚构数据负责人",
        description: "约束证券持仓字段、类型、可空性和质量目标",
        compatibility: "BACKWARD",
        qualitySlo: { minPassRate: 0.99, maxFreshnessSeconds: 86_400 },
      },
      "create-contract",
    );
    assert.equal(created.status, 201);
    assert.equal(created.body.currentVersion.fields.length, 7);
    const replay = await request(
      base,
      "/contracts",
      {
        name: "证券持仓落地契约",
        code: "positions_landing_contract",
        assetId: "landing:raw_positions",
        owner: "虚构数据负责人",
        description: "约束证券持仓字段、类型、可空性和质量目标",
        compatibility: "BACKWARD",
        qualitySlo: { minPassRate: 0.99, maxFreshnessSeconds: 86_400 },
      },
      "create-contract",
    );
    assert.equal(replay.status, 200);
    assert.equal(replay.body.id, created.body.id);

    const checked = await request(
      base,
      `/contracts/${created.body.id}/check`,
      {},
      "check-contract-v1",
    );
    assert.equal(checked.body.status, "PASSED");
    assert.equal(checked.body.actualRows, true);

    const assessment = await request(
      base,
      `/contracts/${created.body.id}/assess`,
      {
        fields: [
          ...created.body.currentVersion.fields,
          { name: "currency", type: "STRING", nullable: true },
        ],
      },
      "assess-compatible-addition",
    );
    assert.equal(assessment.body.status, "COMPATIBLE");
    const versioned = await request(
      base,
      `/contracts/${created.body.id}/versions`,
      { assessmentId: assessment.body.id, acknowledgeBreaking: false },
      "apply-compatible-version",
    );
    assert.equal(versioned.status, 201);
    assert.equal(versioned.body.currentVersion.versionNumber, 2);
    assert.equal(
      (
        await request(
          base,
          `/contracts/${created.body.id}/check`,
          {},
          "check-contract-v2",
        )
      ).body.status,
      "FAILED",
    );

    const breaking = await request(
      base,
      `/contracts/${created.body.id}/assess`,
      {
        fields: versioned.body.currentVersion.fields.filter(
          (field) => field.name !== "currency",
        ),
      },
      "assess-breaking-removal",
    );
    assert.equal(breaking.body.status, "BREAKING");
    const blocked = await request(
      base,
      `/contracts/${created.body.id}/versions`,
      { assessmentId: breaking.body.id, acknowledgeBreaking: false },
      "block-breaking-version",
    );
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, "CONTRACT_BREAKING_CHANGE");
    const accepted = await request(
      base,
      `/contracts/${created.body.id}/versions`,
      { assessmentId: breaking.body.id, acknowledgeBreaking: true },
      "accept-breaking-version",
    );
    assert.equal(accepted.body.currentVersion.versionNumber, 3);
    assert.equal(accepted.body.currentVersion.breakingAcknowledged, true);
    assert.equal((await request(base, "/contracts")).body.length, 1);
    const output = [];
    assert.equal(
      await runV2Cli(
        ["contracts", "show", "--id", created.body.id],
        { SHUZHAN_V2_API_BASE_URL: base },
        { output: (value) => output.push(value), error: (value) => output.push(value) },
      ),
      0,
    );
    assert.equal(JSON.parse(output[0]).currentVersion.versionNumber, 3);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    landingStore.close();
    store.close();
  }
});
