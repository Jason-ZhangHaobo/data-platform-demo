import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { join, resolve, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { MetadataStore } from "./store.mjs";
import {
  getContext,
  publicContext,
  contextIds,
  referenceSql,
  validationContractId,
} from "./context.mjs";
import { runSpark, runtimeConfig } from "./spark.mjs";
import {
  generateSql,
  generateDataServicePlan,
  generateIngestionPlan,
  generateRealtimePlan,
  generateAssetInsight,
  generateQualityPlan,
  generateSecurityPlan,
  generateReportPlan,
  generateOpsDiagnosis,
  modelSettings,
  ModelUnavailable,
} from "./model.mjs";
import { capabilities } from "./capabilities.mjs";
import { saveLocalModelKey } from "./model-credentials.mjs";
import {
  createDeliveryPackage,
  validateDeliveryPackage,
  resolveDeliverySchedule,
  unpackDeliveryPackage,
} from "./delivery.mjs";
import { verifyDeliveryDirectory } from "./delivery-runner.mjs";
import {
  LocalReleaseScheduler,
  localScheduleSpec,
  plannedLocalRuns,
  publicRelease,
} from "./release-scheduler.mjs";
import {
  BusinessQueryStore,
  DataServiceManager,
} from "./data-services.mjs";
import {
  IngestionManager,
  LandingStore,
} from "./ingestion.mjs";
import {
  RealtimeManager,
  StreamStateStore,
} from "./realtime.mjs";
import { AssetCatalogManager } from "./assets.mjs";
import { QualityManager } from "./quality.mjs";
import { SecurityManager } from "./security.mjs";
import { ReportDataStore, ReportManager } from "./reports.mjs";
import { OperationsManager } from "./operations.mjs";
import { AuthManager } from "./auth.mjs";

export const PROJECT = "project-securities-lab";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const fail = (status, message) => Object.assign(new Error(message), { status });
const text = (value, min = 1, max = 20000) => {
  if (
    typeof value !== "string" ||
    value.trim().length < min ||
    value.length > max
  )
    throw fail(400, "提交内容长度不符合要求");
  return value.trim();
};
const json = async (res, status, data, headers = {}) => {
  let responseStatus = status,
    responseData = data,
    responseHeaders = headers;
  try {
    await res.metadataFlush?.();
  } catch (error) {
    responseStatus = error.status ?? 503;
    responseData = {
      message: error.status
        ? error.message
        : "云端元数据保存失败，请刷新确认后重试",
      ...(typeof error.code === "string" ? { code: error.code } : {}),
    };
    // Never issue a login/session cookie when the session itself did not reach
    // durable storage.
    responseHeaders = {};
  }
  res.writeHead(responseStatus, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...responseHeaders,
  });
  res.end(JSON.stringify(responseData));
};
const terminal = new Set([
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "VALIDATION_FAILED",
  "INTERRUPTED",
]);
export function createV2Server(options = {}) {
  const env = options.env ?? process.env,
    root = options.root ?? process.cwd();
  const store =
    options.store ?? new MetadataStore(join(root, ".data/v2-platform.sqlite"));
  const ownsBusinessStore = !options.businessStore,
    businessStore =
      options.businessStore ??
      new BusinessQueryStore(
        options.store ? ":memory:" : join(root, ".data/v2-business-services.sqlite"),
      );
  const ownsLandingStore = !options.landingStore,
    landingStore =
      options.landingStore ??
      new LandingStore(
        options.store ? ":memory:" : join(root, ".data/v2-landing.sqlite"),
      );
  const ownsStreamStateStore = !options.streamStateStore,
    streamStateStore =
      options.streamStateStore ??
      new StreamStateStore(
        options.store ? ":memory:" : join(root, ".data/v2-stream-state.sqlite"),
      );
  const ownsReportStore = !options.reportStore,
    reportStore =
      options.reportStore ??
      new ReportDataStore(
        options.store ? ":memory:" : join(root, ".data/v2-reports.sqlite"),
      );
  const persistence = options.stateCoordinator ?? store;
  const host = env.V2_HOST ?? "127.0.0.1",
    local = env.V2_LOCAL_DEVELOPMENT !== "false",
    insecurePublicCookies =
      env.V2_ALLOW_INSECURE_PUBLIC_COOKIES === "true";
  if (local && !["127.0.0.1", "localhost", "::1"].includes(host))
    throw new Error("本地开发会话只能绑定回环地址");
  if (
    !local &&
    insecurePublicCookies &&
    !["127.0.0.1", "localhost", "::1"].includes(host)
  )
    throw new Error("非安全公网Cookie仅允许回环地址测试");
  if (
    env.V2_META_DRIVER &&
    !["sqlite", "mysql-project-snapshot-cas"].includes(env.V2_META_DRIVER)
  )
    throw new Error("平台元数据库驱动不受支持");
  if (
    env.V2_META_DRIVER === "mysql-project-snapshot-cas" &&
    typeof store.replicationStatus !== "function"
  )
    throw new Error("已要求云端MySQL元数据库，但当前存储没有复制能力");
  const auth = new AuthManager({
    store,
    project: PROJECT,
    now: options.now,
    env,
  });
  const runtime = runtimeConfig(env, root),
    runner = options.runner ?? ((input) => runSpark(input, runtime));
  let modelVerifiedAt = null;
  const generator =
    options.generator ??
    (async (input) => {
      const keyAtRequest = env.DASHSCOPE_API_KEY;
      const result = await generateSql(input, env);
      if (keyAtRequest === env.DASHSCOPE_API_KEY)
        modelVerifiedAt = new Date().toISOString();
      return result;
    });
  const controls = new Map();
  let queue = Promise.resolve();
  store.interruptPending(PROJECT);
  const get = (kind, id) => {
    const item = store.get(kind, id, PROJECT);
    if (!item) throw fail(404, "未找到当前项目的记录");
    return item;
  };
  const releaseTimeUnitMs = Number(options.releaseTimeUnitMs ?? 1000);
  if (!Number.isSafeInteger(releaseTimeUnitMs) || releaseTimeUnitMs < 1)
    throw new Error("本机发布调度时间单位不合法");
  const releaseRunner =
    options.releaseRunner ??
    ((input) => verifyDeliveryDirectory(input, { runtime }));
  const releaseScheduler = new LocalReleaseScheduler({
    store,
    project: PROJECT,
    packageFor: (id) => store.get("delivery_package", id, PROJECT),
    runPackage: releaseRunner,
    now: options.now,
    setTimer: options.setTimer,
    clearTimer: options.clearTimer,
  });
  releaseScheduler.start();
  const expose = (item) => publicRelease(item, root);
  const dataServices = new DataServiceManager({
    store,
    businessStore,
    project: PROJECT,
    releaseRunFor: (id) => store.get("release_run", id, PROJECT),
    now: options.now,
    executeDapi: options.dataServiceExecutor,
  });
  const servicePlanner =
    options.servicePlanner ??
    (async (input) => {
      const keyAtRequest = env.DASHSCOPE_API_KEY,
        result = await generateDataServicePlan(input, env);
      if (keyAtRequest === env.DASHSCOPE_API_KEY)
        modelVerifiedAt = new Date().toISOString();
      return result;
    });
  const ingestion = new IngestionManager({
    store,
    landingStore,
    project: PROJECT,
    fixtureRoot:
      options.fixtureRoot ?? join(process.cwd(), "fixtures", "sources"),
    now: options.now,
  });
  const ingestionPlanner =
    options.ingestionPlanner ??
    (async (input) => {
      const keyAtRequest = env.DASHSCOPE_API_KEY,
        result = await generateIngestionPlan(input, env);
      if (keyAtRequest === env.DASHSCOPE_API_KEY)
        modelVerifiedAt = new Date().toISOString();
      return result;
    });
  const realtime = new RealtimeManager({
    store,
    stateStore: streamStateStore,
    project: PROJECT,
    fixtureRoot:
      options.streamFixtureRoot ?? join(process.cwd(), "fixtures", "streams"),
    now: options.now,
    eventDelayMs: options.realtimeEventDelayMs ?? 40,
  });
  const realtimePlanner =
    options.realtimePlanner ??
    (async (input) => {
      const keyAtRequest = env.DASHSCOPE_API_KEY,
        result = await generateRealtimePlan(input, env);
      if (keyAtRequest === env.DASHSCOPE_API_KEY)
        modelVerifiedAt = new Date().toISOString();
      return result;
    });
  const assets = new AssetCatalogManager({
    store,
    landingStore,
    stateStore: streamStateStore,
    dataServices,
    project: PROJECT,
    now: options.now,
  });
  const assetPlanner =
    options.assetPlanner ??
    (async (input) => {
      const keyAtRequest = env.DASHSCOPE_API_KEY,
        result = await generateAssetInsight(input, env);
      if (keyAtRequest === env.DASHSCOPE_API_KEY)
        modelVerifiedAt = new Date().toISOString();
      return result;
    });
  const quality = new QualityManager({
    store,
    assets,
    project: PROJECT,
    now: options.now,
  });
  const qualityPlanner =
    options.qualityPlanner ??
    (async (input) => {
      const keyAtRequest = env.DASHSCOPE_API_KEY,
        result = await generateQualityPlan(input, env);
      if (keyAtRequest === env.DASHSCOPE_API_KEY)
        modelVerifiedAt = new Date().toISOString();
      return result;
    });
  const security = new SecurityManager({
    store,
    assets,
    project: PROJECT,
    now: options.now,
  });
  const securityPlanner =
    options.securityPlanner ??
    (async (input) => {
      const keyAtRequest = env.DASHSCOPE_API_KEY,
        result = await generateSecurityPlan(input, env);
      if (keyAtRequest === env.DASHSCOPE_API_KEY)
        modelVerifiedAt = new Date().toISOString();
      return result;
    });
  const reports = new ReportManager({
    store,
    reportStore,
    assets,
    project: PROJECT,
    now: options.now,
  });
  const reportPlanner =
    options.reportPlanner ??
    (async (input) => {
      const keyAtRequest = env.DASHSCOPE_API_KEY,
        result = await generateReportPlan(input, env);
      if (keyAtRequest === env.DASHSCOPE_API_KEY)
        modelVerifiedAt = new Date().toISOString();
      return result;
    });
  const operations = new OperationsManager({
    store,
    project: PROJECT,
    now: options.now,
  });
  const opsPlanner =
    options.opsPlanner ??
    (async (input) => {
      const keyAtRequest = env.DASHSCOPE_API_KEY,
        result = await generateOpsDiagnosis(input, env);
      if (keyAtRequest === env.DASHSCOPE_API_KEY)
        modelVerifiedAt = new Date().toISOString();
      return result;
    });
  const revision = (sql, contextId, source) =>
    store.create("revision", PROJECT, {
      sql,
      contextId,
      source,
      hash: hash(sql),
      author: "local-engineer",
    });
  const schedule = (kind, item, work) => {
    const controller = new AbortController();
    controls.set(item.id, controller);
    queue = queue
      .then(async () => {
        if (get(kind, item.id).status === "CANCELLED") {
          controls.delete(item.id);
          return;
        }
        store.update(kind, item.id, PROJECT, {
          status: "RUNNING",
          startedAt: new Date().toISOString(),
        });
        try {
          await work(controller.signal);
        } catch (error) {
          const current = get(kind, item.id);
          if (current.status !== "CANCELLED")
            store.update(kind, item.id, PROJECT, {
              status: controller.signal.aborted ? "CANCELLED" : "FAILED",
              error: error.message,
              finishedAt: new Date().toISOString(),
            });
        } finally {
          controls.delete(item.id);
        }
      })
      .catch(() => {
        controls.delete(item.id);
      });
  };
  const execute = async (run, rev, signal) => {
    const output = await runner({
      sql: rev.sql,
      context: getContext(rev.contextId),
      validationContexts: contextIds.map(getContext),
      signal,
      timeoutMs: Number(env.V2_RUN_TIMEOUT_MS ?? 90000),
    });
    const { directory, ...result } = output;
    if (!["SUCCEEDED", "FAILED", "VALIDATION_FAILED"].includes(result.status))
      throw new Error("执行器返回了无效状态");
    if (result.status === "SUCCEEDED" && !result.validation?.passed)
      throw new Error("缺少独立断言，不能标记成功");
    if (!options.runner && result.status === "SUCCEEDED") {
      const checks = result.validation?.regressions ?? [];
      if (
        checks.length !== contextIds.length ||
        !contextIds.every((id) =>
          checks.some((c) => c.contextId === id && c.passed),
        )
      )
        throw new Error("缺少完整回归场景证据，不能标记成功");
    }
    if (result.validation)
      result.validation = {
        ...result.validation,
        contractId: validationContractId,
      };
    if (signal.aborted)
      return store.update("run", run.id, PROJECT, {
        status: "CANCELLED",
        finishedAt: new Date().toISOString(),
      });
    if (get("run", run.id).status === "CANCELLED") return get("run", run.id);
    return store.update("run", run.id, PROJECT, {
      ...result,
      finishedAt: new Date().toISOString(),
    });
  };
  const readBody = async (req) => {
    if (!String(req.headers["content-type"]).startsWith("application/json"))
      throw fail(415, "使用 JSON 提交");
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (Buffer.byteLength(body) > 100000) throw fail(413, "请求内容过大");
    }
    let parsed;
    try {
      parsed = JSON.parse(body || "{}");
    } catch {
      throw fail(400, "JSON 格式不合法");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw fail(400, "请求必须是 JSON 对象");
    return parsed;
  };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost"),
        path = url.pathname,
        method = req.method;
      if (typeof persistence.refresh === "function") await persistence.refresh();
      if (method !== "GET" && typeof persistence.flush === "function")
        res.metadataFlush = () => persistence.flush();
      const origin = req.headers.origin;
      if (
        origin &&
        !(
          (local &&
            /^http:\/\/(localhost|127\.0\.0\.1):(3100|5173)$/.test(origin)) ||
          (!local &&
            typeof env.V2_PUBLIC_ORIGIN === "string" &&
            origin === env.V2_PUBLIC_ORIGIN)
        )
      )
        throw fail(403, "请求来源不允许");
      if (
        req.headers["x-project-id"] &&
        req.headers["x-project-id"] !== PROJECT
      )
        throw fail(403, "无权访问此项目");
      if (method !== "GET") {
        if (
          !["workbench", "cli", "mcp"].includes(
            req.headers["x-shuzhan-client"],
          )
        )
          throw fail(403, "缺少客户端校验");
        if (local) {
          const hostname = new URL("http://" + req.headers.host).hostname;
          if (!["127.0.0.1", "localhost", "[::1]"].includes(hostname))
            throw fail(403, "本地开发写入只能使用回环地址");
        } else if (
          ![
            "/api/v2/auth/login",
            "/api/v2/auth/redeem",
          ].includes(path)
        )
          auth.requireMutation(req.headers, path);
      }
      if (path === "/api/v2/auth/session" && method === "GET") {
        const context = auth.sessionFromHeaders(req.headers);
        return json(
          res,
          200,
          context
            ? {
                authenticated: true,
                user: context.user,
                role: context.role,
                permissions: context.permissions,
                expiresAt: context.session.expiresAt,
              }
            : {
                authenticated: false,
                mode: local
                  ? "LOCAL_DEVELOPMENT_BYPASS"
                  : "INVITATION_SESSION",
              },
        );
      }
      if (
        ["/api/v2/auth/login", "/api/v2/auth/redeem"].includes(path) &&
        method === "POST"
      ) {
        const body = await readBody(req),
          attemptKey = `${req.socket.remoteAddress ?? "unknown"}:${path}`,
          result =
            path.endsWith("/login")
              ? auth.login(body, { attemptKey })
              : auth.redeemInvitation(body, { attemptKey }),
          response = auth.sessionResponse(
            result,
            !local && !insecurePublicCookies,
          );
        return json(res, 200, response.body, {
          "Set-Cookie": response.cookies,
        });
      }
      if (path === "/api/v2/auth/logout" && method === "POST") {
        await readBody(req);
        return json(res, 200, auth.logout(req.headers), {
          "Set-Cookie": auth.clearCookie(
            !local && !insecurePublicCookies,
          ),
        });
      }
      if (path === "/api/v2/auth/invitations" && method === "GET") {
        const actor = auth.sessionFromHeaders(req.headers);
        if (!actor) throw fail(401, "请先登录受邀账号");
        return json(res, 200, auth.listInvitations(actor));
      }
      if (path === "/api/v2/auth/invitations" && method === "POST") {
        const actor = auth.sessionFromHeaders(req.headers);
        if (!actor) throw fail(401, "请先登录受邀账号");
        return json(
          res,
          201,
          auth.createInvitation(actor, await readBody(req)),
        );
      }
      if (path === "/api/v2/status" && method === "GET") {
        const cloudReplication =
          typeof options.stateCoordinator?.replicationStatus === "function"
            ? options.stateCoordinator.replicationStatus()
            : undefined;
        return json(res, 200, {
          projectId: PROJECT,
          mode: local ? "LOCAL_DEVELOPMENT" : "PUBLIC_INVITATION",
          capabilities,
          model: {
            ...modelSettings(env),
            connectionVerified: Boolean(modelVerifiedAt),
            verifiedAt: modelVerifiedAt,
          },
          spark: {
            available: options.runner ? true : runtime.available,
            engine: "Apache Spark",
            isolation: "LOCAL_PROCESS",
          },
          metadata:
            typeof store.replicationStatus === "function"
              ? {
                  ...store.replicationStatus(),
                  cloudVerified: store.replicationStatus().healthy,
                }
              : { driver: "sqlite", cloudVerified: false },
          persistence:
            cloudReplication
              ? cloudReplication
              : {
                  mode: "local-sqlite",
                  healthy: true,
                  dataState: { driver: "sqlite", healthy: true },
                },
          publicReady: false,
          validationContract: {
            id: validationContractId,
            fixtureCount: contextIds.length,
          },
          dataServices: {
            serviceCount: dataServices.list().length,
            businessDriver: options.stateCoordinator
              ? "sqlite-index-with-oss-snapshot-cas"
              : "sqlite",
            cloudVerified: Boolean(
              cloudReplication?.dataState.healthy,
            ),
          },
          ingestion: {
            sourceCount: ingestion.listSources().length,
            offlineTaskCount: ingestion.listTasks().length,
            sourceType: "LOCAL_CSV",
            landingDriver: options.stateCoordinator
              ? "sqlite-index-with-oss-snapshot-cas"
              : "sqlite",
            cloudVerified: Boolean(
              cloudReplication?.dataState.healthy,
            ),
          },
          realtime: {
            sourceCount: realtime.listSources().length,
            jobCount: realtime.listJobs().length,
            adapter: "local-event-log-v1",
            kafkaConnected: false,
            flinkConnected: false,
            stateDriver: options.stateCoordinator
              ? "sqlite-index-with-oss-snapshot-cas"
              : "sqlite",
            cloudVerified: Boolean(
              cloudReplication?.dataState.healthy,
            ),
          },
          assets: {
            assetCount: assets.listAssets().length,
            metricCount: assets.listMetrics().length,
            standardCount: assets.listStandards().length,
            lineageDerivation: "VERSION_BINDINGS",
            sqlColumnLineageParsed: false,
            cloudVerified: false,
          },
          quality: {
            ...quality.overview().counts,
            executionScope: "LOCAL_ACTUAL_ROWS",
            cloudVerified: false,
          },
          security: {
            ...security.overview().counts,
            identityMode: local
              ? "LOCAL_SYNTHETIC_HEADER"
              : "INVITATION_SESSION",
            publicAuthentication: !local,
            cloudVerified: Boolean(
              cloudReplication?.metadata.healthy,
            ),
          },
          reports: {
            ...reports.overview().counts,
            executionScope: "LOCAL_AGGREGATED_REPORTING",
            publicDeployed: false,
            snapshotDriver: options.stateCoordinator
              ? "sqlite-index-with-oss-snapshot-cas"
              : "sqlite",
            cloudVerified: Boolean(
              cloudReplication?.dataState.healthy,
            ),
          },
          operations: {
            ...operations.overview().counts,
            health: operations.overview().health,
            scope: "LOCAL_CROSS_MODULE_OBSERVABILITY",
            publicDeployed: false,
          },
          authentication: {
            ...auth.overview(),
            mode: local ? "LOCAL_DEVELOPMENT_BYPASS" : "INVITATION_SESSION",
            publicSessionEnforced: !local,
          },
        });
      }
      const openService = path.match(
        /^\/api\/v2\/open\/(dapis|xapis)\/([a-z][a-z0-9-]{2,47})$/,
      );
      if (openService && method === "GET")
        return json(
          res,
          200,
          await dataServices.invoke(
            openService[1] === "dapis" ? "DAPI" : "XAPI",
            openService[2],
            req.headers.authorization,
            Object.fromEntries(url.searchParams),
          ),
        );
      if (path === "/api/v2/contexts" && method === "GET")
        return json(res, 200, contextIds.map(publicContext));
      if (path === "/api/v2/sources" && method === "GET")
        return json(res, 200, ingestion.listSources());
      if (path === "/api/v2/sources" && method === "POST") {
        const body = await readBody(req),
          key = text(req.headers["idempotency-key"], 1, 100),
          dedup = store.deduplicate(
            `${PROJECT}:source:${key}`,
            hash(JSON.stringify(body)),
            () => ingestion.createSource(body),
          );
        return json(
          res,
          dedup.replayed ? 200 : 201,
          ingestion.sourceDetail(dedup.id),
        );
      }
      const sourceRecord = path.match(
        /^\/api\/v2\/sources\/([a-f0-9-]+)(?:\/(test|metadata|revisions))?$/,
      );
      if (sourceRecord) {
        const source = ingestion.sourceDetail(sourceRecord[1]),
          action = sourceRecord[2];
        if (method === "GET" && !action) return json(res, 200, source);
        if (method === "POST" && action === "test") {
          await readBody(req);
          return json(res, 200, ingestion.testConnection(source.id));
        }
        if (method === "POST" && action === "metadata") {
          await readBody(req);
          return json(res, 200, ingestion.collectMetadata(source.id));
        }
        if (method === "POST" && action === "revisions") {
          const body = await readBody(req),
            key = text(req.headers["idempotency-key"], 1, 100),
            dedup = store.deduplicate(
              `${PROJECT}:source-revision:${source.id}:${key}`,
              hash(JSON.stringify(body)),
              () => ingestion.createSourceRevision(source.id, body),
            );
          return json(
            res,
            dedup.replayed ? 200 : 201,
            get("source_revision", dedup.id),
          );
        }
      }
      if (path === "/api/v2/sync/tasks" && method === "GET")
        return json(res, 200, ingestion.listTasks());
      if (path === "/api/v2/sync/agent/plans" && method === "GET")
        return json(res, 200, store.list("ingestion_agent_plan", PROJECT));
      if (path === "/api/v2/sync/agent/plans" && method === "POST") {
        const body = await readBody(req),
          message = text(body.message, 4, 2000);
        if (!options.ingestionPlanner && !modelSettings(env).configured)
          throw new ModelUnavailable();
        const key = text(req.headers["idempotency-key"], 1, 100),
          dedup = store.deduplicate(
            `${PROJECT}:ingestion-agent-plan:${key}`,
            hash(JSON.stringify({ message })),
            () =>
              store.create("ingestion_agent_plan", PROJECT, {
                message,
                status: "QUEUED",
                mode: "LIVE_MODEL",
                completionScope: "OFFLINE_SYNC_DESIGN",
                fullLifecycleE2E: false,
              }),
          ),
          task = get("ingestion_agent_plan", dedup.id);
        if (!dedup.replayed)
          schedule("ingestion_agent_plan", task, async (signal) => {
            const generated = await ingestionPlanner({
                message,
                sources: ingestion.listSources(),
                signal,
              }),
              proposal = ingestion.validateAgentPlan(generated.plan);
            store.update("ingestion_agent_plan", task.id, PROJECT, {
              status: "SUCCEEDED",
              proposal,
              explanation: generated.explanation,
              model: generated.model,
              usage: generated.usage,
              finishedAt: new Date().toISOString(),
            });
          });
        return json(res, 202, task);
      }
      const ingestionAgentPlan = path.match(
        /^\/api\/v2\/sync\/agent\/plans\/([a-f0-9-]+)(?:\/(apply|cancel))?$/,
      );
      if (ingestionAgentPlan) {
        const plan = get("ingestion_agent_plan", ingestionAgentPlan[1]),
          action = ingestionAgentPlan[2];
        if (method === "GET" && !action) return json(res, 200, plan);
        if (method === "POST" && action === "cancel") {
          await readBody(req);
          if (!terminal.has(plan.status) && plan.status !== "APPLIED") {
            store.update("ingestion_agent_plan", plan.id, PROJECT, {
              status: "CANCELLED",
              finishedAt: new Date().toISOString(),
            });
            controls.get(plan.id)?.abort();
          }
          return json(res, 200, get("ingestion_agent_plan", plan.id));
        }
        if (method === "POST" && action === "apply") {
          await readBody(req);
          if (plan.status === "APPLIED" && plan.syncTaskId)
            return json(res, 200, ingestion.taskDetail(plan.syncTaskId));
          if (plan.status !== "SUCCEEDED" || !plan.proposal)
            throw fail(409, "只有模型同步方案验证通过后才能创建草稿");
          const proposal = ingestion.validateAgentPlan(plan.proposal),
            syncTask = ingestion.createTask(proposal);
          store.update("ingestion_agent_plan", plan.id, PROJECT, {
            status: "APPLIED",
            syncTaskId: syncTask.id,
            appliedAt: new Date().toISOString(),
          });
          return json(res, 201, ingestion.taskDetail(syncTask.id));
        }
      }
      if (path === "/api/v2/sync/tasks" && method === "POST") {
        const body = await readBody(req),
          key = text(req.headers["idempotency-key"], 1, 100),
          dedup = store.deduplicate(
            `${PROJECT}:offline-sync-task:${key}`,
            hash(JSON.stringify(body)),
            () => ingestion.createTask(body),
          );
        return json(
          res,
          dedup.replayed ? 200 : 201,
          ingestion.taskDetail(dedup.id),
        );
      }
      const syncTaskRecord = path.match(
        /^\/api\/v2\/sync\/tasks\/([a-f0-9-]+)(?:\/(run))?$/,
      );
      if (syncTaskRecord) {
        const task = ingestion.taskDetail(syncTaskRecord[1]),
          action = syncTaskRecord[2];
        if (method === "GET" && !action) return json(res, 200, task);
        if (method === "POST" && action === "run") {
          await readBody(req);
          const requestKey = text(req.headers["idempotency-key"], 1, 100),
            requestSignature = hash(
              JSON.stringify({
                taskId: task.id,
                configHash: task.configHash,
                sourceRevisionId: task.sourceRevisionId,
              }),
            );
          return json(
            res,
            200,
            ingestion.runTask(task.id, { requestKey, requestSignature }),
          );
        }
      }
      const targetRows = path.match(
        /^\/api\/v2\/sync\/targets\/([a-z][a-z0-9_]{0,62})\/rows$/,
      );
      if (targetRows && method === "GET")
        return json(res, 200, ingestion.previewTarget(targetRows[1]));
      if (path === "/api/v2/streams/monitor" && method === "GET")
        return json(res, 200, realtime.monitor());
      if (path === "/api/v2/streams/agent/plans" && method === "GET")
        return json(res, 200, store.list("realtime_agent_plan", PROJECT));
      if (path === "/api/v2/streams/agent/plans" && method === "POST") {
        const body = await readBody(req),
          message = text(body.message, 4, 2000);
        if (!options.realtimePlanner && !modelSettings(env).configured)
          throw new ModelUnavailable();
        const key = text(req.headers["idempotency-key"], 1, 100),
          dedup = store.deduplicate(
            `${PROJECT}:realtime-agent-plan:${key}`,
            hash(JSON.stringify({ message })),
            () =>
              store.create("realtime_agent_plan", PROJECT, {
                message,
                status: "QUEUED",
                mode: "LIVE_MODEL",
                completionScope: "REALTIME_SYNC_DESIGN",
                fullLifecycleE2E: false,
              }),
          ),
          task = get("realtime_agent_plan", dedup.id);
        if (!dedup.replayed)
          schedule("realtime_agent_plan", task, async (signal) => {
            const generated = await realtimePlanner({
                message,
                sources: realtime.listSources(),
                signal,
              }),
              proposal = realtime.validateAgentPlan(generated.plan);
            store.update("realtime_agent_plan", task.id, PROJECT, {
              status: "SUCCEEDED",
              proposal,
              explanation: generated.explanation,
              model: generated.model,
              usage: generated.usage,
              finishedAt: new Date().toISOString(),
            });
          });
        return json(res, 202, task);
      }
      const realtimeAgentPlan = path.match(
        /^\/api\/v2\/streams\/agent\/plans\/([a-f0-9-]+)(?:\/(apply|cancel))?$/,
      );
      if (realtimeAgentPlan) {
        const plan = get("realtime_agent_plan", realtimeAgentPlan[1]),
          action = realtimeAgentPlan[2];
        if (method === "GET" && !action) return json(res, 200, plan);
        if (method === "POST" && action === "cancel") {
          await readBody(req);
          if (!terminal.has(plan.status) && plan.status !== "APPLIED") {
            store.update("realtime_agent_plan", plan.id, PROJECT, {
              status: "CANCELLED",
              finishedAt: new Date().toISOString(),
            });
            controls.get(plan.id)?.abort();
          }
          return json(res, 200, get("realtime_agent_plan", plan.id));
        }
        if (method === "POST" && action === "apply") {
          await readBody(req);
          if (plan.status === "APPLIED" && plan.streamJobId)
            return json(res, 200, realtime.jobDetail(plan.streamJobId));
          if (plan.status !== "SUCCEEDED" || !plan.proposal)
            throw fail(409, "只有模型实时方案验证通过后才能创建草稿");
          const proposal = realtime.validateAgentPlan(plan.proposal),
            streamJob = realtime.createJob(proposal);
          store.update("realtime_agent_plan", plan.id, PROJECT, {
            status: "APPLIED",
            streamJobId: streamJob.id,
            appliedAt: new Date().toISOString(),
          });
          return json(res, 201, realtime.jobDetail(streamJob.id));
        }
      }
      if (path === "/api/v2/streams/sources" && method === "GET")
        return json(res, 200, realtime.listSources());
      if (path === "/api/v2/streams/sources" && method === "POST") {
        const body = await readBody(req),
          key = text(req.headers["idempotency-key"], 1, 100),
          dedup = store.deduplicate(
            `${PROJECT}:stream-source:${key}`,
            hash(JSON.stringify(body)),
            () => realtime.createSource(body),
          );
        return json(
          res,
          dedup.replayed ? 200 : 201,
          realtime.sourceDetail(dedup.id),
        );
      }
      const streamSourceRecord = path.match(
        /^\/api\/v2\/streams\/sources\/([a-f0-9-]+)(?:\/(revisions))?$/,
      );
      if (streamSourceRecord) {
        const source = realtime.sourceDetail(streamSourceRecord[1]),
          action = streamSourceRecord[2];
        if (method === "GET" && !action) return json(res, 200, source);
        if (method === "POST" && action === "revisions") {
          const body = await readBody(req),
            key = text(req.headers["idempotency-key"], 1, 100),
            dedup = store.deduplicate(
              `${PROJECT}:stream-revision:${source.id}:${key}`,
              hash(JSON.stringify(body)),
              () => realtime.createSourceRevision(source.id, body),
            );
          return json(
            res,
            dedup.replayed ? 200 : 201,
            get("stream_source_revision", dedup.id),
          );
        }
      }
      if (path === "/api/v2/streams/jobs" && method === "GET")
        return json(res, 200, realtime.listJobs());
      if (path === "/api/v2/streams/jobs" && method === "POST") {
        const body = await readBody(req),
          key = text(req.headers["idempotency-key"], 1, 100),
          dedup = store.deduplicate(
            `${PROJECT}:stream-job:${key}`,
            hash(JSON.stringify(body)),
            () => realtime.createJob(body),
          );
        return json(
          res,
          dedup.replayed ? 200 : 201,
          realtime.jobDetail(dedup.id),
        );
      }
      const streamJobRecord = path.match(
        /^\/api\/v2\/streams\/jobs\/([a-f0-9-]+)(?:\/(start|stop|recover|state|checkpoints))?$/,
      );
      if (streamJobRecord) {
        const job = realtime.jobDetail(streamJobRecord[1]),
          action = streamJobRecord[2];
        if (method === "GET" && !action) return json(res, 200, job);
        if (method === "GET" && action === "state")
          return json(res, 200, job.state);
        if (method === "GET" && action === "checkpoints")
          return json(res, 200, job.checkpoints);
        if (method === "POST" && action === "start") {
          await readBody(req);
          const requestKey = text(req.headers["idempotency-key"], 1, 100),
            requestSignature = hash(
              JSON.stringify({
                jobId: job.id,
                sourceRevisionId: job.sourceRevisionId,
                action: "start",
              }),
            );
          return json(
            res,
            202,
            realtime.startJob(job.id, { requestKey, requestSignature }),
          );
        }
        if (method === "POST" && action === "recover") {
          const body = await readBody(req),
            sourceRevisionId = text(body.sourceRevisionId, 1, 80),
            requestKey = text(req.headers["idempotency-key"], 1, 100),
            requestSignature = hash(
              JSON.stringify({
                jobId: job.id,
                sourceRevisionId,
                action: "recover",
              }),
            );
          return json(
            res,
            202,
            realtime.recoverJob(
              job.id,
              { sourceRevisionId },
              { requestKey, requestSignature },
            ),
          );
        }
        if (method === "POST" && action === "stop") {
          await readBody(req);
          return json(res, 202, realtime.stopJob(job.id));
        }
      }
      if (path === "/api/v2/assets" && method === "GET")
        return json(
          res,
          200,
          assets.listAssets({
            q: url.searchParams.get("q") ?? "",
            kind: url.searchParams.get("kind") ?? "",
          }),
        );
      if (path === "/api/v2/assets/agent/tasks" && method === "GET")
        return json(res, 200, store.list("asset_agent_task", PROJECT));
      if (path === "/api/v2/assets/agent/tasks" && method === "POST") {
        const body = await readBody(req),
          message = text(body.message, 4, 2000);
        if (!options.assetPlanner && !modelSettings(env).configured)
          throw new ModelUnavailable();
        const key = text(req.headers["idempotency-key"], 1, 100),
          dedup = store.deduplicate(
            `${PROJECT}:asset-agent-task:${key}`,
            hash(JSON.stringify({ message })),
            () =>
              store.create("asset_agent_task", PROJECT, {
                message,
                status: "QUEUED",
                mode: "LIVE_MODEL",
                completionScope: "ASSET_DISCOVERY",
                fullLifecycleE2E: false,
              }),
          ),
          task = get("asset_agent_task", dedup.id);
        if (!dedup.replayed)
          schedule("asset_agent_task", task, async (signal) => {
            const context = assets.agentContext(),
              generated = await assetPlanner({
                message,
                ...context,
                signal,
              }),
              insight = assets.validateAgentInsight(generated.insight);
            store.update("asset_agent_task", task.id, PROJECT, {
              status: "SUCCEEDED",
              insight,
              model: generated.model,
              usage: generated.usage,
              finishedAt: new Date().toISOString(),
            });
          });
        return json(res, 202, task);
      }
      const assetAgentTask = path.match(
        /^\/api\/v2\/assets\/agent\/tasks\/([a-f0-9-]+)(?:\/(cancel))?$/,
      );
      if (assetAgentTask) {
        const task = get("asset_agent_task", assetAgentTask[1]),
          action = assetAgentTask[2];
        if (method === "GET" && !action) return json(res, 200, task);
        if (method === "POST" && action === "cancel") {
          await readBody(req);
          if (!terminal.has(task.status)) {
            store.update("asset_agent_task", task.id, PROJECT, {
              status: "CANCELLED",
              finishedAt: new Date().toISOString(),
            });
            controls.get(task.id)?.abort();
          }
          return json(res, 200, get("asset_agent_task", task.id));
        }
      }
      const assetRecord = path.match(
        /^\/api\/v2\/assets\/([^/]+)(?:\/(annotation|lineage|impact))?$/,
      );
      if (assetRecord) {
        const id = decodeURIComponent(assetRecord[1]),
          action = assetRecord[2];
        if (method === "GET" && !action)
          return json(res, 200, assets.detail(id));
        if (method === "GET" && action === "lineage")
          return json(res, 200, assets.lineage(id));
        if (method === "GET" && action === "impact")
          return json(res, 200, assets.impact(id));
        if (method === "POST" && action === "annotation") {
          const body = await readBody(req),
            key = text(req.headers["idempotency-key"], 1, 100),
            dedup = store.deduplicate(
              `${PROJECT}:asset-annotation:${id}:${key}`,
              hash(JSON.stringify(body)),
              () => assets.annotate(id, body).annotation,
            );
          get("asset_annotation", dedup.id);
          return json(res, dedup.replayed ? 200 : 201, assets.detail(id));
        }
      }
      if (path === "/api/v2/metrics" && method === "GET")
        return json(res, 200, assets.listMetrics());
      if (path === "/api/v2/metrics" && method === "POST") {
        const body = await readBody(req),
          key = text(req.headers["idempotency-key"], 1, 100),
          dedup = store.deduplicate(
            `${PROJECT}:metric:${key}`,
            hash(JSON.stringify(body)),
            () => assets.createMetric(body),
          );
        return json(res, dedup.replayed ? 200 : 201, get("metric_definition", dedup.id));
      }
      const metricRecord = path.match(
        /^\/api\/v2\/metrics\/([a-f0-9-]+)(?:\/(run))?$/,
      );
      if (metricRecord) {
        const metric = assets
            .listMetrics()
            .find((item) => item.id === metricRecord[1]),
          action = metricRecord[2];
        if (!metric) throw fail(404, "未找到指标");
        if (method === "GET" && !action) return json(res, 200, metric);
        if (method === "POST" && action === "run") {
          await readBody(req);
          const key = text(req.headers["idempotency-key"], 1, 100),
            evidenceHash = assets.detail(metric.assetId).evidenceHash,
            dedup = store.deduplicate(
              `${PROJECT}:metric-run:${metric.id}:${key}`,
              hash(JSON.stringify({ metricId: metric.id, evidenceHash })),
              () => assets.runMetric(metric.id),
            );
          return json(res, dedup.replayed ? 200 : 201, get("metric_run", dedup.id));
        }
      }
      if (path === "/api/v2/standards" && method === "GET")
        return json(res, 200, assets.listStandards());
      if (path === "/api/v2/standards" && method === "POST") {
        const body = await readBody(req),
          key = text(req.headers["idempotency-key"], 1, 100),
          dedup = store.deduplicate(
            `${PROJECT}:standard:${key}`,
            hash(JSON.stringify(body)),
            () => assets.createStandard(body),
          );
        return json(res, dedup.replayed ? 200 : 201, get("data_standard", dedup.id));
      }
      const standardRecord = path.match(
        /^\/api\/v2\/standards\/([a-f0-9-]+)(?:\/(check))?$/,
      );
      if (standardRecord) {
        const standard = assets
            .listStandards()
            .find((item) => item.id === standardRecord[1]),
          action = standardRecord[2];
        if (!standard) throw fail(404, "未找到数据标准");
        if (method === "GET" && !action) return json(res, 200, standard);
        if (method === "POST" && action === "check") {
          await readBody(req);
          const key = text(req.headers["idempotency-key"], 1, 100),
            evidenceHash = assets.detail(standard.assetId).evidenceHash,
            dedup = store.deduplicate(
              `${PROJECT}:standard-check:${standard.id}:${key}`,
              hash(JSON.stringify({ standardId: standard.id, evidenceHash })),
              () => assets.checkStandard(standard.id),
            );
          return json(res, dedup.replayed ? 200 : 201, get("standard_check", dedup.id));
        }
      }
      if (path === "/api/v2/quality/overview" && method === "GET")
        return json(res, 200, quality.overview());
      if (path === "/api/v2/quality/rules" && method === "GET")
        return json(res, 200, quality.listRules());
      if (path === "/api/v2/quality/rules" && method === "POST") {
        const body = await readBody(req),
          key = text(req.headers["idempotency-key"], 1, 100),
          dedup = store.deduplicate(
            `${PROJECT}:quality-rule:${key}`,
            hash(JSON.stringify(body)),
            () => quality.createRule(body),
          );
        return json(
          res,
          dedup.replayed ? 200 : 201,
          quality.detail(dedup.id),
        );
      }
      if (path === "/api/v2/quality/agent/plans" && method === "GET")
        return json(res, 200, store.list("quality_agent_plan", PROJECT));
      if (path === "/api/v2/quality/agent/plans" && method === "POST") {
        const body = await readBody(req),
          message = text(body.message, 4, 2000);
        if (!options.qualityPlanner && !modelSettings(env).configured)
          throw new ModelUnavailable();
        const key = text(req.headers["idempotency-key"], 1, 100),
          dedup = store.deduplicate(
            `${PROJECT}:quality-agent-plan:${key}`,
            hash(JSON.stringify({ message })),
            () =>
              store.create("quality_agent_plan", PROJECT, {
                message,
                status: "QUEUED",
                mode: "LIVE_MODEL",
                completionScope: "QUALITY_RULE_DESIGN",
                fullLifecycleE2E: false,
              }),
          ),
          task = get("quality_agent_plan", dedup.id);
        if (!dedup.replayed)
          schedule("quality_agent_plan", task, async (signal) => {
            const context = quality.agentContext(),
              generated = await qualityPlanner({
                message,
                ...context,
                signal,
              }),
              proposal = quality.validateAgentPlan(generated.plan);
            store.update("quality_agent_plan", task.id, PROJECT, {
              status: "SUCCEEDED",
              proposal,
              explanation: generated.explanation,
              model: generated.model,
              usage: generated.usage,
              finishedAt: new Date().toISOString(),
            });
          });
        return json(res, 202, task);
      }
      const qualityAgentPlan = path.match(
        /^\/api\/v2\/quality\/agent\/plans\/([a-f0-9-]+)(?:\/(apply|cancel))?$/,
      );
      if (qualityAgentPlan) {
        const plan = get("quality_agent_plan", qualityAgentPlan[1]),
          action = qualityAgentPlan[2];
        if (method === "GET" && !action) return json(res, 200, plan);
        if (method === "POST" && action === "cancel") {
          await readBody(req);
          if (!terminal.has(plan.status) && plan.status !== "APPLIED") {
            store.update("quality_agent_plan", plan.id, PROJECT, {
              status: "CANCELLED",
              finishedAt: new Date().toISOString(),
            });
            controls.get(plan.id)?.abort();
          }
          return json(res, 200, get("quality_agent_plan", plan.id));
        }
        if (method === "POST" && action === "apply") {
          await readBody(req);
          if (plan.status === "APPLIED" && plan.ruleId)
            return json(res, 200, quality.detail(plan.ruleId));
          if (plan.status !== "SUCCEEDED" || !plan.proposal)
            throw fail(409, "只有模型质量方案验证通过后才能创建规则草稿");
          const proposal = quality.validateAgentPlan(plan.proposal),
            rule = quality.createRule(proposal);
          store.update("quality_agent_plan", plan.id, PROJECT, {
            status: "APPLIED",
            ruleId: rule.id,
            appliedAt: new Date().toISOString(),
          });
          return json(res, 201, rule);
        }
      }
      const qualityRuleRecord = path.match(
        /^\/api\/v2\/quality\/rules\/([a-f0-9-]+)(?:\/(versions|run))?$/,
      );
      if (qualityRuleRecord) {
        const rule = quality.detail(qualityRuleRecord[1]),
          action = qualityRuleRecord[2];
        if (method === "GET" && !action) return json(res, 200, rule);
        if (method === "POST" && action === "versions") {
          const body = await readBody(req),
            key = text(req.headers["idempotency-key"], 1, 100),
            dedup = store.deduplicate(
              `${PROJECT}:quality-rule-version:${rule.id}:${key}`,
              hash(JSON.stringify(body)),
              () => quality.createVersion(rule.id, body).currentVersion,
            );
          get("quality_rule_version", dedup.id);
          return json(
            res,
            dedup.replayed ? 200 : 201,
            quality.detail(rule.id),
          );
        }
        if (method === "POST" && action === "run") {
          await readBody(req);
          const current = quality.detail(rule.id),
            evidenceHash = assets.detail(rule.assetId).evidenceHash,
            key = text(req.headers["idempotency-key"], 1, 100),
            dedup = store.deduplicate(
              `${PROJECT}:quality-run:${rule.id}:${key}`,
              hash(
                JSON.stringify({
                  ruleId: rule.id,
                  versionId: current.currentVersionId,
                  configHash: current.currentVersion.configHash,
                  evidenceHash,
                }),
              ),
              () => quality.runRule(rule.id).run,
            );
          get("quality_run", dedup.id);
          return json(res, dedup.replayed ? 200 : 201, quality.detail(rule.id));
        }
      }
      if (path === "/api/v2/security/overview" && method === "GET")
        return json(res, 200, security.overview());
      if (path === "/api/v2/security/personas" && method === "GET")
        return json(res, 200, security.personas());
      if (path === "/api/v2/security/policies" && method === "GET")
        return json(res, 200, security.listPolicies());
      if (path === "/api/v2/security/policies" && method === "POST") {
        const body = await readBody(req),
          key = text(req.headers["idempotency-key"], 1, 100),
          dedup = store.deduplicate(
            `${PROJECT}:security-policy:${key}`,
            hash(JSON.stringify(body)),
            () => security.createPolicy(body),
          );
        return json(
          res,
          dedup.replayed ? 200 : 201,
          security.policyDetail(dedup.id),
        );
      }
      const securityPolicyRecord = path.match(
        /^\/api\/v2\/security\/policies\/([a-f0-9-]+)(?:\/(versions))?$/,
      );
      if (securityPolicyRecord) {
        const policy = security.policyDetail(securityPolicyRecord[1]),
          action = securityPolicyRecord[2];
        if (method === "GET" && !action) return json(res, 200, policy);
        if (method === "POST" && action === "versions") {
          const body = await readBody(req),
            key = text(req.headers["idempotency-key"], 1, 100),
            dedup = store.deduplicate(
              `${PROJECT}:security-policy-version:${policy.id}:${key}`,
              hash(JSON.stringify(body)),
              () => security.createPolicyVersion(policy.id, body).currentVersion,
            );
          get("security_policy_version", dedup.id);
          return json(
            res,
            dedup.replayed ? 200 : 201,
            security.policyDetail(policy.id),
          );
        }
      }
      const securityQuery = path.match(
        /^\/api\/v2\/security\/query\/([^/]+)$/,
      );
      if (securityQuery && method === "POST") {
        await readBody(req);
        const actorId = text(req.headers["x-actor-id"], 3, 80);
        return json(
          res,
          200,
          security.query(actorId, decodeURIComponent(securityQuery[1])),
        );
      }
      if (path === "/api/v2/security/requests" && method === "GET")
        return json(res, 200, security.listRequests());
      if (path === "/api/v2/security/requests" && method === "POST") {
        const body = await readBody(req),
          actorId = text(req.headers["x-actor-id"], 3, 80),
          key = text(req.headers["idempotency-key"], 1, 100),
          dedup = store.deduplicate(
            `${PROJECT}:security-request:${actorId}:${key}`,
            hash(JSON.stringify(body)),
            () => security.createRequest(actorId, body),
          );
        return json(
          res,
          dedup.replayed ? 200 : 201,
          get("access_request", dedup.id),
        );
      }
      const securityRequestReview = path.match(
        /^\/api\/v2\/security\/requests\/([a-f0-9-]+)\/review$/,
      );
      if (securityRequestReview && method === "POST") {
        const body = await readBody(req),
          actorId = text(req.headers["x-actor-id"], 3, 80),
          key = text(req.headers["idempotency-key"], 1, 100),
          dedup = store.deduplicate(
            `${PROJECT}:security-review:${securityRequestReview[1]}:${actorId}:${key}`,
            hash(JSON.stringify(body)),
            () =>
              security.reviewRequest(
                actorId,
                securityRequestReview[1],
                body,
              ).request,
          ),
          reviewed = get("access_request", dedup.id),
          grant = reviewed.grantId
            ? get("security_grant", reviewed.grantId)
            : undefined;
        return json(res, dedup.replayed ? 200 : 201, { request: reviewed, grant });
      }
      if (path === "/api/v2/security/audits" && method === "GET")
        return json(res, 200, security.listAudits());
      if (path === "/api/v2/security/agent/plans" && method === "GET")
        return json(res, 200, store.list("security_agent_plan", PROJECT));
      if (path === "/api/v2/security/agent/plans" && method === "POST") {
        const body = await readBody(req),
          message = text(body.message, 4, 2000);
        if (!options.securityPlanner && !modelSettings(env).configured)
          throw new ModelUnavailable();
        const key = text(req.headers["idempotency-key"], 1, 100),
          dedup = store.deduplicate(
            `${PROJECT}:security-agent-plan:${key}`,
            hash(JSON.stringify({ message })),
            () =>
              store.create("security_agent_plan", PROJECT, {
                message,
                status: "QUEUED",
                mode: "LIVE_MODEL",
                completionScope: "SECURITY_POLICY_DESIGN",
                fullLifecycleE2E: false,
              }),
          ),
          task = get("security_agent_plan", dedup.id);
        if (!dedup.replayed)
          schedule("security_agent_plan", task, async (signal) => {
            const context = security.agentContext(),
              generated = await securityPlanner({
                message,
                ...context,
                signal,
              }),
              proposal = security.validateAgentPlan(generated.plan);
            store.update("security_agent_plan", task.id, PROJECT, {
              status: "SUCCEEDED",
              proposal,
              explanation: generated.explanation,
              model: generated.model,
              usage: generated.usage,
              finishedAt: new Date().toISOString(),
            });
          });
        return json(res, 202, task);
      }
      const securityAgentPlan = path.match(
        /^\/api\/v2\/security\/agent\/plans\/([a-f0-9-]+)(?:\/(apply|cancel))?$/,
      );
      if (securityAgentPlan) {
        const plan = get("security_agent_plan", securityAgentPlan[1]),
          action = securityAgentPlan[2];
        if (method === "GET" && !action) return json(res, 200, plan);
        if (method === "POST" && action === "cancel") {
          await readBody(req);
          if (!terminal.has(plan.status) && plan.status !== "APPLIED") {
            store.update("security_agent_plan", plan.id, PROJECT, {
              status: "CANCELLED",
              finishedAt: new Date().toISOString(),
            });
            controls.get(plan.id)?.abort();
          }
          return json(res, 200, get("security_agent_plan", plan.id));
        }
        if (method === "POST" && action === "apply") {
          await readBody(req);
          if (plan.status === "APPLIED" && plan.policyId)
            return json(res, 200, security.policyDetail(plan.policyId));
          if (plan.status !== "SUCCEEDED" || !plan.proposal)
            throw fail(409, "只有模型安全方案验证通过后才能创建策略草稿");
          const proposal = security.validateAgentPlan(plan.proposal),
            policy = security.createPolicy(proposal);
          store.update("security_agent_plan", plan.id, PROJECT, {
            status: "APPLIED",
            policyId: policy.id,
            appliedAt: new Date().toISOString(),
          });
          return json(res, 201, policy);
        }
      }
      if (path === "/api/v2/reports/overview" && method === "GET")
        return json(res, 200, reports.overview());
      if (path === "/api/v2/reports/datasets" && method === "GET")
        return json(res, 200, reports.listDatasets());
      if (path === "/api/v2/reports/datasets" && method === "POST") {
        const body = await readBody(req),
          key = text(req.headers["idempotency-key"], 1, 100),
          dedup = store.deduplicate(
            `${PROJECT}:report-dataset:${key}`,
            hash(JSON.stringify(body)),
            () => reports.createDataset(body),
          );
        return json(
          res,
          dedup.replayed ? 200 : 201,
          reports.datasetDetail(dedup.id),
        );
      }
      const reportDatasetRecord = path.match(
        /^\/api\/v2\/reports\/datasets\/([a-f0-9-]+)(?:\/(refresh))?$/,
      );
      if (reportDatasetRecord) {
        const dataset = reports.datasetDetail(reportDatasetRecord[1]),
          action = reportDatasetRecord[2];
        if (method === "GET" && !action) return json(res, 200, dataset);
        if (method === "POST" && action === "refresh") {
          await readBody(req);
          const asset = assets.detail(dataset.assetId),
            key = text(req.headers["idempotency-key"], 1, 100),
            dedup = store.deduplicate(
              `${PROJECT}:report-dataset-refresh:${dataset.id}:${key}`,
              hash(
                JSON.stringify({
                  datasetId: dataset.id,
                  fields: dataset.fields,
                  assetEvidenceHash: asset.evidenceHash,
                }),
              ),
              () => reports.refreshDataset(dataset.id).currentSnapshot,
            );
          get("report_snapshot", dedup.id);
          return json(res, dedup.replayed ? 200 : 201, reports.datasetDetail(dataset.id));
        }
      }
      if (path === "/api/v2/reports" && method === "GET")
        return json(res, 200, reports.listReports());
      if (path === "/api/v2/reports" && method === "POST") {
        const body = await readBody(req),
          key = text(req.headers["idempotency-key"], 1, 100),
          dedup = store.deduplicate(
            `${PROJECT}:report:${key}`,
            hash(JSON.stringify(body)),
            () => reports.createReport(body),
          );
        return json(
          res,
          dedup.replayed ? 200 : 201,
          reports.reportDetail(dedup.id),
        );
      }
      if (path === "/api/v2/reports/agent/plans" && method === "GET")
        return json(res, 200, store.list("report_agent_plan", PROJECT));
      if (path === "/api/v2/reports/agent/plans" && method === "POST") {
        const body = await readBody(req),
          message = text(body.message, 4, 2000);
        if (!options.reportPlanner && !modelSettings(env).configured)
          throw new ModelUnavailable();
        const key = text(req.headers["idempotency-key"], 1, 100),
          dedup = store.deduplicate(
            `${PROJECT}:report-agent-plan:${key}`,
            hash(JSON.stringify({ message })),
            () =>
              store.create("report_agent_plan", PROJECT, {
                message,
                status: "QUEUED",
                mode: "LIVE_MODEL",
                completionScope: "REPORT_DESIGN",
                fullLifecycleE2E: false,
              }),
          ),
          task = get("report_agent_plan", dedup.id);
        if (!dedup.replayed)
          schedule("report_agent_plan", task, async (signal) => {
            const context = reports.agentContext(),
              generated = await reportPlanner({
                message,
                ...context,
                signal,
              }),
              proposal = reports.validateAgentPlan(generated.plan);
            store.update("report_agent_plan", task.id, PROJECT, {
              status: "SUCCEEDED",
              proposal,
              explanation: generated.explanation,
              model: generated.model,
              usage: generated.usage,
              finishedAt: new Date().toISOString(),
            });
          });
        return json(res, 202, task);
      }
      const reportAgentPlan = path.match(
        /^\/api\/v2\/reports\/agent\/plans\/([a-f0-9-]+)(?:\/(apply|cancel))?$/,
      );
      if (reportAgentPlan) {
        const plan = get("report_agent_plan", reportAgentPlan[1]),
          action = reportAgentPlan[2];
        if (method === "GET" && !action) return json(res, 200, plan);
        if (method === "POST" && action === "cancel") {
          await readBody(req);
          if (!terminal.has(plan.status) && plan.status !== "APPLIED") {
            store.update("report_agent_plan", plan.id, PROJECT, {
              status: "CANCELLED",
              finishedAt: new Date().toISOString(),
            });
            controls.get(plan.id)?.abort();
          }
          return json(res, 200, get("report_agent_plan", plan.id));
        }
        if (method === "POST" && action === "apply") {
          await readBody(req);
          if (plan.status === "APPLIED" && plan.reportId)
            return json(res, 200, reports.reportDetail(plan.reportId));
          if (plan.status !== "SUCCEEDED" || !plan.proposal)
            throw fail(409, "只有模型报表方案验证通过后才能创建草稿");
          const proposal = reports.validateAgentPlan(plan.proposal),
            report = reports.createReport(proposal);
          store.update("report_agent_plan", plan.id, PROJECT, {
            status: "APPLIED",
            reportId: report.id,
            appliedAt: new Date().toISOString(),
          });
          return json(res, 201, report);
        }
      }
      const reportRecord = path.match(
        /^\/api\/v2\/reports\/([a-f0-9-]+)(?:\/(versions|run|export))?$/,
      );
      if (reportRecord) {
        const report = reports.reportDetail(reportRecord[1]),
          action = reportRecord[2];
        if (method === "GET" && !action) return json(res, 200, report);
        if (method === "GET" && action === "export")
          return json(res, 200, reports.exportReport(report.id));
        if (method === "POST" && action === "versions") {
          const body = await readBody(req),
            key = text(req.headers["idempotency-key"], 1, 100),
            dedup = store.deduplicate(
              `${PROJECT}:report-version:${report.id}:${key}`,
              hash(JSON.stringify(body)),
              () => reports.createReportVersion(report.id, body).currentVersion,
            );
          get("report_version", dedup.id);
          return json(res, dedup.replayed ? 200 : 201, reports.reportDetail(report.id));
        }
        if (method === "POST" && action === "run") {
          await readBody(req);
          const current = reports.reportDetail(report.id),
            key = text(req.headers["idempotency-key"], 1, 100),
            dedup = store.deduplicate(
              `${PROJECT}:report-run:${report.id}:${key}`,
              hash(
                JSON.stringify({
                  reportId: report.id,
                  versionId: current.currentVersionId,
                  configHash: current.currentVersion.configHash,
                  datasetSnapshotId: current.currentVersion.datasetSnapshotId,
                }),
              ),
              () => reports.runReport(report.id).run,
            );
          get("report_run", dedup.id);
          return json(res, dedup.replayed ? 200 : 201, reports.reportDetail(report.id));
        }
      }
      if (path === "/api/v2/operations/overview" && method === "GET")
        return json(res, 200, {
          ...operations.overview(),
          externalModelContextAllowed: Boolean(
            options.opsPlanner ||
              env.V2_ALLOW_EXTERNAL_OPS_CONTEXT === "true",
          ),
        });
      if (path === "/api/v2/operations/refresh" && method === "POST") {
        await readBody(req);
        return json(res, 200, operations.refresh());
      }
      if (path === "/api/v2/operations/incidents" && method === "GET")
        return json(res, 200, operations.listIncidents());
      const opsIncidentRecord = path.match(
        /^\/api\/v2\/operations\/incidents\/([a-f0-9-]+)(?:\/(acknowledge|resolve))?$/,
      );
      if (opsIncidentRecord) {
        const incident = operations.incidentDetail(opsIncidentRecord[1]),
          action = opsIncidentRecord[2];
        if (method === "GET" && !action) return json(res, 200, incident);
        if (method === "POST" && ["acknowledge", "resolve"].includes(action)) {
          const body = await readBody(req),
            key = text(req.headers["idempotency-key"], 1, 100),
            dedup = store.deduplicate(
              `${PROJECT}:ops-incident:${incident.id}:${action}:${key}`,
              hash(JSON.stringify(body)),
              () =>
                action === "acknowledge"
                  ? operations.acknowledge(incident.id, body)
                  : operations.resolve(incident.id, body),
            );
          return json(
            res,
            dedup.replayed ? 200 : 201,
            operations.incidentDetail(dedup.id),
          );
        }
      }
      if (path === "/api/v2/operations/agent/diagnoses" && method === "GET")
        return json(res, 200, store.list("ops_agent_diagnosis", PROJECT));
      if (path === "/api/v2/operations/agent/diagnoses" && method === "POST") {
        const body = await readBody(req),
          message = text(body.message, 4, 2000);
        if (!operations.listIncidents().length)
          throw fail(409, "请先刷新并选择有实际证据的事故");
        if (
          !options.opsPlanner &&
          env.V2_ALLOW_EXTERNAL_OPS_CONTEXT !== "true"
        )
          throw fail(
            412,
            "运维摘要默认禁止发送到外部模型；需用户明确授权后设置V2_ALLOW_EXTERNAL_OPS_CONTEXT=true",
          );
        if (!options.opsPlanner && !modelSettings(env).configured)
          throw new ModelUnavailable();
        const key = text(req.headers["idempotency-key"], 1, 100),
          dedup = store.deduplicate(
            `${PROJECT}:ops-agent-diagnosis:${key}`,
            hash(JSON.stringify({ message })),
            () =>
              store.create("ops_agent_diagnosis", PROJECT, {
                message,
                status: "QUEUED",
                mode: "LIVE_MODEL",
                completionScope: "OPS_DIAGNOSIS",
                fullLifecycleE2E: false,
                executable: false,
              }),
          ),
          task = get("ops_agent_diagnosis", dedup.id);
        if (!dedup.replayed)
          schedule("ops_agent_diagnosis", task, async (signal) => {
            const context = operations.agentContext(),
              generated = await opsPlanner({
                message,
                ...context,
                signal,
              }),
              diagnosis = operations.validateAgentDiagnosis(
                generated.diagnosis,
              );
            store.update("ops_agent_diagnosis", task.id, PROJECT, {
              status: "SUCCEEDED",
              diagnosis,
              model: generated.model,
              usage: generated.usage,
              finishedAt: new Date().toISOString(),
            });
          });
        return json(res, 202, task);
      }
      const opsAgentDiagnosis = path.match(
        /^\/api\/v2\/operations\/agent\/diagnoses\/([a-f0-9-]+)(?:\/(cancel))?$/,
      );
      if (opsAgentDiagnosis) {
        const task = get("ops_agent_diagnosis", opsAgentDiagnosis[1]),
          action = opsAgentDiagnosis[2];
        if (method === "GET" && !action) return json(res, 200, task);
        if (method === "POST" && action === "cancel") {
          await readBody(req);
          if (!terminal.has(task.status)) {
            store.update("ops_agent_diagnosis", task.id, PROJECT, {
              status: "CANCELLED",
              finishedAt: new Date().toISOString(),
            });
            controls.get(task.id)?.abort();
          }
          return json(res, 200, get("ops_agent_diagnosis", task.id));
        }
      }
      if (
        path === "/api/v2/evaluations/full-lifecycle/latest" &&
        method === "GET"
      ) {
        let report;
        try {
          report = JSON.parse(
            await readFile(
              join(root, ".v2-artifacts", "full-lifecycle", "latest.json"),
              "utf8",
            ),
          );
        } catch {
          throw fail(404, "尚无完整链路评测报告");
        }
        if (
          report.format !== "shuzhan-full-lifecycle-evaluation/v1" ||
          report.frozenCaseCount !== 20 ||
          !Array.isArray(report.outcomes)
        )
          throw fail(409, "完整链路评测报告格式不合法");
        return json(res, 200, report);
      }
      if (path === "/api/v2/settings/model-key" && method === "POST") {
        if (!local)
          throw fail(403, "公网模式禁止通过页面写入模型密钥");
        const body = await readBody(req);
        const configured = await saveLocalModelKey(root, env, body.apiKey);
        modelVerifiedAt = null;
        store.create("settings_audit", PROJECT, {
          action: "MODEL_KEY_SET",
          actor: "local-engineer",
        });
        return json(res, 200, configured);
      }
      if (path === "/api/v2/revisions" && method === "GET")
        return json(res, 200, store.list("revision", PROJECT));
      if (path === "/api/v2/runs" && method === "GET")
        return json(res, 200, store.list("run", PROJECT));
      if (path === "/api/v2/agent/tasks" && method === "GET")
        return json(res, 200, store.list("agent", PROJECT));
      if (path === "/api/v2/delivery/packages" && method === "GET")
        return json(
          res,
          200,
          store.list("delivery_package", PROJECT).map(({ files, ...item }) => ({
            ...item,
            fileNames: Object.keys(files),
          })),
        );
      if (path === "/api/v2/delivery/verifications" && method === "GET")
        return json(res, 200, store.list("delivery_verification", PROJECT));
      if (path === "/api/v2/release/approvals" && method === "GET")
        return json(res, 200, store.list("release_approval", PROJECT));
      if (path === "/api/v2/releases" && method === "GET")
        return json(
          res,
          200,
          store.list("release", PROJECT).map(expose),
        );
      if (path === "/api/v2/release/runs" && method === "GET")
        return json(
          res,
          200,
          store.list("release_run", PROJECT).map(expose),
        );
      if (path === "/api/v2/monitoring/overview" && method === "GET") {
        const releases = store.list("release", PROJECT),
          runs = store.list("release_run", PROJECT),
          alerts = store.list("monitor_alert", PROJECT),
          events = store.list("monitor_event", PROJECT),
          activeRelease = releases.find(
            (release) => release.status === "ACTIVE_LOCAL",
          );
        return json(res, 200, {
          scope: "LOCAL_RELEASE_MONITORING",
          publicDeployed: false,
          fullLifecycleE2E: false,
          activeRelease: expose(activeRelease),
          counts: {
            scheduled: runs.filter((run) => run.status === "SCHEDULED").length,
            running: runs.filter((run) => run.status === "RUNNING").length,
            succeeded: runs.filter((run) => run.status === "SUCCEEDED").length,
            failed: runs.filter((run) =>
              ["FAILED", "VALIDATION_FAILED"].includes(run.status),
            ).length,
            openAlerts: alerts.filter((alert) => alert.status === "OPEN").length,
          },
          recentRuns: runs.slice(0, 20).map(expose),
          alerts: alerts.slice(0, 20),
          recentEvents: events.slice(0, 30),
          notice:
            "这里只展示本机发布批次与告警证据，不能作为公网、生产或完整Agent E2E验收。",
        });
      }
      if (path === "/api/v2/data-services/dapis" && method === "GET")
        return json(res, 200, dataServices.list("DAPI"));
      if (path === "/api/v2/data-services/xapis" && method === "GET")
        return json(res, 200, dataServices.list("XAPI"));
      if (path === "/api/v2/data-services/applications" && method === "GET")
        return json(res, 200, dataServices.listApplications());
      if (path === "/api/v2/data-services/calls" && method === "GET")
        return json(
          res,
          200,
          dataServices.listCalls(url.searchParams.get("service_id") ?? undefined),
        );
      if (path === "/api/v2/data-services/agent/plans" && method === "GET")
        return json(res, 200, store.list("service_agent_plan", PROJECT));
      if (path === "/api/v2/data-services/agent/plans" && method === "POST") {
        const body = await readBody(req),
          message = text(body.message, 4, 2000);
        if (!options.servicePlanner && !modelSettings(env).configured)
          throw new ModelUnavailable();
        const key = text(req.headers["idempotency-key"], 1, 100),
          signature = hash(JSON.stringify({ message })),
          dedup = store.deduplicate(
            `${PROJECT}:service-agent-plan:${key}`,
            signature,
            () =>
              store.create("service_agent_plan", PROJECT, {
                message,
                status: "QUEUED",
                mode: "LIVE_MODEL",
                completionScope: "DATA_SERVICE_DESIGN",
                fullLifecycleE2E: false,
              }),
          ),
          task = get("service_agent_plan", dedup.id);
        if (!dedup.replayed)
          schedule("service_agent_plan", task, async (signal) => {
            const releaseRuns = store
                .list("release_run", PROJECT)
                .filter(
                  (run) =>
                    run.status === "SUCCEEDED" &&
                    run.published === true &&
                    run.schedulerTriggered === true &&
                    run.validation?.passed,
                ),
              generated = await servicePlanner({
                message,
                services: dataServices.list(),
                releaseRuns,
                signal,
              }),
              proposal = dataServices.validateAgentPlan(generated.plan);
            store.update("service_agent_plan", task.id, PROJECT, {
              status: "SUCCEEDED",
              proposal,
              explanation: generated.explanation,
              model: generated.model,
              usage: generated.usage,
              finishedAt: new Date().toISOString(),
            });
          });
        return json(res, 202, task);
      }
      const serviceAgentPlan = path.match(
        /^\/api\/v2\/data-services\/agent\/plans\/([a-f0-9-]+)(?:\/(apply|cancel))?$/,
      );
      if (serviceAgentPlan) {
        const plan = get("service_agent_plan", serviceAgentPlan[1]),
          action = serviceAgentPlan[2];
        if (method === "GET" && !action) return json(res, 200, plan);
        if (method === "POST" && action === "cancel") {
          await readBody(req);
          if (!terminal.has(plan.status) && plan.status !== "APPLIED") {
            store.update("service_agent_plan", plan.id, PROJECT, {
              status: "CANCELLED",
              finishedAt: new Date().toISOString(),
            });
            controls.get(plan.id)?.abort();
          }
          return json(res, 200, get("service_agent_plan", plan.id));
        }
        if (method === "POST" && action === "apply") {
          await readBody(req);
          if (plan.status === "APPLIED" && plan.serviceId)
            return json(res, 200, dataServices.detail(plan.serviceId));
          if (plan.status !== "SUCCEEDED" || !plan.proposal)
            throw fail(409, "只有模型方案验证通过后才能创建草稿");
          const proposal = dataServices.validateAgentPlan(plan.proposal),
            service =
              proposal.serviceType === "DAPI"
                ? dataServices.createDapi(proposal)
                : dataServices.createXapi(proposal);
          store.update("service_agent_plan", plan.id, PROJECT, {
            status: "APPLIED",
            serviceId: service.id,
            appliedAt: new Date().toISOString(),
          });
          return json(res, 201, dataServices.detail(service.id));
        }
      }
      if (
        path === "/api/v2/data-services/applications" &&
        method === "POST"
      ) {
        const body = await readBody(req),
          key = text(req.headers["idempotency-key"], 1, 100);
        let issued;
        const dedup = store.deduplicate(
          `${PROJECT}:service-application:${key}`,
          hash(JSON.stringify(body)),
          () => {
            issued = dataServices.createApplication(body);
            return issued.application;
          },
        );
        if (dedup.replayed)
          return json(res, 200, {
            application: dataServices.application(dedup.id),
            token: null,
            tokenShownOnce: false,
            notice:
              "幂等请求已创建过应用，平台不保存明文令牌；如令牌丢失请撤销并新建应用。",
          });
        return json(res, 201, issued);
      }
      const applicationRecord = path.match(
        /^\/api\/v2\/data-services\/applications\/([a-f0-9-]+)\/(revoke)$/,
      );
      if (applicationRecord && method === "POST") {
        await readBody(req);
        return json(
          res,
          200,
          dataServices.revokeApplication(applicationRecord[1]),
        );
      }
      if (
        ["/api/v2/data-services/dapis", "/api/v2/data-services/xapis"].includes(
          path,
        ) &&
        method === "POST"
      ) {
        const body = await readBody(req),
          type = path.endsWith("dapis") ? "DAPI" : "XAPI",
          key = text(req.headers["idempotency-key"], 1, 100),
          dedup = store.deduplicate(
            `${PROJECT}:data-service:${type}:${key}`,
            hash(JSON.stringify(body)),
            () =>
              type === "DAPI"
                ? dataServices.createDapi(body)
                : dataServices.createXapi(body),
          );
        return json(
          res,
          dedup.replayed ? 200 : 201,
          dataServices.detail(dedup.id),
        );
      }
      const dataServiceRecord = path.match(
        /^\/api\/v2\/data-services\/(dapis|xapis)\/([a-f0-9-]+)(?:\/(versions|test|publish|activate|openapi|calls))?$/,
      );
      if (dataServiceRecord) {
        const type = dataServiceRecord[1] === "dapis" ? "DAPI" : "XAPI",
          service = dataServices.detail(dataServiceRecord[2]),
          action = dataServiceRecord[3];
        if (service.serviceType !== type)
          throw fail(404, "未找到当前类型的数据服务");
        if (method === "GET" && !action) return json(res, 200, service);
        if (method === "GET" && action === "openapi")
          return json(
            res,
            200,
            dataServices.openApi(
              service.id,
              `http://${req.headers.host ?? "127.0.0.1:3100"}`,
            ),
          );
        if (method === "GET" && action === "calls")
          return json(res, 200, dataServices.listCalls(service.id));
        if (method === "POST" && action === "versions") {
          const body = await readBody(req),
            key = text(req.headers["idempotency-key"], 1, 100),
            dedup = store.deduplicate(
              `${PROJECT}:${type.toLowerCase()}-version:${service.id}:${key}`,
              hash(JSON.stringify(body)),
              () =>
                type === "DAPI"
                  ? dataServices.createDapiVersion(service.id, body)
                  : dataServices.createXapiVersion(service.id, body),
            );
          return json(res, dedup.replayed ? 200 : 201, get("data_service_version", dedup.id));
        }
        if (method === "POST" && action === "test")
          return json(res, 200, await dataServices.test(service.id, await readBody(req)));
        if (method === "POST" && action === "publish")
          return json(res, 200, dataServices.publish(service.id));
        if (method === "POST" && action === "activate") {
          const body = await readBody(req);
          return json(
            res,
            200,
            dataServices.activate(
              service.id,
              text(body.versionId, 1, 80),
            ),
          );
        }
      }
      if (path === "/api/v2/delivery/packages" && method === "POST") {
        const body = await readBody(req),
          sourceRun = get("run", text(body.sourceRunId, 1, 80));
        const name =
          body.name === undefined ? "客户资产 T+1" : text(body.name, 1, 80);
        const bundle = createDeliveryPackage({
          run: sourceRun,
          revision: get("revision", sourceRun.revisionId),
          name,
        });
        const key = text(req.headers["idempotency-key"], 1, 100);
        const dedup = store.deduplicate(
          PROJECT + ":delivery:" + key,
          hash(
            JSON.stringify({
              sourceRunId: sourceRun.id,
              name,
              validationContractId,
            }),
          ),
          () =>
            store.create("delivery_package", PROJECT, {
              ...bundle,
              sourceRunId: sourceRun.id,
              stage: "M2A",
              published: false,
            }),
        );
        return json(
          res,
          dedup.replayed ? 200 : 201,
          get("delivery_package", dedup.id),
        );
      }
      const deliveryRecord = path.match(
        /^\/api\/v2\/delivery\/(packages|verifications)\/([a-f0-9-]+)(?:\/(verify|cancel|approve))?$/,
      );
      if (deliveryRecord) {
        const kind =
          deliveryRecord[1] === "packages"
            ? "delivery_package"
            : "delivery_verification";
        const item = get(kind, deliveryRecord[2]);
        if (method === "GET" && !deliveryRecord[3]) return json(res, 200, item);
        if (
          kind === "delivery_verification" &&
          deliveryRecord[3] === "cancel" &&
          method === "POST"
        ) {
          if (!terminal.has(item.status)) {
            store.update(kind, item.id, PROJECT, { status: "CANCELLED" });
            controls.get(item.id)?.abort();
          }
          return json(res, 200, get(kind, item.id));
        }
        if (
          kind === "delivery_package" &&
          deliveryRecord[3] === "approve" &&
          method === "POST"
        ) {
          const body = await readBody(req),
            packageDigest = text(body.packageDigest, 64, 64);
          if (packageDigest !== item.digest)
            throw fail(409, "审批摘要与当前交付包不一致");
          validateDeliveryPackage(item, item.digest);
          const rehearsal = store
            .list("delivery_verification", PROJECT)
            .find(
              (record) =>
                record.packageId === item.id &&
                record.packageDigest === item.digest &&
                record.status === "SUCCEEDED",
            );
          if (!rehearsal)
            throw fail(409, "交付包尚无成功的按文件演练，不能审批发布");
          const reviewNote =
            body.reviewNote === undefined
              ? "已审阅代码版本、文件摘要和本机演练证据"
              : text(body.reviewNote, 4, 500);
          const existingApproval = store
            .list("release_approval", PROJECT)
            .find(
              (approval) =>
                approval.packageId === item.id &&
                approval.packageDigest === item.digest &&
                approval.status === "APPROVED",
            );
          if (existingApproval) return json(res, 200, existingApproval);
          const key = text(req.headers["idempotency-key"], 1, 100),
            dedup = store.deduplicate(
              PROJECT + ":release-approval:" + key,
              hash(
                JSON.stringify({
                  packageId: item.id,
                  packageDigest: item.digest,
                  rehearsalId: rehearsal.id,
                  reviewNote,
                }),
              ),
              () =>
                store.create("release_approval", PROJECT, {
                  packageId: item.id,
                  packageDigest: item.digest,
                  rehearsalId: rehearsal.id,
                  sourceRevisionId: item.manifest.source.revisionId,
                  sourceSqlHash: item.manifest.source.sqlHash,
                  reviewer: "local-engineer",
                  decision: "APPROVED",
                  status: "APPROVED",
                  reviewNote,
                  approvedAt: new Date().toISOString(),
                  scope: "LOCAL_TEST_RELEASE",
                  publicDeploymentApproved: false,
                }),
            );
          return json(
            res,
            dedup.replayed ? 200 : 201,
            get("release_approval", dedup.id),
          );
        }
        if (
          kind === "delivery_package" &&
          deliveryRecord[3] === "verify" &&
          method === "POST"
        ) {
          const body = await readBody(req),
            scheduledFor = text(body.scheduledFor, 1, 50);
          const plan = validateDeliveryPackage(item, item.digest),
            occurrence = resolveDeliverySchedule(plan, scheduledFor);
          if (!occurrence.eligible) throw fail(422, "样例非交易日，未提交执行");
          if (occurrence.businessDate !== plan.fixtures.context.businessDate)
            throw fail(
              422,
              "T+1业务日与冻结输入不一致，请使用交付包中的样例演练时刻",
            );
          if (!options.deliveryRunner && !runtime.available)
            throw fail(503, "Spark 尚未就绪");
          const key = text(req.headers["idempotency-key"], 1, 100);
          const dedup = store.deduplicate(
            PROJECT + ":delivery-verify:" + key,
            hash(
              JSON.stringify({
                packageId: item.id,
                digest: item.digest,
                scheduledFor,
              }),
            ),
            () =>
              store.create("delivery_verification", PROJECT, {
                packageId: item.id,
                packageDigest: item.digest,
                scheduledFor,
                status: "QUEUED",
                scope: "M2A_LOCAL_FILE_REHEARSAL",
                published: false,
                fullLifecycleE2E: false,
              }),
          );
          const verification = get("delivery_verification", dedup.id);
          if (!dedup.replayed)
            schedule("delivery_verification", verification, async (signal) => {
              const parent = join(root, ".v2-artifacts", "delivery");
              mkdirSync(parent, { recursive: true });
              const directory = unpackDeliveryPackage(
                item,
                join(parent, verification.id),
                item.digest,
              );
              const executeFiles =
                options.deliveryRunner ??
                ((input) => verifyDeliveryDirectory(input, { runtime }));
              const result = await executeFiles({
                directory,
                expectedDigest: item.digest,
                scheduledFor,
                signal,
              });
              if (
                !["SUCCEEDED", "FAILED", "VALIDATION_FAILED"].includes(
                  result.status,
                )
              )
                throw new Error("文件执行器返回无效状态");
              if (
                get("delivery_verification", verification.id).status !==
                "CANCELLED"
              )
                store.update(
                  "delivery_verification",
                  verification.id,
                  PROJECT,
                  {
                    ...result,
                    published: false,
                    fullLifecycleE2E: false,
                    finishedAt: new Date().toISOString(),
                  },
                );
            });
          return json(res, 202, verification);
        }
      }
      if (path === "/api/v2/releases" && method === "POST") {
        const body = await readBody(req),
          approval = get(
            "release_approval",
            text(body.approvalId, 1, 80),
          ),
          item = get("delivery_package", approval.packageId),
          spec = localScheduleSpec(body),
          plan = validateDeliveryPackage(item, item.digest);
        if (
          approval.status !== "APPROVED" ||
          approval.packageDigest !== item.digest ||
          approval.sourceSqlHash !== item.manifest.source.sqlHash
        )
          throw fail(409, "审批记录未绑定当前不可变交付包");
        if (approval.consumedByReleaseId) {
          const existing = get("release", approval.consumedByReleaseId);
          if (
            existing.packageId === item.id &&
            existing.packageDigest === item.digest &&
            JSON.stringify(existing.scheduleSpec) === JSON.stringify(spec)
          )
            return json(res, 200, expose(existing));
          throw fail(409, "该审批已绑定其他发布参数，不能重复使用");
        }
        const businessDay = plan.fixtures.context.businessDate,
          calendarIndex = plan.calendar.tradingDays.indexOf(businessDay),
          nextTradingDay = plan.calendar.tradingDays[calendarIndex + 1];
        if (!nextTradingDay)
          throw fail(422, "样例日历缺少业务日后的下一个交易日");
        const businessScheduledFor =
            nextTradingDay + "T" + plan.schedule.at + "+08:00",
          key = text(req.headers["idempotency-key"], 1, 100),
          dedup = store.deduplicate(
            PROJECT + ":release:" + key,
            hash(
              JSON.stringify({
                approvalId: approval.id,
                packageId: item.id,
                packageDigest: item.digest,
                spec,
              }),
            ),
            () =>
              store.create("release", PROJECT, {
                approvalId: approval.id,
                packageId: item.id,
                packageDigest: item.digest,
                sourceRevisionId: item.manifest.source.revisionId,
                sourceSqlHash: item.manifest.source.sqlHash,
                status: "DEPLOYING",
                health: "PENDING",
                environment: "local-scheduled-test",
                adapter: "local-spark-v1",
                scheduleSpec: spec,
                businessScheduledFor,
                publicDeployed: false,
                fullLifecycleE2E: false,
              }),
          );
        let release = get("release", dedup.id);
        if (!dedup.replayed) {
          try {
            const parent = join(root, ".v2-artifacts", "releases");
            mkdirSync(parent, { recursive: true });
            const artifactDirectory = unpackDeliveryPackage(
              item,
              join(parent, release.id),
              item.digest,
            );
            for (const previous of store.list("release", PROJECT)) {
              if (
                previous.id !== release.id &&
                previous.status === "ACTIVE_LOCAL"
              ) {
                releaseScheduler.cancelRelease(
                  previous.id,
                  "已由新发布版本替代",
                );
                store.update("release", previous.id, PROJECT, {
                  status: "SUPERSEDED_LOCAL",
                  supersededByReleaseId: release.id,
                  supersededAt: new Date().toISOString(),
                });
              }
            }
            release = store.update("release", release.id, PROJECT, {
              status: "ACTIVE_LOCAL",
              health: "OBSERVING",
              artifactDirectory,
              activatedAt: new Date().toISOString(),
            });
            store.update("release_approval", approval.id, PROJECT, {
              consumedByReleaseId: release.id,
              consumedAt: new Date().toISOString(),
            });
            const planned = plannedLocalRuns({
              releaseId: release.id,
              packageId: item.id,
              packageDigest: item.digest,
              businessScheduledFor,
              spec,
              nowMs: options.now?.() ?? Date.now(),
              timeUnitMs: releaseTimeUnitMs,
            });
            for (const runData of planned) {
              const run = store.create("release_run", PROJECT, runData);
              releaseScheduler.schedule(run);
            }
          } catch (error) {
            store.update("release", release.id, PROJECT, {
              status: "FAILED_LOCAL",
              error: error.message,
              finishedAt: new Date().toISOString(),
            });
            throw error;
          }
        }
        return json(res, dedup.replayed ? 200 : 201, expose(release));
      }
      const releaseRecord = path.match(
        /^\/api\/v2\/(releases|release\/runs)\/([a-f0-9-]+)(?:\/(rollback))?$/,
      );
      if (releaseRecord) {
        const kind =
            releaseRecord[1] === "releases" ? "release" : "release_run",
          item = get(kind, releaseRecord[2]);
        if (method === "GET" && !releaseRecord[3])
          return json(res, 200, expose(item));
        if (
          kind === "release" &&
          releaseRecord[3] === "rollback" &&
          method === "POST"
        ) {
          const body = await readBody(req),
            target = get("release", text(body.targetReleaseId, 1, 80));
          if (item.status !== "ACTIVE_LOCAL")
            throw fail(409, "只能回滚当前生效的本机发布版本");
          if (
            target.id === item.id ||
            !["SUPERSEDED_LOCAL", "ROLLED_BACK_LOCAL"].includes(
              target.status,
            ) ||
            Number(target.successfulRunCount ?? 0) < 1
          )
            throw fail(409, "回滚目标必须是已有成功批次的历史发布版本");
          const spec = localScheduleSpec({
            triggerAfterSeconds: body.triggerAfterSeconds ?? 2,
            intervalSeconds: body.intervalSeconds ?? 10,
            runCount: 2,
          });
          releaseScheduler.cancelRelease(item.id, "当前版本已执行回滚");
          store.update("release", item.id, PROJECT, {
            status: "ROLLED_BACK_LOCAL",
            rolledBackToReleaseId: target.id,
            rolledBackAt: new Date().toISOString(),
          });
          const restored = store.update("release", target.id, PROJECT, {
            status: "ACTIVE_LOCAL",
            health: "OBSERVING",
            restoredFromReleaseId: item.id,
            restoredAt: new Date().toISOString(),
          });
          const resolvedAlertIds = [];
          for (const alert of store.list("monitor_alert", PROJECT)) {
            if (alert.releaseId === item.id && alert.status === "OPEN") {
              resolvedAlertIds.push(alert.id);
              store.update("monitor_alert", alert.id, PROJECT, {
                status: "RESOLVED",
                resolutionMode: "ROLLBACK",
                recoveryReleaseId: restored.id,
                resolvedAt: new Date().toISOString(),
              });
            }
          }
          const rollback = store.create("release_rollback", PROJECT, {
            fromReleaseId: item.id,
            toReleaseId: target.id,
            actor: "local-engineer",
            reason:
              body.reason === undefined
                ? "恢复到最近已验证版本"
                : text(body.reason, 4, 500),
            status: "SCHEDULED_FOR_VERIFICATION",
            resolvedAlertIds,
          });
          store.create("monitor_event", PROJECT, {
            type: "ROLLBACK_ACTIVATED",
            releaseId: item.id,
            recoveryReleaseId: restored.id,
            rollbackId: rollback.id,
            observedAt: new Date().toISOString(),
            status: "RECOVERY_SCHEDULED",
          });
          const planned = plannedLocalRuns({
            releaseId: restored.id,
            packageId: restored.packageId,
            packageDigest: restored.packageDigest,
            businessScheduledFor: restored.businessScheduledFor,
            spec,
            nowMs: options.now?.() ?? Date.now(),
            timeUnitMs: releaseTimeUnitMs,
            triggerReason: "ROLLBACK_RECOVERY",
          });
          for (const runData of planned) {
            const run = store.create("release_run", PROJECT, runData);
            releaseScheduler.schedule(run);
          }
          return json(res, 202, {
            rollback,
            activeRelease: expose(restored),
          });
        }
      }
      const record = path.match(
        /^\/api\/v2\/(runs|revisions|agent\/tasks)\/([a-f0-9-]+)(?:\/(cancel|bundle))?$/,
      );
      if (record) {
        const kind = {
            runs: "run",
            revisions: "revision",
            "agent/tasks": "agent",
          }[record[1]],
          item = get(kind, record[2]);
        if (method === "GET" && !record[3]) return json(res, 200, item);
        if (
          method === "POST" &&
          record[3] === "cancel" &&
          kind !== "revision"
        ) {
          if (!terminal.has(item.status)) {
            store.update(kind, item.id, PROJECT, { status: "CANCELLED" });
            controls.get(item.id)?.abort();
          }
          return json(res, 200, get(kind, item.id));
        }
        if (method === "GET" && record[3] === "bundle" && kind === "run") {
          if (item.status !== "SUCCEEDED")
            throw fail(409, "只有经过结果验证的运行可以导出验证包");
          const rev = get("revision", item.revisionId);
          return json(res, 200, {
            format: "shuzhan-verification-bundle/v1",
            revision: rev,
            validation: item.validation,
            engine: item.engine,
            engineVersion: item.engineVersion,
            rows: item.rows,
            files: {
              "main.sql": rev.sql,
              "validation.json": JSON.stringify(item.validation, null, 2),
            },
            releaseState: "NOT_PUBLISHED",
            currentValidationContractId: validationContractId,
            requiresRevalidation:
              item.validation?.contractId !== validationContractId,
            notice: "这是代码与验证包。实际调度、部署和发布在 M2 实现。",
          });
        }
      }
      if (method === "POST" && path === "/api/v2/revisions") {
        const body = await readBody(req),
          sql = text(body.sql),
          contextId = text(body.contextId, 1, 80);
        if (!getContext(contextId)) throw fail(400, "请选择有效上下文");
        return json(res, 201, revision(sql, contextId, "MANUAL"));
      }
      if (method === "POST" && path === "/api/v2/runs") {
        const body = await readBody(req),
          rev = get("revision", text(body.revisionId, 1, 80));
        if (!options.runner && !runtime.available)
          throw fail(503, "Spark 尚未就绪，请运行 npm run v2:bootstrap");
        const key = text(req.headers["idempotency-key"], 1, 100),
          signature = hash(JSON.stringify({ revisionId: rev.id }));
        const dedup = store.deduplicate(
          PROJECT + ":run:" + key,
          signature,
          () =>
            store.create("run", PROJECT, {
              validationContractId,
              revisionId: rev.id,
              revisionHash: rev.hash,
              contextId: rev.contextId,
              status: "QUEUED",
            }),
        );
        const run = get("run", dedup.id);
        if (!dedup.replayed)
          schedule("run", run, (signal) => execute(run, rev, signal));
        return json(res, 202, run);
      }
      if (method === "POST" && path === "/api/v2/agent/tasks") {
        const body = await readBody(req),
          message = text(body.message, 4, 2000),
          currentSql = text(body.sql);
        const context = getContext(text(body.contextId, 1, 80));
        if (!context) throw fail(400, "请选择有效上下文");
        if (!options.generator && !modelSettings(env).configured)
          throw new ModelUnavailable();
        if (!options.runner && !runtime.available)
          throw fail(503, "请先准备 Spark 执行环境再运行 Agent");
        const key = text(req.headers["idempotency-key"], 1, 100),
          signature = hash(
            JSON.stringify({ message, currentSql, contextId: context.id }),
          );
        const dedup = store.deduplicate(
          PROJECT + ":agent:" + key,
          signature,
          () =>
            store.create("agent", PROJECT, {
              message,
              contextId: context.id,
              status: "QUEUED",
              attempts: [],
              mode: "LIVE_MODEL",
              completionScope: "SQL_DEVELOPMENT",
              fullLifecycleE2E: false,
              validationContractId,
              maxAttempts: 3,
            }),
        );
        const task = get("agent", dedup.id);
        if (!dedup.replayed)
          schedule("agent", task, async (signal) => {
            let sql = currentSql,
              error,
              usedTokens = 0;
            for (let attempt = 1; attempt <= 3; attempt++) {
              if (signal.aborted) throw new Error("任务已取消");
              const remainingBudget =
                Number(env.V2_MODEL_TOKEN_BUDGET ?? 32000) - usedTokens;
              if (remainingBudget < 1)
                throw new Error("本次 Agent 已达到 Token 预算上限");
              const generated = await generator({
                message,
                context,
                currentSql: sql,
                error,
                signal,
                remainingBudget,
              });
              const reportedTokens = Number(generated.usage?.total_tokens);
              usedTokens +=
                Number.isSafeInteger(reportedTokens) && reportedTokens > 0
                  ? reportedTokens
                  : remainingBudget;
              if (usedTokens > Number(env.V2_MODEL_TOKEN_BUDGET ?? 32000))
                throw new Error("本次 Agent 已达到 Token 预算上限");
              sql = generated.sql;
              const rev = revision(sql, context.id, "LIVE_MODEL");
              const run = store.create("run", PROJECT, {
                validationContractId,
                revisionId: rev.id,
                revisionHash: rev.hash,
                contextId: context.id,
                status: "RUNNING",
                startedAt: new Date().toISOString(),
                agentTaskId: task.id,
              });
              let completed;
              try {
                completed = await execute(run, rev, signal);
              } catch (e) {
                store.update("run", run.id, PROJECT, {
                  status: signal.aborted ? "CANCELLED" : "FAILED",
                  error: e.message,
                });
                throw e;
              }
              const latest = get("agent", task.id),
                attempts = [
                  ...latest.attempts,
                  {
                    attempt,
                    runId: run.id,
                    revisionId: rev.id,
                    status: completed.status,
                    model: generated.model,
                    usage: generated.usage,
                    explanation: generated.explanation,
                  },
                ];
              if (signal.aborted) throw new Error("任务已取消");
              store.update("agent", task.id, PROJECT, {
                attempts,
                revisionId: rev.id,
                sql,
                explanation: generated.explanation,
                usedTokens,
              });
              if (completed.status === "SUCCEEDED") {
                store.update("agent", task.id, PROJECT, {
                  status: "SUCCEEDED",
                  finishedAt: new Date().toISOString(),
                });
                return;
              }
              error =
                completed.error ?? completed.validation?.issues?.join("；");
            }
            store.update("agent", task.id, PROJECT, {
              status: "FAILED",
              error: "三次修正后仍未通过结果断言，请人工检查",
              finishedAt: new Date().toISOString(),
            });
          });
        return json(res, 202, task);
      }
      if (path.startsWith("/api/v2")) throw fail(404, "接口不存在");
      if (method !== "GET") throw fail(405, "请求方法不支持");
      const relative = decodeURIComponent(path).replace(/^\/v2\/?/, "");
      const base = resolve(root, "web-dist"),
        file = resolve(base, relative || "index.html");
      if (file !== base && !file.startsWith(base + "/"))
        throw fail(404, "页面不存在");
      let content;
      try {
        content = await readFile(file);
      } catch {
        if (extname(file)) throw fail(404, "静态资源不存在");
        content = await readFile(join(base, "index.html"));
      }
      res.writeHead(200, {
        "Content-Type":
          {
            ".js": "text/javascript",
            ".css": "text/css",
            ".html": "text/html",
            ".svg": "image/svg+xml",
          }[extname(file)] ?? "text/html",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-cache",
      });
      res.end(content);
    } catch (error) {
      return json(res, error.status ?? 500, {
        message: error.status ? error.message : "处理失败，请检查服务日志",
        ...(typeof error.code === "string" &&
        /^[A-Z][A-Z0-9_]{2,64}$/.test(error.code)
          ? { code: error.code }
          : {}),
        ...(typeof error.runId === "string" ? { runId: error.runId } : {}),
        ...(typeof error.auditId === "string" ? { auditId: error.auditId } : {}),
      }).finally(() => {
        if (!error.status) console.error(error.message);
      });
    }
  });
  server.on("close", () => {
    for (const c of controls.values()) c.abort();
    releaseScheduler.shutdown();
    realtime.shutdown();
    if (ownsBusinessStore) businessStore.close();
    if (ownsLandingStore) landingStore.close();
    if (ownsStreamStateStore) streamStateStore.close();
    if (ownsReportStore) reportStore.close();
  });
  return {
    server,
    store,
    host,
    releaseScheduler,
    dataServices,
    businessStore,
    ingestion,
    landingStore,
    realtime,
    streamStateStore,
    assets,
    quality,
    security,
    reports,
    reportStore,
    operations,
    auth,
    stateCoordinator: options.stateCoordinator,
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { server, host } = createV2Server();
  server.listen(Number(process.env.V2_PORT ?? 3100), host, () =>
    console.log(
      "Shuzhan V2 ready on http://" +
        host +
        ":" +
        (process.env.V2_PORT ?? 3100) +
        "/v2/",
    ),
  );
}
