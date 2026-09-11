import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { runCli } from "../bin/dataplatform.mjs";

describe("CLI and MCP capability parity", () => {
  test("CLI publishes a development job through the shared API with an access token", async () => {
    const originalFetch = globalThis.fetch;
    const originalLog = console.log;
    const requests = [];
    globalThis.fetch = async (url, options) => {
      requests.push({ url, options });
      return new Response(JSON.stringify({ id: "job-demo", status: "PUBLISHED" }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    console.log = () => {};
    try {
      const code = await runCli(["dev", "deploy", "--job-id", "job-demo", "--base-url", "https://demo.example", "--access-token", "token-demo", "--json"], {});
      assert.equal(code, 0);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].url, "https://demo.example/api/dev/jobs/job-demo/deploy");
      assert.equal(requests[0].options.method, "POST");
      assert.equal(requests[0].options.headers.Authorization, "Bearer token-demo");
    } finally {
      globalThis.fetch = originalFetch;
      console.log = originalLog;
    }
  });

  test("MCP advertises development publish and operations acknowledgement tools", async () => {
    const child = spawn(process.execPath, ["bin/dataplatform-mcp.mjs"], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })}\n`);
    const exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    assert.equal(exitCode, 0);
    const response = JSON.parse(stdout.trim());
    const names = response.result.tools.map((tool) => tool.name);
    assert.equal(names.includes("dev_job_publish"), true);
    assert.equal(names.includes("ops_incident_acknowledge"), true);
    assert.equal(names.includes("ops_incident_resolve"), false);
  });
});
