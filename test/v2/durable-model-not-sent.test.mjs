// Model preparation and in-memory provider/queue doubles only. No paid calls.
import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {MetadataStore} from "../../src/v2/store.mjs";
import {createDurableSqlAgent} from "../../src/v2/durable-agent.mjs";
import {generateSql} from "../../src/v2/model.mjs";
import {modelFailure} from "../../src/v2/model-diagnostics.mjs";
import {getContext,contextIds,validationContractId,referenceSql} from "../../src/v2/context.mjs";

function fixture(t,{generator,tokenBudget=300,modelLeaseMs=90000}={}){
  const root=mkdtempSync(join(tmpdir(),"shuduo-model-not-sent-")),path=join(root,"metadata.sqlite"),project="synthetic-model-not-sent";
  let store=new MetadataStore(path),calls=0,runnerCalls=0,persistFault,clock=Date.now();
  const runner=Object.fromEntries(["prepare","submit","read","cancel"].map(key=>[key,()=>{runnerCalls++;throw Error("synthetic runner forbidden");}]));
  const build=()=>createDurableSqlAgent({store,project,runner,getContext,contextIds,contractId:validationContractId,tokenBudget,requestTokenLimit:100,modelLeaseMs,now:()=>clock,
    persist:async()=>{if(persistFault)persistFault(store);},generator:async input=>{calls++;return generator(input,calls);}});
  let engine=build();t.after(()=>{store.close();rmSync(root,{recursive:true,force:true});});
  return{project,get store(){return store;},get engine(){return engine;},get calls(){return calls;},get runnerCalls(){return runnerCalls;},
    create:()=>engine.create({message:"虚构证券客户资产加工",currentSql:referenceSql,contextId:"holdings-t1",actorId:"synthetic-owner",idempotencyKey:"not-sent"}),
    advance:(id,options={})=>engine.advance(id,{expectedVersion:engine.get(id).version,...options}),
    restart(){store.close();store=new MetadataStore(path);store.interruptPending(project);engine=build();},fault:fn=>persistFault=fn,later:ms=>{clock+=ms;}};
}
const output={sql:referenceSql,model:"TEST_DOUBLE",usage:{total_tokens:20}};

