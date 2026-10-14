import test from "node:test";
import assert from "node:assert/strict";
import {renderAgentEventPlan} from "../../scripts/render-v2-agent-event-plan.mjs";
import {AGENT_WAKE_PREFIX} from "../../src/v2/agent-event-driver.mjs";
import {SPARK_QUEUE_PREFIXES} from "../../src/v2/remote-spark-queue.mjs";
const input={accountId:"111122223333",region:"cn-hangzhou",bucket:"fictional-securities-test",functionName:"fictional-control",
  ossInvocationRoleArn:"acs:ram::111122223333:role/fictional-oss-events"};
test("event plan reuses verified OSS invocation role without fabricating function-scoped Invoke permission",()=>{
  const p=renderAgentEventPlan(input);assert.equal(p.ok,true);assert.equal(p.apply,false);assert.equal(p.invocationPolicyChange,null);
  assert.equal(p.fcInvokeResourceLevelSupported,false);assert.equal(p.invocationRoleGate.stopIfExistingInvokeMissing,true);
  assert.equal(p.triggers.length,2);assert.equal(p.limits.idlePolling,false);assert.equal(p.limits.automaticPublication,false);
  assert.deepEqual(p.runtimePolicy.Statement[0].Action,["oss:GetObject","oss:PutObject"]);
  assert.deepEqual(p.triggers.map(t=>t.triggerConfig.filter.key.prefix),[AGENT_WAKE_PREFIX+"/",SPARK_QUEUE_PREFIXES.results+"/"]);
  assert.ok(!p.triggers.some(t=>t.triggerConfig.filter.key.prefix===SPARK_QUEUE_PREFIXES.jobs+"/"));
});
test("invalid target/account/region fails before any apply plan",()=>{
  for(const bad of [{accountId:"bad"},{region:"cn-beijing"},{bucket:"../private"},{functionName:"../target"},{ossInvocationRoleArn:"acs:ram::999900001111:role/foreign"}]){
    const p=renderAgentEventPlan({...input,...bad});assert.equal(p.ok,false);assert.equal(p.apply,false);
  }
});
