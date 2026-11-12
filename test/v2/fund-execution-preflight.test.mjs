import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { runV2Cli } from "../../bin/shuduo.mjs";
import { handleV2Mcp } from "../../bin/shuduo-mcp.mjs";
import { sha256 } from "../../src/v2/delivery.mjs";
import { createFcIngress } from "../../src/v2/fc-ingress.mjs";
import { fundContextIds } from "../../src/v2/fund-contexts.mjs";
import { createFundTestSql } from "../../src/v2/fund-delivery.mjs";
import { fundContext, fundReferenceSql } from "../../src/v2/fund-lookthrough.mjs";
import { readFundExecutionPreflight } from "../../src/v2/fund-preparation-client.mjs";
import { fundExecutionPreflightPath } from "../../src/v2/fund-preparation-request.mjs";
import { createFundPreparations, fundAgentRequestSignature } from "../../src/v2/fund-preparation.mjs";
import { fundRequirementScope } from "../../src/v2/fund-requirement-contract.mjs";
import { validatePrivateApplicationRequest } from "../../src/v2/private-application.mjs";
import { createV2Server, PROJECT } from "../../src/v2/server.mjs";
import { bindSqlRequirementRevision, sqlRequirementBinding, sqlRequirementReport } from "../../src/v2/sql-requirements.mjs";
import { MetadataStore } from "../../src/v2/store.mjs";

function savedFundSource(store, actor, contextId) {
  // Deliberately synthetic receipts. Actual Spark evidence is exercised separately.
  const context = fundContext(contextId), message = "按已登记基金交易日核对组合敞口";
  const requestId = randomUUID(), preparations = createFundPreparations({ store, project:PROJECT });
  const { receipt } = preparations.submit({ contextId, message, businessDate:context.businessDate,
    metrics:fundRequirementScope(contextId).metrics.map(metric => metric.field) }, actor, requestId);
  const { basis, execution } = receipt;
  const fundPreparation = preparations.bindExecution({requestId,basisDigest:basis.digest,confirm:true},actor,
    {contextId,message,requestKey:requestId});
  const taskInput = { message, contextId, language:"SPARK_SQL", fundPreparation };
  const key = `${PROJECT}:agent:${requestId}`;
  const { id:taskId } = store.deduplicate(key, fundAgentRequestSignature(taskInput), () =>
    store.create("agent",PROJECT,{...taskInput,mode:"SYNTHETIC_MODEL",submittedBy:actor}));
  let task = store.get("agent",taskId,PROJECT);
  const revision = store.create("revision",PROJECT,{contextId,author:actor,source:task.mode,fundPreparation,
    sql:fundReferenceSql,hash:sha256(fundReferenceSql)});
  const inputEvidence = { protocol:"shuduo-spark-execution-input/v1", scope:"MANAGER_SCOPED_REGISTERED_TABLES",
    contextId,inputHash:execution.inputDigest,schemaHash:execution.schemaDigest,tableCount:3 };
  const assertionEvidence = { protocol:"shuduo-securities-assertion-evidence/v1",
    verifierRevision:"fund-lookthrough-v1",contentHash:execution.assertionDigest };
  const run = store.create("run",PROJECT,{contextId,agentTaskId:taskId,revisionId:revision.id,
    revisionHash:revision.hash, status:"SUCCEEDED", engine:"Apache Spark", engineVersion:"3.5.9", mainSqlExecuted:true,
    isolation:"LOCAL_PROCESS", rows:context.expected,inputEvidence,fundPreparation,validation:{
      passed:true,selectedPassed:true,assertionEvidence,regressions:[{contextId,passed:true,inputEvidence,assertionEvidence}],
    }});
  const model = "TEST_DOUBLE";
  const requirement = { kind:"DEVELOPMENT",basisDigest:basis.digest,summary:message,grain:basis.grain,
    metrics:basis.metrics.map(({field,label,sourceFields})=>({field,meaning:label,sourceFields})),constraints:basis.constraints };
  const requirements = bindSqlRequirementRevision(sqlRequirementReport({task,message,context,attempt:1,
    generated:{model,requirement,requirementProtocol:basis.protocol}}),revision);
  task = store.update("agent",taskId,PROJECT,{status:"SUCCEEDED",revisionId:revision.id,runId:run.id,sql:revision.sql,
    requirements,attempts:[{attempt:1,revisionId:revision.id,runId:run.id,status:"SUCCEEDED",model}]});
  store.update("revision",revision.id,PROJECT,{requirementBinding:sqlRequirementBinding(requirements)});
  return {task,run,revision,receipt,context,key,selection:{taskId,requestId,revisionId:revision.id,runId:run.id,basisDigest:basis.digest}};
}

