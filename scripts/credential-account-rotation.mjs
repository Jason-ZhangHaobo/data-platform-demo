// Phase A only. No CLI entry point, filesystem, fetch or cloud client.
// plan.approved is a data gate; the caller must independently verify the actual
// human authorization and the authenticity of every injected IO result.
import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { AuthManager } from "../src/v2/auth.mjs";
import { modelSettings } from "../src/v2/model.mjs";
import { validatePreparedConfig } from "./start-v2-secure-config.mjs";
import { functionSnapshot } from "./refresh-v2-spark-readiness.mjs";

const protocol = "SHUDUO_ACCOUNT_MODEL_ROTATION_A_CHECKPOINT_V1";
const secretNames = ["DASHSCOPE_API_KEY", "V2_MYSQL_PASSWORD", "V2_BOOTSTRAP_ADMIN_PASSWORD_HASH"];
const steps = ["READ_BASELINES", "VERIFY_OLD_LOGIN", "PROBE_NEW_MODEL_KEY", "CHANGE_LOGIN_PASSWORD", "VERIFY_NEW_SESSION", "VERIFY_OLD_SESSION",
  "VERIFY_OLD_PASSWORD_REJECTED", "VERIFY_NEW_PASSWORD_LOGIN", "RESET_DATABASE_PASSWORD", "READ_CONTROL_BEFORE_UPDATE", "UPDATE_CONTROL_ENVIRONMENT",
  "READ_CONTROL_AFTER_UPDATE", "VERIFY_RUNTIME", ...secretNames.map(name => `SET_${name}`), "SAVE_LOCAL_MODEL_KEY"];
const counters = ["requests", "passwordChanges", "rdsResets", "controlUpdates", "githubSecretUpdates", "localModelUpdates"];
const codes = new Set(["BASELINE_CHANGED", "CURRENT_LOGIN_REJECTED", "MODEL_KEY_UNAVAILABLE", "LOGIN_CHANGE_UNCONFIRMED", "NEW_SESSION_INVALID",
  "OLD_SESSION_STILL_VALID", "OLD_PASSWORD_NOT_REJECTED", "NEW_PASSWORD_LOGIN_FAILED", "DATABASE_RESET_UNCONFIRMED", "CONTROL_CHANGED_BEFORE_UPDATE",
  "CONTROL_UPDATE_UNCONFIRMED", "CONTROL_READBACK_MISMATCH", "RUNTIME_EVIDENCE_INCOMPLETE", "GITHUB_SECRET_WRITE_UNCONFIRMED",
  "LOCAL_MODEL_WRITE_UNCONFIRMED", "IO_RESPONSE_UNKNOWN", "CHECKPOINT_WRITE_UNCONFIRMED", "DEADLINE_EXPIRED", "BUDGET_EVIDENCE_EXPIRED",
  "RESTART_REQUIRES_RECONCILIATION"]);
const failure = code => Object.assign(new Error(code), { code });
const requireValue = (value, code) => { if (!value) throw failure(code); };
const same = isDeepStrictEqual;
const positive = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
const stable = fn => fn && (!fn.state || fn.state === "Active") && (!fn.lastUpdateStatus || fn.lastUpdateStatus === "Successful");
const sessionText = value => typeof value === "string" && value.length > 0 && value.length <= 16384 && !/[\r\n\0]/.test(value);

function countsFor(attempts) {
  const counts = Object.fromEntries(counters.map(name => [name, 0]));
  for (const step of attempts) {
    counts.requests++;
    if (step === "CHANGE_LOGIN_PASSWORD") counts.passwordChanges++;
    if (step === "RESET_DATABASE_PASSWORD") counts.rdsResets++;
    if (step === "UPDATE_CONTROL_ENVIRONMENT") counts.controlUpdates++;
    if (step.startsWith("SET_")) counts.githubSecretUpdates++;
    if (step === "SAVE_LOCAL_MODEL_KEY") counts.localModelUpdates++;
  }
  return counts;
}

