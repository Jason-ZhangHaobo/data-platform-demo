// HTTP/lifecycle regression with synthetic model and queue doubles only.
// This file is NOT evidence of live model, Spark, cloud recovery or public E2E.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createV2Server, PROJECT } from '../../src/v2/server.mjs';
import { MetadataStore } from '../../src/v2/store.mjs';
import { LocalArtifactStore } from '../../src/v2/artifact-store.mjs';
import { createFcIngress } from '../../src/v2/fc-ingress.mjs';
import { RemoteSparkQueueClient, SPARK_QUEUE_PREFIXES, createQueuedSparkResult } from '../../src/v2/remote-spark-queue.mjs';
import { referenceSql, contextIds, getContext } from '../../src/v2/context.mjs';
import { V2Client } from '../../src/v2/client.mjs';
import { runV2Cli } from '../../bin/shuduo.mjs';
import { runSpark, runtimeConfig } from '../../src/v2/spark.mjs';
import { syntheticSqlRequirement } from './fixtures/sql-requirement.mjs';
import { publicationPreflightPath, publicationRequestReceiptPath } from '../../src/v2/publication-request.mjs';
import { validatePrivateApplicationRequest } from '../../src/v2/private-application.mjs';
import { signSchedulerTick } from '../../src/v2/scheduler-tick.mjs';
import { runConsumerAcceptance } from '../../scripts/verify-service-consumer.mjs';
import { validateDeliveryPackage } from '../../src/v2/delivery.mjs';
import { opsPublicationTarget, readOpsPublication } from '../../web/src/ops-publication.ts';
import { serviceSourceFromLocation } from '../../web/src/service-source-binding.ts';
import { serviceBatchFromLocation } from '../../web/src/service-batch-scope.ts';

async function fixture(t,{eventsEnabled=false,startupPreflight=false,structuredRequirement=false,stableOrigin=false,queueTimeoutMs=180000}={}) {
  const directory = mkdtempSync(join(tmpdir(), 'shuduo-pilot-journey-'));
  let now = Date.now(), app, store, base, cookie, csrf, modelCalls = 0, jobCreates = 0, loseSubmission = false, modelFault=false;
  let loseArtifactAcknowledgement=false, packageWrites=0;
  let jobWriteAttempts=0, cancellationWrites=0, resultReads=0;
  const objects = new Map();
  const wakes=[];
  const config = { projectId: PROJECT, sharedSecret: 'synthetic-journey-signing-key-only-123456789', jobPrefix: SPARK_QUEUE_PREFIXES.jobs, resultPrefix: SPARK_QUEUE_PREFIXES.results, cancellationPrefix: SPARK_QUEUE_PREFIXES.cancellations, timeoutMs: queueTimeoutMs };
  const queue = new RemoteSparkQueueClient(config, {
    read: async key => { if(key.startsWith(config.resultPrefix+'/'))resultReads++;return objects.get(key); },
    create: async (key, body) => {
      if(key.startsWith(config.jobPrefix+'/'))jobWriteAttempts++;
      if(key.startsWith(config.cancellationPrefix+'/'))cancellationWrites++;
      if (objects.has(key)) { assert.equal(objects.get(key), body); return { created: false }; }
      objects.set(key, body); if (key.startsWith(config.jobPrefix + '/')) jobCreates++;
      if (loseSubmission) { loseSubmission = false; throw Error('SYNTHETIC_LOST_RESPONSE'); }
      return { created: true };
    },
  }, { now: () => now });
  const runner = async () => { throw Error('BLOCKING_RUNNER_FORBIDDEN_IN_THIS_TEST'); };
  runner.descriptor = { engine: 'Apache Spark', isolation: 'REMOTE_FUNCTION', transport: 'PRIVATE_OSS_QUEUE', healthVerified: true, publicWriteEnabled: true };
  runner.durable = { prepare: (input, id) => queue.prepare(input, id), submit: (q,options) => queue.submitPrepared(q,options), read: (q,options) => queue.readPreparedResult(q,options), cancel: q => queue.cancelPrepared(q) };
  const env = { V2_LOCAL_DEVELOPMENT: 'false', V2_HOST: '127.0.0.1', V2_PROVISIONING_ONLY: 'true', V2_PRIVATE_SMOKE_ENABLED: 'true', V2_ALLOW_INSECURE_PUBLIC_COOKIES: 'true', V2_PUBLIC_ORIGIN: 'https://journey.example.invalid', V2_DURABLE_SQL_AGENT_ENABLED: 'true', V2_FC_PUBLIC_WRITE_SCOPE: 'DEVELOPMENT_ONLY', V2_PUBLIC_DEVELOPMENT_STARTS_AT: new Date(now - 1000).toISOString(), V2_PUBLIC_DEVELOPMENT_EXPIRES_AT: new Date(now + 3600000).toISOString(), V2_BOOTSTRAP_ADMIN_EMAIL: 'owner@example.invalid', V2_MONTHLY_REMOTE_SPARK_RUN_LIMIT: '4' };
  if(startupPreflight)Object.assign(env,{DASHSCOPE_API_KEY:'synthetic-no-provider-credential',V2_ACCOUNT_MONTHLY_SPEND_CNY:'20'});
  if(eventsEnabled)Object.assign(env,{V2_AGENT_DRIVER_MODE:'OSS_EVENTS',OSS_BUCKET:'fictional-securities-test',V2_AGENT_EVENT_ACCOUNT_ID:'111122223333',V2_SPARK_EXECUTOR_SECRET:config.sharedSecret,V2_SPARK_EXECUTOR_TRANSPORT:'OSS_QUEUE'});
  const agentWakeTransport={read:async key=>objects.get(key),create:async(key,body)=>{
    if(objects.has(key)){assert.equal(objects.get(key),body);return;}
    objects.set(key,body);wakes.push({events:[{eventName:'ObjectCreated:PutObject',eventSource:'acs:oss',eventVersion:'1.0',eventTime:new Date(now).toISOString(),oss:{bucket:{name:env.OSS_BUCKET,ownerIdentity:env.V2_AGENT_EVENT_ACCOUNT_ID},object:{key}}}]});
  }};
  const close = async () => { if (!app) return; app.server.closeAllConnections(); await new Promise(r => app.server.close(r)); store.close(); app = undefined; };
  const open = async () => {
    store = new MetadataStore(join(directory, 'metadata.sqlite'));
    const artifactStore=new LocalArtifactStore(join(directory,'artifacts')), put=artifactStore.put.bind(artifactStore);
    artifactStore.put=async(kind,digest,value)=>{
      const result=await put(kind,digest,value);
      if(kind==='delivery-package'){
        packageWrites++;
        if(loseArtifactAcknowledgement){loseArtifactAcknowledgement=false;throw Error('SYNTHETIC_ARTIFACT_ACK_LOST');}
      }
      return result;
    };
    app = createV2Server({ store, root: directory, env, runner, agentWakeTransport, now: () => now, artifactStore, ingress: createFcIngress({ publicHttpEnabled: true }), generator: async input => {
      modelCalls++; if(modelFault)throw Error('synthetic model interrupted');
      return { sql: referenceSql, model: structuredRequirement?'qwen3-coder-plus':'synthetic-protocol-fixture',
        explanation: 'Local lifecycle fixture, not a real model', usage: { total_tokens: 12 },
        ...(structuredRequirement ? syntheticSqlRequirement(input) : {}) };
    } });
    app.auth.bootstrapAdmin({ email: env.V2_BOOTSTRAP_ADMIN_EMAIL, password: 'SyntheticJourney!2026', displayName: '虚构开发者' });
    const port=stableOrigin && base ? Number(new URL(base).port) : 0;
    await new Promise(r => app.server.listen(port, '127.0.0.1', r)); base = `http://127.0.0.1:${app.server.address().port}/api/v2`;
  };
  const call = async (path, body, key = 'original-pilot-task') => {
    const r = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-shuduo-client': 'workbench', origin: env.V2_PUBLIC_ORIGIN, 'idempotency-key': key, ...(stableOrigin ? {connection:'close'} : {}), ...(cookie ? { cookie, 'x-csrf-token': csrf } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: await r.json(), cookies: r.headers.getSetCookie() };
  };
  const complete = (prepared, measuredResult) => {
    const payload = JSON.parse(prepared.job.body);
    objects.set(prepared.resultKey, JSON.stringify(createQueuedSparkResult(prepared.job, measuredResult ?? {
      status: 'SUCCEEDED', engine: 'Apache Spark', engineVersion: '3.5.9', mainSqlExecuted: true,
      rows: getContext(payload.context.id).expected, durationMs: 100,
      validation: { passed: true, regressions: contextIds.map(contextId => ({ contextId, passed: true })) },
      ...(payload.testSql ? { testSqlValidation: { passed: true, sqlHash: createHash('sha256').update(payload.testSql).digest('hex') } } : {}),
      log: 'Synthetic queue receipt. No real Spark was run.',
    }, config, now)));
  };
  await open();
  const login = await call('/auth/login', { email: env.V2_BOOTSTRAP_ADMIN_EMAIL, password: 'SyntheticJourney!2026' });
  assert.equal(login.status, 200); cookie = login.cookies.map(c => c.split(';')[0]).join('; '); csrf = login.body.csrfToken;
  t.after(async () => { await close(); rmSync(directory, { recursive: true, force: true }); });
  return { call, complete, env, wakes, directory, get base(){return base;}, restart: async () => { await close(); await open(); }, expire: () => { now = Date.parse(env.V2_PUBLIC_DEVELOPMENT_EXPIRES_AT); }, later:ms=>now+=ms,now:()=>now,modelFault:value=>modelFault=value, lose: () => { loseSubmission = true; }, get store() { return store; }, counts: () => ({ modelCalls, jobCreates }),
    loseArtifact:()=>{loseArtifactAcknowledgement=true;}, packageWrites:()=>packageWrites,
    queueCounts:()=>({jobWriteAttempts,cancellationWrites,resultReads}),
    alignWallClock:()=>{now=Date.now();},
    privateCall:async body=>{const r=await fetch(base.replace(/\/api\/v2$/,'')+'/invoke',{method:'POST',headers:{'content-type':'application/octet-stream','x-fc-control-path':'/invoke',...(stableOrigin?{connection:'close'}:{})},body:JSON.stringify(body)});return{status:r.status,body:await r.json()};} };
}
const taskInput = { message: '计算虚构客户总资产，避免现金重复累计。', code: 'SELECT 1', contextId: 'holdings-t1' };

