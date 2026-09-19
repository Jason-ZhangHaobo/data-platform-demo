import test from "node:test";
import assert from "node:assert/strict";
import { createV2Server, PROJECT } from "../../src/v2/server.mjs";
import {
  MemorySnapshotBackend,
  ReplicatedMetadataStore,
} from "../../src/v2/metadata-replica.mjs";
import {
  MemoryDataStateBackend,
  ReplicatedDataState,
} from "../../src/v2/data-state-replica.mjs";
import { CloudStateCoordinator } from "../../src/v2/cloud-state-coordinator.mjs";
import { LandingStore } from "../../src/v2/ingestion.mjs";
import { StreamStateStore } from "../../src/v2/realtime.mjs";
import { BusinessQueryStore } from "../../src/v2/data-services.mjs";
import { ReportDataStore } from "../../src/v2/reports.mjs";

const stores = () => ({
  landingStore: new LandingStore(),
  streamStateStore: new StreamStateStore(),
  businessStore: new BusinessQueryStore(),
  reportStore: new ReportDataStore(),
});

async function openPrivateServer(enabled) {
  const metadata = await ReplicatedMetadataStore.open({
      backend: new MemorySnapshotBackend(),
      project: PROJECT,
      autoFlush: false,
    }),
    stateStores = stores(),
    dataState = await ReplicatedDataState.open({
      backend: new MemoryDataStateBackend(),
      stores: stateStores,
      project: PROJECT,
      autoFlush: false,
    }),
    coordinator = new CloudStateCoordinator({ metadata, dataState }),
    app = createV2Server({
      store: metadata,
      ...stateStores,
      stateCoordinator: coordinator,
      env: {
        V2_LOCAL_DEVELOPMENT: "false",
        V2_META_DRIVER: "mysql-project-snapshot-cas",
        V2_PROVISIONING_ONLY: "true",
        V2_PRIVATE_SMOKE_ENABLED: String(enabled),
      },
    });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${app.server.address().port}`,
    async close() {
      await new Promise((resolve) => app.server.close(resolve));
      await coordinator.closeReplicated({ closeDataStores: true });
    },
  };
}

async function invoke(base, body, contentType = "application/octet-stream") {
  const response = await fetch(`${base}/invoke`, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body,
  });
  return { status: response.status, body: await response.json() };
}

test("private FC invoke reports only sanitized MySQL and OSS readiness", async () => {
  const server = await openPrivateServer(true);
  try {
    const result = await invoke(server.base, JSON.stringify({ operation: "PRIVATE_STATUS_V1" }));
    assert.equal(result.status, 200);
    assert.deepEqual(result.body, {
      protocol: "shuduo-v2-private-smoke-v1",
      mode: "PRIVATE_CONTROL_PLANE",
      metadata: { driver: "mysql-project-snapshot-cas", healthy: true },
      persistence: {
        mode: "single-instance-two-store-cas",
        healthy: true,
        dataState: { driver: "oss-json-snapshot-cas", healthy: true },
      },
      publicReady: false,
    });
    assert.equal(JSON.stringify(result.body).includes(PROJECT), false);
  } finally {
    await server.close();
  }
});

test("private FC invoke is disabled by default and rejects any other operation", async () => {
  let server = await openPrivateServer(false);
  try {
    assert.equal((await invoke(server.base, JSON.stringify({ operation: "PRIVATE_STATUS_V1" }))).status, 404);
  } finally {
    await server.close();
  }
  server = await openPrivateServer(true);
  try {
    assert.equal((await invoke(server.base, JSON.stringify({ operation: "RUN_SQL" }))).status, 422);
    assert.equal((await invoke(server.base, "{}", "application/json")).status, 415);
  } finally {
    await server.close();
  }
});
