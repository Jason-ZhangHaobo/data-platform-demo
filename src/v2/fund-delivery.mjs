import { createHash } from "node:crypto";
import { fundContext, fundFamily } from "./fund-lookthrough.mjs";
import { fundContextId, isFundContext } from "./fund-contexts.mjs";
import { nonLiveModelLabel } from "./live-lifecycle-provenance.mjs";

const canonical = value => JSON.stringify(value, (_key, item) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const digest = value => createHash("sha256").update(canonical(value)).digest("hex");
const same = (left, right) => canonical(left) === canonical(right);
const literal = value => "'" + value.replaceAll("'", "''") + "'";
const fail = () => Object.assign(new Error("基金交付的登记输入、组合断言或本机范围不一致"), {
  status: 422, code: "FUND_DELIVERY_CONTRACT_MISMATCH",
});

export function fundDeliveryBinding(contextId = fundContextId) {
  const { id, managerId, businessDate, tables, expected, outputContractId } = fundContext(contextId);
  return {
    contractId: outputContractId, managerId, businessDate, keyFields: fundFamily(contextId).keyFields,
    inputHash: digest({ contextId: id, managerId, businessDate, tables }),
    schemaHash: digest({ tables: tables.map(({ name, columns }) => ({ name, columns })) }),
    assertionHash: digest(expected),
  };
}

function inputMatches(evidence, binding, contextId) {
  return evidence?.protocol === "shuduo-spark-execution-input/v1" &&
    evidence.scope === "MANAGER_SCOPED_REGISTERED_TABLES" && evidence.contextId === contextId &&
    evidence.inputHash === binding.inputHash && evidence.schemaHash === binding.schemaHash &&
    evidence.tableCount === fundContext(contextId).tables.length;
}

export function fundValidationMatches(validation, binding, contextId = fundContextId) {
  binding ??= fundDeliveryBinding(contextId);
  const assertion = { protocol: "shuduo-securities-assertion-evidence/v1", verifierRevision: "fund-lookthrough-v1",
    contentHash: binding.assertionHash };
  const checks = validation?.regressions;
  return validation?.passed === true && validation.selectedPassed === true &&
    (validation.contractId === undefined || validation.contractId === binding.contractId) &&
    same(validation.assertionEvidence, assertion) && Array.isArray(checks) && checks.length === 1 &&
    checks[0]?.contextId === contextId && checks[0].passed === true &&
    same(checks[0].assertionEvidence, assertion) && inputMatches(checks[0].inputEvidence, binding, contextId);
}

export function verifiedFundRun(run, contextId = run?.contextId ?? run?.inputEvidence?.contextId ?? fundContextId) {
  const context = fundContext(contextId);
  if (!context || run?.contextId !== undefined && run.contextId !== contextId) return false;
  const binding = fundDeliveryBinding(contextId), { expected } = context;
  if (run?.status !== "SUCCEEDED" || run.engine !== "Apache Spark" || run.mainSqlExecuted !== true ||
      run.testDouble === true || (run.isolation !== undefined && run.isolation !== "LOCAL_PROCESS") ||
      !inputMatches(run.inputEvidence, binding, contextId) || !fundValidationMatches(run.validation, binding, contextId) ||
      !Array.isArray(run.rows) || run.rows.length !== expected.length) return false;
  return expected.every(row => run.rows.filter(actual => same(row, actual)).length === 1);
}

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
export const fundAgentAttributionKind = "FUND_AGENT_GENERATED";

function matchesFundPreparation(preparation, basisDigest, binding) {
  return typeof preparation?.requestId === "string" && uuid.test(preparation.requestId) &&
    typeof basisDigest === "string" && /^[a-f0-9]{64}$/.test(basisDigest) &&
    same(preparation, { requestId: preparation.requestId, basisDigest, inputDigest: binding.inputHash,
      schemaDigest: binding.schemaHash, assertionDigest: binding.assertionHash });
}

export function fundAgentDeliveryAttribution({ agent, run, revision }) {
  const preparation = agent?.fundPreparation, attempt = agent?.attempts?.at(-1);
  if (!isFundContext(agent?.contextId) || !["LIVE_MODEL", "SYNTHETIC_MODEL"].includes(agent.mode) ||
      agent.status !== "SUCCEEDED" || agent.language !== "SPARK_SQL" || attempt?.status !== "SUCCEEDED" ||
      agent.sourceKind !== undefined || agent.sourceAttribution !== undefined ||
      revision?.manualProvenance !== undefined || revision?.sourceAttribution !== undefined ||
      typeof attempt.model !== "string" || !attempt.model.trim() || agent.mode === "LIVE_MODEL" && nonLiveModelLabel(attempt.model) ||
      !uuid.test(agent.id) || typeof agent.submittedBy !== "string" || !agent.submittedBy ||
      agent.submittedBy !== revision?.author || revision.source !== agent.mode ||
      agent.projectId !== revision.projectId || agent.projectId !== run?.projectId ||
      agent.contextId !== revision.contextId || agent.contextId !== run.contextId ||
      agent.revisionId !== revision.id || agent.runId !== run.id || agent.sql !== revision.sql ||
      attempt.revisionId !== revision.id || attempt.runId !== run.id || run.agentTaskId !== agent.id ||
      run.revisionId !== revision.id || run.revisionHash !== revision.hash ||
      agent.requirements?.model !== attempt.model || revision.requirementBinding?.basisDigest !== preparation?.basisDigest ||
      !matchesFundPreparation(preparation, agent.requirements?.basis?.digest, fundDeliveryBinding(agent.contextId)) ||
      !same(preparation, revision.fundPreparation) || !same(preparation, run.fundPreparation) ||
      !verifiedFundRun(run, agent.contextId)) throw fail();
  return { kind: fundAgentAttributionKind, actorId: agent.submittedBy, originAgentTaskId: agent.id,
    modelMode: agent.mode, preparation, agentIndependentE2E: false };
}

export function createFundTestSql(expected, contextId = fundContextId) {
  if (!same(expected, fundContext(contextId).expected)) throw fail();
  const checks = expected.map(row => {
    const keys = fundFamily(contextId).keyFields.map(key => `${key} = ${literal(row[key])}`);
    const amount = `exposure_amount = CAST(${literal(row.exposure_amount)} AS DECIMAL(20,2))`;
    const ratio = `exposure_ratio = CAST(${literal(row.exposure_ratio)} AS DECIMAL(12,6))`;
    return `SUM(CASE WHEN ${[...keys, amount, ratio].join(" AND ")} THEN 1 ELSE 0 END) = 1`;
  });
  return `-- Independent fund look-through assertions, including uncovered holdings.\nSELECT CASE WHEN COUNT(*) = ${expected.length}\n  AND ${checks.join("\n  AND ")}\nTHEN true ELSE false END AS passed\nFROM __shuduo_result\n`;
}

export function validateFundDelivery({ source, proof, testSql, localTarget }) {
  if (!isFundContext(source.contextId)) {
    if (source.fundLookthrough !== undefined) throw fail();
    return;
  }
  const { contextId } = source, binding = fundDeliveryBinding(contextId);
  const agent = source.attribution?.kind === fundAgentAttributionKind;
  const sourceMatches = agent
    ? source.requirement?.taskId === source.attribution.originAgentTaskId &&
      matchesFundPreparation(source.attribution.preparation, source.requirement?.basisDigest, binding) &&
      typeof proof.requirements?.model === "string" && proof.requirements.model.trim() &&
      (source.attribution.modelMode === "SYNTHETIC_MODEL" || !nonLiveModelLabel(proof.requirements.model))
    : source.requirement === undefined && source.attribution?.kind === "ENGINEER_AUTHORED" &&
      source.attribution.developmentReference === undefined;
  if (!localTarget || proof.isolation !== "LOCAL_PROCESS" || !sourceMatches ||
      !same(source.fundLookthrough, binding) || !inputMatches(proof.inputEvidence, binding, contextId) ||
      !fundValidationMatches(proof.report, binding, contextId) || testSql !== createFundTestSql(fundContext(contextId).expected, contextId)) throw fail();
}
