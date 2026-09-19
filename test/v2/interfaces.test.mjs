import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import {
  V2Client,
  V2ApiError,
  V2_OPERATIONS,
} from "../../src/v2/client.mjs";
import { runV2Cli, V2_CLI_OPERATIONS } from "../../bin/shuduo.mjs";
import {
  handleV2Mcp,
  V2_MCP_OPERATIONS,
  V2_MCP_TOOL_NAMES,
} from "../../bin/shuduo-mcp.mjs";
import { MetadataStore } from "../../src/v2/store.mjs";
import { BusinessQueryStore } from "../../src/v2/data-services.mjs";
import { createV2Server } from "../../src/v2/server.mjs";

test("shared V2 client sends scoped identity, idempotency and app authorization", async () => {
  const requests = [],
    client = new V2Client({
      baseUrl: "https://v2.example/api/v2",
      client: "cli",
      projectId: "project-securities-lab",
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    });
  await client.request("/data-services/dapis", {
    method: "POST",
    body: { name: "测试" },
    idempotencyKey: "same-operation",
  });
  await client.request("/open/dapis/demo", {
    authorization: "Bearer LOCAL_TEST_ONLY",
  });
  await client.request("/security/query/landing%3Araw_positions", {
    method: "POST",
    body: {},
    actorId: "user-wealth-advisor",
  });
  assert.equal(requests[0].url, "https://v2.example/api/v2/data-services/dapis");
  assert.equal(requests[0].options.headers["X-Shuduo-Client"], "cli");
  assert.equal(
    requests[0].options.headers["X-Project-Id"],
    "project-securities-lab",
  );
  assert.equal(requests[0].options.headers["Idempotency-Key"], "same-operation");
  assert.equal(requests[0].options.redirect, "error");
  assert.equal(requests[1].options.headers.Authorization, "Bearer LOCAL_TEST_ONLY");
  assert.equal("Idempotency-Key" in requests[1].options.headers, false);
  assert.equal(
    requests[2].options.headers["X-Actor-Id"],
    "user-wealth-advisor",
  );
});

test("shared V2 client preserves API status and diagnostic code", async () => {
  const client = new V2Client({
    fetchImpl: async () =>
      new Response(
        JSON.stringify({ message: "超过限流", code: "RATE_LIMITED" }),
        { status: 429, headers: { "Content-Type": "application/json" } },
      ),
  });
  await assert.rejects(
    client.request("/open/dapis/demo"),
    (error) => {
      assert.ok(error instanceof V2ApiError);
      assert.equal(error.status, 429);
      assert.equal(error.code, "RATE_LIMITED");
      return true;
    },
  );
});

