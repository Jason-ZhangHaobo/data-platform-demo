import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {pinInvitedPublication,pinInvitedBatch,invitedTaskSelection,invitedEditorLocation} from '../../web/src/invited-task-location.ts';
import {prepareInvitedServices,readInvitedServiceCatalog,checkedInvitedApplications,invitedConsumptionRequestId,invitedConsumptionRequests,invitedConsumptionWritable} from '../../web/src/invited-batch-services.ts';
import {runInvitedConsumptionPages,checkedConsumerPage,invitedPagePlan} from '../../web/src/invited-consumption-pages.ts';
import {reportEvidenceDigest} from '../../src/v2/report-provenance-client.mjs';

const uuid=randomUUID;

test('the selected batch and original request survive an editor round trip without binding a different batch',()=>{
  const source={taskId:uuid(),contextId:'holdings-t1',revisionId:uuid(),revisionHash:'a'.repeat(64),runId:uuid()};
  const releaseId=uuid(),pair=[uuid(),uuid()],request=uuid();
  const start='https://demo.invalid/v2/?module=agent-center&task='+source.taskId+'#agent-chat';
  const published=pinInvitedPublication(start,source,uuid(),undefined,releaseId);
  const selected=pinInvitedBatch(published.href,releaseId,pair,pair[1],request);
  const returned=invitedEditorLocation(selected.href,source,source);
  assert.equal(returned.searchParams.get('invited_batch'),pair[1]);
  assert.equal(returned.searchParams.get('invited_consume_request'),request);
  assert.equal(pinInvitedBatch(returned.href,releaseId,pair,pair[0]).searchParams.has('invited_consume_request'),false);
  assert.throws(()=>pinInvitedBatch(selected.href,releaseId,pair,uuid()));
  assert.throws(()=>pinInvitedBatch(selected.href,uuid(),pair,pair[1]));
  for(const mutate of [q=>q.delete('invited_release'),q=>q.delete('invited_batch'),q=>q.append('invited_consume_request',request)]){
    const copy=new URL(selected);mutate(copy.searchParams);assert.equal(invitedTaskSelection(copy.href),null);
  }
});

