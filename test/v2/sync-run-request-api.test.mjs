import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MetadataStore } from "../../src/v2/store.mjs";
import { IngestionManager, LandingStore } from "../../src/v2/ingestion.mjs";
import { createFcIngress } from "../../src/v2/fc-ingress.mjs";
import { createV2Server, PROJECT } from "../../src/v2/server.mjs";
import { V2Client } from "../../src/v2/client.mjs";
import { runV2Cli } from "../../bin/shuduo.mjs";
import { handleV2Mcp } from "../../bin/shuduo-mcp.mjs";
import { syncRunRequestPath } from "../../src/v2/sync-run-request.mjs";

test("original sync evidence is readable without new writes after committed rows, lost result and reopen", async t => {
  const directory = mkdtempSync(join(tmpdir(), "shuduo-sync-request-api-"));
  const fixtureRoot = resolve("fixtures/sources");
  let store, landingStore, ingestion, app, base;
  function openStores() {
    store = new MetadataStore(join(directory, "metadata.sqlite"));
    landingStore = new LandingStore(join(directory, "landing.sqlite"));
    ingestion = new IngestionManager({store, landingStore, project:PROJECT, fixtureRoot});
  }
  async function stop() {
    if (!app) return;
    const active = app;
    app = undefined;
    const done = new Promise(resolve => active.server.close(resolve));
    active.server.closeAllConnections();
    await done;
    active.releaseScheduler.shutdown();
  }
  async function start(readOnly = false) {
    app = createV2Server({store, landingStore, fixtureRoot,
      env:{V2_LOCAL_DEVELOPMENT:readOnly ? "false" : "true", V2_RELEASE_SCHEDULER_MODE:"DISABLED"},
      ...(readOnly ? {ingress:createFcIngress({publicHttpEnabled:true,publicReadOnly:true})} : {}),
    });
    await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
    base = "http://127.0.0.1:" + app.server.address().port + "/api/v2";
  }
  function refreshSource(id) {
    ingestion.testConnection(id);
    ingestion.collectMetadata(id);
  }

  openStores();
  t.after(async () => {
    await stop();
    store.close();
    landingStore.close();
    rmSync(directory, {recursive:true,force:true});
  });
  const source = ingestion.createSource({name:"虚构证券持仓",sourceType:"LOCAL_CSV",fileName:"positions_aliased.csv"});
  refreshSource(source.id);
  const config = {name:"虚构原持仓",sourceId:source.id,targetTable:"synthetic_holdings",mode:"FULL",
    mapping:{holding_id:"position_id",holding_value:"amount",customer_id:"client_id"},keyFields:["position_id"]};
  const task = ingestion.createTask(config);
  const requestKey = "original/../response?batch=%";
  const selection = {taskId:task.id, requestKey};
  const path = syncRunRequestPath(selection);
  const postRun = () => fetch(base + "/sync/tasks/" + task.id + "/run", {method:"POST",
    headers:{"Content-Type":"application/json","X-Shuduo-Client":"workbench","Idempotency-Key":requestKey},body:"{}"});
  const update = store.update.bind(store);
  let dropped = false;
  store.update = (kind, id, project, patch, options) => {
    if (!dropped && kind === "offline_sync_run" && patch.status === "SUCCEEDED") {
      dropped = true;
      throw Error("Fictional metadata acknowledgement failure");
    }
    return update(kind, id, project, patch, options);
  };

  await start();
  const adminCredentials = {email:"fictional-admin@example.test",password:"SyntheticAdmin#2026"};
  app.auth.bootstrapAdmin({...adminCredentials,displayName:"虚构管理员"});
  const auth = app.auth.login(adminCredentials);
  const owner = app.auth.sessionFromHeaders({cookie:"shuduo_session="+auth.rawToken});
  const roleCookie = role => {
    const invite = app.auth.createInvitation(owner,{email:role.toLowerCase()+"@example.test",role});
    const session = app.auth.redeemInvitation({inviteCode:invite.inviteCode,displayName:"虚构证券成员",password:"SyntheticMember#2026"});
    return "shuduo_session="+session.rawToken;
  };
  const engineer = roleCookie("ENGINEER"), viewer = roleCookie("VIEWER");

  const execution = await postRun();
  assert.ok(execution.status >= 400);
  assert.equal((await execution.json()).code, "SYNC_RESULT_UNCONFIRMED");
  assert.ok(dropped);
  const originalId = landingStore.inspectTarget(task.targetTable).runId;
  assert.ok(originalId);
  assert.equal(landingStore.readTable(task.targetTable).length, 3);

  await stop();
  store.close();
  landingStore.close();
  openStores();
  ingestion.createSourceRevision(source.id,{fileName:"positions_aliased_incremental.csv"});
  refreshSource(source.id);
  const later = ingestion.runTask(ingestion.createTask({...config,mode:"INCREMENTAL_UPSERT"}).id);
  const lastLanding = landingStore.inspectTarget(task.targetTable);
  const before = store.list("offline_sync_run",PROJECT);
  assert.equal(lastLanding.runId,later.id);
  let syncWrites = 0;
  const land = landingStore.sync.bind(landingStore);
  landingStore.sync = (...args) => { syncWrites++; return land(...args); };

  await start(true);
  const calls = [];
  const client = new V2Client({baseUrl:base,fetchImpl:(url,options) => {
    calls.push({path:new URL(url).pathname+new URL(url).search,method:options.method});
    return fetch(url,{...options,headers:{...options.headers,Cookie:engineer}});
  }});
  const api = await fetch(base+path,{headers:{Cookie:engineer}});
  assert.equal(api.status,200);
  const receipt = await api.json();
  assert.equal(receipt.state,"LANDING_COMMITTED");
  assert.equal(receipt.run.id,originalId);
  assert.equal(receipt.landingEvidence.finalCount,3);
  assert.notEqual(receipt.landingEvidence.runId,lastLanding.runId);
  assert.ok(!Object.hasOwn(receipt.run,"error") && !Object.hasOwn(receipt.run,"requestSignature"));

  let cli;
  const code = await runV2Cli(["sync","run-request","--id",task.id,"--request-id",requestKey],{},
    {client,output:text=>{cli=JSON.parse(text);},error:()=>{}});
  assert.equal(code,0);
  assert.deepEqual(cli,receipt);
  const mcp = JSON.parse(await handleV2Mcp({jsonrpc:"2.0",id:1,method:"tools/call",
    params:{name:"sync_run_request",arguments:{taskId:task.id,requestId:requestKey}}},{client}));
  assert.deepEqual(mcp.result.structuredContent,receipt);
  assert.deepEqual(calls,Array.from({length:2},()=>({path:"/api/v2"+path,method:"GET"})));

  for (const [headers, status] of [[{},401],[{Cookie:viewer},403],[{Authorization:"Bearer invalid"},401],[{Cookie:"shuduo_session=invalid"},401]])
    assert.equal((await fetch(base+path,{headers})).status,status);
  for (const suffix of ["&page=1","&request_key=other"])
    assert.equal((await fetch(base+path+suffix,{headers:{Cookie:engineer}})).status,422);
  const wrong = await fetch(base+syncRunRequestPath({...selection,requestKey:"different"}),{headers:{Cookie:engineer}});
  assert.equal(wrong.status,404);
  assert.equal((await wrong.json()).code,"SYNC_RUN_REQUEST_NOT_FOUND");
  const basis = {runId:originalId,receiptHash:receipt.landingEvidence.receiptHash,confirm:true};
  const settle = (body, url = path, cookie = engineer) => fetch(base+url,{method:"POST",
    headers:{"Content-Type":"application/json","X-Shuduo-Client":"workbench",Cookie:cookie},body:JSON.stringify(body)});
  assert.equal((await settle(basis)).status,403);
  assert.deepEqual(store.list("offline_sync_run",PROJECT),before);
  assert.deepEqual(landingStore.inspectTarget(task.targetTable),lastLanding);

  await stop();
  await start();
  assert.equal((await settle(basis,path,viewer)).status,403);
  assert.equal((await settle({...basis,confirm:false})).status,422);
  const mismatched = await settle({...basis,receiptHash:"0".repeat(64)});
  assert.equal(mismatched.status,409);
  assert.equal((await mismatched.json()).code,"SYNC_SETTLEMENT_BASIS_MISMATCH");
  const missing = await settle(basis,syncRunRequestPath({...selection,requestKey:"different"}));
  assert.equal(missing.status,404);
  assert.deepEqual(store.list("offline_sync_run",PROJECT),before);
  const settled = await settle(basis);
  assert.equal(settled.status,200);
  const result = await settled.json();
  assert.equal(result.run.id,originalId);
  assert.equal(result.state,"SUCCEEDED");
  assert.equal(result.landingEvidence.receiptHash,basis.receiptHash);
  const after = store.list("offline_sync_run",PROJECT);
  const again = await settle(basis);
  assert.equal(again.status,200);
  assert.deepEqual(await again.json(),result);
  assert.deepEqual(store.list("offline_sync_run",PROJECT),after);
  const replay = await postRun();
  assert.equal(replay.status,200);
  assert.equal((await replay.json()).id,originalId);
  assert.equal(syncWrites,0);
  assert.deepEqual(landingStore.inspectTarget(task.targetTable),lastLanding);
  const archive = ingestion.previewRunSnapshot(task.id,originalId);
  assert.equal(archive.rows.find(row=>row.position_id==="POS-002").amount,"500.00");
  assert.equal(archive.currentTarget.matchesOriginalRun,false);
});
