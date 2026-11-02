import test from "node:test";
import assert from "node:assert/strict";
import {MetadataStore} from "../../src/v2/store.mjs";
import {resolveExplicitSqlRepairSource} from "../../src/v2/sql-repair-source.mjs";
import {referenceSqlForContext,validationFamilyForContext} from "../../src/v2/context.mjs";
import {sha256} from "../../src/v2/delivery.mjs";
const project="synthetic-explicit-repair",actorId="synthetic-owner",contextId="stock-cash-t1";
function fixture(t,manual=false){
  const store=new MetadataStore(":memory:");t.after(()=>store.close());
  const sql=referenceSqlForContext(contextId).trim(),revision=store.create("revision",project,{sql,hash:sha256(sql),contextId,author:actorId,source:manual?"MANUAL":"LIVE_MODEL",
    ...(manual?{manualProvenance:{kind:"ENGINEER_EDIT",actorId,agentIndependentE2E:false}}:{})});
  const run=store.create("run",project,{revisionId:revision.id,revisionHash:revision.hash,contextId,validationContractId:validationFamilyForContext(contextId).id,
    status:"VALIDATION_FAILED",engine:"Apache Spark",mainSqlExecuted:true,validation:{passed:false}});
  const origin=store.create("agent",project,{submittedBy:actorId,contextId,language:"SPARK_SQL",attempts:[{runId:run.id,revisionId:revision.id}]});
  if(!manual)store.update("run",run.id,project,{agentTaskId:origin.id});
  const input={sourceRunId:run.id,actorId,contextId,currentSql:sql,project,read:(kind,id)=>store.get(kind,id,project)};
  return{store,input,revision,run:store.get("run",run.id,project),origin};
}
test("explicit source accepts matching owned model failure or confirmed manual provenance without rewriting either",t=>{
  for(const manual of [false,true]){const f=fixture(t,manual),before=f.store.list("run",project);const result=resolveExplicitSqlRepairSource(f.input);
    assert.equal(result.run.id,f.run.id);assert.equal(result.revision.id,f.revision.id);assert.deepEqual(f.store.list("run",project),before);}
});
test("explicit source refuses cross-project or actor records, wrong hashes, incomplete manual provenance and timeout results",t=>{
  for(const manual of [false,true]){
    const f=fixture(t,manual);
    for(const patch of [{actorId:"other-owner"},{project:"other-project"},{currentSql:"SELECT 1"},{contextId:"holdings-t1"}])
      assert.throws(()=>resolveExplicitSqlRepairSource({...f.input,...patch}),{code:"AGENT_REPAIR_SOURCE_INVALID"});
    for(const patch of [{status:"SUCCEEDED"},{testDouble:true},{code:"REMOTE_SPARK_TIMEOUT"},{revisionHash:"0".repeat(64)},{contextId:"holdings-t1"}]){
      f.store.update("run",f.run.id,project,patch);assert.throws(()=>resolveExplicitSqlRepairSource(f.input),{code:"AGENT_REPAIR_SOURCE_INVALID"});
      f.store.update("run",f.run.id,project,{...f.run,testDouble:undefined,code:undefined});
    }
    if(manual){f.store.update("revision",f.revision.id,project,{manualProvenance:{kind:"ENGINEER_EDIT",actorId:"other-owner",agentIndependentE2E:false}});}
    else f.store.update("agent",f.origin.id,project,{submittedBy:"other-owner"});
    assert.throws(()=>resolveExplicitSqlRepairSource(f.input),{code:"AGENT_REPAIR_SOURCE_INVALID"});
  }
});
