import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { developmentRecoveryScope, developmentRecoveryEnvironment, validateDevelopmentRecoveryPlan, runDevelopmentRecoveryOperation, recoveryDigest, recoveryUsageKeys } from '../../scripts/development-recovery-window.mjs';
import { firstCloudApplicationBinding, firstCloudCheckpointBinding, firstCloudDevelopmentScope, firstCloudWindowReceiptProtocol,
  nextCloudDevelopmentScope, nextCloudWindowReceiptProtocol } from '../../scripts/first-cloud-v3-window.mjs';
import { prepareCloudV3Start } from '../../scripts/start-cloud-v3-case.mjs';
import { functionDigest } from '../../scripts/refresh-v2-spark-readiness.mjs';
import { sha256 } from '../../src/v2/delivery.mjs';
import { currentLiveLifecycleContract, liveLifecyclePlan } from '../../src/v2/live-lifecycle-evaluation.mjs';
import { validationFamilyForContext } from '../../src/v2/context.mjs';
import { fixtureFirstCloudInspection } from './fixtures/first-cloud-application-inspection.mjs';

const time = Date.parse('2026-10-20T08:00:00Z'), stamp = new Date(time).toISOString();
const hash = c => c.repeat(64), uuid = n => `${String(n).padStart(8,'0')}-0000-4000-8000-000000000001`;
const zero = () => Object.fromEntries(recoveryUsageKeys.map(k => [k, 0]));
function fixture() {
  const baseline = { functionName:'dataplatform-v2-fixture-api', runtime:'custom.debian12', cpu:0.25, memorySize:512, timeout:90,
    instanceConcurrency:8, codeChecksum:'123456789', codeSize:100, role:'fictional-preserved-role', vpcConfig:{vpcId:'fictional-network'},
    environmentVariables:{ V2_MODEL:'fictional-coder', V2_MODEL_MONTHLY_BUDGET_CNY:'20', V2_MONTHLY_REMOTE_SPARK_RUN_LIMIT:'100',
      V2_LOCAL_DEVELOPMENT:'false', V2_PROVISIONING_ONLY:'true', V2_FC_PUBLIC_HTTP_ENABLED:'true', V2_FC_PUBLIC_READ_ONLY:'true',
      V2_PRIVATE_RELEASE_ENABLED:'false', V2_DURABLE_SQL_AGENT_ENABLED:'true', V2_AGENT_DRIVER_MODE:'OSS_EVENTS',
      V2_BOOTSTRAP_ADMIN_EMAIL:'admin@fictional.example', V2_SPARK_EXECUTOR_SECRET:'fixture-only-not-a-real-secret' } };
  const historyUsage = {...zero(),configReads:70,configWrites:6};
  return { scope:developmentRecoveryScope, mode:'activate', controlName:baseline.functionName, baseline, baselineDigest:functionDigest(baseline),
    application:{sha256:hash('a'),bytes:100,crc64:'123456789'},contextId:'stock-cash-t1', maxNewTasks:1,maxModelCalls:3,maxSparkRuns:4,
    maxIncrementCny:5,monthlyCny:200,maxReads:120,maxProbes:60,maxWrites:4,issuedAt:time,deadline:time+7200000,priorReserveCny:19,
    binding:{protocol:'DEVELOPMENT_RECOVERY_CONTINUATION_V1',approvalDigest:hash('b'),predecessorDigest:hash('c'),historyDigest:recoveryDigest(historyUsage),
      applicationSha256:hash('a'),workerDigest:hash('d'),priorReserveCny:19}, historyUsage,priorUsage:zero(),
    usage:{month:'2026-10',checkedAt:stamp,sparkRuns:8,modelCny:2.1},billCny:10,
    modelPricing:{model:'fictional-coder',available:true,checkedAt:stamp,maxBatchCny:1,evidenceDigest:hash('e')} };
}
function targetedFixture() {
  const p=fixture();
  p.resumeExistingTask={protocol:'TARGET_TASK_FRESH_WINDOW_V1',taskId:uuid(1),originalStartsAt:new Date(time-7200000).toISOString(),
    originalDeadline:new Date(time-3600000).toISOString(),retainedAttempts:1,approvalDigest:p.binding.approvalDigest,priorCodeReads:30,priorCodeHttp:2,
    codeStageIssuedAt:stamp,codeStageClosedAt:stamp};
  p.binding={...p.binding,protocol:'DEVELOPMENT_TASK_RESUME_CONTINUATION_V1',taskResumeDigest:recoveryDigest(p.resumeExistingTask)};
  p.maxNewTasks=0;p.maxModelCalls=2;p.maxReads=130;p.maxProbes=58;
  return p;
}
function exhaustedTargetFixture() {
  const p=targetedFixture();p.resumeExistingTask.retainedAttempts=3;
  p.binding.taskResumeDigest=recoveryDigest(p.resumeExistingTask);
  p.maxModelCalls=0;p.maxSparkRuns=1;p.priorReserveCny=62;p.binding.priorReserveCny=62;
  delete p.modelPricing;return p;
}
function firstFixture(t) {
  const dir = mkdtempSync(join(tmpdir(),'shuduo-first-window-'));
  t.after(() => rmSync(dir,{recursive:true,force:true}));
  const checkpoint = join(dir,'original.json'), applicationSource='a'.repeat(40);
  prepareCloudV3Start(checkpoint,{baseUrl:'https://first-case.example.invalid/api/v2',projectId:'fictional'},applicationSource);
  const firstCase = firstCloudCheckpointBinding(checkpoint);
  const applicationInspection=fixtureFirstCloudInspection(applicationSource,'b'.repeat(40));
  const p={...fixture(),scope:firstCloudDevelopmentScope,applicationSource,firstCase,contextId:firstCase.contextId,
    applicationInspection,priorReserveCny:64,maxIncrementCny:3,maxWrites:2};
  p.binding={...p.binding,protocol:'FIRST_CLOUD_WINDOW_CONTINUATION_V1',priorReserveCny:p.priorReserveCny,
    firstCaseDigest:recoveryDigest(firstCase),applicationInspectionDigest:firstCloudApplicationBinding(applicationInspection,firstCase).inspectionDigest,
    budgetPolicyDigest:recoveryDigest({reserveCny:p.priorReserveCny,
      maxIncrementCny:p.maxIncrementCny,monthlyCny:p.monthlyCny,windowDeadline:p.deadline,
      maxSparkRuns:p.maxSparkRuns,maxModelCalls:p.maxModelCalls})};
  return p;
}
function harness(plan, options={}) {
  let current = structuredClone(options.current ?? plan.baseline), clock=time;
  const calls=[], writes=[], snapshots=[];
  const report={configReads:1,identityReads:1,configWrites:0,activeHttp:0};
  const io={ now:()=>clock,wait:async()=>{},save:r=>{ if(options.failSave?.(r))throw Error('fixture-save'); snapshots.push(structuredClone(r)); },
    command:async(args,body)=>{
      calls.push(structuredClone({args,body}));
      if(args[0]==='bssopenapi') return {Success:true,Data:{PageNum:1,PageSize:300,TotalCount:1,BillingCycle:'2026-10',Items:{Item:[{Currency:'CNY',PretaxAmount:String(options.bill??10)}]}}};
      assert.deepEqual(args.slice(0,3),['fc',args[1],`/2023-03-30/functions/${plan.controlName}`]);
      if(args[1]==='GET')return structuredClone(options.read?.(current,calls)??current);
      assert.equal(args[1],'PUT'); assert.deepEqual(Object.keys(body),['environmentVariables']);writes.push(structuredClone(body));
      if(!options.unapplied)current={...current,environmentVariables:structuredClone(body.environmentVariables)};
      if(options.unknown)throw Error('fixture-transport');
      return {};
    },
    http:async endpoint=>{
      if(options.httpError)throw new TypeError('fixture-network');
      assert.ok(['/api/v2/auth/session','/api/v2/status'].includes(endpoint));
      const open=current.environmentVariables.V2_FC_PUBLIC_WRITE_SCOPE==='DEVELOPMENT_ONLY';
      return endpoint.endsWith('/session')?{status:200,body:{authenticated:false,readOnly:true,developmentOnly:open,
        developmentStartsAt:options.differentStart?new Date(time-1).toISOString():current.environmentVariables.V2_PUBLIC_DEVELOPMENT_STARTS_AT,
        developmentExpiresAt:current.environmentVariables.V2_PUBLIC_DEVELOPMENT_EXPIRES_AT,
        ...(open&&current.environmentVariables.V2_PUBLIC_DEVELOPMENT_TASK_ID?{developmentTaskOnly:options.targetFlag!==false,...(options.leakTargetId?{developmentTaskId:current.environmentVariables.V2_PUBLIC_DEVELOPMENT_TASK_ID}:{})}:{} ),
        ...(open&&current.environmentVariables.V2_PUBLIC_DEVELOPMENT_REQUEST_DIGEST&&!options.oldRuntime?{developmentRequestOnly:true}:{})}}
        :{status:200,body:{spark:{healthVerified:options.health!==false},agentDevelopment:{durableEnabled:true,
          requestBindingSupported:!options.oldRuntime,derivationBindingSupported:!options.oldDerivationRuntime,
          eventBackgroundAvailable:true}}};
    }};
  return {io,report,calls,writes,snapshots,current:()=>current,setClock:v=>clock=v};
}

