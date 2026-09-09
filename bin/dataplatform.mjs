#!/usr/bin/env node

import { fileURLToPath } from "node:url";

const HELP = `数栈 Data Platform CLI

用法：
  dataplatform health [--base-url URL]
  dataplatform agent plan --message "需求" [--user-id ID] [--json]
  dataplatform agent confirm --plan-id ID [--user-id ID] [--json]
  dataplatform assets search --query "关键词" [--json]
  dataplatform security check --user-id ID --permission PERMISSION --sensitivity LEVEL [--json]

环境变量：
  DATA_PLATFORM_API_BASE_URL   默认 http://localhost:3000
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
  const [resource, action] = positionals;
  try {
    if (resource === "health") { output(await request(baseUrl, "/api/health"), options); return 0; }
    if (resource === "agent" && action === "plan") {
      if (!options.message) throw new Error("缺少 --message");
      output(await request(baseUrl, "/api/agent/plan", { method: "POST", body: JSON.stringify({ message: options.message, userId: options.user_id ?? "user-platform-admin" }) }), options); return 0;
    }
    if (resource === "agent" && action === "confirm") {
      if (!options.plan_id) throw new Error("缺少 --plan-id");
      output(await request(baseUrl, `/api/agent/plans/${encodeURIComponent(options.plan_id)}/confirm`, { method: "POST", body: JSON.stringify({ planId: options.plan_id, userId: options.user_id ?? "user-platform-admin" }) }), options); return 0;
    }
    if (resource === "assets" && action === "search") {
      const query = options.query ? `?q=${encodeURIComponent(options.query)}` : "";
      output(await request(baseUrl, `/api/assets${query}`), options); return 0;
    }
    if (resource === "security" && action === "check") {
      for (const key of ["user_id", "permission", "sensitivity"]) if (!options[key]) throw new Error(`缺少 --${key.replaceAll("_", "-")}`);
      output(await request(baseUrl, "/api/security/access-check", { method: "POST", body: JSON.stringify({ userId: options.user_id, permission: options.permission, sensitivity: options.sensitivity, resourceType: "asset" }) }), options); return 0;
    }
    throw new Error(`不支持的命令：${positionals.join(" ")}`);
  } catch (error) {
    console.error(`错误：${error.message}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) process.exitCode = await runCli(process.argv.slice(2));
