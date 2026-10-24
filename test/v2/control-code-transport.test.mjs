import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {codeUpdateConfig} from '../../scripts/control-code-update.mjs';
import {boundedBytes,codeDownloadUrl,controlCloudAdapter,deploymentInput,privateOssRequest,scalingConfiguration} from '../../scripts/control-code-transport.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
const now=Date.UTC(2026,9,24),old=Buffer.from('old-code'),next=Buffer.from('new-code');
const raw={authorization:'P0A_PRIVATE_CODE_ONLY',operationId:'a'.repeat(32),applicationSource:'b'.repeat(40),operatorSource:'c'.repeat(40),account:'111122223333',role:'fixture-role',functionName:'fixture-control',bucket:'fixture-private',region:'cn-hangzhou',previousInvocations:11,expiresAt:new Date(now+3600000).toISOString(),previous:{sha256:hash(old),bytes:old.length,crc64:'123'},candidate:{sha256:hash(next),bytes:next.length}};
const target={config:raw,roleArn:'acs:ram::111122223333:role/fixture-role',providerArn:'acs:ram::111122223333:oidc-provider/fixture',buildRunId:'12345678',artifactId:'12345679',authorizedAt:new Date(now).toISOString(),bucketPrivacy:{bucketHash:hash(raw.bucket),aclPrivate:true,policyNotPublic:true,publicAccessBlocked:true,checkedAt:new Date(now).toISOString()},unsettledReservedCny:2,objectAclReadApproved:true};
const environment={GITHUB_ACTIONS:'true',GITHUB_REF:'refs/heads/main',GITHUB_SHA:raw.operatorSource,V2_CONTROL_OPERATOR_SHA:raw.operatorSource,V2_CONTROL_UPDATE_APPROVED:'P0A_PRIVATE_CODE_ONLY',V2_CONTROL_UPDATE_TARGET:JSON.stringify(target)};
test('deployment input requires protected main, original scope, matching identity and fresh privacy',()=>{
 assert.equal(deploymentInput(environment,now).config.issuedAt,now);
 for(const patch of [{GITHUB_REF:'refs/heads/other'},{V2_CONTROL_UPDATE_APPROVED:'yes'},{GITHUB_SHA:'f'.repeat(40)},{V2_CONTROL_UPDATE_TARGET:'{}'}])assert.throws(()=>deploymentInput({...environment,...patch},now));
 for(const patch of [{objectAclReadApproved:false},{unsettledReservedCny:0},{roleArn:'acs:ram::999922223333:role/fixture-role'},{bucketPrivacy:{...target.bucketPrivacy,publicAccessBlocked:false}},{bucketPrivacy:{...target.bucketPrivacy,bucketHash:'f'.repeat(64)}}])assert.throws(()=>deploymentInput({...environment,V2_CONTROL_UPDATE_TARGET:JSON.stringify({...target,...patch})},now));
 assert.throws(()=>deploymentInput(environment,now+3600000));
});
test('rollback download is HTTPS-only to the expected regional OSS, with byte bounds',async()=>{
 assert.equal(codeDownloadUrl('http://fixture-code.oss-cn-hangzhou.aliyuncs.com/code?signature=synthetic'),'https://fixture-code.oss-cn-hangzhou.aliyuncs.com/code?signature=synthetic');
 for(const u of ['http://127.0.0.1/code','https://fixture.example.invalid/code','https://fixture-code.oss-cn-hangzhou.aliyuncs.com.evil.invalid/code','https://user@fixture-code.oss-cn-hangzhou.aliyuncs.com/code','https://fixture-code.oss-cn-beijing.aliyuncs.com/code'])assert.throws(()=>codeDownloadUrl(u));
 assert.deepEqual(await boundedBytes(new Response(next),next.length),next);
 await assert.rejects(boundedBytes(new Response(next),2),/TOO_LARGE/);
 await assert.rejects(boundedBytes(new Response('error',{status:403}),100),/NOT_CONFIRMED/);
});
test('object writes are create-only binary requests without ACL mutation, and scaling excludes runtime counters',()=>{
 const credentials={accessKeyId:'fixture-id',accessKeySecret:'fixture-key',securityToken:'fixture-token'};
 const r=privateOssRequest({bucket:'fixture-private',region:'cn-hangzhou',key:'code/fixture.zip',credentials,method:'PUT',body:next});
 assert.equal(r.options.headers['x-oss-object-acl'],undefined);assert.equal(r.options.headers['x-oss-forbid-overwrite'],'true');assert.equal(r.options.redirect,'error');assert.equal(r.options.body,next);assert(!r.url.includes('fixture-token'));
 assert.throws(()=>privateOssRequest({bucket:'fixture-private',region:'cn-hangzhou',credentials,key:'code',method:'DELETE'}));
 const a=scalingConfiguration({minInstances:0,currentInstances:0,enableOnDemandScaling:true}),b=scalingConfiguration({minInstances:0,currentInstances:1,enableOnDemandScaling:true});assert.deepEqual(a,b);
 assert.notDeepEqual(a,scalingConfiguration({minInstances:1,enableOnDemandScaling:true}));
});
function fixture({unknownPut=false,corrupt=false,acl='private'}={}){
 const config=codeUpdateConfig(raw,now),metadata={...target,bucketPrivacy:{...target.bucketPrivacy,checkedAt:new Date().toISOString()}};
 let saved,backup,stored,puts=0;const commands=[];
 const adapter=controlCloudAdapter(config,metadata,{env:{ALIBABA_CLOUD_ACCESS_KEY_ID:'fixture-id',ALIBABA_CLOUD_ACCESS_KEY_SECRET:'fixture-secret',ALIBABA_CLOUD_SECURITY_TOKEN:'fixture-token'},candidateBytes:next,
  loadTransport:()=>saved,saveTransport:v=>{saved=structuredClone(v);},saveBackup:b=>{backup=b;},
  exec:(program,args)=>{commands.push(args);assert.equal(program,'aliyun');assert(args.includes('--retry-count'));if(args[0]==='fc')assert(!args[2].includes('?'));if(args[2]?.endsWith('/code'))return JSON.stringify({checksum:'123',url:'https://fixture-code.oss-cn-hangzhou.aliyuncs.com/rollback'});if(args[2]?.endsWith('/triggers'))return JSON.stringify({triggers:[]});return JSON.stringify({functionName:'fixture-control'});},
  fetchImpl:async(url,options)=>{
   assert.equal(options.redirect,'error');
   if(url.includes('/rollback'))return new Response(old);
   if(url.endsWith('?acl'))return new Response(`<AccessControlPolicy><AccessControlList><Grant>${acl}</Grant></AccessControlList></AccessControlPolicy>`);
   if(options.method==='PUT'){puts++;assert(saved.puts.includes(config.candidate.sha256));stored=corrupt?old:options.body;if(unknownPut)throw Error('lost response');return new Response('',{status:200});}
   return stored?new Response(stored,{headers:{'x-oss-hash-crc64ecma':'456'}}):new Response('<Error><Code>NoSuchKey</Code></Error>',{status:404});
  },
 });
 return{config,adapter,commands,backup:()=>backup,puts:()=>puts};
}
test('transport downloads exact rollback bytes and reconciles one unknown create-only upload',async()=>{
 const f=fixture({unknownPut:true}),backup=await f.adapter.recoverRollback(f.config.previous);assert(backup.safelyRetained);assert.deepEqual(f.backup(),old);
 const receipt=await f.adapter.ensurePackage('candidate',f.config.candidate);assert.equal(receipt.sha256,hash(next));assert.equal(receipt.privateVerified,true);assert.equal(f.puts(),1);
 await f.adapter.ensurePackage('candidate',f.config.candidate);assert.equal(f.puts(),1);
});
test('transport refuses other objects, public ACLs, corrupted bytes and non-code changes',async()=>{
 for(const options of [{corrupt:true},{acl:'public-read'}]){const f=fixture(options);await assert.rejects(f.adapter.ensurePackage('candidate',f.config.candidate));assert.equal(f.puts(),1);}
 const f=fixture();await assert.rejects(f.adapter.ensurePackage('candidate',{...f.config.candidate,key:'other.zip'}));
 assert.throws(()=>f.adapter.updateCode({environmentVariables:{},code:{}}));assert.throws(()=>f.adapter.invoke({operation:'PRIVATE_AGENT_TICK_V1'}));assert.equal(f.commands.length,0);
});
test('protected workflow uses secret metadata and existing pinned package, never W3 or another build',()=>{
 const yaml=readFileSync(new URL('../../.github/workflows/update-v2-control-code.yml',import.meta.url),'utf8');
 for(const text of ["github.ref == 'refs/heads/main'",'P0A_PRIVATE_CODE_ONLY','secrets.V2_CONTROL_UPDATE_TARGET','artifact-ids:','--recover','--seal','v2-staging-control-mutation'])assert(yaml.includes(text));
 for(const text of ['vars.','deploy-v2-w3','build-v2-fc-package','CreateTrigger','workflow_call'])assert(!yaml.includes(text));
});
test('ROA query parameters are separate CLI flags and failures identify the exact read operation',async()=>{
 const f=fixture();await f.adapter.readState();await f.adapter.recoverRollback(f.config.previous);
 for(const [suffix,flag,value] of [['/triggers','--limit','100'],['/scaling-config','--qualifier','LATEST'],['/code','--qualifier','LATEST']]){
  const args=f.commands.find(a=>a[2]?.endsWith(suffix));assert(args);assert.equal(args[args.indexOf(flag)+1],value);assert(!args[2].includes('?'));
 }
 const c=f.config,a=controlCloudAdapter(c,target,{env:{},loadTransport:()=>undefined,saveTransport:()=>{},exec:()=>{throw Object.assign(Error('not retained'),{status:3,stderr:'ERROR: can not find api by path synthetic'});}});
 await assert.rejects(a.readState(),e=>e.safeDiagnostic.operation==='FC_GET_FUNCTION'&&e.safeDiagnostic.cliPathRejected===true&&!JSON.stringify(e.safeDiagnostic).includes('synthetic'));
});
