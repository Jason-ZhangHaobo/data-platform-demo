import test from "node:test";
import assert from "node:assert/strict";
import { agentJourney, deliveryStageText, publicationEvidenceText, verificationPresentation,manualConsumptionEntryMatches } from "../../web/src/agent-journey.ts";
import { contextIds } from "../../src/v2/context.mjs";
import { deliveryFiles } from "../../src/v2/delivery.mjs";
import { developmentVerificationReport } from "../../src/v2/agent-development-workflow.mjs";
import { referenceSql, validationContractId } from "../../src/v2/context.mjs";
import { sha256 } from "../../src/v2/delivery.mjs";
import {syncSqlContractId} from '../../src/v2/sync-sql-contract.mjs';
import {checkedAgentPublication} from '../../web/src/agent-delivery-evidence-read.ts';

const fixture = () => ({
  taskId: "synthetic-task", revisionId: "revision-one", runId: "run-one", dirty: false,
  report: { taskId: "synthetic-task", revisionId: "revision-one", runId: "run-one", status: "PASSED", checks: ["revision", "execution", "results", "regressions"].map(id => ({id, passed:true})) },
  delivery: { status: "SUCCEEDED", packageId: "package-one", packageDigest: "digest-one", verificationId: "verification-one", sourceRevisionId:"revision-one",sourceRunId:"run-one" },
  bundle: { id: "package-one", digest: "digest-one", files: Object.fromEntries(deliveryFiles.map(name => [name, "synthetic fixture"])) },
  verification: { id: "verification-one", status: "SUCCEEDED", mainSqlExecuted: true, testSqlValidation: {passed:true}, validation: {passed:true, regressions:contextIds.map(contextId=>({contextId,passed:true}))} },
  release: { id: "release-one", packageId: "package-one", packageDigest: "digest-one", sourceRevisionId: "revision-one", status: "COMPLETED_CLOUD_TEST", health: "HEALTHY", runCount: 2 },
  batches: [1,2].map(i => ({id:`batch-${i}`, status:"SUCCEEDED", schedulerTriggered:true})), alerts: [],
  events: [1,2].map(i=>({type:"BATCH_SUCCEEDED",releaseId:"release-one",releaseRunId:`batch-${i}`,packageDigest:"digest-one"})),
});
const stage = (e,id) => agentJourney(e).steps.find(step=>step.id===id).state;

test("generated or pending code cannot be a completed code-and-debug milestone", () => {
  const f=fixture();
  for(const evidence of [{taskId:f.taskId,revisionId:f.revisionId,dirty:false},
    {...f,report:{...f.report,status:"PENDING"}},
    {...f,evidenceReadable:false},
    {...f,report:{...f.report,checks:[]}}]) {
    assert.equal(stage(evidence,"code"),"PENDING");
    assert.match(agentJourney(evidence).steps.find(s=>s.id==="code").detail,/等待核对执行与调试回执/);
  }
});

test('an explicit failed requirement binding cannot remain a green recorded-request milestone',()=>{
 const f=fixture();f.report.checks.push({id:'requirement',passed:false});f.report.status='NEEDS_ATTENTION';
 assert.equal(stage(f,'requirement'),'ATTENTION');assert.equal(agentJourney(f).next.id,'requirement');
 assert.match(agentJourney(f).steps[0].detail,/不能沿用原交付与批准/);
 assert.equal(stage({...f,evidenceReadable:false},'requirement'),'PENDING');assert.equal(stage({...f,dirty:true},'requirement'),'STALE');
 f.report.checks.at(-1).passed=true;assert.equal(stage(f,'requirement'),'DONE');assert.match(agentJourney(f).steps[0].detail,/仍须独立核验/);
});

test("code execution requires the current task, revision, run and registered family", () => {
  for(const change of [{taskId:"foreign-task"},{revisionId:"different-code"},{runId:"different-run"},{contextId:"unknown-family"}])
    assert.notEqual(stage({...fixture(),...change},"code"),"DONE");
  const f=fixture();f.report.validationContractId="foreign-contract";
  assert.notEqual(stage(f,"code"),"DONE");
});

