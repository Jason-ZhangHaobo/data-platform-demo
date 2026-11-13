import { fundExecutionBody, fundExecutionPreflightPath, fundPreparationInput, fundPreparationRequestId } from "./fund-preparation-request.mjs";
export { fundExecutionBody };
import { fundRehearsalAt, isFundContext } from "./fund-contexts.mjs";
import { validSqlRequirementBasis } from "./sql-requirement-contract.mjs";

const hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest(
  "SHA-256", new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, "0")).join("");
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export async function checkedFundPreparation(value, { requestId, input: expected } = {}) {
  const invalid = () => { throw Error("基金准备回执与原请求或登记口径不一致"); };
  if (!value || value.protocol !== "shuduo-fund-preparation/v1" || value.status !== "PREPARED" ||
      !["LOCAL_TEST_ONLY","PRIVATE_CLOUD_TEST"].includes(value.scope) || value.modelCalls !== 0 || value.sparkRuns !== 0 ||
      value.publicDeployed !== false || value.agentIndependentE2E !== false ||
      fundPreparationRequestId(value.requestId) !== (requestId ?? value.requestId)) invalid();
  const input = fundPreparationInput(value.input), { basis, execution } = value;
  if (expected && JSON.stringify(input) !== JSON.stringify(fundPreparationInput(expected)) ||
      !validSqlRequirementBasis(basis) || basis.contextId !== input.contextId || basis.parameters.trade_date !== input.businessDate ||
      basis.metrics.some((metric, index) => metric.field !== input.metrics[index]) ||
      execution?.state !== "AWAITING_EXECUTION_AUTHORIZATION" || execution.engine !== "Apache Spark" ||
      execution.dialect !== "SPARK_SQL" || execution.rehearsalAt !== fundRehearsalAt(input.contextId) ||
      ![execution.inputDigest, execution.schemaDigest, execution.assertionDigest].every(digest)) invalid();
  const { digest: basisDigest, ...contents } = basis;
  if (await hash(JSON.stringify(contents)) !== basisDigest || await hash(input.message) !== basis.requestDigest) invalid();
  return value;
}

export async function submitFundPreparation(client, input, requestId) {
  const body = fundPreparationInput(input);
  const id = fundPreparationRequestId(requestId);
  return checkedFundPreparation(await client.request("/agent/fund-preparations", { method: "POST", body, idempotencyKey: id }),
    { requestId: id, input: body });
}

export async function readFundPreparation(client, requestId) {
  const id = fundPreparationRequestId(requestId);
  return checkedFundPreparation(await client.request("/agent/fund-preparations/requests/" + id), { requestId: id });
}

export function fundExecutionReceiptMatches(task, body, requestId) {
  if (!body?.fundPreparation) return !task?.fundPreparation || body === undefined && task.fundPreparation.requestId === requestId;
  const expected = body.fundPreparation, actual = task?.fundPreparation;
  return Boolean(actual && task.contextId === body.contextId && task.message === body.message && task.language === "SPARK_SQL" &&
    actual.requestId === requestId && actual.requestId === expected.requestId && actual.basisDigest === expected.basisDigest &&
    [actual.inputDigest, actual.schemaDigest, actual.assertionDigest].every(digest));
}

export async function executeFundPreparation(client, { requestId, basisDigest, confirm }) {
  if (confirm !== true || !digest(basisDigest)) throw Error("须确认已审阅的原基金口径摘要");
  const receipt = await readFundPreparation(client, requestId);
  if (receipt.basis.digest !== basisDigest) throw Error("准备摘要已变化；本次未提交开发");
  const body = fundExecutionBody(receipt);
  const task = await client.request("/agent/tasks", { method: "POST", body, idempotencyKey: requestId });
  if (!fundExecutionReceiptMatches(task, body, requestId) ||
      ["inputDigest", "schemaDigest", "assertionDigest"].some(key => task.fundPreparation[key] !== receipt.execution[key]))
    throw Error("基金任务回执与原准备不一致，请按原编号查询");
  return task;
}

export async function readFundExecutionPreflight(client, selection) {
  const value = await client.request(fundExecutionPreflightPath(selection));
  const { source, candidate } = value ?? {};
  if (value?.protocol !== "shuduo-fund-execution-preflight/v1" || value.scope !== "INVITED_READ_ONLY" ||
      value.status !== "SOURCE_VERIFIED" || !source || !candidate ||
      !Object.entries(selection).every(([key, expected]) => source[key] === expected) ||
      !isFundContext(source.contextId) || typeof source.businessDate !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(source.businessDate) || source.scope !== "LOCAL_TEST_ONLY" ||
      (source.isolation !== undefined && source.isolation !== "LOCAL_PROCESS") ||
      !["LIVE_MODEL", "SYNTHETIC_MODEL"].includes(source.modelMode) ||
      candidate.engine !== "Apache Spark" || candidate.engineVersion !== "3.5.9" ||
      ![source.requirementDigest, source.inputDigest, source.schemaDigest, source.assertionDigest,
        candidate.sqlDigest, candidate.testSqlDigest, candidate.requestDigest].every(digest) ||
      value.preflightDigest !== await hash(JSON.stringify({ source, candidate })) ||
      value.approved !== false || value.willExecute !== false || value.publicDeployed !== false || value.agentIndependentE2E !== false)
    throw Error("基金执行预检与原任务或确切来源不一致");
  return value;
}
