#!/usr/bin/env node
// Temporary account-restricted Cloud Shell bridge, not a public deployment.
// Compatible with Cloud Shell Node 14; uses no credentials outside its CLI.
import http from "node:http";
import { spawn } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import { fileURLToPath } from "node:url";

const error = (status, message) => Object.assign(new Error(message), { status });
const uuid = "[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}";
const reads = new RegExp(`^/api/v2/(?:status|budget|contexts|auth/session|revisions|runs|(?:runs|revisions)/${uuid})$`);
const writes = new RegExp(`^/api/v2/(?:auth/(?:login|logout)|revisions|runs|runs/${uuid}/cancel)$`);
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".ttf": "font/ttf" };
// On Linux Node's child stdin is a socket: reopening /dev/stdin fails ENXIO.
// Python reads that descriptor directly, then supplies a real anonymous pipe
// to the CLI. Neither credentials nor request bodies are written to disk.
export const pipeBridge = "import subprocess,sys; p=subprocess.Popen(sys.argv[1:],stdin=subprocess.PIPE); p.communicate(sys.stdin.buffer.read()); sys.exit(p.returncode)";

export function privatePayload(method, path, headers, body) {
  if (!(method === "GET" ? reads : method === "POST" ? writes : /$a/).test(path))
    throw error(404, "此接口尚未接入私有预览");
  const forwarded = { "x-shuduo-client": "workbench" };
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
  return { operation: "PRIVATE_APPLICATION_HTTP_V1", method, path, headers: forwarded, ...(method === "POST" ? { body } : {}) };
}

export function invokePrivate(payload, spawnImpl = spawn) {
  return new Promise((resolveResult, reject) => {
    // /dev/stdin keeps passwords, session cookies and SQL out of process argv,
    // shell history and temporary files. No shell expansion is involved.
    const child = spawnImpl("python3", ["-c", pipeBridge, "aliyun", "fc", "POST", "/2023-03-30/functions/dataplatform-v2-staging-api/invocations",
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

export function createPreviewServer({ origin, webRoot, invoke = invokePrivate, maxCalls = 200 }) {
  const expected = new URL(origin);
  if (origin !== expected.origin || expected.username || expected.password ||
      !(expected.protocol === "https:" || (expected.protocol === "http:" && ["127.0.0.1", "localhost"].includes(expected.hostname))))
    throw new Error("An exact HTTPS preview origin is required (HTTP loopback for local tests only)");
  let tail = Promise.resolve(), waiting = 0, calls = 0;
  const rootPromise = realpath(webRoot);
  const server = http.createServer(async (req, res) => {
    const send = (status, body, cookies = []) => {
      if (res.destroyed) return;
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...(cookies.length ? { "Set-Cookie": cookies } : {}) });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.headers.host !== expected.host) throw error(403, "访问地址不匹配");
      if (req.headers.origin && req.headers.origin !== origin) throw error(403, "拒绝跨站请求");
      if (req.headers["sec-fetch-site"] === "cross-site") throw error(403, "拒绝跨站请求");
      const path = req.url || "/";
      if (path.startsWith("/api/")) {
        if (req.headers["x-shuduo-client"] !== "workbench") throw error(403, "仅允许工作台请求");
        if (req.method === "POST" && (req.headers.origin !== origin || !/^application\/json(?:;|$)/i.test(req.headers["content-type"] || ""))) throw error(403, "写入必须来自当前工作台");
        // Validate route before consuming any input or invoking the CLI.
        if (!(req.method === "GET" ? reads : req.method === "POST" ? writes : /$a/).test(path)) throw error(404, "此接口尚未接入私有预览");
        let body;
        if (req.method === "POST") {
          let size = 0, chunks = [];
          for await (const chunk of req) { size += chunk.length; if (size > 64000) throw error(413, "请求内容过大"); chunks.push(chunk); }
          try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw error(400, "JSON 格式无效"); }
        }
        const payload = privatePayload(req.method, path, req.headers, body);
        if (waiting >= 8 || calls >= maxCalls) throw error(429, "本次预览调用额度已达上限，请稍后核查后重启预览");
        waiting++; calls++;
        const action = tail.then(() => invoke(payload));
        tail = action.catch(() => {});
        try {
          const result = await action;
          const cookies = result.cookies.filter(c => typeof c === "string" && /^shuduo_(session|csrf)=/.test(c) && !/[\r\n]/.test(c));
          send(result.status, result.body, cookies);
        } finally { waiting--; }
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") throw error(405, "不支持此操作");
      if (path === "/") { res.writeHead(302, { Location: "/v2/?module=development" }); res.end(); return; }
      const pathname = path.split("?")[0];
      if (pathname !== "/v2/" && !/^\/v2\/assets\/[A-Za-z0-9_.-]+$/.test(pathname)) throw error(404, "页面不存在");
      const root = await rootPromise;
      const file = await realpath(resolve(root, pathname === "/v2/" ? "index.html" : pathname.slice(4)));
      if (!file.startsWith(root + sep)) throw error(403, "文件路径不允许");
      let content = await readFile(file);
      if (pathname === "/v2/") content = Buffer.from(content.toString().replace("<head>", '<head><meta name="shuduo-private-preview" content="true">'));
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
  const server = createPreviewServer({ origin, webRoot: resolve(fileURLToPath(new URL("../web-dist", import.meta.url))) });
  server.listen(port, "0.0.0.0", () => console.log("数舵私有预览已启动；45 分钟后自动停止，最多 200 次云端请求。不记录密码、Cookie 或请求正文。"));
  setTimeout(() => server.close(), 45 * 60 * 1000).unref();
}
