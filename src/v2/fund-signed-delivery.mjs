import { isDeepStrictEqual as same } from "node:util";
import { computeManifestDigest, sha256, validateDeliveryPackage } from "./delivery.mjs";
import { fundAgentAttributionKind } from "./fund-delivery.mjs";
import { verifyFundSignedExecution } from "./fund-signed-execution.mjs";

const mismatch = () => Object.assign(new Error("基金交付文件与原预检及签名结果不一致"), {
  status: 409, code: "FUND_SIGNED_DELIVERY_MISMATCH",
});
const missing = () => Object.assign(new Error("基金演练须先核验原签名任务和结果"), {
  status: 409, code: "FUND_SIGNED_DELIVERY_EVIDENCE_REQUIRED",
});

function checkedBinding(bundle, plan, evidence) {
  if (!evidence) throw missing();
  const verified = verifyFundSignedExecution(evidence);
  if (!verified) throw missing();
  const { source: original } = verified;
  const { source, fixtures } = plan;
  const { attribution, requirement, fundLookthrough } = source;
  const input = {
    sql: bundle.files["main.sql"], context: fixtures.context,
    // The fund Worker already checks the selected context. Older delivery
    // files repeat it in the regression list; the reviewed input omits it.
    validationContexts: fixtures.validationContexts.filter(context => context.id !== fixtures.context.id),
    testSql: bundle.files["tests.sql"],
  };
  if (attribution?.kind !== fundAgentAttributionKind || source.projectId !== evidence.source.project ||
      attribution.actorId !== evidence.source.actorId || attribution.originAgentTaskId !== original.taskId ||
      attribution.modelMode !== original.modelMode || attribution.preparation?.requestId !== original.requestId ||
      attribution.preparation.basisDigest !== original.basisDigest ||
      requirement?.reportDigest !== original.requirementDigest || source.runId !== original.runId ||
      source.revisionId !== original.revisionId || source.contextId !== original.contextId ||
      source.sqlHash !== verified.sqlDigest || fundLookthrough?.businessDate !== original.businessDate ||
      fundLookthrough.inputHash !== original.inputDigest || fundLookthrough.schemaHash !== original.schemaDigest ||
      fundLookthrough.assertionHash !== original.assertionDigest || sha256(input.testSql) !== verified.testSqlDigest ||
      sha256(JSON.stringify(input)) !== verified.requestDigest) throw mismatch();
  const { preflightDigest, jobId, queueJobDigest, resultDigest, requestDigest, testSqlDigest } = verified;
  return { input, binding: { preflightDigest, jobId, queueJobDigest, resultDigest, requestDigest, testSqlDigest } };
}

export function bindFundSignedDelivery(bundle, expectedDigest, evidence) {
  const plan = validateDeliveryPackage(bundle, expectedDigest);
  const { binding } = checkedBinding(bundle, plan, evidence);
  if (plan.source.fundSignedExecution !== undefined) {
    if (!same(plan.source.fundSignedExecution, binding)) throw mismatch();
    return bundle;
  }
  const manifest = { ...bundle.manifest, source: { ...plan.source, fundSignedExecution: binding } };
  const result = { ...bundle, manifest, digest: computeManifestDigest(manifest) };
  validateDeliveryPackage(result, result.digest);
  return result;
}

export function verifyFundSignedDelivery(bundle, plan, evidence) {
  const { binding, input } = checkedBinding(bundle, plan, evidence);
  if (!same(plan.source.fundSignedExecution, binding)) throw mismatch();
  return input;
}
