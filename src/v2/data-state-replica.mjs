import { createHash } from "node:crypto";

const FORMAT = "shuduo-data-state/v1";
const MAX_ROWS_PER_TABLE = 200_000;
const MAX_STRING_BYTES = 2 * 1024 * 1024;

const specs = {
  landingRows: {
    store: "landingStore",
    table: "landing_rows",
    columns: ["target_table", "row_key", "payload", "source_hash", "synced_at"],
    key: ["target_table", "row_key"],
    order: "target_table,row_key",
  },
  streamEvents: {
    store: "streamStateStore",
    table: "stream_events",
    columns: [
      "job_id",
      "event_id",
      "source_offset",
      "sequence",
      "event_time",
      "payload",
      "event_hash",
      "processed_at",
    ],
    key: ["job_id", "event_id"],
    order: "job_id,event_id",
  },
  streamState: {
    store: "streamStateStore",
    table: "stream_state",
    columns: [
      "job_id",
      "state_key",
      "payload",
      "last_sequence",
      "event_time",
      "updated_at",
    ],
    key: ["job_id", "state_key"],
    order: "job_id,state_key",
  },
  streamCheckpoints: {
    store: "streamStateStore",
    table: "stream_checkpoints",
    columns: [
      "id",
      "job_id",
      "run_id",
      "source_revision_id",
      "last_offset",
      "event_count",
      "duplicate_count",
      "watermark",
      "prefix_hash",
      "state_hash",
      "created_at",
    ],
    key: ["id"],
    order: "id",
  },
  serviceSnapshots: {
    store: "businessStore",
    table: "service_snapshots",
    columns: ["id", "content_hash", "row_count", "created_at"],
    key: ["id"],
    order: "id",
  },
  customerAssets: {
    store: "businessStore",
    table: "customer_assets",
    columns: [
      "snapshot_id",
      "client_id",
      "holding_market_value",
      "available_cash",
      "total_assets",
      "security_count",
    ],
    key: ["snapshot_id", "client_id"],
    order: "snapshot_id,client_id",
  },
  reportSnapshots: {
    store: "reportStore",
    table: "report_snapshots",
    columns: [
      "id",
      "asset_id",
      "content_hash",
      "row_count",
      "rows_json",
      "created_at",
    ],
    key: ["id"],
    order: "id",
  },
};

const fail = (message, code = "CLOUD_DATA_STATE_INVALID") =>
  Object.assign(new Error(message), { status: 503, code });

const canonical = (value) =>
  JSON.stringify(
    value && typeof value === "object"
      ? Array.isArray(value)
        ? value.map((item) => JSON.parse(canonical(item)))
        : Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, JSON.parse(canonical(value[key]))]),
          )
      : value,
  );

const digest = (value) =>
  createHash("sha256").update(canonical(value)).digest("hex");

export const emptyDataState = (project) => ({
  format: FORMAT,
  projectId: project,
  tables: Object.fromEntries(Object.keys(specs).map((name) => [name, []])),
});

const validateValue = (value) => {
  if (!["string", "number"].includes(typeof value) && value !== null)
    throw fail("云端业务状态包含不支持的字段类型");
  if (
    typeof value === "string" &&
    Buffer.byteLength(value, "utf8") > MAX_STRING_BYTES
  )
    throw fail("云端业务状态单字段超过安全上限");
  if (typeof value === "number" && !Number.isSafeInteger(value))
    throw fail("云端业务状态整数超出安全范围");
};

const validateRows = (name, rows, spec) => {
  if (!Array.isArray(rows) || rows.length > MAX_ROWS_PER_TABLE)
    throw fail(`云端业务状态表 ${name} 的行数不合法`);
  const keys = new Set();
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row))
      throw fail(`云端业务状态表 ${name} 包含非法行`);
    for (const column of spec.columns) {
      if (!Object.hasOwn(row, column))
        throw fail(`云端业务状态表 ${name} 缺少字段 ${column}`);
      validateValue(row[column]);
    }
    const key = spec.key.map((column) => String(row[column])).join("\u001f");
    if (keys.has(key)) throw fail(`云端业务状态表 ${name} 包含重复主键`);
    keys.add(key);
  }
};

export function validateDataState(payload, project) {
  if (
    !payload ||
    payload.format !== FORMAT ||
    payload.projectId !== project ||
    !payload.tables ||
    typeof payload.tables !== "object"
  )
    throw fail("云端业务状态快照格式不合法");
  for (const [name, spec] of Object.entries(specs))
    validateRows(name, payload.tables[name], spec);
  const snapshotIds = new Set(
    payload.tables.serviceSnapshots.map((row) => row.id),
  );
  if (
    payload.tables.customerAssets.some(
      (row) => !snapshotIds.has(row.snapshot_id),
    )
  )
    throw fail("云端 DAPI 数据行引用了不存在的快照");
  for (const row of [
    ...payload.tables.landingRows,
    ...payload.tables.streamEvents,
  ]) {
    try {
      JSON.parse(row.payload);
    } catch {
      throw fail("云端业务状态包含损坏的 JSON 数据");
    }
  }
  for (const row of payload.tables.reportSnapshots) {
    try {
      const rows = JSON.parse(row.rows_json);
      if (!Array.isArray(rows)) throw new Error("not rows");
    } catch {
      throw fail("云端报表快照包含损坏的 JSON 数据");
    }
  }
  return payload;
}

export function snapshotDataStores(stores, project) {
  const payload = emptyDataState(project);
  for (const [name, spec] of Object.entries(specs))
    payload.tables[name] = stores[spec.store].db
      .prepare(`SELECT ${spec.columns.join(",")} FROM ${spec.table} ORDER BY ${spec.order}`)
      .all()
      .map((row) => ({ ...row }));
  return payload;
}

