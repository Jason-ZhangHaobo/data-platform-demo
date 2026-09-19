import { useEffect, useRef, useState } from "react";
import {
  Activity,
  ArrowDownToLine,
  CheckCircle2,
  Clock3,
  FileCode2,
  GitBranch,
  LoaderCircle,
  Package,
  Play,
  Radio,
  RotateCcw,
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
type Approval = {
  id: string;
  packageId: string;
  packageDigest: string;
  status: string;
  approvedAt: string;
  reviewer: string;
  reviewNote: string;
  consumedByReleaseId?: string;
};
type Review = {
  id: string;
  packageId: string;
  packageDigest: string;
  verificationId: string;
  status: string;
  reviewedAt: string;
  reviewer: { id: string; displayName: string; role: string };
  reviewNote: string;
  attestations: {
    code: boolean;
    assertions: boolean;
    deliveryFiles: boolean;
    localScope: boolean;
  };
};
type Release = {
  id: string;
  packageId: string;
  packageDigest: string;
  sourceSqlHash: string;
  approvalId: string;
  status: string;
  health: string;
  activatedAt?: string;
  successfulRunCount?: number;
  failedRunCount?: number;
  openAlertCount?: number;
  publicDeployed: false;
  artifactReady: boolean;
};
type ReleaseRun = {
  id: string;
  releaseId: string;
  status: string;
  sequence: number;
  triggerReason: string;
  scheduledTriggerAt: string;
  triggeredAt?: string;
  durationMs?: number;
  schedulerTriggered: boolean;
  clockMode?: string;
  error?: string;
};
type MonitorAlert = {
  id: string;
  releaseId: string;
  releaseRunId: string;
  status: string;
  message: string;
  openedAt: string;
  resolvedAt?: string;
  recoveryRunId?: string;
};
type MonitorOverview = {
  scope: string;
  publicDeployed: false;
  fullLifecycleE2E: false;
  activeRelease?: Release;
  counts: {
    scheduled: number;
    running: number;
    succeeded: number;
    failed: number;
    openAlerts: number;
  };
  recentRuns: ReleaseRun[];
  alerts: MonitorAlert[];
  recentEvents: {
    id: string;
    type: string;
    releaseId: string;
    recoveryReleaseId?: string;
  }[];
  notice: string;
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
const releasePending = (overview?: MonitorOverview) =>
  Boolean(overview?.counts.scheduled || overview?.counts.running);
const releaseLabels: Record<string, string> = {
  ACTIVE_LOCAL: "本机版本已激活",
  SUPERSEDED_LOCAL: "本机版本已被替代",
  ROLLED_BACK_LOCAL: "本机版本已回滚",
  FAILED_LOCAL: "本机发布失败",
};
const releaseRunLabels: Record<string, string> = {
  SCHEDULED: "等待计时触发",
  RUNNING: "批次执行中",
  SUCCEEDED: "批次成功",
  FAILED: "批次失败",
  VALIDATION_FAILED: "结果未通过",
  CANCELLED: "批次已取消",
  INTERRUPTED: "批次已中断",
};

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
  const [reviews, setReviews] = useState<Review[]>([]),
    [reviewNote, setReviewNote] = useState(
      "已核对代码、独立断言、DAG与部署文件，确认仅限本机合成数据范围",
    ),
    [attestations, setAttestations] = useState({
      code: false,
      assertions: false,
      deliveryFiles: false,
      localScope: false,
    });
  const [approvals, setApprovals] = useState<Approval[]>([]),
    [releases, setReleases] = useState<Release[]>([]),
    [monitor, setMonitor] = useState<MonitorOverview>();
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
  const loadLifecycle = async () => {
    const [nextReviews, nextApprovals, nextReleases, nextMonitor] = await Promise.all([
      api<Review[]>("/delivery/reviews"),
      api<Approval[]>("/release/approvals"),
      api<Release[]>("/releases"),
      api<MonitorOverview>("/monitoring/overview"),
    ]);
    setReviews(nextReviews);
    setApprovals(nextApprovals);
    setReleases(nextReleases);
    setMonitor(nextMonitor);
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
      api<Review[]>("/delivery/reviews"),
      api<Approval[]>("/release/approvals"),
      api<Release[]>("/releases"),
      api<MonitorOverview>("/monitoring/overview"),
    ])
      .then(
        async ([
          bundles,
          verifications,
          initialReviews,
          initialApprovals,
          initialReleases,
          initialMonitor,
        ]) => {
        if (!active) return;
        setPackages(bundles);
        setChecks(verifications);
        setReviews(initialReviews);
        setApprovals(initialApprovals);
        setReleases(initialReleases);
        setMonitor(initialMonitor);
        if (bundles[0]) {
          const bundle = await api<Bundle>(
            "/delivery/packages/" + bundles[0].id,
          );
          if (active) {
            setSelected(bundle);
            setCheck(verifications.find((v) => v.packageId === bundle.id));
          }
        }
        },
      )
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
  useEffect(() => {
    if (!releasePending(monitor)) return;
    const timer = setInterval(() => {
      loadLifecycle().catch((error) => setError(error.message));
    }, 1400);
    return () => clearInterval(timer);
  }, [monitor?.counts.scheduled, monitor?.counts.running]);
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
  const review = async () => {
    if (!selected || !check) return;
    setBusy("review");
    setError("");
    try {
      await api<Review>(`/delivery/packages/${selected.id}/review`, {
        packageDigest: selected.digest,
        verificationId: check.id,
        reviewNote,
        attestations,
      });
      await loadLifecycle();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy("");
    }
  };
  const approve = async () => {
    if (!selected || !selectedReview) return;
    setBusy("approve");
    setError("");
    try {
      await api<Approval>(`/delivery/packages/${selected.id}/approve`, {
        packageDigest: selected.digest,
        reviewId: selectedReview.id,
      });
      await loadLifecycle();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy("");
    }
  };
  const publish = async () => {
    if (!selected) return;
    const approval = approvals.find(
      (item) =>
        item.packageId === selected.id &&
        item.packageDigest === selected.digest &&
        item.status === "APPROVED",
    );
    if (!approval) return;
    setBusy("publish");
    setError("");
    try {
      await api<Release>("/releases", {
        approvalId: approval.id,
        triggerAfterSeconds: 5,
        intervalSeconds: 15,
        runCount: 2,
      });
      await loadLifecycle();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy("");
    }
  };
  const rollback = async (from: Release, target: Release) => {
    setBusy("rollback");
    setError("");
    try {
      await api(`/releases/${from.id}/rollback`, {
        targetReleaseId: target.id,
        triggerAfterSeconds: 5,
        intervalSeconds: 15,
        reason: "恢复最近已验证版本并重新执行两个计时批次",
      });
      await loadLifecycle();
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
  const selectedReview = selected && check
    ? reviews.find(
        (item) =>
          item.packageId === selected.id &&
          item.packageDigest === selected.digest &&
          item.verificationId === check.id &&
          item.status === "REVIEWED",
      )
    : undefined;
  const selectedApproval = selected
    ? approvals.find(
        (item) =>
          item.packageId === selected.id &&
          item.packageDigest === selected.digest &&
          item.status === "APPROVED",
      )
    : undefined;
  const selectedRelease = selected
    ? releases.find(
        (item) =>
          item.packageId === selected.id &&
          item.packageDigest === selected.digest,
      )
    : undefined;
  const activeRelease = monitor?.activeRelease;
  const selectedIsActive = Boolean(
    selectedRelease?.id && selectedRelease.id === activeRelease?.id,
  );
  const selectedHealthy = Boolean(
    selectedIsActive &&
    selectedRelease?.health === "HEALTHY" &&
    Number(selectedRelease?.successfulRunCount ?? 0) >= 2 &&
    Number(selectedRelease?.openAlertCount ?? 0) === 0,
  );
  const selectedResolvedAlertCount =
    monitor?.alerts.filter(
      (item) => item.releaseId === selectedRelease?.id && item.status === "RESOLVED",
    ).length ?? 0;
  const resolvedAlertCount =
    monitor?.alerts.filter((item) => item.status === "RESOLVED").length ?? 0;
  const m2cRecoveryVerified = Boolean(
    activeRelease?.health === "HEALTHY" &&
      monitor?.counts.failed &&
      resolvedAlertCount,
  );
  const rollbackTarget = activeRelease
    ? releases.find(
        (item) =>
          item.id !== activeRelease.id &&
          item.status === "SUPERSEDED_LOCAL" &&
          Number(item.successfulRunCount ?? 0) > 0,
      )
    : undefined;
  return (
    <div className="delivery-workbench">
      <div className="delivery-notice">
        <ShieldCheck size={19} />
        <div>
          <strong>M2a–M2c · 从文件交付到本机发布监控</strong>
          <p>
            先按文件演练，再锁定摘要审批。本机发布由真实墙上时钟触发两个
            Spark 批次并产生监控证据；全程不代表公网或生产上线。
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
                  "shuduo-delivery-" + selected.id.slice(0, 8) + ".json",
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
            <span
              className={
                "status-pill " +
                (selectedRelease?.status === "ACTIVE_LOCAL"
                  ? "succeeded"
                  : selectedApproval
                    ? "running"
                    : "queued")
              }
            >
              {selectedRelease
                ? (releaseLabels[selectedRelease.status] ?? selectedRelease.status)
                : selectedApproval
                  ? "已审批待发布"
                  : "未审批发布"}
            </span>
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
          <section className="release-lifecycle" aria-label="发布与监控链路">
            <div className="release-stepper">
              {[
                ["01", "交付包", "不可变代码与文件摘要", true],
                [
                  "02",
                  "文件演练",
                  "Spark与独立断言",
                  check?.status === "SUCCEEDED",
                ],
                ["03", "审批发布", "摘要绑定与计时触发", !!selectedRelease],
                [
                  "04",
                  "运行监控",
                  "两批、告警与恢复",
                  selectedHealthy,
                ],
              ].map(([number, title, subtitle, complete]) => (
                <div
                  className={complete ? "release-step complete" : "release-step"}
                  key={String(number)}
                >
                  <span>{number}</span>
                  <div>
                    <strong>{title}</strong>
                    <small>{subtitle}</small>
                  </div>
                  {complete ? <CheckCircle2 size={16} /> : <Clock3 size={15} />}
                </div>
              ))}
            </div>
            <div className="release-panels">
              <article className="release-action-card">
                <header>
                  <div>
                    <span className="eyebrow">M2b · REVIEW & RELEASE</span>
                    <h3>审批绑定不可变版本</h3>
                  </div>
                  <ShieldCheck size={22} />
                </header>
                <p>
                  先形成绑定当前摘要与演练编号的审阅记录，再决定是否审批。发布后 5 秒触发首批、
                  间隔 15 秒触发第二批；页面刷新不会丢失批次记录。
                </p>
                <fieldset className="delivery-review-checklist" disabled={!canWrite || !!selectedReview || !!busy}>
                  <legend>工程师审阅确认（不会发布）</legend>
                  {[
                    ["code", "已核对生成 SQL 版本及业务口径"],
                    ["assertions", "已核对独立断言与 Spark 演练结果"],
                    ["deliveryFiles", "已核对 DAG、调度和部署文件摘要"],
                    ["localScope", "确认本次仅为本机合成数据验证，非公网或生产发布"],
                  ].map(([key, label]) => (
                    <label key={key} className="delivery-review-check">
                      <input
                        type="checkbox"
                        checked={attestations[key as keyof typeof attestations]}
                        onChange={(event) =>
                          setAttestations((current) => ({
                            ...current,
                            [key]: event.target.checked,
                          }))
                        }
                      />
                      {label}
                    </label>
                  ))}
                  <textarea
                    aria-label="审阅备注"
                    value={reviewNote}
                    maxLength={500}
                    onChange={(event) => setReviewNote(event.target.value)}
                    placeholder="说明已核对的口径或限制"
                  />
                </fieldset>
                <div className="release-actions">
                  <button
                    className="button"
                    onClick={review}
                    disabled={
                      !canWrite ||
                      check?.status !== "SUCCEEDED" ||
                      !!selectedReview ||
                      !!busy ||
                      reviewNote.trim().length < 4 ||
                      !Object.values(attestations).every(Boolean)
                    }
                  >
                    <FileCode2 size={15} />
                    {busy === "review"
                      ? "正在记录审阅…"
                      : selectedReview
                        ? "审阅已绑定"
                        : "记录审阅"}
                  </button>
                  <button
                    className="button"
                    onClick={approve}
                    disabled={
                      !canWrite ||
                      check?.status !== "SUCCEEDED" ||
                      !selectedReview ||
                      !!selectedApproval ||
                      !!busy
                    }
                  >
                    <ShieldCheck size={15} />
                    {busy === "approve"
                      ? "正在锁定…"
                      : selectedApproval
                        ? "摘要已审批"
                        : "审阅并锁定摘要"}
                  </button>
                  <button
                    className="button primary"
                    onClick={publish}
                    disabled={
                      !canWrite ||
                      !selectedApproval ||
                      !!selectedRelease ||
                      !!busy
                    }
                  >
                    {busy === "publish" ? (
                      <LoaderCircle className="spin" size={15} />
                    ) : (
                      <Radio size={15} />
                    )}
                    {selectedRelease
                      ? (releaseLabels[selectedRelease.status] ?? "已有发布记录")
                      : "发布到本机调度器"}
                  </button>
                </div>
                {selectedApproval && (
                  <small className="release-proof-line">
                    审批 {selectedApproval.id.slice(0, 8)} · 包摘要
                    {selectedApproval.packageDigest.slice(0, 12)} · 仅本机测试
                  </small>
                )}
                {selectedReview && !selectedApproval && (
                  <small className="release-proof-line">
                    审阅 {selectedReview.id.slice(0, 8)} · 演练
                    {selectedReview.verificationId.slice(0, 8)} · 尚未审批
                  </small>
                )}
              </article>
              <article className="monitor-card">
                <header>
                  <div>
                    <span className="eyebrow">M2c · POST-RELEASE EVIDENCE</span>
                    <h3>上线后运行监控</h3>
                  </div>
                  <Activity size={22} />
                </header>
                {!selectedRelease ? (
                  <p className="monitor-empty">当前所选交付包尚未审批发布；其他版本的健康度不能算作本包的上线后证据。</p>
                ) : (
                  <>
                    {!selectedIsActive && (
                      <div className="monitor-context-v2" role="status">
                        所选包对应历史发布版本，以下批次不代表当前生效版本。
                      </div>
                    )}
                    <div className="monitor-kpis">
                      <div>
                        <span>健康度</span>
                        <strong>{selectedRelease.health}</strong>
                      </div>
                      <div>
                        <span>成功批次</span>
                        <strong>{selectedRelease.successfulRunCount ?? 0}</strong>
                      </div>
                      <div>
                        <span>开放告警</span>
                        <strong>{selectedRelease.openAlertCount ?? 0}</strong>
                      </div>
                      <div>
                        <span>已恢复告警</span>
                        <strong>{selectedResolvedAlertCount}</strong>
                      </div>
                    </div>
                    <small className="active-release-line">
                      所选包发布版本 {selectedRelease.id.slice(0, 8)} ·
                      {selectedIsActive ? " 当前生效" : " 历史版本"}
                      {selectedIsActive && m2cRecoveryVerified ? " · 回滚恢复已验证" : ""}
                    </small>
                    <div className="monitor-runs">
                      {monitor?.recentRuns
                        .filter((item) => item.releaseId === selectedRelease.id)
                        .slice(0, 3)
                        .map((item) => (
                          <p key={item.id}>
                            <span
                              className={
                                "status-pill " + item.status.toLowerCase()
                              }
                            >
                              {releaseRunLabels[item.status] ?? item.status}
                            </span>
                            <code>批次 {item.id.slice(0, 8)}</code>
                            <small>
                              {item.schedulerTriggered
                                ? "墙上时钟已触发"
                                : new Date(item.scheduledTriggerAt).toLocaleTimeString(
                                    "zh-CN",
                                  ) + " 待触发"}
                            </small>
                          </p>
                        ))}
                    </div>
                    {selectedIsActive && rollbackTarget && (
                      <button
                        className="button rollback"
                        onClick={() => rollback(selectedRelease, rollbackTarget)}
                        disabled={!canWrite || !!busy}
                      >
                        <RotateCcw size={15} />
                        回滚到 {rollbackTarget.id.slice(0, 8)}
                      </button>
                    )}
                  </>
                )}
                <small className="release-proof-line">
                  本机发布与监控，不代表公网部署或完整 Agent E2E
                </small>
              </article>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
