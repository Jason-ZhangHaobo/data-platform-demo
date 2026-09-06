import { createServer as createHttpServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { FileTaskStore } from "./repositories/file-store.mjs";
import { OssTaskStore, StorageConflictError, ossConfigFromEnvironment } from "./repositories/oss-store.mjs";
import { createApiController } from "./api-controller.mjs";
import { createCsvMySqlSyncService } from "./services/csv-mysql-sync.mjs";
import { ValidationError } from "../shared/validation.mjs";

const defaultClientDirectory = fileURLToPath(new URL("../client", import.meta.url));
const contentTypes = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

function corsHeaders(request) {
  const configured = process.env.CORS_ALLOW_ORIGIN ?? "*";
  const origin = request.headers.origin;
  const allowed = configured === "*"
    ? "*"
    : configured.split(",").map((item) => item.trim()).includes(origin) ? origin : "null";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Expose-Headers": "Date, X-Fc-Request-Id",
    Vary: "Origin",
  };
}

function json(response, status, body, request) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", ...corsHeaders(request) });
  response.end(body === undefined ? undefined : JSON.stringify(body));
}

async function readJson(request) {
  let raw = "";
  for await (const chunk of request) {
    raw += chunk;
    if (raw.length > 131_072) throw Object.assign(new Error("请求内容过大"), { status: 413 });
  }
  try { return raw ? JSON.parse(raw) : {}; }
  catch { throw Object.assign(new Error("JSON 格式错误"), { status: 400 }); }
}

async function serveStatic(response, pathname, clientDirectory) {
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\//, "");
  const safePath = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, "");
  let filePath = join(clientDirectory, safePath);
  try {
    const content = await readFile(filePath);
    response.writeHead(200, { "Content-Type": contentTypes[extname(filePath)] ?? "application/octet-stream", "Cache-Control": "no-cache", "X-Robots-Tag": "noindex, nofollow" });
    response.end(content);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    if (extname(pathname)) {
      response.writeHead(404, { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" });
      return response.end();
    }
    filePath = join(clientDirectory, "index.html");
    response.writeHead(200, { "Content-Type": contentTypes[".html"], "Cache-Control": "no-cache", "X-Robots-Tag": "noindex, nofollow" });
    response.end(await readFile(filePath));
  }
}

export async function createServer(options = {}) {
  const useOss = process.env.STORAGE_DRIVER === "oss"
    || (process.env.FC_FUNCTION_NAME && process.env.OSS_BUCKET);
  const store = options.store ?? (useOss
    ? await OssTaskStore.open(ossConfigFromEnvironment())
    : await FileTaskStore.open(process.env.DATA_FILE_PATH ?? join(process.cwd(), ".data/store.json")));
  const clientDirectory = options.clientDirectory ?? defaultClientDirectory;
  const realSyncEnabled = process.env.REAL_SYNC_ENABLED === "true";
  const syncService = options.syncService ?? (realSyncEnabled ? await createCsvMySqlSyncService({ clientDirectory }) : undefined);
  const handleApi = createApiController({
    store,
    simulationDelayMs: options.simulationDelayMs ?? Number(process.env.SIMULATION_DELAY_MS ?? 1_200),
    environment: process.env.APP_ENV ?? process.env.DEPLOY_ENV ?? "local",
    accessToken: process.env.DEMO_ACCESS_TOKEN,
    requireAccessToken: process.env.REQUIRE_ACCESS_TOKEN === "true",
    syncService,
    realSyncEnabled,
  });

  return createHttpServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    try {
      if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
        response.writeHead(204, corsHeaders(request));
        return response.end();
      }
      const body = ["POST", "PUT"].includes(request.method ?? "") && url.pathname.startsWith("/api/") ? await readJson(request) : {};
      const apiResult = await handleApi({ method: request.method, pathname: url.pathname, body, headers: request.headers });
      if (apiResult) return json(response, apiResult.status, apiResult.body, request);
      return await serveStatic(response, url.pathname, clientDirectory);
    } catch (error) {
      if (error instanceof ValidationError) return json(response, 400, { message: error.message, issues: error.issues }, request);
      if (error instanceof StorageConflictError) return json(response, 409, { message: error.message }, request);
      if (error.status) return json(response, error.status, { message: error.message }, request);
      console.error(error);
      return json(response, 500, { message: "服务暂时不可用，请稍后重试" }, request);
    }
  });
}
