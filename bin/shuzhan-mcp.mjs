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
  { name: "source_list", description: "列出V2真实数据源、版本、连接测试和元数据摘要。", inputSchema: { type: "object", properties: {} } },
  { name: "source_create", description: "登记仓库合成目录中的LOCAL_CSV源，不接受任意路径或凭证。", inputSchema: { type: "object", properties: { name: { type: "string" }, fileName: { type: "string" } }, required: ["name", "fileName"] } },
  { name: "source_test", description: "真实读取当前CSV版本并记录连接证据。", inputSchema: { type: "object", properties: { sourceId: { type: "string" } }, required: ["sourceId"] } },
  { name: "source_metadata_collect", description: "基于已测试版本扫描字段类型、基数和结构变化。", inputSchema: { type: "object", properties: { sourceId: { type: "string" } }, required: ["sourceId"] } },
  { name: "source_revision_create", description: "为现有数据源创建新的合成CSV版本，不复用旧元数据。", inputSchema: { type: "object", properties: { sourceId: { type: "string" }, fileName: { type: "string" } }, required: ["sourceId", "fileName"] } },
  { name: "sync_task_list", description: "列出V2离线同步任务和全部运行证据。", inputSchema: { type: "object", properties: {} } },
  { name: "sync_task_create", description: "创建绑定源版本和元数据版本的FULL或INCREMENTAL_UPSERT草稿。", inputSchema: { type: "object", properties: { name: { type: "string" }, sourceId: { type: "string" }, targetTable: { type: "string" }, mode: { type: "string", enum: ["FULL", "INCREMENTAL_UPSERT"] }, mapping: { type: "object", additionalProperties: { type: "string" } }, keyFields: { type: "array", items: { type: "string" } }, watermarkField: { type: "string" } }, required: ["name", "sourceId", "targetTable", "mode", "mapping", "keyFields"] } },
  { name: "sync_task_run", description: "实际执行离线同步并返回读写、摘要和水位。", inputSchema: { type: "object", properties: { taskId: { type: "string" } }, required: ["taskId"] } },
  { name: "sync_target_rows", description: "读取本机合成落地区目标行，用于验收。", inputSchema: { type: "object", properties: { targetTable: { type: "string" } }, required: ["targetTable"] } },
  { name: "ingestion_plan_list", description: "列出受治理的同步Agent方案。", inputSchema: { type: "object", properties: {} } },
  { name: "ingestion_plan_create", description: "让真实模型基于现有元数据生成同步方案，不执行同步。", inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } },
  { name: "ingestion_plan_apply", description: "把已验证的同步Agent方案应用为READY草稿，不自动运行。", inputSchema: { type: "object", properties: { planId: { type: "string" } }, required: ["planId"] } },
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
  if (name === "source_list") return client.request("/sources");
  if (name === "source_create")
    return client.request("/sources", {
      method: "POST",
      body: { ...args, sourceType: "LOCAL_CSV" },
    });
  if (["source_test", "source_metadata_collect"].includes(name))
    return client.request(
      `/sources/${encodeURIComponent(args.sourceId)}/${name === "source_test" ? "test" : "metadata"}`,
      { method: "POST", body: {} },
    );
  if (name === "source_revision_create")
    return client.request(
      `/sources/${encodeURIComponent(args.sourceId)}/revisions`,
      { method: "POST", body: { fileName: args.fileName } },
    );
  if (name === "sync_task_list") return client.request("/sync/tasks");
  if (name === "sync_task_create")
    return client.request("/sync/tasks", { method: "POST", body: args });
  if (name === "sync_task_run")
    return client.request(`/sync/tasks/${encodeURIComponent(args.taskId)}/run`, {
      method: "POST",
      body: {},
    });
  if (name === "sync_target_rows")
    return client.request(
      `/sync/targets/${encodeURIComponent(args.targetTable)}/rows`,
    );
  if (name === "ingestion_plan_list") return client.request("/sync/agent/plans");
  if (name === "ingestion_plan_create")
    return client.request("/sync/agent/plans", {
      method: "POST",
      body: { message: args.message },
    });
  if (name === "ingestion_plan_apply")
    return client.request(
      `/sync/agent/plans/${encodeURIComponent(args.planId)}/apply`,
      { method: "POST", body: {} },
    );
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
