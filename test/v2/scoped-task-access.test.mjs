import test from 'node:test';
import assert from 'node:assert/strict';
import {publicDevelopmentConfig,developmentSession,assertDevelopmentMutation,assertDevelopmentRecord,assertDevelopmentTargetTask,developmentBackgroundBoundary,assertDevelopmentBackgroundScope} from '../../src/v2/public-development-access.mjs';
import {agentTaskFinished,mayEditScopedTask} from '../../web/src/agent-task-scope.ts';

const now=Date.parse('2026-02-20T10:00:00Z'),project='project-securities-lab';
const id='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const env={V2_LOCAL_DEVELOPMENT:'false',V2_DURABLE_SQL_AGENT_ENABLED:'true',V2_FC_PUBLIC_WRITE_SCOPE:'DEVELOPMENT_ONLY',V2_PUBLIC_DEVELOPMENT_STARTS_AT:new Date(now-1000).toISOString(),V2_PUBLIC_DEVELOPMENT_EXPIRES_AT:new Date(now+3600000).toISOString(),V2_BOOTSTRAP_ADMIN_EMAIL:'owner@example.invalid',V2_PUBLIC_DEVELOPMENT_TASK_ID:id};
const config=publicDevelopmentConfig(env);
const owner={id:'synthetic-owner',email:env.V2_BOOTSTRAP_ADMIN_EMAIL,status:'ACTIVE',memberships:[{projectId:project,role:'ADMIN'}]};
const session={role:'ADMIN',user:owner};
const task={id,submittedBy:owner.id,executionMode:'DURABLE_SQL_AGENT_V1',language:'SPARK_SQL',contextId:'stock-cash-t1',createdAt:new Date(now-7200000).toISOString(),attempts:[{revisionId:'old-revision'}]};

