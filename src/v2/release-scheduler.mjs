import { validationWithoutRawComparisons } from "./validation-details.mjs";

const fail = (status, message) => Object.assign(new Error(message), { status });
const terminal = new Set([
  "SUCCEEDED",
  "FAILED",
  "VALIDATION_FAILED",
  "CANCELLED",
  "INTERRUPTED",
]);
const MAX_TIMER_DELAY = 2_147_000_000;
export const localReleaseUnknownResultCode = "LOCAL_RELEASE_RESULT_UNKNOWN";
const durableProfile = (leaseMs) => ({
  mode: "CLOUD_DURABLE_SCHEDULE",
  clockMode: "EXTERNAL_DURABLE_TICK",
  publicDeployed: false,
  allowedReleaseStatuses: ["ACTIVE_CLOUD"],
  leaseMs,
  notice:
    "由外部持久调度tick领取并执行；云资源和公网验收完成前不标记为公网发布。",
});

export function localScheduleSpec(input = {}) {
  const integer = (name, fallback, min, max) => {
    const value = input[name] === undefined ? fallback : Number(input[name]);
    if (!Number.isSafeInteger(value) || value < min || value > max)
      throw fail(400, `${name} 必须是 ${min}—${max} 的整数`);
    return value;
  };
  return {
    triggerAfterSeconds: integer("triggerAfterSeconds", 5, 1, 300),
    intervalSeconds: integer("intervalSeconds", 15, 1, 300),
    runCount: integer("runCount", 2, 2, 3),
  };
}

export function plannedLocalRuns({
  releaseId,
  packageId,
  packageDigest,
  businessScheduledFor,
  spec,
  nowMs = Date.now(),
  timeUnitMs = 1000,
  triggerReason = "LOCAL_TEST_SCHEDULE",
}) {
  if (
    ![releaseId, packageId, packageDigest, businessScheduledFor].every(
      (value) => typeof value === "string" && value.length > 0,
    ) ||
    !Number.isFinite(nowMs) ||
    !Number.isSafeInteger(timeUnitMs) ||
    timeUnitMs < 1
  )
    throw fail(400, "本机调度计划参数不完整");
  const normalized = localScheduleSpec(spec);
  return Array.from({ length: normalized.runCount }, (_, index) => ({
    releaseId,
    packageId,
    packageDigest,
    sequence: index + 1,
    triggerReason,
    status: "SCHEDULED",
    scheduledTriggerAt: new Date(
      nowMs +
        (normalized.triggerAfterSeconds + index * normalized.intervalSeconds) *
          timeUnitMs,
    ).toISOString(),
    businessScheduledFor,
    schedulerTriggered: false,
    published: true,
    publicDeployed: false,
    fullLifecycleE2E: false,
  }));
}

export function publicRelease(item, workspaceRoot = "") {
  if (!item) return item;
  const { artifactDirectory, ...safe } = item;
  return {
    ...safe,
    ...(Object.hasOwn(safe, "validation") ? { validation: validationWithoutRawComparisons(safe.validation) } : {}),
    artifactReady: Boolean(artifactDirectory),
    ...(safe.log
      ? {
          logExcerpt: String(safe.log)
            .replaceAll(workspaceRoot, "<workspace>")
            .slice(-4000),
          logAvailable: true,
          log: undefined,
        }
      : {}),
  };
}