test("CLI covers the shared V2 operation contract without putting app tokens in argv", async () => {
  assert.deepEqual(V2_CLI_OPERATIONS, V2_OPERATIONS);
  const requests = [],
    client = {
      async request(path, options) {
        requests.push({ path, options });
        return { ok: true };
      },
    },
    output = [];
  assert.equal(
    await runV2Cli(
      [
        "services",
        "create-dapi",
        "--name",
        "客户资产",
        "--slug",
        "customer-assets",
        "--source-run-id",
        "run-id",
        "--fields",
        "client_id,total_assets",
      ],
      {},
      { client, output: (value) => output.push(value), error: output.push },
    ),
    0,
  );
  assert.deepEqual(requests[0].options.body.fields, [
    "client_id",
    "total_assets",
  ]);
  assert.equal(
    await runV2Cli(
      [
        "services",
        "invoke",
        "--type",
        "dapi",
        "--slug",
        "customer-assets",
        "--client-id",
        "CLIENT-001",
      ],
      { SHUDUO_APP_TOKEN: "SECRET_NOT_IN_ARGV" },
      {
        client,
        output: (value) => output.push(value),
        error: (value) => output.push(value),
      },
    ),
    0,
  );
  assert.equal(
    requests[1].options.authorization,
    "Bearer SECRET_NOT_IN_ARGV",
  );
  assert.equal(JSON.stringify(requests[1].path).includes("SECRET_NOT_IN_ARGV"), false);
  assert.equal(
    await runV2Cli(
      [
        "sync",
        "create",
        "--name",
        "持仓增量",
        "--source-id",
        "source-id",
        "--target-table",
        "raw_positions",
        "--mode",
        "incremental",
        "--mapping",
        "position_id:position_id,trade_date:trade_date",
        "--keys",
        "position_id",
        "--watermark",
        "trade_date",
      ],
      {},
      {
        client,
        output: (value) => output.push(value),
        error: (value) => output.push(value),
      },
    ),
    0,
  );
  assert.equal(requests[2].path, "/sync/tasks");
  assert.equal(requests[2].options.body.mode, "INCREMENTAL_UPSERT");
  assert.deepEqual(requests[2].options.body.mapping, {
    position_id: "position_id",
    trade_date: "trade_date",
  });
  assert.equal(
    await runV2Cli(
      [
        "streams",
        "create-job",
        "--name",
        "行情同步",
        "--source-id",
        "stream-source-id",
        "--target-table",
        "realtime_quotes",
        "--checkpoint-every",
        "3",
      ],
      {},
      {
        client,
        output: (value) => output.push(value),
        error: (value) => output.push(value),
      },
    ),
    0,
  );
  assert.equal(requests[3].path, "/streams/jobs");
  assert.equal(requests[3].options.body.checkpointEvery, 3);
  assert.equal(
    await runV2Cli(
      ["assets", "lineage", "--id", "landing:raw_positions"],
      {},
      {
        client,
        output: (value) => output.push(value),
        error: (value) => output.push(value),
      },
    ),
    0,
  );
  assert.equal(requests[4].path, "/assets/landing%3Araw_positions/lineage");
  assert.equal(
    await runV2Cli(
      [
        "quality",
        "create",
        "--name",
        "持仓市值范围",
        "--code",
        "holding_value_range",
        "--asset-id",
        "landing:raw_positions",
        "--field",
        "market_value",
        "--type",
        "value-range",
        "--min",
        "0.00",
        "--max",
        "5000.00",
        "--description",
        "受控范围规则",
      ],
      {},
      {
        client,
        output: (value) => output.push(value),
        error: (value) => output.push(value),
      },
    ),
    0,
  );
  assert.equal(requests[5].path, "/quality/rules");
  assert.deepEqual(requests[5].options.body.config, {
    min: "0.00",
    max: "5000.00",
  });
  assert.equal(
    await runV2Cli(
      [
        "security",
        "query",
        "--asset-id",
        "landing:raw_positions",
        "--actor-id",
        "user-wealth-advisor",
      ],
      {},
      {
        client,
        output: (value) => output.push(value),
        error: (value) => output.push(value),
      },
    ),
    0,
  );
  assert.equal(requests[6].path, "/security/query/landing%3Araw_positions");
  assert.equal(requests[6].options.actorId, "user-wealth-advisor");
  assert.equal(
    await runV2Cli(
      [
        "reports",
        "create",
        "--name",
        "持仓结构报告",
        "--code",
        "holdings_structure",
        "--dataset-id",
        "dataset-id",
        "--preset",
        "holdings",
        "--description",
        "持仓指标与分布",
      ],
      {},
      {
        client,
        output: (value) => output.push(value),
        error: (value) => output.push(value),
      },
    ),
    0,
  );
  assert.equal(requests[7].path, "/reports");
  assert.equal(requests[7].options.body.widgets.length, 4);
  assert.equal(requests[7].options.body.widgets[2].type, "PIE");
  assert.equal(
    await runV2Cli(
      ["ops", "show", "--id", "incident-id"],
      {},
      {
        client,
        output: (value) => output.push(value),
        error: (value) => output.push(value),
      },
    ),
    0,
  );
  assert.equal(requests[8].path, "/operations/incidents/incident-id");
  assert.equal(
    await runV2Cli(
      ["evaluations", "full-lifecycle"],
      {},
      {
        client,
        output: (value) => output.push(value),
        error: (value) => output.push(value),
      },
    ),
    0,
  );
  assert.equal(requests[9].path, "/evaluations/full-lifecycle/latest");
  assert.equal(
    await runV2Cli(
      [
        "delivery",
        "create",
        "--source-run-id",
        "run-id",
        "--name",
        "客户资产交付",
      ],
      {},
      {
        client,
        output: (value) => output.push(value),
        error: (value) => output.push(value),
      },
    ),
    0,
  );
  assert.equal(requests[10].path, "/delivery/packages");
  assert.deepEqual(requests[10].options.body, {
    sourceRunId: "run-id",
    name: "客户资产交付",
  });
  assert.equal(
    await runV2Cli(
      [
        "delivery",
        "review",
        "--id",
        "package-id",
        "--package-digest",
        "a".repeat(64),
        "--verification-id",
        "verification-id",
        "--note",
        "已审阅代码、断言与部署边界",
        "--attest-code",
        "--attest-assertions",
        "--attest-delivery-files",
        "--attest-local-scope",
      ],
      {},
      {
        client,
        output: (value) => output.push(value),
        error: (value) => output.push(value),
      },
    ),
    0,
  );
  assert.equal(requests[11].path, "/delivery/packages/package-id/review");
  assert.equal(requests[11].options.body.packageDigest, "a".repeat(64));
  assert.deepEqual(requests[11].options.body.attestations, {
    code: true,
    assertions: true,
    deliveryFiles: true,
    localScope: true,
  });
  assert.equal(
    await runV2Cli(
      [
        "releases",
        "approve",
        "--package-id",
        "package-id",
        "--package-digest",
        "a".repeat(64),
        "--review-id",
        "review-id",
      ],
      {},
      {
        client,
        output: (value) => output.push(value),
        error: (value) => output.push(value),
      },
    ),
    0,
  );
  assert.equal(requests[12].path, "/delivery/packages/package-id/approve");
  assert.equal(requests[12].options.body.reviewId, "review-id");
  assert.equal(
    await runV2Cli(
      ["agent", "journey", "--id", "task-id"],
      {},
      {
        client,
        output: (value) => output.push(value),
        error: (value) => output.push(value),
      },
    ),
    0,
  );
  assert.equal(requests[13].path, "/agent/tasks/task-id/journey");
  assert.equal(
    await runV2Cli(
      ["agent", "prepare-delivery", "--id", "task-id"],
      {},
      {
        client,
        output: (value) => output.push(value),
        error: (value) => output.push(value),
      },
    ),
    0,
  );
  assert.equal(requests[14].path, "/agent/tasks/task-id/prepare-delivery");
  assert.deepEqual(requests[14].options.body, {});
});

