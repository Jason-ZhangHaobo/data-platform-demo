import { lazy, Suspense, useEffect, useMemo, useState, useRef } from "react";
import {QualityConfigFields} from './QualityConfigFields';
import {QualityVersionEditor} from './QualityVersionEditor';
import type {PendingQualityVersion} from './QualityVersionEditor';
import {qualityConfigDraft,qualityConfig,qualityConfigProblem,qualityVersionDraft,qualityVersionBody} from './quality-rule-config';
import type {QualityVersionDraft} from './quality-rule-config';
import {checkedQualityVersionWrite,qualityVersionRequestPath} from '../../src/v2/quality-version-request.mjs';
import { FundReportQualityLookup } from './FundReportQualityPanel';
import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronRight,
  Gauge,
  History,
  LoaderCircle,
  Play,
  RefreshCw,
  Send,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";

const QualityArchiveRun=lazy(async()=>({default:(await import("./QualityArchiveRun")).QualityArchiveRun}));
type Api = <T>(path: string, body?: unknown,options?:{idempotencyKey?:string}) => Promise<T>;
type Asset = {
  id: string;
  businessName: string;
  name: string;
  rowCount?: number;
  fields: { name: string; type: string }[];
  executableMetrics: boolean;
};
type QualityRun = {
  id: string;
  archiveSource?:{runId:string;snapshotHash:string};
  status: string;
  ruleVersionId: string;
  evaluatedCount: number;
  passedCount: number;
  failedCount: number;
  passRate: number|null;
  reasonCode?:string;
  storedStatus?:string;
  missingFieldCount?:number;
  assetEvidenceHash?:string;
  assetVersionId?:string;
  syncRunId?:string;
  metadataVersionId?:string;
  durationMs: number;
};
type QualityAlert = {
  id: string;
  status: string;
  severity: string;
  message: string;
  runId: string;
  recoveryRunId?: string;
  recoveryUnconfirmed?:boolean;
};
type RuleVersion = {
  id: string;
  versionNumber: number;
  field: string;
  type: string;
  config: Record<string, unknown>;
  description: string;
  configHash: string;
  status: string;
};
type Rule = {
  id: string;
  name: string;
  code: string;
  assetId: string;
  status: string;
  health?: string;
  sourceFreshness?:{status:string;reason:string;lastDetected?:{runId:string;status:string;versionId?:string;evidenceHash?:string;rowsHash?:string;validUntil?:string};current?:{versionId?:string;evidenceHash?:string;rowsHash?:string;rowCount:number}};
  currentVersionId: string;
  currentVersion: RuleVersion;
  versions: RuleVersion[];
  runs: QualityRun[];
  alerts: QualityAlert[];
};
type Overview = {
  scope: string;
  publicDeployed: boolean;
  rules: Rule[];
  counts: {
    rules: number;
    healthy: number;
    failed: number;
    noData?:number;
    stale?:number;unconfirmed?:number;
    runs: number;
    openAlerts: number;
    resolvedAlerts: number;
  };
};
type AgentPlan = {
  id: string;
  status: string;
  explanation?: string;
  error?: string;
  ruleId?: string;
  model?: string;
  usage?: { total_tokens?: number };
  proposal?: {
    kind: string;
    name: string;
    code: string;
    assetId: string;
    field: string;
    type: string;
    config: Record<string, unknown>;
    description: string;
  };
};

const labels: Record<string, string> = {
  HEALTHY: "健康",
  STALE:"当前数据待检测",
  FAILED: "异常",
  NO_DATA: "无数据待核验",
  PENDING:"待检测当前版本",
  UNCONFIRMED:"健康回执待核对",
  PASSED: "通过",
  ACTIVE: "生效中",
  RETIRED: "已退役",
  OPEN: "待恢复",
  RESOLVED: "已恢复",
  QUEUED: "排队中",
  RUNNING: "生成中",
  SUCCEEDED: "方案已验证",
  APPLIED: "规则草稿已创建",
};
const pending = (status?: string) =>
  status === "QUEUED" || status === "RUNNING";
