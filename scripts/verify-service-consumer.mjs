#!/usr/bin/env node
// Independent HTTP consumer. Never creates services, credentials, resources or jobs.
// Usage: node scripts/verify-service-consumer.mjs --plan /private/plan.json
//   --token-file /private/token --phase consume --execute
// After the operator revokes the application, use the SAME plan/report/token with
// --phase revoked --execute. A failed/unknown request is never automatically retried.
// Both input files must be regular, owned, single-link 0600 files. Plan shape:
// {protocol:"SERVICE_CONSUMER_V1", authorized:true, origin, approvedOrigin,
//  testOnly:false, startedAt, deadline, timeoutMs:5000, maxRequests:40, reportFile,
//  expectedRows:[{client_id:"DEMO-001",holding_market_value:"12.00",
//    available_cash:"3.00",total_assets:"15.00",security_count:1}, ...],
//  dapis:[{id,slug,versionId,alias:"holdings",fields:["client_id",...],granted:true},
//         {id,slug,versionId,alias:"cash",fields:["client_id",...],granted:false}],
//  xapi:{id,slug,versionId}, ungranted:{type:"DAPI",slug},
//  rateLimit:{serviceId,perMinute:6}}
// expectedRows MUST come from an independently reviewed business expectation, never
// the service response. XAPI HTTP responses must expose exact immutable child
// version bindings as service.steps; missing bindings fail verification.
import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, existsSync, fstatSync, fsyncSync, openSync,
  readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import http from "node:http";
import https from "node:https";
import { isDeepStrictEqual } from "node:util";

const PROTOCOL = "SERVICE_CONSUMER_V1";
const FIELDS = ["client_id", "holding_market_value", "available_cash", "total_assets", "security_count"];
const PHASES = ["consume", "revoked"];
const STATES = ["NOT_STARTED", "RUNNING", "PASSED", "FAILED"];
class AcceptanceError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const fail = (code) => { throw new AcceptanceError(code); };
const requireThat = (condition, code) => { if (!condition) fail(code); };
const digest = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) => JSON.stringify(value && typeof value === "object"
  ? Array.isArray(value) ? value.map((v) => JSON.parse(canonical(v)))
    : Object.fromEntries(Object.keys(value).sort().map((k) => [k, JSON.parse(canonical(value[k]))])) : value);
const record = (value) => value && typeof value === "object" && !Array.isArray(value);
const identifier = (value) => typeof value === "string" && /^[a-zA-Z0-9_-]{3,100}$/.test(value);
const slug = (value) => typeof value === "string" && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value) && value.length <= 48;
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const safeCode = (error) => error instanceof AcceptanceError ? error.code : "LOCAL_IO_FAILED";

function readPrivate(file, maximum) {
  requireThat(typeof file === "string" && isAbsolute(file), "ABSOLUTE_FILE_REQUIRED");
  let descriptor;
  try {
    descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(descriptor);
    requireThat(info.isFile() && (info.mode & 0o777) === 0o600 && info.nlink === 1 &&
      (typeof process.getuid !== "function" || info.uid === process.getuid()), "PRIVATE_FILE_REQUIRED");
    requireThat(info.size > 0 && info.size <= maximum, "PRIVATE_FILE_SIZE_INVALID");
    return readFileSync(descriptor, "utf8");
  } catch (error) { fail(safeCode(error)); }
  finally { if (descriptor !== undefined) closeSync(descriptor); }
}
function readJson(file, maximum = 1_048_576) {
  const raw = readPrivate(file, maximum);
  try { return JSON.parse(raw); } catch { fail("INVALID_PRIVATE_JSON"); }
}
function syncDirectory(file) {
  const descriptor = openSync(dirname(file), constants.O_RDONLY);
  try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
}
function persist(file, value, initial = false) {
  const destination = initial ? file : `${file}.${randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(destination, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`);
    fsyncSync(descriptor);
    closeSync(descriptor); descriptor = undefined;
    if (!initial) renameSync(destination, file);
    syncDirectory(file);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (!initial && existsSync(destination)) unlinkSync(destination);
  }
}

