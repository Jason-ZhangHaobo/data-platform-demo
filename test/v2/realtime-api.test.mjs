import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MetadataStore } from "../../src/v2/store.mjs";
import { StreamStateStore } from "../../src/v2/realtime.mjs";
import { createV2Server } from "../../src/v2/server.mjs";

const fault =
  '{"event_id":"EVT-Q-001","sequence":1,"security_code":"SEC-DEMO-001","event_time":"2026-09-14T09:30:00.000Z","price":"10.00","volume":100}\n' +
  '{"event_id":"EVT-Q-002","sequence":2,"security_code":"SEC-DEMO-002","event_time":"2026-09-14T09:30:01.000Z","price":"101.50","volume":200}\n' +
  '{"event_id":"EVT-Q-003","sequence":3,"security_code":"SEC-DEMO-001","event_time":"2026-09-14T09:30:02.000Z","price":"-1.00","volume":150}\n' +
  '{"event_id":"EVT-Q-004","sequence":4,"security_code":"SEC-DEMO-003","event_time":"2026-09-14T09:30:03.000Z","price":"20.00","volume":80}\n' +
  '{"event_id":"EVT-Q-005","sequence":5,"security_code":"SEC-DEMO-002","event_time":"2026-09-14T09:30:04.000Z","price":"101.80","volume":220}\n' +
  '{"event_id":"EVT-Q-005","sequence":5,"security_code":"SEC-DEMO-002","event_time":"2026-09-14T09:30:04.000Z","price":"101.80","volume":220}\n';
const recovered = fault.replace('"price":"-1.00"', '"price":"10.20"');

