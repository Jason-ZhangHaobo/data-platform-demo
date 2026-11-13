// HTTP/lifecycle regression with synthetic models and a local queue. Explicit
// measurement flags can run local Spark. Neither mode attests cloud execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { backup } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createV2Server, PROJECT } from '../../src/v2/server.mjs';
import { MetadataStore } from '../../src/v2/store.mjs';
import { createCloudV2Application } from '../../src/v2/cloud-server.mjs';
import { MemorySnapshotBackend } from '../../src/v2/metadata-replica.mjs';
import { MemoryDataStateBackend } from '../../src/v2/data-state-replica.mjs';
import { LocalArtifactStore } from '../../src/v2/artifact-store.mjs';
import { BusinessQueryStore } from '../../src/v2/data-services.mjs';
import { createFcIngress } from '../../src/v2/fc-ingress.mjs';
import { RemoteSparkQueueClient, SPARK_QUEUE_PREFIXES, createQueuedSparkResult } from '../../src/v2/remote-spark-queue.mjs';
import { referenceSql, referenceSqlForContext, contextIds, getContext, validationFamilyForContext } from '../../src/v2/context.mjs';
import { V2Client } from '../../src/v2/client.mjs';
import { runV2Cli } from '../../bin/shuduo.mjs';
import { handleV2Mcp } from '../../bin/shuduo-mcp.mjs';
import { runSpark, runtimeConfig } from '../../src/v2/spark.mjs';
import { syntheticSqlRequirement } from './fixtures/sql-requirement.mjs';
import { agentReviewEvidencePath, publicationPreflightPath, publicationRequestReceiptPath } from '../../src/v2/publication-request.mjs';
import { validatePrivateApplicationRequest } from '../../src/v2/private-application.mjs';
import { signSchedulerTick } from '../../src/v2/scheduler-tick.mjs';
import { runConsumerAcceptance } from '../../scripts/verify-service-consumer.mjs';
import { validateDeliveryPackage } from '../../src/v2/delivery.mjs';
import { createCloudPublication } from '../../src/v2/cloud-publication.mjs';
import { batchServiceHistoryTarget, opsPublicationTarget, publicationBatchReportHref, publicationMonitorHref, readOpsPublication } from '../../web/src/ops-publication.ts';
import { checkedAgentPublication, checkedBatchConsumption, checkedExactPublicationReceipt } from '../../web/src/agent-delivery-evidence-read.ts';
import { serviceEvidencePath } from '../../web/src/service-source-binding.ts';
import { checkedAgentWorkflow, checkedCloudPublicationPreflight } from '../../web/src/agent-workflow-read.ts';
import { cloudPublicationRequest } from '../../web/src/publication-selection.ts';
import { privateReleasePendingLabel } from '../../src/v2/private-release-stage.mjs';
import { serviceSourceFromLocation } from '../../web/src/service-source-binding.ts';
import { serviceBatchFromLocation } from '../../web/src/service-batch-scope.ts';
import { privateBatchReportPath } from '../../src/v2/private-batch-report-request.mjs';
import { reportEvidenceDigest } from '../../src/v2/report-provenance-client.mjs';
import { batchArchiveRoute, batchArchiveListPath, batchArchiveRequestPath, prepareBatchArchive, readBatchArchive, submitBatchArchive } from '../../src/v2/private-batch-archive-client.mjs';
import { agentArchiveHref, agentArchivePin, checkedAgentArchive, clearAgentArchivePin } from '../../web/src/agent-archive-location.ts';
import { exportCloudV3SourceReview, prepareCloudV3Start, rebindCloudV3PreparedSource } from '../../scripts/start-cloud-v3-case.mjs';
import { withCloudCheckpoint } from '../../scripts/cloud-v3-checkpoint-lock.mjs';
import { cloudWindowApplicationBinding, firstCloudApplicationBinding, firstCloudWindowReceiptProtocol, nextCloudWindowReceiptProtocol } from '../../scripts/first-cloud-v3-window.mjs';
import { developmentRequestDigest } from '../../src/v2/public-development-access.mjs';
import { agentContextDerivationBody } from '../../src/v2/agent-context-derivation.mjs';
import { sha256 } from '../../src/v2/delivery.mjs';
import { seedContextDerivation } from './fixtures/agent-context-derivation.mjs';
import { currentLiveLifecycleContract, liveCaseCheckpoint, liveLifecyclePlan } from '../../src/v2/live-lifecycle-evaluation.mjs';
import { fixtureFirstCloudIndex, fixtureFirstCloudInspection } from './fixtures/first-cloud-application-inspection.mjs';