export function validateConsumerPlan(plan) {
  requireThat(record(plan) && plan.protocol === PROTOCOL && typeof plan.authorized === "boolean", "INVALID_PLAN");
  let url;
  try { url = new URL(plan.origin); } catch { fail("INVALID_ORIGIN"); }
  requireThat(url.origin === plan.origin && plan.origin === plan.approvedOrigin && !url.username && !url.password &&
    ((url.protocol === "https:" && plan.testOnly === false) ||
      (url.protocol === "http:" && url.hostname === "127.0.0.1" && plan.testOnly === true)), "ORIGIN_NOT_APPROVED");
  const started = Date.parse(plan.startedAt), deadline = Date.parse(plan.deadline);
  requireThat(Number.isFinite(started) && Number.isFinite(deadline) && deadline > started && deadline - started <= 7_200_000,
    "INVALID_FIXED_WINDOW");
  requireThat(integer(plan.timeoutMs, 1, 10_000) && integer(plan.maxRequests, 1, 40), "INVALID_REQUEST_BOUNDS");
  requireThat(typeof plan.reportFile === "string" && isAbsolute(plan.reportFile), "ABSOLUTE_FILE_REQUIRED");
  requireThat(Array.isArray(plan.expectedRows) && integer(plan.expectedRows.length, 2, 100), "INDEPENDENT_ROWS_REQUIRED");
  for (const row of plan.expectedRows) {
    requireThat(record(row) && Object.keys(row).length === FIELDS.length && FIELDS.every((field) => Object.hasOwn(row, field)) &&
      /^[A-Z0-9][A-Z0-9-]{2,63}$/.test(row.client_id) && integer(row.security_count, 0, 1_000_000) &&
      FIELDS.slice(1, 4).every((field) => typeof row[field] === "string" && /^-?\d{1,20}\.\d{2}$/.test(row[field])), "INVALID_EXPECTED_ROWS");
  }
  requireThat(new Set(plan.expectedRows.map((row) => row.client_id)).size === plan.expectedRows.length, "DUPLICATE_EXPECTED_CLIENT");
  requireThat(Array.isArray(plan.dapis) && plan.dapis.length === 2 && record(plan.xapi), "EXACT_SERVICE_SET_REQUIRED");
  for (const service of [...plan.dapis, plan.xapi])
    requireThat(record(service) && identifier(service.id) && identifier(service.versionId) && slug(service.slug), "INVALID_SERVICE");
  for (const service of plan.dapis)
    requireThat(typeof service.granted === "boolean" && /^[a-z][a-z0-9_]{1,29}$/.test(service.alias) &&
      Array.isArray(service.fields) && service.fields.includes("client_id") && service.fields.length >= 2 &&
      service.fields.every((field) => FIELDS.includes(field)) && new Set(service.fields).size === service.fields.length, "INVALID_DAPI_PROJECTION");
  requireThat(new Set([...plan.dapis, plan.xapi].map((service) => service.id)).size === 3 &&
    new Set(plan.dapis.map((service) => service.alias)).size === 2 &&
    new Set(plan.dapis.map((service) => service.slug)).size === 2, "DUPLICATE_SERVICE");
  const granted = plan.dapis.filter((service) => service.granted);
  requireThat(granted.length >= 1 && record(plan.ungranted) && ["DAPI", "XAPI"].includes(plan.ungranted.type) &&
    slug(plan.ungranted.slug), "UNGRANTED_SERVICE_REQUIRED");
  requireThat(![...granted.map((s) => `DAPI:${s.slug}`), `XAPI:${plan.xapi.slug}`].includes(`${plan.ungranted.type}:${plan.ungranted.slug}`),
    "UNGRANTED_SERVICE_CONFLICT");
  if (granted.length === 1)
    requireThat(plan.ungranted.type === "DAPI" && plan.ungranted.slug === plan.dapis.find((s) => !s.granted).slug, "UNGRANTED_SERVICE_MISMATCH");
  const targets = [...granted.map((service) => ({ ...service, type: "DAPI" })), { ...plan.xapi, type: "XAPI" }];
  requireThat(record(plan.rateLimit) && targets.some((s) => s.id === plan.rateLimit.serviceId) &&
    integer(plan.rateLimit.perMinute, 3, 28), "INVALID_RATE_LIMIT_TEST");
  const plannedRequests = targets.length * 3 + plan.rateLimit.perMinute + 3;
  requireThat(plannedRequests <= plan.maxRequests, "INSUFFICIENT_REQUEST_BUDGET");
  return { targets, plannedRequests, started, deadline };
}

