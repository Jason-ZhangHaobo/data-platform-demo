import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import {generateKeyPairSync} from 'node:crypto';
import {DOMAIN_BINDING_AUTHORIZATION,P0B_SIGNED_ACCESS_AUTHORIZATION,P0B_SIGNED_RESUME_AUTHORIZATION,P0B_DOMAIN_REMAINING_AUTHORIZATION,DOMAIN_TLS_CIPHER_SUITES,signedAccessLimits,verifySignedHttpsResume,verifyCertificateMaterial,domainBindingPlan,domainTemporaryStatements,domainConfigurationMatches,runDomainBinding} from '../../scripts/v2-domain-binding-plan.mjs';
import {httpsConfig} from '../../scripts/accept-v2-https-binding.mjs';

function materialFixture(){
 const directory=mkdtempSync(join(tmpdir(),'shuduo-domain-plan-'));
 try{
  writeFileSync(join(directory,'test.conf'),'[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=shuduoai.cn\n[ext]\nsubjectAltName=DNS:shuduoai.cn\n',{mode:0o600});
  execFileSync('openssl',['req','-new','-x509','-newkey','rsa:2048','-nodes','-days','2','-config',join(directory,'test.conf'),'-keyout',join(directory,'key.pem'),'-out',join(directory,'cert.pem')],{stdio:'ignore',timeout:10000});
  return{certificate:readFileSync(join(directory,'cert.pem'),'utf8'),privateKey:readFileSync(join(directory,'key.pem'),'utf8')};
 }finally{rmSync(directory,{recursive:true,force:true});}
}
// Only synthetic, locally generated material. Never read project certificates.
const material=materialFixture(),now=Date.now();
const certificate=verifyCertificateMaterial(material,now);
const input={authorization:DOMAIN_BINDING_AUTHORIZATION,domainName:'shuduoai.cn',operationId:'a'.repeat(32),sourceRevision:'b'.repeat(40),expiresAt:new Date(now+1800000).toISOString(),region:'cn-hangzhou',roleArn:'acs:ram::111122223333:role/fixture-deploy',providerArn:'acs:ram::111122223333:oidc-provider/fixture',functionName:'fixture-control',certificate};
const plan=domainBindingPlan(input,now);
function fixture(options={}){
 let state=options.existing?{domainName:'unrelated'}:null,checkpoint,calls=[];
 const adapter={
  preflight:async()=>({defaultBoundaryVerified:true,publicApplicationEnabled:false,sameSignedTriggerPresent:true,functionUnchanged:true,budgetVerified:true,dnsExact:true,...options.preflight}),
  get:async()=>{calls.push('GET');return options.readDenied?{status:403,code:'AccessDenied'}:state?{status:200,value:structuredClone(state)}:{status:404,code:'DomainNameNotFound'};},
  create:async body=>{assert.equal(checkpoint.phase,'CREATE_REQUESTED');calls.push('CREATE');if(options.rejectedCreate)return options.rejectedCreate;state={...structuredClone(body),accountId:plan.target.account};if(options.unknownCreate)throw Error('SYNTHETIC_PRIVATE_EXCEPTION');return{status:200};},
  delete:async()=>{calls.push('DELETE');if(!options.deleteUnapplied)state=null;if(options.unknownDelete||options.deleteUnapplied)throw Error('SYNTHETIC_PRIVATE_EXCEPTION');},
  verifyDomain:async limit=>{calls.push('VERIFY');assert.equal(limit,options.expectedLimit??20);if(options.drift)state.routeConfig.routes[0].functionName='foreign';return{tlsVerified:true,boundaryVerified:true,privateOperationExposed:false,requests:options.expectedRequests??14,...options.verification};},
 };
 const storage={load:async()=>checkpoint,save:async value=>{checkpoint=structuredClone(value);},now:()=>now};
 return{adapter,storage,calls,state:()=>state,checkpoint:()=>checkpoint};
}