async function start({
  store,
  stateStore,
  fixtureRoot,
  local = true,
  realtimePlanner,
}) {
  const app = createV2Server({
    store,
    streamStateStore: stateStore,
    streamFixtureRoot: fixtureRoot,
    realtimeEventDelayMs: 1,
    env: { V2_LOCAL_DEVELOPMENT: String(local) },
    realtimePlanner,
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  return {
    app,
    base: `http://127.0.0.1:${app.server.address().port}/api/v2`,
  };
}
async function request(base, path, body, key = "realtime-api") {
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shuduo-Client": "workbench",
      "Idempotency-Key": key,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
async function waitForJob(base, id, expected) {
  for (let index = 0; index < 100; index++) {
    const response = await request(base, `/streams/jobs/${id}`);
    if (response.body.status === expected) return response.body;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`实时任务未达到${expected}`);
}
async function waitForPlan(base, id, expected) {
  for (let index = 0; index < 100; index++) {
    const response = await request(base, `/streams/agent/plans/${id}`);
    if (response.body.status === expected) return response.body;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`实时Agent方案未达到${expected}`);
}

test("V2 API records a failed stream checkpoint and resumes from a corrected revision", async () => {
  const root = mkdtempSync(join(tmpdir(), "shuduo-realtime-api-")),
    fixtureRoot = join(root, "streams"),
    store = new MetadataStore(join(root, "platform.sqlite")),
    stateStore = new StreamStateStore(join(root, "state.sqlite"));
  mkdirSync(fixtureRoot, { recursive: true });
  writeFileSync(join(fixtureRoot, "fault.jsonl"), fault);
  writeFileSync(join(fixtureRoot, "recovered.jsonl"), recovered);
  let server = await start({ store, stateStore, fixtureRoot });
  try {
    const source = await request(
        server.base,
        "/streams/sources",
        {
          name: "虚构行情事件日志",
          adapter: "local-event-log-v1",
          topic: "market.quotes.demo",
          fileName: "fault.jsonl",
        },
        "stream-source",
      ),
      job = await request(
        server.base,
        "/streams/jobs",
        {
          name: "行情快照实时同步",
          sourceId: source.body.id,
          targetTable: "realtime_quotes",
          checkpointEvery: 2,
          maxOutOfOrderSeconds: 2,
        },
        "stream-job",
      ),
      started = await request(
        server.base,
        `/streams/jobs/${job.body.id}/start`,
        {},
        "stream-first-run",
      );
    assert.equal(source.status, 201);
    assert.equal(job.status, 201);
    assert.equal(started.status, 202);
    const failed = await waitForJob(server.base, job.body.id, "FAILED");
    assert.equal(failed.runs[0].processedCount, 2);
    assert.equal(failed.runs[0].failedOffset, 2);
    assert.equal(failed.checkpoints[0].lastOffset, 1);
    assert.equal(failed.alerts[0].status, "OPEN");
    const replay = await request(
      server.base,
      `/streams/jobs/${job.body.id}/start`,
      {},
      "stream-first-run",
    );
    assert.equal(replay.body.id, started.body.id);
    assert.equal(replay.body.replayed, true);

    const revision = await request(
        server.base,
        `/streams/sources/${source.body.id}/revisions`,
        { fileName: "recovered.jsonl" },
        "stream-fixed-revision",
      ),
      recovering = await request(
        server.base,
        `/streams/jobs/${job.body.id}/recover`,
        { sourceRevisionId: revision.body.id },
        "stream-recovery",
      );
    assert.equal(revision.body.revisionNumber, 2);
    assert.equal(recovering.status, 202);
    assert.equal(recovering.body.startOffset, 2);
    const complete = await waitForJob(server.base, job.body.id, "CAUGHT_UP");
    assert.equal(complete.processedEventCount, 5);
    assert.equal(complete.duplicateCount, 1);
    assert.equal(complete.state.length, 3);
    assert.equal(complete.checkpoints.length, 3);
    assert.equal(complete.alerts[0].status, "RESOLVED");
    assert.equal(
      complete.state.find((row) => row.security_code === "SEC-DEMO-001").price,
      "10.20",
    );
    const monitor = await request(server.base, "/streams/monitor");
    assert.equal(monitor.body.adapter, "local-event-log-v1");
    assert.equal(monitor.body.kafkaConnected, false);
    assert.equal(monitor.body.flinkConnected, false);
    assert.equal(monitor.body.counts.caughtUp, 1);
    assert.equal(monitor.body.counts.failedRuns, 1);
    assert.equal(monitor.body.counts.resolvedAlerts, 1);
    const state = await request(
      server.base,
      `/streams/jobs/${job.body.id}/state`,
    );
    assert.equal(state.body.length, 3);

    await new Promise((resolve) => server.app.server.close(resolve));
    server = await start({
      store,
      stateStore,
      fixtureRoot,
      local: false,
    });
    assert.equal((await request(server.base, "/streams/monitor")).status, 200);
    assert.equal(
      (
        await request(
          server.base,
          "/streams/jobs",
          {
            name: "公开模式拒绝",
            sourceId: source.body.id,
          },
          "public-stream-job",
        )
      ).status,
      401,
    );
  } finally {
    await new Promise((resolve) => server.app.server.close(resolve));
    stateStore.close();
    store.close();
  }
});

test("V2 stream API rejects unsupported adapters and missing fixture paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "shuduo-realtime-api-deny-")),
    fixtureRoot = join(root, "streams"),
    store = new MetadataStore(join(root, "platform.sqlite")),
    stateStore = new StreamStateStore(":memory:");
  mkdirSync(fixtureRoot, { recursive: true });
  writeFileSync(join(fixtureRoot, "fault.jsonl"), fault);
  const server = await start({ store, stateStore, fixtureRoot });
  try {
    const adapter = await request(
      server.base,
      "/streams/sources",
      {
        name: "错误Kafka声明",
        adapter: "kafka",
        topic: "market.quotes.demo",
        fileName: "fault.jsonl",
      },
      "bad-adapter",
    );
    assert.equal(adapter.status, 422);
    assert.equal(adapter.body.code, "UNSUPPORTED_STREAM_ADAPTER");
    const missing = await request(
      server.base,
      "/streams/sources",
      {
        name: "缺失事件日志",
        adapter: "local-event-log-v1",
        topic: "market.quotes.demo",
        fileName: "missing.jsonl",
      },
      "missing-stream",
    );
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, "STREAM_FILE_NOT_FOUND");
    assert.equal(store.list("stream_source", "project-securities-lab").length, 0);
  } finally {
    await new Promise((resolve) => server.app.server.close(resolve));
    stateStore.close();
    store.close();
  }
});

test("Data Agent creates a validated realtime draft only after governed apply", async () => {
  const root = mkdtempSync(join(tmpdir(), "shuduo-realtime-agent-api-")),
    fixtureRoot = join(root, "streams"),
    store = new MetadataStore(join(root, "platform.sqlite")),
    stateStore = new StreamStateStore(":memory:");
  mkdirSync(fixtureRoot, { recursive: true });
  writeFileSync(join(fixtureRoot, "fault.jsonl"), fault);
  const server = await start({
    store,
    stateStore,
    fixtureRoot,
    realtimePlanner: async ({ sources }) => ({
      plan: {
        kind: "REALTIME_SYNC",
        name: "Agent行情同步草稿",
        sourceId: sources[0].id,
        targetTable: "agent_realtime_quotes",
        checkpointEvery: 2,
        maxOutOfOrderSeconds: 3,
      },
      explanation: "基于已登记事件契约生成，不自动启动",
      model: "TEST_DOUBLE",
      usage: { total_tokens: 120 },
    }),
  });
  try {
    const source = await request(
        server.base,
        "/streams/sources",
        {
          name: "Agent虚构行情源",
          adapter: "local-event-log-v1",
          topic: "market.quotes.demo",
          fileName: "fault.jsonl",
        },
        "agent-stream-source",
      ),
      started = await request(
        server.base,
        "/streams/agent/plans",
        { message: "为当前虚构行情源生成实时同步任务草稿" },
        "agent-realtime-plan",
      ),
      complete = await waitForPlan(server.base, started.body.id, "SUCCEEDED");
    assert.equal(source.status, 201);
    assert.equal(started.status, 202);
    assert.equal(complete.completionScope, "REALTIME_SYNC_DESIGN");
    assert.equal(complete.fullLifecycleE2E, false);
    assert.equal(complete.proposal.sourceRevisionId, source.body.currentRevisionId);
    assert.equal(complete.proposal.status, "READY");
    assert.equal(store.list("stream_job", "project-securities-lab").length, 0);
    const applied = await request(
      server.base,
      `/streams/agent/plans/${complete.id}/apply`,
      {},
      "apply-agent-realtime-plan",
    );
    assert.equal(applied.status, 201);
    assert.equal(applied.body.status, "READY");
    assert.equal(applied.body.runs.length, 0);
    assert.equal(
      (await request(server.base, `/streams/agent/plans/${complete.id}`)).body
        .status,
      "APPLIED",
    );
  } finally {
    await new Promise((resolve) => server.app.server.close(resolve));
    stateStore.close();
    store.close();
  }
});
