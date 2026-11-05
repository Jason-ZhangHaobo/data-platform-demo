import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createV2Server, PROJECT } from "../../src/v2/server.mjs";
import { getContext, validationContractId } from "../../src/v2/context.mjs";
import { saveManualRevision } from "../../src/v2/manual-revisions.mjs";
import { createFcIngress } from "../../src/v2/fc-ingress.mjs";
import { validatePrivateApplicationRequest, callPrivateApplication, privateApplicationTimeoutMs } from "../../src/v2/private-application.mjs";
import {publicationReadPath} from "../../src/v2/publication-request.mjs";

const publicationTaskId="00000000-0000-4000-8000-000000000001",manualSourceRunId="00000000-0000-4000-8000-000000000002";
const exactManualSelector={sourceKind:"MANUAL",sourceRunId:manualSourceRunId,packageDigest:"a".repeat(64),verificationId:"00000000-0000-4000-8000-000000000003",releaseId:"00000000-0000-4000-8000-000000000004"};
const exactPublicationPath="/api/v2"+publicationReadPath(publicationTaskId,exactManualSelector),manualWorkflowPath=`/api/v2/runs/${manualSourceRunId}/workflow`;

test("private exact publication and manual workflow reads require opt-in and preserve ordinary authorization",async()=>{
  for(const path of [exactPublicationPath,manualWorkflowPath,`/api/v2/agent/tasks/${publicationTaskId}/publication`]){
    const input={operation:"PRIVATE_APPLICATION_HTTP_V1",method:"GET",path,headers:{cookie:"shuduo_session=synthetic-owner"}};
    assert.throws(()=>validatePrivateApplicationRequest(input),{code:"PRIVATE_APPLICATION_REQUEST_INVALID"});
    for(const options of [{allowDurableAgentRead:true},{allowDurableAgent:true}]){
      assert.equal(validatePrivateApplicationRequest(input,options).path,path);
      let forwards=0;
      const result=await callPrivateApplication(input,"http://127.0.0.1:3100",async(url,request)=>{
        forwards++;assert.equal(url,"http://127.0.0.1:3100"+path);assert.equal(request.method,"GET");
        assert.equal(request.body,undefined);assert.equal(request.headers.cookie,"shuduo_session=synthetic-owner");
        assert.equal(request.headers["x-actor-id"],undefined);assert.equal(request.redirect,"error");
        return new Response(JSON.stringify({code:"SOURCE_OWNER_DENIED"}),{status:403});
      },options);
      assert.equal(result.status,403);assert.equal(result.body.code,"SOURCE_OWNER_DENIED");assert.equal(forwards,1);
    }
    for(const headers of [{"x-actor-id":"another"},{authorization:"Bearer synthetic"}])assert.throws(()=>validatePrivateApplicationRequest({...input,headers},{allowDurableAgentRead:true}),{code:"PRIVATE_APPLICATION_HEADERS_INVALID"});
  }
});

test("private read-only Agent permission cannot POST a workflow, publication or execution even with exact selectors",async()=>{
  const paths=[exactPublicationPath,manualWorkflowPath,`/api/v2/runs/${manualSourceRunId}/prepare-delivery`,
    `/api/v2/agent/tasks/${publicationTaskId}/publication`,`/api/v2/agent/tasks/${publicationTaskId}/publication/cancel`,
    `/api/v2/agent/tasks/${publicationTaskId}/advance`];
  let forwards=0;
  for(const path of paths){
    const input={operation:"PRIVATE_APPLICATION_HTTP_V1",method:"POST",path,body:{...exactManualSelector}};
    await assert.rejects(callPrivateApplication(input,"http://127.0.0.1:3100",async()=>{forwards++;return new Response('{}');},{allowDurableAgentRead:true}),{code:"PRIVATE_APPLICATION_REQUEST_INVALID"});
  }
  assert.equal(forwards,0);
  assert.equal(validatePrivateApplicationRequest({operation:"PRIVATE_APPLICATION_HTTP_V1",method:"POST",path:`/api/v2/runs/${manualSourceRunId}/prepare-delivery`,body:{}},{allowDurableAgent:true}).method,"POST","explicit existing full Agent scope remains separate from read-only scope");
});

