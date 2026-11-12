import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runV2Cli } from "../../bin/shuduo.mjs";
import { handleV2Mcp } from "../../bin/shuduo-mcp.mjs";
import { computeManifestDigest, createDeliveryPackage, sha256, unpackDeliveryPackage } from "../../src/v2/delivery.mjs";
import { verifyDeliveryDirectory } from "../../src/v2/delivery-runner.mjs";
import { createFcIngress } from "../../src/v2/fc-ingress.mjs";
import { fundContextIds, fundRehearsalAt } from "../../src/v2/fund-contexts.mjs";
import { resolveFundConsumptionSource } from "../../src/v2/fund-consumption-source.mjs";
import { createFundTestSql } from "../../src/v2/fund-delivery.mjs";
import { fundContext, fundReferenceSql } from "../../src/v2/fund-lookthrough.mjs";
import { readFundExecutionPreflight } from "../../src/v2/fund-preparation-client.mjs";
import { fundExecutionPreflightPath } from "../../src/v2/fund-preparation-request.mjs";
import { fundExecutionPreflight, resolveFundExecutionCandidate } from "../../src/v2/fund-execution-preflight.mjs";
import { assertFundConsent, fundAgentPublicationPreflight } from "../../src/v2/fund-publication.mjs";
import { verifyFundSignedExecution } from "../../src/v2/fund-signed-execution.mjs";
import { bindFundSignedDelivery } from "../../src/v2/fund-signed-delivery.mjs";
import { createFundSignedReceipts } from "../../src/v2/fund-signed-receipts.mjs";
import { createFundRehearsalRecovery } from "../../src/v2/fund-rehearsal-recovery.mjs";
import { createFundPreparations, fundAgentRequestSignature } from "../../src/v2/fund-preparation.mjs";
import { fundRequirementScope } from "../../src/v2/fund-requirement-contract.mjs";
import { validatePrivateApplicationRequest } from "../../src/v2/private-application.mjs";
import { resolvePublishedReportSource } from "../../src/v2/published-report-source.mjs";
import { createQueuedSparkJob, createQueuedSparkResult, queueConfigFromEnvironment } from "../../src/v2/remote-spark-queue.mjs";
import { plannedLocalRuns } from "../../src/v2/release-scheduler.mjs";
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
    isolation:"LOCAL_PROCESS", finishedAt:"2026-09-11T01:00:00.000Z", rows:context.expected,inputEvidence,fundPreparation,validation:{
      passed:true,selectedPassed:true,contractId:context.outputContractId,assertionEvidence,
      regressions:[{contextId,passed:true,inputEvidence,assertionEvidence}],
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

test("signed fund execution binds immutable job bytes and independent result to one exact preflight and delivery rehearsal", async t => {
  const store = new MetadataStore(":memory:");
  t.after(()=>store.close());
  const actorId = randomUUID(), [original,next] = fundContextIds.map(id=>savedFundSource(store,actorId,id));
  const source = {store,project:PROJECT,actorId,selection:original.selection};
  const preflightDigest = fundExecutionPreflight(source).preflightDigest;
  const {input} = resolveFundExecutionCandidate(source,preflightDigest);
  assert.throws(()=>resolveFundExecutionCandidate(source,"0".repeat(64)),{code:"FUND_EXECUTION_PREFLIGHT_CHANGED"});

  const queueConfig = queueConfigFromEnvironment({V2_SPARK_EXECUTOR_TRANSPORT:"OSS_QUEUE",
    V2_SPARK_EXECUTOR_SECRET:"synthetic-fund-signed-execution-only-12345"});
  const submitted = Date.now(), now = submitted + queueConfig.timeoutMs + 1;
  const {job} = createQueuedSparkJob(input,queueConfig,{now:submitted});
  const serializedJob = JSON.stringify(job);
  const options = {source,preflightDigest,jobId:job.jobId,serializedJob,queueConfig,now};
  assert.equal(verifyFundSignedExecution(options),undefined);
  const output = {...original.run,queueJobDigest:sha256(serializedJob),
    testSqlValidation:{passed:true,sqlHash:sha256(input.testSql)}};
  const sign = result => createQueuedSparkResult(job,result,queueConfig,now);
  const envelope = sign(output);
  const proof = verifyFundSignedExecution({...options,envelope});
  assert.equal(proof.status,"VERIFIED");
  assert.equal(proof.rowCount,7);
  assert.equal(proof.source.businessDate,original.context.businessDate);
  assert.equal(proof.source.modelMode,"SYNTHETIC_MODEL");
  assert.equal(proof.approved||proof.publicDeployed||proof.agentIndependentE2E,false);
  assert.doesNotMatch(JSON.stringify(proof),/PORT-DEMO|SELECT|"rows"|"expected"/);

  const wrongDate = createQueuedSparkJob({...input,context:next.context},queueConfig,{requestId:job.jobId,now:submitted});
  const differentJob = createQueuedSparkJob(input,queueConfig,{requestId:job.jobId,now:submitted});
  const badResults = [
    {...output,queueJobDigest:undefined}, {...output,rows:output.rows.slice(1)},
    {...output,testSqlValidation:{passed:true,sqlHash:"a".repeat(64)}},
    {...output,inputEvidence:{...output.inputEvidence,inputHash:"b".repeat(64)}},
  ];
  for (const invalid of [
    {jobId:randomUUID()},
    {serializedJob:JSON.stringify(wrongDate.job)},
    {serializedJob:JSON.stringify(differentJob.job)},
    ...badResults.map(result=>({envelope:sign(result)})),
  ]) assert.throws(()=>verifyFundSignedExecution({...options,envelope,...invalid}),{code:"FUND_SIGNED_EXECUTION_MISMATCH"});
  assert.throws(()=>verifyFundSignedExecution({...options,envelope:{...envelope,signature:"bad"}}),
    {code:"SPARK_QUEUE_RESULT_INVALID"});

  const build = item => createDeliveryPackage({agent:item.task,run:item.run,
    revision:store.get("revision",item.revision.id,PROJECT)});
  const delivery = build(original), nextDelivery = build(next);
  const evidence = {...options,envelope};
  assert.throws(()=>bindFundSignedDelivery(nextDelivery,nextDelivery.digest,evidence),{code:"FUND_SIGNED_DELIVERY_MISMATCH"});
  const bound = bindFundSignedDelivery(delivery,delivery.digest,evidence);
  assert.notEqual(bound.digest,delivery.digest);
  assert.deepEqual(bound.files,delivery.files);
  assert.equal(bindFundSignedDelivery(bound,bound.digest,evidence),bound);
  const marker = bound.manifest.source.fundSignedExecution;
  assert.equal(marker.queueJobDigest,proof.queueJobDigest);
  assert.equal(marker.resultDigest,proof.resultDigest);

  const directory=mkdtempSync(join(tmpdir(),"shuduo-signed-fund-rehearsal-"));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const receiptOptions = { store, project: PROJECT, root: directory, env: { V2_SPARK_EXECUTOR_SECRET: queueConfig.sharedSecret } };
  const receipts = createFundSignedReceipts(receiptOptions);
  assert.equal(receipts.read(original.run.id), undefined);
  const registration = { selection: original.selection, preflightDigest, jobId: job.jobId, serializedJob, envelope };
  const savedRegistration = receipts.register(registration);
  assert.equal(savedRegistration.replayed, false);
  assert.deepEqual(receipts.register(registration), { ...savedRegistration, replayed: true });
  assert.throws(() => receipts.register({ ...registration, envelope: sign({ ...output, durationMs: 123 }) }),
    { code: "FUND_SIGNED_RECEIPT_UNAVAILABLE" });
  const reopened = createFundSignedReceipts(receiptOptions);
  assert.deepEqual(verifyFundSignedExecution(reopened.read(original.run.id)), proof);
  const receiptDirectory = join(directory, ".data", "fund-signed-receipts");
  const [receiptFilename] = readdirSync(receiptDirectory);
  const receiptFile = join(receiptDirectory, receiptFilename);
  const originalBytes = readFileSync(receiptFile);
  writeFileSync(receiptFile, Buffer.concat([originalBytes, Buffer.from(" ")]));
  assert.throws(() => reopened.read(original.run.id), { code: "FUND_SIGNED_RECEIPT_UNAVAILABLE" });
  writeFileSync(receiptFile, originalBytes);
  assert.doesNotMatch(JSON.stringify(store.list("fund_signed_execution", PROJECT)), /serializedJob|envelope|sharedSecret/);
  const schedule=fundRehearsalAt(original.context.id);
  const request={directory:unpackDeliveryPackage(bound,join(directory,"bound"),bound.digest),
    expectedDigest:bound.digest,scheduledFor:schedule};
  let rehearsals=0;
  const runner=async actual=>{
    rehearsals++;
    assert.deepEqual({sql:actual.sql,context:actual.context,validationContexts:actual.validationContexts,testSql:actual.testSql},input);
    return output;
  };
  await assert.rejects(verifyDeliveryDirectory(request,{runner}),{code:"FUND_SIGNED_DELIVERY_EVIDENCE_REQUIRED"});
  await assert.rejects(verifyDeliveryDirectory(request,{runner,fundSignedExecution:options}),
    {code:"FUND_SIGNED_DELIVERY_EVIDENCE_REQUIRED"});
  const modified=structuredClone(bound);
  modified.manifest.source.fundSignedExecution.resultDigest="a".repeat(64);
  modified.digest=computeManifestDigest(modified.manifest);
  const alteredRequest={...request,directory:unpackDeliveryPackage(modified,join(directory,"altered"),modified.digest),
    expectedDigest:modified.digest};
  await assert.rejects(verifyDeliveryDirectory(alteredRequest,{runner,fundSignedExecution:evidence}),
    {code:"FUND_SIGNED_DELIVERY_MISMATCH"});
  await assert.rejects(verifyDeliveryDirectory({...request,
    beforeRun:()=>{throw new Error("approval changed before Spark");}},{runner,fundSignedExecution:evidence}),
    /approval changed before Spark/);
  assert.equal(rehearsals,0);
  const rehearsal=await verifyDeliveryDirectory(request,{runner,fundSignedExecution:evidence});
  assert.equal(rehearsal.status,"SUCCEEDED");
  assert.equal(rehearsal.published,false);
  assert.equal(rehearsal.mode,"LOCAL_FILE_REHEARSAL");
  assert.deepEqual(rehearsal.source.fundSignedExecution,marker);
  assert.equal(rehearsals,1);

  const reviewBundle={...bound,id:randomUUID()}, verification={...rehearsal,id:randomUUID(),packageId:reviewBundle.id};
  const reviewInput={bundle:reviewBundle,verification,localClassicSpark:true,schedulerMode:"LOCAL_TIMER",fundSignedExecution:evidence};
  const beforeReview=fundAgentPublicationPreflight(reviewInput);
  assert.equal(beforeReview.ready,false);
  assert.equal(beforeReview.rehearsalDigest,sha256(JSON.stringify(verification)));
  assert.deepEqual(beforeReview.fundSignedExecution,marker);
  const review={id:randomUUID(),packageId:reviewBundle.id,packageDigest:bound.digest,verificationId:verification.id,
    reviewer:{id:actorId},status:"REVIEWED",scope:"LOCAL_FILE_REVIEW",publicDeploymentApproved:false,
    fundRehearsalDigest:beforeReview.rehearsalDigest,attestations:{code:true,assertions:true,deliveryFiles:true,localScope:true}};
  const reviewed=fundAgentPublicationPreflight({...reviewInput,review});
  assert.equal(reviewed.ready,true);
  const consent={scope:"LOCAL_TEST_RELEASE",packageDigest:bound.digest,verificationId:verification.id,
    businessDate:original.context.businessDate,scheduleSpec:reviewed.scheduleSpec,preflightDigest:reviewed.digest,
    confirmFrozenFictionalData:true};
  assert.deepEqual(assertFundConsent({...reviewInput,review,consent}),consent);
  for(const changed of [
    {review:{...review,fundRehearsalDigest:undefined}},
    {verification:{...verification,id:randomUUID()}},
    {verification:{...verification,durationMs:5}},
    {bundle:nextDelivery},
  ]) assert.throws(()=>assertFundConsent({...reviewInput,review,consent,...changed}),{code:"FUND_PUBLICATION_SOURCE_CHANGED"});
  assert.throws(()=>assertFundConsent({...reviewInput,review,consent,fundSignedExecution:undefined}),
    {code:"FUND_SIGNED_DELIVERY_EVIDENCE_REQUIRED"});
  assert.throws(()=>assertFundConsent({...reviewInput,review,consent,fundSignedExecution:{...evidence,envelope:{...envelope,signature:"bad"}}}),
    {code:"SPARK_QUEUE_RESULT_INVALID"});

  const save = (kind, data) => store.create(kind, PROJECT, data);
  const deliveryTask = save("agent_delivery_task", { status: "SUCCEEDED", submittedBy: actorId,
    sourceAgentTaskId: original.task.id, sourceRunId: original.run.id,
    sourceRevisionId: original.revision.id, sourceSqlHash: original.revision.hash });
  const savedBundle = save("delivery_package", { ...bound, agentDeliveryTaskId: deliveryTask.id, sourceRunId: original.run.id });
  const savedRehearsal = save("delivery_verification", { ...rehearsal, packageId: savedBundle.id });
  store.update("agent_delivery_task", deliveryTask.id, PROJECT, { packageId: savedBundle.id,
    packageDigest: bound.digest, verificationId: savedRehearsal.id });
  const savedReview = save("delivery_review", { ...review, packageId: savedBundle.id, verificationId: savedRehearsal.id,
    fundRehearsalDigest: sha256(JSON.stringify(savedRehearsal)) });
  const publication = fundAgentPublicationPreflight({ ...reviewInput, bundle: savedBundle,
    verification: savedRehearsal, review: savedReview });
  const release = save("release", { status: "ACTIVE_LOCAL", health: "HEALTHY", successfulRunCount: 2,
    failedRunCount: 0, openAlertCount: 0, packageId: savedBundle.id, packageDigest: bound.digest,
    sourceRevisionId: original.revision.id, sourceSqlHash: original.revision.hash, sourceCodeHash: original.revision.hash,
    publicDeployed: false,
    adapter: "local-spark-v1", environment: "local-rehearsal", fundLookthrough: bound.manifest.source.fundLookthrough,
    scheduleSpec: consent.scheduleSpec, businessScheduledFor: schedule, activatedAt: "2026-09-11T00:00:00.000Z" });
  const approval = save("release_approval", { status: "APPROVED", scope: "LOCAL_TEST_RELEASE", publicDeploymentApproved: false,
    approver: { id: actorId }, packageId: savedBundle.id, packageDigest: bound.digest,
    sourceRevisionId: original.revision.id, sourceSqlHash: original.revision.hash, consumedByReleaseId: release.id,
    rehearsalId: savedRehearsal.id, reviewId: savedReview.id,
    fundConsent: { ...consent, verificationId: savedRehearsal.id, preflightDigest: publication.digest } });
  store.update("release", release.id, PROJECT, { approvalId: approval.id });
  const [batch] = plannedLocalRuns({ releaseId: release.id, packageId: savedBundle.id, packageDigest: bound.digest,
    businessScheduledFor: schedule, spec: consent.scheduleSpec, nowMs: Date.parse(release.activatedAt) }).map(plan => {
    const run = save("release_run", { ...savedRehearsal, ...plan, status: "SUCCEEDED", schedulerTriggered: true,
      executionEvidenceMode: "TEST_HARNESS", mode: "LOCAL_SCHEDULED_RELEASE", clockMode: "WALL_CLOCK_TIMER",
      triggeredAt: plan.scheduledTriggerAt, startedAt: plan.scheduledTriggerAt, finishedAt: plan.scheduledTriggerAt });
    save("monitor_event", { releaseId: release.id, packageDigest: bound.digest, releaseRunId: run.id,
      type: "BATCH_SUCCEEDED", status: "SUCCEEDED", schedulerTriggered: true, observedAt: run.finishedAt });
    return run;
  });
  const selection = { batchId: batch.id, releaseId: release.id, packageDigest: bound.digest };
  const readConsumption = fundSignedExecutionFor =>
    resolveFundConsumptionSource({ store, project: PROJECT, selection, fundSignedExecutionFor });
  assert.throws(() => readConsumption(), { code: "FUND_SIGNED_DELIVERY_EVIDENCE_REQUIRED" });
  assert.throws(() => readConsumption(() => ({ ...evidence, envelope: { ...envelope, signature: "bad" } })),
    { code: "FUND_CONSUMPTION_SOURCE_UNPROVEN" });
  const verified = readConsumption(selected => {
    assert.equal(selected.id, savedBundle.id);
    return evidence;
  });
  assert.equal(verified.evidence.rowCount, 7);
  assert.equal(verified.evidence.engineClassification, "TEST_HARNESS");
  assert.equal(verified.rows, undefined);

  const reportSource = { ...selection, kind: "AGENT", taskId: original.task.id,
    revisionId: original.revision.id, runId: original.run.id };
  const readReport = (fundSignedExecutionFor, owner = actorId) =>
    resolvePublishedReportSource({ store, project: PROJECT, source: reportSource, actorId: owner, fundSignedExecutionFor });
  assert.throws(() => readReport(undefined), { code: "FUND_SIGNED_DELIVERY_EVIDENCE_REQUIRED" });
  assert.throws(() => readReport(() => ({ ...evidence, envelope: { ...envelope, signature: "bad" } })),
    { code: "FUND_CONSUMPTION_SOURCE_UNPROVEN" });
  assert.throws(() => readReport(() => evidence), { code: "FUND_REPORT_SOURCE_UNPROVEN" });
  assert.throws(() => readReport(() => assert.fail("foreign owner reached signing evidence"), randomUUID()),
    { code: "REPORT_SOURCE_OWNER" });

  const recovering = save("agent_delivery_task", { status: "RUNNING", stage: "FILE_REHEARSAL_RUNNING",
    mode: "VERIFIED_ARTIFACT_ORCHESTRATION", signedPackageDigest: bound.digest, packageDigest: bound.digest,
    sourceAgentTaskId: original.task.id, sourceRunId: original.run.id, sourceRevisionId: original.revision.id,
    sourceSqlHash: original.revision.hash });
  const recoverablePackage = save("delivery_package", { ...bound, agentDeliveryTaskId: recovering.id });
  const interruptedVerification = save("delivery_verification", { status: "RUNNING", scheduledFor: schedule,
    agentDeliveryTaskId: recovering.id, packageId: recoverablePackage.id, packageDigest: bound.digest });
  const activeDelivery = store.update("agent_delivery_task", recovering.id, PROJECT,
    { packageId: recoverablePackage.id, verificationId: interruptedVerification.id });
  const parent = join(directory, ".v2-artifacts", "agent-deliveries");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const fileRoot = unpackDeliveryPackage(recoverablePackage, join(parent, recovering.id), bound.digest);
  const recovery = createFundRehearsalRecovery({ store, project: PROJECT, root: directory, evidenceFor: () => evidence, assertSource: () => {} });
  const oldUpdate = store.update.bind(store);
  store.update = (kind, id, ...args) => {
    if (kind === "agent_delivery_task" && id === recovering.id) throw Error("test failure between SQLite updates");
    return oldUpdate(kind, id, ...args);
  };
  try {
    assert.throws(() => recovery.complete(activeDelivery, recoverablePackage, interruptedVerification,
      { ...rehearsal, startedAt: interruptedVerification.createdAt, finishedAt: interruptedVerification.createdAt }),
    /test failure between SQLite updates/);
  } finally { store.update = oldUpdate; }
  const readDelivery = () => store.get("agent_delivery_task", recovering.id, PROJECT);
  const readVerification = () => store.get("delivery_verification", interruptedVerification.id, PROJECT);
  assert.equal(readDelivery().status, "RUNNING");
  assert.equal(readVerification().status, "RUNNING");
  store.interruptPending(PROJECT);
  const recoveryFile = join(fileRoot, "fund-rehearsal-recovery.json");
  renameSync(recoveryFile, recoveryFile + ".held");
  recovery.recover(readDelivery());
  assert.equal(readDelivery().stage, "FILE_REHEARSAL_UNCONFIRMED");
  assert.equal(readVerification().status, "INTERRUPTED");
  renameSync(recoveryFile + ".held", recoveryFile);
  recovery.recover(readDelivery());
  assert.equal(readDelivery().status, "SUCCEEDED");
  assert.equal(readDelivery().recoveredFromFileReceipt, true);
  assert.equal(readVerification().status, "SUCCEEDED");
  const recoveredVersion = readDelivery().version;
  recovery.recover(readDelivery());
  assert.equal(readDelivery().version, recoveredVersion);
});
