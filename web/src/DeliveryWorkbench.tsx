import { useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  CheckCircle2,
  Clock3,
  FileCode2,
  GitBranch,
  LoaderCircle,
  Package,
  Play,
  ShieldCheck,
  Square,
  AlertCircle,
  ChevronRight,
} from "lucide-react";
type Api = <T>(path: string, body?: unknown) => Promise<T>;
type Run = {
  id: string;
  status: string;
  contextId: string;
  revisionId: string;
  validationContractId?: string;
  createdAt: string;
};
type Bundle = {
  id: string;
  digest: string;
  createdAt: string;
  files?: Record<string, string>;
  fileNames?: string[];
  manifest: {
    name: string;
    releaseState: string;
    source: {
      runId: string;
      revisionId: string;
      sqlHash: string;
      contextId: string;
    };
    files: Record<string, { sha256: string; bytes: number }>;
  };
};
type Verification = {
  id: string;
  packageId: string;
  status: string;
  scheduledFor: string;
  packageDigest: string;
  error?: string;
  published?: boolean;
  mode?: string;
  occurrence?: { businessDate: string };
  engineVersion?: string;
  testSqlValidation?: { passed: boolean };
  validation?: { passed: boolean };
  workflowTrace?: { id: string; kind: string; status: string }[];
};
const labels: Record<string, string> = {
  QUEUED: "等待执行",
  RUNNING: "文件演练中",
  SUCCEEDED: "本机演练通过",
  FAILED: "演练失败",
  VALIDATION_FAILED: "结果未通过",
  CANCELLED: "已取消",
  INTERRUPTED: "已中断",
};
const pending = (status?: string) =>
  ["QUEUED", "RUNNING"].includes(status ?? "");
const scheduledFor = "2026-09-11T09:00:00+08:00";

