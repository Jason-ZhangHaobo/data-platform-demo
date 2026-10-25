import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DOMAIN_BINDING_AUTHORIZATION,domainBindingPlan,verifyCertificateMaterial} from '../../scripts/v2-domain-binding-plan.mjs';
import {prepareInvitedReadonlyConfig,verifyInvitedReadonlyConfig,readonlyEntryRollbackRequests} from '../../scripts/invited-readonly-config.mjs';
import {codeUpdateProbes,INVITED_READONLY_CODE_SCOPE} from '../../scripts/control-code-update.mjs';

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
 const privateCodeEvidence={report:{operationId:'c'.repeat(32),scope:'PRIVATE_CONTROL_CODE_ONLY',requestScope:INVITED_READONLY_CODE_SCOPE,passed:true,applicationSource:expectedCode.applicationSource,newInvocations:6,cumulativeInvocations:61,publicEnabled:false,modelCalls:0,sparkRuns:0},checkpoint:{operationId:'c'.repeat(32),phase:'VERIFIED',candidateSha:expectedCode.sha256,candidateReceipt:{sha256:expectedCode.sha256,bytes:4000,crc64:'123456'},probes:codeUpdateProbes.map(p=>({id:p.id,passed:true}))}};
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