test("private publication/manual read allowlists reject duplicate selectors, unknown query and path injection",()=>{
  const rejected=[exactPublicationPath+"&sourceKind=MANUAL",exactPublicationPath+"&source%4bind=MANUAL",exactPublicationPath+"&actorId=other",
    exactPublicationPath+"&unknown=1",exactPublicationPath+"&releaseId=other",exactPublicationPath+"#fragment",
    exactPublicationPath.replace("sourceKind=MANUAL","sourceKind=MANUAL%0A"),exactPublicationPath.replace("/agent/","/agent/../agent/"),
    exactPublicationPath.replace("/agent/","/agent\\"),exactPublicationPath.replace("/agent/","/agent/%2e%2e/agent/"),
    exactPublicationPath+"&verificationId="+"a".repeat(701),"https://external.invalid"+exactPublicationPath,
    manualWorkflowPath+"?sourceKind=MANUAL",manualWorkflowPath+"/extra",manualWorkflowPath.replace("/runs/","/runs/../runs/"),
    `/api/v2/agent/tasks/${publicationTaskId}/publication?sourceKind=MANUAL&sourceRunId=${manualSourceRunId}`];
  for(const path of rejected)for(const options of [{allowDurableAgentRead:true},{allowDurableAgent:true}])
    assert.throws(()=>validatePrivateApplicationRequest({operation:"PRIVATE_APPLICATION_HTTP_V1",method:"GET",path},options),{code:"PRIVATE_APPLICATION_REQUEST_INVALID"},path);
  assert.throws(()=>validatePrivateApplicationRequest({operation:"PRIVATE_APPLICATION_HTTP_V1",method:"GET",path:exactPublicationPath,body:{}},{allowDurableAgentRead:true}),{code:"PRIVATE_APPLICATION_REQUEST_INVALID"});
});

test("private save recovery allows only exact read paths and preserves header boundaries",()=>{
  const input={operation:"PRIVATE_APPLICATION_HTTP_V1",method:"GET",path:"/api/v2/revisions/requests/fixture-save-1",headers:{cookie:"synthetic-session"}};
  assert.equal(validatePrivateApplicationRequest(input).path,input.path);
  for(const bad of [{...input,method:"POST",body:{}},{...input,body:{}},{...input,path:input.path+"?other=1"},{...input,path:input.path+"/extra"},{...input,path:"/api/v2/revisions/requests/../secret"},{...input,headers:{authorization:"Bearer synthetic"}}])assert.throws(()=>validatePrivateApplicationRequest(bad));
});
test("private Agent creation lookup is an explicitly enabled read, never an execution route",async()=>{
  const input={operation:"PRIVATE_APPLICATION_HTTP_V1",method:"GET",path:"/api/v2/agent/requests/fixture-agent-1",headers:{cookie:"synthetic-session"}};
  assert.throws(()=>validatePrivateApplicationRequest(input));
  for(const options of [{allowDurableAgent:true},{allowDurableAgentRead:true}])assert.equal(validatePrivateApplicationRequest(input,options).path,input.path);
  for(const change of [{method:"POST",body:{}},{body:{}},{path:input.path+"/advance"},{path:input.path+"?other=1"},{path:"/api/v2/agent/requests/"+"a".repeat(101)},{headers:{authorization:"Bearer synthetic"}}])assert.throws(()=>validatePrivateApplicationRequest({...input,...change},{allowDurableAgentRead:true}));
  const response=await callPrivateApplication(input,"http://127.0.0.1:3100",async(url,options)=>{
    assert.equal(url,"http://127.0.0.1:3100/api/v2/agent/requests/fixture-agent-1");assert.equal(options.method,"GET");assert.equal(options.headers.cookie,"synthetic-session");
    return new Response(JSON.stringify({message:"原身份无权读取"}),{status:403});
  },{allowDurableAgentRead:true});
  assert.equal(response.status,403);
});

test("private application rejects external targets, unlisted paths and injected headers", async () => {
  const good = { operation: "PRIVATE_APPLICATION_HTTP_V1", method: "GET", path: "/api/v2/status" };
  assert.equal(validatePrivateApplicationRequest(good).path, good.path);
  for (const path of ["https://example.invalid/api/v2/status", "/invoke", "/api/v2/settings/model-key", "/api/v2/status?url=https://example.invalid", "/api/v2/../settings"])
    assert.throws(() => validatePrivateApplicationRequest({ ...good, path }), { code: "PRIVATE_APPLICATION_REQUEST_INVALID" });
  assert.throws(() => validatePrivateApplicationRequest({ ...good, headers: { host: "evil.invalid" } }), { code: "PRIVATE_APPLICATION_HEADERS_INVALID" });
  assert.throws(() => validatePrivateApplicationRequest({ ...good, headers: { cookie: "a\r\nb" } }), { code: "PRIVATE_APPLICATION_HEADERS_INVALID" });
  await assert.rejects(callPrivateApplication(good, "http://evil.invalid:3000"), { code: "PRIVATE_APPLICATION_TARGET_INVALID" });
});

