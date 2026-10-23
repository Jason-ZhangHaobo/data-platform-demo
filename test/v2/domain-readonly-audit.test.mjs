import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {domainAuditConfig,runDomainReadAudit} from '../../scripts/audit-v2-domain-readonly.mjs';
const now=Date.parse('2026-10-23T02:00:00Z');
const target={domainName:'shuduoai.cn',region:'cn-hangzhou',roleArn:'acs:ram::111122223333:role/synthetic-deployer',providerArn:'acs:ram::111122223333:oidc-provider/synthetic',functionName:'synthetic-control'};
const env={GITHUB_REF:'refs/heads/main',GITHUB_SHA:'a'.repeat(40),V2_DOMAIN_SOURCE_SHA:'a'.repeat(40),V2_DOMAIN_READ_AUTHORIZATION:'ONE_DOMAIN_READ_MAX_TWO',V2_DOMAIN_READ_EXPIRES_AT:new Date(now+1800000).toISOString(),V2_DOMAIN_READ_TARGET:JSON.stringify(target)};
const identity={AccountId:'111122223333',Arn:'acs:ram::111122223333:assumed-role/synthetic-deployer/session'};
const config=domainAuditConfig(env,now);
test('domain audit requires fixed target, main SHA and a live one-hour approval window',()=>{
 for(const patch of [{GITHUB_REF:'refs/heads/other'},{V2_DOMAIN_SOURCE_SHA:'b'.repeat(40)},{V2_DOMAIN_READ_AUTHORIZATION:''},{V2_DOMAIN_READ_EXPIRES_AT:new Date(now-1).toISOString()},{V2_DOMAIN_READ_EXPIRES_AT:new Date(now+3600001).toISOString()},{V2_DOMAIN_READ_TARGET:JSON.stringify({...target,domainName:'other.invalid'})}])assert.throws(()=>domainAuditConfig({...env,...patch},now));
});
test('one domain read excludes all certificate bodies, identifiers, paths and raw responses',()=>{
 const calls=[],secret='synthetic-private-certificate-never-retain';
 const report=runDomainReadAudit(config,args=>{calls.push(args);return calls.length===1?identity:{ok:true,status:200,protocol:'HTTPS',hasCertificate:true,routeCount:1,allRoutesTargetConfiguredFunction:true,ignoredPrivateField:secret};},()=>now);
 assert.equal(report.passed,true);assert.equal(report.domainRequests,1);assert.equal(report.domain.hasCertificate,true);assert.equal(report.domain.allRoutesTargetConfiguredFunction,true);
 assert.deepEqual(calls,[['sts','GetCallerIdentity'],['fc','GET','/2023-03-30/custom-domains/shuduoai.cn']]);
 assert(!JSON.stringify(report).includes(secret));assert(!JSON.stringify(report).includes(target.functionName));assert(!JSON.stringify(report).includes(identity.AccountId));assert.equal(report.cloudWrites,0);
});
test('signed HTTP response projection removes PEMs and retains only safe failure codes',()=>{
 const source=`import importlib.util,json\nspec=importlib.util.spec_from_file_location('domain','scripts/read-v2-domain-signed.py')\nm=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\nt={'domainName':'shuduoai.cn','account':'111122223333','functionName':'synthetic-control'}\nv={'domainName':t['domainName'],'accountId':t['account'],'protocol':'HTTPS','certConfig':{'certificate':'PRIVATE_PEM','privateKey':'PRIVATE_KEY'},'routeConfig':{'routes':[{'functionName':'synthetic-control'}]}}\nprint(json.dumps([m.response_evidence(200,json.dumps(v).encode(),t),m.response_evidence(404,b'{"ErrorCode":"DomainNameNotFound","Message":"PRIVATE_KEY"}',t)]))`;
 const raw=execFileSync('python3',['-c',source],{encoding:'utf8'}),[ok,missing]=JSON.parse(raw);
 assert.equal(ok.hasCertificate,true);assert.equal(ok.allRoutesTargetConfiguredFunction,true);assert.equal(missing.code,'DomainNameNotFound');assert.equal(missing.status,404);assert(!raw.includes('PRIVATE_'));assert(!raw.includes('111122223333'));
});
test('missing domain is a verified absence, while access errors are not absence and never retry',()=>{
 for(const code of ['CustomDomainNotFound','AccessDenied']){
  let calls=0;const report=runDomainReadAudit(config,()=>{if(++calls===1)return identity;throw {stderr:JSON.stringify({error:{code,message:'synthetic-secret'}})};},()=>now);
  assert.equal(calls,2);assert.equal(report.domainRequests,1);assert.equal(report.passed,code==='CustomDomainNotFound');assert(!JSON.stringify(report).includes('synthetic-secret'));
 }
});
test('wrong identity or expired window prevents the domain query',()=>{
 let calls=0;const first=runDomainReadAudit(config,()=>{calls++;return{...identity,AccountId:'999900001111'};},()=>now);assert.equal(calls,1);assert.equal(first.domainRequests,0);
 calls=0;const expired=runDomainReadAudit(config,()=>{calls++;return identity;},()=>config.expiresAt);assert.equal(calls,1);assert.equal(expired.domainRequests,0);
});
test('workflow prepares masked metadata before OIDC and retains no plaintext cloud response',()=>{
 const w=readFileSync('.github/workflows/audit-v2-domain-readonly.yml','utf8'),old=readFileSync('.github/workflows/audit-v2-oidc-readonly.yml','utf8');
 assert.match(w,/github.ref == 'refs\/heads\/main'/);assert.match(w,/environment: v2-staging/);assert.doesNotMatch(w,/vars\.|JASONSECRETS|DASHSCOPE|InvokeFunction|CreateCustomDomain|npm /);
 assert.equal(w.match(/configure-aliyun-credentials-action@([a-f0-9]+)/)[1],old.match(/configure-aliyun-credentials-action@([a-f0-9]+)/)[1]);
 assert(w.indexOf('--prepare')<w.indexOf('configure-aliyun-credentials-action'));
 assert.match(w,/path: v2-domain-audit.sealed.json/);assert.match(w,/if: always\(\)/);
});