test("failed execution needs attention and cannot inherit a generated revision's green state", () => {
  const f=fixture();f.report.status="NEEDS_ATTENTION";f.report.checks=f.report.checks.map(c=>c.id==="execution"?{...c,passed:false}:c);
  assert.equal(stage(f,"code"),"ATTENTION");
  assert.match(agentJourney(f).steps.find(s=>s.id==="code").detail,/执行尚未通过/);
});

test("completed execution is separate from business correctness and does not advance failed assertions", () => {
  const f=fixture();f.report.status="NEEDS_ATTENTION";f.report.checks=f.report.checks.map(c=>c.id==="results"?{...c,passed:false}:c);
  assert.equal(stage(f,"code"),"DONE");
  assert.match(agentJourney(f).steps.find(s=>s.id==="code").detail,/业务正确性另见独立结果核验/);
  assert.equal(stage(f,"validation"),"ATTENTION");
  assert.equal(agentJourney(f).next.id,"validation");
});

test("unconfirmed evidence reads revoke current verification and publication readiness", () => {
  const f = fixture();
  const j = agentJourney({...f, evidenceReadable:false});
  assert.equal(j.current, false);
  assert.equal(j.fileVerified, false);
  assert.equal(j.publicationCurrent, false);
  for (const id of ["code", "validation", "files", "publication", "monitoring", "services"])
    assert.notEqual(j.steps.find(s => s.id === id).state, "DONE");
  assert.equal(agentJourney({...f, evidenceReadable:true}).fileVerified, true);
});

test("old or unread reports cannot show current green checks and retry does not request computation", () => {
  for (const state of ["LOADING", "ERROR"]) {
    assert.equal(verificationPresentation(true, true, state).currentChecks, false);
    assert.notEqual(verificationPresentation(true, true, state).title, "核验通过");
  }
  assert.equal(verificationPresentation(false, true, "READY").title, "原版本报告");
  assert.equal(verificationPresentation(false, true, "READY").currentChecks, false);
  assert.match(verificationPresentation(true, true, "ERROR").detail, /不重新运行模型或 Spark/);
  assert.equal(verificationPresentation(true, false, "READY").title, "需要处理");
  assert.equal(verificationPresentation(true, true, "READY").title, "核验通过");
});

test("an in-flight report asks to await the existing receipt, not repair or resubmit", () => {
  const pending = verificationPresentation(true, false, "READY", "PENDING");
  assert.equal(pending.title, "等待执行核验");
  assert.match(pending.detail, /刷新只读取原记录，不重复提交模型或 Spark/);
  assert.equal(verificationPresentation(false, false, "READY", "PENDING").title, "原版本报告");
  assert.equal(verificationPresentation(true, false, "ERROR", "PENDING").title, "读取未确认");
  assert.equal(verificationPresentation(true, false, "READY", "NEEDS_ATTENTION").title, "需要处理");
});

test('settled failed checks are distinct from pending and historical backend reports',()=>{
 const task={id:'fictional-task',contextId:'holdings-t1'};
 const revision={id:'fictional-revision',contextId:task.contextId,sql:referenceSql,hash:sha256(referenceSql)};
 const run={id:'fictional-run',contextId:task.contextId,revisionId:revision.id,revisionHash:revision.hash,
  status:'VALIDATION_FAILED',engine:'Apache Spark',mainSqlExecuted:true,rows:[],
  validation:{passed:false,contractId:validationContractId,regressions:contextIds.map(contextId=>({contextId,passed:false}))}};
 const report=developmentVerificationReport(task,run,revision);
 assert.equal(report.status,'NEEDS_ATTENTION');
 assert.ok(report.checks.some(check=>check.passed));
 assert.ok(report.checks.some(check=>!check.passed));
 const failed=verificationPresentation(true,false,'READY',report.status);
 assert.equal(failed.currentChecks,true);
 assert.equal(failed.unpassedCheckLabel,'未通过');
 const pendingReport=developmentVerificationReport(task,{...run,status:'RUNNING'},revision);
 assert.equal(pendingReport.status,'PENDING');
 assert.equal(verificationPresentation(true,false,'READY',pendingReport.status).unpassedCheckLabel,'待核验');
 for(const state of ['LOADING','ERROR']){
  const view=verificationPresentation(true,false,state,report.status);
  assert.equal(view.currentChecks,false);
  assert.equal(view.unpassedCheckLabel,undefined);
 }
 const old=verificationPresentation(false,false,'READY',report.status);
 assert.equal(old.currentChecks,false);
 assert.equal(old.unpassedCheckLabel,undefined);
});

