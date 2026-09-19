import { randomUUID } from "node:crypto";

export const V2_OPERATIONS = Object.freeze([
  "status",
  "budget_status",
  "agent_intent_list",
  "agent_tool_list",
  "agent_intent_create",
  "agent_intent_approval_list",
  "agent_intent_approval_create",
  "agent_intent_graph",
  "agent_intent_cancel",
  "agent_specialist_cancel",
  "agent_intent_handoff_list",
  "agent_intent_handoff_create",
  "agent_intent_trace",
  "agent_journey",
  "agent_delivery_list",
  "agent_delivery_prepare",
  "agent_delivery_detail",
  "agent_delivery_cancel",
  "release_runs_list",
  "delivery_package_list",
  "delivery_package_detail",
  "delivery_package_create",
  "delivery_package_verify",
  "delivery_verification_list",
  "delivery_verification_detail",
  "delivery_verification_cancel",
  "delivery_review_list",
  "delivery_review_create",
  "release_approval_list",
  "release_approve",
  "release_list",
  "release_detail",
  "release_create",
  "release_rollback",
  "release_monitor",
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
  "source_list",
  "source_create",
  "source_server_mysql_create",
  "source_test",
  "source_metadata",
  "source_revision",
  "sync_task_list",
  "sync_task_create",
  "sync_task_run",
  "sync_target_rows",
  "ingestion_plan_list",
  "ingestion_plan_create",
  "ingestion_plan_apply",
  "stream_source_list",
  "stream_source_create",
  "stream_source_revision",
  "stream_job_list",
  "stream_job_create",
  "stream_job_start",
  "stream_job_stop",
  "stream_job_recover",
  "stream_job_state",
  "stream_job_checkpoints",
  "stream_monitor",
  "realtime_plan_list",
  "realtime_plan_create",
  "realtime_plan_apply",
  "asset_list",
  "asset_detail",
  "asset_lineage",
  "asset_impact",
  "asset_annotate",
  "metric_list",
  "metric_create",
  "metric_run",
  "standard_list",
  "standard_create",
  "standard_check",
  "asset_agent_list",
  "asset_agent_create",
  "contract_list",
  "contract_detail",
  "contract_create",
  "contract_assess",
  "contract_version",
  "contract_check",
  "quality_overview",
  "quality_rule_list",
  "quality_rule_create",
  "quality_rule_version",
  "quality_rule_run",
  "quality_plan_list",
  "quality_plan_create",
  "quality_plan_apply",
  "security_overview",
  "security_persona_list",
  "security_policy_list",
  "security_policy_create",
  "security_policy_version",
  "security_query",
  "security_request_list",
  "security_request_create",
  "security_request_review",
  "security_audit_list",
  "security_plan_list",
  "security_plan_create",
  "security_plan_apply",
  "report_overview",
  "report_dataset_list",
  "report_dataset_create",
  "report_dataset_refresh",
  "report_list",
  "report_create",
  "report_version",
  "report_run",
  "report_export",
  "report_plan_list",
  "report_plan_create",
  "report_plan_apply",
  "ops_overview",
  "ops_refresh",
  "ops_incident_list",
  "ops_incident_detail",
  "ops_incident_acknowledge",
  "ops_incident_resolve",
  "ops_diagnosis_list",
  "ops_diagnosis_create",
  "full_lifecycle_evaluation_latest",
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
    {
      method = "GET",
      body,
      authorization,
      actorId,
      idempotencyKey,
      timeoutMs,
    } = {},
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
          "X-Shuduo-Client": this.client,
          "X-Project-Id": this.projectId,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(method === "GET"
            ? {}
            : { "Idempotency-Key": idempotencyKey ?? randomUUID() }),
          ...(authorization ? { Authorization: authorization } : {}),
          ...(actorId ? { "X-Actor-Id": actorId } : {}),
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
