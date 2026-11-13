import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalArtifactStore } from "../../src/v2/artifact-store.mjs";
import { AuthManager } from "../../src/v2/auth.mjs";
import { createCloudV2Application, startCloudV2Listener } from "../../src/v2/cloud-server.mjs";
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

test("the read-only listener serves the same public files with a returning session during recovery", {timeout:5000}, async t => {
  const options = fixture(t), gate = Promise.withResolvers();
  const metadata = new MemorySnapshotBackend();
  const seed = await ReplicatedMetadataStore.open({backend:metadata,project:PROJECT,autoFlush:false});
  const auth = new AuthManager({store:seed,project:PROJECT,env:{}});
  const credentials = {email:"returning-engineer@example.invalid",password:"SyntheticReturning!2026"};
  const owner = auth.bootstrapAdmin({...credentials,displayName:"虚构回访工程师"});
  const session = auth.sessionResponse(auth.login(credentials),true);
  await seed.closeReplicated();
  mkdirSync(join(options.root, "web-dist", "assets"));
  writeFileSync(join(options.root, "web-dist", "assets", "index-FictionalHash.js"), "export const sample = true;");
  const env = {...cloudEnv,V2_PROVISIONING_ONLY:"true",V2_PRIVATE_SMOKE_ENABLED:"true"};
  const listener = startCloudV2Listener(env,{...options,port:0,host:"127.0.0.1",
    openMetadataBackend:async()=>{await gate.promise;return metadata;},
    createDataBackend:()=>new MemoryDataStateBackend(),createRunner:()=>undefined});
  t.after(async()=>{gate.resolve();await listener.close();});
  await once(listener.server,"listening");
  const base = "http://127.0.0.1:" + listener.server.address().port;
  env.V2_PUBLIC_ORIGIN = base;
  const read = (path,init) => fetch(base+path,init);
  const html = await read("/v2/?module=agent-center");
  assert.equal(await html.text(),"<html>Fictional cloud startup</html>");
  assert.equal(html.headers.get("cache-control"),"no-cache");
  const script=await read("/v2/assets/index-FictionalHash.js",{headers:{origin:base}});
  assert.equal(await script.text(),"export const sample = true;");
  assert.match(script.headers.get("cache-control"),/immutable/);
  const catalog=await (await read("/api/v2/contexts")).json();
  assert.ok(catalog.some(context=>context.id==="holdings-t1"));
  const [sessionCookie,csrfCookie]=session.cookies.map(cookie=>cookie.split(";",1)[0]);
  const returning={headers:{cookie:[sessionCookie,csrfCookie].join("; ")},signal:AbortSignal.timeout(1000)};
  const returningPage=await read("/v2/?module=agent-center",{
    ...returning,headers:{cookie:csrfCookie},
  });
  assert.equal(await returningPage.text(),"<html>Fictional cloud startup</html>");
  assert.equal(returningPage.headers.get("set-cookie"),null);
  const returningScript=await read("/v2/assets/index-FictionalHash.js",returning);
  assert.equal(await returningScript.text(),"export const sample = true;");
  assert.deepEqual(await (await read("/api/v2/contexts",returning)).json(),catalog);
  const pendingDeepLink=await read("/v2/?module=agent-center&task=00000000-0000-4000-8000-000000000001",returning);
  assert.equal(await pendingDeepLink.text(),"<html>Fictional cloud startup</html>");
  for (const [path,headers] of [["/v2/",{origin:"https://wrong.example"}],
    ["/api/v2/contexts",{"x-project-id":"different-project"}],["/api/v2/internal/status",{}],["/v2/%69ndex",{}]]) {
    const denied=await read(path,{headers});
    assert.ok([403,404].includes(denied.status));
  }
  for (const path of ["/api/v2/status?include=session","/api/v2/auth/session","/api/v2/agent/tasks"]) {
    const pending = await read(path,returning);
    assert.equal(pending.status,503);
    assert.equal(pending.headers.get("retry-after"),"1");
    assert.equal((await pending.json()).code,"CLOUD_STARTUP_PENDING");
  }
  assert.equal((await read("/api/v2/agent/tasks",{method:"POST",body:"{}"})).status,403);
  let eventSettled=false;
  const event=read("/invoke",{method:"POST",headers:{"x-fc-control-path":"/invoke","content-type":"application/octet-stream"},
    body:JSON.stringify({operation:"PRIVATE_STATUS_V1"})}).then(value=>{eventSettled=true;return value;});
  // The private event still waits for recovered state.
  await new Promise(resolve=>setTimeout(resolve,40));
  assert.equal(eventSettled,false);
  gate.resolve();
  const boot = await listener.ready;
  assert.equal(boot.app.server,listener.server);
  assert.equal(listener.server.listenerCount("request"),1);
  assert.deepEqual(await (await read("/api/v2/contexts")).json(),catalog);
  const delivered=await event;
  assert.equal(delivered.status,200);
  assert.equal((await delivered.json()).mode,"PRIVATE_CONTROL_PLANE");
  const authenticated=await (await read("/api/v2/auth/session",{headers:returning.headers})).json();
  assert.equal(authenticated.authenticated,true);
  assert.equal(authenticated.user.id,owner.id);
  assert.equal(authenticated.readOnly,true);
  const guest=await (await read("/api/v2/auth/session")).json();
  assert.equal(guest.authenticated,false);
  assert.equal(guest.readOnly,true);
  assert.equal((await read("/api/v2/agent/tasks",{method:"POST",headers:returning.headers,body:"{}"})).status,403);
});

