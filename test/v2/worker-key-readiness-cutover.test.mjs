import test from 'node:test';
import assert from 'node:assert/strict';
import {buildWorkerKeyReadyCutover,workerKeyReadinessCutoverScope} from '../../scripts/worker-key-readiness-cutover.mjs';
import {functionDigest} from '../../scripts/refresh-v2-spark-readiness.mjs';
import {createQueuedSparkJob,createQueuedSparkResult,queueConfigFromEnvironment,RemoteSparkQueueClient} from '../../src/v2/remote-spark-queue.mjs';
import {privateSparkSmokePayload} from '../../src/v2/spark-worker-private-smoke.mjs';
import {reconcileDurableDevelopment} from '../../src/v2/durable-development.mjs';
import {MetadataStore} from '../../src/v2/store.mjs';
import {getContext,referenceSqlForContext,validationFamilyForContext} from '../../src/v2/context.mjs';
import {sha256} from '../../src/v2/delivery.mjs';

// Signed protocol fixtures only. No actual Worker, cloud request or credential.
const now=Date.parse('2026-11-02T03:00:00Z'),id=n=>`${String(n).padStart(8,'0')}-0000-4000-8000-000000000001`;
function fixture(){
  const oldSecret='SYNTHETIC-OLD-WORKER-KEY-000000000000',newSecret='SYNTHETIC-NEW-WORKER-KEY-111111111111';
  const controlBefore={functionName:'dataplatform-v2-synthetic-api',runtime:'custom.debian12',cpu:0.25,memorySize:512,instanceConcurrency:8,timeout:120,
    codeChecksum:'123',codeSize:100,role:'SYNTHETIC_CONTROL_ROLE',vpcConfig:{vpcId:'SYNTHETIC_NETWORK'},state:'Active',lastUpdateStatus:'Successful',
    environmentVariables:{V2_LOCAL_DEVELOPMENT:'false',V2_PROVISIONING_ONLY:'true',V2_FC_PUBLIC_HTTP_ENABLED:'true',V2_FC_PUBLIC_READ_ONLY:'true',
      V2_SPARK_EXECUTOR_TRANSPORT:'OSS_QUEUE',V2_SPARK_EXECUTOR_SECRET:oldSecret,V2_SPARK_QUEUE_READY_JOB_ID:id(1),OTHER_SECRET:'SYNTHETIC_UNRELATED_CONFIG'}};
  const workerBefore={functionName:'dataplatform-v2-synthetic-worker',runtime:'custom.debian10',cpu:1,memorySize:2048,diskSize:10240,timeout:180,
    instanceConcurrency:1,internetAccess:false,codeChecksum:'456',codeSize:200,role:'SYNTHETIC_WORKER_ROLE',vpcConfig:{vpcId:'SYNTHETIC_NETWORK'},state:'Active',lastUpdateStatus:'Successful',
    environmentVariables:{V2_SPARK_WORKER_SECRET:oldSecret,V2_SPARK_QUEUE_CONSUMER_ENABLED:'true',V2_SPARK_WORKER_RUN_TIMEOUT_MS:'120000',OTHER_SECRET:'SYNTHETIC_WORKER_CONFIG'}};
  const workerAfter={...structuredClone(workerBefore),environmentVariables:{...workerBefore.environmentVariables,V2_SPARK_WORKER_SECRET:newSecret},lastModifiedTime:'SYNTHETIC_VOLATILE_TIME'};
  const config=queueConfigFromEnvironment({...controlBefore.environmentVariables,V2_SPARK_EXECUTOR_SECRET:newSecret}),
    queued=createQueuedSparkJob(privateSparkSmokePayload({}),config,{now:now-60000,requestId:id(2)}),
    result={status:'SUCCEEDED',engine:'Apache Spark',engineVersion:'3.5.9',mainSqlExecuted:true,validation:{passed:true},rows:privateSparkSmokePayload({}).context.expected},
    envelope=createQueuedSparkResult(queued.job,result,config,now-10000),
    proof={scope:workerKeyReadinessCutoverScope,issuedAt:now,expiresAt:now+600000,boundaryDigest:functionDigest(controlBefore),oldReadyJobId:id(1),
      workerAfterDigest:functionDigest(workerAfter),job:queued.job,envelope};
  return{input:{controlBefore,workerBefore,workerAfter,newSecret,proof,now},config,result,oldSecret,queued};
}
test('pure cutover binds the new-key fixed self-test and returns only a paired secret/ready environment patch',()=>{
  const f=fixture(),before=structuredClone(f.input),value=buildWorkerKeyReadyCutover(f.input);
  assert.deepEqual(f.input,before);assert.deepEqual(Object.keys(value.patch),['environmentVariables']);
  const changed=Object.keys(value.patch.environmentVariables).filter(k=>value.patch.environmentVariables[k]!==f.input.controlBefore.environmentVariables[k]);
  assert.deepEqual(changed.sort(),['V2_SPARK_EXECUTOR_SECRET','V2_SPARK_QUEUE_READY_JOB_ID']);
  assert.equal(value.patch.environmentVariables.V2_SPARK_EXECUTOR_SECRET,f.input.newSecret);assert.equal(value.patch.environmentVariables.V2_SPARK_QUEUE_READY_JOB_ID,id(2));
  assert.equal(value.expectedControlDigest,functionDigest({...f.input.controlBefore,...value.patch}));
  assert.equal(value.summary.independentAssertions,6);assert.equal(value.summary.authorized,false);assert.equal(value.summary.executed,false);
  for(const key of ['requiresQuiescenceEvidence','requiresFreshCloudReadback','requiresBudgetAndScopeApproval','requiresSingleJobExecutionEvidence'])assert.equal(value.summary[key],true);
  assert.equal(value.summary.historicalCloudCompatibilityAccepted,false);
  const summary=JSON.stringify(value.summary);for(const secret of [f.oldSecret,f.input.newSecret,'SYNTHETIC_UNRELATED_CONFIG','SYNTHETIC_WORKER_CONFIG',id(1),id(2),f.input.controlBefore.functionName])assert.equal(summary.includes(secret),false);
});
test('control/worker boundary, old/new key relationships and any unrelated worker mutation are rejected',()=>{
  const changes=[i=>i.controlBefore.instanceConcurrency=1,i=>i.controlBefore.environmentVariables.V2_FC_PUBLIC_READ_ONLY='false',
    i=>i.controlBefore.environmentVariables.V2_FC_PUBLIC_WRITE_SCOPE='DEVELOPMENT_ONLY',i=>i.controlBefore.environmentVariables.V2_PRIVATE_RELEASE_ENABLED='true',
    i=>i.workerBefore.memorySize=4096,i=>i.workerBefore.runtime='custom.debian12',i=>i.workerBefore.internetAccess=true,
    i=>i.workerBefore.environmentVariables.V2_SPARK_WORKER_SECRET=i.newSecret,i=>i.workerAfter.environmentVariables.V2_SPARK_WORKER_SECRET=i.workerBefore.environmentVariables.V2_SPARK_WORKER_SECRET,
    i=>i.workerAfter.role='ANOTHER_ROLE',i=>i.workerAfter.codeChecksum='changed',i=>i.workerAfter.environmentVariables.OTHER_SECRET='changed',
    i=>i.workerAfter.lastUpdateStatus='InProgress',i=>i.workerAfter.functionName=i.controlBefore.functionName,
    i=>i.newSecret=i.controlBefore.environmentVariables.V2_SPARK_EXECUTOR_SECRET,i=>i.newSecret='short',i=>i.newSecret=' '+i.newSecret,
    i=>i.controlBefore.environmentVariables.V2_SPARK_QUEUE_JOB_PREFIX='other-project/queue/jobs'];
  for(const change of changes){const f=fixture();change(f.input);assert.throws(()=>buildWorkerKeyReadyCutover(f.input));}
});
test('control characters in signing secrets are rejected before proof or patch construction',()=>{
  for(const character of ['\u0000','\u0001','\u001f','\u007f']){
    const f=fixture();f.input.newSecret='SYNTHETIC-NEW-WORKER-KEY-000000000'+character;
    assert.throws(()=>buildWorkerKeyReadyCutover(f.input),{safeCode:'WORKER_CUTOVER_NEW_SECRET_REQUIRED'});
  }
});
test('proof cannot substitute baseline, prior ready job, worker readback, approval flags or time bounds',()=>{
  for(const change of [i=>i.proof.boundaryDigest='0'.repeat(64),i=>i.proof.oldReadyJobId=id(3),i=>i.proof.workerAfterDigest='0'.repeat(64),
    i=>i.proof.scope='shuduo-spark-ready-refresh/v1',i=>i.proof.authorized=true,i=>i.proof.expiresAt=now,i=>i.proof.expiresAt=now+900001,
    i=>i.proof.issuedAt=now+1,i=>i.proof.issuedAt=now-900001,i=>i.now=NaN]){
    const f=fixture();change(f.input);assert.throws(()=>buildWorkerKeyReadyCutover(f.input));
  }
});
test('a partially changed control cannot be accepted as the untouched baseline of a paired switch',()=>{
  for(const changedKey of ['V2_SPARK_EXECUTOR_SECRET','V2_SPARK_QUEUE_READY_JOB_ID']){
    const f=fixture();f.input.controlBefore.environmentVariables[changedKey]=changedKey==='V2_SPARK_EXECUTOR_SECRET'?f.input.newSecret:id(2);
    assert.throws(()=>buildWorkerKeyReadyCutover(f.input));
  }
});
test('old-key or invalid job/result signatures and wrong job identity cannot authorize a ready pointer',()=>{
  for(const mode of ['old-job','old-result','bad-job','bad-result','wrong-result-id','same-ready-id']){
    const f=fixture(),p=f.input.proof,old={...f.config,sharedSecret:f.oldSecret};
    if(mode==='old-job')p.job=createQueuedSparkJob(privateSparkSmokePayload({}),old,{now:now-60000,requestId:id(2)}).job;
    if(mode==='old-result')p.envelope=createQueuedSparkResult(p.job,f.result,old,now-10000);
    if(mode==='bad-job')p.job.signature='v1='+'0'.repeat(64);
    if(mode==='bad-result')p.envelope.signature='v1='+'0'.repeat(64);
    if(mode==='wrong-result-id')p.envelope=createQueuedSparkResult({...p.job,jobId:id(3)},f.result,f.config,now-10000);
    if(mode==='same-ready-id')p.job=createQueuedSparkJob(privateSparkSmokePayload({}),f.config,{now:now-60000,requestId:id(1)}).job;
    assert.throws(()=>buildWorkerKeyReadyCutover(f.input));
  }
});
test('even valid signatures cannot admit changed SQL, contexts, stale timings or incorrect independent results',()=>{
  for(const mutate of [input=>input.sql='SELECT 1',input=>input.context.tables[0].rows[0][0]='OTHER_CLIENT',input=>input.validationContexts=[input.context],input=>input.testSql='SELECT 1']){
    const f=fixture(),input=privateSparkSmokePayload({});mutate(input);
    f.input.proof.job=createQueuedSparkJob(input,f.config,{now:now-60000,requestId:id(2)}).job;
    assert.throws(()=>buildWorkerKeyReadyCutover(f.input),/FIXED_SMOKE/);
  }
  for(const mutate of [r=>r.testDouble=true,r=>r.engineVersion='3.5.7',r=>r.mainSqlExecuted=false,r=>r.status='FAILED',r=>r.validation.passed=false,
    r=>r.rows=[],r=>r.rows.push(r.rows[0]),r=>r.rows[0].total_assets='999.00',r=>r.rows[0].security_count=3]){
    const f=fixture();mutate(f.result);f.input.proof.envelope=createQueuedSparkResult(f.input.proof.job,f.result,f.config,now-10000);
    assert.throws(()=>buildWorkerKeyReadyCutover(f.input));
  }
  for(const patch of [{completedAt:new Date(now+60001).toISOString()},{completedAt:new Date(now-60001).toISOString()}]){
    const f=fixture();Object.assign(f.input.proof.envelope,patch);assert.throws(()=>buildWorkerKeyReadyCutover(f.input),/COMPLETION_TIME/);
  }
  const changedExpiry=fixture();changedExpiry.input.proof.job.expiresAt=new Date(now+900000).toISOString();
  assert.throws(()=>buildWorkerKeyReadyCutover(changedExpiry.input),/JOB_TIME/);
});
test('saved terminal run reconciliation keeps old-key history readable without asking the new-key runner or changing records',async()=>{
  const f=fixture(),store=new MetadataStore(':memory:'),project='project-securities-lab',context=getContext('stock-cash-t1'),family=validationFamilyForContext(context.id);
  let reads=0,writes=0,persists=0;
  const client=new RemoteSparkQueueClient(f.config,{read:async()=>{reads++;throw Error('must not reverify old receipt with new key');},create:async()=>{writes++;throw Error('must not create queue work');}});
  const revision=store.create('revision',project,{sql:referenceSqlForContext(context.id),hash:sha256(referenceSqlForContext(context.id)),contextId:context.id});
  const oldPrepared=new RemoteSparkQueueClient({...f.config,sharedSecret:f.oldSecret},{}).prepare({sql:revision.sql,context,validationContexts:family.contextIds.map(getContext)},id(4));
  try{
    for(const status of ['SUCCEEDED','FAILED','VALIDATION_FAILED','CANCELLED']){
      const run=store.create('run',project,{status,revisionId:revision.id,revisionHash:revision.hash,contextId:context.id,validationContractId:family.id,
        rows:context.expected,engine:'Apache Spark',engineVersion:'3.5.9',mainSqlExecuted:true,remoteSubmission:{prepared:oldPrepared,submitted:true}});
      const result=await reconcileDurableDevelopment(run,{store,project,runner:{read:q=>client.readPreparedResult(q),submit:q=>client.submitPrepared(q)},persist:async()=>{persists++;},contextIds:family.contextIds,contractId:family.id});
      assert.deepEqual(result,run);assert.deepEqual(store.get('run',run.id,project),run);
    }
    assert.equal(reads,0);assert.equal(writes,0);assert.equal(persists,0);
  }finally{store.close();}
});
