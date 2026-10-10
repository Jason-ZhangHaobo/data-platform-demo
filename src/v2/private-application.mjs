import { randomBytes, randomUUID } from "node:crypto";
import { createPasswordHash } from "./auth.mjs";
import { referenceSql } from "./context.mjs";

const fail = (status, code) => Object.assign(new Error(code), { status, code });
const paths = [
  /^\/api\/v2\/(status|budget|contexts|auth\/session|auth\/login|auth\/logout|revisions|runs)$/,
  /^\/api\/v2\/(runs|revisions)\/[a-f0-9-]{36}(?:\/cancel)?$/,
];
const headerNames = new Set(["cookie", "x-csrf-token", "idempotency-key", "x-project-id", "x-shuduo-client"]);
// Keep the model's bounded checkpoint inside the private function's 120s limit.
export const privateApplicationTimeoutMs = path => /^\/api\/v2\/agent\/tasks\/[a-f0-9-]{36}\/advance$/.test(path) ? 105000 : 30000;

export function validatePrivateApplicationRequest(input, { allowDurableAgent = false } = {}) {
  const agentPath = allowDurableAgent && (input?.method === "GET"
    ? /^\/api\/v2\/agent\/(?:tasks(?:\/[a-f0-9-]{36}(?:\/workflow)?)?|deliveries\/[a-f0-9-]{36})$/
    : /^\/api\/v2\/agent\/(?:tasks(?:\/[a-f0-9-]{36}\/(?:advance|cancel|prepare-delivery))?|deliveries\/[a-f0-9-]{36}\/(?:advance|cancel))$/).test(input?.path ?? "");
  if (!input || input.operation !== "PRIVATE_APPLICATION_HTTP_V1" ||
      Object.keys(input).some(k => !["operation", "method", "path", "headers", "body"].includes(k)) ||
      !["GET", "POST"].includes(input.method) || typeof input.path !== "string" ||
      !(paths.some(p => p.test(input.path)) || agentPath))
    throw fail(422, "PRIVATE_APPLICATION_REQUEST_INVALID");
  const headers = input.headers ?? {};
  if (typeof headers !== "object" || Array.isArray(headers) ||
      Object.entries(headers).some(([k, v]) => !headerNames.has(k) || typeof v !== "string" || v.length > 4096 || /[\r\n]/.test(v)))
    throw fail(422, "PRIVATE_APPLICATION_HEADERS_INVALID");
  if (input.method === "GET" && input.body !== undefined)
    throw fail(422, "PRIVATE_APPLICATION_REQUEST_INVALID");
  if (input.method === "POST" && (!input.body || typeof input.body !== "object" || Array.isArray(input.body)))
    throw fail(422, "PRIVATE_APPLICATION_REQUEST_INVALID");
  if (agentPath && input.method === "POST" && input.path === "/api/v2/agent/tasks" &&
      (input.body.language ?? "SPARK_SQL") !== "SPARK_SQL")
    throw fail(422, "PRIVATE_AGENT_LANGUAGE_NOT_ENABLED");
  return { ...input, headers };
}

export async function callPrivateApplication(input, base, fetchImpl = fetch, options = {}) {
  const request = validatePrivateApplicationRequest(input, options), url = new URL(base);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port)
    throw fail(500, "PRIVATE_APPLICATION_TARGET_INVALID");
  const response = await fetchImpl(base + request.path, {
    method: request.method,
    headers: { "content-type": "application/json", "x-shuduo-client": "cli", ...request.headers },
    ...(request.method === "POST" ? { body: JSON.stringify(request.body) } : {}),
    redirect: "error",
    signal: AbortSignal.timeout(privateApplicationTimeoutMs(request.path)),
  });
  const body = await response.json();
  return {
    protocol: "shuduo-private-application-http/v1", status: response.status,
    cookies: response.headers.getSetCookie(), body,
  };
}

