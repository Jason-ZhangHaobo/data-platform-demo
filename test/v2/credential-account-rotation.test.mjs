// Entirely synthetic memory adapters; no server, subprocess, filesystem write or cloud API.
import test from "node:test";
import assert from "node:assert/strict";
import { rotateAccountModelCredentials } from "../../scripts/credential-account-rotation.mjs";
import { validatePreparedConfig } from "../../scripts/start-v2-secure-config.mjs";
import { createPasswordHash } from "../../src/v2/auth.mjs";

const baseTime = Date.parse("2026-11-02T08:00:00Z");
const email = "owner@synthetic.example";
const prepared = { email, ...validatePreparedConfig({ mysql: "NewSyntheticDb!42", currentPassword: "  OldSyntheticLogin!42  ",
  password: "NewSyntheticLogin!42", confirm: "NewSyntheticLogin!42", modelKey: "sk-synthetic-new-model-key" }) };
const oldHash = createPasswordHash(prepared.currentPassword);
const fixture = (options = {}) => {
  let time = baseTime, loginCount = 0, current;
  const candidate = structuredClone(prepared), calls = [], checkpoints = [];
  const database = { instanceId: "rm-synthetic-instance", accountName: "platform_app", databaseName: "platform_meta" };
  const reviewedDatabase = { ...database, accountStatus: "Available", privilege: "ReadWrite" };
  const reviewedControl = { functionName: "dataplatform-v2-synthetic-api", runtime: "custom.debian12", instanceConcurrency: 8, cpu: .25, memorySize: 512,
    codeChecksum: "synthetic-code", codeSize: 42, role: "synthetic-role", futureBoundary: { unchanged: true },
    environmentVariables: { V2_LOCAL_DEVELOPMENT: "false", V2_PROVISIONING_ONLY: "true", V2_PRIVATE_SMOKE_ENABLED: "true", V2_FC_PUBLIC_HTTP_ENABLED: "true",
      V2_FC_PUBLIC_READ_ONLY: "true", V2_PRIVATE_RELEASE_ENABLED: "false", V2_BOOTSTRAP_ADMIN_EMAIL: email, V2_PROJECT_ID: "project-securities-lab",
      V2_MYSQL_USER: "platform_app", V2_MYSQL_DATABASE: "platform_meta", V2_MYSQL_PASSWORD: "OldSyntheticDb!42", DASHSCOPE_API_KEY: "sk-synthetic-old-model-key",
      V2_BOOTSTRAP_ADMIN_PASSWORD_HASH: oldHash, V2_MODEL: "synthetic-model", V2_MODEL_BASE_URL: "https://models.example.invalid/v1",
      V2_SPARK_EXECUTOR_SECRET: "synthetic-worker-secret-must-not-change", FUTURE_SETTING: "preserve" } };
  for (const name of options.omittedModelFields ?? []) delete reviewedControl.environmentVariables[name];
  const plan = { protocol: "SHUDUO_ACCOUNT_MODEL_ROTATION_A_V1", operationId: "a".repeat(32), approved: true, issuedAt: time, expiresAt: time + 2 * 3600000,
    email, projectId: "project-securities-lab", modelId: options.omittedModelFields?.includes("V2_MODEL") ? "qwen3.7-plus" : "synthetic-model",
    modelBaseUrl: options.omittedModelFields?.includes("V2_MODEL_BASE_URL") ? "https://dashscope.aliyuncs.com/compatible-mode/v1" : "https://models.example.invalid/v1", controlName: reviewedControl.functionName,
    database, reviewedDatabase, reviewedControl, github: { repo: "synthetic-owner/synthetic-repo", environment: "v2-staging" },
    budget: { checkedAt: time, spendCny: 5, retainedReserveCny: 64, maxIncrementCny: 2, monthlyLimitCny: 200 } };
  current = structuredClone(reviewedControl);
  const user = { id: "synthetic-user-id", email, projectId: plan.projectId, status: "ACTIVE" };
  const session = label => ({ user: structuredClone(user), role: "ADMIN", permissions: ["SESSION"], cookie: `synthetic-private-cookie-${label}`, csrfToken: `synthetic-private-csrf-${label}` });
  const oldSession = session("old"), changedSession = session("changed"), freshSession = session("fresh");
  const implementations = {
    readBaselines: () => ({ control: structuredClone(current), database: structuredClone(reviewedDatabase) }),
    login: input => {
      loginCount++;
      assert.equal(input.email, email);
      if (loginCount === 1) { assert.equal(input.password, candidate.currentPassword); return { status: 200, session: structuredClone(oldSession) }; }
      if (loginCount === 2) { assert.equal(input.password, candidate.currentPassword); return { status: 401, code: "INVALID_LOGIN" }; }
      assert.equal(input.password, candidate.password); return { status: 200, session: structuredClone(freshSession) };
    },
    probeModelKey: input => { assert.deepEqual(input, { key: candidate.modelKey, baseUrl: plan.modelBaseUrl, modelId: plan.modelId });
      return { status: 200, available: true, modelAvailable: true, modelGenerationCalls: 0 }; },
    changePassword: input => { assert.deepEqual(input, { session: oldSession, currentPassword: candidate.currentPassword, newPassword: candidate.password });
      return { status: 200, session: structuredClone(changedSession) }; },
    readSession: input => input.session.cookie === oldSession.cookie ? { authenticated: false, readOnly: true } :
      { authenticated: true, readOnly: true, user: structuredClone(user), role: "ADMIN" },
    resetDatabasePassword: input => { assert.deepEqual(input, { instanceId: database.instanceId, accountName: database.accountName, password: candidate.mysql }); return { accepted: true }; },
    readControl: input => { assert.equal(input.controlName, plan.controlName); return structuredClone(current); },
    updateControlEnvironment: input => { assert.equal(input.controlName, plan.controlName); current.environmentVariables = structuredClone(input.environmentVariables); return { accepted: true }; },
    verifyRuntime: () => ({ freshInstance: true, readonly: true, newDatabaseConnection: true, priorUserPreserved: true }),
    setGithubSecret: input => { assert.equal(input.repo, plan.github.repo); assert.equal(input.environment, "v2-staging");
      assert.equal(input.value, current.environmentVariables[input.name]); return { saved: true }; },
    saveLocalModelKey: input => { assert.deepEqual(input, { key: candidate.modelKey }); return { configured: true, connectionVerified: false }; },
  };
  const io = { saveCheckpoint: async value => {
    if (options.failCheckpoint?.(value)) throw Error(`synthetic checkpoint transport error ${candidate.password}`);
    checkpoints.push(structuredClone(value));
    options.afterCheckpoint?.(value, () => { time += 2 * 3600000; });
  } };
  for (const [name, implementation] of Object.entries(implementations)) io[name] = async input => {
    const checkpoint = checkpoints.at(-1);
    assert.equal(checkpoint.status, "BEFORE_REQUEST", `missing durable barrier before ${name}`);
    calls.push({ method: name, phase: checkpoint.phase, input: structuredClone(input) });
    let value = implementation(input);
    if (options.failAt === checkpoint.phase) throw Error(`SYNTHETIC_UNKNOWN ${candidate.password} ${candidate.modelKey}`);
    if (options.mutateResult) value = options.mutateResult(checkpoint.phase, value) ?? value;
    return value;
  };
  const run = checkpoint => rotateAccountModelCredentials({ candidate, plan, io, checkpoint, now: () => time });
  return { candidate, plan, io, calls, checkpoints, run, get current() { return current; }, setTime: value => { time = value; } };
};