test('binding plan has fixed HTTPS signed routes, exact rollback scope and no certificate material',()=>{
 assert.equal(plan.desired.authConfig.authType,'function');assert.equal(plan.desired.protocol,'HTTPS');assert.equal(plan.publicApplicationEnabled,false);
 assert.deepEqual(plan.desired.routeConfig.routes.map(r=>r.path),['/','/v2/*','/api/v2/*']);
 assert(plan.desired.routeConfig.routes.every(r=>r.functionName==='fixture-control'&&r.qualifier==='LATEST'));
 assert.equal(plan.dns.type,'CNAME');assert.equal(plan.limits.newBusinessDnsRecords,1);
 const statements=domainTemporaryStatements(plan);
 assert.equal(statements[1].Resource,'acs:fc:cn-hangzhou:111122223333:custom-domains/shuduoai.cn');
 assert.deepEqual(statements[1].Action,['fc:DeleteCustomDomain']);
 assert(!statements[0].Action.includes('fc:UpdateCustomDomain'));assert(!JSON.stringify(plan).includes('PRIVATE KEY'));
 assert(statements.every(s=>s.Condition.DateLessThan['acs:CurrentTime']===input.expiresAt));
});
test('TLS configuration sends an explicit strong allowlist and rejects missing or broadened readback',async()=>{
 assert.deepEqual(plan.desired.tlsConfig.cipherSuites,DOMAIN_TLS_CIPHER_SUITES);
 assert.equal(new Set(DOMAIN_TLS_CIPHER_SUITES).size,4);
 assert(DOMAIN_TLS_CIPHER_SUITES.every(s=>/^TLS_ECDHE_(RSA|ECDSA)_WITH_AES_(128_GCM_SHA256|256_GCM_SHA384)$/.test(s)));
 assert.equal(plan.desired.tlsConfig.minVersion,'TLSv1.2');assert.equal(plan.desired.tlsConfig.maxVersion,'TLSv1.3');
 const f=fixture();await runDomainBinding(plan,material,f.adapter,f.storage);
 const reordered=structuredClone(f.state());reordered.tlsConfig.cipherSuites.reverse();assert.equal(domainConfigurationMatches(reordered,plan),true);
 for(const suites of [undefined,[],['TLS_RSA_WITH_RC4_128_SHA'],[...DOMAIN_TLS_CIPHER_SUITES,'TLS_RSA_WITH_AES_128_CBC_SHA'],[...DOMAIN_TLS_CIPHER_SUITES,'TLS_AES_128_GCM_SHA256'],[...DOMAIN_TLS_CIPHER_SUITES,'TLS_AES_256_GCM_SHA384'],[...DOMAIN_TLS_CIPHER_SUITES,DOMAIN_TLS_CIPHER_SUITES[0]],DOMAIN_TLS_CIPHER_SUITES.slice(1)]){
  const changed=structuredClone(f.state());changed.tlsConfig.cipherSuites=suites;assert.equal(domainConfigurationMatches(changed,plan),false);
 }
 const changed=structuredClone(f.state());changed.tlsConfig.minVersion='TLSv1.1';assert.equal(domainConfigurationMatches(changed,plan),false);
});
test('server-added same-account route metadata and null rewrites do not hide real drift',async()=>{
 const f=fixture();await runDomainBinding(plan,material,f.adapter,f.storage);
 const returned=structuredClone(f.state());returned.routeConfig.routes.forEach(r=>{r.accountId=plan.target.account;r.rewriteConfig=null;});
 assert.equal(domainConfigurationMatches(returned,plan),true);
 for(const change of [r=>r.accountId='999900001111',r=>r.accountId=null,r=>r.rewriteConfig={},r=>r.rewriteConfig={equalRules:[{match:'/',replacement:'/invoke'}]},r=>r.unknown=true,r=>r.functionName='foreign',r=>r.methods.push('DELETE'),r=>r.qualifier='foreign']){
  const changed=structuredClone(returned);change(changed.routeConfig.routes[0]);assert.equal(domainConfigurationMatches(changed,plan),false);
 }
 const extra=structuredClone(returned);extra.routeConfig.rewriteConfig=null;assert.equal(domainConfigurationMatches(extra,plan),false);
 const recovery=fixture({verification:{tlsVerified:false}}),get=recovery.adapter.get;
 recovery.adapter.get=async()=>{const value=await get();value.value?.routeConfig?.routes.forEach(r=>{r.accountId=plan.target.account;r.rewriteConfig=null;});return value;};
 const r=await runDomainBinding(plan,material,recovery.adapter,recovery.storage);assert.equal(r.passed,false);assert.equal(r.rollback.domainAbsent,true);assert.equal(recovery.calls.filter(v=>v==='DELETE').length,1);
});
test('FC configurable cipher allowlist matches the pinned official ITLSConfig schema without downgrading TLS',()=>{
 // Offline, synthetic projection of the public enum at the documented commit;
 // this checks API configuration, not a live handshake or cloud acceptance.
 const officialEnum=new Set([
  'TLS_RSA_WITH_RC4_128_SHA','TLS_RSA_WITH_3DES_EDE_CBC_SHA','TLS_RSA_WITH_AES_128_CBC_SHA','TLS_RSA_WITH_AES_256_CBC_SHA','TLS_RSA_WITH_AES_128_CBC_SHA256','TLS_RSA_WITH_AES_128_GCM_SHA256','TLS_RSA_WITH_AES_256_GCM_SHA384',
  'TLS_ECDHE_ECDSA_WITH_RC4_128_SHA','TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA','TLS_ECDHE_ECDSA_WITH_AES_256_CBC_SHA','TLS_ECDHE_RSA_WITH_RC4_128_SHA','TLS_ECDHE_RSA_WITH_3DES_EDE_CBC_SHA','TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA','TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA',
  'TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA256','TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA256','TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256','TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256','TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384','TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384','TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305','TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305',
 ]);
 assert(DOMAIN_TLS_CIPHER_SUITES.every(v=>officialEnum.has(v)));
 for(const value of ['TLS_AES_128_GCM_SHA256','TLS_AES_256_GCM_SHA384'])assert.equal(officialEnum.has(value),false);
 assert.equal(plan.desired.tlsConfig.maxVersion,'TLSv1.3');assert.equal(plan.desired.authConfig.authType,'function');assert.equal(plan.publicApplicationEnabled,false);
});
test('rejected create retains only bounded diagnostic fields and does not retry a write',async()=>{
 const f=fixture({rejectedCreate:{status:400,code:'InvalidArgument',category:'INVALID_CIPHER_SUITES',message:'DO_NOT_EXPORT',body:material}});
 const r=await runDomainBinding(plan,material,f.adapter,f.storage);
 assert.equal(r.failure,'DOMAIN_CREATE_REJECTED');assert.deepEqual(r.createResponse,{status:400,code:'InvalidArgument',category:'INVALID_CIPHER_SUITES'});
 assert.equal(r.rollback.domainAbsent,true);assert.equal(f.calls.filter(v=>v==='CREATE').length,1);assert(!f.calls.includes('VERIFY'));assert(!f.calls.includes('DELETE'));
 assert(!JSON.stringify(r).includes('DO_NOT_EXPORT'));assert(!JSON.stringify(r).includes('PRIVATE KEY'));
 const resumed=await runDomainBinding(plan,material,f.adapter,f.storage);assert.equal(resumed.recoveryOnly,true);assert.equal(f.calls.filter(v=>v==='CREATE').length,1);
 const invalid=fixture({rejectedCreate:{status:'400',code:'InvalidArgument\nDO_NOT_EXPORT',category:'DO_NOT_EXPORT'}});
 const bad=await runDomainBinding(plan,material,invalid.adapter,invalid.storage);assert.deepEqual(bad.createResponse,{status:0,code:'UNCONFIRMED',category:'UNCLASSIFIED'});assert.equal(bad.failure,'DOMAIN_CREATE_NOT_CONFIRMED');
});
test('plan rejects unapproved, other-domain, foreign identity and invalid lifetime inputs',()=>{
 for(const patch of [{authorization:'yes'},{domainName:'other.invalid'},{region:'cn-beijing'},{operationId:'../escape'},{sourceRevision:'main'},{expiresAt:new Date(now-1).toISOString()},{expiresAt:new Date(now+3600001).toISOString()},{providerArn:'acs:ram::999900001111:oidc-provider/fixture'},{certificate:{...certificate,domain:'other.invalid'}}])assert.throws(()=>domainBindingPlan({...input,...patch},now));
});
test('P0-B plan and configuration preserve historical usage and fixed cumulative limits',async()=>{
 const stage=domainBindingPlan({...input,authorization:P0B_SIGNED_ACCESS_AUTHORIZATION},now);
 assert.equal(stage.limits.historicalRequests,17);assert.equal(stage.limits.defaultNewRequests,15);assert.equal(stage.limits.domainProbes,8);assert.equal(stage.limits.allRequests,40);assert.equal(stage.limits.domainMetadataReads,10);assert.equal(stage.limits.reservedCny,2);
 const f=fixture({expectedLimit:8,expectedRequests:8});assert.equal((await runDomainBinding(stage,material,f.adapter,f.storage)).passed,true);
 const excess=fixture({expectedLimit:8,expectedRequests:9});assert.equal((await runDomainBinding(stage,material,excess.adapter,excess.storage)).passed,false);assert.equal(excess.state(),null);
 const changed=fixture();assert.equal((await runDomainBinding({...stage,limits:{...stage.limits,domainProbes:20}},material,changed.adapter,changed.storage)).failure,'DOMAIN_PROBE_SCOPE_CHANGED');assert.equal(changed.calls.length,0);
 const body={...input,...material,expiresAt:input.expiresAt.replace(/\.\d{3}Z$/,'Z'),priorRequests:17,restoreRunId:'98765',priorControlRunId:'12345678',priorControlAcceptanceDigest:'d'.repeat(64),expectedChecksum:'123456',authorizedAt:new Date(now).toISOString().replace(/\.\d{3}Z$/,'Z')};
 const env={GITHUB_ACTIONS:'true',GITHUB_REF:'refs/heads/main',GITHUB_RUN_ID:'12345679',GITHUB_SHA:input.sourceRevision,V2_HTTPS_SOURCE_SHA:input.sourceRevision,V2_HTTPS_AUTHORIZATION:P0B_SIGNED_ACCESS_AUTHORIZATION,V2_HTTPS_BINDING_INPUT:JSON.stringify(body)};
 const parsed=httpsConfig(env,now);assert.equal(parsed.config.previousReads,17);assert.equal(parsed.config.maxRequests,32);assert.equal(parsed.plan.limits.domainProbes,8);
 for(const patch of [{priorRequests:0},{priorRequests:5},{priorControlRunId:''},{priorControlAcceptanceDigest:''}])assert.throws(()=>httpsConfig({...env,V2_HTTPS_BINDING_INPUT:JSON.stringify({...body,...patch})},now));
 assert.throws(()=>httpsConfig({...env,V2_HTTPS_AUTHORIZATION:DOMAIN_BINDING_AUTHORIZATION},now));
});
test('resume uses a distinct authorization, complete predecessor references and a fixed 55-call cap',async()=>{
 const stage=domainBindingPlan({...input,authorization:P0B_SIGNED_RESUME_AUTHORIZATION},now);
 assert.equal(stage.limits.historicalRequests,32);assert.equal(stage.limits.allRequests,55);assert.equal(stage.limits.domainProbes,8);assert.equal(stage.limits.newDomainCreates,1);
 assert.equal(signedAccessLimits('P0B_SIGNED_HTTPS_RESUME_AGAIN'),undefined);
 const f=fixture({expectedLimit:8,expectedRequests:8});assert.equal((await runDomainBinding(stage,material,f.adapter,f.storage)).passed,true);
 const body={...input,...material,priorRequests:32,restoreRunId:'98765',priorControlRunId:'12345678',priorControlAcceptanceDigest:'d'.repeat(64),priorHttpsRunId:'12345679',priorHttpsAcceptanceDigest:'e'.repeat(64),priorFunctionHash:'f'.repeat(64),priorOriginalTriggersHash:'a'.repeat(64),expectedChecksum:'123456',authorizedAt:new Date(now).toISOString().replace(/\.\d{3}Z$/,'Z'),expiresAt:input.expiresAt.replace(/\.\d{3}Z$/,'Z')};
 const env={GITHUB_ACTIONS:'true',GITHUB_REF:'refs/heads/main',GITHUB_RUN_ID:'12345680',GITHUB_SHA:input.sourceRevision,V2_HTTPS_SOURCE_SHA:input.sourceRevision,V2_HTTPS_AUTHORIZATION:P0B_SIGNED_RESUME_AUTHORIZATION,V2_HTTPS_BINDING_INPUT:JSON.stringify(body)};
 const c=httpsConfig(env,now);assert.equal(c.config.previousReads,32);assert.equal(c.config.maxRequests,47);assert.equal(c.config.priorFunctionHash,body.priorFunctionHash);
 for(const patch of [{priorRequests:17},{priorHttpsRunId:''},{priorHttpsRunId:env.GITHUB_RUN_ID},{priorHttpsAcceptanceDigest:''},{priorFunctionHash:''},{priorOriginalTriggersHash:''}])assert.throws(()=>httpsConfig({...env,V2_HTTPS_BINDING_INPUT:JSON.stringify({...body,...patch})},now));
 for(const authorization of [DOMAIN_BINDING_AUTHORIZATION,P0B_SIGNED_ACCESS_AUTHORIZATION])assert.throws(()=>httpsConfig({...env,V2_HTTPS_AUTHORIZATION:authorization},now));
});
test('domain-only scope carries forty-seven calls and permits only eight new domain checks',async()=>{
 const stage=domainBindingPlan({...input,authorization:P0B_DOMAIN_REMAINING_AUTHORIZATION},now);
 assert.equal(stage.limits.historicalRequests,47);assert.equal(stage.limits.defaultNewRequests,0);assert.equal(stage.limits.allRequests,55);assert.equal(stage.limits.domainProbes,8);
 const f=fixture({expectedLimit:8,expectedRequests:8});assert.equal((await runDomainBinding(stage,material,f.adapter,f.storage)).passed,true);
 const body={...input,...material,priorRequests:47,restoreRunId:'98765',priorControlRunId:'12345678',priorControlAcceptanceDigest:'d'.repeat(64),priorHttpsRunId:'12345679',priorHttpsAcceptanceDigest:'e'.repeat(64),priorFunctionHash:'f'.repeat(64),priorOriginalTriggersHash:'a'.repeat(64),expectedChecksum:'123456',authorizedAt:new Date(now).toISOString().replace(/\.\d{3}Z$/,'Z'),expiresAt:input.expiresAt.replace(/\.\d{3}Z$/,'Z')};
 const env={GITHUB_ACTIONS:'true',GITHUB_REF:'refs/heads/main',GITHUB_RUN_ID:'12345680',GITHUB_SHA:input.sourceRevision,V2_HTTPS_SOURCE_SHA:input.sourceRevision,V2_HTTPS_AUTHORIZATION:P0B_DOMAIN_REMAINING_AUTHORIZATION,V2_HTTPS_BINDING_INPUT:JSON.stringify(body)};
 const c=httpsConfig(env,now);assert.equal(c.config.previousReads,47);assert.equal(c.config.maxRequests,47);assert.equal(c.config.priorHttpsRunId,body.priorHttpsRunId);assert.equal(c.config.priorHttpsAcceptanceDigest,body.priorHttpsAcceptanceDigest);
 for(const authorization of [DOMAIN_BINDING_AUTHORIZATION,P0B_SIGNED_ACCESS_AUTHORIZATION,P0B_SIGNED_RESUME_AUTHORIZATION])assert.throws(()=>httpsConfig({...env,V2_HTTPS_AUTHORIZATION:authorization},now));
 for(const patch of [{priorRequests:32},{priorRequests:0},{priorHttpsRunId:''},{priorHttpsAcceptanceDigest:''}])assert.throws(()=>httpsConfig({...env,V2_HTTPS_BINDING_INPUT:JSON.stringify({...body,...patch})},now));
 const recovery={originalRunId:'12345679',originalEvidenceDigest:'a'.repeat(64),expectedDesiredHash:stage.desiredHash,checkpoint:{operationId:stage.operationId,desiredHash:stage.desiredHash,domainName:'shuduoai.cn',baselineAbsent:true,phase:'CREATE_REQUESTED'},counts:{get:5,create:1,delete:0}};
 for(const mode of ['INSPECT_EXISTING','ROLLBACK_EXISTING']){
  const recoveryEnv={...env,V2_HTTPS_RECOVERY_MODE:mode,V2_HTTPS_BINDING_INPUT:JSON.stringify({...body,recovery})};assert.equal(httpsConfig(recoveryEnv,now).recoveryMode,mode);
  for(const change of [v=>v.checkpoint.operationId='b'.repeat(32),v=>v.checkpoint.baselineAbsent=false,v=>v.expectedDesiredHash='c'.repeat(64),v=>v.counts.get=10,v=>v.counts.create=0,v=>v.counts.delete=1,v=>v.originalEvidenceDigest='',v=>v.originalRunId=env.GITHUB_RUN_ID]){const bad=structuredClone(recovery);change(bad);assert.throws(()=>httpsConfig({...recoveryEnv,V2_HTTPS_BINDING_INPUT:JSON.stringify({...body,recovery:bad})},now));}
 }
 assert.throws(()=>httpsConfig({...env,V2_HTTPS_RECOVERY_MODE:'CREATE_AGAIN'},now));
});
test('authenticated predecessor must prove exact usage, same target and completed rollback',()=>{
 const expected={operationId:'a'.repeat(32),desiredHash:'b'.repeat(64),httpTargetHash:'c'.repeat(64),triggerName:'shuduo-http-boundary-98765'};
 const prior={scope:'SIGNED_HTTPS_DOMAIN_BINDING',passed:false,operationId:expected.operationId,targetHash:expected.desiredHash,
  boundary:{passed:true,priorRequests:17,requests:32,newRequests:15,modelCalls:0,sparkRuns:0,publicApplicationEnabled:false,cleanup:{deferredForSameDomainBatch:true},results:Array.from({length:14},(_,id)=>({id:String(id)}))},
  httpCheckpoint:{targetHash:expected.httpTargetHash,triggerName:expected.triggerName,requests:32,functionHash:'d'.repeat(64),originalTriggersHash:'e'.repeat(64)},
  requestBudget:{historical:17,defaultNewLimit:15,domainNewLimit:8,cumulativeLimit:40},domainRequests:0,cumulativeRequests:32,
  domain:{passed:false,createRequests:1,failure:'DOMAIN_CREATE_NOT_CONFIRMED',modelCalls:0,sparkRuns:0,publicApplicationEnabled:false,rollback:{domainAbsent:true,deleted:false},probes:[]},
  domainCheckpoint:{phase:'ROLLED_BACK',baselineAbsent:true,operationId:expected.operationId,desiredHash:expected.desiredHash,domainName:'shuduoai.cn'},
  cleanup:{triggerAbsent:true,originalTriggersUnchanged:true,functionUnchanged:true,domainRollback:{domainAbsent:true,deleted:false}},domainApiCounts:{get:4,create:1,delete:0}};
 assert.deepEqual(verifySignedHttpsResume(prior,expected),{priorRequests:32,priorFunctionHash:'d'.repeat(64),priorOriginalTriggersHash:'e'.repeat(64)});
 for(const change of [v=>v.passed=true,v=>v.targetHash='f'.repeat(64),v=>v.boundary.priorRequests=0,v=>v.boundary.newRequests=14,v=>v.boundary.modelCalls=1,v=>v.boundary.results.pop(),v=>v.httpCheckpoint.triggerName='foreign',v=>v.httpCheckpoint.requests=31,v=>v.domainRequests=1,v=>v.cumulativeRequests=0,v=>v.requestBudget.cumulativeLimit=55,v=>v.domain.failure='OTHER',v=>v.domain.probes.push({}),v=>v.domainCheckpoint.phase='CREATED_VERIFIED',v=>v.cleanup.triggerAbsent=false,v=>v.cleanup.functionUnchanged=false,v=>v.cleanup.domainRollback.domainAbsent=false,v=>v.domainApiCounts.create=2,v=>v.domainApiCounts.get=11]){
  const bad=structuredClone(prior);change(bad);assert.throws(()=>verifySignedHttpsResume(bad,expected));
 }
 assert.throws(()=>verifySignedHttpsResume(prior,{}));
 const latest=structuredClone(prior);
 Object.assign(latest.boundary,{priorRequests:32,requests:47});latest.httpCheckpoint.requests=47;latest.cumulativeRequests=47;Object.assign(latest.requestBudget,{historical:32,cumulativeLimit:55});Object.assign(latest.domain,{failure:'DOMAIN_CREATE_REJECTED',createResponse:{status:400,code:'InvalidArgument',category:'INVALID_CIPHER_SUITES'}});
 assert.equal(verifySignedHttpsResume(latest,expected,P0B_DOMAIN_REMAINING_AUTHORIZATION).priorRequests,47);
 assert.throws(()=>verifySignedHttpsResume(latest,expected));assert.throws(()=>verifySignedHttpsResume(prior,expected,P0B_DOMAIN_REMAINING_AUTHORIZATION));assert.throws(()=>verifySignedHttpsResume(latest,expected,'UNAPPROVED'));
 for(const change of [v=>v.domain.createResponse.category='OTHER',v=>v.domain.createResponse.status=200,v=>v.domain.failure='DOMAIN_CREATE_NOT_CONFIRMED',v=>v.boundary.newRequests=0,v=>v.requestBudget.defaultNewLimit=0,v=>v.cleanup.domainRollback.domainAbsent=false]){const bad=structuredClone(latest);change(bad);assert.throws(()=>verifySignedHttpsResume(bad,expected,P0B_DOMAIN_REMAINING_AUTHORIZATION));}
});
test('certificate verification checks domain, expiry, size and matching private key without logging raw errors',()=>{
 assert.equal(certificate.domain,'shuduoai.cn');assert.match(certificate.leafSha256,/^[a-f0-9]{64}$/);
 const wrong=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs1',format:'pem'});
 assert.throws(()=>verifyCertificateMaterial({...material,privateKey:wrong},now),/CERTIFICATE_KEY_MISMATCH/);
 assert.throws(()=>verifyCertificateMaterial(material,Date.parse(certificate.validTo)),/CERTIFICATE_NOT_CURRENT/);
 assert.throws(()=>verifyCertificateMaterial({...material,certificate:'x'.repeat(20481)},now),/CERTIFICATE_SIZE_INVALID/);
 assert.throws(()=>verifyCertificateMaterial({certificate:'PRIVATE_SECRET',privateKey:'PRIVATE_SECRET'},now),/CERTIFICATE_MATERIAL_INVALID/);
});
test('known success retains one signed binding and exposes only sanitized evidence',async()=>{
 const f=fixture(),report=await runDomainBinding(plan,material,f.adapter,f.storage);
 assert.equal(report.passed,true);assert.equal(report.createRequests,1);assert.equal(report.domainRequests,14);assert.equal(report.domainRetained,true);
 assert.equal(f.checkpoint().phase,'VERIFIED_RETAINED');assert.equal(f.calls.filter(v=>v==='CREATE').length,1);assert(!f.calls.includes('DELETE'));
 assert(!JSON.stringify([report,f.checkpoint()]).includes('PRIVATE KEY'));
 const before=f.calls.length,resumed=await runDomainBinding(plan,material,f.adapter,f.storage);
 assert.equal(resumed.recoveryOnly,true);assert.equal(resumed.retainedPreviously,true);assert.equal(resumed.passed,false);assert.deepEqual(f.calls.slice(before),['GET']);
});
test('read denial, existing configuration and missing preconditions never create or delete',async()=>{
 for(const options of [{existing:true},{readDenied:true},...['defaultBoundaryVerified','sameSignedTriggerPresent','functionUnchanged','budgetVerified','dnsExact'].map(k=>({preflight:{[k]:false}})),{preflight:{publicApplicationEnabled:true}}]){
  const f=fixture(options),report=await runDomainBinding(plan,material,f.adapter,f.storage);
  assert.equal(report.passed,false);assert.equal(report.createRequests,0);assert(!f.calls.includes('CREATE'));assert(!f.calls.includes('DELETE'));
 }
});
test('lost create receipt is reconciled without a second create',async()=>{
 const f=fixture({unknownCreate:true}),report=await runDomainBinding(plan,material,f.adapter,f.storage);
 assert.equal(report.passed,true);assert.equal(f.calls.filter(v=>v==='CREATE').length,1);assert.equal(f.checkpoint().createResponseUnknown,true);
 assert(!JSON.stringify(report).includes('SYNTHETIC_PRIVATE_EXCEPTION'));
});
test('TLS, boundary, leak and probe-budget failures roll back only the created binding',async()=>{
 for(const verification of [{tlsVerified:false},{boundaryVerified:false},{privateOperationExposed:true},{requests:21},{requests:0}]){
  const f=fixture({verification}),report=await runDomainBinding(plan,material,f.adapter,f.storage);
  assert.equal(report.passed,false);assert.equal(report.rollback.domainAbsent,true);assert.equal(f.calls.filter(v=>v==='DELETE').length,1);assert.equal(f.state(),null);
 }
});
test('unknown delete is read back; an unapplied deletion is not blindly retried on resume',async()=>{
 const ok=fixture({verification:{tlsVerified:false},unknownDelete:true}),report=await runDomainBinding(plan,material,ok.adapter,ok.storage);
 assert.equal(report.rollback.domainAbsent,true);
 const bad=fixture({verification:{tlsVerified:false},deleteUnapplied:true}),first=await runDomainBinding(plan,material,bad.adapter,bad.storage);
 assert.equal(first.cleanupFailure,'DOMAIN_ROLLBACK_NOT_CONFIRMED');
 const next=await runDomainBinding(plan,material,bad.adapter,bad.storage);
 assert.equal(next.recoveryOnly,true);assert.equal(bad.calls.filter(v=>v==='DELETE').length,1);assert.equal(bad.calls.filter(v=>v==='CREATE').length,1);
});
test('ownership, route, certificate and authentication drift cannot be silently deleted',async()=>{
 const f=fixture({drift:true}),report=await runDomainBinding(plan,material,f.adapter,f.storage);
 assert.equal(report.passed,false);assert.equal(report.cleanupFailure,'DOMAIN_DRIFT_DO_NOT_DELETE');assert(!f.calls.includes('DELETE'));
 const good=fixture();await runDomainBinding(plan,material,good.adapter,good.storage);
 for(const change of [v=>v.accountId='999900001111',v=>v.authConfig.authType='anonymous',v=>v.protocol='HTTP,HTTPS',v=>v.certConfig.certName='another-owner',v=>v.certConfig.certificate='invalid',v=>v.routeConfig.routes.push({path:'/*'}),v=>v.corsConfig={allowOrigins:['*']},v=>v.wafConfig={enableWAF:true}]){
  const value=structuredClone(good.state());change(value);assert.equal(domainConfigurationMatches(value,plan),false);
 }
 good.state().authConfig.authType='anonymous';const resumed=await runDomainBinding(plan,material,good.adapter,good.storage);
 assert.equal(resumed.failure,'RETAINED_DOMAIN_NOT_CONFIRMED');assert(!good.calls.includes('DELETE'));
});
test('durable checkpoint and remaining cleanup window are required before mutation',async()=>{
 const f=fixture();await assert.rejects(runDomainBinding(plan,material,f.adapter,{}),/DOMAIN_DURABLE_CHECKPOINT_REQUIRED/);
 const report=await runDomainBinding(plan,material,f.adapter,{...f.storage,now:()=>Date.parse(plan.expiresAt)-299999});
 assert.equal(report.failure,'DOMAIN_WINDOW_TOO_SHORT');assert.equal(report.createRequests,0);
 const lost=fixture(),failed=await runDomainBinding(plan,material,lost.adapter,{...lost.storage,save:async()=>{throw Error('disk unavailable');}});
 assert.equal(failed.passed,false);assert.equal(failed.createRequests,0);assert(!lost.calls.includes('CREATE'));
});