test("invited fund preflight binds the owner and original request, code, date and independent evidence", async t => {
  const store = new MetadataStore(":memory:"), origin = "https://synthetic-fund.example.invalid";
  let computations = 0;
  const forbidden = () => { computations++; throw Error("UNEXPECTED_EXECUTION"); };
  const app = createV2Server({ store, runner:forbidden,generator:forbidden,env:{
    V2_LOCAL_DEVELOPMENT:"false",V2_PUBLIC_ORIGIN:origin,V2_PROVISIONING_ONLY:"true",V2_ALLOW_INSECURE_PUBLIC_COOKIES:"true",
  },ingress:createFcIngress({publicHttpEnabled:true,publicReadOnly:true}) });
  const password = "SyntheticOnly!2026";
  const engineer = app.auth.bootstrapAdmin({ email:"engineer@example.invalid",displayName:"虚构工程师",password });
  const other = app.auth.bootstrapAdmin({ email:"other@example.invalid",displayName:"虚构管理员",password });
  const viewer = app.auth.bootstrapAdmin({ email:"viewer@example.invalid",displayName:"虚构访客",password });
  for (const [user,role] of [[engineer,"ENGINEER"],[viewer,"VIEWER"]])
    store.update("auth_user",user.id,PROJECT,{memberships:[{projectId:PROJECT,role}]});
  const [original, next] = fundContextIds.map(id=>savedFundSource(store,engineer.id,id));
  await new Promise((resolve,reject)=>{app.server.once("error",reject);app.server.listen(0,"127.0.0.1",resolve);});
  t.after(async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));app.releaseScheduler.shutdown();store.close();});
  const base = "http://127.0.0.1:"+app.server.address().port+"/api/v2";
  const login = async user=>{
    const result = await fetch(base+"/auth/login",{method:"POST",headers:{origin,"content-type":"application/json","x-shuduo-client":"workbench"},
      body:JSON.stringify({email:user.email,password})});
    assert.equal(result.status,200);
    return result.headers.getSetCookie().map(cookie=>cookie.split(";")[0]).join("; ");
  };
  const ownerCookie = await login(engineer), otherCookie = await login(other), viewerCookie = await login(viewer);
  const read = (selection,cookie=ownerCookie) => fetch(base+fundExecutionPreflightPath(selection),{headers:{cookie}});
  const before = store.db.prepare("SELECT count(*) AS count FROM documents").get().count;
  const path = fundExecutionPreflightPath(original.selection);
  assert.equal((await read(original.selection,"")).status,401);
  assert.equal((await read(original.selection,otherCookie)).status,404);
  assert.equal((await read(original.selection,viewerCookie)).status,403);
  assert.equal((await fetch(base+path+"&runId="+randomUUID(),{headers:{cookie:ownerCookie}})).status,422);
  assert.equal((await fetch(base+path,{headers:{cookie:ownerCookie,"x-project-id":"wrong-project"}})).status,403);
  for (const key of ["requestId","revisionId","runId","basisDigest"])
    assert.equal((await read({...original.selection,[key]:next.selection[key]})).status,409);

  const seen = [], client = {request:async (request,options)=>{
    assert.equal(options,undefined);
    seen.push(request);
    const response = await fetch(base+request,{headers:{cookie:ownerCookie}});
    assert.equal(response.status,200);
    return response.json();
  }};
  const result = await readFundExecutionPreflight(client,original.selection);
  const nextResult = await readFundExecutionPreflight(client,next.selection);
  assert.notEqual(result.source.businessDate,nextResult.source.businessDate);
  assert.notEqual(result.source.assertionDigest,nextResult.source.assertionDigest);
  assert.notEqual(result.candidate.requestDigest,nextResult.candidate.requestDigest);
  const testSql = createFundTestSql(original.context.expected,original.context.id);
  assert.equal(result.candidate.testSqlDigest,sha256(testSql));
  assert.equal(result.candidate.requestDigest,sha256(JSON.stringify({
    sql:fundReferenceSql,context:original.context,validationContexts:[],testSql,
  })));
  assert.equal(result.source.modelMode,"SYNTHETIC_MODEL");
  assert.equal(result.source.scope,"LOCAL_TEST_ONLY");
  assert.equal(result.source.isolation,"LOCAL_PROCESS");
  assert.equal(result.source.requirementDigest,sqlRequirementBinding(original.task.requirements).reportDigest);
  assert.equal(result.approved||result.willExecute||result.agentIndependentE2E,false);
  assert.doesNotMatch(JSON.stringify(result), /PORT-DEMO|SELECT|password|remoteSubmission|"rows"|"expected"/);

  let cli;
  const code = await runV2Cli(["agent","fund-execution-preflight",...Object.entries(original.selection).flatMap(([key,value])=>
    ["--"+key.replace(/[A-Z]/g,c=>"-"+c.toLowerCase()),value])],{},{
    client,output:text=>{cli=JSON.parse(text);},error:assert.fail,
  });
  assert.equal(code,0);
  assert.deepEqual(cli,result);
  const mcp = JSON.parse(await handleV2Mcp({jsonrpc:"2.0",id:1,method:"tools/call",
    params:{name:"fund_execution_preflight",arguments:original.selection}}, {client}));
  assert.deepEqual(mcp.result.structuredContent,result);
  assert.deepEqual(seen,[path,fundExecutionPreflightPath(next.selection),path,path]);

  const bridge = {operation:"PRIVATE_APPLICATION_HTTP_V1",method:"GET",path:"/api/v2"+path};
  assert.equal(validatePrivateApplicationRequest(bridge,{allowDurableAgentRead:true}).path,bridge.path);
  assert.throws(()=>validatePrivateApplicationRequest(bridge));
  assert.throws(()=>validatePrivateApplicationRequest({...bridge,method:"POST",body:{}},{allowDurableAgent:true}));

  assert.equal(store.db.prepare("SELECT count(*) AS count FROM documents").get().count,before);
  assert.equal(computations,0);
  store.update("run",original.run.id,PROJECT,{isolation:undefined});
  const legacy=await (await read(original.selection)).json();
  assert.equal(legacy.source.scope,"LOCAL_TEST_ONLY");
  assert.equal(legacy.source.isolation,undefined);
  store.update("run",original.run.id,PROJECT,{isolation:"FUNCTION_PROCESS"});
  assert.equal((await read(original.selection)).status,409);
  store.update("run",original.run.id,PROJECT,{isolation:"LOCAL_PROCESS"});
  store.update("revision",original.revision.id,PROJECT,{sql:original.revision.sql+"\n-- changed"});
  assert.equal((await read(original.selection)).status,409);
  store.update("run",next.run.id,PROJECT,{rows:next.run.rows.slice(1)});
  assert.equal((await read(next.selection)).status,409);
  assert.equal(computations,0);
});
