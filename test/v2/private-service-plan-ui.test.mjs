import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import React from 'react';
import ts from 'typescript';
import {renderToStaticMarkup} from 'react-dom/server';
import {durableServiceFixture} from './fixtures/durable-service-agent.mjs';
import {checkedPrivateServicePlan,servicePlanningWindowOpen,samePlanningWindow} from '../../web/src/private-service-plan.ts';
import {sourcePlanReceiptValid,createServicePlanSubmission} from '../../web/src/service-plan-source.ts';
import {privatePayload} from '../../scripts/run-v2-cloudshell-preview.mjs';

const binding=f=>({taskId:f.agent.id,packageDigest:f.bundle.digest,releaseId:f.release.id,sourceKind:'MANUAL',scope:'PRIVATE_CLOUD_TEST',revisionId:f.run.sourceRevisionId??f.bundle.manifest.source.revisionId,runId:f.bundle.manifest.source.runId});
test('private UI receipts retain original source and global window accounting without weakening the local receipt contract',async t=>{
 const f=await durableServiceFixture(t,{manual:true}),source=f.sourceBinding,b=binding(f),made=(await f.create()).body;
 const queued=checkedPrivateServicePlan(made,source,b);assert.equal(queued.stage,'READY_FOR_MODEL');assert.equal(queued.quota.attemptsUsed,0);assert.equal(sourcePlanReceiptValid(made,source),false);
 const ready=(await f.call('/data-services/agent/plans/'+made.id+'/advance',{expectedVersion:made.version},f.a)).body;
 assert.equal(checkedPrivateServicePlan(ready,source,b).proposal.serviceType,'DAPI');assert.equal(ready.quota.attemptsUsed,1);assert.equal(ready.quota.usedTokens,700);
 for(const mutate of [p=>{p.scope='LOCAL_TEST_ONLY';},p=>{p.sourceBinding.releaseId=f.agent.id;},p=>{p.sourceRunId=f.run.id;},p=>{p.sourceKind='AGENT';},p=>{p.recovery.backgroundDispatcherVerified=true;},
  p=>{p.status='SUCCEEDED';p.stage='MODEL_OUTCOME_UNKNOWN';},p=>{p.quota.usedTokens=0;},p=>{p.usedTokens=1;},p=>{p.proposalHash='bad';},p=>{p.proposal.fields=['unknown'];},p=>{p.durable={leaseToken:'DO_NOT_ACCEPT'};},p=>{p.attempts[0].diagnostic={code:'X',phase:'REQUEST',requestMayHaveBeenSent:true,elapsedMs:1,rawBody:'DO_NOT_ACCEPT'};}]){
  const bad=structuredClone(ready);mutate(bad);assert.throws(()=>checkedPrivateServicePlan(bad,source,b));
 }
 f.store.update('release',f.release.id,f.project,{health:'NEEDS_ATTENTION'});const historical=(await f.call('/data-services/agent/plans/'+made.id,undefined,f.a)).body;
 assert.equal(checkedPrivateServicePlan(historical,source,b).sourceCheck,'UNAVAILABLE');assert.equal(f.counts().calls,1);
});

test('session discovery narrows the selected user to planning, masks other users, and public HTTP stays read-only',async t=>{
 const f=await durableServiceFixture(t),own=(await f.call('/auth/session',undefined,f.a)).body,other=(await f.call('/auth/session',undefined,f.b)).body;
 assert.equal(own.servicePlanningOnly,true);assert.deepEqual(own.permissions,['SESSION','SERVICES']);assert.equal(own.readOnly,false);assert.equal(own.servicePlanning.enabled,true);
 assert.deepEqual(other.servicePlanning,{enabled:false});assert.equal(other.readOnly,true);assert.deepEqual(other.permissions,['SESSION']);
 for(const name of ['bill','spendCny','unsettledReserveCny','endpointHash','fingerprint'])assert.equal(JSON.stringify(own.servicePlanning).includes(name),false,name);
 assert.equal(servicePlanningWindowOpen(own.servicePlanning,f.sourceBinding,f.now()),true);assert.equal(servicePlanningWindowOpen(own.servicePlanning,{...f.sourceBinding,sourceReleaseRunId:f.agent.id},f.now()),false);
 const made=(await f.create()).body;assert.equal(samePlanningWindow(checkedPrivateServicePlan(made,f.sourceBinding,{taskId:f.agent.id,packageDigest:f.bundle.digest,releaseId:f.release.id,sourceKind:'AGENT',scope:'PRIVATE_CLOUD_TEST'}),own.servicePlanning),true);
 const publicView=(await f.call('/auth/session',undefined,f.a,undefined,true)).body;assert.equal(publicView.readOnly,true);assert.deepEqual(publicView.servicePlanning,{enabled:false});
 f.moveClock(600001);const closed=(await f.call('/auth/session',undefined,f.a)).body;assert.equal(closed.servicePlanning.enabled,false);assert.deepEqual(closed.permissions,['SESSION','SERVICES']);assert.equal(closed.readOnly,false,'the original owner may still cancel');
});
test('changed window configuration is not advertised as writable during session recovery',async t=>{
 const f=await durableServiceFixture(t);await f.create();f.env.V2_PRIVATE_SERVICE_AGENT_PROFILE=JSON.stringify({...f.profile,maxPlans:2});const changed=await f.start();
 const session=(await changed.call('/auth/session',undefined,changed.a)).body;assert.equal(session.servicePlanning.enabled,false);assert.equal(session.servicePlanning.reason,'BOUNDARY_CHANGED');assert.deepEqual(session.permissions,['SESSION','SERVICES']);
});

