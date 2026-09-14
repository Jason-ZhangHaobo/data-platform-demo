import { randomUUID } from "node:crypto";

export const V2_OPERATIONS = Object.freeze([
  "status",
  "release_runs_list",
  "dapi_list",
  "dapi_create",
  "xapi_list",
  "xapi_create",
  "service_test",
  "service_publish",
  "service_openapi",
  "service_calls",
  "application_list",
  "application_create",
  "application_revoke",
  "service_invoke",
]);

export class V2ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.name = "V2ApiError";
    this.status = status;
    this.code = code;
  }
}

export class V2Client {
  constructor({
    baseUrl = "http://127.0.0.1:3100/api/v2",
    client = "cli",
    projectId = "project-securities-lab",
    fetchImpl = fetch,
    timeoutMs = 15000,
  } = {}) {
    const parsed = new URL(baseUrl);
    if (!["http:", "https:"].includes(parsed.protocol))
      throw new Error("V2 API地址必须使用HTTP或HTTPS");
    if (!['workbench', 'cli', 'mcp'].includes(client))
      throw new Error("V2客户端类型不受支持");
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.client = client;
    this.projectId = projectId;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async request(
    path,
    { method = "GET", body, authorization, idempotencyKey, timeoutMs } = {},
  ) {
    if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//"))
      throw new Error("V2 API路径不合法");
    const controller = AbortSignal.timeout(timeoutMs ?? this.timeoutMs),
      response = await this.fetchImpl(this.baseUrl + path, {
        method,
        redirect: "error",
        signal: controller,
        headers: {
          Accept: "application/json",
          "X-Shuzhan-Client": this.client,
          "X-Project-Id": this.projectId,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(method === "GET"
            ? {}
            : { "Idempotency-Key": idempotencyKey ?? randomUUID() }),
          ...(authorization ? { Authorization: authorization } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    let value;
    try {
      value = await response.json();
    } catch {
      throw new V2ApiError("V2 API返回了无法解析的响应", response.status);
    }
    if (!response.ok)
      throw new V2ApiError(
        value.message ?? `V2 API请求失败（${response.status}）`,
        response.status,
        value.code,
      );
    return value;
  }
}
