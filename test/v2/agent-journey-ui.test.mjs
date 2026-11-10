import test from "node:test";
import assert from "node:assert/strict";
import { agentJourney, deliveryStageText, publicationEvidenceText, verificationPresentation,manualConsumptionEntryMatches } from "../../web/src/agent-journey.ts";
import { contextIds } from "../../src/v2/context.mjs";
import { deliveryFiles } from "../../src/v2/delivery.mjs";

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
