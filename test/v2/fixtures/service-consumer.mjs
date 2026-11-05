import {createServer} from "node:http";
import {once} from "node:events";
import {chmodSync,mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {runConsumerAcceptance} from "../../../scripts/verify-service-consumer.mjs";
import {consumerDigest} from "../../../src/v2/consumer-source.mjs";

// Public synthetic HTTP fixture. Its response rows and plan oracle are separate
// literals. No cloud, model, Spark, real user or credential is involved.
export const SYNTHETIC_CONSUMER_TOKEN = `sz_local_${"L".repeat(32)}`;
const TOKEN=SYNTHETIC_CONSUMER_TOKEN;
export const privateConsumerJson=(file,value)=>{writeFileSync(file,`${JSON.stringify(value)}\n`,{mode:0o600});chmodSync(file,0o600);};
const privateJson=privateConsumerJson;

export async function createConsumerFixture(t, behavior = {}) {
  const root = mkdtempSync(join(tmpdir(), "service-consumer-fixture-"));
  const state = { requests: [], allowed: new Map(), revoked: false };
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1"), path = url.pathname;
    state.requests.push({ method: request.method, path, query: url.search });
    if (behavior.onRequest) behavior.onRequest(state, request);
    const reply = (status, body) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(body)); };
    if (behavior.redirect) { response.writeHead(302, { Location: behavior.redirect }); response.end(); return; }
    if (behavior.disconnect) { request.socket.destroy(); return; }
    if (behavior.hang) return;
    if (state.revoked || request.headers.authorization !== `Bearer ${TOKEN}`) return reply(401, { error: "TOKEN_INVALID" });
    if (path.endsWith("/other-demo") || path.endsWith("/cash-demo") && !behavior.twoGranted) return reply(403, { error: "SERVICE_FORBIDDEN" });
    const page = Number(url.searchParams.get("page")), pageSize = Number(url.searchParams.get("page_size"));
    if (!Number.isSafeInteger(page) || page < 1) return reply(400, { error: "INVALID_INTEGER" });
    const count = state.allowed.get(path) ?? 0;
    if (count >= 6) return reply(429, { error: "RATE_LIMITED" });
    state.allowed.set(path, count + 1);
    const isXapi = path.endsWith("/overview-demo"), isCash = path.endsWith("/cash-demo");
    let source = [
      { client_id: "DEMO-101", holding_market_value: "120.00", available_cash: "30.00", total_assets: "150.00", security_count: 2 },
      { client_id: "DEMO-102", holding_market_value: "230.00", available_cash: "40.00", total_assets: "270.00", security_count: 1 },
    ];
    if (url.searchParams.has("client_id")) source = source.filter((row) => row.client_id === url.searchParams.get("client_id"));
    const data = source.slice((page - 1) * pageSize, page * pageSize).map((row) => isXapi ? {
      client_id: row.client_id,
      holdings: { holding_market_value: row.holding_market_value, total_assets: row.total_assets, security_count: row.security_count },
      cash: { available_cash: row.available_cash },
    } : isCash ? { client_id: row.client_id, available_cash: row.available_cash }
      : { client_id: row.client_id, holding_market_value: row.holding_market_value, total_assets: row.total_assets, security_count: row.security_count });
    const body = {
      data, pagination: { page, pageSize, total: source.length, totalPages: Math.max(1, Math.ceil(source.length / pageSize)) },
      service: isXapi ? { id: "service-overview", slug: "overview-demo", type: "XAPI", versionId: "version-overview-1", steps: [
        { alias: "holdings", dapiId: "service-holdings", dapiVersionId: "version-holdings-1" },
        { alias: "cash", dapiId: "service-cash", dapiVersionId: "version-cash-1" },
      ] } : isCash ? { id: "service-cash", slug: "cash-demo", type: "DAPI", versionId: "version-cash-1" }
        : { id: "service-holdings", slug: "holdings-demo", type: "DAPI", versionId: "version-holdings-1" },
      callId: `fixture-call-${state.requests.length}`, localTestOnly: true, scope: "LOCAL_TEST_ONLY",
    };
    behavior.mutate?.(body, { isXapi, isCash, page, query: url.searchParams });
    reply(200, body);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const plan = {
    protocol: "SERVICE_CONSUMER_V1", authorized: true, origin, approvedOrigin: origin, testOnly: true,
    startedAt: new Date(Date.now() - 1000).toISOString(), deadline: new Date(Date.now() + 300_000).toISOString(),
    timeoutMs: 2000, maxRequests: behavior.twoGranted ? 18 : 15, reportFile: join(root, "report.json"),
    expectedRows: [
      { client_id: "DEMO-102", holding_market_value: "230.00", available_cash: "40.00", total_assets: "270.00", security_count: 1 },
      { client_id: "DEMO-101", holding_market_value: "120.00", available_cash: "30.00", total_assets: "150.00", security_count: 2 },
    ],
    dapis: [
      { id: "service-holdings", slug: "holdings-demo", versionId: "version-holdings-1", alias: "holdings",
        fields: ["client_id", "holding_market_value", "total_assets", "security_count"], granted: true },
      { id: "service-cash", slug: "cash-demo", versionId: "version-cash-1", alias: "cash",
        fields: ["client_id", "available_cash"], granted: Boolean(behavior.twoGranted) },
    ],
    xapi: { id: "service-overview", slug: "overview-demo", versionId: "version-overview-1" },
    ungranted: { type: "DAPI", slug: behavior.twoGranted ? "other-demo" : "cash-demo" }, rateLimit: { serviceId: "service-holdings", perMinute: 6 },
  };
  const planFile = join(root, "plan.json"), tokenFile = join(root, "token");
  privateJson(planFile, plan); writeFileSync(tokenFile, TOKEN, { mode: 0o600 });
  t.after(async () => { server.closeAllConnections(); await new Promise((done) => server.close(done)); rmSync(root, { recursive: true, force: true }); });
  return { root, plan, planFile, tokenFile, state,
    save: () => privateJson(planFile, plan),
    run: (options = {}) => runConsumerAcceptance({ planFile, tokenFile, execute: true, ...options }),
  };
}
export function configureConsumerV2Fixture(fixture, { sourceKind = "AGENT" } = {}) {
  const plan = fixture.plan;
  plan.protocol = "SERVICE_CONSUMER_V2";
  plan.source = { schema: "shuduo-service-consumer-source/v1", scope: plan.testOnly ? "LOCAL_TEST_ONLY" : "PRIVATE_CLOUD_TEST", sourceKind,
    taskId: "task-synthetic-001", revisionId: "revision-synthetic-001", revisionHash: consumerDigest("synthetic-reviewed-sql"), developmentRunId: "development-synthetic-001",
    contextId: "holdings-t1", validationContractId: "securities-five-fixtures-v1", packageDigest: consumerDigest("synthetic-reviewed-package"),
    releaseId: "release-synthetic-001", sourceReleaseRunId: "release-run-synthetic-001" };
  for (const service of [...plan.dapis, plan.xapi]) service.configHash = consumerDigest("synthetic-config-" + service.id);
  if (plan.ungranted.slug === "other-demo") Object.assign(plan.ungranted, { id: "service-other", versionId: "version-other-1", configHash: consumerDigest("synthetic-config-service-other") });
  fixture.save(); return fixture;
}
