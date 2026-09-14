import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { MetadataStore } from "../../src/v2/store.mjs";
import {
  RealtimeManager,
  StreamStateStore,
  validateQuoteEvent,
} from "../../src/v2/realtime.mjs";
import { PROJECT } from "../../src/v2/server.mjs";

const fault =
  '{"event_id":"EVT-Q-001","sequence":1,"security_code":"SEC-DEMO-001","event_time":"2026-09-14T09:30:00.000Z","price":"10.00","volume":100}\n' +
  '{"event_id":"EVT-Q-002","sequence":2,"security_code":"SEC-DEMO-002","event_time":"2026-09-14T09:30:01.000Z","price":"101.50","volume":200}\n' +
  '{"event_id":"EVT-Q-003","sequence":3,"security_code":"SEC-DEMO-001","event_time":"2026-09-14T09:30:02.000Z","price":"-1.00","volume":150}\n' +
  '{"event_id":"EVT-Q-004","sequence":4,"security_code":"SEC-DEMO-003","event_time":"2026-09-14T09:30:03.000Z","price":"20.00","volume":80}\n' +
  '{"event_id":"EVT-Q-005","sequence":5,"security_code":"SEC-DEMO-002","event_time":"2026-09-14T09:30:04.000Z","price":"101.80","volume":220}\n' +
  '{"event_id":"EVT-Q-005","sequence":5,"security_code":"SEC-DEMO-002","event_time":"2026-09-14T09:30:04.000Z","price":"101.80","volume":220}\n';
const recovered = fault.replace('"price":"-1.00"', '"price":"10.20"');

function setup(options = {}) {
  const root = mkdtempSync(join(tmpdir(), "shuzhan-realtime-")),
    fixtureRoot = join(root, "streams"),
    store = new MetadataStore(join(root, "platform.sqlite")),
    stateStore = new StreamStateStore(join(root, "state.sqlite"));
  mkdirSync(fixtureRoot, { recursive: true });
  writeFileSync(join(fixtureRoot, "fault.jsonl"), fault);
  writeFileSync(join(fixtureRoot, "recovered.jsonl"), recovered);
  const manager = new RealtimeManager({
    store,
    stateStore,
    project: PROJECT,
    fixtureRoot,
    eventDelayMs: 1,
    ...options,
  });
  return {
    root,
    fixtureRoot,
    store,
    stateStore,
    manager,
    close() {
      manager.shutdown();
      stateStore.close();
      store.close();
    },
  };
}
function createFaultJob(manager) {
  const source = manager.createSource({
      name: "虚构行情事件日志",
      adapter: "local-event-log-v1",
      topic: "market.quotes.demo",
      fileName: "fault.jsonl",
    }),
    job = manager.createJob({
      name: "行情快照实时同步",
      sourceId: source.id,
      targetTable: "realtime_quotes",
      checkpointEvery: 2,
      maxOutOfOrderSeconds: 2,
    });
  return { source, job };
}

test("quote event contract rejects invalid prices and unknown fields", () => {
  const valid = validateQuoteEvent({
    event_id: "EVT-Q-001",
    sequence: 1,
    security_code: "SEC-DEMO-001",
    event_time: "2026-09-14T09:30:00.000Z",
    price: "10.0",
    volume: 100,
  });
  assert.equal(valid.price, "10.00");
  assert.throws(
    () => validateQuoteEvent({ ...valid, price: "-1.00" }),
    { status: 422, code: "INVALID_QUOTE_PRICE" },
  );
  assert.throws(
    () => validateQuoteEvent({ ...valid, unexpected: true }),
    { status: 422, code: "INVALID_QUOTE_EVENT" },
  );
});

test("repository event logs are synthetic, prefix-compatible and retain a controlled fault", () => {
  const root = resolve("fixtures/streams"),
    broken = readFileSync(join(root, "quotes_fault.jsonl"), "utf8")
      .trim()
      .split("\n"),
    fixed = readFileSync(join(root, "quotes_recovered.jsonl"), "utf8")
      .trim()
      .split("\n");
  assert.equal(broken.length, 6);
  assert.equal(fixed.length, 6);
  assert.deepEqual(broken.slice(0, 2), fixed.slice(0, 2));
  assert.match(broken[2], /"-1\.00"/);
  assert.match(fixed[2], /"10\.20"/);
  assert.ok(fixed.every((line) => line.includes("SEC-DEMO-")));
});

