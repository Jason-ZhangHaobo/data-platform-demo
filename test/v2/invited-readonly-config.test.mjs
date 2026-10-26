import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,statSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createServer as createHttpsServer,request as realHttpsRequest} from 'node:https';
import {createV2Server} from '../../src/v2/server.mjs';
import {MetadataStore} from '../../src/v2/store.mjs';
import {createFcIngress} from '../../src/v2/fc-ingress.mjs';
import {createReadonlyEntryCloudAdapter,readReadonlyHttpsProbe,readonlyDefaultEndpoint} from '../../scripts/invited-entry-cloud-adapter.mjs';
import {DOMAIN_BINDING_AUTHORIZATION,domainBindingPlan,verifyCertificateMaterial} from '../../scripts/v2-domain-binding-plan.mjs';
import {prepareInvitedReadonlyConfig,verifyInvitedReadonlyConfig,readonlyEntryRollbackRequests,readonlyConfigIntegrity} from '../../scripts/invited-readonly-config.mjs';
import {codeUpdateProbes,INVITED_READONLY_CODE_SCOPE} from '../../scripts/control-code-update.mjs';
import {READONLY_ENTRY_SCOPE,readonlyEntryPlan,readonlyEntryProbes,readonlyEntryProbeAccepted,runReadonlyEntry} from '../../scripts/invited-readonly-entry.mjs';

