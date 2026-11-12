import { checkpointCaseScope, stop, uuid } from "./live-lifecycle-checkpoint.mjs";
import { currentLiveLifecycleContract, liveLifecycleCases } from "./live-lifecycle-evaluation.mjs";
import { validationFamilyForContext } from "./context.mjs";

const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const cloudV3BaseCases = () => liveLifecycleCases(currentLiveLifecycleContract.id).filter(item => item.kind === "FRESH");
export const cloudV3PredecessorApprovals = previous =>
  previous?.approvalDigests ?? (previous?.approvalDigest ? [previous.approvalDigest] : []);
export const cloudV3UsageKeys = ["modelCalls","remoteSparkRuns","remoteSparkSeconds"];
export const validCloudV3UsageFloor = value => Boolean(value && typeof value.month==="string" &&
  /^\d{4}-(?:0[1-9]|1[0-2])$/.test(value.month) && Object.keys(value).length===4 &&
  [value.modelCalls,value.remoteSparkRuns].every(count=>Number.isSafeInteger(count)&&count>=0) &&
  Number.isFinite(value.remoteSparkSeconds) && value.remoteSparkSeconds>=0);

export function validCloudV3DerivationSource(definition,source) {
  const parent=cloudV3BaseCases().find(item=>item.id===definition.sourceCaseId);
  return Boolean(definition.kind==="DERIVED" && parent && source && Object.keys(source).length===9 &&
    source.protocol==="shuduo-cloud-v3-derivation-source/v1" && source.sourceCaseId===parent.id &&
    source.contextId===parent.contextId && source.validationContractId===validationFamilyForContext(parent.contextId)?.id &&
    source.validationContractId!==validationFamilyForContext(definition.contextId)?.id &&
    [source.taskId,source.revisionId,source.runId].every(id=>typeof id==="string"&&uuid.test(id)) &&
    digest(source.revisionHash) && digest(source.completionDigest));
}

export function validCloudV3Predecessor(previous, origin, ordinal=2, derived=false) {
  const local = typeof origin==="string" && origin.startsWith("http://");
  if (!(previous && Object.keys(previous).length === (ordinal===2 ? 4 : 5)+Number(Object.hasOwn(previous,"usageFloor")) &&
    digest(previous.checkpointDigest) && digest(previous.completionDigest) &&
    (digest(previous.approvalDigest) || (ordinal===2 && previous.approvalDigest===null && local)) &&
    Number.isFinite(previous.reserveCny) && previous.reserveCny >= 0 && previous.reserveCny < 200 &&
    (!Object.hasOwn(previous,"usageFloor") || validCloudV3UsageFloor(previous.usageFloor))))
    return false;
  if (ordinal===2) return !Object.hasOwn(previous,"approvalDigests");
  const approvals=previous.approvalDigests;
  return Array.isArray(approvals) && (derived ?
    approvals.length>=cloudV3BaseCases().length-Number(local) && approvals.length<ordinal :
    approvals.length===ordinal-1 || (local && approvals.length===ordinal-2)) &&
    approvals.every(digest) && new Set(approvals).size===approvals.length && approvals.at(-1)===previous.approvalDigest;
}

export function cloudV3CheckpointCase(state) {
  const {plan,contractId}=checkpointCaseScope(state,state?.evaluationRunId);
  const [item]=state.outcomes, definition=plan.selectedCases.at(-1);
  if (contractId!==currentLiveLifecycleContract.id || state.outcomes.length!==1 ||
      definition?.id!==item?.caseId ||
      (definition.kind==="DERIVED"? !validCloudV3DerivationSource(definition,item.derivationSource):item.derivationSource!==undefined) ||
      (state.caseLimit===1 ? state.previousCase!==undefined :
        typeof state.origin!=="string" || !validCloudV3Predecessor(state.previousCase,state.origin,state.caseLimit,definition.kind==="DERIVED")))
    stop("云端检查点未绑定已接入的确切评测案例");
  return {definition,item};
}
