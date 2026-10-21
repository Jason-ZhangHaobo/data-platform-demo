import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, privateDecrypt, constants, createDecipheriv } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { auditConfig, recipientKey, runReadAudit, classifyAuditError, sealReport } from '../../scripts/audit-v2-oidc-readonly.mjs';
const env = { V2_DEPLOY_ROLE_ARN: 'acs:ram::111122223333:role/synthetic-deployer', V2_DEPLOY_OIDC_PROVIDER_ARN: 'acs:ram::111122223333:oidc-provider/synthetic', V2_FUNCTION_NAME: 'synthetic-control', ALIBABA_CLOUD_REGION_ID: 'cn-hangzhou' };
const identity = { AccountId: '111122223333', Arn: 'acs:ram::111122223333:assumed-role/synthetic-deployer/session' };
const config = auditConfig(env);
test('read audit validates scope and never falls back to another identity or function', () => {
  for (const patch of [{V2_FUNCTION_NAME:'../other'}, {V2_DEPLOY_ROLE_ARN:'bad'}, {ALIBABA_CLOUD_REGION_ID:'other'}, {V2_DEPLOY_OIDC_PROVIDER_ARN:'acs:ram::999900001111:oidc-provider/foreign'}]) assert.throws(()=>auditConfig({...env,...patch}));
  let calls=0;
  const r=runReadAudit(config,()=>{calls++;return {...identity,AccountId:'999900001111'};});
  assert.equal(calls,1);assert.equal(r.identity,'IDENTITY_MISMATCH');assert.equal(r.cloudWrites,0);
});
test('fixed read operations redact response secrets and do not imply write permission',()=>{
  const calls=[],fixtureSecret='synthetic-private-secret-never-report',fixtureName='synthetic-private-trigger';
  const r=runReadAudit(config,args=>{calls.push(args);return calls.length===1?identity:calls.length===2?{
    functionName:'synthetic-control',codeChecksum:'123',codeSize:123,runtime:'custom.debian12',environmentVariables:{DASHSCOPE_API_KEY:fixtureSecret,V2_AGENT_DRIVER_MODE:'OSS_EVENTS'},
  }:{triggers:[{triggerName:fixtureName,triggerType:'oss'}]};});
  assert.deepEqual(calls,[['sts','GetCallerIdentity'],['fc','GET','/2023-03-30/functions/synthetic-control'],['fc','GET','/2023-03-30/functions/synthetic-control/triggers']]);
  assert.equal(r.function.state,'VERIFIED');assert.equal(r.triggers.state,'VERIFIED');assert.equal(r.writePermissionsVerified,false);
  assert(!JSON.stringify(r).includes(fixtureSecret));assert(!JSON.stringify(r).includes(fixtureName));
});
test('read failure is bounded and excludes raw diagnostics; partial trigger denial is explicit',()=>{
  let calls=0;
  const r=runReadAudit(config,()=>{calls++;if(calls===1)return identity;throw Error('AccessDenied private-id missing parameter SecurityToken');});
  assert.equal(calls,2);assert.equal(r.function.state,'MISSING_SECURITY_TOKEN');assert(!JSON.stringify(r).includes('private-id'));
  calls=0;const partial=runReadAudit(config,()=>{calls++;if(calls===1)return identity;if(calls===2)return{functionName:'synthetic-control'};throw Error('AccessDenied');});
  assert.equal(partial.function.state,'VERIFIED');assert.equal(partial.triggers.state,'ACCESS_DENIED');
  assert.equal(classifyAuditError({code:'ETIMEDOUT'}),'BOUNDED_TIMEOUT');
});
test('evidence is recipient encrypted, provenance bound and tamper evident',()=>{
  const keys=generateKeyPairSync('rsa',{modulusLength:3072}),encoded=keys.publicKey.export({type:'spki',format:'der'}).toString('base64');
  const sealed=sealReport({privateFact:'synthetic-only'},recipientKey(encoded),{sourceRevision:'a'.repeat(40),runId:'123'});
  assert(!JSON.stringify(sealed).includes('synthetic-only'));
  const aes=privateDecrypt({key:keys.privateKey,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:'sha256'},Buffer.from(sealed.wrappedKey,'base64'));
  const open=aad=>{const d=createDecipheriv('aes-256-gcm',aes,Buffer.from(sealed.iv,'base64'));d.setAAD(Buffer.from(aad));d.setAuthTag(Buffer.from(sealed.tag,'base64'));return Buffer.concat([d.update(Buffer.from(sealed.ciphertext,'base64')),d.final()]).toString();};
  assert.deepEqual(JSON.parse(open(sealed.aad)),{privateFact:'synthetic-only'});
  assert.throws(()=>open(sealed.aad+' '));assert.throws(()=>recipientKey('not a key'));
  const weak=generateKeyPairSync('rsa',{modulusLength:2048});assert.throws(()=>recipientKey(weak.publicKey.export({type:'spki',format:'der'}).toString('base64')));
});
test('trigger diagnostics distinguish service denial, incomplete pages and unexpected response shapes without raw values',()=>{
  const evaluate=result=>{let n=0;return runReadAudit(config,()=>++n===1?identity:n===2?{functionName:'synthetic-control'}:result).triggers;};
  assert.equal(evaluate({Code:'AccessDenied',Message:'synthetic-private-detail'}).state,'ACCESS_DENIED');
  const page=evaluate({nextToken:'synthetic-private-token',triggers:[]});assert.equal(page.state,'TRIGGER_PAGE_INCOMPLETE');assert.equal(page.responseShape.hasNextToken,true);
  const unknown=evaluate({privateField:'synthetic-private-detail'});assert.equal(unknown.state,'TRIGGER_RESPONSE_UNCONFIRMED');assert.equal(unknown.responseShape.hasTriggerArray,false);
  for(const value of [page,unknown,evaluate(null)])assert(!JSON.stringify(value).includes('synthetic-private-'));
});
test('workflow is main-only, reuses existing OIDC role and never loads application secrets',()=>{
  const w=readFileSync('.github/workflows/audit-v2-oidc-readonly.yml','utf8');
  assert.match(w,/github.ref == 'refs\/heads\/main'/);assert.match(w,/environment: v2-staging/);
  assert.match(w,/vars.V2_DEPLOY_ROLE_ARN/);assert.match(w,/role-session-expiration: 900/);
  assert.doesNotMatch(w,/secrets\.|npm |deploy-v2|InvokeFunction|CreateTrigger|DeleteTrigger/);
  assert.match(w,/path: v2-readonly-audit.sealed.json/);assert.match(w,/retention-days: 1/);
});
test('pagination follows only bounded same-function GETs and never labels a partial list complete',()=>{
  const calls=[];const r=runReadAudit(config,args=>{
    calls.push(args);if(calls.length===1)return identity;if(calls.length===2)return{functionName:'synthetic-control'};
    return calls.length===3?{triggers:[{triggerName:'synthetic-one',triggerType:'oss'}],nextToken:'a+/='}:{triggers:[{triggerName:'synthetic-two',triggerType:'oss'}]};
  });
  assert.equal(r.triggers.state,'VERIFIED');assert.equal(r.triggers.items.length,2);
  assert.equal(calls[3][2],'/2023-03-30/functions/synthetic-control/triggers?nextToken=a%2B%2F%3D');
  let n=0;const bounded=runReadAudit(config,()=>++n===1?identity:n===2?{functionName:'synthetic-control'}:{triggers:[],nextToken:String(n)});
  assert.equal(n,5);assert.equal(bounded.triggers.state,'TRIGGER_PAGE_INCOMPLETE');
});
