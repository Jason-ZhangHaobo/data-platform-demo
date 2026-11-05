import { createHash } from "node:crypto";

export class ConsumerSourceError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const requireThat = (condition, code) => { if (!condition) throw new ConsumerSourceError(code); };
const record = value => value && typeof value === "object" && !Array.isArray(value);
const exact = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const identifier = value => typeof value === "string" && /^[a-zA-Z0-9_-]{3,100}$/.test(value);
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const fields = ["client_id", "holding_market_value", "available_cash", "total_assets", "security_count"];
const sourceKeys = ["schema", "scope", "sourceKind", "taskId", "revisionId", "revisionHash", "developmentRunId", "contextId", "validationContractId", "packageDigest", "releaseId", "sourceReleaseRunId"];
export const consumerCanonical = value => JSON.stringify(value && typeof value === "object"
  ? Array.isArray(value) ? value.map(item => JSON.parse(consumerCanonical(item)))
    : Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(consumerCanonical(value[key]))])) : value);
export const consumerDigest = value => createHash("sha256").update(value).digest("hex");

// Pure schema validation. IDs and digests become evidence only after the caller
// cross-checks the frozen plan against authorized platform records.
export function validateConsumerSource(source) {
  requireThat(exact(source, sourceKeys) && source.schema === "shuduo-service-consumer-source/v1" &&
    ["LOCAL_TEST_ONLY", "PRIVATE_CLOUD_TEST"].includes(source.scope) && ["AGENT", "MANUAL"].includes(source.sourceKind) &&
    [source.taskId, source.revisionId, source.developmentRunId, source.contextId, source.validationContractId, source.releaseId, source.sourceReleaseRunId].every(identifier) &&
    hash(source.revisionHash) && hash(source.packageDigest) && source.sourceReleaseRunId !== source.developmentRunId, "INVALID_CONSUMER_SOURCE");
  return Object.fromEntries(sourceKeys.map(key => [key, source[key]]));
}
export const sourceDigest = source => consumerDigest(consumerCanonical(validateConsumerSource(source)));