async function subprocessCli(t,f,checkpoint,intercept){
  const requests=[];
  const children=new Set();
  const gate=createServer(async (req,res)=>{
    try {
      const path=req.url.slice('/api/v2'.length);
      const request={method:req.method,path,key:req.headers['idempotency-key']};
      requests.push(request);
      if(req.method==='GET'&&path.startsWith('/open/')){
        // Independent consumers share the checkpoint origin and send only
        // their application credential, without the fixture owner's session.
        const headers=req.headers.authorization?{authorization:req.headers.authorization}:{};
        const response=await fetch(f.base+path,{headers,redirect:'error'});
        res.writeHead(response.status,{'content-type':'application/json'}).end(await response.text());
        return;
      }
      const chunks=[];
      for await(const chunk of req)chunks.push(chunk);
      const body=chunks.length?JSON.parse(Buffer.concat(chunks)):undefined;
      const result=await f.call(path,body,req.headers['idempotency-key']);
      if(await intercept(request,result)===false)return;
      res.writeHead(result.status,{'content-type':'application/json'}).end(JSON.stringify(result.body));
    }catch{
      res.writeHead(500).end('{}');
    }
  });
  await new Promise((resolve,reject)=>{gate.once('error',reject);gate.listen(0,'127.0.0.1',resolve);});
  t.after(async()=>{
    for(const child of children)child.kill('SIGKILL');
    gate.closeAllConnections();
    await new Promise(resolve=>gate.close(resolve));
  });
  const base='http://127.0.0.1:'+gate.address().port+'/api/v2';
  function run(action,flags=[]){
    const child=spawn(process.execPath,['bin/shuduo.mjs','agent',action,'--base-url',base,'--checkpoint',checkpoint,...flags],
      {env:{PATH:process.env.PATH},stdio:['ignore','pipe','pipe']});
    children.add(child);
    let stdout='',stderr='';
    child.stdout.on('data',chunk=>{stdout+=chunk;});child.stderr.on('data',chunk=>{stderr+=chunk;});
    const done=new Promise((resolve,reject)=>{
      child.once('error',reject);
      child.once('close',(code,signal)=>{children.delete(child);resolve({code,signal,stdout,stderr});});
    });
    return {child,done};
  }
  return {base,run,requests};
}

function writeSubprocessBill(path){
  const month=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit'}).format(Date.now());
  writeFileSync(path,JSON.stringify({checkedAt:new Date().toISOString(),unsettledReserveCny:64,maxIncrementCny:2,
    pages:[{Success:true,Data:{PageNum:1,PageSize:300,TotalCount:1,BillingCycle:month,Items:{Item:[{Currency:'CNY',PretaxAmount:'20.00'}]}}}]}),{mode:0o600});
}

test('a killed V3 CLI can only recover the accepted original request under the replacement lock', {timeout:15000}, async t=>{
  const f=await fixture(t,{startupPreflight:true});
  const checkpoint=join(f.directory,'interrupted.json'),billPath=join(f.directory,'bill.json');
  const accepted=Promise.withResolvers(),receivingReceipt=Promise.withResolvers(),sendReceipt=Promise.withResolvers();
  t.after(()=>sendReceipt.resolve());
  const gate=await subprocessCli(t,f,checkpoint,async ({method,path},result)=>{
    if(method==='POST'&&path==='/agent/tasks'){
      accepted.resolve(result);
      return false;
    }
    if(path.startsWith('/agent/requests/')){
      receivingReceipt.resolve();
      await sendReceipt.promise;
    }
  });
  const run=flags=>gate.run('v3-start',flags),requests=gate.requests;
  const prepared=await run(['--source-revision','a'.repeat(40)]).done;
  assert.equal(prepared.code,0,prepared.stderr);
  const originalKey=JSON.parse(readFileSync(checkpoint,'utf8')).outcomes[0].actions.agent.key;
  writeSubprocessBill(billPath);
  const submitting=run(['--bill-file',billPath,'--confirm']);
  const result=await Promise.race([accepted.promise,submitting.done.then(e=>{throw Error('CLI exited before POST was accepted: '+e.stderr);})]);
  assert.equal(result.status,202);
  assert.equal(JSON.parse(readFileSync(checkpoint,'utf8')).outcomes[0].actions.agent.status,'SUBMITTING');
  assert.equal((await run(['--reconcile']).done).code,1,'a live CLI still holds the lock');
  assert.equal(requests.length,2);
  submitting.child.kill('SIGKILL');
  assert.equal((await submitting.done).signal,'SIGKILL');
  const lockPath=checkpoint+'.lock';
  const [abandonedName]=readdirSync(lockPath);
  const abandoned=JSON.parse(readFileSync(join(lockPath,abandonedName),'utf8'));
  assert.equal(abandoned.pid,submitting.child.pid);
  f.expire();
  const blocked=await run(['--bill-file',billPath,'--confirm']).done;
  assert.equal(blocked.code,1,'only reconciliation can recover the abandoned lock');
  assert.equal(requests.length,2);

  const recoveries=[run(['--reconcile']).done,run(['--reconcile']).done];
  try {
    await Promise.race([receivingReceipt.promise,Promise.all(recoveries).then(all=>{
      throw Error('Neither CLI read the original receipt: '+all.map(e=>e.stderr).join(', '));
    })]);
    assert.equal((await Promise.race(recoveries)).code,1,'only one recovery may enter the locked checkpoint');
  }finally{sendReceipt.resolve();}
  const completed=await Promise.all(recoveries);
  assert.deepEqual(completed.map(e=>e.code).sort(),[0,1]);
  const recovered=completed.find(e=>e.code===0);
  assert.equal(JSON.parse(recovered.stdout).taskId,result.body.id);
  const confirmed=JSON.parse(readFileSync(checkpoint,'utf8'));
  const original=confirmed.outcomes[0].actions.agent;
  assert.equal(original.key,originalKey);
  assert.equal(original.id,result.body.id);
  assert.equal(original.status,'CONFIRMED');
  assert.equal(confirmed.submission.bill.unsettledReserveCny,64);
  assert.equal(existsSync(lockPath),false);
  const legacy=JSON.stringify({pid:abandoned.pid});
  writeFileSync(lockPath,legacy,{mode:0o600});
  assert.equal((await run(['--reconcile']).done).code,1);
  assert.equal(readFileSync(lockPath,'utf8'),legacy,'a legacy lock has no boot identity to verify');
  rmSync(lockPath);
  mkdirSync(lockPath,{mode:0o700});
  const foreign=JSON.stringify({...abandoned,scope:'0'.repeat(64)});
  const foreignPath=join(lockPath,abandonedName);
  writeFileSync(foreignPath,foreign,{mode:0o600});
  assert.equal((await run(['--reconcile']).done).code,1);
  assert.equal(readFileSync(foreignPath,'utf8'),foreign,'a lock from a different boot cannot be recovered automatically');
  rmSync(lockPath,{recursive:true});
  assert.equal(JSON.parse((await run(['--reconcile']).done).stdout).taskId,result.body.id);
  assert.deepEqual(requests.map(({method,path})=>[method,path]),[
    ['GET','/status?include=session'],['POST','/agent/tasks'],['GET','/auth/session'],['GET','/agent/requests/'+originalKey],
  ]);
  assert.equal(requests[1].key,originalKey);
  assert.equal(f.store.list('agent',PROJECT).length,1);
  assert.deepEqual(f.counts(),{modelCalls:0,jobCreates:0});
});

