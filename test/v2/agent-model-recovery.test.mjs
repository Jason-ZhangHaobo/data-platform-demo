import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {agentResumeDecision,modelRecoveryNeedsAction,pauseModelRecovery,submitAgentResume} from '../../web/src/agent-model-recovery.ts';

let source=ts.transpileModule(readFileSync('web/src/AgentModelRecovery.tsx','utf8'),{
  compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022},
}).outputText;
for(const pkg of ['react','react/jsx-runtime'])source=source.replaceAll(`from "${pkg}"`,`from ${JSON.stringify(import.meta.resolve(pkg))}`);
const {AgentModelRecovery}=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const input=(stage='MODEL_NOT_SENT')=>({
  task:{id:'original-task',status:'INTERRUPTED',stage,version:7,usedTokens:24000,
    attempts:[{status:'MODEL_OUTCOME_UNKNOWN',usageEstimated:true},{status:'MODEL_NOT_SENT',usageEstimated:true}]},
  canWrite:true,working:false,dirty:false,pendingResult:false,retryConsent:false,
});

test('actual not-sent notice has no unknown-billing checkbox and never performs work on render',()=>{
  let effects=0;
  const html=renderToStaticMarkup(React.createElement(AgentModelRecovery,{
    stage:'MODEL_NOT_SENT',consent:true,disabled:false,onConsent:()=>{effects++;},
  }));
  assert.match(html,/本次模型请求未发送/);assert.match(html,/修复后重试原任务/);
  assert.match(html,/再次执行将实际发送模型请求，可能产生费用/);
  assert.match(html,/原任务、尝试次数及预算预留保留/);
  assert.doesNotMatch(html,/type="checkbox"|上次模型结果未知，可能已产生费用/);
  assert.equal(effects,0);
});

test('legacy unknown still renders and requires its explicit cost consent',async()=>{
  let consent;
  const tree=AgentModelRecovery({stage:'MODEL_OUTCOME_UNKNOWN',consent:false,disabled:false,onConsent:value=>{consent=value;}});
  const checkbox=React.Children.toArray(tree.props.children).find(child=>React.isValidElement(child)&&child.type==='input');
  assert.equal(checkbox.props.checked,false);assert.equal(checkbox.props.type,'checkbox');
  checkbox.props.onChange({target:{checked:true}});assert.equal(consent,true);
  const html=renderToStaticMarkup(tree);assert.match(html,/可能已产生费用/);
  assert.doesNotMatch(html,/本次模型请求未发送/);
  const calls=[],explanations=[],state=input('MODEL_OUTCOME_UNKNOWN');
  const actions={submit:async confirmed=>calls.push(confirmed),explain:reason=>explanations.push(reason)};
  assert.equal(await submitAgentResume(state,actions),false);assert.deepEqual(calls,[]);
  assert.match(explanations[0],/勾选确认/);
  assert.equal(await submitAgentResume({...state,retryConsent:true},actions),true);assert.deepEqual(calls,[true]);
});

test('explicit not-sent resume preserves the original task and history and never carries stale unknown consent',async()=>{
  for(const retryConsent of [false,true]){
    const state={...input(),retryConsent},before=structuredClone(state),calls=[];
    assert.equal(agentResumeDecision(state).reason,undefined);
    assert.equal(await submitAgentResume(state,{submit:async confirmed=>calls.push({id:state.task.id,version:state.task.version,confirmed}),explain:()=>assert.fail('must be allowed')}),true);
    assert.deepEqual(calls,[{id:'original-task',version:7,confirmed:false}]);
    assert.deepEqual(state,before,'not-sent does not release reservations or rewrite historical unknown attempts');
  }
});

test('permission, task completion, drafts, work in progress and unresolved receipts prevent even forced resume handlers',async()=>{
  for(const patch of [
    {canWrite:false},{working:true},{dirty:true},{pendingResult:true},
    {task:{...input().task,status:'FAILED'}},{task:{...input().task,status:'CANCELLED'}},
    {task:{...input().task,version:0}},{task:{...input().task,version:NaN}},
  ]){
    const state={...input(),...patch},calls=[],explanations=[];
    const decision=agentResumeDecision(state);assert.ok(decision.reason);
    assert.equal(await submitAgentResume(state,{submit:async value=>calls.push(value),explain:value=>explanations.push(value)}),false);
    assert.deepEqual(calls,[]);assert.deepEqual(explanations,[decision.reason]);
  }
});

test('both recovery stages stop automatic progression; explicit not-sent permission is not unknown cost consent',()=>{
  assert.equal(pauseModelRecovery('MODEL_NOT_SENT'),true);
  assert.equal(pauseModelRecovery('MODEL_NOT_SENT',{confirmModelRetry:true}),true);
  assert.equal(pauseModelRecovery('MODEL_NOT_SENT',{explicitNotSentRetry:true}),false);
  assert.equal(pauseModelRecovery('MODEL_OUTCOME_UNKNOWN'),true);
  assert.equal(pauseModelRecovery('MODEL_OUTCOME_UNKNOWN',{explicitNotSentRetry:true}),true);
  assert.equal(pauseModelRecovery('MODEL_OUTCOME_UNKNOWN',{confirmModelRetry:true}),false);
  for(const stage of ['MODEL_NOT_SENT','MODEL_OUTCOME_UNKNOWN'])assert.equal(modelRecoveryNeedsAction(stage),true);
  for(const stage of ['READY_FOR_MODEL','WAITING_FOR_RUN',undefined]){
    assert.equal(pauseModelRecovery(stage),false);assert.equal(modelRecoveryNeedsAction(stage),false);
  }
  // Once the explicit first advance has been sent, the next not-sent result is
  // an action boundary again, never another paid request in the same loop.
  assert.equal(pauseModelRecovery('MODEL_NOT_SENT',{explicitNotSentRetry:false}),true);
});

test('actual workspace wires the explicit resume guard and stops its loop at both recovery boundaries',()=>{
  const ui=readFileSync('web/src/AgentDevelopmentWorkbench.tsx','utf8');
  assert.match(ui,/explicitNotSentRetry = manualTakeover && start\.stage === "MODEL_NOT_SENT"/);
  assert.match(ui,/pauseModelRecovery\(current\.stage,\{explicitNotSentRetry,confirmModelRetry:confirmRetry\}\)/);
  assert.match(ui,/explicitNotSentRetry = false;\s*current = await api<Task>\(`\/agent\/tasks\/\$\{current\.id\}\/advance`/);
  assert.match(ui,/agentTaskFinished\(current\.status\) \|\| modelRecoveryNeedsAction\(current\.stage\)/);
  assert.equal((ui.match(/submitAgentResume\(resumeInput/g)||[]).length,2);
  assert.match(ui,/<AgentModelRecovery stage=\{task\.stage\}/);
  assert.match(ui,/修复后重试原任务/);assert.match(ui,/修复后恢复后台/);
});
