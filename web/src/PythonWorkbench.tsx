import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  Clock3,
  FileCode2,
  LoaderCircle,
  Play,
  Save,
  Square,
} from "lucide-react";

const PythonEditor = lazy(() => import("./PythonEditor"));
type Api = <T>(path: string, body?: unknown) => Promise<T>;
type Revision = {
  id: string;
  code: string;
  codeHash: string;
  contextId: string;
  createdAt: string;
};
type Run = {
  id: string;
  revisionId: string;
  status: string;
  engine?: string;
  engineVersion?: string;
  durationMs?: number;
  rows?: Record<string, unknown>[];
  error?: string;
  validation?: {
    passed: boolean;
    issues: string[];
    regressions: { contextId: string; passed: boolean }[];
  };
  resourceLimits?: {
    cpu: boolean;
    addressSpace: boolean;
    fileSize: boolean;
  };
};

const pending = (status?: string) => ["QUEUED", "RUNNING"].includes(status ?? "");

export function PythonWorkbench({
  api,
  contextId,
  canWrite,
  available,
  code,
  onCodeChange,
}: {
  api: Api;
  contextId: string;
  canWrite: boolean;
  available: boolean;
  code: string;
  onCodeChange: (code: string) => void;
}) {
  const [revisions, setRevisions] = useState<Revision[]>([]),
    [runs, setRuns] = useState<Run[]>([]),
    [run, setRun] = useState<Run>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const latestRevision = useMemo(
    () =>
      revisions.find(
        (item) => item.contextId === contextId && item.code === code.trim(),
      ),
    [revisions, contextId, code],
  );

  const refresh = async (preferred?: string) => {
    const [nextRevisions, nextRuns] = await Promise.all([
      api<Revision[]>("/python/revisions"),
      api<Run[]>("/python/runs"),
    ]);
    setRevisions(nextRevisions);
    setRuns(nextRuns);
    setRun(nextRuns.find((item) => item.id === (preferred ?? run?.id)) ?? nextRuns[0]);
  };
  useEffect(() => {
    refresh().catch((cause) => setError((cause as Error).message));
  }, []);
  useEffect(() => {
    if (!pending(run?.status)) return;
    const timer = setInterval(() => {
      api<Run>(`/python/runs/${run!.id}`)
        .then((next) => {
          setRun(next);
          setRuns((items) => [next, ...items.filter((item) => item.id !== next.id)]);
        })
        .catch((cause) => setError((cause as Error).message));
    }, 800);
    return () => clearInterval(timer);
  }, [run?.id, run?.status]);

  const save = async () => {
    const revision = await api<Revision>("/python/revisions", {
      code,
      contextId,
    });
    setRevisions((items) => [revision, ...items.filter((item) => item.id !== revision.id)]);
    return revision;
  };
  const execute = async () => {
    setBusy(true);
    setError("");
    try {
      const revision = latestRevision ?? (await save()),
        created = await api<Run>("/python/runs", { revisionId: revision.id });
      setRun(created);
      setRuns((items) => [created, ...items.filter((item) => item.id !== created.id)]);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    if (!run) return;
    try {
      const cancelled = await api<Run>(`/python/runs/${run.id}/cancel`, {});
      setRun(cancelled);
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  return (
    <section className="python-workbench-v2">
      <header className="python-head-v2">
        <div>
          <span className="eyebrow">RESTRICTED PYTHON · LOCAL ACTUAL</span>
          <h1>客户资产 Python 开发</h1>
          <p>真实CPython子进程执行，使用虚构证券行与五套独立断言；不是公网Python沙箱。</p>
        </div>
        <div className="heading-actions">
          <button className="button" onClick={() => save().catch((cause) => setError((cause as Error).message))} disabled={!canWrite || busy}>
            <Save size={14} />保存版本 <span>{revisions.length}</span>
          </button>
          <button className="button primary" onClick={execute} disabled={!canWrite || !available || busy || pending(run?.status)}>
            {busy || pending(run?.status) ? <LoaderCircle className="spin" size={14} /> : <Play size={14} />}运行并核验
          </button>
          {pending(run?.status) && <button className="button danger" onClick={cancel}><Square size={13} />取消</button>}
        </div>
      </header>
      {error && <div className="agent-os-error-v2" role="alert"><AlertCircle size={14} />{error}</div>}
      <div className="python-grid-v2">
        <section className="python-editor-card-v2">
          <header><FileCode2 size={14} /><strong>customer_assets.py</strong><span>{contextId}</span></header>
          <div className="python-editor-v2"><Suspense fallback={<div className="editor-loading">准备Python编辑器…</div>}><PythonEditor value={code} onChange={onCodeChange} /></Suspense></div>
          <footer>只允许 <code>transform(data, params)</code>；禁止import、文件、网络、反射和内部名称。</footer>
        </section>
        <aside className="python-result-v2">
          <header><strong>运行与断言</strong><span>{run?.status ?? "尚未运行"}</span></header>
          {!run ? <p>运行后显示实际结果、五场景回归和资源限制证据。</p> : <>
            <div className="python-run-meta-v2"><span>{run.engine ?? "CPython"} {run.engineVersion}</span><span>{run.durationMs ?? 0}ms</span><code>{run.id.slice(0, 8)}</code></div>
            {run.error && <div className="validation-error">{run.error}</div>}
            {run.validation && <div className={run.validation.passed ? "validation-list passed" : "validation-list failed"}><h3>{run.validation.passed ? "独立证券断言通过" : "结果需要修正"}</h3>{run.validation.regressions.map((item) => <div key={item.contextId}>{item.passed ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}<span>{item.contextId} · {item.passed ? "通过" : "失败"}</span></div>)}{run.validation.issues.map((item) => <p className="validation-error" key={item}>{item}</p>)}</div>}
            {run.resourceLimits && <div className="python-boundary-v2"><span><Clock3 size={12} />CPU限制 {run.resourceLimits.cpu ? "已生效" : "未验证"}</span><span>文件上限 {run.resourceLimits.fileSize ? "已生效" : "未验证"}</span><span>内存上限 {run.resourceLimits.addressSpace ? "已生效" : "当前宿主未验证"}</span></div>}
            {run.rows && <div className="python-rows-v2"><strong>合成结果 · {run.rows.length}行</strong><pre>{JSON.stringify(run.rows, null, 2)}</pre></div>}
          </>}
          <details><summary>最近运行 {runs.length}</summary>{runs.slice(0, 8).map((item) => <button key={item.id} onClick={() => setRun(item)}><span>{item.status}</span><code>{item.id.slice(0, 8)}</code></button>)}</details>
        </aside>
      </div>
    </section>
  );
}
