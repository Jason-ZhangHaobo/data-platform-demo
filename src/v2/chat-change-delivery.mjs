import { isDeepStrictEqual as same } from 'node:util';
import { agentContextDerivationRequest, verifiedAgentContextExecution } from './agent-context-derivation.mjs';
import { agentCalendarMatches } from './agent-calendar-preparation.mjs';
import { sha256, validateDeliveryPackage } from './delivery.mjs';
import { matchesStoredHoldingsRehearsal } from './delivery-runner.mjs';
import { sqlRequirementBinding } from './sql-requirements.mjs';

const conflict = (message='所选子任务的交付来源或文件演练回执未能核实') =>
  Object.assign(Error(message),{code:'CHAT_CHANGE_DELIVERY_UNCONFIRMED',status:409});
const stages = new Set(['QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED','INTERRUPTED']);

function deliveryRequestId(intentId,changeRequestId,source) {
  const h=sha256(JSON.stringify(['chat-change-delivery/v1',intentId,changeRequestId,source]));
  // A deterministic UUID compatible with existing per-task preparation receipts.
  return h.slice(0,8)+'-'+h.slice(8,12)+'-8'+h.slice(13,16)+'-a'+h.slice(17,20)+'-'+h.slice(20,32);
}

function preparationLedger({source,requestId,requirement},project) {
  const {taskId,runId,revisionHash}=source;
  return {key:`${project}:agent-delivery:${taskId}:${requestId}`,
    signature:sha256(JSON.stringify({agentTaskId:taskId,runId,revisionHash,...(requirement?{requirement}:{})}))};
}

// An explicit prepare may reuse a delivery started in the workbench. Bind the
// conversation's receipt before acknowledging it, even if it was interrupted.
export function retainChatChangeDelivery(selection,store,project,deliveryId) {
  const {key,signature}=preparationLedger(selection,project);
  const saved=store.deduplicate(key,signature,()=>({id:deliveryId}));
  if(saved.id!==deliveryId) throw conflict();
}

export function selectChatChangeDelivery({state,changeRequestId,store,project,actor}) {
  const changed=state.changes.find(change=>change.requestId===changeRequestId);
  if(!changed) throw Object.assign(Error('未找到本对话的口径变更'),{status:404,code:'CHAT_CHANGE_NOT_FOUND'});
  if(!state.eligible || changed.status!=='SUCCEEDED' || !changed.runId || !changed.revisionId || !changed.revisionHash)
    throw conflict('须先核对原会话和修改后的成功 SQL 运行');
  const {intentId,...parent}=state.binding;
  const {taskId,contextId,revisionId,revisionHash,runId}=changed;
  const source={taskId,contextId,revisionId,revisionHash,runId};
  const read=(kind,id)=>store.get(kind,id,project);
  const currentSql=read('agent',taskId)?.sql;
  const {task,revision,run,family}=verifiedAgentContextExecution({
    derivation:agentContextDerivationRequest(source),actorId:actor,currentSql,project,read,
  });
  const requirement=task.requirements ? sqlRequirementBinding(task.requirements) : undefined;
  return {intentId,changeRequestId,parent,source,task,revision,run,family,requirement,
    requestId:deliveryRequestId(intentId,changeRequestId,source)};
}

export function checkChatDeliveryRequest(selection,body,key) {
  if(!body || typeof body!=='object' || Array.isArray(body) || Object.keys(body).length!==2 ||
      body.confirm!==true || !Object.hasOwn(body,'source')) throw Object.assign(Error('请先审阅并确认所选子版本及演练范围'),{status:422});
  if(!same(body.source,selection.source)||key!==selection.requestId) throw conflict('请核对原会话所选子版本、批次和准备请求编号');
}

