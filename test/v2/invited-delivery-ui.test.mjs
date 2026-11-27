import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {invitedRehearsalStatus,invitedDeliveryWriteWindow} from '../../web/src/invited-delivery-state.ts';
import {pinInvitedDelivery,pinInvitedPublication,invitedPublicationPin,invitedEditorSource,invitedEditorLocation,invitedTaskSelection} from '../../web/src/invited-task-location.ts';
import {validationFamilyForContextId} from '../../web/src/validation-family.ts';

const taskId=randomUUID(),other=randomUUID(),now=Date.now();
const source={taskId,requestId:'original-request',contextId:'cash-change',revisionId:randomUUID(),revisionHash:'b'.repeat(64),runId:randomUUID()};
const start='https://example.invalid/v2/?module=agent-center&task='+taskId+'&invited_request=original-request#agent-chat';
const access={deliverySupported:true,developmentOnly:true,canWrite:true,windowTaskId:taskId,
  startsAt:new Date(now-60000).toISOString(),expiresAt:new Date(now+60000).toISOString(),sessionExpiresAt:new Date(now+60000).toISOString()};

test('invited delivery writes use the active window for the selected existing task',()=>{
  assert.equal(invitedDeliveryWriteWindow(access,taskId,now),true);
  assert.equal(invitedDeliveryWriteWindow({...access,taskOnly:true,targetTaskId:taskId},taskId,now),true);
  for(const edit of [{deliverySupported:false},{developmentOnly:false},{canWrite:false},{taskOnly:true},{targetTaskId:other,taskOnly:true},
    {windowTaskId:other},{startsAt:'unknown'},{expiresAt:new Date(now).toISOString()},{sessionExpiresAt:new Date(now).toISOString()}])
    assert.equal(invitedDeliveryWriteWindow({...access,...edit},taskId,now),false);
});

test('unknown preparation and rehearsal stay on the original version after a cold reopen',()=>{
  const request=randomUUID(),deliveryId=randomUUID();
  const prepared=pinInvitedDelivery(start,source,'prepare',request);
  const rehearsal=pinInvitedDelivery(prepared.href,source,'rehearse',deliveryId);
  assert.equal(rehearsal.hash,'#agent-chat');
  assert.equal(rehearsal.searchParams.get('invited_package_request'),request);
  assert.equal(rehearsal.searchParams.get('invited_rehearsal'),deliveryId);
  assert.deepEqual(invitedEditorSource(rehearsal.href),source);
  assert.deepEqual(invitedTaskSelection(rehearsal.href),{taskId,requestId:'original-request'});
  assert.throws(()=>pinInvitedDelivery(prepared.href,{...source,runId:other},'rehearse',deliveryId));
  const editor=invitedEditorLocation(rehearsal.href,source,source);
  assert.equal(editor.searchParams.get('invited_rehearsal'),deliveryId);
  assert.equal(editor.searchParams.get('invited_package_request'),request);
  assert.equal(invitedEditorLocation(rehearsal.href,source,{...source,runId:other}).searchParams.has('invited_rehearsal'),false);
  for(const mutate of [q=>q.delete('invited_hash'),q=>q.delete('invited_run'),q=>q.set('invited_rehearsal','wrong'),
    q=>q.append('invited_package_request',other),q=>q.set('change_request',other)]){
    const url=new URL(rehearsal.href);mutate(url.searchParams);assert.equal(invitedTaskSelection(url.href),null);
  }
});

test('a completed Spark record needs the original signed evidence and the full regression family to show verified',()=>{
  const family=validationFamilyForContextId('cash-change'),report={contextId:'cash-change',validationContractId:family.id};
  const verification={status:'SUCCEEDED',engine:'Apache Spark',engineVersion:'3.5.9',mainSqlExecuted:true,testSqlValidation:{passed:true},
    validation:{passed:true,contractId:family.id,regressions:family.contextIds.map(contextId=>({contextId,passed:true}))}};
  const workflow={report,delivery:{status:'SUCCEEDED'},package:{},verification,invitedRehearsalEvidence:'VERIFIED'};
  assert.equal(invitedRehearsalStatus(workflow,false),'演练通过');
  for(const patch of [{invitedRehearsalEvidence:'UNCONFIRMED'},{invitedRehearsalEvidence:undefined},{verification:{...verification,engineVersion:undefined}},
    {verification:{...verification,validation:{...verification.validation,regressions:verification.validation.regressions.slice(1)}}}])
    assert.match(invitedRehearsalStatus({...workflow,...patch},false),/待核对/);
  assert.match(invitedRehearsalStatus({report,package:{},delivery:{stage:'PACKAGE_READY'}},true),/委托待核对/);
  assert.match(invitedRehearsalStatus({report,verification:{status:'FAILED'},invitedRehearsalEvidence:'FAILED'},false),/^演练失败$/);
  assert.match(invitedRehearsalStatus({report,verification:{status:'FAILED'}},false),/失败记录待核对/);
});

test('a reopened approval keeps its exact version, rehearsal, original window and release through the editor',()=>{
  const webWindow={startsAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+60000).toISOString()};
  const approval={requestId:'approval-'+'b'.repeat(64),reviewDigest:'c'.repeat(64),...webWindow};
  const deliveryId=randomUUID(),releaseId=randomUUID();
  const review=pinInvitedPublication(start,source,deliveryId,approval);
  assert.deepEqual(invitedPublicationPin(review.href),{approval});
  const published=pinInvitedPublication(review.href,source,deliveryId,undefined,releaseId);
  assert.deepEqual(invitedPublicationPin(published.href),{approval,releaseId});
  assert.deepEqual(invitedEditorSource(published.href),source);
  assert.deepEqual(invitedPublicationPin(invitedEditorLocation(published.href,source,source).href),{approval,releaseId});
  assert.deepEqual(invitedPublicationPin(invitedEditorLocation(published.href,source,{...source,runId:other}).href),{});
  assert.throws(()=>pinInvitedPublication(published.href,source,deliveryId,undefined,other));
  assert.throws(()=>pinInvitedPublication(published.href,source,other,undefined,releaseId));
  for(const mutate of [q=>q.delete('invited_review'),q=>q.delete('invited_rehearsal'),q=>q.set('invited_release','other'),
    q=>q.set('invited_approval','arbitrary'),q=>q.append('invited_approval',approval.requestId),
    q=>q.set('invited_starts',webWindow.expiresAt)]){
    const url=new URL(published.href);mutate(url.searchParams);assert.equal(invitedTaskSelection(url.href),null);
  }
});
