import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export class MetadataStore {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS documents(kind TEXT NOT NULL,id TEXT PRIMARY KEY,project TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS documents_project_kind ON documents(project,kind); CREATE TABLE IF NOT EXISTS idempotency(key TEXT PRIMARY KEY, signature TEXT NOT NULL, result_id TEXT NOT NULL);",
    );
  }
  list(kind, project) {
    return this.db
      .prepare(
        "SELECT data FROM documents WHERE kind=? AND project=? ORDER BY rowid DESC",
      )
      .all(kind, project)
      .map((r) => JSON.parse(r.data));
  }
  get(kind, id, project) {
    const r = this.db
      .prepare("SELECT data FROM documents WHERE kind=? AND id=? AND project=?")
      .get(kind, id, project);
    return r ? JSON.parse(r.data) : undefined;
  }
  create(kind, project, data) {
    const item = {
      ...data,
      id: randomUUID(),
      projectId: project,
      createdAt: new Date().toISOString(),
      version: 1,
    };
    this.db
      .prepare("INSERT INTO documents(kind,id,project,data) VALUES(?,?,?,?)")
      .run(kind, item.id, project, JSON.stringify(item));
    return item;
  }
  update(kind, id, project, patch) {
    const old = this.get(kind, id, project);
    if (!old) return undefined;
    const item = {
      ...old,
      ...patch,
      id,
      projectId: project,
      version: old.version + 1,
      updatedAt: new Date().toISOString(),
    };
    const change = this.db
      .prepare(
        "UPDATE documents SET data=?,version=version+1 WHERE kind=? AND id=? AND project=? AND version=?",
      )
      .run(JSON.stringify(item), kind, id, project, old.version);
    if (!change.changes)
      throw Object.assign(new Error("记录已更新，请刷新后重试"), {
        status: 409,
      });
    return item;
  }
  deduplicate(key, signature, create) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const prior = this.db
        .prepare("SELECT * FROM idempotency WHERE key=?")
        .get(key);
      if (prior) {
        if (prior.signature !== signature)
          throw Object.assign(new Error("相同幂等键不能用于不同请求"), {
            status: 409,
          });
        this.db.exec("COMMIT");
        return { id: prior.result_id, replayed: true };
      }
      const item = create();
      this.db
        .prepare("INSERT INTO idempotency VALUES(?,?,?)")
        .run(key, signature, item.id);
      this.db.exec("COMMIT");
      return { id: item.id, replayed: false };
    } catch (e) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw e;
    }
  }
  interruptPending(project) {
    for (const kind of ["run", "agent", "delivery_verification"])
      for (const item of this.list(kind, project))
        if (["QUEUED", "RUNNING"].includes(item.status))
          this.update(kind, item.id, project, {
            status: "INTERRUPTED",
            error: "服务已重启，该任务未完成。请检查记录后重新发起。",
          });
  }
  close() {
    this.db.close();
  }
}
