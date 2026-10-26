import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync,statSync,mkdirSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {generateKeyPairSync,createHash,privateDecrypt,createDecipheriv,constants} from 'node:crypto';
import {openingWorkflowInput,openingWorkflowStore,workflowOpeningUsage,openingWorkflowMain} from '../../scripts/invited-opening-workflow.mjs';
import {createOpeningUsage} from '../../scripts/invited-opening-usage.mjs';
import {READONLY_ENTRY_SCOPE} from '../../scripts/invited-readonly-entry.mjs';
import {INVITED_READONLY_CODE_SCOPE} from '../../scripts/control-code-update.mjs';
import {READONLY_FILING_SCOPE,INVITED_READONLY_FILING_CODE_SCOPE,READONLY_RUNTIME_SCOPE,INVITED_READONLY_RUNTIME_CODE_SCOPE} from '../../scripts/invited-opening-scopes.mjs';
const now=Date.UTC(2026,9,26),hash=b=>createHash('sha256').update(b).digest('hex'),bytes=Buffer.from('fictional-new-package');
const key=generateKeyPairSync('rsa',{modulusLength:3072});
const publicKey=key.publicKey.export({type:'spki',format:'der'}).toString('base64');
function fixture(repair=false){
 const runtime=repair==='runtime';
 let seed;
 const config={authorization:INVITED_READONLY_CODE_SCOPE,operationId:'a'.repeat(32),applicationSource:'b'.repeat(40),operatorSource:'c'.repeat(40),account:'111122223333',role:'fixture-role',functionName:'fixture-control',bucket:'fixture-private',region:'cn-hangzhou',previousInvocations:55,expiresAt:new Date(now+3600000).toISOString(),previous:{sha256:'d'.repeat(64),bytes:4000,crc64:'123'},candidate:{sha256:hash(bytes),bytes:bytes.length}};
 const usage=createOpeningUsage({authorization:READONLY_ENTRY_SCOPE,operationId:config.operationId,operatorSource:config.operatorSource,issuedAt:now,expiresAt:now+3600000,load:()=>undefined,save:v=>{seed=v;},now:()=>now});
 for(let i=0;i<12;i++)usage.reserve('RAM_READ');
 const metadata={config,authorizedAt:new Date(now).toISOString(),roleArn:`acs:ram::${config.account}:role/${config.role}`,providerArn:`acs:ram::${config.account}:oidc-provider/fixture`,buildRunId:'12345678',artifactId:'12345679',objectAclReadApproved:true,unsettledReservedCny:12,bucketPrivacy:{bucketHash:hash(config.bucket),aclPrivate:true,policyNotPublic:true,publicAccessBlocked:true,checkedAt:new Date(now).toISOString()},retainedPlan:{target:{domainName:'shuduoai.cn',account:config.account,role:config.role,functionName:config.functionName,region:config.region}},webIndexSha256:'e'.repeat(64),openingUsage:seed,publicSite:{icpNumber:'测试备案号',registeredName:'虚构站点'}};
 metadata.recipientKeySha256=hash(Buffer.from(publicKey,'base64'));
 if(repair){
  config.authorization=runtime?INVITED_READONLY_RUNTIME_CODE_SCOPE:INVITED_READONLY_FILING_CODE_SCOPE;config.previousInvocations=runtime?69:61;
  metadata.openingUsage={...metadata.openingUsage,authorization:runtime?READONLY_RUNTIME_SCOPE:READONLY_FILING_SCOPE,historicalRequests:runtime?69:61,historicalConfigurationReads:runtime?131:58};
  metadata.priorOpening={runId:'12345677',sourceRevision:'f'.repeat(40),sealedSha256:'e'.repeat(64),configurationReads:runtime?131:58,cumulativeRequests:runtime?69:61,codeRestored:true,permissionRevoked:true,secretRemoved:true,...(runtime?{entryRestored:true}:{})};
 }
 const env={GITHUB_ACTIONS:'true',GITHUB_REF:'refs/heads/main',GITHUB_SHA:config.operatorSource,GITHUB_RUN_ID:'12345680',GITHUB_RUN_ATTEMPT:'1',V2_READONLY_OPENING_APPROVED:runtime?READONLY_RUNTIME_SCOPE:repair?READONLY_FILING_SCOPE:READONLY_ENTRY_SCOPE,V2_OPENING_OPERATOR_SHA:config.operatorSource,V2_AUDIT_RECIPIENT_KEY:publicKey,V2_INVITED_OPENING_TARGET:JSON.stringify(metadata)};
 return{config,metadata,env};
}
test('runtime scope requires the completed entry rollback and cannot reuse the filing grant history',()=>{
 const f=fixture('runtime');assert.equal(openingWorkflowInput(f.env,now).config.previousInvocations,69);
 for(const mutate of [m=>m.priorOpening.entryRestored=false,m=>m.priorOpening.configurationReads=58,m=>m.openingUsage.historicalRequests=61,m=>m.openingUsage.historicalConfigurationReads=58]){
  const metadata=structuredClone(f.metadata);mutate(metadata);assert.throws(()=>openingWorkflowInput({...f.env,V2_INVITED_OPENING_TARGET:JSON.stringify(metadata)},now));
 }
});
test('authorized runtime continuation binds all counters to completed predecessor evidence',()=>{
 const f=fixture('runtime'),history={historicalRequests:83,historicalConfigurationReads:210};
 f.metadata.config.history=history;f.metadata.config.previousInvocations=history.historicalRequests;
 Object.assign(f.metadata.openingUsage,history);
 Object.assign(f.metadata.priorOpening,{configurationReads:history.historicalConfigurationReads,cumulativeRequests:history.historicalRequests});
 const input=()=>openingWorkflowInput({...f.env,V2_INVITED_OPENING_TARGET:JSON.stringify(f.metadata)},now);
 assert.deepEqual(input().config.history,history);
 let cp;const usage=createOpeningUsage({authorization:READONLY_RUNTIME_SCOPE,history,operationId:f.config.operationId,operatorSource:f.config.operatorSource,issuedAt:now,expiresAt:now+3600000,load:()=>cp,save:v=>{cp=v},now:()=>now});
 usage.reserve('PRIVATE_PROBE');usage.reserve('FC_READ');
 assert.equal(usage.counts().cumulativeRequests,84);assert.equal(usage.counts().cumulativeConfigurationReads,211);
 f.metadata.priorOpening.cumulativeRequests--;assert.throws(input,/PRIOR_CLEANUP/);
 f.metadata.priorOpening.cumulativeRequests++;
 f.metadata.openingUsage.historicalRequests--;assert.throws(input,/CHECKPOINT_MISMATCH/);
 for(const invalid of [{...history,historicalRequests:-1},{...history,historicalRequests:1.5},{...history,historicalConfigurationReads:0},{...history,extra:1}])
  assert.throws(()=>createOpeningUsage({authorization:READONLY_RUNTIME_SCOPE,history:invalid}),/CONTINUATION_HISTORY/);
 assert.throws(()=>createOpeningUsage({authorization:READONLY_FILING_SCOPE,history}),/CONTINUATION_HISTORY/);
});
test('filing repair input requires new scope, preserved history and original rollback/cleanup evidence',()=>{
 const f=fixture(true);assert.equal(openingWorkflowInput(f.env,now).config.previousInvocations,61);
 for(const mutate of [m=>m.priorOpening.codeRestored=false,m=>m.priorOpening.configurationReads=0,m=>m.openingUsage.historicalConfigurationReads=0,m=>m.config.previousInvocations=55,m=>m.publicSite.OTHER='not-approved']){
  const m=structuredClone(f.metadata);mutate(m);assert.throws(()=>openingWorkflowInput({...f.env,V2_INVITED_OPENING_TARGET:JSON.stringify(m)},now));
 }
 const old=fixture();assert.throws(()=>openingWorkflowInput({...old.env,V2_READONLY_OPENING_APPROVED:READONLY_FILING_SCOPE},now));
});
test('workflow requires new scope, protected source, original single run and a bounded owner ledger',()=>{
 const f=fixture();assert.equal(openingWorkflowInput(f.env,now).config.authorization,INVITED_READONLY_CODE_SCOPE);
 for(const patch of [{GITHUB_REF:'refs/heads/feature'},{GITHUB_RUN_ATTEMPT:'2'},{V2_READONLY_OPENING_APPROVED:'yes'},{V2_OPENING_OPERATOR_SHA:'f'.repeat(40)}])assert.throws(()=>openingWorkflowInput({...f.env,...patch},now));
 for(const mutate of [m=>m.openingUsage.usage.RAM_READ=17,m=>m.openingUsage.usage.HTTP_PROBE=1,m=>m.openingUsage.operationId='f'.repeat(32),m=>m.retainedPlan.target.account='999900001111',m=>m.recipientKeySha256='f'.repeat(64)]){
  const metadata=structuredClone(f.metadata);mutate(metadata);assert.throws(()=>openingWorkflowInput({...f.env,V2_INVITED_OPENING_TARGET:JSON.stringify(metadata)},now));
 }
 assert.throws(()=>openingWorkflowInput(f.env,now+3600001));
 assert.equal(openingWorkflowInput(f.env,now+3600001,true).config.operationId,f.config.operationId,'expired evidence can still be sealed without a cloud call');
 const late={...f.metadata,bucketPrivacy:{...f.metadata.bucketPrivacy,checkedAt:new Date(now+120000).toISOString()}};
 assert.equal(openingWorkflowInput({...f.env,V2_INVITED_OPENING_TARGET:JSON.stringify(late)},now+3600001,true).config.operationId,f.config.operationId);
});
test('durable workflow store is private, rejects symlinks and never overwrites an ambiguous pending save',()=>{
 const directory=mkdtempSync(join(tmpdir(),'opening-store-'));
 try{
  const store=openingWorkflowStore(directory);store.save('usage',{value:1});assert.equal(store.load('usage').value,1);assert.equal(statSync(join(directory,'usage.json')).mode&0o077,0);
  writeFileSync(join(directory,'usage.json.next'),'unknown',{mode:0o600});assert.throws(()=>store.save('usage',{value:2}));assert.equal(store.load('usage').value,1);
  assert.throws(()=>store.load('../outside'));symlinkSync(join(directory,'usage.json'),join(directory,'stage.json'));assert.throws(()=>store.load('stage'),/NOT_PRIVATE/);
  const broad=join(directory,'broad');mkdirSync(broad,{mode:0o755});assert.throws(()=>openingWorkflowStore(broad),/NOT_PRIVATE/);
 }finally{rmSync(directory,{recursive:true,force:true});}
});
test('workflow preserves 15 cloud rollback reads and 12 owner revocation reads within the same 80',()=>{
 const f=fixture();let cp=f.metadata.openingUsage;
 const usage=createOpeningUsage({authorization:READONLY_ENTRY_SCOPE,operationId:f.config.operationId,operatorSource:f.config.operatorSource,issuedAt:now,expiresAt:now+3600000,load:()=>cp,save:v=>{cp=v;},now:()=>now}),bounded=workflowOpeningUsage(usage);
 while(usage.counts().configurationReads<53)bounded.reserve('FC_READ');
 assert.throws(()=>bounded.reserve('DOMAIN_READ'),/OUTER_CLEANUP_RESERVE/);
 bounded.beginCleanup();for(let i=0;i<15;i++)bounded.reserve('FC_READ');
 assert.throws(()=>bounded.reserve('FC_READ'),/OUTER_CLEANUP_RESERVE/);
 for(let i=0;i<12;i++)usage.reserve('RAM_READ');
 assert.equal(usage.counts().configurationReads,80);assert.throws(()=>usage.reserve('RAM_READ'),/READ_LIMIT/);
});
test('workflow hands off frozen bytes and seals checkpoints for the original owner without plaintext leakage',async()=>{
 const f=fixture(),directory=mkdtempSync(join(tmpdir(),'opening-main-')),packagePath=join(directory,'candidate.zip'),sealedPath=join(directory,'sealed.json');
 const env={...f.env,GITHUB_ENV:join(directory,'github-env'),ALIBABA_CLOUD_ACCESS_KEY_ID:'fictional-id',ALIBABA_CLOUD_ACCESS_KEY_SECRET:'fictional-key',ALIBABA_CLOUD_SECURITY_TOKEN:'fictional-token'};
 const settings={directory,packagePath,sealedPath,now:()=>now,run:async(input,options)=>{
  assert(options.codeOptions.candidateBytes.equals(bytes));assert.equal(options.codeOptions.rollbackFromVerifiedObject,true);assert.equal(input.config.operationId,f.config.operationId);
  options.storage.save('stage',{fictionalSecret:'never-visible-in-envelope'});options.storage.save('code',{updateRequested:true,phase:'VERIFIED'});options.storage.save('entry',{phase:'VERIFIED'});
  return{executionPassed:true,externalCleanupRequired:true};
 }};
 try{
  writeFileSync(packagePath,bytes,{mode:0o600});await openingWorkflowMain(env,'--prepare',settings);
  assert.equal(openingWorkflowStore(directory).load('usage').usage.IDENTITY,1);
  await assert.rejects(openingWorkflowMain(env,'--prepare',settings),/ALREADY_RUN/);
  await openingWorkflowMain(env,'--run',settings);await openingWorkflowMain(env,'--cleanup',{...settings,run:()=>{throw Error('accepted entry must not be restarted');}});
  await openingWorkflowMain(env,'--seal',{...settings,now:()=>now+3600001});
  const raw=readFileSync(sealedPath,'utf8');assert(!raw.includes('never-visible-in-envelope'));assert(!raw.includes('fictional-token'));
  const envelope=JSON.parse(raw),provenance=JSON.parse(envelope.aad);assert.equal(provenance.protocol,'shuduo-invited-opening/v1');assert.equal(provenance.runId,env.GITHUB_RUN_ID);
  const aes=privateDecrypt({key:key.privateKey,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},Buffer.from(envelope.wrappedKey,'base64'));
  const cipher=createDecipheriv('aes-256-gcm',aes,Buffer.from(envelope.iv,'base64'));cipher.setAAD(Buffer.from(envelope.aad));cipher.setAuthTag(Buffer.from(envelope.tag,'base64'));
  const plaintext=JSON.parse(Buffer.concat([cipher.update(Buffer.from(envelope.ciphertext,'base64')),cipher.final()]));aes.fill(0);
  assert.equal(plaintext.stage.fictionalSecret,'never-visible-in-envelope');assert.equal(plaintext.usage.usage.RAM_READ,12);
  await assert.rejects(openingWorkflowMain({...env,GITHUB_RUN_ID:'87654321'},'--cleanup',settings),/BINDING_CHANGED/);
 }finally{rmSync(directory,{recursive:true,force:true});}
});
test('workflow defaults to no authority and always seals cleanup evidence, without rebuilding or DNS changes',()=>{
 const yaml=readFileSync(new URL('../../.github/workflows/open-v2-invited-readonly.yml',import.meta.url),'utf8');
 for(const text of ['default: NOT_AUTHORIZED',"github.ref == 'refs/heads/main'",'environment: v2-staging','secrets.V2_INVITED_OPENING_TARGET','artifact-ids:','--cleanup','--seal','if: always()','v2-staging-control-mutation'])assert(yaml.includes(text));
 for(const text of ['build-v2-fc-package','CreateCustomDomain','DeleteCustomDomain','alidns','deploy-v2-w3','vars.','workflow_call'])assert(!yaml.includes(text));
});
