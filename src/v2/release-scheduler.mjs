const fail = (status, message) => Object.assign(new Error(message), { status });
const terminal = new Set([
  "SUCCEEDED",
  "FAILED",
  "VALIDATION_FAILED",
  "CANCELLED",
  "INTERRUPTED",
]);
const MAX_TIMER_DELAY = 2_147_000_000;

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
  }) {
    this.store = store;
    this.project = project;
    this.packageFor = packageFor;
    this.runPackage = runPackage;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.timers = new Map();
    this.controllers = new Map();
    this.queue = Promise.resolve();
    this.closed = false;
  }

  start() {
    for (const run of this.store.list("release_run", this.project))
      if (run.status === "SCHEDULED") this.schedule(run);
  }

  schedule(run) {
    if (this.closed || run.status !== "SCHEDULED" || this.timers.has(run.id))
      return;
    const delay = Math.max(0, Date.parse(run.scheduledTriggerAt) - this.now());
    const timer = this.setTimer(() => {
      this.timers.delete(run.id);
      if (delay > MAX_TIMER_DELAY) {
        this.schedule(this.store.get("release_run", run.id, this.project));
        return;
      }
      this.queue = this.queue
        .then(() => this.#run(run.id))
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

  shutdown() {
    this.closed = true;
    for (const timer of this.timers.values()) this.clearTimer(timer);
    this.timers.clear();
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
  }

  async #run(id) {
    if (this.closed) return;
    const run = this.store.get("release_run", id, this.project);
    if (!run || run.status !== "SCHEDULED") return;
    const release = this.store.get("release", run.releaseId, this.project);
    if (!release || release.status !== "ACTIVE_LOCAL") {
      this.store.update("release_run", id, this.project, {
        status: "CANCELLED",
        error: "发布版本已不再生效",
        finishedAt: new Date(this.now()).toISOString(),
      });
      return;
    }
    const packageItem = this.packageFor(run.packageId);
    if (!packageItem || packageItem.digest !== run.packageDigest) {
      await this.#finishFailure(run, release, "发布包记录或摘要不一致");
      return;
    }
    const controller = new AbortController();
    this.controllers.set(run.id, controller);
    const triggeredAt = new Date(this.now()).toISOString();
    this.store.update("release_run", id, this.project, {
      status: "RUNNING",
      triggeredAt,
      startedAt: triggeredAt,
      schedulerTriggered: true,
    });
    try {
      const result = await this.runPackage({
        directory: release.artifactDirectory,
        expectedDigest: run.packageDigest,
        scheduledFor: run.businessScheduledFor,
        signal: controller.signal,
      });
      if (!terminal.has(result.status) || result.status === "INTERRUPTED")
        throw new Error("发布执行器返回无效状态");
      const finished = this.store.update("release_run", id, this.project, {
        ...result,
        status: result.status,
        mode: "LOCAL_SCHEDULED_RELEASE",
        clockMode: "WALL_CLOCK_TIMER",
        schedulerTriggered: true,
        published: true,
        publicDeployed: false,
        fullLifecycleE2E: false,
        finishedAt: new Date(this.now()).toISOString(),
        notice:
          "由本机墙上时钟调度器触发并执行；属于本机测试发布，不是公网或生产部署。",
      });
      await this.#recordMonitoring(finished, release);
    } catch (error) {
      await this.#finishFailure(run, release, error.message);
    } finally {
      this.controllers.delete(run.id);
    }
  }

  async #finishFailure(run, release, message) {
    const failed = this.store.update("release_run", run.id, this.project, {
      status: "FAILED",
      error: String(message).slice(0, 3000),
      mode: "LOCAL_SCHEDULED_RELEASE",
      clockMode: "WALL_CLOCK_TIMER",
      schedulerTriggered: true,
      published: true,
      publicDeployed: false,
      fullLifecycleE2E: false,
      finishedAt: new Date(this.now()).toISOString(),
    });
    await this.#recordMonitoring(failed, release);
  }

  async #recordMonitoring(run, release) {
    const success = run.status === "SUCCEEDED";
    this.store.create("monitor_event", this.project, {
      type: success ? "BATCH_SUCCEEDED" : "BATCH_FAILED",
      releaseId: release.id,
      releaseRunId: run.id,
      observedAt: new Date(this.now()).toISOString(),
      status: run.status,
      durationMs: run.durationMs ?? null,
      schedulerTriggered: run.schedulerTriggered === true,
    });
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
    } else {
      for (const alert of this.store.list("monitor_alert", this.project)) {
        if (alert.releaseId === release.id && alert.status === "OPEN") {
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
        .filter((item) => item.releaseId === release.id),
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