test('v3-inspect recovers the same delivery files and rehearsal after CLI termination', {timeout:15000}, async t=>{
  const f=await fixture(t,{startupPreflight:true,structuredRequirement:true,stableOrigin:true});
  const checkpoint=join(f.directory,'delivery-interruption.json'),billPath=join(f.directory,'bill.json');
  const deliveryAccepted=Promise.withResolvers(),rehearsalAccepted=Promise.withResolvers();
  const {run,requests}=await subprocessCli(t,f,checkpoint,({method,path},result)=>{
    if(method!=='POST')return;
    if(path.endsWith('/prepare-delivery'))deliveryAccepted.resolve(result);
    else if(path.startsWith('/agent/deliveries/')&&path.endsWith('/advance'))rehearsalAccepted.resolve(result);
    else return;
    return false;
  });
  async function cli(action,flags=[]){
    const completed=await run(action,flags).done;
    assert.equal(completed.code,0,completed.stderr);
    return JSON.parse(completed.stdout);
  }
  async function stopAfterAcceptance(action,accepted,expectedStatus,phase){
    const submitting=run(action,confirm);
    const response=await Promise.race([accepted.promise,submitting.done.then(e=>{
      throw Error(action+' exited before the application accepted its request: '+e.stderr);
    })]);
    assert.equal(response.status,expectedStatus);
    const before=readFileSync(checkpoint,'utf8');
    assert.equal(JSON.parse(before).outcomes[0].actions[phase].status,'SUBMITTING');
    const beforeInspect=requests.length;
    assert.equal((await run('v3-inspect').done).code,1);
    assert.equal(requests.length,beforeInspect);
    submitting.child.kill('SIGKILL');
    assert.equal((await submitting.done).signal,'SIGKILL');
    assert.equal(readFileSync(checkpoint,'utf8'),before);
    assert.ok(existsSync(checkpoint+'.lock'));
    return response.body;
  }
  writeSubprocessBill(billPath);
  const confirm=['--bill-file',billPath,'--confirm'];
  await cli('v3-start',['--source-revision','a'.repeat(40)]);
  const {taskId}=await cli('v3-start',confirm);
  const taskPath='/agent/tasks/'+taskId;
  const advance=async task=>(await f.call(taskPath+'/advance',{expectedVersion:task.version})).body;
  let task=(await f.call(taskPath)).body;
  task=await advance(await advance(task));
  f.complete(f.store.get('run',task.runId,PROJECT).remoteSubmission.prepared);
  task=await advance(task);
  assert.equal(task.status,'SUCCEEDED');
  assert.equal((await cli('v3-inspect')).status,'DEVELOPMENT_BOUND');

  const accepted=await stopAfterAcceptance('v3-prepare-delivery',deliveryAccepted,202,'delivery');
  assert.equal(accepted.stage,'PACKAGE_READY');
  const deliveryKey=JSON.parse(readFileSync(checkpoint,'utf8')).outcomes[0].actions.delivery.key;
  const bundle=f.store.get('delivery_package',accepted.packageId,PROJECT);
  const artifactPath=join(f.directory,'artifacts',bundle.artifact.key);
  const artifact=readFileSync(artifactPath);
  assert.equal(createHash('sha256').update(artifact).digest('hex'),bundle.artifact.contentHash);
  validateDeliveryPackage(JSON.parse(artifact),accepted.packageDigest);
  assert.equal(Object.keys(bundle.files).length,8);
  await f.restart();
  const offset=requests.length;
  const recovered=await cli('v3-inspect');
  assert.equal(recovered.delivery.id,accepted.id);
  assert.equal(recovered.delivery.packageId,accepted.packageId);
  assert.equal(recovered.delivery.packageDigest,accepted.packageDigest);
  assert.deepEqual(requests.slice(offset).map(({method})=>method),['GET','GET','GET']);
  assert.equal(requests.at(-1).path,taskPath+'/delivery-requests/'+deliveryKey);
  assert.equal((await cli('v3-prepare-delivery',confirm)).reason,'INSPECT_ORIGINAL_DELIVERY');
  assert.equal(requests.length,offset+3);

  const started=await stopAfterAcceptance('v3-rehearse',rehearsalAccepted,200,'rehearsal');
  const verification=f.store.get('delivery_verification',started.verificationId,PROJECT);
  assert.equal(verification.status,'RUNNING');
  const queued=f.store.get('agent_delivery_task',accepted.id,PROJECT).remoteSubmission.prepared;
  assert.equal(queued.job.jobId,verification.id);
  await f.restart();
  f.complete(queued);
  const settling=await f.call('/agent/deliveries/'+accepted.id+'/advance',{
    expectedVersion:started.version,rehearsal:{packageId:accepted.packageId,packageDigest:accepted.packageDigest,verificationId:verification.id},
  });
  assert.equal(settling.body.stage,'AWAITING_ENGINEER_REVIEW');
  f.expire();
  const queueBefore=f.queueCounts(), lastOffset=requests.length;
  const final=await cli('v3-inspect');
  assert.equal(final.delivery.packageDigest,accepted.packageDigest);
  assert.equal(final.delivery.rehearsal.id,verification.id);
  assert.equal(final.delivery.rehearsal.status,'SUCCEEDED');
  assert.equal(final.delivery.rehearsal.reservedDurationMs,verification.reservedDurationMs);
  assert.deepEqual(requests.slice(lastOffset).map(({method})=>method),['GET','GET','GET']);
  assert.equal(requests.at(-1).path,taskPath+'/delivery-requests/'+deliveryKey);
  assert.equal((await cli('v3-rehearse',confirm)).reason,'INSPECT_ORIGINAL_REHEARSAL');
  assert.equal(requests.length,lastOffset+3);
  const [saved]=JSON.parse(readFileSync(checkpoint,'utf8')).outcomes;
  assert.equal(saved.actions.delivery.key,deliveryKey);
  assert.equal(saved.actions.delivery.bill.unsettledReserveCny,64);
  assert.equal(saved.actions.rehearsal.bill.unsettledReserveCny,64);
  assert.equal(saved.actions.rehearsal.id,verification.id);
  assert.deepEqual(readFileSync(artifactPath),artifact);
  assert.equal(f.packageWrites(),1);
  assert.equal(f.store.list('agent_delivery_task',PROJECT).length,1);
  assert.equal(f.store.list('delivery_verification',PROJECT).length,1);
  assert.deepEqual(f.queueCounts(),queueBefore);
  assert.deepEqual(f.counts(),{modelCalls:1,jobCreates:2});
  assert.deepEqual(requests.filter(r=>r.method==='POST').map(r=>r.path),
    ['/agent/tasks',taskPath+'/prepare-delivery','/agent/deliveries/'+accepted.id+'/advance']);
  assert.equal(existsSync(checkpoint+'.lock'),false);
});

async function measuredSpark(t,f,prepared,label){
  const input=JSON.parse(prepared.job.body);
  const result=await runSpark(input,{...runtimeConfig({}),artifactRoot:f.directory,retainArtifacts:false});
  assert.equal(result.status,'SUCCEEDED');
  assert.equal(result.engineVersion,'3.5.9');
  assert.equal(result.mainSqlExecuted,true);
  assert.equal(result.testSqlValidation?.passed,true);
  assert.equal(result.validation?.regressions.length,5);
  assert.ok(result.validation.regressions.every(check=>check.passed===true));
  t.diagnostic(`Local Spark ${result.engineVersion}, ${label}, five independent scenarios, ${result.durationMs} ms`);
  return result;
}

async function consumeOriginalBatch(f,cli,{taskId,releaseId,packageDigest,batchId,sequence,origin}){
  const [holdingsSpec,cashSpec]=[
    {name:'虚构持仓原批次 '+sequence,slug:'verified-holdings-'+sequence,
      fields:['client_id','holding_market_value','security_count'],timeoutMs:3000,rateLimitPerMinute:12},
    {name:'虚构现金原批次 '+sequence,slug:'verified-cash-'+sequence,
      fields:['client_id','available_cash','total_assets'],timeoutMs:3000,rateLimitPerMinute:12},
  ];
  const xapiSpec={name:'虚构资产组合原批次 '+sequence,slug:'verified-assets-'+sequence,timeoutMs:3000,rateLimitPerMinute:6,
    steps:[{alias:'holdings',dapiSlug:holdingsSpec.slug},{alias:'cash',dapiSlug:cashSpec.slug}]};
  const applicationName='原批次独立验收应用 '+sequence;
  f.alignWallClock();
  Object.assign(f.env,{V2_PRIVATE_DATA_SERVICES_ENABLED:'true',V2_FC_PUBLIC_WRITE_SCOPE:'SERVICE_CONSUMPTION_ONLY',
    V2_PUBLIC_SERVICE_STARTS_AT:new Date(f.now()-1000).toISOString(),V2_PUBLIC_SERVICE_EXPIRES_AT:new Date(f.now()+60000).toISOString(),
    V2_PUBLIC_SERVICE_PLAN:JSON.stringify({taskId,packageDigest,sourceReleaseRunId:batchId,dapis:[holdingsSpec,cashSpec],xapi:xapiSpec,applicationName})});
  await f.restart();
  const sourceFile=join(f.directory,'consumer-source-'+sequence+'.json');
  assert.equal((await cli('v3-consumption',['--batch-id',batchId,'--out-file',sourceFile])).status,'CONSUMPTION_SOURCE_READY');
  assert.equal(statSync(sourceFile).mode&0o777,0o600);
  const source=JSON.parse(readFileSync(sourceFile,'utf8'));
  assert.equal(source.releaseId,releaseId);
  assert.equal(source.sourceReleaseRunId,batchId);
  async function createService(type,body){
    const made=await f.call('/data-services/'+type,body,randomUUID());
    assert.equal(made.status,201,JSON.stringify({code:made.body.code,message:made.body.message}));
    const path='/data-services/'+type+'/'+made.body.id;
    assert.equal((await f.call(path+'/test',{})).status,200);
    const published=await f.call(path+'/publish',{configHash:made.body.currentVersion.configHash});
    assert.equal(published.status,200);
    return made.body;
  }
  const holdings=await createService('dapis',{...holdingsSpec,sourceReleaseRunId:batchId});
  const cash=await createService('dapis',{...cashSpec,sourceReleaseRunId:batchId});
  const xapi=await createService('xapis',{...xapiSpec,steps:[{alias:'holdings',dapiId:holdings.id,dapiVersionId:holdings.currentVersion.id},
    {alias:'cash',dapiId:cash.id,dapiVersionId:cash.currentVersion.id}]});
  const app=await f.call('/data-services/applications',{name:applicationName,serviceIds:[holdings.id,xapi.id]},randomUUID());
  assert.equal(app.status,201);
  const tokenFile=join(f.directory,'consumer-token-'+sequence),planFile=join(f.directory,'consumer-plan-'+sequence+'.json');
  const reportFile=join(f.directory,'consumer-report-'+sequence+'.json');
  writeFileSync(tokenFile,app.body.token,{mode:0o600});
  const describe=service=>({id:service.id,slug:service.slug,versionId:service.currentVersion.id,configHash:service.currentVersion.configHash});
  // Literal expectations were declared independently of Spark and HTTP output.
  const expectedRows=[{client_id:'CLIENT-001',holding_market_value:'1500.00',available_cash:'300.00',total_assets:'1800.00',security_count:2},
    {client_id:'CLIENT-002',holding_market_value:'750.00',available_cash:'200.00',total_assets:'950.00',security_count:1}];
  const plan={protocol:'SERVICE_CONSUMER_V2',authorized:true,testOnly:true,privateFixture:true,origin,approvedOrigin:origin,
    startedAt:new Date(f.now()-1000).toISOString(),deadline:new Date(f.now()+50000).toISOString(),timeoutMs:5000,maxRequests:20,
    reportFile,expectedRows,source,dapis:[{...describe(holdings),alias:'holdings',fields:holdingsSpec.fields,granted:true},
      {...describe(cash),alias:'cash',fields:cashSpec.fields,granted:false}],xapi:describe(xapi),
    ungranted:{type:'DAPI',slug:cash.slug},rateLimit:{serviceId:xapi.id,perMinute:6}};
  writeFileSync(planFile,JSON.stringify(plan),{mode:0o600});
  assert.equal((await runConsumerAcceptance({planFile,tokenFile,execute:true})).result,'PASSED');
  assert.equal((await f.call('/data-services/applications/'+app.body.application.id+'/revoke',{})).status,200);
  assert.equal((await runConsumerAcceptance({planFile,tokenFile,execute:true,phase:'revoked'})).result,'PASSED');
  const report=JSON.parse(readFileSync(reportFile,'utf8'));
  assert.equal(report.requestCount,15);
  assert.deepEqual(report.phases,{consume:'PASSED',revoked:'PASSED'});
  const dapiCall=report.requests.find(row=>row.type==='DAPI'&&row.statusCode===200);
  const xapiCall=report.requests.find(row=>row.type==='XAPI'&&row.statusCode===200);
  const flags=['--plan',planFile,'--call-id-digest',xapiCall.callIdDigest];
  const storedCalls=f.store.list('service_call',PROJECT).length;
  const bound=await cli('v3-consumption',flags);
  assert.equal(bound.status,'CONSUMPTION_BOUND',bound.reason);
  assert.equal(bound.consumption.status,'MATCHED_ONLY');
  assert.equal(bound.consumption.dapiCallIdDigest,dapiCall.callIdDigest);
  assert.equal(bound.consumption.xapiCallIdDigest,xapiCall.callIdDigest);
  assert.equal(bound.agentIndependentE2E,false);
  assert.equal(f.store.list('service_call',PROJECT).length,storedCalls);
  assert.ok(!JSON.stringify(bound).includes(app.body.token));
  const missing=structuredClone(report);
  missing.requests[dapiCall.sequence-1].callIdDigest='a'.repeat(64);
  writeFileSync(reportFile,JSON.stringify(missing));
  const missingProof=await cli('v3-consumption',flags);
  assert.equal(missingProof.status,'CONSUMPTION_UNCONFIRMED');
  assert.equal(missingProof.reason,'DAPI_RECEIPT_INVALID');
  assert.equal(f.store.list('service_call',PROJECT).length,storedCalls);
  writeFileSync(reportFile,JSON.stringify(report));
  const altered=structuredClone(plan);altered.expectedRows[0].total_assets='1.00';
  writeFileSync(planFile,JSON.stringify(altered));
  await cli('v3-consumption',flags,1);
  writeFileSync(planFile,JSON.stringify(plan));
  return {bound,flags};
}

