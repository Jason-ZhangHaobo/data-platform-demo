import {LocalDistributionControls} from './LocalDistributionControls';
import {LocalDistributionReview} from './LocalDistributionReview';
import {distributionMetadataForContext} from '../../src/v2/output-contract-metadata.mjs';
import React, { lazy, Suspense, useEffect, useRef, useState } from "react";
import {AssistedDevelopmentReference} from './AssistedDevelopmentReference';
import { CheckCircle2, Circle, Download, FileText, LoaderCircle, Package, Play, RefreshCw, ShieldCheck, Square } from "lucide-react";
import { agentJourney, deliveryStageText, publicationEvidenceText, verificationPresentation } from "./agent-journey";
import type { EvidenceReadState, TaskConsumption } from "./agent-journey";
import { EvidenceDownload } from "./EvidenceDownload";
import { AgentCallHistoryLink } from "./AgentCallHistory";
import { DeliveryFilePreview } from "./DeliveryFilePreview";
import {AgentRequirementUnderstanding} from './AgentRequirementUnderstanding';
import { AgentPublicationReview, publicationTargetMatches } from "./AgentPublicationReview";
import type { PublicationTarget } from "./AuthDialog";
import { applicationStatusText } from "./service-consumption-scope";
import { reviewAttestationsComplete } from "./delivery-presentation";
import { createPublicationReader, publicationPollNeeded } from "./publication-read";
import {ValidationDetails} from "./ValidationDetails";
import {checkedAgentWorkflow,checkedCloudPublicationPreflight,exactDeliveryAdvance,frozenRequirementProposal} from "./agent-workflow-read";
import type {CloudPublicationPreflight} from "./agent-workflow-read";
import type {FundExecutionBinding} from "../../src/v2/fund-preparation-client.mjs";
import {recheckFundRehearsal} from "../../src/v2/fund-rehearsal-recheck.mjs";
import type {Delivery,Workflow} from "./agent-workflow-read";
import {checkedAgentPublication,checkedAgentConsumption,checkedExactPublicationReceipt} from "./agent-delivery-evidence-read";
import {publicationPreflightPath,publicationRequestReceiptPath} from "../../src/v2/publication-request.mjs";
import type {Publication,Release} from "./agent-delivery-evidence-read";
import {privateReleasePendingLabel} from "../../src/v2/private-release-stage.mjs";
import {publicationSelector,publicationSelectionKey,publicationReadPath,publicationReleaseMatches,checkedPublication,publicationWriteAllowed,publicationCancellationAllowed,cloudPublicationRequest,createPublicationAttempt} from "./publication-selection";
import type {PublicationSelector} from "./publication-selection";
import {validServiceSourceBinding,serviceSourceKey,serviceSourceScope,serviceEvidencePath,returnedPublicationMatches,localAgentPublicationPath} from "./service-source-binding";
import type {ServiceSourceBinding} from "./service-source-binding";
import type {PublishedReportSource} from "./published-report-read";
const AgentReportPanel = lazy(async () => ({ default: (await import("./AgentReportPanel")).AgentReportPanel }));
const AgentBatchArchivePanel = lazy(async () => ({default:(await import("./AgentBatchArchivePanel")).AgentBatchArchivePanel}));
type Api = <T>(path: string, body?: unknown, options?: { idempotencyKey?: string }) => Promise<T>;
type FundPreflight = { protocol:string;scope:string;ready:boolean;digest:string;taskId:string;sourceRunId:string;revisionId:string;
  packageId:string;packageDigest:string;verificationId:string;businessDate:string;modelMode:string;reviewId:string;rehearsalDigest?:string;
  scheduleSpec:{triggerAfterSeconds:number;intervalSeconds:number;runCount:2} };
