import { createHash } from "node:crypto";
import { fundContext, fundContextId, fundFamily } from "./fund-lookthrough.mjs";

const canonical = value => JSON.stringify(value, (_key, item) =>
  item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const digest = value => createHash("sha256").update(canonical(value)).digest("hex");
const same = (left, right) => canonical(left) === canonical(right);
const literal = value => "'" + value.replaceAll("'", "''") + "'";
const fail = () => Object.assign(new Error("基金交付的登记输入、组合断言或本机范围不一致"), {
  status: 422, code: "FUND_DELIVERY_CONTRACT_MISMATCH",
});

export function fundDeliveryBinding() {
  const { id, managerId, businessDate, tables, expected, outputContractId } = fundContext();
  return {
    contractId: outputContractId, managerId, businessDate, keyFields: fundFamily().keyFields,
    inputHash: digest({ contextId: id, managerId, businessDate, tables }),
    schemaHash: digest({ tables: tables.map(({ name, columns }) => ({ name, columns })) }),
    assertionHash: digest(expected),
  };
}

function inputMatches(evidence, binding) {
  return evidence?.protocol === "shuduo-spark-execution-input/v1" &&
    evidence.scope === "MANAGER_SCOPED_REGISTERED_TABLES" && evidence.contextId === fundContextId &&
    evidence.inputHash === binding.inputHash && evidence.schemaHash === binding.schemaHash &&
    evidence.tableCount === fundContext().tables.length;
}

export function fundValidationMatches(validation, binding = fundDeliveryBinding()) {
  const assertion = { protocol: "shuduo-securities-assertion-evidence/v1", verifierRevision: "fund-lookthrough-v1",
    contentHash: binding.assertionHash };
  const checks = validation?.regressions;
  return validation?.passed === true && validation.selectedPassed === true &&
    (validation.contractId === undefined || validation.contractId === binding.contractId) &&
    same(validation.assertionEvidence, assertion) && Array.isArray(checks) && checks.length === 1 &&
    checks[0]?.contextId === fundContextId && checks[0].passed === true &&
    same(checks[0].assertionEvidence, assertion) && inputMatches(checks[0].inputEvidence, binding);
}

export function verifiedFundRun(run) {
  const binding = fundDeliveryBinding(), { expected } = fundContext();
  if (run?.status !== "SUCCEEDED" || run.engine !== "Apache Spark" || run.mainSqlExecuted !== true ||
      run.testDouble === true || (run.isolation !== undefined && run.isolation !== "LOCAL_PROCESS") ||
      !inputMatches(run.inputEvidence, binding) || !fundValidationMatches(run.validation, binding) ||
      !Array.isArray(run.rows) || run.rows.length !== expected.length) return false;
  return expected.every(row => run.rows.filter(actual => same(row, actual)).length === 1);
}

export function createFundTestSql(expected) {
  if (!same(expected, fundContext().expected)) throw fail();
  const checks = expected.map(row => {
    const keys = fundFamily().keyFields.map(key => `${key} = ${literal(row[key])}`);
    const amount = `exposure_amount = CAST(${literal(row.exposure_amount)} AS DECIMAL(20,2))`;
    const ratio = `exposure_ratio = CAST(${literal(row.exposure_ratio)} AS DECIMAL(12,6))`;
    return `SUM(CASE WHEN ${[...keys, amount, ratio].join(" AND ")} THEN 1 ELSE 0 END) = 1`;
  });
  return `-- Independent fund look-through assertions, including uncovered holdings.\nSELECT CASE WHEN COUNT(*) = ${expected.length}\n  AND ${checks.join("\n  AND ")}\nTHEN true ELSE false END AS passed\nFROM __shuduo_result\n`;
}

export function validateFundDelivery({ source, proof, testSql, localTarget }) {
  if (source.contextId !== fundContextId) {
    if (source.fundLookthrough !== undefined) throw fail();
    return;
  }
  const binding = fundDeliveryBinding();
  if (!localTarget || proof.isolation !== "LOCAL_PROCESS" || source.requirement !== undefined ||
      source.attribution?.kind !== "ENGINEER_AUTHORED" || source.attribution.developmentReference !== undefined ||
      !same(source.fundLookthrough, binding) || !inputMatches(proof.inputEvidence, binding) ||
      !fundValidationMatches(proof.report, binding) || testSql !== createFundTestSql(fundContext().expected)) throw fail();
}
