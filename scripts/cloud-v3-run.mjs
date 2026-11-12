import { isDeepStrictEqual } from "node:util";
import { isAbsolute } from "node:path";
import { sha256 } from "../src/v2/delivery.mjs";
import { checkpointCaseScope, readCheckpoint, stop, uuid } from "../src/v2/live-lifecycle-checkpoint.mjs";
import { currentLiveLifecycleContract, liveCaseRequestDigest, liveLifecyclePlan } from "../src/v2/live-lifecycle-evaluation.mjs";
import { liveEvidenceProvenance } from "../src/v2/live-lifecycle-provenance.mjs";
import { cloudV3BaseCases, cloudV3CheckpointCase, cloudV3PredecessorApprovals, cloudV3UsageKeys, validCloudV3UsageFloor } from "../src/v2/cloud-v3-case-selection.mjs";

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

function validRecordedCreation(item) {
  return id(item?.actions?.agent?.key) && digest(item.actions.agent.bodyHash) &&
    ["PREPARED","SUBMITTING","UNKNOWN","CONFIRMED"].includes(item.actions.agent.status) &&
    ["REQUIREMENT","CODE_AND_DEBUG","DELIVERY_PREPARATION"].includes(item.phase);
}

function caseEvidenceIdentities(item) {
  const publication=item.actions.publication;
  return [item.actions.agent.key,item.taskId,item.code?.revisionId,item.code?.runId,item.actions.delivery?.id,
    item.rehearsal?.id,publication?.id,...(Array.isArray(publication?.batchIds)?publication.batchIds:[]),
    ...Object.values(item.consumption??{}).flatMap(proof=>[proof?.dapiCallIdDigest,proof?.xapiCallIdDigest])]
    .filter(value=>id(value)||digest(value));
}

export function readCloudV3BaseCases(path,{completionPath,nextPath,nextCompletionPath,recordsPath}={}) {
  const original=readCheckpoint(path,{privateFile:true});
  const {state,text}=original;
  const {plan,contractId}=checkpointCaseScope(state,state?.evaluationRunId);
  const [first]=state.outcomes;
  if (contractId!==currentLiveLifecycleContract.id || state.caseLimit!==1 || state.outcomes.length!==1 ||
      !validRecordedCreation(first))
    stop("须使用原云端首例检查点");
  const fullPlan=liveLifecyclePlan(plan.contract.expectedCaseCount,{contractId});
  const completion=completionPath ? checkedCompletion(completionPath,original,first) : undefined;
  const entries=[], approvals=[], evidence=new Set();
  let reserveCny=0, usageFloor;
  const record=(checkpoint,item,completed)=>{
    const approval=checkpoint.state.submission?.windowApprovalDigest;
    if (approval!==undefined) {
      if (!digest(approval) || approvals.includes(approval)) stop("同一评测不能复用开发窗口审批");
      approvals.push(approval);
    }
    const identities=caseEvidenceIdentities(item);
    if (identities.some(identity=>evidence.has(identity))) stop("同一评测不能复用其他案例的任务、批次或调用回执");
    for (const identity of identities) evidence.add(identity);
    for (const attempt of [checkpoint.state.submission,...Object.values(item.actions)]) {
      const bill=attempt?.bill;
      if (bill?.unsettledReserveCny!==undefined) {
        if (!Number.isFinite(bill.unsettledReserveCny) || bill.unsettledReserveCny<0 || bill.unsettledReserveCny>=200)
          stop("原评测预留无法核对");
        reserveCny=Math.max(reserveCny,bill.unsettledReserveCny);
      }
      if (attempt?.usage!==undefined) {
        const observed={month:bill?.month,...attempt.usage};
        if (!validCloudV3UsageFloor(observed)) stop("原评测用量无法核对");
        if (!usageFloor || observed.month>usageFloor.month) usageFloor=observed;
        else if (observed.month===usageFloor.month) {
          for (const key of cloudV3UsageKeys) usageFloor[key]=Math.max(usageFloor[key],observed[key]);
        }
      }
    }
    entries.push({checkpoint,item,completion:completed});
  };
  record(original,first,completion);
  if ((nextCompletionPath && !nextPath) || (recordsPath && (nextPath || nextCompletionPath)))
    stop("请选择续接文件列表或第二例的原路径");
  const files=recordsPath?readCheckpoint(recordsPath,{privateFile:true}).state:
    nextPath?[{checkpoint:nextPath,...(nextCompletionPath?{completion:nextCompletionPath}:{})}]:[];
  if (!Array.isArray(files) || files.length>=cloudV3BaseCases().length ||
      files.some(file=>!file || typeof file.checkpoint!=="string" || !isAbsolute(file.checkpoint) ||
        Object.keys(file).some(key=>!["checkpoint","completion"].includes(key)) ||
        (Object.hasOwn(file,"completion") && (typeof file.completion!=="string" || !isAbsolute(file.completion)))))
    stop("续接列表仅接受按案例顺序排列的检查点和完成回执路径");
  for (const file of files) {
    const next=readCheckpoint(file.checkpoint,{privateFile:true}), {item}=cloudV3CheckpointCase(next.state);
    const previous=next.state.previousCase;
    const parent=entries.at(-1);
    if (!parent.completion || !previous || next.state.caseLimit!==entries.length+1 ||
        next.state.evaluationRunId!==state.evaluationRunId ||
        next.state.startedAt!==state.startedAt || next.state.origin!==state.origin || next.state.projectId!==state.projectId ||
        previous.checkpointDigest!==sha256(parent.checkpoint.text) || previous.completionDigest!==parent.completion.completionDigest ||
        previous.approvalDigest!==(parent.checkpoint.state.submission?.windowApprovalDigest??null) ||
        !isDeepStrictEqual(cloudV3PredecessorApprovals(previous),approvals) || previous.reserveCny!==reserveCny ||
        !isDeepStrictEqual(previous.usageFloor,next.state.caseLimit>2?usageFloor:undefined) ||
        !validRecordedCreation(item))
      stop("续接案例与原评测、审批历史或上一例完成回执不一致");
    record(next,item,file.completion?checkedCompletion(file.completion,next,item):undefined);
  }
  return {original,fullPlan,entries,approvals,reserveCny,usageFloor};
}

