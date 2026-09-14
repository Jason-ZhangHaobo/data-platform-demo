import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, resolve, sep } from "node:path";

const fail = (status, message, code) =>
  Object.assign(new Error(message), { status, code });
const hash = (value) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
const canonical = (value) =>
  value === undefined
    ? "null"
    :
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
const stableHash = (value) => hash(canonical(value));
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
const fileName = (value) => {
  const result = text(value, "CSV文件", 5, 110);
  if (!/^[a-z0-9][a-z0-9_.-]*\.csv$/.test(result))
    throw fail(400, "CSV文件名不合法，不允许目录或路径", "INVALID_FILE_NAME");
  return result;
};

export function parseCsv(input) {
  if (typeof input !== "string" || !input.length)
    throw fail(422, "CSV文件为空", "EMPTY_CSV");
  const source = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input,
    records = [];
  let row = [],
    field = "",
    quoted = false;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (quoted) {
      if (character === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index++;
        } else quoted = false;
      } else field += character;
      continue;
    }
    if (character === '"') {
      if (field.length)
        throw fail(422, "CSV引号只能出现在字段开头", "INVALID_CSV");
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.endsWith("\r") ? field.slice(0, -1) : field);
      records.push(row);
      row = [];
      field = "";
    } else field += character;
  }
  if (quoted) throw fail(422, "CSV存在未闭合引号", "INVALID_CSV");
  if (field.length || row.length) {
    row.push(field.endsWith("\r") ? field.slice(0, -1) : field);
    records.push(row);
  }
  while (
    records.length &&
    records.at(-1).length === 1 &&
    records.at(-1)[0] === ""
  )
    records.pop();
  if (records.length < 2)
    throw fail(422, "CSV必须包含表头和至少一行数据", "EMPTY_CSV");
  if (records.length > 10_001)
    throw fail(413, "本机CSV验收最多10000行", "CSV_TOO_LARGE");
  const headers = records[0];
  if (
    !headers.length ||
    headers.length > 100 ||
    new Set(headers).size !== headers.length ||
    !headers.every((header) => /^[a-z][a-z0-9_]{0,62}$/.test(header))
  )
    throw fail(422, "CSV表头必须是不重复的小写字段名", "INVALID_HEADERS");
  const rows = records.slice(1).map((values, index) => {
    if (values.length !== headers.length)
      throw fail(
        422,
        `CSV第${index + 2}行字段数量与表头不一致`,
        "INVALID_CSV_ROW",
      );
    return Object.fromEntries(
      headers.map((header, offset) => [
        header,
        values[offset] === "" ? null : values[offset],
      ]),
    );
  });
  return { headers, rows };
}

const inferType = (values) => {
  const present = values.filter((value) => value !== null);
  if (!present.length) return "STRING";
  if (present.every((value) => /^-?\d+$/.test(value))) return "INTEGER";
  if (present.every((value) => /^-?\d+(?:\.\d{1,2})$/.test(value)))
    return "DECIMAL(18,2)";
  if (
    present.every(
      (value) =>
        /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        !Number.isNaN(Date.parse(value + "T00:00:00Z")),
    )
  )
    return "DATE";
  if (present.every((value) => ["true", "false"].includes(value.toLowerCase())))
    return "BOOLEAN";
  return "STRING";
};
export function inferCsvSchema(parsed) {
  return parsed.headers.map((name, ordinal) => {
    const values = parsed.rows.map((row) => row[name]);
    return {
      name,
      ordinal,
      type: inferType(values),
      nullable: values.some((value) => value === null),
      distinctCount: new Set(values.map((value) => String(value))).size,
    };
  });
}

