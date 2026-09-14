import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
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
import { generateSql, modelSettings, ModelUnavailable } from "./model.mjs";
import { capabilities } from "./capabilities.mjs";
import { saveLocalModelKey } from "./model-credentials.mjs";

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
const json = (res, status, data) => {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(data));
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
  const host = env.V2_HOST ?? "127.0.0.1",
    local = env.V2_LOCAL_DEVELOPMENT !== "false";
  if (local && !["127.0.0.1", "localhost", "::1"].includes(host))
    throw new Error("本地开发会话只能绑定回环地址");
  if (env.V2_META_DRIVER && env.V2_META_DRIVER !== "sqlite")
    throw new Error(
      "云端 MySQL 元数据库尚未接入，本地启动不会回退或假报云端就绪",
    );
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
      const origin = req.headers.origin;
      if (
        origin &&
        !/^http:\/\/(localhost|127\.0\.0\.1):(3100|5173)$/.test(origin)
      )
        throw fail(403, "请求来源不允许");
      if (
        req.headers["x-project-id"] &&
        req.headers["x-project-id"] !== PROJECT
      )
        throw fail(403, "无权访问此项目");
      if (method !== "GET") {
        const hostname = new URL("http://" + req.headers.host).hostname;
        if (!local || !["127.0.0.1", "localhost", "[::1]"].includes(hostname))
          throw fail(403, "当前公开模式只读；邀请认证与隔离执行尚未开放");
        if (req.headers["x-shuzhan-client"] !== "workbench")
          throw fail(403, "缺少客户端校验");
      }
      if (path === "/api/v2/status" && method === "GET")
        return json(res, 200, {
          projectId: PROJECT,
          mode: local ? "LOCAL_DEVELOPMENT" : "PUBLIC_READONLY",
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
          metadata: { driver: "sqlite", cloudVerified: false },
          publicReady: false,
          validationContract: {
            id: validationContractId,
            fixtureCount: contextIds.length,
          },
        });
      if (path === "/api/v2/contexts" && method === "GET")
        return json(res, 200, contextIds.map(publicContext));
      if (path === "/api/v2/settings/model-key" && method === "POST") {
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
      json(res, error.status ?? 500, {
        message: error.status ? error.message : "处理失败，请检查服务日志",
        ...(typeof error.code === "string" &&
        error.code.startsWith("MODEL_KEY_")
          ? { code: error.code }
          : {}),
      });
      if (!error.status) console.error(error.message);
    }
  });
  server.on("close", () => {
    for (const c of controls.values()) c.abort();
  });
  return { server, store, host };
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
