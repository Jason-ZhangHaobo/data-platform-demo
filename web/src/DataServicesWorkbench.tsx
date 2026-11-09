import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
const ServiceContractGatesPanel=lazy(async()=>({default:(await import('./ServiceContractGatesPanel')).ServiceContractGatesPanel}));
import { EvidenceDownload, requestTextDownload } from "./EvidenceDownload";
import { compositionChoices } from "./service-composition";
import { applicationStatusText, consumptionApplicationInput, consumptionDapiInput, consumptionPlanAvailable, consumptionServices, consumptionWindowOpen, consumptionXapiInput, serviceApplicationStatus } from "./service-consumption-scope";
import type { ConsumptionScope } from "./service-consumption-scope";
import {validServiceSourceBinding,serviceSourceKey,sourceBindingEnvironmentMatches,serviceSourcesPath,serviceReturnLocation,serviceReadCurrent,sourceRunMatches,sourceRunEligible,sourceBoundServices,sourceBoundCalls,sourceBoundSwitches,sourceBindingScopeCompatible,defaultBoundSourceRun} from "./service-source-binding";
import type {ServiceSourceBinding} from "./service-source-binding";
import {validServicePlanSource,sourcePlanReceiptValid,boundServicePlansPath,servicePlanMarker,servicePlanLocation,createServicePlanSubmission,servicePlanRecoverySource,readPrivateServiceAgentContext} from "./service-plan-source";
import type {ServicePlanSource,SourcePlan,ServiceAgentContext} from './service-plan-source';
import {PrivateServiceAgentStudio} from './PrivateServiceAgentStudio';
import type {ServicePlanningAccess} from './private-service-plan';
import {
  Activity,
  AppWindow,
  Bot,
  Braces,
  CheckCircle2,
  ChevronRight,
  CircleAlert,
  Clock3,
  CodeXml,
  KeyRound,
  Layers3,
  LoaderCircle,
  Network,
  Play,
  Rocket,
  Send,
  ShieldCheck,
} from "lucide-react";

type Api = <T>(path: string, body?: unknown, options?: {idempotencyKey?:string}) => Promise<T>;
type ReleaseRun = {
  id: string;
  releaseId: string;
  sequence?:number;
  status: string;
  published: boolean;
  schedulerTriggered: boolean;
  engine?: string;
  engineVersion?: string;
  rows?: Record<string, string | number>[];
  validation?: { passed: boolean };
  mainSqlExecuted?: boolean;
  testSqlValidation?: { passed: boolean };
  codeExecuted?: boolean;
  createdAt: string;
  sourceAgentTaskId?: string;
  packageDigest?: string;
  sourceKind?:string;sourceAttribution?:string;agentIndependentE2E?:boolean;
  scope?:string;
  sourceRevisionId?:string;sourceRunId?:string;
};
type ServiceVersion = {
  id: string;
  versionNumber: number;
  status: string;
  configHash: string;
  sourcePackageDigest?: string;
  sourceReleaseRunId?: string;
  sourceEngine?: string;
  sourceEngineVersion?: string;
  snapshotHash?: string;
  fields?: string[];
  steps?: { alias: string; dapiId: string; dapiVersionId: string }[];
  timeoutMs: number;
  rateLimitPerMinute: number;
};
type DataService = {
  id: string;
  name: string;
  slug: string;
  serviceType: "DAPI" | "XAPI";
  status: string;
  pilotId?: string;
  endpoint?: string;
  currentVersion?: ServiceVersion;
  publishedVersion?: ServiceVersion;
  versions: ServiceVersion[];
};
type Application = {
  id: string;
  name: string;
  status: string;
  serviceIds: string[];
  tokenPrefix: string;
  scope: string;
  pilotId?: string;
  expiresAt?: string;
};
type ServiceCall = {
  id: string;
  serviceId: string;
  serviceVersionId?:string;
  serviceType: string;
  versionNumber: number;
  applicationId: string;
  outcome: string;
  statusCode: number;
  rowCount: number;
  durationMs: number;
  createdAt: string;
};
type TestReceipt = {
  test: {
    id: string;
    status: string;
    rowCount: number;
    resultHash: string;
    durationMs: number;
    versionId: string;
    configHash: string;
  };
  response: {
    data: Record<string, unknown>[];
    pagination: { total: number };
  };
};
type VersionSwitchReceipt = {id:string;fromVersionId:string;toVersionId:string;targetConfigHash:string;createdAt:string};
type VersionReview = {serviceId:string;type:"DAPI"|"XAPI";versionId:string;configHash:string;expectedPublishedVersionId:string;targetNumber:number;liveNumber:number;accepted:boolean};
type RecoveryReport = {
  bootId: string; healthy: boolean; fingerprint: string; checkedAt: string;
  state: { serviceId: string; calls: unknown[]; applications: {id:string;status:string}[];
    evidence: {verified:boolean;code?:string;snapshot?:{actualRowCount:number;integrityVerified:boolean}|null}[] };
};
type ServiceAgentPlan = SourcePlan & {
  id: string;
  message: string;
  status: string;
  proposal?: {
    serviceType: "DAPI" | "XAPI";
    name: string;
    slug: string;
    fields?: string[];
    steps?: { alias: string; dapiId: string; dapiVersionId: string }[];
    sourceReleaseRunId?: string;
    timeoutMs: number;
    rateLimitPerMinute: number;
  };
  explanation?: string;
  error?: string;
  serviceId?: string;
};

const fieldProfiles = {
  holdings: ["client_id", "holding_market_value", "security_count"],
  cash: ["client_id", "available_cash", "total_assets"],
  full: [
    "client_id",
    "holding_market_value",
    "available_cash",
    "total_assets",
    "security_count",
  ],
};
const fieldScopeNotice = "结果字段含义继承所选发布口径，不当然等于客户全资产；选择全部字段不会补入原口径之外的资产。";
const labels: Record<string, string> = {
  DRAFT: "草稿",
  PUBLISHED: "已发布",
  RETIRED: "历史版本",
  SUCCEEDED: "成功",
  RATE_LIMITED: "已限流",
  TIMED_OUT: "已超时",
  FAILED: "失败",
};
const planLabels:Record<string,string>={QUEUED:'待规划',RUNNING:'规划中',SUCCEEDED:'方案待确认',APPLIED:'草稿已创建',FAILED:'规划失败',CANCELLED:'已取消',INTERRUPTED:'待恢复'};
const flowSteps: {
  Icon: typeof CodeXml;
  number: string;
  title: string;
  description: string;
}[] = [
  { Icon: CodeXml, number: "01", title: "开发", description: "绑定真实发布结果" },
  { Icon: Play, number: "02", title: "测试", description: "执行参数化查询" },
  { Icon: Rocket, number: "03", title: "发布", description: "锁定不可变版本" },
  { Icon: Activity, number: "04", title: "消费", description: "授权、限流与日志" },
];

