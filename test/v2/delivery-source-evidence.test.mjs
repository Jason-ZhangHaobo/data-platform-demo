import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createV2Server,PROJECT} from '../../src/v2/server.mjs';
import {createDeliveryPackage,validateDeliveryPackage,sha256} from '../../src/v2/delivery.mjs';
import {getContext,referenceSqlForContext,validationFamilyForContext} from '../../src/v2/context.mjs';
import {deliverySourceExecutionIssue} from '../../src/v2/delivery-source-evidence.mjs';
import {deliverySourceSelection} from '../../web/src/delivery-source.ts';

function source(contextId='stock-cash-t1') {
  const family=validationFamilyForContext(contextId),sql=referenceSqlForContext(contextId);
  const revision={id:'source-revision',projectId:PROJECT,sql,hash:sha256(sql),contextId};
  const run={id:'source-run',projectId:PROJECT,revisionId:revision.id,revisionHash:revision.hash,
    contextId,validationContractId:family.id,status:'SUCCEEDED',engine:'Apache Spark',engineVersion:'3.5.9',
    mainSqlExecuted:true,rows:getContext(contextId).expected,
    validation:{passed:true,contractId:family.id,regressions:family.contextIds.map(contextId=>({contextId,passed:true}))}};
  return {run,revision};
}
const cases=[
  [{testDouble:true},'DELIVERY_SOURCE_SIMULATED'],
  [{mainSqlExecuted:false},'DELIVERY_SOURCE_EXECUTION_UNCONFIRMED'],
  [{mainSqlExecuted:undefined},'DELIVERY_SOURCE_EXECUTION_UNCONFIRMED'],
  [{engine:'SYNTHETIC'},'DELIVERY_SOURCE_ENGINE_UNSUPPORTED'],
  [{engineVersion:'0.0.0'},'DELIVERY_SOURCE_ENGINE_UNSUPPORTED'],
  [{engineVersion:'3.5.7',isolation:'FUNCTION_PROCESS'},'DELIVERY_SOURCE_ENGINE_UNSUPPORTED'],
];

test('new files require affirmative execution evidence in both registered customer families',()=>{
  for(const contextId of ['holdings-t1','stock-cash-t1']){
    const input=source(contextId),bundle=createDeliveryPackage(input);
    assert.equal(validateDeliveryPackage(bundle,bundle.digest).source.runId,input.run.id);
    for(const [patch,code] of cases){
      const run=Object.freeze({...input.run,...patch});
      assert.equal(deliverySourceExecutionIssue(run).code,code);
      assert.throws(()=>createDeliveryPackage({...input,run}),error=>error.status===409&&error.code===code);
      const selected=deliverySourceSelection([run],{sourceRunId:run.id,lockSource:true,contractId:run.validationContractId});
      assert.equal(selected.source,run.id,'historical reads retain the exact selected source');
      assert.equal(selected.canCreate,false);assert.match(selected.issue,/来源|执行/);
      assert.equal(run.testDouble,patch.testDouble);
    }
  }
});

test('API rejects simulated or unconfirmed sources before artifact writes and execution',async t=>{
  const root=mkdtempSync(join(tmpdir(),'shuduo-delivery-source-gate-'));
  let computes=0,puts=0;
  const app=createV2Server({root,env:{V2_LOCAL_DEVELOPMENT:'true',V2_RELEASE_SCHEDULER_MODE:'DISABLED'},
    runner:async()=>{computes++;throw Error('must not run');}});
  app.artifactStore.put=async()=>{puts++;throw Error('must not write an artifact');};
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{const done=new Promise(resolve=>app.server.close(resolve));app.server.closeAllConnections();await done;app.releaseScheduler.shutdown();app.store.close();rmSync(root,{recursive:true,force:true});});
  for(const [index,[patch,code]] of cases.entries()){
    const input=source(),revision=app.store.create('revision',PROJECT,{sql:input.revision.sql,hash:input.revision.hash,contextId:input.revision.contextId,author:'local-engineer',source:'MANUAL',manualProvenance:{kind:'ENGINEER_EDIT',actorId:'local-engineer',agentIndependentE2E:false}});
    const {id,projectId,...fields}=input.run;
    const run=app.store.create('run',PROJECT,{...fields,...patch,revisionId:revision.id});
    const response=await fetch('http://127.0.0.1:'+app.server.address().port+'/api/v2/delivery/packages',{method:'POST',headers:{'Content-Type':'application/json','X-Shuduo-Client':'workbench','Idempotency-Key':'source-gate-'+index},body:JSON.stringify({sourceRunId:run.id})});
    assert.equal(response.status,409);assert.equal((await response.json()).code,code);
  }
  assert.equal(puts,0);assert.equal(computes,0);assert.equal(app.store.list('delivery_package',PROJECT).length,0);
  assert.equal(app.store.list('delivery_verification',PROJECT).length,0);assert.equal(app.store.list('release',PROJECT).length,0);
});
