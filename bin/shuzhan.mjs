#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { V2Client, V2_OPERATIONS } from "../src/v2/client.mjs";

const HELP = `数栈 V2 CLI · 与GUI/MCP共用 /api/v2

用法：
  shuzhan status
  shuzhan release-runs list
  shuzhan services list [--type dapi|xapi]
  shuzhan services create-dapi --name 名称 --slug path --source-run-id ID [--fields a,b]
  shuzhan services create-xapi --name 名称 --slug path --steps alias:DAPI_ID,alias:DAPI_ID
  shuzhan services test --type dapi|xapi --id ID [--client-id CLIENT-001]
  shuzhan services publish --type dapi|xapi --id ID
  shuzhan services openapi --type dapi|xapi --id ID
  shuzhan services calls [--id ID]
  shuzhan services invoke --type dapi|xapi --slug path [--client-id CLIENT-001]
  shuzhan apps list
  shuzhan apps create --name 名称 --service-ids ID,ID
  shuzhan apps revoke --id ID
  shuzhan sources list
  shuzhan sources create --name 名称 --file positions_baseline.csv
  shuzhan sources test|metadata --id ID
  shuzhan sources revision --id ID --file positions_schema_change.csv
  shuzhan sync list
  shuzhan sync create --name 名称 --source-id ID --target-table raw_positions --mode full|incremental --mapping from:to,... --keys position_id [--watermark trade_date]
  shuzhan sync run --id ID
  shuzhan sync rows --table raw_positions
  shuzhan sync plan --message "同步需求"
  shuzhan sync apply-plan --id PLAN_ID

环境变量：
  SHUZHAN_V2_API_BASE_URL  默认 http://127.0.0.1:3100/api/v2
  SHUZHAN_APP_TOKEN        调用已发布服务；不建议通过命令参数传递令牌

旧 dataplatform 命令仍对应V1模拟接口，不能作为V2验收证据。`;

function parse(argv) {
  const positionals = [],
    options = {};
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const key = token.slice(2).replaceAll("-", "_") ,
      next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      options[key] = next;
      index++;
    } else options[key] = true;
  }
  return { positionals, options };
}
const required = (options, key) => {
  if (typeof options[key] !== "string" || !options[key].trim())
    throw new Error(`缺少 --${key.replaceAll("_", "-")}`);
  return options[key].trim();
};
const typePath = (value) => {
  if (!['dapi', 'xapi'].includes(value)) throw new Error("--type必须是dapi或xapi");
  return value + "s";
};
const list = (value, name) => {
  const items = required({ value }, "value")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (!items.length || new Set(items).size !== items.length)
    throw new Error(`${name}不能为空或重复`);
  return items;
};
const steps = (value) =>
  list(value, "--steps").map((item) => {
    const separator = item.indexOf(":");
    if (separator < 1 || separator === item.length - 1)
      throw new Error("--steps格式为alias:DAPI_ID,alias:DAPI_ID");
    return { alias: item.slice(0, separator), dapiId: item.slice(separator + 1) };
  });
const mapping = (value) =>
  Object.fromEntries(
    list(value, "--mapping").map((item) => {
      const separator = item.indexOf(":");
      if (separator < 1 || separator === item.length - 1)
        throw new Error("--mapping格式为源字段:目标字段,源字段:目标字段");
      return [item.slice(0, separator), item.slice(separator + 1)];
    }),
  );

export const V2_CLI_OPERATIONS = Object.freeze([...V2_OPERATIONS]);

