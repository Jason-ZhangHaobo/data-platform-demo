import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {httpsConfig,domainProbes,domainProbeAccepted,nextDomainMetadataCount,waitExactDns} from '../../scripts/accept-v2-https-binding.mjs';
import {P0B_SIGNED_ACCESS_AUTHORIZATION} from '../../scripts/v2-domain-binding-plan.mjs';

test('custom domain probes require trusted TLS fingerprint plus exact signed application denial',()=>{
 const good={status:404,code:'INGRESS_DENIED',privateProtocol:false,certificateSha256:'a'.repeat(64),tlsVersion:'TLSv1.3'};
 const signed=domainProbes.find(p=>p.id==='signed-baseline'),unsigned=domainProbes.find(p=>p.id==='unsigned');assert.equal(domainProbes[0],signed);
 assert.equal(domainProbeAccepted(good,signed,'a'.repeat(64)),true);
 for(const patch of [{certificateSha256:'b'.repeat(64)},{tlsVersion:'TLSv1.0'},{status:200},{status:403,code:'AccessDenied'},{privateProtocol:true}])assert.equal(domainProbeAccepted({...good,...patch},signed,'a'.repeat(64)),false);
 assert.equal(domainProbeAccepted({...good,status:401},unsigned,'a'.repeat(64)),true);
 assert.equal(domainProbeAccepted({...good,status:400,code:'InvalidArgument',gatewayCategory:'EMPTY_AUTHORIZATION',authenticationRejected:true},unsigned,'a'.repeat(64)),true);
 assert.equal(domainProbeAccepted({...good,status:400,code:'InvalidArgument',gatewayCategory:'UNCLASSIFIED',authenticationRejected:true},unsigned,'a'.repeat(64)),false);
 assert.equal(domainProbeAccepted({...good,code:'DomainRouteNotFound'},domainProbes.at(-1),'a'.repeat(64)),true);
 assert.equal(domainProbes.length,8);assert(domainProbes.length<=20);
 assert.throws(()=>httpsConfig({}),/HTTPS_SCOPE_NOT_AUTHORIZED/);
});
test('domain transport projection removes private key and raw errors for all responses',()=>{
 const source=`import importlib.util,json\ns=importlib.util.spec_from_file_location('d','scripts/transport-v2-domain-signed.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\nv={'accountId':'111122223333','domainName':'shuduoai.cn','certConfig':{'certName':'fixture','certificate':'PUBLIC_SYNTHETIC_CERT','privateKey':'DO_NOT_EXPORT'},'authConfig':{'authType':'jwt','authInfo':'DO_NOT_EXPORT'},'unexpected':'DO_NOT_EXPORT'}\nprint(json.dumps([m.safe_response(200,json.dumps(v).encode(),'get'),m.safe_response(200,json.dumps(v).encode(),'create'),m.safe_response(403,b'{"code":"AccessDenied","message":"DO_NOT_EXPORT"}','delete')]))`;
 const raw=execFileSync('python3',['-c',source],{encoding:'utf8'}),values=JSON.parse(raw);
 assert(!raw.includes('DO_NOT_EXPORT'));assert.equal(values[0].value.certConfig.certificate,'PUBLIC_SYNTHETIC_CERT');assert.equal(values[1].value,undefined);assert.equal(values[2].code,'AccessDenied');
});
test('HTTPS workflow gates DNS handoff on completed boundary proof and always cleans/seals',()=>{
 const workflow=readFileSync('.github/workflows/accept-v2-https-binding.yml','utf8');
 assert.match(workflow,/default: NOT_AUTHORIZED/);assert.match(workflow,/refs\/heads\/main/);assert.match(workflow,/environment: v2-staging/);assert.match(workflow,/cancel-in-progress: false/);
 assert(workflow.indexOf('--prepare')<workflow.indexOf('configure-aliyun-credentials-action'));
 assert(workflow.indexOf('--boundary')<workflow.indexOf('--handoff'));assert(workflow.indexOf('shuduo-https-ready-')<workflow.indexOf('--bind'));
 assert.equal((workflow.match(/if: always\(\)/g)||[]).length,3);assert.match(workflow,/--cleanup/);assert.match(workflow,/--seal/);
 assert.doesNotMatch(workflow,/vars\.|DASHSCOPE|MYSQL|JASONSECRETS|npm run|UpdateFunction/);
 assert.match(workflow,/secrets.V2_HTTPS_BINDING_INPUT/);assert.match(workflow,/path: v2-https-binding.sealed.json/);
});
test('P0-B metadata calls have fixed independent limits and reject corrupt stored counts',()=>{
 let counts={get:0,create:0,delete:0};
 for(let n=0;n<10;n++)counts=nextDomainMetadataCount(counts,'get');
 assert.throws(()=>nextDomainMetadataCount(counts,'get'),/LIMIT_REACHED/);
 counts=nextDomainMetadataCount(counts,'create');counts=nextDomainMetadataCount(counts,'delete');assert.deepEqual(counts,{get:10,create:1,delete:1});
 for(const operation of ['create','delete','update'])assert.throws(()=>nextDomainMetadataCount(counts,operation));
 for(const patch of [{get:-1},{create:2},{delete:'0'},{get:1.5}])assert.throws(()=>nextDomainMetadataCount({...counts,...patch},'get'));
});
test('P0-B waits for authoritative publication without priming recursive negative caches',async()=>{
 const start=Date.now(),plan={requestScope:P0B_SIGNED_ACCESS_AUTHORIZATION,expiresAt:new Date(start+3600000).toISOString(),target:{domainName:'shuduoai.cn'},dns:{value:'fixture.example.invalid'}};
 let elapsed=0,authorityCalls=0,publicCalls=0;
 const options={now:()=>start+elapsed,lookupNs:async()=>['ns-a.example.invalid','ns-b.example.invalid'],lookup4:async()=>['192.0.2.10'],resolverFactory:()=>({setServers:()=>{},resolveCname:async()=>{authorityCalls++;if(elapsed===0)throw Object.assign(Error('not published'),{code:'ENODATA'});return[plan.dns.value];}}),publicLookup:async()=>{publicCalls++;assert(elapsed>=10000);if(publicCalls===1)throw Object.assign(Error('old cache'),{code:'ENODATA'});return[plan.dns.value];},wait:async ms=>{elapsed+=ms;}};
 assert.equal(await waitExactDns(plan,options),true);assert.equal(publicCalls,2);assert.equal(authorityCalls,6);assert.equal(elapsed,20000);
});
test('authoritative readiness cannot bypass a public DNS conflict or the cleanup deadline',async()=>{
 const start=Date.now(),plan={requestScope:P0B_SIGNED_ACCESS_AUTHORIZATION,expiresAt:new Date(start+3600000).toISOString(),target:{domainName:'shuduoai.cn'},dns:{value:'fixture.example.invalid'}};
 const options={now:()=>start,lookupNs:async()=>['ns.example.invalid'],lookup4:async()=>['192.0.2.10'],resolverFactory:()=>({setServers:()=>{},resolveCname:async()=>[plan.dns.value]}),publicLookup:async()=>['foreign.example.invalid'],wait:async()=>assert.fail('conflict must not retry')};
 await assert.rejects(waitExactDns(plan,options),/DNS_TARGET_CONFLICT/);
 await assert.rejects(waitExactDns({...plan,expiresAt:new Date(start+299999).toISOString()},{...options,lookupNs:async()=>assert.fail('expired before lookup')}),/HTTPS_WINDOW_EXPIRED/);
});
