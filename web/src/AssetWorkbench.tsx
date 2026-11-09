import { useEffect, useMemo, useRef, useState } from "react";
import { createAssetReader, assetSummaryValid, assetDetailValid, assetResourcePath, annotationKey, annotationValues, annotationDirty, annotationTags, annotationReceiptMatches, reconcileAnnotation, rebaseAnnotation } from "./asset-read";
import type { AssetCatalogRead, AssetDetailRead, AnnotationDraft, AnnotationValues } from "./asset-read";
import {createAnnotationSubmission,annotationRecoveryMarker,annotationRecoveryLocation,assetLocationTarget} from './asset-annotation-submission';
import {normalizeAnnotationValues} from '../../src/v2/asset-annotation-client.mjs';
import type {AnnotationResult} from '../../src/v2/asset-annotation-client.mjs';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Bot,
  CheckCircle2,
  ChevronRight,
  Database,
  FileSearch,
  Gauge,
  GitBranch,
  Layers3,
  LoaderCircle,
  Network,
  Play,
  Save,
  Search,
  Send,
  ShieldCheck,
  Sparkles,
  Tag,
} from "lucide-react";
import { ContractsPanel } from "./ContractsPanel";
import {SqlColumnLineagePanel} from './SqlColumnLineagePanel';
import type{SqlValueLineage}from'./sql-column-lineage';

type Api = <T>(path: string, body?: unknown, options?:{idempotencyKey?:string}) => Promise<T>;
type Field = {
  name: string;
  type: string;
  nullable: boolean;
  distinctCount?: number;
};
type Asset = {
  id: string;
  kind: string;
  name: string;
  businessName: string;
  system: string;
  domain: string;
  description: string;
  status: string;
  rowCount?: number;
  eventCount?: number;
  fields: Field[];
  tags: string[];
  evidenceHash: string;
  versionId?: string;
  executableMetrics: boolean;
  owner?: string;
  classification: string;
  annotation?: { revision: number };
};
type LineageNode = Asset;
type LineageEdge = {
  id: string;
  from: string;
  to: string;
  type: string;
  fieldMappings: { source: string; target: string }[];
  evidenceId: string;
  evidenceHash: string;
};
type Lineage = {
  focusAssetId: string;
  nodes: LineageNode[];
  edges: LineageEdge[];
  derivation: string;
  sqlColumnLineageParsed: boolean;
  columnLineages?:SqlValueLineage[];
};
type MetricRun = {
  id: string;
  status: string;
  rowCount: number;
  values: { group: string; value: string }[];
  resultHash: string;
  durationMs: number;
};
type Metric = {
  id: string;
  name: string;
  code: string;
  assetId: string;
  aggregation: string;
  field?: string;
  groupBy?: string;
  definition: string;
  unit: string;
  runs: MetricRun[];
};
type StandardCheck = {
  id: string;
  status: string;
  evaluatedCount: number;
  passedCount: number;
  failedCount: number;
};
type Standard = {
  id: string;
  name: string;
  code: string;
  assetId: string;
  field: string;
  semanticType: string;
  description: string;
  checks: StandardCheck[];
};
type AssetDetail = Asset & {
  lineage: Lineage;
  metrics: Metric[];
  standards: Standard[];
};
type AgentTask = {
  id: string;
  message: string;
  status: string;
  insight?: {
    answer: string;
    assetIds: string[];
    lineageFocusAssetId: string;
    caveats: string[];
  };
  error?: string;
  model?: string;
  usage?: { total_tokens?: number };
};

const kindLabels: Record<string, string> = {
  FIXTURE_TABLE: "Spark输入",
  SOURCE_TABLE: "源表",
  LANDING_TABLE: "落地表",
  STREAM_SOURCE: "实时源",
  STREAM_STATE_TABLE: "实时状态",
  PUBLISHED_DATASET: "发布数据集",
  DAPI: "DAPI",
  XAPI: "XAPI",
};
const statusLabels: Record<string, string> = {
  READY: "已就绪",
  SUCCEEDED: "成功",
  CAUGHT_UP: "已追平",
  PUBLISHED: "已发布",
  PUBLISHED_LOCAL: "本机发布",
  VERIFIED_FIXTURE: "已验证样例",
  FAILED: "失败",
  QUEUED: "排队中",
  RUNNING: "运行中",
  PASSED: "通过",
};
const pending = (status?: string) =>
  status === "QUEUED" || status === "RUNNING";