test('cloud v3 startup saves the original key before one POST and reconciles a lost receipt by GET',async t=>{
  const f=await fixture(t,{startupPreflight:true});
  const checkpoint=join(f.directory,'first-v3-checkpoint.json'),billPath=join(f.directory,'bill.json'),
    windowPath=join(f.directory,'opened-window.json'),sessionFile=join(f.directory,'session.json'),reads=[];
  const source='a'.repeat(40), approvalDigest='d'.repeat(64);
  const baseUrl='https://journey.example.invalid/api/v2';
  writeFileSync(sessionFile,JSON.stringify({protocol:'shuduo-invite-session/v1',apiBaseUrl:baseUrl,projectId:PROJECT,
    cookie:'shuduo_session=fictional-session-placeholder',csrfToken:'fictional-csrf-placeholder',
    expiresAt:f.env.V2_PUBLIC_DEVELOPMENT_EXPIRES_AT}),{mode:0o600});
  let originalKey, hideReceipt=false, differentActor=false, missingUsage=false;
  const client=new V2Client({baseUrl,sessionFile,fetchImpl:async(url,options)=>{
    const target=new URL(url), path=target.pathname.slice('/api/v2'.length)+target.search;
    reads.push({path,method:options.method});
    if(options.method==='POST'){
      const saved=JSON.parse(readFileSync(checkpoint,'utf8'));
      assert.equal(saved.outcomes[0].actions.agent.status,'SUBMITTING');
      assert.equal(saved.outcomes[0].actions.agent.key,originalKey);
      assert.equal(options.headers['Idempotency-Key'],originalKey);
      assert.equal(saved.reviewedSource,source);
      assert.equal(saved.submission.bill.unsettledReserveCny,64);
      assert.equal(saved.submission.usage.modelCalls,0);
      assert.equal(saved.submission.windowApprovalDigest,approvalDigest);
      const body=JSON.parse(options.body);
      assert.deepEqual(Object.keys(body),['message','sql','contextId']);
      assert.equal((await f.call(path,body,originalKey)).status,202);
      throw Error('SYNTHETIC_CREATE_RESPONSE_LOST');
    }
    assert.equal(options.body,undefined);
    if(hideReceipt&&path.startsWith('/agent/requests/'))return new Response('{}',{status:404});
    const response=await f.call(path);
    if(differentActor&&path==='/auth/session')response.body.user.id=randomUUID();
    if(missingUsage&&path==='/status?include=session')delete response.body.status.budget.model.recordedCalls;
    return new Response(JSON.stringify(response.body),{status:response.status});
  }});
  const cli=async(flags,expectedExit=0)=>{
    reads.length=0;
    let value;
    assert.equal(await runV2Cli(['agent','v3-start','--checkpoint',checkpoint,...flags],{},
      {client,output:line=>{value=JSON.parse(line);},error:()=>{}}),expectedExit);
    return value;
  };
  const prepared=await cli(['--source-revision',source]);
  assert.equal(prepared.status,'PREPARED');
  assert.equal(prepared.expectedCaseCount,20);
  assert.deepEqual(reads,[]);
  assert.equal(statSync(checkpoint).mode&0o777,0o600);
  const preparedBytes=readFileSync(checkpoint,'utf8');
  originalKey=JSON.parse(preparedBytes).outcomes[0].actions.agent.key;
  assert.ok(!JSON.stringify(prepared).includes(originalKey));
  const binding=await cli(['--window-binding']);
  const sha=value=>createHash('sha256').update(value).digest('hex');
  assert.deepEqual(reads,[]);
  assert.equal(binding.checkpointDigest,sha(preparedBytes));
  assert.equal(binding.requestKeyHash,sha(originalKey));
  assert.ok(!JSON.stringify(binding).includes(originalKey));
  await cli(['--source-revision',source],1);
  assert.equal(readFileSync(checkpoint,'utf8'),preparedBytes);
  const month=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit'}).format(Date.now());
  const writeBill=amount=>writeFileSync(billPath,JSON.stringify({checkedAt:new Date().toISOString(),unsettledReserveCny:64,maxIncrementCny:2,
    pages:[{Success:true,Data:{PageNum:1,PageSize:300,TotalCount:1,BillingCycle:month,Items:{Item:[{Currency:'CNY',PretaxAmount:amount}]}}}]}),{mode:0o600});
  const startsAt=f.env.V2_PUBLIC_DEVELOPMENT_STARTS_AT, expiresAt=f.env.V2_PUBLIC_DEVELOPMENT_EXPIRES_AT;
  const window={protocol:'SHUDUO_FIRST_V3_WINDOW_RECEIPT_V1',checkpoint:binding,approvalDigest,startsAt,expiresAt,
    bill:{month,checkedAt:startsAt,spendCny:20,recordCount:1,pagesDigest:'e'.repeat(64),unsettledReserveCny:64,maxIncrementCny:2}};
  const writeWindow=value=>writeFileSync(windowPath,JSON.stringify(value),{mode:0o600});
  const confirmedFlags=['--window-file',windowPath,'--bill-file',billPath,'--confirm'];
  writeWindow(window);
  writeBill('134.00');
  await cli(confirmedFlags,1);
  assert.deepEqual(reads,[]);
  assert.equal(readFileSync(checkpoint,'utf8'),preparedBytes);
  assert.equal(f.store.list('agent',PROJECT).length,0);
  writeBill('20.00');
  await cli(['--bill-file',billPath,'--confirm'],1);
  assert.deepEqual(reads,[]);
  for(const alter of [v=>v.bill.unsettledReserveCny=0,v=>v.checkpoint.requestKeyHash='f'.repeat(64),v=>v.bill.spendCny=134]){
    const changed=structuredClone(window);alter(changed);writeWindow(changed);
    await cli(confirmedFlags,1);
    assert.deepEqual(reads,[]);
  }
  writeWindow({...window,expiresAt:new Date(Date.parse(expiresAt)+1).toISOString()});
  await cli(confirmedFlags,1);
  assert.deepEqual(reads,[{path:'/status?include=session',method:'GET'}]);
  writeWindow(window);
  client.projectId='different-project';
  await cli(confirmedFlags,1);
  assert.deepEqual(reads,[]);
  client.projectId=PROJECT;
  missingUsage=true;
  await cli(confirmedFlags,1);
  assert.deepEqual(reads,[{path:'/status?include=session',method:'GET'}]);
  assert.equal(readFileSync(checkpoint,'utf8'),preparedBytes);
  missingUsage=false;
  const unknown=await cli(confirmedFlags);
  assert.equal(unknown.reason,'RECONCILE_ORIGINAL_CREATION');
  assert.deepEqual(reads.map(read=>read.method),['GET','POST']);
  assert.equal(f.store.list('agent',PROJECT).length,1);
  const unknownBytes=readFileSync(checkpoint,'utf8');
  assert.equal(JSON.parse(unknownBytes).outcomes[0].actions.agent.status,'UNKNOWN');
  assert.equal((await cli(confirmedFlags)).reason,'RECONCILE_ORIGINAL_CREATION');
  assert.deepEqual(reads,[]);
  assert.equal(readFileSync(checkpoint,'utf8'),unknownBytes);

  f.expire();
  differentActor=true;
  await cli(['--reconcile'],1);
  assert.deepEqual(reads,[{path:'/auth/session',method:'GET'}]);
  differentActor=false;
  hideReceipt=true;
  assert.equal((await cli(['--reconcile'])).reason,'ORIGINAL_CREATION_UNCONFIRMED');
  const originalReads=[{path:'/auth/session',method:'GET'},{path:'/agent/requests/'+originalKey,method:'GET'}];
  assert.deepEqual(reads,originalReads);
  assert.equal(readFileSync(checkpoint,'utf8'),unknownBytes);
  hideReceipt=false;
  const recovered=await cli(['--reconcile']);
  assert.equal(recovered.status,'CREATION_CONFIRMED');
  assert.deepEqual(reads,originalReads);
  const [task]=f.store.list('agent',PROJECT);
  assert.equal(recovered.taskId,task.id);
  const state=JSON.parse(readFileSync(checkpoint,'utf8'));
  assert.equal(state.outcomes[0].actions.agent.id,task.id);
  assert.equal(state.outcomes[0].actions.agent.key,originalKey);
  assert.equal(state.reviewedSource,source);
  assert.equal(state.submission.bill.unsettledReserveCny,64);
  assert.deepEqual(f.counts(),{modelCalls:0,jobCreates:0});
  assert.ok(!JSON.stringify(recovered).includes(originalKey));

  const evidencePath='/agent/requests/'+originalKey+'/execution-evidence';
  const inspect=async()=>{
    reads.length=0;
    let value;
    assert.equal(await runV2Cli(['agent','v3-inspect','--checkpoint',checkpoint],{},
      {client,output:line=>{value=JSON.parse(line);},error:()=>{}}),0);
    assert.deepEqual(reads,[{path:'/auth/session',method:'GET'},{path:evidencePath,method:'GET'}]);
    return value;
  };
  const confirmedBytes=readFileSync(checkpoint,'utf8');
  const queued=await inspect();
  assert.equal(queued.status,'EXECUTION_RECORDED');
  assert.equal(queued.execution.model.state,'READY');
  assert.equal(queued.execution.spark.state,'NOT_LINKED');
  f.store.update('agent',task.id,PROJECT,{status:'RUNNING',stage:'MODEL_OUTCOME_UNKNOWN',usedTokens:180,
    attempts:[{status:'MODEL_OUTCOME_UNKNOWN',model:'unconfirmed',usageEstimated:true,usage:{total_tokens:180}}]});
  const paused=await inspect();
  assert.deepEqual(paused.execution.model,{state:'OUTCOME_UNKNOWN',usage:'PENDING',attempts:1,unconfirmedAttempts:1,
    ledgerTokens:180,reportedTokens:0,reservedTokens:180,unattributedTokens:0});
  assert.equal(readFileSync(checkpoint,'utf8'),confirmedBytes);
  assert.deepEqual(f.counts(),{modelCalls:0,jobCreates:0});
});

