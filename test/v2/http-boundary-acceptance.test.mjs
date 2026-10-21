import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {acceptanceConfig,boundaryCases,runHttpAcceptance,cleanupAcceptance} from '../../scripts/accept-v2-http-boundary.mjs';
const env={GITHUB_REF:'refs/heads/main',GITHUB_ACTIONS:'true',GITHUB_RUN_ID:'12345',GITHUB_SHA:'a'.repeat(40),V2_DEPLOY_ROLE_ARN:'acs:ram::111111111111:role/fixture-role',V2_DEPLOY_OIDC_PROVIDER_ARN:'acs:ram::111111111111:oidc-provider/fixture-provider',V2_FUNCTION_NAME:'fixture-control',ALIBABA_CLOUD_REGION_ID:'cn-hangzhou',V2_EXPECTED_CODE_CHECKSUM:'123456',V2_HTTP_ACCEPTANCE_AUTHORIZED:'ONE_TEMPORARY_SIGNED_TRIGGER_MAX_20_READS',V2_HTTP_AUTHORIZATION_EXPIRES_AT:'2026-10-21T00:30:00Z'};
function fixture(options={}){
 env.V2_ACCEPTANCE_SOURCE_REVISION=env.GITHUB_SHA;
 const config=acceptanceConfig(env),calls=[],original=[{triggerName:'fixture-wake',triggerType:'oss'},{triggerName:'fixture-result',triggerType:'oss'}];
 let list=structuredClone(original),cp,createCount=0;
 const f={functionName:config.functionName,codeChecksum:config.expectedChecksum,cpu:0.25,memorySize:512,instanceConcurrency:1,timeout:120,environmentVariables:{V2_PRIVATE_SMOKE_ENABLED:'true',V2_PROVISIONING_ONLY:'true',DASHSCOPE_API_KEY:'SYNTHETIC_SECRET_MUST_NOT_LEAK'}};
 const adapter={
  identity:async()=>({AccountId:config.account,Arn:`acs:ram::${config.account}:assumed-role/${config.role}/fixture`}),
  fc:async(method,path,body)=>{
   calls.push({method,path});
   if(method==='GET'&&path==='')return structuredClone(f);
   if(method==='GET'&&path==='/triggers')return {triggers:structuredClone(list)};
   if(method==='POST'&&path==='/triggers'){
    assert(cp,'checkpoint exists before create');createCount++;
    list.push({...body,httpTrigger:{urlInternet:'https://fixture.cn-hangzhou.fcapp.run/'}});
    if(options.unknownCreate)throw Error('synthetic create response lost');return {};
   }
   if(method==='DELETE'&&path===`/triggers/${config.triggerName}`){if(!options.deleteFails)list=list.filter(t=>t.triggerName!==config.triggerName);if(options.deleteFails||options.unknownDelete)throw Error('synthetic delete response lost');return {};}
   throw Error('unexpected mutation');
  },
  billPages:async cycle=>[{Success:true,Data:{BillingCycle:cycle,PageNum:1,PageSize:300,TotalCount:1,Items:{Item:[{Currency:'CNY',PretaxAmount:options.overBudget?'199.10':'1.25'}]}}}],
  privateStatus:async()=>({ingress:{mode:'FC_CONTROL_PATH',publicHttpEnabled:false}}),
  probe:async(url,probe)=>({status:probe.signed===false?401:404,code:options.badProbe?'UNCONFIRMED':'INGRESS_DENIED',privateProtocol:Boolean(options.leaks),bytes:40,responseHash:'b'.repeat(64)}),
 };
 return{config,adapter,calls,original,f,options:{now:()=>Date.UTC(2026,9,21),save:value=>{cp=structuredClone(value);},load:()=>cp},checkpoint:()=>cp,remaining:()=>list,creates:()=>createCount};
}
test('acceptance requires main, exact role config, explicit scope and expected deployed checksum',()=>{
 env.V2_ACCEPTANCE_SOURCE_REVISION=env.GITHUB_SHA;
 assert.equal(acceptanceConfig(env).functionName,'fixture-control');
 for(const patch of [{GITHUB_REF:'refs/heads/feature'},{GITHUB_ACTIONS:'false'},{V2_EXPECTED_CODE_CHECKSUM:''},{V2_HTTP_ACCEPTANCE_AUTHORIZED:'yes'},{V2_ACCEPTANCE_SOURCE_REVISION:'b'.repeat(40)}])assert.throws(()=>acceptanceConfig({...env,...patch}));
});
test('happy path uses one trigger and 15 bounded read invocations, restores original state, omits secrets',async()=>{
 const f=fixture(),r=await runHttpAcceptance(f.config,f.adapter,f.options);
 assert.equal(r.passed,true);assert.equal(r.requests,15);assert.equal(r.results.length,14);assert.equal(f.creates(),1);assert.deepEqual(f.remaining(),f.original);assert.equal(r.cleanup.triggerAbsent,true);assert.equal(r.modelCalls,0);assert.equal(r.sparkRuns,0);assert(!JSON.stringify(r).includes('SYNTHETIC_SECRET'));assert(!JSON.stringify(f.checkpoint()).includes('SYNTHETIC_SECRET'));
 const recovery=await runHttpAcceptance(f.config,f.adapter,f.options);assert.equal(recovery.recoveryOnly,true);assert.equal(f.creates(),1);assert.equal(recovery.requests,0);
});
test('budget, code and existing-trigger drift stop before creating or invoking',async()=>{
 for(const change of ['budget','code','trigger','identity']){
  const f=fixture({overBudget:change==='budget'});
  if(change==='code')f.f.codeChecksum='999';
  if(change==='trigger')f.remaining().push({triggerName:'unrelated',triggerType:'http'});
  if(change==='identity')f.adapter.identity=async()=>({AccountId:'wrong'});
  let invokes=0;f.adapter.privateStatus=async()=>{invokes++;throw Error('must not invoke');};
  const r=await runHttpAcceptance(f.config,f.adapter,f.options);assert.equal(r.passed,false);assert.equal(f.creates(),0);assert.equal(invokes,0);
 }
});
test('a queued run with too little permission lifetime cannot create an endpoint',async()=>{
 const f=fixture(),r=await runHttpAcceptance(f.config,f.adapter,{...f.options,now:()=>f.config.authorizationExpiresAt-599999});
 assert.equal(r.failure,'AUTHORIZATION_WINDOW_TOO_SHORT');assert.equal(f.creates(),0);assert.equal(r.requests,0);
});
test('unknown create is reconciled and deleted without retrying create',async()=>{
 const f=fixture({unknownCreate:true}),r=await runHttpAcceptance(f.config,f.adapter,f.options);
 assert.equal(r.passed,false);assert.equal(f.creates(),1);assert.equal(r.cleanup.triggerAbsent,true);assert.deepEqual(f.remaining(),f.original);
});
test('bad authentication or leaked private protocol cannot pass; cleanup still executes',async()=>{
 for(const options of [{badProbe:true},{leaks:true}]){
  const f=fixture(options),r=await runHttpAcceptance(f.config,f.adapter,f.options);
  assert.equal(r.passed,false);assert.equal(r.cleanup.triggerAbsent,true);assert.equal(f.creates(),1);
 }
});
test('unknown delete is read back; remaining trigger is never falsely reported removed',async()=>{
 const ok=fixture({unknownDelete:true}),r=await runHttpAcceptance(ok.config,ok.adapter,ok.options);assert.equal(r.cleanup.triggerAbsent,true);
 const bad=fixture({deleteFails:true}),failed=await runHttpAcceptance(bad.config,bad.adapter,bad.options);assert.equal(failed.passed,false);assert.equal(failed.cleanup.triggerAbsent,false);assert.equal(bad.calls.filter(c=>c.method==='DELETE').length,1);
});
test('cleanup refuses a mismatched target or a changed trigger and never edits originals',async()=>{
 const f=fixture({deleteFails:true});await runHttpAcceptance(f.config,f.adapter,f.options);
 const count=f.calls.filter(c=>c.method==='DELETE').length;
 await assert.rejects(cleanupAcceptance(f.config,f.adapter,{...f.checkpoint(),targetHash:'foreign'}),/CLEANUP_TARGET_MISMATCH/);
 f.remaining().find(t=>t.triggerName===f.config.triggerName).description='another owner';
 await assert.rejects(cleanupAcceptance(f.config,f.adapter,f.checkpoint()),/CLEANUP_TRIGGER_DRIFT/);
 assert.equal(f.calls.filter(c=>c.method==='DELETE').length,count);
});
test('deadline and request budget are checked before continuing probes',async()=>{
 const f=fixture();let time=Date.UTC(2026,9,21);f.adapter.probe=async()=>{time+=600001;return{status:401,code:'UNCONFIRMED'};};
 const r=await runHttpAcceptance(f.config,f.adapter,{...f.options,now:()=>time});assert.equal(r.failure,'ACCEPTANCE_LIMIT_REACHED');assert.equal(r.requests,2);assert.equal(r.cleanup.triggerAbsent,true);
 assert.equal(boundaryCases.length,14);assert(boundaryCases.every(p=>['GET','POST'].includes(p.method)));
});
test('workflow has default denial, protected environment, no app secrets and unconditional cleanup/sealing',()=>{
 const text=readFileSync('.github/workflows/accept-v2-http-boundary.yml','utf8');
 assert.match(text,/default: NOT_AUTHORIZED/);assert.match(text,/environment: v2-staging/);assert.match(text,/refs\/heads\/main/);assert.match(text,/cancel-in-progress: false/);assert.equal((text.match(/if: always\(\)/g)||[]).length,3);assert.match(text,/--cleanup/);assert.match(text,/--seal/);assert(!text.includes('secrets.'));assert.match(text,/path: v2-http-acceptance\.sealed\.json/);
});
