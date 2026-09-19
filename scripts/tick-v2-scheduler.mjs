import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { signSchedulerTick } from "../src/v2/scheduler-tick.mjs";

const fail = (message) => Object.assign(new Error(message), { safe: true });

export function createSchedulerTickRequest(input = {}, now = Date.now()) {
  let endpoint;
  try {
    endpoint = new URL("/api/v2/internal/scheduler/tick", input.publicUrl);
  } catch {
    throw fail("V2调度公网地址不合法");
  }
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password)
    throw fail("V2持久调度只允许无凭证HTTPS地址");
  const sharedSecret = input.sharedSecret;
  if (
    typeof sharedSecret !== "string" ||
    sharedSecret.length < 32 ||
    sharedSecret.length > 512 ||
    /\s/.test(sharedSecret)
  )
    throw fail("V2持久调度密钥格式不合法");
  const limit = input.limit === undefined ? 1 : Number(input.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10)
    throw fail("V2持久调度领取上限不合法");
  const body = JSON.stringify({ limit }),
    timestamp = String(now),
    nonce = randomBytes(24).toString("base64url");
  return {
    endpoint: endpoint.toString(),
    body,
    headers: {
      "Content-Type": "application/json",
      "X-Project-Id": input.projectId ?? "project-securities-lab",
      "X-Shuzhan-Timestamp": timestamp,
      "X-Shuzhan-Nonce": nonce,
      "X-Shuzhan-Signature": signSchedulerTick({
        sharedSecret,
        timestamp,
        nonce,
        body,
      }),
    },
  };
}

async function run() {
  try {
    const request = createSchedulerTickRequest({
        publicUrl: process.env.V2_PUBLIC_URL,
        sharedSecret: process.env.V2_SCHEDULER_TICK_SECRET,
        projectId: process.env.V2_PROJECT_ID,
        limit: process.env.V2_SCHEDULER_TICK_LIMIT,
      }),
      controller = new AbortController(),
      timer = setTimeout(() => controller.abort("timeout"), 180_000);
    try {
      const response = await fetch(request.endpoint, {
          method: "POST",
          headers: request.headers,
          body: request.body,
          redirect: "error",
          signal: controller.signal,
        }),
        value = await response.json().catch(() => undefined);
      if (!response.ok)
        throw fail(`V2持久调度tick失败（HTTP ${response.status}）`);
      if (
        value?.mode !== "CLOUD_DURABLE_SCHEDULE" ||
        !Array.isArray(value.executed) ||
        !Number.isSafeInteger(value.remaining)
      )
        throw fail("V2持久调度tick返回格式不合法");
      process.stdout.write(
        JSON.stringify({
          ok: true,
          recovered: value.recovered,
          due: value.due,
          executed: value.executed.length,
          remaining: value.remaining,
        }) + "\n",
      );
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    process.stderr.write((error.safe ? error.message : "V2持久调度调用失败") + "\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await run();
