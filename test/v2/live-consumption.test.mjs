import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { advanceLiveLifecycleCase, refreshLiveLifecycleConsumption, verifyLiveCaseEvidence, summarizeLiveLifecycle,
  liveLifecycleContract, legacyLiveLifecycleContract } from "../../src/v2/live-lifecycle-evaluation.mjs";
import { inspectLifecycleConsumption, verifyLifecycleConsumptionStage, validLifecycleConsumptionSource } from "../../src/v2/lifecycle-consumption.mjs";
import { m1EvaluationCases } from "../../src/v2/evaluation.mjs";
import { createLiveLifecycleFixture } from "./fixtures/live-lifecycle-case.mjs";

// Pure synthetic API adapter and checkpoints. No network, provider, Spark or
// production evidence; TEST_HARNESS records must never score as real success.
const advance = (f, checkpoint=f.checkpoint, options={}) => advanceLiveLifecycleCase(f.definition,checkpoint,f.adapter,{pause:async()=>{},maxPolls:2,...options});
async function waitingFixture(options={}) {
  const f=createLiveLifecycleFixture(options);f.reviewNow();
  const saved=[];const waiting=await advance(f,f.checkpoint,{save:value=>saved.push(value)});
  assert.equal(waiting.status,"AWAITING_CONSUMPTION");assert.equal(waiting.phase,"CONSUMPTION");
  return {...f,waiting,saved};
}

test("v2 persists the complete monitor boundary before consumption and resume performs exactly one bounded GET",async()=>{
  const f=await waitingFixture(),source=f.waiting.consumptionSource;
  assert.equal(f.waiting.contractId,liveLifecycleContract.id);assert.equal(liveLifecycleContract.stages.at(-1),"CONSUMPTION");
  assert.ok(f.saved.some(state=>state.status==="AWAITING_CONSUMPTION"&&state.consumptionSource&&!state.consumptionStage),"source saved before evidence read");
  assert.equal(source.taskId,f.task.id);assert.equal(source.developmentRunId,f.run.id);assert.equal(source.revisionId,f.revision.id);
  assert.equal(source.packageDigest,f.bundle.digest);assert.equal(source.releaseId,f.release.id);assert.equal(source.batches.length,2);
  const expectedPath="/data-services/task-evidence?"+new URLSearchParams({agent_task_id:f.task.id,package_digest:f.bundle.digest,release_id:f.release.id});
  const mutations=[...f.mutations],code=structuredClone(f.waiting.code),actions=structuredClone(f.waiting.actions);
  let requests=0;
  const readOnly={testDouble:true,request:async(path,body,key)=>{requests++;assert.equal(path,expectedPath);assert.equal(body,undefined);assert.equal(key,undefined);return f.consumption;}};
  const done=await refreshLiveLifecycleConsumption(f.definition,JSON.parse(JSON.stringify(f.waiting)),readOnly);
  assert.equal(requests,1);assert.equal(done.status,"SUCCEEDED");assert.equal(done.phase,"COMPLETE");
  assert.equal(done.consumptionStage.status,"PASSED");assert.equal(done.consumptionStage.externalSystemVerified,false);
  assert.equal(verifyLiveCaseEvidence(f.definition,done),true);assert.deepEqual(done.code,code);assert.deepEqual(done.actions,actions);assert.deepEqual(f.mutations,mutations);
  const again=await refreshLiveLifecycleConsumption(f.definition,done,{request:()=>{throw Error("terminal success must not read or write");}});
  assert.deepEqual(again,done);assert.equal(requests,1);
  const summary=summarizeLiveLifecycle(m1EvaluationCases(),[done]);assert.equal(summary.succeededCaseCount,0);assert.equal(summary.targetMet,false);assert.equal(summary.executionEvidenceMode,"TEST_HARNESS");
});