const configText = (version?: RuleVersion) => {
  if (!version) return "—";
  if (version.type === "VALUE_RANGE")
    return `${version.config.min} ≤ ${version.field} ≤ ${version.config.max}`;
  if (version.type === "ALLOWED_VALUES")
    return `${version.field} ∈ ${(version.config.values as string[]).join("、")}`;
  if (version.type === "FRESHNESS_SECONDS")
    return `${version.field} 不早于检测前${version.config.maxAgeSeconds}秒`;
  return `${version.field} · ${version.type}`;
};

export function QualityWorkbench({ api, canWrite, local }: { api: Api; canWrite: boolean; local: boolean }) {
  const [overview, setOverview] = useState<Overview>(),
    [assets, setAssets] = useState<Asset[]>([]),
    [plans, setPlans] = useState<AgentPlan[]>([]),
    [selectedRuleId, setSelectedRuleId] = useState(()=>typeof location==='undefined'?'':new URL(location.href).searchParams.get('quality_rule')??'');
  const [busy, setBusy] = useState(""),
    [notice, setNotice] = useState(""),
    [error, setError] = useState("");
  const [agentMessage, setAgentMessage] = useState(
      "为证券持仓明细的security_code生成非空质量规则草稿，只生成规则，不自动执行",
    ),
    [agentPlan, setAgentPlan] = useState<AgentPlan>();
  const [name, setName] = useState("持仓市值合理范围"),
    [code, setCode] = useState("holding_value_range_review"),
    [assetId, setAssetId] = useState("landing:raw_positions"),
    [field, setField] = useState("market_value"),
    [description, setDescription] = useState("受控阈值用于验证质量失败、告警与恢复");
  const [configDraft,setConfigDraft]=useState(()=>qualityConfigDraft());
  const catalogInitialized=useRef(false);
  const [versionDrafts,setVersionDrafts]=useState<Record<string,QualityVersionDraft>>({});
  const [versionWrites,setVersionWrites]=useState<Record<string,PendingQualityVersion|undefined>>({});
  const [savedVersionReceipt,setSavedVersionReceipt]=useState<{ruleId:string;name:string;version:RuleVersion;currentVersion:number}>();
  const createConfigProblem=qualityConfigProblem(configDraft);


  const rules = overview?.rules ?? [],
    selectedRule = rules.find((rule) => rule.id === selectedRuleId),
    selectedAsset = assets.find((asset) => asset.id === assetId),
    executableAssets = useMemo(
      () => assets.filter((asset) => asset.executableMetrics),
      [assets],
    );

  const reload = async () => {
    const [nextOverview, nextAssets, nextPlans] = await Promise.all([
      api<Overview>("/quality/overview"),
      api<Asset[]>("/assets"),
      api<AgentPlan[]>("/quality/agent/plans"),
    ]);
    setOverview(nextOverview);
    setAssets(nextAssets);
    setPlans(nextPlans);
    if(!catalogInitialized.current){catalogInitialized.current=true;setAssetId(previous=>nextAssets.some(asset=>asset.id===previous&&asset.executableMetrics)?previous:nextAssets.find(asset=>asset.executableMetrics)?.id??'');}
    if (!selectedRuleId && nextOverview.rules[0])
      setSelectedRuleId(nextOverview.rules[0].id);
    if (!assetId && nextAssets.find((asset) => asset.executableMetrics))
      setAssetId(nextAssets.find((asset) => asset.executableMetrics)!.id);
    if (!agentPlan && nextPlans[0]) setAgentPlan(nextPlans[0]);
  };
  useEffect(() => {
    reload().catch((cause) => setError((cause as Error).message));
  }, []);
  useEffect(() => {
    if (!selectedAsset) return;
    const names = new Set(selectedAsset.fields.map((item) => item.name));
    if (!names.has(field)) setField(selectedAsset.fields[0]?.name ?? "");
  }, [assetId, assets.length]);
  useEffect(() => {
    if (!agentPlan || !pending(agentPlan.status)) return;
    const timer = setInterval(async () => {
      try {
        const current = await api<AgentPlan>(
          `/quality/agent/plans/${agentPlan.id}`,
        );
        setAgentPlan(current);
        if (!pending(current.status)) await reload();
      } catch (cause) {
        setError((cause as Error).message);
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [agentPlan?.id, agentPlan?.status]);

  const action = async (
    key: string,
    work: () => Promise<unknown>,
    message: string,
  ) => {
    setBusy(key);
    setError("");
    try {
      await work();
      await reload();
      setNotice(message);
    } catch (cause) {
      setError((cause as Error).message);
      await reload().catch(() => undefined);
    } finally {
      setBusy("");
    }
  };
  const createRule = () =>
    action(
      "create",
      async () => {
        const rule = await api<Rule>("/quality/rules", {
          name,
          code,
          assetId,
          field,
          type:configDraft.type,
          config: qualityConfig(configDraft),
          description,
        });
        setSelectedRuleId(rule.id);
      },
      "质量规则已绑定资产与当前配置版本，尚未运行",
    );
  const runRule = () =>
    selectedRule &&
    action(
      "run",
      () => api(`/quality/rules/${selectedRule.id}/run`, {expectedVersionId:selectedRule.currentVersionId}),
      "检测回执已保存；无数据不算通过，也不会解除原告警",
    );
  useEffect(()=>{
    const url=new URL(location.href),ruleId=url.searchParams.get('quality_rule'),requestId=url.searchParams.get('quality_version_request');if(!ruleId||!requestId)return;
    let path:string;try{if(url.searchParams.getAll('quality_rule').length!==1||url.searchParams.getAll('quality_version_request').length!==1)throw Error('保存回执编号不能重复');path=qualityVersionRequestPath(ruleId,requestId);}catch(cause){setError((cause as Error).message);return;}
    let live=true;
    void api<Rule>(path).then(value=>{if(!live)return;const receipt=(value as Rule&{versionWrite?:{versionId:string}}).versionWrite,version=value.versions.find(item=>item.id===receipt?.versionId);if(value.id!==ruleId||!version)throw Error('指定原保存回执未核对一致');setSavedVersionReceipt({ruleId:value.id,name:value.name,version,currentVersion:value.currentVersion.versionNumber});setNotice(`已读取${value.name}原保存请求的V${version.versionNumber}，请核对字段和参数；页面不会自动重新保存`);}).catch(cause=>{if(live)setError((cause as Error).message);});
    return()=>{live=false;};
  },[api]);
  const setVersionWrite=(id:string,value:PendingQualityVersion|undefined)=>setVersionWrites(previous=>({...previous,[id]:value}));
  const finishVersion=async(rule:Rule,write:PendingQualityVersion,value:Rule)=>{
    const receipt=checkedQualityVersionWrite(value,rule.id,write.body),saved=value.versions.find(version=>version.id===receipt.versionId);
    if(!saved)throw Error('原保存版本未找到');
    setSavedVersionReceipt({ruleId:rule.id,name:rule.name,version:saved,currentVersion:value.currentVersion.versionNumber});
    setVersionWrite(rule.id,undefined);setVersionDrafts(previous=>({...previous,[rule.id]:qualityVersionDraft(saved)}));
    setNotice(`${rule.name}的V${receipt.versionNumber}已保存，仍需实际检测${receipt.currentVersionId!==receipt.versionId?'；当前规则已有后续版本，请载入后审阅':''}`);
  };
  const lookupVersion=async(rule:Rule,write:PendingQualityVersion)=>{
    try{const value=await api<Rule>(qualityVersionRequestPath(rule.id,write.requestId));await finishVersion(rule,write,value);return true;}
    catch(cause){const error=cause as {code?:string;message:string};setVersionWrite(rule.id,{...write,state:error.code==='QUALITY_VERSION_REQUEST_NOT_FOUND'?'NOT_FOUND':'UNKNOWN'});setError(error.code==='QUALITY_VERSION_REQUEST_NOT_FOUND'?'尚未找到原保存回执；可按原编号重试，不会换编号重复保存':error.message);return false;}
  };
  const saveVersion=async(rule:Rule)=>{
    if(!canWrite||busy)return;
    const draft=versionDrafts[rule.id]??qualityVersionDraft(rule.currentVersion),write=versionWrites[rule.id]??{requestId:crypto.randomUUID(),body:qualityVersionBody(draft),state:'POSTING' as const};
    const receiptUrl=new URL(location.href);receiptUrl.searchParams.set('module','quality');receiptUrl.searchParams.set('quality_rule',rule.id);receiptUrl.searchParams.set('quality_version_request',write.requestId);history.replaceState(null,'',receiptUrl);
    setVersionWrite(rule.id,{...write,state:'POSTING'});setBusy('version');setError('');
    try{await finishVersion(rule,write,await api<Rule>(`/quality/rules/${rule.id}/versions`,write.body,{idempotencyKey:write.requestId}));}
    catch(cause){const error=cause as {code?:string;message:string};
      if(['QUALITY_RULE_VERSION_CHANGED','QUALITY_VERSION_BASIS_INVALID','QUALITY_FIELD_NOT_FOUND','INVALID_QUALITY_CONFIG','INVALID_QUALITY_RANGE','INVALID_ALLOWED_VALUES','INVALID_INTEGER','INVALID_DECIMAL'].includes(error.code??'')){setVersionWrite(rule.id,undefined);setError(error.message);}
      else {setVersionWrite(rule.id,{...write,state:'UNKNOWN'});await lookupVersion(rule,write);}}
    finally{await reload().catch(()=>{});setBusy('');}
  };
  const readVersion=async(rule:Rule)=>{const write=versionWrites[rule.id];if(!write||busy)return;setBusy('version-read');setError('');try{await lookupVersion(rule,write);}finally{await reload().catch(()=>{});setBusy('');}};
  const generatePlan = () =>
    action(
      "agent",
      async () => {
        const plan = await api<AgentPlan>("/quality/agent/plans", {
          message: agentMessage,
        });
        setAgentPlan(plan);
      },
      "Data Agent正在读取字段元数据和聚合质量结果",
    );
  const applyPlan = () =>
    agentPlan &&
    action(
      "apply-plan",
      async () => {
        const rule = await api<Rule>(
          `/quality/agent/plans/${agentPlan.id}/apply`,
          {},
        );
        setSelectedRuleId(rule.id);
        setAgentPlan(
          await api<AgentPlan>(`/quality/agent/plans/${agentPlan.id}`),
        );
      },
      "Agent方案已创建为规则草稿，运行数仍为0",
    );

  return (
    <div className="quality-workbench-v2">
      <section className="quality-hero-v2">
        <div><span className="eyebrow">DATA QUALITY · M4D</span><h2>让失败可重现，让修复有证据</h2><p>每次检测绑定资产摘要和规则版本；失败产生告警，校准新版本后重新检测并关联恢复。</p></div>
        <div className="quality-kpis-v2"><div><ShieldCheck size={15} /><strong>{overview?.counts.healthy ?? 0}</strong><span>当前数据已核验</span></div><div><ShieldAlert size={15} /><strong>{overview?.counts.failed ?? 0}</strong><span>异常规则</span></div><div><Activity size={15} /><strong>{overview?.counts.runs ?? 0}</strong><span>实际运行</span></div><div><AlertTriangle size={15} /><strong>{overview?.counts.openAlerts ?? 0}</strong><span>开放告警</span></div></div>
      </section>
      {(notice || error) && <div className={error ? "ingestion-feedback error" : "ingestion-feedback"} role={error ? "alert" : "status"}>{error ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}{error || notice}</div>}
      {savedVersionReceipt&&<article className="quality-version-receipt" aria-label="原版本保存回执"><header><strong>{savedVersionReceipt.name} · 原回执V{savedVersionReceipt.version.versionNumber}</strong><button className="button" onClick={()=>setSavedVersionReceipt(undefined)}>关闭回执</button></header><p>{configText(savedVersionReceipt.version)}</p><p>{savedVersionReceipt.version.description}</p><small>原保存版本V{savedVersionReceipt.version.versionNumber} · 回读时当前规则V{savedVersionReceipt.currentVersion}。本框只读，仍须实际检测，编辑按当前规则基准。</small></article>}
      {local && <FundReportQualityLookup api={api} canWrite={canWrite} />}

      {Boolean(overview?.counts.stale)&&<p className="quality-no-data-v2" role="status">{overview?.counts.stale}条规则的当前数据已变化或时效已到期，尚未重新检测；旧通过未计为当前健康。</p>}
      {Boolean(overview?.counts.unconfirmed)&&<p className="quality-no-data-v2" role="status">{overview?.counts.unconfirmed}条规则的当前来源或原检测证据未能完整核对，未计为健康；原记录保留。</p>}
      {Boolean(overview?.counts.noData)&&<p className="quality-no-data-v2" role="status">{overview?.counts.noData}条规则当前无行可核验，未恢复为健康。请先检查源同步批次和数据范围；已有告警保持原状态。</p>}
      <section className="quality-agent-v2">
        <header><div className="quality-agent-icon-v2"><Bot size={20} /></div><div><span className="eyebrow">DATA AGENT · METADATA + AGGREGATED EVIDENCE</span><h3>让 Agent 建议规则，人决定是否创建与运行</h3><p>模型只看字段元数据和失败计数，不接收业务行、无效样本或客户标识。</p></div></header>
        <div className="quality-agent-compose-v2"><textarea aria-label="向Data Agent描述质量需求" rows={2} value={agentMessage} onChange={(event) => setAgentMessage(event.target.value)} /><button className="button primary" onClick={generatePlan} disabled={!canWrite || !!busy || pending(agentPlan?.status)}>{busy === "agent" || pending(agentPlan?.status) ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />}生成规则方案</button></div>
        {agentPlan && <div className="quality-agent-result-v2"><span className={`status-pill ${agentPlan.status.toLowerCase()}`}>{labels[agentPlan.status] ?? agentPlan.status}</span><div><strong>{agentPlan.proposal?.name ?? "正在分析字段与质量摘要"}</strong><p>{agentPlan.explanation ?? agentPlan.error ?? "生成中…"}</p>{agentPlan.proposal && <code>{agentPlan.proposal.type} · {agentPlan.proposal.assetId}.{agentPlan.proposal.field}</code>}</div><button className="button" onClick={applyPlan} disabled={!canWrite || !!busy || agentPlan.status !== "SUCCEEDED"}><CheckCircle2 size={14} />确认创建规则</button></div>}
        <small>{plans.length}条Agent方案 · 创建后不自动运行或解除告警</small>
      </section>

      <div className="quality-main-v2">
        <aside className="quality-rule-list-v2">
          <header><div><span className="eyebrow">RULES</span><h3>质量规则</h3></div><span>{rules.length}</span></header>
          {rules.map((rule) => <button key={rule.id} className={rule.id === selectedRuleId ? "active" : ""} onClick={() => setSelectedRuleId(rule.id)}><Gauge size={16} /><div><strong>{rule.name}</strong><code>{rule.currentVersion.type} · {rule.currentVersion.field}</code></div><span className={`status-pill ${(rule.health ?? rule.status).toLowerCase()}`}>{labels[rule.health ?? rule.status] ?? rule.health ?? rule.status}</span><ChevronRight size={13} /></button>)}
          {!rules.length && <div className="ingestion-empty"><Gauge size={25} /><p>创建第一条实际质量规则。</p></div>}
        </aside>
        <section className="quality-detail-v2">
          {selectedRule ? <>
            <header><div><span className="eyebrow">{selectedRule.code} · V{selectedRule.currentVersion.versionNumber}</span><h3>{selectedRule.name}</h3><p>{selectedRule.assetId}</p></div><button className="button primary" onClick={runRule} disabled={!canWrite || !!busy}>{busy === "run" ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}实际检测当前表</button></header>
            <div className="quality-proof-v2"><div><span>本次读取状态</span><strong>{labels[selectedRule.health ?? selectedRule.status] ?? selectedRule.health ?? selectedRule.status}</strong></div><div><span>规则表达</span><strong>{configText(selectedRule.currentVersion)}</strong></div><div><span>版本</span><strong>{selectedRule.versions.length}</strong></div><div><span>检测</span><strong>{selectedRule.runs.length}</strong></div><div><span>开放告警</span><strong>{selectedRule.alerts.filter((item) => item.status === "OPEN").length}</strong></div></div>
            {selectedRule.sourceFreshness&&<section className={"quality-current-evidence "+(selectedRule.health==='STALE'||selectedRule.health==='UNCONFIRMED'?'pending':'')} aria-label="当前质量证据"><header><div><strong>{selectedRule.sourceFreshness.status==='MATCHED'?'本次读取的数据与原检测一致':'当前证据核对'}</strong><p>{selectedRule.sourceFreshness.reason}</p></div><button className="button" disabled={!!busy} onClick={()=>void reload().catch(cause=>setError((cause as Error).message))}>重读当前数据状态</button></header>
              {selectedRule.sourceFreshness.lastDetected&&<p>原检测结论：{labels[selectedRule.sourceFreshness.lastDetected.status]??selectedRule.sourceFreshness.lastDetected.status} · 批次 {selectedRule.sourceFreshness.lastDetected.versionId?.slice(0,8)??'未记录'}{selectedRule.sourceFreshness.current?.versionId&&<> · 当前批次 {selectedRule.sourceFreshness.current.versionId.slice(0,8)}</>}</p>}
              {selectedRule.sourceFreshness.lastDetected?.validUntil&&<small>时效证据有效至 {new Date(selectedRule.sourceFreshness.lastDetected.validUntil).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})} 北京时间</small>}
              <details><summary>核对原检测和当前来源</summary><p>原检测编号 {selectedRule.sourceFreshness.lastDetected?.runId??'尚无检测'}<br/>原数据摘要 {selectedRule.sourceFreshness.lastDetected?.evidenceHash??'未记录'}<br/>当前数据摘要 {selectedRule.sourceFreshness.current?.evidenceHash??'未确认'}<br/>原实际行摘要 {selectedRule.sourceFreshness.lastDetected?.rowsHash??'未记录'}<br/>当前实际行摘要 {selectedRule.sourceFreshness.current?.rowsHash??'未确认'}</p></details></section>}
            {selectedRule.alerts[0] && <div className={`quality-alert-v2 ${selectedRule.alerts[0].status.toLowerCase()}`}>{selectedRule.alerts[0].status === "OPEN" ? <AlertTriangle size={17} /> : <CheckCircle2 size={17} />}<div><strong>{selectedRule.alerts[0].message}</strong><p>{selectedRule.alerts[0].recoveryUnconfirmed?"原恢复回执没有非空通过证据，当前按待恢复处理":selectedRule.alerts[0].status === "OPEN" ? `失败批次 ${selectedRule.alerts[0].runId.slice(0, 8)}` : `恢复批次 ${selectedRule.alerts[0].recoveryRunId?.slice(0, 8)}`}</p></div><span>{selectedRule.alerts[0].status==="RESOLVED"&&selectedRule.sourceFreshness?.status!=="MATCHED"?"原批次已恢复":labels[selectedRule.alerts[0].status]}</span></div>}
            {local&&<Suspense fallback={<p role="status">正在读取原批次复检…</p>}><QualityArchiveRun key={selectedRule.id} api={api} ruleId={selectedRule.id} versionId={selectedRule.currentVersionId} versionNumber={selectedRule.currentVersion.versionNumber} canWrite={canWrite&&!busy} onSaved={reload}/></Suspense>}
            <div className="quality-evidence-v2">
              <section><header><div><History size={15} /><h4>运行历史</h4></div><span>{selectedRule.runs.length}</span></header>{selectedRule.runs.map((run) => <article key={run.id}><span className={`status-pill ${run.status.toLowerCase()}`}>{labels[run.status] ?? run.status}</span><code>{run.id.slice(0, 8)}</code><div><strong>{run.status==='NO_DATA'?'无数据，未给出通过率':run.status==='UNCONFIRMED'?'回执待核对，未确认通过':`${run.passedCount}/${run.evaluatedCount}通过`}</strong><p>{run.status==='NO_DATA'?'请检查数据范围；未解除原告警':run.status==='UNCONFIRMED'?'未计为健康或告警恢复依据':`失败${run.failedCount} · ${run.passRate===null?'通过率待核对':(run.passRate*100).toFixed(1)+'%'} · ${run.durationMs}ms`}</p>
                {Boolean(run.missingFieldCount)&&<p>有{run.missingFieldCount}行缺少检测字段，按未通过处理。</p>}
                {run.reasonCode==='QUALITY_LEGACY_EMPTY_PASS'&&<p>原回执记录通过，但检测行数为0；历史原值保留，不作为恢复证据。</p>}
                {run.reasonCode==='QUALITY_PASS_UNPROVEN'&&<p>原通过回执的执行或计数待核对，未计为健康或恢复依据。</p>}
                <small>{run.archiveSource?"历史复检（不更新当前健康） · ":"当前表检测 · "}规则V{selectedRule.versions.find(version=>version.id===run.ruleVersionId)?.versionNumber??'待核对'} · {run.syncRunId?`同步批次 ${run.syncRunId.slice(0,8)}`:'未记录已核对的同步批次'} · 数据摘要 {run.assetEvidenceHash?.slice(0,12)??'未记录'}</small></div></article>)}</section>
              <section><header><div><RefreshCw size={15} /><h4>版本历史</h4></div><span>{selectedRule.versions.length}</span></header>{selectedRule.versions.map((version) => <article key={version.id}><span className={`status-pill ${version.status.toLowerCase()}`}>V{version.versionNumber}</span><div><strong>{configText(version)}</strong><p>{version.description}</p><code>{version.configHash.slice(0, 12)}</code></div></article>)}</section>
            </div>
            <QualityVersionEditor key={selectedRule.id} current={selectedRule.currentVersion} fields={assets.find(asset=>asset.id===selectedRule.assetId)?.fields.map(field=>field.name)??[]}
              captured={Boolean(versionDrafts[selectedRule.id])} draft={versionDrafts[selectedRule.id]??qualityVersionDraft(selectedRule.currentVersion)} canWrite={canWrite} busy={Boolean(busy)} pending={versionWrites[selectedRule.id]}
              onChange={draft=>setVersionDrafts(previous=>({...previous,[selectedRule.id]:draft}))}
              onLoadCurrent={()=>{setError('');setNotice(`已载入${selectedRule.name}的当前V${selectedRule.currentVersion.versionNumber}，请重新审阅后保存`);if(versionWrites[selectedRule.id]?.state==='NOT_FOUND')setVersionWrite(selectedRule.id,undefined);setVersionDrafts(previous=>({...previous,[selectedRule.id]:qualityVersionDraft(selectedRule.currentVersion)}));}}
              onSave={()=>void saveVersion(selectedRule)} onLookup={()=>void readVersion(selectedRule)} onRefresh={()=>void reload().catch(cause=>setError((cause as Error).message))}/>

          </> : <div className="ingestion-empty"><Gauge size={26} /><p>创建或选择质量规则。</p></div>}
        </section>
      </div>

      <section className="quality-create-v2">
        <header><div><span className="eyebrow">MANUAL RULE</span><h3>手动创建规则</h3></div><SlidersHorizontal size={19} /></header>
        <div><label>规则名称<input value={name} onChange={(event) => setName(event.target.value)} /></label><label>规则代码<input value={code} onChange={(event) => setCode(event.target.value)} /></label><label>实际资产<select value={assetId} onChange={(event) => {setAssetId(event.target.value);setField(assets.find(asset=>asset.id===event.target.value)?.fields[0]?.name??'');}}>{assetId&&!selectedAsset&&<option value={assetId}>原资产暂不可读，请重新选择</option>}{executableAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.businessName} · {asset.rowCount ?? 0}行</option>)}</select></label><label>字段<select value={field} onChange={(event) => setField(event.target.value)}>{selectedAsset?.fields.map((item) => <option key={item.name}>{item.name}</option>)}</select></label><QualityConfigFields draft={configDraft} prefix="新规则" disabled={!canWrite||Boolean(busy)} onChange={setConfigDraft}/><label className="wide">规则说明<input value={description} onChange={(event) => setDescription(event.target.value)} /></label></div>
        <footer><span>{createConfigProblem||(!selectedAsset?'请选择可读取的实际资产':!selectedAsset.fields.some(item=>item.name===field)?'原字段已不在当前资产中，请重新选择':'创建只保存规则V1；必须显式点击“实际检测”才会读取资产行。')}</span><button className="button" onClick={createRule} disabled={!canWrite || !selectedAsset || !selectedAsset.fields.some(item=>item.name===field) || Boolean(createConfigProblem) || !field || !!busy}><ShieldCheck size={14} />创建规则草稿</button></footer>
      </section>
      <footer className="quality-boundary-v2"><ShieldAlert size={14} />当前只检测本机合成落地/实时状态行；不是公司生产质量中心，未连接公网告警渠道。</footer>
    </div>
  );
}