test('the next case has its own approval and closes back to the same read-only baseline',async t=>{
  const first=firstFixture(t), {firstCase,...plan}=first;
  const second=liveLifecyclePlan(2,{contractId:currentLiveLifecycleContract.id}).selectedCases[1];
  const nextCase={...firstCase,protocol:'SHUDUO_V3_NEXT_CHECKPOINT_BINDING_V1',caseId:second.id,contextId:second.contextId,
    checkpointDigest:hash('7'),requestKeyHash:hash('8'),
    requestBodyHash:sha256(JSON.stringify({message:second.request,sql:second.seedSql,contextId:second.contextId})),
    previousCase:{checkpointDigest:firstCase.checkpointDigest,completionDigest:hash('9'),approvalDigest:plan.binding.approvalDigest,reserveCny:64}};
  const {firstCaseDigest,...binding}=plan.binding;
  Object.assign(plan,{scope:nextCloudDevelopmentScope,contextId:second.contextId,nextCase,
    binding:{...binding,protocol:'NEXT_CLOUD_WINDOW_CONTINUATION_V1',approvalDigest:hash('f'),nextCaseDigest:recoveryDigest(nextCase)}});
  assert.throws(()=>validateDevelopmentRecoveryPlan({...plan,binding:{...plan.binding,approvalDigest:nextCase.previousCase.approvalDigest}},time));
  assert.throws(()=>validateDevelopmentRecoveryPlan({...plan,priorReserveCny:63},time));
  assert.throws(()=>validateDevelopmentRecoveryPlan({...plan,firstCase},time));
  const legacyPlan=structuredClone(plan);
  const old=harness(legacyPlan,{oldRuntime:true});
  await assert.rejects(runDevelopmentRecoveryOperation(legacyPlan,legacyPlan.baseline,old.report,old.io));
  assert.deepEqual(old.current(),legacyPlan.baseline);
  assert.equal(old.writes.length,0);
  assert.equal(old.report.nextCaseReceipt,undefined);
  const h=harness(plan);
  await runDevelopmentRecoveryOperation(plan,plan.baseline,h.report,h.io);
  assert.equal(h.report.nextCaseReceipt.protocol,nextCloudWindowReceiptProtocol);
  assert.deepEqual(h.report.nextCaseReceipt.checkpoint,nextCase);
  assert.equal(h.report.firstCaseReceipt,undefined);
  assert.match(h.report.activated.V2_PUBLIC_DEVELOPMENT_REQUEST_DIGEST,/^[a-f0-9]{64}$/);
  assert.equal(h.writes.length,1);
  const close={...plan,mode:'close',phase:'OPENED',activated:h.report.activated,priorUsage:h.report.cumulativeUsage};
  const c=harness(close,{current:h.current()});
  await runDevelopmentRecoveryOperation(close,h.current(),c.report,c.io);
  assert.deepEqual(c.current(),plan.baseline);
  assert.equal(c.report.cumulativeUsage.configWrites,2);
});
test('a derivative window checks exact derivation support before any write',async t=>{
  const {firstCase,...plan}=firstFixture(t);
  const definition=liveLifecyclePlan(20,{contractId:currentLiveLifecycleContract.id}).selectedCases[10];
  const approvals=Array.from({length:10},(_,index)=>sha256("fixture approval "+index));
  const nextCase={...firstCase,protocol:'SHUDUO_V3_NEXT_CHECKPOINT_BINDING_V1',caseId:definition.id,contextId:definition.contextId,
    checkpointDigest:hash('7'),requestKeyHash:hash('8'),requestBodyHash:hash('9'),
    previousCase:{checkpointDigest:firstCase.checkpointDigest,completionDigest:hash('9'),approvalDigest:approvals.at(-1),
      approvalDigests:approvals,reserveCny:64},
    derivationSource:{protocol:'shuduo-cloud-v3-derivation-source/v1',sourceCaseId:definition.sourceCaseId,
      contextId:firstCase.contextId,validationContractId:validationFamilyForContext(firstCase.contextId).id,
      taskId:uuid(1),revisionId:uuid(2),runId:uuid(3),revisionHash:hash('c'),completionDigest:hash('e')}};
  const {firstCaseDigest,...binding}=plan.binding;
  Object.assign(plan,{scope:nextCloudDevelopmentScope,contextId:definition.contextId,nextCase,
    binding:{...binding,protocol:'NEXT_CLOUD_WINDOW_CONTINUATION_V1',approvalDigest:hash('f'),nextCaseDigest:recoveryDigest(nextCase)}});
  const old=harness(plan,{oldDerivationRuntime:true});
  await assert.rejects(runDevelopmentRecoveryOperation(plan,plan.baseline,old.report,old.io),/NEXT_CLOUD_REQUEST_BINDING_UNAVAILABLE/);
  assert.equal(old.writes.length,0);
  const ready=harness(plan);
  await runDevelopmentRecoveryOperation(plan,plan.baseline,ready.report,ready.io);
  assert.equal(ready.report.phase,'OPENED');
  assert.deepEqual(ready.report.nextCaseReceipt.checkpoint.derivationSource,nextCase.derivationSource);
});
async function opened() {
  const p=fixture(),h=harness(p);await runDevelopmentRecoveryOperation(p,p.baseline,h.report,h.io);
  return {p,h,next:{...p,mode:'recycle',phase:'OPENED',activated:h.report.activated,priorUsage:h.report.cumulativeUsage,
    recoveryNonce:'f'.repeat(32),phaseBoundary:{taskId:uuid(1),revisionId:uuid(2),runId:uuid(3),bootId:uuid(4),contextId:'stock-cash-t1',status:'VERIFIED',modelPending:false,sparkPending:false,evidenceDigest:hash('f')}}};
}

