import { checkpointCaseScope, stop } from "./live-lifecycle-checkpoint.mjs";
import { currentLiveLifecycleContract, liveLifecycleCases } from "./live-lifecycle-evaluation.mjs";

const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
export const cloudV3BaseCases = () => liveLifecycleCases(currentLiveLifecycleContract.id).filter(item => item.kind === "FRESH");
export const cloudV3PredecessorApprovals = previous =>
  previous?.approvalDigests ?? (previous?.approvalDigest ? [previous.approvalDigest] : []);
export const cloudV3UsageKeys = ["modelCalls","remoteSparkRuns","remoteSparkSeconds"];
export const validCloudV3UsageFloor = value => Boolean(value && typeof value.month==="string" &&
  /^\d{4}-(?:0[1-9]|1[0-2])$/.test(value.month) && Object.keys(value).length===4 &&
  [value.modelCalls,value.remoteSparkRuns].every(count=>Number.isSafeInteger(count)&&count>=0) &&
  Number.isFinite(value.remoteSparkSeconds) && value.remoteSparkSeconds>=0);

export function validCloudV3Predecessor(previous, origin, ordinal=2) {
  const local = typeof origin==="string" && origin.startsWith("http://");
  if (!(previous && Object.keys(previous).length === (ordinal===2 ? 4 : 5+Number(Object.hasOwn(previous,"usageFloor"))) &&
    digest(previous.checkpointDigest) && digest(previous.completionDigest) &&
    (digest(previous.approvalDigest) || (ordinal===2 && previous.approvalDigest===null && local)) &&
    Number.isFinite(previous.reserveCny) && previous.reserveCny >= 0 && previous.reserveCny < 200))
    return false;
  if (ordinal===2) return !Object.hasOwn(previous,"approvalDigests") && !Object.hasOwn(previous,"usageFloor");
  const approvals=previous.approvalDigests;
  return Array.isArray(approvals) && (approvals.length===ordinal-1 || (local && approvals.length===ordinal-2)) &&
    approvals.every(digest) && new Set(approvals).size===approvals.length && approvals.at(-1)===previous.approvalDigest &&
    (!Object.hasOwn(previous,"usageFloor") || validCloudV3UsageFloor(previous.usageFloor));
}

export function cloudV3CheckpointCase(state) {
  const {plan,contractId}=checkpointCaseScope(state,state?.evaluationRunId);
  const [item]=state.outcomes, definition=plan.selectedCases.at(-1);
  if (contractId!==currentLiveLifecycleContract.id || state.outcomes.length!==1 ||
      definition?.id!==item?.caseId || definition.kind!=="FRESH" ||
      (state.caseLimit===1 ? state.previousCase!==undefined :
        typeof state.origin!=="string" || !validCloudV3Predecessor(state.previousCase,state.origin,state.caseLimit)))
    stop("云端检查点未绑定已接入的确切评测案例");
  return {definition,item};
}
