import { serviceHash, serviceVersionConfigValid, dataServiceFields } from './data-services.mjs';

const scope = 'SERVICE_CONSUMPTION_ONLY';
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const slug = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const authPaths = new Set(['/api/v2/auth/login', '/api/v2/auth/logout']);
const fail = (code, message) => Object.assign(new Error(message), { status: 403, code });
const check = (value, code, message) => { if (!value) throw fail(code, message); };
const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key));
const nameValid = value => typeof value === 'string' && value.length >= 2 && value.length <= 80 && value.trim() === value && !/[\x00-\x1f\x7f]/.test(value);
const slugValid = value => typeof value === 'string' && value.length >= 3 && value.length <= 48 && slug.test(value);
const limitsValid = value => Number.isSafeInteger(value.timeoutMs) && value.timeoutMs >= 100 && value.timeoutMs <= 5000 &&
  Number.isSafeInteger(value.rateLimitPerMinute) && value.rateLimitPerMinute >= 1 && value.rateLimitPerMinute <= 600;
const same = (a, b) => { try { return serviceHash(a) === serviceHash(b); } catch { return false; } };
const selected = (config, session) => session?.role === 'ADMIN' && typeof session?.user?.email === 'string' && session.user.email.toLowerCase() === config.email;
const inWindow = (config, now) => Number.isFinite(now) && now >= config.startsAt && now < config.expiresAt;
const deepFreeze = value => { for (const child of Object.values(value)) if (child && typeof child === 'object') deepFreeze(child); return Object.freeze(value); };

export function publicServiceConfig(env) {
  if (env.V2_FC_PUBLIC_WRITE_SCOPE !== scope) return undefined;
  let plan;
  const startsAt = typeof env.V2_PUBLIC_SERVICE_STARTS_AT === 'string' ? Date.parse(env.V2_PUBLIC_SERVICE_STARTS_AT) : NaN;
  const expiresAt = typeof env.V2_PUBLIC_SERVICE_EXPIRES_AT === 'string' ? Date.parse(env.V2_PUBLIC_SERVICE_EXPIRES_AT) : NaN;
  const email = typeof env.V2_BOOTSTRAP_ADMIN_EMAIL === 'string' ? env.V2_BOOTSTRAP_ADMIN_EMAIL.trim().toLowerCase() : '';
  try {
    if (typeof env.V2_PUBLIC_SERVICE_PLAN !== 'string' || env.V2_PUBLIC_SERVICE_PLAN.length > 8192) throw Error();
    plan = JSON.parse(env.V2_PUBLIC_SERVICE_PLAN);
    if (env.V2_LOCAL_DEVELOPMENT !== 'false' || !Number.isFinite(startsAt) || !Number.isFinite(expiresAt) ||
        expiresAt <= startsAt || expiresAt - startsAt > 2 * 3600000 || email.length > 160 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
        !keys(plan, ['taskId', 'packageDigest', 'sourceReleaseRunId', 'dapis', 'xapi', 'applicationName']) ||
        typeof plan.taskId !== 'string' || !uuid.test(plan.taskId) || typeof plan.packageDigest !== 'string' || !digest.test(plan.packageDigest) ||
        typeof plan.sourceReleaseRunId !== 'string' || !uuid.test(plan.sourceReleaseRunId) || !nameValid(plan.applicationName) ||
        !Array.isArray(plan.dapis) || plan.dapis.length !== 2 || plan.dapis.some(item =>
          !keys(item, ['name', 'slug', 'fields', 'timeoutMs', 'rateLimitPerMinute']) || !nameValid(item.name) || !slugValid(item.slug) || !limitsValid(item) ||
          !Array.isArray(item.fields) || item.fields.length < 1 || item.fields.length > dataServiceFields.length ||
          !item.fields.includes('client_id') || new Set(item.fields).size !== item.fields.length || item.fields.some(field => !dataServiceFields.includes(field))) ||
        !keys(plan.xapi, ['name', 'slug', 'timeoutMs', 'rateLimitPerMinute', 'steps']) || !nameValid(plan.xapi.name) || !slugValid(plan.xapi.slug) || !limitsValid(plan.xapi) ||
        new Set([...plan.dapis.map(item => item.slug), plan.xapi.slug]).size !== 3 ||
        !Array.isArray(plan.xapi.steps) || plan.xapi.steps.length !== 2 || plan.xapi.steps.some(step =>
          !keys(step, ['alias', 'dapiSlug']) || typeof step.alias !== 'string' || !/^[a-z][a-z0-9_]{1,29}$/.test(step.alias) ||
          !plan.dapis.some(item => item.slug === step.dapiSlug)) ||
        new Set(plan.xapi.steps.map(step => step.alias)).size !== 2 || new Set(plan.xapi.steps.map(step => step.dapiSlug)).size !== 2) throw Error();
  } catch { throw Error('PUBLIC_SERVICE_CONFIG_INVALID'); }
  return deepFreeze({ scope, startsAt, expiresAt, email, plan, pilotId: serviceHash(plan) });
}

