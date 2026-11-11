// Negative evidence only: absence of these declarations does not authenticate a
// provider or prove cloud execution. Traverse receipt metadata, never business
// rows, fictional input data, SQL, prompts, file contents or expected answers.
const receiptKeys = new Set([
  'attempts', 'code', 'delivery', 'publication', 'lifecycleOutcome', 'stages',
  'requirementUnderstanding', 'codeAndDebug', 'scheduleFiles', 'deploymentFiles',
  'engineerReview', 'localRelease', 'postReleaseMonitoring', 'consumption',
  'consumptionSource', 'consumptionStage', 'evidence', 'services', 'sourceVersions',
  'call', 'source', 'manifest', 'report', 'package', 'verification', 'release',
  'approval', 'review', 'runs', 'events', 'batches', 'successfulEvents',
  'validation', 'regressions', 'testSqlValidation', 'checks', 'requirements', 'requirementEvidence',
]);
const manualKeys = ['manualProvenance', 'manualContinuation', 'assistedContinuation',
  'repairComparison', 'developmentReference', 'manualDeliveryTaskId', 'sourceAttribution', 'attribution'];
const manualKinds = new Set(['MANUAL_RUN', 'ENGINEER_EDIT', 'ENGINEER_AUTHORED',
  'ENGINEER_ASSISTED', 'MANUAL_SUCCESS_REFERENCE', 'ASSISTED_SUCCESS_REFERENCE',
  'RUN_COMPARISON_REFERENCE', 'FAILED_RUN_REFERENCE']);
const unsettledModelStages = new Set(["MODEL_IN_FLIGHT", "MODEL_OUTCOME_UNKNOWN", "MODEL_NOT_SENT"]);
const unknownReservation = value => value.model === "unconfirmed" && value.usageEstimated === true &&
  unsettledModelStages.has(value.status);
export const nonLiveModelLabel = value => typeof value === 'string' &&
  /test.?double|unconfirmed|fixture|stub|mock|synthetic/i.test(value);

export function liveEvidenceProvenance(...roots) {
  let synthetic = false, nonNative = false, unconfirmed = false;
  const pending = [...roots], seen = new Set();
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    if (seen.size >= 4096) { unconfirmed = true; break; }
    seen.add(value);
    if (Array.isArray(value)) { pending.push(...value.slice(0, 4097)); if (value.length > 4096) unconfirmed = true; continue; }
    if (value.testDouble === true || value.synthetic === true || value.executionEvidenceMode === 'TEST_HARNESS' ||
        (nonLiveModelLabel(value.model) && !unknownReservation(value))) synthetic = true;
    if (value.sourceKind !== undefined && value.sourceKind !== 'AGENT' ||
        value.humanClarified===true || value.clarification!==undefined ||
        value.source === 'MANUAL' || manualKinds.has(value.kind) ||
        manualKeys.some(key => value[key] !== undefined) ||
        value.executionMode === 'DURABLE_PRIVATE_SERVICE_AGENT_V1' || value.completionScope === 'DATA_SERVICE_DESIGN') nonNative = true;
    for (const key of receiptKeys) if (value[key] && typeof value[key] === 'object') pending.push(value[key]);
  }
  return {synthetic, nonNative, unconfirmed};
}
