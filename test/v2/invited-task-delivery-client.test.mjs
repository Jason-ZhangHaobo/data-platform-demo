import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {existsSync,mkdtempSync,readFileSync,rmSync,statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MetadataStore} from '../../src/v2/store.mjs';
import {createDeliveryPackage,unpackDeliveryPackage,loadDeliveryDirectory} from '../../src/v2/delivery.mjs';
import {requirementDeliverySource} from './fixtures/requirement-delivery.mjs';
import {invitedTaskDeliveryPath} from '../../src/v2/invited-task-delivery.mjs';
import {readInvitedTaskDelivery} from '../../src/v2/invited-task-delivery-client.mjs';
import {runV2Cli} from '../../bin/shuduo.mjs';
import {handleV2Mcp} from '../../bin/shuduo-mcp.mjs';

function fixture(t){
  const store=new MetadataStore(':memory:');t.after(()=>store.close());
  const f=requirementDeliverySource(store,'project-securities-lab');
  const bundle={...createDeliveryPackage(f),id:randomUUID()};
  const selection={taskId:f.agent.id,runId:f.run.id,revisionId:f.revision.id,revisionHash:f.revision.hash,deliveryId:randomUUID()};
  const verification={id:randomUUID(),status:'SUCCEEDED',engine:'Apache Spark',mainSqlExecuted:true,
    testSqlValidation:{passed:true},validation:f.validation};
  const value={report:{schema:'shuduo-development-verification/v1',...selection,status:'PASSED',contextId:f.agent.contextId,
    validationContractId:f.family.id},publication:{scope:'PRIVATE_CLOUD_TEST'},package:bundle,verification,invitedRehearsalEvidence:'VERIFIED',
    delivery:{id:selection.deliveryId,status:'SUCCEEDED',sourceAgentTaskId:selection.taskId,
      sourceRunId:selection.runId,sourceRevisionId:selection.revisionId,sourceSqlHash:selection.revisionHash,
      packageId:bundle.id,packageDigest:bundle.digest,verificationId:verification.id}};
  const reads=[],client={request:async(path,options)=>{assert.equal(path,invitedTaskDeliveryPath(selection));assert.equal(options,undefined);reads.push(path);return value;}};
  return {bundle,selection,value,client,reads};
}

test('the invited CLI export can be unpacked offline and MCP reads the same pinned file bytes',async t=>{
  const {bundle,selection,client,reads}=fixture(t);
  const dir=mkdtempSync(join(tmpdir(),'invited-files-'));t.after(()=>rmSync(dir,{force:true,recursive:true}));
  const path=join(dir,'delivery.json');
  const args=['agent','invited-task-delivery','--id',selection.taskId,'--revision-id',selection.revisionId,
    '--revision-hash',selection.revisionHash,'--run-id',selection.runId,'--delivery-id',selection.deliveryId,
    '--download-digest',bundle.digest,'--out-file',path];
  let output,err;
  const invoke=argv=>runV2Cli(argv,{},{client,output:s=>{output=JSON.parse(s);},error:s=>{err=s;}});
  assert.equal(await invoke(args),0,err);assert.equal(output.saved,true);assert.equal(output.packageId,bundle.id);
  assert.equal(statSync(path).mode&0o777,0o600);
  const saved=JSON.parse(readFileSync(path,'utf8'));
  assert.deepEqual(saved.files,bundle.files);
  const extracted=join(dir,'offline');
  unpackDeliveryPackage(saved,extracted,bundle.digest);
  assert.deepEqual(loadDeliveryDirectory(extracted,bundle.digest).plan.order.map(node=>node.id),['execute','validate','evidence']);
  const rpc=JSON.parse(await handleV2Mcp({jsonrpc:'2.0',id:1,method:'tools/call',params:{
    name:'agent_invited_task_delivery',arguments:selection}},{client}));
  assert.deepEqual(rpc.result.structuredContent.package,saved);
  assert.equal(reads.length,2);
  assert.equal(await invoke(args),1);assert.equal(reads.length,2);
  const wrong=join(dir,'wrong.json');
  assert.equal(await invoke(args.map(s=>s===path?wrong:s===bundle.digest?'0'.repeat(64):s)),1);
  assert.equal(existsSync(wrong),false);
});

test('a changed task, revision, run, delivery, rehearsal or one edited schedule cannot be exported',async t=>{
  const {value,selection}=fixture(t);
  for(const change of [
    x=>{x.report.taskId=randomUUID();},x=>{x.report.revisionHash='0'.repeat(64);},x=>{x.delivery.sourceRunId=randomUUID();},
    x=>{x.delivery.id=randomUUID();},x=>{x.verification.id=randomUUID();},x=>{x.verification.testSqlValidation.passed=false;},
    x=>{x.verification.validation.regressions.pop();},
    x=>{x.package.files['schedule.json']+=' ';},x=>{delete x.package.files['deployment.json'];}
  ]){
    const record=structuredClone(value);change(record);
    await assert.rejects(readInvitedTaskDelivery({request:async()=>record},selection),/不一致/);
  }
});
