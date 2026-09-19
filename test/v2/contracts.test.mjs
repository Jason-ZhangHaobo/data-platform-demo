import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MetadataStore } from "../../src/v2/store.mjs";
import { LandingStore } from "../../src/v2/ingestion.mjs";
import { StreamStateStore } from "../../src/v2/realtime.mjs";
import {
  BusinessQueryStore,
  DataServiceManager,
} from "../../src/v2/data-services.mjs";
import { AssetCatalogManager } from "../../src/v2/assets.mjs";
import {
  DataContractManager,
  assessContractCompatibility,
} from "../../src/v2/contracts.mjs";
import { PROJECT } from "../../src/v2/server.mjs";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "shuduo-contracts-")),
    store = new MetadataStore(join(root, "platform.sqlite")),
    landingStore = new LandingStore(join(root, "landing.sqlite")),
    stateStore = new StreamStateStore(join(root, "stream.sqlite")),
    businessStore = new BusinessQueryStore(join(root, "business.sqlite")),
    metadata = store.create("source_metadata", PROJECT, {
      objectName: "positions",
      rowCount: 2,
      contentHash: "source-evidence",
      columns: [
        { name: "position_id", type: "STRING", nullable: false },
        { name: "client_id", type: "STRING", nullable: false },
        { name: "market_value", type: "DECIMAL(18,2)", nullable: false },
      ],
    }),
    source = store.create("ingestion_source", PROJECT, {
      name: "虚构证券持仓源",
      sourceType: "LOCAL_CSV",
      status: "READY",
      currentMetadataId: metadata.id,
    });
  landingStore.sync({
    targetTable: "raw_positions",
    mode: "FULL",
    rows: [
      { position_id: "POS-001", client_id: "CLIENT-001", market_value: "1000.00" },
      { position_id: "POS-002", client_id: "CLIENT-001", market_value: "500.00" },
    ],
    mapping: {
      position_id: "position_id",
      client_id: "client_id",
      market_value: "market_value",
    },
    keyFields: ["position_id"],
    sourceHash: "source-evidence",
    syncedAt: "2026-09-15T00:00:00.000Z",
  });
  store.create("offline_sync_task", PROJECT, {
    name: "虚构持仓全量同步",
    sourceId: source.id,
    metadataVersionId: metadata.id,
    targetTable: "raw_positions",
    mode: "FULL",
    mapping: {
      position_id: "position_id",
      client_id: "client_id",
      market_value: "market_value",
    },
    status: "SUCCEEDED",
    configHash: "task-evidence",
  });
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
    contracts = new DataContractManager({
      store,
      assets,
      project: PROJECT,
      now: () => Date.parse("2026-09-15T01:00:00.000Z"),
    });
  return {
    store,
    landingStore,
    stateStore,
    businessStore,
    assets,
    contracts,
    close() {
      businessStore.close();
      stateStore.close();
      landingStore.close();
      store.close();
    },
  };
}

const createContract = (app, compatibility = "BACKWARD") =>
  app.contracts.create({
    name: `${compatibility}持仓契约`,
    code: `${compatibility.toLowerCase()}_positions_contract`,
    assetId: "landing:raw_positions",
    owner: "虚构数据负责人",
    description: "约束虚构证券持仓落地表结构与质量目标",
    compatibility,
    qualitySlo: { minPassRate: 0.99, maxFreshnessSeconds: 86_400 },
  });

test("contract snapshots actual asset schema and checks actual rows", () => {
  const app = setup();
  try {
    const contract = createContract(app),
      result = app.contracts.check(contract.id);
    assert.equal(contract.currentVersion.fields.length, 3);
    assert.equal(contract.currentVersion.source, "ASSET_SNAPSHOT");
    assert.equal(result.check.status, "PASSED");
    assert.equal(result.check.actualMetadata, true);
    assert.equal(result.check.actualRows, true);
    assert.equal(result.check.evaluatedRows, 2);
    assert.equal(result.check.rowPassRate, 1);
    assert.equal(result.check.freshnessSeconds, 3600);
    assert.equal(result.check.freshnessPassed, true);
    assert.equal(result.contract.alerts.length, 0);
    const sourceAsset = app.assets
        .listAssets()
        .find((asset) => asset.kind === "SOURCE_TABLE"),
      sourceContract = app.contracts.create({
        name: "持仓源元数据契约",
        code: "source_positions_contract",
        assetId: sourceAsset.id,
        owner: "虚构数据负责人",
        description: "验证只有元数据证据时不会冒充完整通过",
        compatibility: "BACKWARD",
      }),
      partial = app.contracts.check(sourceContract.id);
    assert.equal(partial.check.status, "PARTIAL");
    assert.equal(partial.check.actualMetadata, true);
    assert.equal(partial.check.actualRows, false);
  } finally {
    app.close();
  }
});

