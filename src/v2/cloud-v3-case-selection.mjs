import { checkpointCaseScope, stop } from "./live-lifecycle-checkpoint.mjs";
import { currentLiveLifecycleContract } from "./live-lifecycle-evaluation.mjs";

const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

export function validCloudV3Predecessor(previous, origin) {
  return Boolean(previous && Object.keys(previous).length === 4 &&
    digest(previous.checkpointDigest) && digest(previous.completionDigest) &&
    (digest(previous.approvalDigest) || (previous.approvalDigest === null && origin.startsWith("http://"))) &&
    Number.isFinite(previous.reserveCny) && previous.reserveCny >= 0 && previous.reserveCny < 200);
}

export function cloudV3CheckpointCase(state) {
  const {plan,contractId}=checkpointCaseScope(state,state?.evaluationRunId);
  const [item]=state.outcomes, definition=plan.selectedCases.at(-1);
  if (contractId!==currentLiveLifecycleContract.id || state.outcomes.length!==1 ||
      definition?.id!==item?.caseId || ![1,2].includes(state.caseLimit) ||
      (state.caseLimit===1 ? state.previousCase!==undefined :
        typeof state.origin!=="string" || !validCloudV3Predecessor(state.previousCase,state.origin)))
    stop("云端检查点未绑定已接入的确切评测案例");
  return {definition,item};
}