// Disposable self-signed fixture only; never load project certificate material.
const dir=mkdtempSync(join(tmpdir(),'readonly-domain-fixture-'));
let material;
try{
 writeFileSync(join(dir,'test.conf'),'[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=shuduoai.cn\n[ext]\nsubjectAltName=DNS:shuduoai.cn\n');
 execFileSync('openssl',['req','-new','-x509','-newkey','rsa:2048','-nodes','-days','2','-config',join(dir,'test.conf'),'-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem')],{stdio:'ignore',timeout:10000});
 material={certificate:readFileSync(join(dir,'cert.pem'),'utf8'),privateKey:readFileSync(join(dir,'key.pem'),'utf8')};
}finally{rmSync(dir,{recursive:true,force:true});}
const now=Date.now(),certificate=verifyCertificateMaterial(material,now);
const retainedPlan=domainBindingPlan({authorization:DOMAIN_BINDING_AUTHORIZATION,domainName:'shuduoai.cn',operationId:'a'.repeat(32),sourceRevision:'b'.repeat(40),expiresAt:new Date(now+1800000).toISOString(),region:'cn-hangzhou',roleArn:'acs:ram::111122223333:role/fixture-deploy',providerArn:'acs:ram::111122223333:oidc-provider/fixture',functionName:'fixture-control',certificate},now);
function fixture(){
 const domain={accountId:retainedPlan.target.account,domainName:'shuduoai.cn',protocol:'HTTPS',authConfig:{authType:'function',authInfo:'{}'},tlsConfig:structuredClone(retainedPlan.desired.tlsConfig),routeConfig:structuredClone(retainedPlan.desired.routeConfig),certConfig:{certName:retainedPlan.desired.certName,certificate:material.certificate}};
 domain.routeConfig.routes.forEach(r=>{r.accountId=null;r.rewriteConfig=null;});
 const state={function:{functionName:'fixture-control',codeChecksum:'123456',codeSize:4000,runtime:'custom.debian12',cpu:0.25,memorySize:512,instanceConcurrency:1,customDNS:{searches:['synthetic.invalid']},environmentVariables:{V2_LOCAL_DEVELOPMENT:'false',V2_PROVISIONING_ONLY:'true',V2_PRIVATE_SMOKE_ENABLED:'true',V2_DURABLE_SQL_AGENT_ENABLED:'true',SYNTHETIC_SECRET:'not-a-real-secret'}},triggers:[{triggerName:'wake',triggerType:'oss'},{triggerName:'result',triggerType:'oss'}],concurrency:{reservedConcurrency:1},scaling:{minInstances:0}};
 const expectedCode={applicationSource:'d'.repeat(40),sha256:'e'.repeat(64),bytes:4000};
 const privateCodeEvidence={report:{operationId:'c'.repeat(32),scope:'PRIVATE_CONTROL_CODE_ONLY',requestScope:INVITED_READONLY_CODE_SCOPE,passed:true,applicationSource:expectedCode.applicationSource,newInvocations:6,cumulativeInvocations:61,publicEnabled:false,modelCalls:0,sparkRuns:0},checkpoint:{operationId:'c'.repeat(32),phase:'VERIFIED',candidateSha:expectedCode.sha256,candidateReceipt:{sha256:expectedCode.sha256,bytes:4000,crc64:'123456'},probes:codeUpdateProbes.map(p=>({id:p.id,passed:true}))},transport:{configurationReads:17}};
 const change=prepareInvitedReadonlyConfig({state,domain,retainedPlan,operationId:'c'.repeat(32),expectedCode,privateCodeEvidence});
 const opened={state:structuredClone(state),domain:structuredClone(domain)};
 opened.state.function={...opened.state.function,...structuredClone(change.functionBody)};
 opened.state.triggers.push({...structuredClone(change.triggerBody),triggerId:'fixture-id',createdTime:'2026-01-01',httpTrigger:{urlInternet:'https://fixture.invalid'}});
 opened.domain.authConfig=structuredClone(change.domainBody.authConfig);
 return{state,domain,change,opened,expectedCode,privateCodeEvidence};
}
test('preparation changes only four environment keys, domain authentication and one default-URL-disabled trigger',()=>{
 const f=fixture();
 assert.deepEqual(Object.keys(f.change.functionBody),['environmentVariables']);
 assert.deepEqual(Object.keys(f.change.domainBody),['authConfig']);
 assert.equal(f.change.functionBody.environmentVariables.SYNTHETIC_SECRET,'not-a-real-secret');
 assert.equal(f.change.functionBody.environmentVariables.V2_DURABLE_SQL_AGENT_ENABLED,'true');
 assert.equal(f.change.functionBody.environmentVariables.V2_FC_PUBLIC_READ_ONLY,'true');
 assert.equal(f.change.functionBody.environmentVariables.V2_PUBLIC_ORIGIN,'https://shuduoai.cn');
 assert.deepEqual(JSON.parse(f.change.triggerBody.triggerConfig),{authType:'anonymous',disableURLInternet:true,methods:['GET','POST']});
 assert(!JSON.stringify(f.change.summary).includes('not-a-real-secret'));
 assert(!JSON.stringify(f.change).includes('PRIVATE KEY'));
 assert.equal(f.change.summary.applied,false);
 assert.equal(verifyInvitedReadonlyConfig(f.change,f.opened),true);
});
test('preparation refuses a foreign domain, an already-open function and changed resource limits',()=>{
 for(const mutate of [f=>f.domain.accountId='999900001111',f=>f.domain.authConfig.authType='anonymous',f=>f.domain.protocol='HTTP',f=>f.state.function.environmentVariables.V2_FC_PUBLIC_HTTP_ENABLED='true',f=>f.state.function.instanceConcurrency=2,f=>f.state.concurrency.reservedConcurrency=2,f=>f.state.scaling.minInstances=1,f=>f.state.triggers.push({triggerName:'foreign',triggerType:'http'})]){
  const f=fixture();mutate(f);assert.throws(()=>prepareInvitedReadonlyConfig({...f,retainedPlan,operationId:'c'.repeat(32)}));
 }
});
test('opening cannot rely on a flag in old code or an unrelated private code receipt',()=>{
 for(const mutate of [f=>f.state.function.codeChecksum='old-code',f=>f.expectedCode.sha256='f'.repeat(64),f=>f.privateCodeEvidence.report.passed=false,f=>f.privateCodeEvidence.report.requestScope='P0A_PRIVATE_CODE_ONLY',f=>f.privateCodeEvidence.report.applicationSource='f'.repeat(40),f=>f.privateCodeEvidence.report.operationId='f'.repeat(32),f=>f.privateCodeEvidence.checkpoint.operationId='f'.repeat(32),f=>f.privateCodeEvidence.report.cumulativeInvocations=17,f=>f.privateCodeEvidence.checkpoint.phase='UPDATED',f=>f.privateCodeEvidence.checkpoint.probes.pop()]){
  const f=fixture();mutate(f);assert.throws(()=>prepareInvitedReadonlyConfig({...f,retainedPlan,operationId:'c'.repeat(32)}));
 }
});
test('readback rejects certificate, route, capacity, credentials or backend trigger drift',()=>{
 for(const mutate of [v=>v.domain.certConfig.certName='foreign',v=>v.domain.certConfig.certificate='invalid',v=>v.domain.tlsConfig.minVersion='TLSv1.1',v=>v.domain.routeConfig.routes[0].functionName='foreign',v=>v.domain.authConfig.authInfo='nonempty',v=>v.state.function.codeChecksum='654321',v=>v.state.function.environmentVariables.SYNTHETIC_SECRET='changed',v=>v.state.function.environmentVariables.V2_FC_PUBLIC_READ_ONLY='false',v=>v.state.function.customDNS={},v=>v.state.function.memorySize=1024,v=>v.state.triggers[0].triggerName='foreign']){
  const f=fixture();mutate(f.opened);assert.equal(verifyInvitedReadonlyConfig(f.change,f.opened),false);assert.throws(()=>readonlyEntryRollbackRequests(f.change,f.opened),/DO_NOT_OVERWRITE/);
 }
});
test('owned trigger accepts harmless response metadata but never public default URL, other methods or another operation',()=>{
 for(const mutate of [t=>t.description='foreign-operation',t=>t.invocationRole='foreign-role',t=>t.triggerConfig=JSON.stringify({authType:'anonymous',disableURLInternet:false,methods:['GET','POST']}),t=>t.triggerConfig=JSON.stringify({authType:'anonymous',disableURLInternet:true,methods:['GET','POST','DELETE']}),t=>t.triggerConfig='bad-json']){
  const f=fixture();mutate(f.opened.state.triggers[2]);assert.equal(verifyInvitedReadonlyConfig(f.change,f.opened),false);
 }
 const f=fixture();f.opened.state.triggers[2].triggerConfig={authType:'anonymous',disableURLInternet:true,methods:['POST','GET'],authConfig:'{}'};
 assert.equal(verifyInvitedReadonlyConfig(f.change,f.opened),true);
});
test('owned full-entry rollback closes the gate first, restores only auth and removes only its trigger',()=>{
 const f=fixture(),rollback=readonlyEntryRollbackRequests(f.change,f.opened);
 assert.deepEqual(rollback.closeFunction,{environmentVariables:f.state.function.environmentVariables});
 assert.deepEqual(rollback.restoreDomain,{authConfig:{authType:'function',authInfo:'{}'}});
 assert.equal(rollback.deleteTrigger,'shuduo-invited-readonly');
 assert.deepEqual(Object.keys(rollback),['closeFunction','restoreDomain','deleteTrigger']);
 const tampered=structuredClone(f.change);tampered.rollbackFunctionBody.environmentVariables.SYNTHETIC_SECRET='overwrite';
 assert.throws(()=>readonlyEntryRollbackRequests(tampered,f.opened),/DO_NOT_OVERWRITE/);
 const partial=structuredClone(f.opened);partial.state.triggers.pop();
 assert.throws(()=>readonlyEntryRollbackRequests(f.change,partial),/DO_NOT_OVERWRITE/);
});
test('recomputing a plain digest is not authority to widen the prepared request bodies',()=>{
 const canonical=v=>JSON.stringify(v&&typeof v==='object'?Array.isArray(v)?v.map(x=>JSON.parse(canonical(x))):Object.fromEntries(Object.keys(v).sort().map(k=>[k,JSON.parse(canonical(v[k]))])):v??null);
 for(const mutate of [c=>c.functionBody.environmentVariables.V2_FC_PUBLIC_READ_ONLY='false',c=>c.functionBody.environmentVariables.SYNTHETIC_SECRET='overwrite',c=>c.triggerBody.triggerConfig=JSON.stringify({authType:'anonymous',disableURLInternet:false,methods:['GET','POST']}),c=>c.domainBody.protocol='HTTP',c=>c.retainedPlan.target.domainName='foreign.example.invalid']){
  const change=fixture().change;mutate(change);
  const {changeHash,...definition}=change;change.changeHash=createHash('sha256').update(canonical(definition)).digest('hex');
  assert.equal(readonlyConfigIntegrity(change),false);
 }
});