function schemaChange(previous, current) {
  if (!previous)
    return { changed: false, added: [], removed: [], typeChanged: [] };
  const before = new Map(previous.columns.map((column) => [column.name, column])),
    after = new Map(current.map((column) => [column.name, column])),
    added = current
      .filter((column) => !before.has(column.name))
      .map((column) => column.name),
    removed = previous.columns
      .filter((column) => !after.has(column.name))
      .map((column) => column.name),
    typeChanged = current
      .filter(
        (column) =>
          before.has(column.name) && before.get(column.name).type !== column.type,
      )
      .map((column) => ({
        name: column.name,
        from: before.get(column.name).type,
        to: column.type,
      }));
  return {
    changed: Boolean(added.length || removed.length || typeChanged.length),
    added,
    removed,
    typeChanged,
  };
}

export class LandingStore {
  constructor(path = ":memory:") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS landing_rows(target_table TEXT NOT NULL,row_key TEXT NOT NULL,payload TEXT NOT NULL,source_hash TEXT NOT NULL,synced_at TEXT NOT NULL,PRIMARY KEY(target_table,row_key)); CREATE INDEX IF NOT EXISTS landing_target ON landing_rows(target_table,row_key);",
    );
    this.mutationListener = undefined;
  }

  setMutationListener(listener) {
    this.mutationListener = listener;
  }

  sync({ targetTable, mode, rows, mapping, keyFields, sourceHash, syncedAt }) {
    const target = identifier(targetTable, "目标表"),
      normalizedMapping = normalizeMapping(mapping),
      keys = normalizeKeys(keyFields, normalizedMapping),
      projected = rows.map((source) =>
        Object.fromEntries(
          Object.entries(normalizedMapping).map(([from, to]) => [to, source[from]]),
        ),
      ),
      keyed = projected.map((row) => ({
        row,
        key: keys.map((key) => String(row[key] ?? "")).join("\u001f"),
      }));
    if (keyed.some((item) => !item.key.replaceAll("\u001f", "")))
      throw fail(422, "同步主键不能为空", "EMPTY_SYNC_KEY");
    if (new Set(keyed.map((item) => item.key)).size !== keyed.length)
      throw fail(422, "当前批次包含重复同步主键", "DUPLICATE_SYNC_KEY");
    if (!["FULL", "INCREMENTAL_UPSERT"].includes(mode))
      throw fail(400, "同步模式不支持", "INVALID_SYNC_MODE");
    let inserted = 0,
      updated = 0,
      unchanged = 0,
      deleted = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (mode === "FULL") {
        deleted = this.db
          .prepare("SELECT COUNT(*) AS count FROM landing_rows WHERE target_table=?")
          .get(target).count;
        this.db
          .prepare("DELETE FROM landing_rows WHERE target_table=?")
          .run(target);
      }
      const get = this.db.prepare(
          "SELECT payload FROM landing_rows WHERE target_table=? AND row_key=?",
        ),
        upsert = this.db.prepare(
          "INSERT INTO landing_rows VALUES(?,?,?,?,?) ON CONFLICT(target_table,row_key) DO UPDATE SET payload=excluded.payload,source_hash=excluded.source_hash,synced_at=excluded.synced_at",
        );
      for (const item of keyed) {
        const payload = canonical(item.row),
          prior = get.get(target, item.key);
        if (!prior) inserted++;
        else if (prior.payload === payload) unchanged++;
        else updated++;
        upsert.run(target, item.key, payload, sourceHash, syncedAt);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
    this.mutationListener?.();
    const finalRows = this.readTable(target);
    return {
      targetTable: target,
      readCount: rows.length,
      inserted,
      updated,
      unchanged,
      deleted,
      finalCount: finalRows.length,
      targetHash: stableHash(
        finalRows.map(({ sourceHash: _source, syncedAt: _time, ...row }) => row),
      ),
    };
  }

  readTable(targetTable) {
    const target = identifier(targetTable, "目标表");
    return this.db
      .prepare(
        "SELECT row_key,payload,source_hash,synced_at FROM landing_rows WHERE target_table=? ORDER BY row_key",
      )
      .all(target)
      .map((record) => ({
        rowKey: record.row_key,
        ...JSON.parse(record.payload),
        sourceHash: record.source_hash,
        syncedAt: record.synced_at,
      }));
  }

  close() {
    this.db.close();
  }
}