export function AssetWorkbench({
  api,
  canWrite: originalCanWrite,
  initialAssetId,
  handoffMessage,
}: {
  api: Api;
  canWrite: boolean;
  initialAssetId?: string;
  handoffMessage?: string;
}) {
  const initialAnnotation = useMemo(()=>typeof window==='undefined'?{state:'ABSENT' as const}:annotationRecoveryMarker(window.location.href),[]);
  const locationTarget=useMemo(()=>typeof window==='undefined'?undefined:assetLocationTarget(window.location.href),[]);
  const initialTarget = initialAnnotation.state==='VALID'?initialAnnotation.assetId:initialAssetId??locationTarget;
  const [annotationPending,setAnnotationPending]=useState<{assetId:string;requestId:string}|undefined>(initialAnnotation.state==='VALID'?{assetId:initialAnnotation.assetId,requestId:initialAnnotation.requestId}:undefined);
  const [annotationResult,setAnnotationResult]=useState<AnnotationResult>();
  const annotationSubmission=useRef<{assetId:string;controller:ReturnType<typeof createAnnotationSubmission>}|undefined>(undefined);
  const submittedDraft=useRef<AnnotationDraft|undefined>(undefined);
  const confirmedRevisions=useRef(new Map<string,number>());
  const [assets, setAssets] = useState<Asset[]>([]),
    [metrics, setMetrics] = useState<Metric[]>([]),
    [standards, setStandards] = useState<Standard[]>([]),
    [agentTasks, setAgentTasks] = useState<AgentTask[]>([]);
  const [catalogRead, setCatalogRead] = useState<AssetCatalogRead<Asset, Metric, Standard, AgentTask>>({ state: "LOADING", criteria: { query: "", kind: "" } });
  const [detailRead, setDetailRead] = useState<AssetDetailRead<AssetDetail>>({ state: "EMPTY", id: "" });
  const detail = "value" in detailRead ? detailRead.value : undefined, selectedId = detailRead.id;
  const catalogReady = catalogRead.state === "READY", detailReady = detailRead.state === "READY" && detail?.id === selectedId && (detail.annotation?.revision??0)>=(confirmedRevisions.current.get(selectedId)??0);
  const canWrite = originalCanWrite && detailReady;
  const [knownKinds, setKnownKinds] = useState<string[]>([]);
  const [query, setQuery] = useState(""),
    [kind, setKind] = useState(""),
    [tab, setTab] = useState<"overview" | "fields" | "lineage" | "governance">("overview"),
    [busy, setBusy] = useState(""),
    [notice, setNotice] = useState(""),
    [error, setError] = useState("");
  const [agentMessage, setAgentMessage] = useState(
      "找出可以计算财富顾问客户持仓市值的资产，解释它从哪里来、有哪些下游影响和当前证据边界",
    ),
    [agentTask, setAgentTask] = useState<AgentTask>();
  useEffect(() => {
    if (handoffMessage) setAgentMessage(handoffMessage);
  }, [handoffMessage]);
  const drafts = useRef(new Map<string, AnnotationDraft>());
  const [annotation, setAnnotation] = useState<AnnotationDraft>();
  const { businessName = "", description = "", domain = "", owner = "", tagText = "" } = annotation?.values ?? {};
  const draftDirty = Boolean(annotation && annotationDirty(annotation));
  const draftConflict = Boolean(draftDirty && detailReady && annotation && detail && annotation.key !== annotationKey(detail));
  const reader = useRef<ReturnType<typeof createAssetReader<Asset, Metric, Standard, AgentTask, AssetDetail>> | undefined>(undefined);
  const formsAsset = useRef("");
  const selectionRef = useRef(initialTarget ?? "");
  const activeQuestion = useRef<string | undefined>(undefined);
  activeQuestion.current = agentTask?.id;
  const [metricName, setMetricName] = useState("持仓市值"),
    [metricCode, setMetricCode] = useState("holding_market_value_v2"),
    [aggregation, setAggregation] = useState("SUM"),
    [metricField, setMetricField] = useState("market_value"),
    [groupBy, setGroupBy] = useState("asset_class"),
    [metricDefinition, setMetricDefinition] = useState("按资产类别汇总持仓明细market_value，不含现金");
  const [standardName, setStandardName] = useState("证券代码格式"),
    [standardCode, setStandardCode] = useState("security_code_format_v2"),
    [standardField, setStandardField] = useState("security_code"),
    [semanticType, setSemanticType] = useState("SECURITY_CODE"),
    [standardDescription, setStandardDescription] = useState("虚构证券代码必须使用SEC-前缀");
  const metricFieldsValid = Boolean(detail && (aggregation === "COUNT_ROWS" || detail.fields.some(field => field.name === metricField)) && (!groupBy || detail.fields.some(field => field.name === groupBy)));
  const standardFieldValid = Boolean(detail?.fields.some(field => field.name === standardField));

  const nodeById = useMemo(
      () => new Map(detail?.lineage.nodes.map((node) => [node.id, node]) ?? []),
      [detail],
    ),
    executableAssets = assets.filter((asset) => asset.executableMetrics),
    assetKinds = [...new Set([...knownKinds, kind].filter(Boolean))];
  const loadLists = (search?: string, filter?: string) => reader.current?.search(search === undefined ? undefined : { query: search, kind: filter ?? "" }) ?? Promise.resolve(false);
  const selectAsset = (id: string) => { if (!busy) void reader.current?.select(id); };
  function editAnnotation(field: keyof AnnotationValues, value: string) {
    if (!detail || !originalCanWrite || busy === "annotation") return;
    const current = reconcileAnnotation(drafts.current.get(detail.id), detail, detailReady), next = { ...current, values: { ...current.values, [field]: value } };
    drafts.current.set(detail.id, next); setAnnotation(next);
  }
  useEffect(() => {
    const current = createAssetReader<Asset, Metric, Standard, AgentTask, AssetDetail>({ api, initialId: initialTarget, validAsset: assetSummaryValid, validDetail: (value,id)=>assetDetailValid(value,id)&&((value as AssetDetail).annotation?.revision??0)>=(confirmedRevisions.current.get(id)??0), isOlder: (value, known) => (value.annotation?.revision ?? 0) < (known.annotation?.revision ?? 0),
      onCatalog(result) {
        setCatalogRead(result);
        if (result.state !== "READY") return;
        setAssets(result.assets); setMetrics(result.metrics); setStandards(result.standards); setAgentTasks(result.tasks);
        setKnownKinds(previous => [...new Set([...previous, ...result.assets.map(asset => asset.kind)])]);
        setAgentTask(previous => previous ?? result.tasks[0]);
      },
      onDetail(result) {
        selectionRef.current = result.id;
        setDetailRead(result);
        if (!("value" in result) || !result.value) { setAnnotation(undefined); return; }
        const value = result.value, draft = reconcileAnnotation(drafts.current.get(value.id), value, result.state === "READY");
        drafts.current.set(value.id, draft); setAnnotation(draft);
        if (formsAsset.current === value.id) return;
        formsAsset.current = value.id;
        const names = new Set(value.fields.map(field => field.name));
        setMetricField(names.has("market_value") ? "market_value" : names.has("price") ? "price" : value.fields[0]?.name ?? "");
        setGroupBy(names.has("asset_class") ? "asset_class" : "");
        setStandardField(names.has("security_code") ? "security_code" : value.fields[0]?.name ?? "");
      },
    });
    reader.current = current; void current.search();
    return () => { current.close(); if (reader.current === current) reader.current = undefined; };
  }, [api, initialTarget]);
  useEffect(() => {
    if (!agentTask || !pending(agentTask.status)) return;
    let live = true, polling = false; const id = agentTask.id;
    const timer = setInterval(async () => {
      if (polling || activeQuestion.current !== id) return; polling = true;
      try {
        const current = await api<AgentTask>(`/assets/agent/tasks/${id}`);
        if (!live || activeQuestion.current !== id || current.id !== id) return;
        setAgentTask(current);
        if (!pending(current.status)) { const tasks = await api<AgentTask[]>("/assets/agent/tasks"); if (live && activeQuestion.current === id && Array.isArray(tasks)) setAgentTasks(tasks); }
      } catch (cause) {
        if (live && activeQuestion.current === id) setError((cause as Error).message);
      } finally { polling = false; }
    }, 1000);
    return () => { live = false; clearInterval(timer); };
  }, [agentTask?.id, agentTask?.status, api]);

  const action = async (
    name: string,
    work: () => Promise<unknown>,
    message: string,
    refresh: "catalog" | "history" = "catalog",
  ) => {
    if (!originalCanWrite || busy) return;
    const current = reader.current;
    setBusy(name);
    setError("");
    try {
      await work();
      if (reader.current !== current) return;
      setNotice(message);
      if (refresh === "catalog") await current?.search();
      else { const tasks = await api<AgentTask[]>("/assets/agent/tasks"); if (reader.current === current && Array.isArray(tasks)) setAgentTasks(tasks); }
    } catch (cause) {
      if (reader.current === current) setError((cause as Error).message);
    } finally {
      if (reader.current === current) setBusy("");
    }
  };
  const search = async () => { if (busy) return; setNotice(""); if (await loadLists(query, kind)) setNotice("已按所示条件读取资产目录；详情分别核对，没有创建问答。"); };
  const askAgent = () =>
    catalogReady && originalCanWrite && action(
      "agent",
      async () => {
        const current = reader.current, task = await api<AgentTask>("/assets/agent/tasks", {
          message: agentMessage,
        });
        if (reader.current === current) { activeQuestion.current = task.id; setAgentTask(task); }
      },
      "Data Agent正在读取资产摘要和版本绑定血缘",
      "history",
    );
  function annotationController(assetId:string) {
    const previous=annotationSubmission.current;
    if(previous?.assetId===assetId&&!previous.controller.snapshot().closed)return previous;
    if(previous?.controller.snapshot().key)throw Error('原标注结果尚未确认，不能切换为另一个写请求');
    previous?.controller.close();
    const controller=createAnnotationSubmission({api,assetId,initialKey:annotationPending?.assetId===assetId?annotationPending.requestId:undefined,onPending:key=>{
      setAnnotationPending(key?{assetId,requestId:key}:undefined);
      if(typeof window!=='undefined')history.replaceState(null,'',annotationRecoveryLocation(location.href,key?assetId:selectionRef.current||assetId,key));
    }});
    const entry={assetId,controller};annotationSubmission.current=entry;return entry;
  }
  async function acceptAnnotationResult(result:AnnotationResult,entry:NonNullable<typeof annotationSubmission.current>) {
    if(annotationSubmission.current!==entry||result.assetId!==entry.assetId||result.requestId!==entry.controller.snapshot().key)throw Error('标注回执上下文不一致，原请求保留');
    setAnnotationResult(result);
    if(result.receipt.outcome==='APPLIED'&&result.receipt.annotation){
      const saved=result.receipt.annotation,known=drafts.current.get(result.assetId),sent=submittedDraft.current;
      confirmedRevisions.current.set(result.assetId,Math.max(confirmedRevisions.current.get(result.assetId)??0,saved.revision));
      if((!known||known===sent||!annotationDirty(known))&&(!known||known.revision<=saved.revision)){
        const ack=reconcileAnnotation(undefined,{...saved,id:result.assetId,annotation:{revision:saved.revision}});drafts.current.set(result.assetId,ack);if(selectionRef.current===result.assetId)setAnnotation(ack);
      }
      setNotice(`原请求已应用为说明V${saved.revision}${result.currentMatches?'；继续核对当前详情。':'；当前版本另行核对，不把原结果当作最新。'}`);setError('');
    }else{setNotice('');setError('原请求已明确拒绝：已读基线发生变化，没有创建标注版本；本页草稿保留，请重读并审阅新基线。');}
    entry.controller.acknowledge(result.requestId);submittedDraft.current=undefined;
    if(result.receipt.outcome==='APPLIED'){const ready=await reader.current?.search();if(!ready&&selectionRef.current===result.assetId)await reader.current?.refreshDetail();}
    else if(selectionRef.current===result.assetId)await reader.current?.refreshDetail();
  }
  async function recoverAnnotation(retry=false) {
    if(busy||!annotationPending||retry&&!originalCanWrite)return;
    const entry=annotationController(annotationPending.assetId);setBusy('annotation-read');setError('');
    try{await acceptAnnotationResult(await(retry?entry.controller.retry():entry.controller.recover()),entry);}
    catch(cause){if(annotationSubmission.current===entry)setError((cause as Error).message+' 原编号保留；不自动重写。');}
    finally{if(annotationSubmission.current===entry)setBusy('');}
  }
  async function saveAnnotation() {
    if(!detail||!canWrite||!annotation||!draftDirty||draftConflict||busy||annotationPending||initialAnnotation.state==='INVALID')return;
    let values;try{values=normalizeAnnotationValues({businessName:annotation.values.businessName,description:annotation.values.description,domain:annotation.values.domain,owner:annotation.values.owner,classification:'INTERNAL_DEMO',tags:annotationTags(annotation)});}catch(cause){setError((cause as Error).message);return;}
    const entry=annotationController(detail.id);submittedDraft.current=annotation;setBusy('annotation');setError('');
    try{
      const result=await entry.controller.submit({expected:{revision:annotation.revision,evidenceHash:detail.evidenceHash},annotation:values});
      await acceptAnnotationResult(result,entry);
    }catch(cause){
      if(annotationSubmission.current===entry){
        try{await acceptAnnotationResult(await entry.controller.recover(),entry);}
        catch{setError((cause as Error).message+' 保存结果尚未确认；原内容和编号保留，请先核对原请求。');}
      }
    }finally{if(annotationSubmission.current===entry)setBusy('');}
  }
  useEffect(()=>{
    if(initialAnnotation.state==='VALID')void recoverAnnotation();
    return()=>{annotationSubmission.current?.controller.close();annotationSubmission.current=undefined;};
  },[api]);
  const createMetric = () =>
    detail && canWrite && detail.executableMetrics && (aggregation === "COUNT_ROWS" || detail.fields.some(field => field.name === metricField)) && (!groupBy || detail.fields.some(field => field.name === groupBy)) &&
    action(
      "metric",
      () =>
        api("/metrics", {
          name: metricName,
          code: metricCode,
          assetId: detail.id,
          aggregation,
          ...(aggregation === "COUNT_ROWS" ? {} : { field: metricField }),
          ...(groupBy ? { groupBy } : {}),
          definition: metricDefinition,
        }),
      "指标定义已绑定当前资产证据",
    );
  const runMetric = (id: string) =>
    canWrite && detail?.metrics.some(metric => metric.id === id) && action(
      `metric-run:${id}`,
      () => api(`/metrics/${id}/run`, {}),
      "指标已在实际资产行上执行并保存结果摘要",
    );
  const createStandard = () =>
    detail && canWrite && detail.executableMetrics && detail.fields.some(field => field.name === standardField) &&
    action(
      "standard",
      () =>
        api("/standards", {
          name: standardName,
          code: standardCode,
          assetId: detail.id,
          field: standardField,
          semanticType,
          description: standardDescription,
        }),
      "数据标准已绑定当前字段",
    );
  const checkStandard = (id: string) =>
    canWrite && detail?.standards.some(standard => standard.id === id) && action(
      `standard-check:${id}`,
      () => api(`/standards/${id}/check`, {}),
      "标准已在实际资产行上检查",
    );

  return (
    <div className="asset-workbench-v2">
      <section className="asset-hero-v2">
        <div><span className="eyebrow">ASSET GRAPH · M4C</span><h2>资产不是登记表，而是可验证的关系网络</h2><p>目录由真实源版本、同步配置、实时状态、发布批次和数据服务关系生成；业务说明可版本化补充。</p></div>
        <div className="asset-kpis-v2"><div><strong>{catalogReady ? assets.length : "—"}</strong><span>本次检索资产</span></div><div><strong>{detailReady ? detail?.lineage.edges.length : "—"}</strong><span>所选资产血缘</span></div><div><strong>{catalogReady ? metrics.length : "—"}</strong><span>项目指标</span></div><div><strong>{catalogReady ? standards.length : "—"}</strong><span>项目标准</span></div></div>
      </section>

      <form className="asset-search-v2" onSubmit={(event) => { event.preventDefault(); search(); }}>
        <Search size={17} />
        <input aria-label="搜索数据资产" maxLength={500} placeholder="搜索业务名称、表、字段、标签，例如 market_value" value={query} onChange={(event) => setQuery(event.target.value)} />
        <select aria-label="资产类型" value={kind} onChange={(event) => setKind(event.target.value)}><option value="">全部类型</option>{assetKinds.map((item) => <option key={item} value={item}>{kindLabels[item] ?? item}</option>)}</select>
        <button className="button primary" disabled={!!busy}>{catalogRead.state === "LOADING" ? <LoaderCircle className="spin" size={15} /> : <FileSearch size={15} />}搜索</button>
        <button className="button" type="button" disabled={!!busy||catalogRead.state==="LOADING"} onClick={()=>void loadLists()}>刷新当前检索</button>
      </form>
      <p className="asset-read-scope" role="status">{catalogReady?"已应用条件":"本次读取条件"}：{catalogRead.criteria.query||"全部关键词"} · {(kindLabels[catalogRead.criteria.kind]??catalogRead.criteria.kind)||"全部类型"}。{(query.trim()!==catalogRead.criteria.query||kind!==catalogRead.criteria.kind)&&"输入框的新条件尚未应用。"}</p>
      {!catalogReady&&<section className={catalogRead.state==="ERROR"?"ingestion-feedback error":"ingestion-feedback"} role={catalogRead.state==="ERROR"?"alert":"status"} aria-label="资产目录读取状态"><div><strong>{catalogRead.state==="ERROR"?catalogRead.loginRequired?"登录后查看项目资产":"资产目录尚未确认":"正在读取当前条件的资产目录"}</strong><p>{catalogRead.state==="ERROR"?catalogRead.message:"读取完成前不显示零项或空结果。"}</p><small>详情与原问答分别核对；重读不调用模型或创建资源。</small><button className="button" disabled={!!busy||catalogRead.state==="LOADING"} onClick={()=>void loadLists()}>重新读取资产目录</button></div></section>}

      {(notice || error) && <div className={error ? "ingestion-feedback error" : "ingestion-feedback"} role={error ? "alert" : "status"}>{error ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}{error || notice}</div>}
      {initialAnnotation.state==='INVALID'&&<div className="ingestion-feedback error" role="alert">标注恢复链接不完整；可读取资产，本页不创建另一个标注请求。请使用原完整恢复链接。</div>}
      {annotationPending&&<section className="asset-annotation-recovery" aria-label="标注请求恢复" role="status"><strong>原标注结果待核对</strong><p>资产：{annotationPending.assetId}<br/>请求：{annotationPending.requestId}</p><small>只读核对原请求；恢复链接不含标注正文。正文不在本页时仅能查询，不能重发。</small><div><button className="button" disabled={!!busy} onClick={()=>void recoverAnnotation()}>核对原标注请求</button><button className="button" disabled={!!busy||!originalCanWrite||!annotationSubmission.current?.controller.snapshot().canRetry} onClick={()=>void recoverAnnotation(true)}>按原内容和编号重试</button><a className="button" target="_blank" rel="noreferrer" href={annotationRecoveryLocation(typeof location==='undefined'?'http://localhost/v2/':location.href,annotationPending.assetId,annotationPending.requestId).href}>原请求恢复链接</a></div></section>}
      {annotationResult&&<section className="asset-annotation-receipt" aria-label="原标注回执"><strong>{annotationResult.receipt.outcome==='APPLIED'?`原请求已应用为说明V${annotationResult.receipt.annotation?.revision}`:'原请求被拒绝，没有新增标注版本'}</strong><p>{annotationResult.assetId} · {annotationResult.requestId}</p><small>{annotationResult.current.state==='UNAVAILABLE'?'当前资产暂不可核对，原回执保留。':annotationResult.currentMatches?'当前已读状态与原回执一致。':`当前状态已变化（说明V${annotationResult.current.revision}）；原请求结果保持不变。`}</small><small>原回执摘要：{annotationResult.receiptHash.slice(0,12)} · 不以最新详情替代原结果</small></section>}

      <section className="asset-agent-v2">
        <header><div className="asset-agent-icon-v2"><Bot size={20} /></div><div><span className="eyebrow">DATA AGENT · GROUNDED DISCOVERY</span><h3>找数据、解释口径、看下游影响</h3><p>模型只接收资产摘要、版本绑定关系和已检查的契约摘要；引用未知资产即失败，不读取业务行。</p></div></header>
        <div className="asset-agent-compose-v2"><textarea aria-label="向Data Agent询问数据资产" rows={2} readOnly={!originalCanWrite} value={agentMessage} onChange={(event) => setAgentMessage(event.target.value)} /><button className="button primary" onClick={askAgent} type="button" disabled={!originalCanWrite || !catalogReady || !!busy || pending(agentTask?.status)}>{busy === "agent" || pending(agentTask?.status) ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />}询问资产 Agent</button></div>
        {agentTask && <div className="asset-agent-answer-v2"><span className={`status-pill ${agentTask.status.toLowerCase()}`}>{statusLabels[agentTask.status] ?? agentTask.status}</span><div><small>原问题：{agentTask.message} · 不随本次检索重新生成</small><strong>{agentTask.insight?.answer ?? agentTask.error ?? "正在分析资产关系…"}</strong>{agentTask.insight?.caveats.map((item) => <p key={item}>边界：{item}</p>)}{agentTask.usage?.total_tokens && <small>{agentTask.model} · {agentTask.usage.total_tokens} Token</small>}</div><div className="asset-citations-v2">{agentTask.insight?.assetIds.map((id) => <button type="button" disabled={!!busy} key={id} onClick={() => { selectAsset(id); setTab("lineage"); }}>{id}<ChevronRight size={12} /></button>)}</div></div>}
        <small>{catalogReady?`${agentTasks.length}次受治理问答`:"问答目录尚未确认"} · 不自动修改资产</small>
      </section>

      <div className="asset-main-v2">
        <aside className="asset-catalog-v2">
          <header><div><span className="eyebrow">CATALOG</span><h3>资产目录</h3></div><span>{catalogReady?assets.length:"—"}</span></header>
          {catalogReady&&assets.map((asset) => <button disabled={!!busy} key={asset.id} className={asset.id === selectedId ? "active" : ""} onClick={() => selectAsset(asset.id)}><Database size={16} /><div><strong>{asset.businessName}</strong><code>{asset.name}</code><small>{kindLabels[asset.kind] ?? asset.kind} · {asset.fields.length}字段</small></div><span className={`status-pill ${asset.status.toLowerCase()}`}>{statusLabels[asset.status] ?? asset.status}</span></button>)}
          {!catalogReady?<div className="ingestion-empty"><FileSearch size={25}/><p>目录尚未确认，请按上方状态重新读取。</p></div>:!assets.length&&<div className="ingestion-empty"><FileSearch size={25} /><p>没有符合已应用条件的资产。</p></div>}
        </aside>
        <section className="asset-detail-v2">
          {detailRead.state==='READY'&&!detailReady&&<div className="ingestion-feedback" role="status">原标注回执已确认，当前详情尚未完成回读；请刷新所选详情，期间不保存或执行。</div>}
          {detailRead.state!=="READY"&&detailRead.state!=="EMPTY"&&<div className={detailRead.state==="ERROR"?"ingestion-feedback error":"ingestion-feedback"} role={detailRead.state==="ERROR"?"alert":"status"} aria-label="资产详情读取状态"><div><strong>{detailRead.state==="ERROR"?"资产详情尚未确认":"正在读取所选资产详情"}</strong><p>{detailRead.state==="ERROR"?detailRead.message:detailRead.id}</p>{detail&&<small>显示上次已读快照；本次读取未确认，不能保存或执行。未保存的说明保留。</small>}<button className="button" disabled={!!busy||detailRead.state==="LOADING"} onClick={()=>void reader.current?.refreshDetail()}>重新读取原资产</button></div></div>}
          {detail&&<p className="asset-read-scope">详情定位：{detail.id} · 已读说明V{detail.annotation?.revision??0}。{!catalogReady?"目录尚未确认，详情单独核对。":!assets.some(asset=>asset.id===detail.id)?"此资产不在当前检索结果中，来自原定位。":"属于当前检索结果。"}<button className="button" disabled={!!busy||detailRead.state==="LOADING"} onClick={()=>void reader.current?.refreshDetail()}>刷新所选详情</button></p>}
          {detail ? <>
            <header className="asset-detail-head-v2"><div><span className="eyebrow">{kindLabels[detail.kind] ?? detail.kind} · {detail.system}</span><h3>{detail.businessName}</h3><code>{detail.id}</code></div><div><span className={`status-pill ${detail.status.toLowerCase()}`}>{statusLabels[detail.status] ?? detail.status}</span><small>evidence {detail.evidenceHash.slice(0, 12)}</small></div></header>
            <div className="asset-tabs-v2" role="tablist" aria-label="资产详情视图">{[["overview", "概览"], ["fields", `字段 ${detail.fields.length}`], ["lineage", `血缘 ${detail.lineage.edges.length}`], ["governance", "指标、标准与契约"]].map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "active" : ""} onClick={() => setTab(id as typeof tab)}>{label}</button>)}</div>
            {tab === "overview" && <div className="asset-overview-v2">
              <div className="asset-proof-v2"><div><span>真实行数</span><strong>{detail.rowCount ?? "—"}</strong></div><div><span>业务域</span><strong>{detail.domain}</strong></div><div><span>责任人</span><strong>{detail.owner ?? "待补充"}</strong></div><div><span>说明版本</span><strong>V{detail.annotation?.revision ?? 0}</strong></div></div>
              <article className="asset-description-v2"><Layers3 size={18} /><div><strong>{detail.description}</strong><p>{detail.tags.join(" · ")}</p></div></article>
              <details className="asset-annotation-v2"><summary><Tag size={14} />编辑业务说明{draftDirty?" · 有本页草稿":""}</summary>{draftDirty&&<p role="status">本页说明草稿基于已读V{annotation?.revision}；切换资产和重读不会覆盖，尚未保存。</p>}{draftConflict&&annotation&&<div className="asset-draft-conflict" role="alert"><strong>新读取版本与草稿基线不同，先核对再保存。</strong><table><thead><tr><th>字段</th><th>草稿基线</th><th>本次读取</th><th>本页编辑</th></tr></thead><tbody>{(Object.keys(annotation.values) as (keyof AnnotationValues)[]).map(field=><tr key={field}><th>{{businessName:"业务名称",description:"说明",domain:"业务域",owner:"负责人",tagText:"标签"}[field]}</th><td>{annotation.base[field]}</td><td>{annotationValues(detail)[field]}</td><td>{annotation.values[field]}</td></tr>)}</tbody></table><button className="button" disabled={!originalCanWrite||!detailReady||!!busy} onClick={()=>{const next=rebaseAnnotation(annotation,detail);drafts.current.set(detail.id,next);setAnnotation(next);}}>审阅后沿用当前已读版本</button></div>}<div><label>业务名称<input readOnly={!originalCanWrite||busy==="annotation"} value={businessName} onChange={event=>editAnnotation("businessName",event.target.value)} /></label><label>业务域<input readOnly={!originalCanWrite||busy==="annotation"} value={domain} onChange={event=>editAnnotation("domain",event.target.value)} /></label><label>负责人<input readOnly={!originalCanWrite||busy==="annotation"} value={owner} onChange={event=>editAnnotation("owner",event.target.value)} /></label><label>标签<input readOnly={!originalCanWrite||busy==="annotation"} value={tagText} onChange={event=>editAnnotation("tagText",event.target.value)} /></label><label className="wide">说明<textarea readOnly={!originalCanWrite||busy==="annotation"} rows={2} value={description} onChange={event=>editAnnotation("description",event.target.value)} /></label><button className="button" onClick={saveAnnotation} disabled={!canWrite || !draftDirty || draftConflict || !!busy || Boolean(annotationPending) || initialAnnotation.state==='INVALID'}><Save size={14} />保存新版本</button></div></details>
            </div>}
            {tab === "fields" && <div className="asset-fields-v2"><table><thead><tr><th>#</th><th>字段</th><th>类型</th><th>可空</th><th>基数</th></tr></thead><tbody>{detail.fields.map((field, index) => <tr key={field.name}><td>{index + 1}</td><td><code>{field.name}</code></td><td>{field.type}</td><td>{field.nullable ? "是" : "否"}</td><td>{field.distinctCount ?? "—"}</td></tr>)}</tbody></table></div>}
            {tab === "lineage" && <div className="asset-lineage-v2">
              <div className="lineage-boundary-v2"><ShieldCheck size={16} /><div><strong>版本绑定与字段值来源分开展示</strong><p>同步字段映射可追溯；SQL值来源仅使用原发布批次保存并通过版本核对的分析。连接、筛选及分组的完整影响仍未覆盖。</p></div></div>
              {Boolean(detail.lineage.columnLineages?.length)&&<SqlColumnLineagePanel items={detail.lineage.columnLineages!} onSource={table=>{selectAsset(`fixture:${table}`);setTab('fields');}}/>}
              <div className="lineage-edges-v2">{detail.lineage.edges.map((edge) => <article key={edge.id}><div><span>{kindLabels[nodeById.get(edge.from)?.kind ?? ""] ?? nodeById.get(edge.from)?.kind}</span><strong>{nodeById.get(edge.from)?.businessName ?? edge.from}</strong><code>{edge.from}</code></div><div className="lineage-arrow-v2"><span>{edge.type}</span><ArrowRight size={21} /><small>{edge.fieldMappings.length}字段映射</small></div><div><span>{kindLabels[nodeById.get(edge.to)?.kind ?? ""] ?? nodeById.get(edge.to)?.kind}</span><strong>{nodeById.get(edge.to)?.businessName ?? edge.to}</strong><code>{edge.to}</code></div></article>)}</div>
            </div>}
            {tab === "governance" && <div className="asset-governance-v2">
              {!detail.executableMetrics && <div className="lineage-boundary-v2"><AlertTriangle size={16} /><div><strong>该资产首版只读</strong><p>指标与标准执行目前只对有实际本机行数据的落地表和实时状态表开放。</p></div></div>}
              <div className="governance-columns-v2">
                <section><header><div><Gauge size={17} /><h4>指标定义</h4></div><span>{detail.metrics.length}</span></header>{detail.metrics.map((metric) => <article key={metric.id}><div><strong>{metric.name}</strong><code>{metric.aggregation}({metric.field ?? "*"}){metric.groupBy ? ` BY ${metric.groupBy}` : ""}</code><p>{metric.definition}</p></div><button className="button" onClick={() => runMetric(metric.id)} disabled={!canWrite || !!busy}><Play size={13} />执行</button>{metric.runs[0] && <div className="governance-result-v2"><CheckCircle2 size={13} />{metric.runs[0].values.map((value) => `${value.group}:${value.value}`).join(" · ")}</div>}</article>)}{detail.executableMetrics && <details><summary>新建指标</summary><div className="governance-form-v2"><label>名称<input value={metricName} onChange={(event) => setMetricName(event.target.value)} /></label><label>代码<input value={metricCode} onChange={(event) => setMetricCode(event.target.value)} /></label><label>聚合<select value={aggregation} onChange={(event) => setAggregation(event.target.value)}><option>SUM</option><option>COUNT_DISTINCT</option><option>COUNT_ROWS</option></select></label><label>字段<select value={metricField} onChange={(event) => setMetricField(event.target.value)}>{!detail.fields.some(field=>field.name===metricField)&&<option value={metricField}>原字段待重新选择：{metricField||"未选择"}</option>}{detail.fields.map((field) => <option key={field.name}>{field.name}</option>)}</select></label><label>分组<select value={groupBy} onChange={(event) => setGroupBy(event.target.value)}><option value="">不分组</option>{groupBy&&!detail.fields.some(field=>field.name===groupBy)&&<option value={groupBy}>原分组待重新选择：{groupBy}</option>}{detail.fields.map((field) => <option key={field.name}>{field.name}</option>)}</select></label><label className="wide">口径<input value={metricDefinition} onChange={(event) => setMetricDefinition(event.target.value)} /></label><button className="button" onClick={createMetric} disabled={!canWrite || !metricFieldsValid || !!busy}><Sparkles size={13} />创建指标</button></div></details>}</section>
                <section><header><div><ShieldCheck size={17} /><h4>数据标准</h4></div><span>{detail.standards.length}</span></header>{detail.standards.map((standard) => <article key={standard.id}><div><strong>{standard.name}</strong><code>{standard.field} · {standard.semanticType}</code><p>{standard.description}</p></div><button className="button" onClick={() => checkStandard(standard.id)} disabled={!canWrite || !!busy}><Activity size={13} />检查</button>{standard.checks[0] && <div className={`governance-result-v2 ${standard.checks[0].status.toLowerCase()}`}>{standard.checks[0].status === "PASSED" ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}{standard.checks[0].passedCount}/{standard.checks[0].evaluatedCount}通过</div>}</article>)}{detail.executableMetrics && <details><summary>新建标准</summary><div className="governance-form-v2"><label>名称<input value={standardName} onChange={(event) => setStandardName(event.target.value)} /></label><label>代码<input value={standardCode} onChange={(event) => setStandardCode(event.target.value)} /></label><label>字段<select value={standardField} onChange={(event) => setStandardField(event.target.value)}>{!standardFieldValid&&<option value={standardField}>原字段待重新选择：{standardField||"未选择"}</option>}{detail.fields.map((field) => <option key={field.name}>{field.name}</option>)}</select></label><label>语义<select value={semanticType} onChange={(event) => setSemanticType(event.target.value)}><option>SECURITY_CODE</option><option>CLIENT_ID</option><option>DECIMAL_18_2</option><option>TRADE_DATE</option></select></label><label className="wide">说明<input value={standardDescription} onChange={(event) => setStandardDescription(event.target.value)} /></label><button className="button" onClick={createStandard} disabled={!canWrite || !standardFieldValid || !!busy}><Network size={13} />创建标准</button></div></details>}</section>
              </div>
              <ContractsPanel api={api} canWrite={canWrite} asset={detail} />
            </div>}
          </> : <div className="ingestion-empty"><Database size={26} /><p>选择一个资产查看证据。</p></div>}
        </section>
      </div>
      <footer className="asset-boundary-v2"><GitBranch size={14} />目录、血缘与数据契约来自当前版本和实际检查证据；全部数据为虚构证券样例，未连接公司目录、真实用户或公网资产。</footer>
    </div>
  );
}
