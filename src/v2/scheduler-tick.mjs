import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const PROTOCOL = "shuzhan-scheduler-tick/v1";

const validateSecret = (value) => {
  if (
    typeof value !== "string" ||
    value.length < 32 ||
    value.length > 512 ||
    value.trim() !== value ||
    /\s/.test(value)
  )
    throw new Error("持久调度共享密钥必须是32—512字符且不含空白");
  return value;
};

const bodyHash = (body) =>
  createHash("sha256").update(body, "utf8").digest("hex");

export function signSchedulerTick({ sharedSecret, timestamp, nonce, body }) {
  return (
    "v1=" +
    createHmac("sha256", sharedSecret)
      .update(`${PROTOCOL}\n${timestamp}\n${nonce}\n${bodyHash(body)}`, "utf8")
      .digest("hex")
  );
}

export function verifySchedulerTick({
  sharedSecret,
  timestamp,
  nonce,
  body,
  signature,
  now = Date.now(),
  maxSkewMs = 60_000,
}) {
  if (!/^\d{13}$/.test(String(timestamp))) return false;
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(String(nonce))) return false;
  if (Math.abs(now - Number(timestamp)) > maxSkewMs) return false;
  const expected = signSchedulerTick({ sharedSecret, timestamp, nonce, body }),
    actual = String(signature ?? "");
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

export function schedulerTickConfigFromEnvironment(env = process.env) {
  if (env.V2_RELEASE_SCHEDULER_MODE !== "DURABLE_TICK") return undefined;
  const maxSkewMs = Number(env.V2_SCHEDULER_TICK_MAX_SKEW_MS ?? 60_000),
    leaseMs = Number(env.V2_SCHEDULER_LEASE_MS ?? 300_000);
  if (!Number.isSafeInteger(maxSkewMs) || maxSkewMs < 5_000 || maxSkewMs > 300_000)
    throw new Error("持久调度签名时钟偏差配置不合法");
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 30_000 || leaseMs > 900_000)
    throw new Error("持久调度租约配置不合法");
  return {
    sharedSecret: validateSecret(env.V2_SCHEDULER_TICK_SECRET),
    maxSkewMs,
    leaseMs,
  };
}

export const schedulerTickProtocol = PROTOCOL;