test("CLI maps cross-module Agent understanding to the same V2 atomic route", async () => {
  const requests = [],
    client = {
      async request(path, options) {
        requests.push({ path, options });
        return { ok: true };
      },
    },
    output = [];
  assert.equal(
    await runV2Cli(
      ["agent", "understand", "--message", "理解持仓字段后生成资产分析报表"],
      {},
      { client, output: (value) => output.push(value), error: (value) => output.push(value) },
    ),
    0,
  );
  assert.equal(requests[0].path, "/agent/intents");
  assert.deepEqual(requests[0].options.body, {
    message: "理解持仓字段后生成资产分析报表",
  });
  assert.equal(
    await runV2Cli(
      ["agent", "handoff", "--id", "intent-id", "--destination", "reports"],
      {},
      { client, output: (value) => output.push(value), error: (value) => output.push(value) },
    ),
    0,
  );
  assert.equal(requests[1].path, "/agent/intents/intent-id/handoffs");
  assert.deepEqual(requests[1].options.body, { destinationId: "reports" });
  assert.equal(
    await runV2Cli(
      ["sources", "create-server-mysql", "--name", "服务端虚构持仓", "--table", "synthetic_positions"],
      {},
      { client, output: (value) => output.push(value), error: (value) => output.push(value) },
    ),
    0,
  );
  assert.equal(requests[2].path, "/sources");
  assert.deepEqual(requests[2].options.body, {
    name: "服务端虚构持仓",
    sourceType: "SERVER_MYSQL",
    tableName: "synthetic_positions",
  });
  assert.equal(
    await runV2Cli(
      ["agent", "trace", "--id", "intent-id"],
      {},
      { client, output: (value) => output.push(value), error: (value) => output.push(value) },
    ),
    0,
  );
  assert.equal(requests[3].path, "/agent/intents/intent-id/trace");
  assert.equal(
    await runV2Cli(
      ["agent", "approvals", "--id", "intent-id"],
      {},
      { client, output: (value) => output.push(value), error: (value) => output.push(value) },
    ),
    0,
  );
  assert.equal(requests[4].path, "/agent/intents/intent-id/approvals");
  assert.equal(
    await runV2Cli(
      ["agent", "approve", "--id", "intent-id", "--destination", "reports"],
      {},
      { client, output: (value) => output.push(value), error: (value) => output.push(value) },
    ),
    0,
  );
  assert.equal(requests[5].path, "/agent/intents/intent-id/approvals");
  assert.deepEqual(requests[5].options.body, { destinationId: "reports" });
  assert.equal(
    await runV2Cli(
      ["agent", "graph", "--id", "intent-id"],
      {},
      { client, output: (value) => output.push(value), error: (value) => output.push(value) },
    ),
    0,
  );
  assert.equal(requests[6].path, "/agent/intents/intent-id/graph");
});

test("MCP advertises the full V2 data-service surface with explicit credential cautions", async () => {
  assert.deepEqual(V2_MCP_OPERATIONS, V2_OPERATIONS);
  const listed = JSON.parse(
      await handleV2Mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    ),
    names = listed.result.tools.map((tool) => tool.name),
    createApp = listed.result.tools.find(
      (tool) => tool.name === "service_application_create",
    );
  assert.deepEqual(names, V2_MCP_TOOL_NAMES);
  for (const required of [
    "budget_status",
    "agent_intent_list",
    "agent_intent_create",
    "agent_intent_approval_list",
    "agent_intent_approval_create",
    "agent_intent_graph",
    "agent_intent_handoff_list",
    "agent_intent_handoff_create",
    "agent_intent_trace",
    "agent_journey",
    "agent_delivery_list",
    "agent_delivery_prepare",
    "agent_delivery_detail",
    "agent_delivery_cancel",
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
    "dapi_create",
    "xapi_create",
    "data_service_test",
    "data_service_publish",
    "data_service_openapi",
    "data_service_calls",
    "service_application_create",
    "service_application_revoke",
    "data_service_invoke",
    "source_list",
    "source_create",
    "source_server_mysql_create",
    "source_test",
    "source_metadata_collect",
    "source_revision_create",
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
  ])
    assert.ok(names.includes(required));
  assert.match(createApp.description, /明确确认/);
  assert.match(
    listed.result.tools.find((tool) => tool.name === "release_approve")
      .description,
    /明确确认/,
  );
  assert.match(
    listed.result.tools.find((tool) => tool.name === "agent_delivery_cancel")
      .description,
    /明确确认/,
  );
});