function fixture(t,total=2){
  const now=Date.now(),source={taskId:uuid(),packageDigest:'b'.repeat(64),releaseId:uuid(),runId:uuid(),revisionId:uuid(),
    scope:'PRIVATE_CLOUD_TEST',sourceKind:'AGENT'},batchId=uuid(),limits={timeoutMs:2000,rateLimitPerMinute:6},
    dapis=['holdings','cash'].map((slug,index)=>({slug,name:'测试 '+slug,fields:['client_id',index?'total_assets':'holding_market_value'],...limits})),
    xapi={name:'测试组合',slug:'summary',steps:dapis.map(s=>({alias:s.slug,dapiSlug:s.slug})),...limits};
  const scope={taskId:source.taskId,pilotId:'c'.repeat(64),startsAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+120000).toISOString(),
    plan:{taskId:source.taskId,packageDigest:source.packageDigest,sourceReleaseRunId:batchId,applicationName:'虚构应用',dapis,xapi,agentConsumptionAvailable:true}};
  const all=dapis.map(spec=>{
    const version={id:uuid(),sourceReleaseRunId:batchId,sourcePackageDigest:source.packageDigest,fields:spec.fields,configHash:'e'.repeat(64),...limits};
    return {scope:source.scope,serviceType:'DAPI',slug:spec.slug,id:uuid(),pilotId:scope.pilotId,name:spec.name,status:'PUBLISHED',currentVersion:version,publishedVersion:version};
  });
  const steps=all.map(s=>({alias:s.slug,dapiId:s.id,dapiVersionId:s.currentVersion.id}));
  const xv={id:uuid(),configHash:'f'.repeat(64),steps,...limits};
  all.push({scope:source.scope,serviceType:'XAPI',slug:xapi.slug,id:uuid(),name:xapi.name,pilotId:scope.pilotId,status:'PUBLISHED',currentVersion:xv,publishedVersion:xv});
  const run={id:batchId,releaseId:source.releaseId,sourceAgentTaskId:source.taskId,scope:source.scope,sourceRevisionId:source.revisionId,sourceRunId:source.runId,
    status:'SUCCEEDED',published:true,schedulerTriggered:true,engine:'Apache Spark',mainSqlExecuted:true,testSqlValidation:{passed:true},validation:{passed:true},packageDigest:source.packageDigest,rowCount:total};
  const rows={DAPI:[{client_id:'A',holding_market_value:'5.00'},{client_id:'B',holding_market_value:'6.00'}],
    XAPI:[{client_id:'A',holdings:{holding_market_value:'5.00'},cash:{total_assets:'8.00'}},{client_id:'B',holdings:{holding_market_value:'6.00'},cash:{total_assets:'9.00'}}]};
  for(const type of ['DAPI','XAPI'])rows[type]=Array.from({length:total},(_,i)=>({...rows[type][i%2],client_id:i<2?'AB'[i]:'CLIENT-'+i}));
  const app={id:uuid(),scope:source.scope,pilotId:scope.pilotId,pilotStartsAt:Date.parse(scope.startsAt),name:scope.plan.applicationName,
    expiresAt:scope.expiresAt,status:'ACTIVE',serviceIds:[all[0].id,all[2].id]};
  let issued=false,requestId,posts=0,badRows=false,checks=0;
  const api=async(path,body,options)=>{
    if(body===undefined){
      if(path.startsWith('/data-services/sources?'))return [run];
      if(path.endsWith('applications'))return issued?[app]:[];
      if(path.endsWith('dapis'))return all.slice(0,2);
      if(path.endsWith('xapis'))return all.slice(2);
    }else{
      posts++;
      if(path.endsWith('/applications')){
        assert.equal(issued,false);issued=true;
        return {application:app,tokenShownOnce:true,token:'sz_'+'private_'+'x'.repeat(32)};
      }
      if(path.endsWith('/consumption-jobs')){
        assert.equal(options.idempotencyKey,requestId);
        return {...body,requestId,wakeId:uuid(),protocol:'shuduo-agent-consumption-wake/v1',state:'COMPLETED',agentInitiated:true,externalSystemVerified:false,
          calls:await Promise.all([all[0],all[2]].map(async s=>({type:s.serviceType,versionId:s.publishedVersion.id,serviceId:s.id,rowCount:total,
            rowsDigest:await reportEvidenceDigest(rows[s.serviceType]),callIdDigest:await reportEvidenceDigest(s.id),paginationDigest:'d'.repeat(64)})))};
      }
      if(path==='/data-services/applications/'+app.id+'/revoke'){app.status='REVOKED';return app;}
    }
    throw Error('Unexpected management request');
  };
  const original=Object.getOwnPropertyDescriptor(globalThis,'location');
  Object.defineProperty(globalThis,'location',{configurable:true,value:new URL('https://demo.invalid/v2/')});
  t.after(()=>original?Object.defineProperty(globalThis,'location',original):delete globalThis.location);
  t.mock.method(globalThis,'fetch',async(path,options)=>{
    assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');assert.ok(options.headers.Authorization);
    const url=new URL(path,location);assert.equal(url.origin,location.origin);assert.equal(url.searchParams.size,2);
    const {pageSize,totalPages}=invitedPagePlan(total);assert.equal(Number(url.searchParams.get('page_size')),pageSize);
    checks++;
    if(app.status==='REVOKED')return Response.json({code:'TOKEN_INVALID'},{status:401});
    const s=url.pathname.includes('/dapis/')?all[0]:all[2],page=Number(url.searchParams.get('page'));
    return Response.json({scope:source.scope,localTestOnly:false,callId:uuid(),service:{type:s.serviceType,id:s.id,slug:s.slug,versionId:s.publishedVersion.id,...(s.serviceType==='XAPI'?{steps}:{})},
      data:badRows?[{client_id:'wrong'}]:rows[s.serviceType].slice((page-1)*pageSize,page*pageSize),pagination:{page,pageSize,total,totalPages}});
  });
  const perform=(transport=api)=>runInvitedConsumptionPages(transport,scope,source,batchId,()=>{},id=>{requestId=id;},()=>{});
  return {source,scope,batchId,perform,app,api,services:all,counts:()=>[posts,checks],badRows:()=>{badRows=true;}};
}
test('one short grant binds the signed request, four credential-only pages, revocation and refusal',async t=>{
  const f=fixture(t);
  assert.deepEqual(await f.perform(),[{clientId:'A',assets:'8.00'},{clientId:'B',assets:'9.00'}]);
  assert.deepEqual(f.counts(),[3,5]);assert.equal(f.app.status,'REVOKED');
  await assert.rejects(f.perform());assert.deepEqual(f.counts(),[3,5]);
  const reopened=await readInvitedServiceCatalog(f.api,f.scope,f.source,f.batchId);
  assert.equal(reopened.grantCurrent,true);assert.equal(JSON.stringify(reopened).includes('token'),false);
  const altered={...f.scope,startsAt:new Date(Date.parse(f.scope.startsAt)+1).toISOString()};
  assert.equal((await readInvitedServiceCatalog(f.api,altered,f.source,f.batchId)).grantCurrent,false);
  assert.equal(invitedConsumptionWritable(f.scope,f.source,f.batchId,{canConsume:true,sessionExpiresAt:f.scope.expiresAt}),true);
  assert.equal(invitedConsumptionWritable(f.scope,f.source,uuid(),{canConsume:true,sessionExpiresAt:f.scope.expiresAt}),false);
  assert.equal(invitedConsumptionWritable(f.scope,f.source,f.batchId,{canConsume:true,sessionExpiresAt:f.scope.expiresAt},Date.parse(f.scope.expiresAt)),false);
});