export async function runV2Cli(argv, env = process.env, options = {}) {
  const parsed = parse(argv),
    [resource, action] = parsed.positionals,
    out = options.output ?? console.log,
    err = options.error ?? console.error,
    client =
      options.client ??
      new V2Client({
        baseUrl:
          parsed.options.base_url ??
          env.SHUZHAN_V2_API_BASE_URL ??
          "http://127.0.0.1:3100/api/v2",
        client: "cli",
      });
  try {
    if (!resource || resource === "help" || parsed.options.help) {
      out(HELP);
      return 0;
    }
    let result;
    if (resource === "status") result = await client.request("/status");
    else if (resource === "release-runs" && action === "list")
      result = await client.request("/release/runs");
    else if (resource === "services" && action === "list") {
      const type = parsed.options.type;
      if (type) result = await client.request(`/data-services/${typePath(type)}`);
      else {
        const [dapis, xapis] = await Promise.all([
          client.request("/data-services/dapis"),
          client.request("/data-services/xapis"),
        ]);
        result = { dapis, xapis };
      }
    } else if (resource === "services" && action === "create-dapi") {
      result = await client.request("/data-services/dapis", {
        method: "POST",
        body: {
          name: required(parsed.options, "name"),
          slug: required(parsed.options, "slug"),
          sourceReleaseRunId: required(parsed.options, "source_run_id"),
          ...(parsed.options.fields
            ? { fields: list(parsed.options.fields, "--fields") }
            : {}),
          ...(parsed.options.timeout_ms
            ? { timeoutMs: Number(parsed.options.timeout_ms) }
            : {}),
          ...(parsed.options.rate_limit
            ? { rateLimitPerMinute: Number(parsed.options.rate_limit) }
            : {}),
        },
      });
    } else if (resource === "services" && action === "create-xapi") {
      result = await client.request("/data-services/xapis", {
        method: "POST",
        body: {
          name: required(parsed.options, "name"),
          slug: required(parsed.options, "slug"),
          steps: steps(required(parsed.options, "steps")),
        },
      });
    } else if (
      resource === "services" &&
      ["test", "publish", "openapi"].includes(action)
    ) {
      const path = `/data-services/${typePath(required(parsed.options, "type"))}/${encodeURIComponent(required(parsed.options, "id"))}/${action}`;
      result = await client.request(path, {
        ...(action === "openapi"
          ? {}
          : {
              method: "POST",
              body:
                action === "test"
                  ? { clientId: parsed.options.client_id, page: 1, pageSize: 20 }
                  : {},
            }),
      });
    } else if (resource === "services" && action === "calls") {
      result = await client.request(
        `/data-services/calls${parsed.options.id ? `?service_id=${encodeURIComponent(parsed.options.id)}` : ""}`,
      );
    } else if (resource === "services" && action === "invoke") {
      const token = env.SHUZHAN_APP_TOKEN;
      if (!token) throw new Error("缺少环境变量 SHUZHAN_APP_TOKEN");
      const query = new URLSearchParams({
        page: "1",
        page_size: "20",
        ...(parsed.options.client_id
          ? { client_id: parsed.options.client_id }
          : {}),
      });
      result = await client.request(
        `/open/${typePath(required(parsed.options, "type"))}/${encodeURIComponent(required(parsed.options, "slug"))}?${query}`,
        { authorization: `Bearer ${token}` },
      );
    } else if (resource === "apps" && action === "list")
      result = await client.request("/data-services/applications");
    else if (resource === "apps" && action === "create")
      result = await client.request("/data-services/applications", {
        method: "POST",
        body: {
          name: required(parsed.options, "name"),
          serviceIds: list(
            required(parsed.options, "service_ids"),
            "--service-ids",
          ),
        },
      });
    else if (resource === "apps" && action === "revoke")
      result = await client.request(
        `/data-services/applications/${encodeURIComponent(required(parsed.options, "id"))}/revoke`,
        { method: "POST", body: {} },
      );
    else if (resource === "sources" && action === "list")
      result = await client.request("/sources");
    else if (resource === "sources" && action === "create")
      result = await client.request("/sources", {
        method: "POST",
        body: {
          name: required(parsed.options, "name"),
          sourceType: "LOCAL_CSV",
          fileName: required(parsed.options, "file"),
        },
      });
    else if (
      resource === "sources" &&
      ["test", "metadata"].includes(action)
    )
      result = await client.request(
        `/sources/${encodeURIComponent(required(parsed.options, "id"))}/${action}`,
        { method: "POST", body: {} },
      );
    else if (resource === "sources" && action === "revision")
      result = await client.request(
        `/sources/${encodeURIComponent(required(parsed.options, "id"))}/revisions`,
        {
          method: "POST",
          body: { fileName: required(parsed.options, "file") },
        },
      );
    else if (resource === "sync" && action === "list")
      result = await client.request("/sync/tasks");
    else if (resource === "sync" && action === "create") {
      const mode = required(parsed.options, "mode");
      if (!["full", "incremental"].includes(mode))
        throw new Error("--mode必须是full或incremental");
      result = await client.request("/sync/tasks", {
        method: "POST",
        body: {
          name: required(parsed.options, "name"),
          sourceId: required(parsed.options, "source_id"),
          targetTable: required(parsed.options, "target_table"),
          mode: mode === "full" ? "FULL" : "INCREMENTAL_UPSERT",
          mapping: mapping(required(parsed.options, "mapping")),
          keyFields: list(required(parsed.options, "keys"), "--keys"),
          ...(parsed.options.watermark
            ? { watermarkField: parsed.options.watermark }
            : {}),
        },
      });
    } else if (resource === "sync" && action === "run")
      result = await client.request(
        `/sync/tasks/${encodeURIComponent(required(parsed.options, "id"))}/run`,
        { method: "POST", body: {} },
      );
    else if (resource === "sync" && action === "rows")
      result = await client.request(
        `/sync/targets/${encodeURIComponent(required(parsed.options, "table"))}/rows`,
      );
    else if (resource === "sync" && action === "plan")
      result = await client.request("/sync/agent/plans", {
        method: "POST",
        body: { message: required(parsed.options, "message") },
      });
    else if (resource === "sync" && action === "plans")
      result = await client.request("/sync/agent/plans");
    else if (resource === "sync" && action === "apply-plan")
      result = await client.request(
        `/sync/agent/plans/${encodeURIComponent(required(parsed.options, "id"))}/apply`,
        { method: "POST", body: {} },
      );
    else throw new Error(`不支持的V2命令：${parsed.positionals.join(" ")}`);
    out(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    err(`错误：${error.message}`);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  process.exitCode = await runV2Cli(process.argv.slice(2));
