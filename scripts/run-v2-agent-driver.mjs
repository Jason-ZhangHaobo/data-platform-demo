import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const fail = code => Object.assign(new Error(code), { code });
const protocol = "shuduo-private-agent-tick/v1";

export function createPrivateAgentInvoker({ functionName, region, execImpl = exec }) {
  if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/.test(functionName ?? "") || !/^cn-[a-z]+$/.test(region ?? ""))
    throw fail("AGENT_DRIVER_TARGET_INVALID");
  return async payload => {
    let output;
    try {
      const { stdout } = await execImpl("aliyun", ["fc", "POST", `/2023-03-30/functions/${functionName}/invocations`,
        "--region", region, "--read-timeout", "140", "--connect-timeout", "10", "--retry-count", "0",
        "--header", "Content-Type=application/octet-stream", "--body", JSON.stringify(payload)],
      { timeout: 150000, maxBuffer: 65536, encoding: "utf8" });
      output = JSON.parse(stdout);
      if (typeof output === "string") output = JSON.parse(output);
    } catch { throw fail("AGENT_DRIVER_INVOKE_UNCONFIRMED"); }
    if (output?.protocol !== protocol || !["ADVANCED", "STEP_FAILED", "IDLE", "BUSY", "IN_PROGRESS", "LEASE_EXPIRED"].includes(output.state))
      throw fail("AGENT_DRIVER_RESPONSE_INVALID");
    return output;
  };
}

// A bounded headless supervisor: runs independently of the browser, but only
// while this process is alive. It does not install a timer or change cloud IAM.
export async function runAgentDriver({ invoke, maxTicks = 60, intervalMs = 5000,
  maxDurationMs = 300000, now = Date.now,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)), signal, onEvent = () => {} }) {
  if (!Number.isSafeInteger(maxTicks) || maxTicks < 1 || maxTicks > 120 ||
      !Number.isSafeInteger(intervalMs) || intervalMs < 5000 || intervalMs > 60000 ||
      !Number.isSafeInteger(maxDurationMs) || maxDurationMs < 30000 || maxDurationMs > 900000)
    throw fail("AGENT_DRIVER_LIMIT_INVALID");
  let requestId = randomUUID(), errors = 0, idle = 0;
  const deadline = now() + maxDurationMs;
  for (let i = 0; i < maxTicks && !signal?.aborted && now() < deadline; i++) {
    try {
      const result = await invoke({ operation: "PRIVATE_AGENT_TICK_V1", requestId });
      if (result?.protocol !== protocol) throw fail("AGENT_DRIVER_RESPONSE_INVALID");
      onEvent({ tick: i + 1, state: result.state, ...(result.stage ? { stage: result.stage } : {}) });
      requestId = randomUUID(); // Only after a confirmed response; unknown ACK reuses the ID.
      errors = result.state === "STEP_FAILED" ? errors + 1 : 0;
      idle = result.state === "IDLE" && result.pending === 0 ? idle + 1 : 0;
      if (errors >= 3) throw fail("AGENT_DRIVER_REPEATED_STEP_FAILURE");
      if (idle >= 2) return { reason: "IDLE", ticks: i + 1 };
    } catch (error) {
      if (error.code === "AGENT_DRIVER_REPEATED_STEP_FAILURE") throw error;
      errors++;
      onEvent({ tick: i + 1, state: "UNCONFIRMED" });
      if (errors >= 3) throw fail("AGENT_DRIVER_REPEATED_INVOKE_FAILURE");
    }
    if (i + 1 < maxTicks && !signal?.aborted && now() < deadline) await wait(Math.min(intervalMs, deadline - now()));
  }
  return { reason: signal?.aborted ? "STOPPED" : now() >= deadline ? "TIME_LIMIT" : "TICK_LIMIT" };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  try {
    const result = await runAgentDriver({
      invoke: createPrivateAgentInvoker({ functionName: process.env.V2_FUNCTION_NAME, region: process.env.V2_REGION }),
      maxTicks: Number(process.env.V2_AGENT_DRIVER_MAX_TICKS ?? 60),
      intervalMs: Number(process.env.V2_AGENT_DRIVER_INTERVAL_MS ?? 5000),
      signal: controller.signal, onEvent: event => process.stdout.write(JSON.stringify(event) + "\n"),
    });
    process.stdout.write(JSON.stringify(result) + "\n");
  } catch (error) {
    process.stderr.write(JSON.stringify({ code: /^AGENT_DRIVER_[A-Z_]+$/.test(error.code ?? "") ? error.code : "AGENT_DRIVER_FAILED" }) + "\n");
    process.exitCode = 1;
  }
}