test('altered page rows stop the run and revoke the new grant; original requests cannot cross batches',async t=>{
  const f=fixture(t);f.badRows();await assert.rejects(f.perform(),/原批次/);
  assert.equal(f.app.status,'REVOKED');assert.deepEqual(f.counts(),[3,2]);
  const sourceBinding={taskId:f.source.taskId,releaseId:f.source.releaseId,packageDigest:f.source.packageDigest,sourceReleaseRunId:f.batchId};
  const body={sourceBinding,applicationId:f.app.id,dapiVersionId:uuid(),xapiVersionId:uuid()},requestId=await invitedConsumptionRequestId(body);
  assert.equal(await invitedConsumptionRequestId(body),requestId);
  assert.notEqual(await invitedConsumptionRequestId({...body,applicationId:uuid()}),requestId);
  assert.deepEqual(invitedConsumptionRequests([{...body,requestId}],f.source,f.batchId),[{...body,requestId}]);
  assert.throws(()=>invitedConsumptionRequests([{...body,requestId}],f.source,uuid()));
  assert.throws(()=>checkedConsumerPage({}, {},1,invitedPagePlan(2)));
});

for(const count of [1,3,100])test('the original signed '+count+' rows require at most two complete pages per interface',async t=>{
  const f=fixture(t,count);
  assert.equal((await f.perform()).length,count);
  assert.deepEqual(f.counts(),[3,count===1?3:5]);
});
test('row counts outside the signed query limit cannot issue a pagination grant',async t=>{
  const f=fixture(t,101);await assert.rejects(f.perform(),/1–100/);
  assert.deepEqual(f.counts(),[0,0]);
});