export function serviceSession(config, session, now = Date.now()) {
  if (!config) return undefined;
  const administrator = selected(config, session), allowed = administrator && inWindow(config, now);
  return { readOnly: !allowed, consumptionOnly: true, permissions: allowed ? ['SESSION', 'SERVICES'] : ['SESSION'],
    consumptionStartsAt: new Date(config.startsAt).toISOString(), consumptionExpiresAt: new Date(config.expiresAt).toISOString(),
    ...(administrator ? { consumptionTaskId: config.plan.taskId, consumptionPilotId: config.pilotId, consumptionPlan: config.plan } : {}) };
}

export function assertServiceMutation(config, session, method, path, now = Date.now()) {
  if (!config || method === 'GET' || (method === 'POST' && authPaths.has(path))) return;
  const administrator = selected(config, session);
  const revoke = new RegExp(`^/api/v2/data-services/applications/${uuid.source.slice(1, -1)}/revoke$`).test(path ?? '');
  // Revocation remains available after expiry, but the router must additionally
  // assertApplication against this pilot's durable record before changing it.
  if (administrator && method === 'POST' && revoke) return;
  check(administrator && inWindow(config, now), 'PUBLIC_SERVICE_CLOSED', '当前数据服务窗口未开放、已到期或此账号未获准；已保存结果仍可查看。');
  const allowed = /^\/api\/v2\/data-services\/(dapis|xapis|applications)$/.test(path ?? '') ||
    new RegExp(`^/api/v2/data-services/(dapis|xapis)/${uuid.source.slice(1, -1)}/(test|publish)$`).test(path ?? '');
  check(method === 'POST' && allowed, 'PUBLIC_SERVICE_SCOPE_DENIED', '当前仅允许指定发布结果的两个DAPI、一个XAPI及一个短期调用应用；其他写入保持关闭。');
}