const complete = (status?: string) => ["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"].includes(status ?? "");
const batchLabels: Record<string,string> = { SCHEDULED: "等待调度", RUNNING: "正在运行", SUCCEEDED: "独立核验通过", FAILED: "运行或核验失败", CANCELLED: "已停止", INTERRUPTED: "已中断" };
function batchLabel(batch:Publication["runs"][number],reviewedPrivate:boolean) {
  if (batch.resultUnknown) return "执行中断，结果待核对";
  return (reviewedPrivate ? privateReleasePendingLabel(batch) : undefined) ?? batchLabels[batch.status] ?? batch.status;
}
function download(name: string, value: unknown) {
  const blob = new Blob([typeof value === "string" ? value : JSON.stringify(value, null, 2)], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob), link = document.createElement("a"); link.href = url; link.download = name; link.hidden = true;
  try { document.body.appendChild(link); link.click(); }
  finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); }
}
export function AgentDeliveryPanel({ api, taskId, contextId, revisionId, runId, dirty, canWrite, canPublish, publicationTarget, expectedSourceBinding,codeBusy, onOpenServices, handoffBlocked = false, manual = false, assisted = false, pinPreparation = false, fundPreparation }: { api: Api; taskId: string; contextId?:string; revisionId?: string; runId?: string; dirty: boolean; canWrite: boolean; canPublish?: boolean; publicationTarget?: PublicationTarget; expectedSourceBinding?:ServiceSourceBinding; codeBusy: boolean; onOpenServices?: (source:ServiceSourceBinding) => void; handoffBlocked?: boolean; manual?: boolean;assisted?:boolean;pinPreparation?:boolean;fundPreparation?:FundExecutionBinding }) {
  const fund = fundPreparation !== undefined;
  const workflowSourceKey=JSON.stringify([taskId,manual,assisted,runId,revisionId,contextId,expectedSourceBinding,fundPreparation]);
  const [workflowRecord,setWorkflowRecord]=useState<{key:string;value:Workflow}>();
  const workflow=workflowRecord?.key===workflowSourceKey?workflowRecord.value:undefined;
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [auto, setAuto] = useState(false);
  const [unconfirmedPreparation,setUnconfirmedPreparation]=useState<string>(),preparationFlight=useRef(false);
  const preparationUnknown=unconfirmedPreparation===workflowSourceKey;
  const [review, setReview] = useState(false), [confirmed, setConfirmed] = useState<Record<string,boolean>>({}), [release, setRelease] = useState<Release>(), [batches, setBatches] = useState<Publication["runs"]>([]);
  const [fundPreflight, setFundPreflight] = useState<FundPreflight>();
  const [cloudPreflight, setCloudPreflight] = useState<{key:string;value:CloudPublicationPreflight}>();
  const [publication,setPublication]=useState<Publication>();
  const [publicationClock,setPublicationClock]=useState(Date.now);
  const [publicationRead, setPublicationRead] = useState<EvidenceReadState>("LOADING");
  const [publicationReadKey,setPublicationReadKey]=useState("");
  const [publicationError, setPublicationError] = useState("");
  const publicationReader = useRef<ReturnType<typeof createPublicationReader<Publication>> | undefined>(undefined);
  const activePublicationKey=useRef(""),publicationReaderKey=useRef(""),pinnedReleases=useRef(new Map<string,string>());
  const publicationAttempts=useRef(new Map<string,ReturnType<typeof createPublicationAttempt>>());
  const acceptPublication = (value: Publication,key=activePublicationKey.current) => { setPublication(value); setRelease(value.release); setBatches(value.runs); setPublicationReadKey(key);setPublicationRead("READY"); setPublicationError(""); };
  const acceptPublicationWrite = (value: Publication,key=activePublicationKey.current,selector?:PublicationSelector) => {
    if(!alive.current||activePublicationKey.current!==key)return;
    checkedAgentPublication(value,{taskId,scope:cloud?"PRIVATE_CLOUD_TEST":"LOCAL_TEST_RELEASE",selector,releaseId:pinnedReleases.current.get(key)});
    if(value.release)pinnedReleases.current.set(key,value.release.id);
    publicationAttempts.current.get(key)?.readback(Boolean(value.release));
    publicationReader.current?.invalidate(); acceptPublication(value,key);
  };
  const refreshPublication = () => { if (!publicationReader.current||publicationReaderKey.current!==activePublicationKey.current) return Promise.resolve(); setPublicationRead("LOADING"); return publicationReader.current.refresh(); };
  const [consumption,setConsumption]=useState<TaskConsumption>(),[consumptionError,setConsumptionError]=useState("");
  const [consumptionRead,setConsumptionRead]=useState<EvidenceReadState>("LOADING");
  const [evidenceRecord,setEvidenceRecord]=useState<{key:string;state:EvidenceReadState;error?:string}>();
  const evidenceRead=evidenceRecord?.key===workflowSourceKey?evidenceRecord.state:"LOADING";
  const evidenceError=evidenceRecord?.key===workflowSourceKey?evidenceRecord.error??"":"";
  const consumptionEpoch=useRef(0),workflowEpoch=useRef(0);
  const activeConsumptionSource=useRef("");
  const epoch = useRef(0), alive = useRef(true), requestKey = useRef(crypto.randomUUID());
  const activeTask = useRef(taskId); activeTask.current = taskId;
  const activeWorkflowSource=useRef(workflowSourceKey);activeWorkflowSource.current=workflowSourceKey;
  const load = async () => {
    const id = taskId, sequence=++workflowEpoch.current;
    const active = () => alive.current && activeTask.current === id && activeWorkflowSource.current===workflowSourceKey && sequence === workflowEpoch.current;
    setEvidenceRecord({key:workflowSourceKey,state:"LOADING"});
    try {
      let original: Delivery | undefined;
      if (pinPreparation && preparationUnknown) {
        try { original=await api<Delivery>(`/agent/tasks/${id}/delivery-requests/${requestKey.current}`); }
        catch (cause) { if ((cause as {status?:number}).status !== 404) throw cause; }
        if (!active()) return;
      }
      const raw = await api<unknown>(manual ? `/runs/${runId}/workflow` : `/agent/tasks/${id}/workflow`);
      if(!active())return;
      const value=await checkedAgentWorkflow(raw,{taskId,contextId,revisionId,runId,manual,assisted,expectedSourceBinding,fundPreparation});
      if (!active()) return;
      if (original && (!original.id || value.delivery?.id !== original.id || original.sourceRevisionId !== revisionId || original.sourceRunId !== runId))
        throw Error("原交付请求已登记，当前读取的版本或批次与原交付不同。请先核对原任务来源。");
      setWorkflowRecord({key:workflowSourceKey,value});setEvidenceRecord({key:workflowSourceKey,state:"READY"});
      if(preparationUnknown)setError("");
      setUnconfirmedPreparation(old=>old===workflowSourceKey?undefined:old);
      return value;
    } catch (e) {
      if (active()) setEvidenceRecord({key:workflowSourceKey,state:"ERROR",error:(e as Error).message});
      throw e;
    }
  };
  const readConsumption=async(value=workflow)=>{
    const id=taskId,digest=value?.package?.digest,sequence=++consumptionEpoch.current,binding=serviceHandoff,key=serviceSourceKey(binding);
    if(!binding||digest!==binding.packageDigest||!["PRIVATE_CLOUD_TEST","LOCAL_TEST_RELEASE"].includes(value?.publication.scope??""))return;
    setConsumptionRead("LOADING");setConsumptionError("");
    try{
      const source=(value?.package?.manifest as {source?:{outputContract?:{id:string;metadataHash:string};fundLookthrough?:{contractId:string};attribution?:{modelMode:string}}})?.source;
      if(fund&&(!source?.fundLookthrough||!source.attribution?.modelMode))throw Error("基金交付包缺少确切消费口径");
      const expectedFund=fund&&source?.fundLookthrough&&source.attribution?{id:source.fundLookthrough.contractId,modelMode:source.attribution.modelMode}:undefined;
      const result=checkedAgentConsumption(await api<unknown>(serviceEvidencePath(binding)),binding,batches,source?.outputContract,expectedFund);
      if(alive.current&&activeTask.current===id&&activeConsumptionSource.current===key&&sequence===consumptionEpoch.current){setConsumption(result);setConsumptionRead("READY");setConsumptionError("");}
    }catch(e){if(alive.current&&activeTask.current===id&&activeConsumptionSource.current===key&&sequence===consumptionEpoch.current){setConsumptionRead("ERROR");setConsumptionError(`消费对照尚未确认：${(e as Error).message}。不会新增调用或凭证。`);}}
  };
  useEffect(() => { alive.current = true; return () => { alive.current = false; epoch.current++; }; }, []);
  useEffect(() => { if (!codeBusy) void load().catch(() => {}); }, [workflowSourceKey, codeBusy]);
  const report = workflow?.report, delivery = workflow?.delivery;
  const fundReview=workflow?.verification?.fundReview;
  const rehearsalDigest=fundReview?.status==="READY"?fundReview.digest:undefined;
  const fileReview=!fundReview||rehearsalDigest&&workflow?.fileReview?.fundRehearsalDigest===rehearsalDigest
    ? workflow?.fileReview : undefined;
  const activeFileReview=useRef(fileReview?.id);
  activeFileReview.current=fileReview?.id;
  const cloud = workflow?.publication.scope === "PRIVATE_CLOUD_TEST";
  const exactCloudReview = cloud && pinPreparation;
  // A retained, successfully read workflow may still select read-only history
  // while refreshing; write gates continue to require fresh READY evidence.
  const selected=publicationSelector({taskId,manual,runId,revisionId,contextId},workflow,Boolean(workflow));
  const selector = fund ? (selected && workflow?.verification?.status === "SUCCEEDED" ? { ...selected, sourceRunId: runId } : undefined)
    : selected && exactCloudReview ? {...selected,sourceRunId:runId} : selected;
  const publicationKey=selector?publicationSelectionKey(taskId,selector)+(expectedSourceBinding?`:${expectedSourceBinding.releaseId}`:""):!fund&&!manual&&workflow&&!cloud?`local:${workflowSourceKey}:${expectedSourceBinding?.releaseId??""}`:"";
  activePublicationKey.current=publicationKey;
  const publicationReady=Boolean(publicationKey)&&publicationReadKey===publicationKey&&publicationRead==="READY";
  const journey = agentJourney({ taskId, contextId, fund, revisionId, runId, dirty, evidenceReadable: evidenceRead === "READY", publicationReadable: publicationReady, report, delivery, bundle: workflow?.package, verification: workflow?.verification, release, batches, alerts: publication?.alerts, events: publication?.events, consumption:consumptionRead==="READY"?consumption:undefined });
  const current = journey.current;
  const firstBatch = batches.find(batch => batch.sequence === 1);
  const secondBatch = batches.find(batch => batch.sequence === 2);
  const monitorHref = cloud && !manual && publicationReady && journey.publicationCurrent &&
    release?.reviewDigest && revisionId && batches.length === 2 && firstBatch && secondBatch
    ? "/v2/?" + new URLSearchParams({module:"ops",taskId,releaseId:release.id,revisionId,
      firstBatchId:firstBatch.id,secondBatchId:secondBatch.id}) + "#ops-exact-publication"
    : undefined;
  const verified = journey.steps.find(step => step.id === "validation")?.state === "DONE";
  const canPrepare = verified && (!pinPreparation || Boolean(workflow?.preparationSource));
  const reportView = verificationPresentation(current, verified, evidenceRead, report?.status);
  const releaseLabel = (value: Release) => publicationEvidenceText(value, journey.publicationCurrent, journey.steps.some(step => step.id === "monitoring" && step.state === "DONE"));
  const working = busy || auto || codeBusy;
  const receiptPending = fund && delivery?.status === "INTERRUPTED" && delivery.stage === "FILE_REHEARSAL_UNCONFIRMED";
  const workerResult=current?workflow?.verification?.workerResult:undefined;
  const fileVerified = journey.fileVerified;
  const targetMatches = publicationTargetMatches(publicationTarget, { taskId, packageDigest: workflow?.package?.digest, verificationId: workflow?.verification?.id }, publicationClock)
    && (!publicationTarget || delivery?.verificationId === publicationTarget.verificationId);
  const publicationWritable = (!exactCloudReview || Boolean(publicationTarget)) && publicationWriteAllowed({manual,canPublish,canWrite,cloud,hasSelector:Boolean(selector),targetMatches});
  const reviewedCloud = cloudPreflight?.key === publicationKey ? cloudPreflight.value : undefined;
  const activeReview=useRef({key:publicationKey,allowed:publicationWritable&&publicationReady&&verified&&fileVerified&&!preparationUnknown});
  activeReview.current={key:publicationKey,allowed:publicationWritable&&publicationReady&&verified&&fileVerified&&!preparationUnknown};
  const publicationUnknown=publicationAttempts.current.get(publicationKey)?.snapshot().status==="UNKNOWN";
  const cancellationInput={taskId,selector,release,publicationKey,confirmedReadKey:publicationReadKey,pinnedReleaseId:pinnedReleases.current.get(publicationKey),dirty,working,
    canPublish:publicationWritable&&(!publicationTarget||Boolean(release&&publicationTargetMatches(publicationTarget,
      {taskId:release.sourceAgentTaskId??"",packageDigest:release.packageDigest,verificationId:release.verificationId},publicationClock)))};
  const cancellationWritable=publicationCancellationAllowed(cancellationInput);
  const handoffCandidate:ServiceSourceBinding|undefined=publicationReady&&journey.publicationCurrent&&release&&workflow?.package&&["PRIVATE_CLOUD_TEST","LOCAL_TEST_RELEASE"].includes(workflow.publication.scope)&&
    (!fund||journey.steps.some(step=>step.id==="monitoring"&&step.state==="DONE"))&&
    (!cloud||selector&&publicationReleaseMatches(release,taskId,selector))?{taskId,packageDigest:workflow.package.digest,releaseId:release.id,sourceKind:manual?"MANUAL":"AGENT",scope:cloud?"PRIVATE_CLOUD_TEST":"LOCAL_TEST_ONLY",revisionId,runId}:undefined;
  const serviceHandoff=validServiceSourceBinding(handoffCandidate)?handoffCandidate:undefined,serviceHandoffKey=serviceSourceKey(serviceHandoff);
  const reportBatchIds=batches.filter(batch=>batch.status==="SUCCEEDED"&&batch.schedulerTriggered===true).map(batch=>batch.id);
  const reportSource:PublishedReportSource|undefined=!cloud&&publicationReady&&journey.publicationCurrent&&release&&workflow?.package&&revisionId&&runId&&
    (fund?reportBatchIds.length===2:reportBatchIds.length>0)?
    {kind:manual?"MANUAL":"AGENT",releaseId:release.id,packageDigest:workflow.package.digest,revisionId,runId,...(manual?{}:{taskId}),batchIds:reportBatchIds}:undefined;
  const archiveChoices = cloud && !manual && !assisted && serviceHandoff && !distributionMetadataForContext(contextId) &&
    release?.sourceKind === "AGENT" && release.sourceAgentTaskId === taskId && release.sourceRunId === runId && revisionId && runId
    ? batches.filter(batch => reportBatchIds.includes(batch.id)).map(batch => ({
      sequence:batch.sequence,
      source:{kind:"AGENT" as const, taskId, releaseId:release.id, packageDigest:serviceHandoff.packageDigest, revisionId, runId, batchId:batch.id},
    })) : [];
  const archiveReopen = !manual && !assisted && typeof window !== "undefined" && window.location.hash === "#agent-report-archives";
  const showConsumption=Boolean(consumption&&serviceHandoff&&consumption.taskId===serviceHandoff.taskId&&consumption.packageDigest===serviceHandoff.packageDigest&&consumption.releaseId===serviceHandoff.releaseId&&consumption.scope===serviceSourceScope(serviceHandoff));
  activeConsumptionSource.current=serviceHandoffKey;
  useEffect(() => {
    if (!publicationTarget) return;
    setPublicationClock(Date.now());
    const timer=setInterval(()=>setPublicationClock(Date.now()),1000);
    return()=>clearInterval(timer);
  },[publicationTarget?.taskId,publicationTarget?.packageDigest,publicationTarget?.verificationId,publicationTarget?.startsAt,publicationTarget?.expiresAt]);
  useEffect(() => { if (!publicationWritable || preparationUnknown) { setReview(false);setConfirmed({}); } }, [publicationWritable,preparationUnknown]);
  useEffect(() => { if (!canWrite || publicationTarget) { epoch.current++;setAuto(false); } }, [canWrite,publicationTarget?.taskId]);
  useEffect(()=>{setConsumption(undefined);setConsumptionError("");setConsumptionRead("LOADING");void readConsumption();return()=>{consumptionEpoch.current++;};},[serviceHandoffKey,cloud]);
  useEffect(() => { setReview(false); setConfirmed({});setFundPreflight(undefined);setCloudPreflight(undefined); }, [publicationKey,workflow?.package?.digest, workflow?.verification?.id, fileReview?.id, rehearsalDigest, dirty, current, publicationRead]);
  useEffect(() => { requestKey.current = crypto.randomUUID(); }, [taskId, revisionId, runId]);
  async function drive(start: Delivery, snapshot = workflow) {
    if (!canWrite || publicationTarget) return;
    if(preparationUnknown)return;
    const token = ++epoch.current; setAuto(true); setError(""); let item = start;
    try {
      for (let i = 0; i < 40 && alive.current && activeWorkflowSource.current===workflowSourceKey && token === epoch.current && !complete(item.status); i++) {
        const pinned = item.sourcePinned || item.rehearsalPinned;
        const next = item.mode === "DURABLE_AGENT_DELIVERY_V1" ? await api<Delivery>(`/agent/deliveries/${item.id}/advance`, exactDeliveryAdvance(snapshot,item)) : await api<Delivery>(`/agent/deliveries/${item.id}`);
        if (!alive.current || activeWorkflowSource.current!==workflowSourceKey || token !== epoch.current) break;
        snapshot = await load();
        if (pinned) {
          if (snapshot?.delivery?.id !== item.id) throw Error("当前交付或批次已变化，请重新读取原记录。");
          item = snapshot.delivery;
        } else item = next;
        if (!complete(item.status)) await new Promise(r => setTimeout(r, 5000));
      }
    } catch (e) { if (token === epoch.current) setError((e as Error).message + " 记录已保留，请刷新核对后继续同一交付。"); }
    finally { if (token === epoch.current) setAuto(false); }
  }
  async function prepare() {
    if (!canPrepare || !canWrite || publicationTarget || working || preparationUnknown || preparationFlight.current) return;
    const source=workflowSourceKey,current=()=>alive.current&&activeWorkflowSource.current===source;preparationFlight.current=true;setBusy(true);setError("");
    try {
      const body = pinPreparation ? {expectedSource:workflow?.preparationSource} : {};
      const started = await api<Delivery>(manual ? `/runs/${runId}/prepare-delivery` : `/agent/tasks/${taskId}/prepare-delivery`, body, { idempotencyKey: requestKey.current });
      if (!current()) return;
      const value=await load();
      if (!value || !current()) return;
      if (pinPreparation) {
        const saved=value.delivery;
        if (!saved || saved.id !== started.id || saved.sourceRevisionId !== revisionId || saved.sourceRunId !== runId)
          throw Error("交付回执与已核验版本或批次不同，请核对原请求。");
        void drive(saved,value);
      } else void drive(started,value);
    }
    catch (e) { if(current()){setUnconfirmedPreparation(source);setError((e as Error).message+" 请先查询原交付，来源与原请求编号保留，不会自动重提。");} } finally { preparationFlight.current=false;if(current())setBusy(false); }
  }
  async function stop() {
    if (!delivery || !canWrite || publicationTarget) return; epoch.current++; setAuto(false); setBusy(true);
    try { await api(`/agent/deliveries/${delivery.id}/cancel`, {}); await load(); }
    catch(e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function recheckReceipt() {
    if (!delivery || !receiptPending || !canWrite || !current || evidenceRead !== "READY" || working || publicationTarget) return;
    const active = () => alive.current && activeWorkflowSource.current === workflowSourceKey;
    setBusy(true); setError("");
    try {
      const result = await recheckFundRehearsal({ request: (path: string, options: {body: unknown}) => api(path, options.body) }, {
        deliveryTaskId: delivery.id, expectedVersion: delivery.version,
      });
      if (!active()) return;
      if (result.packageDigest !== delivery.packageDigest || result.verificationId !== delivery.verificationId)
        throw Error("核对结果与原交付版本不符");
      await load();
      if (active() && result.status === "UNCONFIRMED") setError("本次核对后，原演练结果仍待确认。");
    } catch (cause) {
      if (!active()) return;
      const updated = await load().catch(() => undefined);
      if (active() && (updated?.delivery?.id !== delivery.id || updated.delivery.status !== "SUCCEEDED"))
        setError((cause as Error).message);
    } finally { if (active()) setBusy(false); }
  }
  async function openReview() {
    if (!publicationWritable || !publicationReady || !fileVerified || preparationUnknown || working) return;
    if (exactCloudReview && selector && workflow) {
      const key=publicationKey;
      setBusy(true);setError("");setReview(false);setConfirmed({});setCloudPreflight(undefined);
      try {
        const value=await checkedCloudPublicationPreflight(await api(publicationPreflightPath(taskId,selector)),workflow);
        if (alive.current && activeReview.current.key===key && activeReview.current.allowed) {
          setCloudPreflight({key,value});setReview(true);
        }
      } catch (cause) { if (alive.current && activePublicationKey.current===key) setError((cause as Error).message); }
      finally { if (alive.current) setBusy(false); }
      return;
    }
    if (!fund) { setReview(true); return; }
    if (!selector || !workflow?.package || !fileReview) return;
    const key = publicationKey;
    setBusy(true); setError("");
    try {
      const response = await api<FundPreflight>(publicationReadPath(taskId,selector).replace("/publication?", "/publication/preflight?"));
      if (!alive.current || activePublicationKey.current !== key || activeFileReview.current!==fileReview.id) return;
      if (response.protocol !== "shuduo-fund-agent-publication-preflight/v1" || response.scope !== "LOCAL_TEST_RELEASE" ||
          response.ready !== true || response.taskId !== taskId || response.revisionId !== revisionId ||
          response.sourceRunId !== runId || response.packageId !== workflow.package.id || response.packageDigest !== selector.packageDigest ||
          response.verificationId !== selector.verificationId || response.reviewId !== fileReview.id ||
          response.rehearsalDigest !== rehearsalDigest ||
          !/^[a-f0-9]{64}$/.test(response.digest) || !/^\d{4}-\d{2}-\d{2}$/.test(response.businessDate) ||
          !["LIVE_MODEL","SYNTHETIC_MODEL"].includes(response.modelMode) || response.scheduleSpec?.triggerAfterSeconds !== 5 ||
          response.scheduleSpec.intervalSeconds !== 30 || response.scheduleSpec.runCount !== 2)
        throw Error("基金发布预检与当前已审阅版本不一致");
      setFundPreflight(response); setReview(true);
    } catch (e) {
      if (alive.current && activePublicationKey.current === key) setError((e as Error).message);
    } finally { if (alive.current) setBusy(false); }
  }
  async function publishLocal() {
    if (!publicationWritable || working || preparationUnknown || !publicationReady || !workflow?.package || !delivery?.verificationId || !verified || !fileVerified || !workflow.publication.available || fund&&(!fundPreflight||fundPreflight.reviewId!==fileReview?.id||fundPreflight.rehearsalDigest!==rehearsalDigest) || !reviewAttestationsComplete(confirmed, cloud,fund||Boolean(distributionMetadataForContext(contextId)))) return;
    setBusy(true); setError("");
    const bundle = workflow.package,writeKey=publicationKey;
    try {
      if(cloud){
        if(!selector)throw Error("请先确认当前交付包、人工来源及文件演练，不能发布其他历史版本。");
        const key=publicationKey;
        if (exactCloudReview) {
          if (!reviewedCloud || !publicationTarget || !publicationTargetMatches(publicationTarget,{taskId,packageDigest:bundle.digest,verificationId:selector.verificationId}))
            throw Error("本次发布窗口或审阅依据已变化，请重新审阅。");
          const fresh=await checkedCloudPublicationPreflight(await api(publicationPreflightPath(taskId,selector)),workflow);
          if (!alive.current || activeReview.current.key!==key || !activeReview.current.allowed) return;
          if (fresh.reviewDigest!==reviewedCloud.reviewDigest) throw Error("发布依据已变化，原勾选已清除。请重新审阅。");
        }
        const request=cloudPublicationRequest(selector,bundle.id,confirmed,exactCloudReview?reviewedCloud?.reviewDigest:undefined);
        let attempt=publicationAttempts.current.get(key);
        if (attempt && exactCloudReview && attempt.request().body.reviewDigest!==request.body.reviewDigest) {
          if (attempt.snapshot().status!=="UNKNOWN" || !attempt.snapshot().readChecked) throw Error("请先查询原发布请求。");
          attempt=undefined;
        }
        if(!attempt){attempt=createPublicationAttempt(request);publicationAttempts.current.set(key,attempt);}
        const revisionHash=workflow.report.revisionHash;
        if (exactCloudReview && reviewedCloud && revisionId && runId && revisionHash) {
          const releaseId=await attempt.submit(async frozen=>checkedExactPublicationReceipt(await api(`/agent/tasks/${taskId}/publication`,frozen.body,{idempotencyKey:frozen.idempotencyKey}),
            {taskId,revisionId,revisionHash,runId,packageId:bundle.id,packageDigest:bundle.digest,verificationId:selector.verificationId,reviewDigest:reviewedCloud.reviewDigest}),true);
          pinnedReleases.current.set(key,releaseId);
          if(alive.current&&activePublicationKey.current===key){setReview(false);publicationReader.current?.invalidate();await refreshPublication();}
          return;
        }
        if (exactCloudReview) throw Error("确切审阅来源尚未核对。");
        const result=await attempt.submit(async frozen=>checkedPublication(await api<Publication>(`/agent/tasks/${taskId}/publication`,frozen.body,{idempotencyKey:frozen.idempotencyKey}),taskId,selector,pinnedReleases.current.get(key),true),true);
        acceptPublicationWrite(result,key,selector);if(activePublicationKey.current===key)setReview(false);return;
      }
      const reviewed = fundPreflight ? { id: fundPreflight.reviewId } : await api<{ id: string }>(`/delivery/packages/${bundle.id}/review`, { packageDigest: bundle.digest, verificationId: delivery.verificationId, reviewNote: "工程师已在Agent工作台审阅代码、核验、交付文件和测试发布范围。", attestations: confirmed });
      const metadata=distributionMetadataForContext(contextId),source=(bundle.manifest as {source?:{outputContract?:{id:string;metadataHash:string}}}).source;
      if(metadata&&(!source?.outputContract||source.outputContract.id!==metadata.id||!/^[a-f0-9]{64}$/.test(source.outputContract.metadataHash)))throw Error('分布契约未确认，请刷新原交付包');
      const distributionConsent=metadata?{scope:'LOCAL_TEST_RELEASE',packageDigest:bundle.digest,verificationId:delivery.verificationId,metadataHash:source!.outputContract!.metadataHash,scheduleSpec:{triggerAfterSeconds:5,intervalSeconds:30,runCount:2},confirmFrozenFictionalData:true}:undefined;
      const fundConsent = fundPreflight ? { scope: fundPreflight.scope, packageDigest: bundle.digest, verificationId: delivery.verificationId,
        businessDate: fundPreflight.businessDate, scheduleSpec: fundPreflight.scheduleSpec, preflightDigest: fundPreflight.digest,
        confirmFrozenFictionalData: true } : undefined;
      const approved = await api<{ id: string }>(`/delivery/packages/${bundle.id}/approve`, { packageDigest: bundle.digest, reviewId: reviewed.id,...(distributionConsent?{distributionConsent}:{}),...(fundConsent?{fundConsent}:{}) },{idempotencyKey:`agent-workbench-approval-${bundle.id}`});
      await api<Release>("/releases", { approvalId: approved.id, ...(fundConsent?.scheduleSpec ?? { triggerAfterSeconds: 5, intervalSeconds: 30, runCount: 2 }) }, { idempotencyKey: `agent-workbench-release-${bundle.id}` });
      publicationReader.current?.invalidate(); setReview(false); await refreshPublication();
    } catch(e) { if(alive.current&&activePublicationKey.current===writeKey){setReview(false);setConfirmed({});setError((e as Error).message + " 只查询当前包的原发布记录；不会自动重发。明确重试仍复用原请求编号和审阅内容，不重新创建批准。"); publicationReader.current?.invalidate(); await refreshPublication();} } finally { if(alive.current)setBusy(false); }
  }
  useEffect(() => {
    const key=publicationKey;
    setPublication(undefined);setRelease(undefined);setBatches([]);setPublicationError("");
    if(!key){setPublicationReadKey("");setPublicationRead("READY");return;}
    setPublicationRead("LOADING");
    const reader = createPublicationReader<Publication>({
      read: async () => {
        let pinned=pinnedReleases.current.get(key)??expectedSourceBinding?.releaseId;
        const attempt=publicationAttempts.current.get(key), request=attempt?.request();
        const reviewDigest=request?.body.reviewDigest, packageId=workflow?.package?.id, revisionHash=workflow?.report.revisionHash;
        if (exactCloudReview && attempt?.snapshot().status==="UNKNOWN" && request && reviewDigest && selector && revisionId && runId && revisionHash && packageId) {
          try {
            const value=await api(publicationRequestReceiptPath(taskId,request.idempotencyKey));
            const originalReleaseId=checkedExactPublicationReceipt(value,{taskId,revisionId,revisionHash,runId,packageId,packageDigest:selector.packageDigest,verificationId:selector.verificationId,reviewDigest});
            if(pinned&&originalReleaseId!==pinned)throw Error("原发布编号与当前记录不同。");
            pinned=originalReleaseId;
          } catch(cause) { if((cause as {status?:number}).status!==404)throw cause; }
        }
        const value=checkedAgentPublication(await api<unknown>(selector?publicationReadPath(taskId,selector,pinned):expectedSourceBinding?.scope==="LOCAL_TEST_ONLY"?localAgentPublicationPath(expectedSourceBinding):`/agent/tasks/${taskId}/publication`),{taskId,scope:cloud?"PRIVATE_CLOUD_TEST":"LOCAL_TEST_RELEASE",selector,releaseId:pinned});
        if (exactCloudReview && reviewDigest && value.release && value.release.reviewDigest!==reviewDigest) throw Error("发布记录的审阅摘要与原请求不同。");
        if(expectedSourceBinding&&!returnedPublicationMatches(expectedSourceBinding,value))throw Error("发布回执不是返程绑定的原版本；未采用同任务的最新发布。可打开当前任务另行查看。");
        return value;
      },
      onValue:value=>{
        if(!alive.current||activePublicationKey.current!==key)return;
        if(value.release)pinnedReleases.current.set(key,value.release.id);
        publicationAttempts.current.get(key)?.readback(Boolean(value.release));
        acceptPublication(value,key);
      },onError:e=>{if(alive.current&&activePublicationKey.current===key){setPublicationRead("ERROR");setPublicationError((e as Error).message);}}
    });
    publicationReader.current = reader;publicationReaderKey.current=key; void reader.refresh();
    return () => { reader.close(); if (publicationReader.current === reader){publicationReader.current = undefined;publicationReaderKey.current="";} };
  }, [publicationKey]);
  useEffect(() => {
    if (!publication || !publicationReady || publication.readMode === "SAVED_HISTORY" || !publicationPollNeeded(publication)) return;
    const timer = setInterval(() => { void publicationReader.current?.refresh(); }, cloud ? 10000 : 5000);
    return () => clearInterval(timer);
  }, [publication, publicationReady, cloud]);
  return <section id="agent-delivery" className="agent-delivery-panel" aria-label="核验与发布交付">
    <header><div><ShieldCheck size={17} /><strong>从开发到交付</strong></div><button className="icon-button" aria-label="刷新核验与交付" disabled={working || evidenceRead === "LOADING"} onClick={async()=>{try{await readConsumption(await load());}catch{/* load preserves the read error without losing evidence */}}}><RefreshCw size={14} /></button></header>
    {report?.developmentReference&&<AssistedDevelopmentReference value={report.developmentReference}/>}
    {fund && <p className="agent-dev-notice">交付绑定已保存的基金口径和原代码版本。演练通过后可审阅八个文件。</p>}
    {manual && <p className="agent-dev-notice" role="status">{assisted?'人工辅助修正交付':'工程师接管交付'} · 当前报告、交付包及演练均绑定此版本。原开发与参考记录保留，不计作自主完成；发布需要独立审阅。</p>}
    {evidenceRead !== "READY" && <div className="agent-dev-notice" role={evidenceRead === "ERROR" ? "alert" : "status"}><div><strong>{reportView.title}</strong><p>{reportView.detail}</p>{evidenceError && <small>{evidenceError}</small>}</div>{evidenceRead === "ERROR" && <button className="button" disabled={working} onClick={() => void load().catch(() => {})}>重新读取核验记录</button>}</div>}
    <div className="agent-journey-summary"><div><span className="eyebrow">TASK JOURNEY · {taskId.slice(0,8)}</span><h3>{evidenceRead !== "READY" ? "先确认核验记录" : journey.next.id === "evidence" ? "本任务测试范围内的证据已齐" : `下一步：${journey.next.label}`}</h3><p>{evidenceRead !== "READY" ? "保留原任务与交付文件；不因读取失败重新计算或创建任务。" : journey.next.detail}</p></div>{evidenceRead === "READY" && <a className="button" href={`#${journey.next.target}`}>{journey.next.id === "evidence" ? "查看消费证据" : "查看下一步"}</a>}</div>
    <ol className="agent-workflow-steps agent-journey-steps" aria-label="完整任务链路">{journey.steps.map((step,index) => <li key={step.id} className={step.state.toLowerCase()}><a href={`#${step.target}`}>{step.state === "DONE" ? <CheckCircle2 size={15} /> : <Circle size={15} />}<span>{index+1}. {step.label}</span><strong>{({DONE:"证据通过",PENDING:"待完成",ATTENTION:"需要处理",STALE:"修改后待核验"})[step.state]}</strong></a><small>{step.detail}</small></li>)}</ol>
    <small>这是当前任务的证据导航，不是自主E2E评分；私有测试发布不等于公网或生产上线。</small>
    {error && <p className="agent-dev-alert error" role="alert">{error}</p>}
    {!workflow ? <p className="agent-dev-empty">{evidenceRead === "ERROR" ? "核验记录未读取成功；无需重新创建任务。" : "正在读取版本、核验和交付记录…"}</p> : <>
      <div id="agent-verification" className="agent-verification-card"><div className="agent-workflow-title"><FileText size={16} /><h3>结果核验报告</h3><span className={verified ? "passed" : ""}>{reportView.title}</span></div>
        <p>{reportView.detail}</p>{current && <p>{report?.summary}</p>}
        <ul>{report?.checks.map(check => <li key={check.id}>{reportView.currentChecks && check.passed ? <CheckCircle2 size={14} /> : <Circle size={14} />}<span>{check.label}</span><strong>{!reportView.currentChecks ? "历史记录" : check.passed ? "通过" : "待核验"}</strong></li>)}</ul>
        <small>{report?.rowCount}{fund||distributionMetadataForContext(contextId)?"个分组":"位客户"} · {report?.engine} {report?.engineVersion} · {report?.notice}</small>
        {fund?<p>基金敞口按组合、交易日与资产类别独立核验。</p>:distributionMetadataForContext(contextId)?<p>分布结果按复合键、金额及六位占比核验；失败明细见代码校验页，旧客户级差异表不适用。</p>:(<ValidationDetails details={evidenceRead==="READY"?report?.validationDetails:{schema:"shuduo-validation-details/v1",status:"UNVERIFIED"}} expectedSource={{runId:report?.runId,revisionId:report?.revisionId,contextId:report?.contextId,revisionHash:report?.revisionHash,contractId:report?.validationContractId}} dirty={dirty} historical={!current} />)}
        <button className="button" onClick={() => download("verification-report.json", report)}><Download size={14} />下载核验报告</button>
      </div>
      <div id="agent-files" className="agent-delivery-card"><div className="agent-workflow-title"><Package size={16} /><h3>调度与部署交付</h3></div><p>把当前通过核验的代码、测试、调度依赖、交易日历和部署清单固定到同一版本，再用 Spark 按文件执行一次演练。</p>
        {preparationUnknown&&<p role="status">交付准备结果待确认。<button className="button" disabled={working||evidenceRead==='LOADING'} onClick={()=>void load().catch(()=>{})}>查询原交付</button>查询只恢复原版本记录；确认前不能重新准备。</p>}
        {pinPreparation && verified && !workflow.preparationSource && !delivery && <p role="status">当前版本的交付来源待核对。请刷新原任务和运行，再准备交付。</p>}
        {!delivery && <button className="button primary" disabled={!canWrite || !canPrepare || working || preparationUnknown} onClick={() => void prepare()}><Play size={14} />生成交付并演练</button>}
        {delivery && <><strong className="agent-delivery-stage">{auto && <LoaderCircle size={14} className="spin" />}{workerResult==="PENDING"?"原演练结果待核对":workerResult==="CONFIRMED"?"演练失败已确认":fileReview&&!release?(current&&verified&&fileVerified&&evidenceRead==="READY"?"本机文件已审阅，不代表发布批准":"保留的文件审阅，当前待核验"):deliveryStageText(delivery.stage, journey.publicationCurrent, release?.status, journey.current)}</strong>{delivery.error && <p role="alert">{delivery.error}</p>}
          {workerResult && <p role="status">{workerResult==="CONFIRMED"
            ? "已核对原 Worker 回执。" : "原 Worker 回执待核对，原演练编号和预留保留。"}</p>}
          <div className="agent-delivery-actions">
            {workerResult && <button className="button" disabled={working || evidenceRead!=="READY"}
              onClick={() => void load().catch(()=>{})}>重新读取原演练</button>}
            {receiptPending && <button className="button" disabled={!canWrite || !current || evidenceRead !== "READY" || working || !!publicationTarget}
              onClick={() => void recheckReceipt()}>核对原演练回执</button>}
            {!complete(delivery.status) && <><button className="button primary" disabled={!canWrite || !verified || working || preparationUnknown || workerResult==="PENDING"} onClick={() => void drive(delivery)}>继续交付准备</button><button className="button" disabled={!canWrite || busy} onClick={() => void stop()}><Square size={13} />停止</button></>}
            {!fund && ["FAILED","CANCELLED"].includes(delivery.status) && <button className="button" disabled={!canWrite || !canPrepare || working || preparationUnknown || workerResult==="PENDING"} onClick={() => { if(preparationUnknown)return;requestKey.current=crypto.randomUUID(); void prepare(); }}>重新准备并演练</button>}
            {workflow.package && <button className="button" onClick={() => download("shuduo-delivery-package.json", workflow.package)}><Download size={14} />下载版本化交付包</button>}
          </div></>}
        {workflow.package && (()=>{const frozen=frozenRequirementProposal(workflow.package,taskId);return frozen&&<AgentRequirementUnderstanding frozen dirty={!current} task={{id:taskId,contextId:frozen.contextId,message:frozen.request,revisionId:frozen.revisionId,language:'SPARK_SQL',requirements:frozen,
          clarification:frozen.clarification,humanClarified:frozen.humanClarified,directAutonomousEligible:frozen.directAutonomousEligible,clarificationOriginTaskId:frozen.clarificationOriginTaskId,
          attempts:[{attempt:frozen.attempt,revisionId:frozen.revisionId,model:frozen.model}]}}/>;})()}
        {workflow.package && <DeliveryFilePreview key={workflow.package.digest} bundle={workflow.package} current={current} onDownload={download} />}
        {workflow.verification && <><p className={fileVerified ? "passed" : ""}>文件演练：{fileVerified ? (fund?"主 SQL、测试 SQL 与登记基金断言通过":"主SQL、测试SQL与五场景回归全部通过") : workflow.verification.status} · {workflow.verification.engine} {workflow.verification.engineVersion}</p>
          <dl className="delivery-review-source" aria-label="交付演练来源"><dt>文件演练编号</dt><dd>{workflow.verification.id}</dd><dt>源代码版本</dt><dd>{delivery?.sourceRevisionId ?? "未确认"}</dd><dt>源运行批次</dt><dd>{delivery?.sourceRunId ?? "未确认"}</dd></dl>
          <small>以上编号属于当前读取的交付演练，不代表已经批准或发布；未开放发布时仍可核对来源。</small>
          <button className="button" onClick={() => download(`delivery-evidence-${workflow.package?.id.slice(0,8) ?? taskId.slice(0,8)}.json`, { schema: "shuduo-delivery-evidence/v1", report: workflow.report, delivery: workflow.delivery, package: workflow.package ? { id: workflow.package.id, digest: workflow.package.digest, manifest: workflow.package.manifest } : undefined, verification: workflow.verification, publication: workflow.publication, exportedAt: new Date().toISOString() })}><Download size={14} />下载演练证据</button></>}
      </div>
      {(fund||distributionMetadataForContext(contextId))&&workflow.package&&workflow.verification?.status==='SUCCEEDED'&&<LocalDistributionReview fund={fund} key={JSON.stringify([taskId,workflow.package.digest,workflow.verification.id,rehearsalDigest])} api={api} packageId={workflow.package.id} packageDigest={workflow.package.digest} verificationId={workflow.verification.id} review={fileReview} fundReview={fundReview} staleReview={Boolean(workflow.fileReview&&!fileReview)} current={current&&verified&&fileVerified&&evidenceRead==="READY"} enabled={canWrite&&verified&&fileVerified&&current&&evidenceRead==="READY"&&!working&&!preparationUnknown} onRefresh={load}/>}
      <div id="agent-publication" className="agent-publication-card"><div className="agent-workflow-title"><ShieldCheck size={16} /><h3>审阅发布与运行监控</h3></div><p>{!workflow.publication.available && release ? "发布记录已保留；临时调度入口已关闭，不会继续启动批次。新发布需按预算和权限重新启用。" : workflow.publication.reason}</p>{release && !journey.publicationCurrent && <p role="status">这是保留的发布记录，尚未核对为当前编辑版本的上线证据。</p>}
        {publicationTarget && <p role="status">{publicationWritable ? "本任务、包摘要和演练编号与受邀发布范围一致。请逐项审阅，不会自动批准。" : "当前任务或版本不在有效发布范围内，或窗口已关闭；只保留查看，不发布或停止其他任务。"} 同一冻结业务日期的两个样例批次，不是两个交易日或生产调度；不修改原代码或重新演练文件。</p>}
        <div className="agent-delivery-actions"><button className="button" disabled={!publicationKey || working || publicationRead === "LOADING"} onClick={() => void refreshPublication()}><RefreshCw size={14} />刷新发布与监控</button><small>{publicationKey?"只读取当前来源、交付包和演练绑定的发布，不重新发布或运行计算。":"先确认当前交付包及文件演练，才能读取此版本的发布记录。"}</small></div>
        {manual&&<p role="status">发布来源：人工辅助（MANUAL／ENGINEER_ASSISTED）· 原开发及参考记录保留，此包和发布不计作 Agent 自主完成。</p>}
        {publicationUnknown&&<p role="status">原发布请求结果尚未确认。先刷新读取同一包的记录；如仍未找到，重新审阅后可按原请求编号重试，不会自动生成新的批准。</p>}
        {publicationKey && !publicationReady && <p role={publicationRead === "ERROR" ? "alert" : "status"}>{publicationRead === "ERROR" ? `发布与监控读取未确认：${publicationError}。已读取的历史记录保留，暂不能判断当前健康或再次发布。` : "正在恢复当前来源与确切交付包的发布、批次与告警记录…"}</p>}
        {fund && !fileReview && fileVerified && <p>请先记录此包的本机文件审阅。</p>}
        {publicationReady && publication?.readMode === "SAVED_HISTORY" && release && <p role="status">已保存的发布与运维记录 · 当前仅回看。</p>}
        {publicationReady && !release && !fund && <p>{publication?.readMode === "SAVED_HISTORY"
          ? "当前交付与演练暂无发布记录。" : "当前来源、交付包与演练尚未找到发布记录；需逐项审阅确切版本，发布后仍等待受控调度器执行。"}</p>}
        {workflow.publication.available && (!release || !journey.publicationCurrent) && <button className="button primary" disabled={!publicationWritable || preparationUnknown || !fileVerified || !verified || working || !publicationReady || fund&&!fileReview} onClick={() => void openReview()}>{publicationUnknown?"重新审阅并重试原发布请求":"审阅并发布测试任务"}</button>}
        {!fund && !workflow.publication.available && !release && <span className="agent-publication-gate">交付演练通过后进入“待发布”；云端上线尚待完成。</span>}
        {review && workflow.package && (!exactCloudReview || reviewedCloud) && <AgentPublicationReview cloud={cloud} preflight={reviewedCloud} fund={fundPreflight} distribution={fund||Boolean(distributionMetadataForContext(contextId))} sourceKind={manual?"MANUAL":"AGENT"} originTaskId={taskId} packageDigest={workflow.package.digest} revisionId={delivery?.sourceRevisionId} runId={delivery?.sourceRunId} verificationId={delivery?.verificationId} confirmed={confirmed} disabled={!publicationWritable || working || !publicationReady || !verified || !fileVerified || !workflow.publication.available} onConfirm={(id, checked) => setConfirmed(old => ({...old, [id]:checked}))} onPublish={() => void publishLocal()} onCancel={() => { setReview(false); setConfirmed({}); }} />}
        {release && <>
          <strong>发布版本 {release.id.slice(0,8)} · {publicationReady ? releaseLabel(release) : "上次读取的记录 · 当前状态未确认"}</strong>
          <p className="agent-publication-id">发布编号：{release.id}</p>
          {fund&&<small>本机测试 · {release.modelMode==="SYNTHETIC_MODEL"?"模型替身":"模型生成"}</small>}
          {monitorHref && <a className="button" href={monitorHref}>在运维监控查看原批次</a>}
          {archiveChoices.length > 0 && <a className="button" href="#agent-report-archives">在此任务查看报表归档</a>}
          <ul>{batches.map(batch => <li key={batch.id}>第{batch.sequence}批 · {batchLabel(batch,cloud && Boolean(release.reviewDigest))} · {batch.schedulerTriggered ? "调度器已触发" : batch.status === "CANCELLED" ? "未再触发" : "等待计划时间"}<small>批次编号：{batch.id}</small></li>)}</ul>
          {publication?.alerts.map(alert => <p key={alert.id} role={alert.status === "OPEN" ? "alert" : undefined}>{alert.status === "OPEN" ? "未解除告警" : "已恢复"}：{alert.message}{alert.recoveryRunId ? ` · 恢复批次 ${alert.recoveryRunId.slice(0,8)}` : ""}</p>)}
          {cloud&&cancellationWritable&&!publicationReady&&<p role="status">监控读取尚未确认；原发布来源和编号已核对，仍可停止这个已确认版本的后续批次。</p>}
          {cloud && release.status !== "CANCELLED" && batches.some(batch => !complete(batch.status)) && <button className="button" disabled={!cancellationWritable} onClick={async () => {
            if (!publicationCancellationAllowed(cancellationInput)||!selector) return;
            const key=publicationKey,selectedReleaseId=release.id;
            setBusy(true);
            try { const value=checkedPublication(await api<Publication>(`/agent/tasks/${taskId}/publication/cancel`,{...selector,releaseId:selectedReleaseId}),taskId,selector,selectedReleaseId);acceptPublicationWrite(value,key,selector); }
            catch(e) { if(alive.current&&activePublicationKey.current===key){setError((e as Error).message); publicationReader.current?.invalidate(); await refreshPublication();} }
            finally { if(alive.current)setBusy(false); }
          }}><Square size={14}/>停止后续云端批次</button>}
          {!cloud&&distributionMetadataForContext(contextId)&&<LocalDistributionControls key={release.id} api={api} release={release} targets={publication?.rollbackTargets??[]} canWrite={Boolean(canPublish)} ready={publicationReady||pinnedReleases.current.get(publicationKey)===release.id} canRollback={publicationReady&&current&&!dirty&&!handoffBlocked} onRefresh={refreshPublication}/>}
          {publication?.historyRunCount? <p>另保留 {publication.historyRunCount} 个历史批次，不计本次恢复窗口的通过数。</p>:null}
          {publication && <button className="button" onClick={() => download(`publication-${release.id.slice(0,8)}.json`,{...publication, readState:publicationRead, notice:"已读取的测试范围记录，不代表实时健康或公网验收"})}><Download size={14}/>下载发布与监控记录</button>}
        </>}
      </div>
      {reportSource&&<Suspense fallback={<p role="status">正在加载同源报表视图…</p>}><AgentReportPanel api={api} source={reportSource}
        fund={fund} canCreate={canWrite&&!dirty&&!working&&!handoffBlocked&&!publicationTarget&&(!fund||release?.health==="HEALTHY"&&release.status==="ACTIVE_LOCAL")}/></Suspense>}
    </>}
    {(archiveChoices.length > 0 || archiveReopen) && <Suspense fallback={<p role="status">正在加载原批次归档…</p>}>
      <AgentBatchArchivePanel api={api} taskId={taskId} choices={archiveChoices}/>
    </Suspense>}
    {workflow && <div id="agent-service-handoff" className="agent-publication-card"><div className="agent-workflow-title"><Package size={16}/><h3>发布结果 → DAPI / XAPI</h3></div><p>继续同一个任务、交付包和发布版本的接口开发、测试与授权。选择实际成功发布批次后核对返回值和调用日志；打开模块不会自动创建凭证或调用接口。</p>
        {fund&&<p>基金接口使用同一批次的组合敞口。授权调用按固定版本和独立基金预期核对。</p>}
        {distributionMetadataForContext(contextId)&&<p role="status">分布按客户＋交易日＋分类独立核对，保留完整分类数组。上游模型归因保留，本机旅程通过不计真实模型完整自主E2E。</p>}
        {manual&&<p role="status">人工发布结果消费 · 保留开发历史及人工辅助归因，不计为 Agent 自主完成。</p>}
        {!serviceHandoff&&<p role="status">请先核对当前包的确切发布记录；未确认来源时不跳转到全项目或原 Agent 的其他结果。</p>}
        {consumptionError&&<p role="status">{consumptionError}</p>}
        {showConsumption&&consumptionRead!=="READY"&&<p role="status">本次消费读取尚未确认；下方保留上次核对的历史记录，不计作本次消费阶段通过。</p>}
        {journey.steps.find(step=>step.id==="services")?.state==="DONE"&&<p role="status">{fund?"同一批次的基金 DAPI 与 XAPI 授权调用均通过独立对照。":"组合接口的消费证据已通过。DAPI的单独授权调用记录独立展示，不影响已通过的XAPI组合查询。"}</p>}
        {showConsumption&&consumption&&<><p>{consumption.notice}</p><small>对照时间：{consumption.checkedAt}；这是历史消费记录，不是实时授权保证。</small>{!current&&<p>编辑器或当前查看的批次已变化；下面证据仅供原版本参考。</p>}<ul>{consumption.services.map(s=><li key={s.serviceId}><strong>{s.serviceType} · {s.name}</strong> · 版本 {s.versionId.slice(0,8)} · {s.status==="VERIFIED"?"历史消费证据对照通过":s.status==="NEEDS_ATTENTION"?"需要处理":"待实际授权调用"}<p>{s.notice}</p>{consumption.outputContractId&&s.source&&<small>{(s.source.modelClassification==="SYNTHETIC_UPSTREAM"||s.source.modelMode==="SYNTHETIC_MODEL")?"模型响应：测试替身":"模型真实性待独立验证"} · {(s.source.engineClassification==="LOCAL_SPARK_RECEIPTS"||s.source.engineClassification==="LOCAL_SPARK_PROCESS")?"本机Spark执行证据":"执行器：测试替身"}</small>}{s.call&&<small>调用 {s.call.callId.slice(0,8)} · {s.call.rowCount}{consumption.outputContractId&&s.serviceType==="XAPI"?(fund?"个组合日期组":"个客户日期组"):"行"} · 摘要 {s.call.resultHash.slice(0,12)} · {applicationStatusText(s.call.applicationStatus,true)}{fund&&s.checkedCalls?.length?` · 共核对 ${s.checkedCalls.length} 条历史调用`:""}</small>}{cloud&&!manual&&consumptionRead==="READY"&&s.status==="VERIFIED"&&s.call&&s.sourceRunIds.length===1&&serviceHandoff&&
          <AgentCallHistoryLink key={s.call.callId} taskId={taskId} release={serviceHandoff.releaseId} packageDigest={serviceHandoff.packageDigest} batch={s.sourceRunIds[0]} callId={s.call.callId}/>}</li>)}</ul>{consumption.truncated&&<p>证据数量超过本次上限，不能标记整个消费阶段完成。</p>}<EvidenceDownload name={`consumption-${taskId.slice(0,8)}.json`} value={consumption} request={{kind:"consumption",id:taskId,digest:consumption.packageDigest,releaseId:consumption.releaseId}}>下载当前发布的消费对照证据</EvidenceDownload></>}
        {workflow.package&&<button className="button" disabled={working||!serviceHandoff} onClick={()=>void readConsumption()}>刷新消费证据</button>}
        {onOpenServices ? <><button className="button" disabled={!serviceHandoff || dirty || working || handoffBlocked} onClick={()=>{if(serviceHandoff&&!dirty&&!working&&!handoffBlocked)onOpenServices(serviceHandoff);}}>继续此任务的接口交付</button>{handoffBlocked && <small>修改需求尚未发送，请先处理输入再切换；不会丢弃你的文字。</small>}</> : <small>当前环境尚未开放服务接管；已有交付记录保留。</small>}</div>}
  </section>;
}
