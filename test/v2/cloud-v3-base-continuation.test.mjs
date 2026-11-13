import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runV2Cli } from "../../bin/shuduo.mjs";
import { sha256 } from "../../src/v2/delivery.mjs";
import { cloudV3BaseCases } from "../../src/v2/cloud-v3-case-selection.mjs";
import { currentLiveLifecycleContract, liveLifecyclePlan } from "../../src/v2/live-lifecycle-evaluation.mjs";
import { referenceSqlForContext, validationFamilyForContext } from "../../src/v2/context.mjs";
import { developmentRequestDigest } from "../../src/v2/public-development-access.mjs";
import { cloudWindowApplicationBinding, cloudWindowCheckpointBinding, nextCloudWindowReceiptProtocol } from "../../scripts/first-cloud-v3-window.mjs";
import { continueCloudV3Start, prepareCloudV3Start } from "../../scripts/start-cloud-v3-case.mjs";
import { nextCloudV3Definition, readCloudV3Run } from "../../scripts/cloud-v3-run.mjs";
import { fixtureFirstCloudIndex, fixtureFirstCloudInspection } from "./fixtures/first-cloud-application-inspection.mjs";

const source = "a".repeat(40);
const read = path => JSON.parse(readFileSync(path,"utf8"));
const write = (path,value) => writeFileSync(path,JSON.stringify(value),{mode:0o600});

// These receipts exercise file and response bindings. The loopback fixture
// never claims model execution, Spark, release or cloud verification.
function recordLocalCompletion(path, completionPath, reserveCny,definition,actorId) {
  const state=read(path), [item]=state.outcomes, taskId=item.taskId??randomUUID(), batchIds=[randomUUID(),randomUUID()];
  const releaseId=randomUUID(), packageDigest=sha256(randomUUID()), verificationId=randomUUID();
  item.taskId=taskId;
  if (!state.submission) state.submission={actorId};
  item.actions.agent={...item.actions.agent,id:taskId,status:"CONFIRMED"};
  item.actions.publication={id:releaseId,packageDigest,verificationId,batchIds,status:"CONFIRMED",bill:{unsettledReserveCny:reserveCny}};
  item.code={revisionId:randomUUID(),runId:randomUUID(),revisionHash:sha256(referenceSqlForContext(definition.contextId))};
  item.consumption=Object.fromEntries(batchIds.map(batchId=>[batchId,{batchId,status:"MATCHED_ONLY",
    ...Object.fromEntries(["sourceDigest","planDigest","reportDigest","dapiCallIdDigest","xapiCallIdDigest",
      "dapiRowsDigest","xapiRowsDigest"].map(key=>[key,sha256(randomUUID())]))}]));
  write(path,state);
  const body={protocol:"shuduo-cloud-v3-completion/v1",scope:"LOCAL_MATCHED_ONLY",checkedAt:new Date().toISOString(),
    checkpointDigest:sha256(readFileSync(path)),evaluationRunId:state.evaluationRunId,caseSetDigest:state.caseSetDigest,
    caseId:item.caseId,requestDigest:item.requestDigest,taskId,revisionId:item.code.revisionId,developmentRunId:item.code.runId,
    packageDigest,verificationId,releaseId,batchIds,consumptionDigest:sha256(JSON.stringify(Object.values(item.consumption)))};
  write(completionPath,{...body,completionDigest:sha256(JSON.stringify(body))});
}

