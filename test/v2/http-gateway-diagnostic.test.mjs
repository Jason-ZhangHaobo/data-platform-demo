import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {diagnosticConfig,diagnosticProbes,runGatewayDiagnostic} from '../../scripts/diagnose-v2-http-gateway.mjs';
const now=Date.UTC(2026,9,23,10),sha='a'.repeat(40);
const target={roleArn:'acs:ram::111122223333:role/fixture-deploy',providerArn:'acs:ram::111122223333:oidc-provider/fixture',functionName:'fixture-control',region:'cn-hangzhou',expectedChecksum:'12345',sourceRevision:sha,priorRequests:8,restoreRunId:'12345',authorizedAt:new Date(now).toISOString(),expiresAt:new Date(now+1800000).toISOString().replace('.000Z','Z')};
const env={GITHUB_ACTIONS:'true',GITHUB_REF:'refs/heads/main',GITHUB_RUN_ID:'98765',GITHUB_SHA:sha,V2_DIAGNOSTIC_SOURCE_SHA:sha,V2_HTTP_DIAGNOSTIC_AUTHORIZED:'THREE_READONLY_GATEWAY_PROBES',V2_HTTP_DIAGNOSTIC_TARGET:JSON.stringify(target)};
function fixture(options={}){
 const {config}=diagnosticConfig(env,now),original=[{triggerName:'fixture-wake',triggerType:'oss'},{triggerName:'fixture-result',triggerType:'oss'}];let items=structuredClone(original),cp,creates=0,probes=[];
 const f={functionName:'fixture-control',codeChecksum:'12345',cpu:0.25,memorySize:512,instanceConcurrency:1,timeout:120,environmentVariables:{V2_PRIVATE_SMOKE_ENABLED:'true',V2_PROVISIONING_ONLY:'true',secret:'NEVER_RETAIN'}};
 const adapter={identity:async()=>({AccountId:config.account,Arn:`acs:ram::${config.account}:assumed-role/${config.role}/test`}),
  fc:async(method,path,body)=>{if(method==='GET'&&path==='')return structuredClone(f);if(method==='GET'&&path==='/triggers')return{triggers:structuredClone(items)};
   if(method==='POST'){assert(cp);creates++;items.push({...body,httpTrigger:{urlInternet:'https://fixture.cn-hangzhou.fcapp.run/'}});if(options.unknownCreate)throw Error('lost response');return{};}
   if(method==='DELETE'){items=items.filter(t=>t.triggerName!==config.triggerName);return{};}throw Error('unexpected operation');},
  privateStatus:async()=>{throw Error('private invocation not allowed in diagnostic budget');},
  billPages:async cycle=>[{Success:true,Data:{BillingCycle:cycle,PageNum:1,PageSize:300,TotalCount:1,Items:{Item:[{Currency:'CNY',PretaxAmount:options.overBudget?'199.10':'1.36'}]}}}],
  diagnose:async(url,probe)=>{probes.push(probe);return{status:probe.id==='signed-baseline'?404:400,code:probe.id==='signed-baseline'?'INGRESS_DENIED':'InvalidArgument',responseHash:'b'.repeat(64),bytes:100,gatewayDiagnostic:probe.signed===false?{message:'synthetic gateway argument error',truncated:false}:null};}};
 return{config,adapter,original,f,probes,creates:()=>creates,remaining:()=>items,options:{now:()=>now,load:()=>cp,save:value=>{cp=structuredClone(value);}}};
}
test('diagnostic requires explicit scope, main, original count and a thirty-minute window',()=>{
 assert.equal(diagnosticConfig(env,now).config.previousReads,8);
 for(const patch of [{V2_HTTP_DIAGNOSTIC_AUTHORIZED:'yes'},{GITHUB_REF:'refs/heads/other'},{V2_DIAGNOSTIC_SOURCE_SHA:'b'.repeat(40)},{V2_HTTP_DIAGNOSTIC_TARGET:JSON.stringify({...target,priorRequests:0})},{V2_HTTP_DIAGNOSTIC_TARGET:JSON.stringify({...target,expiresAt:new Date(now+1801000).toISOString()})}])assert.throws(()=>diagnosticConfig({...env,...patch},now));
});
test('three fixed GET probes retain eight prior requests, collect errors without declaring acceptance, and clean once',async()=>{
 const f=fixture(),r=await runGatewayDiagnostic(f.config,f.adapter,f.options);
 assert.equal(r.diagnosisCollected,true);assert.equal(r.boundaryAccepted,false);assert.equal(r.requests,11);assert.equal(r.newRequests,3);assert.equal(f.creates(),1);assert.equal(r.cleanup.triggerAbsent,true);assert.deepEqual(f.remaining(),f.original);
 assert.deepEqual(f.probes,diagnosticProbes);assert(f.probes.every(p=>p.method==='GET'&&p.path==='/api/v2/status'));assert(!JSON.stringify(r).includes('NEVER_RETAIN'));
 const recovered=await runGatewayDiagnostic(f.config,f.adapter,f.options);assert.equal(recovered.recoveryOnly,true);assert.equal(recovered.requests,11);assert.equal(f.probes.length,3);assert.equal(f.creates(),1);
});
test('budget, baseline and unknown create failures never turn into another trigger or private invocation',async()=>{
 for(const options of [{overBudget:true},{unknownCreate:true}]){const f=fixture(options),r=await runGatewayDiagnostic(f.config,f.adapter,f.options);assert.equal(r.diagnosisCollected,false);assert.equal(r.newRequests,0);assert(f.creates()<=1);assert.deepEqual(f.remaining(),f.original);}
 const f=fixture();f.f.codeChecksum='999';const r=await runGatewayDiagnostic(f.config,f.adapter,f.options);assert.equal(r.failure,'FUNCTION_BASELINE_DRIFT');assert.equal(f.creates(),0);
});
test('diagnostic error projection redacts credentials and identifiers, omits application data, and is opt-in',()=>{
 const source=String.raw`import json,runpy
m=runpy.run_path('scripts/probe-v2-http-boundary.py',run_name='fixture')
v={'ErrorCode':'InvalidArgument','ErrorMessage':'invalid parameter: synthetic-secret; https://private.invalid/path; 111122223333; email=user@example.invalid','RequestId':'request-id-fixture'}
value=m['response_evidence'](400,json.dumps(v).encode(),True,('synthetic-secret',))
s=json.dumps(value['gatewayDiagnostic'])
assert 'synthetic-secret' not in s and 'private.invalid' not in s and '111122223333' not in s and 'user@example.invalid' not in s
assert 'invalid parameter' in s and len(value['gatewayDiagnostic']['requestIdHash'])==64
assert 'gatewayDiagnostic' not in m['response_evidence'](400,json.dumps(v).encode())
assert m['gateway_diagnostic'](200,v) is None
assert m['gateway_diagnostic'](400,{**v,'data':'private application'}) is None
assert m['gateway_diagnostic'](400,{**v,'ErrorMessage':'synthetic PRIVATE KEY marker'}) is None
print('REDACTED_DIAGNOSTIC_PASS')`;
 assert.equal(execFileSync('python3',['-c',source],{encoding:'utf8',timeout:10000}).trim(),'REDACTED_DIAGNOSTIC_PASS');
});
test('diagnostic workflow has no certificate or model secrets, uses main and always exports encrypted cleanup proof',()=>{
 const w=readFileSync('.github/workflows/diagnose-v2-http-gateway.yml','utf8');
 assert.match(w,/default: NOT_AUTHORIZED/);assert.match(w,/refs\/heads\/main/);assert.match(w,/environment: v2-staging/);assert.match(w,/role-session-expiration: 1800/);
 assert(w.indexOf('--prepare')<w.indexOf('configure-aliyun-credentials-action'));assert.equal((w.match(/if: always\(\)/g)||[]).length,3);
 assert.doesNotMatch(w,/vars\.|CERTIFICATE|HTTPS_BINDING_INPUT|DASHSCOPE|MYSQL|JASONSECRETS|CreateCustomDomain|npm run/);assert.match(w,/path: v2-http-diagnostic.sealed.json/);
});