const normalizeMapping = (mapping) => {
  if (
    !mapping ||
    typeof mapping !== "object" ||
    Array.isArray(mapping) ||
    !Object.keys(mapping).length ||
    Object.keys(mapping).length > 100
  )
    throw fail(400, "字段映射不能为空", "INVALID_MAPPING");
  const result = Object.fromEntries(
    Object.entries(mapping).map(([from, to]) => [
      identifier(from, "源字段"),
      identifier(to, "目标字段"),
    ]),
  );
  if (new Set(Object.values(result)).size !== Object.values(result).length)
    throw fail(400, "多个源字段不能映射到同一目标字段", "DUPLICATE_TARGET_FIELD");
  return result;
};
const normalizeKeys = (keys, mapping) => {
  if (
    !Array.isArray(keys) ||
    !keys.length ||
    keys.length > 5 ||
    new Set(keys).size !== keys.length
  )
    throw fail(400, "同步主键必须包含1—5个不重复字段", "INVALID_SYNC_KEYS");
  const result = keys.map((key) => identifier(key, "同步主键"));
  if (!result.every((key) => Object.values(mapping).includes(key)))
    throw fail(400, "同步主键必须存在于目标字段映射中", "INVALID_SYNC_KEYS");
  return result;
};

export class IngestionManager {
  constructor({ store, landingStore, project, fixtureRoot, now = () => Date.now() }) {
    this.store = store;
    this.landingStore = landingStore;
    this.project = project;
    this.fixtureRoot = realpathSync(fixtureRoot);
    this.now = now;
  }

  listSources() {
    return this.store
      .list("ingestion_source", this.project)
      .map((source) => this.sourceDetail(source.id));
  }

  sourceDetail(id) {
    const source = this.#source(id),
      revisions = this.store
        .list("source_revision", this.project)
        .filter((item) => item.sourceId === source.id)
        .sort((a, b) => b.revisionNumber - a.revisionNumber),
      metadataVersions = this.store
        .list("source_metadata", this.project)
        .filter((item) => item.sourceId === source.id),
      tests = this.store
        .list("source_test", this.project)
        .filter((item) => item.sourceId === source.id);
    return {
      ...source,
      currentRevision: revisions.find(
        (revision) => revision.id === source.currentRevisionId,
      ),
      revisions,
      metadataVersions,
      tests,
    };
  }

  createSource(input) {
    if (input.sourceType !== "LOCAL_CSV")
      throw fail(422, "当前真实接入首版只支持LOCAL_CSV", "UNSUPPORTED_SOURCE");
    if (input.credentialRef)
      throw fail(400, "LOCAL_CSV不接受凭证或密码", "UNEXPECTED_CREDENTIAL");
    const name = text(input.name, "数据源名称", 2, 80);
    if (
      this.store
        .list("ingestion_source", this.project)
        .some((item) => item.name === name)
    )
      throw fail(409, "数据源名称已存在", "DUPLICATE_SOURCE");
    const source = this.store.create("ingestion_source", this.project, {
        name,
        sourceType: "LOCAL_CSV",
        status: "NOT_TESTED",
        classification: "SYNTHETIC_ONLY",
      }),
      revision = this.#createRevision(source, fileName(input.fileName));
    return this.store.update("ingestion_source", source.id, this.project, {
      currentRevisionId: revision.id,
    });
  }

  createSourceRevision(sourceId, input) {
    const source = this.#source(sourceId),
      revision = this.#createRevision(source, fileName(input.fileName));
    this.store.update("ingestion_source", source.id, this.project, {
      currentRevisionId: revision.id,
      status: "NOT_TESTED",
      currentMetadataId: undefined,
      lastTestId: undefined,
    });
    return revision;
  }

