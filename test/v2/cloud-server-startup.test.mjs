import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalArtifactStore } from "../../src/v2/artifact-store.mjs";
import { createCloudV2Application } from "../../src/v2/cloud-server.mjs";
import { MemoryDataStateBackend } from "../../src/v2/data-state-replica.mjs";
import { MemorySnapshotBackend, ReplicatedMetadataStore } from "../../src/v2/metadata-replica.mjs";
import { PROJECT } from "../../src/v2/server.mjs";

const cloudEnv = { V2_FC_PUBLIC_HTTP_ENABLED: "true", V2_FC_PUBLIC_READ_ONLY: "true" };
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "shuduo-cloud-startup-"));
  mkdirSync(join(root, "web-dist"));
  writeFileSync(join(root, "web-dist", "index.html"), "<html>Fictional cloud startup</html>");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, createArtifactStore: () => new LocalArtifactStore(join(root, "artifacts")) };
}
async function closeApp({ app, stateCoordinator }) {
  app.server.closeAllConnections();
  await new Promise(resolve => app.server.close(resolve));
  await stateCoordinator.closeReplicated({ closeDataStores: true });
}

test("cloud startup overlaps only the Worker read and waits for persistence and verification before returning the app", { timeout: 5000 }, async t => {
  const options = fixture(t), metadata = new MemorySnapshotBackend(), dataBackend = new MemoryDataStateBackend();
  const seed = await ReplicatedMetadataStore.open({ backend: metadata, project: PROJECT, autoFlush: false });
  const prior = seed.create("run", PROJECT, { status: "RUNNING" });
  await seed.closeReplicated();
  const events = [];
  const mysql = Promise.withResolvers(), oss = Promise.withResolvers(), worker = Promise.withResolvers(),
    enteredOss = Promise.withResolvers(), prefetched = Promise.withResolvers(), flush = Promise.withResolvers(),
    enteredFlush = Promise.withResolvers();
  t.after(() => { for (const gate of [mysql, oss, worker, flush]) gate.resolve(); });
  const readMeta = metadata.load.bind(metadata);
  metadata.load = project => { events.push("metadata"); return readMeta(project); };
  const readOss = dataBackend.load.bind(dataBackend);
  dataBackend.load = async project => {
    events.push("oss"); enteredOss.resolve();
    await oss.promise;
    events.push("oss-restored");
    return readOss(project);
  };
  const commit = metadata.compareAndSwap.bind(metadata);
  metadata.compareAndSwap = async (...args) => {
    events.push("flush"); enteredFlush.resolve();
    await flush.promise;
    return commit(...args);
  };
  const runner = () => assert.fail("Startup must not execute Spark");
  runner.descriptor = { isolation: "REMOTE_FUNCTION", publicWriteEnabled: false };
  runner.prepareVerification = async () => {
    events.push("worker-read");
    await worker.promise;
    events.push("worker-prefetched"); prefetched.resolve();
    return () => {
      events.push("worker-verified");
      runner.descriptor.healthVerified = true;
      runner.descriptor.publicWriteEnabled = true;
    };
  };
  let returned = false;
  const starting = createCloudV2Application(cloudEnv, {
    ...options,
    openMetadataBackend: async () => { events.push("mysql"); await mysql.promise; return metadata; },
    createDataBackend: () => dataBackend,
    createRunner: () => runner,
  }).then(value => { returned = true; return value; });
  assert.deepEqual(events, ["worker-read", "mysql"]);
  mysql.resolve();
  await enteredOss.promise;
  worker.resolve();
  await prefetched.promise;
  assert.deepEqual(events, ["worker-read", "mysql", "metadata", "oss", "worker-prefetched"]);
  assert.equal(runner.descriptor.healthVerified, undefined);
  oss.resolve();
  await enteredFlush.promise;
  assert.deepEqual(events, ["worker-read", "mysql", "metadata", "oss", "worker-prefetched", "oss-restored", "worker-verified", "flush"]);
  assert.equal(returned, false);
  flush.resolve();
  const boot = await starting, { app, timing } = boot;
  t.after(() => closeApp(boot));
  assert.equal(app.server.listening, false);
  assert.equal(app.store.get("run", prior.id, PROJECT).status, "INTERRUPTED");
  assert.ok(["workerEvidenceReadMs", "mysqlOpenMs", "metadataRestoreMs", "dataStateRestoreMs", "workerReadyMs", "initialFlushMs"]
    .every(phase => Number.isSafeInteger(timing[phase])));
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + app.server.address().port;
  assert.equal(await (await fetch(base + "/v2/")).text(), "<html>Fictional cloud startup</html>");
  const denied = await fetch(base + "/api/v2/agent/tasks", { method: "POST", body: "{}" });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).code, "PUBLIC_READ_ONLY");
});

test("a failed prefetched Worker check preserves restored read-only state", async t => {
  const options = fixture(t);
  const runner = () => assert.fail("Startup must not execute Spark");
  runner.descriptor = { isolation: "REMOTE_FUNCTION", healthVerified: false };
  runner.prepareVerification = async () => { throw Object.assign(Error("test evidence unavailable"), { code: "REMOTE_SPARK_NOT_READY" }); };
  const boot = await createCloudV2Application(cloudEnv, {
    ...options, openMetadataBackend: async () => new MemorySnapshotBackend(),
    createDataBackend: () => new MemoryDataStateBackend(), createRunner: () => runner,
  });
  t.after(() => closeApp(boot));
  const { app } = boot;
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + app.server.address().port;
  assert.equal((await fetch(base + "/v2/")).status, 200);
  const session = await (await fetch(base + "/api/v2/auth/session")).json();
  assert.equal(session.authenticated, false);
  assert.equal(session.readOnly, true);
});

test("a persistence failure never commits prefetched Worker readiness and closes the opened backends", async t => {
  const options = fixture(t), metadata = new MemorySnapshotBackend();
  const closed = [];
  metadata.close = async () => { closed.push("metadata"); };
  const runner = () => assert.fail("Startup must not execute Spark");
  runner.prepareVerification = async () => () => assert.fail("Failed startup must not mark the Worker ready");
  const failure = Error("Fictional state restore failure");
  await assert.rejects(createCloudV2Application(cloudEnv, {
    ...options, openMetadataBackend: async () => metadata, createRunner: () => runner,
    createDataBackend: () => ({
      load: async () => { throw failure; },
      close: async () => { closed.push("oss"); },
    }),
  }), failure);
  assert.deepEqual(closed.sort(), ["metadata", "oss"]);
});
