import { setTimeout as delay } from "node:timers/promises";
import { normalizeModelKey } from "../src/v2/model-credentials.mjs";
import { modelSettings } from "../src/v2/model.mjs";
import { functionDigest } from "./refresh-v2-spark-readiness.mjs";

const digestPattern = /^[a-f0-9]{64}$/;
const beijingEndpoint = /^https:\/\/(?:dashscope\.aliyuncs\.com|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cn-beijing\.maas\.aliyuncs\.com)\/compatible-mode\/v1$/;
const failure = (code, putAttempts = 0) => Object.assign(new Error(code), { code, putAttempts });
const stable = fn => (fn.state == null || fn.state === "Active") &&
  (fn.lastUpdateStatus == null || fn.lastUpdateStatus === "Successful");

export function isBeijingModelEndpoint(baseUrl) {
  return typeof baseUrl === "string" && baseUrl === baseUrl.trim() && beijingEndpoint.test(baseUrl) &&
    baseUrl !== "https://trial.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";
}

// Reviewers bind both the full original snapshot and the fingerprint of everything
// that must be preserved. Reconciliation consequently does not need the old key.
export function preservedModelConfigDigest(fn) {
  const environmentVariables = { ...fn.environmentVariables };
  delete environmentVariables.DASHSCOPE_API_KEY;
  return functionDigest({ ...fn, environmentVariables });
}

function validateBoundary(fn, name, attempts) {
  const env = fn?.environmentVariables;
  if (fn?.functionName !== name || fn.runtime !== "custom.debian12" || fn.instanceConcurrency !== 8 ||
      env?.V2_LOCAL_DEVELOPMENT !== "false" || env.V2_PROVISIONING_ONLY !== "true" ||
      env.V2_PRIVATE_SMOKE_ENABLED !== "true" || env.V2_FC_PUBLIC_HTTP_ENABLED !== "true" ||
      env.V2_FC_PUBLIC_READ_ONLY !== "true" || env.V2_FC_PUBLIC_WRITE_SCOPE || env.V2_PRIVATE_RELEASE_ENABLED === "true" ||
      env.V2_MYSQL_USER !== "platform_app" || env.V2_MYSQL_DATABASE !== "platform_meta" ||
      typeof env.DASHSCOPE_API_KEY !== "string" || !env.DASHSCOPE_API_KEY.length)
    throw failure("MODEL_SYNC_BOUNDARY_MISMATCH", attempts);
  const settings = modelSettings(env);
  if (!isBeijingModelEndpoint(settings.baseUrl) || typeof settings.model !== "string" ||
      settings.model !== settings.model.trim() || !/^qwen3\.7-plus(?:-\d{4}-\d{2}-\d{2})?$/.test(settings.model))
    throw failure("MODEL_SYNC_BOUNDARY_MISMATCH", attempts);
  return settings;
}

// The caller owns the approved target, serialization of FC writers, and durable
// write intent. A fresh attempt must never be used to recover a lost PUT reply.
export async function syncControlModelSecret({
  mode, name, modelKey, baselineDigest, preservedDigest, api, probe, readDelay = () => delay(1500),
}) {
  if (!["apply", "verify"].includes(mode) || typeof name !== "string" || name !== name.trim() ||
      !/^dataplatform-v2-[a-z0-9-]{1,60}$/.test(name) ||
      !digestPattern.test(baselineDigest ?? "") || !digestPattern.test(preservedDigest ?? "") ||
      typeof api !== "function" || typeof probe !== "function" || typeof readDelay !== "function")
    throw failure("MODEL_SYNC_INPUT_INVALID");
  try {
    if (normalizeModelKey(modelKey) !== modelKey) throw failure("MODEL_SYNC_INPUT_INVALID");
  } catch { throw failure("MODEL_SYNC_INPUT_INVALID"); }

  const path = "/2023-03-30/functions/" + name;
  let putAttempts = 0;
  const verified = () => ({
    ok: true, status: "CONFIG_VERIFIED", putAttempts, configurationVerified: true, catalogueVerified: true, modelInferenceVerified: false,
  });

  async function read() {
    let fn;
    try { fn = await api("GET", path); }
    catch { throw failure("MODEL_SYNC_UNCONFIRMED", putAttempts); }
    const settings = validateBoundary(fn, name, putAttempts);
    const desired = fn.environmentVariables.DASHSCOPE_API_KEY === modelKey;
    if (preservedModelConfigDigest(fn) !== preservedDigest || (!desired && functionDigest(fn) !== baselineDigest))
      throw failure("MODEL_SYNC_CONFIG_DRIFT", putAttempts);
    return { fn, desired, settings, stable: stable(fn) };
  }

  async function readStable(requireDesired) {
    let lastCode = "MODEL_SYNC_UNCONFIRMED";
    for (let index = 0; index < 4; index++) {
      try {
        const current = await read();
        if (current.stable && (!requireDesired || current.desired)) return current;
        // A stable read of the old snapshot cannot disprove an in-flight PUT.
        lastCode = current.stable && putAttempts === 0 ? "MODEL_SYNC_NOT_MATCHED" : "MODEL_SYNC_UNCONFIRMED";
      } catch (error) {
        if (error.code !== "MODEL_SYNC_UNCONFIRMED") throw error;
        lastCode = "MODEL_SYNC_UNCONFIRMED";
      }
      if (index < 3) {
        try { await readDelay(); } catch { throw failure("MODEL_SYNC_UNCONFIRMED", putAttempts); }
      }
    }
    throw failure(lastCode, putAttempts);
  }

  const before = mode === "verify" ? await readStable(false) : await read();
  if (!before.stable) throw failure("MODEL_SYNC_UNCONFIRMED");
  const { baseUrl, model } = before.settings;
  let available;
  try { available = await probe({ baseUrl, model, modelKey }); }
  catch { throw failure("MODEL_SYNC_CATALOGUE_UNCONFIRMED"); }
  if (available !== true) throw failure("MODEL_SYNC_CATALOGUE_UNCONFIRMED");

  if (mode === "apply") {
    const current = await read();
    if (!current.stable) throw failure("MODEL_SYNC_UNCONFIRMED");
    if (current.desired) return verified();
    if (before.desired) throw failure("MODEL_SYNC_CONFIG_DRIFT");
    const patch = { environmentVariables: { ...current.fn.environmentVariables, DASHSCOPE_API_KEY: modelKey } };
    putAttempts = 1;
    try { await api("PUT", path, patch); }
    catch { /* FC may already have applied this update. Inspect the original target. */ }
  }

  await readStable(true);
  return verified();
}
