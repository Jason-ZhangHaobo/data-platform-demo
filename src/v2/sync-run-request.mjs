const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const states = new Set(["SUCCEEDED", "FAILED", "LANDING_COMMITTED", "UNCONFIRMED"]);
const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const validUuid = value => typeof value === "string" && value.length === 36 && uuid.test(value);
const validDigest = value => typeof value === "string" && value.length === 64 && /^[a-f0-9]{64}$/.test(value);
const terminal = value => value === "SUCCEEDED" || value === "FAILED";

export function validSyncRunRequestKey(value) {
  // Match the stored, trimmed idempotency key. HTTP field values can contain
  // internal HTAB, printable ASCII or obs-text; query encoding keeps them opaque.
  return typeof value === "string" && value.length >= 1 && value.length <= 100 &&
    value.trim() === value && !/[^\t\x20-\x7e\x80-\xff]/.test(value);
}

export function syncRunRequestPath({ taskId, requestKey }) {
  if (!validUuid(taskId) || !validSyncRunRequestKey(requestKey))
    throw Error("请提供原同步任务 UUID 和有效的执行请求编号");
  const query = new URLSearchParams({ request_key: requestKey });
  return "/sync/tasks/" + taskId + "/requests?" + query;
}

export function checkedSyncRunRequest(value, { taskId, requestKey }) {
  if (!isRecord(value) || value.schema !== "shuduo-sync-run-request/v1" ||
      value.taskId !== taskId || value.requestKey !== requestKey || !states.has(value.state) ||
      !isRecord(value.run) || !validUuid(value.run.id) || value.run.taskId !== taskId ||
      typeof value.run.status !== "string" || !value.run.status ||
      ((terminal(value.state) || terminal(value.run.status)) && value.state !== value.run.status) ||
      (value.run.requestKey !== undefined && value.run.requestKey !== requestKey) ||
      (value.state === "LANDING_COMMITTED" && value.landingEvidence === undefined) ||
      (value.landingEvidence !== undefined && (
        !["LANDING_COMMITTED", "SUCCEEDED"].includes(value.state) || !isRecord(value.landingEvidence) ||
        value.landingEvidence.runId !== value.run.id || !validDigest(value.landingEvidence.receiptHash)
      )))
    throw Error("同步执行回执与原任务或请求编号不匹配，请保留原编号");
  return value;
}

export async function readSyncRunRequest(client, selection) {
  const path = syncRunRequestPath(selection);
  return checkedSyncRunRequest(await client.request(path, { method: "GET" }), selection);
}

export async function settleSyncRunRequest(client, selection, evidence) {
  const path = syncRunRequestPath(selection);
  if (!isRecord(evidence) || Object.keys(evidence).length !== 2 ||
      !["runId", "receiptHash"].every(key => Object.hasOwn(evidence, key)) ||
      !validUuid(evidence.runId) || !validDigest(evidence.receiptHash))
    throw Error("确认原执行回执须提供确切运行 UUID 和落地回执摘要");
  const { runId, receiptHash } = evidence;
  const result = checkedSyncRunRequest(await client.request(path, {
    method: "POST", body: { runId, receiptHash, confirm: true },
  }), selection);
  if (result.state !== "SUCCEEDED" || result.run.id !== runId || result.landingEvidence?.receiptHash !== receiptHash)
    throw Error("结算结果与已确认的原运行及回执摘要不匹配，请保留原编号");
  return result;
}