test("CLI and MCP reach the same live V2 API instead of legacy simulation routes", async () => {
  const root = mkdtempSync(join(tmpdir(), "shuduo-v2-interfaces-")),
    store = new MetadataStore(join(root, "platform.sqlite")),
    businessStore = new BusinessQueryStore(":memory:"),
    app = createV2Server({
      store,
      businessStore,
      env: { V2_LOCAL_DEVELOPMENT: "true" },
    });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${app.server.address().port}/api/v2`,
    cliOutput = [],
    cliError = [];
  try {
    const code = await runV2Cli(
      ["services", "list", "--type", "dapi", "--base-url", baseUrl],
      {},
      { output: (value) => cliOutput.push(value), error: (value) => cliError.push(value) },
    );
    assert.equal(code, 0, cliError.join("\n"));
    assert.deepEqual(JSON.parse(cliOutput[0]), []);
    const monitorCode = await runV2Cli(
      ["streams", "monitor", "--base-url", baseUrl],
      {},
      {
        output: (value) => cliOutput.push(value),
        error: (value) => cliError.push(value),
      },
    );
    assert.equal(monitorCode, 0, cliError.join("\n"));
    const cliMonitor = JSON.parse(cliOutput[1]);
    assert.equal(cliMonitor.adapter, "local-event-log-v1");
    assert.equal(cliMonitor.kafkaConnected, false);
    const assetCode = await runV2Cli(
      ["assets", "list", "--base-url", baseUrl],
      {},
      {
        output: (value) => cliOutput.push(value),
        error: (value) => cliError.push(value),
      },
    );
    assert.equal(assetCode, 0, cliError.join("\n"));
    const cliAssets = JSON.parse(cliOutput[2]);
    assert.ok(cliAssets.some((asset) => asset.id === "fixture:positions"));
    const deliveryCode = await runV2Cli(
      ["delivery", "packages", "--base-url", baseUrl],
      {},
      {
        output: (value) => cliOutput.push(value),
        error: (value) => cliError.push(value),
      },
    );
    assert.equal(deliveryCode, 0, cliError.join("\n"));
    const cliPackages = JSON.parse(cliOutput[3]);
    assert.deepEqual(cliPackages, []);
    const reviewCode = await runV2Cli(
      ["delivery", "reviews", "--base-url", baseUrl],
      {},
      {
        output: (value) => cliOutput.push(value),
        error: (value) => cliError.push(value),
      },
    );
    assert.equal(reviewCode, 0, cliError.join("\n"));
    const cliReviews = JSON.parse(cliOutput[4]);
    assert.deepEqual(cliReviews, []);

    const child = spawn(process.execPath, ["bin/shuduo-mcp.mjs"], {
      cwd: process.cwd(),
      env: { ...process.env, SHUDUO_V2_API_BASE_URL: baseUrl },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.stdin.end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "stream_monitor", arguments: {} },
      }) +
        "\n" +
        JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
        params: { name: "asset_list", arguments: {} },
      }) +
        "\n" +
        JSON.stringify({
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: { name: "delivery_package_list", arguments: {} },
        }) +
        "\n" +
        JSON.stringify({
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: { name: "delivery_review_list", arguments: {} },
        }) +
        "\n",
    );
    const exit = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(exit, 0, stderr);
    const responses = stdout.trim().split("\n").map((line) => JSON.parse(line)),
      response = responses.find((item) => item.id === 2),
      assetResponse = responses.find((item) => item.id === 3),
      packageResponse = responses.find((item) => item.id === 4),
      reviewResponse = responses.find((item) => item.id === 5);
    assert.equal(
      response.result.structuredContent.adapter,
      cliMonitor.adapter,
    );
    assert.deepEqual(
      response.result.structuredContent.counts,
      cliMonitor.counts,
    );
    assert.deepEqual(assetResponse.result.structuredContent, cliAssets);
    assert.deepEqual(packageResponse.result.structuredContent, cliPackages);
    assert.deepEqual(reviewResponse.result.structuredContent, cliReviews);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    businessStore.close();
    store.close();
  }
});
