import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {readFile,writeFile,mkdir,readdir} from 'node:fs/promises';
import {join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID,createHash} from 'node:crypto';
import {durableServiceFixture} from './fixtures/durable-service-agent.mjs';
import {AGENT_WAKE_PREFIX} from '../../src/v2/agent-event-driver.mjs';

const workerPath=fileURLToPath(new URL('./fixtures/service-event-process.mjs',import.meta.url));
const schema='shuduo-synthetic-service-process/v1',hash=value=>createHash('sha256').update(value).digest('hex');
const stableTask=p=>({id:p.id,requestId:p.requestId,createdAt:p.createdAt,contextHash:p.contextHash,sourceBinding:p.sourceBinding,sourceKind:p.sourceKind,sourceRevisionId:p.sourceRevisionId,sourceRunId:p.sourceRunId,
 pilotId:p.pilotId,executionMode:p.executionMode,requestedModel:p.requestedModel,executionWindow:p.executionWindow,resourceVersions:p.resourceVersions,maxAttempts:p.maxAttempts,requestTokenLimit:p.requestTokenLimit,tokenBudget:p.tokenBudget});
const withDeadline=(promise,ms,label)=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error(label)),ms);promise.then(v=>{clearTimeout(timer);resolve(v);},e=>{clearTimeout(timer);reject(e);});});

