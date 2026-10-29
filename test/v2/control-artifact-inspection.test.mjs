import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {validateArtifactIdentity,controlArtifactSources} from '../../scripts/inspect-control-artifact.mjs';
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
test('readonly artifact source checks cover budget accounting, durable ownership, event scope and delivery',()=>{
 const prior=['fc-ingress','server','cloud-server','public-status','auth','private-application','request-lane','static-response','cloud-state-coordinator','public-development-access','public-publication-access','cloud-publication','private-release-timer','public-service-access','private-data-services','data-services','private-task-consumption'];
 assert.deepEqual(controlArtifactSources,[...prior,'budget','durable-agent','model-diagnostics','agent-event-driver','agent-development-workflow'].map(name=>`src/v2/${name}.mjs`));
 assert.equal(new Set(controlArtifactSources).size,22);assert.equal(Object.isFrozen(controlArtifactSources),true);
 const source=readFileSync(new URL('../../scripts/inspect-control-artifact.mjs',import.meta.url),'utf8');
 assert.match(source,/sha\(extract\(name\)\)===sha\(readFileSync\(resolve\('\.artifact-source',name\)\)\)/);
 assert.ok(!source.includes('execFileSync(extract('),'package source is inspected, never executed');
});