test("unknown read pauses at consumption, preserving source, model usage and actions without replaying earlier phases",async()=>{
  const f=await waitingFixture(),before=structuredClone(f.waiting);f.failConsumptionRead(true);
  let paused=await advance(f,JSON.parse(JSON.stringify(f.waiting)));
  assert.equal(paused.status,"PAUSED");assert.equal(paused.phase,"CONSUMPTION");assert.equal(paused.errorCode,"CONSUMPTION_READ_UNCONFIRMED");
  assert.deepEqual(paused.consumptionSource,before.consumptionSource);assert.deepEqual(paused.code,before.code);assert.deepEqual(paused.actions,before.actions);
  assert.equal(f.mutations.length,2);const readCount=f.reads.length;
  paused=await advance(f,JSON.parse(JSON.stringify(paused)));assert.equal(f.reads.length,readCount+1);assert.equal(f.mutations.length,2);
  f.failConsumptionRead(false);f.consumeNow();const restored=await advance(f,paused);
  assert.equal(restored.status,"SUCCEEDED");assert.equal(f.mutations.length,2);assert.deepEqual(restored.code,before.code);
  assert.equal(restored.errorHistory.at(-1).code,"CONSUMPTION_READ_UNCONFIRMED");
});

test("VERIFIED labels cannot replace exact XAPI, pinned DAPI versions, successful source batch or valid call proof",async()=>{
  const f=await waitingFixture(),source=f.waiting.consumptionSource;
  for(const change of [
    r=>{r.sourceKind="MANUAL";},r=>{r.sourceKind="UNKNOWN";},r=>{r.sourceAttribution="ENGINEER_ASSISTED";},
    r=>{r.taskId=randomUUID();},r=>{r.packageDigest="f".repeat(64);},r=>{r.releaseId=randomUUID();},
    r=>{r.protocol="shuduo-private-task-consumption/v1";},r=>{r.scope="PRIVATE_CLOUD_TEST";},r=>{r.externalSystemVerified=true;},r=>{r.truncated=true;},
    r=>{r.services=[];r.matchingCount=0;},r=>{r.services[0].serviceType="DAPI";},r=>{r.services[0].sourceKind="MANUAL";},
    r=>{r.services[0].sourceAttribution="ENGINEER_ASSISTED";},r=>{r.services[0].sourceKind="UNKNOWN";},
    r=>{r.services[0].releaseId=randomUUID();},r=>{r.services[0].sourceRunIds=[f.run.id];},r=>{r.services[0].sourceVersions[0].sourceReleaseRunId=f.run.id;},
    r=>{r.services[0].sourceVersions[1].sourceReleaseRunId=f.batches[1].id;},r=>{r.services[0].sourceVersions[1].releaseId=randomUUID();},
    r=>{r.services[0].sourceVersions[0].sourceKind="MANUAL";},r=>{r.services[0].sourceVersions[0].sourceAttribution="ENGINEER_ASSISTED";},
    r=>{r.services[0].sourceVersions[0].sourceKind="UNKNOWN";},r=>{r.services[0].sourceVersions[0].packageDigest="0".repeat(64);},
    r=>{r.services[0].sourceVersions=r.services[0].sourceVersions.slice(0,1);},r=>{r.services[0].sourceVersions[1].versionId=r.services[0].sourceVersions[0].versionId;},
    r=>{r.services[0].sourceVersions[1].serviceId=r.services[0].sourceVersions[0].serviceId;},r=>{delete r.services[0].sourceVersions;},
    r=>{r.services[0].sourceVersions[0].configHash="not-a-hash";},r=>{r.services[0].configHash="not-a-hash";},
    r=>{r.services[0].sourceVersions[1].fields=["client_id","available_cash"];},r=>{r.services[0].sourceVersions[0].fields.push("arbitrary-secret-field");},
    r=>{r.services[0].call.versionId=randomUUID();},r=>{r.services[0].call.configHash="a".repeat(64);},r=>{delete r.services[0].call.configHash;},
    r=>{r.services[0].call.resultHash="unverified";},r=>{r.services[0].call.verified=false;},
    r=>{r.services[0].call.rowCount=0;},r=>{r.services[0].call.applicationStatus="MISSING";},r=>{r.services[0].call.finishedAt="2020-01-01T00:00:00Z";},
    r=>{r.services[0].call.callId="../unsafe";},r=>{r.services[0].call.applicationId="";},
  ]){
    const report=structuredClone(f.consumption);change(report);
    assert.notEqual(inspectLifecycleConsumption(source,report).status,"PASSED");
    const state=await refreshLiveLifecycleConsumption(f.definition,f.waiting,{request:async()=>report});
    assert.equal(state.status,"AWAITING_CONSUMPTION");assert.equal(state.phase,"CONSUMPTION");assert.equal(verifyLiveCaseEvidence(f.definition,state),false);
    assert.equal(state.code.reportedTokens,f.waiting.code.reportedTokens);
  }
  for(const applicationStatus of ["ACTIVE","REVOKED","EXPIRED"]){
    const report=structuredClone(f.consumption);report.services[0].call.applicationStatus=applicationStatus;
    const result=inspectLifecycleConsumption(source,report);assert.equal(result.status,"PASSED");assert.equal(result.evidence.services[0].call.applicationStatus,applicationStatus);
    assert.equal(result.externalSystemVerified,false);assert.match(result.notice,/不代表当前授权/);
  }
});

