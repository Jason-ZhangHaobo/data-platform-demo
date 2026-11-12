import { isDeepStrictEqual as same } from "node:util";
import { sha256 } from "./delivery.mjs";
import { createFundTestSql, fundAgentDeliveryAttribution } from "./fund-delivery.mjs";
import { fundContext } from "./fund-lookthrough.mjs";
import { createFundPreparations, fundAgentRequestSignature } from "./fund-preparation.mjs";
import { frozenSqlRequirements, sqlRequirementBinding } from "./sql-requirements.mjs";

const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const mismatched = () => fail(409, "FUND_EXECUTION_SOURCE_MISMATCH", "原基金准备、SQL 版本、运行或独立断言不一致");

// Preflight binds an existing local result to a reproducible candidate for review.
// It never creates a new task, signs a queue job, or authorizes execution.
export function fundExecutionPreflight({ store, project, actorId, selection }) {
  const { taskId, requestId, revisionId, runId, basisDigest } = selection;
  const task = store.get("agent", taskId, project);
  if (!actorId || !task?.fundPreparation || task.submittedBy !== actorId)
    throw fail(404, "FUND_EXECUTION_SOURCE_NOT_FOUND", "未找到本账号的原基金任务");
  if (task.fundPreparation.requestId !== requestId || task.fundPreparation.basisDigest !== basisDigest ||
      task.revisionId !== revisionId || task.runId !== runId) throw mismatched();

  const preparation = createFundPreparations({ store, project }).read(requestId, actorId);
  const { inputDigest, schemaDigest, assertionDigest } = preparation.execution;
  const binding = { requestId, basisDigest: preparation.basis.digest, inputDigest, schemaDigest, assertionDigest };
  const ledger = store.db.prepare("SELECT result_id, signature FROM idempotency WHERE key=?").get(`${project}:agent:${requestId}`);
  if (task.contextId !== preparation.input.contextId || task.message !== preparation.input.message ||
      !same(binding, task.fundPreparation) || ledger?.result_id !== taskId ||
      ledger.signature !== fundAgentRequestSignature(task)) throw mismatched();

  const revision = store.get("revision", revisionId, project), run = store.get("run", runId, project);
  if (!revision || typeof revision.sql !== "string" || sha256(revision.sql) !== revision.hash ||
      !run || (run.isolation !== undefined && run.isolation !== "LOCAL_PROCESS") ||
      run.engineVersion !== "3.5.9" || run.remoteSubmission !== undefined)
    throw mismatched();
  let attribution, requirements;
  try {
    attribution = fundAgentDeliveryAttribution({ agent: task, revision, run });
    requirements = frozenSqlRequirements({ agent: task, revision, run });
  } catch { throw mismatched(); }
  if (!requirements || !same(requirements.basis, preparation.basis) ||
      !same(revision.requirementBinding, sqlRequirementBinding(requirements))) throw mismatched();

  const context = fundContext(task.contextId);
  const testSql = createFundTestSql(context.expected, context.id);
  const basis = {
    source: { taskId, requestId, revisionId, runId, basisDigest, contextId: context.id,
      businessDate: context.businessDate, modelMode: attribution.modelMode, scope: preparation.scope,
      ...(run.isolation ? { isolation: run.isolation } : {}),
      requirementDigest: revision.requirementBinding.reportDigest,
      inputDigest: binding.inputDigest, schemaDigest: binding.schemaDigest, assertionDigest: binding.assertionDigest },
    candidate: { engine: "Apache Spark", engineVersion: "3.5.9", sqlDigest: revision.hash,
      testSqlDigest: sha256(testSql), requestDigest: sha256(JSON.stringify({ sql: revision.sql, context, validationContexts: [], testSql })) },
  };
  return { protocol: "shuduo-fund-execution-preflight/v1", scope: "INVITED_READ_ONLY", status: "SOURCE_VERIFIED",
    ...basis, preflightDigest: sha256(JSON.stringify(basis)), approved: false, willExecute: false,
    publicDeployed: false, agentIndependentE2E: false };
}
