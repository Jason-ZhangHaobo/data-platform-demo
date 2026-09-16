import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronRight,
  Clock3,
  Eye,
  EyeOff,
  FileCheck2,
  Fingerprint,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  Send,
  ShieldCheck,
  UserCheck,
  Users,
} from "lucide-react";

type Api = <T>(
  path: string,
  body?: unknown,
  options?: { actorId?: string },
) => Promise<T>;
type Persona = {
  id: string;
  displayName: string;
  role: string;
  advisorId?: string;
  authentication: string;
};
type Asset = {
  id: string;
  businessName: string;
  rowCount?: number;
  executableMetrics: boolean;
  fields: { name: string; type: string }[];
};
type PolicyVersion = {
  id: string;
  versionNumber: number;
  roles: string[];
  rowScope: string;
  defaultAction: string;
  fieldActions: Record<string, string>;
  description: string;
  configHash: string;
  status: string;
};
type Policy = {
  id: string;
  name: string;
  code: string;
  assetId: string;
  status: string;
  currentVersion: PolicyVersion;
  versions: PolicyVersion[];
};
type AccessRequest = {
  id: string;
  requesterId: string;
  requesterRole: string;
  assetId: string;
  scope: string;
  reason: string;
  status: string;
  grantId?: string;
};
type Audit = {
  id: string;
  actorId: string;
  action: string;
  assetId?: string;
  decision: string;
  rowCount?: number;
  maskedFields?: string[];
  policyVersionId?: string;
  grantId?: string;
  containsRowData: boolean;
};
type Overview = {
  scope: string;
  publicAuthentication: boolean;
  personas: Persona[];
  policies: Policy[];
  requests: AccessRequest[];
  counts: {
    policies: number;
    pendingRequests: number;
    activeGrants: number;
    allowAudits: number;
    denyAudits: number;
  };
  recentAudits: Audit[];
};
type QueryResult = {
  actor: Persona;
  assetId: string;
  decision: string;
  policyId?: string;
  policyVersionId?: string;
  grantId?: string;
  rowScope: string;
  columns: string[];
  maskedFields: string[];
  rowCount: number;
  rows: Record<string, unknown>[];
  auditId: string;
  authentication: string;
  publicEnforced: boolean;
};
type AgentPlan = {
  id: string;
  status: string;
  explanation?: string;
  error?: string;
  policyId?: string;
  model?: string;
  usage?: { total_tokens?: number };
  proposal?: {
    name: string;
    code: string;
    assetId: string;
    roles: string[];
    rowScope: string;
    fieldActions: Record<string, string>;
    defaultAction: string;
  };
};

const labels: Record<string, string> = {
  ACTIVE: "生效中",
  RETIRED: "已退役",
  PENDING: "待审批",
  APPROVED: "已批准",
  REJECTED: "已拒绝",
  ALLOW: "允许",
  DENY: "拒绝",
  QUEUED: "排队中",
  RUNNING: "生成中",
  SUCCEEDED: "方案已验证",
  APPLIED: "策略已创建",
};
const actionLabels: Record<string, string> = {
  ALLOW: "明文",
  MASK_PARTIAL: "部分脱敏",
  MASK_FULL: "全量遮盖",
  HASH: "哈希",
  DENY: "不可见",
};
const roleLabels: Record<string, string> = {
  WEALTH_ADVISOR: "财富顾问",
  DATA_ENGINEER: "数据开发工程师",
  AUDITOR: "审计员",
  DATA_OWNER: "数据负责人",
};
const pending = (status?: string) =>
  status === "QUEUED" || status === "RUNNING";

