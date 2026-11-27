import { agentContextDerivationRequest, checkedDeliveryDerivation, validStoredAgentDerivation, verifiedAgentContextExecution } from "./agent-context-derivation.mjs";
import { allContextIds, getContext } from "./context.mjs";
import { verifiedStoredCloudDevelopment } from "./agent-development-workflow.mjs";
import { liveEvidenceProvenance } from "./live-lifecycle-provenance.mjs";
import { amountFields, formatCents, amountInCents as cents } from "./derived-amounts.mjs";

const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
const rowFields = ["client_id", ...amountFields, "security_count"];
const forbidden = () => Object.assign(new Error("仅可对照本人在当前项目的已派生任务"), {
  status: 403, code: "AGENT_DERIVATION_COMPARISON_FORBIDDEN",
});


function count(value) {
  if (typeof value !== "number" && typeof value !== "string") return;
  const match = /^(\d{1,16})(?:\.0{1,38})?$/.exec(String(value));
  if (match && BigInt(match[1]) <= maxSafe) return BigInt(match[1]);
}

function observedRows(rows) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 1000) return;
  const mapped = new Map();
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row) || Object.keys(row).length !== rowFields.length ||
        !rowFields.every(key => Object.hasOwn(row, key)) || typeof row.client_id !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(row.client_id) || mapped.has(row.client_id)) return;
    const amounts = Object.fromEntries(amountFields.map(field => [field, cents(row[field])]));
    const securities = count(row.security_count);
    if (Object.values(amounts).some(v => v === undefined) || securities === undefined ||
        amounts.holding_market_value + amounts.available_cash !== amounts.total_assets) return;
    mapped.set(row.client_id, { ...amounts, security_count: securities });
  }
  return mapped;
}

function valuesAt(before, after) {
  const delta = {}, output = {};
  for (const field of [...amountFields, "security_count"]) delta[field] = after[field] - before[field];
  for (const [side, values] of Object.entries({ before, after, delta })) {
    output[side] = Object.fromEntries(amountFields.map(field => [field, formatCents(values[field])]));
    output[side].security_count = Number(values.security_count);
  }
  return output;
}

function sum(rows) {
  const result = { holding_market_value: 0n, available_cash: 0n, total_assets: 0n, security_count: 0n };
  for (const values of rows.values()) for (const field of Object.keys(result)) result[field] += values[field];
  return result;
}

function domainFailure(error) {
  return ["AGENT_CONTEXT_SOURCE_INVALID", "AGENT_CONTEXT_DERIVATION_INVALID"].includes(error?.code);
}

function verifiedSide({ task, selector, currentSql, read, actorId, project, context }) {
  const run = read("run", selector.runId);
  if (!run || run.agentTaskId !== task.id || run.projectId !== project || run.contextId !== context.id ||
      run.revisionId !== selector.revisionId || run.revisionHash !== selector.revisionHash) return {};
  const rows = observedRows(run.rows);
  if (!rows) return { reason: "INVALID_ROWS" };
  let receipt;
  try {
    receipt = verifiedAgentContextExecution({ derivation: selector, currentSql, read, actorId, project });
  } catch (error) {
    if (!domainFailure(error)) throw error;
    return {};
  }
  const workerProject = run.remoteSubmission?.prepared?.job?.projectId;
  if (receipt.task.sourceRunId !== undefined || receipt.task.syncInput || (workerProject !== undefined && workerProject !== project) ||
      (run.submittedBy !== undefined && run.submittedBy !== actorId) || run.validation?.selectedPassed === false ||
      (receipt.task.executionMode === "DURABLE_SQL_AGENT_V1" && !verifiedStoredCloudDevelopment(receipt.task, receipt.revision, run)) ||
      Object.values(liveEvidenceProvenance(receipt.task, receipt.revision, run)).some(Boolean)) return {};
  for (const source of [receipt.task, receipt.revision, run]) {
    if ((source.advisorId !== undefined && source.advisorId !== context.advisorId) ||
        (source.businessDate !== undefined && source.businessDate !== context.businessDate)) return { reason: "SCOPE_CHANGED" };
  }
  return { rows, source: { taskId: task.id, revisionId: selector.revisionId, runId: selector.runId, revisionHash: selector.revisionHash,
    contextId: context.id, contextName: context.name, validationContractId: receipt.family.id } };
}