test("all twenty fixed V3 cases continue with distinct requests, checked parent bindings and retained approvals",async t=>{
  const dir=mkdtempSync(join(tmpdir(),"shuduo-cloud-base-"));
  t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const file=name=>join(dir,name+".json");
  const firstPath=file("first"), completionPath=file("first-completion"), recordsPath=file("case-records");
  const appPath=file("inspection"), billPath=file("bill"), windowPath=file("window");
  const baseUrl="http://127.0.0.1:3100/api/v2", projectId="fictional-securities", actorId=randomUUID();
  const inspection=fixtureFirstCloudInspection(source,"b".repeat(40)), requests=[], parents=new Map(), revisions=new Map();
  let session, budget, receipt, activeKey, staleSeed=false;
  const client={baseUrl,projectId,
    fetchImpl:async (url,options)=>{
      assert.equal(new URL(url).pathname,"/v2/");
      requests.push(options.method+" /v2/");
      return new Response(fixtureFirstCloudIndex,{headers:{"content-type":"text/html"}});
    },
    request:async (path,options)=>{
      requests.push((options?.method??"GET")+" "+path);
      if (path==="/status?include=session") return {session,status:{mode:"PUBLIC_INVITATION",projectId,budget,
        model:{configured:true},spark:{available:true,healthVerified:true,isolation:"REMOTE_FUNCTION"},
        agentDevelopment:{durableEnabled:true,derivationBindingSupported:true,sqlMaxAttempts:3,sqlTokenBudget:32000}}};
      if (path==="/auth/session") return {authenticated:true,user:{id:actorId,projectId}};
      if (parents.has(path)) return parents.get(path);
      if (revisions.has(path)) return staleSeed?{...revisions.get(path),sql:"SELECT changed"}:revisions.get(path);
      if (path==="/agent/tasks" && options?.method==="POST") {
        assert.equal(options.idempotencyKey,activeKey);
        receipt={id:randomUUID(),contextId:options.body.contextId,message:options.body.message,
          initialSql:options.body.derivation?options.body.sql:options.body.sql.trim(),mode:"LIVE_MODEL",language:"SPARK_SQL",version:1,attempts:[],
          executionMode:"DURABLE_SQL_AGENT_V1",createdAt:new Date().toISOString()};
        if (options.body.derivation) {
          const parent=revisions.get("/revisions/"+options.body.derivation.revisionId);
          assert.equal(options.body.sql,parent.sql);
          receipt.derivedFrom={...options.body.derivation,contextId:parent.contextId,
            validationContractId:validationFamilyForContext(parent.contextId).id};
        }
        throw Error("fixture response lost");
      }
      assert.equal(path,"/agent/requests/"+activeKey);
      return receipt;
    },
  };
  const fullPlan=liveLifecyclePlan(20,{contractId:currentLiveLifecycleContract.id}), catalog=fullPlan.selectedCases;
  const saveParent=(path,definition)=>{
    if (definition.kind!=="FRESH") return;
    const state=read(path), [item]=state.outcomes, code=item.code;
    const sql=referenceSqlForContext(definition.contextId), family=validationFamilyForContext(definition.contextId);
    const binding={revisionId:code.revisionId,revisionHash:code.revisionHash,runId:code.runId};
    revisions.set("/revisions/"+code.revisionId,{id:code.revisionId,hash:code.revisionHash,sql,
      source:"LIVE_MODEL",contextId:definition.contextId});
    parents.set("/agent/requests/"+item.actions.agent.key+"/execution-evidence",{
      protocol:"shuduo-agent-execution-evidence/v1",scope:"PRIVATE_CLOUD_TEST",verificationMode:"STORED_METADATA_ONLY",
      status:"EXECUTION_RECORDED",fullLifecycleE2E:false,publicDeployed:false,taskId:item.taskId,
      contextId:definition.contextId,requestSha256:sha256(definition.request),seedSqlSha256:sha256(definition.seedSql.trim()),
      taskCreatedAt:state.submission?.submittedAt??item.evaluationStartedAt,
      development:{...binding,engine:"Apache Spark",engineVersion:"3.5.9",validationContractId:family.id,
        regressionCount:family.contextIds.length,model:"qwen3-coder-plus"},
      execution:{state:"RECORDED",taskId:item.taskId,taskVersion:6,evidence:"STORED_METADATA",
        spark:{...binding,state:"RESULT_RECORDED",resultStatus:"SUCCEEDED",pinned:false},
        model:{state:"OUTPUT_RECORDED",usage:"RECORDED",attempts:1,unconfirmedAttempts:0,
          ledgerTokens:12,reportedTokens:12,reservedTokens:0,unattributedTokens:0}},
    });
  };
  write(appPath,inspection);
  prepareCloudV3Start(firstPath,client,source);
  recordLocalCompletion(firstPath,completionPath,64,catalog[0],actorId);
  saveParent(firstPath,catalog[0]);
  const original=readFileSync(firstPath), evaluation=read(firstPath);
  const entries=[], keys=new Set(), approvals=[];
  const fresh=cloudV3BaseCases();
  assert.equal(fresh.length,10);
  const prepare=async(path,exit=0)=>{
    let result,message;
    const code=await runV2Cli(["agent","v3-prepare-next","--checkpoint",path,"--first-checkpoint",firstPath,
      "--completion-file",completionPath,"--case-records",recordsPath,"--source-revision",source],{},
    {client,output:line=>{result=JSON.parse(line);},error:line=>{message=line;}});
    assert.equal(code,exit,message);
    return result;
  };

  for (const [offset,definition] of catalog.slice(1).entries()) {
    const index=offset+1, checkpoint=file("case-"+index), completion=file("completion-"+index);
    write(recordsPath,entries);
    requests.length=0;
    const prepared=await prepare(checkpoint);
    const derived=definition.kind==="DERIVED";
    assert.equal(requests.length,derived?3:0);
    assert.ok(requests.every(request=>request.startsWith("GET ")));
    requests.length=0;
    assert.equal(prepared.caseId,definition.id);
    assert.equal(prepared.evaluationRunId,evaluation.evaluationRunId);
    assert.equal(read(checkpoint).startedAt,evaluation.startedAt);
    activeKey=read(checkpoint).outcomes[0].actions.agent.key;
    const binding=cloudWindowCheckpointBinding(checkpoint);
    assert.equal(binding.contextId,definition.contextId);
    assert.ok(!keys.has(binding.requestKeyHash));
    keys.add(binding.requestKeyHash);
    assert.deepEqual(binding.previousCase.approvalDigests,index===1?undefined:approvals);
    if (derived) assert.equal(binding.derivationSource.sourceCaseId,definition.sourceCaseId);
    assert.ok(!Object.hasOwn(read(checkpoint).outcomes[0],"sql"));
    const reserveCny=64+index-1;
    assert.equal(binding.previousCase.reserveCny,reserveCny);
    const now=Date.now(), startsAt=new Date(now-1000).toISOString(), expiresAt=new Date(now+60000).toISOString();
    const month=new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit"}).format(now);
    if (index>1) assert.deepEqual(binding.previousCase.usageFloor,{
      month,modelCalls:index-1,remoteSparkRuns:(index-1)*4,remoteSparkSeconds:(index-1)*24,
    });
    const approvalDigest=sha256(randomUUID());
    const window={protocol:nextCloudWindowReceiptProtocol,checkpoint:binding,approvalDigest,startsAt,expiresAt,
      application:{...cloudWindowApplicationBinding(inspection,binding),crc64:"123456789"},
      bill:{month,checkedAt:startsAt,spendCny:12,recordCount:1,pagesDigest:sha256("pages"),unsettledReserveCny:reserveCny,maxIncrementCny:2}};
    write(billPath,{checkedAt:new Date(now).toISOString(),unsettledReserveCny:reserveCny,maxIncrementCny:2,
      pages:[{Success:true,Data:{PageNum:1,PageSize:300,TotalCount:1,BillingCycle:month,Items:{Item:[{Currency:"CNY",PretaxAmount:"12.00"}]}}}]});
    session={authenticated:true,role:"ADMIN",user:{id:actorId,projectId},readOnly:false,developmentOnly:true,
      developmentStartsAt:startsAt,developmentExpiresAt:expiresAt,developmentRequestOnly:true,
      developmentRequestDigest:developmentRequestDigest(binding.requestKeyHash,binding.requestBodyHash)};
    budget={enforced:"ALLOW",month,hardLimitCny:200,account:{observedSpendCny:12},model:{recordedCalls:index},
      remoteSpark:{runCount:index*4,seconds:index*24}};
    const options={billPath,windowPath,applicationPath:appPath};
    if (index===3) {
      write(windowPath,{...window,approvalDigest:approvals[0]});
      await assert.rejects(continueCloudV3Start(checkpoint,client,options),/独立开发窗口/);
      assert.deepEqual(requests,[]);
    }
    write(windowPath,window);
    if (index===10) {
      staleSeed=true;
      await assert.rejects(continueCloudV3Start(checkpoint,client,options),/派生父版本 SQL/);
      assert.ok(requests.every(request=>request.startsWith("GET ")));
      requests.length=0;
      staleSeed=false;
    }
    if (index===3) {
      budget.model.recordedCalls=0;
      await assert.rejects(continueCloudV3Start(checkpoint,client,options),/用量低于/);
      assert.deepEqual(requests,["GET /status?include=session"]);
      requests.length=0;
      budget.model.recordedCalls=index;
    }
    assert.equal((await continueCloudV3Start(checkpoint,client,options)).status,"PENDING");
    assert.deepEqual(requests,["GET /status?include=session","GET /v2/",
      ...(derived?["GET /revisions/"+binding.derivationSource.revisionId]:[]),"POST /agent/tasks"]);
    assert.equal(receipt.contextId,definition.contextId);
    assert.equal(receipt.message,definition.request);
    requests.length=0;
    assert.equal((await continueCloudV3Start(checkpoint,client,options)).status,"PENDING");
    assert.deepEqual(requests,[]);
    if (index===10) {
      const originalReceipt=receipt;
      receipt={...receipt,derivedFrom:{...receipt.derivedFrom,runId:randomUUID()}};
      assert.equal((await continueCloudV3Start(checkpoint,client,{reconcile:true})).status,"PENDING");
      assert.deepEqual(requests,["GET /auth/session","GET /agent/requests/"+activeKey]);
      requests.length=0;
      receipt=originalReceipt;
    }
    assert.equal((await continueCloudV3Start(checkpoint,client,{reconcile:true})).taskId,receipt.id);
    assert.deepEqual(requests,["GET /auth/session","GET /agent/requests/"+activeKey]);
    assert.equal(read(checkpoint).submission.usage.remoteSparkRuns,index*4);
    if (index===2) {
      write(recordsPath,[...entries,{checkpoint}]);
      await prepare(file("skipped-case"),1);
      assert.throws(()=>readCloudV3Run(firstPath,{completionPath,recordsPath,nextPath:checkpoint}));
      const saved=readFileSync(checkpoint);
      const copied=read(checkpoint);
      copied.outcomes[0].taskId=evaluation.outcomes[0].taskId;
      write(checkpoint,copied);
      assert.throws(()=>readCloudV3Run(firstPath,{completionPath,recordsPath}),/不能复用其他案例/);
      writeFileSync(checkpoint,saved);
    }
    recordLocalCompletion(checkpoint,completion,reserveCny+1,definition,actorId);
    saveParent(checkpoint,definition);
    entries.push({checkpoint,completion});
    approvals.push(approvalDigest);
  }
  write(recordsPath,entries);
  const run=readCloudV3Run(firstPath,{completionPath,recordsPath});
  assert.equal(run.cases.length,20);
  assert.equal(run.cases.filter(item=>item.status==="LOCAL_MATCHED_ONLY").length,20);
  assert.equal(run.cases.filter(item=>item.status==="WAITING_FOR_SOURCE").length,0);
  assert.equal(run.cases[10].sourceCaseId,catalog[0].id);
  assert.equal(run.verifiedCloudCaseCount,0);
  assert.equal(run.nextCaseId,null);
  assert.equal(run.score.localOnlySuccesses,20);
  assert.equal(run.score.pendingCloudCases,20);
  assert.equal(run.score.cloudCoverage,0);
  assert.equal(run.score.reviewedCloudCompletionRate,null);
  assert.deepEqual(readFileSync(firstPath),original);
  await prepare(file("beyond-base-cases"),1);
  write(recordsPath,[entries[1],entries[0],...entries.slice(2)]);
  assert.throws(()=>readCloudV3Run(firstPath,{completionPath,recordsPath}),/上一例完成回执/);
});

test("a failed source removes only its own dependent case from the runnable sequence",()=>{
  const fullPlan=liveLifecyclePlan(20,{contractId:currentLiveLifecycleContract.id});
  const entries=fullPlan.selectedCases.slice(0,10).map((definition,index)=>({
    item:{caseId:definition.id},completion:index===0?{failure:{}}:{scope:"LOCAL_MATCHED_ONLY"},
  }));
  assert.equal(nextCloudV3Definition(fullPlan,entries).id,fullPlan.selectedCases[11].id);
});
