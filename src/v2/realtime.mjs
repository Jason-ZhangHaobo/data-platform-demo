import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, resolve, sep } from "node:path";

const fail = (status, message, code) =>
  Object.assign(new Error(message), { status, code });
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const canonical = (value) =>
  JSON.stringify(
    value && typeof value === "object"
      ? Array.isArray(value)
        ? value.map((item) => JSON.parse(canonical(item)))
        : Object.fromEntries(
            Object.keys(value)
              .filter((key) => value[key] !== undefined)
              .sort()
              .map((key) => [key, JSON.parse(canonical(value[key]))]),
          )
      : value,
  );
const stableHash = (value) => sha256(canonical(value));
const text = (value, name, min = 1, max = 100) => {
  if (
    typeof value !== "string" ||
    value.trim().length < min ||
    value.length > max
  )
    throw fail(400, `${name}长度必须为${min}—${max}个字符`, "INVALID_TEXT");
  return value.trim();
};
const identifier = (value, name) => {
  const result = text(value, name, 1, 63);
  if (!/^[a-z][a-z0-9_]*$/.test(result))
    throw fail(400, `${name}只能使用小写字母、数字和下划线`, "INVALID_IDENTIFIER");
  return result;
};
const streamFileName = (value) => {
  const result = text(value, "事件日志文件", 7, 110);
  if (!/^[a-z0-9][a-z0-9_.-]*\.jsonl$/.test(result))
    throw fail(
      400,
      "事件日志只允许合成目录内的JSONL文件名",
      "INVALID_STREAM_FILE",
    );
  return result;
};
const positiveInteger = (value, name, fallback, min, max) => {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max)
    throw fail(400, `${name}必须为${min}—${max}的整数`, "INVALID_INTEGER");
  return result;
};
const linesOf = (content) => {
  const lines = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length || lines.length > 10_000)
    throw fail(422, "事件日志必须包含1—10000行", "INVALID_EVENT_LOG");
  return lines;
};
const prefixHash = (lines, offset) =>
  sha256(lines.slice(0, offset + 1).join("\n"));
const decimal2 = (value) => {
  const result = String(value);
  if (!/^\d+(?:\.\d{1,2})?$/.test(result) || Number(result) <= 0)
    throw fail(422, "行情价格必须是大于0的两位小数", "INVALID_QUOTE_PRICE");
  const [whole, fraction = ""] = result.split(".");
  return `${whole}.${fraction.padEnd(2, "0")}`;
};
export function validateQuoteEvent(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw fail(422, "行情事件必须是JSON对象", "INVALID_QUOTE_EVENT");
  const keys = [
    "event_id",
    "sequence",
    "security_code",
    "event_time",
    "price",
    "volume",
  ];
  if (
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  )
    throw fail(422, "行情事件字段与契约不一致", "INVALID_QUOTE_EVENT");
  const eventId = text(value.event_id, "事件编号", 5, 64),
    securityCode = text(value.security_code, "证券代码", 5, 40),
    eventTime = text(value.event_time, "事件时间", 20, 30),
    sequence = Number(value.sequence),
    volume = Number(value.volume);
  if (!/^EVT-[A-Z0-9-]+$/.test(eventId))
    throw fail(422, "事件编号格式不合法", "INVALID_EVENT_ID");
  if (!/^SEC-[A-Z0-9-]+$/.test(securityCode))
    throw fail(422, "证券代码格式不合法", "INVALID_SECURITY_CODE");
  if (
    !Number.isSafeInteger(sequence) ||
    sequence < 1 ||
    !Number.isSafeInteger(volume) ||
    volume < 0
  )
    throw fail(422, "行情序号或成交量不合法", "INVALID_QUOTE_NUMBER");
  if (
    Number.isNaN(Date.parse(eventTime)) ||
    new Date(eventTime).toISOString() !== eventTime
  )
    throw fail(422, "事件时间必须是标准UTC时间", "INVALID_EVENT_TIME");
  return {
    event_id: eventId,
    sequence,
    security_code: securityCode,
    event_time: eventTime,
    price: decimal2(value.price),
    volume,
  };
}

