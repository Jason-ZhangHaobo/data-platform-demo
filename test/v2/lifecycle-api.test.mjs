import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {MetadataStore} from '../../src/v2/store.mjs';
import {createV2Server} from '../../src/v2/server.mjs';
import {frozenEvidence,lifecycleOutcome,lifecycleReport} from './lifecycle-fixtures.mjs';

test('report API keeps failed and unexecuted cases visible and refuses unsupported success claims',async()=>{
 const root=mkdtempSync(join(tmpdir(),'shuduo-lifecycle-api-')),reportRoot=join(root,'.v2-artifacts','full-lifecycle'),fixtureRoot=join(root,'fixtures','e2e');
 mkdirSync(reportRoot,{recursive:true});mkdirSync(fixtureRoot,{recursive:true});
 writeFileSync(join(fixtureRoot,'m1-code-evidence.json'),JSON.stringify(frozenEvidence));
 const store=new MetadataStore(join(root,'platform.sqlite')),app=createV2Server({root,store,env:{V2_LOCAL_DEVELOPMENT:'true'}});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const request=()=>fetch(`http://127.0.0.1:${app.server.address().port}/api/v2/evaluations/full-lifecycle/latest`);
 const save=report=>writeFileSync(join(reportRoot,'latest.json'),JSON.stringify(report));
 try{
  assert.equal((await request()).status,404);
  const outcomes=frozenEvidence.cases.map(lifecycleOutcome);outcomes[0].stages.postReleaseMonitoring.status='FAILED';
  const failed=lifecycleReport(outcomes);save(failed);
  let response=await request();assert.equal(response.status,200);let body=await response.json();
  assert.equal(body.failedCaseCount,1);assert.equal(body.outcomes.length,20);assert.equal(body.publicDeployed,false);assert.equal(body.agentIndependentE2E,false);
  save({...failed,succeededCaseCount:20,fullLifecycleE2E:true});assert.equal((await request()).status,409);
  save(lifecycleReport(outcomes.slice(1,2)));response=await request();assert.equal(response.status,200);body=await response.json();
  assert.equal(body.localFullLifecycleRate,0.05);assert.equal(body.unexecutedCaseCount,19);assert.equal(body.targetMet,false);
  save({...failed,format:'shuduo-full-lifecycle-evaluation/v1'});assert.equal((await request()).status,409);
  save(failed);const altered=structuredClone(frozenEvidence);altered.cases[0].original.usedTokens++;
  writeFileSync(join(fixtureRoot,'m1-code-evidence.json'),JSON.stringify(altered));assert.equal((await request()).status,409);
 }finally{await new Promise(resolve=>app.server.close(resolve));store.close();}
});
