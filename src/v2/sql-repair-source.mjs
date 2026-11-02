import {createHash} from "node:crypto";
import {validationFamilyForContext} from "./context.mjs";

const invalid = () => Object.assign(new Error("修正来源必须是当前账号、同一口径和代码版本的已完成失败批次；超时或来源不明的记录不能直接用于模型修正"),
  {status:409,code:"AGENT_REPAIR_SOURCE_INVALID"});

// Read only through the caller's project-scoped store. This explicit handoff is
// distinct from searching other tasks for similar SQL or inheriting approval.
export function resolveExplicitSqlRepairSource({sourceRunId,actorId,contextId,currentSql,project,read}) {
  if (typeof sourceRunId !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(sourceRunId) ||
      typeof actorId !== "string" || !actorId || typeof currentSql !== "string" || typeof project !== "string" || !project) throw invalid();
  const run=read("run",sourceRunId),revision=run?.revisionId ? read("revision",run.revisionId) : undefined,
    family=validationFamilyForContext(contextId);
  if (!run || !revision || !family || run.projectId!==project || revision.projectId!==project ||
      !["FAILED","VALIDATION_FAILED"].includes(run.status) || run.code==="REMOTE_SPARK_TIMEOUT" ||
      run.engine!=="Apache Spark" || run.testDouble===true || run.contextId!==contextId || revision.contextId!==contextId ||
      run.validationContractId!==family.id || revision.author!==actorId || typeof revision.sql!=="string" ||
      currentSql.trim()!==revision.sql.trim() || run.revisionHash!==revision.hash ||
      createHash("sha256").update(revision.sql).digest("hex")!==revision.hash ||
      (run.status==="VALIDATION_FAILED" && (run.mainSqlExecuted!==true || run.validation?.passed!==false))) throw invalid();
  if (revision.source==="LIVE_MODEL") {
    const origin=run.agentTaskId ? read("agent",run.agentTaskId) : undefined;
    if (!origin || origin.projectId!==project || origin.submittedBy!==actorId || origin.contextId!==contextId || origin.language!=="SPARK_SQL" ||
        !origin.attempts?.some(attempt=>attempt.runId===run.id && attempt.revisionId===revision.id)) throw invalid();
  } else if (revision.source==="MANUAL") {
    const provenance=revision.manualProvenance;
    if (run.agentTaskId!==undefined || provenance?.kind!=="ENGINEER_EDIT" || provenance.actorId!==actorId || provenance.agentIndependentE2E!==false) throw invalid();
  } else throw invalid();
  return {run,revision};
}