async function setup(t){
 const cleanup=[],children=[];
 t.after(async()=>{for(const child of [...children].reverse())await child.stop();for(const fn of cleanup)await fn();});
 const f=await durableServiceFixture({after:fn=>cleanup.push(fn)},{eventMode:true,manual:true});
 const parentHash=hash(JSON.stringify(f.store.get('agent',f.agent.id,f.project)));
 // Seed once, then close this app before either independent process starts.
 f.app.server.closeAllConnections();await new Promise(resolve=>f.app.server.close(resolve));
 await writeFile(join(f.root,'synthetic-process-marker'),schema,{mode:0o600});
 async function start(name,{modelMode='SUCCEED',modelLeaseMs=90000}={}){
  const configPath=join(f.root,'synthetic-worker-'+name+'.json');await writeFile(configPath,JSON.stringify({schema,root:f.root,env:f.env,modelMode,modelLeaseMs}),{mode:0o600});
  const child=spawn(process.execPath,[workerPath,'--synthetic-service-worker',configPath],{env:{PATH:process.env.PATH??'',NODE_NO_WARNINGS:'1',TZ:'Asia/Shanghai'},stdio:['ignore','pipe','pipe']});
  const messages=[],listeners=new Set();let exitResult;
  const exited=new Promise(resolve=>child.once('exit',(code,signal)=>{exitResult={code,signal};resolve(exitResult);for(const fn of listeners)fn();}));
  // Do not print child/config payloads. The worker emits a small allowlist only.
  const lines=createInterface({input:child.stdout});lines.on('line',line=>{try{const v=JSON.parse(line);if(['ready','model-started'].includes(v.kind)){messages.push(v);for(const fn of listeners)fn();}}catch{}});child.stderr.resume();
  const waitMessage=kind=>withDeadline(new Promise((resolve,reject)=>{
   const check=()=>{const v=messages.find(v=>v.kind===kind);if(v){listeners.delete(check);resolve(v);}else if(exitResult){listeners.delete(check);reject(Error('SYNTHETIC_CHILD_EXITED_BEFORE_'+kind));}};
   listeners.add(check);check();
  }),8000,'SYNTHETIC_CHILD_MESSAGE_TIMEOUT_'+kind);
  const result={child,pid:child.pid,waitMessage,stop:async(signal='SIGTERM')=>{
   if(!exitResult)child.kill(signal);
   try{return await withDeadline(exited,4000,'SYNTHETIC_CHILD_STOP_TIMEOUT');}catch{child.kill('SIGKILL');return await exited;}
  }};children.push(result);
  const ready=await waitMessage('ready');assert.equal(ready.pid,child.pid);result.base=`http://127.0.0.1:${ready.port}`;
  result.invoke=async payload=>{const r=await fetch(result.base+'/invoke',{method:'POST',headers:{'content-type':'application/octet-stream','x-fc-control-path':'/invoke'},body:JSON.stringify(payload),signal:AbortSignal.timeout(12000)});return {status:r.status,body:await r.json()};};
  result.call=async(path,body,key)=>{
   const response=await result.invoke({operation:'PRIVATE_APPLICATION_HTTP_V1',method:body===undefined?'GET':'POST',path:'/api/v2'+path,headers:{'x-shuduo-client':'workbench',...f.a,...(key?{'idempotency-key':key}:{})},...(body===undefined?{}:{body})});
   assert.equal(response.status,200,response.body.code);return {status:response.body.status,body:response.body.body};
  };
  return result;
 }
 const read=async(p,id)=>{const r=await p.call('/data-services/agent/plans/'+id);assert.equal(r.status,200,r.body.code);return r.body;};
 const recovery=async p=>{const r=await p.call('/data-services/dapis/'+f.holdings.id+'/recovery');assert.equal(r.status,200,r.body.code);assert.equal(r.body.healthy,true);return {bootId:r.body.bootId,fingerprint:r.body.fingerprint};};
 const objects=async()=>{const dir=join(f.root,'synthetic-oss'),files=(await readdir(dir)).filter(p=>p.endsWith('.json')).sort();return Promise.all(files.map(async file=>({file,hash:hash(await readFile(join(dir,file)))})));};
 const event=file=>({events:[{eventName:'ObjectCreated:PutObject',eventSource:'acs:oss',eventVersion:'1.0',eventTime:new Date().toISOString(),oss:{bucket:{name:f.env.OSS_BUCKET,ownerIdentity:f.env.V2_AGENT_EVENT_ACCOUNT_ID},object:{key:AGENT_WAKE_PREFIX+'/'+file}}}]});
 const modelRows=async()=>{try{return (await readFile(join(f.root,'synthetic-model-starts.ndjson'),'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);}catch(error){if(error.code==='ENOENT')return [];throw error;}};
 const create=async p=>{const requestId=randomUUID(),r=await p.call('/data-services/agent/plans',{message:'为虚构证券财富顾问生成股票与现金查询，验证原任务跨进程恢复',sourceBinding:f.sourceBinding},requestId);assert.equal(r.status,202,r.body.code);return r.body;};
 const unchangedParent=()=>assert.equal(hash(JSON.stringify(f.store.get('agent',f.agent.id,f.project))),parentHash);
 return {f,start,read,recovery,objects,event,modelRows,create,unchangedParent};
}

async function evidence(name,proof){
 const target=process.env.SHUDUO_SYNTHETIC_PROCESS_EVIDENCE_DIR;if(!target)return;
 const dir=resolve(target);if(!dir.startsWith(resolve('.runtime')+sep))throw Error('SYNTHETIC_EVIDENCE_DIRECTORY_REQUIRED');
 await mkdir(dir,{recursive:true,mode:0o700});await writeFile(join(dir,name+'.json'),JSON.stringify({schema:'shuduo-service-process-recovery/v1',environment:'LOCAL_PROCESS_SYNTHETIC_ONLY',realModelCalls:0,realSparkRuns:0,cloudCalls:0,publicDeployed:false,agentIndependentE2E:false,...proof},null,2)+'\n',{mode:0o600});
}

test('a queued original service event survives process exit with its session, source and immutable wake unchanged',async t=>{
 const x=await setup(t),a=await x.start('queued-a'),beforeBoot=await x.recovery(a),task=await x.create(a);
 const queued=await a.call('/data-services/agent/plans/'+task.id+'/advance',{expectedVersion:task.version});assert.equal(queued.status,202);assert.equal((await x.modelRows()).length,0);
 const beforeObjects=await x.objects();assert.equal(beforeObjects.length,1);const exitA=await a.stop();assert.equal(exitA.code,0);
 const b=await x.start('queued-b'),afterBoot=await x.recovery(b);assert.notEqual(a.pid,b.pid);assert.notEqual(beforeBoot.bootId,afterBoot.bootId);assert.equal(beforeBoot.fingerprint,afterBoot.fingerprint);
 const restored=await x.read(b,task.id);assert.deepEqual(stableTask(restored),stableTask(task));assert.equal(restored.version,1);assert.equal(restored.attempts.length,0);assert.deepEqual(await x.objects(),beforeObjects);
 const request=await b.call('/data-services/agent/requests/'+task.requestId);assert.equal(request.body.id,task.id);
 const recoveredCreate=await b.call('/data-services/agent/plans',{message:task.message,sourceBinding:task.sourceBinding},task.requestId);assert.equal(recoveredCreate.body.id,task.id);assert.deepEqual(await x.objects(),beforeObjects);assert.equal((await x.modelRows()).length,0);
 const originalEvent=x.event(beforeObjects[0].file),delivered=await b.invoke(originalEvent);assert.equal(delivered.status,200);assert.equal(delivered.body.status,'COMPLETED');
 const done=await x.read(b,task.id);assert.equal(done.status,'SUCCEEDED');assert.equal(done.attempts.length,1);assert.equal(done.usedTokens,700);assert.deepEqual(stableTask(done),stableTask(task));
 await b.invoke(originalEvent);const models=await x.modelRows();assert.equal(models.length,1);assert.equal(models[0].pid,b.pid);assert.equal((await x.read(b,task.id)).recovery.background.consumedEvents,1);
 const applied=await b.call('/data-services/agent/plans/'+task.id+'/apply',{proposalHash:done.proposalHash});assert.equal(applied.status,200);assert.equal((await x.read(b,task.id)).status,'APPLIED');
 assert.equal(x.f.store.list('service_agent_plan',x.f.project).length,1);x.unchangedParent();
 const exitB=await b.stop();assert.equal(exitB.code,0);
 await evidence('queued',{pidA:a.pid,pidB:b.pid,exitA,exitB,beforeBoot,afterBoot,originalTaskId:task.id,originalRequestId:task.requestId,sessionRestoredWithoutLogin:true,wakeBytesUnchanged:true,parentAgentUnchanged:true,planCount:1,syntheticModels:1,modelPids:models.map(m=>m.pid),attempts:1,usedTokens:700,humanReviewedDraft:true});
});

test('SIGKILL during a model leaves a durable reservation; a new process reconciles UNKNOWN before any reviewed retry',async t=>{
 const x=await setup(t),a=await x.start('inflight-a',{modelMode:'BLOCK',modelLeaseMs:5000}),beforeBoot=await x.recovery(a),task=await x.create(a);
 await a.call('/data-services/agent/plans/'+task.id+'/advance',{expectedVersion:task.version});const beforeObjects=await x.objects(),originalEvent=x.event(beforeObjects[0].file);
 const pending=a.invoke(originalEvent).catch(()=>({outcome:'UNCONFIRMED'}));await a.waitMessage('model-started');
 const exitA=await a.stop('SIGKILL');assert.equal(exitA.signal,'SIGKILL');const interrupted=await pending;assert.equal(interrupted.outcome,'UNCONFIRMED');
 const persisted=x.f.store.get('service_agent_plan',task.id,x.f.project);assert.equal(persisted.stage,'MODEL_IN_FLIGHT');assert.equal(persisted.usedTokens,8000);assert.equal(persisted.attempts.length,1);
 const b=await x.start('inflight-b',{modelLeaseMs:5000}),afterBoot=await x.recovery(b);assert.notEqual(a.pid,b.pid);assert.notEqual(beforeBoot.bootId,afterBoot.bootId);assert.equal(beforeBoot.fingerprint,afterBoot.fingerprint);
 const restored=await x.read(b,task.id);assert.deepEqual(stableTask(restored),stableTask(task));assert.equal(restored.stage,'MODEL_IN_FLIGHT');assert.equal((await x.modelRows()).length,1);assert.deepEqual(await x.objects(),beforeObjects);
 await new Promise(resolve=>setTimeout(resolve,Math.max(1,Date.parse(persisted.durable.leaseExpiresAt)-Date.now()+50)));
 assert.equal((await b.invoke(originalEvent)).body.status,'NEEDS_CONFIRMATION');const unknown=await x.read(b,task.id);assert.equal(unknown.stage,'MODEL_OUTCOME_UNKNOWN');assert.equal(unknown.usedTokens,8000);assert.equal(unknown.attempts.length,1);assert.equal(unknown.recovery.background.consumedEvents,1);
 await b.invoke(originalEvent);assert.equal((await x.modelRows()).length,1);
 const denied=await b.call('/data-services/agent/plans/'+task.id+'/advance',{expectedVersion:unknown.version});assert.equal(denied.body.code,'SERVICE_AGENT_RETRY_CONFIRMATION_REQUIRED');
 const resumed=await b.call('/data-services/agent/plans/'+task.id+'/advance',{expectedVersion:unknown.version,confirmModelRetry:true});assert.equal(resumed.status,202);assert.equal(resumed.body.usedTokens,8000);
 const all=await x.objects(),fresh=all.find(o=>!beforeObjects.some(prior=>prior.file===o.file));assert.ok(fresh);await b.invoke(originalEvent);assert.equal((await x.modelRows()).length,1);
 await b.invoke(x.event(fresh.file));const done=await x.read(b,task.id);assert.equal(done.status,'SUCCEEDED');assert.equal(done.attempts.length,2);assert.equal(done.usedTokens,8700);assert.deepEqual(stableTask(done),stableTask(task));assert.equal((await x.modelRows()).length,2);
 const models=await x.modelRows();assert.deepEqual(models.map(m=>m.pid),[a.pid,b.pid]);assert.equal(done.recovery.background.consumedEvents,2);assert.equal(x.f.store.list('service_agent_plan',x.f.project).length,1);x.unchangedParent();
 const exitB=await b.stop();assert.equal(exitB.code,0);
 await evidence('inflight',{pidA:a.pid,pidB:b.pid,exitA,exitB,beforeBoot,afterBoot,originalTaskId:task.id,originalRequestId:task.requestId,sessionRestoredWithoutLogin:true,parentAgentUnchanged:true,planCount:1,originalInvocationOutcome:interrupted.outcome,initialStageAfterKill:'MODEL_IN_FLIGHT',unknownReservedTokens:8000,unknownAttempts:1,modelsBeforeExplicitReview:1,syntheticModels:2,modelPids:models.map(m=>m.pid),finalAttempts:2,finalTokens:8700});
});