  testConnection(sourceId) {
    const source = this.#source(sourceId),
      revision = this.#revision(source.currentRevisionId),
      started = this.now();
    try {
      const input = this.#read(revision.fileName),
        parsed = parseCsv(input.content),
        test = this.store.create("source_test", this.project, {
          sourceId: source.id,
          revisionId: revision.id,
          status: "CONNECTED",
          fileHash: input.fileHash,
          bytes: input.bytes,
          rowCount: parsed.rows.length,
          fieldCount: parsed.headers.length,
          headers: parsed.headers,
          durationMs: this.now() - started,
        });
      this.store.update("ingestion_source", source.id, this.project, {
        status: "CONNECTED",
        lastTestId: test.id,
        lastTestAt: new Date(this.now()).toISOString(),
      });
      return test;
    } catch (error) {
      const test = this.store.create("source_test", this.project, {
        sourceId: source.id,
        revisionId: revision.id,
        status: "FAILED",
        error: error.message,
        durationMs: this.now() - started,
      });
      this.store.update("ingestion_source", source.id, this.project, {
        status: "FAILED",
        lastTestId: test.id,
      });
      throw error;
    }
  }

  collectMetadata(sourceId) {
    const source = this.#source(sourceId),
      revision = this.#revision(source.currentRevisionId),
      test = this.store.get("source_test", source.lastTestId, this.project);
    if (
      !test ||
      test.status !== "CONNECTED" ||
      test.revisionId !== revision.id
    )
      throw fail(409, "请先测试当前数据源版本", "SOURCE_TEST_REQUIRED");
    const input = this.#read(revision.fileName),
      parsed = parseCsv(input.content);
    if (input.fileHash !== test.fileHash)
      throw fail(409, "CSV在连接测试后发生变化，请重新测试", "SOURCE_CHANGED");
    const columns = inferCsvSchema(parsed),
      prior = this.store
        .list("source_metadata", this.project)
        .find((item) => item.sourceId === source.id),
      change = schemaChange(prior, columns),
      metadata = this.store.create("source_metadata", this.project, {
        sourceId: source.id,
        revisionId: revision.id,
        objectName: revision.fileName.replace(/\.csv$/, ""),
        status: "COLLECTED",
        classification: "ACTUAL_FILE_SCAN",
        rowCount: parsed.rows.length,
        bytes: input.bytes,
        contentHash: input.fileHash,
        schemaHash: stableHash(columns.map(({ name, type, nullable }) => ({ name, type, nullable }))),
        columns,
        change,
        collectedAt: new Date(this.now()).toISOString(),
      });
    this.store.update("ingestion_source", source.id, this.project, {
      status: change.changed ? "SCHEMA_CHANGED" : "READY",
      currentMetadataId: metadata.id,
    });
    return metadata;
  }

  listTasks() {
    return this.store
      .list("offline_sync_task", this.project)
      .map((task) => this.taskDetail(task.id));
  }

  taskDetail(id) {
    const task = this.#task(id);
    return {
      ...task,
      runs: this.store
        .list("offline_sync_run", this.project)
        .filter((run) => run.taskId === task.id),
    };
  }

  createTask(input) {
    return this.store.create(
      "offline_sync_task",
      this.project,
      this.#normalizeTask(input),
    );
  }

  validateAgentPlan(value) {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      value.kind !== "OFFLINE_SYNC"
    )
      throw fail(
        422,
        "Agent未返回可验证的离线同步方案",
        "INVALID_INGESTION_PLAN",
      );
    return { kind: "OFFLINE_SYNC", ...this.#normalizeTask(value) };
  }

