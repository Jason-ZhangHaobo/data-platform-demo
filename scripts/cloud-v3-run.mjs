import { isDeepStrictEqual } from "node:util";
import { sha256 } from "../src/v2/delivery.mjs";
import { checkpointCaseScope, readCheckpoint, stop, uuid } from "../src/v2/live-lifecycle-checkpoint.mjs";
import { currentLiveLifecycleContract, liveCaseRequestDigest, liveLifecyclePlan } from "../src/v2/live-lifecycle-evaluation.mjs";
import { liveEvidenceProvenance } from "../src/v2/live-lifecycle-provenance.mjs";

const digest = value => typeof value==="string" && /^[a-f0-9]{64}$/.test(value);
const id = value => typeof value==="string" && uuid.test(value);

export function cloudV3CompletionScope(state,proofs) {
  if (!Array.isArray(proofs) || proofs.length!==2) stop("完成回执须核验两个原发布批次");
  if (new URL(state.origin).protocol==="http:" && proofs.every(proof=>proof?.status==="MATCHED_ONLY"))
    return "LOCAL_MATCHED_ONLY";
  if (new URL(state.origin).protocol==="https:" && proofs.every(proof=>proof?.status==="MATCHED") &&
      digest(state.submission?.windowApprovalDigest) &&
      state.submission?.application?.applicationSource===state.reviewedSource &&
      digest(state.submission?.application?.inspectionDigest))
    return "INVITED_CLOUD_MATCHED";
  stop("原开发窗口、验包或消费范围未获确认");
}

function checkedCompletion(path, original, first) {
  const { state:receipt }=readCheckpoint(path,{privateFile:true});
  const {state,text}=original, action=first.actions?.publication;
  const batches=action?.batchIds;
  const provenance=liveEvidenceProvenance(first);
  if (provenance.synthetic || provenance.nonNative || provenance.unconfirmed || first.actions?.agent?.status!=="CONFIRMED" ||
      action?.status!=="CONFIRMED" || ![first.taskId,first.code?.revisionId,first.code?.runId,action.id,action.verificationId].every(id) ||
      !digest(first.code?.revisionHash) || !digest(action.packageDigest) ||
      !Array.isArray(batches) || batches.length!==2 || new Set(batches).size!==2 || !batches.every(id) ||
      !Number.isFinite(Date.parse(receipt?.checkedAt)))
    stop("完成回执缺少原双批证据");
  const proofs=batches.map(batchId=>first.consumption?.[batchId]);
  if (!proofs.every((proof,index)=>proof?.batchId===batches[index] &&
      [proof.sourceDigest,proof.planDigest,proof.reportDigest,proof.dapiCallIdDigest,proof.xapiCallIdDigest,
        proof.dapiRowsDigest,proof.xapiRowsDigest].every(digest)) ||
      new Set(proofs.flatMap(proof=>[proof.dapiCallIdDigest,proof.xapiCallIdDigest])).size!==4)
    stop("完成回执缺少原双批证据");
  const scope=cloudV3CompletionScope(state,proofs);
  const body={protocol:"shuduo-cloud-v3-completion/v1",scope,checkedAt:receipt.checkedAt,
    checkpointDigest:sha256(text),evaluationRunId:state.evaluationRunId,caseSetDigest:state.caseSetDigest,
    caseId:first.caseId,requestDigest:first.requestDigest,taskId:first.taskId,revisionId:first.code?.revisionId,
    developmentRunId:first.code?.runId,packageDigest:action.packageDigest,verificationId:action.verificationId,
    releaseId:action.id,batchIds:batches,consumptionDigest:sha256(JSON.stringify(proofs))};
  if (!isDeepStrictEqual(receipt,{...body,completionDigest:sha256(JSON.stringify(body))}))
    stop("完成回执与原检查点、案例或批次不一致");
  return receipt;
}

export function readCloudV3Run(path, {completionPath}={}) {
  const original=readCheckpoint(path,{privateFile:true});
  const {state,text}=original;
  const {plan,contractId}=checkpointCaseScope(state,state?.evaluationRunId);
  const [first]=state.outcomes;
  if (contractId!==currentLiveLifecycleContract.id || state.caseLimit!==1 || state.outcomes.length!==1 ||
      !id(first?.actions?.agent?.key) || !digest(first.actions.agent.bodyHash) ||
      !["PREPARED","SUBMITTING","UNKNOWN","CONFIRMED"].includes(first.actions.agent.status) ||
      !["REQUIREMENT","CODE_AND_DEBUG","DELIVERY_PREPARATION"].includes(first.phase))
    stop("须使用原云端首例检查点");
  const fullPlan=liveLifecyclePlan(plan.contract.expectedCaseCount,{contractId});
  const completion=completionPath ? checkedCompletion(completionPath,original,first) : undefined;
  const verified=completion?.scope==="INVITED_CLOUD_MATCHED";
  const cases=fullPlan.selectedCases.map(definition=>{
    const item={caseId:definition.id,kind:definition.kind,contextId:definition.contextId,
      requestDigest:liveCaseRequestDigest(definition,contractId)};
    if (definition.id===first.caseId) return {...item,status:verified ? "CLOUD_CHAIN_VERIFIED"
      : completion ? "LOCAL_MATCHED_ONLY" : "ORIGINAL_CHECKPOINT",
      creationStatus:first.actions.agent.status,phase:first.phase};
    if (definition.kind==="DERIVED") {
      const parentVerified=verified&&definition.sourceCaseId===first.caseId;
      return {...item,sourceCaseId:definition.sourceCaseId,status:parentVerified ? "SOURCE_VERIFIED" : "WAITING_FOR_SOURCE",
        ...(parentVerified ? {source:{evaluationRunId:state.evaluationRunId,requestDigest:first.requestDigest,
          taskId:first.taskId,revisionId:first.code.revisionId,revisionHash:first.code.revisionHash,
          developmentRunId:first.code.runId,completionDigest:completion.completionDigest}} : {})};
    }
    return {...item,status:"NOT_STARTED"};
  });
  return {protocol:"shuduo-cloud-v3-run/v1",verificationMode:"STORED_CHECKPOINT_AND_RECEIPT_ONLY",
    evaluationRunId:state.evaluationRunId,caseSetDigest:state.caseSetDigest,originalCheckpointDigest:sha256(text),
    expectedCaseCount:fullPlan.contract.expectedCaseCount,verifiedCloudCaseCount:verified ? 1 : 0,
    nextCaseId:verified ? fullPlan.selectedCases[1].id : first.caseId,
    ...(completion ? {completionDigest:completion.completionDigest} : {}),
    cases,willExecute:false,executionAuthorized:false,agentIndependentE2E:false,publicDeployed:false};
}
