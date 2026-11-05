import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createV2Server,PROJECT} from '../../../src/v2/server.mjs';
import {createDeliveryPackage,sha256} from '../../../src/v2/delivery.mjs';
import {getContext,referenceSqlForContext,validationFamilyForContext} from '../../../src/v2/context.mjs';
import {saveManualRevision} from '../../../src/v2/manual-revisions.mjs';

// Actual HTTP, application auth, SQLite and query snapshots. All upstream
// release/model/Spark receipts are synthetic; this fixture never calls a cloud.
export async function privateServiceContextFixture(t){
 const root=mkdtempSync(join(tmpdir(),'shuduo-private-context-'));let flushes=0,models=0,compute=0;
 const env={V2_LOCAL_DEVELOPMENT:'false',V2_ALLOW_INSECURE_PUBLIC_COOKIES:'true',V2_PROVISIONING_ONLY:'true',V2_PRIVATE_SMOKE_ENABLED:'true',V2_DURABLE_SQL_AGENT_ENABLED:'false',V2_PRIVATE_DATA_SERVICES_ENABLED:'true'};
 const app=createV2Server({root,servicePlanner:async()=>{models++;throw Error('must not call model');},runner:async()=>{compute++;throw Error('must not compute');},
  stateCoordinator:{refresh:async()=>{},flush:async()=>{flushes++;}},env});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 const close=async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));app.store.close();rmSync(root,{recursive:true,force:true});};
 t?.after(close);
 const store=app.store,password='SyntheticContext!2026';
 const owner=app.auth.bootstrapAdmin({email:'context-owner@example.invalid',password,displayName:'合成工程师'}),other=app.auth.bootstrapAdmin({email:'context-other@example.invalid',password,displayName:'合成管理员'});
 store.update('auth_user',owner.id,PROJECT,{memberships:[{projectId:PROJECT,role:'ENGINEER'}]});
 const agent=store.create('agent',PROJECT,{submittedBy:owner.id,contextId:'stock-cash-t1',status:'FAILED'});
 const base=`http://127.0.0.1:${app.server.address().port}`;
 env.V2_PUBLIC_ORIGIN=base;
 const call=async(path,body,headers={},key='synthetic-'+path)=>{
  const response=await fetch(base+'/api/v2'+path,{method:body===undefined?'GET':'POST',headers:{origin:base,'content-type':'application/json','x-shuduo-client':'cli','idempotency-key':key,...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:response.status,body:await response.json(),cookies:response.headers.getSetCookie()};
 };
 const login=async(email)=>{const response=await call('/auth/login',{email,password});assert.equal(response.status,200);return {cookie:response.cookies.map(value=>value.split(';')[0]).join('; '),'x-csrf-token':response.body.csrfToken};};
 const a=await login(owner.email),b=await login(other.email);let serial=0;
 function source(contextId='stock-cash-t1',manual=false){
  const sql=referenceSqlForContext(contextId)+`\n-- synthetic source ${++serial}`,family=validationFamilyForContext(contextId);
  const revision=manual?saveManualRevision({store,project:PROJECT,actor:owner.id,key:'manual-'+serial,sql,contextId,originAgentTaskId:agent.id}).revision:store.create('revision',PROJECT,{sql,hash:sha256(sql),contextId});
  const validation={passed:true,contractId:family.id,regressions:family.contextIds.map(contextId=>({contextId,passed:true}))};
  const sourceRun=store.create('run',PROJECT,{revisionId:revision.id,revisionHash:revision.hash,contextId,status:'SUCCEEDED',engine:'Apache Spark',engineVersion:'3.5.9',mainSqlExecuted:true,isolation:'FUNCTION_PROCESS',validation,rows:getContext(contextId).expected});
  const bundle=store.create('delivery_package',PROJECT,{...createDeliveryPackage({run:sourceRun,revision}),sourceRunId:sourceRun.id,...(manual?{sourceKind:'MANUAL',agentIndependentE2E:false}:{})});
  const attribution=manual?{sourceKind:'MANUAL',sourceAttribution:'ENGINEER_ASSISTED',agentIndependentE2E:false,sourceRunId:sourceRun.id,submittedBy:owner.id}:{};
  const approval=store.create('release_approval',PROJECT,{...attribution,status:'APPROVED',packageId:bundle.id,packageDigest:bundle.digest,sourceRevisionId:revision.id,sourceCodeHash:revision.hash});
  const release=store.create('release',PROJECT,{...attribution,mode:'DURABLE_PRIVATE_RELEASE_V1',scope:'PRIVATE_CLOUD_TEST',status:'COMPLETED_CLOUD_TEST',health:'HEALTHY',sourceAgentTaskId:agent.id,sourceRevisionId:revision.id,sourceCodeHash:revision.hash,packageId:bundle.id,packageDigest:bundle.digest,approvalId:approval.id,publicDeployed:false});
  const run=store.create('release_run',PROJECT,{...attribution,sourceAgentTaskId:agent.id,releaseId:release.id,mode:release.mode,scope:release.scope,status:'SUCCEEDED',published:true,publicDeployed:false,schedulerTriggered:true,clockMode:'FC_TIMER',engine:'Apache Spark',engineVersion:'3.5.9',mainSqlExecuted:true,packageId:bundle.id,packageDigest:bundle.digest,rows:sourceRun.rows,testSqlValidation:{passed:true,sqlHash:sha256(bundle.files['tests.sql'])},validation,sequence:1});
  const sourceBinding={taskId:agent.id,packageDigest:bundle.digest,releaseId:release.id,sourceReleaseRunId:run.id};return {revision,sourceRun,bundle,approval,release,run,sourceBinding};
 }
 const create=async(value,slug,fields=['client_id','total_assets'])=>{
  const made=await call('/data-services/dapis',{name:'合成证券'+slug,slug,sourceReleaseRunId:value.run.id,fields},a,slug);assert.equal(made.status,201,JSON.stringify(made.body));
  assert.equal((await call(`/data-services/dapis/${made.body.id}/test`,{},a)).status,200);
  const published=await call(`/data-services/dapis/${made.body.id}/publish`,{configHash:made.body.currentVersion.configHash},a);assert.equal(published.status,200);return published.body.service;
 };
 return {app,root,store,owner,other,agent,a,b,base,call,source,create,close,counts:()=>({models,compute,flushes}),project:PROJECT};
}
