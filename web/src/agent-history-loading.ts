import {clarificationReceiptMatches} from '../../src/v2/sql-clarification-contract.mjs';
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
type HistoryTask = {id:string;version:number;message:string;contextId:string;status:string;stage?:string};
const record = (value:unknown):value is Record<string,unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
const optionalText = (value:unknown) => value === undefined || typeof value === "string";
const identifier = (value:unknown) => typeof value === "string" && uuid.test(value);
function summaryValid(value:unknown):value is HistoryTask & Record<string,unknown> {
  return record(value) && identifier(value.id) && Number.isSafeInteger(value.version) && Number(value.version)>0 &&
    typeof value.message === "string" && value.message.trim().length>0 && typeof value.contextId === "string" && value.contextId.length>0 &&
    typeof value.status === "string" && value.status.length>0 && optionalText(value.stage);
}
export function checkedAgentHistory<T extends HistoryTask>(value:unknown):T[] {
  if(!Array.isArray(value)||!value.every(summaryValid)||new Set(value.map(item=>item.id)).size!==value.length)
    throw Error("任务历史响应不完整，原任务与草稿保留；请重新读取。");
  return value as T[];
}
export function checkedAgentTask<T extends HistoryTask>(value:unknown,expectedId:string):T {
  const invalid=()=>Error("任务回执与原编号或记录结构不匹配，未替换当前任务和代码。");
  if(!summaryValid(value)||value.id!==expectedId||!record(value)||!Array.isArray(value.attempts)||
    value.requestBound!==undefined && value.requestBound!==true)throw invalid();
  if(["sql","initialSql","explanation","error","executionMode","mode","sourceKind","createdAt"].some(key=>!optionalText(value[key]))||
    ["revisionId","runId","sourceRunId"].some(key=>value[key]!==undefined&&!identifier(value[key]))||
    value.language!==undefined&&value.language!=="SPARK_SQL"&&value.language!=="PYTHON"||
    value.usedTokens!==undefined&&(!Number.isSafeInteger(value.usedTokens)||Number(value.usedTokens)<0))throw invalid();
  const attempts=value.attempts;
  if(!clarificationReceiptMatches(value)||value.humanClarified===true&&(value.directAutonomousEligible!==false||!identifier(value.clarificationOriginTaskId)))throw invalid();
  if(!attempts.every(attempt=>record(attempt)&&Number.isSafeInteger(attempt.attempt)&&Number(attempt.attempt)>0&&typeof attempt.status==="string"&&
    ["revisionId","runId","sourceRunId"].every(key=>attempt[key]===undefined||identifier(attempt[key]))&&optionalText(attempt.model)&&
    (attempt.diagnostic===undefined||record(attempt.diagnostic)&&typeof attempt.diagnostic.code==="string"&&typeof attempt.diagnostic.phase==="string"&&
      typeof attempt.diagnostic.elapsedMs==="number"&&Number.isFinite(attempt.diagnostic.elapsedMs)&&attempt.diagnostic.elapsedMs>=0&&
      typeof attempt.diagnostic.requestMayHaveBeenSent==="boolean"&&
      (attempt.diagnostic.httpStatus===undefined||Number.isInteger(attempt.diagnostic.httpStatus)&&Number(attempt.diagnostic.httpStatus)>=100&&Number(attempt.diagnostic.httpStatus)<=599)))||
    new Set(attempts.map(attempt=>attempt.attempt)).size!==attempts.length)throw invalid();
  if(value.recovery!==undefined&&(!record(value.recovery)||!optionalText(value.recovery.modelLeaseExpiresAt)))throw invalid();
  const background=value.background;
  if(background!==undefined&&(!record(background)||typeof background.status!=="string"||
    ["state","delivery","code"].some(key=>!optionalText(background[key]))||
    ["expiresAt","consumedEvents","maxEvents"].some(key=>typeof background[key]!=="number"||!Number.isFinite(background[key]))||
    background.scopeBlocked!==undefined&&typeof background.scopeBlocked!=="boolean"))throw invalid();
  return value as T;
}
export function checkedAgentRun<T extends {id:string;status:string;revisionId?:string;contextId?:string}>(value:unknown,task:{id?:string;contextId:string;runId?:string;revisionId?:string}):T {
  if(!record(value)||value.id!==task.runId||typeof value.status!=="string"||!value.status||
    value.agentTaskId!==undefined&&task.id!==undefined&&value.agentTaskId!==task.id||
    task.revisionId!==undefined&&value.revisionId!==task.revisionId||value.contextId!==undefined&&value.contextId!==task.contextId||
    ["error","log","engine","engineVersion","stage"].some(key=>!optionalText(value[key]))||
    value.rows!==undefined&&(!Array.isArray(value.rows)||!value.rows.every(record))||
    value.revisionId!==undefined&&!identifier(value.revisionId))
    throw Error("运行回执与原任务、代码或口径不匹配；已读任务和代码保留，运行结果未确认。");
  const validation=value.validation;
  if(validation!==undefined&&(!record(validation)||typeof validation.passed!=="boolean"||
    validation.issues!==undefined&&(!Array.isArray(validation.issues)||!validation.issues.every(item=>typeof item==="string"))||
    validation.regressions!==undefined&&(!Array.isArray(validation.regressions)||!validation.regressions.every(item=>record(item)&&typeof item.contextId==="string"&&optionalText(item.name)&&typeof item.passed==="boolean"))))
    throw Error("运行校验响应不完整；已读任务和代码保留，运行结果未确认。");
  return value as T;
}

export function initialAgentTaskId(url: string) {
  const values = new URL(url).searchParams.getAll("task");
  if (!values.length) return undefined;
  if (values.length !== 1 || !uuid.test(values[0])) throw Error("任务链接无效，请从任务历史重新选择；原链接未被清除。");
  return values[0];
}

// Task links must not wait for (or depend on membership in) a history listing.
// Only read callbacks are accepted here; no submission or retry is performed.
export async function loadHistoryAfterTarget<T extends HistoryTask>({restoreTarget,readHistory,isCurrent,acceptHistory,onHistoryError}: {
  restoreTarget?: () => Promise<unknown>;
  readHistory: () => Promise<unknown>;
  isCurrent: () => boolean;
  acceptHistory: (items:T[]) => void;
  onHistoryError: (error:unknown) => void;
}) {
  if (restoreTarget) await restoreTarget();
  if (!isCurrent()) return;
  try {
    const items = await readHistory();
    if (isCurrent()) acceptHistory(checkedAgentHistory<T>(items));
  } catch (error) {
    if (isCurrent()) onHistoryError(error);
  }
}

export function mergeTaskHistory<T extends {id:string;version:number}>(items:T[],selected?:T) {
  if (!selected) return items;
  const listed = items.find(item=>item.id===selected.id);
  if (listed && listed.version > selected.version) return items;
  return [selected,...items.filter(item=>item.id!==selected.id)];
}