test("publication card uses the same evidence gate as journey, not a healthy status label", () => {
  const f = fixture();
  const label = e => {
    const j = agentJourney(e);
    return publicationEvidenceText(e.release, j.publicationCurrent, j.steps.find(s => s.id === "monitoring").state === "DONE");
  };
  assert.match(label(f), /监控证据核对通过/);
  for (const change of [{batches:[]}, {events:[]}, {alerts:[{status:"OPEN"}]}])
    assert.match(label({...f,...change}), /证据尚未齐备/);
  assert.match(label({...f, dirty:true}), /历史发布/);
  assert.match(label({...f, release:{...f.release, status:"ROLLED_BACK"}}), /已回滚/);
  assert.match(label({...f, release:{...f.release, status:"CANCELLED"}}), /已停止/);
  assert.match(label({...f, release:{...f.release, health:"CRITICAL"}}), /运行异常/);
});

test("delivery summary follows only the current reviewed package and preserves stopped releases", () => {
  const f=fixture();
  assert.equal(deliveryStageText("AWAITING_ENGINEER_REVIEW",agentJourney(f).publicationCurrent,f.release.status),"交付文件已演练并完成发布审阅");
  assert.equal(deliveryStageText("FILE_REHEARSAL_UNCONFIRMED",false),"原演练结果待核对");
  for(const change of [{dirty:true},{revisionId:"new-code"},{bundle:{...f.bundle,digest:"new-package"}}]) {
    const journey=agentJourney({...f,...change});
    assert.equal(deliveryStageText("AWAITING_ENGINEER_REVIEW",journey.publicationCurrent,f.release.status,journey.current),change.bundle?"演练通过，待审阅交付":"原版本交付记录；当前修改待核验");
  }
  for(const status of ["CANCELLED","ROLLED_BACK"])assert.equal(deliveryStageText("AWAITING_ENGINEER_REVIEW",true,status),"交付文件已演练；发布已停止");
});

test("journey shows actual evidence stages and never claims unverified service consumption or E2E", () => {
  const f=fixture(), journey=agentJourney(f);
  assert.equal(journey.steps.filter(s=>s.state==="DONE").length,6);
  assert.equal(journey.next.id,"services");
  assert.equal(journey.steps.at(-1).state,"PENDING");
  assert.match(journey.steps.at(-1).detail,/尚未核验消费/);
});
test("dirty, foreign task and historical run cannot inherit verified delivery or publication", () => {
  assert.equal(stage({...fixture(),dirty:true},"code"),"STALE");
  for(const change of [{dirty:true},{taskId:"other-task"},{revisionId:"other-revision"},{runId:"historical-run"}]) {
    const f={...fixture(),...change};
    assert.equal(agentJourney(f).fileVerified,false);
    assert.notEqual(stage(f,"publication"),"DONE");
    assert.notEqual(stage(f,"monitoring"),"DONE");
  }
});
test("file rehearsal needs files, bound receipt, actual main SQL, tests and every business fixture", () => {
  const changes=[f=>{delete f.bundle.files["schedule.json"];},f=>{f.delivery.packageDigest="old";},f=>{f.delivery.verificationId="other";},f=>{f.verification.mainSqlExecuted=false;},f=>{f.verification.validation.regressions.pop();},f=>{f.report.checks.pop();}];
  for(const mutate of changes){const f=fixture();mutate(f);assert.equal(agentJourney(f).fileVerified,false);}
  for (const name of deliveryFiles) {
    const f=fixture(); delete f.bundle.files[name];
    assert.equal(agentJourney(f).fileVerified,false,`missing ${name}`);
  }
});
test("healthy label alone does not prove monitored publication or all scheduled batches", () => {
  const changes=[f=>{f.release.packageDigest="old";},f=>{f.release.sourceRevisionId="old";},f=>{f.release.status="CANCELLED";},f=>{f.batches=[];},f=>{f.batches.pop();},f=>{f.batches[1].id=f.batches[0].id;},f=>{f.batches[1].schedulerTriggered=false;},f=>{f.alerts=[{status:"OPEN"}];},f=>{f.events=[];},f=>{f.events[1].packageDigest="old";}];
  for(const mutate of changes){const f=fixture();mutate(f);assert.notEqual(stage(f,"monitoring"),"DONE");}
  assert.notEqual(stage({...fixture(),publicationReadable:false},"monitoring"),"DONE");
  assert.equal(stage({...fixture(),publicationReadable:false},"validation"),"DONE","monitoring read failure does not discard code evidence");
});

