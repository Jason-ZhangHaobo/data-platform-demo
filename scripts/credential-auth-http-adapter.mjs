// Fixed-origin phase-A HTTP adapter. Importing it has no effects; no CLI, logging,
// files, retries, arbitrary URLs, service creation or model/compute requests.
const origin = "https://shuduoai.cn";
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const digest = /^[a-f0-9]{64}$/;
const errorCodes = new Set(["INVALID_LOGIN", "CURRENT_PASSWORD_INVALID", "PASSWORD_UNCHANGED", "WEAK_PASSWORD", "AUTHENTICATION_REQUIRED", "CSRF_REQUIRED"]);
const fail = code => Object.assign(new Error(code), { code });
const check = (value, code) => { if (!value) throw fail(code); };
const keys = (value, allowed) => value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));
const permissionsValid = value => Array.isArray(value) && value.length === 1 && value[0] === "SESSION";

/**
 * beforeRequest receives only {sequence, operation, method, path}. It must durably
 * account for that exact request before resolving; failure prevents transport.
 * fetchImpl has the fetch contract and must not retry internally. All sessions
 * are private memory values for credential-account-rotation.mjs, never reports.
 * readRecovery uses the existing read-only snapshot route. Its bootId must be
 * compared across the same pinned XAPI together with independently verified FC
 * configuration; /status alone is not evidence of a new boot or DB connection.
 */
