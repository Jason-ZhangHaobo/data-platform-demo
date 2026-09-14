#!/usr/bin/env node
import readline from "node:readline";
import { V2Client, V2_OPERATIONS } from "../src/v2/client.mjs";

const tools = [
  { name: "v2_status", description: "读取数栈V2真实/本机/公网能力边界。", inputSchema: { type: "object", properties: {} } },
  { name: "release_runs_list", description: "列出真实调度发布批次及验证证据。", inputSchema: { type: "object", properties: {} } },
  { name: "dapi_list", description: "列出版本化DAPI。", inputSchema: { type: "object", properties: {} } },
  { name: "dapi_create", description: "从已验证发布批次创建DAPI草稿，不自动发布。", inputSchema: { type: "object", properties: { name: { type: "string" }, slug: { type: "string" }, sourceReleaseRunId: { type: "string" }, fields: { type: "array", items: { type: "string" } } }, required: ["name", "slug", "sourceReleaseRunId"] } },
  { name: "xapi_list", description: "列出版本化XAPI。", inputSchema: { type: "object", properties: {} } },
  { name: "xapi_create", description: "声明式编排2—5个已发布DAPI版本，不自动发布。", inputSchema: { type: "object", properties: { name: { type: "string" }, slug: { type: "string" }, steps: { type: "array", items: { type: "object", properties: { alias: { type: "string" }, dapiId: { type: "string" } }, required: ["alias", "dapiId"], additionalProperties: false } } }, required: ["name", "slug", "steps"] } },
  { name: "data_service_test", description: "实际执行当前DAPI/XAPI版本并保存测试证据。", inputSchema: { type: "object", properties: { type: { type: "string", enum: ["dapi", "xapi"] }, serviceId: { type: "string" }, clientId: { type: "string" } }, required: ["type", "serviceId"] } },
  { name: "data_service_publish", description: "发布已有成功测试证据的当前版本。调用前应向用户展示服务、版本摘要和端点。", inputSchema: { type: "object", properties: { type: { type: "string", enum: ["dapi", "xapi"] }, serviceId: { type: "string" } }, required: ["type", "serviceId"] } },
  { name: "data_service_openapi", description: "读取指定DAPI/XAPI的OpenAPI 3.1文档。", inputSchema: { type: "object", properties: { type: { type: "string", enum: ["dapi", "xapi"] }, serviceId: { type: "string" } }, required: ["type", "serviceId"] } },
  { name: "data_service_calls", description: "读取数据服务调用日志，可按服务过滤。", inputSchema: { type: "object", properties: { serviceId: { type: "string" } } } },
  { name: "service_application_list", description: "列出调用应用与授权，不返回令牌或令牌哈希。", inputSchema: { type: "object", properties: {} } },
  { name: "service_application_create", description: "创建本机调用应用并仅显示一次令牌。该操作创建持久访问能力，调用前必须取得用户明确确认。", inputSchema: { type: "object", properties: { name: { type: "string" }, serviceIds: { type: "array", items: { type: "string" } } }, required: ["name", "serviceIds"] } },
  { name: "service_application_revoke", description: "撤销本机调用应用。该操作会使令牌立即失效，调用前必须取得用户明确确认。", inputSchema: { type: "object", properties: { applicationId: { type: "string" } }, required: ["applicationId"] } },
  { name: "data_service_invoke", description: "使用服务器环境中的SHUZHAN_APP_TOKEN调用已授权服务；令牌不进入模型参数。", inputSchema: { type: "object", properties: { type: { type: "string", enum: ["dapi", "xapi"] }, slug: { type: "string" }, clientId: { type: "string" }, page: { type: "integer", minimum: 1 }, pageSize: { type: "integer", minimum: 1, maximum: 100 } }, required: ["type", "slug"] } },
];

export const V2_MCP_OPERATIONS = Object.freeze([...V2_OPERATIONS]);
export const V2_MCP_TOOL_NAMES = Object.freeze(tools.map((tool) => tool.name));