export class StreamStateStore {
  constructor(path = ":memory:") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS stream_events(job_id TEXT NOT NULL,event_id TEXT NOT NULL,source_offset INTEGER NOT NULL,sequence INTEGER NOT NULL,event_time TEXT NOT NULL,payload TEXT NOT NULL,event_hash TEXT NOT NULL,processed_at TEXT NOT NULL,PRIMARY KEY(job_id,event_id)); CREATE TABLE IF NOT EXISTS stream_state(job_id TEXT NOT NULL,state_key TEXT NOT NULL,payload TEXT NOT NULL,last_sequence INTEGER NOT NULL,event_time TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(job_id,state_key)); CREATE TABLE IF NOT EXISTS stream_checkpoints(id TEXT PRIMARY KEY,job_id TEXT NOT NULL,run_id TEXT NOT NULL,source_revision_id TEXT NOT NULL,last_offset INTEGER NOT NULL,event_count INTEGER NOT NULL,duplicate_count INTEGER NOT NULL,watermark TEXT NOT NULL,prefix_hash TEXT NOT NULL,state_hash TEXT NOT NULL,created_at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS stream_checkpoints_job ON stream_checkpoints(job_id,created_at);",
    );
  }

  applyEvent(jobId, event, offset, now) {
    const existing = this.db
      .prepare("SELECT event_id FROM stream_events WHERE job_id=? AND event_id=?")
      .get(jobId, event.event_id);
    if (existing) return { duplicate: true, stateUpdated: false };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const payload = canonical(event),
        eventHash = sha256(payload),
        state = this.db
          .prepare("SELECT * FROM stream_state WHERE job_id=? AND state_key=?")
          .get(jobId, event.security_code),
        stateUpdated = !state || event.sequence > state.last_sequence;
      this.db
        .prepare("INSERT INTO stream_events VALUES(?,?,?,?,?,?,?,?)")
        .run(
          jobId,
          event.event_id,
          offset,
          event.sequence,
          event.event_time,
          payload,
          eventHash,
          now,
        );
      if (stateUpdated)
        this.db
          .prepare(
            "INSERT INTO stream_state VALUES(?,?,?,?,?,?) ON CONFLICT(job_id,state_key) DO UPDATE SET payload=excluded.payload,last_sequence=excluded.last_sequence,event_time=excluded.event_time,updated_at=excluded.updated_at",
          )
          .run(
            jobId,
            event.security_code,
            payload,
            event.sequence,
            event.event_time,
            now,
          );
      this.db.exec("COMMIT");
      return { duplicate: false, stateUpdated, late: !stateUpdated, eventHash };
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  checkpoint(input) {
    const state = this.state(input.jobId),
      checkpoint = {
        id: randomUUID(),
        ...input,
        eventCount: this.eventCount(input.jobId),
        stateHash: stableHash(state),
      };
    this.db
      .prepare("INSERT INTO stream_checkpoints VALUES(?,?,?,?,?,?,?,?,?,?,?)")
      .run(
        checkpoint.id,
        checkpoint.jobId,
        checkpoint.runId,
        checkpoint.sourceRevisionId,
        checkpoint.lastOffset,
        checkpoint.eventCount,
        checkpoint.duplicateCount,
        checkpoint.watermark,
        checkpoint.prefixHash,
        checkpoint.stateHash,
        checkpoint.createdAt,
      );
    return checkpoint;
  }

  checkpoints(jobId) {
    return this.db
      .prepare(
        "SELECT * FROM stream_checkpoints WHERE job_id=? ORDER BY created_at DESC,rowid DESC",
      )
      .all(jobId)
      .map((row) => ({
        id: row.id,
        jobId: row.job_id,
        runId: row.run_id,
        sourceRevisionId: row.source_revision_id,
        lastOffset: row.last_offset,
        eventCount: row.event_count,
        duplicateCount: row.duplicate_count,
        watermark: row.watermark,
        prefixHash: row.prefix_hash,
        stateHash: row.state_hash,
        createdAt: row.created_at,
      }));
  }

  latestCheckpoint(jobId) {
    return this.checkpoints(jobId)[0];
  }

  eventCount(jobId) {
    return this.db
      .prepare("SELECT COUNT(*) AS count FROM stream_events WHERE job_id=?")
      .get(jobId).count;
  }

  state(jobId) {
    return this.db
      .prepare(
        "SELECT state_key,payload,last_sequence,event_time,updated_at FROM stream_state WHERE job_id=? ORDER BY state_key",
      )
      .all(jobId)
      .map((row) => ({
        stateKey: row.state_key,
        ...JSON.parse(row.payload),
        lastSequence: row.last_sequence,
        updatedAt: row.updated_at,
      }));
  }

  close() {
    this.db.close();
  }
}