test('existing-task scope is optional and fail-closed; private task ID is not disclosed to guests or other users',()=>{
  assert.equal(publicDevelopmentConfig({...env,V2_PUBLIC_DEVELOPMENT_TASK_ID:''}).taskId,undefined);
  for(const value of [' '+id,id.toUpperCase()+'Z',42,{},'not-a-uuid'])assert.throws(()=>publicDevelopmentConfig({...env,V2_PUBLIC_DEVELOPMENT_TASK_ID:value}),/INVALID/);
  assert.equal(developmentSession(config,session,now).developmentTaskId,id);
  for(const candidate of [undefined,{...session,user:{...owner,email:'other@example.invalid'}},{...session,role:'ENGINEER'}]){
    const view=developmentSession(config,candidate,now);
    assert.equal(view.developmentTaskOnly,true);assert.equal(view.developmentTaskId,undefined);assert.equal(view.readOnly,true);
  }
  assert.equal(developmentSession(config,session,config.expiresAt).developmentTaskId,undefined);
});
test('the fresh window permits only the explicit old task, no new or derived task, publishing or credential changes',()=>{
  for(const suffix of ['advance','cancel','prepare-delivery','background','background/cancel','background/resume']){
    assert.doesNotThrow(()=>assertDevelopmentMutation(config,session,'POST',`/api/v2/agent/tasks/${id}/${suffix}`,now));
    assert.throws(()=>assertDevelopmentMutation(config,session,'POST',`/api/v2/agent/tasks/${other}/${suffix}`,now),{code:'PUBLIC_DEVELOPMENT_TARGET_ONLY'});
  }
  assert.throws(()=>assertDevelopmentMutation(config,session,'POST','/api/v2/agent/tasks',now),{code:'PUBLIC_DEVELOPMENT_TARGET_ONLY'});
  for(const path of ['/api/v2/releases','/api/v2/data-services/applications',`/api/v2/agent/tasks/${id}/publication`])assert.throws(()=>assertDevelopmentMutation(config,session,'POST',path,now),{code:'PUBLIC_DEVELOPMENT_SCOPE_DENIED'});
  assert.doesNotThrow(()=>assertDevelopmentMutation(config,undefined,'GET',`/api/v2/agent/tasks/${other}`,config.expiresAt));
});
test('trusted lineage, not a timestamp or same owner, determines the editable task/revision',()=>{
  const original=structuredClone(task),options={task,now};
  assertDevelopmentRecord(config,session,task,options);
  const revision={id:'old-revision',author:owner.id,contextId:task.contextId,createdAt:task.createdAt};
  assertDevelopmentRecord(config,session,revision,options);
  const manual={...revision,id:'manual-revision',source:'MANUAL',manualProvenance:{kind:'ENGINEER_EDIT',actorId:owner.id,originAgentTaskId:id}};
  assertDevelopmentRecord(config,session,manual,options);
  for(const item of [{...task,id:other,createdAt:new Date(now).toISOString()},{...revision,id:'unrelated'},{...revision,contextId:'holdings-t1'},{...manual,manualProvenance:{...manual.manualProvenance,originAgentTaskId:other}},{...manual,manualProvenance:{...manual.manualProvenance,actorId:'other-owner'}},{...manual,source:'LIVE_MODEL'}])assert.throws(()=>assertDevelopmentRecord(config,session,item,options),{code:'PUBLIC_DEVELOPMENT_TARGET_ONLY'});
  assert.deepEqual(task,original,'validation must not rewrite createdAt, attempts or checkpoints');
  assert.throws(()=>assertDevelopmentRecord(config,session,task,{task,now:config.expiresAt}),{code:'PUBLIC_DEVELOPMENT_CLOSED'});
});
test('execution rechecks active project membership and original actor, not just the email in the request',()=>{
  assertDevelopmentTargetTask(config,task,owner,project,now);
  for(const invalid of [{...owner,status:'DISABLED'},{...owner,id:'foreign'},{...owner,memberships:[]},{...owner,memberships:[{projectId:project,role:'ENGINEER'}]}])assert.throws(()=>assertDevelopmentTargetTask(config,task,invalid,project,now));
  assert.throws(()=>assertDevelopmentTargetTask(config,undefined,owner,project,now));
});
test('public background delegation is bound to both the window and task; missing, closed or superseded windows cannot advance',()=>{
  const boundary=developmentBackgroundBoundary(config,id,now);
  assertDevelopmentBackgroundScope(config,task,owner,project,boundary,now);
  for(const changed of [undefined,{...config,startsAt:config.startsAt+1},{...config,expiresAt:config.expiresAt+1},{...config,taskId:other}])assert.throws(()=>assertDevelopmentBackgroundScope(changed,task,owner,project,boundary,now),{code:'PUBLIC_DEVELOPMENT_BACKGROUND_SCOPE_CHANGED'});
  assert.throws(()=>assertDevelopmentBackgroundScope(config,task,owner,project,undefined,now),{code:'PUBLIC_DEVELOPMENT_BACKGROUND_SCOPE_CHANGED'});
  assert.throws(()=>assertDevelopmentBackgroundScope(config,task,owner,project,boundary,config.expiresAt),{code:'PUBLIC_DEVELOPMENT_CLOSED'});
  assert.throws(()=>developmentBackgroundBoundary(config,other,now),{code:'PUBLIC_DEVELOPMENT_TARGET_ONLY'});
});
test('UI keeps interrupted tasks resumable and unrelated task editors read-only',()=>{
  assert.equal(agentTaskFinished('INTERRUPTED'),false);assert.equal(agentTaskFinished('RUNNING'),false);
  for(const status of ['SUCCEEDED','FAILED','CANCELLED'])assert.equal(agentTaskFinished(status),true);
  assert.equal(mayEditScopedTask(true,id,id,undefined),true);
  assert.equal(mayEditScopedTask(true,id,undefined,id),true);
  assert.equal(mayEditScopedTask(true,id,other,id),false);
  assert.equal(mayEditScopedTask(true,undefined,id,id),false);
  assert.equal(mayEditScopedTask(true,id,undefined,undefined),false);
  assert.equal(mayEditScopedTask(false,undefined,other,undefined),true);
});