export class LocalReleaseScheduler {
  constructor({
    store,
    project,
    packageFor,
    runPackage,
    now = () => Date.now(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    persist = async () => undefined,
    resolveDirectory = async ({ release }) => release.artifactDirectory,
    assertRunSource = () => {},
    fundExecutionEvidenceMode,
  }) {
    this.store = store;
    this.project = project;
    this.packageFor = packageFor;
    this.runPackage = runPackage;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.persist = persist;
    this.resolveDirectory = resolveDirectory;
    this.assertRunSource = assertRunSource;
    this.fundExecutionEvidenceMode = fundExecutionEvidenceMode;
    this.timers = new Map();
    this.controllers = new Map();
    this.queue = Promise.resolve();
    this.closed = false;
  }

  start() {
    if (this.closed) return;
    for (const run of this.store.list("release_run", this.project)) {
      if (run.status === "SCHEDULED") this.schedule(run);
      else if (run.status === "INTERRUPTED") this.#recordInterruptedResult(run);
    }
  }

  #recordInterruptedResult(run) {
    if (run.resultUnknown === true || run.mode !== "LOCAL_SCHEDULED_RELEASE" ||
        run.clockMode !== "WALL_CLOCK_TIMER" || run.schedulerTriggered !== true ||
        !Number.isFinite(Date.parse(run.triggeredAt))) return;
    const release = this.store.get("release", run.releaseId, this.project);
    if (!release || release.publicDeployed !== false || release.packageId !== run.packageId ||
        release.packageDigest !== run.packageDigest) return;
    const key = `${this.project}:local-release-result-unknown:${run.id}`;
    const signature = JSON.stringify([release.id, run.packageDigest, run.triggeredAt]);
    this.store.deduplicate(key, signature, () => {
      const observedAt = new Date(this.now()).toISOString();
      const message = "本机服务重启前此批次已触发，执行结果待核对。请按原批次查证。";
      const marked = this.store.update("release_run", run.id, this.project, {
        resultUnknown: true, resultUnknownObservedAt: observedAt, error: message,
      });
      this.store.create("monitor_event", this.project, {
        type: "BATCH_RESULT_UNKNOWN", releaseId: release.id, releaseRunId: run.id, packageDigest: run.packageDigest,
        observedAt, status: "INTERRUPTED", schedulerTriggered: true,
      });
      this.store.create("monitor_alert", this.project, {
        releaseId: release.id, releaseRunId: run.id, status: "OPEN", severity: "ERROR",
        code: localReleaseUnknownResultCode, message, openedAt: observedAt,
      });
      const openAlertCount = this.store.list("monitor_alert", this.project)
        .filter(alert => alert.releaseId === release.id && alert.status === "OPEN").length;
      this.store.update("release", release.id, this.project, {
        ...(release.status === "ACTIVE_LOCAL" ? { health: "CRITICAL" } : {}),
        openAlertCount, lastObservedAt: observedAt,
      });
      return marked;
    });
  }

  schedule(run) {
    if (this.closed || run?.status !== "SCHEDULED" || this.timers.has(run.id))
      return;
    const delay = Math.max(0, Date.parse(run.scheduledTriggerAt) - this.now());
    const timer = this.setTimer(() => {
      if (this.closed || this.timers.get(run.id) !== timer) return;
      this.timers.delete(run.id);
      if (delay > MAX_TIMER_DELAY) {
        this.schedule(this.store.get("release_run", run.id, this.project));
        return;
      }
      this.queue = this.queue
        .then(() => this.executeRun(run.id))
        .catch((error) => {
          if (!this.closed) console.error("本机发布调度失败：" + error.message);
        });
    }, Math.min(delay, MAX_TIMER_DELAY));
    timer.unref?.();
    this.timers.set(run.id, timer);
  }

  cancelRelease(releaseId, reason = "发布已停止") {
    for (const run of this.store.list("release_run", this.project)) {
      if (run.releaseId !== releaseId || terminal.has(run.status)) continue;
      const timer = this.timers.get(run.id);
      if (timer) this.clearTimer(timer);
      this.timers.delete(run.id);
      this.controllers.get(run.id)?.abort();
      this.store.update("release_run", run.id, this.project, {
        status: "CANCELLED",
        error: reason,
        finishedAt: new Date(this.now()).toISOString(),
      });
    }
  }

  async waitForIdle() {
    await this.queue;
  }

  enqueue(runId, profile) {
    this.queue = this.queue.then(() => this.executeRun(runId, profile));
    return this.queue;
  }

  shutdown() {
    this.closed = true;
    for (const timer of this.timers.values()) this.clearTimer(timer);
    this.timers.clear();
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
  }

