import test from "node:test";
import assert from "node:assert/strict";
import { LandingStore } from "../../src/v2/ingestion.mjs";
import { StreamStateStore } from "../../src/v2/realtime.mjs";
import { BusinessQueryStore } from "../../src/v2/data-services.mjs";
import { ReportDataStore } from "../../src/v2/reports.mjs";
import {
  MemoryDataStateBackend,
  ReplicatedDataState,
} from "../../src/v2/data-state-replica.mjs";
import {
  MemorySnapshotBackend,
  ReplicatedMetadataStore,
} from "../../src/v2/metadata-replica.mjs";
import { CloudStateCoordinator } from "../../src/v2/cloud-state-coordinator.mjs";
import { PROJECT } from "../../src/v2/server.mjs";

const makeStores = () => ({
  landingStore: new LandingStore(),
  streamStateStore: new StreamStateStore(),
  businessStore: new BusinessQueryStore(),
  reportStore: new ReportDataStore(),
});

const writeAllStoreTypes = (stores, suffix = "001") => {
  stores.landingStore.sync({
    targetTable: "raw_positions",
    mode: "INCREMENTAL_UPSERT",
    rows: [{ position_id: `POS-${suffix}`, market_value: "1000.00" }],
    mapping: {
      position_id: "position_id",
      market_value: "market_value",
    },
    keyFields: ["position_id"],
    sourceHash: `source-${suffix}`,
    syncedAt: "2026-09-15T00:00:00.000Z",
  });
  const event = {
    event_id: `EVT-${suffix}`,
    sequence: 1,
    security_code: `SEC-${suffix}`,
    event_time: "2026-09-15T01:00:00.000Z",
    price: "10.00",
    volume: 100,
  };
  stores.streamStateStore.applyEvent(
    "stream-job-001",
    event,
    0,
    "2026-09-15T01:00:01.000Z",
  );
  stores.streamStateStore.checkpoint({
    jobId: "stream-job-001",
    runId: "stream-run-001",
    sourceRevisionId: "stream-source-revision-001",
    lastOffset: 0,
    duplicateCount: 0,
    watermark: "2026-09-15T00:59:55.000Z",
    prefixHash: `prefix-${suffix}`,
    createdAt: "2026-09-15T01:00:02.000Z",
  });
  stores.businessStore.materialize(`release-run-${suffix}`, [
    {
      client_id: `CLIENT-${suffix}`,
      holding_market_value: "1000.00",
      available_cash: "200.00",
      total_assets: "1200.00",
      security_count: 1,
    },
  ]);
  return stores.reportStore.materialize(
    "asset-client-holdings",
    [{ client_id: `CLIENT-${suffix}`, total_assets: "1200.00" }],
    "2026-09-15T01:00:03.000Z",
  );
};

test("OSS-style data state survives a cold reopen for all four SQLite indexes", async () => {
  const backend = new MemoryDataStateBackend(),
    firstStores = makeStores(),
    first = await ReplicatedDataState.open({
      backend,
      stores: firstStores,
      project: PROJECT,
    }),
    reportSnapshot = writeAllStoreTypes(firstStores);
  await first.flush();
  assert.equal(first.replicationStatus().remoteRevision, 1);
  assert.equal(first.replicationStatus().rowCounts.landingRows, 1);

  const secondStores = makeStores(),
    second = await ReplicatedDataState.open({
      backend,
      stores: secondStores,
      project: PROJECT,
    });
  assert.equal(secondStores.landingStore.readTable("raw_positions").length, 1);
  assert.equal(secondStores.streamStateStore.eventCount("stream-job-001"), 1);
  assert.equal(secondStores.streamStateStore.checkpoints("stream-job-001").length, 1);
  assert.equal(
    secondStores.businessStore.queryAssets("release-run-001").rows[0]
      .total_assets,
    "1200.00",
  );
  assert.equal(secondStores.reportStore.read(reportSnapshot.id).rowCount, 1);
  await second.closeReplicated({ closeStores: true });
  await first.closeReplicated({ closeStores: true });
});

test("data state compare-and-swap rejects a stale writer and restores the winner", async () => {
  const backend = new MemoryDataStateBackend(),
    winnerStores = makeStores(),
    staleStores = makeStores(),
    winner = await ReplicatedDataState.open({
      backend,
      stores: winnerStores,
      project: PROJECT,
      autoFlush: false,
    }),
    stale = await ReplicatedDataState.open({
      backend,
      stores: staleStores,
      project: PROJECT,
      autoFlush: false,
    });
  writeAllStoreTypes(winnerStores, "WINNER");
  await winner.flush();
  writeAllStoreTypes(staleStores, "LOSER");
  await assert.rejects(stale.flush(), {
    status: 409,
    code: "CLOUD_DATA_STATE_CONFLICT",
  });
  assert.equal((await stale.refresh()).recoveredFromConflict, true);
  assert.equal(staleStores.landingStore.readTable("raw_positions")[0].position_id, "POS-WINNER");
  await stale.closeReplicated({ closeStores: true });
  await winner.closeReplicated({ closeStores: true });
});

test("cloud coordinator durably flushes metadata and data as one request boundary", async () => {
  const metadataBackend = new MemorySnapshotBackend(),
    dataBackend = new MemoryDataStateBackend(),
    firstStores = makeStores(),
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
  metadata.create("sync_run", PROJECT, { status: "SUCCEEDED" });
  writeAllStoreTypes(firstStores);
  await coordinator.flush();
  const status = coordinator.replicationStatus();
  assert.equal(status.healthy, true);
  assert.equal(status.metadata.remoteRevision, 1);
  assert.equal(status.dataState.remoteRevision, 1);
  await coordinator.closeReplicated({ closeDataStores: true });

  const restoredStores = makeStores(),
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
  assert.equal(restoredMetadata.list("sync_run", PROJECT).length, 1);
  assert.equal(restoredStores.landingStore.readTable("raw_positions").length, 1);
  await restoredData.closeReplicated({ closeStores: true });
  await restoredMetadata.closeReplicated();
});