test('a killed publication CLI recovers both original batches through signed scheduling and authorized consumption',async t=>{
  // Local HTTP, real local artifact I/O, synthetic provider and Worker receipts.
  const f=await fixture(t,{startupPreflight:true,structuredRequirement:true,stableOrigin:true,queueTimeoutMs:30000});
  const checkpoint=join(f.directory,'exact-delivery.json'),billPath=join(f.directory,'current-bill.json'),requests=[];
  const month=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit'}).format(Date.now());
  const writeBill=unsettledReserveCny=>writeFileSync(billPath,JSON.stringify({checkedAt:new Date().toISOString(),unsettledReserveCny,maxIncrementCny:2,
    pages:[{Success:true,Data:{PageNum:1,PageSize:300,TotalCount:1,BillingCycle:month,Items:{Item:[{Currency:'CNY',PretaxAmount:'20.00'}]}}}]}),{mode:0o600});
  writeBill(64);
  let savedAtDeliveryPost;
  let savedAtRehearsalPost;
  const publicationAccepted=Promise.withResolvers();
  const publicationCli=await subprocessCli(t,f,checkpoint,(request,response)=>{
    if(request.method!=='POST'||!request.path.endsWith('/publication'))return;
    publicationAccepted.resolve({request,response});
    return false;
  });
  const client=new V2Client({baseUrl:publicationCli.base,fetchImpl:async(url,options)=>{
    const target=new URL(url), path=target.pathname.slice('/api/v2'.length)+target.search;
    const body=options.body?JSON.parse(options.body):undefined, key=options.headers['Idempotency-Key'];
    requests.push({path,method:options.method});
    if(path.endsWith('/prepare-delivery')){
      const [item]=JSON.parse(readFileSync(checkpoint,'utf8')).outcomes;
      savedAtDeliveryPost={...item.actions.delivery, postedKey:key, postedBody:body};
    }
    if(path.startsWith('/agent/deliveries/')&&path.endsWith('/advance')&&body?.rehearsal&&!body.rehearsal.verificationId)
      savedAtRehearsalPost=JSON.parse(readFileSync(checkpoint,'utf8')).outcomes[0].actions.rehearsal;
    const response=await f.call(path,body,key);
    return new Response(JSON.stringify(response.body),{status:response.status});
  }});
  const cli=async(action,flags=[],exit=0)=>{
    requests.length=0;
    let value;
    assert.equal(await runV2Cli(['agent',action,'--checkpoint',checkpoint,...flags],{},
      {client,output:line=>{value=JSON.parse(line);},error:()=>{}}),exit);
    return value;
  };
  const confirm=['--bill-file',billPath,'--confirm'];
  await cli('v3-start',['--source-revision','a'.repeat(40)]);
  const created=await cli('v3-start',confirm);
  assert.equal(created.status,'CREATION_CONFIRMED');
  const taskPath='/agent/tasks/'+created.taskId, advance=task=>f.call(taskPath+'/advance',{expectedVersion:task.version});
  let task=(await f.call(taskPath)).body;
  task=(await advance(task)).body;
  task=(await advance(task)).body;
  const prepared=f.store.get('run',task.runId,PROJECT).remoteSubmission.prepared;
  f.complete(prepared);
  task=(await advance(task)).body;
  assert.equal(task.status,'SUCCEEDED');
  const inspected=await cli('v3-inspect');
  assert.equal(inspected.status,'DEVELOPMENT_BOUND');
  const initialBytes=readFileSync(checkpoint,'utf8'), [bound]=JSON.parse(initialBytes).outcomes;
  assert.equal(task.requirements.status,'MODEL_PROPOSED');
  assert.equal(bound.code.requirementBinding.taskId,task.id);
  const source={revisionId:bound.code.revisionId,revisionHash:bound.code.revisionHash,runId:bound.code.runId,
    requirementBinding:bound.code.requirementBinding};
  const preparePath=taskPath+'/prepare-delivery';
  assert.equal((await f.call(preparePath,{expectedSource:{...source,runId:randomUUID()}},randomUUID())).status,409);
  assert.equal((await f.call(preparePath,{expectedSource:{...source,requirementBinding:{protocol:'shuduo-sql-requirements/v1',
    taskId:task.id,basisDigest:'a'.repeat(64),reportDigest:'b'.repeat(64)}}},randomUUID())).status,409);
  assert.equal(f.store.list('agent_delivery_task',PROJECT).length,0);
  assert.equal(f.packageWrites(),0);
  writeBill(63);
  await cli('v3-prepare-delivery',confirm,1);
  assert.deepEqual(requests,[]);
  assert.equal(readFileSync(checkpoint,'utf8'),initialBytes);
  writeBill(64);
  f.loseArtifact();
  const unknown=await cli('v3-prepare-delivery',confirm);
  assert.equal(unknown.reason,'INSPECT_ORIGINAL_DELIVERY');
  assert.deepEqual(requests,[{path:'/auth/session',method:'GET'},{path:preparePath,method:'POST'}]);
  assert.equal(savedAtDeliveryPost.status,'SUBMITTING');
  assert.equal(savedAtDeliveryPost.key,savedAtDeliveryPost.postedKey);
  assert.deepEqual(savedAtDeliveryPost.postedBody,{expectedSource:source});
  assert.equal(savedAtDeliveryPost.bodyHash,createHash('sha256').update(JSON.stringify(savedAtDeliveryPost.postedBody)).digest('hex'));
  assert.equal(savedAtDeliveryPost.bill.unsettledReserveCny,64);
  assert.equal((await cli('v3-prepare-delivery',confirm)).reason,'INSPECT_ORIGINAL_DELIVERY');
  assert.deepEqual(requests,[]);
  const [pending]=f.store.list('agent_delivery_task',PROJECT);
  assert.equal(pending.stage,'PACKAGE_PERSISTING');
  assert.equal(f.packageWrites(),1);
  assert.equal(f.store.list('delivery_verification',PROJECT).length,0);
  await f.restart();
  const recovered=await cli('v3-inspect');
  assert.equal(recovered.delivery.id,pending.id);
  assert.equal(recovered.delivery.packageDigest,pending.packageDigest);
  assert.equal(recovered.delivery.version,pending.version);
  assert.equal(recovered.delivery.storagePending,true);
  assert.ok(requests.every(request=>request.method==='GET'));
  assert.equal(f.packageWrites(),1);
  const finished=(await f.call('/agent/deliveries/'+pending.id+'/advance',{expectedVersion:pending.version})).body;
  assert.equal(finished.stage,'PACKAGE_READY');
  assert.equal(finished.id,pending.id);
  assert.equal(finished.packageId,pending.packageId);
  assert.equal(finished.packageDigest,pending.packageDigest);
  const bundle=f.store.get('delivery_package',finished.packageId,PROJECT);
  assert.equal(Object.keys(bundle.files).length,8);
  assert.equal(bundle.manifest.source.revisionId,source.revisionId);
  assert.equal(bundle.manifest.source.runId,source.runId);
  assert.deepEqual(bundle.manifest.source.requirement,source.requirementBinding);
  const artifact=readFileSync(join(f.directory,'artifacts',bundle.artifact.key),'utf8');
  assert.equal(createHash('sha256').update(artifact).digest('hex'),bundle.artifact.contentHash);
  assert.deepEqual(JSON.parse(artifact).files,bundle.files);
  assert.equal(f.store.list('delivery_package',PROJECT).length,1);
  assert.equal(f.store.list('delivery_verification',PROJECT).length,0);
  assert.deepEqual(f.counts(),{modelCalls:1,jobCreates:1});
  const rehearsalPath='/agent/deliveries/'+pending.id+'/advance';
  const exact={packageId:pending.packageId,packageDigest:pending.packageDigest};
  assert.equal((await f.call(rehearsalPath,{expectedVersion:finished.version,rehearsal:{...exact,packageDigest:'a'.repeat(64)}})).status,409);
  assert.equal(f.store.list('delivery_verification',PROJECT).length,0);
  writeBill(63);
  await cli('v3-rehearse',confirm,1);
  assert.deepEqual(requests,[]);
  writeBill(64);
  f.lose();
  const started=await cli('v3-rehearse',confirm);
  assert.equal(started.reason,'INSPECT_ORIGINAL_REHEARSAL');
  assert.equal(savedAtRehearsalPost.status,'SUBMITTING');
  assert.equal(savedAtRehearsalPost.expectedVersion,finished.version);
  assert.equal(savedAtRehearsalPost.usage.remoteSparkRuns,1);
  assert.equal(savedAtRehearsalPost.bill.unsettledReserveCny,64);
  assert.equal(requests.filter(request=>request.method==='POST').length,1);
  assert.equal((await cli('v3-rehearse',confirm)).reason,'INSPECT_ORIGINAL_REHEARSAL');
  assert.deepEqual(requests,[]);
  const [verification]=f.store.list('delivery_verification',PROJECT);
  const queued=f.store.get('agent_delivery_task',pending.id,PROJECT).remoteSubmission.prepared;
  const budgetBefore=(await f.call('/status')).body.budget.remoteSpark;
  assert.equal(queued.job.jobId,verification.id);
  assert.equal(verification.reservedDurationMs,30000);
  assert.equal(budgetBefore.runCount,2);
  assert.ok(budgetBefore.seconds>=30);
  await f.restart();
  f.later(181000);
  const readsBefore=f.queueCounts();
  const unconfirmed=(await cli('v3-inspect')).delivery.rehearsal;
  assert.equal(unconfirmed.id,verification.id);
  assert.equal(unconfirmed.stage,'FILE_REHEARSAL_SUBMITTING');
  assert.equal(unconfirmed.reservedDurationMs,30000);
  assert.deepEqual(f.queueCounts(),readsBefore);
  const deliveryVersion=f.store.get('agent_delivery_task',pending.id,PROJECT).version;
  assert.equal((await f.call(rehearsalPath,{expectedVersion:deliveryVersion,rehearsal:{...exact,verificationId:randomUUID()}})).status,409);
  assert.deepEqual(f.queueCounts(),readsBefore);
  const absent=(await cli('v3-rehearse',['--settle'])).delivery.rehearsal;
  assert.deepEqual(absent,unconfirmed);
  assert.deepEqual((await f.call('/status')).body.budget.remoteSpark,budgetBefore);
  assert.deepEqual(f.queueCounts(),{...readsBefore,resultReads:readsBefore.resultReads+1});
  const measuredResult=process.env.SHUDUO_TEST_LOCAL_SPARK_REHEARSAL==='true' ? await measuredSpark(t,f,queued,'one rehearsal') : undefined;
  f.complete(queued,measuredResult);
  assert.equal((await f.call('/agent/deliveries/'+pending.id)).body.rehearsal.status,'RUNNING');
  assert.equal((await f.call(taskPath+'/workflow')).body.delivery.status,'RUNNING');
  assert.equal((await cli('v3-review')).reason,'CLOUD_REHEARSAL_PENDING');
  assert.equal(f.queueCounts().resultReads,readsBefore.resultReads+1);
  const verified=await cli('v3-rehearse',['--settle']);
  assert.equal(verified.delivery.rehearsal.id,verification.id);
  assert.equal(verified.delivery.rehearsal.stage,'AWAITING_ENGINEER_REVIEW');
  assert.equal(verified.delivery.rehearsal.durationMs,measuredResult?.durationMs ?? 100);
  assert.equal(verified.delivery.packageDigest,pending.packageDigest);
  assert.equal(f.store.list('delivery_verification',PROJECT).length,1);
  assert.equal(f.queueCounts().jobWriteAttempts,2);
  assert.equal(f.queueCounts().cancellationWrites,0);
  assert.equal(f.store.list('release_approval',PROJECT).length,0);
  f.expire();
  assert.equal((await cli('v3-review')).status,'REVIEW_EVIDENCE_BOUND');
  assert.equal((await cli('v3-inspect')).delivery.rehearsal.id,verification.id);
  assert.equal((await cli('v3-inspect')).delivery.storagePending,undefined);
  assert.ok(!JSON.stringify(recovered).includes(savedAtDeliveryPost.key));

  const reviewPath=join(f.directory,'publication-review.json');
  const preflightQueue=f.queueCounts();
  const exported=await cli('v3-publication-review',['--out-file',reviewPath]);
  assert.equal(exported.status,'REVIEW_FILE_READY');
  assert.equal(exported.approvalRecorded,false);
  assert.equal(exported.schedulerAvailable,false);
  assert.ok(requests.every(request=>request.method==='GET'));
  assert.equal(statSync(reviewPath).mode&0o777,0o600);
  const draft=JSON.parse(readFileSync(reviewPath,'utf8'));
  assert.deepEqual(draft.package.files,bundle.files);
  assert.equal(draft.basis.evidence.delivery.verificationId,verification.id);
  assert.ok(Object.values(draft.attestations).every(value=>value===false));
  assert.deepEqual(f.queueCounts(),preflightQueue);
  assert.equal(f.store.list('release_approval',PROJECT).length,0);
  const selector={sourceKind:'AGENT',sourceRunId:source.runId,packageDigest:pending.packageDigest,verificationId:verification.id};
  const proofPath=publicationPreflightPath(task.id,selector);
  const privateProof={operation:'PRIVATE_APPLICATION_HTTP_V1',method:'GET',path:'/api/v2'+proofPath};
  assert.equal(validatePrivateApplicationRequest(privateProof,{allowDurableAgentRead:true}).path,privateProof.path);
  assert.throws(()=>validatePrivateApplicationRequest({...privateProof,method:'POST',body:{}},{allowDurableAgent:true}));
  assert.equal((await f.call(proofPath+'&sourceRunId='+source.runId)).status,422);
  const publishFlags=['--review-file',reviewPath,...confirm];
  await cli('v3-publish',publishFlags,1);
  assert.deepEqual(requests,[]);
  const reviewed={...draft,attestations:{code:true,assertions:true,deliveryFiles:true,cloudScope:true}};
  const publicationBody={...selector,reviewDigest:reviewed.reviewDigest,attestations:reviewed.attestations};
  assert.equal((await f.call(taskPath+'/publication',publicationBody,randomUUID())).status,403);
  Object.assign(f.env,{
    V2_FC_PUBLIC_WRITE_SCOPE:'PUBLICATION_ONLY',
    V2_PUBLIC_PUBLICATION_STARTS_AT:new Date(Date.now()-1000).toISOString(),
    V2_PUBLIC_PUBLICATION_EXPIRES_AT:new Date(f.now()+600000).toISOString(),
    V2_PUBLIC_PUBLICATION_TASK_ID:task.id,
    V2_PUBLIC_PUBLICATION_PACKAGE_DIGEST:pending.packageDigest,
    V2_PUBLIC_PUBLICATION_VERIFICATION_ID:verification.id,
    V2_PRIVATE_RELEASE_ENABLED:'true',
    V2_PRIVATE_RELEASE_TRIGGER_NAMES:'shuduo-release-synthetic-review',
    V2_SCHEDULER_TICK_SECRET:'synthetic-release-authorization-1234567890',
  });
  await f.restart();
  assert.equal((await f.call(taskPath+'/publication',{...publicationBody,reviewDigest:'f'.repeat(64)},randomUUID())).status,409);
  const tampered=structuredClone(reviewed);
  tampered.package.files['main.sql']+='\n-- modified after review';
  writeFileSync(reviewPath,JSON.stringify(tampered));
  await cli('v3-publish',publishFlags,1);
  assert.ok(requests.every(request=>request.method==='GET'));
  assert.equal(f.store.list('release',PROJECT).length,0);
  writeFileSync(reviewPath,JSON.stringify(reviewed));
  const publishing=publicationCli.run('v3-publish',publishFlags);
  const {request,response}=await Promise.race([publicationAccepted.promise,publishing.done.then(e=>{
    throw Error('CLI exited before the application accepted the publication: '+e.stderr);
  })]);
  assert.equal(response.status,202);
  assert.equal(request.path,taskPath+'/publication');
  const acceptedRelease=response.body, submittedBytes=readFileSync(checkpoint,'utf8');
  const savedAtPublicationPost=JSON.parse(submittedBytes).outcomes[0].actions.publication;
  assert.equal(savedAtPublicationPost.status,'SUBMITTING');
  assert.equal(savedAtPublicationPost.key,request.key);
  assert.equal(savedAtPublicationPost.reviewDigest,reviewed.reviewDigest);
  assert.equal(savedAtPublicationPost.bill.unsettledReserveCny,64);
  assert.equal(acceptedRelease.release.status,'WAITING_SCHEDULER');
  assert.equal(acceptedRelease.runs.length,2);
  assert.ok(acceptedRelease.runs.every(run=>run.status==='SCHEDULED'&&!run.schedulerTriggered));
  const publishOffset=publicationCli.requests.length;
  assert.equal((await publicationCli.run('v3-publish',['--reconcile']).done).code,1);
  assert.equal(publicationCli.requests.length,publishOffset);
  publishing.child.kill('SIGKILL');
  assert.equal((await publishing.done).signal,'SIGKILL');
  assert.equal(readFileSync(checkpoint,'utf8'),submittedBytes);
  assert.ok(existsSync(checkpoint+'.lock'));
  assert.equal((await publicationCli.run('v3-publish',publishFlags).done).code,1);
  assert.equal(publicationCli.requests.length,publishOffset);
  await f.restart();
  assert.deepEqual(f.queueCounts(),preflightQueue);
  const reconciled=await publicationCli.run('v3-publish',['--reconcile']).done;
  assert.equal(reconciled.code,0,reconciled.stderr);
  const found=JSON.parse(reconciled.stdout);
  const receiptPath=publicationRequestReceiptPath(task.id,savedAtPublicationPost.key);
  assert.equal(found.status,'PUBLICATION_RECORDED');
  assert.equal(found.publication.releaseId,acceptedRelease.release.id);
  assert.deepEqual(found.publication.batchIds,acceptedRelease.runs.map(run=>run.id));
  assert.deepEqual(publicationCli.requests.slice(publishOffset).map(({method,path})=>[method,path]),
    [['GET','/auth/session'],['GET',receiptPath]]);
  assert.equal(existsSync(checkpoint+'.lock'),false);
  assert.equal((await cli('v3-publish',publishFlags)).reason,'INSPECT_ORIGINAL_PUBLICATION');
  assert.deepEqual(requests,[]);
  assert.equal((await f.call(publicationRequestReceiptPath(task.id,randomUUID()))).status,404);
  assert.equal((await f.call(receiptPath+'?releaseId='+acceptedRelease.release.id)).status,422);
  const privateReceipt={operation:'PRIVATE_APPLICATION_HTTP_V1',method:'GET',path:'/api/v2'+receiptPath};
  assert.equal(validatePrivateApplicationRequest(privateReceipt,{allowDurableAgentRead:true}).path,privateReceipt.path);
  assert.equal(f.store.list('delivery_review',PROJECT).length,1);
  assert.equal(f.store.list('release_approval',PROJECT).length,1);
  assert.equal(f.store.list('release',PROJECT).length,1);
  assert.equal(f.store.list('release_run',PROJECT).length,2);
  assert.deepEqual(f.queueCounts(),preflightQueue);

  const releaseId=found.publication.releaseId,[firstId,secondId]=found.publication.batchIds;
  const releaseRun=id=>f.store.get('release_run',id,PROJECT);
  const timer=(mark,forged=false)=>{
    const triggerName=f.env.V2_PRIVATE_RELEASE_TRIGGER_NAMES,timestamp=String(f.now()),nonce=mark.repeat(24);
    const body=JSON.stringify({releaseId,triggerName,expiresAt:f.now()+300000});
    return {triggerName,triggerTime:new Date(f.now()).toISOString(),payload:JSON.stringify({
      operation:'PRIVATE_RELEASE_TIMER_V1',timestamp,nonce,body,
      signature:forged?'bad':signSchedulerTick({sharedSecret:f.env.V2_SCHEDULER_TICK_SECRET,timestamp,nonce,body}),
    })};
  };
  assert.equal((await f.privateCall(timer('x',true))).status,401);
  const releaseRecord=f.store.get('release',releaseId,PROJECT);
  f.store.update('release',releaseId,PROJECT,{sourceCodeHash:'0'.repeat(64)});
  assert.equal((await f.privateCall(timer('y'))).status,409);
  f.store.update('release',releaseId,PROJECT,{sourceCodeHash:releaseRecord.sourceCodeHash});
  assert.equal(releaseRun(firstId).status,'SCHEDULED');
  assert.deepEqual(f.queueCounts(),preflightQueue);
  const firstTimer=timer('a');
  f.lose();
  assert.equal((await f.privateCall(firstTimer)).status,500);
  const first=releaseRun(firstId).remoteSubmission.prepared;
  assert.equal(first.job.jobId,firstId);
  const reserved=(await f.call('/status')).body.budget.remoteSpark;
  assert.equal(reserved.runCount,3);
  assert.equal(releaseRun(firstId).reservedDurationMs,30000);
  await f.restart();
  f.later(60000);
  const lostQueue=f.queueCounts();
  const waiting=(await cli('v3-publish',['--reconcile'])).publication;
  assert.equal(waiting.monitoringStatus,'PENDING');
  assert.deepEqual(waiting.batches,[{id:firstId,status:'RUNNING',reservedDurationMs:30000},{id:secondId,status:'SCHEDULED'}]);
  assert.equal((await f.call(taskPath+'/publication')).body.release.status,'RUNNING_CLOUD_TEST');
  assert.deepEqual(f.queueCounts(),lostQueue);
  assert.equal((await f.privateCall(timer('b'))).status,200);
  assert.equal((await f.privateCall(timer('a'))).status,409,'changing the signed time with the original nonce is rejected');
  assert.deepEqual((await f.call('/status')).body.budget.remoteSpark,reserved);
  assert.equal(releaseRun(secondId).status,'SCHEDULED');
  assert.equal(f.queueCounts().jobWriteAttempts,lostQueue.jobWriteAttempts);
  assert.equal(f.queueCounts().cancellationWrites,0);

  const useRealSpark=process.env.SHUDUO_TEST_LOCAL_SPARK_RELEASE==='true';
  f.complete(first,useRealSpark?await measuredSpark(t,f,first,'release batch 1'):undefined);
  assert.equal((await f.privateCall(firstTimer)).status,200);
  assert.equal(releaseRun(firstId).status,'SUCCEEDED');
  assert.equal(releaseRun(secondId).status,'SCHEDULED','the original signed event can settle only its prior batch');
  assert.equal((await f.privateCall(firstTimer)).body.replayed,true);
  const competing=await Promise.all([f.privateCall(timer('c')),f.privateCall(timer('e'))]);
  assert.ok(competing.every(response=>response.status===200));
  const second=releaseRun(secondId).remoteSubmission.prepared;
  assert.equal(second.job.jobId,secondId);
  f.complete(second,useRealSpark?await measuredSpark(t,f,second,'release batch 2'):undefined);
  f.later(600001);
  assert.equal((await f.privateCall(timer('d'))).status,200);
  const monitorOffset=publicationCli.requests.length, queuesBeforeMonitoring=f.queueCounts();
  const monitoring=await publicationCli.run('v3-publish',['--reconcile']).done;
  assert.equal(monitoring.code,0,monitoring.stderr);
  const {publication:complete}=JSON.parse(monitoring.stdout);
  assert.deepEqual(publicationCli.requests.slice(monitorOffset).map(({method,path})=>[method,path]),
    [['GET','/auth/session'],['GET',receiptPath]]);
  assert.equal(publicationCli.requests.filter(r=>r.method==='POST').length,1);
  assert.deepEqual(f.queueCounts(),queuesBeforeMonitoring);
  assert.equal(complete.status,'COMPLETED_CLOUD_TEST');
  assert.equal(complete.monitoringStatus,'VERIFIED');
  assert.deepEqual(complete.monitoring.map(entry=>entry.batchId),[firstId,secondId]);
  assert.equal(f.queueCounts().jobWriteAttempts,preflightQueue.jobWriteAttempts+2);
  assert.equal(f.queueCounts().cancellationWrites,0);
  assert.equal(f.store.list('release_run',PROJECT).length,2);
  assert.equal(f.store.list('monitor_event',PROJECT).length,2);
  assert.equal(f.store.list('monitor_alert',PROJECT).length,0);
  const monitorHref='/v2/?'+new URLSearchParams({module:'ops',taskId:task.id,releaseId,revisionId:source.revisionId,
    firstBatchId:firstId,secondBatchId:secondId})+'#ops-exact-publication';
  const monitorTarget=opsPublicationTarget(new URL(monitorHref,f.base).href);
  assert.equal(opsPublicationTarget(new URL(monitorHref.replace('#','&releaseId='+releaseId+'#'),f.base).href),null);
  const monitorReads=[];
  const monitorReader=async path=>{
    monitorReads.push(path);
    const result=await f.call(path);
    assert.equal(result.status,200);
    return result.body;
  };
  const monitoringBefore=f.queueCounts();
  const opsEvidence=await readOpsPublication(monitorReader,monitorTarget);
  assert.deepEqual(monitorReads,['/releases/'+releaseId,'/release/runs/'+firstId,'/release/runs/'+secondId]);
  const {batches:monitorBatches,...monitorStatus}=opsEvidence;
  assert.deepEqual(monitorStatus,{status:'COMPLETED_CLOUD_TEST',health:'HEALTHY'});
  assert.deepEqual(monitorBatches.map(({serviceHref,...batch})=>batch),[
    {id:firstId,sequence:1,status:'SUCCEEDED',schedulerTriggered:true},
    {id:secondId,sequence:2,status:'SUCCEEDED',schedulerTriggered:true},
  ]);
  for (const batch of monitorBatches) {
    assert.ok(batch.serviceHref);
    const href=new URL(batch.serviceHref,f.base).href;
    const parsed=serviceSourceFromLocation(href);
    assert.equal(parsed.status,'VALID');
    assert.equal(parsed.binding.releaseId,releaseId);
    assert.equal(parsed.binding.revisionId,source.revisionId);
    assert.equal(serviceBatchFromLocation(href,parsed.binding),batch.id);
  }
  const onePending=await readOpsPublication(async path=>{
    const record=await monitorReader(path);
    return path.endsWith(secondId)?{...record,status:'RUNNING'}:record;
  },monitorTarget);
  assert.equal(onePending.batches[1].serviceHref,undefined);
  await assert.rejects(readOpsPublication(monitorReader,{...monitorTarget,firstBatchId:secondId,secondBatchId:firstId}),/来源不一致/);
  await assert.rejects(readOpsPublication(monitorReader,{...monitorTarget,revisionId:randomUUID()}),/来源不一致/);
  assert.deepEqual(f.queueCounts(),monitoringBefore);
  for(const path of monitorReads.slice(0,3)){
    const guest=await fetch(f.base+path);
    assert.ok([401,403].includes(guest.status));
    assert.ok(!(await guest.text()).includes(releaseId));
  }
  const queuesBeforeConsumption=f.queueCounts();
  const origin=new URL(publicationCli.base).origin;
  const firstConsumption=await consumeOriginalBatch(f,cli,{taskId:task.id,releaseId,packageDigest:pending.packageDigest,batchId:firstId,sequence:1,origin});
  const secondConsumption=await consumeOriginalBatch(f,cli,{taskId:task.id,releaseId,packageDigest:pending.packageDigest,batchId:secondId,sequence:2,origin});
  assert.equal(firstConsumption.bound.consumption.batchId,firstId);
  assert.equal(secondConsumption.bound.consumption.batchId,secondId);
  assert.deepEqual(f.queueCounts(),queuesBeforeConsumption);
  const sources=new URLSearchParams({agent_task_id:task.id,package_digest:pending.packageDigest,release_id:releaseId});
  f.store.update('release',releaseId,PROJECT,{reviewDigest:undefined});
  assert.deepEqual((await f.call('/data-services/sources?'+sources)).body,[]);
  f.store.update('release',releaseId,PROJECT,{reviewDigest:releaseRecord.reviewDigest});
  const event=complete.monitoring[0];
  f.store.update('monitor_event',event.eventId,PROJECT,{observedAt:'2000-01-01T00:00:00.000Z'});
  const checkpointBytes=readFileSync(checkpoint,'utf8');
  assert.equal((await f.call(receiptPath)).body.monitoring.status,'UNCONFIRMED');
  assert.deepEqual((await f.call('/data-services/sources?'+sources)).body,[]);
  assert.equal((await cli('v3-publish',['--reconcile'])).reason,'ORIGINAL_PUBLICATION_UNCONFIRMED');
  await cli('v3-consumption',secondConsumption.flags,1);
  assert.equal(readFileSync(checkpoint,'utf8'),checkpointBytes);
});