// No redirects, proxy configuration, cookies, arbitrary headers, POSTs or retries.
function requestOnce(url, token, timeoutMs) {
  return new Promise((resolveResponse, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request(url, { method: "GET", agent: false,
      headers: { Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) } }, (response) => {
      const chunks = []; let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > 524_288) request.destroy(new AcceptanceError("RESPONSE_TOO_LARGE"));
        else chunks.push(chunk);
      });
      response.on("error", () => { clearTimeout(timer); reject(new AcceptanceError("TRANSPORT_FAILED")); });
      response.on("end", () => {
        clearTimeout(timer);
        if (response.statusCode >= 300 && response.statusCode < 400) return reject(new AcceptanceError("REDIRECT_REFUSED"));
        resolveResponse({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") });
      });
    });
    const timer = setTimeout(() => request.destroy(new AcceptanceError("REQUEST_TIMEOUT")), timeoutMs);
    request.on("error", (error) => { clearTimeout(timer); reject(new AcceptanceError(error instanceof AcceptanceError ? error.code : "TRANSPORT_FAILED")); });
    request.end();
  });
}

function expectedResponse(plan, service, query) {
  const source = [...plan.expectedRows].sort((a, b) => a.client_id.localeCompare(b.client_id))
    .filter((row) => !query.client_id || row.client_id === query.client_id);
  const rows = source.slice((query.page - 1) * query.page_size, query.page * query.page_size);
  const projection = (row, fields) => Object.fromEntries(fields.map((field) => [field, row[field]]));
  return {
    data: service.type === "DAPI" ? rows.map((row) => projection(row, service.fields)) : rows.map((row) => ({
      client_id: row.client_id,
      ...Object.fromEntries(plan.dapis.map((child) => [child.alias, projection(row, child.fields.filter((field) => field !== "client_id"))])),
    })),
    pagination: { page: query.page, pageSize: query.page_size, total: source.length,
      totalPages: Math.max(1, Math.ceil(source.length / query.page_size)) },
  };
}
function verifySuccess(plan, service, query, response) {
  let body;
  try { body = JSON.parse(response.body); } catch { fail("INVALID_RESPONSE_JSON"); }
  requireThat(record(body) && record(body.service) && body.service.id === service.id &&
    body.service.type === service.type && body.service.slug === service.slug && body.service.versionId === service.versionId,
    "EXACT_VERSION_MISMATCH");
  const expected = expectedResponse(plan, service, query);
  requireThat(isDeepStrictEqual(body.data, expected.data), "BUSINESS_ROWS_MISMATCH");
  requireThat(isDeepStrictEqual(body.pagination, expected.pagination), "PAGINATION_MISMATCH");
  requireThat(identifier(body.callId), "CALL_EVIDENCE_MISSING");
  requireThat(body.scope === (plan.testOnly ? "LOCAL_TEST_ONLY" : "PRIVATE_CLOUD_TEST") && body.localTestOnly === plan.testOnly,
    "EVIDENCE_SCOPE_MISMATCH");
  let childBindingsVerified = false;
  if (service.type === "XAPI") {
    const expectedSteps = plan.dapis.map((child) => ({ alias: child.alias, dapiId: child.id, dapiVersionId: child.versionId }));
    requireThat(isDeepStrictEqual(body.service.steps, expectedSteps), "CHILD_VERSION_MISMATCH");
    childBindingsVerified = true;
  }
  return { responseDigest: digest(canonical({ data: body.data, pagination: body.pagination })),
    callIdDigest: digest(body.callId), childBindingsVerified };
}

