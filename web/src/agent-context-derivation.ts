import { validationFamilyForContextId, regressionsMatchFamily } from "./validation-family.ts";

export type ContextDerivation = { kind:"REGISTERED_CONTEXT_CHANGE"; taskId:string; revisionId:string; runId:string; revisionHash:string };
export type DerivedFrom = ContextDerivation & { contextId:string; validationContractId:string };
export type ContextDerivationDraft = { source:ContextDerivation; targetContextId:string };
export type VerifiedDerivationSource = { source:ContextDerivation; contextId:string; validationContractId:string; sql:string };
export type DerivationLocation = {status:"ABSENT"}|{status:"INVALID";error:string}|{status:"VALID";draft:ContextDerivationDraft};
export type DerivationAccess = {canWrite:boolean;readOnly:boolean;taskOnly:boolean;sourceLocked:boolean;publicationOnly:boolean;working:boolean;pending:boolean;dirty:boolean;unsentMessage?:boolean};
type Native = {sourceKind?:string;sourceAttribution?:unknown;manualProvenance?:unknown;testDouble?:boolean};
export type DerivationTask = Native & {id:string;status:string;mode?:string;language?:string;contextId:string;sql?:string;revisionId?:string;runId?:string;
  attempts:{status:string;model?:string;revisionId?:string;runId?:string}[]};
type Revision = Native & {id:string;hash?:string;sql:string;source?:string;contextId:string};
type Run = Native & {id:string;status:string;agentTaskId?:string;revisionId?:string;revisionHash?:string;contextId?:string;engine?:string;mainSqlExecuted?:boolean;
  validationContractId?:string;validation?:{passed:boolean;contractId?:string;regressions?:{contextId:string;passed:boolean}[]}};