  async executeRun(id, profile = {}) {
    if (this.closed) return;
    const run = this.store.get("release_run", id, this.project);
    if (!run || run.status !== "SCHEDULED") return;
    const pendingTimer = this.timers.get(id);
    if (pendingTimer !== undefined) {
      this.clearTimer(pendingTimer);
      this.timers.delete(id);
    }
    const release = this.store.get("release", run.releaseId, this.project);
    const allowedReleaseStatuses = profile.allowedReleaseStatuses ?? ["ACTIVE_LOCAL"];
    if (!release || !allowedReleaseStatuses.includes(release.status)) {
      this.store.update("release_run", id, this.project, {
        status: "CANCELLED",
        error: "发布版本已不再生效",
        finishedAt: new Date(this.now()).toISOString(),
      });
      await this.persist();
      return;
    }
    const packageItem = this.packageFor(run.packageId);
    if (!packageItem || packageItem.digest !== run.packageDigest) {
      await this.#finishFailure(run, release, "发布包记录或摘要不一致", profile);
      return;
    }
    // Timers can wake before the wall-clock deadline, and queued work may see
    // a clock change. Recheck at the claim boundary, before recording a trigger
    // or calling the runner; a wake-up is not evidence that this batch is due.
    const triggerTime = this.now();
    if ((profile.clockMode ?? "WALL_CLOCK_TIMER") === "WALL_CLOCK_TIMER" &&
        triggerTime < Date.parse(run.scheduledTriggerAt)) {
      this.schedule(run);
      return;
    }
    const controller = new AbortController();
    this.controllers.set(run.id, controller);
    const triggeredAt = new Date(triggerTime).toISOString();
    this.store.update("release_run", id, this.project, {
      status: "RUNNING",
      triggeredAt,
      startedAt: triggeredAt,
      schedulerTriggered: true,
      mode: profile.mode ?? "LOCAL_SCHEDULED_RELEASE",
      clockMode: profile.clockMode ?? "WALL_CLOCK_TIMER",
      ...(profile.leaseMs
        ? { leaseExpiresAt: new Date(this.now() + profile.leaseMs).toISOString() }
        : {}),
    });
    // A durable scheduler must persist the claim before any side effect. If the
    // process dies afterwards, a later tick can recover the expired lease.
    let claimPersisted = false;
    const stopped=()=>controller.signal.aborted||!allowedReleaseStatuses.includes(this.store.get('release',release.id,this.project)?.status);
    const cancelBeforeRun=async()=>{
      const current=this.store.get('release_run',id,this.project);
      if(!terminal.has(current.status))this.store.update('release_run',id,this.project,{status:'CANCELLED',error:'发布已停止，未提交计算',finishedAt:new Date(this.now()).toISOString()});
      await this.persist();return this.store.get('release_run',id,this.project);
    };
    try {
      await this.persist();
      claimPersisted = true;
      if(stopped())return await cancelBeforeRun();
      this.assertRunSource({run,release,packageItem});
      const directory = await this.resolveDirectory({
        run,
        release,
        packageItem,
      });
      if(stopped())return await cancelBeforeRun();
      this.assertRunSource({run,release,packageItem});
      const executionStartedAt = new Date(this.now()).toISOString();
      const result = await this.runPackage({
        directory,
        expectedDigest: run.packageDigest,
        scheduledFor: run.businessScheduledFor,
        signal: controller.signal,
        ...(packageItem.manifest?.source?.fundSignedExecution
          ? { beforeRun: () => this.assertRunSource({run,release,packageItem}) }
          : {}),
      });
      if((release.outputContract||release.fundLookthrough)&&stopped())return await cancelBeforeRun();
      if (!terminal.has(result.status) || result.status === "INTERRUPTED")
        throw new Error("发布执行器返回无效状态");
      const finished = this.store.update("release_run", id, this.project, {
        ...result,
        ...(release.fundLookthrough ? { executionEvidenceMode: this.fundExecutionEvidenceMode, startedAt: executionStartedAt } : {}),
        status: result.status,
        mode: profile.mode ?? "LOCAL_SCHEDULED_RELEASE",
        clockMode: profile.clockMode ?? "WALL_CLOCK_TIMER",
        schedulerTriggered: true,
        published: true,
        publicDeployed: profile.publicDeployed === true,
        fullLifecycleE2E: false,
        leaseExpiresAt: null,
        finishedAt: new Date(this.now()).toISOString(),
        notice:
          profile.notice ??
          "由本机墙上时钟调度器触发并执行；属于本机测试发布，不是公网或生产部署。",
      });
      await this.#recordMonitoring(finished, release);
      await this.persist();
      return finished;
    } catch (error) {
      if (!claimPersisted) throw error;
      if((release.outputContract||release.fundLookthrough)&&controller.signal.aborted)return await cancelBeforeRun();
      return this.#finishFailure(run, release, error.message, profile);
    } finally {
      this.controllers.delete(run.id);
    }
  }