test("phase A performs only the bounded account/model changes behind durable barriers and never reports secret values", async () => {
  const f = fixture(), result = await f.run();
  assert.equal(result.status, "COMPLETE");
  assert.deepEqual(result.summary.confirmed, { requests: 17, passwordChanges: 1, rdsResets: 1, controlUpdates: 1, githubSecretUpdates: 3, localModelUpdates: 1 });
  assert.equal(result.summary.requiresIndependentAuthorizationEvidence, true);
  assert.equal(result.summary.requiresCallerEvidenceVerification, true);
  assert.equal(result.summary.verificationBasis, "CALLER_INJECTED_IO_RESULTS");
  assert.equal(result.summary.modelGenerationCalls, 0); assert.equal(result.summary.sparkRuns, 0);
  assert.equal(result.summary.oldModelKeyDeleted, false); assert.equal(result.summary.workerChanged, false);
  const expected = structuredClone(f.plan.reviewedControl);
  Object.assign(expected.environmentVariables, { DASHSCOPE_API_KEY: f.candidate.modelKey, V2_MYSQL_PASSWORD: f.candidate.mysql,
    V2_BOOTSTRAP_ADMIN_PASSWORD_HASH: f.candidate.bootstrapPasswordHash });
  assert.deepEqual(f.current, expected);
  assert.deepEqual(f.calls.filter(x => x.method === "setGithubSecret").map(x => x.input.name),
    ["DASHSCOPE_API_KEY", "V2_MYSQL_PASSWORD", "V2_BOOTSTRAP_ADMIN_PASSWORD_HASH"]);
  assert.equal(f.calls.filter(x => x.method === "changePassword").length, 1);
  assert.equal(f.calls.filter(x => x.method === "resetDatabasePassword").length, 1);
  assert.equal(f.calls.filter(x => x.method === "updateControlEnvironment").length, 1);
  const publicOutput = JSON.stringify({ result, checkpoints: f.checkpoints });
  for (const secret of [...Object.values(f.candidate), oldHash, f.plan.reviewedControl.environmentVariables.V2_MYSQL_PASSWORD,
    f.plan.reviewedControl.environmentVariables.DASHSCOPE_API_KEY, "synthetic-private-cookie-old", "synthetic-private-csrf-changed"])
    assert.equal(publicOutput.includes(secret), false);
});