export function createCredentialAuthHttpAdapter({ email, projectId = "project-securities-lab", beforeRequest, fetchImpl = globalThis.fetch,
  timeoutMs = 15000, maxResponseBytes = 256 * 1024, now = Date.now, xapiId } = {}) {
  check(typeof email === "string" && email === email.toLowerCase() && email.length <= 160 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) &&
    projectId === "project-securities-lab" && typeof beforeRequest === "function" && typeof fetchImpl === "function" && typeof now === "function" &&
    Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 60000 && Number.isSafeInteger(maxResponseBytes) &&
    maxResponseBytes >= 1024 && maxResponseBytes <= 1024 * 1024 && (xapiId === undefined || uuid.test(xapiId)), "AUTH_HTTP_CONFIG_INVALID");
  let sessions = new WeakMap(), sequence = 0, disposed = false, selectedXapi = xapiId;
  const controllers = new Set();
  const validUser = user => user?.email === email && user.projectId === projectId && user.status === "ACTIVE" && uuid.test(user.id ?? "");
  const publicUser = user => ({ id: user.id, email: user.email, projectId: user.projectId, status: user.status });
  const credentials = session => {
    check(!disposed && session && typeof session === "object", "AUTH_HTTP_SESSION_INVALID");
    const privateValue = sessions.get(session);
    check(privateValue && privateValue.cookie === session.cookie && privateValue.csrfToken === session.csrfToken, "AUTH_HTTP_SESSION_INVALID");
    return privateValue;
  };
  const request = async (operation, method, path, { body, session } = {}) => {
    check(!disposed, "AUTH_HTTP_DISPOSED");
    const secret = session === undefined ? undefined : credentials(session);
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    check(serialized === undefined || Buffer.byteLength(serialized) <= 8192, "AUTH_HTTP_REQUEST_TOO_LARGE");
    try { await beforeRequest(Object.freeze({ sequence: ++sequence, operation, method, path })); }
    catch { throw fail("AUTH_HTTP_ACCOUNTING_FAILED"); }
    check(!disposed, "AUTH_HTTP_DISPOSED");
    const controller = new AbortController();
    controllers.add(controller);
    let timer, reader;
    const headers = { Accept: "application/json", "X-Project-Id": projectId, "X-Shuduo-Client": "cli",
      ...(method === "POST" ? { "Content-Type": "application/json", Origin: origin } : {}),
      ...(secret ? { Cookie: secret.cookie, ...(method === "POST" ? { "X-CSRF-Token": secret.csrfToken } : {}) } : {}) };
    const pending = (async () => {
      const response = await fetchImpl(origin + path, { method, headers, ...(serialized === undefined ? {} : { body: serialized }),
        redirect: "error", signal: controller.signal, credentials: "omit" });
      check(response && Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 && response.redirected !== true &&
        (!response.url || response.url === origin + path), "AUTH_HTTP_RESPONSE_INVALID");
      check(/^application\/(?:json|[a-z0-9.-]+\+json)(?:\s*;|$)/i.test(response.headers?.get("content-type") ?? ""), "AUTH_HTTP_RESPONSE_INVALID");
      const length = response.headers.get("content-length");
      check(length === null || /^\d+$/.test(length) && Number(length) <= maxResponseBytes, "AUTH_HTTP_RESPONSE_TOO_LARGE");
      check(response.body && typeof response.body.getReader === "function", "AUTH_HTTP_RESPONSE_INVALID");
      reader = response.body.getReader();
      const chunks = []; let bytes = 0;
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        check(part.value instanceof Uint8Array, "AUTH_HTTP_RESPONSE_INVALID");
        bytes += part.value.byteLength;
        check(bytes <= maxResponseBytes, "AUTH_HTTP_RESPONSE_TOO_LARGE");
        chunks.push(Buffer.from(part.value));
      }
      let value;
      try { value = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")); }
      catch { throw fail("AUTH_HTTP_RESPONSE_INVALID"); }
      return { status: response.status, headers: response.headers, value };
    })();
    try {
      const response = await Promise.race([pending, new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(fail("AUTH_HTTP_TIMEOUT")); }, timeoutMs);
      })]);
      check(!disposed, "AUTH_HTTP_DISPOSED");
      return response;
    } catch (error) {
      controller.abort();
      try { if (reader) void reader.cancel().catch(() => {}); } catch { /* Cancellation diagnostics never leave memory. */ }
      if (["AUTH_HTTP_RESPONSE_INVALID", "AUTH_HTTP_RESPONSE_TOO_LARGE", "AUTH_HTTP_TIMEOUT", "AUTH_HTTP_DISPOSED"].includes(error?.code)) throw fail(error.code);
      throw fail("AUTH_HTTP_RESPONSE_UNKNOWN");
    } finally { clearTimeout(timer); controllers.delete(controller); }
  };
  const cookieValues = headers => {
    check(typeof headers.getSetCookie === "function", "AUTH_HTTP_COOKIE_INVALID");
    let raw;
    try { raw = headers.getSetCookie(); } catch { throw fail("AUTH_HTTP_COOKIE_INVALID"); }
    const found = new Map();
    check(Array.isArray(raw) && raw.length <= 16, "AUTH_HTTP_COOKIE_INVALID");
    for (const line of raw) {
      check(typeof line === "string" && line.length <= 4096 && !/[\r\n\0]/.test(line), "AUTH_HTTP_COOKIE_INVALID");
      const parts = line.split(";").map(part => part.trim()), separator = parts[0].indexOf("="), name = parts[0].slice(0, separator);
      if (!["shuduo_session", "shuduo_csrf"].includes(name)) continue;
      check(!found.has(name), "AUTH_HTTP_COOKIE_INVALID");
      const value = parts[0].slice(separator + 1), attributes = new Map();
      for (const part of parts.slice(1)) {
        const split = part.indexOf("="), key = (split < 0 ? part : part.slice(0, split)).toLowerCase();
        check(!attributes.has(key), "AUTH_HTTP_COOKIE_INVALID");
        attributes.set(key, split < 0 ? "" : part.slice(split + 1));
      }
      // AuthManager emits 32 random bytes for sessions and 24 for CSRF:
      // unpadded base64url suffixes are exactly 43 and 32 characters.
      const tokenPattern = name === "shuduo_session" ? /^sess_[A-Za-z0-9_-]{43}$/ : /^csrf_[A-Za-z0-9_-]{32}$/;
      check(attributes.has("secure") && !attributes.has("domain") && attributes.get("samesite")?.toLowerCase() === "strict" &&
        attributes.get("path") === (name === "shuduo_session" ? "/api/v2" : "/") &&
        (name !== "shuduo_session" || attributes.has("httponly")) &&
        /^\d+$/.test(attributes.get("max-age") ?? "") && Number(attributes.get("max-age")) > 0 && Number(attributes.get("max-age")) <= 28800 &&
        tokenPattern.test(value), "AUTH_HTTP_COOKIE_INVALID");
      found.set(name, value);
    }
    check(found.size === 2, "AUTH_HTTP_COOKIE_INVALID");
    return { cookie: `shuduo_session=${found.get("shuduo_session")}; shuduo_csrf=${found.get("shuduo_csrf")}`, csrfToken: found.get("shuduo_csrf") };
  };
  const authenticationResult = response => {
    check(!disposed, "AUTH_HTTP_DISPOSED");
    if (response.status !== 200) return { status: response.status, ...(errorCodes.has(response.value?.code) ? { code: response.value.code } : {}) };
    const body = response.value;
    check(validUser(body?.user) && body.role === "ADMIN" && permissionsValid(body.permissions) && body.readOnly === true, "AUTH_HTTP_IDENTITY_INVALID");
    const secret = cookieValues(response.headers);
    check(body.csrfToken === secret.csrfToken, "AUTH_HTTP_COOKIE_INVALID");
    const session = Object.freeze({ user: Object.freeze(publicUser(body.user)), role: "ADMIN", permissions: Object.freeze(["SESSION"]), ...secret });
    sessions.set(session, { ...secret, userId: body.user.id });
    return { status: 200, session };
  };
  const requireSuccess = response => { check(response.status === 200, "AUTH_HTTP_STATUS_UNCONFIRMED"); return response.value; };
  const adapter = {
    async login(input) {
      check(keys(input, ["email", "password"]) && input.email === email && typeof input.password === "string" && input.password.length >= 1 && input.password.length <= 128,
        "AUTH_HTTP_INPUT_INVALID");
      return authenticationResult(await request("AUTH_LOGIN", "POST", "/api/v2/auth/login", { body: { email, password: input.password } }));
    },
    async changePassword(input) {
      check(keys(input, ["session", "currentPassword", "newPassword"]) && typeof input.currentPassword === "string" && input.currentPassword.length >= 1 &&
        input.currentPassword.length <= 128 && typeof input.newPassword === "string" && input.newPassword.length >= 12 && input.newPassword.length <= 128,
      "AUTH_HTTP_INPUT_INVALID");
      const prior = credentials(input.session);
      const result = authenticationResult(await request("AUTH_PASSWORD_CHANGE", "POST", "/api/v2/auth/password", {
        session: input.session, body: { currentPassword: input.currentPassword, newPassword: input.newPassword } }));
      check(!result.session || result.session.user.id === prior.userId, "AUTH_HTTP_IDENTITY_INVALID");
      return result;
    },
    async readSession(input = {}) {
      check(keys(input, ["session"]), "AUTH_HTTP_INPUT_INVALID");
      const prior = input.session === undefined ? undefined : credentials(input.session);
      const body = requireSuccess(await request("AUTH_SESSION_READ", "GET", "/api/v2/auth/session", input));
      check(body && typeof body.authenticated === "boolean", "AUTH_HTTP_RESPONSE_INVALID");
      if (!body.authenticated) return { authenticated: false, readOnly: body.readOnly === true };
      check(prior && validUser(body.user) && body.user.id === prior.userId && body.role === "ADMIN", "AUTH_HTTP_IDENTITY_INVALID");
      return { authenticated: true, readOnly: body.readOnly === true && permissionsValid(body.permissions), user: publicUser(body.user), role: body.role };
    },
    async readStatus(input = {}) {
      check(keys(input, ["session"]), "AUTH_HTTP_INPUT_INVALID");
      const body = requireSuccess(await request("STATUS_READ", "GET", "/api/v2/status", input));
      check(body?.projectId === projectId && body.mode === "PUBLIC_INVITATION", "AUTH_HTTP_STATUS_UNCONFIRMED");
      return { mode: body.mode, publicReady: body.publicReady === true,
        metadata: { driver: body.metadata?.driver === "mysql-project-snapshot-cas" ? "mysql-project-snapshot-cas" : "UNVERIFIED", cloudVerified: body.metadata?.cloudVerified === true },
        persistence: { mode: body.persistence?.mode === "single-instance-two-store-cas" ? "single-instance-two-store-cas" : "UNVERIFIED", healthy: body.persistence?.healthy === true },
        authentication: { mode: body.authentication?.mode === "INVITATION_SESSION" ? "INVITATION_SESSION" : "UNVERIFIED", publicSessionEnforced: body.authentication?.publicSessionEnforced === true } };
    },
    async selectExistingXapi({ session } = {}) {
      credentials(session);
      if (selectedXapi) return { serviceId: selectedXapi, serviceType: "XAPI" };
      const body = requireSuccess(await request("XAPI_LIST", "GET", "/api/v2/data-services/xapis", { session }));
      check(Array.isArray(body) && body.length <= 1000, "AUTH_HTTP_XAPI_LIST_INVALID");
      const eligible = body.filter(item => uuid.test(item?.id ?? "") && item.serviceType === "XAPI" && item.scope === "PRIVATE_CLOUD_TEST" &&
        item.projectId === projectId && uuid.test(item.publishedVersionId ?? "")).map(item => item.id).sort();
      check(eligible.length > 0, "AUTH_HTTP_EXISTING_XAPI_REQUIRED");
      selectedXapi ??= eligible[0];
      return { serviceId: selectedXapi, serviceType: "XAPI" };
    },
    async readRecovery({ session } = {}) {
      const { serviceId } = await adapter.selectExistingXapi({ session });
      const body = requireSuccess(await request("XAPI_RECOVERY_READ", "GET", `/api/v2/data-services/xapis/${serviceId}/recovery`, { session }));
      const checkedAt = Date.parse(body?.checkedAt), time = now();
      check(body?.protocol === "shuduo-private-service-recovery/v1" && body.scope === "PRIVATE_CLOUD_TEST" && body.publicDeployed === false &&
        body.state?.serviceId === serviceId && body.state.serviceType === "XAPI" && uuid.test(body.bootId ?? "") && digest.test(body.fingerprint ?? "") &&
        typeof body.healthy === "boolean" && Number.isFinite(checkedAt) && checkedAt <= time + 60000 && time - checkedAt <= 5 * 60000,
      "AUTH_HTTP_RECOVERY_INVALID");
      return { protocol: body.protocol, serviceId, bootId: body.bootId, checkedAt: body.checkedAt, healthy: body.healthy, fingerprint: body.fingerprint };
    },
    dispose() { disposed = true; for (const controller of controllers) controller.abort(); sessions = new WeakMap(); selectedXapi = undefined; },
  };
  return Object.freeze(adapter);
}
