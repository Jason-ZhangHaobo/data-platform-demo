import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  RemoteSparkQueueClient,
  OssSparkQueueTransport,
  SPARK_QUEUE_PREFIXES,
  createQueuedSparkJob,
  createQueuedSparkResult,
  createQueuedSparkCancellation,
  queueConfigFromEnvironment,
  verifyQueuedSparkJob,
  verifyQueuedSparkResult,
  verifyQueuedSparkCancellation,
  consumeQueuedSparkJob,
} from "../../src/v2/remote-spark-queue.mjs";
import { createRemoteSparkWorker } from "../../src/v2/remote-spark-worker.mjs";

const config = queueConfigFromEnvironment({
  V2_SPARK_EXECUTOR_TRANSPORT: "OSS_QUEUE",
  V2_SPARK_EXECUTOR_SECRET: "synthetic-shared-secret-32-characters-long",
  V2_PROJECT_ID: "project-securities-lab",
  V2_SPARK_QUEUE_TIMEOUT_MS: "5000",
  V2_SPARK_QUEUE_POLL_MS: "200",
});
const input = { sql: "SELECT 1", context: { id: "demo" }, validationContexts: [] };
function atomicTransport(objects) {
  return {
    read: async key => objects.get(key),
    create: async (key, body) => {
      if (objects.has(key)) {
        assert.equal(objects.get(key), body);
        return {created:false};
      }
      objects.set(key,body);
      return {created:true};
    },
  };
}

test("signed OSS queue job binds a fixed project, nonce, expiry and result key", () => {
  const queued = createQueuedSparkJob(input, config, { now: 1789900000000, requestId: "11111111-1111-4111-8111-111111111111", nonce: "n".repeat(24) });
  assert.match(queued.jobKey, /jobs\/11111111-1111-4111-8111-111111111111\.json$/);
  assert.match(queued.resultKey, /results\/11111111-1111-4111-8111-111111111111\.json$/);
  assert.equal(queued.cancelKey, `${SPARK_QUEUE_PREFIXES.cancellations}/11111111-1111-4111-8111-111111111111.cancel.json`);
  assert.equal(verifyQueuedSparkJob(queued.job, config, 1789900000100).sql, "SELECT 1");
  assert.throws(() => verifyQueuedSparkJob({ ...queued.job, projectId: "other" }, config, 1789900000100), { code: "SPARK_QUEUE_JOB_INVALID" });
  assert.throws(() => verifyQueuedSparkJob({ ...queued.job, signature: "v1=bad" }, config, 1789900000100), { code: "SPARK_QUEUE_SIGNATURE_INVALID" });
});

test("signed result cannot be substituted across jobs", () => {
  const queued = createQueuedSparkJob(input, config, { now: 1789900000000, requestId: "22222222-2222-4222-8222-222222222222", nonce: "m".repeat(24) });
  const result = createQueuedSparkResult(queued.job, { status: "SUCCEEDED", engine: "Apache Spark" }, config, 1789900000200);
  assert.equal(verifyQueuedSparkResult(result, queued.job.jobId, config).status, "SUCCEEDED");
  assert.throws(() => verifyQueuedSparkResult({ ...result, jobId: "33333333-3333-4333-8333-333333333333" }, queued.job.jobId, config), { code: "SPARK_QUEUE_RESULT_INVALID" });
});

test("queue client persists a cancellation marker and never returns an unsigned result", async () => {
  const objects = new Map(), controller = new AbortController();
  const transport = { create: async (key, body) => { if (objects.has(key)) throw new Error("conflict"); objects.set(key, body); }, read: async (key) => objects.get(key) };
  let clock = 1789900000000;
  const client = new RemoteSparkQueueClient(config, transport, { now: () => clock, wait: async () => { controller.abort(); clock += 300; } });
  await assert.rejects(client.execute({ ...input, signal: controller.signal }), { code: "REMOTE_SPARK_CANCELLED" });
  const cancelKey = [...objects.keys()].find((key) => key.endsWith(".cancel.json"));
  assert.ok(cancelKey.startsWith(`${SPARK_QUEUE_PREFIXES.cancellations}/`));
  const marker = JSON.parse(objects.get(cancelKey));
  assert.equal(verifyQueuedSparkCancellation(marker, marker.jobId, config, clock), "USER_CANCELLED");
});

