import test from 'node:test';
import assert from 'node:assert/strict';
import {frozenDeliveryMode} from '../../web/src/frozen-delivery-mode.ts';
import {deliveryStageText} from '../../web/src/agent-journey.ts';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function fixture(archive=true){
  const input={targetTable:'raw_positions',runId:id(4),targetHash:'a'.repeat(64),snapshotId:id(5),snapshotHash:'b'.repeat(64),taskId:id(6),sourceRevisionId:id(7),metadataVersionId:id(8),rowCount:4,
    ...(archive?{kind:'SYNC_RUN_ARCHIVE_V1',landingSnapshotHash:'c'.repeat(64)}:{})};
  return {task:{id:id(1),runId:id(2),revisionId:id(3),contextId:'holdings-t1',status:'SUCCEEDED',mode:'SYNTHETIC_MODEL',syncInput:structuredClone(input)},
    run:{id:id(2),revisionId:id(3),agentTaskId:id(1),contextId:'holdings-t1',status:'SUCCEEDED',syncInput:structuredClone(input)},revisionId:id(3)};
}
test('native archived and legacy frozen Agent runs retain their own Agent delivery workflow',()=>{
  for(const archive of [true,false])for(const mode of ['LIVE_MODEL','SYNTHETIC_MODEL']){const f=fixture(archive);f.task.mode=mode;assert.equal(frozenDeliveryMode(f),'AGENT');}
});
test('manual saved runs retain manual provenance; missing or mismatched native receipts do not fall back to manual delivery',()=>{
  const manual=fixture();delete manual.run.agentTaskId;manual.run.id=id(20);manual.run.revisionId=id(21);manual.revisionId=id(21);assert.equal(frozenDeliveryMode(manual),'MANUAL');delete manual.task;assert.equal(frozenDeliveryMode(manual),'MANUAL');
  assert.equal(frozenDeliveryMode({}),'UNCONFIRMED');
  for(const change of [f=>{f.task.runId=id(9);},f=>{f.run.agentTaskId=id(9);},f=>{f.run.revisionId=id(9);},f=>{f.revisionId=id(9);},f=>{f.task.sourceKind='MANUAL';},f=>{f.task.sourceAttribution={kind:'ENGINEER_REFERENCE'};},f=>{f.task.status='FAILED';},f=>{f.run.status='VALIDATION_FAILED';},f=>{f.task.contextId='stock-cash-t1';}]){
    const f=fixture();change(f);assert.equal(frozenDeliveryMode(f),'UNCONFIRMED');
  }
});
test('native delivery routing checks the full original sync identity, not just the development run',()=>{
  for(const field of ['targetTable','snapshotHash','snapshotId','runId','targetHash','taskId','sourceRevisionId','metadataVersionId','rowCount','kind','landingSnapshotHash']){
    const f=fixture();f.run.syncInput[field]='changed';assert.equal(frozenDeliveryMode(f),'UNCONFIRMED',field);
  }
  for(const field of ['snapshotHash','snapshotId','taskId','sourceRevisionId','metadataVersionId','rowCount']){
    const f=fixture();delete f.task.syncInput[field];delete f.run.syncInput[field];assert.equal(frozenDeliveryMode(f),'UNCONFIRMED',field);
  }
});
test('terminal delivery status cannot be rendered as an ongoing rehearsal or saving stage',()=>{
  assert.equal(deliveryStageText('FILE_REHEARSAL_RUNNING',false,undefined,true,'FAILED'),'文件演练失败，待处理');
  assert.equal(deliveryStageText('PACKAGE_PERSISTING',false,undefined,true,'FAILED'),'交付准备失败，待处理');
  assert.equal(deliveryStageText('FILE_REHEARSAL_RUNNING',false,undefined,true,'CANCELLED'),'交付准备已停止');
  assert.equal(deliveryStageText('FILE_REHEARSAL_RUNNING',false,undefined,true,'INTERRUPTED'),'交付已中断，结果待核对');
  assert.equal(deliveryStageText('FILE_REHEARSAL_RUNNING',false,undefined,false,'FAILED'),'原版本交付记录；当前修改待核验');
  assert.equal(deliveryStageText('FILE_REHEARSAL_RUNNING',false,undefined,true,'RUNNING'),'Spark 正在按交付文件演练');
});
