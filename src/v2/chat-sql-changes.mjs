import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { allContextIds, getContext, otherHoldingsScope, validationFamilyForContext } from "./context.mjs";
import { agentContextDerivationRequest, verifiedAgentContextExecution } from "./agent-context-derivation.mjs";
import { uuid } from "./live-lifecycle-checkpoint.mjs";
import { storedExecutionStages } from "./live-lifecycle-execution.mjs";
import { storedAgentExecutionEvidence } from "./agent-execution-evidence.mjs";
import { deliverySourceExecutionIssue } from "./delivery-source-evidence.mjs";

const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const conflict = (message="原对话的口径变更记录尚未核实") =>
  Object.assign(Error(message),{status:409,code:"CHAT_CHANGE_UNCONFIRMED"});
export const chatChangeRequestKey = value => typeof value==="string" && /^chat-derive-v1-[a-f0-9]{64}$/.test(value);
// Use the ordinary per-owner durable namespace across both task runners. The
// original-request reader and invited creation quota already consult this key.
export const chatChangeLedger = (project, actor, requestId) => `${project}:durable-agent:${actor}:${requestId}`;
const nextKey = (intentId, previousTaskId) => "chat-derive-v1-"+hash([intentId,previousTaskId]);
const requestHash = (binding,requestId,contextId,message) => hash([binding,requestId,contextId,message]);

// Keep stable dataset pairing in the registry. Switching only the asset scope on
// identical input lets an engineer attribute the amount difference to that scope.
function contextChoices(sourceId) {
  const describe = id => {
    const context=getContext(id);
    if (!context) throw conflict("原代码声明的业务口径不在当前项目目录");
    const { name,definition } = context;
    return {id,name,definition};
  };
  const source=describe(sourceId);
  if (!allContextIds.includes(sourceId)) return {source,targets:[]};
  const paired=otherHoldingsScope(sourceId);
  const targets=allContextIds.filter(id=>id!==sourceId).map(id=>({...describe(id),recommended:id===paired}));
  return {source,targets};
}

function confirmedAssertionFailure(task,read) {
  if (!["FAILED","VALIDATION_FAILED"].includes(task.status) || !Number.isFinite(Date.parse(task.finishedAt))) return false;
  const last=task.attempts?.at(-1), run=last?.runId && read("run",last.runId);
  if (!run || last.status!=="VALIDATION_FAILED" || run.status!==last.status || deliverySourceExecutionIssue(run) ||
      !Number.isFinite(Date.parse(run.finishedAt)) || run.validation?.passed!==false ||
      !(run.validation.selectedPassed===false || run.validation.regressions?.some(check=>check.passed===false))) return false;
  if (task.executionMode==="DURABLE_SQL_AGENT_V1") return Boolean(storedAgentExecutionEvidence(task,read).settledFailure);
  const {model,spark}=storedExecutionStages(task,read);
  return model?.usage==="RECORDED" && model.state==="OUTPUT_RECORDED" && model.ledgerTokens>0 &&
    !model.unconfirmedAttempts && !model.unattributedTokens && !model.reservedTokens &&
    spark?.state==="RESULT_RECORDED" && spark.resultStatus===run.status &&
    task.attempts.every(attempt=>{
      const receipt=attempt.runId&&read("run",attempt.runId);
      return receipt?.agentTaskId===task.id && receipt.status===attempt.status &&
        receipt.revisionId===attempt.revisionId && receipt.isolation!=="FUNCTION_PROCESS" && !receipt.remoteSubmission &&
        receipt.code!=="REMOTE_SPARK_TIMEOUT" && ["VALIDATION_FAILED","FAILED"].includes(receipt.status) &&
        Number.isFinite(Date.parse(receipt.finishedAt));
    });
}

