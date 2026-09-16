import { MetadataStore } from "./store.mjs";

const conflict = () =>
  Object.assign(new Error("云端元数据已被其他实例更新，请刷新后重试"), {
    status: 409,
    code: "CLOUD_METADATA_CONFLICT",
  });

export class ReplicatedMetadataStore extends MetadataStore {
  static async open({ backend, project, autoFlush = true }) {
    const remote = await backend.load(project),
      store = new ReplicatedMetadataStore({
        backend,
        project,
        remote,
        autoFlush,
      });
    return store;
  }

  constructor({ backend, project, remote, autoFlush }) {
    super(":memory:");
    this.backend = backend;
    this.project = project;
    this.remoteVersion = remote.revision;
    this.dirty = false;
    this.lastFlushError = undefined;
    this.flushQueue = Promise.resolve();
    this.closed = false;
    this.autoFlush = autoFlush;
    this.mutationListener = undefined;
    this.#load(remote.payload);
  }

  setMutationListener(listener) {
    this.mutationListener = listener;
  }

  create(kind, project, data) {
    const result = super.create(kind, project, data);
    this.#markDirty();
    return result;
  }

  update(kind, id, project, patch) {
    const result = super.update(kind, id, project, patch);
    if (result) this.#markDirty();
    return result;
  }

  deduplicate(key, signature, create) {
    const result = super.deduplicate(key, signature, create);
    if (!result.replayed) this.#markDirty();
    return result;
  }

  async flush() {
    if (this.closed) throw new Error("云端元数据存储已关闭");
    this.flushQueue = this.flushQueue
      .catch(() => undefined)
      .then(async () => {
        while (this.dirty) {
          const expectedRevision = this.remoteVersion,
            payload = this.#snapshot();
          this.dirty = false;
          try {
            this.remoteVersion = await this.backend.compareAndSwap(
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
    if (this.closed) throw new Error("云端元数据存储已关闭");
    if (this.lastFlushError) {
      const remote = await this.backend.load(this.project);
      this.#load(remote.payload);
      this.remoteVersion = remote.revision;
      this.dirty = false;
      this.lastFlushError = undefined;
      return { refreshed: true, recoveredFromConflict: true };
    }
    if (this.dirty) await this.flush();
    const remote = await this.backend.load(this.project);
    if (remote.revision === this.remoteVersion)
      return { refreshed: false, revision: this.remoteVersion };
    this.#load(remote.payload);
    this.remoteVersion = remote.revision;
    return { refreshed: true, revision: this.remoteVersion };
  }

  replicationStatus() {
    return {
      driver: "mysql-project-snapshot-cas",
      projectId: this.project,
      remoteRevision: this.remoteVersion,
      dirty: this.dirty,
      healthy: !this.lastFlushError,
      conflict: this.lastFlushError?.code === "CLOUD_METADATA_CONFLICT",
    };
  }

  async closeReplicated() {
    if (this.closed) return;
    if (this.dirty) await this.flush();
    this.closed = true;
    super.close();
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

  #snapshot() {
    return {
      format: "shuzhan-metadata-snapshot/v1",
      projectId: this.project,
      documents: this.db
        .prepare(
          "SELECT kind,id,project,version,data FROM documents WHERE project=? ORDER BY rowid",
        )
        .all(this.project),
      idempotency: this.db
        .prepare("SELECT key,signature,result_id FROM idempotency ORDER BY key")
        .all(),
    };
  }

  #load(payload) {
    const value = payload ?? {
      format: "shuzhan-metadata-snapshot/v1",
      projectId: this.project,
      documents: [],
      idempotency: [],
    };
    if (
      value.format !== "shuzhan-metadata-snapshot/v1" ||
      value.projectId !== this.project ||
      !Array.isArray(value.documents) ||
      !Array.isArray(value.idempotency)
    )
      throw Object.assign(new Error("云端元数据快照格式不合法"), {
        status: 503,
        code: "CLOUD_METADATA_INVALID",
      });
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM documents WHERE project=?").run(this.project);
      this.db.prepare("DELETE FROM idempotency").run();
      const insertDocument = this.db.prepare(
          "INSERT INTO documents(kind,id,project,version,data) VALUES(?,?,?,?,?)",
        ),
        insertIdempotency = this.db.prepare(
          "INSERT INTO idempotency(key,signature,result_id) VALUES(?,?,?)",
        );
      for (const item of value.documents)
        insertDocument.run(
          item.kind,
          item.id,
          item.project,
          item.version,
          item.data,
        );
      for (const item of value.idempotency)
        insertIdempotency.run(item.key, item.signature, item.result_id);
      this.db.exec("COMMIT");
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

export class MemorySnapshotBackend {
  constructor() {
    this.projects = new Map();
  }

  async load(project) {
    const state = this.projects.get(project) ?? {
      revision: 0,
      payload: {
        format: "shuzhan-metadata-snapshot/v1",
        projectId: project,
        documents: [],
        idempotency: [],
      },
    };
    return structuredClone(state);
  }

  async compareAndSwap(project, expectedRevision, payload) {
    const current = await this.load(project);
    if (current.revision !== expectedRevision) throw conflict();
    const next = expectedRevision + 1;
    this.projects.set(project, {
      revision: next,
      payload: structuredClone(payload),
    });
    return next;
  }

  async close() {}
}

export function cloudMetadataConflict() {
  return conflict();
}
