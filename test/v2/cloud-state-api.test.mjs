import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createV2Server, PROJECT } from "../../src/v2/server.mjs";
import {
  LandingStore,
  identityPositionMapping,
} from "../../src/v2/ingestion.mjs";
import { StreamStateStore } from "../../src/v2/realtime.mjs";
import { BusinessQueryStore } from "../../src/v2/data-services.mjs";
import { ReportDataStore } from "../../src/v2/reports.mjs";
import {
  MemorySnapshotBackend,
  ReplicatedMetadataStore,
} from "../../src/v2/metadata-replica.mjs";
import {
  MemoryDataStateBackend,
  ReplicatedDataState,
} from "../../src/v2/data-state-replica.mjs";
import { CloudStateCoordinator } from "../../src/v2/cloud-state-coordinator.mjs";

const csv =
  "position_id,client_id,security_code,asset_class,industry,market_value,trade_date\n" +
  "POS-001,CLIENT-001,SEC-DEMO-001,股票,金融,1000.00,2026-09-10\n";

const stores = () => ({
  landingStore: new LandingStore(),
  streamStateStore: new StreamStateStore(),
  businessStore: new BusinessQueryStore(),
  reportStore: new ReportDataStore(),
});

async function post(base, path, body, key) {
  const response = await fetch(base + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shuzhan-Client": "workbench",
      "Idempotency-Key": key,
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test("successful sync API response is recoverable after a simulated cloud cold start", async () => {
  const root = mkdtempSync(join(tmpdir(), "shuzhan-cloud-state-api-")),
    fixtureRoot = join(root, "fixtures"),
    metadataBackend = new MemorySnapshotBackend(),
    dataBackend = new MemoryDataStateBackend(),
    firstStores = stores(),
    metadata = await ReplicatedMetadataStore.open({
      backend: metadataBackend,
      project: PROJECT,
      autoFlush: false,
    }),
    dataState = await ReplicatedDataState.open({
      backend: dataBackend,
      stores: firstStores,
      project: PROJECT,
      autoFlush: false,
    }),
    coordinator = new CloudStateCoordinator({ metadata, dataState });
  mkdirSync(fixtureRoot, { recursive: true });
  writeFileSync(join(fixtureRoot, "positions.csv"), csv);
  const app = createV2Server({
    store: metadata,
    ...firstStores,
    stateCoordinator: coordinator,
    fixtureRoot,
    env: {
      V2_LOCAL_DEVELOPMENT: "true",
      V2_META_DRIVER: "mysql-project-snapshot-cas",
    },
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}/api/v2`;
  try {
    const source = await post(
      base,
      "/sources",
      { name: "虚构证券持仓", sourceType: "LOCAL_CSV", fileName: "positions.csv" },
      "cloud-source",
    );
    assert.equal(source.status, 201);
    assert.equal((await post(base, `/sources/${source.body.id}/test`, {}, "cloud-test")).status, 200);
    assert.equal((await post(base, `/sources/${source.body.id}/metadata`, {}, "cloud-meta")).status, 200);
    const task = await post(
      base,
      "/sync/tasks",
      {
        name: "虚构持仓全量同步",
        sourceId: source.body.id,
        targetTable: "raw_positions",
        mode: "FULL",
        mapping: identityPositionMapping,
        keyFields: ["position_id"],
        watermarkField: "trade_date",
      },
      "cloud-task",
    );
    const run = await post(
      base,
      `/sync/tasks/${task.body.id}/run`,
      {},
      "cloud-run",
    );
    assert.equal(run.status, 200);
    assert.equal(run.body.status, "SUCCEEDED");
    assert.equal(run.body.finalCount, 1);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    await coordinator.closeReplicated({ closeDataStores: true });
  }

  const restoredStores = stores(),
    restoredMetadata = await ReplicatedMetadataStore.open({
      backend: metadataBackend,
      project: PROJECT,
      autoFlush: false,
    }),
    restoredData = await ReplicatedDataState.open({
      backend: dataBackend,
      stores: restoredStores,
      project: PROJECT,
      autoFlush: false,
    });
  assert.equal(restoredMetadata.list("offline_sync_run", PROJECT).length, 1);
  assert.equal(restoredStores.landingStore.readTable("raw_positions").length, 1);
  await restoredData.closeReplicated({ closeStores: true });
  await restoredMetadata.closeReplicated();
});