test('interrupted preparation finds the issued draft and the previously passed test before publishing once',async t=>{
  const f=fixture(t),drafts=[],tested=new Set(),creates=[],successfulPublishes=[];
  let lost=true;
  const api=async(path,body,options)=>{
    if(path.includes('/sources?')||path.endsWith('/applications'))return f.api(path,body,options);
    const [,resource,id,action]=path.split('/').slice(1),type=resource==='dapis'?'DAPI':'XAPI';
    if(body===undefined)return id?drafts.find(s=>s.id===id):drafts.filter(s=>s.serviceType===type);
    if(!id){
      const src=f.services.find(s=>s.slug===body.slug);
      assert.ok(src);assert.ok(!drafts.some(s=>s.id===src.id));
      const draft={...src,status:'DRAFT',publishedVersion:undefined};
      drafts.push(draft);creates.push(options.idempotencyKey);return draft;
    }
    const draft=drafts.find(s=>s.id===id);assert.ok(draft);
    if(action==='test'){
      assert.ok(!tested.has(id));tested.add(id);
      if(lost){lost=false;throw Error('Test response unavailable');}
      return {test:{status:'PASSED',versionId:draft.currentVersion.id,configHash:draft.currentVersion.configHash}};
    }
    assert.equal(action,'publish');
    if(!tested.has(id))throw Object.assign(Error(),{code:'SERVICE_TEST_REQUIRED'});
    draft.status='PUBLISHED';draft.publishedVersion=draft.currentVersion;successfulPublishes.push(id);return {};
  };
  const prepare=()=>prepareInvitedServices(api,f.scope,f.source,f.batchId,()=>{});
  await assert.rejects(prepare(),/Test response unavailable/);
  await prepare();await prepare();
  assert.equal(new Set(creates).size,3);assert.equal(tested.size,3);assert.equal(successfulPublishes.length,3);
  assert.equal(f.counts()[0],0);
});

test('issued applications show only allowlisted details for the selected service set',()=>{
  const serviceId=uuid(),applicationId=uuid(),now=new Date().toISOString();
  const app={applicationId,name:'历史测试应用',serviceIds:[serviceId],status:'REVOKED',expiresAt:now,createdAt:now,revokedAt:now,
    tokenPrefix:'private-field',unrelated:'unknown-field'};
  const safe=checkedInvitedApplications([app],[serviceId],false);
  assert.equal(safe[0].applicationId,applicationId);assert.equal(safe[0].revokedAt,now);
  assert.doesNotMatch(JSON.stringify(safe),/private-field|unknown-field/);
  assert.throws(()=>checkedInvitedApplications([app],[uuid()],false));
});

for(const fault of ['catalog disconnect','catalog app changed','issuance response lost','neighboring window response','idempotent replay']){
  test('pagination cleanup uses only the confirmed original issuance after '+fault,async t=>{
    const f=fixture(t),revoked=[],neighbor=uuid();
    let issued=false;
    const transport=async(path,body,options)=>{
      if(body===undefined&&issued&&path.endsWith('/applications')){
        if(fault==='catalog disconnect')throw Error('Read interrupted');
        if(fault==='catalog app changed')return [{...f.app,id:neighbor}];
      }
      if(path.endsWith('/revoke'))revoked.push(path);
      const response=await f.api(path,body,options);
      if(body!==undefined&&path.endsWith('/applications')){
        issued=true;
        if(fault==='issuance response lost')throw Error('Issuance response unavailable');
        if(fault==='neighboring window response')return {...response,application:{...f.app,id:neighbor,pilotStartsAt:f.app.pilotStartsAt+1}};
        if(fault==='idempotent replay')return {application:f.app,tokenShownOnce:false,token:null};
      }
      return response;
    };
    await assert.rejects(f.perform(transport));
    const confirmed=fault.startsWith('catalog');
    assert.deepEqual(revoked,confirmed?['/data-services/applications/'+f.app.id+'/revoke']:[]);
    assert.equal(f.app.status,confirmed?'REVOKED':'ACTIVE');
    const recovered=await readInvitedServiceCatalog(f.api,f.scope,f.source,f.batchId);
    assert.equal(recovered.target.application.id,f.app.id);
    await assert.rejects(f.perform());
    assert.deepEqual(f.counts(),[confirmed?2:1,0]);
  });
}