// source(id) is the existing verifiedPrivateServiceSource adapter. detail(id)
// returns the authoritative service and versions. These guards never create,
// revoke, compute or return a token. Creation guards belong inside dedup callbacks.
export function createServicePilotGuard({ config, store, project, source, detail, now = Date.now }) {
  if (!config) return { assertCreate: () => {}, assertService: item => item,
    assertApplicationCreate: () => {}, assertApplication: item => item, recordTags: {}, applicationTags: {} };
  const open = () => check(inWindow(config, now()), 'PUBLIC_SERVICE_CLOSED', '数据服务窗口已关闭；不会新增接口、版本或凭证。');
  const allowed = (value, message = '数据服务必须绑定本次允许的任务、发布批次和计划。') => check(value, 'PUBLIC_SERVICE_TARGET_MISMATCH', message);
  const sourceMatches = () => {
    const run = source(config.plan.sourceReleaseRunId);
    const release = run && store.get('release', run.releaseId, project);
    allowed(run?.id === config.plan.sourceReleaseRunId && run.packageDigest === config.plan.packageDigest &&
      release?.id === run.releaseId && release.sourceAgentTaskId === config.plan.taskId && release.packageDigest === config.plan.packageDigest);
    return run;
  };
  const specFor = item => item?.serviceType === 'DAPI' ? config.plan.dapis.find(spec => spec.slug === item.slug)
    : item?.serviceType === 'XAPI' && item.slug === config.plan.xapi.slug ? config.plan.xapi : undefined;
  const dapiFieldsMatch = (version, spec) => version.serviceType === 'DAPI' && version.sourceReleaseRunId === config.plan.sourceReleaseRunId &&
    version.sourceReleaseId === sourceMatches().releaseId && version.sourcePackageDigest === config.plan.packageDigest &&
    same(version.fields, spec.fields) && version.timeoutMs === spec.timeoutMs && version.rateLimitPerMinute === spec.rateLimitPerMinute;
  const serviceById = id => {
    allowed(typeof id === 'string' && uuid.test(id));
    const item = detail(id), spec = specFor(item);
    allowed(item?.id === id && item.pilotId === config.pilotId && item.scope === 'PRIVATE_CLOUD_TEST' && spec && item.name === spec.name);
    return { item, spec };
  };
  const assertDapi = id => {
    const { item, spec } = serviceById(id); allowed(item.serviceType === 'DAPI');
    const version = item.currentVersion;
    allowed(version?.serviceId === item.id && version.id === item.currentVersionId && version.scope === 'PRIVATE_CLOUD_TEST' &&
      version.versionNumber === 1 && serviceVersionConfigValid(version) && dapiFieldsMatch(version, spec));
    if (item.publishedVersionId) allowed(item.publishedVersion?.id === item.publishedVersionId && item.publishedVersionId === version.id &&
      serviceVersionConfigValid(item.publishedVersion) && dapiFieldsMatch(item.publishedVersion, spec));
    return item;
  };
  const xapiSteps = steps => {
    allowed(Array.isArray(steps) && steps.length === 2);
    for (const [index, step] of steps.entries()) {
      const expected = config.plan.xapi.steps[index];
      allowed(keys(step, ['alias', 'dapiId', 'dapiVersionId']) && step.alias === expected.alias);
      const dapi = assertDapi(step.dapiId);
      allowed(dapi.slug === expected.dapiSlug && dapi.status === 'PUBLISHED' && dapi.publishedVersion?.status === 'PUBLISHED' &&
        step.dapiVersionId === dapi.publishedVersionId, 'XAPI只能引用本次两个DAPI已发布的确切版本，不能替换或混用来源。');
    }
  };
  const assertService = value => {
    const { item, spec } = serviceById(value?.id);
    if (item.serviceType === 'DAPI') return assertDapi(item.id);
    const version = item.currentVersion;
    allowed(version?.serviceId === item.id && version.id === item.currentVersionId && version.scope === 'PRIVATE_CLOUD_TEST' &&
      version.versionNumber === 1 && version.serviceType === 'XAPI' && version.joinKey === 'client_id' && serviceVersionConfigValid(version) &&
      version.timeoutMs === spec.timeoutMs && version.rateLimitPerMinute === spec.rateLimitPerMinute);
    xapiSteps(version.steps);
    if (item.publishedVersionId) allowed(item.publishedVersion?.id === item.publishedVersionId && item.publishedVersionId === version.id &&
      serviceVersionConfigValid(item.publishedVersion) && item.publishedVersion.configHash === version.configHash);
    return item;
  };
  const assertCreate = (type, body) => {
    open(); sourceMatches();
    const spec = type === 'DAPI' ? config.plan.dapis.find(item => item.slug === body?.slug) : type === 'XAPI' ? config.plan.xapi : undefined;
    allowed(spec && keys(body, type === 'DAPI' ? ['name', 'slug', 'sourceReleaseRunId', 'fields', 'timeoutMs', 'rateLimitPerMinute']
      : ['name', 'slug', 'steps', 'timeoutMs', 'rateLimitPerMinute']));
    if (type === 'DAPI') allowed(same(body, { ...spec, sourceReleaseRunId: config.plan.sourceReleaseRunId }));
    else {
      allowed(body.name === spec.name && body.slug === spec.slug && body.timeoutMs === spec.timeoutMs && body.rateLimitPerMinute === spec.rateLimitPerMinute);
      xapiSteps(body.steps);
    }
    check(!store.list('data_service', project).some(item => item.pilotId === config.pilotId && item.slug === spec.slug),
      'PUBLIC_SERVICE_SLOT_USED', '本次接口名额已使用；请查询原幂等请求，不会换编号重复创建。');
  };
  const assertApplicationCreate = body => {
    open(); allowed(keys(body, ['name', 'serviceIds']) && body.name === config.plan.applicationName && Array.isArray(body.serviceIds) &&
      body.serviceIds.length >= 1 && body.serviceIds.length <= 3 && new Set(body.serviceIds).size === body.serviceIds.length);
    for (const id of body.serviceIds) {
      const item = assertService({ id }); allowed(item.status === 'PUBLISHED' && item.publishedVersionId && item.publishedVersion?.status === 'PUBLISHED');
    }
    check(!store.list('service_app', project).some(app => app.pilotId === config.pilotId),
      'PUBLIC_SERVICE_APPLICATION_USED', '本次调用应用名额已使用；撤销或到期后不会自动签发第二个凭证。');
  };
  const assertApplication = value => {
    const app = typeof value?.id === 'string' && store.get('service_app', value.id, project);
    allowed(app && app.pilotId === config.pilotId && app.scope === 'PRIVATE_CLOUD_TEST' && app.name === config.plan.applicationName,
      '只能操作本次数据服务试点的调用应用。');
    return value;
  };
  return { assertCreate, assertService, assertApplicationCreate, assertApplication,
    recordTags: Object.freeze({ pilotId: config.pilotId }),
    applicationTags: Object.freeze({ pilotId: config.pilotId, expiresAt: new Date(config.expiresAt).toISOString() }) };
}