export class RealtimeManager {
  constructor({
    store,
    stateStore,
    project,
    fixtureRoot,
    now = () => Date.now(),
    eventDelayMs = 25,
  }) {
    this.store = store;
    this.stateStore = stateStore;
    this.project = project;
    this.fixtureRoot = realpathSync(fixtureRoot);
    this.now = now;
    this.eventDelayMs = positiveInteger(
      eventDelayMs,
      "事件间隔",
      25,
      0,
      5000,
    );
    this.controls = new Map();
    this.pending = new Set();
    for (const job of this.store.list("stream_job", this.project)) {
      const run = job.lastRunId
        ? this.store.get("stream_run", job.lastRunId, this.project)
        : undefined;
      if (
        ["RUNNING", "RECOVERING"].includes(job.status) &&
        run?.status === "INTERRUPTED"
      )
        this.store.update("stream_job", job.id, this.project, {
          status: "INTERRUPTED",
          error: "服务重启中断实时处理，请从最新Checkpoint恢复",
        });
    }
  }

  createSource(input) {
    const name = text(input.name, "实时源名称", 2, 80);
    if (input.adapter !== "local-event-log-v1")
      throw fail(422, "当前本机实时首版只支持local-event-log-v1", "UNSUPPORTED_STREAM_ADAPTER");
    if (
      this.store
        .list("stream_source", this.project)
        .some((source) => source.name === name)
    )
      throw fail(409, "实时源名称已存在", "DUPLICATE_STREAM_SOURCE");
    const source = this.store.create("stream_source", this.project, {
        name,
        adapter: "local-event-log-v1",
        topic: text(input.topic, "Topic", 3, 80),
        status: "READY",
        classification: "SYNTHETIC_ONLY",
      }),
      revision = this.#createRevision(source, streamFileName(input.fileName));
    return this.store.update("stream_source", source.id, this.project, {
      currentRevisionId: revision.id,
    });
  }

  createSourceRevision(sourceId, input) {
    const source = this.#source(sourceId),
      revision = this.#createRevision(source, streamFileName(input.fileName));
    this.store.update("stream_source", source.id, this.project, {
      currentRevisionId: revision.id,
    });
    return revision;
  }

  listSources() {
    return this.store
      .list("stream_source", this.project)
      .map((source) => this.sourceDetail(source.id));
  }

  sourceDetail(id) {
    const source = this.#source(id),
      revisions = this.store
        .list("stream_source_revision", this.project)
        .filter((revision) => revision.sourceId === source.id)
        .sort((a, b) => b.revisionNumber - a.revisionNumber);
    return {
      ...source,
      currentRevision: revisions.find(
        (revision) => revision.id === source.currentRevisionId,
      ),
      revisions,
    };
  }

  createJob(input) {
    const source = this.#source(text(input.sourceId, "实时源编号", 3, 80)),
      checkpointEvery = positiveInteger(
        input.checkpointEvery,
        "Checkpoint间隔",
        2,
        1,
        100,
      ),
      maxOutOfOrderSeconds = positiveInteger(
        input.maxOutOfOrderSeconds,
        "最大乱序秒数",
        2,
        0,
        300,
      ),
      config = {
        name: text(input.name, "实时任务名称", 2, 80),
        sourceId: source.id,
        sourceRevisionId: source.currentRevisionId,
        targetTable: identifier(input.targetTable ?? "realtime_quotes", "实时目标表"),
        adapter: source.adapter,
        keyField: "security_code",
        eventIdField: "event_id",
        sequenceField: "sequence",
        eventTimeField: "event_time",
        checkpointEvery,
        maxOutOfOrderSeconds,
        status: "READY",
        actualExecution: true,
        publicDeployed: false,
        fullLifecycleE2E: false,
      };
    return this.store.create("stream_job", this.project, {
      ...config,
      configHash: stableHash(config),
    });
  }

  listJobs() {
    return this.store
      .list("stream_job", this.project)
      .map((job) => this.jobDetail(job.id));
  }

