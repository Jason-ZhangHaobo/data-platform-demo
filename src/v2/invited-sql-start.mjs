import {readInvitedSqlContext} from './invited-sql-context-client.mjs';

export const emptyAgentDraftSql = 'SELECT 1 AS pending';
const uuid=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const otherSources=['sourceRunId','derivedFrom','syncInput','fundPreparation','assistedContinuation',
  'manualContinuation','manualProvenance','sourceAttribution','repairComparison','clarification','chatChange'];
const fields=(input,allowed)=>input && typeof input==='object' && !Array.isArray(input) &&
  Object.keys(input).every(k=>allowed.includes(k));

export function agentTaskReceiptValid(task){
  return typeof task?.id==='string' && uuid.test(task.id) && Number.isSafeInteger(task.version) && task.version>0 &&
    typeof task.message==='string' && typeof task.contextId==='string' && task.contextId.length>0 && Array.isArray(task.attempts) &&
    task.attempts.every(a=>a && typeof a==='object' && Number.isSafeInteger(a.attempt) && a.attempt>0 && typeof a.status==='string') &&
    (task.language===undefined || task.language==='SPARK_SQL') && (task.runId===undefined || (typeof task.runId==='string' && uuid.test(task.runId)));
}

export function invitedSqlStartBody({message,contextId}){
  const requirement=typeof message==='string'?message.trim():'';
  if(requirement.length<4 || requirement.length>2000)throw Error('请输入 4 至 2000 个字符的开发需求。');
  if(typeof contextId!=='string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(contextId))throw Error('请选择已登记的 SQL 口径。');
  return {message:requirement,sql:emptyAgentDraftSql,contextId,background:true};
}

export function acceptsInvitedSqlContext(context){
  return context?.capabilities?.agentDevelopment!==false && context?.capabilities?.scope!=='LOCAL_ONLY' &&
    context?.capabilities?.fundPreparation!==true && typeof context?.id==='string';
}

export async function bindInvitedSqlStart(client,task,requestId,expected){
  if(!agentTaskReceiptValid(task) || task.executionMode!=='DURABLE_SQL_AGENT_V1' ||
    task.language!=='SPARK_SQL' || task.mode!=='LIVE_MODEL' || task.initialSql!==emptyAgentDraftSql ||
    task.requestBound===true || (task.sourceKind!==undefined && task.sourceKind!=='AGENT') ||
    otherSources.some(k=>task[k]!==undefined) ||
    (expected && (task.contextId!==expected.contextId || task.message!==expected.message)))
    throw Error('原提交与受邀 SQL 任务回执不一致，请保留原请求编号。');
  const selection={taskId:task.id,requestId};
  const context=await readInvitedSqlContext(client,selection);
  if(context.contextId!==task.contextId || context.message!==task.message)
    throw Error('原任务的需求或数据口径与创建请求不一致。');
  return selection;
}

function requestPath(requestId){
  if(typeof requestId!=='string' || !uuid.test(requestId))throw Error('请提供本次委托的原请求 UUID。');
  return '/agent/requests/'+requestId;
}

export async function recoverInvitedSqlStart(client,args){
  if(!fields(args,['requestId']))throw Error('核对原任务仅接受原请求编号。');
  const task=await client.request(requestPath(args.requestId));
  return bindInvitedSqlStart(client,task,args.requestId);
}

export async function submitInvitedSqlStart(client,args){
  if(!fields(args,['message','contextId','requestId','confirm']) || args.confirm!==true)
    throw Error('请确认在受邀开发窗口内委托一次模型和 Spark 后台开发。');
  const path=requestPath(args.requestId),body=invitedSqlStartBody(args);
  // An earlier write may already have been accepted. Only a missing creator's
  // original mapping qualifies for a new POST; a mismatched binding never does.
  let existing,missing=false;
  try {existing=await client.request(path);}
  catch(e){if(e?.status!==404)throw e;missing=true;}
  if(!missing)return bindInvitedSqlStart(client,existing,args.requestId,body);

  const contexts=await client.request('/contexts');
  if(!Array.isArray(contexts) || !contexts.some(c=>c?.id===body.contextId && acceptsInvitedSqlContext(c)))
    throw Error('当前受邀项目没有开放此 SQL 口径。');
  const {status,session}=await client.request('/status?include=session');
  const now=Date.now();
  if(status?.mode!=='PUBLIC_INVITATION' || session?.authenticated!==true || session.user?.projectId!==status.projectId ||
    !session.user?.id || !status.projectId || session.readOnly!==false || session.developmentOnly!==true ||
    session.developmentTaskOnly || session.developmentRequestOnly || session.developmentWindowUsed || session.developmentWindowTaskId ||
    session.publicationOnly || session.consumptionOnly || session.servicePlanningOnly ||
    !Array.isArray(session.permissions) || !session.permissions.includes('AGENT') ||
    !(Date.parse(session.developmentStartsAt)<=now && now<Date.parse(session.developmentExpiresAt) && now<Date.parse(session.expiresAt)) ||
    status.model?.configured!==true || status.spark?.available!==true || status.agentDevelopment?.durableEnabled!==true ||
    status.agentDevelopment.eventBackgroundAvailable!==true || status.agentDevelopment.invitedSqlStartSupported!==true)
    throw Error('普通受邀开发窗口、当前身份、任务名额或签名执行后台尚未就绪。');
  try {
    const task=await client.request('/agent/tasks',{method:'POST',idempotencyKey:args.requestId,body});
    return await bindInvitedSqlStart(client,task,args.requestId,body);
  } catch(error) {
    const status=Number.isInteger(error?.status) && error.status>=100 && error.status<=599?error.status:undefined;
    throw Object.assign(Error('受邀任务的提交结果尚待核对'+(status?'（HTTP '+status+'）':'')+
      '。请使用原 UUID 执行 invited-start-request 或 agent_invited_sql_start_request。'),
    {code:'INVITED_SQL_START_UNCONFIRMED',status});
  }
}