function registeredPair() {
  const f=fixture();
  const id=n=>"00000000-0000-4000-8000-"+String(n).padStart(12,"0");
  Object.assign(f,{taskId:id(1),revisionId:id(2),runId:id(3)});
  Object.assign(f.report,{taskId:f.taskId,revisionId:f.revisionId,runId:f.runId});
  Object.assign(f.bundle,{id:id(4),digest:sha256("fictional cash-change package")});
  f.verification.id=id(5);
  Object.assign(f.delivery,{sourceRevisionId:f.revisionId,sourceRunId:f.runId,
    packageId:f.bundle.id,packageDigest:f.bundle.digest,verificationId:f.verification.id});
  const source={packageId:f.bundle.id,packageDigest:f.bundle.digest,sourceRunId:f.runId,
    sourceAgentTaskId:f.taskId,reviewDigest:sha256("fictional cash-change review")};
  Object.assign(f.release,source,{id:id(6),scope:"PRIVATE_CLOUD_TEST",sourceKind:"AGENT",
    sourceRevisionId:f.revisionId,verificationId:f.verification.id,status:"WAITING_SCHEDULER",health:"OBSERVING"});
  f.publicationReadable=true;
  f.monitoringVerified=false;
  f.batches=[1,2].map(sequence=>({
    ...source,id:id(sequence+6),sequence,releaseId:f.release.id,
    status:"SCHEDULED", schedulerTriggered:false,
  }));
  f.events=[];
  checkedAgentPublication({release:f.release,runs:f.batches,events:f.events,alerts:f.alerts},
    {taskId:f.taskId,scope:"PRIVATE_CLOUD_TEST",releaseId:f.release.id,selector:{
      sourceKind:"AGENT",sourceRunId:f.runId,packageDigest:f.bundle.digest,verificationId:f.verification.id}});
  return f;
}

test("registered batches guide the engineer to the original schedule as trigger evidence arrives", () => {
  const f=registeredPair();
  let journey=agentJourney(f);
  assert.equal(journey.publicationCurrent,true);
  assert.match(journey.next.detail,/0\s*\/\s*2/);
  assert.match(journey.next.detail,/调度|触发/);
  assert.doesNotMatch(journey.next.detail,/需审阅|重新发布/);
  assert.notEqual(stage(f,"monitoring"),"DONE");

  f.release.status="RUNNING_CLOUD_TEST";
  for(const status of ["RUNNING","SUCCEEDED"]){
    Object.assign(f.batches[0],{status,schedulerTriggered:true});
    journey=agentJourney(f);
    assert.match(journey.next.detail,/1\s*\/\s*2/,status);
    assert.doesNotMatch(journey.next.detail,/需审阅|重新发布/);
    assert.notEqual(stage(f,"monitoring"),"DONE");
    assert.notEqual(stage(f,"services"),"DONE");
  }
});

