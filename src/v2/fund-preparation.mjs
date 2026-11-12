import { isDeepStrictEqual as same } from "node:util";
import { getContext } from "./context.mjs";
import { sha256 } from "./delivery.mjs";
import { fundDeliveryBinding } from "./fund-delivery.mjs";
import { fundRehearsalAt } from "./fund-contexts.mjs";
import { fundPreparationInput, fundPreparationRequestId } from "./fund-preparation-request.mjs";
import { sqlRequirementBasis } from "./sql-requirements.mjs";

const fail = (status, code, message) => Object.assign(new Error(message), { status, code });

export function createFundPreparations({ store, project }) {
  const kind = "agent_fund_preparation";
  const keyFor = (actor, requestId) => `${project}:agent-fund-preparation:v1:${actor}:${requestId}`;
  const build = (input, requestId) => {
    const context = getContext(input.contextId);
    if (!context || context.businessDate !== input.businessDate)
      throw fail(422, "FUND_PREPARATION_DATE_MISMATCH", "业务日与所选基金口径不一致");
    const binding = fundDeliveryBinding(context.id), basis = sqlRequirementBasis(input.message, context);
    return {
      protocol: "shuduo-fund-preparation/v1", status: "PREPARED", scope: "LOCAL_TEST_ONLY", requestId, input, basis,
      execution: { state: "AWAITING_EXECUTION_AUTHORIZATION", engine: "Apache Spark", dialect: "SPARK_SQL",
        rehearsalAt: fundRehearsalAt(context.id), inputDigest: binding.inputHash, schemaDigest: binding.schemaHash,
        assertionDigest: binding.assertionHash },
      modelCalls: 0, sparkRuns: 0, publicDeployed: false, agentIndependentE2E: false,
    };
  };
  const read = (requestId, actor) => {
    const key = keyFor(actor, fundPreparationRequestId(requestId));
    const ledger = store.db.prepare("SELECT result_id, signature FROM idempotency WHERE key=?").get(key);
    const item = ledger && store.get(kind, ledger.result_id, project);
    if (!item || item.actorId !== actor)
      throw fail(404, "FUND_PREPARATION_NOT_FOUND", "未找到本账号的基金准备记录");
    const input = fundPreparationInput(item.receipt?.input);
    if (ledger.signature !== sha256(JSON.stringify(input)) || !same(build(input, requestId), item.receipt))
      throw fail(409, "FUND_PREPARATION_CHANGED", "原口径或执行依据已变化，请核对原请求");
    return item.receipt;
  };
  return {
    submit(body, actor, requestId) {
      requestId = fundPreparationRequestId(requestId);
      const input = fundPreparationInput(body), receipt = build(input, requestId);
      const { replayed } = store.deduplicate(keyFor(actor, requestId), sha256(JSON.stringify(input)),
        () => store.create(kind, project, { actorId: actor, receipt }));
      return { receipt: read(requestId, actor), replayed };
    },
    read,
  };
}
