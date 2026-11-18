import test from 'node:test';
import assert from 'node:assert/strict';
import {nextDevelopmentFeedback,developmentValidationScenarios} from '../../web/src/development-feedback.ts';

test('an executing batch reveals its failure details when no feedback page was manually selected',()=>{
  let state=nextDevelopmentFeedback(undefined,{id:'original-run',status:'RUNNING'});
  state=nextDevelopmentFeedback(state,{id:'original-run',status:'VALIDATION_FAILED'});
  assert.equal(state.tab,'校验');
  state=nextDevelopmentFeedback(undefined,{id:'execution-error',status:'FAILED'});
  assert.equal(state.tab,'日志');
});

test('manual feedback selection survives same-batch refresh, temporary clearing, and completion',()=>{
  let state={...nextDevelopmentFeedback(undefined,{id:'original-run',status:'RUNNING'}),tab:'日志',manual:true};
  const saved=state;
  state=nextDevelopmentFeedback(state,undefined);
  assert.equal(state,saved);
  state=nextDevelopmentFeedback(state,{id:'original-run',status:'VALIDATION_FAILED'});
  assert.equal(state.tab,'日志');assert.equal(state.manual,true);
  state=nextDevelopmentFeedback(state,{id:'original-run',status:'VALIDATION_FAILED'});
  assert.equal(state.tab,'日志');
});

test('another batch selects its own feedback and does not inherit the prior batch selection',()=>{
  const prior={id:'failed-batch',status:'VALIDATION_FAILED',tab:'字段来源',manual:true};
  let state=nextDevelopmentFeedback(prior,{id:'new-failed-batch',status:'FAILED'});
  assert.equal(state.tab,'日志');assert.equal(state.manual,false);
  state=nextDevelopmentFeedback(state,{id:'verified-batch',status:'SUCCEEDED'});
  assert.equal(state.tab,'结果');assert.equal(state.manual,false);
  assert.equal(prior.tab,'字段来源');
});

test('failed scenario receipts appear first while original evidence and within-group order are preserved',()=>{
  const passed={contextId:'base',passed:true},failed={contextId:'duplicate-position',passed:false};
  const original=Object.freeze([passed,failed,{contextId:'cash-change',passed:true},{contextId:'empty-client',passed:false}]);
  const visible=developmentValidationScenarios(original);
  assert.deepEqual(visible.map(x=>x.contextId),['duplicate-position','empty-client','base','cash-change']);
  assert.equal(visible[0],failed);assert.equal(original[0],passed);
  assert.deepEqual(developmentValidationScenarios(undefined),[]);
});