  async #finishFailure(run, release, message, profile = {}) {
    const failed = this.store.update("release_run", run.id, this.project, {
      status: "FAILED",
      error: String(message).slice(0, 3000),
      mode: profile.mode ?? "LOCAL_SCHEDULED_RELEASE",
      clockMode: profile.clockMode ?? "WALL_CLOCK_TIMER",
      schedulerTriggered: true,
      published: true,
      publicDeployed: profile.publicDeployed === true,
      fullLifecycleE2E: false,
      leaseExpiresAt: null,
      finishedAt: new Date(this.now()).toISOString(),
    });
    await this.#recordMonitoring(failed, release);
    await this.persist();
    return failed;
  }

  async #recordMonitoring(run, release) {
    const success = run.status === "SUCCEEDED";
    this.store.create("monitor_event", this.project, {
      type: success ? "BATCH_SUCCEEDED" : (release.outputContract||release.fundLookthrough)&&run.status==="CANCELLED"?"BATCH_CANCELLED":"BATCH_FAILED",
      releaseId: release.id,
      releaseRunId: run.id,
      packageDigest: run.packageDigest,
      observedAt: new Date(this.now()).toISOString(),
      status: run.status,
      durationMs: run.durationMs ?? null,
      schedulerTriggered: run.schedulerTriggered === true,
    });
    if((release.outputContract||release.fundLookthrough)&&run.status==='CANCELLED')return;
    let recoveredAlerts = 0;
    if (!success) {
      this.store.create("monitor_alert", this.project, {
        releaseId: release.id,
        releaseRunId: run.id,
        status: "OPEN",
        severity: "ERROR",
        code: "LOCAL_RELEASE_BATCH_FAILED",
        message: run.error ?? "本机发布批次失败",
        openedAt: new Date(this.now()).toISOString(),
      });
    } else if (!release.fundLookthrough) {
      for (const alert of this.store.list("monitor_alert", this.project)) {
        if (alert.releaseId === release.id && alert.status === "OPEN" && alert.code !== localReleaseUnknownResultCode) {
          recoveredAlerts++;
          this.store.update("monitor_alert", alert.id, this.project, {
            status: "RESOLVED",
            resolvedAt: new Date(this.now()).toISOString(),
            recoveryRunId: run.id,
          });
        }
      }
    }
    const runs = this.store
        .list("release_run", this.project)
        .filter((item) => item.releaseId === release.id && (!release.outputContract||!release.currentRollbackId||item.rollbackId===release.currentRollbackId)),
      successfulRunCount = runs.filter(
        (item) => item.status === "SUCCEEDED",
      ).length,
      failedRunCount = runs.filter((item) =>
        ["FAILED", "VALIDATION_FAILED"].includes(item.status),
      ).length,
      openAlertCount = this.store
        .list("monitor_alert", this.project)
        .filter(
          (item) => item.releaseId === release.id && item.status === "OPEN",
        ).length,
      health = openAlertCount
        ? "CRITICAL"
        : successfulRunCount >= 2
          ? "HEALTHY"
          : recoveredAlerts
            ? "RECOVERING"
            : "OBSERVING";
    if(release.outputContract&&release.currentRollbackId){
      const rollback=this.store.get('release_rollback',release.currentRollbackId,this.project);
      if(rollback?.status==='SCHEDULED_FOR_VERIFICATION'&&successfulRunCount>=2&&!openAlertCount){
        const resolvedAlertIds=[];
        for(const alert of this.store.list('monitor_alert',this.project))if(alert.releaseId===rollback.fromReleaseId&&alert.status==='OPEN'&&alert.code!==localReleaseUnknownResultCode){
          resolvedAlertIds.push(alert.id);this.store.update('monitor_alert',alert.id,this.project,{status:'RESOLVED',resolutionMode:'VERIFIED_ROLLBACK',recoveryReleaseId:release.id,recoveryRunId:run.id,resolvedAt:new Date(this.now()).toISOString()});
        }
        this.store.update('release_rollback',rollback.id,this.project,{status:'VERIFIED',resolvedAlertIds,verifiedAt:new Date(this.now()).toISOString()});
        this.store.create('monitor_event',this.project,{type:'ROLLBACK_VERIFIED',releaseId:rollback.fromReleaseId,recoveryReleaseId:release.id,rollbackId:rollback.id,releaseRunId:run.id,observedAt:new Date(this.now()).toISOString(),status:'RECOVERY_VERIFIED'});
      }else if(rollback?.status==='SCHEDULED_FOR_VERIFICATION'&&runs.every(r=>terminal.has(r.status))&&failedRunCount){
        this.store.update('release_rollback',rollback.id,this.project,{status:'FAILED',failedAt:new Date(this.now()).toISOString()});
      }
    }
    this.store.update("release", release.id, this.project, {
      health,
      lastRunId: run.id,
      lastRunStatus: run.status,
      successfulRunCount,
      failedRunCount,
      openAlertCount,
      lastObservedAt: new Date(this.now()).toISOString(),
    });
  }
}