test("fixed targets, read-only configuration, budget and candidate changes fail before any adapter request", async () => {
  for (const mutate of [
    f => { f.plan.approved = false; }, f => { f.candidate.email = "other@example.invalid"; },
    f => { f.plan.database.accountName = "other_app"; }, f => { f.plan.controlName = "dataplatform-v2-other-api"; },
    f => { f.plan.reviewedControl.environmentVariables.V2_FC_PUBLIC_READ_ONLY = "false"; },
    f => { f.plan.reviewedControl.environmentVariables.V2_FC_PUBLIC_WRITE_SCOPE = "DEVELOPMENT_ONLY"; },
    f => { f.plan.budget.spendCny = 134; }, f => { f.plan.expiresAt++; },
    f => { f.candidate.mysql = f.plan.reviewedControl.environmentVariables.V2_MYSQL_PASSWORD; },
    f => { f.candidate.modelKey = f.plan.reviewedControl.environmentVariables.DASHSCOPE_API_KEY; },
    f => { f.candidate.modelKey = ` ${f.plan.reviewedControl.environmentVariables.DASHSCOPE_API_KEY} `; },
    f => { f.candidate.password = f.candidate.currentPassword; }, f => { f.candidate.bootstrapPasswordHash = oldHash; },
    f => { f.candidate.workerSecret = "not-permitted"; }, f => { f.plan.modelBaseUrl = "https://unreviewed.example.invalid"; },
  ]) {
    const f = fixture(); mutate(f); await assert.rejects(f.run()); assert.equal(f.calls.length, 0); assert.equal(f.checkpoints.length, 0);
  }
});

test("effective runtime model defaults are accepted without adding model settings to the baseline or environment update", async () => {
  for (const omittedModelFields of [["V2_MODEL"], ["V2_MODEL_BASE_URL"], ["V2_MODEL", "V2_MODEL_BASE_URL"]]) {
    const f = fixture({ omittedModelFields }), before = structuredClone(f.plan.reviewedControl);
    const result = await f.run(); assert.equal(result.status, "COMPLETE");
    assert.deepEqual(f.plan.reviewedControl, before);
    const patch = f.calls.find(call => call.method === "updateControlEnvironment").input.environmentVariables;
    for (const name of omittedModelFields) {
      assert.equal(Object.hasOwn(f.current.environmentVariables, name), false);
      assert.equal(Object.hasOwn(patch, name), false);
    }
    assert.deepEqual(f.calls.find(call => call.method === "probeModelKey").input,
      { key: f.candidate.modelKey, baseUrl: f.plan.modelBaseUrl, modelId: f.plan.modelId });
  }
});