test('environment-only opening preserves code, identity and all unrelated fields; fresh complete bill',async()=>{
  const p=fixture(),h=harness(p);await runDevelopmentRecoveryOperation(p,p.baseline,h.report,h.io);
  assert.equal(h.report.phase,'OPENED');assert.equal(h.writes.length,1);assert.equal(h.report.modelCalls,0);assert.equal(h.report.sparkRuns,0);
  assert.equal(h.current().codeChecksum,p.baseline.codeChecksum);assert.deepEqual(h.current().vpcConfig,p.baseline.vpcConfig);
  assert.equal(h.report.activated.V2_MONTHLY_REMOTE_SPARK_RUN_LIMIT,'12');assert.equal(h.report.activated.V2_MODEL_MONTHLY_BUDGET_CNY,'3.1');
  assert.equal(h.report.activated.V2_PUBLIC_DEVELOPMENT_EXPIRES_AT,new Date(p.deadline).toISOString());
  assert.equal(h.report.cumulativeUsage.configWrites,1);assert.deepEqual(h.report.historyUsage,p.historyUsage);
});
test('one settled phase reload preserves exact original window, quota and code; close restores baseline',async()=>{
  const {p,h,next}=await opened(),r=harness(next,{current:h.current()});
  await runDevelopmentRecoveryOperation(next,h.current(),r.report,r.io);
  assert.equal(r.report.phase,'RELOAD_CONFIGURATION_VERIFIED');assert.equal(r.writes.length,1);
  assert.deepEqual(r.report.reloaded,{...h.report.activated,V2_RECOVERY_PILOT_NONCE:'f'.repeat(32)});
  const closing={...next,mode:'close',phase:r.report.phase,reloaded:r.report.reloaded,priorUsage:r.report.cumulativeUsage};
  const c=harness(closing,{current:r.current()});await runDevelopmentRecoveryOperation(closing,r.current(),c.report,c.io);
  assert.equal(c.report.phase,'CLOSED_READONLY');assert.deepEqual(c.current(),p.baseline);assert.equal(c.report.cumulativeUsage.configWrites,3);
});
test('new authority, full history, exact package, reserve and no extra operation are mandatory',()=>{
  const changes=[p=>p.scope='INVITED_DEVELOPMENT_PILOT_V1',p=>p.mode='stage',p=>p.contextId='wealth-assets-t1',p=>p.maxModelCalls=4,
    p=>p.maxSparkRuns=5,p=>p.maxWrites=5,p=>p.maxIncrementCny=6,p=>p.maxNewTasks=2,p=>p.binding.approvalDigest='',p=>p.priorReserveCny=0,
    p=>p.historyUsage.configReads=0,p=>p.binding.applicationSha256=hash('9'),p=>p.baseline.codeSize=101,p=>p.baseline.role='foreign',
    p=>p.deadline++,p=>p.priorUsage.configWrites=1,p=>p.candidate={},p=>p.triggerNames=[],p=>p.schedulerSecret='forbidden',p=>p.priorUsage.objectGets=1,
    p=>p.baseline.environmentVariables.V2_PRIVATE_RELEASE_ENABLED='true'];
  for(const change of changes){const p=fixture();change(p);assert.throws(()=>validateDevelopmentRecoveryPlan(p,time));}
});
test('unsettled model, wrong task context or repeated reload is rejected before IO',async()=>{
  const {next,h}=await opened();
  for(const change of [p=>p.phaseBoundary.modelPending=true,p=>p.phaseBoundary.sparkPending=true,p=>p.phaseBoundary.status='RUNNING',
    p=>p.phaseBoundary.contextId='old-context',p=>p.phaseBoundary.runId='',p=>p.priorUsage.configWrites=2,p=>p.reloaded={...p.activated}]){
    const p=structuredClone(next);change(p);const r=harness(p,{current:h.current()});await assert.rejects(runDevelopmentRecoveryOperation(p,h.current(),r.report,r.io));assert.equal(r.calls.length,0);
  }
});
test('pricing, fresh usage, actual bill and existing narrower quotas fail closed',async()=>{
  for(const change of [p=>p.modelPricing.available=false,p=>p.modelPricing.maxBatchCny=4.1,p=>p.modelPricing.model='other',p=>p.modelPricing.checkedAt='2025-01-01',
    p=>p.usage.checkedAt='2025-01-01',p=>p.usage.sparkRuns=-1,p=>p.baseline.environmentVariables.V2_MODEL_MONTHLY_BUDGET_CNY='2',
    p=>p.baseline.environmentVariables.V2_MONTHLY_REMOTE_SPARK_RUN_LIMIT='10']){
    const p=fixture();change(p);assert.throws(()=>developmentRecoveryEnvironment(p,time));
  }
  const p=fixture(),h=harness(p,{bill:190});await assert.rejects(runDevelopmentRecoveryOperation(p,p.baseline,h.report,h.io),/RECOVERY_BUDGET_INVALID/);assert.equal(h.writes.length,0);
});
test('unknown successful environment write is read back without repeating PUT',async()=>{
  const p=fixture(),h=harness(p,{unknown:true});await runDevelopmentRecoveryOperation(p,p.baseline,h.report,h.io);
  assert.equal(h.report.phase,'OPENED');assert.equal(h.report.updateResponseUnknown,true);assert.equal(h.writes.length,1);
});
test('unknown unapplied opening never replays or computes',async()=>{
  const p=fixture(),h=harness(p,{unknown:true,unapplied:true});await assert.rejects(runDevelopmentRecoveryOperation(p,p.baseline,h.report,h.io),/RECOVERY_UPDATE_UNCONFIRMED/);
  assert.equal(h.writes.length,1);assert.equal(h.report.restoration,'ALREADY_BASELINE');
});
test('runtime failure after opening restores readonly once, counting all attempts',async()=>{
  const p=fixture(),h=harness(p,{health:false});await assert.rejects(runDevelopmentRecoveryOperation(p,p.baseline,h.report,h.io),/RECOVERY_RUNTIME_UNCONFIRMED/);
  assert.equal(h.writes.length,2);assert.equal(h.report.restoration,'VERIFIED');assert.deepEqual(h.current(),p.baseline);
});
test('reload failure can use reserved restoration write, never another nonce',async()=>{
  const {next,h}=await opened(),r=harness(next,{current:h.current(),health:false});await assert.rejects(runDevelopmentRecoveryOperation(next,h.current(),r.report,r.io),/RECOVERY_RUNTIME_UNCONFIRMED/);
  assert.equal(r.writes.length,2);assert.equal(r.report.cumulativeUsage.configWrites,3);assert.equal(r.report.restoration,'VERIFIED');
});
test('foreign configuration is never overwritten, including failure restoration',async()=>{
  const p=fixture(),foreign={...p.baseline,role:'changed-by-another-operator'},h=harness(p,{current:foreign});
  await assert.rejects(runDevelopmentRecoveryOperation(p,foreign,h.report,h.io),/RECOVERY_FOREIGN_CONFIGURATION/);assert.equal(h.writes.length,0);
});
test('checkpoint storage failure before mutation prevents cloud write',async()=>{
  const p=fixture(),h=harness(p,{failSave:r=>r.phase==='ACTIVATION_REQUESTED'});
  await assert.rejects(runDevelopmentRecoveryOperation(p,p.baseline,h.report,h.io));assert.equal(h.writes.length,0);
});
test('expired window cannot be reopened but exact readonly restoration remains possible',async()=>{
  const p=fixture();assert.throws(()=>validateDevelopmentRecoveryPlan(p,p.deadline));
  const {h,next}=await opened(),closing={...next,mode:'close'};const c=harness(closing,{current:h.current()});c.setClock(closing.deadline+1000);
  await runDevelopmentRecoveryOperation(closing,h.current(),c.report,c.io);assert.equal(c.report.phase,'CLOSED_READONLY');
});
test('uncertain close is only reconciled, never reissued while still open',async()=>{
  const {h,next}=await opened(),p={...next,mode:'close',phase:'RESTORE_UNCONFIRMED',priorUsage:{...next.priorUsage,configWrites:2}},c=harness(p,{current:h.current()});
  await assert.rejects(runDevelopmentRecoveryOperation(p,h.current(),c.report,c.io),/RECOVERY_RESTORE_ALREADY_ATTEMPTED/);assert.equal(c.writes.length,0);
  const r=harness(p);await runDevelopmentRecoveryOperation(p,p.baseline,r.report,r.io);assert.equal(r.report.phase,'CLOSED_READONLY');assert.equal(r.writes.length,0);
});
test('workflow supports only environment lifecycle without artifact fetch; existing scopes keep one-hour checks',()=>{
  const source=readFileSync(new URL('../../scripts/deploy-development-pilot.mjs',import.meta.url),'utf8');
  const workflow=readFileSync(new URL('../../.github/workflows/deploy-v2-development-pilot.yml',import.meta.url),'utf8');
  assert.match(workflow,/activate, recycle, timers/);assert.match(workflow,/inputs.mode == 'deploy' \|\| inputs.mode == 'stage'/);
  assert.match(source,/const boundCase = cloudV3DevelopmentScope\(plan.scope\)/);
  assert.match(source,/const environmentOnly=boundCase \|\| plan.scope===developmentRecoveryScope/);
  assert.match(source,/environmentOnly \? 7200000 : 3600000/);
  assert.match(source,/runDevelopmentRecoveryOperation\(plan, before, report/);
});

test('first v3 activation binds the original request and complete bill, then restores the exact baseline once',async t=>{
  const p=firstFixture(t),h=harness(p,{bill:13});
  await runDevelopmentRecoveryOperation(p,p.baseline,h.report,h.io);
  assert.equal(h.report.phase,'OPENED');
  assert.equal(h.writes.length,1);
  const receipt=h.report.firstCaseReceipt;
  assert.equal(receipt.protocol,firstCloudWindowReceiptProtocol);
  assert.deepEqual(receipt.checkpoint,p.firstCase);
  assert.deepEqual(receipt.application,{...firstCloudApplicationBinding(p.applicationInspection,p.firstCase),crc64:p.application.crc64});
  assert.equal(receipt.approvalDigest,p.binding.approvalDigest);
  assert.equal(receipt.startsAt,stamp);
  assert.equal(receipt.expiresAt,new Date(p.deadline).toISOString());
  assert.deepEqual(receipt.bill,{month:'2026-10',checkedAt:stamp,spendCny:13,recordCount:1,
    pagesDigest:recoveryDigest([{
      Success:true,Data:{PageNum:1,PageSize:300,TotalCount:1,BillingCycle:'2026-10',Items:{Item:[{Currency:'CNY',PretaxAmount:'13'}]}}
    }]),unsettledReserveCny:64,maxIncrementCny:3});
  assert.ok(!JSON.stringify(receipt).includes(p.baseline.environmentVariables.V2_SPARK_EXECUTOR_SECRET));
  assert.deepEqual(h.report.historyUsage,p.historyUsage);
  const close={...p,mode:'close',phase:'ACTIVATION_REQUESTED',activated:h.report.activated,priorUsage:h.report.cumulativeUsage};
  const c=harness(close,{current:h.current()});
  c.setClock(p.deadline+1);
  await runDevelopmentRecoveryOperation(close,h.current(),c.report,c.io);
  assert.equal(c.report.phase,'CLOSED_READONLY');
  assert.equal(c.writes.length,1);
  assert.equal(c.report.cumulativeUsage.configWrites,2);
  assert.deepEqual(c.current(),p.baseline);
  assert.equal(c.report.firstCaseReceipt,undefined);
  const already={...close,phase:'RESTORE_REQUESTED',priorUsage:c.report.cumulativeUsage};
  const r=harness(already);
  await runDevelopmentRecoveryOperation(already,p.baseline,r.report,r.io);
  assert.equal(r.report.phase,'CLOSED_READONLY');
  assert.equal(r.writes.length,0);
  const legacy=structuredClone(close);
  delete legacy.applicationInspection;
  delete legacy.binding.applicationInspectionDigest;
  const legacyClose=harness(legacy,{current:h.current()});
  legacyClose.setClock(p.deadline+1);
  await runDevelopmentRecoveryOperation(legacy,h.current(),legacyClose.report,legacyClose.io);
  assert.equal(legacyClose.report.phase,'CLOSED_READONLY');
  assert.equal(legacyClose.writes.length,1);
});

test('first v3 rejects altered request, reserve, source or window and restores if the runtime start differs',async t=>{
  const p=firstFixture(t);
  for(const alter of [
    v=>v.firstCase.checkpointDigest=hash('f'),v=>v.firstCase.requestKeyHash=hash('f'),v=>v.firstCase.requestBodyHash=hash('f'),
    v=>v.firstCase.origin='http://example.invalid',v=>v.applicationSource='b'.repeat(40),v=>v.contextId='other-context',
    v=>delete v.applicationInspection,v=>v.applicationInspection.sha256=hash('f'),v=>v.applicationInspection.bytes++,
    v=>v.applicationInspection.applicationSource='c'.repeat(40),v=>v.applicationInspection.webIndexSha256=hash('f'),
    v=>v.applicationInspection.buildWorkflowSource='f'.repeat(40),
    v=>v.binding.applicationInspectionDigest=hash('f'),v=>v.application.crc64='0123456789',
    v=>{v.priorReserveCny=0;v.binding.priorReserveCny=0;},v=>v.maxIncrementCny=4,v=>v.deadline--,
    v=>v.mode='recycle',v=>v.maxProbes=7,v=>v.recoveryNonce='f'.repeat(32),v=>v.priorUsage.configWrites=1,
  ]){
    const changed=structuredClone(p);alter(changed);
    const h=harness(changed);
    await assert.rejects(runDevelopmentRecoveryOperation(changed,p.baseline,h.report,h.io));
    assert.equal(h.calls.length,0);
  }
  const over=harness(p,{bill:133});
  await assert.rejects(runDevelopmentRecoveryOperation(p,p.baseline,over.report,over.io),/RECOVERY_BUDGET_INVALID/);
  assert.equal(over.writes.length,0);
  const drift=harness(p,{differentStart:true});
  await assert.rejects(runDevelopmentRecoveryOperation(p,p.baseline,drift.report,drift.io),/RECOVERY_RUNTIME_UNCONFIRMED/);
  assert.equal(drift.report.restoration,'VERIFIED');
  assert.equal(drift.report.firstCaseReceipt,undefined);
  assert.equal(drift.writes.length,2);
  assert.deepEqual(drift.current(),p.baseline);
  let interruptedSave=false;
  const interrupted=harness(p,{failSave:r=>{
    if(r.phase!=='OPENED'||interruptedSave)return false;
    interruptedSave=true;
    return true;
  }});
  await assert.rejects(runDevelopmentRecoveryOperation(p,p.baseline,interrupted.report,interrupted.io),/fixture-save/);
  assert.equal(interrupted.report.restoration,'VERIFIED');
  assert.equal(interrupted.report.firstCaseReceipt,undefined);
  assert.deepEqual(interrupted.current(),p.baseline);
});

test('targeted fresh window binds one old task, preserves both histories and subtracts prior code-stage reads',async()=>{
  const p=targetedFixture(),h=harness(p);await runDevelopmentRecoveryOperation(p,p.baseline,h.report,h.io);
  assert.equal(h.report.phase,'OPENED');assert.equal(h.writes.length,1);
  const active=h.report.activated;
  assert.equal(active.V2_PUBLIC_DEVELOPMENT_TASK_ID,p.resumeExistingTask.taskId);
  assert.equal(active.V2_PUBLIC_DEVELOPMENT_STARTS_AT,stamp,'newly reviewed window, never copied from the old task window');
  assert.equal(active.V2_PUBLIC_DEVELOPMENT_EXPIRES_AT,new Date(p.deadline).toISOString());
  assert.equal(h.current().codeChecksum,p.baseline.codeChecksum);assert.deepEqual(h.current().vpcConfig,p.baseline.vpcConfig);
  assert.deepEqual(h.report.resumeExistingTask,p.resumeExistingTask);assert.deepEqual(h.report.historyUsage,p.historyUsage);
  assert.ok(h.report.cumulativeUsage.configReads+p.resumeExistingTask.priorCodeReads<=160);
  assert.ok(h.report.cumulativeUsage.activeHttp+p.resumeExistingTask.priorCodeHttp<=60);
  assert.equal(h.report.modelCalls,0);assert.equal(h.report.sparkRuns,0);
});
test('targeted continuation rejects stale-window extensions, new-task authority, mismatched approval, reset limits and target tampering',()=>{
  const changes=[p=>p.resumeExistingTask.protocol='ORIGINAL_TASK_WINDOW_CONTINUATION_V1',p=>p.resumeExistingTask.originalDeadline=new Date(time+1).toISOString(),
    p=>p.resumeExistingTask.originalStartsAt=p.resumeExistingTask.originalDeadline,p=>p.resumeExistingTask.retainedAttempts=0,
    p=>p.resumeExistingTask.approvalDigest=hash('9'),p=>p.resumeExistingTask.taskId=uuid(9),p=>p.binding.taskResumeDigest=hash('9'),
    p=>p.binding.protocol='DEVELOPMENT_RECOVERY_CONTINUATION_V1',p=>p.resumeExistingTask.extra=true,p=>p.maxNewTasks=1,p=>p.maxModelCalls=3,
    p=>p.maxReads=160,p=>p.maxProbes=60,p=>p.resumeExistingTask.priorCodeReads=0,p=>p.resumeExistingTask.priorCodeHttp=0,
    p=>p.resumeExistingTask.priorCodeReads=-1,p=>p.resumeExistingTask.priorCodeHttp='2',p=>p.baseline.environmentVariables.V2_PUBLIC_DEVELOPMENT_TASK_ID=uuid(9),
    p=>p.issuedAt-=1000,p=>p.resumeExistingTask.codeStageIssuedAt=new Date(time-1000).toISOString(),p=>p.resumeExistingTask.codeStageClosedAt=new Date(time+1).toISOString()];
  for(const change of changes){const p=targetedFixture();change(p);assert.throws(()=>validateDevelopmentRecoveryPlan(p,time));}
});
test('targeted reload requires a settled boundary from the exact allowed task; closing restores original read-only state',async()=>{
  const p=targetedFixture(),h=harness(p);await runDevelopmentRecoveryOperation(p,p.baseline,h.report,h.io);
  const reload={...p,mode:'recycle',phase:'OPENED',activated:h.report.activated,priorUsage:h.report.cumulativeUsage,recoveryNonce:'f'.repeat(32),
    phaseBoundary:{taskId:p.resumeExistingTask.taskId,revisionId:uuid(2),runId:uuid(3),bootId:uuid(4),contextId:p.contextId,status:'VERIFIED',modelPending:false,sparkPending:false,evidenceDigest:hash('f')}};
  for(const change of [p=>p.phaseBoundary.taskId=uuid(9),p=>p.phaseBoundary.modelPending=true,p=>p.phaseBoundary.sparkPending=true]){
    const invalid=structuredClone(reload);change(invalid);const r=harness(invalid,{current:h.current()});
    await assert.rejects(runDevelopmentRecoveryOperation(invalid,h.current(),r.report,r.io));assert.equal(r.calls.length,0);
  }
  const r=harness(reload,{current:h.current()});await runDevelopmentRecoveryOperation(reload,h.current(),r.report,r.io);
  assert.equal(r.report.reloaded.V2_PUBLIC_DEVELOPMENT_TASK_ID,p.resumeExistingTask.taskId);
  assert.equal(r.report.reloaded.V2_PUBLIC_DEVELOPMENT_STARTS_AT,stamp);assert.equal(r.report.cumulativeUsage.configWrites,2);
  const closing={...reload,mode:'close',phase:r.report.phase,reloaded:r.report.reloaded,priorUsage:r.report.cumulativeUsage},c=harness(closing,{current:r.current()});
  c.setClock(p.deadline+1000);await runDevelopmentRecoveryOperation(closing,r.current(),c.report,c.io);
  assert.deepEqual(c.current(),p.baseline);assert.equal(c.report.phase,'CLOSED_READONLY');assert.equal(c.writes.length,1);
});
test('targeted runtime probe refuses an old application or anonymous task-ID disclosure and restores once',async()=>{
  for(const options of [{targetFlag:false},{leakTargetId:true}]){
    const p=targetedFixture(),h=harness(p,options);
    await assert.rejects(runDevelopmentRecoveryOperation(p,p.baseline,h.report,h.io),/RECOVERY_RUNTIME_UNCONFIRMED/);
    assert.equal(h.writes.length,2);assert.equal(h.report.restoration,'VERIFIED');assert.deepEqual(h.current(),p.baseline);
  }
});
test('targeted retained attempts determine exact remaining model calls while Spark scope can only narrow',()=>{
  for(const retainedAttempts of [1,2,3])for(const maxSparkRuns of [1,2,3,4]){
    const p=targetedFixture();p.resumeExistingTask.retainedAttempts=retainedAttempts;p.binding.taskResumeDigest=recoveryDigest(p.resumeExistingTask);
    p.maxModelCalls=3-retainedAttempts;p.maxSparkRuns=maxSparkRuns;
    assert.equal(validateDevelopmentRecoveryPlan(p,time),true);
    assert.equal(developmentRecoveryEnvironment(p,time).V2_MONTHLY_REMOTE_SPARK_RUN_LIMIT,String(p.usage.sparkRuns+maxSparkRuns));
  }
  for(const mutate of [p=>p.resumeExistingTask.retainedAttempts=0,p=>p.resumeExistingTask.retainedAttempts=4,p=>p.resumeExistingTask.retainedAttempts=1.5,
    p=>p.resumeExistingTask.retainedAttempts='3',p=>p.maxModelCalls=1,p=>p.maxModelCalls=-1,p=>p.maxModelCalls='0',
    p=>p.maxSparkRuns=0,p=>p.maxSparkRuns=5,p=>p.maxSparkRuns=1.5,p=>p.maxSparkRuns='1',p=>p.maxNewTasks=1]){
    const p=exhaustedTargetFixture();mutate(p);p.binding.taskResumeDigest=recoveryDigest(p.resumeExistingTask);
    assert.throws(()=>validateDevelopmentRecoveryPlan(p,time));
  }
  for(const patch of [{maxSparkRuns:1},{maxModelCalls:0}])assert.throws(()=>validateDevelopmentRecoveryPlan({...fixture(),...patch},time),/RECOVERY_SCOPE_INVALID/);
});
test('zero-model single-Spark opening preserves exact model budget without pricing or provider requests',async()=>{
  const p=exhaustedTargetFixture();p.baseline.environmentVariables.V2_MODEL_MONTHLY_BUDGET_CNY='020.00';p.baselineDigest=functionDigest(p.baseline);
  const h=harness(p);await runDevelopmentRecoveryOperation(p,p.baseline,h.report,h.io);
  assert.equal(h.report.phase,'OPENED');assert.equal(h.writes.length,1);
  assert.equal(h.report.activated.V2_MODEL_MONTHLY_BUDGET_CNY,'020.00');assert.equal(h.report.activated.V2_MONTHLY_REMOTE_SPARK_RUN_LIMIT,'9');
  assert.equal(h.report.activated.V2_PUBLIC_DEVELOPMENT_TASK_ID,p.resumeExistingTask.taskId);
  assert.equal(h.report.issuedAt,p.issuedAt);assert.equal(h.report.deadline,p.deadline);
  assert.equal(h.report.binding.priorReserveCny,62);assert.deepEqual(h.report.historyUsage,p.historyUsage);
  assert.ok(h.calls.every(c=>['fc','bssopenapi'].includes(c.args[0])));assert.equal(h.report.modelCalls,0);assert.equal(h.report.sparkRuns,0);
});
test('zero-model scope still requires fresh usage, a complete affordable bill, original quotas and actual closed code stage',async()=>{
  for(const mutate of [p=>p.usage.checkedAt='2025-01-01',p=>p.usage.sparkRuns=-1,p=>p.usage.modelCny=NaN,
    p=>p.baseline.environmentVariables.V2_MONTHLY_REMOTE_SPARK_RUN_LIMIT='8',p=>p.baseline.environmentVariables.V2_MODEL_MONTHLY_BUDGET_CNY='',
    p=>p.billCny=133]){
    const p=exhaustedTargetFixture();mutate(p);assert.throws(()=>developmentRecoveryEnvironment(p,time));
  }
  for(const mutate of [p=>delete p.resumeExistingTask.codeStageClosedAt,p=>p.resumeExistingTask.codeStageClosedAt=new Date(time+1).toISOString(),
    p=>p.resumeExistingTask.codeStageIssuedAt=new Date(time-1).toISOString(),p=>p.binding.taskResumeDigest=hash('9'),p=>p.priorReserveCny=57]){
    const p=exhaustedTargetFixture();mutate(p);assert.throws(()=>validateDevelopmentRecoveryPlan(p,time));
  }
  const p=exhaustedTargetFixture(),h=harness(p,{bill:133});
  await assert.rejects(runDevelopmentRecoveryOperation(p,p.baseline,h.report,h.io),/RECOVERY_BUDGET_INVALID/);assert.equal(h.writes.length,0);
  const liveModel=targetedFixture();delete liveModel.modelPricing;
  assert.throws(()=>developmentRecoveryEnvironment(liveModel,time),/RECOVERY_MODEL_PRICE_REQUIRED/);
});
test('zero-model manual rehearsal retains the same limits through one settled reload and exact late closure',async()=>{
  const p=exhaustedTargetFixture(),h=harness(p);await runDevelopmentRecoveryOperation(p,p.baseline,h.report,h.io);
  const reload={...p,mode:'recycle',phase:'OPENED',activated:h.report.activated,priorUsage:h.report.cumulativeUsage,recoveryNonce:'f'.repeat(32),
    phaseBoundary:{taskId:p.resumeExistingTask.taskId,revisionId:uuid(2),runId:uuid(3),bootId:uuid(4),contextId:p.contextId,status:'VERIFIED',modelPending:false,sparkPending:false,evidenceDigest:hash('f')}};
  const r=harness(reload,{current:h.current()});await runDevelopmentRecoveryOperation(reload,h.current(),r.report,r.io);
  assert.equal(r.report.reloaded.V2_MONTHLY_REMOTE_SPARK_RUN_LIMIT,'9');assert.equal(r.report.reloaded.V2_MODEL_MONTHLY_BUDGET_CNY,p.baseline.environmentVariables.V2_MODEL_MONTHLY_BUDGET_CNY);
  assert.equal(r.report.reloaded.V2_PUBLIC_DEVELOPMENT_EXPIRES_AT,new Date(p.deadline).toISOString());
  const closing={...reload,mode:'close',phase:r.report.phase,reloaded:r.report.reloaded,priorUsage:r.report.cumulativeUsage},c=harness(closing,{current:r.current()});
  c.setClock(p.deadline+1000);await runDevelopmentRecoveryOperation(closing,r.current(),c.report,c.io);
  assert.equal(c.report.phase,'CLOSED_READONLY');assert.deepEqual(c.current(),p.baseline);assert.equal(c.report.cumulativeUsage.configWrites,3);
});
test('targeted unknown environment write is reconciled once, and a depleted phase budget cannot borrow cleanup reads',async()=>{
  const p=targetedFixture(),h=harness(p,{unknown:true});await runDevelopmentRecoveryOperation(p,p.baseline,h.report,h.io);
  assert.equal(h.writes.length,1);assert.equal(h.report.updateResponseUnknown,true);assert.equal(h.report.phase,'OPENED');
  const depleted=targetedFixture();depleted.priorUsage.configReads=depleted.maxReads-20;
  const d=harness(depleted);await assert.rejects(runDevelopmentRecoveryOperation(depleted,depleted.baseline,d.report,d.io),/RECOVERY_USAGE_LIMIT/);
  assert.equal(d.writes.length,0);assert.equal(d.calls.length,0);
});