export function DataServicesWorkbench({
  api:rawApi,
  canWrite: originalCanWrite,
  privateCloud = false,
  cloudAccess = "private-preview",
  sourceAgentTaskId,
  consumptionScope,
  sourceBinding,
  sourceBindingError,
  runtimeMode,
  sourceBoundAgentPlansEnabled=false,
  sourceBoundAgentContextEnabled=false,
  modelConfigured=false,
  durableServiceAgentEnabled=false,
  durableServiceAgentReadEnabled=false,
  servicePlanningTransport=false,
  servicePlanningOnly=false,
  servicePlanning,
}: {
  api: Api;
  canWrite: boolean;
  privateCloud?: boolean;
  cloudAccess?: "private-preview" | "invited";
  sourceAgentTaskId?: string;
  consumptionScope?: ConsumptionScope;
  sourceBinding?:ServiceSourceBinding;
  sourceBindingError?:string;
  runtimeMode?:"LOCAL_DEVELOPMENT"|"PUBLIC_INVITATION";
  sourceBoundAgentPlansEnabled?:boolean;
  sourceBoundAgentContextEnabled?:boolean;
  modelConfigured?:boolean;
  durableServiceAgentEnabled?:boolean;
  durableServiceAgentReadEnabled?:boolean;
  servicePlanningTransport?:boolean;
  servicePlanningOnly?:boolean;
  servicePlanning?:ServicePlanningAccess;
}) {
  const scopePlan=consumptionPlanAvailable(consumptionScope)?consumptionScope.plan:undefined;
  const bindingDeclared=sourceBinding!==undefined||Boolean(sourceBindingError),binding=validServiceSourceBinding(sourceBinding)?sourceBinding:undefined;
  const bindingError=sourceBindingError||(bindingDeclared&&!binding?"接口交接来源不完整；不会退回全项目数据。":binding&&!sourceBindingEnvironmentMatches(binding,privateCloud,runtimeMode)?"交接范围与当前运行环境不一致；保留只读，不切换本机／云端来源。":binding&&!sourceBindingScopeCompatible(binding,consumptionScope)?"交接来源与当前最小消费计划冲突；不扩大计划或切换到其他包。":"");
  const scopeKey=JSON.stringify([consumptionScope??null,sourceAgentTaskId??null,serviceSourceKey(binding),bindingError]);
  const savedPlanMarker=typeof window==='undefined'?{invalid:false as const,requestId:undefined,planId:undefined,batchId:undefined}:servicePlanMarker(window.location.href);
  const boundPlannerAllowed=sourceBoundAgentPlansEnabled&&runtimeMode==='LOCAL_DEVELOPMENT'&&!privateCloud&&!consumptionScope&&binding?.scope==='LOCAL_TEST_ONLY'&&binding.sourceKind==='AGENT'&&!bindingError;
  const privateContextAllowed=sourceBoundAgentContextEnabled&&privateCloud&&runtimeMode!=='LOCAL_DEVELOPMENT'&&binding?.scope!=='LOCAL_TEST_ONLY'&&Boolean(binding)&&!bindingError;
  const privateStudioVisible=durableServiceAgentReadEnabled&&privateCloud&&Boolean(binding)&&!bindingError&&!consumptionScope;
  const sourceContext=useRef(scopeKey);sourceContext.current=scopeKey;
  const sourceRequest=useRef(0),alive=useRef(true);
  const [sourceRead,setSourceRead]=useState<{key:string;state:"LOADING"|"READY"|"ERROR";message?:string;loginRequired?:boolean}>({key:"",state:"LOADING"});
  const dataReady=sourceRead.key===scopeKey&&sourceRead.state==="READY";
  const readFailed=sourceRead.key===scopeKey&&sourceRead.state==="ERROR";
  async function api<T>(path:string,body?:unknown,options?:{idempotencyKey?:string}):Promise<T>{const key=scopeKey;const result=await rawApi<T>(path,body,options);if(!alive.current||sourceContext.current!==key)throw Error("来源已切换，旧响应未用于当前工作区。");return result;}
  const [scopeClock,setScopeClock]=useState(Date.now);
  const canWrite=originalCanWrite&&!servicePlanningOnly&&(!consumptionScope||privateCloud&&consumptionWindowOpen(consumptionScope,scopeClock))&&
    (!bindingDeclared||Boolean(binding&&!bindingError&&sourceRead.key===scopeKey&&sourceRead.state==="READY"));
  const cloudScopeLabel = cloudAccess === "invited" ? "受邀云测试范围" : "私有云测试范围";
  const [releaseRuns, setReleaseRuns] = useState<ReleaseRun[]>([]),
    [dapis, setDapis] = useState<DataService[]>([]),
    [xapis, setXapis] = useState<DataService[]>([]),
    [applications, setApplications] = useState<Application[]>([]),
    [calls, setCalls] = useState<ServiceCall[]>([]),
    [agentPlans, setAgentPlans] = useState<ServiceAgentPlan[]>([]);
  const [selectedId, setSelectedId] = useState(""),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [plannedDapiIndex,setPlannedDapiIndex]=useState(0);
  const [dapiName, setDapiName] = useState(scopePlan?.dapis[0]?.name??"客户持仓查询"),
    [dapiSlug, setDapiSlug] = useState(scopePlan?.dapis[0]?.slug??(sourceAgentTaskId?`customer-holdings-${sourceAgentTaskId.slice(0,8)}`:"customer-holdings")),
    [profile, setProfile] = useState<keyof typeof fieldProfiles>("holdings"),
    [sourceRunId, setSourceRunId] = useState(scopePlan?.sourceReleaseRunId??((boundPlannerAllowed||privateContextAllowed)&&!savedPlanMarker.invalid?savedPlanMarker.batchId:undefined)??"");
  const [xapiName,setXapiName]=useState(scopePlan?.xapi.name??"财富顾问客户资产组合查询"),
    [xapiSlug,setXapiSlug]=useState(scopePlan?.xapi.slug??(sourceAgentTaskId?`advisor-assets-${sourceAgentTaskId.slice(0,8)}`:"advisor-asset-overview")),
    [holdingsVersionId,setHoldingsVersionId]=useState(""),[cashVersionId,setCashVersionId]=useState("");
  const [testReceipt, setTestReceipt] = useState<TestReceipt>(),
    [openApi, setOpenApi] = useState<Record<string, unknown>>(),
    [issuedToken, setIssuedToken] = useState("");
  const [tokenVisible,setTokenVisible]=useState(false),[issuedAppId,setIssuedAppId]=useState("");
  const [recoveryReport,setRecoveryReport]=useState<RecoveryReport>();
  const [showVersionEditor,setShowVersionEditor]=useState(false),[versionProfile,setVersionProfile]=useState<keyof typeof fieldProfiles>("full"),[versionRate,setVersionRate]=useState("60"),[versionTimeout,setVersionTimeout]=useState("1500");
  const [versionReview,setVersionReview]=useState<VersionReview>(),[switchHistory,setSwitchHistory]=useState<VersionSwitchReceipt[]>([]);
  const activeServiceRef=useRef(selectedId);activeServiceRef.current=selectedId;
  const [agentMessage, setAgentMessage] = useState(
      "基于已发布的持仓与现金DAPI，规划一个财富顾问客户资产组合XAPI",
    ),
    [agentPlan, setAgentPlan] = useState<ServiceAgentPlan>();
  const [pendingPlanKey,setPendingPlanKey]=useState<string|undefined>(()=>boundPlannerAllowed&&!savedPlanMarker.invalid?savedPlanMarker.requestId:undefined),
    [planReadError,setPlanReadError]=useState('');
  const planSubmission=useRef<ReturnType<typeof createServicePlanSubmission<ServiceAgentPlan>>|undefined>(undefined);
  const [privateContextRead,setPrivateContextRead]=useState<{key:string;state:'LOADING'|'READY'|'ERROR';value?:ServiceAgentContext;error?:string}>();
  const services = useMemo(() => consumptionServices(binding?sourceBoundServices([...dapis,...xapis],binding,releaseRuns):bindingDeclared?[]:[...dapis, ...xapis],consumptionScope), [dapis, xapis, releaseRuns,scopeKey]),
    selected = services.find((item) => item.id === selectedId),
    eligibleRuns = (binding?releaseRuns.filter(run=>sourceRunMatches(run,binding)):bindingDeclared?[]:releaseRuns).filter(
      (run) =>
        run.status === "SUCCEEDED" &&
        run.published &&
        run.schedulerTriggered &&
        ((run.engine === "Apache Spark" &&
          run.mainSqlExecuted === true &&
          run.testSqlValidation?.passed === true) ||
          (run.engine === "CPython" && run.codeExecuted === true)) &&
        run.validation?.passed && (!consumptionScope || Boolean(scopePlan&&run.id===scopePlan.sourceReleaseRunId&&run.sourceAgentTaskId===scopePlan.taskId&&run.packageDigest===scopePlan.packageDigest)),
    ),
    visibleCalls=bindingDeclared?sourceBoundCalls(calls,services):calls,
    callsForSelected = selected
      ? visibleCalls.filter((item) => item.serviceId === selected.id)
      : visibleCalls.filter(item=>!consumptionScope&&!bindingDeclared||services.some(s=>s.id===item.serviceId));
  const scopedDapis=services.filter(s=>s.serviceType==="DAPI"),scopedXapis=services.filter(s=>s.serviceType==="XAPI");
  const visibleApplications=bindingDeclared?applications.filter(a=>a.serviceIds.length>0&&a.serviceIds.every(id=>services.some(s=>s.id===id))):applications;
  const scopedApplications=consumptionScope?visibleApplications.filter(a=>scopePlan&&a.pilotId===consumptionScope.pilotId&&a.name===scopePlan.applicationName&&a.serviceIds.length>0&&a.serviceIds.every(id=>services.some(s=>s.id===id))):visibleApplications;
  const plannedDapi=scopePlan?.dapis[plannedDapiIndex];
  const nextPlannedDapi=scopePlan?.dapis.findIndex(d=>!dapis.some(s=>s.slug===d.slug))??-1;
  const dapiAlreadyExists=Boolean(consumptionScope&&plannedDapi&&dapis.some(s=>s.slug===plannedDapi.slug));
  const xapiAlreadyExists=Boolean(consumptionScope&&scopePlan&&xapis.some(s=>s.slug===scopePlan.xapi.slug));
  const appAlreadyExists=Boolean(consumptionScope&&applications.some(a=>a.pilotId===consumptionScope.pilotId||scopePlan&&a.name===scopePlan.applicationName));
  const scopeConflict=Boolean(consumptionScope&&scopePlan&&[...dapis,...xapis].some(s=>[...scopePlan.dapis.map(d=>d.slug),scopePlan.xapi.slug].includes(s.slug)&&!services.some(allowed=>allowed.id===s.id)));
  let plannedXapiBody: ReturnType<typeof consumptionXapiInput> | undefined,plannedApplicationBody: ReturnType<typeof consumptionApplicationInput> | undefined;
  if(consumptionScope&&scopePlan){try{plannedXapiBody=consumptionXapiInput(consumptionScope,services);}catch{/* Wait for both approved DAPI versions. */}try{plannedApplicationBody=consumptionApplicationInput(consumptionScope,services);}catch{/* Wait for the approved three-service set. */}}
  const composition=compositionChoices(scopedDapis,{privateCloud,sourceRunId,holdingsVersionId,cashVersionId});
  const currentPublished=Boolean(selected?.currentVersion && selected.currentVersion.id===selected.publishedVersion?.id);
  const versionContext=`${scopeKey}:${selectedId}:${selected?.currentVersion?.id??""}`;
  const activeVersionRef=useRef(versionContext);activeVersionRef.current=versionContext;
  const planSourceCandidate=binding?{taskId:binding.taskId,packageDigest:binding.packageDigest,releaseId:binding.releaseId,sourceReleaseRunId:sourceRunId}:undefined;
  const boundPlanSource=boundPlannerAllowed&&validServicePlanSource(planSourceCandidate)&&eligibleRuns.some(run=>run.id===sourceRunId)?planSourceCandidate:undefined;
  const privateContextSource=privateContextAllowed&&validServicePlanSource(planSourceCandidate)&&sourceRead.key===scopeKey&&sourceRead.state==='READY'&&eligibleRuns.some(run=>run.id===sourceRunId)?planSourceCandidate:undefined;
  const privateContextKey=JSON.stringify([scopeKey,privateContextSource??null]),privateContextRef=useRef(privateContextKey);privateContextRef.current=privateContextKey;
  const privateContextState=privateContextRead?.key===privateContextKey?privateContextRead:undefined;
  const privateStudioSource=privateContextSource??servicePlanRecoverySource(binding,typeof window==='undefined'?undefined:window.location.href);
  async function inspectPrivateContext(){
    if(!privateContextSource||privateContextState?.state==='LOADING')return;
    const key=privateContextKey,source=privateContextSource;setPrivateContextRead({key,state:'LOADING'});
    try{const value=await readPrivateServiceAgentContext(api,source);if(alive.current&&privateContextRef.current===key){
      if(value.sourceKind!==binding?.sourceKind||binding?.sourceKind==='MANUAL'&&(value.releaseRuns[0].sourceRevisionId!==binding.revisionId||value.releaseRuns[0].sourceRunId!==binding.runId))throw Error('上下文来源类型或人工版本不一致，未采用该回执。');
      history.replaceState(null,'',servicePlanLocation(location.href,{batchId:source.sourceReleaseRunId}));
      setPrivateContextRead({key,state:'READY',value});}}
    catch(cause){if(alive.current&&privateContextRef.current===key)setPrivateContextRead({key,state:'ERROR',error:(cause as Error).message});}
  }
  const recoveryPlanSource=boundPlannerAllowed?servicePlanRecoverySource(binding,typeof window==='undefined'?undefined:window.location.href):undefined,readablePlanSource=boundPlanSource??recoveryPlanSource;
  const plannerKey=JSON.stringify([scopeKey,readablePlanSource??null]),activePlanner=useRef(plannerKey);activePlanner.current=plannerKey;
  const plannerCurrent=(key:string)=>alive.current&&activePlanner.current===key;
  function serviceSubmission(){
    if(!readablePlanSource)throw Error('原规划来源标识不完整');
    if(!planSubmission.current||planSubmission.current.snapshot().closed){
      const marker=servicePlanMarker(location.href),source=readablePlanSource;
      planSubmission.current=createServicePlanSubmission<ServiceAgentPlan>({api,initialKey:!marker.invalid?marker.requestId:undefined,onPending:key=>{
        setPendingPlanKey(key);if(key)history.replaceState(null,'',servicePlanLocation(location.href,{batchId:source.sourceReleaseRunId,requestId:key}));
      }});
    }
    return planSubmission.current;
  }
  function acceptSourcePlan(plan:ServiceAgentPlan,source:ServicePlanSource,key:string,requestId?:string){
    if(!plannerCurrent(key))return;
    if(!sourcePlanReceiptValid(plan,source)||requestId&&plan.requestId!==requestId)throw Error('原规划回执尚未确认，已保留来源和请求编号；未创建替代任务。');
    if(requestId)serviceSubmission().acknowledge(requestId);
    setPendingPlanKey(undefined);setPlanReadError(plan.sourceCheck==='UNAVAILABLE'?'原来源当前未通过复核；仅恢复原方案记录，可取消规划，不能应用或再生成。':'');setAgentPlan(plan);
    setAgentPlans(old=>[plan,...old.filter(item=>item.id!==plan.id)]);
    history.replaceState(null,'',servicePlanLocation(location.href,{batchId:source.sourceReleaseRunId,planId:plan.id}));
    if(plan.status==='APPLIED'&&plan.serviceId)setSelectedId(plan.serviceId);
  }
  async function readSourcePlan(id?:string,retry=false){
    if(!readablePlanSource||busy||retry&&(!boundPlanSource||!canWrite||!modelConfigured))return;const source=readablePlanSource,key=plannerKey;setBusy('agent-read');setError('');
    try{
      const request=servicePlanMarker(location.href),pending=!request.invalid?request.requestId:pendingPlanKey;
      const plan=id?await api<ServiceAgentPlan>('/data-services/agent/plans/'+id):pending?
        await (retry?serviceSubmission().retry():serviceSubmission().recover()):agentPlan?await api<ServiceAgentPlan>('/data-services/agent/plans/'+agentPlan.id):undefined;
      if(plan){acceptSourcePlan(plan,source,key,id?undefined:pending);if(plan.status==='APPLIED'&&plan.sourceCheck!=='UNAVAILABLE')await reload();}
    }catch(cause){if(plannerCurrent(key)){setPlanReadError((cause as Error).message);setError((cause as Error).message+' 原编号保留，不自动重新调用模型。');}}
    finally{if(plannerCurrent(key))setBusy('');}
  }
  const currentTestValid=Boolean(selected?.currentVersion && testReceipt?.test.status==="PASSED" && testReceipt.test.versionId===selected.currentVersion.id && testReceipt.test.configHash===selected.currentVersion.configHash);
  const requestKeys=useRef<Record<string,{signature:string;key:string}>>({});
  const keyFor=(action:string,body:unknown)=>{const signature=JSON.stringify(body),old=requestKeys.current[action];if(old?.signature===signature)return old.key;const key=crypto.randomUUID();requestKeys.current[action]={signature,key};return key;};

  const reload = async () => {
    const key=scopeKey,request=++sourceRequest.current;
    const current=()=>serviceReadCurrent(key,request,sourceContext.current,sourceRequest.current,alive.current);
    if(!alive.current)return;
    if(bindingError){setSourceRead({key,state:"ERROR",message:bindingError});return;}
    setSourceRead({key,state:"LOADING"});
    try{
    const [nextRuns, nextDapis, nextXapis, nextApps, nextCalls, nextPlans] =
      await Promise.all([
        api<ReleaseRun[]>(binding?serviceSourcesPath(binding):privateCloud ? "/data-services/sources" + (sourceAgentTaskId ? `?agent_task_id=${encodeURIComponent(sourceAgentTaskId)}` : "") : "/release/runs"),
        api<DataService[]>("/data-services/dapis"),
        api<DataService[]>("/data-services/xapis"),
        api<Application[]>("/data-services/applications"),
        api<ServiceCall[]>("/data-services/calls"),
        privateCloud || consumptionScope || bindingDeclared ? Promise.resolve([] as ServiceAgentPlan[]) : api<ServiceAgentPlan[]>("/data-services/agent/plans"),
      ]);
    if(!current())return;
    if(![nextRuns,nextDapis,nextXapis,nextApps,nextCalls,nextPlans].every(Array.isArray))throw Error("服务目录响应不完整；未确认服务、批次、应用或调用数量，请重新读取。");
    if(binding&&nextRuns.some(run=>!sourceRunMatches(run,binding)))throw Error("发布来源回读与交接包或版本不一致，未采用其他结果。");
    setReleaseRuns(nextRuns);
    setDapis(nextDapis);
    setXapis(nextXapis);
    setApplications(nextApps);
    setCalls(nextCalls);
    if(!bindingDeclared){setAgentPlans(nextPlans);if (!agentPlan && nextPlans[0]) setAgentPlan(nextPlans[0]);}
    const boundEligible=binding?nextRuns.filter(run=>sourceRunMatches(run,binding)&&sourceRunEligible(run)):nextRuns;
    if(binding&&(!boundEligible.length||!sourceBindingScopeCompatible(binding,consumptionScope,boundEligible))){
      setSourceRunId("");setSelectedId("");setSourceRead({key,state:"ERROR",message:boundEligible.length?"确切发布批次与当前最小消费计划冲突；未扩大来源。":"此确切发布尚无通过核验的可消费批次，或当前账号不可见。可重新读取；不会选其他发布或开发运行。"});return;
    }
    const marker=servicePlanMarker(location.href),requestedBatch=(boundPlannerAllowed||privateContextAllowed)&&!marker.invalid?marker.batchId:undefined;
    if(requestedBatch&&!boundEligible.some(run=>run.id===requestedBatch)){setSourceRunId('');setSourceRead({key,state:'ERROR',message:'原规划指定批次当前不可用，保留原记录，不采用其他批次。'});return;}
    if(scopePlan)setSourceRunId(scopePlan.sourceReleaseRunId);
    else if(binding)setSourceRunId(previous=>defaultBoundSourceRun(binding,nextRuns,[...nextDapis,...nextXapis],{currentRunId:previous||requestedBatch,selectedServiceId:activeServiceRef.current})??"");
    else if (!sourceRunId && nextRuns.find((run) => run.status === "SUCCEEDED"))
      setSourceRunId(nextRuns.find((run) => run.status === "SUCCEEDED")!.id);
    const nextServices=consumptionServices(binding?sourceBoundServices([...nextDapis,...nextXapis],binding,nextRuns):[...nextDapis,...nextXapis],consumptionScope);
    if (!selectedId && nextServices[0])setSelectedId(nextServices[0].id);
    else if((consumptionScope||bindingDeclared)&&selectedId&&!nextServices.some(s=>s.id===selectedId))setSelectedId("");
    setSourceRead({key,state:"READY"});
    }catch(cause){if(current()){const failure=cause as Error&{status?:number;code?:string};setSourceRead({key,state:"ERROR",message:failure.message,loginRequired:failure.status===401||failure.code==="AUTHENTICATION_REQUIRED"});}throw cause;}
  };
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;sourceRequest.current++;};},[]);
  useEffect(() => {
    const marker=servicePlanMarker(location.href);setSelectedId("");setSourceRunId(scopePlan?.sourceReleaseRunId??((boundPlannerAllowed||privateContextAllowed)&&!marker.invalid?marker.batchId:undefined)??"");setHoldingsVersionId("");setCashVersionId("");setTestReceipt(undefined);setIssuedToken("");setTokenVisible(false);setVersionReview(undefined);setRecoveryReport(undefined);setOpenApi(undefined);
    void reload().catch(()=>{});
  }, [scopeKey]);
  useEffect(()=>{if(!consumptionScope)return;setScopeClock(Date.now());const timer=setInterval(()=>setScopeClock(Date.now()),1000);return()=>clearInterval(timer);},[scopeKey]);
  useEffect(()=>{if(!canWrite){setIssuedToken("");setTokenVisible(false);}if(consumptionScope||servicePlanningOnly){setShowVersionEditor(false);setVersionReview(undefined);}},[canWrite,scopeKey,servicePlanningOnly]);
  useEffect(()=>{
    planSubmission.current?.close();planSubmission.current=undefined;
    if(!boundPlannerAllowed||!readablePlanSource)return;
    const key=plannerKey,source=readablePlanSource,marker=servicePlanMarker(location.href);let active=true;
    setAgentPlan(undefined);setAgentPlans([]);setPlanReadError('');
    const valid=()=>active&&plannerCurrent(key);
    if(marker.invalid){setPlanReadError('规划恢复链接不完整，未读取其他来源。');return;}
    if(marker.batchId&&marker.batchId!==source.sourceReleaseRunId){
      if(marker.requestId){setPendingPlanKey(marker.requestId);setPlanReadError('原规划请求属于另一成功批次；请沿原恢复链接核对，未切换来源。');return;}
      history.replaceState(null,'',servicePlanLocation(location.href,{batchId:source.sourceReleaseRunId}));
    }
    void(async()=>{
      try{
        let original:ServiceAgentPlan|undefined;
        if(marker.requestId){setPendingPlanKey(marker.requestId);original=await serviceSubmission().recover();if(valid())acceptSourcePlan(original,source,key,marker.requestId);}
        else if(marker.planId&&marker.batchId===source.sourceReleaseRunId){original=await api<ServiceAgentPlan>('/data-services/agent/plans/'+marker.planId);if(valid())acceptSourcePlan(original,source,key);}
        if(!valid()||original?.sourceCheck==='UNAVAILABLE')return;
        const plans=await api<ServiceAgentPlan[]>(boundServicePlansPath(source));if(!valid())return;
        if(!Array.isArray(plans)||plans.some(plan=>!sourcePlanReceiptValid(plan,source)))throw Error('同源方案记录回执不完整');setAgentPlans(plans);
      }catch(cause){if(valid())setPlanReadError((cause as Error).message+' 原来源和请求编号保留，未重新提交。');}
    })();
    return()=>{active=false;planSubmission.current?.close();planSubmission.current=undefined;};
  },[plannerKey,boundPlannerAllowed]);
  useEffect(() => {
    setTestReceipt(undefined);
    setOpenApi(undefined);
    setIssuedToken("");
    setTokenVisible(false);
    setRecoveryReport(undefined);
    setVersionReview(undefined);setShowVersionEditor(false);setSwitchHistory([]);
    if(selected?.currentVersion){setVersionRate(String(selected.currentVersion.rateLimitPerMinute));setVersionTimeout(String(selected.currentVersion.timeoutMs));setVersionProfile(selected.currentVersion.fields?.includes("holding_market_value") ? selected.currentVersion.fields.includes("available_cash")?"full":"holdings":"cash");}
  }, [selectedId, selected?.currentVersion?.id]);
  useEffect(() => {
    if (!agentPlan || !["QUEUED", "RUNNING"].includes(agentPlan.status)||boundPlannerAllowed&&Boolean(planReadError)) return;
    const key=plannerKey,source=readablePlanSource;
    const timer = setInterval(async () => {
      try {
        const latest = await api<ServiceAgentPlan>(
          `/data-services/agent/plans/${agentPlan.id}`,
        );
        if(boundPlannerAllowed){if(!plannerCurrent(key))return;if(!source||!sourcePlanReceiptValid(latest,source))throw Error('原规划状态回执未确认');}
        setAgentPlan(latest);
        if (!["QUEUED", "RUNNING"].includes(latest.status))
          {const plans=await api<ServiceAgentPlan[]>(source?boundServicePlansPath(source):'/data-services/agent/plans');if(!boundPlannerAllowed||plannerCurrent(key))setAgentPlans(plans);}
      } catch (cause) {
        if(boundPlannerAllowed&&!plannerCurrent(key))return;
        setError((cause as Error).message);
        if(boundPlannerAllowed){clearInterval(timer);setPlanReadError((cause as Error).message+' 查询已暂停，可手动读取原方案。');}
      }
    }, 1200);
    return () => clearInterval(timer);
  }, [agentPlan?.id, agentPlan?.status,plannerKey,planReadError]);

  const planWithAgent = async () => {
    if(!dataReady)return;
    if(boundPlannerAllowed){
      if(!canWrite||!boundPlanSource||!modelConfigured||busy||pendingPlanKey||planReadError||servicePlanMarker(location.href).invalid)return;
      const source=boundPlanSource,key=plannerKey;setBusy('agent');setError('');setPlanReadError('');setAgentPlan(undefined);
      try{
        const controller=serviceSubmission(),plan=await controller.submit({message:agentMessage.trim(),sourceBinding:source}),request=controller.snapshot().key;
        if(request)acceptSourcePlan(plan,source,key,request);
        if(plannerCurrent(key))setNotice('已按当前发布批次生成规划任务；方案通过后仍需确认草稿。');
      }catch(cause){if(plannerCurrent(key))setError((cause as Error).message+' 原规划编号和需求保留，请先查询，不会自动再调用模型。');}
      finally{if(plannerCurrent(key))setBusy('');}return;
    }
    if(!canWrite||consumptionScope||bindingDeclared)return;
    setBusy("agent");
    setError("");
    try {
      const plan = await api<ServiceAgentPlan>("/data-services/agent/plans", {
        message: agentMessage,
      });
      setAgentPlan(plan);
      setNotice("Data Agent已开始读取当前发布批次与DAPI版本");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy("");
    }
  };
  const cancelSourcePlan=async()=>{
    if(!boundPlannerAllowed||!readablePlanSource||!agentPlan||!sourcePlanReceiptValid(agentPlan,readablePlanSource)||!originalCanWrite||busy||pendingPlanKey)return;
    const key=plannerKey,source=readablePlanSource,id=agentPlan.id;setBusy('agent-cancel');setError('');
    try{const plan=await api<ServiceAgentPlan>('/data-services/agent/plans/'+id+'/cancel',{sourceBoundOnly:true});if(plannerCurrent(key)){acceptSourcePlan(plan,source,key);setNotice('已取消原规划；原来源与记录保留。');}}
    catch(cause){if(plannerCurrent(key))setError((cause as Error).message+' 可沿原方案编号确认取消结果。');}
    finally{if(plannerCurrent(key))setBusy('');}
  };
  const applyAgentPlan = async () => {
    if(!dataReady)return;
    if(boundPlannerAllowed){
      if(!canWrite||!boundPlanSource||!agentPlan||agentPlan.sourceCheck==='UNAVAILABLE'||!sourcePlanReceiptValid(agentPlan,boundPlanSource)||busy||pendingPlanKey)return;
      const source=boundPlanSource,key=plannerKey,planId=agentPlan.id;setBusy('agent-apply');setError('');
      try{
        const service=await api<DataService>('/data-services/agent/plans/'+planId+'/apply',{}),plan=await api<ServiceAgentPlan>('/data-services/agent/plans/'+planId);
        if(!plannerCurrent(key))return;
        if(!sourcePlanReceiptValid(plan,source)||plan.status!=='APPLIED'||plan.serviceId!==service.id||plan.appliedVersionId!==service.currentVersion?.id||plan.appliedConfigHash!==service.currentVersion?.configHash)
          throw Error('草稿回执尚未与原方案版本对应，请先查询原方案');
        acceptSourcePlan(plan,source,key);await reload();if(plannerCurrent(key)){setSelectedId(service.id);setNotice('已创建同源草稿；当前版本、测试、发布和授权仍可逐项审阅。');}
      }catch(cause){if(plannerCurrent(key))setError((cause as Error).message+' 原方案保留；可查询其状态，未另建规划或自动发布。');}
      finally{if(plannerCurrent(key))setBusy('');}return;
    }
    if (!agentPlan || !canWrite || consumptionScope || bindingDeclared) return;
    setBusy("agent-apply");
    setError("");
    try {
      const service = await api<DataService>(
        `/data-services/agent/plans/${agentPlan.id}/apply`,
        {},
      );
      await reload();
      setSelectedId(service.id);
      setAgentPlan(
        await api<ServiceAgentPlan>(
          `/data-services/agent/plans/${agentPlan.id}`,
        ),
      );
      setNotice("已按经过后端校验的Agent方案创建草稿，尚未测试或发布");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy("");
    }
  };

  const createDapi = async () => {
    if(!canWrite||!eligibleRuns.some(run=>run.id===sourceRunId)||dapiAlreadyExists)return;
    setBusy("create-dapi");
    setError("");
    try {
      const body=consumptionScope?consumptionDapiInput(consumptionScope,plannedDapiIndex):{
        name: dapiName,
        slug: dapiSlug,
        sourceReleaseRunId: sourceRunId,
        fields: fieldProfiles[profile],
        timeoutMs: 1500,
        rateLimitPerMinute: 60,
      };const created = await api<DataService>("/data-services/dapis",body,{idempotencyKey:keyFor("dapi",body)});
      await reload();
      setSelectedId(created.id);
      setNotice("DAPI草稿已绑定真实发布批次，请先执行查询测试");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy("");
    }
  };
  const createXapi = async () => {
    if(!canWrite||xapiAlreadyExists)return;
    setBusy("create-xapi");
    setError("");
    try {
      const {holdings,cash}=composition;
      if(!consumptionScope&&(!holdings||!cash))throw new Error("请先发布同一批次的持仓DAPI与现金DAPI");
      const body=consumptionScope?consumptionXapiInput(consumptionScope,services):{
        name: xapiName.trim(),
        slug: xapiSlug.trim(),
        steps: [
          { alias: "positions", dapiId: holdings!.id, dapiVersionId:holdings!.publishedVersion!.id },
          { alias: "cash", dapiId: cash!.id, dapiVersionId:cash!.publishedVersion!.id },
        ],
        timeoutMs: 2500,
        rateLimitPerMinute: 30,
      };const created=await api<DataService>("/data-services/xapis",body,{idempotencyKey:keyFor("xapi",body)});
      await reload();
      setSelectedId(created.id);
      setNotice("XAPI已锁定两个DAPI的已发布版本");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy("");
    }
  };
  const testService = async () => {
    if (!selected || !canWrite) return;
    const context=versionContext;
    setBusy("test");
    setError("");
    try {
      const receipt = await api<TestReceipt>(
        `/data-services/${selected.serviceType.toLowerCase()}s/${selected.id}/test`,
        { clientId: "CLIENT-001", page: 1, pageSize: 20 },
      );
      if(activeVersionRef.current!==context)return;
      setTestReceipt(receipt);
      setNotice("实际业务查询已通过，结果摘要已绑定当前版本");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy("");
    }
  };
  const publish = async () => {
    if (!selected || !currentTestValid || !canWrite) return;
    setBusy("publish");
    setError("");
    try {
      await api(
        `/data-services/${selected.serviceType.toLowerCase()}s/${selected.id}/publish`,
        {configHash:selected.currentVersion?.configHash},
      );
      await reload();
      setNotice(privateCloud ? `${cloudScopeLabel}：当前版本已发布，仍需应用授权调用；不代表生产验收完成` : "当前测试版本已发布，本机外部端点已生成");
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy("");
    }
  };
  const loadOpenApi = async () => {
    if (!selected) return;
    setBusy("openapi");
    setError("");
    try {
      setOpenApi(
        await api<Record<string, unknown>>(
          `/data-services/${selected.serviceType.toLowerCase()}s/${selected.id}/openapi`,
        ),
      );
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy("");
    }
  };
  const createApplication = async () => {
    if (!selected || !canWrite || appAlreadyExists || consumptionScope&&!plannedApplicationBody) return;
    setBusy("application");
    setError("");
    setIssuedToken("");
    try {
      const body=consumptionScope?consumptionApplicationInput(consumptionScope,services):{name:"证券财富分析演示系统",serviceIds:[selected.id]};
      const issued = await api<{
        application: Application;
        token: string | null;
        tokenShownOnce: boolean;
      }>("/data-services/applications", body,{idempotencyKey:keyFor(consumptionScope?"scoped-app":"app:"+selected.id,body)});
      setIssuedToken(issued.token ?? "");
      setIssuedAppId(issued.application.id);setTokenVisible(false);
      await reload();
      setNotice(`${privateCloud ? cloudScopeLabel : "本机"}应用凭证已创建；令牌只显示这一次`);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy("");
    }
  };
  const loadRecovery = async () => {
    if(!selected)return;
    const serviceId=selected.id;
    setBusy("recovery");setError("");
    try {
      const report=await api<RecoveryReport>(`/data-services/${selected.serviceType.toLowerCase()}s/${serviceId}/recovery`);
      if(activeServiceRef.current!==serviceId)return;
      setRecoveryReport(report);
      setNotice("已读取当前后端实例的恢复对照；仍需重建后比较启动标识与状态摘要");
    }catch(cause){if(activeServiceRef.current===serviceId)setError((cause as Error).message);}
    finally{setBusy("");}
  };
  const createVersion = async () => {
    if(!selected?.currentVersion||!canWrite||consumptionScope)return;
    const resource=selected,prior=selected.currentVersion;
    setBusy("new-version");setError("");
    try{
      const body={...(resource.serviceType==="DAPI"?{sourceReleaseRunId:prior.sourceReleaseRunId,fields:fieldProfiles[versionProfile]}:{}),rateLimitPerMinute:Number(versionRate),timeoutMs:Number(versionTimeout)};
      await api(`/data-services/${resource.serviceType.toLowerCase()}s/${resource.id}/versions`,body,{idempotencyKey:keyFor("version:"+resource.id,body)});
      await reload();setNotice("已创建不可变新草稿；原线上版本继续服务，新版本仍须实际测试与审阅发布");
    }catch(cause){setError((cause as Error).message);}finally{setBusy("");}
  };
  const loadSwitchHistory = async () => {
    if(!selected)return;const resource=selected,version=versionContext;setBusy("history");setError("");
    try{const rows=await api<VersionSwitchReceipt[]>(`/data-services/${resource.serviceType.toLowerCase()}s/${resource.id}/history`);if(activeVersionRef.current===version)setSwitchHistory(bindingDeclared?sourceBoundSwitches(rows,resource):rows);}
    catch(cause){setError((cause as Error).message);}finally{setBusy("");}
  };
  const activateVersion = async () => {
    if(!versionReview?.accepted||!canWrite||consumptionScope)return;const review=versionReview;
    setBusy("activate");setError("");
    try{
      const body={versionId:review.versionId,expectedPublishedVersionId:review.expectedPublishedVersionId,configHash:review.configHash};
      const result=await api<{receipt:VersionSwitchReceipt;targetStillActive:boolean}>(`/data-services/${review.type.toLowerCase()}s/${review.serviceId}/activate`,body,{idempotencyKey:keyFor("activate:"+review.serviceId,body)});
      await reload();setVersionReview(undefined);
      setNotice(result.targetStillActive?`版本切换已记录回执 ${result.receipt.id.slice(0,8)}；没有重新运行模型或Spark` : "原切换请求已处理，但线上版本后来已改变；请查看版本历史，不会重复回滚");
    }catch(cause){setError((cause as Error).message);}finally{setBusy("");}
  };

  return (
    <div className="service-workbench">
      <section className={servicePlanningOnly?"service-hero service-hero-compact":"service-hero"}>
        <div>
          <span className="eyebrow">{servicePlanningOnly?"DATA AGENT · SERVICE DELIVERY":"DATA SERVICE STUDIO · M3"}</span>
          <h2>{servicePlanningOnly?"用 Agent 交付数据服务":"把已验证数据发布成可治理接口"}</h2>
          <p>
            {servicePlanningOnly?"描述接口需求，核对来源与方案，再确认创建草稿；全过程保留原任务和恢复记录。":"DAPI查询真实发布批次，XAPI固定编排已发布版本；测试、授权、限流、版本和调用证据共享一个工作区。"}
          </p>
        </div>
        {!servicePlanningOnly&&<div className="service-stats" aria-label={dataReady?"当前范围统计":"当前范围统计尚未确认"}>
          <div>
            <strong>{dataReady?scopedDapis.length:"—"}</strong>
            <span>DAPI</span>
          </div>
          <div>
            <strong>{dataReady?scopedXapis.length:"—"}</strong>
            <span>XAPI</span>
          </div>
          <div>
            <strong>{dataReady?(consumptionScope||bindingDeclared?visibleCalls.filter(c=>services.some(s=>s.id===c.serviceId)).length:visibleCalls.length):"—"}</strong>
            <span>调用</span>
          </div>
          <button className="button service-catalog-refresh" disabled={(!dataReady&&!readFailed)||!!busy||Boolean(bindingError)} onClick={()=>void reload().catch(()=>{})}>刷新目录</button>
        </div>}
      </section>
      {!dataReady&&<section className={readFailed?"service-feedback error":"service-feedback"} role={readFailed?"alert":"status"} aria-label="数据服务读取状态">
        {readFailed?<CircleAlert size={18}/>:<LoaderCircle size={18} className="spin"/>}
        <div><strong>{readFailed?(sourceRead.loginRequired?"登录后查看项目服务":"目录读取尚未确认"):"正在读取当前范围的服务目录"}</strong>
          <p>{readFailed?sourceRead.message:"正在核对发布批次、DAPI／XAPI、应用与调用记录。"}</p>
          <small>未读取成功不代表没有数据；确认前不显示零项或使用旧目录操作。原方案、待确认请求与草稿保留。</small>
          {sourceRead.loginRequired&&<p>请通过右上角“受邀用户登录”进入已有账号，再重新读取目录。</p>}
          <button className="button" disabled={!readFailed||!!busy||Boolean(bindingError)} onClick={()=>void reload().catch(()=>{})}>重新读取目录</button>
        </div>
      </section>}
      {bindingDeclared&&<section className={bindingError||sourceRead.state==="ERROR"?"service-feedback error":"service-feedback"} role="status" aria-label="确切发布来源"><details open={!servicePlanningOnly}><summary>{bindingError||sourceRead.state==='ERROR'?"来源待恢复 · 查看核对记录":sourceRead.key===scopeKey&&sourceRead.state==='READY'?"发布来源已核对 · 查看原任务与版本":"正在核对发布来源"}</summary><div><strong>{binding?.sourceKind==="MANUAL"?"工程师接管结果 · 非 Agent 自主完成":"指定发布结果交接"}</strong><p>只使用指定任务、交付包和发布版本的成功发布批次；不是开发运行，不会自动创建接口、凭证或调用数据。</p>{binding&&<><p>原任务：{binding.taskId}<br/>交付包：{binding.packageDigest}<br/>发布版本：{binding.releaseId}</p>{sourceRead.key===scopeKey&&sourceRead.state==="READY"?<a className="button" href={serviceReturnLocation(typeof location==="undefined"?"http://localhost/v2/":location.href,binding).href}>返回原{binding.sourceKind==="MANUAL"?"人工版本":"Agent任务"}</a>:<small>返回原版本的链接将在同源核对后开放。</small>}</>}{bindingError?<p>{bindingError}</p>:<p>{sourceRead.key!==scopeKey||sourceRead.state==="LOADING"?"正在核对确切发布来源；写入暂不开放。":sourceRead.state==="ERROR"?"来源尚未确认；保留绑定，不回退全项目或其他发布。":"已核对可消费的成功发布批次；写权限仍按当前账号和消费计划判断。"}</p>}<button className="button" disabled={!!busy||Boolean(bindingError)} onClick={()=>void reload().catch(()=>{})}>重新读取指定来源</button></div></details></section>}
      {consumptionScope&&<section className="service-feedback" role="status" aria-label="接口消费试点范围"><div><strong>仅本次冻结接口计划 · 不重新计算业务数据</strong><p>{canWrite?"允许手动创建、测试、发布本计划接口，并创建及撤销唯一测试应用。":"当前消费窗口未开放、已到期或计划不可用；保持只读，不发行凭证。"} 不开放模型规划、代码开发、业务批次发布或接口版本切换。</p>{scopePlan&&<><p>源任务：{scopePlan.taskId}<br/>源发布批次：{scopePlan.sourceReleaseRunId}<br/>包摘要：{scopePlan.packageDigest}</p><small>接口：{scopePlan.dapis.map(d=>d.name).join("、")}、{scopePlan.xapi.name}。应用：{scopePlan.applicationName}；只授权直接查询持仓和组合资产，现金接口未单独授权。</small></>}<p>截止：{consumptionScope.expiresAt?new Date(consumptionScope.expiresAt).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai"}):"未确认"}（北京时间）。凭证到期后失效，历史调用证据保留。</p></div></section>}
      {scopeConflict&&<div className="service-feedback error" role="alert">发现同名服务不属于本次试点或其版本配置与计划不符；不会混入、覆盖或更新旧服务，请先核对来源。</div>}
      {!servicePlanningOnly&&<div className="service-flow" aria-label="数据服务生命周期">
        {flowSteps.map(({ Icon: FlowIcon, number, title, description }) => {
          return (
            <div key={String(number)}>
              <FlowIcon size={17} />
              <span>{number}</span>
              <strong>{title}</strong>
              <small>{description}</small>
            </div>
          );
        })}
      </div>}
      {(error || notice) && (
        <div
          className={error ? "service-feedback error" : "service-feedback"}
          role={error ? "alert" : "status"}
        >
          {error ? <CircleAlert size={16} /> : <CheckCircle2 size={16} />}
          {error || notice}
        </div>
      )}
      {privateStudioVisible&&<div className="service-agent-source"><label>当前发布批次<select aria-label="私有规划发布批次" value={sourceRunId} disabled={!!busy||sourceRead.state!=='READY'||Boolean(!savedPlanMarker.invalid&&savedPlanMarker.requestId)} onChange={event=>{setSourceRunId(event.target.value);history.replaceState(null,'',servicePlanLocation(location.href,{batchId:event.target.value}));}}>
        {!eligibleRuns.some(run=>run.id===sourceRunId)&&<option value={sourceRunId}>原成功批次待核对</option>}{eligibleRuns.map(run=><option key={run.id} value={run.id}>批次 {run.sequence??run.id.slice(0,8)} · {run.id.slice(0,8)}</option>)}
      </select></label><small>仅当前窗口指定的成功批次可创建与推进；切换不会删除原任务，待确认的原提交须先恢复。</small></div>}
      {privateStudioVisible&&binding&&<PrivateServiceAgentStudio key={JSON.stringify([scopeKey,privateStudioSource??null])}
        api={api} binding={binding} verifiedSource={privateContextSource} readEnabled={durableServiceAgentReadEnabled} planningEnabled={durableServiceAgentEnabled} transportEnabled={servicePlanningTransport}
        canAct={originalCanWrite} modelConfigured={modelConfigured} access={servicePlanning} onBusyChange={value=>setBusy(value?'private-agent':'')}
        onRefreshSource={reload} onApplied={async id=>{await reload();if(alive.current)setSelectedId(id);}}/>}
      {servicePlanningOnly&&<p className="service-feedback" role="status">当前仅允许指定来源的规划与草稿确认；下方经典模块可查看，测试、发布、版本修改及调用凭证保持关闭。</p>}
      {privateContextAllowed&&!privateStudioVisible&&<section className="service-agent-studio service-context-inspection" aria-label="私有Agent规划上下文">
        <header><div className="service-agent-icon"><Bot size={20}/></div><div><span className="eyebrow">DATA AGENT · SOURCE CONTEXT</span><h3>规划前，先核对数据</h3><p>核对当前成功批次、字段口径及可组合的接口版本，再决定下一步开发。</p></div></header>
        <div className="service-agent-source"><label>当前成功批次<select aria-label="规划上下文成功批次" value={sourceRunId} disabled={privateContextState?.state==='LOADING'||!!busy} onChange={event=>{setSourceRunId(event.target.value);history.replaceState(null,'',servicePlanLocation(location.href,{batchId:event.target.value}));}}>
          {!sourceRunId&&<option value="">请选择已核验批次</option>}{eligibleRuns.map(run=><option key={run.id} value={run.id}>批次 {run.sequence??run.id.slice(0,8)} · {run.id.slice(0,8)}</option>)}
        </select></label><button className="button" disabled={!privateContextSource||privateContextState?.state==='LOADING'||!!busy} onClick={()=>void inspectPrivateContext()}>{privateContextState?.state==='LOADING'?<LoaderCircle className="spin" size={16}/>:<ShieldCheck size={16}/>} {privateContextState?.state==='READY'?'重新核对上下文':'核对规划上下文'}</button></div>
        {privateContextState?.state==='ERROR'&&<p role="alert" className="service-feedback error">{privateContextState.error} 当前选择保留，可重新核对；未采用其他批次。</p>}
        {privateContextState?.value&&<><div className="service-context-columns"><div><span className="pill success">来源已核对 · {privateContextState.value.sourceKind==='MANUAL'?'工程师人工交付':'Agent交付'}</span><h4>{privateContextState.value.sourceContext.name}</h4><p>{privateContextState.value.sourceContext.definition}</p><dl>{Object.entries(privateContextState.value.sourceContext.metricLabels).map(([field,label])=><div key={field}><dt>{label}</dt><dd><code>{field}</code></dd></div>)}</dl></div><div><h4>可组合的 DAPI · {privateContextState.value.services.length}</h4><p>只列出当前批次已发布且可访问的固定版本。</p>{privateContextState.value.services.length?<ul>{privateContextState.value.services.map(service=><li key={service.id}><strong>{service.name}</strong><small>版本 {service.publishedVersion.id.slice(0,8)} · {service.publishedVersion.fields.map(field=>privateContextState.value!.sourceContext.metricLabels[field]).join('、')}</small></li>)}</ul>:<p>当前没有可组合的已发布 DAPI，可先完成 DAPI 开发、测试和发布。</p>}
          {privateContextState.value.resourcesTruncated&&<p>仅展示前100个接口，不代表全部接口已纳入后续规划。</p>}{privateContextState.value.unavailableServiceCount>0&&<p>{privateContextState.value.unavailableServiceCount} 个同源接口未通过版本或结果快照核对，未纳入。</p>}</div></div>
          <details><summary>查看来源标识</summary><p>发布 {privateContextState.value.sourceBinding.releaseId} · 批次 {privateContextState.value.sourceBinding.sourceReleaseRunId}</p></details></>}
        <p className="service-context-boundary" role="status">云端自动规划尚未开放。核对上下文不会调用模型、创建方案或发布接口。</p>
      </section>}
      {(!privateCloud && !consumptionScope && !bindingDeclared || boundPlannerAllowed) && <section className="service-agent-studio">
        <header>
          <div className="service-agent-icon">
            <Bot size={20} />
          </div>
          <div>
            <span className="eyebrow">DATA AGENT · GOVERNED DESIGN</span>
            <h3>用自然语言规划数据服务</h3>
            <p>模型只能选择页面中的发布批次和DAPI版本；后端校验通过后仍只创建草稿。</p>
            {boundPlanSource&&<small>已锁定当前任务的发布与成功批次 · {boundPlanSource.releaseId.slice(0,8)} / {boundPlanSource.sourceReleaseRunId.slice(0,8)}。字段含义继承原发布口径。</small>}
          </div>
        </header>
        {boundPlannerAllowed&&<div className="service-agent-source"><label>当前成功批次<select aria-label="Agent规划成功批次" value={sourceRunId} disabled={!!busy||Boolean(pendingPlanKey)||!canWrite} onChange={event=>setSourceRunId(event.target.value)}>
          {eligibleRuns.map(run=><option key={run.id} value={run.id}>第{run.sequence??'—'}批 · {run.id.slice(0,8)}</option>)}</select></label>
          <button className="button" disabled={!!busy||Boolean(pendingPlanKey)} onClick={()=>setAgentMessage('基于当前已核验批次生成持仓DAPI，只返回客户编号、持仓市值和证券数量；继承原发布口径。')}>先规划持仓 DAPI</button>
          <button className="button" disabled={!!busy||Boolean(pendingPlanKey)} onClick={()=>setAgentMessage('将当前批次已发布的持仓和现金DAPI组合为XAPI，按客户编号关联，并保留原字段口径。')}>组合已有 DAPI</button></div>}
        <div className="service-agent-compose">
          <textarea
            aria-label="向Data Agent描述数据服务需求"
            value={agentMessage}
            rows={2}
            maxLength={2000}
            onChange={(event) => setAgentMessage(event.target.value)}
          />
          <button
            className="button primary"
            onClick={planWithAgent}
            disabled={
              !dataReady || !canWrite ||
              !!busy ||
              boundPlannerAllowed&&(!boundPlanSource||!modelConfigured||Boolean(pendingPlanKey)||Boolean(planReadError)||Boolean(servicePlanMarker(location.href).invalid)) ||
              agentMessage.trim().length < 4 ||
              ["QUEUED", "RUNNING"].includes(agentPlan?.status ?? "")
            }
          >
            {busy === "agent" || ["QUEUED", "RUNNING"].includes(agentPlan?.status ?? "") ? (
              <LoaderCircle size={15} className="spin" />
            ) : (
              <Send size={15} />
            )}
            生成受治理方案
          </button>
        </div>
        {boundPlannerAllowed&&!modelConfigured&&<p role="status">模型尚未配置；来源仍可核对，配置完成后可生成同源方案。</p>}
        {boundPlannerAllowed&&pendingPlanKey&&<div className="service-feedback" role="status"><div><strong>原规划结果待确认</strong><p>请求编号 {pendingPlanKey}。查询只读取原任务，不再调用模型。</p>
          <button className="button" disabled={!!busy||!readablePlanSource} onClick={()=>void readSourcePlan()}>查询原规划任务</button>
          <button className="button" disabled={!!busy||!canWrite||!modelConfigured||!planSubmission.current?.snapshot().canRetry} onClick={()=>void readSourcePlan(undefined,true)}>按原需求和编号重试</button>
          {readablePlanSource&&<a href={servicePlanLocation(location.href,{batchId:readablePlanSource.sourceReleaseRunId,requestId:pendingPlanKey}).toString()} target="_blank" rel="noreferrer">原规划恢复链接</a>}</div></div>}
        {boundPlannerAllowed&&pendingPlanKey&&readablePlanSource&&<a href={servicePlanLocation(location.href,{batchId:readablePlanSource.sourceReleaseRunId}).toString()} target="_blank" rel="noreferrer">另开当前来源工作台查看记录</a>}
        {boundPlannerAllowed&&planReadError&&<p role="alert">{planReadError}</p>}
        {agentPlan && (
          <div className="service-agent-plan">
            <span className={"status-pill " + agentPlan.status.toLowerCase()}>
              {planLabels[agentPlan.status]??agentPlan.status}
            </span>
            <div>
              <strong>
                {agentPlan.proposal
                  ? `${agentPlan.proposal.serviceType} · ${agentPlan.proposal.name}`
                  : "正在生成方案"}
              </strong>
              <p>{agentPlan.explanation ?? agentPlan.error ?? "读取资源与约束中…"}</p>
              {boundPlannerAllowed&&<small>本方案需求：{agentPlan.message}</small>}
              {boundPlannerAllowed&&agentPlan.sourceContext&&<p>{agentPlan.sourceCheck==='UNAVAILABLE'?'原方案口径（来源待复核）':'当前已登记口径'}：{agentPlan.sourceContext.name}。{agentPlan.sourceContext.definition}</p>}
              {agentPlan.proposal && (
                <code>
                  /{agentPlan.proposal.slug} · {agentPlan.proposal.timeoutMs}ms · {agentPlan.proposal.rateLimitPerMinute}/min
                </code>
              )}
            </div>
            <button
              className="button"
              onClick={applyAgentPlan}
              disabled={!dataReady || !canWrite || agentPlan.status !== "SUCCEEDED" || !!busy || Boolean(pendingPlanKey) || boundPlannerAllowed&&(!boundPlanSource||agentPlan.sourceCheck==='UNAVAILABLE'||!sourcePlanReceiptValid(agentPlan,boundPlanSource))}
            >
              <CheckCircle2 size={15} />
              {agentPlan.status === "APPLIED" ? "草稿已创建" : "确认创建草稿"}
            </button>
          </div>
        )}
        {boundPlannerAllowed&&agentPlan&&<button className="button" disabled={!!busy||Boolean(pendingPlanKey)} onClick={()=>void readSourcePlan(agentPlan.id)}>重新读取原方案</button>}
        {boundPlannerAllowed&&agentPlan&&['QUEUED','RUNNING'].includes(agentPlan.status)&&<button className="button" disabled={!!busy||!originalCanWrite||Boolean(pendingPlanKey)} onClick={()=>void cancelSourcePlan()}>取消当前规划</button>}
        {boundPlannerAllowed&&agentPlans.length>0&&<details><summary>当前来源的方案记录</summary>{agentPlans.map(plan=><button className="button" key={plan.id} disabled={!!busy||Boolean(pendingPlanKey)} onClick={()=>void readSourcePlan(plan.id)}>{plan.proposal?.name??'规划任务'} · {planLabels[plan.status]??plan.status}</button>)}</details>}
        <small>{dataReady?`${agentPlans.length}条方案记录`:"方案目录尚未确认"} · 不自动发布、不创建调用凭证</small>
      </section>}
      {privateCloud && <div className="service-feedback" role="status">{privateStudioVisible?"Agent只使用当前来源的已核验元数据规划，执行受窗口约束；确认草稿不重跑Spark，查询测试、发布和授权须另行开放。":"复用已经审阅并运行的版本创建接口，不重新运行模型或Spark；当前服务操作仅提供虚构证券资产契约的参数化快照查询。"}</div>}
      {dataReady&&<><div className="service-layout">
        <aside className="service-catalog">
          <header>
            <div>
              <span className="eyebrow">SERVICE CATALOG</span>
              <h3>服务目录</h3>
            </div>
            <button className="button" disabled={!canWrite||!!busy||Boolean(consumptionScope&&nextPlannedDapi<0)} onClick={()=>{if(!canWrite)return;setSelectedId("");if(consumptionScope){if(nextPlannedDapi>=0)setPlannedDapiIndex(nextPlannedDapi);return;}const hasHoldings=dapis.some(s=>s.currentVersion?.fields?.includes("holding_market_value")&&(!privateCloud||s.currentVersion.sourceReleaseRunId===sourceRunId));setProfile(hasHoldings?"cash":"holdings");setDapiName(hasHoldings?"客户现金查询":"客户持仓查询");setDapiSlug((hasHoldings?"customer-cash":"customer-holdings")+(sourceAgentTaskId?`-${sourceAgentTaskId.slice(0,8)}`:""));}}>新建 DAPI</button>
          </header>
          {services.length ? (
            services.map((service) => (
              <button
                className={service.id === selectedId ? "active" : ""}
                key={service.id}
                onClick={() => setSelectedId(service.id)}
              >
                {service.serviceType === "DAPI" ? (
                  <Braces size={17} />
                ) : (
                  <Network size={17} />
                )}
                <div>
                  <strong>{service.name}</strong>
                  <code>/{service.slug}</code>
                </div>
                <span className={"status-pill " + service.status.toLowerCase()}>
                  {labels[service.status] ?? service.status}
                </span>
                <ChevronRight size={14} />
              </button>
            ))
          ) : (
            <div className="service-empty">
              <Layers3 size={25} />
              <p>从真实发布批次创建第一个DAPI。</p>
            </div>
          )}
        </aside>
        <section className="service-editor">
          {!selected ? (
            <section className="service-create-panel">
              <header>
                <div>
                  <span className="eyebrow">NEW DAPI</span>
                  <h3>创建参数化查询服务</h3>
                </div>
                <Braces size={22} />
              </header>
              {scopePlan&&<label>本次计划中的DAPI<select aria-label="选择已批准DAPI定义" disabled={!!busy||servicePlanningOnly} value={plannedDapiIndex} onChange={event=>setPlannedDapiIndex(Number(event.target.value))}>{scopePlan.dapis.map((d,index)=><option key={d.slug} value={index}>{d.name}{dapis.some(s=>s.slug===d.slug)?" · 已登记":""}</option>)}</select></label>}
              <div className="service-form-grid">
                <label>
                  服务名称
                  <input
                    value={plannedDapi?.name??dapiName}
                    readOnly={Boolean(consumptionScope)}
                    maxLength={80}
                    onChange={(event) => setDapiName(event.target.value)}
                  />
                </label>
                <label>
                  服务路径
                  <input
                    value={plannedDapi?.slug??dapiSlug}
                    readOnly={Boolean(consumptionScope)}
                    maxLength={48}
                    onChange={(event) => setDapiSlug(event.target.value)}
                  />
                </label>
                <label>
                  已验证发布批次
                  <select
                    value={scopePlan?.sourceReleaseRunId??sourceRunId}
                    disabled={Boolean(consumptionScope)||!!busy||Boolean(pendingPlanKey)}
                    onChange={(event) => setSourceRunId(event.target.value)}
                  >
                    {!eligibleRuns.length && <option>暂无可用批次</option>}
                    {eligibleRuns.map((run) => (
                      <option value={run.id} key={run.id}>
                        {run.id.slice(0, 8)} · {run.engine} {run.engineVersion}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  返回字段模板
                  {consumptionScope?<code>{plannedDapi?.fields.join(", ")??"计划尚未核对"}</code>:<select
                    value={profile}
                    onChange={(event) =>
                      setProfile(event.target.value as keyof typeof fieldProfiles)
                    }
                  >
                    <option value="holdings">持仓市值与证券数量</option>
                    <option value="cash">现金与口径合计</option>
                    <option value="full">全部结果字段</option>
                  </select>}
                </label>
              </div>
              {!consumptionScope&&<small>{fieldScopeNotice}</small>}
              <div className="service-contract-preview">
                <span>GET</span>
                <code>/api/v2/open/dapis/{plannedDapi?.slug??dapiSlug}</code>
                <small>client_id · page · page_size</small>
              </div>
              <button
                className="button primary"
                disabled={!canWrite || !eligibleRuns.length || dapiAlreadyExists || !!busy}
                onClick={createDapi}
              >
                {busy === "create-dapi" ? (
                  <LoaderCircle size={15} className="spin" />
                ) : (
                  <Braces size={15} />
                )}
                创建DAPI草稿
              </button>
              {plannedDapi&&<small>固定超时 {plannedDapi.timeoutMs}ms · 固定限流 {plannedDapi.rateLimitPerMinute}/min；本次不允许改名、改路径、换字段或换源批次。</small>}
            </section>
          ) : (
            <>
              <section className="service-detail-head">
                <div>
                  <span className="eyebrow">{selected.serviceType} · VERSIONED</span>
                  <h3>{selected.name}</h3>
                  <code>{selected.endpoint ?? `/api/v2/open/${selected.serviceType.toLowerCase()}s/${selected.slug}`}</code>
                </div>
                <span className={"status-pill " + selected.status.toLowerCase()}>
                  {labels[selected.status] ?? selected.status}
                </span>
              </section>
              {!privateCloud&&runtimeMode==='LOCAL_DEVELOPMENT'&&<Suspense fallback={<p role="status">正在加载数据契约门禁…</p>}><ServiceContractGatesPanel key={`${selected.id}:${bindingDeclared?selected.currentVersion?.id??'unconfirmed':'settings'}`} api={api} serviceId={selected.id} canWrite={canWrite&&!consumptionScope&&!bindingDeclared} version={bindingDeclared?selected.currentVersion:undefined} refreshToken={`${selected.currentVersion?.id??''}:${error}:${notice}`}/></Suspense>}
              <div className="service-version-grid">
                <div>
                  <span>{currentPublished?"线上版本":"当前草稿"}</span>
                  <strong>V{selected.currentVersion?.versionNumber}</strong>
                </div>
                <div>
                  <span>超时</span>
                  <strong>{selected.currentVersion?.timeoutMs}ms</strong>
                </div>
                <div>
                  <span>限流</span>
                  <strong>{selected.currentVersion?.rateLimitPerMinute}/min</strong>
                </div>
                <div>
                  <span>版本摘要</span>
                  <code>{selected.currentVersion?.configHash.slice(0, 12)}</code>
                </div>
              </div>
              {!currentPublished && selected.publishedVersion && <div className="service-contract-preview"><span>线上 V{selected.publishedVersion.versionNumber}</span><small>查询端点仍使用原发布版本；当前草稿尚未上线。</small></div>}
              <section className="service-definition">
                <header>
                  <h4>{selected.serviceType === "DAPI" ? "查询定义" : "组合编排"}</h4>
                  <span>不可变版本</span>
                </header>
                {selected.serviceType === "DAPI" ? (
                  <>
                    <pre>{`SELECT ${(selected.currentVersion?.fields ?? []).join(", ")}
FROM customer_assets
WHERE snapshot_id = :snapshot_id
  AND (:client_id IS NULL OR client_id = :client_id)
ORDER BY client_id
LIMIT :limit OFFSET :offset`}</pre>
                    <small>
                      源发布批次 {selected.currentVersion?.sourceReleaseRunId?.slice(0, 8)} · {selected.currentVersion?.sourceEngine ?? "未知引擎"} {selected.currentVersion?.sourceEngineVersion ?? ""} · 快照
                      {selected.currentVersion?.snapshotHash?.slice(0, 12)}
                    </small>
                  </>
                ) : (
                  <div className="xapi-steps">
                    {selected.currentVersion?.steps?.map((step, index) => (
                      <div key={step.alias}>
                        <span>{index + 1}</span>
                        <Network size={15} />
                        <strong>{step.alias}</strong>
                        <code>DAPI {step.dapiVersionId.slice(0, 8)}</code>
                      </div>
                    ))}
                    <small>按 client_id 合并结果；发布后继续固定子版本。</small>
                  </div>
                )}
              </section>
              <div className="service-actions">
                <button className="button" onClick={testService} disabled={!canWrite || !!busy}>
                  {busy === "test" ? <LoaderCircle size={15} className="spin" /> : <Play size={15} />}
                  实际查询测试
                </button>
                <button
                  className="button primary"
                  onClick={publish}
                  disabled={!canWrite || !currentTestValid || currentPublished || !!busy}
                >
                  <Rocket size={15} />
                  {currentPublished ? "当前版本已发布" : "发布当前版本"}
                </button>
                <button className="button" onClick={loadOpenApi} disabled={!!busy}>
                  <CodeXml size={15} />
                  OpenAPI
                </button>
                {privateCloud && <button className="button" onClick={loadRecovery} disabled={!!busy}><Activity size={15}/>恢复对照</button>}
                <button
                  className="button"
                  onClick={createApplication}
                  disabled={!canWrite || selected.status !== "PUBLISHED" || !!busy || appAlreadyExists || Boolean(consumptionScope&&!plannedApplicationBody)}
                >
                  <KeyRound size={15} />
                  {consumptionScope?appAlreadyExists?"本次应用已发行，不再补发":"创建唯一测试凭证":"创建调用凭证"}
                </button>
              </div>
              {consumptionScope&&<p>三项接口均发布后，仅发放1个测试应用：直接查询持仓DAPI和XAPI组合资产；现金DAPI未单独授权，用于检验越权拒绝。到期或撤销后不能再补发。</p>}
              <section className="service-definition" aria-label="版本治理">
                <header><h4>版本历史与受控切换</h4>{!consumptionScope&&<button className="button" disabled={!canWrite||!!busy} onClick={()=>setShowVersionEditor(!showVersionEditor)}>新建版本</button>}</header>
                {consumptionScope&&<small>本次只使用计划内首次发布的固定版本；新建版本与切换入口关闭。</small>}
                {!consumptionScope&&showVersionEditor && <div className="service-create-panel">
                  <small>{selected.serviceType==="DAPI"?"复用当前已核验发布批次，不重新计算业务数据。":"保留原固定DAPI子版本，不跟随它们的最新版本。"}</small>
                  <div className="service-form-grid">
                    {selected.serviceType==="DAPI" && <label>返回字段模板<select value={versionProfile} onChange={e=>setVersionProfile(e.target.value as keyof typeof fieldProfiles)}><option value="holdings">持仓市值与证券数量</option><option value="cash">现金与口径合计</option><option value="full">全部结果字段</option></select></label>}
                    <label>每分钟限流<input type="number" min={1} max={600} value={versionRate} onChange={e=>setVersionRate(e.target.value)}/></label>
                    <label>查询超时（毫秒）<input type="number" min={100} max={5000} value={versionTimeout} onChange={e=>setVersionTimeout(e.target.value)}/></label>
                  </div>
                  {selected.serviceType==="DAPI"&&<small>{fieldScopeNotice}</small>}
                  <button className="button" disabled={!canWrite||!!busy} onClick={createVersion}>保存新版本草稿</button>
                </div>}
                {selected.versions.map(v=><div key={v.id} className="service-contract-preview">
                  <span>V{v.versionNumber} {v.id===selected.publishedVersion?.id?"线上":v.status==="DRAFT"?"草稿":"历史"}</span><code>{v.configHash.slice(0,12)}</code>
                  {!consumptionScope&&v.id!==selected.publishedVersion?.id && ["PUBLISHED","RETIRED"].includes(v.status) && selected.publishedVersion && <button className="button" disabled={!canWrite||!!busy} onClick={()=>setVersionReview({serviceId:selected.id,type:selected.serviceType,versionId:v.id,configHash:v.configHash,expectedPublishedVersionId:selected.publishedVersion!.id,targetNumber:v.versionNumber,liveNumber:selected.publishedVersion!.versionNumber,accepted:false})}>审阅切换到 V{v.versionNumber}</button>}
                </div>)}
                {!consumptionScope&&versionReview && <div className="service-create-panel" role="group" aria-label="版本切换审阅">
                  <strong>线上 V{versionReview.liveNumber} → 目标 V{versionReview.targetNumber}</strong>
                  <code>目标摘要 {versionReview.configHash.slice(0,16)}</code>
                  <small>切换影响本服务查询端点；固定引用它的XAPI仍使用原子版本。线上版本变化后旧审阅将被拒绝。</small>
                  <label><input type="checkbox" checked={versionReview.accepted} onChange={e=>setVersionReview({...versionReview,accepted:e.target.checked})}/>我已核对线上版本、目标摘要及查询影响</label>
                  <button className="button primary" disabled={!canWrite||!versionReview.accepted||!!busy} onClick={activateVersion}>确认切换版本</button>
                  <button className="button" disabled={!!busy} onClick={()=>setVersionReview(undefined)}>取消审阅</button>
                </div>}
                <button className="button" disabled={!!busy} onClick={loadSwitchHistory}>查看切换回执</button>
                {switchHistory.map(r=><small key={r.id}>回执 {r.id.slice(0,8)} · {r.fromVersionId.slice(0,8)} → {r.toVersionId.slice(0,8)} · {new Date(r.createdAt).toLocaleString()}</small>)}
              </section>
              {recoveryReport && <section className="service-definition" aria-label="服务恢复对照">
                <header><h4>当前实例恢复对照</h4><span>{recoveryReport.healthy ? "快照及来源完整" : "数据或版本校验未通过"}</span></header>
                {recoveryReport.state.evidence.filter(e=>!e.verified).map((e,i)=><small key={i}>{e.code==="SERVICE_VERSION_CORRUPT"?"不可变版本配置与摘要不一致":e.code==="VERSION_NOT_FOUND"?"固定子版本缺失":"来源或实际数据快照缺失、漂移"}</small>)}
                <div className="service-version-grid">
                  <div><span>后端启动标识</span><code>{recoveryReport.bootId.slice(0,12)}</code></div>
                  <div><span>状态摘要</span><code>{recoveryReport.fingerprint.slice(0,12)}</code></div>
                  <div><span>持久调用</span><strong>{recoveryReport.state.calls.length}</strong></div>
                  <div><span>已撤销应用</span><strong>{recoveryReport.state.applications.filter(a=>a.status==="REVOKED").length}</strong></div>
                </div>
                <p>这是一份只读检查，不代表已经通过冷启动验收。重建后端后须确认启动标识改变、状态摘要与原记录一致；刷新浏览器或重启临时代理不能代替。</p>
                <EvidenceDownload name={`service-recovery-${recoveryReport.state.serviceId.slice(0,8)}.json`} value={recoveryReport} request={{kind:"recovery",type:selected.serviceType.toLowerCase() as "dapi"|"xapi",id:recoveryReport.state.serviceId}}>下载恢复对照</EvidenceDownload>
              </section>}
              {testReceipt && (
                <section className="service-test-result">
                  <CheckCircle2 size={18} />
                  <div>
                    <strong>真实查询通过 · {testReceipt.test.rowCount}行</strong>
                    <code>结果摘要 {testReceipt.test.resultHash.slice(0, 16)}</code>
                  </div>
                  <pre>{JSON.stringify(testReceipt.response.data, null, 2)}</pre>
                </section>
              )}
              {issuedToken && (
                <section className="service-token" role="status">
                  <ShieldCheck size={18} />
                  <div>
                    <strong>令牌仅显示一次</strong>
                    <code>{tokenVisible ? issuedToken : "已生成 · 默认隐藏"}</code>
                    <button className="button" onClick={()=>setTokenVisible(!tokenVisible)}>{tokenVisible?"隐藏令牌":"显示一次性令牌"}</button>
                    <button className="button" onClick={()=>{
                      try { requestTextDownload(`shuduo-application-${issuedAppId.slice(0,8)}.token`,issuedToken+"\n","text/plain;charset=utf-8"); setNotice("已请求保存本次凭据，请核对浏览器下载列表；未确认下载时可使用本卡的显示/隐藏入口，不会补发应用。请勿发送或公开令牌。"); }
                      catch { setError("未确认保存，本次令牌仍在卡片中保留；可使用显示/隐藏入口安全保存，不会补发应用。"); }
                    }}>下载本次调用凭据</button>
                    <small>只存哈希；请勿提交Git或发送到聊天。</small>
                  </div>
                </section>
              )}
              {openApi && (
                <section className="service-openapi">
                  <header>
                    <h4>OpenAPI 3.1</h4>
                    <span>{privateCloud ? cloudScopeLabel : "本机测试范围"}</span>
                  </header>
                  <pre>{JSON.stringify(openApi, null, 2)}</pre>
                </section>
              )}
            </>
          )}
        </section>
      </div>
      <section className="service-bottom-grid">
        <article className="service-create-more">
          <header>
            <Network size={19} />
            <div>
              <h3>XAPI组合编排</h3>
              <p>把两个已发布DAPI按客户编号组合，固定其版本。</p>
            </div>
          </header>
          <div className="service-composition-form">
            <label>XAPI名称<input value={scopePlan?.xapi.name??xapiName} maxLength={100} readOnly={Boolean(consumptionScope)} disabled={!!busy||servicePlanningOnly} onChange={e=>setXapiName(e.target.value)}/></label>
            <label>XAPI路径标识<input value={scopePlan?.xapi.slug??xapiSlug} maxLength={48} readOnly={Boolean(consumptionScope)} disabled={!!busy||servicePlanningOnly} onChange={e=>setXapiSlug(e.target.value)}/></label>
            <label>持仓DAPI版本<select value={composition.holdings?.publishedVersion?.id??""} disabled={!!busy||Boolean(consumptionScope)||servicePlanningOnly} onChange={e=>{setHoldingsVersionId(e.target.value);setCashVersionId("");}}><option value="">请选择已发布版本</option>{composition.holdingsOptions.map(s=><option key={s.id} value={s.publishedVersion!.id}>{s.name} · V{s.publishedVersion!.versionNumber} · {s.publishedVersion!.id.slice(0,8)}</option>)}</select></label>
            <label>现金DAPI版本<select value={composition.cash?.publishedVersion?.id??""} disabled={!!busy||Boolean(consumptionScope)||servicePlanningOnly} onChange={e=>setCashVersionId(e.target.value)}><option value="">请选择已发布版本</option>{composition.cashOptions.map(s=><option key={s.id} value={s.publishedVersion!.id}>{s.name} · V{s.publishedVersion!.versionNumber} · {s.publishedVersion!.id.slice(0,8)}</option>)}</select></label>
          </div>
          <button
            className="button"
            onClick={createXapi}
            disabled={!canWrite || (consumptionScope ? !plannedXapiBody || xapiAlreadyExists : !composition.holdings || !composition.cash || !xapiName.trim() || !/^[a-z][a-z0-9-]{2,47}$/.test(xapiSlug.trim())) || !!busy}
          >
            <Network size={15} />
            创建持仓+现金XAPI
          </button>
          <small>需要至少两个已发布DAPI；首版采用声明式编排。</small>
          {scopePlan&&<small>固定编排：{scopePlan.xapi.steps.map(s=>`${s.alias} → ${s.dapiSlug}`).join("；")}；{scopePlan.xapi.timeoutMs}ms、{scopePlan.xapi.rateLimitPerMinute}/min。</small>}
        </article>
        <article className="service-observability">
          <header>
            <Activity size={19} />
            <div>
              <h3>调用与授权</h3>
              <p>{scopedApplications.length}个应用 · {callsForSelected.length}条当前服务调用</p>
            </div>
          </header>
          {callsForSelected.slice(0, 5).map((call) => (
            <div key={call.id}>
              <span className={"status-pill " + call.outcome.toLowerCase()}>
                {labels[call.outcome] ?? call.outcome}
              </span>
              <code>V{call.versionNumber} · {call.id.slice(0, 8)}</code>
              <span>{call.rowCount}行</span>
              <span>{call.durationMs}ms</span>
            </div>
          ))}
            {!callsForSelected.length && (
            <div className="service-no-calls">
              <Clock3 size={16} />
              发布并授权后，外部调用证据显示在这里。
            </div>
            )}
          {scopedApplications.filter(app=>consumptionScope||!selected||app.serviceIds.includes(selected.id)).map(app=><div key={app.id}><span>{app.name} · {applicationStatusText(serviceApplicationStatus(app,scopeClock))}{app.expiresAt&&<small>到期：{new Date(app.expiresAt).toLocaleString("zh-CN",{timeZone:"Asia/Shanghai"})}</small>}</span><button className="button" disabled={!canWrite||serviceApplicationStatus(app,scopeClock)!=="ACTIVE"||!!busy} onClick={async()=>{if(!canWrite||!scopedApplications.some(a=>a.id===app.id))return;setBusy("revoke");try{await api(`/data-services/applications/${app.id}/revoke`,{});for(const id of app.serviceIds)delete requestKeys.current["app:"+id];setIssuedToken("");await reload();setNotice("凭证已撤销，旧令牌不能继续调用");}catch(e){setError((e as Error).message);}finally{setBusy("");}}}>撤销凭证</button></div>)}
        </article>
      </section></>}
      <footer className="service-boundary">
        <AppWindow size={15} />
        当前数据来自虚构证券发布批次；业务查询库与平台元数据库分离。{privateCloud ? `${cloudScopeLabel}：接口查询已发布结果的不可变快照，不在每次调用时重跑Spark；访问仍受应用授权限制，不代表生产验收完成。` : "本机端点不是公网服务。"}
      </footer>
    </div>
  );
}
