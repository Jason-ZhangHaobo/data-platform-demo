// Synthetic input, real independent Node process and SQLite queries. NOT FC,
// MySQL, OSS or Spark acceptance. File CAS simulates the remote transports only.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync, renameSync, lstatSync } from 'node:fs';
import { join, basename } from 'node:path';
import { createV2Server, PROJECT } from '../../src/v2/server.mjs';
import { ReplicatedMetadataStore } from '../../src/v2/metadata-replica.mjs';
import { ReplicatedDataState, emptyDataState } from '../../src/v2/data-state-replica.mjs';
import { CloudStateCoordinator } from '../../src/v2/cloud-state-coordinator.mjs';
import { BusinessQueryStore } from '../../src/v2/data-services.mjs';
import { LandingStore } from '../../src/v2/ingestion.mjs';
import { StreamStateStore } from '../../src/v2/realtime.mjs';
import { ReportDataStore } from '../../src/v2/reports.mjs';
import { createDeliveryPackage, sha256 } from '../../src/v2/delivery.mjs';
import { getContext, contextIds, referenceSql, validationContractId } from '../../src/v2/context.mjs';

const [phase,root]=process.argv.slice(2);
assert.ok(['seed','resume','missing','corrupt'].includes(phase));
assert.ok(basename(root).startsWith('shuduo-service-restart-'));
assert.ok(lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink());
class FileCas {
  constructor(name,empty){this.path=join(root,name);this.empty=empty;}
  async load(){return existsSync(this.path)?JSON.parse(readFileSync(this.path)):this.empty;}
  async compareAndSwap(project,revision,payload){
    const current=await this.load();
    if(current.revision!==revision)throw Object.assign(new Error('fixture CAS conflict'),{status:409});
    writeFileSync(this.path+'.next',JSON.stringify({revision:revision+1,payload}),{mode:0o600});
    renameSync(this.path+'.next',this.path);return revision+1;
  }
  async close(){}
}
const metadata=await ReplicatedMetadataStore.open({backend:new FileCas('metadata.json',{revision:0,payload:null}),project:PROJECT,autoFlush:false});
const stores={businessStore:new BusinessQueryStore(),landingStore:new LandingStore(),streamStateStore:new StreamStateStore(),reportStore:new ReportDataStore()};
const dataState=await ReplicatedDataState.open({backend:new FileCas('business.json',{revision:0,payload:emptyDataState(PROJECT)}),stores,project:PROJECT,autoFlush:false});
const coordinator=new CloudStateCoordinator({metadata,dataState});
const app=createV2Server({store:metadata,...stores,stateCoordinator:coordinator,env:{
  V2_LOCAL_DEVELOPMENT:'false',V2_ALLOW_INSECURE_PUBLIC_COOKIES:'true',
  V2_PROVISIONING_ONLY:'true',V2_PRIVATE_SMOKE_ENABLED:'true',V2_PRIVATE_DATA_SERVICES_ENABLED:'true',
}});
await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${app.server.address().port}/api/v2`;
const call=async(path,body,headers={},key=path)=>{
  const r=await fetch(base+path,{method:body===undefined?'GET':'POST',
    headers:{'content-type':'application/json','x-shuduo-client':'cli','idempotency-key':key,...headers},
    ...(body===undefined?{}:{body:JSON.stringify(body)})});
  return{status:r.status,body:await r.json(),cookies:r.headers.getSetCookie()};
};
try {
  let state;
  if(phase==='seed'){
    const owner=app.auth.bootstrapAdmin({email:'restart-owner@example.invalid',password:'SyntheticPassword!2026',displayName:'合成恢复工程师'});
    const agent=metadata.create('agent',PROJECT,{submittedBy:owner.id});
    const revision=metadata.create('revision',PROJECT,{sql:referenceSql,hash:sha256(referenceSql),contextId:'cash-change'});
    const validation={passed:true,contractId:validationContractId,regressions:contextIds.map(contextId=>({contextId,passed:true}))};
    const prior=metadata.create('run',PROJECT,{revisionId:revision.id,revisionHash:revision.hash,status:'SUCCEEDED',engine:'Apache Spark',engineVersion:'3.5.9',mainSqlExecuted:true,isolation:'FUNCTION_PROCESS',rows:getContext('cash-change').expected,validation});
    const bundle=metadata.create('delivery_package',PROJECT,createDeliveryPackage({run:prior,revision}));
    const approval=metadata.create('release_approval',PROJECT,{status:'APPROVED',packageId:bundle.id,packageDigest:bundle.digest});
    const release=metadata.create('release',PROJECT,{mode:'DURABLE_PRIVATE_RELEASE_V1',scope:'PRIVATE_CLOUD_TEST',status:'COMPLETED_CLOUD_TEST',health:'HEALTHY',sourceAgentTaskId:agent.id,sourceCodeHash:bundle.manifest.source.sqlHash,packageId:bundle.id,packageDigest:bundle.digest,approvalId:approval.id,publicDeployed:false});
    const run=metadata.create('release_run',PROJECT,{releaseId:release.id,mode:release.mode,status:'SUCCEEDED',published:true,publicDeployed:false,schedulerTriggered:true,clockMode:'FC_TIMER',engine:'Apache Spark',engineVersion:'3.5.9',mainSqlExecuted:true,packageId:bundle.id,packageDigest:bundle.digest,rows:getContext('cash-change').expected,testSqlValidation:{passed:true,sqlHash:sha256(bundle.files['tests.sql'])},validation});
    const login=await call('/auth/login',{email:owner.email,password:'SyntheticPassword!2026'});assert.equal(login.status,200);
    const auth={cookie:login.cookies.map(c=>c.split(';')[0]).join('; '),'x-csrf-token':login.body.csrfToken};
    const dapi=async(slug,fields)=>{
      const r=await call('/data-services/dapis',{name:slug,slug,fields,sourceReleaseRunId:run.id},auth,slug);assert.equal(r.status,201);
      assert.equal((await call(`/data-services/dapis/${r.body.id}/test`,{},auth)).status,200);
      assert.equal((await call(`/data-services/dapis/${r.body.id}/publish`,{configHash:r.body.currentVersion.configHash},auth)).status,200);return r.body;
    };
    const h=await dapi('restart-holdings',['client_id','holding_market_value','security_count']);
    const c=await dapi('restart-cash',['client_id','available_cash','total_assets']);
    const x=await call('/data-services/xapis',{name:'合成恢复组合',slug:'restart-overview',rateLimitPerMinute:1,steps:[{alias:'positions',dapiId:h.id},{alias:'cash',dapiId:c.id}]},auth,'restart-xapi');assert.equal(x.status,201);
    assert.equal((await call(`/data-services/xapis/${x.body.id}/test`,{},auth)).status,200);
    assert.equal((await call(`/data-services/xapis/${x.body.id}/publish`,{configHash:x.body.currentVersion.configHash},auth)).status,200);
    const issue=async key=>{const r=await call('/data-services/applications',{name:'合成恢复查询应用',serviceIds:[x.body.id]},auth,key);assert.equal(r.status,201);return r.body;};
    const revoked=await issue('revoked-app'),active=await issue('rate-app');
    const url='/open/xapis/restart-overview?client_id=CLIENT-001';
    assert.equal((await call(url,undefined,{authorization:'Bearer '+revoked.token})).status,200);
    assert.equal((await call(`/data-services/applications/${revoked.application.id}/revoke`,{},auth)).status,200);
    assert.equal((await call(url,undefined,{authorization:'Bearer '+active.token})).status,200);
    const proof=await call(`/data-services/xapis/${x.body.id}/recovery`,undefined,auth);assert.equal(proof.status,200);assert.equal(proof.body.healthy,true);
    state={auth,serviceId:x.body.id,revokedToken:revoked.token,activeToken:active.token,proof:proof.body};
    writeFileSync(join(root,'client-state.json'),JSON.stringify(state),{mode:0o600});
    process.stdout.write(JSON.stringify({scope:'LOCAL_PROCESS_RESTART_FILE_CAS',syntheticInputs:true,pid:process.pid,proof:proof.body})+'\n');
  }else{
    state=JSON.parse(readFileSync(join(root,'client-state.json')));
    const proof=await call(`/data-services/xapis/${state.serviceId}/recovery`,undefined,state.auth);assert.equal(proof.status,200);
    if(phase==='resume'){
      assert.equal(proof.body.healthy,true);assert.notEqual(proof.body.bootId,state.proof.bootId);
      assert.equal(proof.body.fingerprint,state.proof.fingerprint);
      assert.equal((await call('/open/xapis/restart-overview?client_id=CLIENT-001',undefined,{authorization:'Bearer '+state.revokedToken})).status,401);
      assert.equal((await call('/open/xapis/restart-overview?client_id=CLIENT-001',undefined,{authorization:'Bearer '+state.activeToken})).status,429);
      const replay=await call('/data-services/applications',{name:'合成恢复查询应用',serviceIds:[state.serviceId]},state.auth,'rate-app');assert.equal(replay.body.token,null);
      assert.equal(metadata.list('data_service',PROJECT).length,3);
      assert.equal(metadata.list('service_app',PROJECT).length,2);
    }else{
      assert.equal(proof.body.healthy,false);
      const r=await call(`/data-services/xapis/${state.serviceId}/test`,{},state.auth);assert.equal(r.status,409);assert.equal(r.body.code,'SOURCE_SNAPSHOT_UNAVAILABLE');
    }
    process.stdout.write(JSON.stringify({scope:'LOCAL_PROCESS_RESTART_FILE_CAS',syntheticInputs:true,pid:process.pid,proof:proof.body,revokedRejected:phase==='resume',rateCounterRestored:phase==='resume',idempotencyRestored:phase==='resume'})+'\n');
  }
}finally{
  app.server.closeAllConnections();await new Promise(r=>app.server.close(r));
  await coordinator.closeReplicated({closeDataStores:true});
}
