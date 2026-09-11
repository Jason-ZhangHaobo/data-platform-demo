#!/usr/bin/env node

import readline from "node:readline";

const baseUrl = (process.env.DATA_PLATFORM_API_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const accessToken = process.env.DATA_PLATFORM_ACCESS_TOKEN;
const tools = [
  { name: "data_agent_plan", description: "根据中国证券行业自然语言需求生成计划、风险、澄清问题和模块草稿，不执行写入。", inputSchema: { type: "object", properties: { message: { type: "string" }, userId: { type: "string" } }, required: ["message"] } },
  { name: "data_agent_confirm", description: "确认并执行一个已生成的 Data Agent 计划。调用前必须向用户展示计划并获得明确确认。", inputSchema: { type: "object", properties: { planId: { type: "string" }, userId: { type: "string" } }, required: ["planId", "userId"] } },
  { name: "assets_search", description: "搜索证券数据资产的表、字段、敏感等级和血缘摘要，只返回元数据。", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
  { name: "security_access_check", description: "检查虚构用户对某敏感等级资源的访问权限，并写入允许/拒绝审计。", inputSchema: { type: "object", properties: { userId: { type: "string" }, permission: { type: "string" }, sensitivity: { type: "string", enum: ["PUBLIC", "INTERNAL", "SENSITIVE", "RESTRICTED"] } }, required: ["userId", "permission", "sensitivity"] } },
  { name: "dev_job_list", description: "列出 SQL 开发任务及其草稿、发布和运行状态。", inputSchema: { type: "object", properties: {} } },
  { name: "dev_job_validate", description: "静态校验 SQL 开发任务，只返回风险提示，不执行 SQL。", inputSchema: { type: "object", properties: { jobId: { type: "string" } }, required: ["jobId"] } },
  { name: "dev_job_publish", description: "发布 SQL 任务到虚构 staging 调度环境。调用前必须向用户展示 SQL、风险和调度配置并获得明确确认。", inputSchema: { type: "object", properties: { jobId: { type: "string" } }, required: ["jobId"] } },
  { name: "ops_incident_list", description: "列出虚构证券数据告警、影响范围、责任人和处置手册。", inputSchema: { type: "object", properties: {} } },
  { name: "ops_incident_acknowledge", description: "确认一条虚构运维告警并转交处置。调用前必须向用户展示影响范围和处置手册并获得明确确认；不提供自动结案。", inputSchema: { type: "object", properties: { incidentId: { type: "string" } }, required: ["incidentId"] } },
];

async function api(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}), ...options.headers } });
  const body = response.status === 204 ? undefined : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.message ?? `API 请求失败（${response.status}）`);
  return body;
}

async function callTool(name, args = {}) {
  if (name === "data_agent_plan") return api("/api/agent/plan", { method: "POST", body: JSON.stringify({ message: args.message, userId: args.userId ?? "user-platform-admin" }) });
  if (name === "data_agent_confirm") return api(`/api/agent/plans/${encodeURIComponent(args.planId)}/confirm`, { method: "POST", body: JSON.stringify({ planId: args.planId, userId: args.userId }) });
  if (name === "assets_search") return api(`/api/assets${args.query ? `?q=${encodeURIComponent(args.query)}` : ""}`);
  if (name === "security_access_check") return api("/api/security/access-check", { method: "POST", body: JSON.stringify({ ...args, resourceType: "asset" }) });
  if (name === "dev_job_list") return api("/api/dev/jobs");
  if (name === "dev_job_validate") return api(`/api/dev/jobs/${encodeURIComponent(args.jobId)}/validate`, { method: "POST", body: JSON.stringify({}) });
  if (name === "dev_job_publish") return api(`/api/dev/jobs/${encodeURIComponent(args.jobId)}/deploy`, { method: "POST", body: JSON.stringify({}) });
  if (name === "ops_incident_list") return api("/api/ops/incidents");
  if (name === "ops_incident_acknowledge") return api(`/api/ops/incidents/${encodeURIComponent(args.incidentId)}/acknowledge`, { method: "POST", body: JSON.stringify({}) });
  throw new Error(`未知 MCP 工具：${name}`);
}

function response(id, result) { return JSON.stringify({ jsonrpc: "2.0", id, result }); }
function errorResponse(id, code, message) { return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }); }

async function handle(message) {
  if (message.method === "initialize") return response(message.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "dataplatform-mcp", version: "0.1.0" } });
  if (message.method === "notifications/initialized") return undefined;
  if (message.method === "tools/list") return response(message.id, { tools });
  if (message.method === "tools/call") {
    try { const result = await callTool(message.params?.name, message.params?.arguments); return response(message.id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result }); }
    catch (error) { return errorResponse(message.id, -32000, error.message); }
  }
  return errorResponse(message.id, -32601, `不支持的方法：${message.method}`);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  if (!line.trim()) continue;
  try { const output = await handle(JSON.parse(line)); if (output) process.stdout.write(`${output}\n`); }
  catch (error) { process.stdout.write(`${errorResponse(null, -32700, error.message)}\n`); }
}
