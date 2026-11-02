import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import { failedRunRepairAction, submitFailedRunRepair } from '../../web/src/agent-repair-action.ts';

let componentSource=ts.transpileModule(readFileSync('web/src/AgentRepairAction.tsx','utf8'),{
  compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022},
}).outputText;
for(const pkg of ['react','react/jsx-runtime'])componentSource=componentSource.replaceAll(`from "${pkg}"`,`from ${JSON.stringify(import.meta.resolve(pkg))}`);
componentSource=componentSource.replaceAll('from "./agent-repair-action"',`from ${JSON.stringify(new URL('../../web/src/agent-repair-action.ts',import.meta.url).href)}`);
const {AgentRepairAction}=await import(`data:text/javascript;base64,${Buffer.from(componentSource).toString('base64')}`);
function elements(root,type){
  if(!React.isValidElement(root))return[];
  return [...(root.type===type?[root]:[]),...React.Children.toArray(root.props.children).flatMap(child=>elements(child,type))];
}

const input = () => ({
  taskOnly:false,taskStatus:'FAILED',ready:true,canWrite:true,working:false,dirty:false,
  pendingResult:false,hasContext:true,baselineRevisionId:'saved-revision',
  run:{id:'original-failed-run',revisionId:'saved-revision',status:'VALIDATION_FAILED'},
});

async function attempt(state) {
  const submissions=[],explanations=[];
  const submitted=await submitFailedRunRepair(state,{
    submit:async request=>{submissions.push(request);},explain:reason=>explanations.push(reason),
  });
  return {submitted,submissions,explanations};
}

test('target-only never dispatches a new task, including an exhausted original task',async()=>{
  for(const taskStatus of ['FAILED','CANCELLED','SUCCEEDED']){
    const state={...input(),taskOnly:true,taskStatus},before=structuredClone(state);
    const view=failedRunRepairAction(state),result=await attempt(state);
    assert.equal(view.visible,true);assert.equal(view.request,undefined);
    assert.match(view.reason,/原任务已结束/);assert.match(view.reason,/保存并运行我的代码/);
    assert.match(view.reason,/费用预留保持不变/);
    assert.deepEqual(result,{submitted:false,submissions:[],explanations:[view.reason]});
    assert.deepEqual(state,before,'repair guidance must not rewrite the original failure or counters');
  }
});

test('a resumable scoped task points to existing continuation instead of creating another task',async()=>{
  const state={...input(),taskOnly:true,taskStatus:'QUEUED'};
  const view=failedRunRepairAction(state),result=await attempt(state);
  assert.match(view.reason,/继续任务/);assert.match(view.reason,/审阅并恢复云后台/);
  assert.doesNotMatch(view.reason,/原任务已结束/);
  assert.equal(result.submitted,false);assert.equal(result.submissions.length,0);
  assert.equal(result.explanations.length,1);
});

test('a scoped manual version offers manual repair without inventing the original task status',async()=>{
  const state={...input(),taskOnly:true,taskStatus:undefined},view=failedRunRepairAction(state);
  assert.match(view.reason,/当前是人工接管版本/);assert.match(view.reason,/保存并运行我的代码/);
  assert.doesNotMatch(view.reason,/原任务已结束|继续任务/);
  assert.equal((await attempt(state)).submissions.length,0);
});

test('unrestricted repair submits exactly the bound failed run once and retains the input',async()=>{
  const state=input(),before=structuredClone(state);
  const view=failedRunRepairAction(state),result=await attempt(state);
  assert.match(view.reason,/新建任务/);assert.match(view.reason,/不是恢复原任务/);
  assert.equal(result.submitted,true);assert.equal(result.submissions.length,1);
  assert.equal(result.submissions[0].sourceRunId,state.run.id);
  assert.match(result.submissions[0].message,/独立业务校验/);
  assert.deepEqual(result.explanations,[]);assert.deepEqual(state,before);
});

test('visible disabled reasons also block dispatch, rather than silently accepting a click',async()=>{
  for(const [patch,reason] of [
    [{canWrite:false},/没有开发写入权限/],
    [{working:true},/当前操作尚未结束/],
    [{pendingResult:true},/结果尚未确认/],
    [{dirty:true},/未保存修改/],
    [{baselineRevisionId:'different-revision'},/不属于当前代码版本/],
    [{baselineRevisionId:undefined},/不属于当前代码版本/],
    [{ready:false},/尚未就绪/],
    [{hasContext:false},/业务口径尚未读取完成/],
  ]){
    const state={...input(),...patch},view=failedRunRepairAction(state),result=await attempt(state);
    assert.equal(view.request,undefined);assert.match(view.reason,reason);
    assert.equal(result.submitted,false);assert.deepEqual(result.submissions,[]);
    assert.deepEqual(result.explanations,[view.reason]);
  }
});

test('successful, pending and absent runs cannot start a repair',async()=>{
  for(const run of [undefined,...['SUCCEEDED','QUEUED','RUNNING','CANCELLED','INTERRUPTED'].map(status=>({...input().run,status}))]){
    const state={...input(),run},view=failedRunRepairAction(state),result=await attempt(state);
    assert.equal(view.visible,false);assert.equal(view.request,undefined);
    assert.equal(result.submitted,false);assert.deepEqual(result.submissions,[]);
  }
});

test('failed submission propagates the error and is not automatically retried',async()=>{
  let calls=0;
  await assert.rejects(submitFailedRunRepair(input(),{
    submit:async()=>{calls++;throw new Error('synthetic unknown response');},
    explain:()=>assert.fail('an allowed repair should use submission recovery'),
  }),/synthetic unknown response/);
  assert.equal(calls,1);
});

test('actual scoped control renders a usable code anchor and never offers a new-task click',()=>{
  let calls=0;
  const props={input:{...input(),taskOnly:true},onSubmit:async()=>{calls++;},onExplain:()=>{calls++;}};
  const tree=AgentRepairAction(props),html=renderToStaticMarkup(React.createElement(AgentRepairAction,props));
  assert.equal(elements(tree,'button').length,0);
  assert.equal(elements(tree,'a')[0].props.href,'#agent-code');
  assert.match(html,/查看代码并人工接管/);assert.match(html,/保存并运行我的代码/);
  assert.doesNotMatch(html,/>基于失败批次新建修正任务</);
  assert.equal(calls,0,'rendering and choosing the code anchor do not submit work');
});

test('actual new-task button dispatches the original run, while disabled callbacks still cannot submit',async()=>{
  const submissions=[],explanations=[],actions={onSubmit:async request=>{submissions.push(request);},onExplain:reason=>explanations.push(reason)};
  const allowed=AgentRepairAction({input:input(),...actions}),button=elements(allowed,'button')[0];
  assert.equal(button.props.disabled,false);assert.match(renderToStaticMarkup(allowed),/基于失败批次新建修正任务/);
  await button.props.onClick();assert.equal(submissions.length,1);assert.equal(submissions[0].sourceRunId,input().run.id);
  for(const patch of [{canWrite:false},{dirty:true},{pendingResult:true},{working:true},{ready:false},{hasContext:false},{baselineRevisionId:'other'}]){
    const tree=AgentRepairAction({input:{...input(),...patch},...actions}),disabled=elements(tree,'button')[0];
    assert.equal(disabled.props.disabled,true);assert.match(renderToStaticMarkup(tree),/disabled=""/);
    await disabled.props.onClick(); // Force the handler to check its own gate, not just the DOM attribute.
    assert.equal(submissions.length,1);
  }
  assert.equal(explanations.length,7);
});