test("stream fails after a durable checkpoint and recovers without duplicates", async () => {
  const app = setup();
  try {
    const { source, job } = createFaultJob(app.manager),
      first = app.manager.startJob(job.id, {
        requestKey: "stream-first",
        requestSignature: "fault-revision",
      });
    assert.equal(first.status, "RUNNING");
    await app.manager.waitForIdle();
    let detail = app.manager.jobDetail(job.id);
    assert.equal(detail.status, "FAILED");
    assert.equal(detail.runs[0].status, "FAILED");
    assert.equal(detail.runs[0].processedCount, 2);
    assert.equal(detail.runs[0].lastOffset, 1);
    assert.equal(detail.runs[0].failedOffset, 2);
    assert.equal(detail.runs[0].errorCode, "INVALID_QUOTE_PRICE");
    assert.equal(detail.checkpoints.length, 1);
    assert.equal(detail.checkpoints[0].lastOffset, 1);
    assert.equal(detail.checkpoints[0].eventCount, 2);
    assert.equal(detail.state.length, 2);
    assert.equal(detail.alerts[0].status, "OPEN");

    const revision = app.manager.createSourceRevision(source.id, {
        fileName: "recovered.jsonl",
      }),
      recovery = app.manager.recoverJob(
        job.id,
        { sourceRevisionId: revision.id },
        { requestKey: "stream-recovery", requestSignature: "fixed-revision" },
      );
    assert.equal(recovery.recovery, true);
    assert.equal(recovery.startOffset, 2);
    await app.manager.waitForIdle();
    detail = app.manager.jobDetail(job.id);
    const recoveryRun = detail.runs.find((run) => run.id === recovery.id);
    assert.equal(detail.status, "CAUGHT_UP");
    assert.equal(recoveryRun.status, "SUCCEEDED");
    assert.equal(recoveryRun.processedCount, 3);
    assert.equal(recoveryRun.duplicateCount, 1);
    assert.equal(recoveryRun.eventCount, 5);
    assert.equal(detail.state.length, 3);
    assert.equal(
      detail.state.find((row) => row.security_code === "SEC-DEMO-001").price,
      "10.20",
    );
    assert.equal(
      detail.state.find((row) => row.security_code === "SEC-DEMO-002").price,
      "101.80",
    );
    assert.equal(detail.alerts[0].status, "RESOLVED");
    assert.equal(detail.alerts[0].recoveryRunId, recovery.id);
    assert.equal(detail.duplicateCount, 1);
    assert.equal(detail.watermark, "2026-09-14T09:30:02.000Z");
    assert.ok(detail.lagMs >= 0);
    assert.ok(detail.throughputPerSecond > 0);
    assert.equal(detail.publicDeployed, false);
    assert.equal(detail.fullLifecycleE2E, false);
  } finally {
    app.close();
  }
});

test("recovery rejects logs whose checkpoint prefix changed", async () => {
  const app = setup();
  try {
    const { source, job } = createFaultJob(app.manager);
    app.manager.startJob(job.id);
    await app.manager.waitForIdle();
    writeFileSync(
      join(app.fixtureRoot, "mismatch.jsonl"),
      recovered.replace("EVT-Q-001", "EVT-Q-CHANGED"),
    );
    const revision = app.manager.createSourceRevision(source.id, {
      fileName: "mismatch.jsonl",
    });
    assert.throws(
      () =>
        app.manager.recoverJob(job.id, { sourceRevisionId: revision.id }),
      { status: 409, code: "CHECKPOINT_PREFIX_MISMATCH" },
    );
    assert.equal(app.manager.jobDetail(job.id).status, "FAILED");
  } finally {
    app.close();
  }
});

test("stream can be stopped and retains a terminal run", async () => {
  const app = setup({ eventDelayMs: 25 });
  try {
    const { job } = createFaultJob(app.manager),
      run = app.manager.startJob(job.id);
    app.manager.stopJob(job.id);
    await app.manager.waitForIdle();
    const detail = app.manager.jobDetail(job.id),
      stopped = detail.runs.find((item) => item.id === run.id);
    assert.equal(detail.status, "STOPPED");
    assert.equal(stopped.status, "STOPPED");
    assert.equal(stopped.errorCode, "STREAM_STOPPED");
    assert.equal(detail.alerts.length, 0);
  } finally {
    app.close();
  }
});

test("service restart converts an active stream into explicit interrupted state", () => {
  const app = setup();
  try {
    const source = app.store.create("stream_source", PROJECT, {
        name: "重启源",
        adapter: "local-event-log-v1",
      }),
      revision = app.store.create("stream_source_revision", PROJECT, {
        sourceId: source.id,
        fileName: "fault.jsonl",
      }),
      run = app.store.create("stream_run", PROJECT, {
        jobId: "pending-job",
        status: "RUNNING",
      }),
      job = app.store.create("stream_job", PROJECT, {
        id: "pending-job",
        name: "中断任务",
        sourceId: source.id,
        sourceRevisionId: revision.id,
        lastRunId: run.id,
        status: "RUNNING",
      });
    app.store.update("stream_run", run.id, PROJECT, { jobId: job.id });
    app.store.interruptPending(PROJECT);
    const next = new RealtimeManager({
      store: app.store,
      stateStore: app.stateStore,
      project: PROJECT,
      fixtureRoot: app.fixtureRoot,
      eventDelayMs: 1,
    });
    assert.equal(app.store.get("stream_run", run.id, PROJECT).status, "INTERRUPTED");
    assert.equal(app.store.get("stream_job", job.id, PROJECT).status, "INTERRUPTED");
    next.shutdown();
  } finally {
    app.close();
  }
});

test("stream source rejects paths and symlinks", () => {
  const app = setup();
  try {
    assert.throws(
      () =>
        app.manager.createSource({
          name: "越界事件源",
          adapter: "local-event-log-v1",
          topic: "market.quotes.demo",
          fileName: "../outside.jsonl",
        }),
      { status: 400, code: "INVALID_STREAM_FILE" },
    );
    symlinkSync(
      join(app.fixtureRoot, "fault.jsonl"),
      join(app.fixtureRoot, "linked.jsonl"),
    );
    assert.throws(
      () =>
        app.manager.createSource({
          name: "符号链接事件源",
          adapter: "local-event-log-v1",
          topic: "market.quotes.demo",
          fileName: "linked.jsonl",
        }),
      { status: 422, code: "STREAM_SYMLINK_FORBIDDEN" },
    );
  } finally {
    app.close();
  }
});
