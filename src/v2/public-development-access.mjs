// Optional, fail-closed rollout gate. This never grants a session or bypasses
// existing CSRF, project, role, ownership, persistence or execution budgets.
const permissions = Object.freeze(['SESSION', 'AGENT', 'DEVELOPMENT', 'DELIVERY']);
const authPaths = new Set(['/api/v2/auth/login', '/api/v2/auth/logout']);
const routes = [
  /^\/api\/v2\/(?:revisions|runs|agent\/tasks)$/,
  /^\/api\/v2\/runs\/[a-f0-9-]{36}\/cancel$/,
  /^\/api\/v2\/agent\/tasks\/[a-f0-9-]{36}\/(?:advance|cancel|prepare-delivery|background(?:\/cancel)?)$/,
  /^\/api\/v2\/agent\/deliveries\/[a-f0-9-]{36}\/(?:advance|cancel)$/,
];
const fail = (code, message) => Object.assign(new Error(message), { status: 403, code });
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const targetDenied = () => fail('PUBLIC_DEVELOPMENT_TARGET_ONLY', '当前窗口只续接指定的既有任务及其关联代码；不能新建、派生或操作其他任务。');
export function publicDevelopmentConfig(env) {
  const scope = env.V2_FC_PUBLIC_WRITE_SCOPE;
  if (scope === undefined || scope === '' || scope === 'PUBLICATION_ONLY' || scope === 'SERVICE_CONSUMPTION_ONLY') return undefined;
  const startsAt = Date.parse(env.V2_PUBLIC_DEVELOPMENT_STARTS_AT),
    expiresAt = Date.parse(env.V2_PUBLIC_DEVELOPMENT_EXPIRES_AT),
    email = String(env.V2_BOOTSTRAP_ADMIN_EMAIL ?? '').trim().toLowerCase(),
    taskId = env.V2_PUBLIC_DEVELOPMENT_TASK_ID;
  if (scope !== 'DEVELOPMENT_ONLY' || env.V2_LOCAL_DEVELOPMENT !== 'false' ||
      !Number.isFinite(startsAt) || !Number.isFinite(expiresAt) || expiresAt <= startsAt || expiresAt - startsAt > 2 * 3600000 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      (env.V2_DURABLE_SQL_AGENT_ENABLED !== 'true' && env.V2_EXECUTION_UNAVAILABLE !== 'true') ||
      (taskId !== undefined && taskId !== '' && (typeof taskId !== 'string' || !uuid.test(taskId))))
    throw Error('PUBLIC_DEVELOPMENT_CONFIG_INVALID');
  return Object.freeze({ scope, startsAt, expiresAt, email, executionAvailable: env.V2_EXECUTION_UNAVAILABLE !== 'true', ...(taskId ? {taskId} : {}) });
}
export function developmentSession(config, session, now = Date.now()) {
  if (!config) return undefined;
  const allowed = config.executionAvailable && now >= config.startsAt && now < config.expiresAt && session?.role === 'ADMIN' && session?.user?.email?.toLowerCase() === config.email;
  return { readOnly: !allowed, permissions: allowed ? [...permissions] : ['SESSION'],
    developmentOnly: true, developmentStartsAt: new Date(config.startsAt).toISOString(), developmentExpiresAt: new Date(config.expiresAt).toISOString(),
    ...(config.taskId ? {developmentTaskOnly:true,...(allowed?{developmentTaskId:config.taskId}:{})} : {}) };
}
export function assertDevelopmentMutation(config, session, method, path, now = Date.now()) {
  if (!config || method === 'GET' || authPaths.has(path)) return;
  if (developmentSession(config, session, now).readOnly)
    throw fail('PUBLIC_DEVELOPMENT_CLOSED', '当前开发窗口未开放、已到期、执行器未就绪或此账号未获准；已保存结果仍可查看。');
  if(config.taskId){
    if(path==='/api/v2/agent/tasks')throw targetDenied();
    const taskPath=path.match(/^\/api\/v2\/agent\/tasks\/([a-f0-9-]{36})\//);
    if(taskPath && taskPath[1]!==config.taskId)throw targetDenied();
  }
  const targetedResume=config.taskId && path===`/api/v2/agent/tasks/${config.taskId}/background/resume`;
  if (method !== 'POST' || (!targetedResume && !routes.some(rule => rule.test(path))))
    throw fail('PUBLIC_DEVELOPMENT_SCOPE_DENIED', '当前仅开放 SQL 开发和交付文件准备；发布、其他模块写入及账号凭证管理未开放。');
}
export function assertDevelopmentTaskCreation(config, session, store, project, key, language, now = Date.now()) {
  if (!config) return;
  assertDevelopmentMutation(config, session, 'POST', '/api/v2/agent/tasks', now);
  if (language !== 'SPARK_SQL') throw fail('PUBLIC_DEVELOPMENT_SQL_ONLY', '本次开发窗口仅支持 Spark SQL。');
  const id = store.deduplicatedId(`${project}:durable-agent:${session.user.id}:${key}`);
  const tasks = store.list('agent', project).filter(t => t.submittedBy === session.user.id && Date.parse(t.createdAt) >= config.startsAt);
  if (id && tasks.some(t => t.id === id)) return; // Original idempotent request, not another task.
  if (id || tasks.length >= 1) throw fail('PUBLIC_DEVELOPMENT_TASK_LIMIT', '本次窗口仅允许一条新 Agent 任务；请查看或恢复原任务，不要重新创建。');
}
export function assertDevelopmentRecord(config, session, item, {task,now=Date.now()}={}) {
  if (!config) return;
  if(config.taskId){
    if(developmentSession(config,session,now).readOnly)throw fail('PUBLIC_DEVELOPMENT_CLOSED','当前任务续接窗口未开放、已到期或身份不符；已保存结果仍可查看。');
    const origin=task??item;
    const owned=origin?.id===config.taskId&&origin.executionMode==='DURABLE_SQL_AGENT_V1'&&origin.language==='SPARK_SQL'&&
      origin.submittedBy===session?.user?.id&&typeof origin.contextId==='string'&&Number.isFinite(Date.parse(origin.createdAt));
    const linked=item?.id===origin?.id&&item?.executionMode==='DURABLE_SQL_AGENT_V1' ||
      item?.author===session?.user?.id&&item?.contextId===origin?.contextId&&
      (origin?.revisionId===item?.id||origin?.attempts?.some(a=>a.revisionId===item?.id)||
       item?.source==='MANUAL'&&item.manualProvenance?.kind==='ENGINEER_EDIT'&&item.manualProvenance.actorId===session?.user?.id&&item.manualProvenance.originAgentTaskId===origin?.id);
    if(!owned||!linked||!Number.isFinite(Date.parse(item?.createdAt)))throw targetDenied();
    return;
  }
  if (!item || (item.submittedBy ?? item.author) !== session?.user?.id || Date.parse(item.createdAt) < config.startsAt || !Number.isFinite(Date.parse(item.createdAt)))
    throw fail('PUBLIC_DEVELOPMENT_HISTORY_READ_ONLY', '此开发窗口只操作当前账号的新任务和新代码；历史记录保持只读。');
}
export function assertDevelopmentTargetTask(config,task,owner,project,now=Date.now()){
  if(!config?.taskId)return;
  const membership=owner?.memberships?.find(m=>m.projectId===project);
  if(owner?.status!=='ACTIVE'||owner.id!==task?.submittedBy||membership?.role!=='ADMIN')throw targetDenied();
  assertDevelopmentRecord(config,{user:owner,role:membership.role},task,{now});
}
export function developmentBackgroundBoundary(config,taskId,now=Date.now()){
  if(!config)return undefined;
  assertDevelopmentExecutionWindow(config,now);
  if(!uuid.test(taskId??'')||(config.taskId&&config.taskId!==taskId))throw targetDenied();
  return {protocol:'shuduo-development-background-window/v1',taskId,startsAt:config.startsAt,expiresAt:config.expiresAt,targetTaskId:config.taskId??null};
}
export function assertDevelopmentBackgroundScope(config,task,owner,project,boundary,now=Date.now()){
  if((config && !boundary) || boundary && (!config||boundary.protocol!=='shuduo-development-background-window/v1'||boundary.taskId!==task?.id||
    boundary.startsAt!==config.startsAt||boundary.expiresAt!==config.expiresAt||boundary.targetTaskId!==(config.taskId??null)))
    throw fail('PUBLIC_DEVELOPMENT_BACKGROUND_SCOPE_CHANGED','后台委托不属于当前授权窗口；请审阅原任务后重新续接，历史计数不会重置。');
  if(config?.taskId)assertDevelopmentTargetTask(config,task,owner,project,now);
  else if(boundary){
    const membership=owner?.memberships?.find(m=>m.projectId===project);
    if(owner?.status!=='ACTIVE'||owner.id!==task?.submittedBy||developmentSession(config,{user:owner,role:membership?.role},now).readOnly)throw targetDenied();
  }
  assertDevelopmentExecutionWindow(config,now);
}
export function developmentBackgroundWindow(config, now = Date.now(), requested = {}) {
  if (!config) return {};
  if ((requested.durationMs !== undefined && (!Number.isSafeInteger(requested.durationMs) || requested.durationMs < 60000 || requested.durationMs > 1800000)) ||
      (requested.maxEvents !== undefined && (!Number.isSafeInteger(requested.maxEvents) || requested.maxEvents < 1 || requested.maxEvents > 20)))
    throw fail('PUBLIC_DEVELOPMENT_LIMIT_INVALID', '后台期限或事件额度格式不合法。');
  const durationMs = Math.min(requested.durationMs ?? 900000, 900000, config.expiresAt - now);
  if (durationMs < 60000) throw fail('PUBLIC_DEVELOPMENT_CLOSED', '本次开发窗口即将结束，不能新建后台委托；已保存结果仍可查看。');
  return { durationMs, maxEvents: Math.min(requested.maxEvents ?? 20, 20) };
}
export function assertDevelopmentExecutionWindow(config, now = Date.now()) {
  if (config && (!config.executionAvailable || now < config.startsAt || now >= config.expiresAt))
    throw fail('PUBLIC_DEVELOPMENT_CLOSED', '执行器未就绪或开发窗口已结束，不再发起模型或 Spark；已提交计算仅保留原结果。');
}