// This safe projection complements the runner's original transport, deadline
// and request-budget validation. It never retains expected rows or file paths.
export function consumerV2PlanEvidence(plan) {
  const planKeys = ["protocol", "authorized", "origin", "approvedOrigin", "testOnly", "startedAt", "deadline", "timeoutMs", "maxRequests", "reportFile",
    "expectedRows", "dapis", "xapi", "ungranted", "rateLimit", "source"];
  requireThat(exact(plan, planKeys) && plan.protocol === "SERVICE_CONSUMER_V2" && typeof plan.testOnly === "boolean", "INVALID_CONSUMER_V2_PLAN");
  const source = validateConsumerSource(plan.source);
  requireThat(source.scope === (plan.testOnly ? "LOCAL_TEST_ONLY" : "PRIVATE_CLOUD_TEST"), "CONSUMER_SOURCE_SCOPE_MISMATCH");
  let origin;
  try { origin = new URL(plan.origin); } catch { throw new ConsumerSourceError("INVALID_ORIGIN"); }
  requireThat(origin.origin === plan.origin && plan.approvedOrigin === plan.origin && !origin.username && !origin.password &&
    (plan.testOnly ? origin.protocol === "http:" && origin.hostname === "127.0.0.1" : origin.protocol === "https:"), "ORIGIN_NOT_APPROVED");
  const safeTime = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
  requireThat(safeTime(plan.startedAt) && safeTime(plan.deadline), "INVALID_FIXED_WINDOW");
  requireThat(Array.isArray(plan.expectedRows) && plan.expectedRows.length >= 2 && plan.expectedRows.length <= 100 &&
    plan.expectedRows.every(row => exact(row, fields) && typeof row.client_id === "string" && /^[A-Z0-9][A-Z0-9-]{2,63}$/.test(row.client_id) &&
      Number.isSafeInteger(row.security_count) && row.security_count >= 0 && row.security_count <= 1_000_000 &&
      fields.slice(1,4).every(field => typeof row[field] === "string" && /^-?\d{1,20}\.\d{2}$/.test(row[field]))) &&
    new Set(plan.expectedRows.map(row => row.client_id)).size === plan.expectedRows.length, "INVALID_EXPECTED_ROWS");
  requireThat(Array.isArray(plan.dapis) && plan.dapis.length === 2 && exact(plan.xapi, ["id", "slug", "versionId", "configHash"]) &&
    plan.dapis.every(service => exact(service, ["id", "slug", "versionId", "configHash", "alias", "fields", "granted"])), "INVALID_CONSUMER_SERVICE_BINDING");
  const all = [...plan.dapis, plan.xapi];
  requireThat(all.every(service => identifier(service.id) && identifier(service.versionId) && hash(service.configHash) &&
    typeof service.slug === "string" && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(service.slug) && service.slug.length <= 48) &&
    new Set(all.map(service => service.id)).size === 3 && new Set(all.map(service => service.versionId)).size === 3 &&
    plan.dapis.every(service => typeof service.granted === "boolean" && typeof service.alias === "string" && /^[a-z][a-z0-9_]{1,29}$/.test(service.alias) &&
      Array.isArray(service.fields) && service.fields.length >= 2 && service.fields.length <= fields.length && service.fields.includes("client_id") &&
      service.fields.every(field => fields.includes(field)) && new Set(service.fields).size === service.fields.length) &&
    new Set(plan.dapis.map(service => service.alias)).size === 2 &&
    fields.every(field => plan.dapis.some(service => service.fields.includes(field))), "INVALID_CONSUMER_SERVICE_BINDING");
  requireThat((exact(plan.ungranted, ["type", "slug"]) || exact(plan.ungranted, ["type", "slug", "id", "versionId", "configHash"])) &&
    ["DAPI", "XAPI"].includes(plan.ungranted.type) && typeof plan.ungranted.slug === "string" &&
    /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(plan.ungranted.slug) && plan.ungranted.slug.length <= 48 &&
    exact(plan.rateLimit, ["serviceId", "perMinute"]), "INVALID_CONSUMER_V2_PLAN");
  const knownUngrant = plan.ungranted.type === "DAPI" ? plan.dapis.find(service => service.slug === plan.ungranted.slug)
    : plan.xapi.slug === plan.ungranted.slug ? plan.xapi : undefined;
  if (knownUngrant && Object.hasOwn(plan.ungranted, "id")) requireThat(["id", "versionId", "configHash"].every(key => knownUngrant[key] === plan.ungranted[key]), "INVALID_CONSUMER_SERVICE_BINDING");
  const ungranted = knownUngrant ?? plan.ungranted;
  requireThat(identifier(ungranted.id) && identifier(ungranted.versionId) && hash(ungranted.configHash), "INVALID_CONSUMER_SERVICE_BINDING");
  if (!knownUngrant) requireThat(all.every(service => service.id !== ungranted.id && service.versionId !== ungranted.versionId), "INVALID_CONSUMER_SERVICE_BINDING");
  return {
    source, sourceDigest: sourceDigest(source), expectedRowsDigest: consumerDigest(consumerCanonical(plan.expectedRows)),
    services: [...plan.dapis.map(service => ({ id: service.id, type: "DAPI", versionId: service.versionId, configHash: service.configHash,
      alias: service.alias, fields: [...service.fields] })), { id: plan.xapi.id, type: "XAPI", versionId: plan.xapi.versionId, configHash: plan.xapi.configHash }],
    ungrantedService: { id: ungranted.id, type: plan.ungranted.type, versionId: ungranted.versionId, configHash: ungranted.configHash },
    origin: plan.origin, scope: source.scope, ...(source.sourceKind === "MANUAL" ? { sourceAttribution: "ENGINEER_ASSISTED" } : {}),
    agentIndependentE2E: false, externalSystemVerified: false, publicDeployed: false,
  };
}
