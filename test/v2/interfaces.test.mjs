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
import { runV2Cli, V2_CLI_OPERATIONS } from "../../bin/shuzhan.mjs";
import {
  handleV2Mcp,
  V2_MCP_OPERATIONS,
  V2_MCP_TOOL_NAMES,
} from "../../bin/shuzhan-mcp.mjs";
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
  assert.equal(requests[0].url, "https://v2.example/api/v2/data-services/dapis");
  assert.equal(requests[0].options.headers["X-Shuzhan-Client"], "cli");
  assert.equal(
    requests[0].options.headers["X-Project-Id"],
    "project-securities-lab",
  );
  assert.equal(requests[0].options.headers["Idempotency-Key"], "same-operation");
  assert.equal(requests[0].options.redirect, "error");
  assert.equal(requests[1].options.headers.Authorization, "Bearer LOCAL_TEST_ONLY");
  assert.equal("Idempotency-Key" in requests[1].options.headers, false);
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
      { SHUZHAN_APP_TOKEN: "SECRET_NOT_IN_ARGV" },
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
    "quality_overview",
    "quality_rule_list",
    "quality_rule_create",
    "quality_rule_version",
    "quality_rule_run",
    "quality_plan_list",
    "quality_plan_create",
    "quality_plan_apply",
  ])
    assert.ok(names.includes(required));
  assert.match(createApp.description, /明确确认/);
});

test("CLI and MCP reach the same live V2 API instead of legacy simulation routes", async () => {
  const root = mkdtempSync(join(tmpdir(), "shuzhan-v2-interfaces-")),
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

    const child = spawn(process.execPath, ["bin/shuzhan-mcp.mjs"], {
      cwd: process.cwd(),
      env: { ...process.env, SHUZHAN_V2_API_BASE_URL: baseUrl },
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
        "\n",
    );
    const exit = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(exit, 0, stderr);
    const responses = stdout.trim().split("\n").map((line) => JSON.parse(line)),
      response = responses.find((item) => item.id === 2),
      assetResponse = responses.find((item) => item.id === 3);
    assert.equal(
      response.result.structuredContent.adapter,
      cliMonitor.adapter,
    );
    assert.deepEqual(
      response.result.structuredContent.counts,
      cliMonitor.counts,
    );
    assert.deepEqual(assetResponse.result.structuredContent, cliAssets);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    businessStore.close();
    store.close();
  }
});