test("private Agent transport is explicit, SQL-only and preserves ordinary authentication", async () => {
  assert.equal(privateApplicationTimeoutMs("/api/v2/agent/tasks/00000000-0000-4000-8000-000000000001/advance"), 105000);
  assert.equal(privateApplicationTimeoutMs("/api/v2/data-services/agent/plans/00000000-0000-4000-8000-000000000001/advance"), 105000);
  assert.equal(privateApplicationTimeoutMs("/api/v2/runs"), 30000);
  assert.equal(privateApplicationTimeoutMs("/api/v2/agent/tasks"), 30000);
  const input = { operation: "PRIVATE_APPLICATION_HTTP_V1", method: "POST", path: "/api/v2/agent/tasks", body: { message: "虚构证券加工", sql: "SELECT 1" } };
  assert.throws(() => validatePrivateApplicationRequest(input), { code: "PRIVATE_APPLICATION_REQUEST_INVALID" });
  assert.equal(validatePrivateApplicationRequest(input, { allowDurableAgent: true }).path, input.path);
  assert.throws(() => validatePrivateApplicationRequest({ ...input, body: { ...input.body, language: "PYTHON" } }, { allowDurableAgent: true }), { code: "PRIVATE_AGENT_LANGUAGE_NOT_ENABLED" });
  assert.throws(() => validatePrivateApplicationRequest({ ...input, path: "/api/v2/internal/scheduler/tick" }, { allowDurableAgent: true }), { code: "PRIVATE_APPLICATION_REQUEST_INVALID" });
  let forwarded;
  const response = await callPrivateApplication(input, "http://127.0.0.1:3100", async (url, options) => {
    forwarded = { url, options };
    return new Response(JSON.stringify({ code: "AUTHENTICATION_REQUIRED" }), { status: 401 });
  }, { allowDurableAgent: true });
  assert.equal(response.status, 401); assert.equal(response.body.code, "AUTHENTICATION_REQUIRED");
  assert.equal(forwarded.options.headers.cookie, undefined);
  assert.equal(forwarded.options.headers["x-csrf-token"], undefined);
  assert.equal(forwarded.url, "http://127.0.0.1:3100/api/v2/agent/tasks");
});