type Workflow = {report?:Native & {status:string;taskId?:string;revisionId?:string;revisionHash?:string;runId?:string;contextId?:string;validationContractId?:string;checks?:{id:string;passed:boolean}[]}};
const uuid=(value:unknown):value is string=>typeof value==="string"&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const hash=(value:unknown):value is string=>typeof value==="string"&&/^[a-f0-9]{64}$/.test(value);
const native=(value:Native|undefined)=>Boolean(value&&[undefined,"AGENT"].includes(value.sourceKind)&&value.sourceAttribution===undefined&&value.manualProvenance===undefined&&value.testDouble!==true);
const knownContext=(value:unknown):value is string=>typeof value==="string"&&Boolean(validationFamilyForContextId(value)?.contextIds.includes(value));
const sourceKeys=["kind","taskId","revisionId","runId","revisionHash"] as const;
const queryKeys={taskId:"derive_task",revisionId:"derive_revision",runId:"derive_run",revisionHash:"derive_hash",targetContextId:"derive_context"} as const;
export function validContextDerivation(value:unknown):value is ContextDerivation{
  if(!value||typeof value!=="object"||Array.isArray(value))return false;
  const source=value as ContextDerivation;
  return Object.keys(source).length===sourceKeys.length&&sourceKeys.every(key=>Object.hasOwn(source,key))&&source.kind==="REGISTERED_CONTEXT_CHANGE"&&
    uuid(source.taskId)&&uuid(source.revisionId)&&uuid(source.runId)&&hash(source.revisionHash);
}
export function contextDerivationFromLocation(href:string):DerivationLocation{
  const invalid=():DerivationLocation=>({status:"INVALID",error:"口径变更来源链接不完整或冲突；未采用其他任务或最新版本。"});
  let query:URLSearchParams;try{query=new URL(href).searchParams;}catch{return invalid();}
  const values=[...query].filter(([key])=>key.startsWith("derive_"));
  if(!values.length)return{status:"ABSENT"};
  if(values.length!==5||new Set(values.map(([key])=>key)).size!==5||values.some(([key])=>!Object.values(queryKeys).includes(key as typeof queryKeys[keyof typeof queryKeys]))||
    [...query.keys()].some(key=>key.startsWith("source_")||["task","revision","run","run_request","origin_task","save_request"].includes(key))||
    query.getAll("agent_request").length>1||query.has("agent_request")&&!uuid(query.get("agent_request")))return invalid();
  const source={kind:"REGISTERED_CONTEXT_CHANGE" as const,taskId:query.get(queryKeys.taskId),revisionId:query.get(queryKeys.revisionId),runId:query.get(queryKeys.runId),revisionHash:query.get(queryKeys.revisionHash)};
  const targetContextId=query.get(queryKeys.targetContextId);
  return validContextDerivation(source)&&knownContext(targetContextId)?{status:"VALID",draft:{source,targetContextId}}:invalid();
}
export function contextDerivationLocation(href:string,draft:ContextDerivationDraft,requestKey?:string){
  if(!validContextDerivation(draft.source)||!knownContext(draft.targetContextId)||requestKey!==undefined&&!uuid(requestKey))throw Error("口径变更恢复标识不合法");
  const url=new URL(href);url.username="";url.password="";url.search="";url.hash="";url.searchParams.set("module","agent-center");
  for(const[key,name]of Object.entries(queryKeys))url.searchParams.set(name,key==="targetContextId"?draft.targetContextId:draft.source[key as keyof ContextDerivation]);
  if(requestKey)url.searchParams.set("agent_request",requestKey);return url;
}
export function clearContextDerivation(href:string){
  const url=new URL(href);for(const key of [...url.searchParams.keys()])if(key.startsWith("derive_"))url.searchParams.delete(key);return url;
}
export function contextDerivationAccessReason(access:DerivationAccess){
  if(access.sourceLocked)return"当前是精确发布返程，只读定位；请先打开原任务再提出新口径。";
  if(access.taskOnly)return"本窗口仅续接指定任务，不能派生新口径任务。";
  if(access.publicationOnly)return"当前仅允许审阅发布，不能创建新的开发任务。";
  if(access.readOnly||!access.canWrite)return"当前没有开发写入权限；原任务仍可只读查看。";
  if(access.working)return"请先等待当前操作结束。";
  if(access.pending)return"原保存或提交结果尚未确认，请先查询原编号。";
  if(access.dirty)return"当前代码有未保存修改，请先处理修改，再以已验证版本变更口径。";
  if(access.unsentMessage)return"已有未发送需求，请先处理这段文字，再创建口径变更草稿。";
  return"";
}
export function contextDerivationReference(task:DerivationTask|undefined,run:Run|undefined,revisionId?:string):ContextDerivation|undefined{
  const last=task?.attempts.at(-1),family=validationFamilyForContextId(task?.contextId);
  if(!native(task)||task?.status!=="SUCCEEDED"||task.mode!=="LIVE_MODEL"||![undefined,"SPARK_SQL"].includes(task.language)||
    !knownContext(task.contextId)||last?.status!=="SUCCEEDED"||typeof last.model!=="string"||!last.model||/test.?double|unconfirmed|fixture|stub|synthetic|mock/i.test(last.model)||
    !native(run)||run?.status!=="SUCCEEDED"||run.engine!=="Apache Spark"||run.mainSqlExecuted!==true||run.agentTaskId!==task.id||
    run.id!==last.runId||run.revisionId!==last.revisionId||revisionId!==last.revisionId||run.contextId!==task.contextId||
    run.validationContractId!==family?.id||run.validation?.contractId!==family?.id||!regressionsMatchFamily(run.validation,family)||
    task.revisionId!==undefined&&task.revisionId!==revisionId||task.runId!==undefined&&task.runId!==run.id)return;
  const source={kind:"REGISTERED_CONTEXT_CHANGE" as const,taskId:task.id,revisionId,runId:run.id,revisionHash:run.revisionHash};
  return validContextDerivation(source)?source:undefined;
}
export async function readContextDerivationSource(draft:ContextDerivationDraft,read:<T>(path:string)=>Promise<T>):Promise<VerifiedDerivationSource>{
  if(!validContextDerivation(draft.source)||!knownContext(draft.targetContextId))throw Error("口径变更来源不合法，未读取其他版本。");
  const ref=draft.source;
  const [task,revision,run,workflow]=await Promise.all([read<DerivationTask>(`/agent/tasks/${ref.taskId}`),read<Revision>(`/revisions/${ref.revisionId}`),read<Run>(`/runs/${ref.runId}`),read<Workflow>(`/agent/tasks/${ref.taskId}/workflow`)]);
  const actual=contextDerivationReference(task,run,revision.id),report=workflow.report,family=validationFamilyForContextId(task.contextId);
  if(!actual||sourceKeys.some(key=>actual[key]!==ref[key])||!native(revision)||revision.source!=="LIVE_MODEL"||revision.hash!==ref.revisionHash||
    revision.contextId!==task.contextId||typeof revision.sql!=="string"||!revision.sql.trim()||revision.sql.length>20000||task.sql!==revision.sql||
    !native(report)||report?.status!=="PASSED"||report.taskId!==ref.taskId||report.revisionId!==ref.revisionId||report.runId!==ref.runId||
    report.revisionHash!==ref.revisionHash||report.contextId!==task.contextId||report.validationContractId!==family?.id||
    !["revision","execution","results","regressions"].every(id=>report.checks?.some(check=>check.id===id&&check.passed===true)))
    throw Error("原任务、成功代码、运行或独立核验已变化，不能用其他版本替代此来源。");
  const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(revision.sql));
  if([...new Uint8Array(bytes)].map(byte=>byte.toString(16).padStart(2,"0")).join("")!==ref.revisionHash)throw Error("原SQL与冻结摘要不一致，变更草稿保持不可提交。");
  return{source:{...ref},contextId:task.contextId,validationContractId:family!.id,sql:revision.sql};
}
export function contextDerivationSubmitReason(draft:ContextDerivationDraft|undefined,verified:VerifiedDerivationSource|undefined,access:DerivationAccess,ready:boolean,currentSql:string){
  const boundary=contextDerivationAccessReason(access);if(boundary)return boundary;
  if(!draft||!verified||sourceKeys.some(key=>draft.source[key]!==verified.source[key]))return"原冻结来源尚未核验，不能提交；请重新读取来源。";
  if(!knownContext(draft.targetContextId)||draft.targetContextId===verified.contextId)return"请选择不同的已登记口径；原任务不会被修改。";
  if(currentSql!==verified.sql)return"源SQL必须保持冻结；本次不会提交手工改动。";
  if(!ready)return"模型或执行环境尚未就绪；草稿和来源保留，当前不会执行。";
  return"";
}
export function contextDerivationBody(draft:ContextDerivationDraft,verified:VerifiedDerivationSource,message:string){
  if(!validContextDerivation(draft.source)||sourceKeys.some(key=>draft.source[key]!==verified.source[key])||!knownContext(draft.targetContextId)||
    draft.targetContextId===verified.contextId||typeof message!=="string"||message.trim().length<4||message.trim().length>2000)throw Error("请确认原版本、不同目标口径和新任务需求。");
  return{message:message.trim(),sql:verified.sql,contextId:draft.targetContextId,derivation:{...draft.source}};
}
export function contextDerivationReceiptMatches(task:{id?:string;contextId?:string;initialSql?:string;derivedFrom?:DerivedFrom},draft:ContextDerivationDraft,verified:VerifiedDerivationSource){
  const source=task.derivedFrom;
  return Boolean(uuid(task.id)&&task.id!==draft.source.taskId&&task.contextId===draft.targetContextId&&task.initialSql===verified.sql&&source&&
    Object.keys(source).length===7&&sourceKeys.every(key=>source[key]===draft.source[key])&&source.contextId===verified.contextId&&source.validationContractId===verified.validationContractId);
}
// Call only after validating the derived receipt. Draft SQL was read-only, so
// recovering a completed child adopts its code, not the original parent SQL.
export function contextDerivationReceiptContent(task:{sql?:string;initialSql?:string;message:string},message:string,automaticMessage?:string){
  const validSql=(value:unknown):value is string=>typeof value==="string"&&value.trim().length>0&&value.length<=20000;
  if(!validSql(task.initialSql)||task.sql!==undefined&&!validSql(task.sql))throw Error("新任务代码回执不完整，原提交编号保留，未替换原草稿。");
  const sql=task.sql===undefined?task.initialSql:task.sql;
  return{sql,message:message.trim()===task.message.trim()||automaticMessage!==undefined&&message===automaticMessage?"":message};
}