// This fixture driver runs only inside the existing IAM-protected private
// invocation, with the same application authentication and task endpoints.
export async function verifyPrivateApplicationTask(input, { base, store, project, fetchImpl = fetch, deadlineMs = 150000 }) {
  if (input.operation !== "PRIVATE_APPLICATION_TASK_V1" || Object.keys(input).some(k => !["operation", "caseId", "submitOnly"].includes(k)) ||
      (input.submitOnly !== undefined && typeof input.submitOnly !== "boolean") ||
      !["holdings-t1", "cash-change"].includes(input.caseId))
    throw fail(422, "PRIVATE_APPLICATION_CASE_INVALID");
  const id = randomUUID(), password = "Synthetic!9" + randomBytes(24).toString("base64url"),
    email = `acceptance-${id}@example.invalid`,
    user = store.create("auth_user", project, {
      email, displayName: "私有任务验收工程师", passwordHash: createPasswordHash(password),
      status: "ACTIVE", memberships: [{ projectId: project, role: "ENGINEER" }], source: "PRIVATE_ACCEPTANCE",
    });
  let headers = {}, runId, submissionOnlyCompleted = false;
  const call = async (method, path, body, overrides = {}) =>
    callPrivateApplication({ operation: "PRIVATE_APPLICATION_HTTP_V1", method, path, headers: { ...headers, ...overrides }, ...(body === undefined ? {} : { body }) }, base, fetchImpl);
  const requireStatus = (result, status) => {
    if (result.status !== status) throw fail(502, result.body?.code ?? "PRIVATE_APPLICATION_API_FAILED");
    return result.body;
  };
  try {
    const login = await call("POST", "/api/v2/auth/login", { email, password });
    requireStatus(login, 200);
    headers = { cookie: login.cookies.map(c => c.split(";")[0]).join("; "), "x-csrf-token": login.body.csrfToken, "x-project-id": project, "x-shuduo-client": "cli" };
    const revision = requireStatus(await call("POST", "/api/v2/revisions", { contextId: input.caseId, sql: referenceSql }), 201);
    const key = `private-task-${id}`;
    const submittedAt = Date.now();
    const started = requireStatus(await call("POST", "/api/v2/runs", { revisionId: revision.id }, { "idempotency-key": key }), 202);
    const submissionElapsedMs = Date.now() - submittedAt;
    runId = started.id;
    const replay = requireStatus(await call("POST", "/api/v2/runs", { revisionId: revision.id }, { "idempotency-key": key }), 202);
    if (replay.id !== runId) throw fail(502, "PRIVATE_APPLICATION_DUPLICATE_RUN");
    if (input.submitOnly === true) {
      if (started.stage !== "WAITING_FOR_WORKER_RESULT")
        throw fail(502, "PRIVATE_APPLICATION_SUBMISSION_NOT_DURABLE");
      submissionOnlyCompleted = true;
      return {
      protocol: "shuduo-private-application-submission/v1", acceptanceId: id,
      caseId: input.caseId, revisionId: revision.id, revisionHash: revision.hash, runId,
      status: "SUBMITTED", applicationRunStatus: started.status, submissionElapsedMs,
      duplicateSubmissionDeduplicated: true, verificationPending: true,
      scope: "PRIVATE_APPLICATION_API", fullAgentLifecycleVerified: false, publicDeployed: false,
      };
    }
    const deadline = Date.now() + deadlineMs;
    let result;
    while (Date.now() < deadline) {
      result = requireStatus(await call("GET", `/api/v2/runs/${runId}`), 200);
      if (["SUCCEEDED", "FAILED", "VALIDATION_FAILED", "CANCELLED"].includes(result.status)) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (result?.status !== "SUCCEEDED" || result.engine !== "Apache Spark" || result.engineVersion !== "3.5.9" || result.mainSqlExecuted !== true || result.validation?.passed !== true || result.testDouble === true)
      throw fail(502, "PRIVATE_APPLICATION_RUN_NOT_VERIFIED");
    const expected = input.caseId === "cash-change" ? "2300.00" : "1800.00";
    if (String(result.rows?.find(r => r.client_id === "CLIENT-001")?.total_assets) !== expected)
      throw fail(502, "PRIVATE_APPLICATION_RESULT_MISMATCH");
    const restored = requireStatus(await call("GET", `/api/v2/runs/${runId}`), 200);
    if (JSON.stringify(restored.rows) !== JSON.stringify(result.rows) || restored.revisionHash !== revision.hash)
      throw fail(502, "PRIVATE_APPLICATION_REFRESH_MISMATCH");
    return {
      protocol: "shuduo-private-application-acceptance/v1", acceptanceId: id,
      caseId: input.caseId, revisionId: revision.id, runId, status: result.status,
      engine: result.engine, engineVersion: result.engineVersion, totalAssets: expected,
      assertionsPassed: true, duplicateSubmissionDeduplicated: true, refreshedResultMatches: true,
      rows: result.rows, revisionHash: revision.hash, validation: result.validation,
      scope: "PRIVATE_APPLICATION_API", fullAgentLifecycleVerified: false, publicDeployed: false,
    };
  } finally {
    if (runId && !submissionOnlyCompleted) {
      try {
        const r = await call("GET", `/api/v2/runs/${runId}`);
        if (!["SUCCEEDED", "FAILED", "VALIDATION_FAILED", "CANCELLED"].includes(r.body?.status))
          await call("POST", `/api/v2/runs/${runId}/cancel`, {});
      } catch {}
    }
    try { if (headers.cookie) await call("POST", "/api/v2/auth/logout", {}); } catch {}
    store.update("auth_user", user.id, project, { status: "DISABLED" });
    if (typeof store.flush === "function") await store.flush();
  }
}