function validateReport(report, planHash, credentialDigest, plan) {
  requireThat(record(report) && report.protocol === PROTOCOL && report.planDigest === planHash &&
    report.credentialDigest === credentialDigest && report.maxRequests === plan.maxRequests && report.deadline === plan.deadline &&
    integer(report.requestCount, 0, plan.maxRequests) && Array.isArray(report.requests) && report.requests.length === report.requestCount &&
    record(report.phases) && PHASES.every((phase) => STATES.includes(report.phases[phase])), "REPORT_BINDING_INVALID");
  requireThat(report.requests.every((entry, index) => record(entry) && entry.sequence === index + 1 && PHASES.includes(entry.phase) &&
    ["PENDING", "PASSED", "FAILED"].includes(entry.result)), "REPORT_COUNTER_INVALID");
}

export async function runConsumerAcceptance({ planFile, tokenFile, phase = "consume", execute = false }) {
  const plan = readJson(planFile), bounds = validateConsumerPlan(plan);
  requireThat(PHASES.includes(phase), "INVALID_PHASE");
  if (execute !== true) return { protocol: PROTOCOL, mode: "PLAN_ONLY", plannedRequests: bounds.plannedRequests,
    maxRequests: plan.maxRequests, requests: 0, evidence: "NOT_EXECUTED" };
  requireThat(plan.authorized === true, "EXPLICIT_AUTHORIZATION_REQUIRED");
  requireThat(Date.now() >= bounds.started && Date.now() < bounds.deadline, "OUTSIDE_FIXED_WINDOW");
  requireThat(plan.reportFile !== resolve(planFile) && plan.reportFile !== resolve(tokenFile), "REPORT_INPUT_COLLISION");
  const token = readPrivate(tokenFile, 200).trim();
  requireThat(/^sz_(?:private|local)_[A-Za-z0-9_-]{32}$/.test(token), "INVALID_TOKEN_FILE");
  const planHash = digest(canonical(plan)), credentialDigest = digest(token), lock = `${plan.reportFile}.lock`;
  let lockDescriptor, report, phaseStarted = false;
  try {
    try { lockDescriptor = openSync(lock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch { fail("REPORT_LOCKED_OR_UNAVAILABLE"); }
    if (existsSync(plan.reportFile)) {
      report = readJson(plan.reportFile);
      validateReport(report, planHash, credentialDigest, plan);
    } else {
      requireThat(phase === "consume", "PRIOR_CONSUMER_REPORT_REQUIRED");
      report = { protocol: PROTOCOL, planDigest: planHash, credentialDigest, maxRequests: plan.maxRequests,
        deadline: plan.deadline, evidence: plan.testOnly ? "LOCAL_HTTP_FIXTURE" : "HTTP_CONSUMER_ONLY",
        requestCount: 0, phases: { consume: "NOT_STARTED", revoked: "NOT_STARTED" }, requests: [] };
      persist(plan.reportFile, report, true);
    }
    requireThat(report.phases[phase] === "NOT_STARTED", "PHASE_ALREADY_ATTEMPTED");
    requireThat(phase !== "revoked" || report.requestCount > 0, "PRIOR_CONSUMER_REQUEST_REQUIRED");
    report.phases[phase] = "RUNNING";
    persist(plan.reportFile, report);
    phaseStarted = true;
    const firstSuccess = new Map();
    const call = async (service, query, auth, expectedStatus, check) => {
      requireThat(Date.now() < bounds.deadline, "FIXED_DEADLINE_REACHED");
      requireThat(report.requestCount < plan.maxRequests - (phase === "consume" ? 1 : 0), "REQUEST_BUDGET_EXHAUSTED");
      const entry = { sequence: ++report.requestCount, phase, check, startedAt: new Date().toISOString(), result: "PENDING" };
      report.requests.push(entry);
      // This reservation survives disconnects/crashes. Even a GET is not reissued.
      persist(plan.reportFile, report);
      try {
        const url = new URL(`/api/v2/open/${service.type === "DAPI" ? "dapis" : "xapis"}/${service.slug}`, plan.origin);
        for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
        requireThat(Date.now() < bounds.deadline, "FIXED_DEADLINE_REACHED");
        const response = await requestOnce(url, auth, Math.max(1, Math.min(plan.timeoutMs, bounds.deadline - Date.now())));
        entry.statusCode = response.status;
        requireThat(response.status === expectedStatus, "HTTP_STATUS_MISMATCH");
        if (expectedStatus === 200) {
          Object.assign(entry, verifySuccess(plan, service, query, response));
          if (!firstSuccess.has(service.id)) firstSuccess.set(service.id, Date.parse(entry.startedAt));
        }
        entry.result = "PASSED";
      } catch (error) { entry.result = "FAILED"; entry.failure = safeCode(error); throw error; }
      finally { persist(plan.reportFile, report); }
    };
    const standard = { page: 1, page_size: Math.ceil(plan.expectedRows.length / 2) };
    const first = bounds.targets[0];
    if (phase === "revoked") {
      await call(first, standard, token, 401, "REVOKED_TOKEN");
    } else {
      for (const [index, service] of bounds.targets.entries()) {
        await call(service, standard, token, 200, `SERVICE_${index + 1}_PAGE_1`);
        await call(service, { ...standard, page: 2 }, token, 200, `SERVICE_${index + 1}_PAGE_2`);
        await call(service, { ...standard, client_id: plan.expectedRows[0].client_id }, token, 200, `SERVICE_${index + 1}_FILTER`);
      }
      await call(first, standard, undefined, 401, "MISSING_TOKEN");
      await call(first, standard, "invalid-consumer-probe", 401, "INVALID_TOKEN");
      await call(plan.ungranted, standard, token, 403, "UNGRANTED_SERVICE");
      await call(first, { ...standard, page: 0 }, token, 400, "INVALID_PARAMETERS");
      const rateTarget = bounds.targets.find((service) => service.id === plan.rateLimit.serviceId);
      for (let used = 3; used <= plan.rateLimit.perMinute; used += 1) {
        requireThat(Date.now() - firstSuccess.get(rateTarget.id) + plan.timeoutMs < 60_000, "RATE_WINDOW_EXCEEDED");
        await call(rateTarget, standard, token, used === plan.rateLimit.perMinute ? 429 : 200,
          used === plan.rateLimit.perMinute ? "RATE_LIMIT_REJECTED" : "RATE_LIMIT_ALLOWED");
      }
    }
    report.phases[phase] = "PASSED";
    persist(plan.reportFile, report);
    return { protocol: PROTOCOL, phase, result: "PASSED", requestCount: report.requestCount,
      maxRequests: plan.maxRequests, phases: report.phases, evidence: report.evidence };
  } catch (error) {
    if (phaseStarted && report && report.phases[phase] === "RUNNING") {
      report.phases[phase] = "FAILED";
      try { persist(plan.reportFile, report); } catch { /* Durable pending reservations remain authoritative. */ }
    }
    throw new AcceptanceError(safeCode(error));
  } finally {
    if (lockDescriptor !== undefined) { closeSync(lockDescriptor); unlinkSync(lock); }
  }
}

async function main() {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 1) {
    const key = args[i];
    if (key === "--execute" && options.execute === undefined) options.execute = true;
    else if (["--plan", "--token-file", "--phase"].includes(key) && args[i + 1] && !args[i + 1].startsWith("--")) {
      const name = { "--plan": "planFile", "--token-file": "tokenFile", "--phase": "phase" }[key];
      requireThat(options[name] === undefined, "INVALID_CLI_ARGUMENTS"); options[name] = args[++i];
    } else fail("INVALID_CLI_ARGUMENTS");
  }
  const result = await runConsumerAcceptance(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch((error) => { process.stderr.write(`${JSON.stringify({ result: "FAILED", code: safeCode(error) })}\n`); process.exitCode = 1; });
