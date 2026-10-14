#!/usr/bin/env node
// Temporary account-restricted Cloud Shell bridge, not a public deployment.
// Compatible with Cloud Shell Node 14; uses no credentials outside its CLI.
import http from "node:http";
import { spawn } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { privateServiceRoute } from "../src/v2/private-service-routes.mjs";

const error = (status, message) => Object.assign(new Error(message), { status });
const uuid = "[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}";
const reads = new RegExp(`^/api/v2/(?:status|budget|contexts|auth/session|revisions|runs|(?:runs|revisions)/${uuid})$`);
const writes = new RegExp(`^/api/v2/(?:auth/(?:login|logout)|revisions|runs|runs/${uuid}/cancel)$`);
const agentReads = new RegExp(`^/api/v2/agent/(?:tasks(?:/${uuid}(?:/(?:workflow|publication|background))?)?|deliveries/${uuid})$`);
const agentWrites = new RegExp(`^/api/v2/agent/(?:tasks(?:/${uuid}/(?:advance|cancel|prepare-delivery|publication(?:/cancel)?|background(?:/(?:cancel|resume))?))?|deliveries/${uuid}/(?:advance|cancel))$`);
const routeAllowed = (method, path, allowAgent, allowDataServices) => (method === "GET" ? reads : method === "POST" ? writes : /$a/).test(path) ||
  (allowAgent && (method === "GET" ? agentReads : method === "POST" ? agentWrites : /$a/).test(path)) || (allowDataServices && privateServiceRoute(method,path));
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".ttf": "font/ttf" };