  jobDetail(id) {
    const job = this.#job(id);
    return {
      ...job,
      runs: this.store
        .list("stream_run", this.project)
        .filter((run) => run.jobId === job.id),
      checkpoints: this.stateStore.checkpoints(job.id),
      state: this.stateStore.state(job.id),
      alerts: this.store
        .list("stream_alert", this.project)
        .filter((alert) => alert.jobId === job.id),
    };
  }

  startJob(jobId, request = {}) {
    return this.#start(this.#job(jobId), {
      ...request,
      sourceRevisionId: this.#job(jobId).sourceRevisionId,
      startOffset: 0,
      recovery: false,
    });
  }

  recoverJob(jobId, input, request = {}) {
    const job = this.#job(jobId);
    if (!["FAILED", "INTERRUPTED"].includes(job.status))
      throw fail(409, "只有失败或中断的实时任务可以恢复", "STREAM_NOT_RECOVERABLE");
    const revision = this.#revision(text(input.sourceRevisionId, "恢复源版本", 3, 80));
    if (revision.sourceId !== job.sourceId)
      throw fail(409, "恢复源版本不属于当前实时源", "STREAM_REVISION_MISMATCH");
    const checkpoint = this.stateStore.latestCheckpoint(job.id);
    if (!checkpoint)
      throw fail(409, "没有可用Checkpoint，不能声称断点恢复", "CHECKPOINT_NOT_FOUND");
    const stream = this.#readRevision(revision);
    if (
      checkpoint.prefixHash !== prefixHash(stream.lines, checkpoint.lastOffset)
    )
      throw fail(
        409,
        "恢复日志在Checkpoint之前发生变化，拒绝跳过已处理事件",
        "CHECKPOINT_PREFIX_MISMATCH",
      );
    this.store.update("stream_job", job.id, this.project, {
      sourceRevisionId: revision.id,
      status: "RECOVERING",
      recoveryCheckpointId: checkpoint.id,
    });
    return this.#start(this.#job(job.id), {
      ...request,
      sourceRevisionId: revision.id,
      startOffset: checkpoint.lastOffset + 1,
      recovery: true,
      recoveryCheckpointId: checkpoint.id,
    });
  }

  stopJob(jobId) {
    const job = this.#job(jobId),
      controller = this.controls.get(job.id);
    if (!controller)
      throw fail(409, "实时任务当前没有运行", "STREAM_NOT_RUNNING");
    controller.abort();
    return this.jobDetail(job.id);
  }

  monitor() {
    const jobs = this.listJobs(),
      runs = this.store.list("stream_run", this.project),
      alerts = this.store.list("stream_alert", this.project);
    return {
      scope: "LOCAL_EVENT_LOG_RUNTIME",
      adapter: "local-event-log-v1",
      kafkaConnected: false,
      flinkConnected: false,
      publicDeployed: false,
      jobs,
      counts: {
        jobs: jobs.length,
        running: jobs.filter((job) => job.status === "RUNNING").length,
        caughtUp: jobs.filter((job) => job.status === "CAUGHT_UP").length,
        failedRuns: runs.filter((run) => run.status === "FAILED").length,
        openAlerts: alerts.filter((alert) => alert.status === "OPEN").length,
        resolvedAlerts: alerts.filter((alert) => alert.status === "RESOLVED").length,
      },
    };
  }

  async waitForIdle() {
    await Promise.all([...this.pending]);
  }

  shutdown() {
    for (const controller of this.controls.values()) controller.abort();
  }

  #start(job, input) {
    const duplicate = requestDuplicate(
      this.store,
      this.project,
      input.requestKey,
      input.requestSignature,
    );
    if (duplicate) return duplicate;
    if (this.controls.size)
      throw fail(
        409,
        "本机预算模式一次只运行一个实时任务",
        "STREAM_CONCURRENCY_LIMIT",
      );
    if (!input.recovery && !["READY", "STOPPED", "CAUGHT_UP"].includes(job.status))
      throw fail(409, "实时任务当前状态不能启动", "STREAM_INVALID_STATE");
    const run = this.store.create("stream_run", this.project, {
        jobId: job.id,
        status: "RUNNING",
        sourceRevisionId: input.sourceRevisionId,
        startOffset: input.startOffset,
        lastOffset: input.startOffset - 1,
        processedCount: 0,
        duplicateCount: 0,
        lateCount: 0,
        checkpointCount: 0,
        recovery: input.recovery,
        recoveryCheckpointId: input.recoveryCheckpointId,
        requestKey: input.requestKey,
        requestSignature: input.requestSignature,
        startedAt: new Date(this.now()).toISOString(),
        actualExecution: true,
        publicDeployed: false,
        fullLifecycleE2E: false,
      }),
      controller = new AbortController();
    this.store.update("stream_job", job.id, this.project, {
      status: input.recovery ? "RECOVERING" : "RUNNING",
      lastRunId: run.id,
      error: undefined,
    });
    this.controls.set(job.id, controller);
    const pending = this.#process(run.id, controller.signal).finally(() => {
      this.controls.delete(job.id);
      this.pending.delete(pending);
    });
    this.pending.add(pending);
    return run;
  }

  async #process(runId, signal) {
    const run = this.store.get("stream_run", runId, this.project),
      job = this.#job(run.jobId),
      revision = this.#revision(run.sourceRevisionId),
      stream = this.#readRevision(revision),
      started = this.now();
    let processedCount = 0,
      duplicateCount = 0,
      lateCount = 0,
      checkpointCount = 0,
      lastOffset = run.startOffset - 1,
      maxEventTimeMs = 0,
      currentOffset = run.startOffset;
    try {
      for (
        currentOffset = run.startOffset;
        currentOffset < stream.lines.length;
        currentOffset++
      ) {
        await new Promise((resolveDelay) =>
          setTimeout(resolveDelay, this.eventDelayMs),
        );
        if (signal.aborted)
          throw fail(409, "实时任务已停止", "STREAM_STOPPED");
        let parsed;
        try {
          parsed = JSON.parse(stream.lines[currentOffset]);
        } catch {
          throw fail(422, "事件日志包含无效JSON", "INVALID_EVENT_JSON");
        }
        const event = validateQuoteEvent(parsed),
          eventTimeMs = Date.parse(event.event_time),
          applied = this.stateStore.applyEvent(
            job.id,
            event,
            currentOffset,
            new Date(this.now()).toISOString(),
          );
        if (applied.duplicate) duplicateCount++;
        else {
          processedCount++;
          if (applied.late) lateCount++;
        }
        maxEventTimeMs = Math.max(maxEventTimeMs, eventTimeMs);
        lastOffset = currentOffset;
        const watermark = new Date(
          maxEventTimeMs - job.maxOutOfOrderSeconds * 1000,
        ).toISOString();
        if (
          (currentOffset + 1) % job.checkpointEvery === 0 ||
          currentOffset === stream.lines.length - 1
        ) {
          this.stateStore.checkpoint({
            jobId: job.id,
            runId: run.id,
            sourceRevisionId: revision.id,
            lastOffset,
            duplicateCount,
            watermark,
            prefixHash: prefixHash(stream.lines, lastOffset),
            createdAt: new Date(this.now()).toISOString(),
          });
          checkpointCount++;
        }
        this.store.update("stream_run", run.id, this.project, {
          lastOffset,
          processedCount,
          duplicateCount,
          lateCount,
          checkpointCount,
          watermark,
          lagMs: Math.max(0, this.now() - maxEventTimeMs),
          throughputPerSecond:
            processedCount / Math.max(0.001, (this.now() - started) / 1000),
        });
      }
      const completed = this.store.update("stream_run", run.id, this.project, {
        status: "SUCCEEDED",
        lastOffset,
        processedCount,
        duplicateCount,
        lateCount,
        checkpointCount,
        eventCount: this.stateStore.eventCount(job.id),
        stateHash: stableHash(this.stateStore.state(job.id)),
        durationMs: this.now() - started,
        finishedAt: new Date(this.now()).toISOString(),
      });
      this.store.update("stream_job", job.id, this.project, {
        status: "CAUGHT_UP",
        processedEventCount: completed.eventCount,
        duplicateCount:
          Number(job.duplicateCount ?? 0) + completed.duplicateCount,
        lateCount: Number(job.lateCount ?? 0) + completed.lateCount,
        watermark: completed.watermark,
        lagMs: completed.lagMs,
        throughputPerSecond: completed.throughputPerSecond,
        checkpointCount:
          this.stateStore.checkpoints(job.id).length,
        stateHash: completed.stateHash,
        caughtUpAt: completed.finishedAt,
      });
      if (run.recovery) {
        for (const alert of this.store.list("stream_alert", this.project))
          if (alert.jobId === job.id && alert.status === "OPEN")
            this.store.update("stream_alert", alert.id, this.project, {
              status: "RESOLVED",
              recoveryRunId: run.id,
              resolvedAt: new Date(this.now()).toISOString(),
            });
      }
      return completed;
    } catch (error) {
      const stopped = error.code === "STREAM_STOPPED",
        failed = this.store.update("stream_run", run.id, this.project, {
          status: stopped ? "STOPPED" : "FAILED",
          lastOffset,
          failedOffset: stopped ? undefined : currentOffset,
          processedCount,
          duplicateCount,
          lateCount,
          checkpointCount,
          eventCount: this.stateStore.eventCount(job.id),
          error: error.message,
          errorCode: error.code,
          durationMs: this.now() - started,
          finishedAt: new Date(this.now()).toISOString(),
        });
      this.store.update("stream_job", job.id, this.project, {
        status: stopped ? "STOPPED" : "FAILED",
        error: error.message,
        lastRunId: failed.id,
      });
      if (!stopped)
        this.store.create("stream_alert", this.project, {
          jobId: job.id,
          runId: run.id,
          status: "OPEN",
          severity: "ERROR",
          code: error.code ?? "STREAM_RUNTIME_FAILED",
          message: error.message,
          failedOffset: currentOffset,
          openedAt: new Date(this.now()).toISOString(),
        });
      return failed;
    }
  }

  #createRevision(source, name) {
    const stream = this.#read(name),
      revisionNumber =
        this.store
          .list("stream_source_revision", this.project)
          .filter((revision) => revision.sourceId === source.id).length + 1;
    return this.store.create("stream_source_revision", this.project, {
      sourceId: source.id,
      revisionNumber,
      fileName: name,
      lineCount: stream.lines.length,
      contentHash: stream.contentHash,
    });
  }

  #readRevision(revision) {
    const stream = this.#read(revision.fileName);
    if (stream.contentHash !== revision.contentHash)
      throw fail(
        409,
        "事件日志在版本登记后发生变化",
        "STREAM_SOURCE_CHANGED",
      );
    return stream;
  }

  #read(name) {
    const path = this.#resolve(name),
      stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 5_000_000)
      throw fail(422, "事件日志必须是5MB以内普通文件", "INVALID_STREAM_FILE");
    const content = readFileSync(path, "utf8");
    return { lines: linesOf(content), contentHash: sha256(content), bytes: stat.size };
  }

  #resolve(name) {
    const target = resolve(this.fixtureRoot, streamFileName(name));
    if (target !== this.fixtureRoot && !target.startsWith(this.fixtureRoot + sep))
      throw fail(400, "事件日志超出合成目录", "STREAM_PATH_FORBIDDEN");
    let real;
    try {
      real = realpathSync(target);
    } catch {
      throw fail(404, "事件日志文件不存在", "STREAM_FILE_NOT_FOUND");
    }
    if (real !== target)
      throw fail(422, "事件日志不能使用符号链接", "STREAM_SYMLINK_FORBIDDEN");
    return target;
  }

  #source(id) {
    const source = this.store.get("stream_source", id, this.project);
    if (!source) throw fail(404, "未找到实时源", "STREAM_SOURCE_NOT_FOUND");
    return source;
  }

  #revision(id) {
    const revision = this.store.get("stream_source_revision", id, this.project);
    if (!revision)
      throw fail(404, "未找到实时源版本", "STREAM_REVISION_NOT_FOUND");
    return revision;
  }

  #job(id) {
    const job = this.store.get("stream_job", id, this.project);
    if (!job) throw fail(404, "未找到实时任务", "STREAM_JOB_NOT_FOUND");
    return job;
  }
}

function requestDuplicate(store, project, key, signature) {
  if (!key) return undefined;
  const prior = store
    .list("stream_run", project)
    .find((run) => run.requestKey === key);
  if (!prior) return undefined;
  if (prior.requestSignature !== signature)
    throw fail(
      409,
      "相同幂等键不能用于不同实时请求",
      "STREAM_IDEMPOTENCY_CONFLICT",
    );
  return { ...prior, replayed: true };
}