const client = new V2Client({
  baseUrl:
    process.env.SHUZHAN_V2_API_BASE_URL ??
    "http://127.0.0.1:3100/api/v2",
  client: "mcp",
});
const typePath = (value) => {
  if (!['dapi', 'xapi'].includes(value)) throw new Error("type必须是dapi或xapi");
  return value + "s";
};
async function callTool(name, args = {}) {
  if (name === "v2_status") return client.request("/status");
  if (name === "release_runs_list") return client.request("/release/runs");
  if (name === "dapi_list") return client.request("/data-services/dapis");
  if (name === "xapi_list") return client.request("/data-services/xapis");
  if (name === "dapi_create")
    return client.request("/data-services/dapis", { method: "POST", body: args });
  if (name === "xapi_create")
    return client.request("/data-services/xapis", { method: "POST", body: args });
  if (["data_service_test", "data_service_publish", "data_service_openapi"].includes(name)) {
    const action = { data_service_test: "test", data_service_publish: "publish", data_service_openapi: "openapi" }[name],
      path = `/data-services/${typePath(args.type)}/${encodeURIComponent(args.serviceId)}/${action}`;
    return client.request(path, {
      ...(action === "openapi"
        ? {}
        : {
            method: "POST",
            body:
              action === "test"
                ? { clientId: args.clientId, page: 1, pageSize: 20 }
                : {},
          }),
    });
  }
  if (name === "data_service_calls")
    return client.request(
      `/data-services/calls${args.serviceId ? `?service_id=${encodeURIComponent(args.serviceId)}` : ""}`,
    );
  if (name === "service_application_list")
    return client.request("/data-services/applications");
  if (name === "service_application_create")
    return client.request("/data-services/applications", { method: "POST", body: args });
  if (name === "service_application_revoke")
    return client.request(
      `/data-services/applications/${encodeURIComponent(args.applicationId)}/revoke`,
      { method: "POST", body: {} },
    );
  if (name === "data_service_invoke") {
    if (!process.env.SHUZHAN_APP_TOKEN)
      throw new Error("MCP服务未配置SHUZHAN_APP_TOKEN");
    const query = new URLSearchParams({
      page: String(args.page ?? 1),
      page_size: String(args.pageSize ?? 20),
      ...(args.clientId ? { client_id: args.clientId } : {}),
    });
    return client.request(
      `/open/${typePath(args.type)}/${encodeURIComponent(args.slug)}?${query}`,
      { authorization: `Bearer ${process.env.SHUZHAN_APP_TOKEN}` },
    );
  }
  throw new Error(`未知V2 MCP工具：${name}`);
}
const response = (id, result) => JSON.stringify({ jsonrpc: "2.0", id, result });
const errorResponse = (id, code, message, data) =>
  JSON.stringify({ jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } });
export async function handleV2Mcp(message) {
  if (message.method === "initialize")
    return response(message.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "shuzhan-v2-mcp", version: "0.1.0" },
    });
  if (message.method === "notifications/initialized") return undefined;
  if (message.method === "tools/list") return response(message.id, { tools });
  if (message.method === "tools/call") {
    try {
      const result = await callTool(
        message.params?.name,
        message.params?.arguments,
      );
      return response(message.id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result,
      });
    } catch (error) {
      return errorResponse(message.id, -32000, error.message, {
        status: error.status,
        code: error.code,
      });
    }
  }
  return errorResponse(message.id, -32601, `不支持的方法：${message.method}`);
}

if (process.argv[1] && process.argv[1].endsWith("shuzhan-mcp.mjs")) {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    try {
      const output = await handleV2Mcp(JSON.parse(line));
      if (output) process.stdout.write(output + "\n");
    } catch (error) {
      process.stdout.write(errorResponse(null, -32700, error.message) + "\n");
    }
  }
}