test("queue timeout leaves a signed cancellation marker for a delayed Worker", async () => {
  const objects = new Map();
  const transport = { create: async (key, body) => objects.set(key, body), read: async (key) => objects.get(key) };
  let clock = 1789900000000;
  const client = new RemoteSparkQueueClient(config, transport, { now: () => clock, wait: async () => { clock += 5000; } });
  await assert.rejects(client.execute(input), { code: "REMOTE_SPARK_TIMEOUT" });
  const marker = JSON.parse(objects.get([...objects.keys()].find((key) => key.endsWith(".cancel.json"))));
  assert.equal(verifyQueuedSparkCancellation(marker, marker.jobId, config, clock), "DEADLINE");
});

test("exact rehearsal uses one OSS PUT and can read a signed result after expiry without writing cancellation", async () => {
  const requests=[];
  let clock=1789900000000, result;
  const transport=new OssSparkQueueTransport({bucket:"synthetic-securities",endpoint:"oss.example.invalid",
    credentials:{accessKeyId:"synthetic-id",accessKeySecret:"synthetic-secret"}},async(url,options)=>{
    requests.push({url,method:options.method});
    if(options.method==="PUT"){
      assert.equal(options.headers["x-oss-forbid-overwrite"],"true");
      throw new TypeError("simulated response loss");
    }
    return result ? new Response(JSON.stringify(result),{status:200}) : new Response(null,{status:404});
  },{sleep:async()=>assert.fail("exact submission must not retry transport")});
  const client=new RemoteSparkQueueClient(config,transport,{now:()=>clock});
  const prepared=client.prepare(input,"11111111-1111-4111-8111-111111111111");
  await assert.rejects(client.submitPrepared(prepared,{retry:false}));
  assert.deepEqual(requests.map(request=>request.method),["PUT"]);
  clock+=config.timeoutMs+1;
  assert.equal(await client.readPreparedResult(prepared,{cancelOnTimeout:false}),undefined);
  result=createQueuedSparkResult(prepared.job,{status:"SUCCEEDED"},config,clock);
  assert.deepEqual(await client.readPreparedResult(prepared,{cancelOnTimeout:false}),{status:"SUCCEEDED"});
  assert.deepEqual(requests.map(request=>request.method),["PUT","GET","GET"]);
  assert.ok(requests.slice(1).every(request=>request.url.endsWith(prepared.resultKey)));
});

test("OSS must reject overwriting the claim before allowing execution", async () => {
  const time=1789900000100, queued=createQueuedSparkJob(input,config,{now:time});
  for (const enforceCreateOnly of [true,false]) {
    const objects=new Map([[queued.jobKey,JSON.stringify(queued.job)]]), requests=[];
    const transport=new OssSparkQueueTransport({bucket:"synthetic-securities",endpoint:"oss.example.invalid",
      credentials:{accessKeyId:"synthetic-id",accessKeySecret:"synthetic-secret"}},async (url,options)=>{
      const key=new URL(url).pathname.slice(1);
      requests.push({key,method:options.method});
      if(options.method==="GET")return objects.has(key)?new Response(objects.get(key)):new Response(null,{status:404});
      assert.equal(options.headers["x-oss-forbid-overwrite"],"true");
      if(enforceCreateOnly&&objects.has(key))return new Response(null,{status:409});
      objects.set(key,options.body);
      return new Response(null,{status:200});
    });
    let starts=0;
    const consume=()=>consumeQueuedSparkJob({jobKey:queued.jobKey,config,transport,now:()=>time,
      runner:async()=>{starts++;return {status:"SUCCEEDED"};}});
    if(enforceCreateOnly)assert.equal((await consume()).status,"SUCCEEDED");
    else await assert.rejects(consume(),{code:"SPARK_QUEUE_CREATE_ONLY_UNVERIFIED"});
    assert.equal(starts,Number(enforceCreateOnly));
    const claimKey=config.resultPrefix+"/"+queued.job.jobId+".claim";
    assert.deepEqual(requests.filter(r=>r.method==="PUT").map(r=>r.key),
      [claimKey,claimKey,...(enforceCreateOnly?[queued.resultKey]:[])]);
    assert.equal(objects.has(queued.resultKey),enforceCreateOnly);
  }
});