export function readDerivedResultComparison({task, project, actorId, read: readStored}) {
  if (!task || !actorId || !project || task.submittedBy !== actorId || task.projectId !== project) throw forbidden();
  // Resolve each pointer once. The rows compared are the very same observations
  // passed to the independent verifier, even when a second request edits a task.
  const documents = new Map([["agent/" + task.id, task]]);
  const read = (kind, id) => {
    const key = kind + "/" + id;
    if (!documents.has(key)) documents.set(key, readStored(kind, id));
    return documents.get(key);
  };
  const base = { protocol: "shuduo-derived-result-comparison/v1", taskId: task.id };
  const unavailable = reason => ({ ...base, state: "UNAVAILABLE", reason });
  if (task.derivedFrom === undefined) return unavailable("NOT_DERIVED");
  let binding;
  try { binding = checkedDeliveryDerivation(task.derivedFrom, task.contextId); }
  catch (error) {
    if (!domainFailure(error)) throw error;
    return unavailable("SOURCE_UNCONFIRMED");
  }
  const original = read("agent", binding.taskId);
  if (!original || original.id !== binding.taskId || original.id === task.id) return unavailable("SOURCE_UNCONFIRMED");
  if (original.submittedBy !== actorId || original.projectId !== project) throw forbidden();
  if (original.contextId !== binding.contextId || !validStoredAgentDerivation(original, read)) return unavailable("SOURCE_UNCONFIRMED");
  if (![binding.contextId, task.contextId].every(id => allContextIds.includes(id)) || original.syncInput || task.syncInput)
    return unavailable("UNSUPPORTED_GRAIN");
  const parentContext = getContext(binding.contextId), childContext = getContext(task.contextId);
  if (parentContext.businessDate !== childContext.businessDate || parentContext.advisorId !== childContext.advisorId)
    return unavailable("SCOPE_CHANGED");

  const parent = verifiedSide({ task: original, selector: agentContextDerivationRequest(binding), currentSql: task.initialSql,
    context: parentContext, actorId, project, read });
  if (!parent.source) return unavailable(parent.reason ?? "SOURCE_UNCONFIRMED");
  if (["QUEUED", "RUNNING"].includes(task.status)) return { ...base, state: "PENDING", reason: "CHILD_RUNNING" };
  if (task.status !== "SUCCEEDED" || !task.revisionId) return unavailable("CHILD_UNCONFIRMED");
  const revision = read("revision", task.revisionId);
  const runId = task.runId ?? (Array.isArray(task.attempts) ? task.attempts.at(-1)?.runId : undefined);
  if (!revision || !runId) return unavailable("CHILD_UNCONFIRMED");
  const selector = agentContextDerivationRequest({ taskId: task.id, revisionId: task.revisionId, runId, revisionHash: revision.hash });
  const child = verifiedSide({ task, selector, currentSql: task.sql, context: childContext, actorId, project, read });
  if (!child.source) return unavailable(child.reason ?? "CHILD_UNCONFIRMED");
  if (parent.rows.size !== child.rows.size || [...parent.rows.keys()].some(id => !child.rows.has(id)))
    return unavailable("CUSTOMER_SCOPE_CHANGED");
  const before = sum(parent.rows), after = sum(child.rows);
  if (before.security_count > maxSafe || after.security_count > maxSafe) return unavailable("INVALID_ROWS");
  return { ...base, state: "MATCHED", parent: parent.source, child: child.source,
    rows: [...parent.rows.keys()].sort().map(clientId => ({ clientId, ...valuesAt(parent.rows.get(clientId), child.rows.get(clientId)) })),
    totals: valuesAt(before, after) };
}