const deleteOrder = [
  "customerAssets",
  "serviceSnapshots",
  "streamCheckpoints",
  "streamState",
  "streamEvents",
  "landingRows",
  "reportSnapshots",
];

export function replaceDataStores(stores, payload, project) {
  validateDataState(payload, project);
  const grouped = new Map();
  for (const name of deleteOrder) {
    const spec = specs[name],
      entry = grouped.get(spec.store) ?? [];
    entry.push([name, spec]);
    grouped.set(spec.store, entry);
  }
  for (const [storeName, entries] of grouped) {
    const db = stores[storeName].db;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const [, spec] of entries) db.prepare(`DELETE FROM ${spec.table}`).run();
      const insertionEntries =
        storeName === "businessStore" ? [...entries].reverse() : entries;
      for (const [name, spec] of insertionEntries) {
        const placeholders = spec.columns.map(() => "?").join(","),
          insert = db.prepare(
            `INSERT INTO ${spec.table} (${spec.columns.join(",")}) VALUES (${placeholders})`,
          );
        for (const row of payload.tables[name])
          insert.run(...spec.columns.map((column) => row[column]));
      }
      db.exec("COMMIT");
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  }
}

const conflict = () =>
  Object.assign(new Error("云端业务状态已被其他实例更新，请刷新后重试"), {
    status: 409,
    code: "CLOUD_DATA_STATE_CONFLICT",
  });

export class ReplicatedDataState {
  static async open({ backend, stores, project, autoFlush = true }) {
    const remote = await backend.load(project),
      replica = new ReplicatedDataState({
        backend,
        stores,
        project,
        remote,
        autoFlush,
      });
    return replica;
  }

  constructor({ backend, stores, project, remote, autoFlush }) {
    this.backend = backend;
    this.stores = stores;
    this.project = project;
    this.remoteRevision = remote.revision;
    this.autoFlush = autoFlush;
    this.dirty = false;
    this.lastFlushError = undefined;
    this.flushQueue = Promise.resolve();
    this.closed = false;
    this.mutationListener = undefined;
    replaceDataStores(this.stores, remote.payload, this.project);
    for (const store of Object.values(this.stores))
      store.setMutationListener?.(() => this.#markDirty());
  }

  setMutationListener(listener) {
    this.mutationListener = listener;
  }

  async flush() {
    if (this.closed) throw new Error("云端业务状态存储已关闭");
    this.flushQueue = this.flushQueue
      .catch(() => undefined)
      .then(async () => {
        while (this.dirty) {
          const expectedRevision = this.remoteRevision,
            payload = snapshotDataStores(this.stores, this.project);
          this.dirty = false;
          try {
            this.remoteRevision = await this.backend.compareAndSwap(
              this.project,
              expectedRevision,
              payload,
            );
            this.lastFlushError = undefined;
          } catch (error) {
            this.dirty = true;
            this.lastFlushError = error;
            throw error;
          }
        }
      });
    return this.flushQueue;
  }

  async refresh() {
    if (this.closed) throw new Error("云端业务状态存储已关闭");
    if (this.lastFlushError) {
      const remote = await this.backend.load(this.project);
      replaceDataStores(this.stores, remote.payload, this.project);
      this.remoteRevision = remote.revision;
      this.dirty = false;
      this.lastFlushError = undefined;
      return { refreshed: true, recoveredFromConflict: true };
    }
    if (this.dirty) await this.flush();
    const remote = await this.backend.load(this.project);
    if (remote.revision === this.remoteRevision)
      return { refreshed: false, revision: this.remoteRevision };
    replaceDataStores(this.stores, remote.payload, this.project);
    this.remoteRevision = remote.revision;
    return { refreshed: true, revision: this.remoteRevision };
  }

  replicationStatus() {
    const snapshot = snapshotDataStores(this.stores, this.project);
    return {
      driver: "oss-json-snapshot-cas",
      projectId: this.project,
      remoteRevision: this.remoteRevision,
      dirty: this.dirty,
      healthy: !this.lastFlushError,
      conflict: this.lastFlushError?.code === "CLOUD_DATA_STATE_CONFLICT",
      contentHash: digest(snapshot),
      rowCounts: Object.fromEntries(
        Object.entries(snapshot.tables).map(([name, rows]) => [name, rows.length]),
      ),
    };
  }

  async closeReplicated({ closeStores = false } = {}) {
    if (this.closed) return;
    if (this.dirty) await this.flush();
    this.closed = true;
    for (const store of Object.values(this.stores))
      store.setMutationListener?.(undefined);
    if (closeStores)
      for (const store of new Set(Object.values(this.stores))) store.close();
    await this.backend.close?.();
  }

  #markDirty() {
    this.dirty = true;
    this.mutationListener?.();
    if (!this.autoFlush) return;
    queueMicrotask(() => {
      if (!this.closed)
        this.flush().catch((error) => {
          this.lastFlushError = error;
        });
    });
  }
}

export class MemoryDataStateBackend {
  constructor() {
    this.projects = new Map();
  }

  async load(project) {
    return structuredClone(
      this.projects.get(project) ?? {
        revision: 0,
        payload: emptyDataState(project),
      },
    );
  }

  async compareAndSwap(project, expectedRevision, payload) {
    validateDataState(payload, project);
    const current = await this.load(project);
    if (current.revision !== expectedRevision) throw conflict();
    const revision = expectedRevision + 1;
    this.projects.set(project, {
      revision,
      payload: structuredClone(payload),
    });
    return revision;
  }

  async close() {}
}

export function cloudDataStateConflict() {
  return conflict();
}