test("a closed publication window preserves the registered pair and two triggers still require monitoring evidence", () => {
  const f=registeredPair();
  f.publicationAvailable=false;
  const waiting=agentJourney(f);
  assert.equal(waiting.next.label,"查看原批次");
  assert.match(waiting.next.detail,/0\/2.*入口已关闭/);
  assert.equal(waiting.reviewedBatches.firstBatchId,f.batches[0].id);
  assert.equal(waiting.reviewedBatches.secondBatchId,f.batches[1].id);
  f.release.status="RUNNING_CLOUD_TEST";
  for(const b of f.batches)Object.assign(b,{status:"RUNNING",schedulerTriggered:true});
  assert.match(agentJourney(f).next.detail,/2\/2.*监控事件/);
  f.batches[1].stage="WORKER_RESULT_UNCONFIRMED";
  assert.match(agentJourney(f).next.detail,/2\/2.*核对原 Worker 结果/);
  assert.notEqual(stage(f,"monitoring"),"DONE");
  for(const batch of f.batches){batch.status="SUCCEEDED";delete batch.stage;}
  f.events=f.batches.map(batch=>({type:"BATCH_SUCCEEDED",releaseId:f.release.id,releaseRunId:batch.id,packageDigest:f.bundle.digest}));
  f.monitoringVerified=true;
  f.release.health="HEALTHY";
  assert.notEqual(stage(f,"monitoring"),"DONE","the registered release itself is still running");
  f.release.status="COMPLETED_CLOUD_TEST";
  assert.equal(stage(f,"monitoring"),"DONE");
});

test("the journey never guesses a trigger count from partial, mismatched or unread batch records", () => {
  for(const change of [
    f=>{f.batches.pop();},
    f=>{f.batches[1].id=f.batches[0].id;},
    f=>{f.batches[1].sequence=f.batches[0].sequence;},
    f=>{f.batches[0].releaseId="another-release";},
    f=>{f.batches[0].packageDigest="another-package";},
    f=>{delete f.batches[0].schedulerTriggered;},
    f=>{f.batches[0].schedulerTriggered=true;}, // Still SCHEDULED: fields do not agree.
    f=>{f.publicationReadable=false;},
    f=>{f.release.packageDigest="historical-package";},
    f=>{f.release.verificationId="old-verification";},
  ]){
    const f=registeredPair();change(f);
    const journey=agentJourney(f);
    assert.doesNotMatch(journey.next.detail,/[012]\s*\/\s*2/);
    assert.notEqual(stage(f,"monitoring"),"DONE");
    assert.notEqual(stage(f,"services"),"DONE");
  }
});

