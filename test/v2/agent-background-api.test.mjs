import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {mkdtempSync,rmSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createV2Server,PROJECT} from "../../src/v2/server.mjs";
import {AGENT_WAKE_PREFIX} from "../../src/v2/agent-event-driver.mjs";
import {SPARK_QUEUE_PREFIXES} from "../../src/v2/remote-spark-queue.mjs";

test("background HTTP admission uses invitation owner and CSRF; old tasks are not implicitly opted in",async t=>{
  const root=mkdtempSync(join(tmpdir(),"shuduo-background-api-")),objects=new Map();let models=0;
  const runner=async()=>{};runner.durable={prepare(){},submit(){},read(){},cancel(){}};
  const env={V2_LOCAL_DEVELOPMENT:"false",V2_PROVISIONING_ONLY:"true",V2_PRIVATE_SMOKE_ENABLED:"true",V2_DURABLE_SQL_AGENT_ENABLED:"true",V2_AGENT_DRIVER_MODE:"OSS_EVENTS",
    OSS_BUCKET:"fictional-securities-test",V2_AGENT_EVENT_ACCOUNT_ID:"111122223333",V2_SCHEDULER_TICK_SECRET:"synthetic-wake-secret-".repeat(3),V2_SPARK_EXECUTOR_SECRET:"synthetic-worker-secret-".repeat(3),V2_SPARK_EXECUTOR_TRANSPORT:"OSS_QUEUE"};
  const app=createV2Server({root,runner,env,generator:async()=>{models++;throw Error("not used by admission");},agentWakeTransport:{create:async(key,body)=>objects.set(key,body),read:async key=>objects.get(key)}});
  await new Promise(r=>app.server.listen(0,"127.0.0.1",r));
  t.after(async()=>{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));app.store.close();rmSync(root,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${app.server.address().port}`;
  const call=async(path,body,headers={})=>{
    const r=await fetch(base+"/invoke",{method:"POST",headers:{"content-type":"application/octet-stream"},body:JSON.stringify({operation:"PRIVATE_APPLICATION_HTTP_V1",method:body===undefined?"GET":"POST",path,...(body===undefined?{}:{body}),headers})});
    return (await r.json());
  };
  app.auth.bootstrapAdmin({email:"background-owner@example.invalid",password:"SyntheticPassword!2026",displayName:"虚构证券工程师"});
  const login=await call("/api/v2/auth/login",{email:"background-owner@example.invalid",password:"SyntheticPassword!2026"});
  assert.equal(login.status,200);
  const headers={cookie:login.cookies.map(c=>c.split(";")[0]).join("; "),"x-csrf-token":login.body.csrfToken,"idempotency-key":randomUUID()};
  const body={message:"虚构证券客户资产T+1",sql:"SELECT 1 AS pending",contextId:"holdings-t1"};
  const anonymous=await call("/api/v2/agent/tasks",{...body,background:true});assert.equal(anonymous.status,401);
  const noCsrf={...headers};delete noCsrf["x-csrf-token"];
  assert.equal((await call("/api/v2/agent/tasks",{...body,background:true},noCsrf)).status,403);
  const plain=await call("/api/v2/agent/tasks",body,headers);assert.equal(plain.status,202);assert.equal(objects.size,0);assert.equal(plain.body.background,undefined);
  const opted=await call("/api/v2/agent/tasks",{...body,background:true},{...headers,"idempotency-key":randomUUID()});
  assert.equal(opted.status,202);assert.equal(opted.body.background.status,"ACTIVE");assert.equal(models,0);assert.equal(objects.size,1);
  assert.ok([...objects.keys()][0].startsWith(AGENT_WAKE_PREFIX+"/"));
  const id=opted.body.id,path=`/api/v2/agent/tasks/${id}/background`;
  assert.equal((await call(path,undefined)).status,403);
  assert.equal((await call(`/api/v2/agent/tasks/${id}/advance`,{expectedVersion:opted.body.version},headers)).status,409);
  const foreign=app.store.create("auth_user",PROJECT,{status:"ACTIVE",memberships:[{projectId:PROJECT,role:"ENGINEER"}]});
  app.store.update("agent",id,PROJECT,{submittedBy:foreign.id});
  const mismatch=await call(path,{expectedVersion:app.store.get("agent",id,PROJECT).version},headers);assert.equal(mismatch.status,403);
  const owner=app.store.list("auth_user",PROJECT).find(u=>u.email==="background-owner@example.invalid");
  app.store.update("agent",id,PROJECT,{submittedBy:owner.id});
  const stopped=await call(path+"/cancel",{},headers);assert.equal(stopped.status,200);assert.equal(stopped.body.status,"CANCELLED");
  const invoke=await fetch(base+"/invoke",{method:"POST",headers:{"content-type":"application/octet-stream"},body:JSON.stringify({operation:"PRIVATE_AGENT_TICK_V1",requestId:randomUUID()})});
  assert.equal(invoke.status,403);assert.equal(models,0);
  assert.equal((await call("/api/v2/status",undefined,headers)).body.agentDevelopment.eventBackgroundAvailable,true);
});

test("UI/API/CLI/MCP expose explicit bounded background controls, not a hidden polling driver",()=>{
  const ui=readFileSync("web/src/AgentDevelopmentWorkbench.tsx","utf8"),client=readFileSync("src/v2/client.mjs","utf8"),cli=readFileSync("bin/shuduo.mjs","utf8"),mcp=readFileSync("bin/shuduo-mcp.mjs","utf8");
  assert.match(ui,/background:backgroundConsent/);assert.match(ui,/current\.background\?\.status===\"ACTIVE\"/);assert.match(ui,/停止后台自动推进/);
  assert.match(ui,/cloud|云端事件后台/);assert.match(cli,/enable-background/);assert.match(cli,/options\.confirm!==true/);
  for(const name of ["agent_background_status","agent_background_enable","agent_background_cancel"]){assert.ok(client.includes(name));assert.ok(mcp.includes(name));}
  assert.match(mcp,/args\.confirm!==true/);assert.notEqual(AGENT_WAKE_PREFIX,SPARK_QUEUE_PREFIXES.results);
});
