#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { V2Client, V2_OPERATIONS } from "../src/v2/client.mjs";

const HELP = `数栈 V2 CLI · 与GUI/MCP共用 /api/v2

用法：
  shuzhan status
  shuzhan budget
  shuzhan release-runs list
  shuzhan delivery packages
  shuzhan delivery show --id PACKAGE_ID
  shuzhan delivery create --source-run-id RUN_ID --name "客户资产 T+1"
  shuzhan delivery verify --id PACKAGE_ID --scheduled-for 2026-09-11T09:00:00+08:00
  shuzhan delivery verifications
  shuzhan delivery verification --id VERIFICATION_ID
  shuzhan delivery cancel --id VERIFICATION_ID
  shuzhan releases approvals
  shuzhan releases approve --package-id PACKAGE_ID --package-digest SHA256 --note "已审阅"
  shuzhan releases list
  shuzhan releases show --id RELEASE_ID
  shuzhan releases publish --approval-id APPROVAL_ID [--trigger-after-seconds 5 --interval-seconds 15 --run-count 2]
  shuzhan releases rollback --id RELEASE_ID --target-release-id RELEASE_ID --reason "恢复稳定版本"
  shuzhan releases monitor
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
  shuzhan streams sources
  shuzhan streams create-source --name 名称 --topic market.quotes.demo --file quotes_fault.jsonl
  shuzhan streams revision --source-id ID --file quotes_recovered.jsonl
  shuzhan streams jobs
  shuzhan streams create-job --name 名称 --source-id ID --target-table realtime_quotes [--checkpoint-every 2] [--max-out-of-order-seconds 2]
  shuzhan streams start|stop --id JOB_ID
  shuzhan streams recover --id JOB_ID --revision-id REVISION_ID
  shuzhan streams state|checkpoints --id JOB_ID
  shuzhan streams monitor
  shuzhan streams plan --message "实时同步需求"
  shuzhan streams plans
  shuzhan streams apply-plan --id PLAN_ID
  shuzhan assets list [--query 持仓] [--kind LANDING_TABLE]
  shuzhan assets show|lineage|impact --id ASSET_ID
  shuzhan assets annotate --id ASSET_ID --business-name 名称 --description 说明 --domain 财富管理 --owner 负责人 [--tags 持仓,T+1]
  shuzhan assets agent --message "找出持仓市值资产并解释来源"
  shuzhan assets agents
  shuzhan contracts list
  shuzhan contracts show --id CONTRACT_ID
  shuzhan contracts create --name 名称 --code positions_contract --asset-id landing:raw_positions --compatibility BACKWARD --owner 负责人 --description "契约说明"
  shuzhan contracts assess-current --id CONTRACT_ID
  shuzhan contracts apply-version --id CONTRACT_ID --assessment-id ASSESSMENT_ID [--acknowledge-breaking]
  shuzhan contracts check --id CONTRACT_ID
  shuzhan metrics list
  shuzhan metrics create --name 持仓市值 --code holding_market_value --asset-id landing:raw_positions --aggregation SUM --field market_value --group-by asset_class --definition "按资产类别汇总持仓，不含现金"
  shuzhan metrics run --id METRIC_ID
  shuzhan standards list
  shuzhan standards create --name 证券代码格式 --code security_code_format --asset-id landing:raw_positions --field security_code --semantic-type SECURITY_CODE --description "使用SEC前缀"
  shuzhan standards check --id STANDARD_ID
  shuzhan quality overview|list
  shuzhan quality create --name 名称 --code holding_value_range --asset-id landing:raw_positions --field market_value --type value-range --min 0.00 --max 5000.00 --description "持仓市值范围"
  shuzhan quality version --id RULE_ID --type value-range --min 0.00 --max 10000.00 --description "校准范围"
  shuzhan quality run --id RULE_ID
  shuzhan quality plan --message "为证券代码生成非空规则"
  shuzhan quality plans
  shuzhan quality apply-plan --id PLAN_ID
  shuzhan security overview|personas|policies|requests|audits
  shuzhan security create-policy --name 名称 --code advisor_positions --asset-id landing:raw_positions --roles WEALTH_ADVISOR --row-scope ADVISOR_CLIENTS --actions position_id:MASK_FULL,client_id:MASK_PARTIAL,security_code:ALLOW,market_value:ALLOW --description "顾问最小权限"
  shuzhan security version --id POLICY_ID --roles WEALTH_ADVISOR --row-scope ADVISOR_CLIENTS --actions client_id:HASH,security_code:ALLOW --description "策略V2"
  shuzhan security query --asset-id landing:raw_positions --actor-id user-wealth-advisor
  shuzhan security request --asset-id landing:raw_positions --scope READ_MASKED --reason "安全验收" --actor-id user-auditor
  shuzhan security review --id REQUEST_ID --decision APPROVE --duration-hours 24 --note "仅限合成数据" --actor-id user-data-owner
  shuzhan security plan --message "为财富顾问生成持仓最小权限策略"
  shuzhan security plans
  shuzhan security apply-plan --id PLAN_ID
  shuzhan reports overview|datasets|list
  shuzhan reports create-dataset --name 名称 --code holdings_dataset --asset-id landing:raw_positions --fields client_id,security_code,asset_class,industry,market_value,trade_date
  shuzhan reports refresh-dataset --id DATASET_ID
  shuzhan reports create --name 持仓结构报告 --code holdings_structure --dataset-id DATASET_ID --preset holdings --description "持仓指标与分布"
  shuzhan reports version --id REPORT_ID --preset holdings --description "报表V2"
  shuzhan reports run|export --id REPORT_ID
  shuzhan reports plan --message "生成持仓结构报告"
  shuzhan reports plans
  shuzhan reports apply-plan --id PLAN_ID
  shuzhan ops overview|refresh|incidents
  shuzhan ops show --id INCIDENT_ID
  shuzhan ops acknowledge --id INCIDENT_ID --note "已确认"
  shuzhan ops resolve --id INCIDENT_ID --evidence-kind offline_sync_run --evidence-id RUN_ID --note "新批次已成功"
  shuzhan ops diagnose --message "诊断当前事故"
  shuzhan ops diagnoses
  shuzhan evaluations full-lifecycle

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
const qualityType = (value) => {
  const normalized = required({ value }, "value").replaceAll("-", "_").toUpperCase();
  if (
    ![
      "NOT_NULL",
      "UNIQUE",
      "VALUE_RANGE",
      "ALLOWED_VALUES",
      "FRESHNESS_SECONDS",
    ].includes(normalized)
  )
    throw new Error("--type不受支持");
  return normalized;
};
const qualityConfig = (options, type) => {
  if (["NOT_NULL", "UNIQUE"].includes(type)) return {};
  if (type === "VALUE_RANGE")
    return {
      min: required(options, "min"),
      max: required(options, "max"),
    };
  if (type === "ALLOWED_VALUES")
    return { values: list(required(options, "values"), "--values") };
  return {
    maxAgeSeconds: Number(required(options, "max_age_seconds")),
  };
};
const reportWidgets = (preset) => {
  if (preset === "holdings")
    return [
      { id: "holding_value", type: "KPI", title: "持仓市值", aggregation: "SUM", field: "market_value" },
      { id: "security_count", type: "KPI", title: "证券数量", aggregation: "COUNT_DISTINCT", field: "security_code" },
      { id: "asset_class_distribution", type: "PIE", title: "资产类别分布", aggregation: "SUM", field: "market_value", dimension: "asset_class" },
      { id: "industry_distribution", type: "BAR", title: "行业分布", aggregation: "SUM", field: "market_value", dimension: "industry" },
    ];
  if (preset === "customer-assets")
    return [
      { id: "total_assets", type: "KPI", title: "客户总资产", aggregation: "SUM", field: "total_assets" },
      { id: "client_assets", type: "BAR", title: "客户资产分布", aggregation: "SUM", field: "total_assets", dimension: "client_id" },
    ];
  throw new Error("--preset必须是holdings或customer-assets");
};

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
    else if (resource === "budget" && !action)
      result = await client.request("/budget");
    else if (resource === "release-runs" && action === "list")
      result = await client.request("/release/runs");
    else if (resource === "delivery" && action === "packages")
      result = await client.request("/delivery/packages");
    else if (resource === "delivery" && action === "show")
      result = await client.request(
        `/delivery/packages/${encodeURIComponent(required(parsed.options, "id"))}`,
      );
    else if (resource === "delivery" && action === "create")
      result = await client.request("/delivery/packages", {
        method: "POST",
        body: {
          sourceRunId: required(parsed.options, "source_run_id"),
          name: required(parsed.options, "name"),
        },
      });
    else if (resource === "delivery" && action === "verify")
      result = await client.request(
        `/delivery/packages/${encodeURIComponent(required(parsed.options, "id"))}/verify`,
        {
          method: "POST",
          body: {
            scheduledFor: required(parsed.options, "scheduled_for"),
          },
        },
      );
    else if (resource === "delivery" && action === "verifications")
      result = await client.request("/delivery/verifications");
    else if (resource === "delivery" && action === "verification")
      result = await client.request(
        `/delivery/verifications/${encodeURIComponent(required(parsed.options, "id"))}`,
      );
    else if (resource === "delivery" && action === "cancel")
      result = await client.request(
        `/delivery/verifications/${encodeURIComponent(required(parsed.options, "id"))}/cancel`,
        { method: "POST", body: {} },
      );
    else if (resource === "releases" && action === "approvals")
      result = await client.request("/release/approvals");
    else if (resource === "releases" && action === "approve")
      result = await client.request(
        `/delivery/packages/${encodeURIComponent(required(parsed.options, "package_id"))}/approve`,
        {
          method: "POST",
          body: {
            packageDigest: required(parsed.options, "package_digest"),
            reviewNote: required(parsed.options, "note"),
          },
        },
      );
    else if (resource === "releases" && action === "list")
      result = await client.request("/releases");
    else if (resource === "releases" && action === "show")
      result = await client.request(
        `/releases/${encodeURIComponent(required(parsed.options, "id"))}`,
      );
    else if (resource === "releases" && action === "publish")
      result = await client.request("/releases", {
        method: "POST",
        body: {
          approvalId: required(parsed.options, "approval_id"),
          triggerAfterSeconds: Number(parsed.options.trigger_after_seconds ?? 5),
          intervalSeconds: Number(parsed.options.interval_seconds ?? 15),
          runCount: Number(parsed.options.run_count ?? 2),
        },
      });
    else if (resource === "releases" && action === "rollback")
      result = await client.request(
        `/releases/${encodeURIComponent(required(parsed.options, "id"))}/rollback`,
        {
          method: "POST",
          body: {
            targetReleaseId: required(parsed.options, "target_release_id"),
            triggerAfterSeconds: Number(parsed.options.trigger_after_seconds ?? 5),
            intervalSeconds: Number(parsed.options.interval_seconds ?? 15),
            reason: required(parsed.options, "reason"),
          },
        },
      );
    else if (resource === "releases" && action === "monitor")
      result = await client.request("/monitoring/overview");
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
    else if (resource === "streams" && action === "sources")
      result = await client.request("/streams/sources");
    else if (resource === "streams" && action === "create-source")
      result = await client.request("/streams/sources", {
        method: "POST",
        body: {
          name: required(parsed.options, "name"),
          adapter: "local-event-log-v1",
          topic: required(parsed.options, "topic"),
          fileName: required(parsed.options, "file"),
        },
      });
    else if (resource === "streams" && action === "revision")
      result = await client.request(
        `/streams/sources/${encodeURIComponent(required(parsed.options, "source_id"))}/revisions`,
        {
          method: "POST",
          body: { fileName: required(parsed.options, "file") },
        },
      );
    else if (resource === "streams" && action === "jobs")
      result = await client.request("/streams/jobs");
    else if (resource === "streams" && action === "create-job")
      result = await client.request("/streams/jobs", {
        method: "POST",
        body: {
          name: required(parsed.options, "name"),
          sourceId: required(parsed.options, "source_id"),
          targetTable: required(parsed.options, "target_table"),
          ...(parsed.options.checkpoint_every
            ? { checkpointEvery: Number(parsed.options.checkpoint_every) }
            : {}),
          ...(parsed.options.max_out_of_order_seconds
            ? {
                maxOutOfOrderSeconds: Number(
                  parsed.options.max_out_of_order_seconds,
                ),
              }
            : {}),
        },
      });
    else if (
      resource === "streams" &&
      ["start", "stop"].includes(action)
    )
      result = await client.request(
        `/streams/jobs/${encodeURIComponent(required(parsed.options, "id"))}/${action}`,
        { method: "POST", body: {} },
      );
    else if (resource === "streams" && action === "recover")
      result = await client.request(
        `/streams/jobs/${encodeURIComponent(required(parsed.options, "id"))}/recover`,
        {
          method: "POST",
          body: {
            sourceRevisionId: required(parsed.options, "revision_id"),
          },
        },
      );
    else if (
      resource === "streams" &&
      ["state", "checkpoints"].includes(action)
    )
      result = await client.request(
        `/streams/jobs/${encodeURIComponent(required(parsed.options, "id"))}/${action}`,
      );
    else if (resource === "streams" && action === "monitor")
      result = await client.request("/streams/monitor");
    else if (resource === "streams" && action === "plan")
      result = await client.request("/streams/agent/plans", {
        method: "POST",
        body: { message: required(parsed.options, "message") },
      });
    else if (resource === "streams" && action === "plans")
      result = await client.request("/streams/agent/plans");
    else if (resource === "streams" && action === "apply-plan")
      result = await client.request(
        `/streams/agent/plans/${encodeURIComponent(required(parsed.options, "id"))}/apply`,
        { method: "POST", body: {} },
      );
    else if (resource === "assets" && action === "list") {
      const query = new URLSearchParams({
        ...(parsed.options.query ? { q: parsed.options.query } : {}),
        ...(parsed.options.kind ? { kind: parsed.options.kind } : {}),
      });
      result = await client.request(`/assets${query.size ? `?${query}` : ""}`);
    } else if (
      resource === "assets" &&
      ["show", "lineage", "impact"].includes(action)
    ) {
      const id = encodeURIComponent(required(parsed.options, "id"));
      result = await client.request(
        `/assets/${id}${action === "show" ? "" : `/${action}`}`,
      );
    } else if (resource === "assets" && action === "annotate")
      result = await client.request(
        `/assets/${encodeURIComponent(required(parsed.options, "id"))}/annotation`,
        {
          method: "POST",
          body: {
            businessName: required(parsed.options, "business_name"),
            description: required(parsed.options, "description"),
            domain: required(parsed.options, "domain"),
            owner: required(parsed.options, "owner"),
            classification:
              parsed.options.classification ?? "INTERNAL_DEMO",
            ...(parsed.options.tags
              ? { tags: list(parsed.options.tags, "--tags") }
              : {}),
          },
        },
      );
    else if (resource === "assets" && action === "agent")
      result = await client.request("/assets/agent/tasks", {
        method: "POST",
        body: { message: required(parsed.options, "message") },
      });
    else if (resource === "assets" && action === "agents")
      result = await client.request("/assets/agent/tasks");
    else if (resource === "contracts" && action === "list")
      result = await client.request("/contracts");
    else if (resource === "contracts" && action === "show")
      result = await client.request(
        `/contracts/${encodeURIComponent(required(parsed.options, "id"))}`,
      );
    else if (resource === "contracts" && action === "create")
      result = await client.request("/contracts", {
        method: "POST",
        body: {
          name: required(parsed.options, "name"),
          code: required(parsed.options, "code"),
          assetId: required(parsed.options, "asset_id"),
          compatibility: required(parsed.options, "compatibility"),
          owner: required(parsed.options, "owner"),
          description: required(parsed.options, "description"),
          qualitySlo: {
            minPassRate: Number(parsed.options.min_pass_rate ?? 0.99),
            maxFreshnessSeconds: Number(
              parsed.options.max_freshness_seconds ?? 86400,
            ),
          },
        },
      });
    else if (resource === "contracts" && action === "assess-current")
      result = await client.request(
        `/contracts/${encodeURIComponent(required(parsed.options, "id"))}/assess`,
        { method: "POST", body: {} },
      );
    else if (resource === "contracts" && action === "apply-version")
      result = await client.request(
        `/contracts/${encodeURIComponent(required(parsed.options, "id"))}/versions`,
        {
          method: "POST",
          body: {
            assessmentId: required(parsed.options, "assessment_id"),
            acknowledgeBreaking:
              parsed.options.acknowledge_breaking === true,
          },
        },
      );
    else if (resource === "contracts" && action === "check")
      result = await client.request(
        `/contracts/${encodeURIComponent(required(parsed.options, "id"))}/check`,
        { method: "POST", body: {} },
      );
    else if (resource === "metrics" && action === "list")
      result = await client.request("/metrics");
    else if (resource === "metrics" && action === "create")
      result = await client.request("/metrics", {
        method: "POST",
        body: {
          name: required(parsed.options, "name"),
          code: required(parsed.options, "code"),
          assetId: required(parsed.options, "asset_id"),
          aggregation: required(parsed.options, "aggregation").toUpperCase(),
          ...(parsed.options.field ? { field: parsed.options.field } : {}),
          ...(parsed.options.group_by ? { groupBy: parsed.options.group_by } : {}),
          definition: required(parsed.options, "definition"),
        },
      });
    else if (resource === "metrics" && action === "run")
      result = await client.request(
        `/metrics/${encodeURIComponent(required(parsed.options, "id"))}/run`,
        { method: "POST", body: {} },
      );
    else if (resource === "standards" && action === "list")
      result = await client.request("/standards");
    else if (resource === "standards" && action === "create")
      result = await client.request("/standards", {
        method: "POST",
        body: {
          name: required(parsed.options, "name"),
          code: required(parsed.options, "code"),
          assetId: required(parsed.options, "asset_id"),
          field: required(parsed.options, "field"),
          semanticType: required(parsed.options, "semantic_type").toUpperCase(),
          description: required(parsed.options, "description"),
        },
      });
    else if (resource === "standards" && action === "check")
      result = await client.request(
        `/standards/${encodeURIComponent(required(parsed.options, "id"))}/check`,
        { method: "POST", body: {} },
      );
    else if (resource === "quality" && action === "overview")
      result = await client.request("/quality/overview");
    else if (resource === "quality" && action === "list")
      result = await client.request("/quality/rules");
    else if (resource === "quality" && action === "create") {
      const type = qualityType(required(parsed.options, "type"));
      result = await client.request("/quality/rules", {
        method: "POST",
        body: {
          name: required(parsed.options, "name"),
          code: required(parsed.options, "code"),
          assetId: required(parsed.options, "asset_id"),
          field: required(parsed.options, "field"),
          type,
          config: qualityConfig(parsed.options, type),
          description: required(parsed.options, "description"),
        },
      });
    } else if (resource === "quality" && action === "version") {
      const type = qualityType(required(parsed.options, "type"));
      result = await client.request(
        `/quality/rules/${encodeURIComponent(required(parsed.options, "id"))}/versions`,
        {
          method: "POST",
          body: {
            type,
            config: qualityConfig(parsed.options, type),
            description: required(parsed.options, "description"),
          },
        },
      );
    } else if (resource === "quality" && action === "run")
      result = await client.request(
        `/quality/rules/${encodeURIComponent(required(parsed.options, "id"))}/run`,
        { method: "POST", body: {} },
      );
    else if (resource === "quality" && action === "plan")
      result = await client.request("/quality/agent/plans", {
        method: "POST",
        body: { message: required(parsed.options, "message") },
      });
    else if (resource === "quality" && action === "plans")
      result = await client.request("/quality/agent/plans");
    else if (resource === "quality" && action === "apply-plan")
      result = await client.request(
        `/quality/agent/plans/${encodeURIComponent(required(parsed.options, "id"))}/apply`,
        { method: "POST", body: {} },
      );
    else if (resource === "security" && action === "overview")
      result = await client.request("/security/overview");
    else if (resource === "security" && action === "personas")
      result = await client.request("/security/personas");
    else if (resource === "security" && action === "policies")
      result = await client.request("/security/policies");
    else if (resource === "security" && action === "create-policy")
      result = await client.request("/security/policies", {
        method: "POST",
        body: {
          name: required(parsed.options, "name"),
          code: required(parsed.options, "code"),
          assetId: required(parsed.options, "asset_id"),
          roles: list(required(parsed.options, "roles"), "--roles"),
          rowScope: required(parsed.options, "row_scope").toUpperCase(),
          defaultAction: (parsed.options.default_action ?? "DENY").toUpperCase(),
          fieldActions: Object.fromEntries(
            Object.entries(
              mapping(required(parsed.options, "actions")),
            ).map(([field, value]) => [field, value.toUpperCase()]),
          ),
          description: required(parsed.options, "description"),
        },
      });
    else if (resource === "security" && action === "version")
      result = await client.request(
        `/security/policies/${encodeURIComponent(required(parsed.options, "id"))}/versions`,
        {
          method: "POST",
          body: {
            roles: list(required(parsed.options, "roles"), "--roles"),
            rowScope: required(parsed.options, "row_scope").toUpperCase(),
            defaultAction: (parsed.options.default_action ?? "DENY").toUpperCase(),
            fieldActions: Object.fromEntries(
              Object.entries(
                mapping(required(parsed.options, "actions")),
              ).map(([field, value]) => [field, value.toUpperCase()]),
            ),
            description: required(parsed.options, "description"),
          },
        },
      );
    else if (resource === "security" && action === "query")
      result = await client.request(
        `/security/query/${encodeURIComponent(required(parsed.options, "asset_id"))}`,
        {
          method: "POST",
          body: {},
          actorId: required(parsed.options, "actor_id"),
        },
      );
    else if (resource === "security" && action === "requests")
      result = await client.request("/security/requests");
    else if (resource === "security" && action === "request")
      result = await client.request("/security/requests", {
        method: "POST",
        actorId: required(parsed.options, "actor_id"),
        body: {
          assetId: required(parsed.options, "asset_id"),
          scope: required(parsed.options, "scope").toUpperCase(),
          reason: required(parsed.options, "reason"),
        },
      });
    else if (resource === "security" && action === "review")
      result = await client.request(
        `/security/requests/${encodeURIComponent(required(parsed.options, "id"))}/review`,
        {
          method: "POST",
          actorId: required(parsed.options, "actor_id"),
          body: {
            decision: required(parsed.options, "decision").toUpperCase(),
            reviewNote: required(parsed.options, "note"),
            ...(parsed.options.duration_hours
              ? { durationHours: Number(parsed.options.duration_hours) }
              : {}),
          },
        },
      );
    else if (resource === "security" && action === "audits")
      result = await client.request("/security/audits");
    else if (resource === "security" && action === "plan")
      result = await client.request("/security/agent/plans", {
        method: "POST",
        body: { message: required(parsed.options, "message") },
      });
    else if (resource === "security" && action === "plans")
      result = await client.request("/security/agent/plans");
    else if (resource === "security" && action === "apply-plan")
      result = await client.request(
        `/security/agent/plans/${encodeURIComponent(required(parsed.options, "id"))}/apply`,
        { method: "POST", body: {} },
      );
    else if (resource === "reports" && action === "overview")
      result = await client.request("/reports/overview");
    else if (resource === "reports" && action === "datasets")
      result = await client.request("/reports/datasets");
    else if (resource === "reports" && action === "create-dataset")
      result = await client.request("/reports/datasets", {
        method: "POST",
        body: {
          name: required(parsed.options, "name"),
          code: required(parsed.options, "code"),
          assetId: required(parsed.options, "asset_id"),
          fields: list(required(parsed.options, "fields"), "--fields"),
        },
      });
    else if (resource === "reports" && action === "refresh-dataset")
      result = await client.request(
        `/reports/datasets/${encodeURIComponent(required(parsed.options, "id"))}/refresh`,
        { method: "POST", body: {} },
      );
    else if (resource === "reports" && action === "list")
      result = await client.request("/reports");
    else if (resource === "reports" && action === "create")
      result = await client.request("/reports", {
        method: "POST",
        body: {
          name: required(parsed.options, "name"),
          code: required(parsed.options, "code"),
          datasetId: required(parsed.options, "dataset_id"),
          widgets: reportWidgets(required(parsed.options, "preset")),
          description: required(parsed.options, "description"),
        },
      });
    else if (resource === "reports" && action === "version")
      result = await client.request(
        `/reports/${encodeURIComponent(required(parsed.options, "id"))}/versions`,
        {
          method: "POST",
          body: {
            widgets: reportWidgets(required(parsed.options, "preset")),
            description: required(parsed.options, "description"),
          },
        },
      );
    else if (resource === "reports" && ["run", "export"].includes(action))
      result = await client.request(
        `/reports/${encodeURIComponent(required(parsed.options, "id"))}/${action}`,
        action === "run" ? { method: "POST", body: {} } : {},
      );
    else if (resource === "reports" && action === "plan")
      result = await client.request("/reports/agent/plans", {
        method: "POST",
        body: { message: required(parsed.options, "message") },
      });
    else if (resource === "reports" && action === "plans")
      result = await client.request("/reports/agent/plans");
    else if (resource === "reports" && action === "apply-plan")
      result = await client.request(
        `/reports/agent/plans/${encodeURIComponent(required(parsed.options, "id"))}/apply`,
        { method: "POST", body: {} },
      );
    else if (resource === "ops" && action === "overview")
      result = await client.request("/operations/overview");
    else if (resource === "ops" && action === "refresh")
      result = await client.request("/operations/refresh", {
        method: "POST",
        body: {},
      });
    else if (resource === "ops" && action === "incidents")
      result = await client.request("/operations/incidents");
    else if (resource === "ops" && action === "show")
      result = await client.request(
        `/operations/incidents/${encodeURIComponent(required(parsed.options, "id"))}`,
      );
    else if (resource === "ops" && action === "acknowledge")
      result = await client.request(
        `/operations/incidents/${encodeURIComponent(required(parsed.options, "id"))}/acknowledge`,
        {
          method: "POST",
          body: {
            actor: parsed.options.actor ?? "local-operator",
            note: required(parsed.options, "note"),
          },
        },
      );
    else if (resource === "ops" && action === "resolve")
      result = await client.request(
        `/operations/incidents/${encodeURIComponent(required(parsed.options, "id"))}/resolve`,
        {
          method: "POST",
          body: {
            actor: parsed.options.actor ?? "local-operator",
            evidenceKind: required(parsed.options, "evidence_kind"),
            evidenceId: required(parsed.options, "evidence_id"),
            note: required(parsed.options, "note"),
          },
        },
      );
    else if (resource === "ops" && action === "diagnose")
      result = await client.request("/operations/agent/diagnoses", {
        method: "POST",
        body: { message: required(parsed.options, "message") },
      });
    else if (resource === "ops" && action === "diagnoses")
      result = await client.request("/operations/agent/diagnoses");
    else if (resource === "evaluations" && action === "full-lifecycle")
      result = await client.request("/evaluations/full-lifecycle/latest");
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