  #normalizeTask(input) {
    const source = this.#source(text(input.sourceId, "数据源编号", 3, 80)),
      revision = this.#revision(source.currentRevisionId),
      metadata = this.store.get(
        "source_metadata",
        source.currentMetadataId,
        this.project,
      );
    if (!metadata || metadata.revisionId !== revision.id)
      throw fail(409, "请先采集当前数据源版本的元数据", "METADATA_REQUIRED");
    const mapping = normalizeMapping(input.mapping),
      sourceFields = new Set(metadata.columns.map((column) => column.name));
    if (!Object.keys(mapping).every((field) => sourceFields.has(field)))
      throw fail(400, "字段映射引用了不存在的源字段", "UNKNOWN_SOURCE_FIELD");
    const mode = input.mode;
    if (!["FULL", "INCREMENTAL_UPSERT"].includes(mode))
      throw fail(400, "同步模式不支持", "INVALID_SYNC_MODE");
    const keyFields = normalizeKeys(input.keyFields, mapping),
      watermarkField = input.watermarkField
        ? identifier(input.watermarkField, "水位字段")
        : undefined;
    if (
      watermarkField &&
      !Object.values(mapping).includes(watermarkField)
    )
      throw fail(400, "水位字段必须存在于目标映射中", "INVALID_WATERMARK");
    const config = {
      name: text(input.name, "同步任务名称", 2, 80),
      sourceId: source.id,
      sourceRevisionId: revision.id,
      metadataVersionId: metadata.id,
      targetTable: identifier(input.targetTable, "目标表"),
      mode,
      mapping,
      keyFields,
      watermarkField,
      status: "READY",
    };
    return {
      ...config,
      configHash: stableHash({
        sourceRevisionId: revision.id,
        metadataVersionId: metadata.id,
        targetTable: input.targetTable,
        mode,
        mapping,
        keyFields,
        watermarkField,
      }),
    };
  }

  runTask(taskId, request = {}) {
    const task = this.#task(taskId),
      started = this.now();
    if (request.requestKey) {
      const prior = this.store
        .list("offline_sync_run", this.project)
        .find((run) => run.requestKey === request.requestKey);
      if (prior) {
        if (prior.requestSignature !== request.requestSignature)
          throw fail(
            409,
            "相同幂等键不能用于不同同步请求",
            "SYNC_IDEMPOTENCY_CONFLICT",
          );
        if (["SUCCEEDED", "FAILED"].includes(prior.status))
          return { ...prior, replayed: true };
        throw fail(
          409,
          "该同步请求仍在运行或已中断，请先检查运行记录",
          "SYNC_RUN_UNCERTAIN",
        );
      }
    }
    const pending = this.store.create("offline_sync_run", this.project, {
      taskId: task.id,
      status: "RUNNING",
      sourceRevisionId: task.sourceRevisionId,
      metadataVersionId: task.metadataVersionId,
      configHash: task.configHash,
      requestKey: request.requestKey,
      requestSignature: request.requestSignature,
      startedAt: new Date(started).toISOString(),
      actualExecution: true,
      fullLifecycleE2E: false,
    });
    this.store.update("offline_sync_task", task.id, this.project, {
      status: "RUNNING",
      lastRunId: pending.id,
    });
    try {
      const source = this.#source(task.sourceId);
      if (source.currentRevisionId !== task.sourceRevisionId)
        throw fail(
          409,
          "数据源版本已变化，请新建同步任务版本",
          "SOURCE_REVISION_STALE",
        );
      const metadata = this.store.get(
        "source_metadata",
        task.metadataVersionId,
        this.project,
      );
      if (!metadata || source.currentMetadataId !== metadata.id)
        throw fail(
          409,
          "元数据版本已变化，请重新配置同步任务",
          "METADATA_STALE",
        );
      const revision = this.#revision(task.sourceRevisionId),
        input = this.#read(revision.fileName),
        parsed = parseCsv(input.content);
      if (input.fileHash !== metadata.contentHash)
        throw fail(
          409,
          "源文件在元数据采集后发生变化",
          "SOURCE_CHANGED",
        );
      const output = this.landingStore.sync({
        targetTable: task.targetTable,
        mode: task.mode,
        rows: parsed.rows,
        mapping: task.mapping,
        keyFields: task.keyFields,
        sourceHash: input.fileHash,
        syncedAt: new Date(this.now()).toISOString(),
      });
      const sourceWatermarkField = task.watermarkField
          ? Object.entries(task.mapping).find(
              ([, target]) => target === task.watermarkField,
            )?.[0]
          : undefined,
        watermark = sourceWatermarkField
          ? parsed.rows
              .map((row) => row[sourceWatermarkField])
              .filter((value) => value !== null && value !== undefined)
              .sort()
              .at(-1)
          : undefined,
        run = this.store.update(
          "offline_sync_run",
          pending.id,
          this.project,
          {
          status: "SUCCEEDED",
          sourceRevisionId: task.sourceRevisionId,
          metadataVersionId: task.metadataVersionId,
          configHash: task.configHash,
          sourceHash: input.fileHash,
          ...output,
          watermark,
          durationMs: this.now() - started,
          finishedAt: new Date(this.now()).toISOString(),
          actualExecution: true,
          fullLifecycleE2E: false,
          },
        );
      this.store.update("offline_sync_task", task.id, this.project, {
        status: "SUCCEEDED",
        lastRunId: run.id,
        watermark,
      });
      return run;
    } catch (error) {
      const run = this.store.update(
        "offline_sync_run",
        pending.id,
        this.project,
        {
        status: "FAILED",
        sourceRevisionId: task.sourceRevisionId,
        metadataVersionId: task.metadataVersionId,
        configHash: task.configHash,
        error: error.message,
        durationMs: this.now() - started,
        finishedAt: new Date(this.now()).toISOString(),
        actualExecution: true,
        fullLifecycleE2E: false,
        },
      );
      this.store.update("offline_sync_task", task.id, this.project, {
        status: "FAILED",
        lastRunId: run.id,
      });
      throw Object.assign(error, { runId: run.id });
    }
  }

  previewTarget(targetTable) {
    return this.landingStore.readTable(targetTable);
  }

  #createRevision(source, name) {
    this.#resolve(name);
    const count = this.store
      .list("source_revision", this.project)
      .filter((item) => item.sourceId === source.id).length;
    return this.store.create("source_revision", this.project, {
      sourceId: source.id,
      revisionNumber: count + 1,
      fileName: name,
      sourceType: source.sourceType,
    });
  }

  #read(name) {
    const path = this.#resolve(name),
      stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 5_000_000)
      throw fail(422, "CSV必须是5MB以内的普通文件", "INVALID_SOURCE_FILE");
    const content = readFileSync(path, "utf8");
    return { content, fileHash: hash(content), bytes: stat.size };
  }

  #resolve(name) {
    const target = resolve(this.fixtureRoot, fileName(name));
    if (target !== this.fixtureRoot && !target.startsWith(this.fixtureRoot + sep))
      throw fail(400, "CSV路径超出合成数据目录", "SOURCE_PATH_FORBIDDEN");
    let real;
    try {
      real = realpathSync(target);
    } catch {
      throw fail(404, "CSV文件不存在", "SOURCE_FILE_NOT_FOUND");
    }
    if (real !== target)
      throw fail(422, "CSV数据源不能使用符号链接", "SOURCE_SYMLINK_FORBIDDEN");
    return target;
  }

  #source(id) {
    const source = this.store.get("ingestion_source", id, this.project);
    if (!source) throw fail(404, "未找到当前项目的数据源", "SOURCE_NOT_FOUND");
    return source;
  }

  #revision(id) {
    const revision = this.store.get("source_revision", id, this.project);
    if (!revision)
      throw fail(404, "未找到数据源版本", "SOURCE_REVISION_NOT_FOUND");
    return revision;
  }

  #task(id) {
    const task = this.store.get("offline_sync_task", id, this.project);
    if (!task) throw fail(404, "未找到离线同步任务", "SYNC_TASK_NOT_FOUND");
    return task;
  }
}

export const identityPositionMapping = Object.freeze({
  position_id: "position_id",
  client_id: "client_id",
  security_code: "security_code",
  asset_class: "asset_class",
  industry: "industry",
  market_value: "market_value",
  trade_date: "trade_date",
});
