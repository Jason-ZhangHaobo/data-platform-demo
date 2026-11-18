import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {agentConsumptionLocation,agentConsumptionReceiptSelection,agentConsumptionRequestMarker,agentConsumptionTarget,checkedAgentConsumptionReceipt} from '../../web/src/agent-consumption-view.ts';

const entry='https://fictional.example/v2/?module=services';

const consumptionSelection=()=>({sourceBinding:{taskId:randomUUID(),releaseId:randomUUID(),packageDigest:'a'.repeat(64),sourceReleaseRunId:randomUUID()},
  applicationId:randomUUID(),dapiVersionId:randomUUID(),xapiVersionId:randomUUID()});

test('the receipt deep link binds the original scope and rejects incomplete or duplicate selection',()=>{
  const id=randomUUID(),scope=consumptionSelection(),url=agentConsumptionLocation(entry+'&unrelated=value',id,scope);
  assert.equal(agentConsumptionRequestMarker(url.href),id);
  assert.deepEqual(agentConsumptionReceiptSelection(url.href),scope);
  assert.equal(url.searchParams.has('unrelated'),false);
  assert.equal(url.hash,'#release-batch-consumption');
  assert.notEqual(url.search,agentConsumptionLocation(entry,id).search);
  const omitted=new URL(url);
  omitted.searchParams.delete('release_batch');
  assert.equal(agentConsumptionReceiptSelection(omitted.href),null);
  const doubled=new URL(url);
  doubled.searchParams.append('release_batch',randomUUID());
  assert.equal(agentConsumptionReceiptSelection(doubled.href),null);
  url.searchParams.append('agent_consumption_request',id);
  assert.equal(agentConsumptionRequestMarker(url.href),null);
  assert.equal(agentConsumptionReceiptSelection(url.href),null);
});

test('the workbench offers only the two authorized versions for the exact original batch',()=>{
  const taskId=randomUUID(),packageDigest='a'.repeat(64),batch={id:randomUUID(),releaseId:randomUUID(),sourceAgentTaskId:taskId,packageDigest};
  const pilotId='fictional-pilot',limits={timeoutMs:1500,rateLimitPerMinute:5};
  const dapis=['持仓','现金'].map((name,index)=>({name,slug:index?'cash':'holdings',fields:['client_id'],...limits}));
  const xapi={name:'客户资产组合',slug:'asset-combination',...limits,steps:[{alias:'holdings',dapiSlug:'holdings'},{alias:'cash',dapiSlug:'cash'}]};
  const scope={pilotId,taskId,plan:{taskId,packageDigest,sourceReleaseRunId:batch.id,dapis,xapi,applicationName:'虚构受邀应用',agentConsumptionAvailable:true}};
  const services=dapis.map(item=>{
    const version={id:randomUUID(),sourceReleaseRunId:batch.id,sourcePackageDigest:packageDigest,fields:item.fields,...limits};
    return {id:randomUUID(),pilotId,name:item.name,slug:item.slug,serviceType:'DAPI',status:'PUBLISHED',currentVersion:version,publishedVersion:version};
  });
  const xapiVersion={id:randomUUID(),...limits,steps:xapi.steps.map((step,index)=>({alias:step.alias,dapiId:services[index].id,dapiVersionId:services[index].publishedVersion.id}))};
  services.push({id:randomUUID(),pilotId,name:xapi.name,slug:xapi.slug,serviceType:'XAPI',status:'PUBLISHED',currentVersion:xapiVersion,publishedVersion:xapiVersion});
  const app={id:randomUUID(),pilotId,name:scope.plan.applicationName,status:'ACTIVE',scope:'PRIVATE_CLOUD_TEST',serviceIds:[services[0].id,services[2].id]};
  const target=agentConsumptionTarget(scope,batch,services,[app]);
  assert.equal(target.input.applicationId,app.id);
  assert.equal(target.input.dapiVersionId,services[0].publishedVersion.id);
  assert.equal(target.input.xapiVersionId,xapiVersion.id);
  assert.equal(agentConsumptionTarget(scope,{...batch,id:randomUUID()},services,[app]),undefined);
  assert.equal(agentConsumptionTarget(scope,batch,services,[{...app,serviceIds:[services[2].id]}]),undefined);
  assert.equal(agentConsumptionTarget({...scope,plan:{...scope.plan,agentConsumptionAvailable:undefined}},batch,services,[app]),undefined);
});

test('receipt projection verifies request and versions and keeps untrusted fields out of the view',()=>{
  const candidate=consumptionSelection();
  const requestId=randomUUID(),receipt={...candidate,requestId,wakeId:randomUUID(),protocol:'shuduo-agent-consumption-wake/v1',
    state:'COMPLETED',agentInitiated:true,externalSystemVerified:false,token:'fictional-must-not-display',calls:['DAPI','XAPI'].map((type,index)=>({
      type,versionId:index?candidate.xapiVersionId:candidate.dapiVersionId,serviceId:randomUUID(),callIdDigest:(index?'b':'c').repeat(64),
      rowsDigest:'d'.repeat(64),paginationDigest:'e'.repeat(64),rowCount:2}))};
  const checked=checkedAgentConsumptionReceipt(receipt,requestId,candidate);
  assert.deepEqual(checked.calls.map(call=>call.type),['DAPI','XAPI']);
  assert.doesNotMatch(JSON.stringify(checked),/fictional-must-not-display/);
  assert.throws(()=>checkedAgentConsumptionReceipt(receipt,randomUUID()),/不一致/);
  assert.throws(()=>checkedAgentConsumptionReceipt(receipt,requestId,{...candidate,xapiVersionId:randomUUID()}),/不一致/);
  assert.throws(()=>checkedAgentConsumptionReceipt({...receipt,calls:receipt.calls.slice(0,1)},requestId),/不一致/);
  const wrongBatch=agentConsumptionLocation(entry,requestId,candidate);
  wrongBatch.searchParams.set('release_batch',randomUUID());
  assert.throws(()=>checkedAgentConsumptionReceipt(receipt,requestId,agentConsumptionReceiptSelection(wrongBatch.href)),
    {code:'AGENT_CONSUMPTION_SCOPE_MISMATCH'});
});
