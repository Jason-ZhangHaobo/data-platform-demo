import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {httpsConfig,domainProbes,domainProbeAccepted} from '../../scripts/accept-v2-https-binding.mjs';

test('custom domain probes require trusted TLS fingerprint plus exact signed application denial',()=>{
 const good={status:404,code:'INGRESS_DENIED',privateProtocol:false,certificateSha256:'a'.repeat(64),tlsVersion:'TLSv1.3'};
 assert.equal(domainProbeAccepted(good,domainProbes[1],'a'.repeat(64)),true);
 for(const patch of [{certificateSha256:'b'.repeat(64)},{tlsVersion:'TLSv1.0'},{status:200},{status:403,code:'AccessDenied'},{privateProtocol:true}])assert.equal(domainProbeAccepted({...good,...patch},domainProbes[1],'a'.repeat(64)),false);
 assert.equal(domainProbeAccepted({...good,status:401},domainProbes[0],'a'.repeat(64)),true);
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
