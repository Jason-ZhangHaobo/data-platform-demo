import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {validateArtifactIdentity,verifyControlBuildBytes,controlArtifactSources,controlArtifactSourceChecks,splitStartupArtifactSources,verifyControlArtifactSources} from '../../scripts/inspect-control-artifact.mjs';
test('remote inspection requires a successful source-matched original build and unexpired matching artifact',()=>{
 const identity={source:'a'.repeat(40),buildRunId:'12345678',artifactId:'12345679'};
 const run={id:12345678,name:'Build V2 control plane package',head_sha:identity.source,status:'completed',conclusion:'success'};
 const artifact={id:12345679,expired:false,workflow_run:{id:12345678},name:`shuduo-v2-control-${identity.source}`,digest:'sha256:'+'b'.repeat(64)};
 assert.doesNotThrow(()=>validateArtifactIdentity(run,artifact,identity));
 for(const patch of [{conclusion:'failure'},{head_sha:'c'.repeat(40)},{name:'other'}])assert.throws(()=>validateArtifactIdentity({...run,...patch},artifact,identity));
 for(const patch of [{expired:true},{workflow_run:{id:1}},{name:'other'},{digest:null}])assert.throws(()=>validateArtifactIdentity(run,{...artifact,...patch},identity));
 const workflow=readFileSync(new URL('../../.github/workflows/inspect-v2-control-artifact.yml',import.meta.url),'utf8');
 for(const banned of ['id-token:','secrets.','environment:','aliyun','build-v2-fc-package'])assert(!workflow.includes(banned));
});
test('an older application can use a protected main build only with its exact workflow, attempt, tree and package proof',()=>{
 const identity={source:'a'.repeat(40),buildRunId:'12345678',artifactId:'12345679'};
 const run={id:12345678,name:'Build V2 control plane package',head_sha:'c'.repeat(40),head_branch:'main',
  path:'.github/workflows/build-v2-control-plane.yml',event:'workflow_dispatch',run_attempt:1,status:'completed',conclusion:'success'};
 const artifact={id:12345679,expired:false,workflow_run:{id:12345678},name:`shuduo-v2-control-${identity.source}`,digest:'sha256:'+'b'.repeat(64)};
 const bytes=Buffer.from('synthetic package bytes'),tree='d'.repeat(40);
 const build={protocol:'shuduo-control-build-source/v1',applicationSource:identity.source,applicationTree:tree,
  workflowSource:run.head_sha,buildRunId:identity.buildRunId,buildAttempt:'1',
  sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length};
 assert.doesNotThrow(()=>validateArtifactIdentity(run,artifact,identity,build));
 assert.doesNotThrow(()=>verifyControlBuildBytes(build,tree,bytes));
 assert.throws(()=>validateArtifactIdentity(run,artifact,identity),/BUILD_SOURCE_NOT_VERIFIED/);
 for(const patch of [{head_branch:'stale-branch'},{path:'.github/workflows/another.yml'},{event:'pull_request'},{run_attempt:2}])
  assert.throws(()=>validateArtifactIdentity({...run,...patch},artifact,identity,build),/BUILD_SOURCE_NOT_VERIFIED/);
 for(const patch of [{workflowSource:'f'.repeat(40)},{applicationSource:'f'.repeat(40)},{buildRunId:'12345680'}])
  assert.throws(()=>validateArtifactIdentity(run,artifact,identity,{...build,...patch}),/BUILD_SOURCE_NOT_VERIFIED/);
 assert.throws(()=>verifyControlBuildBytes(build,'e'.repeat(40),bytes),/BUILD_BYTES_NOT_VERIFIED/);
 assert.throws(()=>verifyControlBuildBytes(build,tree,Buffer.from('altered package bytes')),/BUILD_BYTES_NOT_VERIFIED/);
 const workflow=readFileSync(new URL('../../.github/workflows/build-v2-control-plane.yml',import.meta.url),'utf8');
 assert.match(workflow,/git merge-base --is-ancestor "\$V2_BUILD_SOURCE" "\$GITHUB_SHA"/);
 assert.match(workflow,/python3 -m pip install --require-hashes --no-deps --requirement deploy\/sql-lineage-requirements.txt/);
 for(const banned of ['id-token:','secrets.','environment:','aliyun'])assert(!workflow.includes(banned));
});
test('readonly artifact source checks cover budget accounting, durable ownership, event scope and delivery',()=>{
 const prior=['fc-ingress','server','cloud-server','public-status','auth','private-application','request-lane','static-response','cloud-state-coordinator','public-development-access','public-publication-access','cloud-publication','private-release-timer','public-service-access','private-data-services','data-services','private-task-consumption'];
 assert.deepEqual(controlArtifactSources,[...prior,'budget','durable-agent','model','model-diagnostics','agent-event-driver','agent-development-workflow'].map(name=>`src/v2/${name}.mjs`));
 assert.equal(new Set(controlArtifactSources).size,23);assert.equal(Object.isFrozen(controlArtifactSources),true);
 const source=readFileSync(new URL('../../scripts/inspect-control-artifact.mjs',import.meta.url),'utf8');
 assert.match(source,/verifyControlArtifactSources\('\.artifact-source',extract\)/);
 assert.ok(!source.includes('execFileSync(extract('),'package source is inspected, never executed');
});
test('source checkout requires new repair and Worker evidence modules while preserving legacy application inspection',()=>{
 const root='/synthetic-source',modules=['sql-repair-feedback','sql-repair-progress','sql-repair-source','validation-details','publication-request','private-service-routes','private-task-consumption','consumer-source','agent-context-derivation','service-plan-source','service-plan-request','service-agent-context-client','service-plan-proposal','private-service-agent-policy','durable-service-agent','worker-result-evidence','cloud-release-evidence','agent-review-evidence','remote-spark','remote-spark-queue','cloud-execution-state','durable-development','fund-preparation','fund-preparation-request','delivery','fund-delivery','private-release-source','fund-agent-task-consumption','distribution-services','private-batch-report'].map(name=>`src/v2/${name}.mjs`);
 const queried=[];const checks=controlArtifactSourceChecks(root,path=>{queried.push(path);return true;});
 assert.deepEqual(checks,[...controlArtifactSources,...modules,...splitStartupArtifactSources]);assert.equal(checks.length,59);assert.equal(Object.isFrozen(checks),true);
 assert.deepEqual(queried,[...modules,...splitStartupArtifactSources].map(name=>resolve(root,name)));
 assert.deepEqual(controlArtifactSourceChecks(root,path=>modules.some(name=>path===resolve(root,name))),[...controlArtifactSources,...modules]);
 assert.deepEqual(controlArtifactSourceChecks(root,()=>false),controlArtifactSources);
 assert.deepEqual(controlArtifactSourceChecks(root,path=>path.endsWith('/sql-repair-source.mjs')),[...controlArtifactSources,modules[2]]);
});
test('split startup artifacts require every new module and context byte while legacy inspection remains valid',()=>{
 const root=mkdtempSync(resolve(tmpdir(),'shuduo-artifact-sources-'));
 const expected=['src/v2/cloud-application.mjs','src/v2/request-scope.mjs','src/v2/context.mjs',
  'fixtures/holdings/context.json','fixtures/holdings/reference.sql','fixtures/holdings/stock-cash-reference.sql'];
 assert.deepEqual(splitStartupArtifactSources,expected);
 assert.equal(Object.isFrozen(splitStartupArtifactSources),true);
 assert.throws(()=>controlArtifactSourceChecks(root,path=>path.endsWith('/cloud-application.mjs')),/STARTUP_SOURCE_CHECKOUT_INCOMPLETE/);
 const sources=controlArtifactSourceChecks(root,()=>true),archive=new Map();
 try{
  for(const name of sources){
   const bytes=Buffer.from(`fictional source for ${name}\n`);
   mkdirSync(dirname(resolve(root,name)),{recursive:true});
   writeFileSync(resolve(root,name),bytes);archive.set(name,bytes);
  }
  assert.deepEqual(verifyControlArtifactSources(root,name=>archive.get(name)),sources);
  for(const name of expected){
   const extract=entry=>entry===name?Buffer.from('altered fictional source'):archive.get(entry);
   assert.throws(()=>verifyControlArtifactSources(root,extract),/SOURCE_MISMATCH/);
   const missing=entry=>entry===name?Buffer.alloc(0):archive.get(entry);
   assert.throws(()=>verifyControlArtifactSources(root,missing),/SOURCE_MISMATCH/);
  }
 }finally{rmSync(root,{recursive:true,force:true});}
});