test("an unconfirmed claim is retained and neither a replacement nor a replay starts Spark", async () => {
  const time=1789900000100, queued=createQueuedSparkJob(input,config,{now:time});
  const objects=new Map([[queued.jobKey,JSON.stringify(queued.job)]]), transport=atomicTransport(objects);
  const options={jobKey:queued.jobKey,config,now:()=>time,runner:()=>assert.fail("unconfirmed claim must not start Spark")};
  await assert.rejects(consumeQueuedSparkJob({...options,transport:{...transport,create:async(key,body,options)=>{
    assert.deepEqual(options,{retry:false,verifyCreateOnly:true});
    await transport.create(key,body);
    throw Error("synthetic claim acknowledgement lost");
  }}}),/acknowledgement lost/);
  assert.equal(objects.size,2);
  const pending=await consumeQueuedSparkJob({...options,transport});
  assert.equal(pending.status,"RESULT_PENDING");
  assert.equal(pending.jobId,queued.job.jobId);
  assert.equal(objects.has(queued.resultKey),false);
  objects.set(queued.resultKey,JSON.stringify(createQueuedSparkResult(queued.job,{status:"SUCCEEDED"},config,time)));
  assert.equal((await consumeQueuedSparkJob({...options,transport})).status,"SUCCEEDED");
});

test("Worker consumer executes only a signed create-only job and writes a bound result", async () => {
  const objects = new Map(), queued = createQueuedSparkJob(input, config, {
    now: 1789900000000,
    requestId: "44444444-4444-4444-8444-444444444444",
    nonce: "q".repeat(24),
  });
  objects.set(queued.jobKey, JSON.stringify(queued.job));
  const transport = atomicTransport(objects);
  const consumed = await consumeQueuedSparkJob({
    jobKey: queued.jobKey,
    config,
    transport,
    now: () => 1789900000100,
    runner: async (value) => ({ status: "SUCCEEDED", engine: "Apache Spark", observedSql: value.sql }),
  });
  assert.equal(consumed.status, "SUCCEEDED");
  const stored = JSON.parse(objects.get(queued.resultKey));
  assert.equal(verifyQueuedSparkResult(stored, queued.job.jobId, config).observedSql, "SELECT 1");
  assert.equal(verifyQueuedSparkResult(stored, queued.job.jobId, config).queueJobDigest,
    createHash("sha256").update(objects.get(queued.jobKey)).digest("hex"));
  const replay = await consumeQueuedSparkJob({
    jobKey: queued.jobKey,
    config,
    transport,
    now: () => 1789900006000,
    runner: async () => assert.fail("must not execute after a signed result is stored"),
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.status, "SUCCEEDED");
  assert.equal(objects.get(queued.resultKey), JSON.stringify(stored));
  await assert.rejects(
    consumeQueuedSparkJob({ jobKey: "other/job.json", config, transport, runner: async () => ({}) }),
    { code: "SPARK_QUEUE_JOB_KEY_INVALID" },
  );
  const wrongKey = `${config.jobPrefix}/99999999-9999-4999-8999-999999999999.json`;
  objects.set(wrongKey, JSON.stringify(queued.job));
  await assert.rejects(
    consumeQueuedSparkJob({ jobKey: wrongKey, config, transport, now: () => 1789900000100, runner: async () => assert.fail("wrong job key must not run") }),
    { code: "SPARK_QUEUE_JOB_KEY_INVALID" },
  );
});

test("Worker consumer honors a valid cancellation marker before running", async () => {
  const objects = new Map(), queued = createQueuedSparkJob(input, config, {
    now: 1789900000000,
    requestId: "55555555-5555-4555-8555-555555555555",
    nonce: "r".repeat(24),
  });
  objects.set(queued.jobKey, JSON.stringify(queued.job));
  objects.set(queued.cancelKey, JSON.stringify(createQueuedSparkCancellation(queued.job.jobId, config, 1789900000050)));
  const transport = atomicTransport(objects);
  const result = await consumeQueuedSparkJob({
    jobKey: queued.jobKey, config, transport, now: () => 1789900000100,
    runner: async () => { throw new Error("must not run"); },
  });
  assert.equal(result.status, "CANCELLED");
});

test("a forged cancellation marker cannot stop or execute a queued job", async () => {
  const objects = new Map(), queued = createQueuedSparkJob(input, config, {
    now: 1789900000000,
    requestId: "77777777-7777-4777-8777-777777777777",
    nonce: "u".repeat(24),
  });
  const marker = createQueuedSparkCancellation(queued.job.jobId, config, 1789900000050);
  objects.set(queued.jobKey, JSON.stringify(queued.job));
  objects.set(queued.cancelKey, JSON.stringify({ ...marker, reason: "DEADLINE" }));
  const transport = { read: async (key) => objects.get(key), create: async () => assert.fail("must not create a result") };
  assert.throws(() => verifyQueuedSparkCancellation({ ...marker, reason: "DEADLINE" }, queued.job.jobId, config, 1789900000100), { code: "SPARK_QUEUE_CANCEL_INVALID" });
  await assert.rejects(consumeQueuedSparkJob({
    jobKey: queued.jobKey, config, transport, now: () => 1789900000100,
    runner: async () => assert.fail("must not execute a forged cancellation"),
  }), { code: "SPARK_QUEUE_CANCEL_INVALID" });
});

test("Worker interrupts an active Spark process after a signed cancellation", async () => {
  const objects = new Map(), queued = createQueuedSparkJob(input, config, {
    now: 1789900000000,
    requestId: "88888888-8888-4888-8888-888888888888",
    nonce: "v".repeat(24),
  });
  objects.set(queued.jobKey, JSON.stringify(queued.job));
  const transport = atomicTransport(objects);
  let aborted = false;
  const pending = consumeQueuedSparkJob({
    jobKey: queued.jobKey, config, transport, now: () => 1789900000100,
    runner: ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => { aborted = true; reject(new Error("Spark process stopped")); }, { once: true });
    }),
  });
  setTimeout(() => objects.set(queued.cancelKey,
    JSON.stringify(createQueuedSparkCancellation(queued.job.jobId, config, 1789900000050))), 20);
  const result = await pending;
  assert.equal(aborted, true);
  assert.equal(result.status, "CANCELLED");
  assert.equal(verifyQueuedSparkResult(JSON.parse(objects.get(queued.resultKey)), queued.job.jobId, config).code, "REMOTE_SPARK_CANCELLED");
});

