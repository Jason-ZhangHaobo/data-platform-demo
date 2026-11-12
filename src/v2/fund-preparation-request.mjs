import { isFundContext } from "./fund-contexts.mjs";
import { fundRequirementScope } from "./fund-requirement-contract.mjs";

const invalid = () => Object.assign(new Error("请选择已登记的基金交易日并确认指标范围"), {
  status: 422, code: "FUND_PREPARATION_INVALID",
});

export function fundPreparationRequestId(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)) throw invalid();
  return value;
}

export function fundPreparationInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some(key => !["contextId", "businessDate", "message", "metrics"].includes(key)) ||
      !isFundContext(input.contextId) || typeof input.businessDate !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(input.businessDate) ||
      typeof input.message !== "string" || input.message.trim().length < 4 || input.message.length > 2000)
    throw invalid();
  const metrics = fundRequirementScope(input.contextId).metrics.map(metric => metric.field);
  if (!Array.isArray(input.metrics) || input.metrics.length !== metrics.length ||
      new Set(input.metrics).size !== metrics.length || metrics.some(metric => !input.metrics.includes(metric))) throw invalid();
  return { contextId: input.contextId, businessDate: input.businessDate, message: input.message.trim(), metrics };
}

const preflightPath = /^\/api\/v2\/agent\/tasks\/([a-f0-9-]{36})\/fund-execution-preflight$/;
const preflightFields = ["requestId", "revisionId", "runId", "basisDigest"];

export function fundExecutionPreflightPath(selection) {
  if (!selection || typeof selection !== "object" || Object.keys(selection).length !== preflightFields.length + 1)
    throw invalid();
  const { taskId, requestId, revisionId, runId, basisDigest } = selection;
  for (const id of [taskId, requestId, revisionId, runId]) fundPreparationRequestId(id);
  if (typeof basisDigest !== "string" || !/^[a-f0-9]{64}$/.test(basisDigest)) throw invalid();
  return "/agent/tasks/" + taskId + "/fund-execution-preflight?" +
    new URLSearchParams({ requestId, revisionId, runId, basisDigest });
}

export function parseFundExecutionPreflightPath(url) {
  if (typeof url !== "string" || url.length > 512 || url.includes("#")) return;
  const separator = url.indexOf("?");
  if (separator === -1) return;
  const match = url.slice(0, separator).match(preflightPath);
  const query = new URLSearchParams(url.slice(separator + 1));
  if (!match || query.size !== preflightFields.length ||
      !preflightFields.every(key => query.getAll(key).length === 1)) return;
  const selection = { taskId: match[1], ...Object.fromEntries(query) };
  try { fundExecutionPreflightPath(selection); } catch { return; }
  return selection;
}
