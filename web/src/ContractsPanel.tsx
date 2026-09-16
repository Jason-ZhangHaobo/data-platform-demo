import { useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FileCheck2,
  GitCompareArrows,
  LoaderCircle,
  Plus,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";

type Api = <T>(path: string, body?: unknown) => Promise<T>;
type Field = {
  name: string;
  type: string;
  nullable: boolean;
  description?: string;
};
type ContractVersion = {
  id: string;
  versionNumber: number;
  fields: Field[];
  schemaHash: string;
  source: string;
  change: {
    added: string[];
    removed: string[];
    typeChanged: { field: string; from: string; to: string }[];
    nullabilityChanged: { field: string; from: boolean; to: boolean }[];
    breaking: boolean;
    breakingReasons: string[];
  };
};
type Assessment = {
  id: string;
  status: "COMPATIBLE" | "BREAKING" | "APPLIED";
  proposedFields: Field[];
  proposedSchemaHash: string;
  change: ContractVersion["change"];
  downstream: { id: string; name: string; kind: string; status: string }[];
  appliedVersionId?: string;
};
type ContractCheck = {
  id: string;
  status: "PASSED" | "PARTIAL" | "FAILED";
  missing: string[];
  typeMismatch: { field: string; expected: string; actual: string }[];
  unexpected: string[];
  nullViolations: string[];
  evaluatedRows: number;
  rowFailureCount: number;
  rowPassRate?: number;
  minPassRate: number;
  freshnessMeasured: boolean;
  freshnessSeconds?: number;
  maxFreshnessSeconds: number;
  actualMetadata: boolean;
  actualRows: boolean;
};
type Contract = {
  id: string;
  name: string;
  code: string;
  assetId: string;
  owner: string;
  description: string;
  compatibility: "BACKWARD" | "FULL" | "NONE";
  status: string;
  currentVersion: ContractVersion;
  versions: ContractVersion[];
  assessments: Assessment[];
  checks: ContractCheck[];
  alerts: { id: string; status: string; affectedFields: string[] }[];
  impact: {
    downstream: { id: string; name: string; kind: string; status: string }[];
    edgeCount: number;
    derivation: string;
  };
};
type Asset = {
  id: string;
  name: string;
  businessName: string;
  fields: Field[];
  evidenceHash: string;
};

const codeFor = (asset: Asset) => {
  const base = asset.name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `${/^[a-z]/.test(base) ? base : "asset"}_contract`;
};

export function ContractsPanel({
  api,
  canWrite,
  asset,
}: {
  api: Api;
  canWrite: boolean;
  asset: Asset;
}) {
  const [contracts, setContracts] = useState<Contract[]>([]),
    [selectedId, setSelectedId] = useState(""),
    [assessment, setAssessment] = useState<Assessment>(),
    [busy, setBusy] = useState(""),
    [notice, setNotice] = useState(""),
    [error, setError] = useState("");
  const [name, setName] = useState(`${asset.businessName}契约`),
    [code, setCode] = useState(codeFor(asset)),
    [owner, setOwner] = useState("虚构数据负责人"),
    [description, setDescription] = useState("约束虚构证券资产字段、兼容性和质量目标"),
    [compatibility, setCompatibility] = useState("BACKWARD"),
    [proposal, setProposal] = useState("CURRENT"),
    [acknowledgeBreaking, setAcknowledgeBreaking] = useState(false);

  const relevant = useMemo(
      () => contracts.filter((contract) => contract.assetId === asset.id),
      [contracts, asset.id],
    ),
    selected =
      relevant.find((contract) => contract.id === selectedId) ?? relevant[0],
    latestCheck = selected?.checks[0];

  const load = async () => {
    const next = await api<Contract[]>("/contracts");
    setContracts(next);
    const choices = next.filter((contract) => contract.assetId === asset.id);
    if (!choices.some((contract) => contract.id === selectedId))
      setSelectedId(choices[0]?.id ?? "");
  };
  useEffect(() => {
    setName(`${asset.businessName}契约`);
    setCode(codeFor(asset));
    setAssessment(undefined);
    void load().catch((cause) => setError((cause as Error).message));
  }, [asset.id]);

  const perform = async (
    key: string,
    work: () => Promise<unknown>,
    success: string,
  ) => {
    setBusy(key);
    setError("");
    setNotice("");
    try {
      await work();
      await load();
      setNotice(success);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy("");
    }
  };
  const create = () =>
    perform(
      "create",
      async () => {
        const contract = await api<Contract>("/contracts", {
          name,
          code,
          assetId: asset.id,
          owner,
          description,
          compatibility,
          qualitySlo: { minPassRate: 0.99, maxFreshnessSeconds: 86400 },
        });
        setSelectedId(contract.id);
      },
      "契约V1已固定当前资产字段与证据摘要",
    );
  const proposedFields = () => {
    if (!selected) return asset.fields;
    const current = selected.currentVersion.fields.map((field) => ({ ...field }));
    if (proposal === "ADD_OPTIONAL") {
      const candidate = current.some((field) => field.name === "currency")
        ? "source_system"
        : "currency";
      return [...current, { name: candidate, type: "STRING", nullable: true }];
    }
    if (proposal === "REMOVE_LAST" && current.length > 1) return current.slice(0, -1);
    if (proposal === "TYPE_CHANGE")
      return current.map((field, index) =>
        index === 0
          ? { ...field, type: field.type === "STRING" ? "INTEGER" : "STRING" }
          : field,
      );
    return asset.fields;
  };
  const assess = () =>
    selected &&
    perform(
      "assess",
      async () => {
        const result = await api<Assessment>(
          `/contracts/${selected.id}/assess`,
          { fields: proposedFields() },
        );
        setAssessment(result);
        setAcknowledgeBreaking(false);
      },
      "兼容性与下游影响已计算；尚未创建新版本",
    );
  const apply = () =>
    selected &&
    assessment &&
    perform(
      "version",
      async () => {
        await api(`/contracts/${selected.id}/versions`, {
          assessmentId: assessment.id,
          acknowledgeBreaking,
        });
        setAssessment(undefined);
      },
      "已从精确评估创建不可变契约版本",
    );
  const check = () =>
    selected &&
    perform(
      "check",
      () => api(`/contracts/${selected.id}/check`, {}),
      "已用当前实际元数据与可用数据行检查契约",
    );

  return (
    <section className="contracts-panel-v2">
      <header>
        <div>
          <span className="eyebrow">VERSIONED DATA CONTRACT</span>
          <h4>数据契约与变更影响</h4>
          <p>字段、兼容策略、SLO和下游绑定同一版本；评估不会自动发布。</p>
        </div>
        <span>{relevant.length}</span>
      </header>
      {(notice || error) && (
        <div className={error ? "contract-feedback-v2 failed" : "contract-feedback-v2"} role={error ? "alert" : "status"}>
          {error ? <AlertTriangle size={14} /> : <CheckCircle2 size={14} />}
          {error || notice}
        </div>
      )}
      {!selected ? (
        <div className="contract-create-v2">
          <label>名称<input value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label>代码<input value={code} onChange={(event) => setCode(event.target.value)} /></label>
          <label>兼容策略<select value={compatibility} onChange={(event) => setCompatibility(event.target.value)}><option>BACKWARD</option><option>FULL</option><option>NONE</option></select></label>
          <label>责任人<input value={owner} onChange={(event) => setOwner(event.target.value)} /></label>
          <label className="wide">说明<input value={description} onChange={(event) => setDescription(event.target.value)} /></label>
          <button className="button primary" onClick={create} disabled={!canWrite || !!busy}><Plus size={14} />{busy === "create" ? "正在创建…" : "从当前资产创建V1"}</button>
        </div>
      ) : (
        <>
          <div className="contract-selector-v2">
            <label>当前契约<select value={selected.id} onChange={(event) => { setSelectedId(event.target.value); setAssessment(undefined); }}>{relevant.map((contract) => <option key={contract.id} value={contract.id}>{contract.name} · V{contract.currentVersion.versionNumber}</option>)}</select></label>
            <div><span className="status-pill succeeded">{selected.compatibility}</span><code>{selected.currentVersion.schemaHash.slice(0, 12)}</code></div>
            <div><strong>{selected.currentVersion.fields.length}</strong><span>字段</span></div>
            <div><strong>{selected.impact.downstream.length}</strong><span>下游资产</span></div>
            <button className="button" onClick={check} disabled={!canWrite || !!busy}>{busy === "check" ? <LoaderCircle className="spin" size={14} /> : <FileCheck2 size={14} />}实际检查</button>
          </div>
          {latestCheck && <div className={`contract-check-v2 ${latestCheck.status.toLowerCase()}`}><span>{latestCheck.status === "PASSED" ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}{latestCheck.status}</span><p>元数据：实际 · 数据行：{latestCheck.actualRows ? `${latestCheck.evaluatedRows}行` : "当前不可用"} · 行通过率 {latestCheck.rowPassRate === undefined ? "未测" : `${(latestCheck.rowPassRate * 100).toFixed(1)}% / ${(latestCheck.minPassRate * 100).toFixed(1)}%`} · 新鲜度 {latestCheck.freshnessMeasured ? `${latestCheck.freshnessSeconds}s / ${latestCheck.maxFreshnessSeconds}s` : "未测"} · 缺字段 {latestCheck.missing.length} · 类型错误 {latestCheck.typeMismatch.length} · 空值违约 {latestCheck.nullViolations.length}</p></div>}
          <div className="contract-change-v2">
            <label>变更样例<select value={proposal} onChange={(event) => { setProposal(event.target.value); setAssessment(undefined); }}><option value="CURRENT">重新采集当前资产</option><option value="ADD_OPTIONAL">增加可空字段</option><option value="REMOVE_LAST">删除最后字段</option><option value="TYPE_CHANGE">修改首字段类型</option></select></label>
            <button className="button" onClick={assess} disabled={!canWrite || !!busy}><GitCompareArrows size={14} />{busy === "assess" ? "评估中…" : "评估兼容与影响"}</button>
          </div>
          {assessment && <div className={`contract-assessment-v2 ${assessment.status.toLowerCase()}`}><div><span className={`status-pill ${assessment.status === "BREAKING" ? "failed" : "succeeded"}`}>{assessment.status}</span><strong>新增 {assessment.change.added.length} · 删除 {assessment.change.removed.length} · 类型 {assessment.change.typeChanged.length} · 可空性 {assessment.change.nullabilityChanged.length}</strong><p>{assessment.change.breakingReasons.join(" · ") || "当前策略下无破坏性变更"}</p><small>影响下游 {assessment.downstream.length} · proposed {assessment.proposedSchemaHash.slice(0, 12)}</small></div><div>{assessment.status === "BREAKING" && <label className="contract-ack-v2"><input type="checkbox" checked={acknowledgeBreaking} onChange={(event) => setAcknowledgeBreaking(event.target.checked)} />已审阅下游影响并确认不兼容变更</label>}<button className="button primary" onClick={apply} disabled={!canWrite || !!busy || (assessment.status === "BREAKING" && !acknowledgeBreaking)}>{busy === "version" ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}创建V{selected.currentVersion.versionNumber + 1}</button></div></div>}
          <footer><ShieldCheck size={13} />契约检查只返回字段名和计数，不返回失败业务值；不兼容变更必须精确评估后确认。</footer>
        </>
      )}
    </section>
  );
}