test('invited development reaches versioned files across restart without another task or submission', async t => {
  const f = await fixture(t);
  let task = (await f.call('/agent/tasks', taskInput)).body;
  task = (await f.call(`/agent/tasks/${task.id}/advance`, { expectedVersion: task.version })).body;
  assert.equal(task.stage, 'READY_FOR_RUN'); assert.equal(f.counts().modelCalls, 1);
  task = (await f.call(`/agent/tasks/${task.id}/advance`, { expectedVersion: task.version })).body;
  assert.equal(task.stage, 'WAITING_FOR_RUN'); assert.equal(f.counts().jobCreates, 1);
  const prepared = f.store.get('run', task.runId, PROJECT).remoteSubmission.prepared;
  await f.restart(); f.complete(prepared);
  task = (await f.call(`/agent/tasks/${task.id}`)).body;
  task = (await f.call(`/agent/tasks/${task.id}/advance`, { expectedVersion: task.version })).body;
  assert.equal(task.status, 'SUCCEEDED'); assert.deepEqual(f.counts(), { modelCalls: 1, jobCreates: 1 });
  const workflow = await f.call(`/agent/tasks/${task.id}/workflow`);
  assert.equal(workflow.body.report.status, 'PASSED');
  let delivery = (await f.call(`/agent/tasks/${task.id}/prepare-delivery`, {}, 'delivery-once')).body;
  assert.equal(delivery.stage, 'PACKAGE_READY');
  const bundle = f.store.get('delivery_package', delivery.packageId, PROJECT);
  for (const name of ['main.sql', 'tests.sql', 'schedule.json', 'deployment.json']) assert.equal(typeof bundle.files[name], 'string');
  delivery = (await f.call(`/agent/deliveries/${delivery.id}/advance`, { expectedVersion: delivery.version })).body;
  assert.equal(delivery.stage, 'FILE_REHEARSAL_RUNNING'); assert.equal(f.counts().jobCreates, 2);
  const rehearsal = f.store.get('agent_delivery_task', delivery.id, PROJECT).remoteSubmission.prepared;
  await f.restart(); f.complete(rehearsal);
  const completed = await f.call(`/agent/deliveries/${delivery.id}`);
  assert.equal(completed.body.stage, 'AWAITING_ENGINEER_REVIEW');
  assert.equal(completed.body.packageDigest, bundle.digest);
  assert.deepEqual(f.counts(), { modelCalls: 1, jobCreates: 2 });
  assert.equal((await f.call('/agent/tasks', taskInput, 'second-task')).body.code, 'PUBLIC_DEVELOPMENT_TASK_LIMIT');
  assert.equal((await f.call(`/agent/tasks/${task.id}/publication`, {})).body.code, 'PUBLIC_DEVELOPMENT_SCOPE_DENIED');
  assert.equal(f.store.list('release', PROJECT).length, 0);
});

