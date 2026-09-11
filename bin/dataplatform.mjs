#!/usr/bin/env node

import { fileURLToPath } from "node:url";

const HELP = `数栈 Data Platform CLI

用法：
  dataplatform health [--base-url URL]
  dataplatform agent plan --message "需求" [--user-id ID] [--json]
  dataplatform agent confirm --plan-id ID [--user-id ID] [--json]
  dataplatform agent eval [--json]
  dataplatform assets search --query "关键词" [--json]
  dataplatform security check --user-id ID --permission PERMISSION --sensitivity LEVEL [--json]
  dataplatform dev list [--json]
  dataplatform dev validate --job-id ID [--json]
  dataplatform dev deploy --job-id ID [--json]
  dataplatform dev run --job-id ID [--json]
  dataplatform ops list [--json]
  dataplatform ops acknowledge --incident-id ID [--json]
  dataplatform ops resolve --incident-id ID [--json]

环境变量：
  DATA_PLATFORM_API_BASE_URL   默认 http://localhost:3000
  DATA_PLATFORM_ACCESS_TOKEN   可选的 staging 演示访问码
`;

function parseArgs(argv) {
  const positionals = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--")) {
      const key = token.slice(2).replaceAll("-", "_");
      const next = argv[index + 1];
      if (next && !next.startsWith("--")) { options[key] = next; index += 1; }
      else options[key] = true;
    } else positionals.push(token);
  }
  return { positionals, options };
}

async function request(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}${path}`, {
    ...options,
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers },
  });
  const body = response.status === 204 ? undefined : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.message ?? `请求失败（${response.status}）`);
  return body;
}

function output(value, options) {
  if (options.json) console.log(JSON.stringify(value, null, 2));
  else if (typeof value === "string") console.log(value);
  else console.log(JSON.stringify(value, null, 2));
}

export async function runCli(argv, env = process.env) {
  const { positionals, options } = parseArgs(argv);
  if (!positionals.length || positionals[0] === "help" || options.help) { console.log(HELP); return 0; }
  const baseUrl = options.base_url ?? env.DATA_PLATFORM_API_BASE_URL ?? "http://localhost:3000";
  const accessToken = options.access_token ?? env.DATA_PLATFORM_ACCESS_TOKEN;
  const api = (path, requestOptions = {}) => request(baseUrl, path, {
    ...requestOptions,
    headers: { ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}), ...requestOptions.headers },
  });
  const [resource, action] = positionals;
  try {
    if (resource === "health") { output(await api("/api/health"), options); return 0; }
    if (resource === "agent" && action === "plan") {
      if (!options.message) throw new Error("缺少 --message");
      output(await api("/api/agent/plan", { method: "POST", body: JSON.stringify({ message: options.message, userId: options.user_id ?? "user-platform-admin" }) }), options); return 0;
    }
    if (resource === "agent" && action === "confirm") {
      if (!options.plan_id) throw new Error("缺少 --plan-id");
      output(await api(`/api/agent/plans/${encodeURIComponent(options.plan_id)}/confirm`, { method: "POST", body: JSON.stringify({ planId: options.plan_id, userId: options.user_id ?? "user-platform-admin" }) }), options); return 0;
    }
    if (resource === "agent" && action === "eval") { output(await api("/api/agent/evaluation/run", { method: "POST", body: JSON.stringify({}) }), options); return 0; }
    if (resource === "assets" && action === "search") {
      const query = options.query ? `?q=${encodeURIComponent(options.query)}` : "";
      output(await api(`/api/assets${query}`), options); return 0;
    }
    if (resource === "security" && action === "check") {
      for (const key of ["user_id", "permission", "sensitivity"]) if (!options[key]) throw new Error(`缺少 --${key.replaceAll("_", "-")}`);
      output(await api("/api/security/access-check", { method: "POST", body: JSON.stringify({ userId: options.user_id, permission: options.permission, sensitivity: options.sensitivity, resourceType: "asset" }) }), options); return 0;
    }
    if (resource === "dev" && action === "list") { output(await api("/api/dev/jobs"), options); return 0; }
    if (resource === "dev" && ["validate", "deploy", "run"].includes(action)) {
      if (!options.job_id) throw new Error("缺少 --job-id");
      output(await api(`/api/dev/jobs/${encodeURIComponent(options.job_id)}/${action}`, { method: "POST", body: JSON.stringify({}) }), options); return 0;
    }
    if (resource === "ops" && action === "list") { output(await api("/api/ops/incidents"), options); return 0; }
    if (resource === "ops" && ["acknowledge", "resolve"].includes(action)) {
      if (!options.incident_id) throw new Error("缺少 --incident-id");
      output(await api(`/api/ops/incidents/${encodeURIComponent(options.incident_id)}/${action}`, { method: "POST", body: JSON.stringify({}) }), options); return 0;
    }
    throw new Error(`不支持的命令：${positionals.join(" ")}`);
  } catch (error) {
    console.error(`错误：${error.message}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = await runCli(process.argv.slice(2));