test("plans that disagree with effective model defaults are rejected before checkpoints or requests", async () => {
  for (const key of ["modelId", "modelBaseUrl"]) {
    const f = fixture({ omittedModelFields: ["V2_MODEL", "V2_MODEL_BASE_URL"] });
    f.plan[key] = key === "modelId" ? "wrong-model" : "https://unreviewed.example.invalid/v1";
    await assert.rejects(f.run(), { code: "ROTATION_MODEL_TARGET_INVALID" });
    assert.equal(f.calls.length, 0); assert.equal(f.checkpoints.length, 0);
  }
});

test("only a precise old-password 401 INVALID_LOGIN is accepted; success, throttling and server errors stop before RDS", async () => {
  for (const response of [{ status: 200 }, { status: 429, code: "INVALID_LOGIN" }, { status: 500 }, { status: 401, code: "AUTHENTICATION_REQUIRED" }]) {
    const f = fixture({ mutateResult: (phase, value) => phase === "VERIFY_OLD_PASSWORD_REJECTED" ? response : value });
    const result = await f.run();
    assert.equal(result.status, "NEEDS_RECONCILIATION"); assert.equal(result.phase, "VERIFY_OLD_PASSWORD_REJECTED");
    assert.equal(f.calls.filter(x => x.method === "resetDatabasePassword").length, 0);
    assert.equal(f.calls.filter(x => x.phase === "VERIFY_OLD_PASSWORD_REJECTED").length, 1);
  }
});

test("wrong identity, non-read-only sessions or an unavailable model cannot continue to a password/RDS reset", async () => {
  for (const target of ["VERIFY_OLD_LOGIN", "PROBE_NEW_MODEL_KEY", "VERIFY_NEW_SESSION", "VERIFY_OLD_SESSION", "VERIFY_NEW_PASSWORD_LOGIN"]) {
    const f = fixture({ mutateResult: (phase, value) => phase !== target ? value : phase === "PROBE_NEW_MODEL_KEY" ? { ...value, modelAvailable: false } :
      phase === "VERIFY_NEW_SESSION" ? { ...value, readOnly: false } : phase === "VERIFY_OLD_SESSION" ? { ...value, authenticated: true } :
      { ...value, session: { ...value.session, user: { ...value.session.user, email: "different@example.invalid" } } } });
    const result = await f.run(); assert.notEqual(result.status, "COMPLETE"); assert.equal(result.phase, target);
    assert.equal(f.calls.filter(x => x.method === "resetDatabasePassword").length, 0);
    if (["VERIFY_OLD_LOGIN", "PROBE_NEW_MODEL_KEY"].includes(target)) assert.equal(f.calls.filter(x => x.method === "changePassword").length, 0);
  }
});

test("an unknown response at any operation stops at that phase and a reused checkpoint never repeats an effect", async () => {
  const successful = fixture(); await successful.run();
  for (const { phase } of successful.calls) {
    const f = fixture({ failAt: phase }), result = await f.run();
    assert.equal(result.status, "NEEDS_RECONCILIATION"); assert.equal(result.phase, phase);
    assert.equal(f.calls.at(-1).phase, phase); assert.equal(f.calls.filter(x => x.phase === phase).length, 1);
    const count = f.calls.length, saves = f.checkpoints.length, repeated = await f.run(result.checkpoint);
    assert.equal(repeated.status, "NEEDS_RECONCILIATION"); assert.equal(repeated.phase, phase);
    assert.equal(f.calls.length, count); assert.equal(f.checkpoints.length, saves);
    for (const secret of [f.candidate.password, f.candidate.modelKey]) assert.equal(JSON.stringify(result).includes(secret), false);
  }
});