test('unknown submission is not replayed by restart or expiry; an existing late result remains readable', async t => {
  const f = await fixture(t);
  const revision = (await f.call('/revisions', { sql: referenceSql, contextId: 'holdings-t1' }, 'manual-save')).body;
  f.lose(); const submitted = await f.call('/runs', { revisionId: revision.id }, 'manual-once');
  assert.equal(submitted.status, 500); assert.deepEqual(f.counts(), { modelCalls: 0, jobCreates: 1 });
  const saved = f.store.list('run', PROJECT)[0], prepared = saved.remoteSubmission.prepared;
  await f.restart();
  assert.equal((await f.call(`/runs/${saved.id}`)).body.status, 'QUEUED');
  assert.deepEqual(f.counts(), { modelCalls: 0, jobCreates: 1 });
  f.complete(prepared); f.expire();
  const late = await f.call(`/runs/${saved.id}`);
  assert.equal(late.body.status, 'SUCCEEDED'); assert.equal(late.body.id, saved.id);
  assert.equal((await f.call('/auth/session')).body.readOnly, true);
  assert.equal((await f.call('/runs', { revisionId: revision.id }, 'manual-once')).body.code, 'PUBLIC_DEVELOPMENT_CLOSED');
  assert.deepEqual(f.counts(), { modelCalls: 0, jobCreates: 1 });
});