export function readCloudV3Run(path,options) {
  const {original,fullPlan,entries}=readCloudV3BaseCases(path,options);
  const {state,text}=original, contractId=fullPlan.contract.id, completion=entries[0].completion;
  const recorded=new Map(entries.map(entry=>[entry.item.caseId,entry]));
  const verified=entry=>entry?.completion?.scope==="INVITED_CLOUD_MATCHED";
  const cases=fullPlan.selectedCases.map(definition=>{
    const item={caseId:definition.id,kind:definition.kind,contextId:definition.contextId,
      requestDigest:liveCaseRequestDigest(definition,contractId)};
    const existing=recorded.get(definition.id);
    if (existing) return {...item,status:verified(existing) ? "CLOUD_CHAIN_VERIFIED"
      : existing.completion ? "LOCAL_MATCHED_ONLY" : "ORIGINAL_CHECKPOINT",
      creationStatus:existing.item.actions.agent.status,phase:existing.item.phase};
    if (definition.kind==="DERIVED") {
      const parent=recorded.get(definition.sourceCaseId), parentVerified=verified(parent);
      return {...item,sourceCaseId:definition.sourceCaseId,status:parentVerified ? "SOURCE_VERIFIED" : "WAITING_FOR_SOURCE",
        ...(parentVerified ? {source:{evaluationRunId:state.evaluationRunId,requestDigest:parent.item.requestDigest,
          taskId:parent.item.taskId,revisionId:parent.item.code.revisionId,revisionHash:parent.item.code.revisionHash,
          developmentRunId:parent.item.code.runId,completionDigest:parent.completion.completionDigest}} : {})};
    }
    return {...item,status:"NOT_STARTED"};
  });
  return {protocol:"shuduo-cloud-v3-run/v1",verificationMode:"STORED_CHECKPOINT_AND_RECEIPT_ONLY",
    evaluationRunId:state.evaluationRunId,caseSetDigest:state.caseSetDigest,originalCheckpointDigest:sha256(text),
    expectedCaseCount:fullPlan.contract.expectedCaseCount,verifiedCloudCaseCount:[...recorded.values()].filter(verified).length,
    nextCaseId:cases.find(entry=>entry.status!=="CLOUD_CHAIN_VERIFIED").caseId,
    ...(completion ? {completionDigest:completion.completionDigest} : {}),
    cases,willExecute:false,executionAuthorized:false,agentIndependentE2E:false,publicDeployed:false};
}
