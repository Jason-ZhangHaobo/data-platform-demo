import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {acceptanceConfig,boundaryCases,runHttpAcceptance,cleanupAcceptance,commandFailure,inlineBodyArguments,functionHash,triggerHash} from '../../scripts/accept-v2-http-boundary.mjs';
import {P0B_SIGNED_ACCESS_AUTHORIZATION,P0B_SIGNED_RESUME_AUTHORIZATION,P0B_DOMAIN_REMAINING_AUTHORIZATION} from '../../scripts/v2-domain-binding-plan.mjs';
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
 const recovery=await runHttpAcceptance(f.config,f.adapter,f.options);assert.equal(recovery.recoveryOnly,true);assert.equal(f.creates(),1);assert.equal(recovery.requests,15);assert.equal(recovery.newRequests,0);
});
test('prior attempts remain counted across recovery and insufficient total budget stops before invocation',async()=>{
 const f=fixture();f.config.previousReads=1;
 const r=await runHttpAcceptance(f.config,f.adapter,f.options);assert.equal(r.passed,true);assert.equal(r.priorRequests,1);assert.equal(r.requests,16);assert.equal(r.newRequests,15);
 const blocked=fixture();blocked.config.previousReads=6;let calls=0;blocked.adapter.privateStatus=async()=>{calls++;};
 const no=await runHttpAcceptance(blocked.config,blocked.adapter,blocked.options);assert.equal(no.failure,'INSUFFICIENT_REMAINING_READ_BUDGET');assert.equal(no.requests,6);assert.equal(no.newRequests,0);assert.equal(calls,0);assert.equal(blocked.creates(),0);
 for(const value of ['-1','21','1.5','abc',''])assert.throws(()=>acceptanceConfig({...env,V2_HTTP_PREVIOUS_READS:value}));
});
test('recreation requires a separate explicit flag, the original identifier, and carried usage',()=>{
 assert.throws(()=>acceptanceConfig({...env,V2_HTTP_RESTORE_RUN_ID:'98765',V2_HTTP_PREVIOUS_READS:'3'}),/TRIGGER_RESTORE_NOT_AUTHORIZED/);
 assert.throws(()=>acceptanceConfig({...env,V2_HTTP_RESTORE_AUTHORIZED:'RECREATE_SAME_TRIGGER_ONCE'}),/TRIGGER_RESTORE_NOT_AUTHORIZED/);
 assert.throws(()=>acceptanceConfig({...env,V2_HTTP_RESTORE_RUN_ID:'98765',V2_HTTP_RESTORE_AUTHORIZED:'RECREATE_SAME_TRIGGER_ONCE',V2_HTTP_PREVIOUS_READS:'0'}),/TRIGGER_RESTORE_NOT_AUTHORIZED/);
 const c=acceptanceConfig({...env,V2_HTTP_RESTORE_RUN_ID:'98765',V2_HTTP_RESTORE_AUTHORIZED:'RECREATE_SAME_TRIGGER_ONCE',V2_HTTP_PREVIOUS_READS:'3'});
 assert.equal(c.triggerName,'shuduo-http-boundary-98765');assert.equal(c.previousReads,3);assert.equal(c.restoreRunId,'98765');
});
test('new P0-B scope preserves seventeen historical calls and only permits fifteen new default checks',async()=>{
 const f=fixture(),stage={...env,V2_HTTP_ACCEPTANCE_AUTHORIZED:P0B_SIGNED_ACCESS_AUTHORIZATION,V2_HTTPS_AUTHORIZATION:P0B_SIGNED_ACCESS_AUTHORIZATION,V2_HTTP_PREVIOUS_READS:'17',V2_HTTP_RESTORE_RUN_ID:'98765',V2_HTTP_RESTORE_AUTHORIZED:'RECREATE_SAME_TRIGGER_ONCE'};
 const config=acceptanceConfig(stage);assert.equal(config.maxRequests,32);Object.assign(f.config,config);
 const report=await runHttpAcceptance(f.config,f.adapter,f.options);
 assert.equal(report.passed,true);assert.equal(report.priorRequests,17);assert.equal(report.newRequests,15);assert.equal(report.requests,32);assert.equal(report.reservedCny,2);assert.equal(f.creates(),1);assert.equal(report.cleanup.triggerAbsent,true);
 const recovered=await runHttpAcceptance(f.config,f.adapter,f.options);assert.equal(recovered.requests,32);assert.equal(recovered.newRequests,0);assert.equal(f.creates(),1);
 for(const patch of [{V2_HTTPS_AUTHORIZATION:undefined},{V2_HTTP_PREVIOUS_READS:'0'},{V2_HTTP_PREVIOUS_READS:'5'},{V2_HTTP_PREVIOUS_READS:'16'},{V2_HTTP_PREVIOUS_READS:'18'},{V2_HTTP_RESTORE_RUN_ID:''}])assert.throws(()=>acceptanceConfig({...stage,...patch}));
 const wrong=fixture();Object.assign(wrong.config,config,{maxRequests:33});const denied=await runHttpAcceptance(wrong.config,wrong.adapter,wrong.options);assert.equal(denied.failure,'P0B_SCOPE_CHANGED');assert.equal(wrong.calls.length,0);
});
test('one HTTPS resume preserves thirty-two calls and refuses mixed scopes or baseline drift',async()=>{
 const f=fixture(),stage={...env,V2_HTTP_ACCEPTANCE_AUTHORIZED:P0B_SIGNED_RESUME_AUTHORIZATION,V2_HTTPS_AUTHORIZATION:P0B_SIGNED_RESUME_AUTHORIZATION,V2_HTTP_PREVIOUS_READS:'32',V2_HTTP_RESTORE_RUN_ID:'98765',V2_HTTP_RESTORE_AUTHORIZED:'RECREATE_SAME_TRIGGER_ONCE',V2_HTTP_PRIOR_FUNCTION_HASH:functionHash(f.f),V2_HTTP_PRIOR_TRIGGERS_HASH:triggerHash(f.original)};
 const config=acceptanceConfig(stage);Object.assign(f.config,config);assert.equal(config.maxRequests,47);
 const r=await runHttpAcceptance(f.config,f.adapter,f.options);assert.equal(r.passed,true);assert.equal(r.requests,47);assert.equal(r.priorRequests,32);assert.equal(r.newRequests,15);assert.equal(r.unsettledReservedCny,6);assert.equal(f.creates(),1);
 const recovered=await runHttpAcceptance(f.config,f.adapter,f.options);assert.equal(recovered.requests,47);assert.equal(recovered.newRequests,0);assert.equal(f.creates(),1);
 for(const patch of [{V2_HTTP_PREVIOUS_READS:'17'},{V2_HTTP_PREVIOUS_READS:'0'},{V2_HTTP_PREVIOUS_READS:'33'},{V2_HTTPS_AUTHORIZATION:P0B_SIGNED_ACCESS_AUTHORIZATION},{V2_HTTP_ACCEPTANCE_AUTHORIZED:P0B_SIGNED_ACCESS_AUTHORIZATION},{V2_HTTP_PRIOR_FUNCTION_HASH:''},{V2_HTTP_PRIOR_TRIGGERS_HASH:'not-a-digest'}])assert.throws(()=>acceptanceConfig({...stage,...patch}));
 for(const patch of [{priorFunctionHash:'f'.repeat(64)},{priorOriginalTriggersHash:'f'.repeat(64)},{maxRequests:55}]){
  const bad=fixture();Object.assign(bad.config,config,patch);let calls=0;bad.adapter.privateStatus=async()=>{calls++;};const denied=await runHttpAcceptance(bad.config,bad.adapter,bad.options);assert.equal(denied.passed,false);assert.equal(denied.newRequests,0);assert.equal(calls,0);assert.equal(bad.creates(),0);
 }
 const budget=fixture();Object.assign(budget.config,config);budget.adapter.billPages=async cycle=>[{Success:true,Data:{BillingCycle:cycle,PageNum:1,PageSize:300,TotalCount:1,Items:{Item:[{Currency:'CNY',PretaxAmount:'192.50'}]}}}];
 const denied=await runHttpAcceptance(budget.config,budget.adapter,budget.options);assert.equal(denied.failure,'BUDGET_NOT_VERIFIED');assert.equal(denied.newRequests,0);assert.equal(budget.creates(),0);
});
test('remaining-domain scope revalidates prior evidence without any default invocation or probe',async()=>{
 const f=fixture(),stage={...env,V2_HTTP_ACCEPTANCE_AUTHORIZED:P0B_DOMAIN_REMAINING_AUTHORIZATION,V2_HTTPS_AUTHORIZATION:P0B_DOMAIN_REMAINING_AUTHORIZATION,V2_HTTP_PREVIOUS_READS:'47',V2_HTTP_RESTORE_RUN_ID:'98765',V2_HTTP_RESTORE_AUTHORIZED:'RECREATE_SAME_TRIGGER_ONCE',V2_HTTP_PRIOR_FUNCTION_HASH:functionHash(f.f),V2_HTTP_PRIOR_TRIGGERS_HASH:triggerHash(f.original),V2_HTTP_PRIOR_HTTPS_RUN_ID:'12344',V2_HTTP_PRIOR_HTTPS_DIGEST:'d'.repeat(64)};
 const config={...acceptanceConfig(stage),domainBindingAuthorization:'ONE_SIGNED_DOMAIN_BINDING_KEEP_BUSINESS_CLOSED'};Object.assign(f.config,config);
 f.adapter.privateStatus=async()=>assert.fail('must not repeat private invocation');f.adapter.probe=async()=>assert.fail('must not repeat default HTTP probes');
 const r=await runHttpAcceptance(f.config,f.adapter,{...f.options,deferForDomain:true});
 assert.equal(r.passed,true);assert.equal(r.scope,'SIGNED_DOMAIN_PREPARATION_ONLY');assert.equal(r.phase,'PRIOR_BOUNDARY_REVALIDATED');assert.equal(r.defaultBoundaryReused,true);assert.equal(r.requests,47);assert.equal(r.newRequests,0);assert.equal(r.results.length,0);assert.equal(r.unsettledReservedCny,8);assert.equal(f.creates(),1);
 assert.deepEqual(r.priorBoundaryEvidence,{runId:'12344',digest:'d'.repeat(64)});assert.equal(r.cleanup.deferredForSameDomainBatch,true);
 const recovered=await runHttpAcceptance(f.config,f.adapter,{...f.options,deferForDomain:true});assert.equal(recovered.newRequests,0);assert.equal(recovered.requests,47);assert.equal(recovered.cleanup.triggerAbsent,true);assert.equal(f.creates(),1);
 for(const patch of [{V2_HTTP_PREVIOUS_READS:'32'},{V2_HTTP_PREVIOUS_READS:'48'},{V2_HTTP_PRIOR_HTTPS_RUN_ID:''},{V2_HTTP_PRIOR_HTTPS_RUN_ID:env.GITHUB_RUN_ID},{V2_HTTP_PRIOR_HTTPS_DIGEST:''},{V2_HTTPS_AUTHORIZATION:P0B_SIGNED_RESUME_AUTHORIZATION}])assert.throws(()=>acceptanceConfig({...stage,...patch}));
 for(const patch of [{priorFunctionHash:'f'.repeat(64)},{priorOriginalTriggersHash:'f'.repeat(64)},{maxRequests:55},{priorHttpsAcceptanceDigest:''}]){
  const bad=fixture();Object.assign(bad.config,config,patch);bad.adapter.privateStatus=async()=>assert.fail('no invoke');bad.adapter.probe=async()=>assert.fail('no probe');
  const denied=await runHttpAcceptance(bad.config,bad.adapter,{...bad.options,deferForDomain:true});assert.equal(denied.passed,false);assert.equal(denied.newRequests,0);assert.equal(bad.creates(),0);
 }
 const standalone=fixture();Object.assign(standalone.config,config);const denied=await runHttpAcceptance(standalone.config,standalone.adapter,standalone.options);assert.equal(denied.failure,'DOMAIN_ONLY_REQUIRES_HELD_INGRESS');assert.equal(standalone.creates(),0);
});
test('failure evidence distinguishes CLI service denial, transport and parsing without response text or secrets',async()=>{
 const args=['fc','POST','/2023-03-30/functions/private-name/invocations'];
 const error=Object.assign(Error('SYNTHETIC_SECRET'),{status:2,stderr:JSON.stringify({error:{code:'AccessDenied',message:'SYNTHETIC_SECRET'}})});
 const classified=commandFailure(args,error);assert.equal(classified.safeDiagnostic.serviceCode,'AccessDenied');assert.equal(classified.safeDiagnostic.operation,'PRIVATE_STATUS');assert.equal(classified.safeDiagnostic.jsonParsingFailed,false);
 const parsing=commandFailure(args,new SyntaxError('private response'), 'PRIVATE_RESPONSE');assert.equal(parsing.safeDiagnostic.jsonParsingFailed,true);assert.equal(parsing.safeDiagnostic.responseBytes,16);
 const eof=commandFailure(args,{status:2,stderr:JSON.stringify({message:'request to fixture.example failed: EOF'})});assert.equal(eof.safeDiagnostic.transport,'NETWORK');
 const confirm=commandFailure(args,{status:1,stderr:'confirmation required before this call'});assert.equal(confirm.safeDiagnostic.cliConfirmationRequired,true);
 assert.equal(commandFailure(args,{code:'ETIMEDOUT'}).safeDiagnostic.processTimeout,true);
 assert(!JSON.stringify(classified.safeDiagnostic).includes('SYNTHETIC_SECRET'));assert(!JSON.stringify(parsing.safeDiagnostic).includes('PRIVATE_RESPONSE'));assert(!JSON.stringify(classified.safeDiagnostic).includes('private-name'));
 const f=fixture();f.adapter.privateStatus=async()=>{throw classified;};const r=await runHttpAcceptance(f.config,f.adapter,f.options);
 assert.equal(r.phase,'PRIVATE_STATUS_BASELINE');assert.equal(r.failureDiagnostic.serviceCode,'AccessDenied');assert.equal(r.requests,1);assert.equal(f.creates(),0);
});
test('inline CLI bodies permit only the fixed secret-free status and temporary trigger payloads',async()=>{
 const call=['fc','POST','/2023-03-30/functions/fixture/invocations'];
 assert.deepEqual(inlineBodyArguments(call,{operation:'PRIVATE_STATUS_V1'}),['--body','{"operation":"PRIVATE_STATUS_V1"}']);
 assert.deepEqual(inlineBodyArguments(['fc','GET','/fixture'],undefined),[]);
 for(const body of [{operation:'PRIVATE_APPLICATION_TASK_V1'},{operation:'PRIVATE_STATUS_V1',secret:'DO_NOT_PASS'},'arbitrary'])assert.throws(()=>inlineBodyArguments(call,body),/INLINE_BODY_NOT_ALLOWLISTED/);
 assert.throws(()=>inlineBodyArguments(['fc','PUT','/functions/fixture'],{environmentVariables:{SECRET:'DO_NOT_PASS'}}),/INLINE_BODY_NOT_ALLOWLISTED/);
 const f=fixture(),fc=f.adapter.fc;f.adapter.fc=async(method,path,body)=>{if(method==='POST')assert.equal(inlineBodyArguments(['fc',method,path],body)[0],'--body');return fc(method,path,body);};
 assert.equal((await runHttpAcceptance(f.config,f.adapter,f.options)).passed,true);
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
test('slow preflight cannot consume the cleanup window and then create a trigger',async()=>{
 const f=fixture();let now=Date.UTC(2026,9,21);const bill=f.adapter.billPages;
 f.adapter.billPages=async cycle=>{now+=21*60000;return bill(cycle);};
 const r=await runHttpAcceptance(f.config,f.adapter,{...f.options,now:()=>now});
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
test('documented unsigned header rejection is accepted only with exact evidence; signed requests still require application denial',async()=>{
 const f=fixture(),probe=f.adapter.probe;f.adapter.probe=async(url,p)=>p.signed===false?{status:400,code:'MissingRequiredHeader',authenticationRejected:true}:probe(url,p);
 assert.equal((await runHttpAcceptance(f.config,f.adapter,f.options)).passed,true);
 for(const value of [{status:400,code:'UNCONFIRMED',authenticationRejected:true},{status:400,code:'MissingRequiredHeader',authenticationRejected:false},{status:400,code:'InvalidArgument',authenticationRejected:true}]){
  const g=fixture();g.adapter.probe=async()=>value;assert.equal((await runHttpAcceptance(g.config,g.adapter,g.options)).passed,false);
 }
 const signed=fixture();signed.adapter.probe=async()=>({status:400,code:'MissingRequiredHeader',authenticationRejected:true});
 const result=await runHttpAcceptance(signed.config,signed.adapter,signed.options);assert.equal(result.passed,false);assert.equal(result.phase,'HTTP_signed-baseline');
});
test('only classified empty-authorization InvalidArgument is accepted for the unsigned negative control',async()=>{
 const f=fixture(),probe=f.adapter.probe;
 f.adapter.probe=async(url,p)=>p.signed===false?{status:400,code:'InvalidArgument',gatewayCategory:'EMPTY_AUTHORIZATION',authenticationRejected:true}:probe(url,p);
 assert.equal((await runHttpAcceptance(f.config,f.adapter,f.options)).passed,true);
 for(const patch of [{gatewayCategory:'UNCLASSIFIED'},{authenticationRejected:false}]){
  const g=fixture(),original=g.adapter.probe;g.adapter.probe=async(url,p)=>p.signed===false?{status:400,code:'InvalidArgument',gatewayCategory:'EMPTY_AUTHORIZATION',authenticationRejected:true,...patch}:original(url,p);
  assert.equal((await runHttpAcceptance(g.config,g.adapter,g.options)).passed,false);
 }
 const signed=fixture();signed.adapter.probe=async()=>({status:400,code:'InvalidArgument',gatewayCategory:'EMPTY_AUTHORIZATION',authenticationRejected:true});
 assert.equal((await runHttpAcceptance(signed.config,signed.adapter,signed.options)).passed,false);
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
 const f=fixture();let time=Date.UTC(2026,9,21);f.adapter.probe=async()=>{time+=600001;return{status:404,code:'INGRESS_DENIED'};};
 const r=await runHttpAcceptance(f.config,f.adapter,{...f.options,now:()=>time});assert.equal(r.failure,'ACCEPTANCE_LIMIT_REACHED');assert.equal(r.requests,2);assert.equal(r.cleanup.triggerAbsent,true);
 assert.equal(boundaryCases.length,14);assert(boundaryCases.every(p=>['GET','POST'].includes(p.method)));
 assert.equal(boundaryCases[0].id,'signed-baseline');
});
test('workflow has default denial, protected environment, no app secrets and unconditional cleanup/sealing',()=>{
 const text=readFileSync('.github/workflows/accept-v2-http-boundary.yml','utf8');
 assert.match(text,/default: NOT_AUTHORIZED/);assert.match(text,/environment: v2-staging/);assert.match(text,/refs\/heads\/main/);assert.match(text,/cancel-in-progress: false/);assert.equal((text.match(/if: always\(\)/g)||[]).length,3);assert.match(text,/--cleanup/);assert.match(text,/--seal/);assert(!text.includes('secrets.'));assert.match(text,/path: v2-http-acceptance\.sealed\.json/);
});
test('the same trigger may be held only for the explicitly authorized domain batch after all checks pass',async()=>{
 const denied=fixture(),blocked=await runHttpAcceptance(denied.config,denied.adapter,{...denied.options,deferForDomain:true});
 assert.equal(blocked.failure,'DOMAIN_HOLD_NOT_AUTHORIZED');assert.equal(denied.creates(),0);
 const valid=fixture();valid.config.domainBindingAuthorization='ONE_SIGNED_DOMAIN_BINDING_KEEP_BUSINESS_CLOSED';valid.config.previousReads=3;
 const ready=await runHttpAcceptance(valid.config,valid.adapter,{...valid.options,deferForDomain:true});
 assert.equal(ready.passed,true);assert.equal(ready.requests,18);assert.equal(ready.cleanup.deferredForSameDomainBatch,true);assert.equal(valid.creates(),1);assert.equal(valid.remaining().length,3);
 assert.equal((await cleanupAcceptance(valid.config,valid.adapter,valid.checkpoint())).triggerAbsent,true);assert.deepEqual(valid.remaining(),valid.original);
 const remaining=fixture();remaining.config.domainBindingAuthorization=valid.config.domainBindingAuthorization;remaining.config.previousReads=5;
 const last=await runHttpAcceptance(remaining.config,remaining.adapter,{...remaining.options,deferForDomain:true});assert.equal(last.passed,true);assert.equal(last.requests,20);assert.equal(last.newRequests,15);await cleanupAcceptance(remaining.config,remaining.adapter,remaining.checkpoint());
 const bad=fixture({badProbe:true});bad.config.domainBindingAuthorization=valid.config.domainBindingAuthorization;
 const failed=await runHttpAcceptance(bad.config,bad.adapter,{...bad.options,deferForDomain:true});assert.equal(failed.passed,false);assert.equal(failed.cleanup.triggerAbsent,true);assert.deepEqual(bad.remaining(),bad.original);
});
