import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { validateTransferPlan, signedTransferRequest } from '../../scripts/run-control-multipart-prestage.mjs';
import { functionDigest } from '../../scripts/refresh-v2-spark-readiness.mjs';

const now = Date.parse('2026-11-25T01:00:00Z');
const hash = v=>createHash('sha256').update(v).digest('hex');
const sha = 'a'.repeat(64), bucket = 'example-private', key = 'data-platform-demo/v2/control-plane/'+sha+'.zip';

function inputs() {
  const env = {GITHUB_SHA:'b'.repeat(40),GITHUB_RUN_ID:'1111111',V2_MULTIPART_BUILD_RUN:'2111111',V2_MULTIPART_ARTIFACT_ID:'3111111',V2_AUDIT_RECIPIENT_KEY:'example-recipient'};
  const config={functionName:'example-control'};
  const current={codeSize:47000123,codeChecksum:'13067',environmentVariables:{OSS_BUCKET:bucket,V2_FC_PUBLIC_READ_ONLY:'true'}};
  const plan={scope:'CONTROL_CODE_MULTIPART_PRESTAGE_V1',operationId:'a'.repeat(32),operatorSource:env.GITHUB_SHA,
    applicationSource:'c'.repeat(40),controlName:config.functionName,baselineDigest:functionDigest(current),
    previous:{sha256:'b'.repeat(64),bytes:current.codeSize,crc64:current.codeChecksum},candidate:{sha256:sha,bytes:48000123,crc64:'10345'},
    buildRunId:env.V2_MULTIPART_BUILD_RUN,artifactId:env.V2_MULTIPART_ARTIFACT_ID,issuedAt:now-30000,deadline:now+1200000,
    recipientKeyDigest:hash(env.V2_AUDIT_RECIPIENT_KEY),bucketHash:hash(bucket),approvalDigest:'d'.repeat(64),
    preflight:{checkedAt:new Date(now-90000).toISOString(),versioning:'UNVERSIONED',candidateAbsent:true,activeUploads:0,
      privacyVerified:true,billCny:12,retainedReserveCny:90,maxIncrementCny:2,monthlyLimitCny:200}};
  return {env,config,current,plan};
}

test('prestage binds the artifact, readonly baseline, recipient and bounded owner preflight',()=>{
  const {env,config,current,plan}=inputs();
  const verify=p=>validateTransferPlan(p,env,config,current,now);
  verify(plan);
  for(const patch of [{operatorSource:plan.applicationSource},{artifactId:'7777777'},{baselineDigest:plan.approvalDigest},
    {recipientKeyDigest:'0'.repeat(64)},{deadline:now+3600001},{issuedAt:now+1},{scope:'OTHER'},
    {candidate:{...plan.candidate,bytes:100}},{previous:{...plan.previous,sha256:sha}}]) assert.throws(()=>verify({...plan,...patch}));
  for(const patch of [{billCny:108.01},{retainedReserveCny:88},{activeUploads:1},{candidateAbsent:false},{privacyVerified:false},
    {versioning:'Suspended'},{checkedAt:new Date(now-3600000).toISOString()}]) assert.throws(()=>verify({...plan,preflight:{...plan.preflight,...patch}}));
  verify({...plan,preflight:{...plan.preflight,billCny:108}});
});

test('a cleanup dispatch is separately bound to exactly one original run, session and abort history',()=>{
  const {env,config,current,plan}=inputs();
  const cleanup={...plan,scope:'CONTROL_CODE_MULTIPART_CLEANUP_V1',uploadId:'demo-id-123',
    priorRunId:'7111111',priorRunTerminal:true,startedAt:new Date(now-10000).toISOString(),priorAbortAttempted:false};
  const verify=(p,envOverride)=>validateTransferPlan(p,{...env,V2_MULTIPART_CLEANUP_ONLY:'true',...envOverride},config,current,now);
  verify(cleanup);
  assert.throws(()=>verify(cleanup,{V2_MULTIPART_CLEANUP_ONLY:'false'}));
  assert.throws(()=>verify(plan));
  for(const patch of [{uploadId:'a/b'},{priorRunId:env.GITHUB_RUN_ID},{priorAbortAttempted:undefined},
    {startedAt:new Date(now+100).toISOString()}]) assert.throws(()=>verify({...cleanup,...patch}));
});

test('multipart signing binds non-overwrite, the MD5 body and exact candidate key with no redirect',()=>{
  const target={bucket,key,credentials:{accessKeyId:'test-id',accessKeySecret:'test-secret',securityToken:'test-token'}};
  const date='Wed, 25 Nov 2026 01:00:00 GMT';
  const sign=args=>signedTransferRequest(target,args,date);
  const complete=sign({op:'complete',uploadId:'demo-id-123',body:Buffer.from('<CompleteMultipartUpload/>')});
  assert.equal(complete.options.headers.Authorization, 'OSS test-id:I9YeGg4tY5I+7N79g5zVLb5UrjI=');
  assert.equal(complete.options.headers['Content-MD5'],'bsH7mXPT4JG3JAurYv4JNA==');
  assert.equal(complete.options.headers['x-oss-forbid-overwrite'],'true');
  assert.equal(complete.options.redirect,'error');
  assert.equal(complete.url,'https://example-private.oss-cn-hangzhou.aliyuncs.com/'+key+'?uploadId=demo-id-123');
  for(const [op,method,query] of [['acl','GET','?acl'],['init','POST','?uploads'],['get','GET',''],
    ['parts','GET','?uploadId=demo-id-123'],['abort','DELETE','?uploadId=demo-id-123']]){
    const req=sign({op,uploadId:'demo-id-123'}); assert.equal(req.options.method,method); assert.equal(new URL(req.url).search,query);
  }
  assert.equal(new URL(sign({op:'part',part:12,uploadId:'demo-id-123',body:Buffer.from('x')}).url).search,'?partNumber=12&uploadId=demo-id-123');
  for(const args of [{op:'sessions'},{op:'abort',uploadId:'bad?uploads'},{op:'part',part:13,uploadId:'demo-id-123',body:Buffer.from('x')},
    {op:'get',body:Buffer.from('x')}]) assert.throws(()=>sign(args));
});

test('multipart workflow is single-attempt, main-only, and publishes only the sealed operation report',()=>{
  const y=readFileSync(new URL('../../.github/workflows/prestage-v2-control-multipart.yml',import.meta.url),'utf8');
  assert.match(y,/workflow_dispatch:/);
  assert.doesNotMatch(y,/^  (push|pull_request|schedule|workflow_call):/m);
  assert.match(y,/github\.ref == 'refs\/heads\/main' && github\.run_attempt == 1/);
  assert.match(y,/environment: v2-staging/);
  assert.match(y,/group: v2-staging-control-mutation/);
  assert.match(y,/if: \$\{\{ !inputs\.cleanup_only \}\}/);
  assert.match(y,/path: v2-control-multipart\.sealed\.json/);
  assert.doesNotMatch(y,/secrets\.|ossutil |curl |run:.*\$\{\{ inputs\./);
});