function safeSummary(state) {
  return { protocol: "SHUDUO_ACCOUNT_MODEL_ROTATION_A_RESULT_V1", operationId: state.operationId, status: state.status, phase: state.phase,
    ...(state.code ? { code: state.code } : {}), attempted: structuredClone(state.counts), confirmed: structuredClone(state.confirmedCounts),
    modelGenerationCalls: 0, sparkRuns: 0, oldModelKeyDeleted: false, workerChanged: false, containsSecretValues: false,
    requiresIndependentAuthorizationEvidence: true, requiresCallerEvidenceVerification: true, verificationBasis: "CALLER_INJECTED_IO_RESULTS" };
}
const resultFor = state => ({ status: state.status, phase: state.phase, summary: safeSummary(state), checkpoint: structuredClone(state) });

function validatePlan(plan) {
  const fn = plan?.reviewedControl, env = fn?.environmentVariables, db = plan?.database, reviewedDb = plan?.reviewedDatabase;
  requireValue(plan?.protocol === "SHUDUO_ACCOUNT_MODEL_ROTATION_A_V1" && plan.approved === true &&
    /^(?:[a-f0-9]{32}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/.test(plan.operationId ?? "") &&
    typeof plan.email === "string" && plan.email.length <= 160 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(plan.email) && plan.email === plan.email.toLowerCase() &&
    typeof plan.projectId === "string" && plan.projectId.length > 0 && plan.projectId.length <= 100 &&
    Number.isSafeInteger(plan.issuedAt) && Number.isSafeInteger(plan.expiresAt) && plan.expiresAt > plan.issuedAt && plan.expiresAt - plan.issuedAt <= 2 * 3600000 &&
    /^dataplatform-v2-[a-z0-9-]{1,60}$/.test(plan.controlName ?? "") && fn?.functionName === plan.controlName && stable(fn) &&
    fn.runtime === "custom.debian12" && fn.instanceConcurrency === 8 && env?.V2_LOCAL_DEVELOPMENT === "false" &&
    env.V2_PROVISIONING_ONLY === "true" && env.V2_PRIVATE_SMOKE_ENABLED === "true" && env.V2_FC_PUBLIC_HTTP_ENABLED === "true" &&
    env.V2_FC_PUBLIC_READ_ONLY === "true" && !env.V2_FC_PUBLIC_WRITE_SCOPE && env.V2_PRIVATE_RELEASE_ENABLED !== "true" &&
    env.V2_BOOTSTRAP_ADMIN_EMAIL === plan.email && (env.V2_PROJECT_ID ?? "project-securities-lab") === plan.projectId &&
    env.V2_MYSQL_USER === "platform_app" && env.V2_MYSQL_DATABASE === "platform_meta" &&
    typeof env.V2_MYSQL_PASSWORD === "string" && env.V2_MYSQL_PASSWORD.length > 0 && typeof env.DASHSCOPE_API_KEY === "string" && env.DASHSCOPE_API_KEY.length > 0,
  "ROTATION_PLAN_INVALID");
  requireValue(typeof db?.instanceId === "string" && /^rm-[a-zA-Z0-9-]{1,80}$/.test(db.instanceId) && db.accountName === "platform_app" && db.databaseName === "platform_meta" &&
    reviewedDb?.instanceId === db.instanceId && reviewedDb.accountName === db.accountName && reviewedDb.databaseName === db.databaseName &&
    reviewedDb.accountStatus === "Available" && reviewedDb.privilege === "ReadWrite", "ROTATION_DATABASE_BASELINE_INVALID");
  let modelUrl;
  try { modelUrl = new URL(plan.modelBaseUrl); } catch { throw failure("ROTATION_MODEL_TARGET_INVALID"); }
  const effectiveModel = modelSettings(env);
  requireValue(modelUrl.protocol === "https:" && !modelUrl.username && !modelUrl.password && !modelUrl.search && !modelUrl.hash &&
    plan.modelBaseUrl === effectiveModel.baseUrl && typeof plan.modelId === "string" && plan.modelId.length > 0 && plan.modelId === effectiveModel.model,
  "ROTATION_MODEL_TARGET_INVALID");
  requireValue(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(plan.github?.repo ?? "") && plan.github.environment === "v2-staging", "ROTATION_SECRET_TARGET_INVALID");
  const b = plan.budget;
  requireValue(Number.isSafeInteger(b?.checkedAt) && positive(b.spendCny) && positive(b.retainedReserveCny) && positive(b.maxIncrementCny) &&
    b.maxIncrementCny > 0 && b.monthlyLimitCny === 200 && b.spendCny + b.retainedReserveCny + b.maxIncrementCny < b.monthlyLimitCny,
  "ROTATION_BUDGET_INVALID");
}

function validateCandidate(candidate, plan) {
  const names = ["email", "mysql", "currentPassword", "password", "modelKey", "bootstrapPasswordHash"];
  requireValue(candidate && Object.keys(candidate).length === names.length && names.every(name => Object.hasOwn(candidate, name)) && candidate.email === plan.email,
    "ROTATION_CANDIDATE_INVALID");
  try {
    const validated = validatePreparedConfig({ mysql: candidate.mysql, currentPassword: candidate.currentPassword, password: candidate.password,
      confirm: candidate.password, modelKey: candidate.modelKey });
    requireValue(validated.modelKey === candidate.modelKey, "ROTATION_CANDIDATE_INVALID");
  } catch { throw failure("ROTATION_CANDIDATE_INVALID"); }
  requireValue(candidate.mysql !== plan.reviewedControl.environmentVariables.V2_MYSQL_PASSWORD &&
    candidate.modelKey !== plan.reviewedControl.environmentVariables.DASHSCOPE_API_KEY, "ROTATION_UNCHANGED_CREDENTIAL");
  // Reuse AuthManager's bounded scrypt validation and password verification in a
  // disposable in-memory store. This never reads or changes a real auth_user.
  const rows = [], store = {
    list: kind => rows.filter(row => row.kind === kind),
    create: (kind, project, value) => { const row = { ...value, id: randomUUID(), kind, projectId: project }; rows.push(row); return row; },
    get: (_kind, id) => rows.find(row => row.id === id),
    update: (_kind, id, _project, patch) => Object.assign(rows.find(row => row.id === id), patch),
  };
  try {
    const auth = new AuthManager({ store, project: plan.projectId, env: {} });
    auth.bootstrapAdmin({ email: plan.email, displayName: "合成哈希验证", passwordHash: candidate.bootstrapPasswordHash });
    auth.login({ email: plan.email, password: candidate.password });
  } catch { throw failure("ROTATION_BOOTSTRAP_PASSWORD_MISMATCH"); }
}

function validateCheckpoint(value, operationId) {
  const keys = ["protocol", "operationId", "status", "phase", "attemptedSteps", "confirmedSteps", "counts", "confirmedCounts", "updatedAt", "code"];
  requireValue(value?.protocol === protocol && value.operationId === operationId && Object.keys(value).every(key => keys.includes(key)) &&
    ["BEFORE_REQUEST", "CONFIRMED", "NEEDS_RECONCILIATION", "FAILED", "COMPLETE"].includes(value.status) &&
    [...steps, "VALIDATE_INPUTS", "COMPLETE"].includes(value.phase) && Number.isSafeInteger(value.updatedAt) &&
    (!value.code || codes.has(value.code)) && Array.isArray(value.attemptedSteps) && Array.isArray(value.confirmedSteps) &&
    value.attemptedSteps.every((step, index) => step === steps[index]) &&
    value.confirmedSteps.every((step, index) => step === value.attemptedSteps[index]) &&
    value.attemptedSteps.length <= steps.length && value.confirmedSteps.length <= value.attemptedSteps.length &&
    same(value.counts, countsFor(value.attemptedSteps)) && same(value.confirmedCounts, countsFor(value.confirmedSteps)) &&
    (value.status !== "COMPLETE" || value.phase === "COMPLETE" && value.confirmedSteps.length === steps.length), "ROTATION_CHECKPOINT_INVALID");
}

/**
 * IO contracts (all values and sessions are private in-memory data):
 * readBaselines() -> {control, database}; database uses the reviewedDatabase
 * fields {instanceId, accountName, databaseName, accountStatus, privilege}.
 * login({email,password}), changePassword({session,currentPassword,newPassword})
 *   -> {status, code?, session?}; a successful session contains
 *   {user:{id,email,projectId,status:'ACTIVE'},role:'ADMIN',permissions:['SESSION'],cookie,csrfToken}.
 * readSession({session}) -> {authenticated,readOnly,user?,role?}.
 * probeModelKey({key,baseUrl,modelId}) -> {status:200,available:true,modelAvailable:true,modelGenerationCalls:0}; NO inference fallback.
 * resetDatabasePassword({instanceId,accountName,password}),
 * updateControlEnvironment({controlName,environmentVariables}) -> {accepted:true}.
 * readControl({controlName,phase}) -> full stable function; phase is BEFORE_UPDATE/AFTER_UPDATE.
 * verifyRuntime() -> {freshInstance,readonly,newDatabaseConnection,priorUserPreserved}, all true.
 * setGithubSecret({repo,environment,name,value}) -> {saved:true}; saveLocalModelKey({key}) -> {configured:true}.
 * saveCheckpoint(safeState) must durably complete before each other IO call.
 * Plan issuedAt/expiresAt/budget.checkedAt and now() are epoch milliseconds.
 * Any adapter rejection is an unknown response. No request is automatically retried.
 */
export async function rotateAccountModelCredentials({ candidate, plan, io, checkpoint, now = Date.now }) {
  try { plan = structuredClone(plan); } catch { throw failure("ROTATION_PLAN_INVALID"); }
  validatePlan(plan);
  if (checkpoint && Object.keys(checkpoint).length) {
    validateCheckpoint(checkpoint, plan.operationId);
    if (checkpoint.status === "COMPLETE") return resultFor(checkpoint);
    return resultFor({ ...structuredClone(checkpoint), status: "NEEDS_RECONCILIATION", code: "RESTART_REQUIRES_RECONCILIATION" });
  }
  try { candidate = structuredClone(candidate); } catch { throw failure("ROTATION_CANDIDATE_INVALID"); }
  validateCandidate(candidate, plan);
  for (const name of ["saveCheckpoint", "readBaselines", "login", "readSession", "probeModelKey", "changePassword", "resetDatabasePassword",
    "readControl", "updateControlEnvironment", "verifyRuntime", "setGithubSecret", "saveLocalModelKey"])
    requireValue(typeof io?.[name] === "function", "ROTATION_IO_INVALID");
  const state = { protocol, operationId: plan.operationId, status: "CONFIRMED", phase: "VALIDATE_INPUTS", attemptedSteps: [], confirmedSteps: [],
    counts: countsFor([]), confirmedCounts: countsFor([]), updatedAt: now() };
  const halt = Symbol("phase-a-stop");
  const persist = async () => {
    state.updatedAt = now();
    try { await io.saveCheckpoint(structuredClone(state)); }
    catch { state.status = "NEEDS_RECONCILIATION"; state.code = "CHECKPOINT_WRITE_UNCONFIRMED"; throw halt; }
  };
  const stop = async (code, status = "NEEDS_RECONCILIATION") => { state.status = status; state.code = code; await persist(); throw halt; };
  const window = async () => {
    const time = now();
    if (!Number.isSafeInteger(time) || time < plan.issuedAt || time >= plan.expiresAt) await stop("DEADLINE_EXPIRED", "FAILED");
    if (plan.budget.checkedAt > time || time - plan.budget.checkedAt >= 3600000) await stop("BUDGET_EVIDENCE_EXPIRED", "FAILED");
  };
  const request = async (phase, method, argument, validate, code, invalidStatus = "NEEDS_RECONCILIATION") => {
    await window();
    requireValue(phase === steps[state.attemptedSteps.length], "ROTATION_STEP_ORDER_INVALID");
    state.phase = phase; state.status = "BEFORE_REQUEST"; delete state.code;
    state.attemptedSteps.push(phase); state.counts = countsFor(state.attemptedSteps);
    await persist(); await window();
    let value;
    try { value = await io[method](argument); } catch { await stop("IO_RESPONSE_UNKNOWN"); }
    let valid = false;
    try { valid = validate(value); } catch { /* Treat malformed evidence as unconfirmed, never print it. */ }
    if (!valid) await stop(code, invalidStatus);
    state.confirmedSteps.push(phase); state.confirmedCounts = countsFor(state.confirmedSteps); state.status = "CONFIRMED";
    await persist(); return value;
  };
  const userMatches = (user, expectedId) => user?.email === plan.email && user.projectId === plan.projectId && user.status === "ACTIVE" &&
    typeof user.id === "string" && user.id.length > 0 && (!expectedId || user.id === expectedId);
  const validSession = (value, expectedId) => value?.status === 200 && userMatches(value.session?.user, expectedId) && value.session.role === "ADMIN" &&
    same(value.session.permissions, ["SESSION"]) && sessionText(value.session.cookie) && sessionText(value.session.csrfToken);
  try {
    await request("READ_BASELINES", "readBaselines", undefined, value => stable(value?.control) &&
      same(functionSnapshot(value.control), functionSnapshot(plan.reviewedControl)) && same(value.database, plan.reviewedDatabase), "BASELINE_CHANGED", "FAILED");
    const original = await request("VERIFY_OLD_LOGIN", "login", { email: plan.email, password: candidate.currentPassword }, value => validSession(value), "CURRENT_LOGIN_REJECTED", "FAILED");
    const userId = original.session.user.id;
    await request("PROBE_NEW_MODEL_KEY", "probeModelKey", { key: candidate.modelKey, baseUrl: plan.modelBaseUrl, modelId: plan.modelId },
      value => value?.status === 200 && value.available === true && value.modelAvailable === true && value.modelGenerationCalls === 0, "MODEL_KEY_UNAVAILABLE", "FAILED");
    const changed = await request("CHANGE_LOGIN_PASSWORD", "changePassword", { session: original.session, currentPassword: candidate.currentPassword, newPassword: candidate.password },
      value => validSession(value, userId), "LOGIN_CHANGE_UNCONFIRMED");
    await request("VERIFY_NEW_SESSION", "readSession", { session: changed.session },
      value => value?.authenticated === true && value.readOnly === true && value.role === "ADMIN" && userMatches(value.user, userId), "NEW_SESSION_INVALID");
    await request("VERIFY_OLD_SESSION", "readSession", { session: original.session }, value => value?.authenticated === false && value.readOnly === true, "OLD_SESSION_STILL_VALID");
    await request("VERIFY_OLD_PASSWORD_REJECTED", "login", { email: plan.email, password: candidate.currentPassword },
      value => value?.status === 401 && value.code === "INVALID_LOGIN" && !value.session, "OLD_PASSWORD_NOT_REJECTED");
    await request("VERIFY_NEW_PASSWORD_LOGIN", "login", { email: plan.email, password: candidate.password }, value => validSession(value, userId), "NEW_PASSWORD_LOGIN_FAILED");
    await request("RESET_DATABASE_PASSWORD", "resetDatabasePassword", { instanceId: plan.database.instanceId, accountName: plan.database.accountName, password: candidate.mysql },
      value => value?.accepted === true, "DATABASE_RESET_UNCONFIRMED");
    await request("READ_CONTROL_BEFORE_UPDATE", "readControl", { controlName: plan.controlName, phase: "BEFORE_UPDATE" },
      value => stable(value) && same(functionSnapshot(value), functionSnapshot(plan.reviewedControl)), "CONTROL_CHANGED_BEFORE_UPDATE");
    const environmentVariables = { ...plan.reviewedControl.environmentVariables, DASHSCOPE_API_KEY: candidate.modelKey,
      V2_MYSQL_PASSWORD: candidate.mysql, V2_BOOTSTRAP_ADMIN_PASSWORD_HASH: candidate.bootstrapPasswordHash };
    await request("UPDATE_CONTROL_ENVIRONMENT", "updateControlEnvironment", { controlName: plan.controlName, environmentVariables },
      value => value?.accepted === true, "CONTROL_UPDATE_UNCONFIRMED");
    const expected = { ...plan.reviewedControl, environmentVariables };
    await request("READ_CONTROL_AFTER_UPDATE", "readControl", { controlName: plan.controlName, phase: "AFTER_UPDATE" },
      value => stable(value) && same(functionSnapshot(value), functionSnapshot(expected)), "CONTROL_READBACK_MISMATCH");
    await request("VERIFY_RUNTIME", "verifyRuntime", undefined,
      value => ["freshInstance", "readonly", "newDatabaseConnection", "priorUserPreserved"].every(name => value?.[name] === true), "RUNTIME_EVIDENCE_INCOMPLETE");
    for (const name of secretNames) await request(`SET_${name}`, "setGithubSecret", { ...plan.github, name, value: environmentVariables[name] },
      value => value?.saved === true, "GITHUB_SECRET_WRITE_UNCONFIRMED");
    await request("SAVE_LOCAL_MODEL_KEY", "saveLocalModelKey", { key: candidate.modelKey }, value => value?.configured === true, "LOCAL_MODEL_WRITE_UNCONFIRMED");
    state.status = "COMPLETE"; state.phase = "COMPLETE"; await persist();
  } catch (error) { if (error !== halt) throw error; }
  return resultFor(state);
}
