import test from "node:test";
import assert from "node:assert/strict";
import { agentJourney, deliveryStageText } from "../../web/src/agent-journey.ts";
import { contextIds } from "../../src/v2/context.mjs";

const fixture = () => ({
  taskId: "synthetic-task", revisionId: "revision-one", runId: "run-one", dirty: false,
  report: { taskId: "synthetic-task", revisionId: "revision-one", runId: "run-one", status: "PASSED", checks: ["revision", "execution", "results", "regressions"].map(id => ({id, passed:true})) },
  delivery: { status: "SUCCEEDED", packageId: "package-one", packageDigest: "digest-one", verificationId: "verification-one", sourceRevisionId:"revision-one",sourceRunId:"run-one" },
  bundle: { id: "package-one", digest: "digest-one", files: Object.fromEntries(["main.sql", "tests.sql", "schedule.json", "deployment.json"].map(name => [name, "synthetic fixture"])) },
  verification: { id: "verification-one", status: "SUCCEEDED", mainSqlExecuted: true, testSqlValidation: {passed:true}, validation: {passed:true, regressions:contextIds.map(contextId=>({contextId,passed:true}))} },
  release: { id: "release-one", packageId: "package-one", packageDigest: "digest-one", sourceRevisionId: "revision-one", status: "COMPLETED_CLOUD_TEST", health: "HEALTHY", runCount: 2 },
  batches: [1,2].map(i => ({id:`batch-${i}`, status:"SUCCEEDED", schedulerTriggered:true})), alerts: [],
  events: [1,2].map(i=>({type:"BATCH_SUCCEEDED",releaseId:"release-one",releaseRunId:`batch-${i}`,packageDigest:"digest-one"})),
});
const stage = (e,id) => agentJourney(e).steps.find(step=>step.id===id).state;

test("delivery summary follows only the current reviewed package and preserves stopped releases", () => {
  const f=fixture();
  assert.equal(deliveryStageText("AWAITING_ENGINEER_REVIEW",agentJourney(f).publicationCurrent,f.release.status),"交付文件已演练并完成发布审阅");
  for(const change of [{dirty:true},{revisionId:"new-code"},{bundle:{...f.bundle,digest:"new-package"}}]) {
    assert.equal(deliveryStageText("AWAITING_ENGINEER_REVIEW",agentJourney({...f,...change}).publicationCurrent,f.release.status),"演练通过，待审阅交付");
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
});
test("healthy label alone does not prove monitored publication or all scheduled batches", () => {
  const changes=[f=>{f.release.packageDigest="old";},f=>{f.release.sourceRevisionId="old";},f=>{f.release.status="CANCELLED";},f=>{f.batches=[];},f=>{f.batches.pop();},f=>{f.batches[1].id=f.batches[0].id;},f=>{f.batches[1].schedulerTriggered=false;},f=>{f.alerts=[{status:"OPEN"}];},f=>{f.events=[];},f=>{f.events[1].packageDigest="old";}];
  for(const mutate of changes){const f=fixture();mutate(f);assert.notEqual(stage(f,"monitoring"),"DONE");}
});
test('consumption stages bind task, package, current version, receipt and complete composition',()=>{
  const consumption={protocol:'shuduo-private-task-consumption/v1',taskId:'synthetic-task',packageDigest:'digest-one',scope:'PRIVATE_CLOUD_TEST',status:'VERIFIED',truncated:false,services:[{serviceType:'XAPI',status:'VERIFIED',fullAssetComposition:true,versionId:'x-version',call:{verified:true,versionId:'x-version',rowCount:2}}]};
  assert.equal(stage({...fixture(),consumption},'services'),'DONE');
  assert.equal(agentJourney({...fixture(),consumption}).next.id,'evidence');
  for(const patch of [{taskId:'foreign'},{packageDigest:'old'},{truncated:true},{status:'PENDING'},{services:[]},{scope:'LOCAL_TEST_ONLY'}])assert.notEqual(stage({...fixture(),consumption:{...consumption,...patch}},'services'),'DONE');
  assert.notEqual(stage({...fixture(),dirty:true,consumption},'services'),'DONE');
  assert.notEqual(stage({...fixture(),consumption:{...consumption,services:[{...consumption.services[0],call:{verified:true,versionId:'old',rowCount:2}}]}},'services'),'DONE');
});