// Native same-origin attachments avoid unsupported blob downloads in embedded
// browsers. This is only a transport adapter: normal backend authorization is
// still mandatory, and callers cannot select an arbitrary URL or file path.
export function privateEvidenceExport(path) {
  if (!path.startsWith("/api/v2/evidence-export")) return undefined;
  const u = new URL(path, "http://127.0.0.1"), keys = [...u.searchParams.keys()];
  if (path.length > 700 || u.pathname !== "/api/v2/evidence-export" || /[#\\]/.test(path) || new Set(keys).size !== keys.length) throw error(422, "导出参数无效");
  const id = u.searchParams.get("id"), kind = u.searchParams.get("kind");
  if (!new RegExp(`^${uuid}$`).test(id || "")) throw error(422, "导出编号无效");
  if (kind === "recovery" && keys.length === 3 && keys.every(k => ["kind", "type", "id"].includes(k)) && ["dapi", "xapi"].includes(u.searchParams.get("type"))) {
    return { kind, id, path: `/api/v2/data-services/${u.searchParams.get("type")}s/${id}/recovery`, name: `service-recovery-${id.slice(0, 8)}.json` };
  }
  const digest = u.searchParams.get("digest");
  if (kind === "consumption" && keys.length === 3 && keys.every(k => ["kind", "id", "digest"].includes(k)) && /^[a-f0-9]{64}$/.test(digest || "")) {
    return { kind, id, digest, path: `/api/v2/data-services/task-evidence?agent_task_id=${id}&package_digest=${digest}`, name: `consumption-${id.slice(0, 8)}.json` };
  }
  throw error(422, "导出范围无效");
}

export function exportedEvidence(result, request) {
  const body = result.body;
  const valid = body?.scope === "PRIVATE_CLOUD_TEST" && body.publicDeployed === false && (request.kind === "recovery"
    ? body.protocol === "shuduo-private-service-recovery/v1" && body.state?.serviceId === request.id
    : body.protocol === "shuduo-private-task-consumption/v1" && body.taskId === request.id && body.packageDigest === request.digest);
  if (!valid) throw error(502, "报告来源与导出请求不一致，未生成文件");
  const text = JSON.stringify(body, null, 2) + "\n";
  if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw error(413, "报告超过导出上限");
  return { text, sha256: createHash("sha256").update(text).digest("hex") };
}
// On Linux Node's child stdin is a socket: reopening /dev/stdin fails ENXIO.
// Python reads that descriptor directly, then supplies a real anonymous pipe
// to the CLI. Neither credentials nor request bodies are written to disk.
export const pipeBridge = "import subprocess,sys; p=subprocess.Popen(sys.argv[1:],stdin=subprocess.PIPE); p.communicate(sys.stdin.buffer.read()); sys.exit(p.returncode)";

export function privatePayload(method, path, headers, body, { allowAgent = false, allowDataServices = false } = {}) {
  if (!routeAllowed(method, path, allowAgent, allowDataServices))
    throw error(404, "此接口尚未接入私有预览");
  const forwarded = { "x-shuduo-client": "workbench" };
  if(allowDataServices && method==="GET" && path.startsWith("/api/v2/open/") && headers.authorization) {
    if(typeof headers.authorization!=="string" || headers.authorization.length>4096 || /[\r\n]/.test(headers.authorization))throw error(400,"应用认证头无效");
    forwarded.authorization=headers.authorization;
  }
  for (const key of ["x-csrf-token", "idempotency-key", "x-project-id"]) {
    if (headers[key]) {
      if (typeof headers[key] !== "string" || headers[key].length > 4096 || /[\r\n]/.test(headers[key])) throw error(400, "请求头无效");
      forwarded[key] = headers[key];
    }
  }
  // Never forward the Cloud Shell account's own cookies to the application.
  const cookies = String(headers.cookie || "").split(";").map(s => s.trim())
    .filter(s => /^shuduo_(session|csrf)=[A-Za-z0-9_-]+$/.test(s));
  if (cookies.length) forwarded.cookie = cookies.join("; ");
  if (method === "POST" && (!body || typeof body !== "object" || Array.isArray(body))) throw error(422, "请求内容必须为 JSON 对象");
  if (method === "POST" && path === "/api/v2/agent/tasks" && (body.language || "SPARK_SQL") !== "SPARK_SQL") throw error(422, "此预览仅支持 Spark SQL Agent");
  return { operation: "PRIVATE_APPLICATION_HTTP_V1", method, path, headers: forwarded, ...(method === "POST" ? { body } : {}) };
}

export function invokePrivate(payload, spawnImpl = spawn, functionName = process.env.SHUDUO_PRIVATE_PREVIEW_FUNCTION) {
  if (typeof functionName !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(functionName))
    return Promise.reject(error(503, "请先配置已核验的私有函数名称"));
  return new Promise((resolveResult, reject) => {
    // /dev/stdin keeps passwords, session cookies and SQL out of process argv,
    // shell history and temporary files. No shell expansion is involved.
    const child = spawnImpl("python3", ["-c", pipeBridge, "aliyun", "fc", "POST", `/2023-03-30/functions/${functionName}/invocations`,
      "--region", "cn-hangzhou", "--read-timeout", "140", "--connect-timeout", "10", "--retry-count", "0",
      "--header", "Content-Type=application/octet-stream", "--body-file", "/dev/stdin"], { stdio: ["pipe", "pipe", "pipe"], detached: true });
    let output = "", bytes = 0, finished = false;
    const fail = () => {
      if (finished) return;
      finished = true; clearTimeout(timer);
      // Kill only this invocation's dedicated process group, including the CLI.
      try { if (child.pid) process.kill(-child.pid, "SIGTERM"); else child.kill(); } catch { /* already exited */ }
      reject(error(502, "云端调用未确认，请查看任务历史后再试；不要重复提交"));
    };
    const timer = setTimeout(fail, 150000);
    child.on("error", fail);
    child.stdin.on("error", fail);
    child.stdout.on("data", chunk => { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) fail(); else output += chunk; });
    child.stderr.resume(); // SDK errors can contain credentials; never return/log them.
    child.on("close", code => {
      if (finished) return;
      if (code !== 0) return fail();
      try {
        let result = JSON.parse(output);
        if (typeof result === "string") result = JSON.parse(result);
        if (result.protocol !== "shuduo-private-application-http/v1" || !Number.isInteger(result.status) || result.status < 200 || result.status > 599 || !Array.isArray(result.cookies)) throw new Error();
        finished = true; clearTimeout(timer); resolveResult(result);
      } catch { fail(); }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

export function createPreviewServer({ origin, webRoot, invoke = invokePrivate, maxCalls = 200, localProxyPort, allowAgent = false, allowDataServices = false }) {
  const expected = new URL(origin);
  if (origin !== expected.origin || expected.username || expected.password ||
      !(expected.protocol === "https:" || (expected.protocol === "http:" && ["127.0.0.1", "localhost"].includes(expected.hostname))))
    throw new Error("An exact HTTPS preview origin is required (HTTP loopback for local tests only)");
  // Cloud Shell preserves the browser Origin but rewrites Host to loopback.
  // Enable this only for the matching official preview origin and fixed port.
  if (localProxyPort !== undefined && (![60000, 61000, 62000, 63000, 64000, 65000].includes(localProxyPort) ||
      expected.protocol !== "https:" || expected.port ||
      !new RegExp(`^${localProxyPort}-dot-[a-z0-9]+\\.shell\\.aliyuncs\\.com$`).test(expected.hostname)))
    throw new Error("Loopback proxy requires a matching official Cloud Shell preview origin");
  let tail = Promise.resolve(), waiting = 0, calls = 0;
  const rootPromise = realpath(webRoot);
  const server = http.createServer(async (req, res) => {
    const send = (status, body, cookies = []) => {
      if (res.destroyed) return;
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...(cookies.length ? { "Set-Cookie": cookies } : {}) });
      res.end(JSON.stringify(body));
    };
    try {
      const trustedLocalProxy = localProxyPort !== undefined && req.headers.host === `127.0.0.1:${localProxyPort}` && req.headers["x-forwarded-proto"] === "https";
      if (req.headers.host !== expected.host && !trustedLocalProxy) throw error(403, "访问地址不匹配");
      if (req.headers.origin && req.headers.origin !== origin) throw error(403, "拒绝跨站请求");
      const path = req.url || "/";
      if (path.startsWith("/api/")) {
        if (req.headers["sec-fetch-site"] === "cross-site") throw error(403, "拒绝跨站请求");
        const exportRequest = allowDataServices && req.method === "GET" ? privateEvidenceExport(path) : undefined;
        const backendPath = exportRequest?.path || path;
        const applicationQuery=allowDataServices && req.method==="GET" && path.startsWith("/api/v2/open/") && privateServiceRoute(req.method,path);
        if (!applicationQuery && !exportRequest && req.headers["x-shuduo-client"] !== "workbench") throw error(403, "仅允许工作台请求");
        if (req.method === "POST" && (req.headers.origin !== origin || !/^application\/json(?:;|$)/i.test(req.headers["content-type"] || ""))) throw error(403, "写入必须来自当前工作台");
        // Validate route before consuming any input or invoking the CLI.
        if (!routeAllowed(req.method, backendPath, allowAgent, allowDataServices)) throw error(404, "此接口尚未接入私有预览");
        let body;
        if (req.method === "POST") {
          let size = 0, chunks = [];
          for await (const chunk of req) { size += chunk.length; if (size > 64000) throw error(413, "请求内容过大"); chunks.push(chunk); }
          try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw error(400, "JSON 格式无效"); }
        }
        const payload = privatePayload(req.method, backendPath, req.headers, body, { allowAgent, allowDataServices });
        if (waiting >= 8 || calls >= maxCalls) throw error(429, "本次预览调用额度已达上限，请稍后核查后重启预览");
        waiting++; calls++;
        const action = tail.then(() => invoke(payload));
        tail = action.catch(() => {});
        try {
          const result = await action;
          const cookies = result.cookies.filter(c => typeof c === "string" && /^shuduo_(session|csrf)=/.test(c) && !/[\r\n]/.test(c));
          if (exportRequest && result.status === 200) {
            const exported = exportedEvidence(result, exportRequest);
            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="${exportRequest.name}"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Shuduo-Evidence-Sha256": exported.sha256, ...(cookies.length ? { "Set-Cookie": cookies } : {}) });
            res.end(exported.text);
            return;
          }
          send(result.status, result.body, cookies);
        } finally { waiting--; }
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") throw error(405, "不支持此操作");
      if (path === "/") { res.writeHead(302, { Location: `/v2/?module=${allowAgent ? "agent-center" : "development"}` }); res.end(); return; }
      const pathname = path.split("?")[0];
      if (pathname !== "/v2/" && !/^\/v2\/assets\/[A-Za-z0-9_.-]+$/.test(pathname)) throw error(404, "页面不存在");
      const root = await rootPromise;
      const file = await realpath(resolve(root, pathname === "/v2/" ? "index.html" : pathname.slice(4)));
      if (!file.startsWith(root + sep)) throw error(403, "文件路径不允许");
      let content = await readFile(file);
      if (pathname === "/v2/") content = Buffer.from(content.toString().replace("<head>", '<head><meta name="shuduo-private-preview" content="true">' + (allowAgent ? '<meta name="shuduo-agent-development" content="true">' : "") + (allowDataServices ? '<meta name="shuduo-private-services" content="true">' : "")));
      res.writeHead(200, { "Content-Type": types[extname(file)] || "application/octet-stream", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY", "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
      res.end(req.method === "HEAD" ? undefined : content);
    } catch (cause) {
      send(cause.status || 502, { message: cause.status ? cause.message : "预览服务暂不可用，请检查 Cloud Shell 会话；输入不会自动重发" });
    }
  });
  server.requestTimeout = 160000;
  server.headersTimeout = 10000;
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = name => args[args.indexOf(name) + 1];
  if (!args.includes("--origin")) throw new Error("Pass --origin with the verified account-restricted HTTPS Web Preview origin");
  const origin = option("--origin"), port = Number(args.includes("--port") ? option("--port") : 60000);
  if (![60000, 61000, 62000, 63000, 64000, 65000].includes(port)) throw new Error("Unsupported Cloud Shell preview port");
  const server = createPreviewServer({ origin, localProxyPort: port, allowAgent: args.includes("--agent-development"), allowDataServices:args.includes("--data-services"), webRoot: resolve(fileURLToPath(new URL("../web-dist", import.meta.url))) });
  // The managed preview gateway reaches the VM interface even though it sends
  // a loopback Host. Host/Origin gates above remain mandatory on all requests.
  server.listen(port, "0.0.0.0", () => console.log("数舵私有预览已启动；45 分钟后自动停止，最多 200 次云端请求。不记录密码、Cookie 或请求正文。"));
  setTimeout(() => server.close(), 45 * 60 * 1000).unref();
}
