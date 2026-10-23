import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createV2Server,PROJECT} from '../../src/v2/server.mjs';
import {MetadataStore} from '../../src/v2/store.mjs';
import {BusinessQueryStore,DataServiceManager} from '../../src/v2/data-services.mjs';
import {createDeliveryPackage,sha256} from '../../src/v2/delivery.mjs';
import {referenceSql,getContext,contextIds,validationContractId} from '../../src/v2/context.mjs';
import {localTaskConsumption} from '../../src/v2/local-task-consumption.mjs';

test('local task consumption joins existing source and revoked-app receipts without executing or writing',async t=>{
 const root=mkdtempSync(join(tmpdir(),'shuduo-local-consumption-')),store=new MetadataStore(join(root,'meta.sqlite')),businessStore=new BusinessQueryStore(join(root,'business.sqlite'));
 const revision={id:'fixture-revision',projectId:PROJECT,sql:referenceSql,hash:sha256(referenceSql),contextId:'holdings-t1'};
 const codeRun={id:'fixture-code-run',projectId:PROJECT,revisionId:revision.id,revisionHash:revision.hash,status:'SUCCEEDED',engine:'Apache Spark',engineVersion:'3.5.9',validation:{passed:true,contractId:validationContractId,regressions:contextIds.map(contextId=>({contextId,passed:true}))}};
 const agent=store.create('agent',PROJECT,{status:'SUCCEEDED',attempts:[{revisionId:revision.id,runId:codeRun.id}]});
 const bundle=store.create('delivery_package',PROJECT,createDeliveryPackage({run:codeRun,revision}));
 store.create('agent_delivery_task',PROJECT,{sourceAgentTaskId:agent.id,sourceRevisionId:revision.id,sourceRunId:codeRun.id,packageId:bundle.id,packageDigest:bundle.digest});
 const approval=store.create('release_approval',PROJECT,{status:'APPROVED',packageId:bundle.id,packageDigest:bundle.digest});
 const release=store.create('release',PROJECT,{status:'ACTIVE_LOCAL',packageId:bundle.id,packageDigest:bundle.digest,sourceRevisionId:revision.id,approvalId:approval.id});
 const run=store.create('release_run',PROJECT,{releaseId:release.id,packageId:bundle.id,packageDigest:bundle.digest,status:'SUCCEEDED',published:true,publicDeployed:false,schedulerTriggered:true,engine:'Apache Spark',engineVersion:'3.5.9',mainSqlExecuted:true,testSqlValidation:{passed:true},validation:{passed:true},source:{revisionId:revision.id,runId:codeRun.id},rows:getContext('holdings-t1').expected});
 const manager=new DataServiceManager({store,businessStore,project:PROJECT,releaseRunFor:id=>store.get('release_run',id,PROJECT)});
 async function dapi(slug,fields){const s=manager.createDapi({name:'合成证券查询',slug,fields,sourceReleaseRunId:run.id});await manager.test(s.id,{});manager.publish(s.id);return s;}
 const h=await dapi('fixture-holdings',['client_id','holding_market_value','security_count']),c=await dapi('fixture-cash',['client_id','available_cash','total_assets']);
 const x=manager.createXapi({name:'合成资产组合',slug:'fixture-assets',steps:[{alias:'positions',dapiId:h.id},{alias:'cash',dapiId:c.id}]});await manager.test(x.id,{});manager.publish(x.id);
 const read=(patch={})=>localTaskConsumption({store,project:PROJECT,agent,packageDigest:bundle.digest,manager,...patch});
 assert.equal((await read()).status,'PENDING');
 const issued=manager.createApplication({name:'合成消费应用',serviceIds:[x.id]});await manager.invoke('XAPI','fixture-assets','Bearer '+issued.token,{});manager.revokeApplication(issued.application.id);
 const count=store.list('service_call',PROJECT).length;
 for(let i=0;i<2;i++){
  const proof=await read();assert.equal(proof.scope,'LOCAL_TEST_ONLY');assert.equal(proof.status,'VERIFIED');assert.equal(proof.protocol,'shuduo-local-task-consumption/v1');
  assert.equal(proof.services.find(s=>s.serviceId===x.id).call.applicationStatus,'REVOKED');
  assert.equal(JSON.stringify(proof).includes('1800.00'),false);assert.equal(JSON.stringify(proof).includes(issued.token),false);
 }
 assert.equal(store.list('service_call',PROJECT).length,count);assert.equal(manager.listApplications().length,1);
 store.update('service_app',issued.application.id,PROJECT,{scope:'PRIVATE_CLOUD_TEST'});assert.equal((await read()).status,'PENDING');
 store.update('service_app',issued.application.id,PROJECT,{scope:'LOCAL_TEST_ONLY'});
 await assert.rejects(read({packageDigest:'0'.repeat(64)}),{status:409});
 await assert.rejects(read({agent:{...agent,id:'foreign-task'}}),{status:409});
 await assert.rejects(read({agent:{...agent,attempts:[{revisionId:revision.id,runId:'different-run'}]}}),{status:409});
 let computations=0;
 const app=createV2Server({root,store,businessStore,env:{V2_LOCAL_DEVELOPMENT:'true'},runner:async()=>{computations++;throw Error('must not run');}});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));businessStore.close();store.close();});
 const path=`http://127.0.0.1:${app.server.address().port}/api/v2/data-services/task-evidence?agent_task_id=${agent.id}&package_digest=${bundle.digest}`;
 const response=await fetch(path);assert.equal(response.status,200);assert.equal((await response.json()).status,'VERIFIED');
 assert.equal((await fetch(path+'&extra=not-supported')).status,422);
 assert.equal(computations,0);assert.equal(store.list('service_call',PROJECT).length,count);
});