async function open(enabled = true, durable = false) {
  const runner = async ({ context }) => ({ status: "SUCCEEDED", engine: "Apache Spark", engineVersion: "3.5.9", mainSqlExecuted: true, rows: context.expected, validation: { passed: true } });
  if (durable) runner.durable = { prepare() {}, submit() {}, read() {}, cancel() {} };
  const app = createV2Server({
    ingress: createFcIngress(),
    root: mkdtempSync(join(tmpdir(), "shuduo-private-app-")),
    env: { V2_LOCAL_DEVELOPMENT: "false", V2_PROVISIONING_ONLY: "true", V2_PRIVATE_SMOKE_ENABLED: String(enabled), V2_DURABLE_SQL_AGENT_ENABLED: String(durable) },
    runner,
    ...(durable ? { generator: async () => { throw new Error("creation must not call a model"); } } : {}),
  });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  const invoke = async body => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/invoke`, { method: "POST", headers: { "Content-Type": "application/octet-stream", "x-fc-control-path": "/invoke" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { app, invoke, close: async () => { await new Promise(resolve => app.server.close(resolve)); app.store.close(); } };
}

test("normal private app login and CSRF are required to create a durable Agent task", async () => {
  const service = await open(true, true);
  const call = async (path, body, headers = {}) => (await service.invoke({ operation: "PRIVATE_APPLICATION_HTTP_V1", method: "POST", path, body, headers })).body;
  try {
    const body = { message: "理解虚构证券资产口径并编写SQL", sql: "SELECT 1 AS pending", contextId: "holdings-t1" };
    assert.equal((await call("/api/v2/agent/tasks", body)).status, 401);
    service.app.auth.bootstrapAdmin({ email: "recovery-owner@example.invalid", password: "SyntheticPassword!2026", displayName: "测试工程师" });
    const login = await call("/api/v2/auth/login", { email: "recovery-owner@example.invalid", password: "SyntheticPassword!2026" });
    assert.equal(login.status, 200);
    const headers = { cookie: login.cookies.map(c => c.split(";")[0]).join("; "), "idempotency-key": "private-intake-test" };
    assert.equal((await call("/api/v2/agent/tasks", body, headers)).status, 403);
    headers["x-csrf-token"] = login.body.csrfToken;
    const task = await call("/api/v2/agent/tasks", body, headers);
    assert.equal(task.status, 202); assert.equal(task.body.stage, "READY_FOR_MODEL");
    assert.equal(task.body.usedTokens, 0); assert.equal(task.body.attempts.length, 0);
    const lookupPath="/api/v2/agent/requests/private-intake-test";
    const recovered=await service.invoke({operation:"PRIVATE_APPLICATION_HTTP_V1",method:"GET",path:lookupPath,headers:{cookie:headers.cookie}});
    assert.equal(recovered.body.status,200);assert.equal(recovered.body.body.id,task.body.id);assert.equal(recovered.body.body.attempts.length,0);
    const denied=await service.invoke({operation:"PRIVATE_APPLICATION_HTTP_V1",method:"GET",path:lookupPath});
    assert([401,403].includes(denied.body.status));assert(!JSON.stringify(denied).includes(task.body.id));
    assert.equal((await call("/api/v2/agent/tasks", body, headers)).body.id, task.body.id);
    assert.equal((await call("/api/v2/agent/tasks", { ...body, language: "PYTHON" }, headers)).code, "PRIVATE_AGENT_LANGUAGE_NOT_ENABLED");
    const revision = saveManualRevision({store:service.app.store,project:PROJECT,actor:login.body.user.id,key:"existing-manual-failure",sql:"SELECT missing_col FROM positions",contextId:"holdings-t1"}).revision;
    const failed = service.app.store.create("run", PROJECT, { revisionId: revision.id, revisionHash:revision.hash,contextId:revision.contextId,validationContractId,
      status: "FAILED", engine: "Apache Spark", error: "stored unresolved column missing_col" });
    const repairBody = { ...body, sql: revision.sql, sourceRunId: failed.id, sourceError: "untrusted client override" };
    const repairHeaders = { ...headers, "idempotency-key": "repair-fixture" };
    const repaired = await call("/api/v2/agent/tasks", repairBody, repairHeaders);
    assert.equal(repaired.status, 202); assert.equal(repaired.body.sourceRunId, failed.id);
    assert.equal(service.app.store.get("agent", repaired.body.id, PROJECT).durable.validationError, failed.error);
    for (const patch of [{ sql: "SELECT 2" }, { contextId: "cash-change" }])
      assert.equal((await call("/api/v2/agent/tasks", { ...repairBody, ...patch }, repairHeaders)).body.code, "AGENT_REPAIR_SOURCE_MISMATCH");
    service.app.store.update("run", failed.id, PROJECT, { code: "REMOTE_SPARK_TIMEOUT" });
    assert.equal((await call("/api/v2/agent/tasks", repairBody, repairHeaders)).body.code, "AGENT_REPAIR_SOURCE_MISMATCH");
    service.app.store.update("run", failed.id, PROJECT, { status: "SUCCEEDED", code: undefined });
    assert.equal((await call("/api/v2/agent/tasks", repairBody, repairHeaders)).body.code, "AGENT_REPAIR_SOURCE_MISMATCH");
    const outside = service.app.store.create("run", "other-project", { status: "FAILED", revisionId: revision.id });
    assert.equal((await call("/api/v2/agent/tasks", { ...repairBody, sourceRunId: outside.id }, repairHeaders)).status, 404);
  } finally { await service.close(); }
});

test("private application preserves ordinary authentication and CSRF checks", async () => {
  const app = await open();
  try {
    const result = await app.invoke({ operation: "PRIVATE_APPLICATION_HTTP_V1", method: "POST", path: "/api/v2/revisions", body: { sql: "SELECT 1", contextId: "holdings-t1" } });
    assert.equal(result.status, 200);
    assert.equal(result.body.status, 401);
    assert.equal(result.body.body.code, "AUTHENTICATION_REQUIRED");
  } finally { await app.close(); }
});

test("fixture acceptance exercises task API, deduplication, changed context and revocation", async () => {
  const app = await open();
  try {
    for (const caseId of ["holdings-t1", "cash-change"]) {
      const result = await app.invoke({ operation: "PRIVATE_APPLICATION_TASK_V1", caseId });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.totalAssets, String(getContext(caseId).expected[0].total_assets));
      assert.equal(result.body.duplicateSubmissionDeduplicated, true);
      assert.equal(result.body.refreshedResultMatches, true);
      assert.equal(result.body.fullAgentLifecycleVerified, false);
      assert.ok(!JSON.stringify(result.body).includes("csrf_"));
    }
    const users = app.app.store.list("auth_user", "project-securities-lab");
    assert.equal(users.length, 2);
    assert.ok(users.every(u => u.status === "DISABLED"));
  } finally { await app.close(); }
});

test("private application invocation is unavailable when the private gate is disabled", async () => {
  const app = await open(false);
  try {
    assert.equal((await app.invoke({ operation: "PRIVATE_APPLICATION_TASK_V1", caseId: "holdings-t1" })).status, 404);
  } finally { await app.close(); }
});