test("private and writable configurations bind after recovery and failed early listeners close", {timeout:5000}, async t => {
  const options=fixture(t);
  for (const env of [{V2_FC_PUBLIC_HTTP_ENABLED:"false"},{...cloudEnv,V2_FC_PUBLIC_READ_ONLY:"false"}]) {
    const gate=Promise.withResolvers();
    const listener=startCloudV2Listener(env,{...options,port:0,host:"127.0.0.1",
      openMetadataBackend:async()=>{await gate.promise;return new MemorySnapshotBackend();},
      createDataBackend:()=>new MemoryDataStateBackend(),createRunner:()=>undefined});
    t.after(async()=>{gate.resolve();await listener.close();});
    assert.equal(listener.server.listening,false);
    gate.resolve();
    await listener.ready;
    assert.equal(listener.server.listening,true);
    await listener.close();
  }
  const gate=Promise.withResolvers(), failure=Error("fictional restore failure");
  const listener=startCloudV2Listener(cloudEnv,{...options,port:0,host:"127.0.0.1",
    openMetadataBackend:()=>gate.promise,createDataBackend:()=>new MemoryDataStateBackend(),createRunner:()=>undefined});
  t.after(async()=>{gate.reject(failure);await listener.close();});
  const rejected=assert.rejects(listener.ready,failure);
  await once(listener.server,"listening");
  const requested=once(listener.server,"request");
  const event=fetch("http://127.0.0.1:"+listener.server.address().port+"/invoke",{
    method:"POST",headers:{"x-fc-control-path":"/invoke","content-type":"application/octet-stream"},body:"{}",
  });
  const notAcknowledged=assert.rejects(event);
  await requested;
  gate.reject(failure);
  await rejected;
  await notAcknowledged;
  assert.equal(listener.server.listening,false);
  await listener.close();

  const opening=Promise.withResolvers(), remaining=Promise.withResolvers(), metadata=new MemorySnapshotBackend();
  let closes=0;
  metadata.close=async()=>{closes++;};
  const stopping=startCloudV2Listener(cloudEnv,{...options,port:0,host:"127.0.0.1",
    openMetadataBackend:async()=>{opening.resolve();await remaining.promise;return metadata;},
    createDataBackend:()=>new MemoryDataStateBackend(),createRunner:()=>undefined});
  t.after(async()=>{remaining.resolve();await stopping.close();});
  await opening.promise;
  assert.equal(stopping.server.listening,true);
  const stopped=stopping.close();
  assert.equal(stopping.server.listening,false);
  remaining.resolve();
  await stopped;
  assert.equal(closes,1);
  assert.equal(stopping.server.listening,false);
});
