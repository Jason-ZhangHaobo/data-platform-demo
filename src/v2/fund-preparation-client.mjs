import { fundPreparationInput, fundPreparationRequestId } from "./fund-preparation-request.mjs";
import { fundRehearsalAt } from "./fund-contexts.mjs";
import { validSqlRequirementBasis } from "./sql-requirement-contract.mjs";

const hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest(
  "SHA-256", new TextEncoder().encode(value))), byte => byte.toString(16).padStart(2, "0")).join("");
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export async function checkedFundPreparation(value, { requestId, input: expected } = {}) {
  const invalid = () => { throw Error("基金准备回执与原请求或登记口径不一致"); };
  if (!value || value.protocol !== "shuduo-fund-preparation/v1" || value.status !== "PREPARED" ||
      value.scope !== "LOCAL_TEST_ONLY" || value.modelCalls !== 0 || value.sparkRuns !== 0 ||
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
