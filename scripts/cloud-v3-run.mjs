import { isDeepStrictEqual } from "node:util";
import { isAbsolute } from "node:path";
import { sha256 } from "../src/v2/delivery.mjs";
import { checkpointCaseScope, readCheckpoint, stop, uuid } from "../src/v2/live-lifecycle-checkpoint.mjs";
import { currentLiveLifecycleContract, liveCaseRequestDigest, liveLifecyclePlan } from "../src/v2/live-lifecycle-evaluation.mjs";
import { liveEvidenceProvenance } from "../src/v2/live-lifecycle-provenance.mjs";
import { validSettledDevelopmentFailure } from "../src/v2/agent-execution-evidence.mjs";
import { validStoredWorkerBatchResult } from "../src/v2/worker-result-evidence.mjs";
import { validationFamilyForContext } from "../src/v2/context.mjs";
import { cloudV3BaseCases, cloudV3CheckpointCase, cloudV3PredecessorApprovals, cloudV3UsageKeys, validCloudV3UsageFloor } from "../src/v2/cloud-v3-case-selection.mjs";

const digest = value => typeof value==="string" && /^[a-f0-9]{64}$/.test(value);
const id = value => typeof value==="string" && uuid.test(value);
const failureProtocol="shuduo-cloud-v3-settled-failure/v1";
const billingMonth=new Intl.DateTimeFormat("sv-SE",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit"});
const hasCloudApplication=state=>digest(state.submission?.windowApprovalDigest) &&
  state.submission?.application?.applicationSource===state.reviewedSource &&
  digest(state.submission?.application?.inspectionDigest);

export function cloudV3CompletionScope(state,proofs) {
  if (!Array.isArray(proofs) || proofs.length!==2) stop("完成回执须核验两个原发布批次");
  if (new URL(state.origin).protocol==="http:" && proofs.every(proof=>proof?.status==="MATCHED_ONLY"))
    return "LOCAL_MATCHED_ONLY";
  if (new URL(state.origin).protocol==="https:" && proofs.every(proof=>proof?.status==="MATCHED") &&
      hasCloudApplication(state))
    return "INVITED_CLOUD_MATCHED";
  stop("原开发窗口、验包或消费范围未获确认");
}

export function validDownstreamFailure(item,failure) {
  const {delivery,rehearsal,publication}=item.actions, code=item.code;
  if (!code || code.taskId!==item.taskId || !id(code.revisionId) || !id(code.runId) ||
      !digest(code.revisionHash) || !Number.isSafeInteger(code.accountedTokens) ||
      code.accountedTokens!==code.reportedTokens || code.reservedTokens!==0 || code.unattributedTokens!==0 ||
      delivery?.status!=="CONFIRMED" || !id(delivery.id) || !id(failure.packageId) || !digest(failure.packageDigest) ||
      failure.packageId!==delivery.packageId || failure.packageDigest!==delivery.packageDigest ||
      !id(failure.verificationId) || (item.rehearsal && item.rehearsal.id!==failure.verificationId) ||
      !Array.isArray(failure.batches) || item.consumption)
    return false;
  if (failure.kind==="FILE_REHEARSAL") {
    const [batch]=failure.batches;
    return Object.keys(failure).length===5 && !publication && failure.batches.length===1 &&
      rehearsal && ["SUBMITTING","UNKNOWN","CONFIRMED"].includes(rehearsal.status) &&
      rehearsal.deliveryId===delivery.id && rehearsal.packageId===failure.packageId && rehearsal.packageDigest===failure.packageDigest &&
      (rehearsal.id===undefined||rehearsal.id===failure.verificationId) &&
      validStoredWorkerBatchResult(batch) && batch.id===failure.verificationId && batch.status==="FAILED";
  }
  if (failure.kind!=="PUBLICATION" || Object.keys(failure).length!==7 || !publication ||
      !["SUBMITTING","UNKNOWN","CONFIRMED"].includes(publication.status) ||
      !id(failure.releaseId) || !digest(failure.reviewDigest) || failure.reviewDigest!==publication.reviewDigest ||
      failure.packageId!==publication.packageId || failure.packageDigest!==publication.packageDigest ||
      failure.verificationId!==publication.verificationId || item.rehearsal?.status!=="SUCCEEDED" ||
      (publication.id!==undefined&&publication.id!==failure.releaseId) || failure.batches.length!==2 ||
      !failure.batches.every(batch=>{
        if (!batch || !id(batch.eventId)) return false;
        const {eventId,...result}=batch;
        return validStoredWorkerBatchResult(result);
      }))
    return false;
  const batches=failure.batches.map(batch=>batch.id);
  return new Set(batches).size===2 && new Set(failure.batches.map(batch=>batch.eventId)).size===2 &&
    failure.batches.some(batch=>batch.status==="FAILED") &&
    (publication.batchIds===undefined||isDeepStrictEqual(publication.batchIds,batches));
}

export function cloudV3FailureReceipt(original,item,failure,checkedAt) {
  const {state,text}=original, protocol=new URL(state.origin).protocol;
  const startedAt=state.previousCase ? state.submission?.submittedAt : item.evaluationStartedAt;
  const provenance=liveEvidenceProvenance(item);
  const downstream=failure?.kind!==undefined;
  const valid=downstream?validDownstreamFailure(item,failure):
    Object.keys(item.actions).length===1 && !item.code && !item.rehearsal && !item.consumption &&
    validSettledDevelopmentFailure(failure);
  const finishes=valid&&downstream?failure.batches.map(batch=>batch.finishedAt):[failure?.finishedAt];
  if (provenance.synthetic || provenance.nonNative || provenance.unconfirmed ||
      item.actions.agent.status!=="CONFIRMED" || !id(item.taskId) || item.actions.agent.id!==item.taskId ||
      !valid || !finishes.every(time=>Date.parse(startedAt)<=Date.parse(time) && Date.parse(time)<=Date.parse(checkedAt)) ||
      !(protocol==="http:" || (protocol==="https:" && hasCloudApplication(state))))
    stop("原案例尚无已结算的失败证据");
  const body={protocol:failureProtocol,scope:protocol==="https:"?"INVITED_CLOUD_SETTLED_FAILURE":"LOCAL_SETTLED_FAILURE_ONLY",
    checkedAt,checkpointDigest:sha256(text),evaluationRunId:state.evaluationRunId,caseSetDigest:state.caseSetDigest,
    caseId:item.caseId,requestDigest:item.requestDigest,taskId:item.taskId,failure};
  return {...body,completionDigest:sha256(JSON.stringify(body))};
}

function checkedCompletion(path, original, first) {
  const { state:receipt }=readCheckpoint(path,{privateFile:true});
  if (receipt?.protocol===failureProtocol) {
    if (!isDeepStrictEqual(receipt,cloudV3FailureReceipt(original,first,receipt.failure,receipt.checkedAt)))
      stop("失败回执与原检查点或案例不一致");
    return receipt;
  }
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

export function nextCloudV3Definition(fullPlan,entries) {
  const baseCount=cloudV3BaseCases().length;
  if (entries.length<baseCount) return fullPlan.selectedCases[entries.length];
  return fullPlan.selectedCases.slice(baseCount).find(definition=>
    !entries.some(entry=>entry.item.caseId===definition.id) &&
    entries.some(entry=>entry.item.caseId===definition.sourceCaseId && entry.completion && !entry.completion.failure));
}

export function cloudV3DerivationSource(fullPlan,definition,parent) {
  const source=fullPlan.selectedCases.find(entry=>entry.id===definition.sourceCaseId);
  if (!source || parent?.item.caseId!==source.id || !parent.completion || parent.completion.failure)
    stop("派生来源没有原案例成功回执");
  const {item,completion}=parent, code=item.code;
  return {protocol:"shuduo-cloud-v3-derivation-source/v1",sourceCaseId:source.id,
    contextId:source.contextId,validationContractId:validationFamilyForContext(source.contextId).id,
    taskId:item.taskId,revisionId:code.revisionId,runId:code.runId,revisionHash:code.revisionHash,
    completionDigest:completion.completionDigest};
}

export function readCloudV3Cases(path,{completionPath,nextPath,nextCompletionPath,recordsPath}={}) {
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
  const retainUsage=observed=>{
    if (!validCloudV3UsageFloor(observed)) stop("原评测用量无法核对");
    if (!usageFloor || observed.month>usageFloor.month) usageFloor=observed;
    else if (observed.month===usageFloor.month) {
      for (const key of cloudV3UsageKeys) usageFloor[key]=Math.max(usageFloor[key],observed[key]);
    }
  };
  const record=(checkpoint,item,completed)=>{
    const approval=checkpoint.state.submission?.windowApprovalDigest;
    if (approval!==undefined) {
      if (!digest(approval) || approvals.includes(approval)) stop("同一评测不能复用开发窗口审批");
      approvals.push(approval);
    }
    const failure=completed?.failure;
    const identities=[...caseEvidenceIdentities(item),...(failure?.sparkRunIds??[]),
      ...(failure?.batches??[]).map(batch=>batch.id),...(failure?.releaseId?[failure.releaseId]:[])];
    if (identities.some(identity=>evidence.has(identity))) stop("同一评测不能复用其他案例的任务、批次或调用回执");
    for (const identity of identities) evidence.add(identity);
    for (const attempt of [checkpoint.state.submission,...Object.values(item.actions)]) {
      const bill=attempt?.bill;
      if (bill?.unsettledReserveCny!==undefined) {
        if (!Number.isFinite(bill.unsettledReserveCny) || bill.unsettledReserveCny<0 || bill.unsettledReserveCny>=200)
          stop("原评测预留无法核对");
        reserveCny=Math.max(reserveCny,bill.unsettledReserveCny);
      }
      if (attempt?.usage!==undefined) retainUsage({...attempt.usage,month:bill?.month});
    }
    const submission=checkpoint.state.submission;
    if (failure?.batches) {
      const attempt=failure.kind==="PUBLICATION"?item.actions.publication:item.actions.rehearsal;
      const sameMonth=failure.batches.filter(batch=>billingMonth.format(new Date(batch.createdAt))===attempt.bill?.month);
      if (attempt.usage && sameMonth.length) retainUsage({...attempt.usage,month:attempt.bill.month,
        remoteSparkRuns:attempt.usage.remoteSparkRuns+sameMonth.length,
        remoteSparkSeconds:attempt.usage.remoteSparkSeconds+sameMonth.reduce((sum,batch)=>sum+batch.durationMs,0)/1000});
    } else if (failure && submission?.usage && [checkpoint.state.previousCase?submission.submittedAt:item.evaluationStartedAt,failure.finishedAt]
        .every(time=>billingMonth.format(new Date(time))===submission.bill.month)) {
      retainUsage({...submission.usage,month:submission.bill.month,
        modelCalls:submission.usage.modelCalls+failure.modelAttempts,
        remoteSparkRuns:submission.usage.remoteSparkRuns+failure.sparkRunIds.length,
        remoteSparkSeconds:submission.usage.remoteSparkSeconds+failure.sparkDurationMs/1000});
    }
    entries.push({checkpoint,item,completion:completed});
  };
  record(original,first,completion);
  if ((nextCompletionPath && !nextPath) || (recordsPath && (nextPath || nextCompletionPath)))
    stop("请选择续接文件列表或第二例的原路径");
  const files=recordsPath?readCheckpoint(recordsPath,{privateFile:true}).state:
    nextPath?[{checkpoint:nextPath,...(nextCompletionPath?{completion:nextCompletionPath}:{})}]:[];
  if (!Array.isArray(files) || files.length>=fullPlan.selectedCases.length ||
      files.some(file=>!file || typeof file.checkpoint!=="string" || !isAbsolute(file.checkpoint) ||
        Object.keys(file).some(key=>!["checkpoint","completion"].includes(key)) ||
        (Object.hasOwn(file,"completion") && (typeof file.completion!=="string" || !isAbsolute(file.completion)))))
    stop("续接列表仅接受按案例顺序排列的检查点和完成回执路径");
  for (const file of files) {
    const next=readCheckpoint(file.checkpoint,{privateFile:true}), {item}=cloudV3CheckpointCase(next.state);
    const previous=next.state.previousCase;
    const parent=entries.at(-1), definition=nextCloudV3Definition(fullPlan,entries);
    if (!parent.completion || !previous || item.caseId!==definition?.id ||
        next.state.evaluationRunId!==state.evaluationRunId ||
        next.state.startedAt!==state.startedAt || next.state.origin!==state.origin || next.state.projectId!==state.projectId ||
        previous.checkpointDigest!==sha256(parent.checkpoint.text) || previous.completionDigest!==parent.completion.completionDigest ||
        previous.approvalDigest!==(parent.checkpoint.state.submission?.windowApprovalDigest??null) ||
        !isDeepStrictEqual(cloudV3PredecessorApprovals(previous),approvals) || previous.reserveCny!==reserveCny ||
        !isDeepStrictEqual(previous.usageFloor,next.state.caseLimit>2||parent.completion.failure?usageFloor:undefined) ||
        !validRecordedCreation(item))
      stop("续接案例与原评测、审批历史或上一例完成回执不一致");
    if (definition.kind==="DERIVED" && !isDeepStrictEqual(item.derivationSource,cloudV3DerivationSource(fullPlan,definition,
      entries.find(entry=>entry.item.caseId===definition.sourceCaseId))))
      stop("派生案例与固定父版本或成功回执不一致");
    record(next,item,file.completion?checkedCompletion(file.completion,next,item):undefined);
  }
  return {original,fullPlan,entries,approvals,reserveCny,usageFloor};
}

export function readCloudV3Run(path,options) {
  const {original,fullPlan,entries}=readCloudV3Cases(path,options);
  const {state,text}=original, contractId=fullPlan.contract.id, completion=entries[0].completion;
  const recorded=new Map(entries.map(entry=>[entry.item.caseId,entry]));
  const verified=entry=>entry?.completion?.scope==="INVITED_CLOUD_MATCHED";
  const cloudFailure=entry=>entry?.completion?.scope==="INVITED_CLOUD_SETTLED_FAILURE";
  const cases=fullPlan.selectedCases.map(definition=>{
    const item={caseId:definition.id,kind:definition.kind,contextId:definition.contextId,
      requestDigest:liveCaseRequestDigest(definition,contractId),
      ...(definition.kind==="DERIVED"?{sourceCaseId:definition.sourceCaseId}:{})};
    const existing=recorded.get(definition.id);
    if (existing) return {...item,status:verified(existing) ? "CLOUD_CHAIN_VERIFIED" : cloudFailure(existing) ? "CLOUD_FAILURE_SETTLED"
      : existing.completion?.failure ? "LOCAL_FAILURE_SETTLED_ONLY" : existing.completion ? "LOCAL_MATCHED_ONLY" : "ORIGINAL_CHECKPOINT",
      creationStatus:existing.item.actions.agent.status,phase:existing.item.phase};
    if (definition.kind==="DERIVED") {
      const parent=recorded.get(definition.sourceCaseId), parentVerified=verified(parent);
      return {...item,status:parentVerified ? "SOURCE_VERIFIED"
        : cloudFailure(parent) ? "SOURCE_FAILED" : "WAITING_FOR_SOURCE",
        ...(parentVerified ? {source:{evaluationRunId:state.evaluationRunId,requestDigest:parent.item.requestDigest,
          taskId:parent.item.taskId,revisionId:parent.item.code.revisionId,revisionHash:parent.item.code.revisionHash,
          developmentRunId:parent.item.code.runId,completionDigest:parent.completion.completionDigest}} : {})};
    }
    return {...item,status:"NOT_STARTED"};
  });
  return {protocol:"shuduo-cloud-v3-run/v1",verificationMode:"STORED_CHECKPOINT_AND_RECEIPT_ONLY",
    evaluationRunId:state.evaluationRunId,caseSetDigest:state.caseSetDigest,originalCheckpointDigest:sha256(text),
    expectedCaseCount:fullPlan.contract.expectedCaseCount,verifiedCloudCaseCount:[...recorded.values()].filter(verified).length,
    ...(entries.some(entry=>entry.completion?.failure)?{settledCloudFailureCount:entries.filter(cloudFailure).length}:{}),
    nextCaseId:cases.find(entry=>!["CLOUD_CHAIN_VERIFIED","CLOUD_FAILURE_SETTLED","SOURCE_FAILED"].includes(entry.status))?.caseId??null,
    ...(completion ? {completionDigest:completion.completionDigest} : {}),
    cases,willExecute:false,executionAuthorized:false,agentIndependentE2E:false,publicDeployed:false};
}
