import { fundRehearsalAt } from "../../src/v2/fund-contexts.mjs";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type {ServiceSourceBinding} from "./service-source-binding";
import type {PublishedReportSource} from "./published-report-read";
const AgentReportPanel = lazy(async () => ({ default: (await import("./AgentReportPanel")).AgentReportPanel }));
import { manualDeliveryPackages } from "./manual-run-recovery";
import { deliverySourceSelection } from "./delivery-source";
import { defaultLocalReleaseSchedule, localReleaseScheduleText, matchingDeliveryVerification } from "./delivery-presentation";
import { checkedSyncSqlRehearsalSchema } from "../../src/v2/sync-sql-output-schema-client.mjs";
import type { SyncSqlRehearsalSchema } from "../../src/v2/sync-sql-output-schema-client.mjs";
import { SyncOutputSchemaDetails } from "./SyncOutputSchemaDetails";
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
  contextId?: string;
  revisionId: string;
  validationContractId?: string;
  syncInput?: { snapshotHash: string };
  validation?: { contractId?: string };
  createdAt: string;
};
type Bundle = {
  id: string;
  digest: string;
  createdAt: string;
  files?: Record<string, string>;
  fileNames?: string[];
  manifest: {
    format: string;
    name: string;
    releaseState: string;
    source: {
      runId: string;
      revisionId: string;
      sqlHash?: string;
      codeHash?: string;
      contextId: string;
      fundLookthrough?: { businessDate: string; managerId: string };
      fundSignedExecution?: { preflightDigest: string };
      syncInput?: { runId: string; metadataVersionId: string; snapshotHash: string; rowCount: number; developmentMode: string; agentTaskId: string };
      attribution?: { originAgentTaskId?: string };
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
  engine?: string;
  codeExecuted?: boolean;
  testSqlValidation?: { passed: boolean };
  validation?: { passed: boolean };
  rehearsalOutputSchema?: unknown;
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
  expiresAt?: string;
  syncConsent?: { verificationId: string; snapshotHash: string; scheduleSpec: { triggerAfterSeconds: number; intervalSeconds: number; runCount: number } };
  fundConsent?: { scheduleSpec: { triggerAfterSeconds: number; intervalSeconds: number; runCount: number } };
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
  sourceSqlHash?: string;
  sourceCodeHash?: string;
  approvalId: string;
  status: string;
  health: string;
  activatedAt?: string;
  successfulRunCount?: number;
  failedRunCount?: number;
  openAlertCount?: number;
  publicDeployed: false;
  artifactReady: boolean;
  fundLookthrough?: { businessDate: string };
  syncInput?: { snapshotHash: string };
  sourceRevisionId?: string;
  scheduleSpec?:{triggerAfterSeconds?:unknown;intervalSeconds?:unknown;runCount?:unknown};
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
  resultUnknown?: boolean;
  clockMode?: string;
  error?: string;
};
type FundSourceEvidence = {
  protocol: string;
  releaseId: string;
  packageDigest: string;
  batchId: string;
  businessDate: string;
  rowCount: number;
  resultDigest: string;
  eligibleForService: boolean;
};

function FundSourceReadback({ api, release, batches }: { api: Api; release: Release; batches: ReleaseRun[] }) {
  const [batchId, selectBatch] = useState("");
  const [evidence, setEvidence] = useState<FundSourceEvidence>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const selected = batches.find(batch => batch.id === batchId) ?? batches[0];
  const verify = async () => {
    if (!selected) return;
    setPending(true);
    setError("");
    setEvidence(undefined);
    try {
      const params = new URLSearchParams({ release_id: release.id, package_digest: release.packageDigest });
      const result = await api<FundSourceEvidence>(`/data-services/fund-sources/${selected.id}?${params}`);
      if (result.protocol !== "shuduo-fund-consumption-source/v1" || result.releaseId !== release.id ||
          result.packageDigest !== release.packageDigest || result.batchId !== selected.id)
        throw new Error("返回的来源与所选发布批次不一致");
      setEvidence(result);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setPending(false);
    }
  };
  return (
    <div className="release-proof-line">
      <label>
        数据服务来源批次{" "}
        <select aria-label="数据服务来源批次" disabled={pending} value={selected?.id ?? ""} onChange={event => {
          selectBatch(event.currentTarget.value);
          setEvidence(undefined);
          setError("");
        }}>
          {batches.map(batch => <option key={batch.id} value={batch.id}>第 {batch.sequence} 批 · {batch.id.slice(0, 8)}</option>)}
        </select>
      </label>{" "}
      <button className="button" disabled={!selected || pending} onClick={verify}>{pending ? "正在核对…" : "核对来源"}</button>
      {error && <p role="alert">{error}</p>}
      {evidence && evidence.batchId === selected?.id && (
        <p role="status">
          {evidence.eligibleForService ? "双批来源通过" : "测试夹具 · 不可用于发布接口"} · {evidence.businessDate} · {evidence.rowCount} 行 ·{" "}
          <code title={evidence.resultDigest}>{evidence.resultDigest.slice(0, 12)}</code>
        </p>
      )}
    </div>
  );
}
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
const syncReleaseSchedule = { triggerAfterSeconds: 5, intervalSeconds: 45, runCount: 2 };
const releasePending = (overview?: MonitorOverview) =>
  Boolean(overview?.counts.scheduled || overview?.counts.running);
const releaseLabels: Record<string, string> = {
  ACTIVE_LOCAL: "本机版本已激活",
  SUPERSEDED_LOCAL: "本机版本已被替代",
  ROLLED_BACK_LOCAL: "本机版本已回滚",
  FAILED_LOCAL: "本机发布失败",
  CANCELLED: "本机发布已停止",
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

const defaultReviewNote = "已核对代码、独立断言、DAG与部署文件，确认仅限本机合成数据范围";
const emptyAttestations = { code: false, assertions: false, deliveryFiles: false, localScope: false };
type ReviewDraft = { target: string; note: string; attestations: typeof emptyAttestations };

export function DeliveryWorkbench({
  api,
  runs,
  contractId,
  sourceRunId,
  canWrite,
  onBack,
  onOpenServices,
  lockSource = false,
}: {
  api: Api;
  runs: Run[];
  contractId?: string;
  sourceRunId?: string;
  canWrite: boolean;
  onBack: () => void;
  onOpenServices?: (source: ServiceSourceBinding) => void;
  lockSource?: boolean;
}) {
  const [currentSource, setSource] = useState(""),
    [name, setName] = useState("客户资产 T+1");
  const { eligible, source, locked: sourceLocked, issue: sourceIssue } = deliverySourceSelection(runs, { contractId, sourceRunId, lockSource, currentSource });
  const [loadedPackages, setPackages] = useState<Bundle[]>([]),
    [loadedPackage, setSelected] = useState<Bundle>();
  const snapshotHash = sourceLocked ? eligible[0]?.syncInput?.snapshotHash : undefined;
  const matchesSnapshot = (bundle: Bundle) => !snapshotHash || bundle.manifest.source.syncInput?.snapshotHash === snapshotHash;
  const packages = manualDeliveryPackages(loadedPackages, sourceRunId, sourceLocked).filter(matchesSnapshot);
  const selected = loadedPackage && (!sourceLocked || source && loadedPackage.manifest.source.runId === sourceRunId)
    && matchesSnapshot(loadedPackage) ? loadedPackage : undefined;
  const fund = selected?.manifest.source.fundLookthrough;
  const syncInput = selected?.manifest.source.syncInput;
  const syncFileScope = Boolean(syncInput || eligible.find(run => run.id === source)?.syncInput);
  const [approvalClock, setApprovalClock] = useState(Date.now);
  const [syncConsentTarget, setSyncConsentTarget] = useState<string>();
  const signedFundTask = selected?.manifest.source.fundSignedExecution
    ? selected.manifest.source.attribution?.originAgentTaskId : undefined;
  const [checks, setChecks] = useState<Verification[]>([]),
    [observedCheck, setCheck] = useState<Verification>();
  const check = observedCheck && matchingDeliveryVerification(selected, [observedCheck]);
  const savedChecks = syncInput ? checks.filter(item => matchingDeliveryVerification(selected, [item])) : [];
  let rehearsalSchema:SyncSqlRehearsalSchema|undefined;
  if (check?.rehearsalOutputSchema !== undefined && selected?.manifest.source.sqlHash && syncInput) {
    const { runId, revisionId, sqlHash } = selected.manifest.source;
    try {
      rehearsalSchema = checkedSyncSqlRehearsalSchema(check.rehearsalOutputSchema, {
        verificationId:check.id, packageId:selected.id, packageDigest:selected.digest, runId, revisionId,
        revisionHash:sqlHash, snapshotHash:syncInput.snapshotHash,
      });
    } catch { /* Keep the original receipt when its optional details cannot be confirmed. */ }
  }
  const [reviews, setReviews] = useState<Review[]>([]), [reviewDraft, setReviewDraft] = useState<ReviewDraft>();
  const reviewTarget = selected && !selected.manifest.source.fundSignedExecution && check?.status === "SUCCEEDED"
    ? `${selected.id}:${selected.digest}:${check.id}` : undefined;
  const [fundConsentTarget, setFundConsentTarget] = useState<string>();
  const fundConfirmed = Boolean(reviewTarget && fundConsentTarget === reviewTarget);
  const syncConfirmed = Boolean(reviewTarget && syncConsentTarget === reviewTarget && check?.occurrence?.businessDate);
  const currentDraft = reviewDraft?.target === reviewTarget ? reviewDraft : undefined;
  const reviewNote = currentDraft?.note ?? defaultReviewNote;
  const attestations = currentDraft?.attestations ?? emptyAttestations;
  const [approvals, setApprovals] = useState<Approval[]>([]),
    [releases, setReleases] = useState<Release[]>([]),
    [monitor, setMonitor] = useState<MonitorOverview>();
  const [file, setFile] = useState("schedule.json"),
    [busy, setBusy] = useState(""),
    [error, setError] = useState("");
  const ticket = useRef(0);
  const editReviewDraft = (edit: (draft: ReviewDraft) => ReviewDraft) => {
    if (!reviewTarget) return;
    setReviewDraft(draft => edit(draft?.target === reviewTarget ? draft : {
      target: reviewTarget, note: defaultReviewNote, attestations: emptyAttestations,
    }));
  };
  useEffect(() => {
    setReviewDraft(draft => draft?.target === reviewTarget ? draft : undefined);
    setFundConsentTarget(current => current === reviewTarget ? current : undefined);
    setSyncConsentTarget(current => current === reviewTarget ? current : undefined);
  }, [reviewTarget]);
  const scopedBundles = (bundles: Bundle[]) => manualDeliveryPackages(bundles, sourceRunId, sourceLocked).filter(matchesSnapshot);
  const packageKey = `shuduo:delivery:package:${sourceLocked ? sourceRunId : "classic"}`;
  const rememberPackage = (bundle:Bundle) => {
    try {
      if (bundle.manifest.source.syncInput) sessionStorage.setItem(packageKey, JSON.stringify({id:bundle.id,digest:bundle.digest}));
      else sessionStorage.removeItem(packageKey);
    } catch { /* The package remains available in the current session view. */ }
  };
  const restorePackage = (history:Bundle[]) => {
    let saved;
    try { saved = JSON.parse(sessionStorage.getItem(packageKey) ?? "null"); }
    catch { /* No valid previous package selection. */ }
    if (!saved) return history[0];
    const original = history.find(bundle => bundle.id === saved.id && bundle.digest === saved.digest && bundle.manifest.source.syncInput);
    if (!original) setError("上次的交付包未能确认。请在当前包列表重新核对。");
    return original ?? history[0];
  };
  const checkKey = (bundle:Bundle) => `shuduo:delivery:rehearsal:${bundle.id}:${bundle.digest}`;
  const rememberCheck = (bundle:Bundle, verification:Verification) => {
    if (!bundle.manifest.source.syncInput) return;
    rememberPackage(bundle);
    try { sessionStorage.setItem(checkKey(bundle), verification.id); }
    catch { /* History remains readable when browser storage is disabled. */ }
  };
  const restoreCheck = (bundle:Bundle, history:Verification[]) => {
    let pinned;
    if (bundle.manifest.source.syncInput) {
      try { pinned = sessionStorage.getItem(checkKey(bundle)); }
      catch { /* Use the visible history when no previous selection is available. */ }
    }
    if (!pinned) return matchingDeliveryVerification(bundle, history);
    const original = matchingDeliveryVerification(bundle, history.filter(item => item.id === pinned));
    if (!original) setError("原演练回执未能确认，请从本包的已保存演练重新选择。");
    return original;
  };
  const openCheck = async (id:string) => {
    if (!selected || !savedChecks.some(item => item.id === id)) return;
    const request = ++ticket.current;
    const previous = check;
    setCheck(undefined);
    setError("");
    setBusy("read-verification");
    try {
      const latest = await api<Verification>("/delivery/verifications/" + id);
      if (request !== ticket.current) return;
      if (latest.id !== id || !matchingDeliveryVerification(selected, [latest]))
        throw Error("演练回执与当前交付包不一致，请重新核对。");
      rememberCheck(selected, latest);
      setCheck(latest);
    } catch (cause) {
      if (request === ticket.current) {
        setCheck(previous);
        setError((cause as Error).message);
      }
    } finally {
      setBusy(current => current === "read-verification" ? "" : current);
    }
  };
  const loadPackage = async (id: string) => {
    const request = ++ticket.current;
    const bundle = await api<Bundle>("/delivery/packages/" + id);
    if (request === ticket.current) {
      if (bundle.id !== id || !packages.some(item => item.id === id && item.digest === bundle.digest))
        throw Error("交付包与已选版本不一致，请重新核对。");
      rememberPackage(bundle);
      setSelected(bundle);
      setCheck(restoreCheck(bundle, checks));
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
    if (!sourceLocked && !currentSource && source) setSource(source);
  }, [sourceLocked, currentSource, source]);
  useEffect(() => {
    let active = true;
    ++ticket.current;
    setSelected(undefined);
    setCheck(undefined);
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
        const visibleBundles = scopedBundles(bundles);
        setPackages(visibleBundles);
        setChecks(verifications);
        setReviews(initialReviews);
        setApprovals(initialApprovals);
        setReleases(initialReleases);
        setMonitor(initialMonitor);
        const initialBundle = restorePackage(visibleBundles);
        if (initialBundle) {
          const bundle = await api<Bundle>(
            "/delivery/packages/" + initialBundle.id,
          );
          if (active) {
            if (bundle.id !== initialBundle.id || bundle.digest !== initialBundle.digest)
              throw Error("交付包与已选版本不一致，请重新核对。");
            setSelected(bundle);
            setCheck(restoreCheck(bundle, verifications));
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
  }, [sourceRunId, lockSource]);
  useEffect(() => {
    if (!selected || !check || !pending(check.status)) return;
    const request = ticket.current;
    let active = true;
    const timer = setInterval(async () => {
      try {
        const latest = await api<Verification>("/delivery/verifications/" + check.id);
        if (!active || request !== ticket.current) return;
        if (latest.id !== check.id || !matchingDeliveryVerification(selected, [latest])) {
          setCheck(undefined);
          setError("演练回执与当前交付包不一致，请重新核对。");
          return;
        }
        setCheck(latest);
        if (!pending(latest.status))
          setChecks(await api<Verification[]>("/delivery/verifications"));
      } catch (error) {
        if (active && request === ticket.current) setError((error as Error).message);
      }
    }, 1400);
    return () => { active = false; clearInterval(timer); };
  }, [selected?.id, selected?.digest, check?.id, check?.status]);
  useEffect(() => {
    if (!releasePending(monitor)) return;
    const timer = setInterval(() => {
      loadLifecycle().catch((error) => setError(error.message));
    }, 1400);
    return () => clearInterval(timer);
  }, [monitor?.counts.scheduled, monitor?.counts.running]);
  const create = async () => {
    if (!source || !eligible.some(run => run.id === source)) {
      setError(sourceIssue || "请先选择已通过其业务口径验证的运行。");
      return;
    }
    setBusy("create");
    setError("");
    try {
      const bundle = await api<Bundle>("/delivery/packages", {
        sourceRunId: source,
        name,
      });
      if (bundle.manifest.source.runId !== source || !matchesSnapshot(bundle)) throw Error("交付包与所选运行或原快照不一致");
      rememberPackage(bundle);
      setSelected(bundle);
      setCheck(restoreCheck(bundle, checks));
      setPackages(scopedBundles(await api<Bundle[]>("/delivery/packages")));
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy("");
    }
  };
  const execute = async () => {
    if (!selected) return;
    const request = ticket.current;
    setBusy("execute");
    setError("");
    try {
      const verification = await api<Verification>(
        "/delivery/packages/" + selected.id + "/verify",
        { scheduledFor: fundRehearsalAt(selected.manifest.source.contextId) ?? scheduledFor },
      );
      if (request === ticket.current) {
        const matched = matchingDeliveryVerification(selected, [verification]);
        setCheck(matched);
        if (matched) {
          rememberCheck(selected, matched);
          setChecks(history => [matched, ...history.filter(item => item.id !== matched.id)]);
        } else setError("演练回执与当前交付包不一致，请重新核对。");
      }
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy("");
    }
  };
  const review = async () => {
    if (!selected || !check || !reviewTarget || !currentDraft || !Object.values(attestations).every(Boolean)) return;
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
    if (!selected || !reviewTarget || !selectedReview || (fund && !fundConfirmed) || (syncInput && !syncConfirmed)) return;
    setBusy("approve");
    setError("");
    try {
      await api<Approval>(`/delivery/packages/${selected.id}/approve`, {
        packageDigest: selected.digest,
        reviewId: selectedReview.id,
        ...(syncInput ? { syncConsent: {
          scope: "LOCAL_TEST_RELEASE", packageDigest: selected.digest, verificationId: selectedReview.verificationId,
          businessDate: check?.occurrence?.businessDate, snapshotHash: syncInput.snapshotHash,
          scheduleSpec: syncReleaseSchedule, confirmFrozenFictionalData: true,
        } } : {}),
        ...(fund ? { fundConsent: {
          scope: "LOCAL_TEST_RELEASE", packageDigest: selected.digest, verificationId: selectedReview.verificationId,
          businessDate: fund.businessDate, scheduleSpec: defaultLocalReleaseSchedule, confirmFrozenFictionalData: true,
        } } : {}),
      });
      setApprovalClock(Date.now());
      await loadLifecycle();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy("");
    }
  };
  const publish = async () => {
    if (!selected) return;
    const approval = selectedApproval;
    if (!approval) return;
    const scheduleSpec = syncInput ? approval.syncConsent?.scheduleSpec : fund ? approval.fundConsent?.scheduleSpec : defaultLocalReleaseSchedule;
    if (syncInput && !approval.consumedByReleaseId && Date.now() >= Date.parse(approval.expiresAt ?? "")) {
      setApprovalClock(Date.now());
      setError("测试发布批准已过期，请重新确认该版本。");
      return;
    }
    if (!scheduleSpec) return;
    setBusy("publish");
    setError("");
    try {
      await api<Release>("/releases", {
        approvalId: approval.id,
        ...scheduleSpec,
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
          item.status === "APPROVED" && (!fund || Boolean(item.fundConsent)) &&
          (!syncInput || item.syncConsent?.snapshotHash === syncInput.snapshotHash &&
            item.syncConsent.verificationId === check?.id && (item.consumedByReleaseId || Date.parse(item.expiresAt ?? "") > approvalClock)),
      )
    : undefined;
  const selectedRelease = selected
    ? releases.find(
        (item) =>
          item.packageId === selected.id &&
          item.packageDigest === selected.digest,
      )
    : undefined;
  useEffect(() => {
    if (!syncInput || !selectedApproval?.expiresAt || selectedApproval.consumedByReleaseId) return;
    const timer = setTimeout(() => { setApprovalClock(Date.now()); setSyncConsentTarget(undefined); },
      Math.max(0, Date.parse(selectedApproval.expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [syncInput, selectedApproval?.expiresAt, selectedApproval?.consumedByReleaseId]);
  const stopScopedRelease = async () => {
    if ((!fund && !syncInput) || !selectedRelease) return;
    setBusy("stop");
    setError("");
    try {
      await api(`/releases/${selectedRelease.id}/cancel`, { packageDigest: selectedRelease.packageDigest });
      await loadLifecycle();
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy("");
    }
  };
  const activeRelease = monitor?.activeRelease;
  const selectedIsActive = Boolean(
    fund || syncInput ? selectedRelease?.status === "ACTIVE_LOCAL" : selectedRelease?.id && selectedRelease.id === activeRelease?.id,
  );
  const selectedHealthy = Boolean(
    selectedIsActive &&
    selectedRelease?.health === "HEALTHY" &&
    Number(selectedRelease?.successfulRunCount ?? 0) >= 2 &&
    Number(selectedRelease?.openAlertCount ?? 0) === 0,
  );
  const fundSourceBatches = fund && selectedHealthy ? (monitor?.recentRuns ?? [])
    .filter(batch => batch.releaseId === selectedRelease?.id && batch.status === "SUCCEEDED")
    .sort((left, right) => left.sequence - right.sequence) : [];
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
  const rollbackTarget = activeRelease && !activeRelease.fundLookthrough && !activeRelease.syncInput
    ? releases.find(
        (item) =>
          item.id !== activeRelease.id &&
          !item.fundLookthrough && !item.syncInput &&
          item.status === "SUPERSEDED_LOCAL" &&
          Number(item.successfulRunCount ?? 0) > 0,
      )
    : undefined;
  const selectedIsPython =
    selected?.manifest.format === "shuduo-python-delivery/v1";
  const selectedSourceHash =
    selected?.manifest.source.codeHash ?? selected?.manifest.source.sqlHash ?? "";
  const reportBatchIds = monitor?.recentRuns.filter(batch => batch.releaseId === selectedRelease?.id && batch.status === "SUCCEEDED" && batch.schedulerTriggered === true).map(batch => batch.id) ?? [];
  const syncHandoff:ServiceSourceBinding|undefined = syncInput && syncInput.developmentMode !== "MANUAL" &&
    selected && selectedRelease && selectedHealthy && reportBatchIds.length === 2 && selectedRelease.syncInput?.snapshotHash === syncInput.snapshotHash
    ? {taskId:syncInput.agentTaskId,packageDigest:selected.digest,releaseId:selectedRelease.id,sourceKind:"AGENT",scope:"LOCAL_TEST_ONLY",
        revisionId:selected.manifest.source.revisionId,runId:selected.manifest.source.runId} : undefined;
  const reportSource:PublishedReportSource|undefined=syncHandoff && syncHandoff.taskId && syncHandoff.revisionId && syncHandoff.runId
    ? {kind:"AGENT",taskId:syncHandoff.taskId,releaseId:syncHandoff.releaseId,packageDigest:syncHandoff.packageDigest,revisionId:syncHandoff.revisionId,runId:syncHandoff.runId,batchIds:reportBatchIds}
    : (!syncInput||syncInput.developmentMode==="MANUAL"&&selectedHealthy)&&(!fund||selectedHealthy)&&sourceLocked&&source&&selected&&selectedRelease&&selectedRelease.sourceRevisionId===selected.manifest.source.revisionId&&reportBatchIds.length
      ? {kind:"MANUAL",releaseId:selectedRelease.id,packageDigest:selected.digest,revisionId:selected.manifest.source.revisionId,runId:selected.manifest.source.runId,batchIds:reportBatchIds} : undefined;
  return (
    <div className="delivery-workbench">
      <div className="delivery-notice">
        <ShieldCheck size={19} />
        <div>
          <strong>{syncFileScope ? "冻结持仓 · 文件交付与测试发布" : "M2a–M2c · 从文件交付到本机发布监控"}</strong>
          <p>
            {syncFileScope ? "沿原快照生成八文件、执行 Spark 演练并审阅版本。确认测试计划后可安排两个本机计时批次。" :
              "先按文件演练，再锁定摘要审批。本机发布由真实墙上时钟触发两个真实运行批次并产生监控证据；SQL使用Spark，Python使用受限CPython；全程不代表公网或生产上线。"}
          </p>
          {syncInput && <small>同步批次 {syncInput.runId.slice(0,8)} · 元数据 {syncInput.metadataVersionId.slice(0,8)} · {syncInput.rowCount} 行 · 快照 {syncInput.snapshotHash.slice(0,12)}</small>}
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
            <label htmlFor="delivery-source">已通过当前验证的 SQL 运行（Python包由Data Agent生成）</label>
            <select
              id="delivery-source"
              value={source}
              onChange={(event) => setSource(event.target.value)}
              disabled={sourceLocked || !eligible.length || !!busy}
            >
              {!source && (
                <option value="">{eligible.length ? "请明确选择已验证运行" : "尚无可用运行，请先完成代码验证"}</option>
              )}
              {eligible.map((run) => (
                <option key={run.id} value={run.id}>
                  {run.contextId ?? "原客户资产口径"} · 批次 {run.id.slice(0, 8)}
                </option>
              ))}
            </select>
            {sourceIssue && <p role="status">{sourceIssue}</p>}
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
            SQL包包含main.sql/tests.sql，Python包包含main.py；两者都绑定调度、部署、日历、冻结输入和验证报告。
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
              <code>{selectedSourceHash.slice(0, 12)}</code>
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
                  <span>1</span>执行 {selectedIsPython ? "main.py" : "main.sql"}
                </li>
                <li>
                  <span>2</span>{selectedIsPython ? "执行受限Python五场景断言" : fund ? "运行 tests.sql 与组合独立断言" : "运行 tests.sql 与五场景核验"}
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
              {savedChecks.length > 0 && <label className="delivery-rehearsal-history">
                已保存的文件演练
                <select value={check?.id ?? ""} disabled={Boolean(busy)} onChange={event=>void openCheck(event.target.value)}>
                  <option value="" disabled>选择演练</option>
                  {savedChecks.map(item=><option key={item.id} value={item.id}>{labels[item.status] ?? item.status} · {item.id.slice(0,8)}</option>)}
                </select>
              </label>}
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
                          const request = ticket.current;
                          try {
                            const cancelled = await api<Verification>(
                              "/delivery/verifications/" + check.id + "/cancel", {},
                            );
                            if (request !== ticket.current) return;
                            if (cancelled.id !== check.id || !matchingDeliveryVerification(selected, [cancelled])) {
                              setError("演练回执与当前交付包不一致，请重新核对。");
                              return;
                            }
                            setCheck(cancelled);
                          } catch (error) {
                            if (request === ticket.current) setError((error as Error).message);
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
                  {rehearsalSchema && <SyncOutputSchemaDetails schema={rehearsalSchema}/>}
                  {check.rehearsalOutputSchema !== undefined && !rehearsalSchema &&
                    <p role="status">结构差异未能与原演练对应，已保留原回执。</p>}
                  {check.status === "SUCCEEDED" && (
                    <p>
                      {selectedIsPython ? "Python代码与五场景断言已实际执行 · CPython " : "测试 SQL 已实际执行 · Spark "}{check.engineVersion}
                      <br />
                      未触发云部署或发布
                    </p>
                  )}
                </div>
              )}
            </aside>
          </div>
          <section className="release-lifecycle" aria-label="发布与监控链路">
            {syncInput && check?.status === "FAILED" && selectedRelease &&
              <p role="status" className="delivery-error-text">当前所选演练失败。下方运行监控对应本包此前的发布。</p>}
            <div className="release-stepper">
              {[
                ["01", "交付包", "不可变代码与文件摘要", true],
                [
                  "02",
                  "文件演练",
                  selectedIsPython ? "CPython与独立断言" : "Spark与独立断言",
                  check?.status === "SUCCEEDED",
                ],
                ["03", "审批发布", "摘要绑定与计时触发", !!selectedRelease],
                ["04", "运行监控", "两批、告警与恢复", selectedHealthy],
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
                    <h3>{syncInput ? "审阅此文件版本" : "审批绑定不可变版本"}</h3>
                  </div>
                  <ShieldCheck size={22} />
                </header>
                <p>
                  {syncInput ? "文件审阅绑定包摘要与成功演练。测试发布批准在 15 分钟内有效。" : <>先形成绑定当前摘要与演练编号的审阅记录，再决定是否审批。{localReleaseScheduleText(selectedRelease)}</>}
                </p>
                {signedFundTask && <p><a href={`/v2/?module=agent-center&task=${encodeURIComponent(signedFundTask)}#agent-delivery`}>到原 Agent 任务审阅签名交付</a></p>}
                <fieldset className="delivery-review-checklist" disabled={!canWrite || !reviewTarget || !!selectedReview || !!busy}>
                  <legend>工程师审阅确认（不会发布）</legend>
                  {[
                    ["code", selectedIsPython ? "已核对 Python 版本及业务口径" : "已核对 SQL 版本及业务口径"],
                    ["assertions", selectedIsPython ? "已核对独立断言与CPython演练结果" : "已核对独立断言与Spark演练结果"],
                    ["deliveryFiles", "已核对 DAG、调度和部署文件摘要"],
                    ["localScope", "确认本次仅为本机合成数据验证，非公网或生产发布"],
                  ].map(([key, label]) => (
                    <label key={key} className="delivery-review-check">
                      <input
                        type="checkbox"
                        checked={attestations[key as keyof typeof attestations]}
                        onChange={(event) => {
                          const checked = event.currentTarget.checked;
                          editReviewDraft(draft => ({ ...draft, attestations: { ...draft.attestations, [key]: checked } }));
                        }}
                      />
                      {label}
                    </label>
                  ))}
                  <textarea
                    aria-label="审阅备注"
                    value={reviewNote}
                    maxLength={500}
                    onChange={(event) => {
                      const note = event.currentTarget.value;
                      editReviewDraft(draft => ({ ...draft, note }));
                    }}
                    placeholder="说明已核对的口径或限制"
                  />
                </fieldset>
                {fund && !selectedApproval && <label className="delivery-review-check">
                  <input type="checkbox" checked={fundConfirmed}
                    disabled={!canWrite || !selectedReview || !reviewTarget || !!busy}
                    onChange={event => setFundConsentTarget(event.currentTarget.checked ? reviewTarget : undefined)} />
                  确认仅发布此包的两个本机虚构批次，使用同一业务日 {fund.businessDate}
                </label>}
                {syncInput && !selectedApproval && <label className="delivery-review-check">
                  <input type="checkbox" checked={syncConfirmed} disabled={!canWrite || !selectedReview || !check?.occurrence?.businessDate || !!busy}
                    onChange={event => setSyncConsentTarget(event.currentTarget.checked ? reviewTarget : undefined)} />
                  确认原快照 {syncInput.snapshotHash.slice(0,12)} 与业务日 {check?.occurrence?.businessDate ?? "待演练"}。发布后第 5 秒起执行两批，间隔 45 秒。
                </label>}
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
                      (Boolean(fund) && !fundConfirmed) ||
                      (Boolean(syncInput) && !syncConfirmed) ||
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
                  {(fund || syncInput) && selectedRelease?.status === "ACTIVE_LOCAL" && <button className="button" disabled={!canWrite || !!busy} onClick={stopScopedRelease}>
                    <Square size={15} />停止后续批次
                  </button>}
                </div>
                {selectedApproval && (
                  <small className="release-proof-line">
                    审批 {selectedApproval.id.slice(0, 8)} · 包摘要
                    {selectedApproval.packageDigest.slice(0, 12)} · 仅本机测试
                    {syncInput && selectedApproval.expiresAt && !selectedApproval.consumedByReleaseId && ` · ${new Date(selectedApproval.expiresAt).toLocaleTimeString("zh-CN")}前可激活`}
                  </small>
                )}
                {selectedReview && !selectedApproval && (
                  <small className="release-proof-line">
                    审阅 {selectedReview.id.slice(0, 8)} · 演练
                    {selectedReview.verificationId.slice(0, 8)} · {syncInput ? "文件审阅已保存" : "尚未审批"}
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
                      {!fund && !syncInput && selectedIsActive && m2cRecoveryVerified ? " · 回滚恢复已验证" : ""}
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
                              {item.resultUnknown ? "执行中断，结果待核对" : releaseRunLabels[item.status] ?? item.status}
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
                    {syncHandoff && onOpenServices && <button className="button primary" onClick={()=>onOpenServices(syncHandoff)}>接续此版本的 DAPI／XAPI</button>}
                    {fund && selectedHealthy && fundSourceBatches.length === 2 && (
                      <FundSourceReadback key={selectedRelease.id} api={api} release={selectedRelease} batches={fundSourceBatches} />
                    )}
                    {!fund && !syncInput && selectedIsActive && rollbackTarget && (
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
          {reportSource&&<Suspense fallback={<p role="status">正在加载同源报表视图…</p>}><AgentReportPanel api={api} source={reportSource} canCreate={canWrite&&!busy} fund={Boolean(fund)} sync={Boolean(syncInput)}/></Suspense>}
        </>
      )}
    </div>
  );
}