export function DeliveryWorkbench({
  api,
  runs,
  contractId,
  sourceRunId,
  canWrite,
  onBack,
}: {
  api: Api;
  runs: Run[];
  contractId?: string;
  sourceRunId?: string;
  canWrite: boolean;
  onBack: () => void;
}) {
  const eligible = runs.filter(
    (run) =>
      run.status === "SUCCEEDED" && run.validationContractId === contractId,
  );
  const [source, setSource] = useState(""),
    [name, setName] = useState("客户资产 T+1");
  const [packages, setPackages] = useState<Bundle[]>([]),
    [selected, setSelected] = useState<Bundle>();
  const [checks, setChecks] = useState<Verification[]>([]),
    [check, setCheck] = useState<Verification>();
  const [file, setFile] = useState("schedule.json"),
    [busy, setBusy] = useState(""),
    [error, setError] = useState("");
  const ticket = useRef(0);
  const loadPackage = async (id: string) => {
    const request = ++ticket.current;
    const bundle = await api<Bundle>("/delivery/packages/" + id);
    if (request === ticket.current) {
      setSelected(bundle);
      setCheck(checks.find((check) => check.packageId === id));
    }
  };
  useEffect(() => {
    if (sourceRunId && eligible.some((run) => run.id === sourceRunId))
      setSource(sourceRunId);
    else if (!source && eligible[0]) setSource(eligible[0].id);
  }, [sourceRunId, runs, contractId]);
  useEffect(() => {
    let active = true;
    Promise.all([
      api<Bundle[]>("/delivery/packages"),
      api<Verification[]>("/delivery/verifications"),
    ])
      .then(async ([bundles, verifications]) => {
        if (!active) return;
        setPackages(bundles);
        setChecks(verifications);
        if (bundles[0]) {
          const bundle = await api<Bundle>(
            "/delivery/packages/" + bundles[0].id,
          );
          if (active) {
            setSelected(bundle);
            setCheck(verifications.find((v) => v.packageId === bundle.id));
          }
        }
      })
      .catch((error) => {
        if (active) setError(error.message);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!check || !pending(check.status)) return;
    const timer = setInterval(async () => {
      try {
        const latest = await api<Verification>(
          "/delivery/verifications/" + check.id,
        );
        setCheck(latest);
        if (!pending(latest.status))
          setChecks(await api<Verification[]>("/delivery/verifications"));
      } catch (error) {
        setError((error as Error).message);
      }
    }, 1400);
    return () => clearInterval(timer);
  }, [check?.id, check?.status]);
  const create = async () => {
    setBusy("create");
    setError("");
    try {
      const bundle = await api<Bundle>("/delivery/packages", {
        sourceRunId: source,
        name,
      });
      setSelected(bundle);
      setCheck(undefined);
      setPackages(await api<Bundle[]>("/delivery/packages"));
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy("");
    }
  };
  const execute = async () => {
    if (!selected) return;
    setBusy("execute");
    setError("");
    try {
      setCheck(
        await api<Verification>(
          "/delivery/packages/" + selected.id + "/verify",
          { scheduledFor },
        ),
      );
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy("");
    }
  };
  const download = (text: string, filename: string) => {
    const url = URL.createObjectURL(
      new Blob([text], {
        type: filename.endsWith(".json")
          ? "application/json;charset=utf-8"
          : "text/plain;charset=utf-8",
      }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const content = selected
    ? file === "manifest.json"
      ? JSON.stringify(selected.manifest, null, 2)
      : (selected.files?.[file] ?? "")
    : "";
  return (
    <div className="delivery-workbench">
      <div className="delivery-notice">
        <ShieldCheck size={19} />
        <div>
          <strong>M2a · 文件交付与本机演练</strong>
          <p>
            生成包和演练不会发布上线。真实定时触发、审批与回滚属于
            M2b；当前使用明确标注的样例交易日历。
          </p>
        </div>
      </div>
      {error && (
        <div className="delivery-error" role="alert">
          <AlertCircle size={17} />
          {error}
        </div>
      )}
      <details className="delivery-create-container" open={!selected}>
        <summary>生成新交付包</summary>
        <div className="delivery-create">
          <div>
            <label htmlFor="delivery-source">已通过当前验证的 SQL 运行</label>
            <select
              id="delivery-source"
              value={source}
              onChange={(event) => setSource(event.target.value)}
              disabled={!eligible.length || !!busy}
            >
              {!eligible.length && (
                <option value="">尚无可用运行，请先完成代码验证</option>
              )}
              {eligible.map((run) => (
                <option key={run.id} value={run.id}>
                  {run.contextId} · 批次 {run.id.slice(0, 8)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="delivery-name">交付名称</label>
            <input
              id="delivery-name"
              value={name}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <button
            className="button primary"
            onClick={create}
            disabled={!canWrite || !source || !name.trim() || !!busy}
          >
            <Package size={16} />
            {busy === "create" ? "正在生成…" : "生成交付包"}
          </button>
        </div>
      </details>
      {!selected ? (
        <div className="delivery-empty">
          <Package size={32} />
          <h2>把已验证代码交付成可执行文件</h2>
          <p>
            包含
            main.sql、tests.sql、schedule.json、deployment.json、calendar.json、fixtures.json
            和验证报告。
          </p>
          <button className="button" onClick={onBack}>
            返回代码工作台
            <ChevronRight size={15} />
          </button>
        </div>
      ) : (
        <>
          <div className="delivery-package-toolbar">
            <label>
              已生成的交付包
              <select
                aria-label="选择交付包"
                value={selected.id}
                onChange={(event) =>
                  loadPackage(event.target.value).catch((error) =>
                    setError(error.message),
                  )
                }
              >
                {packages.map((bundle) => (
                  <option key={bundle.id} value={bundle.id}>
                    {bundle.manifest.name} · {bundle.id.slice(0, 8)}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="button primary"
              onClick={execute}
              disabled={!canWrite || !!busy || pending(check?.status)}
            >
              {pending(check?.status) ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                <Play size={16} />
              )}
              本机按文件演练
            </button>
            <button
              className="button"
              onClick={() =>
                download(
                  JSON.stringify(
                    {
                      manifest: selected.manifest,
                      files: selected.files,
                      digest: selected.digest,
                    },
                    null,
                    2,
                  ),
                  "shuzhan-delivery-" + selected.id.slice(0, 8) + ".json",
                )
              }
            >
              <ArrowDownToLine size={15} />
              下载交付包
            </button>
          </div>
          <div className="delivery-source-proof">
            <span>
              源版本{" "}
              <code>{selected.manifest.source.sqlHash.slice(0, 12)}</code>
            </span>
            <span>
              包摘要{" "}
              <code title={selected.digest}>
                {selected.digest.slice(0, 16)}
              </code>
            </span>
            <span className="status-pill queued">未发布上线</span>
          </div>
          <div className="delivery-grid">
            <section className="delivery-files">
              <div role="tablist" aria-label="交付文件">
                {[...Object.keys(selected.manifest.files), "manifest.json"].map(
                  (name) => (
                    <button
                      role="tab"
                      aria-selected={file === name}
                      className={file === name ? "active" : ""}
                      key={name}
                      onClick={() => setFile(name)}
                    >
                      <FileCode2 size={14} />
                      {name}
                    </button>
                  ),
                )}
              </div>
              <pre aria-label="交付文件内容">{content}</pre>
              <footer>
                <span>文件只读；改代码后重新核验并生成新包</span>
                <button onClick={() => download(content, file)}>
                  <ArrowDownToLine size={14} />
                  下载当前文件
                </button>
              </footer>
            </section>
            <aside className="delivery-execution">
              <h3>
                <GitBranch size={18} />
                按文件演练
              </h3>
              <ol>
                <li>
                  <span>1</span>执行 main.sql
                </li>
                <li>
                  <span>2</span>运行 tests.sql 与五场景核验
                </li>
                <li>
                  <span>3</span>保存真实结果与文件摘要
                </li>
              </ol>
              <div className="delivery-clock">
                <Clock3 size={16} />
                <div>
                  <strong>样例调度时刻</strong>
                  <p>2026-09-11 09:00 · 北京时间</p>
                  <small>
                    T+1
                    对应业务日2026-09-10；这是手动指定的演练时刻，不是定时器触发。
                  </small>
                </div>
              </div>
              {check && (
                <div className="delivery-receipt">
                  <div>
                    <span
                      className={"status-pill " + check.status.toLowerCase()}
                    >
                      {labels[check.status] ?? check.status}
                    </span>
                    {pending(check.status) && (
                      <button
                        aria-label="取消文件演练"
                        onClick={async () => {
                          try {
                            setCheck(
                              await api<Verification>(
                                "/delivery/verifications/" +
                                  check.id +
                                  "/cancel",
                                {},
                              ),
                            );
                          } catch (error) {
                            setError((error as Error).message);
                          }
                        }}
                      >
                        <Square size={13} />
                      </button>
                    )}
                  </div>
                  <code>演练 {check.id.slice(0, 8)}</code>
                  {check.workflowTrace?.map((step) => (
                    <p key={step.id}>
                      {step.status === "SUCCEEDED" ? (
                        <CheckCircle2 size={14} />
                      ) : (
                        <AlertCircle size={14} />
                      )}{" "}
                      {step.id} · {step.status}
                    </p>
                  ))}
                  {check.error && (
                    <p role="alert" className="delivery-error-text">
                      {check.error}
                    </p>
                  )}
                  {check.status === "SUCCEEDED" && (
                    <p>
                      测试 SQL 已实际执行 · Spark {check.engineVersion}
                      <br />
                      未触发云部署或发布
                    </p>
                  )}
                </div>
              )}
            </aside>
          </div>
        </>
      )}
    </div>
  );
}