test("stopped or unresolved registered batches cannot prompt approval again or prove a successful run", () => {
  const stopped=registeredPair();
  stopped.release.status="CANCELLED";
  for(const batch of stopped.batches)batch.status="CANCELLED";
  assert.equal(stage(stopped,"publication"),"ATTENTION");
  assert.match(agentJourney(stopped).next.detail,/停止|取消/);
  assert.doesNotMatch(agentJourney(stopped).next.detail,/需审阅/);
  const unconfirmed=registeredPair();
  unconfirmed.release.status="RUNNING_CLOUD_TEST";
  Object.assign(unconfirmed.batches[0],{status:"RUNNING",schedulerTriggered:true,stage:"WORKER_RESULT_UNCONFIRMED"});
  for(const f of [stopped,unconfirmed]){
    assert.notEqual(stage(f,"publication"),"DONE");
    assert.notEqual(stage(f,"monitoring"),"DONE");
    assert.notEqual(stage(f,"services"),"DONE");
  }
});
test("actual local rollback, replacement and failure states cannot retain completed publication",()=>{
  for(const status of ["ROLLED_BACK_LOCAL","SUPERSEDED_LOCAL","FAILED_LOCAL"]){
    const f=fixture();f.release.status=status;
    assert.notEqual(stage(f,"publication"),"DONE");assert.notEqual(stage(f,"monitoring"),"DONE");
    assert.equal(deliveryStageText("AWAITING_ENGINEER_REVIEW",true,status),"交付文件已演练；发布已停止");
    assert.doesNotMatch(publicationEvidenceText(f.release,true,true),/核对通过/);
  }
});
test('consumption stages bind task, package, current version, receipt and complete composition',()=>{
  const consumption={protocol:'shuduo-private-task-consumption/v1',taskId:'synthetic-task',packageDigest:'digest-one',scope:'PRIVATE_CLOUD_TEST',status:'VERIFIED',truncated:false,services:[{serviceType:'XAPI',status:'VERIFIED',fullAssetComposition:true,versionId:'x-version',call:{verified:true,versionId:'x-version',rowCount:2}}]};
  assert.equal(stage({...fixture(),consumption},'services'),'DONE');
  assert.equal(agentJourney({...fixture(),consumption}).next.id,'evidence');
  const limited=structuredClone(consumption);
  Object.assign(limited.services[0].call,{coverage:'SINGLE_CUSTOMER',rowCount:1});
  assert.equal(stage({...fixture(),consumption:limited},'services'),'PENDING');
  assert.match(agentJourney({...fixture(),consumption:limited}).next.detail,/单客户授权调用已核验/);
  for(const patch of [{taskId:'foreign'},{packageDigest:'old'},{truncated:true},{status:'PENDING'},{services:[]},{scope:'LOCAL_TEST_ONLY'}])assert.notEqual(stage({...fixture(),consumption:{...consumption,...patch}},'services'),'DONE');
  assert.notEqual(stage({...fixture(),dirty:true,consumption},'services'),'DONE');
  assert.notEqual(stage({...fixture(),consumption:{...consumption,services:[{...consumption.services[0],call:{verified:true,versionId:'old',rowCount:2}}]}},'services'),'DONE');
});
test('local consumption can complete the same task journey but cannot claim a cloud release',()=>{
  const f=fixture();f.release.status='ACTIVE_LOCAL';
  const consumption={protocol:'shuduo-local-task-consumption/v1',taskId:f.taskId,packageDigest:f.bundle.digest,scope:'LOCAL_TEST_ONLY',status:'VERIFIED',truncated:false,services:[{serviceType:'XAPI',status:'VERIFIED',fullAssetComposition:true,versionId:'local-x',call:{verified:true,versionId:'local-x',rowCount:2}}]};
  assert.equal(stage({...f,consumption},'services'),'DONE');
  assert.notEqual(stage({...fixture(),consumption},'services'),'DONE');
  assert.notEqual(stage({...f,consumption:{...consumption,protocol:'shuduo-private-task-consumption/v1',scope:'PRIVATE_CLOUD_TEST'}},'services'),'DONE');
});
test('manual consumption requires the same exact release and keeps human attribution',()=>{
  const f=fixture();f.release.sourceKind='MANUAL';
  const consumption={protocol:'shuduo-private-task-consumption/v1',taskId:f.taskId,packageDigest:f.bundle.digest,releaseId:f.release.id,sourceKind:'MANUAL',agentIndependentE2E:false,
    scope:'PRIVATE_CLOUD_TEST',status:'VERIFIED',truncated:false,services:[{serviceType:'XAPI',status:'VERIFIED',fullAssetComposition:true,versionId:'manual-x',releaseId:f.release.id,sourceKind:'MANUAL',agentIndependentE2E:false,sourceRunIds:[f.batches[0].id],call:{verified:true,versionId:'manual-x',rowCount:2}}]};
  assert.equal(stage({...f,consumption},'services'),'DONE');
  for(const patch of [{releaseId:undefined},{releaseId:'another-release'},{sourceKind:'AGENT'},{agentIndependentE2E:true}])
    assert.notEqual(stage({...f,consumption:{...consumption,...patch}},'services'),'DONE');
  assert.equal(consumption.agentIndependentE2E,false);
  const entry=consumption.services[0];
  for(const patch of [{releaseId:undefined},{releaseId:'other-release'},{sourceKind:undefined},{sourceKind:'AGENT'},{agentIndependentE2E:undefined},{agentIndependentE2E:true},
    {sourceRunIds:undefined},{sourceRunIds:[]},{sourceRunIds:[f.runId]},{sourceRunIds:['foreign-run']},{sourceRunIds:[f.batches[0].id,f.batches[0].id]},{sourceRunIds:f.batches.map(batch=>batch.id)}]){
    assert.equal(manualConsumptionEntryMatches({...entry,...patch},f.release.id,f.batches,f.runId),false);
    assert.notEqual(stage({...f,consumption:{...consumption,services:[{...entry,...patch}]}},'services'),'DONE');
  }
  for(const patch of [{status:'FAILED'},{schedulerTriggered:false}])assert.equal(manualConsumptionEntryMatches(entry,f.release.id,[{...f.batches[0],...patch}],f.runId),false);
  assert.equal(manualConsumptionEntryMatches({...entry,sourceRunIds:[f.runId]},f.release.id,[{id:f.runId,status:'SUCCEEDED',schedulerTriggered:true}],f.runId),false,'a mislabeled development run never becomes a release batch');
});