test("saved consumption stages are projected, revalidated and cannot turn development runs or inconsistent checkpoints into publish evidence",async()=>{
  const f=await waitingFixture();f.consumption.token="SYNTHETIC_NOT_FOR_CHECKPOINT";f.consumption.services[0].rows=[{secret:"SYNTHETIC_NOT_FOR_CHECKPOINT"}];
  const stage=inspectLifecycleConsumption(f.waiting.consumptionSource,f.consumption);
  assert.equal(stage.status,"PASSED");assert.doesNotMatch(JSON.stringify(stage),/SYNTHETIC_NOT_FOR_CHECKPOINT/);
  assert.equal(verifyLifecycleConsumptionStage(f.waiting.consumptionSource,stage),true);
  const corrupted=structuredClone(stage);corrupted.evidence.services[0].call.versionId=randomUUID();assert.equal(verifyLifecycleConsumptionStage(f.waiting.consumptionSource,corrupted),false);
  let requests=0;const forbidden={request:()=>{requests++;throw Error("invalid checkpoint must not request");}};
  for(const change of [
    s=>{s.consumptionSource.releaseId=randomUUID();},s=>{s.publication.batchIds.reverse();},s=>{s.delivery.packageDigest="f".repeat(64);},
    s=>{s.consumptionSource.batches[0].id=s.consumptionSource.developmentRunId;},s=>{s.code.sourceKind="MANUAL";},
    s=>{s.code.sourceAttribution="ENGINEER_ASSISTED";},s=>{s.publication.sourceAttribution="ENGINEER_ASSISTED";},
    s=>{s.actions.delivery.id=randomUUID();},s=>{s.caseId="unregistered-case";},s=>{s.phase="CODE_AND_DEBUG";},
  ]){const state=structuredClone(f.waiting);change(state);await assert.rejects(refreshLiveLifecycleConsumption(f.definition,state,forbidden));}
  const developmentBatch={...f.waiting.consumptionSource,batches:[{...f.waiting.consumptionSource.batches[0],id:f.run.id},f.waiting.consumptionSource.batches[1]]};
  assert.equal(validLifecycleConsumptionSource(developmentBatch),false);assert.equal(requests,0);
});

test("manual key artifacts cannot enter the new native Agent checkpoint",async()=>{
  for(const alter of [f=>{f.revision.source="MANUAL";},f=>{f.revision.manualProvenance={kind:"ENGINEER_EDIT"};},
    f=>{f.delivery.sourceKind="MANUAL";},f=>{f.release.sourceKind="MANUAL";},f=>{f.review.sourceKind="MANUAL";},
    f=>{f.approval.sourceKind="MANUAL";},f=>{f.batches[0].sourceKind="MANUAL";}]){
    const f=createLiveLifecycleFixture();f.reviewNow();f.consumeNow();alter(f);
    const result=await advance(f);assert.equal(result.status,"FAILED");assert.notEqual(result.phase,"COMPLETE");
    assert.equal(f.reads.some(path=>path.startsWith("/data-services/task-evidence")),false);
  }
});