test('new targeted window resumes the original task and files, but no new task, foreign revision or private bypass',async t=>{
  const f=await fixture(t);
  const unrelated=(await f.call('/revisions',{sql:'SELECT 1',contextId:'holdings-t1'},'unrelated')).body;
  let task=(await f.call('/agent/tasks',taskInput)).body;
  f.modelFault(true);task=(await f.call(`/agent/tasks/${task.id}/advance`,{expectedVersion:task.version})).body;
  const original=structuredClone(task);assert.equal(task.stage,'MODEL_OUTCOME_UNKNOWN');assert.equal(task.usedTokens,12000);
  f.expire();f.later(60000);
  Object.assign(f.env,{V2_PUBLIC_DEVELOPMENT_TASK_ID:task.id,V2_PUBLIC_DEVELOPMENT_STARTS_AT:new Date(f.now()).toISOString(),V2_PUBLIC_DEVELOPMENT_EXPIRES_AT:new Date(f.now()+3600000).toISOString()});
  await f.restart();
  const session=(await f.call('/auth/session')).body;assert.equal(session.developmentTaskId,task.id);assert.equal(session.readOnly,false);
  assert.equal((await f.call(`/agent/tasks/${task.id}`)).body.createdAt,original.createdAt);
  assert.deepEqual(f.counts(),{modelCalls:1,jobCreates:0});
  assert.equal((await f.call('/agent/tasks',taskInput,'another-task')).body.code,'PUBLIC_DEVELOPMENT_TARGET_ONLY');
  assert.equal((await f.call('/runs',{revisionId:unrelated.id},'foreign-run')).body.code,'PUBLIC_DEVELOPMENT_TARGET_ONLY');
  for(const origin of [undefined,unrelated.id])assert.equal((await f.call('/revisions',{sql:'SELECT 2',contextId:'holdings-t1',...(origin?{originAgentTaskId:origin}:{})},'wrong-origin')).body.code,'PUBLIC_DEVELOPMENT_TARGET_ONLY');
  for(const operation of ['PRIVATE_AGENT_RECOVERY_V1','PRIVATE_AGENT_TICK_V1','PRIVATE_APPLICATION_HTTP_V1','PRIVATE_APPLICATION_TASK_V1'])assert.equal((await f.privateCall({operation})).body.code,'PUBLIC_DEVELOPMENT_TARGET_ONLY');
  assert.deepEqual(f.counts(),{modelCalls:1,jobCreates:0});
  f.modelFault(false);
  task=(await f.call(`/agent/tasks/${task.id}/advance`,{expectedVersion:task.version,confirmModelRetry:true})).body;
  assert.equal(task.stage,'READY_FOR_RUN');assert.equal(task.createdAt,original.createdAt);assert.equal(task.attempts.length,2);assert.equal(task.usedTokens,12012);
  task=(await f.call(`/agent/tasks/${task.id}/advance`,{expectedVersion:task.version})).body;
  assert.equal(task.stage,'WAITING_FOR_RUN');f.complete(f.store.get('run',task.runId,PROJECT).remoteSubmission.prepared);
  task=(await f.call(`/agent/tasks/${task.id}/advance`,{expectedVersion:task.version})).body;
  assert.equal(task.status,'SUCCEEDED');
  let delivery=(await f.call(`/agent/tasks/${task.id}/prepare-delivery`,{},'original-files')).body;
  assert.equal(delivery.stage,'PACKAGE_READY');
  delivery=(await f.call(`/agent/deliveries/${delivery.id}/advance`,{expectedVersion:delivery.version})).body;
  assert.equal(delivery.stage,'FILE_REHEARSAL_RUNNING');
  f.complete(f.store.get('agent_delivery_task',delivery.id,PROJECT).remoteSubmission.prepared);
  assert.equal((await f.call(`/agent/deliveries/${delivery.id}`)).body.stage,'AWAITING_ENGINEER_REVIEW');
  assert.equal(f.store.list('agent',PROJECT).length,1);assert.deepEqual(f.counts(),{modelCalls:2,jobCreates:2});
  assert.equal((await f.call(`/agent/tasks/${task.id}/publication`,{})).body.code,'PUBLIC_DEVELOPMENT_SCOPE_DENIED');
});

test('target-linked manual SQL stays human-assisted and its signed late result is read without resubmitting',async t=>{
  const f=await fixture(t),task=(await f.call('/agent/tasks',taskInput)).body;
  f.expire();f.later(60000);
  Object.assign(f.env,{V2_PUBLIC_DEVELOPMENT_TASK_ID:task.id,V2_PUBLIC_DEVELOPMENT_STARTS_AT:new Date(f.now()).toISOString(),V2_PUBLIC_DEVELOPMENT_EXPIRES_AT:new Date(f.now()+3600000).toISOString()});
  await f.restart();
  const wrong=await f.call('/revisions',{sql:referenceSql,contextId:'cash-change',originAgentTaskId:task.id},'wrong-context');assert.equal(wrong.status,409);
  const saved=(await f.call('/revisions',{sql:referenceSql,contextId:task.contextId,originAgentTaskId:task.id},'manual-target')).body;
  assert.equal(saved.manualProvenance.agentIndependentE2E,false);assert.equal(saved.manualProvenance.originAgentTaskId,task.id);
  const run=(await f.call('/runs',{revisionId:saved.id},'manual-once')).body;assert.equal(run.revisionHash,saved.hash);
  const queued=f.store.get('run',run.id,PROJECT).remoteSubmission.prepared;
  f.expire();await f.restart();f.complete(queued);
  const late=(await f.call(`/runs/${run.id}`)).body;assert.equal(late.status,'SUCCEEDED');
  assert.deepEqual(f.counts(),{modelCalls:0,jobCreates:1});
  assert.equal((await f.call('/runs',{revisionId:saved.id},'manual-once')).body.code,'PUBLIC_DEVELOPMENT_CLOSED');
  assert.equal(f.store.get('agent',task.id,PROJECT).attempts.length,0);
});

test('HTTP review renews a window-bound background grant on the old task, not a caller-supplied scope',async t=>{
  const f=await fixture(t,{eventsEnabled:true});
  f.modelFault(true);
  let task=(await f.call('/agent/tasks',{...taskInput,background:true})).body;
  assert.equal(task.background.status,'ACTIVE');
  const original=f.store.get('agent',task.id,PROJECT);
  assert.equal((await f.privateCall(f.wakes[0])).status,200);
  task=(await f.call(`/agent/tasks/${task.id}`)).body;assert.equal(task.background.status,'NEEDS_CONFIRMATION');
  const before=f.store.list('agent_background',PROJECT)[0];assert.equal(before.consumedEvents,1);assert.ok(before.developmentBoundary);
  f.expire();f.later(60000);
  Object.assign(f.env,{V2_PUBLIC_DEVELOPMENT_TASK_ID:task.id,V2_PUBLIC_DEVELOPMENT_STARTS_AT:new Date(f.now()).toISOString(),V2_PUBLIC_DEVELOPMENT_EXPIRES_AT:new Date(f.now()+5*60000).toISOString()});
  await f.restart();
  const route=`/agent/tasks/${task.id}/background/resume`,review={expectedVersion:task.version,confirmModelRetry:true};
  assert.equal((await f.call(route,{...review,developmentBoundary:{taskId:'foreign'}})).status,422);
  assert.equal((await f.call(route,{...review,durationMs:3600000})).status,422);
  assert.equal((await f.call(route,{...review,confirmModelRetry:false})).body.code,'AGENT_RETRY_CONFIRMATION_REQUIRED');
  const resumed=await f.call(route,review);assert.equal(resumed.status,202);assert.equal(resumed.body.consumedEvents,1);assert.equal(resumed.body.maxEvents,before.maxEvents);
  assert.equal(resumed.body.expiresAt,Date.parse(f.env.V2_PUBLIC_DEVELOPMENT_EXPIRES_AT));
  f.modelFault(false);await f.privateCall(f.wakes.at(-1));
  const after=(await f.call(`/agent/tasks/${task.id}`)).body;
  assert.equal(after.stage,'READY_FOR_RUN');assert.equal(after.createdAt,original.createdAt);assert.equal(after.attempts.length,2);assert.equal(after.usedTokens,12012);
  assert.deepEqual(f.counts(),{modelCalls:2,jobCreates:0});
  f.expire();const snapshot=structuredClone(f.store.get('agent',task.id,PROJECT));
  assert.equal((await f.privateCall(f.wakes.at(-1))).body.state,'SCOPE_DENIED');
  assert.deepEqual(f.store.get('agent',task.id,PROJECT),snapshot);assert.deepEqual(f.counts(),{modelCalls:2,jobCreates:0});
});