function executionFixture(options={}){
 const f=fixture(),plan=readonlyEntryPlan({authorization:READONLY_ENTRY_SCOPE,operationId:f.change.operationId,operatorSource:'f'.repeat(40),webIndexSha256:'1'.repeat(64),issuedAt:new Date(now).toISOString(),expiresAt:new Date(now+3600000).toISOString(),seed:{newRequests:6,configurationReads:25}},now);
 let cloud={state:structuredClone(f.state),domain:structuredClone(f.domain)},checkpoint;
 const calls=[],snapshots=[];
 const storage={now:()=>now,load:async()=>checkpoint,save:async cp=>{checkpoint=structuredClone(cp);snapshots.push({checkpoint:structuredClone(cp),cloud:structuredClone(cloud)});}};
 const record=name=>{
  calls.push(name);
  if(name.startsWith('read')||name==='listTriggers')assert.equal(checkpoint.configurationReads,25+calls.filter(n=>n.startsWith('read')||n==='listTriggers').length+(options.readOffset??0));
  else if(name!=='probe')assert.equal(checkpoint.writes[name],true,'marker must be saved before cloud write');
 };
 const write=(name,apply)=>async body=>{
  record(name);
  if(options.unapplied===name)throw Error('synthetic lost request');
  apply(body);
  if(options.unknown===name)throw Error('synthetic lost response');
 };
 const adapter={
  readFunction:async()=>{record('readFunction');return structuredClone(cloud.state.function);},
  readDomain:async()=>{record('readDomain');return structuredClone(cloud.domain);},
  listTriggers:async()=>{record('listTriggers');return structuredClone(cloud.state.triggers);},
  readConcurrency:async()=>{record('readConcurrency');return structuredClone(cloud.state.concurrency);},
  readScaling:async()=>{record('readScaling');return structuredClone(cloud.state.scaling);},
  createTrigger:write('createTrigger',body=>cloud.state.triggers.push(structuredClone(body))),
  updateDomain:write('updateDomain',body=>{cloud.domain={...cloud.domain,...body};}),
  openFunction:write('openFunction',body=>{cloud.state.function={...cloud.state.function,...body};}),
  closeFunction:write('closeFunction',body=>{cloud.state.function={...cloud.state.function,...body};}),
  restoreDomain:write('restoreDomain',body=>{cloud.domain={...cloud.domain,...body};}),
  deleteTrigger:write('deleteTrigger',name=>{cloud.state.triggers=cloud.state.triggers.filter(t=>t.triggerName!==name);}),
  probe:async probe=>{
   record('probe');assert.equal(checkpoint.newRequests,6+calls.filter(n=>n==='probe').length+(options.probeOffset??0));
   const value={tlsTrusted:true,endpointMatched:true,certificateMatched:true,hasSetCookie:false,status:200};
   if(probe.id==='default-disabled')value.status=403;
   if(probe.id==='entry-html'){value.contentType='text/html; charset=utf-8';value.bodySha256=plan.webIndexSha256;}
   if(probe.id==='anonymous-session')value.body={authenticated:false,readOnly:true};
   if(['readonly-agent','readonly-publish'].includes(probe.id)){value.status=403;value.body={code:'PUBLIC_READ_ONLY'};}
   if(probe.id==='private-internal'){value.status=404;value.body={code:'INGRESS_DENIED'};}
   if(probe.id==='unmapped-invoke'){value.status=404;value.serviceCode='DomainRouteNotFound';}
   if(probe.id==='foreign-origin'){value.status=403;value.body={message:'请求来源不允许'};}
   if(probe.id==='invalid-login'){value.status=401;value.body={code:'INVALID_LOGIN'};}
   if(options.badProbe===probe.id){
    if(options.foreignDomain)cloud.domain.certConfig.certName='external-change';
    if(options.foreignFunction)cloud.state.function.environmentVariables.EXTERNAL_SETTING='do-not-overwrite';
    value.tlsTrusted=false;
    if(options.unexpectedWrite){value.status=200;value.tlsTrusted=true;value.body={};}
   }
   return value;
  },
 };
 return{...f,plan,storage,adapter,calls,snapshots,checkpoint:()=>checkpoint,cloud:()=>cloud,restore:snapshot=>{checkpoint=structuredClone(snapshot.checkpoint);cloud=structuredClone(snapshot.cloud);},mutate:fn=>fn(cloud)};
}
test('entry sequence preserves the whole-stage ledger and keeps only the intended read-only configuration',async()=>{
 const f=executionFixture(),r=await runReadonlyEntry(f.plan,f.change,f.adapter,f.storage);
 assert.equal(r.passed,true);assert.equal(r.entryRetained,true);assert.equal(r.invitedUserAccepted,false);
 assert.equal(r.configurationReads,39);assert.equal(r.newRequests,15);assert.equal(r.cumulativeRequests,70);
 assert.equal(f.calls.filter(n=>n==='createTrigger').length,1);assert.equal(f.calls.filter(n=>n==='openFunction').length,1);
 assert.equal(verifyInvitedReadonlyConfig(f.change,f.cloud()),true);
 assert.equal(f.calls.indexOf('createTrigger')<f.calls.indexOf('updateDomain'),true);
 assert.equal(f.calls.indexOf('updateDomain')<f.calls.indexOf('openFunction'),true);
 assert.equal(r.externalCleanupRequired,true);
 assert(!JSON.stringify(r).includes('not-a-real-secret'));
 // Even the synthetic normal path already exceeds the old 30-read proposal,
 // before outer IAM cleanup. No old grant may silently receive the new limit.
 assert.ok(r.configurationReads>30);
 assert.throws(()=>readonlyEntryPlan({...f.plan,authorization:'INVITED_READ_ONLY_OPENING'},now),/NEW_GRANT_REQUIRED/);
 assert.throws(()=>readonlyEntryPlan({...f.plan,issuedAt:new Date(f.plan.issuedAt).toISOString(),expiresAt:new Date(f.plan.expiresAt).toISOString(),seed:{newRequests:6,configurationReads:0}},now),/SEED_INVALID/);
 await assert.rejects(runReadonlyEntry({...f.plan,limits:{...f.plan.limits,configurationReads:30}},f.change,f.adapter,f.storage),/PLAN_CHANGED/);
});
test('lost write responses are reconciled, never repeated when the change was actually applied',async()=>{
 for(const unknown of ['createTrigger','updateDomain','openFunction']){
  const f=executionFixture({unknown}),r=await runReadonlyEntry(f.plan,f.change,f.adapter,f.storage);
  assert.equal(r.passed,true);assert.equal(f.calls.filter(n=>n===unknown).length,1);assert.equal(f.checkpoint().unknownWrites[unknown],true);
 }
});
test('an unapplied or unknown create is not retried and does not delete an unrelated resource',async()=>{
 const f=executionFixture({unapplied:'createTrigger'}),r=await runReadonlyEntry(f.plan,f.change,f.adapter,f.storage);
 assert.equal(r.failure,'READONLY_TRIGGER_CREATE_UNCONFIRMED');assert.equal(r.rollback.triggerAbsent,true);assert.equal(r.phase,'ROLLED_BACK');
 assert.equal(f.calls.filter(n=>n==='createTrigger').length,1);assert.equal(f.calls.includes('deleteTrigger'),false);
 const count=f.calls.length,again=await runReadonlyEntry(f.plan,f.change,f.adapter,f.storage);
 assert.equal(again.previouslyRolledBack,true);assert.equal(f.calls.length,count);
});
test('failed acceptance closes only the owned entry and restores signed access without touching DNS or certificates',async()=>{
 const f=executionFixture({badProbe:'readonly-agent'}),r=await runReadonlyEntry(f.plan,f.change,f.adapter,f.storage);
 assert.equal(r.passed,false);assert.equal(r.failureAt,'readonly-agent');assert.equal(r.phase,'ROLLED_BACK');
 assert.deepEqual(r.rollback,{functionRestored:true,domainRestored:true,triggerAbsent:true,issues:[],entryClosed:true});
 assert.equal(f.cloud().domain.certConfig.certName,f.domain.certConfig.certName);
 assert.equal(f.cloud().domain.authConfig.authType,'function');
 assert.equal(f.cloud().state.triggers.length,2);
 assert.equal(f.calls.indexOf('closeFunction')<f.calls.indexOf('restoreDomain'),true);
 assert.equal(f.calls.indexOf('restoreDomain')<f.calls.indexOf('deleteTrigger'),true);
 const unexpected=executionFixture({badProbe:'readonly-agent',unexpectedWrite:true});
 const bad=await runReadonlyEntry(unexpected.plan,unexpected.change,unexpected.adapter,unexpected.storage);
 assert.equal(bad.passed,false);assert.equal(bad.possibleUnexpectedWrite,true);
 assert.equal(bad.modelCalls,undefined);assert.equal(bad.modelCallsRequested,0);
});
test('foreign changes are not overwritten and do not prevent independent containment',async()=>{
 for(const options of [{foreignDomain:true},{foreignFunction:true}]){
  const f=executionFixture({...options,badProbe:'readonly-agent'}),r=await runReadonlyEntry(f.plan,f.change,f.adapter,f.storage);
  assert.equal(r.phase,'NEEDS_ATTENTION');assert.equal(r.rollback.entryClosed,true);assert.equal(r.rollback.triggerAbsent,true);
  if(options.foreignDomain){assert.equal(f.calls.includes('restoreDomain'),false);assert.equal(f.cloud().domain.certConfig.certName,'external-change');assert.equal(r.rollback.functionRestored,true);}
  if(options.foreignFunction){assert.equal(f.calls.includes('closeFunction'),false);assert.equal(f.cloud().state.function.environmentVariables.EXTERNAL_SETTING,'do-not-overwrite');assert.equal(r.rollback.domainRestored,true);}
 }
});
test('failed cleanup is retried only by observation, never as a second unconfirmed write',async()=>{
 const f=executionFixture({badProbe:'readonly-agent',unapplied:'closeFunction'}),r=await runReadonlyEntry(f.plan,f.change,f.adapter,f.storage);
 assert.equal(r.phase,'NEEDS_ATTENTION');assert.equal(r.rollback.functionRestored,false);assert.equal(r.rollback.entryClosed,true);
 const again=await runReadonlyEntry(f.plan,f.change,f.adapter,f.storage);
 assert.equal(again.phase,'NEEDS_ATTENTION');assert.equal(f.calls.filter(n=>n==='closeFunction').length,1);
 assert.equal(f.calls.filter(n=>n==='deleteTrigger').length,1);
});
test('corrupt checkpoints and expired grants perform no resource requests',async()=>{
 const f=executionFixture();await runReadonlyEntry(f.plan,f.change,f.adapter,f.storage);
 const good={checkpoint:structuredClone(f.checkpoint()),cloud:structuredClone(f.cloud())};
 for(const mutate of [cp=>cp.changeHash='0'.repeat(64),cp=>cp.newRequests=6,cp=>cp.writes={openFunction:true},cp=>cp.probes.pop()]){
  f.restore(good);mutate(f.checkpoint());const count=f.calls.length;
  const r=await runReadonlyEntry(f.plan,f.change,f.adapter,f.storage);
  assert.equal(r.passed,false);assert.equal(f.calls.length,count);
 }
 f.restore(good);const count=f.calls.length;
 await assert.rejects(runReadonlyEntry(f.plan,f.change,f.adapter,{...f.storage,now:()=>f.plan.expiresAt}),/WINDOW_EXPIRED/);
 assert.equal(f.calls.length,count);
});
test('successful retained entry is never torn down by a later readback failure',async()=>{
 const f=executionFixture();await runReadonlyEntry(f.plan,f.change,f.adapter,f.storage);
 f.mutate(cloud=>cloud.domain.certConfig.certName='later-owner-change');
 const r=await runReadonlyEntry(f.plan,f.change,f.adapter,f.storage);
 assert.equal(r.failure,'READONLY_RETAINED_ENTRY_DRIFT');assert.equal(f.calls.includes('closeFunction'),false);assert.equal(f.calls.includes('deleteTrigger'),false);
});
test('resume after a confirmed create preserves counters and never creates the trigger twice',async()=>{
 const first=executionFixture();await runReadonlyEntry(first.plan,first.change,first.adapter,first.storage);
 const point=first.snapshots.find(s=>s.cloud.state.triggers.length===3&&s.checkpoint.writes.createTrigger&&!s.checkpoint.writes.updateDomain);
 assert.ok(point);
 const resumed=executionFixture({readOffset:point.checkpoint.configurationReads-25,probeOffset:point.checkpoint.newRequests-6});
 resumed.restore(point);
 const r=await runReadonlyEntry(resumed.plan,resumed.change,resumed.adapter,resumed.storage);
 assert.equal(r.passed,true);assert.equal(resumed.calls.includes('createTrigger'),false);
 assert.equal(resumed.calls.filter(n=>n==='updateDomain').length,1);
 assert.equal(resumed.calls.filter(n=>n==='openFunction').length,1);
 assert.equal(r.cumulativeRequests,70);assert.ok(r.configurationReads>point.checkpoint.configurationReads);
});
test('resume may re-read one interrupted GET but never repeats an unconfirmed POST probe',async()=>{
 const first=executionFixture();await runReadonlyEntry(first.plan,first.change,first.adapter,first.storage);
 for(const id of ['default-disabled','readonly-agent']){
  const point=first.snapshots.find(s=>s.checkpoint.probeAttempts[id]===1&&!s.checkpoint.probes.some(p=>p.id===id));
  assert.ok(point);
  const resumed=executionFixture({readOffset:point.checkpoint.configurationReads-25,probeOffset:point.checkpoint.newRequests-6});
  resumed.restore(point);
  const r=await runReadonlyEntry(resumed.plan,resumed.change,resumed.adapter,resumed.storage);
  if(id==='default-disabled'){
   assert.equal(r.passed,true);assert.equal(resumed.checkpoint().probeAttempts[id],2);assert.equal(r.cumulativeRequests,71);
  }else{
   assert.equal(r.failure,'READONLY_PROBE_OUTCOME_UNKNOWN');assert.equal(r.phase,'ROLLED_BACK');
   assert.equal(resumed.calls.includes('probe'),false);assert.equal(r.rollback.entryClosed,true);
  }
 }
});
test('exhausted metadata budget never issues an extra read or unverified cleanup write',async()=>{
 const first=executionFixture();await runReadonlyEntry(first.plan,first.change,first.adapter,first.storage);
 const point={checkpoint:structuredClone(first.checkpoint()),cloud:structuredClone(first.cloud())};
 point.checkpoint.phase='ACTIVE';point.checkpoint.configurationReads=80;
 const resumed=executionFixture();resumed.restore(point);
 const r=await runReadonlyEntry(resumed.plan,resumed.change,resumed.adapter,resumed.storage);
 assert.equal(r.passed,false);assert.equal(r.configurationReads,80);assert.equal(r.rollback.entryClosed,false);
 assert.deepEqual(resumed.calls,[]);assert.equal(r.phase,'NEEDS_ATTENTION');
});
test('HTTP success alone cannot pass HTML, identity, TLS or application-error acceptance',()=>{
 const f=executionFixture(),base={tlsTrusted:true,endpointMatched:true,certificateMatched:true,hasSetCookie:false,status:200};
 const cases=[
  ['entry-html',{...base,contentType:'text/html',bodySha256:'2'.repeat(64)}],
  ['entry-html',{...base,contentType:'text/html',bodySha256:f.plan.webIndexSha256,attachment:true}],
  ['anonymous-session',{...base,body:{authenticated:true,readOnly:true}}],
  ['anonymous-session',{...base,body:{authenticated:false,readOnly:false}}],
  ['readonly-agent',{...base,status:403,body:{code:'ACCESS_DENIED'}}],
  ['invalid-login',{...base,status:401,body:{code:'GATEWAY_UNAUTHORIZED'}}],
  ['default-disabled',{...base,status:403,tlsTrusted:false}],
  ['default-disabled',{...base,status:403,endpointMatched:false}],
  ['private-internal',{...base,status:404,body:{code:'INGRESS_DENIED'},hasSetCookie:true}],
 ];
 for(const [id,response] of cases)assert.equal(readonlyEntryProbeAccepted(response,readonlyEntryProbes.find(p=>p.id===id),f.plan),false);
});
function transportFixture(){
 const f=executionFixture(),commands=[],bodyFiles=[];
 const env={GITHUB_ACTIONS:'true',GITHUB_REF:'refs/heads/main',GITHUB_SHA:f.plan.operatorSource,V2_READONLY_OPENING_APPROVED:READONLY_ENTRY_SCOPE,V2_CONTROL_ROLE_ARN:'acs:ram::111122223333:role/fixture-deploy',ALIBABA_CLOUD_ACCESS_KEY_ID:'fixture-id',ALIBABA_CLOUD_ACCESS_KEY_SECRET:'fixture-secret',ALIBABA_CLOUD_SECURITY_TOKEN:'fixture-session'};
 const exec=(program,args,options)=>{
  commands.push({program,args,input:options.input});
  assert.equal(options.env.ALIBABA_CLOUD_IGNORE_PROFILE,'TRUE');
  if(program==='python3'){
   const input=JSON.parse(options.input);assert.equal(input.domainName,'shuduoai.cn');
   return JSON.stringify(input.operation==='get'?{status:200,value:f.domain}:{status:200});
  }
  assert.equal(program,'aliyun');assert(!args[2].includes('?'));
  assert.equal(args[args.indexOf('--retry-count')+1],'0');
  assert(!args.includes('--body'));
  if(args.includes('--body-file')){
   const path=args[args.indexOf('--body-file')+1];
   assert.equal(statSync(path).mode&0o777,0o600);
   assert(!args.join(' ').includes('not-a-real-secret'));
   bodyFiles.push({path,body:JSON.parse(readFileSync(path,'utf8'))});
  }
  if(args[2].endsWith('/triggers'))return JSON.stringify({triggers:[...f.state.triggers,{...f.change.triggerBody,httpTrigger:{urlInternet:'https://fixture-default.cn-hangzhou.fcapp.run/'}}]});
  return JSON.stringify(f.state.function);
 };
 return{...f,env,exec,commands,bodyFiles};
}
test('cloud adapter restricts targets and passes environment secrets only through a disposable 0600 body file',async()=>{
 const f=transportFixture(),adapter=createReadonlyEntryCloudAdapter({plan:f.plan,change:f.change,env:f.env,exec:f.exec,now:()=>now});
 adapter.openFunction(f.change.functionBody);
 assert.deepEqual(f.bodyFiles[0].body,f.change.functionBody);assert.equal(existsSync(f.bodyFiles[0].path),false);
 adapter.closeFunction(f.change.rollbackFunctionBody);adapter.createTrigger(f.change.triggerBody);adapter.updateDomain(f.change.domainBody);adapter.restoreDomain(f.change.rollbackDomainBody);
 await adapter.readFunction();await adapter.listTriggers();await adapter.readDomain();await adapter.readScaling();
 const count=f.commands.length;
 assert.throws(()=>adapter.openFunction({environmentVariables:{V2_LOCAL_DEVELOPMENT:'true'}}),/OUTSIDE_SCOPE/);
 assert.throws(()=>adapter.deleteTrigger('foreign-trigger'),/OUTSIDE_SCOPE/);
 assert.equal(f.commands.length,count);
 for(const patch of [{GITHUB_REF:'refs/heads/other'},{V2_READONLY_OPENING_APPROVED:'yes'},{V2_CONTROL_ROLE_ARN:'foreign-role'},{ALIBABA_CLOUD_SECURITY_TOKEN:''}])
  assert.throws(()=>createReadonlyEntryCloudAdapter({plan:f.plan,change:f.change,env:{...f.env,...patch},exec:f.exec,now:()=>now}));
 const expired=createReadonlyEntryCloudAdapter({plan:f.plan,change:f.change,env:f.env,exec:f.exec,now:()=>f.plan.expiresAt});
 assert.throws(()=>expired.readFunction(),/EXPIRED/);assert.equal(f.commands.length,count);
});
test('default URLs and probe definitions reject redirects, foreign endpoints and arbitrary actions',async()=>{
 assert.equal(readonlyDefaultEndpoint('https://fixture-default.cn-hangzhou.fcapp.run/'),'https://fixture-default.cn-hangzhou.fcapp.run');
 for(const value of ['http://fixture.cn-hangzhou.fcapp.run','https://fixture.cn-beijing.fcapp.run','https://fixture.cn-hangzhou.fcapp.run.evil.invalid','https://u:p@fixture.cn-hangzhou.fcapp.run','https://fixture.cn-hangzhou.fcapp.run/other','https://fixture.cn-hangzhou.fcapp.run/?token=x'])
  assert.throws(()=>readonlyDefaultEndpoint(value));
 let requests=0;
 await assert.rejects(readReadonlyHttpsProbe('https://shuduoai.cn',{...readonlyEntryProbes[2],path:'/invoke'},'1'.repeat(64),{request:()=>{requests++;}}),/OUTSIDE_SCOPE/);
 assert.equal(requests,0);
});
test('Python domain transport isolates legacy create/delete from V2 authentication-only updates',()=>{
 execFileSync('python3',['-c',String.raw`
import importlib.util
spec = importlib.util.spec_from_file_location('transport', 'scripts/transport-v2-domain-signed.py')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
base = {'authorization':'INVITED_READ_ONLY_OPENING_V2','domainName':'shuduoai.cn'}
for auth in ('anonymous','function'):
    op, method, action, path, body = mod.request_shape(dict(base, operation='update', body={'authConfig':{'authType':auth,'authInfo':'{}'}}))
    assert method == 'PUT' and action == 'UpdateCustomDomain' and path.endswith('/shuduoai.cn')
for change in ({'operation':'create'}, {'operation':'delete'}, {'operation':'update','body':{'protocol':'HTTP'}}, {'operation':'update','body':{'authConfig':{'authType':'jwt','authInfo':'{}'}}}):
    try:
        mod.request_shape(dict(base, **change))
        raise AssertionError('scope bypass')
    except ValueError:
        pass
try:
    mod.request_shape({'authorization':'ONE_SIGNED_DOMAIN_BINDING_KEEP_BUSINESS_CLOSED','domainName':'shuduoai.cn','operation':'update','body':{'authConfig':{'authType':'anonymous','authInfo':'{}'}}})
    raise AssertionError('old scope widened')
except ValueError:
    pass
`],{timeout:10000,stdio:'pipe'});
});
test('actual loopback TLS and application responses satisfy the fixed read-only contracts without cloud credentials',async t=>{
 const root=mkdtempSync(join(tmpdir(),'shuduo-tls-app-'));
 mkdirSync(join(root,'web-dist'));
 const html=Buffer.from('<!doctype html><title>数舵 合成传输测试</title>');
 writeFileSync(join(root,'web-dist/index.html'),html);
 const store=new MetadataStore(':memory:'),app=createV2Server({root,store,cloudReadinessEvidence:{format:'SYNTHETIC_ONLY'},ingress:createFcIngress({publicHttpEnabled:true,publicReadOnly:true}),env:{V2_LOCAL_DEVELOPMENT:'false',V2_PUBLIC_ORIGIN:'https://shuduoai.cn'}});
 // Explicitly simulated FC header, valid local test certificate. This is not
 // a real FC edge, public DNS, or publicly trusted certificate acceptance.
 const tls=createHttpsServer({key:material.privateKey,cert:material.certificate},(req,res)=>{
  req.headers['x-fc-control-path']='/http-invoke';req.rawHeaders.push('X-Fc-Control-Path','/http-invoke');
  app.server.emit('request',req,res);
 });
 await new Promise(resolve=>tls.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{tls.closeAllConnections();await new Promise(resolve=>tls.close(resolve));await new Promise(resolve=>app.server.close(()=>resolve()));store.close();rmSync(root,{recursive:true,force:true});});
 let requests=0;
 const request=(url,options,callback)=>{
  requests++;assert.equal(url.hostname,'shuduoai.cn');assert.equal(options.rejectUnauthorized,true);
  assert.equal(options.headers.Authorization,undefined);assert.equal(options.headers.Cookie,undefined);
  // Test-only mapping and CA, never exposed by production input/config.
  return realHttpsRequest({hostname:'127.0.0.1',port:tls.address().port,servername:'shuduoai.cn',path:url.pathname,ca:material.certificate,...options},callback);
 };
 const plan={webIndexSha256:createHash('sha256').update(html).digest('hex')};
 for(const id of ['entry-html','anonymous-session','readonly-agent','readonly-publish','private-internal','foreign-origin','invalid-login']){
  const probe=readonlyEntryProbes.find(p=>p.id===id),result=await readReadonlyHttpsProbe('https://shuduoai.cn',probe,certificate.leafSha256,{request,timeoutMs:5000});
  assert.equal(readonlyEntryProbeAccepted(result,probe,plan),true,id);
  assert.equal(result.tlsTrusted,true);assert.equal(result.certificateMatched,true);
 }
 assert.equal(requests,7);assert.equal(store.list('agent','project-securities-lab').length,0);assert.equal(store.list('run','project-securities-lab').length,0);
});
