import test from 'node:test';
import assert from 'node:assert/strict';
import fs,{mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,statSync,existsSync,rmSync,symlinkSync,renameSync,closeSync,unlinkSync} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {runLiveLifecycleCli,createLiveEvaluationAdapter} from '../../scripts/run-live-lifecycle-evaluation.mjs';
import {liveLifecyclePlan,liveLifecycleContract,legacyLiveLifecycleContract,liveCaseCheckpoint,advanceLiveLifecycleCase} from '../../src/v2/live-lifecycle-evaluation.mjs';
import {m1EvaluationCases} from '../../src/v2/evaluation.mjs';
import {createLiveLifecycleFixture} from './fixtures/live-lifecycle-case.mjs';

async function savedFixture(t,{limit=3,legacy=false}={}){
 const f=createLiveLifecycleFixture(),opts={pause:async()=>{},maxPolls:2};
 const review=await advanceLiveLifecycleCase(f.definition,f.checkpoint,f.adapter,opts);f.reviewNow();
 const waiting=await advanceLiveLifecycleCase(f.definition,review,f.adapter,opts);
 assert.equal(waiting.status,'AWAITING_CONSUMPTION');
 const root=mkdtempSync(join(tmpdir(),'shuduo-live-cli-synthetic-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const artifactRoot=join(root,'runs');mkdirSync(artifactRoot,{mode:0o700});
 const id=randomUUID(),dir=join(artifactRoot,id);mkdirSync(dir,{mode:0o700});
 const plan=liveLifecyclePlan(limit),origin='http://127.0.0.1:3311';
 const pending=liveCaseCheckpoint(m1EvaluationCases()[1],f.checkpoint.evaluationStartedAt,plan.caseSetDigest);
 const outcomes=limit>1?[waiting,pending]:[waiting];
 if(legacy){for(const item of outcomes)delete item.contractId;waiting.status='SUCCEEDED';waiting.phase='COMPLETE';delete waiting.consumptionSource;delete waiting.consumptionStage;}
 const state={evaluationRunId:id,contract:legacy?legacyLiveLifecycleContract:liveLifecycleContract,startedAt:f.checkpoint.evaluationStartedAt,caseSetDigest:plan.caseSetDigest,caseLimit:limit,origin,outcomes};
 const path=join(dir,'checkpoint.json');writeFileSync(path,JSON.stringify(state,null,2)+'\n',{mode:0o600});
 const calls=[],output=[],errors=[];
 const options={artifactRoot,testDouble:true,output:text=>output.push(JSON.parse(text)),error:text=>errors.push(text),fetchImpl:async(url,request)=>{
  calls.push({url,method:request.method,body:request.body});assert.equal(new URL(url).origin,origin);
  const value=await f.adapter.request(new URL(url).pathname.replace('/api/v2','')+new URL(url).search,request.body===undefined?undefined:JSON.parse(request.body));
  return new Response(JSON.stringify(value),{status:200});
 }};
 return {f,id,dir,path,state,calls,output,errors,options,read:()=>JSON.parse(readFileSync(path,'utf8'))};
}
function assertExactServicesLink(value,x){
 const url=new URL(value.servicesUrl);
 assert.equal(url.origin,x.state.origin);assert.equal(url.pathname,'/v2/');assert.equal(url.hash,'');
 assert.deepEqual(Object.fromEntries(url.searchParams),{module:'services',source_task:x.f.task.id,source_package:x.f.bundle.digest,
  source_release:x.f.release.id,source_kind:'AGENT',source_scope:'LOCAL_TEST_ONLY',source_revision:x.f.revision.id,source_run:x.f.run.id});
 assert.equal(value.navigationOnly,true);assert.equal(value.sourceSelection,'EXACT_LOCAL_RELEASE');
 assert.match(value.servicesNotice,/实际回读/);assert.match(value.servicesNotice,/链接本身不授权/);
 assert.deepEqual(value.consumptionTarget,{taskId:x.f.task.id,packageDigest:x.f.bundle.digest,releaseId:x.f.release.id,batchIds:x.f.batches.map(batch=>batch.id)});
}

test('CLI plan defaults to v2 including consumption and has no network or filesystem side effects',async t=>{
 const root=mkdtempSync(join(tmpdir(),'shuduo-live-plan-synthetic-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const output=[],artifactRoot=join(root,'not-created');
 assert.equal(await runLiveLifecycleCli(['--plan'],{},{artifactRoot,output:text=>output.push(JSON.parse(text)),fetchImpl:()=>assert.fail('plan cannot fetch')}),0);
 assert.equal(output[0].contract.id,liveLifecycleContract.id);assert.ok(output[0].contract.stages.includes('CONSUMPTION'));assert.equal(output[0].willExecute,false);
 assert.equal(existsSync(artifactRoot),false);
});

test('CLI refresh checks only existing consumption cases without authorization, health checks, POSTs or later case creation',async t=>{
 const x=await savedFixture(t),later=structuredClone(x.state.outcomes[1]),mutationCount=x.f.mutations.length;x.f.consumeNow();
 assert.equal(await runLiveLifecycleCli(['--refresh',x.id],{},x.options),0,x.errors.join('\n'));
 assert.equal(x.calls.length,1);assert.equal(x.calls[0].method,'GET');assert.equal(x.calls[0].body,undefined);
 const query=new URL(x.calls[0].url);assert.equal(query.pathname,'/api/v2/data-services/task-evidence');
 assert.equal(query.searchParams.get('release_id'),x.f.release.id);assert.equal(query.searchParams.get('package_digest'),x.f.bundle.digest);
 assert.equal(x.f.mutations.length,mutationCount);
 const state=x.read();assert.equal(state.evaluationRunId,x.id);assert.equal(state.caseLimit,3);assert.equal(state.outcomes.length,2);
 assert.equal(state.outcomes[0].status,'SUCCEEDED');assert.deepEqual(state.outcomes[1],later);
 assert.equal(state.succeededCaseCount,0,'synthetic evidence never becomes genuine success');assert.equal(state.targetMet,false);
 const progress=x.output.find(row=>row.caseId===x.f.definition.id);
 assert.equal(progress.taskUrl,x.state.origin+'/v2/?module=agent-center&task='+x.f.task.id);
 assertExactServicesLink(progress,x);assert.equal(x.output.at(-1).waitingConsumptionCount,0);
 assert.deepEqual(readdirSync(x.dir),['checkpoint.json']);assert.equal(statSync(x.path).mode&0o777,0o600);
 const bytes=readFileSync(x.path,'utf8'),calls=x.calls.length;
 assert.equal(await runLiveLifecycleCli(['--refresh',x.id],{},x.options),0);assert.equal(x.calls.length,calls);assert.equal(readFileSync(x.path,'utf8'),bytes,'no waiting case means no checkpoint rewrite');
});

test('failed consumption read pauses original case, and refresh resumes only that phase without a paid window',async t=>{
 const x=await savedFixture(t,{limit:1});x.f.failConsumptionRead(true);
 assert.equal(await runLiveLifecycleCli(['--refresh',x.id],{},x.options),2);
 assert.equal(x.read().outcomes[0].status,'PAUSED');assert.equal(x.read().outcomes[0].phase,'CONSUMPTION');
 assert.equal(x.calls.every(call=>call.method==='GET'),true);x.f.failConsumptionRead(false);x.f.consumeNow();
 assert.equal(await runLiveLifecycleCli(['--refresh',x.id],{},x.options),0);assert.equal(x.read().outcomes[0].status,'SUCCEEDED');
});

test('refresh adapter rejects every POST and all reads except the original exact consumption tuple',async t=>{
 const x=await savedFixture(t,{limit:1}),requests=[];
 const adapter=createLiveEvaluationAdapter(x.state.origin,{readOnly:true,outcomes:x.state.outcomes,fetchImpl:async(url,options)=>{requests.push({url,options});return new Response('{}');}});
 const path='/data-services/task-evidence?'+new URLSearchParams({agent_task_id:x.f.task.id,package_digest:x.f.bundle.digest,release_id:x.f.release.id});
 for(const [route,body]of [[path,{}],['/agent/tasks',{}],['/status',undefined],[path+'&actorId=other',undefined],[path.replace(x.f.release.id,randomUUID()),undefined],['//external.invalid/api',undefined]])
  await assert.rejects(adapter.request(route,body),{code:'READ_ONLY_CONSUMPTION_REFRESH_REQUIRED'});
 assert.equal(requests.length,0);await adapter.request(path);assert.equal(requests.length,1);assert.equal(requests[0].options.method,'GET');
});

test('report reads current or legacy contract as recorded only; legacy resume never migrates or rewrites history',async t=>{
 for(const legacy of [false,true]){
  const x=await savedFixture(t,{limit:1,legacy}),before=readFileSync(x.path,'utf8'),mtime=statSync(x.path).mtimeMs;
  assert.equal(await runLiveLifecycleCli(['--report',x.id],{},x.options),0);
  const output=x.output.at(-1);assert.equal(output.recorded,true);assert.equal(output.externalTruthReverified,false);
  assert.equal(output.contract.id,legacy?legacyLiveLifecycleContract.id:liveLifecycleContract.id);assert.equal(output.currentContractTargetMet,false);
  if(legacy){assert.match(output.scopeNotice,/不含消费/);assert.equal(output.cases[0].servicesUrl,undefined);assert.equal(output.cases[0].taskUrl,x.state.origin+'/v2/?module=agent-center&task='+x.f.task.id);assert.equal(await runLiveLifecycleCli(['--resume',x.id],{},x.options),2);assert.equal(x.output.at(-1).resumeUnsupported,true);assert.equal(await runLiveLifecycleCli(['--refresh',x.id],{},x.options),2);}
  else assertExactServicesLink(output.cases[0],x);
  assert.equal(x.calls.length,0);assert.equal(readFileSync(x.path,'utf8'),before);assert.equal(statSync(x.path).mtimeMs,mtime);assert.deepEqual(readdirSync(x.dir),['checkpoint.json']);
 }
});

test('recorded v2 report navigates to only its exact local source without requests, mutations or rewriting the checkpoint',async t=>{
 const x=await savedFixture(t,{limit:1}),before=readFileSync(x.path,'utf8'),mutations=[...x.f.mutations],mtime=statSync(x.path).mtimeMs;
 assert.equal(await runLiveLifecycleCli(['--report',x.id],{},x.options),0);
 const row=x.output.at(-1).cases[0];assertExactServicesLink(row,x);
 assert.equal(row.status,'AWAITING_CONSUMPTION');assert.equal(x.output.at(-1).externalTruthReverified,false);
 assert.equal(x.calls.length,0);assert.deepEqual(x.f.mutations,mutations);assert.equal(readFileSync(x.path,'utf8'),before);
 assert.equal(statSync(x.path).mtimeMs,mtime);assert.deepEqual(readdirSync(x.dir),['checkpoint.json']);
});

test('missing or contradictory saved sources never degrade to an unscoped service directory link',async t=>{
 const x=await savedFixture(t,{limit:1}),original=structuredClone(x.state),mutations=[...x.f.mutations];
 for(const change of [
  s=>{delete s.consumptionSource;},s=>{delete s.consumptionSource.revisionId;},s=>{delete s.consumptionSource.developmentRunId;},
  s=>{s.consumptionSource.scope='PRIVATE_CLOUD_TEST';},s=>{s.consumptionSource.sourceKind='MANUAL';},s=>{s.consumptionSource.sourceKind='UNKNOWN';},
  s=>{s.consumptionSource.sourceAttribution='ENGINEER_ASSISTED';},s=>{s.consumptionSource.taskId=randomUUID();},s=>{s.consumptionSource.revisionId=randomUUID();},
  s=>{s.consumptionSource.revisionHash='f'.repeat(64);},s=>{s.consumptionSource.developmentRunId=randomUUID();},s=>{s.consumptionSource.packageDigest='f'.repeat(64);},
  s=>{s.consumptionSource.releaseId=randomUUID();},s=>{s.consumptionSource.batches[0].id=s.consumptionSource.developmentRunId;},
  s=>{s.code.sourceKind='MANUAL';},s=>{s.code.sourceAttribution='ENGINEER_ASSISTED';},s=>{s.publication.releaseId=randomUUID();},
  s=>{s.delivery.verificationId=randomUUID();},s=>{s.actions.agent.id=randomUUID();},s=>{s.actions.delivery.id=randomUUID();},
  s=>{s.lifecycleOutcome.stages.postReleaseMonitoring.health='CRITICAL';},s=>{s.phase='CODE_AND_DEBUG';},
  s=>{s.status='SUCCEEDED';s.phase='COMPLETE';},
 ]){
  const state=structuredClone(original);change(state.outcomes[0]);writeFileSync(x.path,JSON.stringify(state),{mode:0o600});
  const before=readFileSync(x.path,'utf8');assert.equal(await runLiveLifecycleCli(['--report',x.id],{},x.options),0,x.errors.join('\n'));
  const row=x.output.at(-1).cases[0];assert.equal(row.servicesUrl,undefined);assert.equal(row.consumptionTarget,undefined);assert.equal(row.sourceSelection,undefined);
  assert.equal(row.taskUrl,x.state.origin+'/v2/?module=agent-center&task='+x.f.task.id);
  assert.equal(readFileSync(x.path,'utf8'),before);assert.equal(x.calls.length,0);assert.deepEqual(x.f.mutations,mutations);
 }
});

test('a legacy case with a leftover v2-shaped source still receives no exact service navigation',async t=>{
 const x=await savedFixture(t,{limit:1}),legacy=structuredClone(x.state);legacy.contract=legacyLiveLifecycleContract;delete legacy.outcomes[0].contractId;
 writeFileSync(x.path,JSON.stringify(legacy),{mode:0o600});const before=readFileSync(x.path,'utf8');
 assert.equal(await runLiveLifecycleCli(['--report',x.id],{},x.options),0);
 const row=x.output.at(-1).cases[0];assert.equal(row.servicesUrl,undefined);assert.equal(row.sourceSelection,undefined);
 assert.equal(row.taskUrl,x.state.origin+'/v2/?module=agent-center&task='+x.f.task.id);assert.equal(x.calls.length,0);assert.equal(readFileSync(x.path,'utf8'),before);
});

test('refresh rejects scope drift, arbitrary paths, symlinks and an existing serial lock before any request',async t=>{
 const x=await savedFixture(t,{limit:1}),before=readFileSync(x.path,'utf8');
 for(const env of [{V2_LIVE_EVALUATION_CASE_LIMIT:'2'},{V2_LIVE_EVALUATION_ORIGIN:'http://127.0.0.1:3312'},{V2_LIVE_EVALUATION_ORIGIN:'https://example.invalid'}])
  assert.equal(await runLiveLifecycleCli(['--refresh',x.id],env,x.options),1);
 assert.equal(await runLiveLifecycleCli(['--report','../checkpoint.json'],{},x.options),1);
 writeFileSync(join(x.dir,'runner.lock'),'synthetic-existing-lock',{mode:0o600});
 assert.equal(await runLiveLifecycleCli(['--refresh',x.id],{},x.options),1);assert.equal(readFileSync(join(x.dir,'runner.lock'),'utf8'),'synthetic-existing-lock');
 assert.equal(await runLiveLifecycleCli(['--report',x.id],{},x.options),0,'read-only report does not remove or acquire the running executor lock');
 const alias=randomUUID();symlinkSync(x.dir,join(x.options.artifactRoot,alias));assert.equal(await runLiveLifecycleCli(['--report',alias],{},x.options),1);
 assert.equal(x.calls.length,0);assert.equal(readFileSync(x.path,'utf8'),before);
});

test('malformed consumption checkpoint is rejected before GET and retains the original bytes',async t=>{
 const x=await savedFixture(t,{limit:1});x.state.outcomes[0].consumptionSource.releaseId=randomUUID();
 writeFileSync(x.path,JSON.stringify(x.state),{mode:0o600});const before=readFileSync(x.path,'utf8');
 assert.equal(await runLiveLifecycleCli(['--refresh',x.id],{},x.options),1);assert.equal(x.calls.length,0);assert.equal(readFileSync(x.path,'utf8'),before);
 assert.deepEqual(readdirSync(x.dir),['checkpoint.json']);
});

test('report projection never prints an untrusted raw error field from an old checkpoint',async t=>{
 const x=await savedFixture(t,{limit:1});x.state.outcomes[0].errorCode='synthetic private/raw error detail';
 writeFileSync(x.path,JSON.stringify(x.state),{mode:0o600});const before=readFileSync(x.path,'utf8');
 assert.equal(await runLiveLifecycleCli(['--report',x.id],{},x.options),0);
 assert.doesNotMatch(JSON.stringify(x.output),/synthetic private|raw error/);assert.equal(readFileSync(x.path,'utf8'),before);assert.equal(x.calls.length,0);
});

test('execute and v2 resume keep current authorization and model/Spark readiness gates',async t=>{
 const x=await savedFixture(t,{limit:1});
 assert.equal(await runLiveLifecycleCli(['--resume',x.id],{},x.options),1);assert.equal(x.calls.length,0);
 let health=0;const before=readFileSync(x.path,'utf8'),options={...x.options,fetchImpl:async(url,request)=>{health++;assert.equal(new URL(url).pathname,'/api/v2/status');assert.equal(request.method,'GET');return new Response(JSON.stringify({mode:'LOCAL_DEVELOPMENT',model:{configured:false},spark:{available:false}}));}};
 const env={V2_LIVE_EVALUATION_AUTHORIZED:'LOCAL_FRESH_MODEL_WITH_HUMAN_REVIEW',V2_LIVE_EVALUATION_AUTHORIZED_CASES:'1'};
 assert.equal(await runLiveLifecycleCli(['--resume',x.id],env,options),1);assert.equal(health,1);assert.equal(readFileSync(x.path,'utf8'),before);
 const freshId=randomUUID();assert.equal(await runLiveLifecycleCli(['--execute'],{}, {...x.options,runId:freshId}),1);assert.equal(existsSync(join(x.options.artifactRoot,freshId)),false);
 const uncreated=join(x.options.artifactRoot,'no-authorization-no-directory');assert.equal(await runLiveLifecycleCli(['--execute'],{}, {...x.options,artifactRoot:uncreated,runId:freshId}),1);assert.equal(existsSync(uncreated),false);
});

test('a second executor completing and unlocking after the initial read cannot be overwritten by an older resume or refresh snapshot',async t=>{
 for(const mode of ['--resume','--refresh']){
  const x=await savedFixture(t),latest=structuredClone(x.state),nextDefinition=m1EvaluationCases()[2];
  latest.outcomes[0].status='SUCCEEDED';latest.outcomes[0].phase='COMPLETE';
  const laterTask=liveCaseCheckpoint(nextDefinition,latest.startedAt,latest.caseSetDigest);
  laterTask.status='PAUSED';laterTask.taskId=randomUUID();laterTask.actions.agent={id:laterTask.taskId,key:'synthetic-original-paid-request',status:'CONFIRMED'};laterTask.reservedTokens=12000;
  latest.outcomes.push(laterTask);latest.updatedAt='2026-11-05T10:00:00.000Z';
  const latestBytes=JSON.stringify(latest,null,2)+'\n',lockPath=join(x.dir,'runner.lock'),originalOpen=fs.openSync;
  let concurrentWriterRan=false;
  const mocked=t.mock.method(fs,'openSync',(path,...args)=>{
   if(path===lockPath&&args[0]==='wx'&&!concurrentWriterRan){
    concurrentWriterRan=true;
    // Deterministically model process B acquiring the same lock, persisting its
    // newer case/request association, then unlocking before process A opens it.
    const otherLock=originalOpen(lockPath,'wx',0o600),replacement=join(x.dir,'synthetic-newer-checkpoint.tmp');
    try{writeFileSync(otherLock,'synthetic-second-executor\n');writeFileSync(replacement,latestBytes,{mode:0o600});renameSync(replacement,x.path);}
    finally{closeSync(otherLock);unlinkSync(lockPath);}
   }
   return originalOpen(path,...args);
  });
  syncBuiltinESMExports();
  let result;
  try{result=await runLiveLifecycleCli([mode,x.id],{V2_LIVE_EVALUATION_AUTHORIZED:'LOCAL_FRESH_MODEL_WITH_HUMAN_REVIEW',V2_LIVE_EVALUATION_AUTHORIZED_CASES:'3'},x.options);}
  finally{mocked.mock.restore();syncBuiltinESMExports();}
  assert.equal(concurrentWriterRan,true);assert.equal(result,1);assert.match(x.errors.at(-1),/取得锁前已变化/);
  assert.equal(x.calls.length,0,'stale scope cannot even perform a health or consumption GET');
  assert.equal(readFileSync(x.path,'utf8'),latestBytes,'all newer task, idempotency and reservation associations survive byte-for-byte');
  assert.equal(x.read().outcomes[2].taskId,laterTask.taskId);assert.equal(x.read().outcomes[2].reservedTokens,12000);
  assert.deepEqual(readdirSync(x.dir),['checkpoint.json'],'only the older executor own lock is cleaned');
 }
});
