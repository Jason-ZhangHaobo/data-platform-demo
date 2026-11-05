import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {MetadataStore} from '../../../src/v2/store.mjs';
import {AuthManager} from '../../../src/v2/auth.mjs';
import {BusinessQueryStore} from '../../../src/v2/data-services.mjs';
import {createPrivateDataServices} from '../../../src/v2/private-data-services.mjs';
import {createV2Server,PROJECT} from '../../../src/v2/server.mjs';
import {createFcIngress} from '../../../src/v2/fc-ingress.mjs';
import {createDeliveryPackage,sha256} from '../../../src/v2/delivery.mjs';
import {referenceSqlForContext,getContext,validationFamilyForContext} from '../../../src/v2/context.mjs';
import {saveManualRevision} from '../../../src/v2/manual-revisions.mjs';
import {serviceAgentMonth} from '../../../src/v2/private-service-agent-policy.mjs';

// Actual HTTP/CSRF/auth/SQLite/budget/manager with synthetic model and release
// receipts. Public ingress is read-only; tests use the trusted loopback hop.
export async function durableServiceFixture(t,{profilePatch={},modelLeaseMs=90000,manual=false,eventMode=false}={}){
 const root=mkdtempSync(join(tmpdir(),'shuduo-durable-service-')),store=new MetadataStore(join(root,'platform.sqlite')),businessStore=new BusinessQueryStore(join(root,'business.sqlite'));
 let clock=Date.now(),calls=0,compute=0,flushes=0,failFlush=false,failAtFlush=0;
 const now=()=>clock,password='SyntheticService!2026',auth=new AuthManager({store,project:PROJECT,env:{},now});
 const owner=auth.bootstrapAdmin({email:'service-owner@example.invalid',password,displayName:'合成服务工程师'}),other=auth.bootstrapAdmin({email:'service-other@example.invalid',password,displayName:'合成另一工程师'});
 for(const value of [owner,other])store.update('auth_user',value.id,PROJECT,{memberships:[{projectId:PROJECT,role:'ENGINEER'}]});
 const agent=store.create('agent',PROJECT,{submittedBy:owner.id,contextId:'stock-cash-t1',status:'FAILED'}),contextId='stock-cash-t1',family=validationFamilyForContext(contextId),sql=referenceSqlForContext(contextId);
 const revision=manual?saveManualRevision({store,project:PROJECT,actor:owner.id,key:'synthetic-manual',sql,contextId,originAgentTaskId:agent.id}).revision:store.create('revision',PROJECT,{contextId,sql,hash:sha256(sql)});
 const validation={passed:true,contractId:family.id,regressions:family.contextIds.map(contextId=>({contextId,passed:true}))};
 const sourceRun=store.create('run',PROJECT,{revisionId:revision.id,revisionHash:revision.hash,contextId,status:'SUCCEEDED',engine:'Apache Spark',engineVersion:'3.5.9',mainSqlExecuted:true,isolation:'FUNCTION_PROCESS',validation,rows:getContext(contextId).expected});
 const bundle=store.create('delivery_package',PROJECT,{...createDeliveryPackage({run:sourceRun,revision}),sourceRunId:sourceRun.id,...(manual?{sourceKind:'MANUAL',agentIndependentE2E:false}:{})});
 const attribution=manual?{sourceKind:'MANUAL',sourceAttribution:'ENGINEER_ASSISTED',agentIndependentE2E:false,sourceRunId:sourceRun.id,submittedBy:owner.id}:{};
 const approval=store.create('release_approval',PROJECT,{...attribution,status:'APPROVED',packageId:bundle.id,packageDigest:bundle.digest,sourceRevisionId:revision.id,sourceCodeHash:revision.hash});
 const release=store.create('release',PROJECT,{...attribution,mode:'DURABLE_PRIVATE_RELEASE_V1',scope:'PRIVATE_CLOUD_TEST',status:'COMPLETED_CLOUD_TEST',health:'HEALTHY',sourceAgentTaskId:agent.id,sourceRevisionId:revision.id,sourceCodeHash:revision.hash,packageId:bundle.id,packageDigest:bundle.digest,approvalId:approval.id,publicDeployed:false});
 const run=store.create('release_run',PROJECT,{...attribution,sourceAgentTaskId:agent.id,releaseId:release.id,mode:release.mode,scope:release.scope,status:'SUCCEEDED',published:true,publicDeployed:false,schedulerTriggered:true,clockMode:'FC_TIMER',engine:'Apache Spark',engineVersion:'3.5.9',mainSqlExecuted:true,packageId:bundle.id,packageDigest:bundle.digest,rows:sourceRun.rows,testSqlValidation:{passed:true,sqlHash:sha256(bundle.files['tests.sql'])},validation,sequence:1});
 const sourceBinding={taskId:agent.id,packageDigest:bundle.digest,releaseId:release.id,sourceReleaseRunId:run.id};
 const seed=createPrivateDataServices({store,businessStore,project:PROJECT,auth,now});
 const dapi=async(slug,fields)=>{const service=seed.manager.createDapi({name:slug,slug,sourceReleaseRunId:run.id,fields});store.update('data_service',service.id,PROJECT,{scope:'PRIVATE_CLOUD_TEST',createdBy:owner.id});
  await seed.manager.test(service.id,{});seed.manager.publish(service.id);return seed.manager.detail(service.id);};
 const holdings=await dapi('synthetic-stock-holdings',['client_id','holding_market_value','security_count']),cash=await dapi('synthetic-stock-cash',['client_id','available_cash','total_assets']);
 const profile={id:randomUUID(),actorId:owner.id,sourceBinding,startsAt:new Date(clock-1000).toISOString(),expiresAt:new Date(clock+600000).toISOString(),maxPlans:1,maxModelCalls:3,requestTokenLimit:8000,tokenBudget:24000,maxModelCostCny:5,...(eventMode?{driver:'OSS_EVENTS'}:{}),
  bill:{month:serviceAgentMonth(clock),observedAt:new Date(clock-500).toISOString(),spendCny:40,unsettledReserveCny:60},...profilePatch};
 const env={V2_LOCAL_DEVELOPMENT:'false',V2_ALLOW_INSECURE_PUBLIC_COOKIES:'true',V2_PROVISIONING_ONLY:'true',V2_PRIVATE_SMOKE_ENABLED:'true',V2_PRIVATE_DATA_SERVICES_ENABLED:'true',V2_DURABLE_SQL_AGENT_ENABLED:'false',V2_FC_PUBLIC_READ_ONLY:'true',V2_ACCOUNT_MONTHLY_SPEND_CNY:'40',V2_MODEL:'qwen3.7-plus',V2_PRIVATE_SERVICE_AGENT_PROFILE:JSON.stringify(profile),
  ...(eventMode?{OSS_BUCKET:'fictional-service-events',V2_AGENT_EVENT_ACCOUNT_ID:'111122223333',V2_SPARK_EXECUTOR_SECRET:'synthetic-service-events-key-'.repeat(3)}:{})};
 let next=input=>({plan:{serviceType:'DAPI',name:'股票与现金查询',slug:'synthetic-agent-assets',sourceReleaseRunId:input.releaseRuns[0].id,fields:['client_id','total_assets']},explanation:'按所选股票与现金口径生成方案',model:'qwen3.7-plus',usage:{prompt_tokens:500,completion_tokens:200,total_tokens:700}});
 const inputs=[],apps=[],objects=new Map(),events=[];let eventReads=0,eventPuts=0,putFailure;
 const transport={create:async(key,body)=>{
  eventPuts++;if(putFailure==='BEFORE')throw Object.assign(Error('synthetic put not acknowledged'),{code:'SYNTHETIC_PUT_UNKNOWN'});
  if(objects.has(key))assert.equal(objects.get(key),body);else{objects.set(key,body);events.push({events:[{eventName:'ObjectCreated:PutObject',eventSource:'acs:oss',eventVersion:'1.0',eventTime:new Date(now()).toISOString(),oss:{bucket:{name:env.OSS_BUCKET,ownerIdentity:env.V2_AGENT_EVENT_ACCOUNT_ID},object:{key}}}]});}
  if(putFailure==='AFTER')throw Object.assign(Error('synthetic put acknowledgement lost'),{code:'SYNTHETIC_PUT_UNKNOWN'});
 },read:async key=>{eventReads++;return objects.get(key);}};
 let refreshHook=async()=>{};
 const persist=async()=>{flushes++;if(failFlush||failAtFlush===flushes)throw Error('Synthetic persistence failure');};
 const start=async()=>{
  const ingress=createFcIngress({publicHttpEnabled:true,publicReadOnly:true});
  const app=createV2Server({root,store,businessStore,env,now,ingress,stateCoordinator:{refresh:()=>refreshHook(),flush:persist},serviceAgentModelLeaseMs:modelLeaseMs,agentWakeTransport:eventMode?transport:undefined,
   servicePlanner:async input=>{calls++;inputs.push(input);return next(input);},runner:async()=>{compute++;throw Error('must not compute');}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${app.server.address().port}`;env.V2_PUBLIC_ORIGIN=base;
  const call=async(path,body,headers={},key=randomUUID(),publicHttp=false)=>{
   const response=await fetch(base+'/api/v2'+path,{method:body===undefined?'GET':'POST',headers:{origin:base,'content-type':'application/json','x-shuduo-client':'cli','idempotency-key':key,...(publicHttp?{}:ingress.internalHeaders),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
   return {status:response.status,body:await response.json(),cookies:response.headers.getSetCookie()};
  };
  const login=async(email)=>{const response=await call('/auth/login',{email,password});assert.equal(response.status,200,JSON.stringify(response.body));return {cookie:response.cookies.map(value=>value.split(';')[0]).join('; '),'x-csrf-token':response.body.csrfToken};};
  const invoke=async(payload)=>{const response=await fetch(base+'/invoke',{method:'POST',headers:{'content-type':'application/octet-stream','x-fc-control-path':'/invoke'},body:JSON.stringify(payload),signal:AbortSignal.timeout(10000)});return {status:response.status,body:await response.json()};};
  const a=await login(owner.email),b=await login(other.email);const result={app,base,call,invoke,a,b,internalHeaders:ingress.internalHeaders};apps.push(result);return result;
 };
 const api=await start();
 t.after(async()=>{for(const {app}of apps){app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));}businessStore.close();store.close();rmSync(root,{recursive:true,force:true});});
 const create=(message='基于当前股票与现金来源规划资产DAPI',key=randomUUID(),binding=sourceBinding,headers=api.a)=>api.call('/data-services/agent/plans',{message,sourceBinding:binding},headers,key);
 return {...api,root,store,businessStore,owner,other,agent,run,release,bundle,holdings,cash,sourceBinding,profile,env,create,start,inputs,privateManager:seed.manager,project:PROJECT,
  setNext:fn=>{next=fn;},setRefreshHook:fn=>{refreshHook=fn;},moveClock:ms=>{clock+=ms;},now,counts:()=>({calls,compute,flushes}),failFlush:value=>{failFlush=value;},failFlushAt:value=>{failAtFlush=value;},
  objects,events,eventCounts:()=>({reads:eventReads,puts:eventPuts}),setPutFailure:value=>{putFailure=value;}};
}
