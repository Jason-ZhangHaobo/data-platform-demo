import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MetadataStore } from "../../../src/v2/store.mjs";
import { AuthManager } from "../../../src/v2/auth.mjs";
import { LocalArtifactStore } from "../../../src/v2/artifact-store.mjs";
import { createV2Server, PROJECT } from "../../../src/v2/server.mjs";
import { createFcIngress } from "../../../src/v2/fc-ingress.mjs";
import { getContext, referenceSqlForContext, validationFamilyForContext } from "../../../src/v2/context.mjs";
import { saveManualRevision } from "../../../src/v2/manual-revisions.mjs";
import { createDurableAgentDelivery } from "../../../src/v2/agent-development-workflow.mjs";
import { sha256 } from "../../../src/v2/delivery.mjs";
import { RemoteSparkQueueClient, SPARK_QUEUE_PREFIXES, createQueuedSparkResult } from "../../../src/v2/remote-spark-queue.mjs";
import { signSchedulerTick } from "../../../src/v2/scheduler-tick.mjs";

// Synthetic SQLite, authenticated loopback HTTP and signed in-memory queue.
// This helper never contacts a cloud, model or Spark. The password/keys below
// are public test constants and must never be used for a real account.
export const manualPublicationTestPassword = "SyntheticManualPublication!2026";
export async function createManualPublicationJourney({ applicationRoot, port = 0, businessStore, enableServices = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "shuduo-manual-publication-journey-"));
  const artifactStore = new LocalArtifactStore(join(directory, "artifacts")), objects = new Map(), identities = {};
  let now = Date.now(), app, base, store = new MetadataStore(join(directory, "metadata.sqlite"));
  let modelCalls = 0, jobCreates = 0, submitCalls = 0, resultReads = 0, cancelCalls = 0, failReads = false, losePublishFlush = false;
  const queueConfig = { projectId: PROJECT, sharedSecret: "synthetic-manual-publication-queue-key-123456789",
    jobPrefix: SPARK_QUEUE_PREFIXES.jobs, resultPrefix: SPARK_QUEUE_PREFIXES.results,
    cancellationPrefix: SPARK_QUEUE_PREFIXES.cancellations, timeoutMs: 180000 };
  const queue = new RemoteSparkQueueClient(queueConfig, {
    read: async key => objects.get(key),
    create: async (key, body) => {
      if (objects.has(key)) {
        if (objects.get(key) !== body) throw Error("SYNTHETIC_OBJECT_CONTENT_CHANGED");
        return { created: false };
      }
      objects.set(key, body); if (key.startsWith(queueConfig.jobPrefix + "/")) jobCreates++;
      return { created: true };
    },
  }, { now: () => now });
  const runner = async () => { throw Error("SYNTHETIC_BLOCKING_RUNNER_FORBIDDEN"); };
  runner.descriptor = { engine: "Apache Spark", isolation: "REMOTE_FUNCTION", transport: "PRIVATE_OSS_QUEUE", healthVerified: true, publicWriteEnabled: true };
  runner.durable = { prepare: (input, id) => queue.prepare(input, id), submit: prepared => { submitCalls++; return queue.submitPrepared(prepared); },
    read: prepared => { resultReads++; if (failReads) throw Error("SYNTHETIC_RECEIPT_READ_UNAVAILABLE"); return queue.readPreparedResult(prepared); },
    cancel: prepared => { cancelCalls++; return queue.cancelPrepared(prepared); } };
  const auth = new AuthManager({ store, project: PROJECT, env: {}, now: () => now });
  const owner = auth.bootstrapAdmin({ email: "manual-owner@example.invalid", password: manualPublicationTestPassword, displayName: "虚构审阅工程师" }),
    other = auth.bootstrapAdmin({ email: "manual-other@example.invalid", password: manualPublicationTestPassword, displayName: "虚构其他管理员" });
  const contextId = "stock-cash-t1", family = validationFamilyForContext(contextId),
    validation = { passed: true, contractId: family.id, regressions: family.contextIds.map(contextId => ({ contextId, passed: true })) };
  const failedRevision = store.create("revision", PROJECT, { author: owner.id, source: "LIVE_MODEL", contextId,
    sql: referenceSqlForContext(contextId).replace("SELECT DISTINCT position_id", "SELECT position_id") });
  store.update("revision", failedRevision.id, PROJECT, { hash: sha256(failedRevision.sql) });
  const failedRun = store.create("run", PROJECT, { revisionId: failedRevision.id, revisionHash: sha256(failedRevision.sql), contextId,
    validationContractId: family.id, status: "VALIDATION_FAILED", engine: "Apache Spark", engineVersion: "3.5.9", mainSqlExecuted: true,
    isolation: "FUNCTION_PROCESS", mode: "DURABLE_REMOTE_SUBMISSION", durationMs: 20, rows: getContext(contextId).expected,
    error: "合成历史：重复持仓独立校验未通过", validation: { ...validation, passed: false,
      regressions: validation.regressions.map(row => ({ ...row, passed: !row.contextId.includes("duplicate-position") })) } });
  const agent = store.create("agent", PROJECT, { submittedBy: owner.id, contextId, validationContractId: family.id, language: "SPARK_SQL", mode: "LIVE_MODEL",
    executionMode: "DURABLE_SQL_AGENT_V1", status: "FAILED", stage: "FAILED", usedTokens: 18000, tokenBudget: 18000, maxAttempts: 3,
    sql: failedRevision.sql, revisionId: failedRevision.id, runId: failedRun.id, message: "合成历史需求：加工股票持仓与可用现金", attempts: [
      { attempt: 1, status: "MODEL_OUTCOME_UNKNOWN", model: "unconfirmed", usageEstimated: true, usage: { total_tokens: 6000 } },
      { attempt: 2, status: "VALIDATION_FAILED", model: "synthetic-saved-model", usage: { total_tokens: 6000 }, revisionId: failedRevision.id, runId: failedRun.id },
      { attempt: 3, status: "VALIDATION_FAILED", model: "synthetic-saved-model", usage: { total_tokens: 6000 }, revisionId: failedRevision.id, runId: failedRun.id },
    ] });
  store.update("run", failedRun.id, PROJECT, { agentTaskId: agent.id });
  const revision = saveManualRevision({ store, project: PROJECT, actor: owner.id, key: "synthetic-manual-publication-save", sql: referenceSqlForContext(contextId), contextId, originAgentTaskId: agent.id }).revision;
  const sourceRun = store.create("run", PROJECT, { revisionId: revision.id, revisionHash: revision.hash, contextId, validationContractId: family.id,
    status: "SUCCEEDED", engine: "Apache Spark", engineVersion: "3.5.9", mainSqlExecuted: true, isolation: "FUNCTION_PROCESS", mode: "DURABLE_REMOTE_SUBMISSION",
    durationMs: 20, validation, rows: getContext(contextId).expected, log: "Synthetic stored source; no real Spark was run." });
  const complete = prepared => {
    const input = JSON.parse(prepared.job.body);
    objects.set(prepared.resultKey, JSON.stringify(createQueuedSparkResult(prepared.job, { status: "SUCCEEDED", engine: "Apache Spark", engineVersion: "3.5.9", mainSqlExecuted: true,
      rows: getContext(input.context.id).expected, validation, durationMs: 20, testSqlValidation: { passed: true, sqlHash: sha256(input.testSql) },
      log: "Synthetic signed queue receipt; no real Spark was run." }, queueConfig, now)));
  };
  const deliveryEngine = createDurableAgentDelivery({ store, project: PROJECT, runner: runner.durable, artifactStore, persist: async () => {} });
  const created = await deliveryEngine.createManual({ runId: sourceRun.id, actorId: owner.id, key: "synthetic-manual-publication-handoff" }),
    submitted = await deliveryEngine.advance(created.id, created.version),
    storedDelivery = store.get("agent_delivery_task", submitted.id, PROJECT);
  complete(storedDelivery.remoteSubmission.prepared);
  const delivery = await deliveryEngine.reconcile(submitted.id), item = store.get("delivery_package", delivery.packageId, PROJECT),
    verification = store.get("delivery_verification", delivery.verificationId, PROJECT);
  const queueBaseline = { jobCreates, submitCalls, resultReads, cancelCalls };
  const secret = "synthetic-manual-publication-timer-key-123456789", triggerName = "shuduo-release-manual-contract";
  const env = { V2_LOCAL_DEVELOPMENT: "false", V2_HOST: "127.0.0.1", V2_PROVISIONING_ONLY: "true", V2_PRIVATE_SMOKE_ENABLED: "true", V2_ALLOW_INSECURE_PUBLIC_COOKIES: "true",
    ...(enableServices ? {V2_PRIVATE_DATA_SERVICES_ENABLED: "true"} : {}),
    V2_PUBLIC_ORIGIN: "https://manual-publication.example.invalid", V2_DURABLE_SQL_AGENT_ENABLED: "true", V2_FC_PUBLIC_WRITE_SCOPE: "PUBLICATION_ONLY",
    V2_BOOTSTRAP_ADMIN_EMAIL: owner.email, V2_PUBLIC_PUBLICATION_TASK_ID: agent.id, V2_PUBLIC_PUBLICATION_PACKAGE_DIGEST: item.digest,
    V2_PUBLIC_PUBLICATION_VERIFICATION_ID: verification.id, V2_PUBLIC_PUBLICATION_STARTS_AT: new Date(now - 1000).toISOString(), V2_PUBLIC_PUBLICATION_EXPIRES_AT: new Date(now + 3600000).toISOString(),
    V2_PRIVATE_RELEASE_ENABLED: "true", V2_SCHEDULER_TICK_SECRET: secret, V2_PRIVATE_RELEASE_TRIGGER_NAMES: triggerName,
    // Three existing source/rehearsal records plus exactly two new batches.
    V2_MONTHLY_REMOTE_SPARK_RUN_LIMIT: "5" };
  const stateCoordinator = { refresh: async () => {}, flush: async () => {
    if (losePublishFlush && store.list("release", PROJECT).some(record => record.packageDigest === item.digest)) {
      losePublishFlush = false; throw Error("SYNTHETIC_PUBLICATION_FLUSH_ACK_LOST");
    }
  } };
  const close = async () => {
    if (app) { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); app = undefined; }
    if (store) { store.close(); store = undefined; }
  };
  const open = async () => {
    store ??= new MetadataStore(join(directory, "metadata.sqlite"));
    app = createV2Server({ root: applicationRoot ?? directory, store, artifactStore, runner, businessStore, stateCoordinator, env, now: () => now,
      ingress: createFcIngress({ publicHttpEnabled: true }), generator: async () => { modelCalls++; throw Error("SYNTHETIC_MODEL_FORBIDDEN"); } });
    await new Promise(resolve => app.server.listen(port, "127.0.0.1", resolve)); base = `http://127.0.0.1:${app.server.address().port}`;
  };
  const call = async (path, body, { identity = "owner", key = "synthetic-manual-reviewed-package", headers = {} } = {}) => {
    const response = await fetch(base + "/api/v2" + path, { method: body === undefined ? "GET" : "POST", signal: AbortSignal.timeout(5000),
      headers: { "content-type": "application/json", "x-shuduo-client": "workbench", origin: env.V2_PUBLIC_ORIGIN, "idempotency-key": key,
        ...(identity ? identities[identity] : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), cookies: response.headers.getSetCookie() };
  };
  const login = async identity => {
    const user = identity === "owner" ? owner : other;
    const response = await call("/auth/login", { email: user.email, password: manualPublicationTestPassword }, { identity: null });
    if (response.status !== 200) throw Error("SYNTHETIC_FIXTURE_LOGIN_FAILED");
    identities[identity] = { cookie: response.cookies.map(value => value.split(";")[0]).join("; "), "x-csrf-token": response.body.csrfToken };
    return response.body;
  };
  const tick = async (releaseId, sequence, extra = {}) => {
    const timestamp = String(now), nonce = `synthetic-manual-publication-event-${sequence}`,
      body = JSON.stringify({ releaseId, triggerName, expiresAt: now + 120000 }),
      payload = JSON.stringify({ operation: "PRIVATE_RELEASE_TIMER_V1", timestamp, nonce, body, signature: signSchedulerTick({ sharedSecret: secret, timestamp, nonce, body }) });
    const response = await fetch(base + "/invoke", { method: "POST", signal: AbortSignal.timeout(5000), headers: { "content-type": "application/octet-stream", "x-fc-control-path": "/invoke" },
      body: JSON.stringify({ triggerName, triggerTime: new Date(now).toISOString(), payload, ...extra }) });
    return { status: response.status, body: await response.json() };
  };
  try { await open(); await login("owner"); await login("other"); }
  catch (error) { await close(); rmSync(directory, { recursive: true, force: true }); throw error; }
  const selector = { sourceKind: "MANUAL", sourceRunId: sourceRun.id, packageDigest: item.digest, verificationId: verification.id }, path = `/agent/tasks/${agent.id}/publication`;
  return { directory, env, owner, other, agent, revision, sourceRun, delivery, item, verification, selector, path, call, tick, complete, login,
    query: "?" + new URLSearchParams(selector).toString(), body: { ...selector, attestations: { code: true, assertions: true, deliveryFiles: true, cloudScope: true } },
    restart: async () => { await close(); await open(); }, advance: () => { now += 60000; }, expire: () => { now = Date.parse(env.V2_PUBLIC_PUBLICATION_EXPIRES_AT); },
    failReceiptReads: value => { failReads = value; }, loseNextPublicationAcknowledgement: () => { losePublishFlush = true; },
    counts: () => ({ modelCalls, jobCreates: jobCreates - queueBaseline.jobCreates, submitCalls: submitCalls - queueBaseline.submitCalls,
      resultReads: resultReads - queueBaseline.resultReads, cancelCalls: cancelCalls - queueBaseline.cancelCalls }),
    get base() { return base; }, get store() { return store; },
    get manualUrl() { return `${base}/v2/?module=agent-center&revision=${revision.id}&run=${sourceRun.id}&origin_task=${agent.id}`; },
    dispose: async () => { await close(); rmSync(directory, { recursive: true, force: true }); },
  };
}
