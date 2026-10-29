import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { developmentRecoveryScope, developmentRecoveryEnvironment, validateDevelopmentRecoveryPlan, runDevelopmentRecoveryOperation, recoveryDigest, recoveryUsageKeys } from '../../scripts/development-recovery-window.mjs';
import { functionDigest } from '../../scripts/refresh-v2-spark-readiness.mjs';

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
      return endpoint.endsWith('/session')?{status:200,body:{authenticated:false,readOnly:true,developmentOnly:open,developmentExpiresAt:current.environmentVariables.V2_PUBLIC_DEVELOPMENT_EXPIRES_AT}}
        :{status:200,body:{spark:{healthVerified:options.health!==false},agentDevelopment:{durableEnabled:true,eventBackgroundAvailable:true}}};
    }};
  return {io,report,calls,writes,snapshots,current:()=>current,setClock:v=>clock=v};
}
async function opened() {
  const p=fixture(),h=harness(p);await runDevelopmentRecoveryOperation(p,p.baseline,h.report,h.io);
  return {p,h,next:{...p,mode:'recycle',phase:'OPENED',activated:h.report.activated,priorUsage:h.report.cumulativeUsage,
    recoveryNonce:'f'.repeat(32),phaseBoundary:{taskId:uuid(1),revisionId:uuid(2),runId:uuid(3),bootId:uuid(4),contextId:'stock-cash-t1',status:'VERIFIED',modelPending:false,sparkPending:false,evidenceDigest:hash('f')}}};
}

test('original-task continuation preserves its original window, used attempts and remaining counters',async()=>{
 const p=fixture();p.issuedAt=time-3600000;p.deadline=time+3600000;p.maxNewTasks=0;p.maxModelCalls=2;p.maxWrites=3;p.maxReads=82;p.maxProbes=48;
 p.resumeExistingTask={protocol:'ORIGINAL_TASK_WINDOW_CONTINUATION_V1',taskId:uuid(9),originalStartsAt:new Date(p.issuedAt).toISOString(),
   originalDeadline:new Date(p.deadline).toISOString(),retainedAttempts:1,approvalDigest:p.binding.approvalDigest,priorCodeReads:20,priorCodeHttp:6};
 const h=harness(p);await runDevelopmentRecoveryOperation(p,p.baseline,h.report,h.io);
 assert.equal(h.report.activated.V2_PUBLIC_DEVELOPMENT_STARTS_AT,p.resumeExistingTask.originalStartsAt);
 const closing={...p,mode:'close',phase:'OPENED',activated:h.report.activated,activationCheckedAt:h.report.activationCheckedAt,priorUsage:h.report.cumulativeUsage};
 const c=harness(closing,{current:h.current()});await runDevelopmentRecoveryOperation(closing,h.current(),c.report,c.io);assert.equal(c.report.phase,'CLOSED_READONLY');
 for(const change of [q=>q.maxNewTasks=1,q=>q.maxModelCalls=3,q=>q.resumeExistingTask.retainedAttempts=0,q=>q.resumeExistingTask.originalDeadline=new Date(q.deadline+1).toISOString(),
   q=>q.resumeExistingTask.approvalDigest='f'.repeat(64),q=>q.maxReads=120]){const q=structuredClone(p);change(q);assert.throws(()=>validateDevelopmentRecoveryPlan(q,time));}
});
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
  assert.match(source,/plan.scope === developmentRecoveryScope \? 7200000 : 3600000/);
  assert.match(source,/runDevelopmentRecoveryOperation\(plan, before, report/);
});
