import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {MetadataStore} from '../../src/v2/store.mjs';
import {createV2Server,PROJECT} from '../../src/v2/server.mjs';
import {generateSql} from '../../src/v2/model.mjs';
import {referenceSql} from '../../src/v2/context.mjs';
import {verifiedSqlRequirementReport} from '../../src/v2/sql-requirements.mjs';
import {syntheticSqlRequirement} from './fixtures/sql-requirement.mjs';

test('local development HTTP keeps one proposal/attempt and stops clarification or missing evidence before execution',async t=>{
 const root=mkdtempSync(join(tmpdir(),'shuduo-requirement-api-synthetic-')),store=new MetadataStore(join(root,'metadata.sqlite'));
 let modelCalls=0,executions=0,mode='proposal';
 const app=createV2Server({store,env:{V2_LOCAL_DEVELOPMENT:'true'},generator:input=>generateSql(input,{DASHSCOPE_API_KEY:'SYNTHETIC_ONLY'},async()=>{
  modelCalls++;const {requirement}=syntheticSqlRequirement(input,{clarification:mode==='clarification'});
  return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({sql:mode==='clarification'?null:referenceSql,
   ...(mode==='missing'?{}:{requirement}),explanation:'合成API验收'})}}],usage:{total_tokens:200}}));
 }),runner:async({context,validationContexts})=>{executions++;return {status:'SUCCEEDED',engine:'Apache Spark',engineVersion:'3.5.9',testDouble:true,
  mainSqlExecuted:true,rows:context.expected,validation:{passed:true,regressions:validationContexts.map(c=>({contextId:c.id,passed:true}))}};}});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
 t.after(async()=>{await new Promise(r=>app.server.close(r));store.close();rmSync(root,{recursive:true,force:true});});
 const origin=`http://127.0.0.1:${app.server.address().port}`;
 const call=async(path,body)=>{
  const r=await fetch(origin+'/api/v2'+path,{method:body?'POST':'GET',headers:{'content-type':'application/json','x-shuduo-client':'cli','idempotency-key':randomUUID()},
   ...(body?{body:JSON.stringify(body)}:{})});assert.ok(r.ok);return r.json();
 };
 for(const desired of ['proposal','clarification','missing']){
  mode=desired;const before=modelCalls,task=await call('/agent/tasks',{message:'虚构证券客户资产加工 '+desired,contextId:'holdings-t1',sql:referenceSql});
  let current;for(let n=0;n<30;n++){current=await call('/agent/tasks/'+task.id);if(['SUCCEEDED','FAILED'].includes(current.status))break;await new Promise(r=>setTimeout(r,5));}
  assert.equal(current.attempts.length,1);assert.equal(current.usedTokens,200);assert.equal(modelCalls,before+1);
  const jobs=executions;
  if(desired==='proposal'){
   assert.equal(current.status,'SUCCEEDED');assert.equal(current.requirements.status,'MODEL_PROPOSED');assert.equal(verifiedSqlRequirementReport(current.requirements,current),true);
   assert.equal(store.list('revision',PROJECT).length,1);
  }else{
   assert.equal(current.status,'FAILED');assert.equal(current.stage,desired==='clarification'?'REQUIREMENT_CLARIFICATION_REQUIRED':'REQUIREMENT_EVIDENCE_INVALID');
   assert.equal(current.attempts[0].computationSkipped,true);assert.equal(executions,1);
  }
  const again=await call('/agent/tasks/'+task.id);assert.deepEqual(again.requirements,current.requirements);assert.equal(executions,jobs);assert.equal(modelCalls,before+1);
 }
});
