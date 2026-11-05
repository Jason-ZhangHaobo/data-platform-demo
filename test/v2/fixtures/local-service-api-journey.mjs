import assert from 'node:assert/strict';
import {mkdtempSync,cpSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createV2Server,PROJECT} from '../../../src/v2/server.mjs';
import {MetadataStore} from '../../../src/v2/store.mjs';
import {referenceSqlForContext,getContext,validationFamilyForContext} from '../../../src/v2/context.mjs';
import {sha256} from '../../../src/v2/delivery.mjs';

// Actual controller, package files, timer writes and SQLite; synthetic model and
// Spark receipts only. No real credentials or provider processes are used.
export async function createLocalSourceApiFixture({applicationRoot,port=0}={}){
 const root=mkdtempSync(join(tmpdir(),'shuduo-local-source-api-')),store=new MetadataStore(join(root,'metadata.sqlite'));
 if(applicationRoot)cpSync(join(applicationRoot,'web-dist'),join(root,'web-dist'),{recursive:true});
 const counts={syntheticModel:0,syntheticSpark:0};
 const app=createV2Server({root,store,env:{V2_LOCAL_DEVELOPMENT:'true'},releaseTimeUnitMs:10,
  generator:async({context})=>{counts.syntheticModel++;return {sql:referenceSqlForContext(context.id),model:'protocol-model-provider',usage:{total_tokens:100}};},
  runner:async({context,testSql})=>{counts.syntheticSpark++;const family=validationFamilyForContext(context.id);return {status:'SUCCEEDED',engine:'Apache Spark',engineVersion:'3.5.9',
   mainSqlExecuted:true,isolation:'LOCAL_PROCESS',rows:getContext(context.id).expected,validation:{passed:true,contractId:family.id,regressions:family.contextIds.map(contextId=>({contextId,passed:true}))},
   ...(testSql?{testSqlValidation:{passed:true,sqlHash:sha256(testSql)}}:{})};}});
 await new Promise(resolve=>app.server.listen(port,'127.0.0.1',resolve));
 let closed=false;
 const dispose=async()=>{if(closed)return;closed=true;app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));store.close();rmSync(root,{recursive:true,force:true});};
 let requests=0;const origin=`http://127.0.0.1:${app.server.address().port}`,base=origin+'/api/v2';
 const call=async(path,body,{headers={}}={})=>{requests++;const response=await fetch(base+path,{method:body===undefined?'GET':'POST',signal:AbortSignal.timeout(5000),
  headers:{'content-type':'application/json','x-shuduo-client':'cli','idempotency-key':'synthetic-source-'+requests,...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:response.status,body:await response.json()};};
 const poll=async(path,done)=>{let last;for(let n=0;n<100;n++){last=await call(path);assert.equal(last.status,200);if(done(last.body))return last.body;await new Promise(r=>setTimeout(r,10));}assert.fail('synthetic producer did not reach expected checkpoint: '+last.body.status);};
 return {root,store,origin,base,call,poll,counts,dispose};
}

export async function publishLocalAgentFixture(f,{contextId='holdings-t1'}={}){
 const created=await f.call('/agent/tasks',{message:'虚构证券客户资产加工协议验收',sql:'SELECT 1',contextId});assert.equal(created.status,202);
 const agent=await f.poll(`/agent/tasks/${created.body.id}`,value=>['SUCCEEDED','FAILED'].includes(value.status));assert.equal(agent.status,'SUCCEEDED');
 const made=await f.call('/delivery/packages',{sourceRunId:agent.runId,name:'先独立生成再复用的虚构包'});assert.equal(made.status,201);
 assert.equal(made.body.agentDeliveryTaskId,undefined);
 const prepared=await f.call(`/agent/tasks/${agent.id}/prepare-delivery`,{});assert.equal(prepared.status,202);
 const delivery=await f.poll(`/agent/deliveries/${prepared.body.id}`,value=>['SUCCEEDED','FAILED'].includes(value.status));assert.equal(delivery.status,'SUCCEEDED');assert.equal(delivery.packageId,made.body.id);
 const review=await f.call(`/delivery/packages/${made.body.id}/review`,{packageDigest:made.body.digest,verificationId:delivery.verificationId,
  reviewNote:'合成协议验收：核对同源代码、独立断言和文件，不是生产审批',attestations:{code:true,assertions:true,deliveryFiles:true,localScope:true}});assert.equal(review.status,201);
 const approval=await f.call(`/delivery/packages/${made.body.id}/approve`,{packageDigest:made.body.digest,reviewId:review.body.id});assert.equal(approval.status,201);
 const released=await f.call('/releases',{approvalId:approval.body.id,triggerAfterSeconds:1,intervalSeconds:2,runCount:2});assert.equal(released.status,201);
 const release=await f.poll(`/releases/${released.body.id}`,value=>value.health==='HEALTHY');assert.equal(release.successfulRunCount,2);
 const query=new URLSearchParams({agent_task_id:agent.id,package_digest:made.body.digest,release_id:release.id});
 const sources=await f.call('/data-services/sources?'+query);assert.equal(sources.status,200);assert.equal(sources.body.length,2);
 return {agent,bundle:made.body,delivery,review:review.body,approval:approval.body,release,sources:sources.body,query};
}

export async function createLocalServiceUiJourney(options={}){
 const f=await createLocalSourceApiFixture(options);
 try{
  const old=await publishLocalAgentFixture(f),oldDapi=await f.call('/data-services/dapis',{name:'其他历史包',slug:'local-other-package',sourceReleaseRunId:old.sources[0].id,fields:['client_id','total_assets']});assert.equal(oldDapi.status,201);
  const selected=await publishLocalAgentFixture(f,{contextId:'stock-cash-t1'});
  async function dapi(name,slug,fields){const made=await f.call('/data-services/dapis',{name,slug,sourceReleaseRunId:selected.sources[0].id,fields});assert.equal(made.status,201);
   assert.equal((await f.call(`/data-services/dapis/${made.body.id}/test`,{})).status,200);
   assert.equal((await f.call(`/data-services/dapis/${made.body.id}/publish`,{configHash:made.body.currentVersion.configHash})).status,200);return made.body;}
  const holdings=await dapi('本机股票持仓查询','local-selected-holdings',['client_id','holding_market_value','security_count']),cash=await dapi('本机可用现金查询','local-selected-cash',['client_id','available_cash','total_assets']);
  const made=await f.call('/data-services/xapis',{name:'本机客户股票与现金组合','slug':'local-selected-assets',steps:[{alias:'holdings',dapiId:holdings.id},{alias:'cash',dapiId:cash.id}]});assert.equal(made.status,201);
  assert.equal((await f.call(`/data-services/xapis/${made.body.id}/test`,{})).status,200);
  assert.equal((await f.call(`/data-services/xapis/${made.body.id}/publish`,{configHash:made.body.currentVersion.configHash})).status,200);
  const issued=await f.call('/data-services/applications',{name:'本机合成消费应用',serviceIds:[made.body.id]});assert.equal(issued.status,201);
  const actual=await f.call('/open/xapis/local-selected-assets?client_id=CLIENT-001',undefined,{headers:{authorization:'Bearer '+issued.body.token}});assert.equal(actual.status,200);
  assert.deepEqual(actual.body.data,[{client_id:'CLIENT-001',holdings:{holding_market_value:'1000.00',security_count:1},cash:{available_cash:'300.00',total_assets:'1300.00'}}]);
  assert.equal((await f.call(`/data-services/applications/${issued.body.application.id}/revoke`,{})).status,200);issued.body.token=undefined;
  const binding={taskId:selected.agent.id,packageDigest:selected.bundle.digest,releaseId:selected.release.id,sourceKind:'AGENT',scope:'LOCAL_TEST_ONLY',revisionId:selected.agent.revisionId,runId:selected.agent.runId};
  const sourceQuery=new URLSearchParams({module:'services',source_task:binding.taskId,source_package:binding.packageDigest,source_release:binding.releaseId,source_kind:binding.sourceKind,source_scope:binding.scope,source_revision:binding.revisionId,source_run:binding.runId});
  return {...f,selected,old,distractorServiceId:oldDapi.body.id,binding,url:f.origin+'/v2/?'+sourceQuery,
   serviceIds:[holdings.id,cash.id,made.body.id],snapshot:()=>({...f.counts,services:f.store.list('data_service',PROJECT).length,applications:f.store.list('service_app',PROJECT).length,calls:f.store.list('service_call',PROJECT).length,
    actualModel:0,actualSpark:0,cloud:0})};
 }catch(error){await f.dispose();throw error;}
}