test("unknown or contradictory provenance is never normalized into a native Agent success",async()=>{
  for(const record of ["task","revision","run","bundle","delivery","verification","release","review","approval"]){
    for(const patch of [{sourceKind:"UNKNOWN"},{sourceKind:null},{sourceKind:"AGENT",sourceAttribution:"ENGINEER_ASSISTED"}]){
      const f=createLiveLifecycleFixture();f.reviewNow();f.consumeNow();Object.assign(f[record],patch);
      const state=await advance(f);assert.equal(state.status,"FAILED",record+JSON.stringify(patch));
      assert.equal(verifyLiveCaseEvidence(f.definition,state),false);
      assert.equal(f.reads.some(path=>path.startsWith("/data-services/task-evidence")),false);
    }
  }
  for(const patch of [{sourceKind:"UNKNOWN"},{sourceKind:"AGENT",sourceAttribution:"ENGINEER_ASSISTED"}]){
    const f=createLiveLifecycleFixture();f.reviewNow();f.consumeNow();Object.assign(f.batches[0],patch);
    assert.equal((await advance(f)).status,"FAILED");
  }
});

test("legacy v1 reports retain their monitor-only contract; they never silently upgrade, refresh or mix into v2",async()=>{
  const f=await waitingFixture(),legacy=structuredClone(f.waiting);
  delete legacy.contractId;delete legacy.consumptionSource;delete legacy.consumptionStage;delete legacy.errorCode;
  legacy.status="SUCCEEDED";legacy.phase="COMPLETE";
  assert.equal(verifyLiveCaseEvidence(f.definition,legacy),false);
  assert.equal(verifyLiveCaseEvidence(f.definition,legacy,{contractId:legacyLiveLifecycleContract.id}),true);
  const summary=summarizeLiveLifecycle(m1EvaluationCases(),[legacy],{contractId:legacyLiveLifecycleContract.id});
  assert.equal(summary.contract.id,legacyLiveLifecycleContract.id);assert.equal(summary.contract.stages.includes("CONSUMPTION"),false);assert.match(summary.notice,/不含消费/);
  assert.throws(()=>summarizeLiveLifecycle(m1EvaluationCases(),[legacy]),{code:"CASE_CONTRACT_MISMATCH"});
  let requests=0;const forbidden={request:()=>{requests++;throw Error("legacy must not run");}};
  await assert.rejects(advanceLiveLifecycleCase(f.definition,legacy,forbidden),{code:"CASE_CONTRACT_MISMATCH"});
  await assert.rejects(refreshLiveLifecycleConsumption(f.definition,legacy,forbidden),{code:"CASE_CONTRACT_MISMATCH"});assert.equal(requests,0);
  assert.equal(legacy.contractId,undefined);assert.equal(legacy.consumptionStage,undefined);
});

test("fixed twenty-case denominator keeps awaiting consumption uncompleted and test harness success out of the real score",async()=>{
  const f=await waitingFixture(),pending=summarizeLiveLifecycle(m1EvaluationCases(),[f.waiting]);
  assert.equal(pending.frozenCaseCount,20);assert.equal(pending.awaitingConsumptionCaseCount,1);assert.equal(pending.completedCaseCount,0);
  assert.equal(pending.attemptedCaseCount,1);assert.equal(pending.unexecutedCaseCount,19);assert.equal(pending.targetMet,false);
  f.consumeNow();const done=await advance(f,f.waiting),summary=summarizeLiveLifecycle(m1EvaluationCases(),[done]);
  assert.equal(summary.completedCaseCount,1);assert.equal(summary.succeededCaseCount,0);assert.equal(summary.completionRate,0);assert.equal(summary.targetMet,false);
  assert.equal(summary.agentIndependentE2E,false);assert.equal(summary.publicDeployed,false);assert.equal(summary.externalSystemVerified,false);
});