test("actual provider preparation failures are definitively not sent and retain the existing attempt/reservation across reads and restart",async t=>{
  for(const [code,env] of [["MODEL_KEY_MISSING",{}],["MODEL_CONFIG_INVALID",{DASHSCOPE_API_KEY:"SYNTHETIC",V2_MODEL_BASE_URL:"http://invalid.example"}],
    ["MODEL_CONTEXT_BUDGET",{DASHSCOPE_API_KEY:"SYNTHETIC"}]])await t.test(code,async t=>{
    let requests=0;const f=fixture(t,{generator:input=>generateSql(input,env,async()=>{requests++;throw Error("request must not be sent");})});
    let task=await f.create();task=await f.advance(task.id);
    assert.equal(task.status,"INTERRUPTED");assert.equal(task.stage,"MODEL_NOT_SENT");assert.equal(task.recovery.confirmationRequired,false);
    assert.equal(task.attempts.length,1);assert.equal(task.attempts[0].status,"MODEL_NOT_SENT");assert.equal(task.usedTokens,100);
    assert.equal(task.attempts[0].usage.total_tokens,100);assert.equal(task.attempts[0].usageEstimated,true);
    assert.equal(task.attempts[0].diagnostic.code,code);assert.equal(task.attempts[0].diagnostic.phase,"PREPARE");
    assert.equal(task.attempts[0].diagnostic.requestMayHaveBeenSent,false);assert.match(task.error,/本次未发起模型请求/);
    assert.equal(requests,0);assert.equal(f.calls,1);assert.equal(f.runnerCalls,0);
    const snapshot=structuredClone(task);assert.deepEqual(f.engine.get(task.id),snapshot);f.restart();assert.deepEqual(f.engine.get(task.id),snapshot);
    assert.equal(f.calls,1);assert.equal(f.store.list("revision",f.project).length,0);assert.equal(f.store.list("run",f.project).length,0);
  });
});
test("only diagnostic classification is trusted; forged flags, sent responses and leases stay on the original unknown confirmation gate",async t=>{
  const failures=[Object.assign(Error("SYNTHETIC_UNTRUSTED"),{diagnostic:{phase:"PREPARE",requestMayHaveBeenSent:false},phase:"PREPARE",requestMayHaveBeenSent:false}),
    ...["MONTHLY_MODEL_BUDGET_EXCEEDED","MONTHLY_HARD_BUDGET_EXCEEDED","MODEL_RESERVATION_INVALID"].map(code=>Object.assign(Error("SYNTHETIC_SENT_FAILURE"),{code})),
    modelFailure("MODEL_HTTP_ERROR","RESPONSE",{httpStatus:401}),modelFailure("MODEL_RESPONSE_INVALID","PARSE"),
    modelFailure("MODEL_TRANSPORT_ERROR","REQUEST"),modelFailure("MODEL_INTERRUPTED","LEASE")];
  for(const error of failures)await t.test("unknown result preserved",async t=>{
    const f=fixture(t,{generator:()=>{throw error;}});let task=await f.create();task=await f.advance(task.id);
    assert.equal(task.stage,"MODEL_OUTCOME_UNKNOWN");assert.equal(task.recovery.confirmationRequired,true);assert.equal(task.usedTokens,100);
    await f.advance(task.id);assert.equal(f.calls,1);
    await assert.rejects(f.engine.prepareResume(task.id,{expectedVersion:task.version,confirmModelRetry:false}),{code:"AGENT_RETRY_CONFIRMATION_REQUIRED"});
    assert.equal(f.runnerCalls,0);
  });
});
test("expired or invalid leases stay unknown even when the watchdog has not fired and the thrown preparation error is trusted",async t=>{
  for(const mode of ["expired","exact-deadline","invalid-deadline"])await t.test(mode,async t=>{
    let signalAborted;
    const f=fixture(t,{modelLeaseMs:10,generator:input=>{
      signalAborted=input.signal.aborted;
      if(mode==="invalid-deadline"){
        const task=f.store.get("agent",input.modelBudgetReservation.taskId,f.project);
        f.store.update("agent",task.id,f.project,{durable:{...task.durable,leaseExpiresAt:"invalid"}});
      }else f.later(mode==="expired"?11:10);
      throw modelFailure("MODEL_KEY_MISSING","PREPARE");
    }});
    let task=await f.create();task=await f.advance(task.id);
    assert.equal(signalAborted,false,"the event-loop watchdog has not fired");assert.equal(task.stage,"MODEL_OUTCOME_UNKNOWN");
    assert.equal(task.recovery.confirmationRequired,true);assert.equal(task.attempts[0].diagnostic.phase,"LEASE");
    assert.equal(task.attempts[0].diagnostic.requestMayHaveBeenSent,true);assert.equal(task.usedTokens,100);assert.equal(task.attempts[0].usage.total_tokens,100);
    await f.advance(task.id);assert.equal(f.calls,1);assert.equal(f.runnerCalls,0);
  });
});
test("explicit advance after a known-unsent failure needs no unknown-fee confirmation and keeps every historical reservation",async t=>{
  const f=fixture(t,{generator:(_input,call)=>{if(call===1)throw Error("unknown provider result");if(call===2)throw modelFailure("MODEL_KEY_MISSING","PREPARE");return output;}});
  let task=await f.create();task=await f.advance(task.id);const unknown=structuredClone(task.attempts[0]);
  task=await f.advance(task.id,{confirmModelRetry:true});assert.equal(task.stage,"MODEL_NOT_SENT");const unsent=structuredClone(task.attempts[1]);
  assert.equal(task.usedTokens,200);f.restart();task=await f.advance(task.id,{confirmModelRetry:false});
  assert.equal(task.stage,"READY_FOR_RUN");assert.equal(task.attempts.length,3);assert.equal(task.usedTokens,220);
  assert.deepEqual(task.attempts[0],unknown);assert.deepEqual(task.attempts[1],unsent);assert.equal(f.calls,3);assert.equal(f.runnerCalls,0);
});
test("explicit preparation review alone never invokes a provider or resets limits, while an exhausted task cannot resume",async t=>{
  let fixed=false;const f=fixture(t,{generator:()=>{if(!fixed)throw modelFailure("MODEL_CONFIG_INVALID","PREPARE");return output;}});
  let task=await f.create();task=await f.advance(task.id);const prior=structuredClone(task);
  task=await f.engine.prepareResume(task.id,{expectedVersion:task.version,confirmModelRetry:false});
  assert.equal(task.stage,"READY_FOR_MODEL");assert.equal(task.usedTokens,prior.usedTokens);assert.deepEqual(task.attempts,prior.attempts);assert.equal(f.calls,1);
  fixed=true;task=await f.advance(task.id);assert.equal(task.stage,"READY_FOR_RUN");assert.equal(f.calls,2);assert.equal(task.usedTokens,120);
  const exhausted=fixture(t,{tokenBudget:100,generator:()=>{throw modelFailure("MODEL_CONTEXT_BUDGET","PREPARE");}});
  let stopped=await exhausted.create();stopped=await exhausted.advance(stopped.id);const old=structuredClone(stopped.attempts);
  await assert.rejects(exhausted.engine.prepareResume(stopped.id,{expectedVersion:stopped.version,confirmModelRetry:false}),{code:"AGENT_RETRY_LIMIT"});
  stopped=await exhausted.advance(stopped.id);assert.equal(stopped.status,"FAILED");assert.equal(exhausted.calls,1);assert.equal(stopped.usedTokens,100);assert.deepEqual(stopped.attempts,old);
});
test("failure to persist the unsent checkpoint does not call a provider again on read or restart",async t=>{
  const f=fixture(t,{generator:()=>{throw modelFailure("MODEL_KEY_MISSING","PREPARE");}}),task=await f.create();
  f.fault(store=>{if(store.get("agent",task.id,f.project).stage==="MODEL_NOT_SENT")throw Error("synthetic persistence failure");});
  await assert.rejects(f.advance(task.id),/synthetic persistence failure/);assert.equal(f.calls,1);f.fault(undefined);f.restart();
  assert.equal(f.engine.get(task.id).stage,"MODEL_NOT_SENT");assert.equal(f.engine.get(task.id).usedTokens,100);assert.equal(f.calls,1);assert.equal(f.runnerCalls,0);
});