export class DurableReleaseScheduler extends LocalReleaseScheduler {
  constructor({ refresh = async () => undefined, leaseMs = 300_000, ...options }) {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 30_000 || leaseMs > 900_000)
      throw new Error("持久调度租约必须是30000—900000毫秒的整数");
    super(options);
    this.refresh = refresh;
    this.leaseMs = leaseMs;
    this.tickPromise = undefined;
  }

  // Durable runs are woken by an external cloud tick, never an in-process timer.
  start() {}

  schedule() {}

  tick({ limit = 1 } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10)
      return Promise.reject(fail(400, "单次持久调度领取上限必须是1—10"));
    if (this.closed) return Promise.reject(fail(503, "持久调度器已关闭"));
    if (this.tickPromise) return this.tickPromise;
    this.tickPromise = this.#tick(limit).finally(() => {
      this.tickPromise = undefined;
    });
    return this.tickPromise;
  }

  async #tick(limit) {
    await this.refresh();
    const nowMs = this.now(),
      nowIso = new Date(nowMs).toISOString();
    let recovered = 0;
    for (const run of this.store.list("release_run", this.project)) {
      if (
        run.status === "RUNNING" &&
        run.mode === "CLOUD_DURABLE_SCHEDULE" &&
        Number.isFinite(Date.parse(run.leaseExpiresAt)) &&
        Date.parse(run.leaseExpiresAt) <= nowMs
      ) {
        recovered++;
        this.store.update("release_run", run.id, this.project, {
          status: "SCHEDULED",
          schedulerTriggered: false,
          leaseExpiresAt: null,
          recoveredAt: nowIso,
          recoveryCount: Number(run.recoveryCount ?? 0) + 1,
        });
      }
    }
    if (recovered) await this.persist();
    const due = this.store
      .list("release_run", this.project)
      .filter(
        (run) => {
          const release = this.store.get("release", run.releaseId, this.project);
          return (
            run.status === "SCHEDULED" &&
            release?.status === "ACTIVE_CLOUD" &&
            Number.isFinite(Date.parse(run.scheduledTriggerAt)) &&
            Date.parse(run.scheduledTriggerAt) <= nowMs
          );
        },
      )
      .sort(
        (left, right) =>
          Date.parse(left.scheduledTriggerAt) - Date.parse(right.scheduledTriggerAt) ||
          left.id.localeCompare(right.id),
      );
    const executed = [];
    for (const run of due.slice(0, limit)) {
      const result = await this.enqueue(run.id, durableProfile(this.leaseMs));
      if (result) executed.push({ id: result.id, status: result.status });
    }
    return {
      mode: "CLOUD_DURABLE_SCHEDULE",
      tickedAt: nowIso,
      recovered,
      due: due.length,
      executed,
      remaining: Math.max(0, due.length - executed.length),
    };
  }
}