test('distribution journey uses its schema-specific receipt, complete arrays and independent evidence without borrowing legacy full-asset success',async()=>{
 const {validationFamilyForContext}=await import('../../src/v2/context.mjs'),{distributionMetadataForContext}=await import('../../src/v2/output-contract-metadata.mjs');
 const f=fixture(),contextId='holdings-asset-class-t1',family=validationFamilyForContext(contextId),c=distributionMetadataForContext(contextId);f.contextId=contextId;f.report.contextId=contextId;f.report.validationContractId=family.id;f.verification.validation={passed:true,contractId:family.id,regressions:family.contextIds.map(contextId=>({contextId,passed:true}))};f.release.status='ACTIVE_LOCAL';
 const receipt={protocol:'shuduo-local-distribution-consumption/v1',outputContractId:c.id,scope:'LOCAL_TEST_ONLY',taskId:f.taskId,packageDigest:f.bundle.digest,releaseId:f.release.id,sourceKind:'AGENT',status:'VERIFIED',truncated:false,agentIndependentE2E:false,services:[{serviceType:'XAPI',status:'VERIFIED',distributionComposition:true,fullAssetComposition:false,versionId:'version-distribution',call:{verified:true,independentResultVerified:true,versionId:'version-distribution',rowCount:1}}]};f.consumption=receipt;
 assert.equal(stage(f,'services'),'DONE');assert.match(agentJourney(f).next.detail,/仍不代表自主E2E/);
 for(const change of [{outputContractId:'wrong'},{protocol:'shuduo-local-task-consumption/v1'},{agentIndependentE2E:true},{releaseId:'different'}])assert.notEqual(stage({...f,consumption:{...receipt,...change}},'services'),'DONE');
 for(const change of [{distributionComposition:false},{fullAssetComposition:true},{call:{...receipt.services[0].call,independentResultVerified:false}}])assert.notEqual(stage({...f,consumption:{...receipt,services:[{...receipt.services[0],...change}]}},'services'),'DONE');
 assert.equal(stage({...f,dirty:true},'services'),'STALE');
});

test('frozen holdings journey recognizes its registered contract and still requires output schema and exact regression family',()=>{
 const f=fixture();f.contextId='holdings-t1';f.report.contextId='holdings-t1';f.report.validationContractId=syncSqlContractId;
 f.report.checks.push({id:'outputSchema',passed:true});f.verification.validation.contractId=syncSqlContractId;
 assert.equal(stage(f,'validation'),'DONE');assert.equal(agentJourney(f).fileVerified,true);
 const failed=structuredClone(f);failed.delivery.status='FAILED';failed.verification.status='FAILED';
 assert.equal(stage(failed,'validation'),'DONE');assert.equal(stage(failed,'files'),'ATTENTION');assert.equal(agentJourney(failed).publicationCurrent,false);
 for(const change of [e=>{e.report.checks=e.report.checks.filter(c=>c.id!=='outputSchema');},e=>{e.report.checks.find(c=>c.id==='outputSchema').passed=false;},e=>{e.report.contextId=e.contextId='stock-cash-t1';}]){
  const altered=structuredClone(f);change(altered);assert.notEqual(stage(altered,'validation'),'DONE');assert.equal(agentJourney(altered).publicationCurrent,false);
 }
 const wrongFamily=structuredClone(f);wrongFamily.verification.validation.contractId='other-contract';assert.equal(agentJourney(wrongFamily).fileVerified,false);
});
