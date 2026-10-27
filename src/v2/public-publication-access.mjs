// Optional single-package rollout gate. Identity, CSRF, ownership and project
// permissions remain the responsibility of the normal server authorization.
const scope = 'PUBLICATION_ONLY';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const authPaths = new Set(['/api/v2/auth/login', '/api/v2/auth/logout']);
const fail = (code, message) => Object.assign(new Error(message), { status: 403, code });
const inWindow = (config, now) => config.executionAvailable && Number.isFinite(now) && now >= config.startsAt && now < config.expiresAt;

export function publicPublicationConfig(env) {
  if (env.V2_FC_PUBLIC_WRITE_SCOPE !== scope) return undefined;
  const startsAt = typeof env.V2_PUBLIC_PUBLICATION_STARTS_AT === 'string' ? Date.parse(env.V2_PUBLIC_PUBLICATION_STARTS_AT) : NaN,
    expiresAt = typeof env.V2_PUBLIC_PUBLICATION_EXPIRES_AT === 'string' ? Date.parse(env.V2_PUBLIC_PUBLICATION_EXPIRES_AT) : NaN,
    email = typeof env.V2_BOOTSTRAP_ADMIN_EMAIL === 'string' ? env.V2_BOOTSTRAP_ADMIN_EMAIL.trim().toLowerCase() : '',
    taskId = env.V2_PUBLIC_PUBLICATION_TASK_ID,
    packageDigest = env.V2_PUBLIC_PUBLICATION_PACKAGE_DIGEST,
    verificationId = env.V2_PUBLIC_PUBLICATION_VERIFICATION_ID;
  if (env.V2_LOCAL_DEVELOPMENT !== 'false' ||
      !Number.isFinite(startsAt) || !Number.isFinite(expiresAt) || expiresAt <= startsAt || expiresAt - startsAt > 2 * 3600000 ||
      email.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      typeof taskId !== 'string' || !uuid.test(taskId) ||
      typeof packageDigest !== 'string' || !digest.test(packageDigest) ||
      typeof verificationId !== 'string' || !uuid.test(verificationId))
    throw Error('PUBLIC_PUBLICATION_CONFIG_INVALID');
  return Object.freeze({ scope, startsAt, expiresAt, email, taskId, packageDigest, verificationId,
    executionAvailable: env.V2_EXECUTION_UNAVAILABLE !== 'true' });
}

export function publicationSession(config, session, now = Date.now()) {
  if (!config) return undefined;
  const selectedAdministrator = session?.role === 'ADMIN' &&
    typeof session?.user?.email === 'string' && session.user.email.toLowerCase() === config.email;
  const allowed = inWindow(config, now) && selectedAdministrator;
  return { readOnly: !allowed, permissions: allowed ? ['SESSION', 'DELIVERY'] : ['SESSION'],
    publicationOnly: true, ...(selectedAdministrator ? { publicationTaskId: config.taskId,
      publicationPackageDigest: config.packageDigest, publicationVerificationId: config.verificationId } : {}),
    publicationStartsAt: new Date(config.startsAt).toISOString(),
    publicationExpiresAt: new Date(config.expiresAt).toISOString() };
}

export function assertPublicationMutation(config, session, method, path, now = Date.now()) {
  if (!config || method === 'GET' || (method === 'POST' && authPaths.has(path))) return;
  if (publicationSession(config, session, now).readOnly)
    throw fail('PUBLIC_PUBLICATION_CLOSED', '当前发布窗口未开放、已到期、执行器未就绪或此账号未获准；已保存结果仍可查看。');
  const target = `/api/v2/agent/tasks/${config.taskId}/publication`;
  if (method !== 'POST' || (path !== target && path !== `${target}/cancel`))
    throw fail('PUBLIC_PUBLICATION_SCOPE_DENIED', '当前仅开放指定任务和交付包的审阅发布及停止；代码开发、其他任务和账号凭证管理保持只读。');
}

export function assertPublicationTarget(config, target = {}, now = Date.now()) {
  if (!config) return;
  if (!inWindow(config, now))
    throw fail('PUBLIC_PUBLICATION_CLOSED', '发布窗口未开放、已到期或执行器未就绪；不会新建发布或计算。');
  if (!target || target.agentId !== config.taskId || target.packageDigest !== config.packageDigest || target.verificationId !== config.verificationId)
    throw fail('PUBLIC_PUBLICATION_TARGET_MISMATCH', '发布必须绑定本次允许的任务、交付包摘要和文件演练；不允许替换版本。');
}

export function assertPublicationExecutionWindow(config, release, now = Date.now()) {
  if (!config) return;
  if (!inWindow(config, now))
    throw fail('PUBLIC_PUBLICATION_CLOSED', '发布窗口未开放、已到期或执行器未就绪；不再启动新 Spark，已提交结果仍可查看。');
  if (!release || release.sourceAgentTaskId !== config.taskId || release.packageDigest !== config.packageDigest ||
      release.verificationId !== config.verificationId)
    throw fail('PUBLIC_PUBLICATION_TARGET_MISMATCH', '调度只能执行本次允许的任务及确切交付包；其他发布保持停止。');
}
