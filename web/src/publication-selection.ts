import {reviewAttestationsComplete} from "./delivery-presentation.ts";

export type PublicationSelector = {sourceKind:"AGENT"|"MANUAL";sourceRunId?:string;packageDigest:string;verificationId:string};
export type PublicationSelection = {taskId:string;manual:boolean;runId?:string;revisionId?:string;contextId?:string};
type WorkflowSource = {
  report?:{taskId:string;sourceKind?:string;agentIndependentE2E?:boolean;runId?:string;revisionId?:string;contextId?:string};
  delivery?:{packageId?:string;packageDigest?:string;verificationId?:string;sourceRunId?:string;sourceRevisionId?:string;sourceKind?:string};
  package?:{id:string;digest:string};verification?:{id:string};
};
export type PublicationReleaseSource = {id:string;sourceKind?:string;sourceRunId?:string;sourceAgentTaskId?:string;sourceRevisionId?:string;packageDigest?:string;verificationId?:string};
const opaque=(value:unknown):value is string=>typeof value==="string"&&value.length>0&&value.length<=100&&/^[a-zA-Z0-9_-]+$/.test(value);
export function publicationSelector(selection:PublicationSelection,workflow:WorkflowSource|undefined,evidenceReady:boolean):PublicationSelector|undefined {
  if(!evidenceReady||!workflow)return;
  const {report,delivery,package:bundle,verification}=workflow;
  if(!opaque(selection.taskId)||!opaque(selection.runId)||!opaque(selection.revisionId)||!report||!delivery||!bundle||!verification||
    report.taskId!==selection.taskId||report.runId!==selection.runId||report.revisionId!==selection.revisionId||
    selection.contextId!==undefined&&report.contextId!==selection.contextId||
    delivery.sourceRunId!==selection.runId||delivery.sourceRevisionId!==selection.revisionId||
    delivery.packageId!==bundle.id||delivery.packageDigest!==bundle.digest||delivery.verificationId!==verification.id||
    !/^[a-f0-9]{64}$/.test(bundle.digest)||!opaque(verification.id))return;
  if(selection.manual){
    if(report.sourceKind!=="MANUAL"||report.agentIndependentE2E!==false||delivery.sourceKind!=="MANUAL")return;
    return {sourceKind:"MANUAL",sourceRunId:selection.runId,packageDigest:bundle.digest,verificationId:verification.id};
  }
  if(report.sourceKind==="MANUAL"||delivery.sourceKind==="MANUAL")return;
  return {sourceKind:"AGENT",packageDigest:bundle.digest,verificationId:verification.id};
}
export function publicationSelectionKey(taskId:string,selector:PublicationSelector){
  return JSON.stringify([taskId,selector.sourceKind,selector.sourceRunId??"",selector.packageDigest,selector.verificationId]);
}
export function publicationReadPath(taskId:string,selector:PublicationSelector,releaseId?:string){
  const query=new URLSearchParams({...selector,...(releaseId?{releaseId}:{})});
  return `/agent/tasks/${encodeURIComponent(taskId)}/publication?${query}`;
}
export function publicationReleaseMatches(release:PublicationReleaseSource|undefined,taskId:string,selector:PublicationSelector,releaseId?:string){
  return Boolean(release&&release.sourceAgentTaskId===taskId&&(release.sourceKind??"AGENT")===selector.sourceKind&&
    release.packageDigest===selector.packageDigest&&release.verificationId===selector.verificationId&&
    (selector.sourceRunId===undefined||release.sourceRunId===selector.sourceRunId)&&(!releaseId||release.id===releaseId));
}
export function checkedPublication<T extends {release?:PublicationReleaseSource;runs:unknown[];alerts:unknown[];events:unknown[]}>(value:T,taskId:string,selector:PublicationSelector,releaseId?:string,requireRelease=false):T {
  if(!value||!Array.isArray(value.runs)||!Array.isArray(value.alerts)||!Array.isArray(value.events)||
    value.release&&!publicationReleaseMatches(value.release,taskId,selector,releaseId)||
    !value.release&&(value.runs.length||value.alerts.length||value.events.length||releaseId||requireRelease))
    throw Error("发布回执与当前人工／Agent来源、交付包或演练不一致；未采用其他历史发布。");
  return value;
}
export function publicationWriteAllowed({manual,canPublish,canWrite,cloud,hasSelector,targetMatches}:{manual:boolean;canPublish?:boolean;canWrite:boolean;cloud:boolean;hasSelector:boolean;targetMatches:boolean}){
  return Boolean((manual?canPublish===true:(canPublish??canWrite))&&targetMatches&&(!cloud||hasSelector)&&(!manual||cloud));
}
// Stopping a known release does not need a fresh monitoring read. It still
// requires the last confirmed exact source, a pinned release and live authority.
export function publicationCancellationAllowed({taskId,selector,release,publicationKey,confirmedReadKey,pinnedReleaseId,canPublish,dirty,working}:{
  taskId:string;selector?:PublicationSelector;release?:PublicationReleaseSource;
  publicationKey:string;confirmedReadKey:string;pinnedReleaseId?:string;canPublish:boolean;dirty:boolean;working:boolean;
}){
  return Boolean(canPublish&&!dirty&&!working&&selector&&release&&opaque(release.id)&&opaque(pinnedReleaseId)&&publicationKey&&
    publicationKey===confirmedReadKey&&publicationKey===publicationSelectionKey(taskId,selector)&&
    pinnedReleaseId===release.id&&publicationReleaseMatches(release,taskId,selector,pinnedReleaseId));
}
export function cloudPublicationRequest(selector:PublicationSelector,packageId:string,attestations:Record<string,boolean>,reviewDigest?:string){
  const idempotencyKey=`agent-publish-${packageId}-${selector.verificationId}`;
  if(!opaque(packageId)||!opaque(selector.verificationId)||idempotencyKey.length>100||
    !["MANUAL","AGENT"].includes(selector.sourceKind)||!/^[a-f0-9]{64}$/.test(selector.packageDigest)||
    selector.sourceKind==="MANUAL"&&!opaque(selector.sourceRunId)||!reviewAttestationsComplete(attestations,true)||
    reviewDigest!==undefined&&(selector.sourceKind!=="AGENT"||!opaque(selector.sourceRunId)||!/^[a-f0-9]{64}$/.test(reviewDigest)))throw Error("请逐项审阅这个确切版本的四项依据。");
  return {body:{packageDigest:selector.packageDigest,verificationId:selector.verificationId,
    ...(selector.sourceKind==="MANUAL"?{sourceKind:"MANUAL" as const,sourceRunId:selector.sourceRunId}:{}),
    ...(reviewDigest ? {sourceKind:"AGENT" as const,sourceRunId:selector.sourceRunId,reviewDigest}:{}),
    attestations:{code:true,assertions:true,deliveryFiles:true,cloudScope:true}},
    idempotencyKey};
}

// One frozen request per exact package/rehearsal. Unknown replies are read first;
// another POST requires an explicit retry and reuses the original body and key.
export function createPublicationAttempt(request:ReturnType<typeof cloudPublicationRequest>){
  const frozen=structuredClone(request);
  let status:"IDLE"|"SENDING"|"UNKNOWN"|"CONFIRMED"="IDLE",readChecked=false;
  return {
    snapshot:()=>({status,readChecked}),
    request:()=>structuredClone(frozen),
    readback(hasRelease:boolean){readChecked=true;if(hasRelease)status="CONFIRMED";},
    async submit<T>(post:(request:typeof frozen)=>Promise<T>,explicitRetry=false):Promise<T>{
      if(status==="SENDING"||status==="CONFIRMED")throw Error("原发布请求正在提交或已确认，请读取同一版本的发布记录。");
      if(status==="UNKNOWN"&&(!explicitRetry||!readChecked))throw Error("发布结果尚未确认，请先读取同一交付包的原记录，不自动重复提交。");
      status="SENDING";readChecked=false;
      try{const result=await post(structuredClone(frozen));status="CONFIRMED";return result;}
      catch(error){if(status!=="CONFIRMED"){status="UNKNOWN";readChecked=false;}throw error;}
    },
  };
}
