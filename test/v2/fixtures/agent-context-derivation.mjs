import { createHash } from "node:crypto";
import { getContext, referenceSqlForContext, validationFamilyForContext } from "../../../src/v2/context.mjs";

// Synthetic persisted source only. It neither runs nor attests a real model/Spark.
export function seedContextDerivation(store, project, { actorId = "synthetic-owner", contextId = "holdings-t1", legacyLocal = false } = {}) {
  const sql = referenceSqlForContext(contextId), family = validationFamilyForContext(contextId);
  let task = store.create("agent", project, { submittedBy: actorId, status: "SUCCEEDED", mode: "LIVE_MODEL", language: "SPARK_SQL",
    sql, contextId, validationContractId: family.id, attempts: [], usedTokens: 12345,
    approvalId: "synthetic-old-approval", releaseId: "synthetic-old-release", fullLifecycleE2E: false });
  const revision = store.create("revision", project, { author: actorId, sql, contextId, source: "LIVE_MODEL",
    hash: createHash("sha256").update(sql).digest("hex") });
  const run = store.create("run", project, { agentTaskId: task.id, revisionId: revision.id, revisionHash: revision.hash, contextId,
    status: "SUCCEEDED", engine: "Apache Spark", engineVersion: "3.5.9", mainSqlExecuted: true, validationContractId: family.id,
    rows: getContext(contextId).expected, validation: { passed: true, contractId: family.id,
      regressions: family.contextIds.map(contextId => ({ contextId, passed: true })) } });
  task = store.update("agent", task.id, project, { revisionId: revision.id, ...(legacyLocal ? {} : { runId: run.id }),
    attempts: [{ status: "SUCCEEDED", revisionId: revision.id, runId: run.id, model: "protocol-model-provider", usage: { total_tokens: 12345 } }] });
  const derivation = { kind: "REGISTERED_CONTEXT_CHANGE", taskId: task.id, revisionId: revision.id, runId: run.id, revisionHash: revision.hash };
  return { task, revision, run, derivation, actorId, family, sql };
}
