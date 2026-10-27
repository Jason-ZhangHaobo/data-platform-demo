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
export function publicDevelopmentConfig(env) {
  const scope = env.V2_FC_PUBLIC_WRITE_SCOPE;
  if (scope === undefined || scope === '') return undefined;
  const startsAt = Date.parse(env.V2_PUBLIC_DEVELOPMENT_STARTS_AT),
    expiresAt = Date.parse(env.V2_PUBLIC_DEVELOPMENT_EXPIRES_AT),
    email = String(env.V2_BOOTSTRAP_ADMIN_EMAIL ?? '').trim().toLowerCase();
  if (scope !== 'DEVELOPMENT_ONLY' || env.V2_LOCAL_DEVELOPMENT !== 'false' ||
      !Number.isFinite(startsAt) || !Number.isFinite(expiresAt) || expiresAt <= startsAt || expiresAt - startsAt > 2 * 3600000 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      (env.V2_DURABLE_SQL_AGENT_ENABLED !== 'true' && env.V2_EXECUTION_UNAVAILABLE !== 'true'))
    throw Error('PUBLIC_DEVELOPMENT_CONFIG_INVALID');
  return Object.freeze({ scope, startsAt, expiresAt, email, executionAvailable: env.V2_EXECUTION_UNAVAILABLE !== 'true' });
}
export function developmentSession(config, session, now = Date.now()) {
  if (!config) return undefined;
  const allowed = config.executionAvailable && now >= config.startsAt && now < config.expiresAt && session?.role === 'ADMIN' && session?.user?.email?.toLowerCase() === config.email;
  return { readOnly: !allowed, permissions: allowed ? [...permissions] : ['SESSION'],
    developmentOnly: true, developmentStartsAt: new Date(config.startsAt).toISOString(), developmentExpiresAt: new Date(config.expiresAt).toISOString() };
}
export function assertDevelopmentMutation(config, session, method, path, now = Date.now()) {
  if (!config || method === 'GET' || authPaths.has(path)) return;
  if (developmentSession(config, session, now).readOnly)
    throw fail('PUBLIC_DEVELOPMENT_CLOSED', '当前开发窗口未开放、已到期、执行器未就绪或此账号未获准；已保存结果仍可查看。');
  if (method !== 'POST' || !routes.some(rule => rule.test(path)))
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
export function assertDevelopmentRecord(config, session, item) {
  if (!config) return;
  if (!item || (item.submittedBy ?? item.author) !== session?.user?.id || Date.parse(item.createdAt) < config.startsAt || !Number.isFinite(Date.parse(item.createdAt)))
    throw fail('PUBLIC_DEVELOPMENT_HISTORY_READ_ONLY', '此开发窗口只操作当前账号的新任务和新代码；历史记录保持只读。');
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