// Read only persisted children addressed by the original intent and prior slot.
// An unrelated derivation of the same source (including editor tasks) has no
// claim on a chat slot, even when its SQL and target are identical.
export function chatSqlChanges({evidence,store,actor,project,authorizeChild}) {
  const {binding,sql}=evidence, {intentId}=binding;
  const {source,targets}=contextChoices(binding.contextId);
  const read=(kind,id)=>store.get(kind,id,project);
  const derivation=agentContextDerivationRequest(binding);
  let eligible=false, reason;
  if (targets.length && evidence.codeSource==="RECORDED_MODEL") {
    try {
      verifiedAgentContextExecution({derivation,actorId:actor,currentSql:sql,project,read});
      eligible=true;
    } catch (error) {
      if (error?.code!=="AGENT_CONTEXT_SOURCE_INVALID") throw error;
    }
  }
  if (!eligible) reason=evidence.codeSource==="SYNTHETIC_MODEL"
    ? "这份 SQL 来自测试模型。请选择已登记模型生成并经 Spark 完整核验的原生持仓版本。"
    : "此版本缺少已登记持仓口径、原生模型来源或完整的 Spark 独立验证。";
  const changes=[],seen=new Set();
  let requestId=nextKey(intentId,null), blocking=false;
  const parent={...derivation,contextId:binding.contextId,validationContractId:validationFamilyForContext(binding.contextId)?.id};
  for (;;) {
    const ledger=chatChangeLedger(project,actor,requestId);
    const taskId=store.deduplicatedId(ledger);
    if (!taskId) break;
    if (blocking || seen.has(taskId)) throw conflict();
    seen.add(taskId);
    const task=read("agent",taskId);
    if (!task || task.submittedBy!==actor || task.projectId!==project || task.language!=="SPARK_SQL" ||
        task.chatChange?.intentId!==intentId || task.chatChange.requestId!==requestId ||
        !targets.some(target=>target.id===task.contextId) || !isDeepStrictEqual(task.derivedFrom,parent) ||
        task.initialSql!==sql || typeof task.message!=="string" ||
        store.deduplicatedId(ledger,requestHash(binding,requestId,task.contextId,task.message))!==taskId) throw conflict();
    authorizeChild(task);
    const change={requestId,taskId,contextId:task.contextId,message:task.message,status:task.status};
    const attempt=task.attempts?.at(-1);
    const settledFailure=confirmedAssertionFailure(task,read);
    if ((task.status==="SUCCEEDED" || settledFailure) && attempt?.runId && attempt.revisionId) {
      const run=read("run",attempt.runId),rev=read("revision",attempt.revisionId);
      if (!run || !rev || run.status!==attempt.status || run.agentTaskId!==task.id || run.revisionId!==rev.id || run.revisionHash!==rev.hash ||
          run.contextId!==task.contextId || rev.contextId!==task.contextId || rev.author!==actor ||
          task.revisionId!==rev.id || task.runId!==undefined && task.runId!==run.id ||
          rev.sql!==task.sql || typeof rev.sql!=="string" || createHash("sha256").update(rev.sql).digest("hex")!==rev.hash)
        throw conflict();
      // A known terminal revision/run can be cited. Pending or failed provider
      // calls are visible by original task ID without attributing amounts to them.
      Object.assign(change,{revisionId:rev.id,runId:run.id,revisionHash:rev.hash});
    }
    if(task.status==="SUCCEEDED" && (!change.runId||attempt?.status!=="SUCCEEDED")) throw conflict();
    changes.push(change);
    blocking=task.status!=="SUCCEEDED" && !settledFailure;
    requestId=nextKey(intentId,taskId);
  }
  return {protocol:"shuduo-chat-sql-changes/v1",binding,source,targets,eligible,...(reason?{reason}:{}),
    nextRequestId:eligible&&!blocking?requestId:null,changes};
}

export function validateChatChangeInput(input,key) {
  if (!input.chatChange || typeof input.chatChange!=="object" || typeof input.chatChange.intentId!=="string" || !uuid.test(input.chatChange.intentId) ||
      Object.keys(input.chatChange).length!==1 || input.language!=="SPARK_SQL" || !input.derivation ||
      !chatChangeRequestKey(key) || Object.keys(input).some(k=>!["message","sql","contextId","language","derivation","chatChange"].includes(k)))
    throw Object.assign(Error("口径变更须使用原会话、原 SQL、受审目标和该会话给出的请求编号"),{status:422,code:"CHAT_CHANGE_INPUT_INVALID"});
}

export function acceptChatChange({state,evidence,requestId,contextId,message,currentSql,derivation}) {
  if (!isDeepStrictEqual(derivation,agentContextDerivationRequest(evidence.binding)) || currentSql!==evidence.sql ||
      !state.targets.some(target=>target.id===contextId)) throw conflict("会话来源或目标口径与所选版本不一致");
  const existing=state.changes.find(change=>change.requestId===requestId);
  if(existing && (existing.contextId!==contextId || existing.message!==message)) throw conflict("该请求已用于其他口径变更");
  if (!existing && (!state.eligible || requestId!==state.nextRequestId)) throw conflict(state.reason??"请核对原任务及其已有修改请求");
  return {existing, marker:{intentId:evidence.binding.intentId,requestId},
    signature:requestHash(evidence.binding,requestId,contextId,message)};
}