test("backward compatibility permits an optional addition but blocks removal without review", () => {
  const app = setup();
  try {
    let contract = createContract(app),
      assessment = app.contracts.assess(contract.id, {
        fields: [
          ...contract.currentVersion.fields,
          { name: "currency", type: "STRING", nullable: true },
        ],
      }),
      staleAssessment = app.contracts.assess(contract.id);
    assert.equal(assessment.status, "COMPATIBLE");
    contract = app.contracts.createVersion(contract.id, {
      assessmentId: assessment.id,
      acknowledgeBreaking: false,
    });
    assert.equal(contract.currentVersion.versionNumber, 2);
    assert.throws(
      () =>
        app.contracts.createVersion(contract.id, {
          assessmentId: staleAssessment.id,
          acknowledgeBreaking: false,
        }),
      { status: 409, code: "CONTRACT_ASSESSMENT_STALE" },
    );
    const failed = app.contracts.check(contract.id);
    assert.equal(failed.check.status, "FAILED");
    assert.deepEqual(failed.check.missing, ["currency"]);
    assert.equal(failed.contract.alerts[0].status, "OPEN");

    assessment = app.contracts.assess(contract.id, {
      fields: contract.currentVersion.fields.filter(
        (field) => field.name !== "currency",
      ),
    });
    assert.equal(assessment.status, "BREAKING");
    assert.deepEqual(assessment.change.breakingReasons, ["REMOVED:currency"]);
    assert.throws(
      () =>
        app.contracts.createVersion(contract.id, {
          assessmentId: assessment.id,
          acknowledgeBreaking: false,
        }),
      { status: 409, code: "CONTRACT_BREAKING_CHANGE" },
    );
    const recovered = app.contracts.createVersion(contract.id, {
      assessmentId: assessment.id,
      acknowledgeBreaking: true,
    });
    const passed = app.contracts.check(recovered.id);
    assert.equal(passed.check.status, "PASSED");
    assert.equal(
      passed.contract.alerts.find((alert) => alert.status === "OPEN"),
      undefined,
    );
    assert.equal(passed.contract.alerts[0].recoveryCheckId, passed.check.id);
  } finally {
    app.close();
  }
});

test("full compatibility treats additions as breaking and exposes downstream impact only", () => {
  const app = setup();
  try {
    const contract = createContract(app, "FULL"),
      assessment = app.contracts.assess(contract.id, {
        fields: [
          ...contract.currentVersion.fields,
          { name: "trade_date", type: "STRING", nullable: false },
        ],
      }),
      context = app.contracts.agentContext();
    assert.equal(assessment.change.breaking, true);
    assert.deepEqual(assessment.change.breakingReasons, ["ADDED:trade_date"]);
    assert.equal(context[0].assetId, "landing:raw_positions");
    assert.equal(JSON.stringify(context).includes("CLIENT-001"), false);
    assert.equal(JSON.stringify(context).includes("1000.00"), false);
  } finally {
    app.close();
  }
});

test("compatibility helper identifies type and nullability risks deterministically", () => {
  const result = assessContractCompatibility(
    [{ name: "market_value", type: "DECIMAL(18,2)", nullable: false }],
    [{ name: "market_value", type: "STRING", nullable: true }],
    "BACKWARD",
  );
  assert.equal(result.breaking, true);
  assert.deepEqual(result.breakingReasons, [
    "TYPE_CHANGED:market_value",
    "BECAME_NULLABLE:market_value",
  ]);
});

test("backward compatibility rejects a newly required field and validates nullable input", () => {
  const result = assessContractCompatibility(
    [{ name: "client_id", type: "STRING", nullable: false }],
    [
      { name: "client_id", type: "STRING", nullable: false },
      { name: "trade_date", type: "STRING", nullable: false },
    ],
    "BACKWARD",
  );
  assert.equal(result.breaking, true);
  assert.deepEqual(result.breakingReasons, ["ADDED_REQUIRED:trade_date"]);
  const app = setup();
  try {
    assert.throws(
      () =>
        app.contracts.assess(createContract(app).id, {
          fields: [{ name: "client_id", type: "STRING", nullable: "false" }],
        }),
      { status: 400, code: "INVALID_CONTRACT_FIELDS" },
    );
  } finally {
    app.close();
  }
});