function rehearsalEvidence(record,plan,bundle,delivery) {
  if(record.packageId!==bundle.id || record.packageDigest!==bundle.digest || record.agentDeliveryTaskId!==delivery.id ||
    !stages.has(record.status)) throw conflict();
  const {id,status,engine,engineVersion,mainSqlExecuted,finishedAt}=record;
  const checks=record.validation?.regressions;
  if(status==='SUCCEEDED' && (!matchesStoredHoldingsRehearsal(plan,bundle,record) ||
      record.validation.selectedPassed===false || !Number.isFinite(Date.parse(finishedAt))))
    throw conflict('调度、部署、测试 SQL 或独立结果与所选交付包不符');
  return {id,status,engine,engineVersion,mainSqlExecuted,finishedAt,
    ...(status==='SUCCEEDED'?{scheduledFor:record.scheduledFor,businessDate:record.occurrence.businessDate,
      executionOrder:record.workflowTrace.map(step=>step.id)}:{}),
    ...(record.testSqlValidation?{testSqlValidation:{passed:record.testSqlValidation.passed,sqlHash:record.testSqlValidation.sqlHash}}:{}),
    ...(record.validation?{validation:{passed:record.validation.passed,regressions:Array.isArray(checks)?checks.map(({contextId,passed})=>({contextId,passed})):[]}}:{})};
}

export function checkChatDeliveryBundle(selection,bundle,plan) {
  const {source,task,revision,requirement,family}=selection;
  if(plan.source.runId!==source.runId || plan.source.revisionId!==source.revisionId || plan.source.sqlHash!==source.revisionHash ||
      plan.source.projectId!==task.projectId || plan.source.contextId!==source.contextId || plan.source.validationContractId!==family.id ||
      !same(plan.source.derivation,task.derivedFrom) || !same(plan.source.requirement,requirement) ||
      !agentCalendarMatches(bundle,undefined) || bundle.files['main.sql']!==revision.sql)throw conflict();
}

export function storedChatChangeDelivery(selection,{store,project,artifacts}) {
  const {intentId,changeRequestId,requestId,parent,source,task,requirement}=selection;
  const base={protocol:'shuduo-chat-change-delivery/v1',intentId,changeRequestId,requestId,parent,source};
  const {taskId,revisionId,runId,revisionHash}=source;
  const {key,signature}=preparationLedger(selection,project);
  const recorded=store.deduplicatedId(key);
  const matches=item=>item.mode==='VERIFIED_ARTIFACT_ORCHESTRATION' && item.sourceAgentTaskId===taskId &&
    item.sourceRevisionId===revisionId && item.sourceRunId===runId && item.sourceSqlHash===revisionHash &&
    !item.calendarSelection && !item.signedPackageDigest && same(item.sourceRequirementBinding,requirement) &&
    (item.sourceKind===undefined || item.sourceKind==='AGENT') && (!item.submittedBy || item.submittedBy===task.submittedBy);
  let delivery;
  if(recorded){
    delivery=store.get('agent_delivery_task',recorded,project);
    if(!delivery || store.deduplicatedId(key,signature)!==recorded || !matches(delivery)) throw conflict();
  } else {
    const candidates=store.list('agent_delivery_task',project).filter(matches);
    if(candidates.length>1)throw conflict('此版本有多个独立交付记录，请从专业工作台核对确切原编号');
    [delivery]=candidates;
  }
  if(!delivery)return {...base,status:'NOT_PREPARED'};
  if(!stages.has(delivery.status))throw conflict();
  const {id,status,stage,packageId,packageDigest,verificationId}=delivery;
  const view={...base,status,delivery:{id,status,stage,packageId,packageDigest,verificationId,
    sourceAgentTaskId:taskId,sourceRevisionId:revisionId,sourceSqlHash:revisionHash,sourceRunId:runId}};
  const {bundle,verification}=artifacts(delivery);
  if(!bundle) {
    if(packageId || packageDigest || verificationId || status==='SUCCEEDED')throw conflict();
    return view;
  }
  const plan=validateDeliveryPackage(bundle,packageDigest);
  checkChatDeliveryBundle(selection,bundle,plan);
  view.package={id:bundle.id,digest:bundle.digest,manifest:bundle.manifest,files:bundle.files};
  if(verification) view.verification=rehearsalEvidence(verification,plan,bundle,delivery);
  if(status==='SUCCEEDED' && (!delivery.actualExecution || view.verification?.status!=='SUCCEEDED'))throw conflict();
  return view;
}