test('first-case entry preflight distinguishes exact bytes, stale HTML and a timeout without modifying the checkpoint', async t => {
  const directory=mkdtempSync(join(tmpdir(),'shuduo-entry-preflight-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const checkpoint=join(directory,'checkpoint.json'), applicationPath=join(directory,'application.json');
  const source='a'.repeat(40), reads=[];
  let reply=()=>new Response(fixtureFirstCloudIndex,{headers:{'content-type':'text/html; charset=utf-8'}});
  const client={baseUrl:'https://pilot.example.invalid/api/v2',projectId:PROJECT,
    fetchImpl:async (url,options)=>{
      reads.push(url);
      assert.equal(url,'https://pilot.example.invalid/v2/');
      assert.equal(options.method,'GET');
      assert.equal(options.credentials,'omit');
      assert.equal(options.redirect,'error');
      return reply(options);
    },request:()=>assert.fail('The entry probe must not call authenticated API routes')};
  prepareCloudV3Start(checkpoint,client,source);
  const bytes=readFileSync(checkpoint), state=JSON.parse(bytes);
  const inspection=fixtureFirstCloudInspection(source,'b'.repeat(40));
  const save=value=>writeFileSync(applicationPath,JSON.stringify(value),{mode:0o600});
  const check=async (flags=[],expectedExit=0)=>{
    const output=[];
    const status=await runV2Cli(['agent','v3-entry-preflight','--checkpoint',checkpoint,'--application-file',applicationPath,...flags],
      {},{client,output:line=>output.push(line),error:()=>{}});
    assert.equal(status,expectedExit);
    assert.deepEqual(readFileSync(checkpoint),bytes);
    assert.equal(existsSync(checkpoint+'.lock'),false);
    if(expectedExit)return;
    const result=JSON.parse(output.join(''));
    assert.equal(result.agentSubmissions,0);
    assert.ok(!output[0].includes(state.outcomes[0].actions.agent.key));
    return result;
  };
  save({...inspection,applicationSource:'d'.repeat(40)});
  assert.equal((await check()).reason,'APPLICATION_BINDING_MISMATCH');
  assert.equal(reads.length,0);
  save(inspection);
  await check(['--timeout-ms','99999'],1);
  await check(['--confirm'],1);
  assert.equal(reads.length,0);
  assert.equal((await check()).status,'MATCHED');
  reply=()=>new Response('<html>rollback build</html>',{headers:{'content-type':'text/html'}});
  assert.equal((await check()).reason,'ENTRY_CONTENT_MISMATCH');
  reply=()=>new Response('{}',{headers:{'content-type':'application/json'}});
  assert.equal((await check()).reason,'ENTRY_NOT_HTML');
  reply=()=>new Response(fixtureFirstCloudIndex,{headers:{'content-type':'text/html','content-length':'300001'}});
  assert.equal((await check()).reason,'ENTRY_TOO_LARGE');
  reply=async ({signal})=>{await new Promise(resolve=>setTimeout(resolve,10));throw signal.reason;};
  assert.equal((await check(['--timeout-ms','1'])).reason,'ENTRY_TIMEOUT');
  assert.equal(reads.length,5);
});

test('first-case entry preflight optionally verifies the same-origin script from the exact inspected ZIP', async t => {
  const directory=mkdtempSync(join(tmpdir(),'shuduo-entry-script-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const checkpoint=join(directory,'checkpoint.json'), applicationPath=join(directory,'application.json');
  const path='/v2/assets/index-test.js', script='export const fictional = true;';
  const index=`<html><script type="module" crossorigin src="${path}"></script></html>`;
  const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
  const source='a'.repeat(40), reads=[];
  let html=index, scriptResponse=()=>new Response(script,{headers:{'content-type':'text/javascript; charset=utf-8'}});
  const client={baseUrl:'https://pilot.example.invalid/api/v2',projectId:PROJECT,fetchImpl:async (url,options)=>{
    reads.push({url,signal:options.signal});
    assert.equal(options.method,'GET');
    assert.equal(options.redirect,'error');
    assert.equal(options.credentials,'omit');
    assert.equal(Object.keys(options.headers).some(key=>['authorization','cookie'].includes(key.toLowerCase())),false);
    if (url==='https://pilot.example.invalid/v2/') return new Response(html,{headers:{'content-type':'text/html'}});
    assert.equal(url,'https://pilot.example.invalid'+path);
    return scriptResponse(options);
  },request:()=>assert.fail('Preflight must stay anonymous')};
  prepareCloudV3Start(checkpoint,client,source);
  const original=readFileSync(checkpoint);
  const archive=(name,entry)=>{
    const zip=join(directory,name+'.zip');
    mkdirSync(join(directory,'web-dist/assets'),{recursive:true});
    writeFileSync(join(directory,'web-dist/index.html'),entry);
    writeFileSync(join(directory,'web-dist/assets/index-test.js'),script);
    execFileSync('zip',['-q',zip,'web-dist/index.html','web-dist/assets/index-test.js'],{cwd:directory});
    chmodSync(zip,0o600);
    const bytes=readFileSync(zip);
    return {zip,inspection:{...fixtureFirstCloudInspection(source,'b'.repeat(40)),bytes:bytes.length,sha256:hash(bytes),
      webIndexBytes:Buffer.byteLength(entry),webIndexSha256:hash(entry)}};
  };
  const check=async (archive,flags=[])=>{
    reads.length=0;
    writeFileSync(applicationPath,JSON.stringify(archive.inspection),{mode:0o600});
    const output=[];
    assert.equal(await runV2Cli(['agent','v3-entry-preflight','--checkpoint',checkpoint,'--application-file',applicationPath,
      '--zip-file',archive.zip,...flags],{},{client,output:line=>output.push(line),error:()=>{}}),0);
    const report=JSON.parse(output.join(''));
    assert.equal(report.agentSubmissions,0);
    assert.equal(reads.length,report.entryRequests+report.scriptRequests);
    assert.deepEqual(readFileSync(checkpoint),original);
    assert.equal(existsSync(checkpoint+'.lock'),false);
    return report;
  };
  const candidate=archive('candidate',index);
  const other=archive('external','<html><script type="module" src="//untrusted.invalid/index-test.js"></script></html>');
  assert.equal((await check({...candidate,zip:other.zip})).reason,'APPLICATION_ZIP_MISMATCH');
  assert.equal((await check(other)).reason,'APPLICATION_ENTRY_INVALID');
  chmodSync(candidate.zip,0o644);
  assert.equal((await check(candidate)).reason,'APPLICATION_ZIP_MISMATCH');
  chmodSync(candidate.zip,0o600);
  const success=await check(candidate);
  assert.equal(success.status,'MATCHED');
  assert.equal(success.script.status,'MATCHED');
  assert.equal(reads[0].signal,reads[1].signal);
  html='<html>Wrong version</html>';
  assert.equal((await check(candidate)).reason,'ENTRY_CONTENT_MISMATCH');
  assert.equal(reads.length,1);
  html=index;
  scriptResponse=()=>new Response(script.replace('true','null'),{headers:{'content-type':'application/javascript'}});
  assert.equal((await check(candidate)).reason,'ENTRY_SCRIPT_CONTENT_MISMATCH');
  scriptResponse=()=>new Response('<html>Fallback</html>',{headers:{'content-type':'text/html'}});
  assert.equal((await check(candidate)).reason,'ENTRY_SCRIPT_NOT_JAVASCRIPT');
  scriptResponse=()=>new Response(script,{headers:{'content-type':'text/javascript','content-length':'2097153'}});
  assert.equal((await check(candidate)).reason,'ENTRY_SCRIPT_TOO_LARGE');
  scriptResponse=async ({signal})=>{await new Promise(resolve=>setTimeout(resolve,25));throw signal.reason;};
  assert.equal((await check(candidate,['--timeout-ms','10'])).reason,'ENTRY_SCRIPT_TIMEOUT');
});

async function fixture(t,{eventsEnabled=false,startupPreflight=false,structuredRequirement=false,stableOrigin=false,
  queueTimeoutMs=180000,contextualModel=false,sqlForAttempt}={}) {
  const directory = mkdtempSync(join(tmpdir(), 'shuduo-pilot-journey-'));
  let now = Date.now(), app, store, base, cookie, csrf, cloudState, modelCalls = 0, jobCreates = 0, loseSubmission = false, modelFault=false;
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
  const resultEvent=key=>({events:[{eventName:'ObjectCreated:PutObject',eventSource:'acs:oss',eventVersion:'1.0',
    eventTime:new Date(now).toISOString(),oss:{bucket:{name:env.OSS_BUCKET,ownerIdentity:env.V2_AGENT_EVENT_ACCOUNT_ID},object:{key}}}]});
  const close = async () => {
    if (!app) return;
    app.server.closeAllConnections(); await new Promise(r => app.server.close(r));
    if (cloudState) {
      await backup(store.db,join(directory,'metadata.sqlite'));
      await cloudState.closeReplicated({closeDataStores:true}); cloudState=undefined;
    }
    else { app.businessStore.close(); store.close(); }
    app=undefined;
  };
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
    const businessStore=new BusinessQueryStore(join(directory,'business.sqlite'));
    app = createV2Server({ store, businessStore, root: directory, env, runner, agentWakeTransport, now: () => now, artifactStore, ingress: createFcIngress({ publicHttpEnabled: true, publicReadOnly: env.V2_FC_PUBLIC_READ_ONLY === 'true' }), generator: async input => {
      modelCalls++; if(modelFault)throw Error('synthetic model interrupted');
      return { sql: sqlForAttempt?.(modelCalls,input) ?? (contextualModel?referenceSqlForContext(input.context.id):referenceSql), model: structuredRequirement?'qwen3-coder-plus':'synthetic-protocol-fixture',
        explanation: 'Local lifecycle fixture, not a real model', usage: { total_tokens: 12 },
        ...(structuredRequirement ? syntheticSqlRequirement(input) : {}) };
    } });
    app.auth.bootstrapAdmin({ email: env.V2_BOOTSTRAP_ADMIN_EMAIL, password: 'SyntheticJourney!2026', displayName: '虚构开发者' });
    const port=stableOrigin && base ? Number(new URL(base).port) : 0;
    await new Promise(r => app.server.listen(port, '127.0.0.1', r)); base = `http://127.0.0.1:${app.server.address().port}/api/v2`;
  };
  const call = async (path, body, key = 'original-pilot-task') => {
    const r = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-shuduo-client': 'workbench', origin: env.V2_PUBLIC_ORIGIN, 'idempotency-key': key, ...(stableOrigin ? {connection:'close'} : {}), ...(cookie ? { cookie, 'x-csrf-token': csrf } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: r.status, body: await r.json(), cookies: r.headers.getSetCookie(), headers: r.headers };
  };
  const complete = (prepared, measuredResult, queueJobDigest=sha256(prepared.serialized)) => {
    const payload = JSON.parse(prepared.job.body);
    const result=measuredResult ?? {
      status: 'SUCCEEDED', engine: 'Apache Spark', engineVersion: '3.5.9', mainSqlExecuted: true,
      rows: getContext(payload.context.id).expected, durationMs: 100,
      validation: { passed: true, regressions: contextIds.map(contextId => ({ contextId, passed: true })) },
      ...(payload.testSql ? { testSqlValidation: { passed: true, sqlHash: createHash('sha256').update(payload.testSql).digest('hex') } } : {}),
      log: 'Synthetic queue receipt. No real Spark was run.',
    };
    objects.set(prepared.resultKey, JSON.stringify(createQueuedSparkResult(prepared.job,
      {...result,queueJobDigest},config,now)));
  };
  const restartWithExpiredReadiness=async()=>{
    assert.equal(cloudState,undefined);
    const metadata=new MemorySnapshotBackend(), data=new MemoryDataStateBackend();
    const documents=store.db.prepare('SELECT kind,id,project,version,data FROM documents ORDER BY rowid').all();
    const idempotency=store.db.prepare('SELECT key,signature,result_id FROM idempotency ORDER BY key').all();
    await metadata.compareAndSwap(PROJECT,0,{format:'shuduo-metadata-snapshot/v1',projectId:PROJECT,documents,idempotency});
    const port=Number(new URL(base).port);
    await close();
    const readyJob=queue.prepare({sql:'SELECT 1',context:{id:'synthetic-health'},validationContexts:[]},randomUUID());
    const healthQueue=new RemoteSparkQueueClient({...config,readyJobId:readyJob.job.jobId,readyMaxAgeMs:60000}, {
      read:async key=>{
        assert.equal(key,readyJob.resultKey);
        return JSON.stringify(createQueuedSparkResult(readyJob.job,{status:'SUCCEEDED',engine:'Apache Spark',
          engineVersion:'3.5.9',mainSqlExecuted:true,validation:{passed:true}},config,Date.now()-61000));
      },
    });
    const candidate=Object.assign(()=>assert.fail('new Spark execution during recovery'),{
      descriptor:runner.descriptor,
      prepareVerification:()=>healthQueue.prepareHealthCheck(),
      durable:{read:runner.durable.read,prepare:()=>assert.fail('new Spark reservation during recovery'),
        submit:()=>assert.fail('new Spark submission during recovery'),cancel:()=>assert.fail('Spark cancellation during recovery')},
    });
    const boot=await createCloudV2Application({...env,V2_FC_PUBLIC_HTTP_ENABLED:'true'},{root:directory,now:()=>now,createRunner:()=>candidate,
      openMetadataBackend:async()=>metadata,createDataBackend:()=>data,createArtifactStore:()=>new LocalArtifactStore(join(directory,'artifacts'))});
    app=boot.app;store=app.store;cloudState=boot.stateCoordinator;
    await new Promise(resolve=>app.server.listen(port,'127.0.0.1',resolve));
  };
  await open();
  const login = await call('/auth/login', { email: env.V2_BOOTSTRAP_ADMIN_EMAIL, password: 'SyntheticJourney!2026' });
  assert.equal(login.status, 200); cookie = login.cookies.map(c => c.split(';')[0]).join('; '); csrf = login.body.csrfToken;
  t.after(async () => { await close(); rmSync(directory, { recursive: true, force: true }); });
  return { call, complete, removeResult:prepared=>objects.delete(prepared.resultKey), resultEvent, env, wakes, directory, get base(){return base;}, restart: async () => { await close(); await open(); }, restartWithExpiredReadiness, expire: () => { now = Date.parse(env.V2_PUBLIC_DEVELOPMENT_EXPIRES_AT); }, later:ms=>now+=ms,now:()=>now,modelFault:value=>modelFault=value, lose: () => { loseSubmission = true; }, get store() { return store; }, counts: () => ({ modelCalls, jobCreates }),
    get businessStore(){return app.businessStore;}, addAdmin:input=>app.auth.bootstrapAdmin(input),
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

async function measuredSpark(t,f,prepared,label,expectedStatus='SUCCEEDED'){
  const input=JSON.parse(prepared.job.body);
  const result=await runSpark(input,{...runtimeConfig({}),artifactRoot:f.directory,retainArtifacts:false});
  assert.equal(result.status,expectedStatus);
  assert.equal(result.engineVersion,'3.5.9');
  assert.equal(result.mainSqlExecuted,true);
  if (input.testSql) assert.equal(result.testSqlValidation?.passed,true);
  assert.equal(result.validation?.regressions.length,5);
  assert.equal(result.validation.regressions.every(check=>check.passed===true),expectedStatus==='SUCCEEDED');
  t.diagnostic(`Local Spark ${result.engineVersion}, ${label}, five independent scenarios, ${result.durationMs} ms`);
  return result;
}

async function consumeOriginalBatch(f,cli,{taskId,releaseId,packageDigest,batchId,sequence,origin,expectedRows=baseConsumerRows,
  differentContextRows}){
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
  // Store creation timestamps use wall time. The fixture's fixed invocation
  // clock must start after the application grant it is testing.
  f.alignWallClock();
  const tokenFile=join(f.directory,'consumer-token-'+sequence),planFile=join(f.directory,'consumer-plan-'+sequence+'.json');
  const reportFile=join(f.directory,'consumer-report-'+sequence+'.json');
  writeFileSync(tokenFile,app.body.token,{mode:0o600});
  const describe=service=>({id:service.id,slug:service.slug,versionId:service.currentVersion.id,configHash:service.currentVersion.configHash});
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
  const altered=structuredClone(plan);
  if (differentContextRows) altered.expectedRows=differentContextRows;
  else altered.expectedRows[0].total_assets='1.00';
  writeFileSync(planFile,JSON.stringify(altered));
  await cli('v3-consumption',flags,1);
  writeFileSync(planFile,JSON.stringify(plan));
  return {bound,flags};
}

// Reviewed literals from the fictional source inputs, independent of output.
const baseConsumerRows=[
  {client_id:'CLIENT-001',holding_market_value:'1500.00',available_cash:'300.00',total_assets:'1800.00',security_count:2},
  {client_id:'CLIENT-002',holding_market_value:'750.00',available_cash:'200.00',total_assets:'950.00',security_count:1},
];
const stockConsumerRows=[
  {client_id:'CLIENT-001',holding_market_value:'1000.00',available_cash:'300.00',total_assets:'1300.00',security_count:1},
  {client_id:'CLIENT-002',holding_market_value:'750.00',available_cash:'200.00',total_assets:'950.00',security_count:1},
];

function fixtureSourceReview(directory) {
  const cwd=join(directory,'source-review-repo');
  mkdirSync(cwd);
  const git=(...args)=>execFileSync('git',args,{cwd,encoding:'utf8',timeout:5000,stdio:['ignore','pipe','pipe']}).trim();
  git('init','--quiet','-b','main');
  const save=message=>{
    writeFileSync(join(cwd,'fictional-scope.txt'),message);
    git('add','fictional-scope.txt');
    git('-c','user.name=Fictional Review','-c','user.email=review@example.invalid','-c','commit.gpgsign=false','commit','--quiet','-m',message);
    return git('rev-parse','HEAD');
  };
  const source=save('reviewed fictional source'),tree=git('rev-parse','HEAD^{tree}');
  git('update-ref','refs/remotes/origin/main',source);
  return {cwd,source,tree,unmerged:save('unmerged fictional source')};
}

test('source rebind CLI preserves a PREPARED request and rejects unreviewed, locked and submitted states', async t=>{
  const directory=mkdtempSync(join(tmpdir(),'shuduo-source-review-'));
  t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const {cwd,source,tree,unmerged}=fixtureSourceReview(directory);
  const checkpoint=join(directory,'first-case.json'),reviewPath=join(directory,'source-review.json');
  prepareCloudV3Start(checkpoint,{baseUrl:'https://fictional.example/api/v2',projectId:'fictional'},'a'.repeat(40));
  const prepared=JSON.parse(readFileSync(checkpoint,'utf8'));
  prepared.historyUsage={unsettledReserveCny:64,recordedModelCalls:2};
  writeFileSync(checkpoint,JSON.stringify(prepared,null,2)+'\n');
  const original=readFileSync(checkpoint,'utf8'),key=JSON.parse(original).outcomes[0].actions.agent.key;
  const cliPath=resolve('bin/shuduo.mjs');
  const cli=(args,expected=0)=>{
    const run=spawnSync(process.execPath,[cliPath,'agent','v3-rebind-source','--checkpoint',checkpoint,...args],{cwd,encoding:'utf8',timeout:10000});
    assert.equal(run.status,expected,run.stderr);
    return expected===0?JSON.parse(run.stdout):undefined;
  };
  cli(['--source-revision',unmerged,'--out-file',reviewPath],1);
  assert.equal(existsSync(reviewPath),false);
  const review=cli(['--source-revision',source,'--out-file',reviewPath]);
  assert.equal(review.status,'SOURCE_REVIEW_EXPORTED');
  assert.equal(review.applicationTree,tree);
  const reviewBytes=readFileSync(reviewPath,'utf8');
  const digest=value=>createHash('sha256').update(value).digest('hex');
  assert.equal(review.reviewDigest,digest(reviewBytes));
  assert.equal(statSync(reviewPath).mode&0o777,0o600);
  assert.ok(!reviewBytes.includes(key));
  assert.equal(readFileSync(checkpoint,'utf8'),original);
  const flags=['--review-file',reviewPath,'--review-digest',review.reviewDigest];
  cli(['--review-file',reviewPath,'--review-digest','0'.repeat(64)],1);
  const alteredTree=JSON.stringify({...JSON.parse(reviewBytes),applicationTree:'f'.repeat(40)});
  writeFileSync(reviewPath,alteredTree);
  cli(['--review-file',reviewPath,'--review-digest',digest(alteredTree)],1);
  writeFileSync(reviewPath,reviewBytes);
  await withCloudCheckpoint(checkpoint,async()=>{
    await assert.rejects(rebindCloudV3PreparedSource(checkpoint,reviewPath,review.reviewDigest,{cwd}),/已有锁/);
  });
  assert.equal(readFileSync(checkpoint,'utf8'),original);
  const unknown=JSON.parse(original);
  unknown.outcomes[0].actions.agent.status='UNKNOWN';
  writeFileSync(checkpoint,JSON.stringify(unknown));
  cli(flags,1);
  assert.deepEqual(JSON.parse(readFileSync(checkpoint,'utf8')),unknown);
  const stale={...JSON.parse(original),historyUsage:{...prepared.historyUsage,unsettledReserveCny:0}};
  writeFileSync(checkpoint,JSON.stringify(stale));
  cli(flags,1);
  assert.deepEqual(JSON.parse(readFileSync(checkpoint,'utf8')),stale);
  writeFileSync(checkpoint,original);
  const applied=cli(flags);
  assert.equal(applied.status,'SOURCE_REBOUND');
  const reboundBytes=readFileSync(checkpoint,'utf8');
  const {reviewedSource,sourceRebinds,...preserved}=JSON.parse(reboundBytes);
  assert.equal(reviewedSource,source);
  const {reviewedSource:ignored,...originalFields}=JSON.parse(original);
  assert.deepEqual(preserved,originalFields);
  assert.equal(sourceRebinds[0].previousCheckpointDigest,digest(original));
  assert.equal(sourceRebinds[0].reviewDigest,review.reviewDigest);
  assert.equal(cli(flags).status,'SOURCE_ALREADY_REBOUND');
  assert.equal(readFileSync(checkpoint,'utf8'),reboundBytes);
  const changedAudit=JSON.parse(reboundBytes);
  changedAudit.sourceRebinds[0].applicationTree='0'.repeat(40);
  const changedBytes=JSON.stringify(changedAudit);
  writeFileSync(checkpoint,changedBytes);
  cli(flags,1);
  assert.equal(readFileSync(checkpoint,'utf8'),changedBytes);
  assert.equal(existsSync(checkpoint+'.lock'),false);
});

test('cloud v3 startup saves the original key before one POST and reconciles a lost receipt by GET',async t=>{
  const f=await fixture(t,{startupPreflight:true});
  const checkpoint=join(f.directory,'first-v3-checkpoint.json'),billPath=join(f.directory,'bill.json'),
    windowPath=join(f.directory,'opened-window.json'),applicationPath=join(f.directory,'inspected-application.json'),
    sessionFile=join(f.directory,'session.json'),reads=[];
  const source='a'.repeat(40), approvalDigest='d'.repeat(64);
  let activeSource=source,activeApprovalDigest=approvalDigest;
  const baseUrl='https://journey.example.invalid/api/v2';
  writeFileSync(sessionFile,JSON.stringify({protocol:'shuduo-invite-session/v1',apiBaseUrl:baseUrl,projectId:PROJECT,
    cookie:'shuduo_session=fictional-session-placeholder',csrfToken:'fictional-csrf-placeholder',
    expiresAt:f.env.V2_PUBLIC_DEVELOPMENT_EXPIRES_AT}),{mode:0o600});
  let originalKey, activeApplication, hideReceipt=false, differentActor=false, missingUsage=false, wrongEntry=false, wrongRuntimeDigest=false;
  const client=new V2Client({baseUrl,sessionFile,fetchImpl:async(url,options)=>{
    const target=new URL(url), path=target.pathname==='/v2/'?'/v2/':target.pathname.slice('/api/v2'.length)+target.search;
    reads.push({path,method:options.method});
    if(path==='/v2/'){
      assert.equal(options.method,'GET');
      assert.equal(options.headers.Cookie,undefined);
      assert.equal(options.headers.Authorization,undefined);
      return new Response(wrongEntry?fixtureFirstCloudIndex.replace('Fictional','Different'):fixtureFirstCloudIndex,
        {headers:{'content-type':'text/html; charset=utf-8'}});
    }
    if(options.method==='POST'){
      const saved=JSON.parse(readFileSync(checkpoint,'utf8'));
      assert.equal(saved.outcomes[0].actions.agent.status,'SUBMITTING');
      assert.equal(saved.outcomes[0].actions.agent.key,originalKey);
      assert.equal(options.headers['Idempotency-Key'],originalKey);
      assert.equal(saved.reviewedSource,activeSource);
      assert.equal(saved.submission.bill.unsettledReserveCny,64);
      assert.equal(saved.submission.usage.modelCalls,0);
      assert.equal(saved.submission.windowApprovalDigest,activeApprovalDigest);
      assert.deepEqual(saved.submission.application,activeApplication);
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
    if(wrongRuntimeDigest&&path==='/status?include=session')response.body.session.developmentRequestDigest='0'.repeat(64);
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
  assert.equal(prepared.taskUrl,undefined);
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
  writeFileSync(checkpoint,JSON.stringify({...JSON.parse(preparedBytes),sourceRebinds:[]}));
  const emptyHistory=await cli(['--window-binding']);
  assert.equal(emptyHistory.applicationTree,undefined);
  assert.equal(emptyHistory.requestKeyHash,binding.requestKeyHash);
  writeFileSync(checkpoint,preparedBytes);
  await cli(['--source-revision',source],1);
  assert.equal(readFileSync(checkpoint,'utf8'),preparedBytes);
  const month=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit'}).format(Date.now());
  const writeBill=amount=>writeFileSync(billPath,JSON.stringify({checkedAt:new Date().toISOString(),unsettledReserveCny:64,maxIncrementCny:2,
    pages:[{Success:true,Data:{PageNum:1,PageSize:300,TotalCount:1,BillingCycle:month,Items:{Item:[{Currency:'CNY',PretaxAmount:amount}]}}}]}),{mode:0o600});
  const startsAt=f.env.V2_PUBLIC_DEVELOPMENT_STARTS_AT, expiresAt=f.env.V2_PUBLIC_DEVELOPMENT_EXPIRES_AT;
  const writeInspection=(checkpoint,tree)=>{
    const inspection=fixtureFirstCloudInspection(checkpoint.sourceRevision,tree);
    writeFileSync(applicationPath,JSON.stringify(inspection),{mode:0o600});
    return {...firstCloudApplicationBinding(inspection,checkpoint),crc64:'123456789'};
  };
  const window={protocol:firstCloudWindowReceiptProtocol,checkpoint:binding,approvalDigest,startsAt,expiresAt,
    application:writeInspection(binding,'b'.repeat(40)),
    bill:{month,checkedAt:startsAt,spendCny:20,recordCount:1,pagesDigest:'e'.repeat(64),unsettledReserveCny:64,maxIncrementCny:2}};
  const writeWindow=value=>writeFileSync(windowPath,JSON.stringify(value),{mode:0o600});
  const confirmedFlags=['--window-file',windowPath,'--application-file',applicationPath,'--bill-file',billPath,'--confirm'];
  writeWindow(window);
  writeBill('134.00');
  await cli(confirmedFlags,1);
  assert.deepEqual(reads,[]);
  assert.equal(readFileSync(checkpoint,'utf8'),preparedBytes);
  assert.equal(f.store.list('agent',PROJECT).length,0);
  writeBill('20.00');
  await cli(['--bill-file',billPath,'--confirm'],1);
  assert.deepEqual(reads,[]);
  await cli(['--window-file',windowPath,'--bill-file',billPath,'--confirm'],1);
  assert.deepEqual(reads,[]);
  for(const alter of [
    v=>v.bill.unsettledReserveCny=0,v=>v.checkpoint.requestKeyHash='f'.repeat(64),v=>v.bill.spendCny=134,
    v=>v.protocol='SHUDUO_FIRST_V3_WINDOW_RECEIPT_V1',v=>delete v.application,
    v=>v.application.sha256='f'.repeat(64),v=>v.application.webIndexSha256='f'.repeat(64),v=>v.application.inspectionDigest='f'.repeat(64),
    v=>v.expiresAt=new Date(Date.now()-1).toISOString(),
  ]){
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
  // A legacy window receipt cannot start a new cloud case on a runtime with no request binding.
  await cli(confirmedFlags,1);
  assert.deepEqual(reads,[{path:'/status?include=session',method:'GET'}]);
  assert.equal(f.store.list('agent',PROJECT).length,0);
  const expectedDigest=developmentRequestDigest(binding.requestKeyHash,binding.requestBodyHash);
  f.env.V2_PUBLIC_DEVELOPMENT_REQUEST_DIGEST=expectedDigest;
  await f.restart();
  const admitted=await f.call('/auth/session');
  assert.equal(admitted.body.developmentRequestDigest,expectedDigest);
  const guest=await (await fetch(f.base+'/auth/session')).json();
  assert.equal(guest.developmentRequestOnly,true);
  assert.equal(Object.hasOwn(guest,'developmentRequestDigest'),false);
  const definition=liveLifecyclePlan(1,{contractId:currentLiveLifecycleContract.id}).selectedCases[0];
  const firstBody={message:definition.request,sql:definition.seedSql,contextId:definition.contextId};
  assert.equal(sha(JSON.stringify(firstBody)),binding.requestBodyHash);
  for (const [body,key] of [[{...firstBody,message:firstBody.message+' 改动'},originalKey],
    [{...firstBody,sql:'SELECT 0'},originalKey],[{...firstBody,contextId:'cash-change'},originalKey],
    [{...firstBody,background:true},originalKey],[firstBody,randomUUID()]]) {
    const denied=await f.call('/agent/tasks',body,key);
    assert.equal(denied.status,403);
    assert.equal(denied.body.code,'PUBLIC_DEVELOPMENT_REQUEST_ONLY');
  }
  assert.equal(f.store.list('agent',PROJECT).length,0);
  assert.deepEqual(f.counts(),{modelCalls:0,jobCreates:0});
  wrongRuntimeDigest=true;
  await cli(confirmedFlags,1);
  assert.deepEqual(reads,[{path:'/status?include=session',method:'GET'}]);
  wrongRuntimeDigest=false;
  missingUsage=true;
  await cli(confirmedFlags,1);
  assert.deepEqual(reads,[{path:'/status?include=session',method:'GET'}]);
  assert.equal(readFileSync(checkpoint,'utf8'),preparedBytes);
  missingUsage=false;
  const reviewedSource=fixtureSourceReview(f.directory),reviewFile=join(f.directory,'source-review.json');
  const billBytes=readFileSync(billPath,'utf8');
  const exported=exportCloudV3SourceReview(checkpoint,reviewedSource.source,reviewFile,{cwd:reviewedSource.cwd});
  await rebindCloudV3PreparedSource(checkpoint,reviewFile,exported.reviewDigest,{cwd:reviewedSource.cwd});
  activeSource=reviewedSource.source;
  assert.equal(readFileSync(billPath,'utf8'),billBytes);
  await cli(confirmedFlags,1);
  assert.deepEqual(reads,[],'old window receipt cannot authorize the rebound source');
  const reboundBinding=await cli(['--window-binding']);
  assert.equal(reboundBinding.sourceRevision,activeSource);
  assert.equal(reboundBinding.applicationTree,reviewedSource.tree);
  assert.equal(reboundBinding.requestKeyHash,binding.requestKeyHash);
  assert.equal(reboundBinding.requestBodyHash,binding.requestBodyHash);
  assert.equal(reboundBinding.evaluationRunId,binding.evaluationRunId);
  assert.notEqual(reboundBinding.checkpointDigest,binding.checkpointDigest);
  activeApprovalDigest='c'.repeat(64);
  activeApplication=writeInspection(reboundBinding,reviewedSource.tree);
  const newWindow={...window,checkpoint:reboundBinding,approvalDigest:activeApprovalDigest,application:activeApplication};
  writeWindow(newWindow);
  writeFileSync(applicationPath,JSON.stringify(fixtureFirstCloudInspection(activeSource,'0'.repeat(40))));
  await cli(confirmedFlags,1);
  assert.deepEqual(reads,[],'a different Git tree cannot authorize this rebound checkpoint');
  writeInspection(reboundBinding,reviewedSource.tree);
  const reboundBytes=readFileSync(checkpoint,'utf8');
  wrongEntry=true;
  await cli(confirmedFlags,1);
  assert.deepEqual(reads,[{path:'/status?include=session',method:'GET'},{path:'/v2/',method:'GET'}]);
  assert.equal(readFileSync(checkpoint,'utf8'),reboundBytes);
  assert.equal(f.store.list('agent',PROJECT).length,0);
  wrongEntry=false;
  const unknown=await cli(confirmedFlags);
  assert.equal(unknown.reason,'RECONCILE_ORIGINAL_CREATION');
  assert.equal(unknown.taskUrl,undefined);
  assert.deepEqual(reads.map(read=>read.method),['GET','GET','POST']);
  assert.equal(f.store.list('agent',PROJECT).length,1);
  const unknownBytes=readFileSync(checkpoint,'utf8');
  assert.equal(JSON.parse(unknownBytes).outcomes[0].actions.agent.status,'UNKNOWN');
  await assert.rejects(rebindCloudV3PreparedSource(checkpoint,reviewFile,exported.reviewDigest,{cwd:reviewedSource.cwd}));
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
  assert.equal(task.requestBound,true);
  assert.equal((await f.call('/agent/tasks/'+task.id)).body.requestBound,true);
  assert.equal(recovered.taskUrl,'https://journey.example.invalid/v2/?module=agent-center&task='+task.id);
  assert.equal((await cli(['--reconcile'])).taskUrl,recovered.taskUrl);
  assert.deepEqual(reads,[]);
  const state=JSON.parse(readFileSync(checkpoint,'utf8'));
  assert.equal(state.outcomes[0].actions.agent.id,task.id);
  assert.equal(state.outcomes[0].actions.agent.key,originalKey);
  assert.equal(state.reviewedSource,activeSource);
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
  const observedBytes=readFileSync(checkpoint,'utf8');
  const observed=JSON.parse(observedBytes);
  assert.deepEqual(observed.outcomes[0].developmentObservation,{stage:'DEVELOPMENT_UNCONFIRMED',provenance:'STORED_METADATA'});
  delete observed.outcomes[0].developmentObservation;
  assert.deepEqual(observed,JSON.parse(confirmedBytes));
  await inspect();
  assert.equal(readFileSync(checkpoint,'utf8'),observedBytes);
  assert.deepEqual(f.counts(),{modelCalls:0,jobCreates:0});
});

test('a request-bound base task requires the exact verified version for delivery and publication',async t=>{
  const f=await fixture(t,{eventsEnabled:true,startupPreflight:true,structuredRequirement:true,contextualModel:true,stableOrigin:true});
  const measure=process.env.SHUDUO_TEST_LOCAL_SPARK_WORKBENCH==='true';
  const definition=liveLifecyclePlan(1,{contractId:currentLiveLifecycleContract.id}).selectedCases[0];
  const body={message:definition.request,sql:definition.seedSql,contextId:definition.contextId};
  const key=randomUUID();
  const checkpoint=join(f.directory,'workbench-case.json'), origin=new URL(f.base).origin, requests=[];
  const plan=liveLifecyclePlan(1,{contractId:currentLiveLifecycleContract.id}), evaluationRunId=randomUUID();
  const startedAt=new Date(f.now()-1000).toISOString();
  const {user:{id:actorId}}=(await f.call('/auth/session')).body;
  const month=(await f.call('/status')).body.budget.month;
  let alter;
  const client=new V2Client({baseUrl:f.base,fetchImpl:async(url,options)=>{
    const uri=new URL(url), path=uri.pathname.slice('/api/v2'.length)+uri.search;
    requests.push([options.method,path]);
    const response=await f.call(path,options.body?JSON.parse(options.body):undefined,options.headers['Idempotency-Key']);
    alter?.(path,response.body);
    return new Response(JSON.stringify(response.body),{status:response.status});
  }});
  const cli=async(action,flags=[],expectedCode=0,checkpointFile=checkpoint)=>{
    requests.length=0;
    let value, error;
    const exit=await runV2Cli(['agent',action,'--checkpoint',checkpointFile,...flags],{},
      {client,output:line=>{value=JSON.parse(line);},error:line=>{error=line;}});
    assert.equal(exit,expectedCode,error);
    assert.ok(requests.every(([method])=>method==='GET'));
    return value;
  };
  const saved=()=>JSON.parse(readFileSync(checkpoint,'utf8'));
  f.env.V2_PUBLIC_DEVELOPMENT_REQUEST_DIGEST=developmentRequestDigest(sha256(key),sha256(JSON.stringify(body)));
  await f.restart();
  const created=await f.call('/agent/tasks',body,key);
  assert.equal(created.status,202,created.body.message);
  assert.equal(created.body.requestBound,true);
  assert.equal(created.body.derivedFrom,undefined);
  writeFileSync(checkpoint,JSON.stringify({evaluationRunId,contract:plan.contract,startedAt,caseSetDigest:plan.caseSetDigest,
    caseLimit:1,origin,projectId:PROJECT,reviewedSource:'a'.repeat(40),submission:{actorId,
      bill:{month,unsettledReserveCny:64},usage:{modelCalls:0,remoteSparkRuns:0,remoteSparkSeconds:0}},
    outcomes:[{...liveCaseCheckpoint(definition,startedAt,plan.caseSetDigest,{contractId:plan.contract.id,evaluationRunId}),
      status:'PAUSED',phase:'CODE_AND_DEBUG',taskId:created.body.id,
      actions:{agent:{key,status:'CONFIRMED',id:created.body.id,bodyHash:sha256(JSON.stringify(body))}}}]}),{mode:0o600});
  const taskPath='/agent/tasks/'+created.body.id;
  const evidencePath='/agent/requests/'+key+'/execution-evidence';
  const advance=async current=>{
    const response=await f.call(taskPath+'/advance',{expectedVersion:current.version});
    assert.equal(response.status,200,response.body.message);
    return response.body;
  };
  let current=await advance(created.body);
  current=await advance(current);
  const developmentJob=f.store.get('run',current.runId,PROJECT).remoteSubmission.prepared;
  f.complete(developmentJob,measure?await measuredSpark(t,f,developmentJob,'workbench development'):undefined);
  current=await advance(current);
  const sourceView=(await f.call(taskPath+'/workflow')).body.preparationSource;
  assert.equal(sourceView.runId,current.runId);
  assert.equal(sourceView.revisionId,current.revisionId);
  const beforeFiles=f.counts();
  assert.equal((await f.call(taskPath+'/prepare-delivery',{},randomUUID())).status,422);
  assert.equal((await f.call(taskPath+'/prepare-delivery',{expectedSource:{...sourceView,revisionHash:'0'.repeat(64)}},randomUUID())).status,409);
  assert.equal(f.store.list('agent_delivery_task',PROJECT).length,0);
  assert.deepEqual(f.counts(),beforeFiles);
  const deliveryRequestId=randomUUID();
  const preparedFiles=await f.call(taskPath+'/prepare-delivery',{expectedSource:sourceView},deliveryRequestId);
  assert.equal(preparedFiles.status,202,preparedFiles.body.message);
  assert.equal(preparedFiles.body.sourcePinned,true);
  const bundle=f.store.get('delivery_package',preparedFiles.body.packageId,PROJECT);
  assert.equal(bundle.manifest.source.runId,current.runId);
  assert.equal(bundle.manifest.source.revisionId,current.revisionId);
  assert.equal(Object.keys(bundle.files).length,8);
  assert.deepEqual(f.counts(),beforeFiles);
  assert.equal(preparedFiles.body.preparationRequestId,undefined);
  assert.deepEqual((await f.call(evidencePath)).body.originalDelivery,{id:preparedFiles.body.id,requestId:deliveryRequestId});
  assert.ok(!(await (await fetch(f.base+evidencePath)).text()).includes(deliveryRequestId));
  assert.equal((await cli('v3-inspect')).delivery.status,'REQUEST_NOT_SUBMITTED');
  const beforeImport=readFileSync(checkpoint,'utf8');
  assert.equal((await cli('v3-inspect',['--workbench','--delivery-request-id',randomUUID()])).reason,'WORKBENCH_DELIVERY_REQUEST_MISMATCH');
  await cli('v3-inspect',['--workbench','--delivery-request-id','../fake'],1);
  assert.equal(readFileSync(checkpoint,'utf8'),beforeImport);
  alter=(path,value)=>{if(path===evidencePath)delete value.originalDelivery;};
  assert.equal((await cli('v3-inspect',['--workbench'])).delivery.reason,'WORKBENCH_DELIVERY_REQUEST_UNCONFIRMED');
  assert.equal((await cli('v3-inspect',['--workbench','--delivery-request-id',randomUUID()])).delivery.status,'PENDING');
  assert.equal(readFileSync(checkpoint,'utf8'),beforeImport);
  assert.equal((await cli('v3-inspect',['--workbench','--delivery-request-id',deliveryRequestId])).delivery.id,preparedFiles.body.id);
  writeFileSync(checkpoint,beforeImport);
  alter=undefined;
  const exactPackage={packageId:bundle.id,packageDigest:bundle.digest};
  const deliveryPath='/agent/deliveries/'+preparedFiles.body.id+'/advance';
  // The queue accepts the original rehearsal while its acknowledgement is lost.
  f.lose();
  assert.equal((await f.call(deliveryPath,{expectedVersion:preparedFiles.body.version,rehearsal:exactPackage})).status,500);
  const stored=f.store.get('agent_delivery_task',preparedFiles.body.id,PROJECT);
  const {verificationId}=stored;
  assert.equal(stored.stage,'FILE_REHEARSAL_SUBMITTING');
  assert.equal(stored.remoteSubmission.submitted,false);
  assert.equal((await f.call(taskPath+'/workflow')).body.eventDrivenRehearsal,true);
  const event=f.resultEvent(stored.remoteSubmission.prepared.resultKey);
  const controls=f.queueCounts();
  assert.equal((await f.privateCall(f.resultEvent(stored.remoteSubmission.prepared.resultKey.replace(verificationId,randomUUID())))).body.state,'IGNORED_UNREGISTERED');
  assert.deepEqual(f.queueCounts(),controls);
  assert.equal((await f.privateCall(event)).status,503);
  assert.equal(f.store.get('agent_delivery_task',stored.id,PROJECT).version,stored.version);
  f.complete(stored.remoteSubmission.prepared,undefined,'0'.repeat(64));
  assert.equal((await f.privateCall(event)).body.code,'SPARK_QUEUE_RESULT_INVALID');
  assert.equal(f.store.get('agent_delivery_task',stored.id,PROJECT).version,stored.version);
  f.complete(stored.remoteSubmission.prepared,measure?await measuredSpark(t,f,stored.remoteSubmission.prepared,'workbench rehearsal'):undefined);
  // The original HTTP client is gone. Reopen the persisted controller with
  // writes closed and settle solely through the original private result event.
  f.expire();
  f.env.V2_FC_PUBLIC_READ_ONLY='true';
  const originalStore=f.store;
  await f.restartWithExpiredReadiness();
  assert.notEqual(f.store,originalStore);
  const degraded=(await f.call('/status')).body;
  assert.equal(degraded.spark.healthVerified,false);
  assert.equal(degraded.agentDevelopment.eventBackgroundAvailable,false);
  const owner=f.store.get('auth_user',actorId,PROJECT);
  f.store.update('auth_user',actorId,PROJECT,{status:'DISABLED'});
  const whileDisabled=f.queueCounts();
  assert.equal((await f.privateCall(event)).body.state,'REHEARSAL_OWNER_INACTIVE');
  assert.deepEqual(f.queueCounts(),whileDisabled);
  f.store.update('auth_user',actorId,PROJECT,{status:owner.status});
  const beforeSettlement=f.queueCounts();
  const settled=await f.privateCall(event);
  assert.equal(settled.status,200,settled.body.message);
  assert.equal(settled.body.state,'REHEARSAL_SETTLED');
  const duplicate=await f.privateCall(event);
  assert.equal(duplicate.body.state,'REHEARSAL_ALREADY_SETTLED');
  assert.deepEqual(f.queueCounts(),{...beforeSettlement,resultReads:beforeSettlement.resultReads+1});
  assert.equal(f.store.list('delivery_verification',PROJECT).length,1);
  assert.equal(f.store.list('release_approval',PROJECT).length,0);
  assert.equal(f.wakes.length,0);
  const readback=await f.call(taskPath+'/delivery-requests/'+deliveryRequestId);
  assert.equal(readback.body.verificationId,verificationId);
  assert.equal(readback.body.status,'SUCCEEDED');
  assert.equal(readback.body.stage,'AWAITING_ENGINEER_REVIEW');
  assert.equal(readback.body.packageDigest,bundle.digest);
  assert.equal((await f.call(deliveryPath,{expectedVersion:readback.body.version,rehearsal:{...exactPackage,verificationId}})).status,403);

  delete f.env.V2_FC_PUBLIC_READ_ONLY;
  f.alignWallClock();
  Object.assign(f.env,{V2_FC_PUBLIC_WRITE_SCOPE:'PUBLICATION_ONLY',
    V2_PUBLIC_PUBLICATION_STARTS_AT:new Date(f.now()-1000).toISOString(),
    V2_PUBLIC_PUBLICATION_EXPIRES_AT:new Date(f.now()+600000).toISOString(),
    V2_PUBLIC_PUBLICATION_TASK_ID:created.body.id,V2_PUBLIC_PUBLICATION_PACKAGE_DIGEST:bundle.digest,
    V2_PUBLIC_PUBLICATION_VERIFICATION_ID:verificationId,V2_PRIVATE_RELEASE_ENABLED:'true',
    V2_PRIVATE_RELEASE_TRIGGER_NAMES:'shuduo-release-fictional-first',V2_SCHEDULER_TICK_SECRET:'fictional-first-release-authorization-1234567890'});
  await f.restart();
  const selector={sourceKind:'AGENT',sourceRunId:current.runId,packageDigest:bundle.digest,verificationId};
  const preflightPath=publicationPreflightPath(created.body.id,selector);
  const rehearsalResult=f.store.get('delivery_verification',verificationId,PROJECT);
  const rehearsalQueue=f.queueCounts();
  f.store.update('delivery_verification',verificationId,PROJECT,{workerResultDigest:'f'.repeat(64)});
  assert.equal((await f.call(preflightPath)).status,409);
  assert.deepEqual(f.queueCounts(),rehearsalQueue);
  f.store.update('delivery_verification',verificationId,PROJECT,{workerResultDigest:rehearsalResult.workerResultDigest});
  const preflight=await f.call(preflightPath);
  assert.equal(preflight.status,200,preflight.body.message);
  const attestations={code:true,assertions:true,deliveryFiles:true,cloudScope:true};
  const publication=taskPath+'/publication', counts=f.counts();
  assert.equal((await f.call(publication,{...selector,attestations},randomUUID())).status,422);
  assert.equal((await f.call(publication,{...selector,attestations,reviewDigest:'0'.repeat(64)},randomUUID())).status,409);
  assert.equal(f.store.list('release',PROJECT).length,0);
  const request=cloudPublicationRequest(selector,bundle.id,attestations,preflight.body.reviewDigest);
  const accepted=await f.call(publication,request.body,request.idempotencyKey);
  assert.equal(accepted.status,202,accepted.body.message);
  assert.equal(accepted.body.release.sourceRunId,current.runId);
  assert.deepEqual(accepted.body.runs.map(run=>[run.sequence,run.status,run.schedulerTriggered]),[[1,'SCHEDULED',false],[2,'SCHEDULED',false]]);
  const original=await f.call(publicationRequestReceiptPath(created.body.id,request.idempotencyKey));
  assert.deepEqual(original.body,accepted.body);
  assert.equal(f.store.list('release_approval',PROJECT).length,1);
  assert.deepEqual(f.counts(),counts);

  const queueBeforeImport=f.queueCounts();
  const inspected=await cli('v3-inspect',['--workbench']);
  assert.equal(inspected.delivery.id,preparedFiles.body.id);
  assert.equal(inspected.delivery.rehearsal.id,verificationId);
  assert.equal(saved().outcomes[0].actions.delivery.key,deliveryRequestId);
  assert.equal((await cli('v3-review')).status,'REVIEW_EVIDENCE_BOUND');
  const beforePublication=readFileSync(checkpoint,'utf8');
  const receiptPath=publicationRequestReceiptPath(created.body.id,request.idempotencyKey);
  alter=(path,value)=>{if(path===receiptPath)value.release.reviewDigest='0'.repeat(64);};
  assert.equal((await cli('v3-publish',['--reconcile','--workbench'])).reason,'ORIGINAL_PUBLICATION_UNCONFIRMED');
  assert.equal(readFileSync(checkpoint,'utf8'),beforePublication);
  alter=undefined;
  const adopted=await cli('v3-publish',['--reconcile','--workbench']);
  const {releaseId,batchIds}=adopted.publication;
  assert.equal(releaseId,accepted.body.release.id);
  assert.deepEqual(batchIds,accepted.body.runs.map(run=>run.id));
  assert.equal(saved().outcomes[0].actions.publication.key,request.idempotencyKey);
  assert.deepEqual(saved().outcomes[0].actions.publication.approvalTiming,accepted.body.release.approvalTiming);
  assert.ok(Date.parse(accepted.body.release.approvalTiming.approvedAt)>=Date.parse(accepted.body.release.approvalTiming.readyAt));
  assert.equal(saved().submission.bill.unsettledReserveCny,64);
  const afterPublication=readFileSync(checkpoint,'utf8');
  assert.deepEqual(await cli('v3-publish',['--reconcile']),adopted);
  assert.equal(readFileSync(checkpoint,'utf8'),afterPublication);
  assert.deepEqual(f.queueCounts(),queueBeforeImport);
  assert.deepEqual(f.counts(),counts);

  f.later(1000);
  for (const [index,batchId] of batchIds.entries()) {
    if (index) f.later(60001);
    const triggerName=f.env.V2_PRIVATE_RELEASE_TRIGGER_NAMES,timestamp=String(f.now()),nonce=(index?'b':'a').repeat(24);
    const signed=JSON.stringify({releaseId,triggerName,expiresAt:f.now()+300000});
    const tick={triggerName,triggerTime:new Date(f.now()).toISOString(),payload:JSON.stringify({
      operation:'PRIVATE_RELEASE_TIMER_V1',timestamp,nonce,body:signed,
      signature:signSchedulerTick({sharedSecret:f.env.V2_SCHEDULER_TICK_SECRET,timestamp,nonce,body:signed}),
    })};
    assert.equal((await f.privateCall(tick)).status,200);
    const prepared=f.store.get('release_run',batchId,PROJECT).remoteSubmission.prepared;
    f.complete(prepared,measure?await measuredSpark(t,f,prepared,'workbench publication '+(index+1)):undefined);
    assert.equal((await f.privateCall(tick)).body.replayed,true);
  }
  const beforeUsage=readFileSync(checkpoint,'utf8'), queueBeforeReadback=f.queueCounts();
  const firstResult=f.store.get('release_run',batchIds[0],PROJECT);
  const secondResult=f.store.get('release_run',batchIds[1],PROJECT);
  assert.notEqual(firstResult.workerResultDigest,secondResult.workerResultDigest);
  f.store.update('release_run',batchIds[0],PROJECT,{workerResultDigest:secondResult.workerResultDigest});
  assert.equal((await cli('v3-publish',['--reconcile'])).publication.monitoringStatus,'UNCONFIRMED');
  assert.equal((await f.call('/releases/'+releaseId)).body.monitoringEvidence.status,'UNCONFIRMED');
  await cli('v3-consumption',['--batch-id',batchIds[0],'--out-file',join(f.directory,'wrong-worker-source.json')],1);
  assert.equal(existsSync(join(f.directory,'wrong-worker-source.json')),false);
  assert.equal(readFileSync(checkpoint,'utf8'),beforeUsage);
  assert.deepEqual(f.queueCounts(),queueBeforeReadback);
  f.store.update('release_run',batchIds[0],PROJECT,{workerResultDigest:firstResult.workerResultDigest});
  alter=(path,value)=>{if(path==='/status')value.budget.remoteSpark.runCount=1;};
  assert.equal((await cli('v3-publish',['--reconcile'])).reason,'WORKBENCH_USAGE_UNCONFIRMED');
  assert.equal(readFileSync(checkpoint,'utf8'),beforeUsage);
  alter=undefined;
  const monitored=await cli('v3-publish',['--reconcile']);
  assert.equal(monitored.publication.monitoringStatus,'VERIFIED');
  assert.deepEqual(monitored.publication.monitoring.map(row=>row.batchId),batchIds);
  assert.deepEqual(requests,[['GET','/auth/session'],['GET',receiptPath],['GET','/status']]);
  const usage=saved().outcomes[0].workbenchUsage;
  assert.equal(usage.modelCalls,1);
  assert.equal(usage.remoteSparkRuns,4);
  assert.deepEqual(monitored.workbenchUsage,usage);
  assert.deepEqual(f.queueCounts(),queueBeforeReadback);
  assert.deepEqual(f.counts(),{modelCalls:1,jobCreates:4});
  const consumed=[];
  for (const [index,batchId] of batchIds.entries())
    consumed.push(await consumeOriginalBatch(f,cli,{taskId:created.body.id,releaseId,packageDigest:bundle.digest,
      batchId,sequence:index+1,origin}));
  f.env.V2_FC_PUBLIC_READ_ONLY='true';
  await f.restart();
  assert.equal((await cli('v3-publish',['--reconcile'])).publication.monitoringStatus,'VERIFIED');
  const completionFile=join(f.directory,'workbench-completion.json');
  const completion=await cli('v3-complete',['--first-plan',consumed[0].flags[1],'--second-plan',consumed[1].flags[1],'--out-file',completionFile]);
  assert.equal(completion.scope,'LOCAL_MATCHED_ONLY');
  assert.equal(completion.independentlyVerifiedCloudCase,false);
  const run=await cli('v3-run',['--completion-file',completionFile]);
  assert.equal(run.verifiedCloudCaseCount,0);
  assert.equal(run.cases[0].status,'LOCAL_MATCHED_ONLY');
  assert.equal(run.score.localOnlySuccesses,1);
  assert.equal(run.score.reviewedCloudCompletionRate,null);
  assert.equal(run.score.reviewedCloudTargetStatus,'INCOMPLETE');
  const nextFile=join(f.directory,'next-workbench-case.json');
  assert.equal((await cli('v3-prepare-next',['--first-checkpoint',checkpoint,'--completion-file',completionFile,
    '--source-revision','a'.repeat(40)],0,nextFile)).status,'PREPARED');
  const next=JSON.parse(readFileSync(nextFile,'utf8'));
  assert.equal(next.previousCase.reserveCny,64);
  assert.deepEqual(next.previousCase.usageFloor,usage);
  assert.equal((await cli('v3-run',['--completion-file',completionFile,'--next-checkpoint',nextFile])).verifiedCloudCaseCount,0);
  assert.equal(f.store.list('release_approval',PROJECT).length,1);
  assert.equal(f.store.list('release_run',PROJECT).length,2);
  assert.deepEqual(f.queueCounts(),queueBeforeReadback);
});

test('a killed publication CLI recovers both original batches through signed scheduling and authorized consumption',async t=>{
  // Local HTTP, real local artifact I/O, synthetic provider and Worker receipts.
  const f=await fixture(t,{eventsEnabled:true,startupPreflight:true,structuredRequirement:true,stableOrigin:true,queueTimeoutMs:30000});
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
  let loseNextReceipt=false;
  const client=new V2Client({baseUrl:publicationCli.base,fetchImpl:async(url,options)=>{
    const target=new URL(url), path=target.pathname.slice('/api/v2'.length)+target.search;
    if(target.pathname==='/v2/'){
      requests.push({path:'/v2/',method:options.method});
      return new Response(fixtureFirstCloudIndex,{headers:{'content-type':'text/html; charset=utf-8'}});
    }
    const body=options.body?JSON.parse(options.body):undefined, key=options.headers['Idempotency-Key'];
    requests.push({path,method:options.method});
    if(path.endsWith('/prepare-delivery')){
      const [item]=JSON.parse(readFileSync(checkpoint,'utf8')).outcomes;
      savedAtDeliveryPost={...item.actions.delivery, postedKey:key, postedBody:body};
    }
    if(path.startsWith('/agent/deliveries/')&&path.endsWith('/advance')&&body?.rehearsal&&!body.rehearsal.verificationId)
      savedAtRehearsalPost=JSON.parse(readFileSync(checkpoint,'utf8')).outcomes[0].actions.rehearsal;
    const response=await f.call(path,body,key);
    if(loseNextReceipt&&options.method==='POST'&&path==='/agent/tasks'){
      assert.equal(response.status,202);
      loseNextReceipt=false;
      throw Error('SYNTHETIC_NEXT_RECEIPT_LOST');
    }
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
  const savedReader = createCloudPublication({ store: f.store, project: PROJECT, now: f.now });
  const originalReceipt = await f.call(receiptPath);
  assert.deepEqual(savedReader.savedRequestReceipt(task.id, savedAtPublicationPost.key,
    f.store.get('agent', task.id, PROJECT).submittedBy), originalReceipt.body);
  const privateReceipt={operation:'PRIVATE_APPLICATION_HTTP_V1',method:'GET',path:'/api/v2'+receiptPath};
  assert.equal(validatePrivateApplicationRequest(privateReceipt,{allowDurableAgentRead:true}).path,privateReceipt.path);
  assert.equal(f.store.list('delivery_review',PROJECT).length,1);
  assert.equal(f.store.list('release_approval',PROJECT).length,1);
  assert.equal(f.store.list('release',PROJECT).length,1);
  assert.equal(f.store.list('release_run',PROJECT).length,2);
  assert.deepEqual(f.queueCounts(),preflightQueue);

  const releaseId=found.publication.releaseId,[firstId,secondId]=found.publication.batchIds;
  const releaseRun=id=>f.store.get('release_run',id,PROJECT);
  const monitorHref='/v2/?'+new URLSearchParams({module:'ops',taskId:task.id,releaseId,revisionId:source.revisionId,
    firstBatchId:firstId,secondBatchId:secondId})+'#ops-exact-publication';
  const monitorTarget=opsPublicationTarget(new URL(monitorHref,f.base).href);
  const monitorReads=[];
  const monitorReader=async path=>{
    monitorReads.push(path);
    const result=await f.call(path);
    assert.equal(result.status,200);
    return result.body;
  };
  const exactSelection={...selector,releaseId}, publicationRead=taskPath+'/publication?'+new URLSearchParams(exactSelection);
  const publicationOptions={taskId:task.id,scope:'PRIVATE_CLOUD_TEST',selector,releaseId};
  const pendingLabels=async()=>{
    const receipt=await monitorReader(publicationRead);
    const workbench=checkedAgentPublication(receipt,publicationOptions);
    const ops=await readOpsPublication(monitorReader,monitorTarget);
    assert.deepEqual(ops.batches.map(batch=>batch.id),[firstId,secondId]);
    assert.deepEqual(ops.batches.map(batch=>batch.pendingLabel),workbench.runs.map(privateReleasePendingLabel));
    assert.ok(ops.batches.every(batch=>batch.serviceHref===undefined&&batch.reportSource===undefined));
    return receipt;
  };
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
  const firstResultEvent=f.resultEvent(first.resultKey);
  const reserved=(await f.call('/status')).body.budget.remoteSpark;
  assert.equal(reserved.runCount,3);
  assert.equal(releaseRun(firstId).reservedDurationMs,30000);
  await f.restart();
  f.later(29999);
  const lostQueue=f.queueCounts();
  const waiting=(await cli('v3-publish',['--reconcile'])).publication;
  assert.equal(waiting.monitoringStatus,'PENDING');
  assert.deepEqual(waiting.batches,[{id:firstId,status:'RUNNING',stage:'SUBMITTING',reservedDurationMs:30000},{id:secondId,status:'SCHEDULED'}]);
  const submissionPending=await pendingLabels();
  assert.equal(submissionPending.release.status,'RUNNING_CLOUD_TEST');
  assert.equal(privateReleasePendingLabel(submissionPending.runs[0]),'提交待确认');
  assert.equal(privateReleasePendingLabel({...submissionPending.runs[0],stage:'unknown'}),'运行阶段待确认');
  assert.equal(privateReleasePendingLabel({...submissionPending.runs[0],schedulerTriggered:false}),'运行阶段待确认');
  assert.throws(()=>checkedAgentPublication({...submissionPending,runs:[{...submissionPending.runs[0],reviewDigest:'f'.repeat(64)},submissionPending.runs[1]]},publicationOptions));
  const originalClaim=releaseRun(firstId);
  f.later(1);
  const expiredSubmission=await pendingLabels();
  assert.equal(privateReleasePendingLabel(expiredSubmission.runs[0]),'结果待核对');
  assert.equal(expiredSubmission.runs[0].status,'RUNNING');
  assert.equal(expiredSubmission.runs[0].reservedDurationMs,30000);
  assert.equal(expiredSubmission.runs[0].remoteSubmission,undefined);
  const expiredCli=(await cli('v3-publish',['--reconcile'])).publication;
  assert.equal(expiredCli.monitoringStatus,'PENDING');
  assert.deepEqual(expiredCli.batches[0],{id:firstId,status:'RUNNING',stage:'WORKER_RESULT_UNCONFIRMED',reservedDurationMs:30000});
  assert.deepEqual(releaseRun(firstId),originalClaim);
  assert.deepEqual(f.queueCounts(),lostQueue);
  f.later(30000);
  assert.equal((await f.privateCall(timer('b'))).status,200);
  assert.equal((await f.privateCall(timer('a'))).status,409,'changing the signed time with the original nonce is rejected');
  assert.deepEqual((await f.call('/status')).body.budget.remoteSpark,reserved);
  assert.equal(releaseRun(secondId).status,'SCHEDULED');
  assert.equal(f.queueCounts().jobWriteAttempts,lostQueue.jobWriteAttempts);
  assert.equal(f.queueCounts().cancellationWrites,0);

  const earlyReplay=await f.privateCall(firstTimer);
  assert.equal(earlyReplay.status,200);
  assert.equal(earlyReplay.body.succeeded,0);
  assert.equal(earlyReplay.body.pending,2);
  assert.equal(releaseRun(firstId).status,'RUNNING');
  assert.equal(releaseRun(secondId).status,'SCHEDULED');
  assert.equal(f.queueCounts().jobWriteAttempts,lostQueue.jobWriteAttempts);
  assert.equal(f.queueCounts().cancellationWrites,0);

  const beforeEvent=f.queueCounts();
  assert.equal((await f.privateCall(f.resultEvent(first.resultKey.replace(firstId,secondId)))).body.code,'PUBLIC_PUBLICATION_SCOPE_DENIED');
  assert.deepEqual(f.queueCounts(),beforeEvent);
  assert.equal((await f.privateCall(firstResultEvent)).status,503);
  assert.deepEqual(releaseRun(firstId),originalClaim);
  const beforeFakeIngress=f.queueCounts();
  const fakeIngress=await fetch(f.base.replace(/\/api\/v2$/,'')+'/invoke',{
    method:'POST',headers:{'content-type':'application/json','x-fc-control-path':'/http-invoke'},body:JSON.stringify(firstResultEvent),
  });
  assert.equal(fakeIngress.status,404);
  assert.deepEqual(f.queueCounts(),beforeFakeIngress);
  const useRealSpark=process.env.SHUDUO_TEST_LOCAL_SPARK_RELEASE==='true';
  f.complete(first,undefined,'0'.repeat(64));
  assert.equal((await f.privateCall(firstResultEvent)).body.code,'SPARK_QUEUE_RESULT_INVALID');
  assert.deepEqual(releaseRun(firstId),originalClaim);
  f.complete(first,useRealSpark?await measuredSpark(t,f,first,'release batch 1'):undefined);
  const publicationTaskId=f.env.V2_PUBLIC_PUBLICATION_TASK_ID;
  f.env.V2_PUBLIC_PUBLICATION_TASK_ID=randomUUID();
  await f.restart();
  const beforeWrongWindow=f.queueCounts();
  assert.equal((await f.privateCall(firstResultEvent)).body.code,'PUBLIC_PUBLICATION_TARGET_MISMATCH');
  assert.deepEqual(f.queueCounts(),beforeWrongWindow);
  f.env.V2_PUBLIC_PUBLICATION_TASK_ID=publicationTaskId;
  f.later(180001);
  await f.restart();
  assert.equal((await f.privateCall(firstTimer)).body.code,'PRIVATE_RELEASE_TIMER_INVALID');
  assert.equal((await f.privateCall(firstResultEvent)).body.state,'RELEASE_BATCH_SETTLED');
  const afterFirstEvent=f.queueCounts();
  assert.equal((await f.privateCall(firstResultEvent)).body.state,'RELEASE_BATCH_ALREADY_SETTLED');
  assert.deepEqual(f.queueCounts(),afterFirstEvent);
  assert.equal(releaseRun(firstId).status,'SUCCEEDED');
  assert.equal(releaseRun(secondId).status,'SCHEDULED');
  assert.equal(f.store.list('monitor_event',PROJECT).length,1);
  assert.equal(afterFirstEvent.jobWriteAttempts,lostQueue.jobWriteAttempts);
  const firstTick=f.store.list('cloud_release_tick',PROJECT).find(record=>record.batchId===firstId);
  assert.equal(firstTick.summary.succeeded,1);
  f.env.V2_FC_PUBLIC_READ_ONLY='true';
  await f.restart();
  assert.equal((await f.privateCall(timer('q'))).body.code,'PUBLIC_PUBLICATION_CLOSED');
  assert.equal(releaseRun(secondId).status,'SCHEDULED');
  assert.deepEqual(f.queueCounts(),afterFirstEvent);
  delete f.env.V2_FC_PUBLIC_READ_ONLY;
  await f.restart();
  const competing=await Promise.all([f.privateCall(timer('c')),f.privateCall(timer('e'))]);
  assert.ok(competing.every(response=>response.status===200));
  const second=releaseRun(secondId).remoteSubmission.prepared;
  assert.equal(second.job.jobId,secondId);
  const beforeAcknowledgedRead=f.queueCounts();
  const acknowledged=await pendingLabels();
  assert.equal(privateReleasePendingLabel(acknowledged.runs[0]),undefined);
  assert.equal(privateReleasePendingLabel(acknowledged.runs[1]),'等待 Worker 结果');
  assert.equal((await cli('v3-publish',['--reconcile'])).publication.batches[1].stage,'WAITING_FOR_WORKER_RESULT');
  const originalAcknowledged=releaseRun(secondId);
  f.later(30000);
  const expiredAcknowledgement=await pendingLabels();
  assert.equal(privateReleasePendingLabel(expiredAcknowledgement.runs[1]),'结果待核对');
  assert.equal(expiredAcknowledgement.runs[1].status,'RUNNING');
  assert.deepEqual(releaseRun(secondId),originalAcknowledged);
  const mcpRead=JSON.parse(await handleV2Mcp({jsonrpc:'2.0',id:10,method:'tools/call',
    params:{name:'agent_publication_detail',arguments:{taskId:task.id,...exactSelection}}},
    {client:{request:monitorReader}}));
  assert.ok(mcpRead.result,mcpRead.error?.message);
  assert.deepEqual(JSON.parse(mcpRead.result.content[0].text).runs.map(run=>run.stage),['COMPLETED','WORKER_RESULT_UNCONFIRMED']);
  assert.deepEqual(f.queueCounts(),beforeAcknowledgedRead);
  f.complete(second,useRealSpark?await measuredSpark(t,f,second,'release batch 2'):undefined);
  const beforeOldReplay=f.queueCounts();
  assert.equal((await f.privateCall(firstResultEvent)).body.state,'RELEASE_BATCH_ALREADY_SETTLED');
  assert.equal(releaseRun(secondId).status,'RUNNING','replaying result one must not settle batch two');
  assert.deepEqual(f.queueCounts(),beforeOldReplay);
  f.later(600001);
  const priorOwner=f.store.list('auth_user',PROJECT).length;
  await f.restartWithExpiredReadiness();
  const degraded=(await f.call('/status')).body;
  assert.equal(degraded.spark.healthVerified,false);
  assert.equal(degraded.agentDevelopment.publishAvailable,false);
  assert.equal(degraded.agentDevelopment.eventBackgroundAvailable,false);
  assert.equal((await f.call('/auth/session')).body.readOnly,true);
  assert.equal((await f.call('/agent/tasks',taskInput,randomUUID())).status,403);
  assert.equal((await f.privateCall(timer('d'))).status,401);
  assert.equal(f.store.list('auth_user',PROJECT).length,priorOwner);
  assert.deepEqual(f.queueCounts(),beforeOldReplay);
  const secondResultEvent=f.resultEvent(second.resultKey);
  assert.equal((await f.privateCall(secondResultEvent)).body.state,'RELEASE_BATCH_SETTLED');
  const afterSecondEvent=f.queueCounts();
  assert.equal((await f.privateCall(secondResultEvent)).body.state,'RELEASE_BATCH_ALREADY_SETTLED');
  assert.deepEqual(afterSecondEvent,{...beforeOldReplay,resultReads:beforeOldReplay.resultReads+1});
  assert.deepEqual(f.queueCounts(),afterSecondEvent);
  delete f.env.V2_FC_PUBLIC_WRITE_SCOPE;
  delete f.env.V2_PRIVATE_RELEASE_ENABLED;
  await f.restart();
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
  assert.equal(opsPublicationTarget(new URL(monitorHref.replace('#','&releaseId='+releaseId+'#'),f.base).href),null);
  monitorReads.length=0;
  const monitoringBefore=f.queueCounts();
  const opsEvidence=await readOpsPublication(monitorReader,monitorTarget);
  assert.deepEqual(monitorReads,['/releases/'+releaseId,'/release/runs/'+firstId,'/release/runs/'+secondId]);
  const {batches:monitorBatches,status:monitorStatus,health:monitorHealth,monitoringVerified}=opsEvidence;
  assert.deepEqual({monitorStatus,monitorHealth,monitoringVerified},{monitorStatus:'COMPLETED_CLOUD_TEST',monitorHealth:'HEALTHY',monitoringVerified:true});
  assert.deepEqual(monitorBatches.map(({serviceHref,reportSource,...batch})=>batch),[
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
    const reportLocation=new URL(monitorHref,f.base);
    reportLocation.searchParams.set('reportBatchId',batch.id);
    assert.equal(opsPublicationTarget(reportLocation.href).reportBatchId,batch.id);
    reportLocation.searchParams.append('reportBatchId',batch.id);
    assert.equal(opsPublicationTarget(reportLocation.href),null);
  }
  const onePending=await readOpsPublication(async path=>{
    const record=await monitorReader(path);
    return path.endsWith(secondId)?{...record,status:'RUNNING'}:record;
  },monitorTarget);
  assert.ok(onePending.batches.every(batch=>batch.serviceHref===undefined&&batch.reportSource===undefined));
  for (const releaseState of [{status:'RUNNING'}, {health:'DEGRADED'}]) {
    const ineligible=await readOpsPublication(async path=>{
      const record=await monitorReader(path);
      return path.endsWith(releaseId)?{...record,...releaseState}:record;
    },monitorTarget);
    assert.ok(ineligible.batches.every(batch=>batch.serviceHref===undefined&&batch.reportSource===undefined));
  }
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
  const completionFile=join(f.directory,'case-completion.json');
  const completionFlags=['--first-plan',firstConsumption.flags[1],'--second-plan',join(f.directory,'consumer-plan-2.json'),'--out-file',completionFile];
  await cli('v3-complete',completionFlags,1);
  assert.equal(existsSync(completionFile),false);
  const missingReport=await f.call(privateBatchReportPath(monitorBatches[1].reportSource));
  assert.equal(missingReport.status,404);
  assert.equal(missingReport.body.code,'PRIVATE_BATCH_REPORT_SNAPSHOT_MISSING');
  const secondConsumption=await consumeOriginalBatch(f,cli,{taskId:task.id,releaseId,packageDigest:pending.packageDigest,batchId:secondId,sequence:2,origin});
  assert.equal(firstConsumption.bound.consumption.batchId,firstId);
  assert.equal(secondConsumption.bound.consumption.batchId,secondId);
  assert.deepEqual(f.queueCounts(),queuesBeforeConsumption);

  // Verify the exact snapshots over authenticated HTTP after closing writes.
  f.env.V2_FC_PUBLIC_READ_ONLY='true';
  await f.restart();
  const beforeCompletion=readFileSync(checkpoint,'utf8');
  const incorrectOrder=['--first-plan',secondConsumption.flags[1],'--second-plan',firstConsumption.flags[1],'--out-file',completionFile];
  await cli('v3-complete',incorrectOrder,1);
  assert.deepEqual(requests,[]);
  assert.equal(existsSync(completionFile),false);
  const completion=await cli('v3-complete',completionFlags);
  assert.equal(completion.status,'COMPLETION_RECEIPT_SAVED');
  assert.equal(completion.scope,'LOCAL_MATCHED_ONLY');
  assert.equal(completion.independentlyVerifiedCloudCase,false);
  assert.equal(requests.length,10);
  assert.ok(requests.every(request=>request.method==='GET'));
  assert.equal(statSync(completionFile).mode&0o777,0o600);
  const run=await cli('v3-run',['--completion-file',completionFile]);
  assert.deepEqual(requests,[]);
  assert.equal(run.cases.length,20);
  assert.equal(run.verifiedCloudCaseCount,0);
  assert.equal(run.cases[0].status,'LOCAL_MATCHED_ONLY');
  assert.equal(run.cases.filter(item=>item.status==='WAITING_FOR_SOURCE').length,9);
  assert.equal(run.cases.find(item=>item.sourceCaseId===run.cases[0].caseId).status,'LOCAL_SOURCE_MATCHED');
  const changedCompletion=join(f.directory,'changed-completion.json');
  const receipt=JSON.parse(readFileSync(completionFile,'utf8'));
  writeFileSync(changedCompletion,JSON.stringify({...receipt,revisionId:randomUUID()}),{mode:0o600});
  await cli('v3-run',['--completion-file',changedCompletion],1);
  assert.deepEqual(requests,[]);
  assert.equal(readFileSync(checkpoint,'utf8'),beforeCompletion);
  assert.deepEqual(f.queueCounts(),queuesBeforeConsumption);

  const other={email:'other-report-owner@example.invalid',password:'SyntheticJourney!2026',displayName:'其他虚构管理员'};
  f.addAdmin(other);
  const otherLogin=await f.call('/auth/login',{email:other.email,password:other.password});
  assert.equal(otherLogin.status,200);
  const otherCookie=otherLogin.cookies.map(value=>value.split(';')[0]).join('; ');
  const beforeReportReads=f.store.db.prepare('SELECT count(*) AS n FROM documents').get().n;
  const beforeReportExecution=f.counts();
  const [firstReport,secondReport]=await Promise.all(monitorBatches.map(batch=>f.call(privateBatchReportPath(batch.reportSource))));
  for (const [index, response] of [firstReport,secondReport].entries()) {
    assert.equal(response.status,200,JSON.stringify({code:response.body.code,message:response.body.message}));
    const {digest,...summary}=response.body, binding=monitorBatches[index].reportSource;
    assert.deepEqual(summary.source,binding);
    assert.equal(summary.provenance.snapshotId,'release-run:'+binding.batchId);
    assert.equal(summary.provenance.publicationReviewDigest,releaseRecord.reviewDigest);
    assert.equal(summary.provenance.businessDate,getContext('holdings-t1').businessDate);
    assert.equal(summary.provenance.rowCount,2);
    assert.deepEqual(summary.metrics.map(metric=>metric.value),['2750.00','2250.00','500.00']);
    assert.equal(summary.reportReview,'NOT_INCLUDED');
    assert.equal(await reportEvidenceDigest(summary),digest);
    assert.ok(!JSON.stringify(summary).includes('CLIENT-001'));
    const exportPath=privateBatchReportPath(binding,digest), downloaded=await f.call(exportPath);
    assert.equal(downloaded.headers.get('cache-control'),'no-store');
    assert.equal(downloaded.headers.get('content-disposition'),`attachment; filename="shuduo-batch-report-${binding.batchId.slice(0,8)}.json"`);
    assert.deepEqual(downloaded.body,response.body);
    assert.equal((await f.call(privateBatchReportPath(binding,'a'.repeat(64)))).status,409);
    const denied=await fetch(f.base+exportPath,{headers:{cookie:otherCookie}});
    assert.equal(denied.status,404);
    assert.ok(!(await denied.text()).includes(summary.provenance.snapshotDigest));
  }
  assert.notEqual(firstReport.body.digest,secondReport.body.digest);
  const boundReport=monitorBatches[0].reportSource, boundPath=privateBatchReportPath(boundReport);
  const clientForReport={request:async path=>{
    const response=await f.call(path);
    assert.equal(response.status,200);
    return response.body;
  }};
  const mcp=JSON.parse(await handleV2Mcp({jsonrpc:'2.0',id:1,method:'tools/call',
    params:{name:'report_batch_summary',arguments:{source:boundReport}}},{client:clientForReport}));
  assert.ok(mcp.result,mcp.error?.message);
  assert.deepEqual(JSON.parse(mcp.result.content[0].text),firstReport.body);
  const sourceFile=join(f.directory,'batch-report-source.json'), reportFile=join(f.directory,'batch-report.json');
  writeFileSync(sourceFile,JSON.stringify(boundReport),{mode:0o600});
  const downloadArgs=['reports','batch-summary','--source-file',sourceFile,'--download-digest',firstReport.body.digest,'--out-file',reportFile];
  assert.equal(await runV2Cli(downloadArgs,{},{client:clientForReport,output:()=>{},error:value=>{throw Error(value);}}),0);
  assert.equal(statSync(reportFile).mode&0o777,0o600);
  assert.deepEqual(JSON.parse(readFileSync(reportFile,'utf8')),firstReport.body);
  const offline={request:()=>{throw Error('Offline verification must not use HTTP');}};
  const verifyArgs=['reports','verify-batch-summary','--file',reportFile];
  assert.equal(await runV2Cli(verifyArgs,{},{client:offline,output:value=>{
    const result=JSON.parse(value);
    assert.equal(result.digest,firstReport.body.digest);
    assert.equal(result.onlineAuthorityVerified,false);
  },error:value=>{throw Error(value);}}),0);
  assert.equal(await runV2Cli(downloadArgs,{},{client:clientForReport,output:()=>{},error:()=>{}}),1);
  assert.deepEqual(JSON.parse(readFileSync(reportFile,'utf8')),firstReport.body);
  const tamperedReport=structuredClone(firstReport.body);
  tamperedReport.metrics[0].value='1.00';
  writeFileSync(reportFile,JSON.stringify(tamperedReport),{mode:0o600});
  assert.equal(await runV2Cli(verifyArgs,{},{client:offline,output:()=>{},error:()=>{}}),1);
  assert.equal((await fetch(f.base+boundPath)).status,401);
  assert.equal((await fetch(f.base+boundPath,{headers:{cookie:otherCookie,'x-project-id':'other-project'}})).status,403);
  assert.equal((await f.call(privateBatchReportPath({...boundReport,batchId:randomUUID()}))).status,404);
  assert.equal((await f.call(privateBatchReportPath({...boundReport,revisionId:randomUUID()}))).status,409);
  assert.equal((await f.call(boundPath+'&batchId='+boundReport.batchId)).status,422);
  assert.equal((await f.call(boundPath,{})).status,403);
  const db=f.businessStore.db, snapshotId=firstReport.body.provenance.snapshotId;
  db.prepare('UPDATE service_snapshots SET content_hash=? WHERE id=?').run('b'.repeat(64),snapshotId);
  assert.equal((await f.call(boundPath)).status,409);
  db.prepare('UPDATE service_snapshots SET content_hash=? WHERE id=?').run(firstReport.body.provenance.snapshotDigest,snapshotId);
  assert.equal((await f.call(boundPath)).body.digest,firstReport.body.digest);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM documents').get().n,beforeReportReads);
  assert.deepEqual(f.counts(),beforeReportExecution);
  assert.deepEqual(f.queueCounts(),queuesBeforeConsumption);

  const archiveDraft={source:boundReport,summaryDigest:firstReport.body.digest,title:'虚构财富顾问资产分析',
    requirement:'核对原批次客户资产、持仓和现金汇总，并保留审阅依据。'};
  const reviewedArchive=await prepareBatchArchive(archiveDraft), archiveRequestId=randomUUID();
  assert.equal((await f.call(batchArchiveListPath(boundReport))).body.canArchive,false);
  assert.equal((await f.call(batchArchiveRoute,reviewedArchive,archiveRequestId)).status,403);
  delete f.env.V2_FC_PUBLIC_READ_ONLY;
  delete f.env.V2_FC_PUBLIC_WRITE_SCOPE;
  await f.restart();
  assert.equal((await f.call(batchArchiveRoute,reviewedArchive,archiveRequestId)).status,403);
  f.env.V2_PRIVATE_BATCH_REPORT_ARCHIVE_ENABLED='true';
  await f.restart();
  assert.equal((await f.call(batchArchiveListPath(boundReport))).body.canArchive,true);
  assert.equal((await f.call(batchArchiveRoute,{...reviewedArchive,draft:{...archiveDraft,title:'被替换的归档'}},archiveRequestId)).status,409);
  const stale=await prepareBatchArchive({...archiveDraft,summaryDigest:secondReport.body.digest});
  assert.equal((await f.call(batchArchiveRoute,stale,archiveRequestId)).status,409);
  const otherWrite=await fetch(f.base+batchArchiveRoute,{method:'POST',headers:{cookie:otherCookie,
    'x-shuduo-client':'workbench','x-csrf-token':otherLogin.body.csrfToken,'content-type':'application/json',
    'idempotency-key':archiveRequestId},body:JSON.stringify(reviewedArchive)});
  assert.equal(otherWrite.status,404);
  assert.equal(f.store.list('private_batch_report_archive',PROJECT).length,0);

  const archiveClient={request:async (path,options)=>{
    const response=await f.call(path,options?.body,options?.idempotencyKey);
    assert.ok(response.status===200||response.status===201);
    return response.body;
  }};
  let submittedArchive;
  await assert.rejects(submitBatchArchive({request:async (path,options)=>{
    submittedArchive=await archiveClient.request(path,options);
    throw Error('simulated connection loss after archive commit');
  }},{...reviewedArchive,requestId:archiveRequestId}),/connection loss/);
  await f.restart();
  const recoveredArchive=await readBatchArchive(archiveClient,{requestId:archiveRequestId,source:boundReport,reviewedDigest:reviewedArchive.reviewedDigest});
  assert.deepEqual(recoveredArchive,submittedArchive);
  assert.equal(recoveredArchive.reportVersion,1);
  assert.equal(recoveredArchive.review.draft.requirement,archiveDraft.requirement);
  assert.deepEqual(recoveredArchive.summary,firstReport.body);
  assert.deepEqual(await submitBatchArchive(archiveClient,{...reviewedArchive,requestId:archiveRequestId}),recoveredArchive);
  const secondReview=await prepareBatchArchive({...archiveDraft,title:'虚构财富顾问资产分析复核版'});
  assert.equal((await f.call(batchArchiveRoute,secondReview,archiveRequestId)).status,409);
  const secondArchive=await submitBatchArchive(archiveClient,{...secondReview,requestId:randomUUID()});
  assert.equal(secondArchive.reportVersion,2);
  assert.equal(f.store.list('private_batch_report_archive',PROJECT).length,2);
  assert.ok(!(await f.call('/reports/overview')).body.reports.some(report=>report.name===archiveDraft.title));
  assert.deepEqual((await f.call(batchArchiveListPath(boundReport))).body.entries.map(entry=>entry.reportVersion),[2,1]);
  assert.deepEqual((await f.call(batchArchiveListPath(monitorBatches[1].reportSource))).body.entries,[]);
  assert.equal((await fetch(f.base+batchArchiveRequestPath(archiveRequestId),{headers:{cookie:otherCookie}})).status,404);
  assert.equal((await fetch(f.base+batchArchiveRequestPath(archiveRequestId))).status,401);
  f.env.V2_FC_PUBLIC_READ_ONLY='true';
  await f.restart();
  assert.equal((await f.call(batchArchiveRoute,reviewedArchive,archiveRequestId)).status,403);
  const archivedFile=await f.call(batchArchiveRequestPath(archiveRequestId)+'?download_digest='+recoveredArchive.digest);
  assert.equal(archivedFile.status,200);
  assert.equal(archivedFile.headers.get('cache-control'),'no-store');
  assert.match(archivedFile.headers.get('content-disposition'),/^attachment; filename="shuduo-batch-archive-/);
  assert.deepEqual(archivedFile.body,recoveredArchive);
  const archivedAgentHref='https://journey.example.invalid/v2/?module=agent-center&task='+task.id;
  const archivePin={requestId:archiveRequestId,batchId:firstId,digest:recoveredArchive.digest};
  const bookmark=new URL(agentArchiveHref(archivedAgentHref,task.id,archivePin),archivedAgentHref);
  assert.equal(bookmark.hash,'#agent-report-archives');
  assert.deepEqual(agentArchivePin(bookmark.href,task.id),archivePin);
  assert.equal(agentArchivePin(bookmark.href,randomUUID()),null);
  const duplicate=new URL(bookmark);
  duplicate.searchParams.append('archiveBatch',secondId);
  assert.equal(agentArchivePin(duplicate.href,task.id),null);
  const incomplete=new URL(bookmark);
  incomplete.searchParams.delete('archiveDigest');
  assert.equal(agentArchivePin(incomplete.href,task.id),null);
  const removed=clearAgentArchivePin(new URL(bookmark));
  assert.equal(removed.searchParams.get('task'),task.id);
  assert.equal(agentArchivePin(removed.href,task.id),undefined);
  const reopened=await readBatchArchive(archiveClient,{requestId:agentArchivePin(bookmark.href,task.id).requestId});
  assert.deepEqual(checkedAgentArchive(reopened,task.id,archivePin),recoveredArchive);
  assert.throws(()=>checkedAgentArchive(reopened,task.id,{...archivePin,batchId:secondId}),/不一致/);
  assert.throws(()=>checkedAgentArchive(reopened,task.id,{...archivePin,digest:secondArchive.digest}),/不一致/);
  assert.throws(()=>checkedAgentArchive(secondArchive,task.id,archivePin),/不一致/);
  assert.equal((await f.call(batchArchiveRequestPath(archiveRequestId)+'?download_digest='+'0'.repeat(64))).status,409);
  const archiveFile=join(f.directory,'batch-archive.json');
  writeFileSync(archiveFile,JSON.stringify(archivedFile.body),{mode:0o600});
  const verifyArchive=['reports','verify-batch-archive','--file',archiveFile];
  assert.equal(await runV2Cli(verifyArchive,{},{client:offline,output:()=>{},error:value=>{throw Error(value);}}),0);
  const changedArchive=structuredClone(archivedFile.body);
  changedArchive.review.draft.requirement='不符合原审阅的修改';
  writeFileSync(archiveFile,JSON.stringify(changedArchive),{mode:0o600});
  assert.equal(await runV2Cli(verifyArchive,{},{client:offline,output:()=>{},error:()=>{}}),1);
  const archiveMcp=JSON.parse(await handleV2Mcp({jsonrpc:'2.0',id:2,method:'tools/call',
    params:{name:'report_batch_archive',arguments:{requestId:archiveRequestId}}},{client:archiveClient}));
  assert.deepEqual(archiveMcp.result.structuredContent,recoveredArchive);
  const storedArchive=f.store.list('private_batch_report_archive',PROJECT).find(record=>record.receipt.review.requestId===archiveRequestId);
  const {digest:originalDigest,...rehashed}=structuredClone(storedArchive.receipt);
  rehashed.review.draft.title='写入后改过的名称';
  rehashed.review.reviewedDigest=await reportEvidenceDigest(rehashed.review.draft);
  f.store.update('private_batch_report_archive',storedArchive.id,PROJECT,{receipt:{...rehashed,digest:await reportEvidenceDigest(rehashed)}});
  assert.equal((await f.call(batchArchiveRequestPath(archiveRequestId))).body.code,'BATCH_REPORT_ARCHIVE_CHANGED');
  f.store.update('private_batch_report_archive',storedArchive.id,PROJECT,{receipt:storedArchive.receipt});
  assert.equal((await f.call(batchArchiveRequestPath(archiveRequestId))).body.digest,originalDigest);
  assert.deepEqual(f.counts(),beforeReportExecution);
  assert.deepEqual(f.queueCounts(),queuesBeforeConsumption);

  const sources=new URLSearchParams({agent_task_id:task.id,package_digest:pending.packageDigest,release_id:releaseId});
  f.store.update('release',releaseId,PROJECT,{reviewDigest:undefined});
  assert.deepEqual((await f.call('/data-services/sources?'+sources)).body,[]);
  f.store.update('release',releaseId,PROJECT,{reviewDigest:releaseRecord.reviewDigest});
  const event=complete.monitoring[0];
  f.store.update('monitor_event',event.eventId,PROJECT,{observedAt:'2000-01-01T00:00:00.000Z'});
  const checkpointBytes=readFileSync(checkpoint,'utf8');
  assert.equal((await f.call(receiptPath)).body.monitoring.status,'UNCONFIRMED');
  assert.deepEqual(await readBatchArchive(archiveClient,{requestId:archiveRequestId,source:boundReport}),recoveredArchive);
  assert.deepEqual((await f.call('/data-services/sources?'+sources)).body,[]);
  assert.equal((await cli('v3-publish',['--reconcile'])).reason,'ORIGINAL_PUBLICATION_UNCONFIRMED');
  await cli('v3-consumption',secondConsumption.flags,1);
  assert.equal(readFileSync(checkpoint,'utf8'),checkpointBytes);

  {
    const nextPath=join(f.directory,'next-case.json'), inspectionPath=join(f.directory,'next-inspection.json'),
      windowPath=join(f.directory,'next-window.json');
    const nextCli=async(action,flags=[],exit=0,path=nextPath)=>{
      requests.length=0;
      let value,message;
      const code=await runV2Cli(['agent',action,'--checkpoint',path,...flags],{},
        {client,output:line=>{value=JSON.parse(line);},error:line=>{message=line;}});
      assert.equal(code,exit,message);
      return value;
    };
    const nextSource='a'.repeat(40);
    const preparation=['--first-checkpoint',checkpoint,'--completion-file',completionFile,'--source-revision',nextSource];
    const prepared=await nextCli('v3-prepare-next',preparation);
    assert.equal(prepared.caseId,'v3-fresh--cash-change');
    assert.equal(prepared.evaluationRunId,run.evaluationRunId);
    const otherPath=join(f.directory,'same-next-case.json');
    await nextCli('v3-prepare-next',preparation,0,otherPath);
    const binding=await nextCli('v3-start',['--window-binding']);
    assert.equal(binding.requestKeyHash,(await nextCli('v3-start',['--window-binding'],0,otherPath)).requestKeyHash);
    assert.equal(binding.previousCase.reserveCny,64);
    assert.equal(binding.previousCase.completionDigest,completion.completionDigest);
    const inspection=fixtureFirstCloudInspection(nextSource,'b'.repeat(40));
    writeFileSync(inspectionPath,JSON.stringify(inspection),{mode:0o600});
    const runtimeDigest=developmentRequestDigest(binding.requestKeyHash,binding.requestBodyHash);
    f.alignWallClock();
    const startsAt=new Date(f.now()).toISOString(), expiresAt=new Date(f.now()+60000).toISOString();
    Object.assign(f.env,{V2_FC_PUBLIC_READ_ONLY:'false',V2_FC_PUBLIC_WRITE_SCOPE:'DEVELOPMENT_ONLY',
      V2_PUBLIC_DEVELOPMENT_STARTS_AT:startsAt,V2_PUBLIC_DEVELOPMENT_EXPIRES_AT:expiresAt,
      V2_PUBLIC_DEVELOPMENT_REQUEST_DIGEST:runtimeDigest});
    await f.restart();
    const validWindow={protocol:nextCloudWindowReceiptProtocol,checkpoint:binding,approvalDigest:'d'.repeat(64),startsAt,expiresAt,
      application:{...cloudWindowApplicationBinding(inspection,binding),crc64:'123456789'},
      bill:{month,checkedAt:startsAt,spendCny:20,recordCount:1,pagesDigest:'e'.repeat(64),unsettledReserveCny:64,maxIncrementCny:2}};
    const approve=['--window-file',windowPath,'--application-file',inspectionPath,'--bill-file',billPath,'--confirm'];
    writeBill(64);
    const nextPreparedBytes=readFileSync(nextPath,'utf8');
    await nextCli('v3-start',confirm,1);
    assert.deepEqual(requests,[]);
    writeFileSync(windowPath,JSON.stringify({...validWindow,protocol:firstCloudWindowReceiptProtocol}),{mode:0o600});
    await nextCli('v3-start',approve,1);
    assert.deepEqual(requests,[]);
    writeFileSync(windowPath,JSON.stringify(validWindow));
    assert.equal((await f.call('/agent/tasks',{...taskInput,contextId:'cash-change'},randomUUID())).body.code,'PUBLIC_DEVELOPMENT_REQUEST_ONLY');
    const preparedState=JSON.parse(nextPreparedBytes);
    const requestKey=preparedState.outcomes[0].actions.agent.key;
    assert.equal((await f.call('/agent/tasks',{...taskInput,contextId:'cash-change'},requestKey)).body.code,'PUBLIC_DEVELOPMENT_REQUEST_ONLY');
    assert.equal(readFileSync(nextPath,'utf8'),nextPreparedBytes);
    const beforeNext=f.counts();
    await nextCli('v3-start',approve,1);
    assert.deepEqual(requests,[{path:'/status?include=session',method:'GET'}]);
    assert.equal(readFileSync(nextPath,'utf8'),nextPreparedBytes);
    // The first fixture used its four-run cap. Reopen the fixture with a
    // separately provisioned allowance while keeping all recorded usage.
    f.env.V2_MONTHLY_REMOTE_SPARK_RUN_LIMIT='8';
    await f.restart();
    loseNextReceipt=true;
    assert.equal((await nextCli('v3-start',approve)).reason,'RECONCILE_ORIGINAL_CREATION');
    assert.deepEqual(requests,[{path:'/status?include=session',method:'GET'},{path:'/v2/',method:'GET'},{path:'/agent/tasks',method:'POST'}]);
    assert.equal((await nextCli('v3-start',approve)).reason,'RECONCILE_ORIGINAL_CREATION');
    assert.deepEqual(requests,[]);
    f.env.V2_FC_PUBLIC_READ_ONLY='true';
    delete f.env.V2_FC_PUBLIC_WRITE_SCOPE;
    delete f.env.V2_PUBLIC_DEVELOPMENT_REQUEST_DIGEST;
    await f.restart();
    const recovered=await nextCli('v3-start',['--reconcile']);
    assert.equal(recovered.status,'CREATION_CONFIRMED');
    assert.deepEqual(requests,[{path:'/auth/session',method:'GET'},{path:'/agent/requests/'+requestKey,method:'GET'}]);
    assert.equal(f.store.list('agent',PROJECT).filter(item=>item.contextId==='cash-change').length,1);
    assert.deepEqual(f.counts(),beforeNext);
    const joined=await cli('v3-run',['--completion-file',completionFile,'--next-checkpoint',nextPath]);
    assert.equal(joined.cases[1].creationStatus,'CONFIRMED');
    assert.equal(joined.verifiedCloudCaseCount,0);
    assert.equal(JSON.parse(readFileSync(nextPath,'utf8')).startedAt,preparedState.startedAt);
    assert.equal(readFileSync(checkpoint,'utf8'),checkpointBytes);
  }
});

test('an invited derived task progresses on original events after client disconnect and controller reopen',async t=>{
  const f=await fixture(t,{eventsEnabled:true,startupPreflight:true,structuredRequirement:true,stableOrigin:true,contextualModel:true});
  const definition=liveLifecyclePlan(11,{contractId:currentLiveLifecycleContract.id}).selectedCases.at(-1);
  const owner=(await f.call('/auth/session')).body.user.id;
  const source=seedContextDerivation(f.store,PROJECT,{actorId:owner});
  const originalParent=f.store.get('agent',source.task.id,PROJECT);
  const key=randomUUID(), contextId=definition.contextId;
  const body=agentContextDerivationBody({message:definition.request,sql:source.sql,contextId,derivation:source.derivation});
  const start=Math.max(f.now(),Date.parse(source.task.createdAt)+1);
  f.later(start-f.now());
  Object.assign(f.env,{V2_PUBLIC_DEVELOPMENT_STARTS_AT:new Date(start).toISOString(),
    V2_PUBLIC_DEVELOPMENT_EXPIRES_AT:new Date(start+3600000).toISOString(),
    V2_PUBLIC_DEVELOPMENT_REQUEST_DIGEST:developmentRequestDigest(sha256(key),sha256(JSON.stringify(body)))});
  await f.restart();
  assert.equal((await f.call('/agent/tasks',{...body,background:true},key)).body.code,'PUBLIC_DEVELOPMENT_REQUEST_ONLY');
  const created=await f.call('/agent/tasks',body,key);
  assert.equal(created.status,202);
  const {id,version,derivedFrom}=created.body;
  const route=`/agent/tasks/${id}`;
  assert.equal(derivedFrom.revisionId,source.revision.id);
  assert.equal((await f.call(`/agent/tasks/${source.task.id}/background`,{expectedVersion:originalParent.version})).status,403);
  const delegated=await f.call(route+'/background',{expectedVersion:version,maxEvents:3});
  assert.equal(delegated.status,202);
  assert.equal(delegated.body.status,'ACTIVE');
  assert.equal(f.wakes.length,1);
  assert.deepEqual(f.counts(),{modelCalls:0,jobCreates:0});

  // The public client's connection is closed. Only private object events drive execution.
  const initialStore=f.store;
  await f.restart();
  assert.notEqual(f.store,initialStore);
  assert.equal((await f.privateCall(f.wakes[0])).status,200);
  assert.equal((await f.privateCall(f.wakes[0])).status,200);
  assert.equal(f.wakes.length,2);
  assert.deepEqual(f.counts(),{modelCalls:1,jobCreates:0});
  assert.equal((await f.privateCall(f.wakes[1])).status,200);
  const waiting=f.store.get('agent',id,PROJECT);
  assert.equal(waiting.stage,'WAITING_FOR_RUN');
  assert.notEqual(waiting.runId,source.run.id);
  const prepared=f.store.get('run',waiting.runId,PROJECT).remoteSubmission.prepared;
  const family=validationFamilyForContext(contextId);
  const measured=process.env.SHUDUO_TEST_LOCAL_SPARK_DERIVATION_RECOVERY==='true';
  f.complete(prepared,measured?await measuredSpark(t,f,prepared,'derived event recovery'):{
    status:'SUCCEEDED',engine:'Apache Spark',engineVersion:'3.5.9',mainSqlExecuted:true,durationMs:100,
    rows:getContext(contextId).expected,validation:{passed:true,contractId:family.id,
      regressions:family.contextIds.map(value=>({contextId:value,passed:true}))},
  });
  const callback=structuredClone(f.wakes[1]);
  callback.events[0].oss.object.key=prepared.resultKey;
  await f.restart();
  assert.equal((await f.privateCall(callback)).status,200);
  assert.equal((await f.privateCall(callback)).status,200);
  assert.equal(f.wakes.length,3);
  assert.equal((await f.privateCall(f.wakes[2])).status,200);
  assert.equal((await f.privateCall(f.wakes[2])).status,200);
  assert.deepEqual(f.counts(),{modelCalls:1,jobCreates:1});
  const settled=f.store.get('agent',id,PROJECT), savedRun=f.store.get('run',waiting.runId,PROJECT);
  assert.equal(settled.status,'SUCCEEDED');
  assert.equal(settled.revisionId,waiting.revisionId);
  assert.deepEqual(settled.derivedFrom,derivedFrom);
  assert.equal(savedRun.validation.passed,true);
  assert.equal(savedRun.validation.contractId,family.id);

  f.expire();
  await f.restart();
  const recovered=await f.call('/agent/requests/'+key), evidence=await f.call('/agent/requests/'+key+'/execution-evidence');
  assert.equal(recovered.status,200);
  assert.equal(recovered.body.id,id);
  assert.equal(recovered.body.runId,waiting.runId);
  assert.equal(recovered.body.background.status,'COMPLETED');
  assert.equal(recovered.body.background.consumedEvents,3);
  assert.equal(evidence.body.status,'EXECUTION_RECORDED');
  assert.deepEqual(evidence.body.derivedFrom,derivedFrom);
  assert.equal(evidence.body.development.runId,waiting.runId);
  assert.equal(evidence.body.development.revisionId,waiting.revisionId);
  assert.equal(evidence.body.fullLifecycleE2E,false);
  assert.deepEqual(f.store.get('run',waiting.runId,PROJECT),savedRun);
  assert.deepEqual(f.store.get('agent',source.task.id,PROJECT),originalParent);
  assert.deepEqual(f.counts(),{modelCalls:1,jobCreates:1});
  assert.equal(f.queueCounts().jobWriteAttempts,1);
});

test('expired Worker readiness settles original Agent development, then resumes repair under the original request',async t=>{
  const measure=process.env.SHUDUO_TEST_LOCAL_SPARK_DEVELOPMENT_RECOVERY==='true';
  for (const initiallyInvalid of [false,true]) await t.test(initiallyInvalid?'validation failure and repair':'successful receipt',async t=>{
    const f=await fixture(t,{eventsEnabled:true,startupPreflight:true,structuredRequirement:true,stableOrigin:true,
      sqlForAttempt:(attempt,input)=>initiallyInvalid&&attempt===1 ? 'SELECT 1 AS wrong_metric' : referenceSqlForContext(input.context.id)});
    const definition=liveLifecyclePlan(1,{contractId:currentLiveLifecycleContract.id}).selectedCases[0];
    const body={message:definition.request,sql:definition.seedSql,contextId:definition.contextId}, key=randomUUID();
    f.env.V2_PUBLIC_DEVELOPMENT_REQUEST_DIGEST=developmentRequestDigest(sha256(key),sha256(JSON.stringify(body)));
    await f.restart();
    const created=await f.call('/agent/tasks',body,key);
    assert.equal(created.status,202);
    const path='/agent/tasks/'+created.body.id;
    const advance=async task=>{
      const response=await f.call(path+'/advance',{expectedVersion:task.version});
      assert.equal(response.status,200,response.body.message);
      return response.body;
    };
    const waiting=await advance(await advance(created.body));
    assert.equal(waiting.stage,'WAITING_FOR_RUN');
    let original=f.store.get('run',waiting.runId,PROJECT);
    const prepared=original.remoteSubmission.prepared;
    const event=f.resultEvent(prepared.resultKey);
    const resultStatus=initiallyInvalid?'VALIDATION_FAILED':'SUCCEEDED';
    const family=validationFamilyForContext(definition.contextId);
    const result=measure ? await measuredSpark(t,f,prepared,'development '+resultStatus,resultStatus) :
      initiallyInvalid ? {status:resultStatus,engine:'Apache Spark',engineVersion:'3.5.9',mainSqlExecuted:true,
        validation:{passed:false,issues:['虚构独立断言未通过'],
          regressions:family.contextIds.map(contextId=>({contextId,passed:false,issues:['虚构独立断言未通过']}))},
        rows:[{wrong_metric:1}],durationMs:100} : undefined;
    if (!initiallyInvalid) {
      // An older controller could commit the run and stop before updating the Agent.
      f.complete(prepared,result);
      assert.equal((await f.call('/runs/'+original.id)).body.status,'SUCCEEDED');
      assert.equal(f.store.get('agent',waiting.id,PROJECT).stage,'WAITING_FOR_RUN');
      original=f.store.get('run',original.id,PROJECT);
      f.removeResult(prepared);
    }
    f.expire();
    await f.restartWithExpiredReadiness();
    assert.equal((await f.call('/status')).body.spark.healthVerified,false);
    assert.equal((await f.call(path+'/advance',{expectedVersion:waiting.version})).status,403);
    assert.equal((await f.privateCall(event)).status,503);
    assert.deepEqual(f.store.get('run',original.id,PROJECT),original);
    f.complete(prepared,result,'0'.repeat(64));
    assert.equal((await f.privateCall(event)).body.code,'SPARK_QUEUE_RESULT_INVALID');
    assert.deepEqual(f.store.get('run',original.id,PROJECT),original);
    f.complete(prepared,result);
    const before=f.queueCounts();
    assert.equal((await f.privateCall(event)).body.state,'DEVELOPMENT_BATCH_SETTLED');
    const saved=f.store.get('run',original.id,PROJECT);
    assert.equal(saved.status,resultStatus);
    assert.equal(saved.revisionId,waiting.revisionId);
    if (!initiallyInvalid) assert.equal(saved.finishedAt,original.finishedAt);
    const recovered=(await f.call('/agent/requests/'+key)).body;
    assert.equal(recovered.id,created.body.id);
    assert.equal(recovered.runId,waiting.runId);
    assert.equal(recovered.revisionId,waiting.revisionId);
    assert.equal(recovered.stage,initiallyInvalid?'READY_FOR_MODEL':'SUCCEEDED');
    assert.equal(recovered.usedTokens,12);
    assert.equal(recovered.attempts.length,1);
    assert.equal(recovered.attempts[0].status,resultStatus);
    assert.equal((await f.privateCall(event)).body.state,'DEVELOPMENT_BATCH_ALREADY_SETTLED');
    assert.deepEqual(f.queueCounts(),{...before,resultReads:before.resultReads+1});
    assert.deepEqual(f.counts(),{modelCalls:1,jobCreates:1});
    assert.equal(f.wakes.length,0);
    assert.equal(f.store.list('delivery_package',PROJECT).length,0);
    assert.equal(f.store.list('release_approval',PROJECT).length,0);
    const evidence=(await f.call('/agent/requests/'+key+'/execution-evidence')).body;
    assert.equal(evidence.execution.spark.runId,waiting.runId);
    assert.equal(evidence.execution.spark.resultStatus,resultStatus);
    if (!initiallyInvalid) {
      assert.equal(evidence.development.runId,waiting.runId);
      return;
    }
    assert.equal(evidence.development,undefined);
    assert.equal(saved.validation.passed,false);
    const beforeDeniedRepair=f.queueCounts();
    assert.equal((await f.call(path+'/advance',{expectedVersion:recovered.version})).status,403);
    assert.deepEqual(f.queueCounts(),beforeDeniedRepair);
    assert.equal(f.counts().modelCalls,1);
    // Reopen a new, explicit continuation window for the same task.
    f.alignWallClock();
    delete f.env.V2_PUBLIC_DEVELOPMENT_REQUEST_DIGEST;
    Object.assign(f.env,{V2_PUBLIC_DEVELOPMENT_TASK_ID:recovered.id,
      V2_PUBLIC_DEVELOPMENT_STARTS_AT:new Date(f.now()-1000).toISOString(),
      V2_PUBLIC_DEVELOPMENT_EXPIRES_AT:new Date(f.now()+600000).toISOString()});
    await f.restart();
    const generated=await advance(recovered);
    assert.equal(generated.stage,'READY_FOR_RUN');
    assert.equal(generated.id,recovered.id);
    assert.notEqual(generated.revisionId,recovered.revisionId);
    const repairing=await advance(generated);
    const repairedJob=f.store.get('run',repairing.runId,PROJECT).remoteSubmission.prepared;
    f.complete(repairedJob,measure?await measuredSpark(t,f,repairedJob,'development repair'):undefined);
    const finished=await advance(repairing);
    assert.equal(finished.status,'SUCCEEDED');
    assert.equal(finished.attempts[0].runId,waiting.runId);
    assert.equal(finished.attempts[0].status,'VALIDATION_FAILED');
    assert.equal(finished.usedTokens,24);
    assert.deepEqual(f.store.get('run',waiting.runId,PROJECT),saved);
    assert.deepEqual(f.counts(),{modelCalls:2,jobCreates:2});
  });
});

test('an invited exact window binds derivation from the parent through signed release and both consumer batches',async t=>{
  const f=await fixture(t,{startupPreflight:true,structuredRequirement:true,stableOrigin:true,contextualModel:true});
  const measure=process.env.SHUDUO_TEST_LOCAL_SPARK_DERIVATION==='true';
  const measureRelease=process.env.SHUDUO_TEST_LOCAL_SPARK_DERIVATION_RELEASE==='true';
  const plan=liveLifecyclePlan(11,{contractId:currentLiveLifecycleContract.id}), definition=plan.selectedCases.at(-1);
  const owner=(await f.call('/auth/session')).body.user.id;
  const source=seedContextDerivation(f.store,PROJECT,{actorId:owner});
  const initialParent=f.store.get('agent',source.task.id,PROJECT);
  const key=randomUUID(), target=definition.contextId, family=validationFamilyForContext(target);
  const body=agentContextDerivationBody({message:definition.request,sql:source.sql,
    contextId:target,derivation:source.derivation});
  const starts=Math.max(Date.now(),Date.parse(source.task.createdAt)+1);
  f.later(starts-f.now());
  f.env.V2_PUBLIC_DEVELOPMENT_STARTS_AT=new Date(starts).toISOString();
  f.env.V2_PUBLIC_DEVELOPMENT_EXPIRES_AT=new Date(starts+3600000).toISOString();
  f.env.V2_PUBLIC_DEVELOPMENT_REQUEST_DIGEST=developmentRequestDigest(sha256(key),sha256(JSON.stringify(body)));
  await f.restart();
  assert.equal((await f.call('/status')).body.agentDevelopment.derivationBindingSupported,true);
  const parentRevision=await f.call('/revisions/'+source.revision.id);
  assert.equal(parentRevision.status,200);
  assert.equal(parentRevision.body.sql,source.sql);
  for (const wrong of [{...body,sql:'SELECT 0'},{...body,derivation:{...body.derivation,runId:randomUUID()}}]) {
    const denied=await f.call('/agent/tasks',wrong,key);
    assert.equal(denied.body.code,'PUBLIC_DEVELOPMENT_REQUEST_ONLY');
  }
  const created=await f.call('/agent/tasks',body,key);
  assert.equal(created.status,202,created.body.code??created.body.message);
  const original=await f.call('/agent/requests/'+key);
  assert.equal(original.body.id,created.body.id);
  assert.equal(original.body.requestBound,true);
  assert.deepEqual(original.body.derivedFrom,{...source.derivation,contextId:source.task.contextId,
    validationContractId:source.family.id});
  assert.equal(original.body.runId,undefined);
  const taskPath='/agent/tasks/'+created.body.id;
  let task=(await f.call(taskPath+'/advance',{expectedVersion:created.body.version})).body;
  task=(await f.call(taskPath+'/advance',{expectedVersion:task.version})).body;
  assert.equal(task.stage,'WAITING_FOR_RUN');
  const runId=task.runId;
  assert.notEqual(runId,source.run.id);
  const developmentJob=f.store.get('run',runId,PROJECT).remoteSubmission.prepared;
  f.complete(developmentJob,measure?await measuredSpark(t,f,developmentJob,'derived development'):{
    status:'SUCCEEDED',engine:'Apache Spark',engineVersion:'3.5.9',mainSqlExecuted:true,durationMs:100,
    rows:getContext(target).expected,validation:{passed:true,contractId:family.id,
      regressions:family.contextIds.map(contextId=>({contextId,passed:true}))},
  });
  task=(await f.call(taskPath+'/advance',{expectedVersion:task.version})).body;
  assert.equal(task.status,'SUCCEEDED');
  const before=f.counts(), evidencePath='/agent/requests/'+key+'/execution-evidence';
  const evidence=await f.call(evidencePath);
  assert.equal(evidence.body.status,'EXECUTION_RECORDED');
  assert.equal(evidence.body.seedSqlSha256,source.revision.hash);
  assert.deepEqual(evidence.body.derivedFrom,original.body.derivedFrom);
  assert.equal(evidence.body.development.runId,runId);
  assert.equal(evidence.body.development.validationContractId,family.id);
  const preparation=(await f.call(taskPath+'/workflow')).body.preparationSource;
  assert.deepEqual(preparation,{revisionId:task.revisionId,revisionHash:evidence.body.development.revisionHash,runId,
    requirementBinding:evidence.body.development.requirementBinding});
  assert.equal((await f.call(taskPath+'/prepare-delivery',{expectedSource:{...preparation,runId:randomUUID()}},randomUUID())).status,409);
  assert.equal((await f.call(taskPath+'/prepare-delivery',{},randomUUID())).status,422);
  assert.equal(f.store.list('agent_delivery_task',PROJECT).length,0);
  assert.deepEqual(f.store.get('agent',source.task.id,PROJECT),initialParent);
  assert.deepEqual(f.counts(),before);
  const checkpoint=join(f.directory,'derived-case.json'), bill=join(f.directory,'derived-bill.json');
  const evaluationRunId=randomUUID(), startedAt=new Date(starts).toISOString();
  const approvals=Array.from({length:10},(_,index)=>sha256('derived fixture approval '+index));
  const submittedAt=created.body.createdAt;
  const item={...liveCaseCheckpoint(definition,startedAt,plan.caseSetDigest,{contractId:plan.contract.id,evaluationRunId}),
    status:'PAUSED',phase:'CODE_AND_DEBUG',taskId:task.id,actions:{agent:{key,status:'CONFIRMED',id:task.id,bodyHash:sha256(JSON.stringify(body))}},
    derivationSource:{protocol:'shuduo-cloud-v3-derivation-source/v1',sourceCaseId:definition.sourceCaseId,contextId:source.task.contextId,
      validationContractId:source.family.id,taskId:source.task.id,revisionId:source.revision.id,runId:source.run.id,
      revisionHash:source.revision.hash,completionDigest:sha256('fixture parent completion')}};
  const origin=new URL(f.base).origin;
  writeFileSync(checkpoint,JSON.stringify({evaluationRunId,contract:plan.contract,startedAt,caseSetDigest:plan.caseSetDigest,
    caseLimit:11,origin,projectId:PROJECT,reviewedSource:'a'.repeat(40),
    previousCase:{checkpointDigest:sha256('fixture prior checkpoint'),completionDigest:sha256('fixture prior completion'),
      approvalDigest:approvals.at(-1),approvalDigests:approvals,reserveCny:64},
    submission:{actorId:owner,submittedAt,bill:{unsettledReserveCny:64}},outcomes:[item]}),{mode:0o600});
  writeSubprocessBill(bill);
  const requests=[];
  let losePublication=false;
  const client=new V2Client({baseUrl:f.base,fetchImpl:async(url,options)=>{
    const uri=new URL(url), path=uri.pathname.slice('/api/v2'.length)+uri.search;
    requests.push({method:options.method,path});
    const result=await f.call(path,options.body?JSON.parse(options.body):undefined,options.headers['Idempotency-Key']);
    if (losePublication && options.method==='POST' && path===taskPath+'/publication') {
      assert.equal(result.status,202);
      losePublication=false;
      throw Error('synthetic derivative publication response lost');
    }
    return new Response(JSON.stringify(result.body),{status:result.status});
  }});
  const cli=async(action,flags=[],exit=0)=>{
    requests.length=0;
    let result,message;
    const code=await runV2Cli(['agent',action,'--checkpoint',checkpoint,...flags],{},
      {client,output:line=>{result=JSON.parse(line);},error:line=>{message=line;}});
    assert.equal(code,exit,message);
    return result;
  };
  const confirm=['--bill-file',bill,'--confirm'];
  assert.equal((await cli('v3-inspect')).status,'DEVELOPMENT_BOUND');
  const {delivery}=await cli('v3-prepare-delivery',confirm);
  const bundle=f.store.get('delivery_package',delivery.packageId,PROJECT);
  assert.deepEqual(bundle.manifest.source.derivation,original.body.derivedFrom);
  const started=await cli('v3-rehearse',confirm);
  const queued=f.store.get('agent_delivery_task',delivery.id,PROJECT).remoteSubmission.prepared;
  f.complete(queued,measure?await measuredSpark(t,f,queued,'derived file rehearsal'):{
    status:'SUCCEEDED',engine:'Apache Spark',engineVersion:'3.5.9',mainSqlExecuted:true,durationMs:100,
    rows:getContext(target).expected,validation:{passed:true,contractId:family.id,
      regressions:family.contextIds.map(contextId=>({contextId,passed:true}))},
    testSqlValidation:{passed:true,sqlHash:sha256(JSON.parse(queued.job.body).testSql)},
  });
  const settled=await cli('v3-rehearse',['--settle']);
  assert.equal(settled.delivery.rehearsal.id,started.delivery.rehearsal.id);
  assert.equal(settled.delivery.rehearsal.status,'SUCCEEDED');
  const evidenceReviewPath=agentReviewEvidencePath({taskId:task.id,deliveryId:delivery.id,requestSha256:sha256(body.message)});
  const review=(await f.call(evidenceReviewPath)).body;
  assert.equal(review.status,'REVIEW_EVIDENCE_READY',review.reason);
  assert.deepEqual(review.derivedFrom,original.body.derivedFrom);
  assert.equal(Object.keys(review.delivery.fileHashes).length,8);
  const after=f.counts();
  f.store.update('revision',source.revision.id,PROJECT,{hash:'f'.repeat(64)});
  assert.equal((await f.call(evidencePath)).body.status,'UNCONFIRMED');
  assert.equal((await f.call(evidenceReviewPath)).body.status,'UNCONFIRMED');
  assert.deepEqual(f.counts(),after);
  f.store.update('revision',source.revision.id,PROJECT,{hash:source.revision.hash});

  const reviewFile=join(f.directory,'derivative-publication-review.json');
  assert.equal((await cli('v3-publication-review',['--out-file',reviewFile])).status,'REVIEW_FILE_READY');
  const draft=JSON.parse(readFileSync(reviewFile,'utf8'));
  assert.deepEqual(draft.package.manifest.source.derivation,original.body.derivedFrom);
  assert.equal(draft.basis.evidence.delivery.packageDigest,delivery.packageDigest);
  const reviewed={...draft,attestations:Object.fromEntries(Object.keys(draft.attestations).map(key=>[key,true]))};
  writeFileSync(reviewFile,JSON.stringify(reviewed));
  f.alignWallClock();
  Object.assign(f.env,{
    V2_FC_PUBLIC_WRITE_SCOPE:'PUBLICATION_ONLY',
    V2_PUBLIC_PUBLICATION_STARTS_AT:new Date(f.now()-1000).toISOString(),
    V2_PUBLIC_PUBLICATION_EXPIRES_AT:new Date(f.now()+600000).toISOString(),
    V2_PUBLIC_PUBLICATION_TASK_ID:task.id,V2_PUBLIC_PUBLICATION_PACKAGE_DIGEST:delivery.packageDigest,
    V2_PUBLIC_PUBLICATION_VERIFICATION_ID:settled.delivery.rehearsal.id,
    V2_PRIVATE_RELEASE_ENABLED:'true',V2_PRIVATE_RELEASE_TRIGGER_NAMES:'shuduo-release-synthetic-derived',
    V2_SCHEDULER_TICK_SECRET:'synthetic-derived-release-authorization-1234567890',
  });
  await f.restart();
  const selector={sourceKind:'AGENT',sourceRunId:task.runId,packageDigest:delivery.packageDigest,verificationId:settled.delivery.rehearsal.id};
  const workflow=await checkedAgentWorkflow((await f.call(taskPath+'/workflow')).body,
    {taskId:task.id,contextId:target,revisionId:task.revisionId,runId:task.runId,manual:false});
  const preflightPath=publicationPreflightPath(task.id,selector), preflight=(await f.call(preflightPath)).body;
  const checked=await checkedCloudPublicationPreflight(preflight,workflow);
  assert.equal(checked.reviewDigest,draft.reviewDigest);
  for (const key of ['packageDigest','verificationId']) {
    const changed=structuredClone(preflight);
    changed.basis.evidence.delivery[key]=key==='packageDigest'?'a'.repeat(64):randomUUID();
    changed.reviewDigest=sha256(JSON.stringify(changed.basis));
    await assert.rejects(checkedCloudPublicationPreflight(changed,workflow),/未确认/);
  }
  const originalPublish=cloudPublicationRequest(selector,delivery.packageId,reviewed.attestations,checked.reviewDigest);
  const {reviewDigest,...withoutDigest}=originalPublish.body;
  assert.equal((await f.call(taskPath+'/publication',withoutDigest,randomUUID())).status,422);
  assert.equal((await f.call(taskPath+'/publication',{...originalPublish.body,reviewDigest:'f'.repeat(64)},randomUUID())).status,409);
  assert.equal(f.store.list('release_approval',PROJECT).length,0);
  losePublication=true;
  assert.equal((await cli('v3-publish',['--review-file',reviewFile,...confirm])).reason,'INSPECT_ORIGINAL_PUBLICATION');
  assert.equal(requests.filter(entry=>entry.method==='POST').length,1);
  const {publication}=await cli('v3-publish',['--reconcile']);
  assert.equal(publication.status,'WAITING_SCHEDULER');
  assert.equal(requests.filter(entry=>entry.method==='POST').length,0);
  assert.equal(f.store.list('release_approval',PROJECT).length,1);
  const {releaseId,batchIds}=publication;
  const observed=await f.call(publicationRequestReceiptPath(task.id,JSON.parse(readFileSync(checkpoint,'utf8')).outcomes[0].actions.publication.key));
  assert.equal(checkedExactPublicationReceipt(observed.body,{taskId:task.id,revisionId:task.revisionId,
    revisionHash:evidence.body.development.revisionHash,runId:task.runId,packageId:delivery.packageId,
    packageDigest:selector.packageDigest,verificationId:selector.verificationId,reviewDigest}),releaseId);
  const timer=(mark,forged=false)=>{
    const triggerName=f.env.V2_PRIVATE_RELEASE_TRIGGER_NAMES,timestamp=String(f.now()),nonce=mark.repeat(24);
    const signed=JSON.stringify({releaseId,triggerName,expiresAt:f.now()+300000});
    return {triggerName,triggerTime:new Date(f.now()).toISOString(),payload:JSON.stringify({
      operation:'PRIVATE_RELEASE_TIMER_V1',timestamp,nonce,body:signed,
      signature:forged?'bad':signSchedulerTick({sharedSecret:f.env.V2_SCHEDULER_TICK_SECRET,timestamp,nonce,body:signed}),
    })};
  };
  assert.equal((await f.privateCall(timer('x',true))).status,401);
  const alternative=seedContextDerivation(f.store,PROJECT,{actorId:owner});
  assert.equal(alternative.sql,source.sql);
  f.store.update('agent',task.id,PROJECT,{derivedFrom:{...alternative.derivation,contextId:source.task.contextId,
    validationContractId:source.family.id}});
  // This alternative is a valid same-SQL parent, but not the reviewed one.
  assert.equal((await f.call(evidencePath)).body.status,'EXECUTION_RECORDED');
  assert.equal((await f.privateCall(timer('y'))).status,409);
  assert.deepEqual(f.counts(),after);
  f.store.update('agent',task.id,PROJECT,{derivedFrom:original.body.derivedFrom});

  f.later(1000);
  for (const [index,id] of batchIds.entries()) {
    if (index) f.later(60001);
    const tick=timer(index?'b':'a');
    assert.equal((await f.privateCall(tick)).status,200);
    const run=f.store.get('release_run',id,PROJECT), prepared=run.remoteSubmission.prepared;
    assert.equal(prepared.job.jobId,id);
    assert.equal(JSON.parse(prepared.job.body).context.id,target);
    assert.equal(f.counts().jobCreates,after.jobCreates+index+1);
    f.complete(prepared,measureRelease?await measuredSpark(t,f,prepared,'derived release batch '+(index+1)):{
      status:'SUCCEEDED',engine:'Apache Spark',engineVersion:'3.5.9',mainSqlExecuted:true,durationMs:100,
      rows:stockConsumerRows,validation:{passed:true,contractId:family.id,
        regressions:family.contextIds.map(contextId=>({contextId,passed:true}))},
      testSqlValidation:{passed:true,sqlHash:sha256(JSON.parse(prepared.job.body).testSql)},
    });
    assert.equal((await f.privateCall(tick)).body.replayed,true);
    assert.equal(f.store.get('release_run',id,PROJECT).status,'SUCCEEDED');
    assert.equal(f.counts().jobCreates,after.jobCreates+index+1);
  }
  const finished=(await cli('v3-publish',['--reconcile'])).publication;
  assert.equal(finished.monitoringStatus,'VERIFIED');
  assert.deepEqual(finished.monitoring.map(row=>row.batchId),batchIds);
  const monitorHref='/v2/?'+new URLSearchParams({module:'ops',taskId:task.id,releaseId,revisionId:evidence.body.development.revisionId,
    firstBatchId:batchIds[0],secondBatchId:batchIds[1]})+'#ops-exact-publication';
  const monitor=await readOpsPublication(async path=>(await f.call(path)).body,opsPublicationTarget(new URL(monitorHref,f.base).href));
  assert.equal(monitor.health,'HEALTHY');
  assert.equal(monitor.monitoringVerified,true);
  const reader=async path=>(await f.call(path)).body;
  const originalTarget={...opsPublicationTarget(new URL(monitorHref,f.base).href),source:monitor.source};
  const returnHref=publicationMonitorHref(originalTarget,true);
  const returnTarget=opsPublicationTarget(new URL(returnHref,f.base).href,true);
  assert.deepEqual(returnTarget,originalTarget);
  assert.equal(opsPublicationTarget(new URL(returnHref.replace('&reviewDigest=','&otherDigest='),f.base).href,true),null);
  await assert.rejects(readOpsPublication(reader,{...returnTarget,source:{...returnTarget.source,packageDigest:'f'.repeat(64)}}),/来源不一致/);
  await assert.rejects(readOpsPublication(reader,{...returnTarget,source:{...returnTarget.source,verificationId:randomUUID()}}),/来源不一致/);
  await assert.rejects(readOpsPublication(reader,{...returnTarget,source:{...returnTarget.source,reviewDigest:'f'.repeat(64)}}),/来源不一致/);
  const originalEvent=f.store.list('monitor_event',PROJECT).find(event=>event.releaseId===releaseId);
  const readOnlyCounts=f.queueCounts();
  f.store.update('monitor_event',originalEvent.id,PROJECT,{packageDigest:'0'.repeat(64)});
  const unconfirmed=await readOpsPublication(reader,returnTarget);
  assert.equal(unconfirmed.monitoringVerified,false);
  assert.ok(unconfirmed.batches.every(batch=>!batch.serviceHref&&!batch.reportSource));
  f.store.update('monitor_event',originalEvent.id,PROJECT,{packageDigest:originalEvent.packageDigest});
  assert.deepEqual(f.queueCounts(),readOnlyCounts);
  for (const [index,batch] of monitor.batches.entries()) {
    const serviceUrl=new URL(batch.serviceHref,f.base).href, parsed=serviceSourceFromLocation(serviceUrl);
    assert.equal(parsed.binding.releaseId,releaseId);
    assert.equal(serviceBatchFromLocation(serviceUrl,parsed.binding),batchIds[index]);
  }
  const consumed=[];
  for (const [index,batchId] of batchIds.entries()) {
    consumed.push(await consumeOriginalBatch(f,cli,{taskId:task.id,releaseId,packageDigest:delivery.packageDigest,batchId,
      sequence:index+1,origin,expectedRows:stockConsumerRows,differentContextRows:baseConsumerRows}));
  }
  f.env.V2_FC_PUBLIC_READ_ONLY='true';
  await f.restart();
  const proofPath=join(f.directory,'derived-completion.json'), beforeProof=readFileSync(checkpoint);
  const proof=await cli('v3-complete',['--first-plan',consumed[0].flags[1],'--second-plan',consumed[1].flags[1],'--out-file',proofPath]);
  assert.equal(proof.scope,'LOCAL_MATCHED_ONLY');
  assert.equal(requests.length,10);
  assert.ok(requests.every(entry=>entry.method==='GET'));
  delete f.env.V2_PRIVATE_DATA_SERVICES_ENABLED;
  delete f.env.V2_FC_PUBLIC_WRITE_SCOPE;
  delete f.env.V2_PUBLIC_SERVICE_PLAN;
  await f.restart();
  const callCount=f.store.list('service_call',PROJECT).length;
  const historyTargets=monitor.batches.map(batch=>batchServiceHistoryTarget(new URL(batch.serviceHref,origin).href));
  for (const [index,history] of historyTargets.entries()) {
    const path=serviceEvidencePath(history.binding)+'&release_batch_id='+history.batchId;
    const saved=await f.call(path);
    assert.equal(saved.status,200,saved.body.message);
    const result=checkedBatchConsumption(saved.body,history.binding,batchIds[index]);
    assert.equal(result.truncated,false);
    assert.deepEqual(result.services.filter(s=>s.status==='VERIFIED').map(s=>s.serviceType).sort(),['DAPI','XAPI']);
    assert.ok(result.services.filter(s=>s.call).every(s=>s.call.applicationStatus==='REVOKED'&&s.sourceRunIds[0]===batchIds[index]));
    assert.throws(()=>checkedBatchConsumption(saved.body,history.binding,batchIds[1-index]),/未确认/);
    assert.equal((await f.call(path+'&release_batch_id='+batchIds[1-index])).status,422);
    const reportTarget=opsPublicationTarget(new URL(publicationBatchReportHref(history.publication,history.batchId),origin).href);
    assert.deepEqual(reportTarget,{...history.publication,reportBatchId:batchIds[index]});
    const reportSource=monitor.batches[index].reportSource;
    const report=await f.call(privateBatchReportPath(reportSource));
    assert.equal(report.status,200,report.body.message);
    assert.deepEqual(report.body.metrics.map(metric=>metric.value),['2250.00','1750.00','500.00']);
    assert.equal(report.body.source.batchId,history.batchId);
    const attachment=await f.call(privateBatchReportPath(reportSource,report.body.digest));
    assert.equal(attachment.status,200);
    assert.match(attachment.headers.get('content-disposition'),/^attachment;/);
    assert.deepEqual(attachment.body,report.body);
    assert.equal((await f.call(privateBatchReportPath(reportSource,'f'.repeat(64)))).status,409);
  }
  const sourcePath=serviceEvidencePath(historyTargets[0].binding);
  assert.equal((await f.call(sourcePath+'&release_batch_id='+task.runId)).status,409);
  assert.ok([401,403].includes((await fetch(f.base+sourcePath+'&release_batch_id='+batchIds[0])).status));
  assert.equal(f.store.list('service_call',PROJECT).length,callCount);
  assert.deepEqual(readFileSync(checkpoint),beforeProof);
  assert.deepEqual(f.counts(),{modelCalls:1,jobCreates:4});
  assert.deepEqual(f.store.get('agent',source.task.id,PROJECT),initialParent);
});

test('a settled original development failure allows the next case while pending usage and Spark stay unresolved',async t=>{
  const f=await fixture(t,{startupPreflight:true,structuredRequirement:true,stableOrigin:true});
  const checkpoint=join(f.directory,'failed-case.json'), bill=join(f.directory,'bill.json'),
    outFile=join(f.directory,'failure.json'), nextPath=join(f.directory,'next.json');
  const month=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit'}).format(Date.now());
  writeFileSync(bill,JSON.stringify({checkedAt:new Date().toISOString(),unsettledReserveCny:64,maxIncrementCny:2,
    pages:[{Success:true,Data:{PageNum:1,PageSize:300,TotalCount:1,BillingCycle:month,Items:{Item:[{Currency:'CNY',PretaxAmount:'20.00'}]}}}]}),{mode:0o600});
  const calls=[],client=new V2Client({baseUrl:f.base,fetchImpl:async(url,options)=>{
    const uri=new URL(url), path=uri.pathname.slice('/api/v2'.length)+uri.search;
    calls.push({method:options.method,path});
    const reply=await f.call(path,options.body?JSON.parse(options.body):undefined,options.headers['Idempotency-Key']);
    return new Response(JSON.stringify(reply.body),{status:reply.status});
  }});
  const cli=async(action,flags,exit=0,path=checkpoint)=>{
    calls.length=0;
    let value,message;
    assert.equal(await runV2Cli(['agent',action,'--checkpoint',path,...flags],{},
      {client,output:line=>{value=JSON.parse(line);},error:line=>{message=line;}}),exit,message);
    return value;
  };
  const source='a'.repeat(40);
  await cli('v3-start',['--source-revision',source]);
  const created=await cli('v3-start',['--bill-file',bill,'--confirm']);
  const taskPath='/agent/tasks/'+created.taskId;
  const advance=async version=>{
    f.alignWallClock();
    const response=await f.call(taskPath+'/advance',{expectedVersion:version});
    assert.equal(response.status,200);
    return response.body;
  };
  const evidencePath='/agent/requests/'+JSON.parse(readFileSync(checkpoint,'utf8')).outcomes[0].actions.agent.key+'/execution-evidence';
  const inspectReads=[{method:'GET',path:'/auth/session'},{method:'GET',path:evidencePath}];
  const pending=async()=>{
    const snapshot=readFileSync(checkpoint);
    const proof=await cli('v3-settle-failure',['--out-file',outFile]);
    assert.equal(proof.reason,'DEVELOPMENT_FAILURE_NOT_SETTLED');
    assert.deepEqual(calls,inspectReads);
    assert.equal(existsSync(outFile),false);
    assert.deepEqual(readFileSync(checkpoint),snapshot);
  };
  let task=await advance((await f.call(taskPath)).body.version);
  task=await advance(task.version);
  assert.equal(task.stage,'WAITING_FOR_RUN');
  const runId=task.runId, prepared=f.store.get('run',runId,PROJECT).remoteSubmission.prepared;
  await pending();
  f.complete(prepared,{status:'FAILED',engine:'Apache Spark',engineVersion:'3.5.9',durationMs:100,error:'fixture SQL error'});
  task=await advance(task.version);
  assert.equal(task.stage,'READY_FOR_MODEL');
  task=await advance(task.version);
  assert.equal(task.status,'FAILED');
  assert.equal(task.code,'AGENT_SQL_UNCHANGED_AFTER_FAILURE');
  f.env.V2_FC_PUBLIC_READ_ONLY='true';
  delete f.env.V2_FC_PUBLIC_WRITE_SCOPE;
  await f.restart();
  const rawTask=f.store.get('agent',task.id,PROJECT);
  f.store.update('agent',task.id,PROJECT,{attempts:rawTask.attempts.map((attempt,index)=>index===0?{...attempt,usageEstimated:true}:attempt)});
  await pending();
  f.store.update('agent',task.id,PROJECT,{attempts:rawTask.attempts});
  const run=f.store.get('run',runId,PROJECT);
  f.store.update('run',runId,PROJECT,{code:'REMOTE_SPARK_TIMEOUT'});
  await pending();
  f.store.update('run',runId,PROJECT,{code:run.code});
  const beforeSettlement=readFileSync(checkpoint), beforeCounts=f.counts();
  const failure=await cli('v3-settle-failure',['--out-file',outFile]);
  assert.equal(failure.status,'FAILURE_RECEIPT_SAVED');
  assert.equal(failure.scope,'LOCAL_SETTLED_FAILURE_ONLY');
  assert.equal(statSync(outFile).mode&0o777,0o600);
  assert.deepEqual(calls,inspectReads);
  const receipt=JSON.parse(readFileSync(outFile,'utf8'));
  assert.deepEqual(receipt.failure.sparkRunIds,[runId]);
  assert.equal(receipt.failure.modelAttempts,2);
  assert.equal(receipt.failure.ledgerTokens,24);
  assert.equal(receipt.failure.sparkDurationMs,100);
  assert.deepEqual(readFileSync(checkpoint),beforeSettlement);
  assert.deepEqual(f.counts(),beforeCounts);
  const next=await cli('v3-prepare-next',['--first-checkpoint',checkpoint,'--completion-file',outFile,'--source-revision',source],0,nextPath);
  assert.equal(next.caseId,'v3-fresh--cash-change');
  const binding=await cli('v3-start',['--window-binding'],0,nextPath);
  assert.equal(binding.previousCase.reserveCny,64);
  assert.deepEqual(binding.previousCase.usageFloor,{month,modelCalls:2,remoteSparkRuns:1,remoteSparkSeconds:0.1});
  const report=await cli('v3-run',['--completion-file',outFile,'--next-checkpoint',nextPath]);
  assert.equal(report.expectedCaseCount,20);
  assert.equal(report.verifiedCloudCaseCount,0);
  assert.equal(report.cases[0].status,'LOCAL_FAILURE_SETTLED_ONLY');
  assert.equal(report.cases[1].creationStatus,'PREPARED');
  assert.equal(report.score.localOnlyFailures,1);
  assert.equal(report.score.settledCloudFailures,0);
  assert.equal(report.cases.find(row=>row.sourceCaseId===report.cases[0].caseId).status,'LOCAL_SOURCE_FAILED');
  assert.deepEqual(calls,[]);
  const tampered=join(f.directory,'tampered-failure.json');
  writeFileSync(tampered,JSON.stringify({...receipt,taskId:randomUUID()}),{mode:0o600});
  await cli('v3-run',['--completion-file',tampered],1);
});

test('original file and publication Worker failures settle read-only while unfinished work retains reservations',async t=>{
  for (const stage of ['FILE_REHEARSAL','PUBLICATION']) await t.test(stage,async t=>{
    const f=await fixture(t,{startupPreflight:true,structuredRequirement:true,stableOrigin:true,queueTimeoutMs:30000});
    const checkpoint=join(f.directory,'original.json'), bill=join(f.directory,'bill.json'),
      failureFile=join(f.directory,'failure.json'), nextPath=join(f.directory,'next.json');
    writeSubprocessBill(bill);
    const calls=[], client=new V2Client({baseUrl:f.base,fetchImpl:async(url,options)=>{
      const uri=new URL(url), path=uri.pathname.slice('/api/v2'.length)+uri.search;
      calls.push({method:options.method,path});
      const response=await f.call(path,options.body?JSON.parse(options.body):undefined,options.headers['Idempotency-Key']);
      return new Response(JSON.stringify(response.body),{status:response.status});
    }});
    const cli=async(action,flags=[],path=checkpoint)=>{
      calls.length=0;
      let result,message;
      const code=await runV2Cli(['agent',action,'--checkpoint',path,...flags],{},
        {client,output:line=>{result=JSON.parse(line);},error:line=>{message=line;}});
      assert.equal(code,0,message);
      return result;
    };
    const confirm=['--bill-file',bill,'--confirm'];
    await cli('v3-start',['--source-revision','a'.repeat(40)]);
    const created=await cli('v3-start',confirm);
    const taskPath='/agent/tasks/'+created.taskId;
    let task=(await f.call(taskPath)).body;
    task=(await f.call(taskPath+'/advance',{expectedVersion:task.version})).body;
    task=(await f.call(taskPath+'/advance',{expectedVersion:task.version})).body;
    f.complete(f.store.get('run',task.runId,PROJECT).remoteSubmission.prepared);
    task=(await f.call(taskPath+'/advance',{expectedVersion:task.version})).body;
    assert.equal(task.status,'SUCCEEDED');
    assert.equal((await cli('v3-inspect')).status,'DEVELOPMENT_BOUND');
    const {delivery}=await cli('v3-prepare-delivery',confirm);
    const opened=await cli('v3-rehearse',confirm), verificationId=opened.delivery.rehearsal.id;
    const rehearsalJob=f.store.get('agent_delivery_task',delivery.id,PROJECT).remoteSubmission.prepared;
    const pending=async(reason,requestPath)=>{
      const snapshot=readFileSync(checkpoint), queues=f.queueCounts();
      assert.equal((await cli('v3-settle-failure',['--out-file',failureFile])).reason,reason);
      assert.deepEqual(calls,[{method:'GET',path:'/auth/session'},{method:'GET',path:requestPath}]);
      assert.equal(existsSync(failureFile),false);
      assert.deepEqual(f.queueCounts(),queues);
      assert.deepEqual(readFileSync(checkpoint),snapshot);
    };
    const read=()=>JSON.parse(readFileSync(checkpoint,'utf8')).outcomes[0];
    const deliveryReceiptPath=taskPath+'/delivery-requests/'+read().actions.delivery.key;
    const readRehearsal=async()=>checkedAgentWorkflow((await f.call(taskPath+'/workflow')).body,{
      taskId:task.id,contextId:task.contextId,runId:task.runId,revisionId:task.revisionId,manual:false,
    });
    const originalFailure={status:'FAILED',engine:'Apache Spark',engineVersion:'3.5.9'};
    let settledIds, settledPath, seconds;
    if (stage==='FILE_REHEARSAL') {
      await pending('FILE_REHEARSAL_FAILURE_NOT_SETTLED',deliveryReceiptPath);
      assert.equal((await readRehearsal()).verification.workerResult,undefined);
      f.later(30001);
      await pending('FILE_REHEARSAL_FAILURE_NOT_SETTLED',deliveryReceiptPath);
      assert.equal((await readRehearsal()).verification.workerResult,'PENDING');
      f.complete(rehearsalJob,{...originalFailure,durationMs:0});
      assert.equal((await cli('v3-rehearse',['--settle'])).delivery.rehearsal.status,'FAILED');
      const verified=f.store.get('delivery_verification',verificationId,PROJECT);
      assert.equal(verified.durationMs,undefined);
      f.store.update('delivery_verification',verificationId,PROJECT,{workerResultDigest:'f'.repeat(64)});
      await pending('FILE_REHEARSAL_FAILURE_NOT_SETTLED',deliveryReceiptPath);
      assert.equal((await readRehearsal()).verification.workerResult,'PENDING');
      f.store.update('delivery_verification',verificationId,PROJECT,{workerResultDigest:verified.workerResultDigest});
      assert.equal((await readRehearsal()).verification.workerResult,'CONFIRMED');
      settledIds=[verificationId];settledPath=deliveryReceiptPath;seconds=30100;
    } else {
      f.complete(rehearsalJob);
      assert.equal((await cli('v3-rehearse',['--settle'])).delivery.rehearsal.status,'SUCCEEDED');
      const file=join(f.directory,'review.json');
      await cli('v3-publication-review',['--out-file',file]);
      const review=JSON.parse(readFileSync(file,'utf8'));
      writeFileSync(file,JSON.stringify({...review,attestations:Object.fromEntries(Object.keys(review.attestations).map(key=>[key,true]))}));
      f.alignWallClock();
      Object.assign(f.env,{V2_FC_PUBLIC_WRITE_SCOPE:'PUBLICATION_ONLY',
        V2_PUBLIC_PUBLICATION_STARTS_AT:new Date(f.now()-1000).toISOString(),
        V2_PUBLIC_PUBLICATION_EXPIRES_AT:new Date(f.now()+600000).toISOString(),
        V2_PUBLIC_PUBLICATION_TASK_ID:task.id,V2_PUBLIC_PUBLICATION_PACKAGE_DIGEST:delivery.packageDigest,
        V2_PUBLIC_PUBLICATION_VERIFICATION_ID:verificationId,V2_PRIVATE_RELEASE_ENABLED:'true',
        V2_PRIVATE_RELEASE_TRIGGER_NAMES:'shuduo-release-synthetic-failure',V2_SCHEDULER_TICK_SECRET:'synthetic-failure-release-authorization-1234'});
      await f.restart();
      const {publication}=await cli('v3-publish',['--review-file',file,...confirm]);
      const {releaseId,batchIds}=publication;
      settledPath=publicationRequestReceiptPath(task.id,read().actions.publication.key);
      const monitorTarget=opsPublicationTarget(new URL('/v2/?'+new URLSearchParams({
        module:'ops',taskId:task.id,releaseId,revisionId:task.revisionId,firstBatchId:batchIds[0],secondBatchId:batchIds[1],
      }),f.base).href);
      const readMonitor=()=>readOpsPublication(async path=>(await f.call(path)).body,monitorTarget);
      const tick=letter=>{
        const triggerName=f.env.V2_PRIVATE_RELEASE_TRIGGER_NAMES,timestamp=String(f.now()),nonce=letter.repeat(24);
        const body=JSON.stringify({releaseId,triggerName,expiresAt:f.now()+300000});
        return {triggerName,triggerTime:new Date(f.now()).toISOString(),payload:JSON.stringify({
          operation:'PRIVATE_RELEASE_TIMER_V1',timestamp,nonce,body,
          signature:signSchedulerTick({sharedSecret:f.env.V2_SCHEDULER_TICK_SECRET,timestamp,nonce,body}),
        })};
      };
      f.later(1000);
      const first=tick('a');
      assert.equal((await f.privateCall(first)).status,200);
      f.complete(f.store.get('release_run',batchIds[0],PROJECT).remoteSubmission.prepared,{...originalFailure,durationMs:123});
      assert.equal((await f.privateCall(first)).body.replayed,true);
      await pending('PUBLICATION_FAILURE_NOT_SETTLED',settledPath);
      const partial=await readMonitor();
      assert.equal(partial.failureSettlement,'PENDING');
      assert.deepEqual(partial.batches.map(batch=>batch.workerResult),['CONFIRMED',undefined]);
      f.later(60001);
      const second=tick('b');
      assert.equal((await f.privateCall(second)).status,200);
      f.later(30001);
      await pending('PUBLICATION_FAILURE_NOT_SETTLED',settledPath);
      assert.deepEqual((await readMonitor()).batches.map(batch=>batch.workerResult),['CONFIRMED','PENDING']);
      f.complete(f.store.get('release_run',batchIds[1],PROJECT).remoteSubmission.prepared);
      assert.equal((await f.privateCall(second)).body.replayed,true);
      const secondRun=f.store.get('release_run',batchIds[1],PROJECT);
      f.store.update('release_run',secondRun.id,PROJECT,{workerResultDigest:'e'.repeat(64)});
      await pending('PUBLICATION_FAILURE_NOT_SETTLED',settledPath);
      assert.equal((await readMonitor()).failureSettlement,'PENDING');
      f.store.update('release_run',secondRun.id,PROJECT,{workerResultDigest:secondRun.workerResultDigest});
      const monitored=await readMonitor();
      assert.equal(monitored.failureSettlement,'CONFIRMED');
      assert.ok(monitored.batches.every(batch=>batch.workerResult==='CONFIRMED'&&!batch.serviceHref&&!batch.reportSource));
      assert.equal((await f.call('/release/runs/'+batchIds[0])).body.workerResultDigest,undefined);
      settledIds=batchIds;seconds=423;
    }
    f.env.V2_FC_PUBLIC_READ_ONLY='true';
    delete f.env.V2_FC_PUBLIC_WRITE_SCOPE;
    await f.restart();
    const queues=f.queueCounts(), counts=f.counts(), checkpointBytes=readFileSync(checkpoint);
    if (stage==='PUBLICATION') t.mock.method(Date,'now',()=>f.now());
    const settled=await cli('v3-settle-failure',['--out-file',failureFile]);
    assert.equal(settled.status,'FAILURE_RECEIPT_SAVED');
    assert.equal(settled.scope,'LOCAL_SETTLED_FAILURE_ONLY');
    assert.deepEqual(calls,[{method:'GET',path:'/auth/session'},{method:'GET',path:settledPath}]);
    assert.deepEqual(f.counts(),counts);
    assert.deepEqual(f.queueCounts(),queues);
    assert.deepEqual(readFileSync(checkpoint),checkpointBytes);
    const receipt=JSON.parse(readFileSync(failureFile,'utf8'));
    assert.equal(receipt.failure.kind,stage);
    assert.deepEqual(receipt.failure.batches.map(batch=>batch.id),settledIds);
    const next=await cli('v3-prepare-next',['--first-checkpoint',checkpoint,'--completion-file',failureFile,'--source-revision','a'.repeat(40)],nextPath);
    assert.equal(next.status,'PREPARED');
    const {previousCase}=await cli('v3-start',['--window-binding'],nextPath);
    assert.equal(previousCase.reserveCny,64);
    assert.equal(previousCase.usageFloor.modelCalls,1);
    assert.equal(previousCase.usageFloor.remoteSparkRuns,stage==='FILE_REHEARSAL'?2:4);
    assert.equal(Math.round(previousCase.usageFloor.remoteSparkSeconds*1000),seconds);
    const report=await cli('v3-run',['--completion-file',failureFile,'--next-checkpoint',nextPath]);
    assert.equal(report.cases[0].status,'LOCAL_FAILURE_SETTLED_ONLY');
    assert.equal(report.verifiedCloudCaseCount,0);
    assert.equal(report.expectedCaseCount,20);
    assert.deepEqual(calls,[]);
  });
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