test("a failed checkpoint blocks the next request and an unknown control PUT is not repeated or guessed from configuration", async () => {
  const f = fixture({ failCheckpoint: state => state.phase === "RESET_DATABASE_PASSWORD" && state.status === "BEFORE_REQUEST" });
  const result = await f.run(); assert.equal(result.summary.code, "CHECKPOINT_WRITE_UNCONFIRMED");
  assert.equal(f.calls.some(x => x.method === "resetDatabasePassword"), false);
  const unknown = fixture({ failAt: "UPDATE_CONTROL_ENVIRONMENT" }), unconfirmed = await unknown.run();
  assert.equal(unconfirmed.status, "NEEDS_RECONCILIATION");
  assert.equal(unknown.current.environmentVariables.V2_MYSQL_PASSWORD, unknown.candidate.mysql, "the synthetic PUT applied before its response was lost");
  assert.equal(unknown.calls.some(x => x.phase === "READ_CONTROL_AFTER_UPDATE"), false);
  assert.equal(unknown.calls.some(x => x.method === "setGithubSecret"), false);
});

test("full function snapshots detect both pre-write drift and non-target readback changes", async () => {
  for (const phase of ["READ_BASELINES", "READ_CONTROL_BEFORE_UPDATE", "READ_CONTROL_AFTER_UPDATE"]) {
    const f = fixture({ mutateResult: (at, value) => {
      if (at === phase) (at === "READ_BASELINES" ? value.control : value).futureBoundary.unchanged = false;
      return value;
    } });
    const result = await f.run(); assert.equal(result.phase, phase); assert.notEqual(result.status, "COMPLETE");
    assert.equal(f.calls.some(x => x.method === "setGithubSecret"), false);
    assert.equal(f.calls.filter(x => x.method === "updateControlEnvironment").length, phase === "READ_CONTROL_AFTER_UPDATE" ? 1 : 0);
  }
});

test("runtime evidence requires all four caller-reported booleans before writing GitHub Secrets", async () => {
  for (const key of ["freshInstance", "readonly", "newDatabaseConnection", "priorUserPreserved"]) {
    const f = fixture({ mutateResult: (phase, value) => phase === "VERIFY_RUNTIME" ? { ...value, [key]: false } : value });
    const result = await f.run(); assert.equal(result.phase, "VERIFY_RUNTIME"); assert.equal(result.status, "NEEDS_RECONCILIATION");
    assert.equal(f.calls.some(x => x.method === "setGithubSecret" || x.method === "saveLocalModelKey"), false);
  }
});

test("time and budget freshness are checked before every operation, including after checkpoint persistence", async () => {
  const expired = fixture(); expired.setTime(baseTime + 2 * 3600000);
  assert.equal((await expired.run()).summary.code, "DEADLINE_EXPIRED"); assert.equal(expired.calls.length, 0);
  const stale = fixture(); stale.plan.budget.checkedAt -= 3600000;
  assert.equal((await stale.run()).summary.code, "BUDGET_EVIDENCE_EXPIRED"); assert.equal(stale.calls.length, 0);
  const delayed = fixture({ afterCheckpoint: (state, expire) => { if (state.phase === "VERIFY_OLD_LOGIN" && state.status === "BEFORE_REQUEST") expire(); } });
  const result = await delayed.run(); assert.equal(result.summary.code, "DEADLINE_EXPIRED");
  assert.equal(delayed.calls.some(x => x.method === "login"), false);
});

test("a completed checkpoint returns the same summary with no candidate or IO and rejects foreign or secret-bearing checkpoints", async () => {
  const f = fixture(), result = await f.run(), before = f.calls.length;
  const repeated = await rotateAccountModelCredentials({ plan: f.plan, checkpoint: result.checkpoint, now: () => baseTime });
  assert.deepEqual(repeated.summary, result.summary); assert.equal(f.calls.length, before);
  for (const patch of [{ operationId: "b".repeat(32) }, { candidate: prepared }, { confirmedCounts: { ...result.checkpoint.confirmedCounts, githubSecretUpdates: 4 } }])
    await assert.rejects(rotateAccountModelCredentials({ plan: f.plan, checkpoint: { ...result.checkpoint, ...patch }, now: () => baseTime }), { code: "ROTATION_CHECKPOINT_INVALID" });
});
