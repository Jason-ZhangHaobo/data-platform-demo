import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { get } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MetadataStore } from "../../src/v2/store.mjs";
import { StreamStateStore } from "../../src/v2/realtime.mjs";
import { kafkaFlinkEvidence } from "../../src/v2/realtime-kafka-flink.mjs";
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
  kafkaFlinkRunner,
}) {
  const app = createV2Server({
    store,
    streamStateStore: stateStore,
    streamFixtureRoot: fixtureRoot,
    realtimeEventDelayMs: 1,
    env: { V2_LOCAL_DEVELOPMENT: String(local) },
    realtimePlanner,
    kafkaFlinkRunner,
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

test("the registered engine runs once per request and keeps verified Kafka results across restart",async t=>{
  const root=mkdtempSync(join(tmpdir(),"shuduo-kafka-flink-api-"));
  const store=new MetadataStore(join(root,"meta.sqlite"));
  const stateStore=new StreamStateStore(join(root,"stream.sqlite"));
  const fixture=readFileSync("fixtures/streams/quotes_recovered.jsonl","utf8");
  const events=fixture.trim().split("\n").map(line=>JSON.parse(line));
  const finalQuotes=Object.fromEntries(events.map(event=>[event.security_code,event]));
  const value={scope:"LOCAL_KAFKA_FLINK_SYNTHETIC_QUOTES",result:"VERIFIED",kafkaVersion:"4.1.2",flinkVersion:"1.20.5",
    inputEvents:9,committedUpdatesBefore:4,committedUpdatesAfter:5,originalJobId:"a".repeat(32),restoredJobId:"b".repeat(32),
    originalSavepointDigest:"c".repeat(64),restoredSavepointDigest:"d".repeat(64),
    fixtureDigest:createHash("sha256").update(fixture).digest("hex"),finalQuotes};
  let calls=0, reply=Promise.withResolvers();
  const runner=()=>{calls++;return reply.promise;};
  const stop=server=>new Promise(resolve=>server.app.server.close(resolve));
  let server=await start({store,stateStore,kafkaFlinkRunner:runner});
  t.after(async ()=>{
    if (server.app.server.listening) await stop(server);
    store.close();
    stateStore.close();
  });

  const firstList=await request(server.base,"/streams/jobs");
  const [job]=firstList.body;
  assert.equal(job.adapter,"kafka-flink-local-v1");
  assert.equal(job.status,"READY");
  const path="/streams/jobs/"+job.id;
  assert.equal((await request(server.base,path+"/start",{topic:"arbitrary"})).status,422);
  const foreignHostStatus=await new Promise((resolve,reject)=>{
    get(server.base+path,{headers:{host:"example.invalid"}},res=>{res.resume();resolve(res.statusCode);}).on("error",reject);
  });
  assert.equal(foreignHostStatus,404);
  const started=await request(server.base,path+"/start",{},"engine-1");
  assert.equal(started.status,202);
  assert.equal((await request(server.base,path+"/start",{},"engine-1")).body.id,started.body.id);
  assert.equal((await request(server.base,path+"/start",{},"engine-overlap")).status,409);
  assert.equal(calls,1);
  reply.resolve(value);
  const verified=await waitForJob(server.base,job.id,"CAUGHT_UP");
  assert.equal(verified.engineEvidence.runId,started.body.id);
  assert.equal(verified.engineEvidence.committedUpdatesAfter,5);
  assert.deepEqual(verified.checkpoints.map(checkpoint=>checkpoint.stateHash),
    [value.originalSavepointDigest,value.restoredSavepointDigest]);
  assert.deepEqual((await request(server.base,path+"/state")).body,
    verified.state);
  assert.equal((await request(server.base,"/assets")).body.some(asset=>asset.id==="stream:"+job.id),false);
  assert.equal((await request(server.base,"/streams/monitor")).body.kafkaFlinkLocalReady,true);

  reply=Promise.withResolvers();
  const second=await request(server.base,path+"/start",{},"engine-2");
  assert.equal(second.status,202);
  reply.resolve({...value,committedUpdatesAfter:6});
  const failed=await waitForJob(server.base,job.id,"FAILED");
  assert.equal(failed.runs[0].errorCode,"KAFKA_FLINK_EVIDENCE_MISMATCH");
  assert.equal(failed.engineEvidence.runId,started.body.id);
  assert.equal(failed.alerts[0].runId,second.body.id);

  reply=Promise.withResolvers();
  const retry=await request(server.base,path+"/start",{},"engine-stop");
  assert.equal(retry.status,202);
  assert.equal((await request(server.base,path+"/stop",{})).status,202);
  reply.resolve(value);
  const stopped=await waitForJob(server.base,job.id,"STOPPED");
  assert.equal(stopped.runs[0].id,retry.body.id);
  assert.equal(stopped.runs[0].engineResult,undefined);
  assert.equal(stopped.engineEvidence.runId,started.body.id);
  await stop(server);
  server=await start({store,stateStore,kafkaFlinkRunner:runner});
  const persisted=(await request(server.base,path)).body;
  assert.equal(persisted.engineEvidence.runId,started.body.id);
  assert.equal(persisted.runs.length,3);
  assert.equal(calls,3);
  await stop(server);

  runner.checkpointCrash=true;
  server=await start({store,stateStore,kafkaFlinkRunner:runner});
  const crashMode=(await request(server.base,path)).body;
  assert.equal(crashMode.checkpointCrashEnabled,true);
  assert.equal(crashMode.engineEvidence.checkpointRecovery,undefined);
  assert.equal((await request(server.base,path+"/start",{},"engine-1")).status,409);
  reply=Promise.withResolvers();
  const withoutRecovery=await request(server.base,path+"/start",{},"engine-no-crash-proof");
  reply.resolve(value);
  const rejected=await waitForJob(server.base,job.id,"FAILED");
  assert.equal(rejected.runs[0].id,withoutRecovery.body.id);
  assert.equal(rejected.runs[0].errorCode,"KAFKA_FLINK_EVIDENCE_MISMATCH");

  reply=Promise.withResolvers();
  const recovery=await request(server.base,path+"/start",{},"engine-crash-proof");
  const {originalSavepointDigest:checkpointDigest,...shared}=value;
  const checkpointRecovery={checkpointId:2,restoredCheckpointId:2,checkpointDigest,exitCode:137,
    inputOffsetBeforeExit:4,committedUpdatesAtExit:4};
  assert.throws(()=>kafkaFlinkEvidence({...shared,checkpointRecovery:{...checkpointRecovery,restoredCheckpointId:3}},
    {checkpointCrash:true,fixtureDigest:value.fixtureDigest,quotes:Object.values(finalQuotes)}),
    /KAFKA_FLINK_EVIDENCE_MISMATCH/);
  reply.resolve({...shared,checkpointRecovery});
  const recoveredJob=await waitForJob(server.base,job.id,"CAUGHT_UP");
  assert.equal(recoveredJob.engineEvidence.runId,recovery.body.id);
  assert.deepEqual(recoveredJob.engineEvidence.checkpointRecovery,checkpointRecovery);
  assert.equal(recoveredJob.checkpoints[0].checkpointId,2);
  assert.equal(recoveredJob.checkpoints[0].stateHash,checkpointDigest);
  assert.equal(calls,5);
  await stop(server);
  server=await start({store,stateStore,local:false,kafkaFlinkRunner:runner});
  assert.equal(server.app.realtime.listJobs().some(candidate=>candidate.id===job.id),false);
  assert.equal(calls,5);
});

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
    assert.equal((await request(server.base, "/streams/monitor")).status, 401);
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