test('the same submission controller recovers the original private task before acknowledging a lost create reply',async t=>{
 const f=await durableServiceFixture(t,{manual:true}),b=binding(f),seen=[],pending=[];let original;
 const api=async(path,body,options)=>{seen.push({path,body,options});const r=await f.call(path,body,f.a,options?.idempotencyKey);
  if(r.status>=400)throw Object.assign(Error(r.body.message),{status:r.status});if(body){original=r.body;throw Error('synthetic reply lost');}return r.body;};
 const c=createServicePlanSubmission({api,onPending:key=>pending.push(key)});await assert.rejects(c.submit({message:'恢复原私有接口规划请求',sourceBinding:f.sourceBinding}));const request=c.snapshot().key;
 const recovered=checkedPrivateServicePlan(await c.recover(),f.sourceBinding,b);assert.equal(recovered.id,original.id);assert.equal(recovered.requestId,request);assert.equal(c.snapshot().key,request);c.acknowledge(request);
 assert.equal(c.snapshot().key,undefined);assert.equal(seen.filter(call=>call.body).length,1);assert.equal(f.counts().calls,0);
});

test('private preview planning writes require a distinct flag, while old data-service access only restores or cancels original tasks',()=>{
 const id='00000000-0000-4000-8000-000000000001',paths=['/api/v2/data-services/agent/plans',`/api/v2/data-services/agent/plans/${id}/advance`,`/api/v2/data-services/agent/plans/${id}/apply`];
 for(const path of paths){assert.throws(()=>privatePayload('POST',path,{},{} ,{allowDataServices:true}),e=>e.status===404);const value=privatePayload('POST',path,{authorization:'Bearer never-forward','x-actor-id':'other',cookie:'aliyun_token=never; shuduo_session=synthetic'},{} ,{allowDataServices:true,allowServiceAgent:true});assert.equal(value.headers.authorization,undefined);assert.equal(value.headers['x-actor-id'],undefined);assert.equal(value.headers.cookie,'shuduo_session=synthetic');}
 assert.throws(()=>privatePayload('POST',paths[0],{},{} ,{allowServiceAgent:true}),e=>e.status===422);
 assert.equal(privatePayload('GET',`/api/v2/data-services/agent/requests/${id}`,{},undefined,{allowDataServices:true}).method,'GET');
 assert.equal(privatePayload('POST',`/api/v2/data-services/agent/plans/${id}/cancel`,{},{} ,{allowDataServices:true}).method,'POST');
});

const compile=()=>{
 let code=ts.transpileModule(readFileSync('web/src/PrivateServiceAgentStudio.tsx','utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
 for(const name of ['react','react/jsx-runtime','lucide-react'])code=code.replaceAll(`from "${name}"`,`from ${JSON.stringify(import.meta.resolve(name))}`).replaceAll(`from '${name}'`,`from ${JSON.stringify(import.meta.resolve(name))}`);
 for(const helper of ['service-plan-source','private-service-plan'])code=code.replaceAll(`from './${helper}'`,`from ${JSON.stringify(new URL(`../../web/src/${helper}.ts`,import.meta.url).href)}`).replaceAll(`from "./${helper}"`,`from ${JSON.stringify(new URL(`../../web/src/${helper}.ts`,import.meta.url).href)}`);
 return 'data:text/javascript;base64,'+Buffer.from(code).toString('base64');
};
const {PrivateServiceAgentStudio}=await import(compile());
test('actual private studio rendering separates save, paid advance and draft confirmation without fetching on render',()=>{
 let calls=0;const props={api:async()=>{calls++;throw Error('render cannot call API');},binding:{taskId:'00000000-0000-4000-8000-000000000001',packageDigest:'a'.repeat(64),releaseId:'00000000-0000-4000-8000-000000000002',sourceKind:'AGENT',scope:'PRIVATE_CLOUD_TEST'},readEnabled:true,planningEnabled:true,transportEnabled:false,canAct:false,modelConfigured:true,onBusyChange:()=>{},onApplied:async()=>{},onRefreshSource:async()=>{}};
 const html=renderToStaticMarkup(React.createElement(PrivateServiceAgentStudio,props));assert.match(html,/持久私有服务规划/);assert.match(html,/此通道未开放新规划步骤/);assert.match(html,/disabled=""[^>]*>[\s\S]*?保存规划任务/);assert.doesNotMatch(html,/确认重试模型/);assert.equal(calls,0);
 const source={taskId:props.binding.taskId,packageDigest:props.binding.packageDigest,releaseId:props.binding.releaseId,sourceReleaseRunId:'00000000-0000-4000-8000-000000000003'},access={enabled:true,id:'00000000-0000-4000-8000-000000000004',sourceBinding:source,startsAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),maxPlans:2};
 const mismatched=renderToStaticMarkup(React.createElement(PrivateServiceAgentStudio,{...props,canAct:true,transportEnabled:true,access,verifiedSource:{...source,sourceReleaseRunId:'00000000-0000-4000-8000-000000000005'}}));
 assert.match(mismatched,/当前发布批次不属于此执行窗口/);assert.doesNotMatch(mismatched,/当前窗口已保存 0/);
 const loading=renderToStaticMarkup(React.createElement(PrivateServiceAgentStudio,{...props,canAct:true,transportEnabled:true,access,verifiedSource:source}));assert.match(loading,/正在读取当前窗口任务数/);assert.doesNotMatch(loading,/当前窗口已保存 0/);assert.equal(calls,0);
});