export function SecurityWorkbench({ api, canWrite }: { api: Api; canWrite: boolean }) {
  const [overview, setOverview] = useState<Overview>(),
    [assets, setAssets] = useState<Asset[]>([]),
    [plans, setPlans] = useState<AgentPlan[]>([]),
    [selectedPolicyId, setSelectedPolicyId] = useState("");
  const [actorId, setActorId] = useState("user-wealth-advisor"),
    [assetId, setAssetId] = useState("landing:raw_positions"),
    [queryResult, setQueryResult] = useState<QueryResult>();
  const [busy, setBusy] = useState(""),
    [notice, setNotice] = useState(""),
    [error, setError] = useState("");
  const [requestReason, setRequestReason] = useState("核对本机虚构证券安全与脱敏流程"),
    [requestScope, setRequestScope] = useState("READ_MASKED");
  const [policyName, setPolicyName] = useState("财富顾问持仓最小权限"),
    [policyCode, setPolicyCode] = useState("advisor_positions_review"),
    [policyRole, setPolicyRole] = useState("WEALTH_ADVISOR"),
    [rowScope, setRowScope] = useState("ADVISOR_CLIENTS"),
    [policyDescription, setPolicyDescription] = useState("财富顾问只看名下虚构客户，客户号和持仓号脱敏");
  const [agentMessage, setAgentMessage] = useState(
      "为数据开发工程师访问证券持仓明细生成最小权限策略草稿，客户号部分脱敏，其他分析字段可读，不自动查询或审批",
    ),
    [agentPlan, setAgentPlan] = useState<AgentPlan>();

  const policies = overview?.policies ?? [],
    requests = overview?.requests ?? [],
    selectedPolicy = policies.find((policy) => policy.id === selectedPolicyId),
    selectedAsset = assets.find((asset) => asset.id === assetId),
    executableAssets = useMemo(
      () => assets.filter((asset) => asset.executableMetrics),
      [assets],
    ),
    personas = overview?.personas ?? [];

  const reload = async () => {
    const [nextOverview, nextAssets, nextPlans] = await Promise.all([
      api<Overview>("/security/overview"),
      api<Asset[]>("/assets"),
      api<AgentPlan[]>("/security/agent/plans"),
    ]);
    setOverview(nextOverview);
    setAssets(nextAssets);
    setPlans(nextPlans);
    if (!selectedPolicyId && nextOverview.policies[0])
      setSelectedPolicyId(nextOverview.policies[0].id);
    if (!assetId && nextAssets.find((asset) => asset.executableMetrics))
      setAssetId(nextAssets.find((asset) => asset.executableMetrics)!.id);
    if (!agentPlan && nextPlans[0]) setAgentPlan(nextPlans[0]);
  };
  useEffect(() => {
    reload().catch((cause) => setError((cause as Error).message));
  }, []);
  useEffect(() => {
    setQueryResult(undefined);
  }, [actorId, assetId]);
  useEffect(() => {
    if (!agentPlan || !pending(agentPlan.status)) return;
    const timer = setInterval(async () => {
      try {
        const current = await api<AgentPlan>(
          `/security/agent/plans/${agentPlan.id}`,
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
  const preview = () =>
    action(
      "query",
      async () => {
        setQueryResult(
          await api<QueryResult>(
            `/security/query/${encodeURIComponent(assetId)}`,
            {},
            { actorId },
          ),
        );
      },
      "策略已在实际资产行上执行，审计记录已保存",
    );
  const requestAccess = () =>
    action(
      "request",
      () =>
        api(
          "/security/requests",
          { assetId, scope: requestScope, reason: requestReason },
          { actorId },
        ),
      "权限申请已提交，尚未获得访问权",
    );
  const review = (requestId: string, decision: "APPROVE" | "REJECT") =>
    action(
      `review:${requestId}`,
      () =>
        api(
          `/security/requests/${requestId}/review`,
          {
            decision,
            durationHours: 24,
            reviewNote:
              decision === "APPROVE"
                ? "仅限本机合成证券验收，有效24小时"
                : "当前不满足最小权限要求",
          },
          { actorId: "user-data-owner" },
        ),
      decision === "APPROVE" ? "数据负责人已批准临时授权" : "数据负责人已拒绝申请",
    );
  const fieldActions = () =>
    Object.fromEntries(
      (selectedAsset?.fields ?? []).map((field) => [
        field.name,
        field.name === "position_id"
          ? "MASK_FULL"
          : field.name === "client_id"
            ? "MASK_PARTIAL"
            : "ALLOW",
      ]),
    );
  const createPolicy = () =>
    action(
      "policy",
      async () => {
        const policy = await api<Policy>("/security/policies", {
          name: policyName,
          code: policyCode,
          assetId,
          roles: [policyRole],
          rowScope,
          defaultAction: "DENY",
          fieldActions: fieldActions(),
          description: policyDescription,
        });
        setSelectedPolicyId(policy.id);
      },
      "安全策略V1已保存，尚未执行查询",
    );
  const generatePlan = () =>
    action(
      "agent",
      async () => {
        const plan = await api<AgentPlan>("/security/agent/plans", {
          message: agentMessage,
        });
        setAgentPlan(plan);
      },
      "Data Agent正在基于合成身份和字段元数据设计最小权限",
    );
  const applyPlan = () =>
    agentPlan &&
    action(
      "apply-plan",
      async () => {
        const policy = await api<Policy>(
          `/security/agent/plans/${agentPlan.id}/apply`,
          {},
        );
        setSelectedPolicyId(policy.id);
        setAgentPlan(
          await api<AgentPlan>(`/security/agent/plans/${agentPlan.id}`),
        );
      },
      "Agent方案已创建为策略V1，没有执行查询或审批",
    );

  return (
    <div className="security-workbench-v2">
      <section className="security-hero-v2">
        <div><span className="eyebrow">DATA SECURITY · M4E</span><h2>先验证“谁能看什么”，再展示数据</h2><p>本机策略引擎真实执行行级范围、列动作和脱敏；每次允许或拒绝都记录不含业务行的审计。</p></div>
        <div className="security-kpis-v2"><div><ShieldCheck size={15} /><strong>{overview?.counts.policies ?? 0}</strong><span>生效策略</span></div><div><Clock3 size={15} /><strong>{overview?.counts.pendingRequests ?? 0}</strong><span>待审批</span></div><div><KeyRound size={15} /><strong>{overview?.counts.activeGrants ?? 0}</strong><span>临时授权</span></div><div><FileCheck2 size={15} /><strong>{(overview?.counts.allowAudits ?? 0) + (overview?.counts.denyAudits ?? 0)}</strong><span>查询审计</span></div></div>
      </section>
      <div className="security-local-boundary-v2"><AlertTriangle size={16} /><div><strong>这是本机合成身份，不是公网登录</strong><p><code>X-Actor-Id</code>只用于验证策略语义；邀请制认证、会话防伪和跨用户隔离仍在公网里程碑。</p></div></div>
      {(notice || error) && <div className={error ? "ingestion-feedback error" : "ingestion-feedback"} role={error ? "alert" : "status"}>{error ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}{error || notice}</div>}

      <section className="security-agent-v2">
        <header><div className="security-agent-icon-v2"><Bot size={20} /></div><div><span className="eyebrow">DATA AGENT · LEAST PRIVILEGE</span><h3>让 Agent 起草策略，后端验证每个角色、资产和字段</h3><p>模型不读取业务行，不执行查询，不批准权限，也不能把本机身份说成公网认证。</p></div></header>
        <div className="security-agent-compose-v2"><textarea aria-label="向Data Agent描述安全策略" rows={2} value={agentMessage} onChange={(event) => setAgentMessage(event.target.value)} /><button className="button primary" onClick={generatePlan} disabled={!canWrite || !!busy || pending(agentPlan?.status)}>{busy === "agent" || pending(agentPlan?.status) ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />}生成最小权限方案</button></div>
        {agentPlan && <div className="security-agent-result-v2"><span className={`status-pill ${agentPlan.status.toLowerCase()}`}>{labels[agentPlan.status] ?? agentPlan.status}</span><div><strong>{agentPlan.proposal?.name ?? "正在检查角色和字段边界"}</strong><p>{agentPlan.explanation ?? agentPlan.error ?? "生成中…"}</p>{agentPlan.proposal && <code>{agentPlan.proposal.roles.join("+")} · {agentPlan.proposal.rowScope} · {Object.keys(agentPlan.proposal.fieldActions).length}字段</code>}</div><button className="button" onClick={applyPlan} disabled={!canWrite || !!busy || agentPlan.status !== "SUCCEEDED"}><CheckCircle2 size={14} />确认创建策略</button></div>}
        <small>{plans.length}条Agent方案 · 创建策略后仍需选择身份实际验证</small>
      </section>

      <div className="security-main-v2">
        <aside className="security-policy-list-v2">
          <header><div><span className="eyebrow">POLICIES</span><h3>安全策略</h3></div><span>{policies.length}</span></header>
          {policies.map((policy) => <button key={policy.id} className={policy.id === selectedPolicyId ? "active" : ""} onClick={() => setSelectedPolicyId(policy.id)}><LockKeyhole size={16} /><div><strong>{policy.name}</strong><code>{policy.currentVersion.roles.join("+")} · {policy.currentVersion.rowScope}</code></div><span className="status-pill active">V{policy.currentVersion.versionNumber}</span><ChevronRight size={13} /></button>)}
          {!policies.length && <div className="ingestion-empty"><LockKeyhole size={25} /><p>创建第一条最小权限策略。</p></div>}
        </aside>
        <section className="security-simulator-v2">
          <header><div><span className="eyebrow">POLICY SIMULATOR · ACTUAL ROWS</span><h3>身份视角预览</h3></div><Fingerprint size={19} /></header>
          <div className="security-selector-v2"><label>虚构身份<select value={actorId} onChange={(event) => setActorId(event.target.value)}>{personas.map((persona) => <option key={persona.id} value={persona.id}>{persona.displayName} · {roleLabels[persona.role]}</option>)}</select></label><label>实际资产<select value={assetId} onChange={(event) => setAssetId(event.target.value)}>{executableAssets.map((asset) => <option key={asset.id} value={asset.id}>{asset.businessName} · {asset.rowCount ?? 0}行</option>)}</select></label><button className="button primary" onClick={preview} disabled={!canWrite || !!busy}>{busy === "query" ? <LoaderCircle className="spin" size={15} /> : <Eye size={15} />}执行安全查询</button></div>
          {queryResult ? <>
            <div className="security-query-proof-v2"><div><span>决策</span><strong>允许</strong></div><div><span>行范围</span><strong>{queryResult.rowScope}</strong></div><div><span>返回行</span><strong>{queryResult.rowCount}</strong></div><div><span>脱敏字段</span><strong>{queryResult.maskedFields.length}</strong></div><div><span>凭据</span><strong>{queryResult.policyVersionId ? "策略版本" : "临时授权"}</strong></div></div>
            <div className="security-table-v2"><table><thead><tr>{queryResult.columns.map((column) => <th key={column}>{column}{queryResult.maskedFields.includes(column) && <EyeOff size={11} />}</th>)}</tr></thead><tbody>{queryResult.rows.map((row, index) => <tr key={index}>{queryResult.columns.map((column) => <td key={column}>{String(row[column] ?? "NULL")}</td>)}</tr>)}</tbody></table></div>
            <small className="security-audit-line-v2">审计 {queryResult.auditId.slice(0, 8)} · publicEnforced=false · 不保存业务行</small>
          </> : <div className="security-empty-v2"><Eye size={23} /><strong>选择身份后执行</strong><p>无策略时会拒绝并留审计；不会默认回退为明文访问。</p></div>}
        </section>
      </div>

      {selectedPolicy && <section className="security-policy-detail-v2"><header><div><span className="eyebrow">{selectedPolicy.code} · VERSION {selectedPolicy.currentVersion.versionNumber}</span><h3>{selectedPolicy.name}</h3><p>{selectedPolicy.currentVersion.description}</p></div><span className="status-pill active">{labels[selectedPolicy.status] ?? selectedPolicy.status}</span></header><div className="security-policy-proof-v2"><div><span>资产</span><code>{selectedPolicy.assetId}</code></div><div><span>角色</span><strong>{selectedPolicy.currentVersion.roles.map((role) => roleLabels[role] ?? role).join("、")}</strong></div><div><span>行范围</span><strong>{selectedPolicy.currentVersion.rowScope}</strong></div><div><span>默认动作</span><strong>{actionLabels[selectedPolicy.currentVersion.defaultAction]}</strong></div><div><span>配置摘要</span><code>{selectedPolicy.currentVersion.configHash.slice(0, 12)}</code></div></div><div className="security-field-actions-v2">{Object.entries(selectedPolicy.currentVersion.fieldActions).map(([fieldName, action]) => <div key={fieldName}><code>{fieldName}</code><span>{actionLabels[action] ?? action}</span></div>)}</div></section>}

      <div className="security-lower-v2">
        <section className="security-requests-v2"><header><div><Users size={17} /><h3>权限申请</h3></div><span>{requests.length}</span></header><div className="security-request-create-v2"><label>申请身份<select value={actorId} onChange={(event) => setActorId(event.target.value)}>{personas.filter((persona) => persona.role !== "DATA_OWNER").map((persona) => <option key={persona.id} value={persona.id}>{persona.displayName}</option>)}</select></label><label>范围<select value={requestScope} onChange={(event) => setRequestScope(event.target.value)}><option>READ_MASKED</option><option>READ_FULL</option></select></label><label className="wide">理由<input value={requestReason} onChange={(event) => setRequestReason(event.target.value)} /></label><button className="button" onClick={requestAccess} disabled={!canWrite || !!busy}><KeyRound size={13} />提交申请</button></div>{requests.map((request) => <article key={request.id}><span className={`status-pill ${request.status.toLowerCase()}`}>{labels[request.status] ?? request.status}</span><div><strong>{request.requesterId} · {request.scope}</strong><p>{request.reason}</p><code>{request.assetId}</code></div>{request.status === "PENDING" && <div><button className="button" onClick={() => review(request.id, "REJECT")} disabled={!canWrite || !!busy}>拒绝</button><button className="button primary" onClick={() => review(request.id, "APPROVE")} disabled={!canWrite || !!busy}><UserCheck size={13} />批准24h</button></div>}</article>)}</section>
        <section className="security-audits-v2"><header><div><FileCheck2 size={17} /><h3>安全审计</h3></div><span>{overview?.recentAudits.length ?? 0}</span></header>{overview?.recentAudits.slice(0, 8).map((audit) => <article key={audit.id}><span className={`status-pill ${audit.decision.toLowerCase()}`}>{labels[audit.decision] ?? audit.decision}</span><div><strong>{audit.action} · {audit.actorId}</strong><p>{audit.assetId ?? "—"} · {audit.rowCount ?? 0}行 · 脱敏{audit.maskedFields?.length ?? 0}字段</p></div><code>{audit.id.slice(0, 8)}</code></article>)}</section>
      </div>

      <details className="security-create-policy-v2"><summary><ShieldCheck size={14} />手动创建最小权限策略</summary><div><label>名称<input value={policyName} onChange={(event) => setPolicyName(event.target.value)} /></label><label>代码<input value={policyCode} onChange={(event) => setPolicyCode(event.target.value)} /></label><label>角色<select value={policyRole} onChange={(event) => { setPolicyRole(event.target.value); setRowScope(event.target.value === "WEALTH_ADVISOR" ? "ADVISOR_CLIENTS" : "ALL"); }}>{personas.map((persona) => <option key={persona.role} value={persona.role}>{roleLabels[persona.role]}</option>)}</select></label><label>行范围<select value={rowScope} onChange={(event) => setRowScope(event.target.value)}><option>ADVISOR_CLIENTS</option><option>ALL</option><option>DENY</option></select></label><label className="wide">说明<input value={policyDescription} onChange={(event) => setPolicyDescription(event.target.value)} /></label><button className="button" onClick={createPolicy} disabled={!canWrite || !!busy}><LockKeyhole size={13} />创建策略V1</button></div><small>默认：position_id全遮盖、client_id部分脱敏、其余已登记字段允许；未声明字段拒绝。</small></details>
      <footer className="security-boundary-v2"><LockKeyhole size={14} />本机合成身份与策略语义已真实执行；公网邀请登录、会话认证、跨项目隔离和企业IAM仍未实现。</footer>
    </div>
  );
}