test("queue prefixes reject overlap so cancellations cannot trigger job execution", () => {
  assert.throws(() => queueConfigFromEnvironment({
    V2_SPARK_EXECUTOR_TRANSPORT: "OSS_QUEUE",
    V2_SPARK_EXECUTOR_SECRET: config.sharedSecret,
    V2_SPARK_QUEUE_CANCELLATION_PREFIX: `${config.jobPrefix}/nested`,
  }), /队列前缀不合法/);
});

test("overlapping native OSS deliveries execute the signed job once and return its original result", async () => {
  const objects = new Map(), queued = createQueuedSparkJob(input, config, {
    now: 1789900000000,
    requestId: "66666666-6666-4666-8666-666666666666",
    nonce: "s".repeat(24),
  });
  objects.set(queued.jobKey, JSON.stringify(queued.job));
  const transport = {
    config: { bucket: "synthetic-bucket" },
    ...atomicTransport(objects),
  };
  const entered=Promise.withResolvers(), finish=Promise.withResolvers();
  let starts=0;
  const app = createRemoteSparkWorker({
    env: {
      V2_SPARK_WORKER_SECRET: config.sharedSecret,
      V2_SPARK_QUEUE_CONSUMER_ENABLED: "true",
    },
    queueConfig: config,
    queueTransport: transport,
    now: () => 1789900000100,
    runner: async () => {
      starts++;
      entered.resolve();
      await finish.promise;
      return { status: "SUCCEEDED", engine: "Apache Spark", engineVersion: "3.5.9", validation: { passed: true } };
    },
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  try {
    const invoke = key => fetch(`http://127.0.0.1:${app.server.address().port}/invoke`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      signal:AbortSignal.timeout(5000),
      body: JSON.stringify({
        events: [{
          eventName: "ObjectCreated:PutObject",
          eventSource: "acs:oss",
          region: "cn-hangzhou",
          oss: { bucket: { name: "synthetic-bucket" }, object: { key } },
        }],
      }),
    });
    const first=invoke(queued.jobKey);
    await Promise.race([entered.promise,first.then(()=>assert.fail("Worker returned before entering the runner"))]);
    const replay=await invoke(queued.jobKey);
    assert.equal(replay.status,202);
    assert.equal((await replay.json()).status,"RESULT_PENDING");
    assert.equal(starts,1);
    assert.equal(objects.has(queued.resultKey),false);
    const claimKey=[...objects.keys()].find(key=>key.endsWith(".claim"));
    assert.ok(claimKey.startsWith(config.resultPrefix+"/"));
    assert.equal((await invoke(claimKey)).status,422);
    finish.resolve();
    const response=await first;
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {
      protocol: "shuduo-spark-queue-trigger/v1",
      status: "SUCCEEDED",
      jobId: queued.job.jobId,
      publicReady: false,
    });
    assert.equal(objects.has(queued.resultKey), true);
    assert.equal((await (await invoke(queued.jobKey)).json()).status,"SUCCEEDED");
    assert.equal(starts,1);
  } finally {
    finish.resolve();
    app.server.closeAllConnections();
    await new Promise((resolve) => app.server.close(resolve));
  }
});
