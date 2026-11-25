import {changelogMode,normalizeChangeConfig,changeSpecHash,initializeChangeTables,inspectChangeState,prepareChangeEvents,assertChangeStart,applyChangeEvents,changeStateHash,changeHash} from './csv-changelog.mjs';
import {ingestionWatermark} from './ingestion-watermark.mjs';
import { buildSyncSnapshot, checkedSyncSnapshot, syncSnapshotLimits } from './sync-run-snapshot.mjs';
import {
  checkedStandardSyncReceipt, standardLandingOutput, standardRunRequestHash,
  standardSyncReceiptProtocol, syncLandingBinding, verifyStandardRunReceipt,
} from './sync-standard-receipt.mjs';
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
export const ingestionSchemaHash = columns => stableHash(columns.map(({ name, type, nullable }) => ({ name, type, nullable })));
const landingHash = rows => stableHash(rows.map(({ sourceHash: _source, syncedAt: _time, ...row }) => row));
const staleSyncErrors = {
  SOURCE_REVISION_STALE: "数据源版本已变化，请新建同步任务版本",
  METADATA_STALE: "元数据版本已变化，请重新配置同步任务",
};
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
      "CREATE TABLE IF NOT EXISTS landing_rows(target_table TEXT NOT NULL,row_key TEXT NOT NULL,payload TEXT NOT NULL,source_hash TEXT NOT NULL,synced_at TEXT NOT NULL,PRIMARY KEY(target_table,row_key)); CREATE INDEX IF NOT EXISTS landing_target ON landing_rows(target_table,row_key); CREATE TABLE IF NOT EXISTS landing_commits(target_table TEXT PRIMARY KEY,run_id TEXT NOT NULL,target_hash TEXT NOT NULL);",
    );
    this.db.exec('CREATE TABLE IF NOT EXISTS landing_run_snapshots(run_id TEXT PRIMARY KEY,target_table TEXT NOT NULL,payload TEXT NOT NULL,snapshot_hash TEXT NOT NULL,byte_count INTEGER NOT NULL)');
    this.db.exec('CREATE TABLE IF NOT EXISTS landing_run_receipts(run_id TEXT PRIMARY KEY,target_table TEXT NOT NULL,payload TEXT NOT NULL,receipt_hash TEXT NOT NULL)');
    initializeChangeTables(this.db);
    this.mutationListener = undefined;
  }

  setMutationListener(listener) {
    this.mutationListener = listener;
  }

  sync({ targetTable, mode, rows, mapping, keyFields, sourceHash, syncedAt, runId, snapshotBinding,changeConfig,changeGuard,standardExecution }) {
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
    if (projected.some(row=>keys.some(key=>row[key]===null||row[key]===undefined||String(row[key]).trim()==='')))
      throw fail(422, "同步主键不能为空", "EMPTY_SYNC_KEY");
    if(projected.some(row=>keys.some(key=>String(row[key]).includes('\u001f'))))
      throw fail(422,"同步主键含不支持的控制字符，请清理后再同步","INVALID_SYNC_KEY_VALUE");
    if (mode!==changelogMode&&new Set(keyed.map((item) => item.key)).size !== keyed.length)
      throw fail(422, "当前批次包含重复同步主键", "DUPLICATE_SYNC_KEY");
    if (!["FULL", "INCREMENTAL_UPSERT",changelogMode].includes(mode))
      throw fail(400, "同步模式不支持", "INVALID_SYNC_MODE");
    const managed=this.db.prepare('SELECT 1 FROM landing_change_targets WHERE target_table=?').get(target);
    if(mode!==changelogMode&&managed)throw fail(409,'变更受控目标不能用旧FULL/UPSERT覆盖','CHANGE_TARGET_MANAGED');
    const config=mode===changelogMode?normalizeChangeConfig(changeConfig,normalizedMapping,keys):undefined,
      events=config?prepareChangeEvents(rows,normalizedMapping,keys,config):undefined,specHash=config?changeSpecHash(config,normalizedMapping,keys):undefined;
    if(config&&(!runId||!snapshotBinding))throw fail(422,'变更批次须绑定原运行和快照配置','CHANGE_RUN_BINDING_REQUIRED');
    if (standardExecution && (config || !runId || snapshotBinding?.sourceHash !== sourceHash))
      throw fail(422, '标准同步落地回执须绑定原运行和确切源摘要', 'SYNC_LANDING_RECEIPT_BINDING_REQUIRED');
    let changeCounts,changeState;
    let inserted = 0,
      updated = 0,
      unchanged = 0,
      deleted = 0,
      finalRows, targetHash, snapshotReceipt;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (runId && this.db.prepare('SELECT 1 FROM landing_run_snapshots WHERE run_id=?').get(runId))
        throw fail(409,'原同步运行已留存快照，不允许重复落地覆盖','SYNC_SNAPSHOT_EXISTS');
      if (runId && this.hasStandardRunReceipt(runId))
        throw fail(409, '原同步运行已留存提交回执，不允许重复落地覆盖', 'SYNC_LANDING_RECEIPT_EXISTS');
      if(config){assertChangeStart({db:this.db,target,targetHash:landingHash(this.readTable(target)),config,specHash,guard:changeGuard,events});
        changeCounts=applyChangeEvents(this.db,target,events,sourceHash,syncedAt);({inserted,updated,unchanged,deleted}=changeCounts);
      }else{
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
      }
      finalRows = this.readTable(target);
      targetHash = landingHash(finalRows);
      if (runId) this.db.prepare(
        "INSERT INTO landing_commits VALUES(?,?,?) ON CONFLICT(target_table) DO UPDATE SET run_id=excluded.run_id,target_hash=excluded.target_hash",
      ).run(target, runId, targetHash);
      else this.db.prepare("DELETE FROM landing_commits WHERE target_table=?").run(target);
      if (runId && snapshotBinding) {
        snapshotReceipt = {snapshotStatus:'NOT_RETAINED_LIMIT'};
        if (finalRows.length <= syncSnapshotLimits.rows) {
          const snapshot = buildSyncSnapshot({runId,targetTable:target,binding:snapshotBinding,targetHash,rows:finalRows,createdAt:syncedAt});
          const used = this.db.prepare('SELECT COALESCE(SUM(LENGTH(CAST(payload AS BLOB))),0) AS bytes FROM landing_run_snapshots').get().bytes;
          if (snapshot.bytes <= syncSnapshotLimits.bytes && used + snapshot.bytes <= syncSnapshotLimits.totalBytes) {
            // Plain INSERT: a reused run identifier must roll back, never overwrite evidence.
            this.db.prepare('INSERT INTO landing_run_snapshots VALUES(?,?,?,?,?)').run(runId,target,snapshot.payload,snapshot.snapshotHash,snapshot.bytes);
            snapshotReceipt = {snapshotStatus:'RETAINED',landingSnapshotHash:snapshot.snapshotHash};
          }
        }
      }
      if(config){
        const dataStateHash=changeStateHash(this.db,target,targetHash,config.epochId,specHash),info={epochId:config.epochId,specHash,appliedEvents:changeCounts.appliedEvents,deleteEvents:changeCounts.deleteEvents,duplicateEvents:changeCounts.duplicateEvents,staleEvents:changeCounts.staleEvents};
        const receipt={protocol:'shuduo-csv-changelog/v1',targetTable:target,readCount:rows.length,inserted,updated,unchanged,deleted,finalCount:finalRows.length,targetHash,...snapshotReceipt,...info,dataStateHash,previousStateHash:changeGuard.expectedStateHash??null,previousStatus:changeGuard.initialize?'DRAFT':'READY',runId,taskId:snapshotBinding.taskId,configHash:snapshotBinding.configHash,sourceHash};
        const stateHash=changeHash({dataStateHash,receiptHash:changeHash(receipt)});changeState={...info,changeStateHash:stateHash};
        this.db.prepare('INSERT INTO landing_change_targets VALUES(?,?,?,?,?,?) ON CONFLICT(target_table) DO UPDATE SET state_hash=excluded.state_hash,last_run_id=excluded.last_run_id,receipt=excluded.receipt').run(target,config.epochId,specHash,stateHash,runId,JSON.stringify(receipt));
      }
      if (standardExecution) {
        const receipt = { protocol: standardSyncReceiptProtocol, runId, targetTable: target, binding: snapshotBinding,
          mode, sourceType: standardExecution.sourceType, requestHash: standardExecution.requestHash,
          landedAt: new Date(standardExecution.now()).toISOString(), readCount: rows.length,
          inserted, updated, unchanged, deleted, finalCount: finalRows.length, targetHash, ...snapshotReceipt,
          ...(standardExecution.watermark === undefined ? {} : { watermark: standardExecution.watermark }) };
        const row = { run_id: runId, target_table: target, payload: canonical(receipt), receipt_hash: stableHash(receipt) };
        checkedStandardSyncReceipt(row, snapshotBinding.projectId);
        this.db.prepare('INSERT INTO landing_run_receipts VALUES(?,?,?,?)')
          .run(row.run_id, row.target_table, row.payload, row.receipt_hash);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
    this.mutationListener?.();
    return {
      targetTable: target,
      readCount: rows.length,
      inserted,
      updated,
      unchanged,
      deleted,
      finalCount: finalRows.length,
      targetHash,
      ...snapshotReceipt,
      ...(changeState?{changeState}:{}),
    };
  }

  changeStatus(targetTable){return inspectChangeState(this.db,targetTable,landingHash(this.readTable(targetTable)));}
  assertChangeIntegrity(){for(const marker of this.db.prepare('SELECT target_table FROM landing_change_targets').all())this.changeStatus(marker.target_table);}

  readRunSnapshot(expected) {
    const record = this.db.prepare('SELECT * FROM landing_run_snapshots WHERE run_id=?').get(expected.runId);
    if (!record) throw fail(409,'原批次快照缺失；未使用当前表替代','SYNC_SNAPSHOT_MISSING');
    return checkedSyncSnapshot(record,expected);
  }

  readStandardRunReceipt(runId, project) {
    const row = this.db.prepare('SELECT * FROM landing_run_receipts WHERE run_id=?').get(runId);
    return row ? checkedStandardSyncReceipt(row, project) : undefined;
  }

  hasStandardRunReceipt(runId) {
    return Boolean(this.db.prepare('SELECT 1 FROM landing_run_receipts WHERE run_id=?').get(runId));
  }

  hasStandardRunReceiptForTarget(targetTable) {
    return Boolean(this.db.prepare('SELECT 1 FROM landing_run_receipts WHERE target_table=? LIMIT 1').get(targetTable));
  }

  inspectTarget(targetTable, { includeRows = false, includeRecordedRun = false } = {}) {
    this.db.exec("BEGIN");
    try {
      const rows = this.readTable(targetTable), targetHash = landingHash(rows);
      const commit = this.db.prepare("SELECT run_id,target_hash FROM landing_commits WHERE target_table=?").get(targetTable);
      return { rowCount: rows.length, targetHash, runId: commit?.target_hash === targetHash ? commit.run_id : undefined,
        ...(includeRecordedRun && commit ? {recordedRunId:commit.run_id} : {}),
        ...(includeRows ? { rows } : {}) };
    } finally { this.db.exec("ROLLBACK"); }
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
  constructor({ store, landingStore, project, fixtureRoot, serverMysqlAdapter, allowChangelog = true, now = () => Date.now() }) {
    this.store = store;
    this.landingStore = landingStore;
    this.project = project;
    this.fixtureRoot = realpathSync(fixtureRoot);
    this.serverMysqlAdapter = serverMysqlAdapter;
    this.allowChangelog = allowChangelog;
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
      supportsOfflineSync:
        source.sourceType === "LOCAL_CSV" ||
        (source.sourceType === "SERVER_MYSQL" &&
          this.serverMysqlAdapter?.supportsOfflineSync === true),
      currentRevision: revisions.find(
        (revision) => revision.id === source.currentRevisionId,
      ),
      revisions,
      metadataVersions,
      tests,
    };
  }

  createSource(input) {
    if (!["LOCAL_CSV", "SERVER_MYSQL"].includes(input.sourceType))
      throw fail(422, "当前真实接入只支持LOCAL_CSV或SERVER_MYSQL", "UNSUPPORTED_SOURCE");
    if (input.credentialRef || input.password || input.host || input.user)
      throw fail(400, "数据源不接受浏览器凭证或连接信息", "UNEXPECTED_CREDENTIAL");
    if (input.sourceType === "SERVER_MYSQL") {
      const tableName = identifier(input.tableName, "MySQL数据表");
      if (!this.serverMysqlAdapter?.allowTables?.includes(tableName))
        throw fail(422, "MySQL数据表不在服务端白名单中", "MYSQL_TABLE_NOT_ALLOWED");
    }
    const name = text(input.name, "数据源名称", 2, 80);
    if (
      this.store
        .list("ingestion_source", this.project)
        .some((item) => item.name === name)
    )
      throw fail(409, "数据源名称已存在", "DUPLICATE_SOURCE");
    const source = this.store.create("ingestion_source", this.project, {
        name,
        sourceType: input.sourceType,
        status: "NOT_TESTED",
        classification: input.sourceType === "LOCAL_CSV" ? "SYNTHETIC_ONLY" : "SERVER_CONFIGURED_SYNTHETIC_ONLY",
      });
    const revision = input.sourceType === "LOCAL_CSV"
      ? this.#createRevision(source, fileName(input.fileName))
      : this.#createServerMysqlRevision(source, input);
    return this.store.update("ingestion_source", source.id, this.project, {
      currentRevisionId: revision.id,
    });
  }

  createSourceRevision(sourceId, input) {
    const source = this.#source(sourceId),
      revision = source.sourceType === "LOCAL_CSV"
        ? this.#createRevision(source, fileName(input.fileName))
        : this.#createServerMysqlRevision(source, input);
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
    if (source.sourceType !== "LOCAL_CSV")
      throw fail(409, "SERVER_MYSQL请使用异步服务端连接测试", "SERVER_SOURCE_ASYNC_REQUIRED");
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
    if (source.sourceType !== "LOCAL_CSV")
      throw fail(409, "SERVER_MYSQL请使用异步服务端元数据采集", "SERVER_SOURCE_ASYNC_REQUIRED");
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
        schemaHash: ingestionSchemaHash(columns),
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

  async testServerMysqlConnection(sourceId) {
    const source = this.#source(sourceId),
      revision = this.#revision(source.currentRevisionId),
      started = this.now();
    if (source.sourceType !== "SERVER_MYSQL")
      throw fail(409, "当前数据源不是SERVER_MYSQL", "SOURCE_TYPE_MISMATCH");
    if (!this.serverMysqlAdapter)
      throw fail(503, "服务端MySQL数据源尚未配置", "MYSQL_SOURCE_NOT_CONFIGURED");
    try {
      const result = await this.serverMysqlAdapter.probe(revision.tableName),
        test = this.store.create("source_test", this.project, {
          sourceId: source.id,
          revisionId: revision.id,
          status: "CONNECTED",
          sourceType: "SERVER_MYSQL",
          tableName: revision.tableName,
          serverVersion: result.serverVersion,
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
        sourceType: "SERVER_MYSQL",
        errorCode: error.code ?? "MYSQL_CONNECTION_FAILED",
        durationMs: this.now() - started,
      });
      this.store.update("ingestion_source", source.id, this.project, { status: "FAILED", lastTestId: test.id });
      throw error;
    }
  }

  async collectServerMysqlMetadata(sourceId) {
    const source = this.#source(sourceId),
      revision = this.#revision(source.currentRevisionId),
      test = this.store.get("source_test", source.lastTestId, this.project);
    if (source.sourceType !== "SERVER_MYSQL")
      throw fail(409, "当前数据源不是SERVER_MYSQL", "SOURCE_TYPE_MISMATCH");
    if (!test || test.status !== "CONNECTED" || test.revisionId !== revision.id)
      throw fail(409, "请先测试当前数据源版本", "SOURCE_TEST_REQUIRED");
    if (!this.serverMysqlAdapter)
      throw fail(503, "服务端MySQL数据源尚未配置", "MYSQL_SOURCE_NOT_CONFIGURED");
    const described = await this.serverMysqlAdapter.describe(revision.tableName),
      columns = described.columns.map((column) => ({ ...column, distinctCount: undefined })),
      prior = this.store.list("source_metadata", this.project).find((item) => item.sourceId === source.id),
      change = schemaChange(prior, columns),
      metadata = this.store.create("source_metadata", this.project, {
        sourceId: source.id,
        revisionId: revision.id,
        objectName: revision.tableName,
        status: "COLLECTED",
        classification: "SERVER_MYSQL_SCHEMA_SCAN",
        rowCount: described.rowCount,
        schemaHash: ingestionSchemaHash(columns),
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

  taskRunRequest(taskId, requestKey) {
    const { task, key, run } = this.#taskRunByRequest(taskId, requestKey);
    return this.#taskRunRequestView(task, key, run, this.#standardReceipt(task, run));
  }

  settleTaskRunRequest(taskId, requestKey, basis) {
    if (!basis || typeof basis !== 'object' || Array.isArray(basis) || Object.keys(basis).length !== 2 ||
        !Object.hasOwn(basis, 'runId') || !Object.hasOwn(basis, 'receiptHash') ||
        typeof basis.runId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(basis.runId) ||
        typeof basis.receiptHash !== 'string' || !/^[a-f0-9]{64}$/.test(basis.receiptHash))
      throw fail(422, '结算须提供已核对的原运行编号与落地回执摘要', 'INVALID_SYNC_SETTLEMENT_BASIS');
    const { task, key, run } = this.#taskRunByRequest(taskId, requestKey);
    const mismatch = () => fail(409, '原同步运行或落地回执摘要已变化，请重新核对', 'SYNC_SETTLEMENT_BASIS_MISMATCH');
    if (run.id !== basis.runId) throw mismatch();
    const proof = this.#standardReceipt(task, run);
    if (!proof) throw fail(409, '原运行缺少确切落地回执，不能结算', 'SYNC_LANDING_RECEIPT_MISSING');
    if (proof.receiptHash !== basis.receiptHash) throw mismatch();
    if (run.status === 'SUCCEEDED') {
      this.#updateTaskRunSummary(task.id, run.id, { status: 'SUCCEEDED', watermark: run.watermark });
      return this.#taskRunRequestView(task, key, run, proof);
    }
    const settled = this.#finishStandard(task, run, { reconciled: true, proof });
    return this.#taskRunRequestView(task, key, settled, this.#standardReceipt(task, settled));
  }

  #taskRunByRequest(taskId, requestKey) {
    const task = this.#task(taskId), key = text(requestKey, '原同步请求编号');
    const matches = this.store.list('offline_sync_run', this.project)
      .filter(run => run.taskId === task.id && run.requestKey === key);
    if (matches.length === 0) throw fail(404, '未找到此任务的原同步请求', 'SYNC_RUN_REQUEST_NOT_FOUND');
    const [run] = matches;
    if (matches.length !== 1 || run.configHash !== task.configHash ||
        run.sourceRevisionId !== task.sourceRevisionId || run.metadataVersionId !== task.metadataVersionId)
      throw fail(409, '原同步请求与任务版本不一致', 'SYNC_RUN_REQUEST_MISMATCH');
    return { task, key, run };
  }

  #taskRunRequestView(task, key, run, proof) {
    const state = ['SUCCEEDED', 'FAILED'].includes(run.status) ? run.status :
      proof ? 'LANDING_COMMITTED' : 'UNCONFIRMED';
    const fields = ['id', 'taskId', 'status', 'configHash', 'sourceRevisionId', 'metadataVersionId', 'sourceHash',
      'readCount', 'inserted', 'updated', 'unchanged', 'deleted', 'finalCount', 'targetHash', 'snapshotStatus',
      'landingSnapshotHash', 'watermark', 'startedAt', 'finishedAt', 'durationMs'];
    const summary = Object.fromEntries(fields.filter(field => run[field] !== undefined).map(field => [field, run[field]]));
    return {
      schema: 'shuduo-sync-run-request/v1', taskId: task.id, requestKey: key, state,
      run: { ...summary, sourceType: task.sourceType, targetTable: task.targetTable,
        ...(typeof run.errorCode === 'string' && /^[A-Z0-9_]{1,80}$/.test(run.errorCode) ? { errorCode: run.errorCode } : {}) },
      ...(proof ? { landingEvidence: { runId: proof.runId, ...standardLandingOutput(proof),
        landedAt: proof.landedAt, receiptHash: proof.receiptHash } } : {}),
    };
  }

  #standardReceipt(task, run) {
    return verifyStandardRunReceipt({ store: this.store, landingStore: this.landingStore, project: this.project, task, run });
  }

  #beginTaskRun(task, pending) {
    if (!this.store.update('offline_sync_task', task.id, this.project,
      { status: 'RUNNING', lastRunId: pending.id }, { expectedVersion: task.version }))
      throw fail(409, '同步任务启动状态未确认', 'SYNC_TASK_START_UNCONFIRMED');
  }

  #updateTaskRunSummary(taskId, runId, patch) {
    const current = this.store.get('offline_sync_task', taskId, this.project);
    if (current?.lastRunId === runId && Object.entries(patch).some(([field, value]) => current[field] !== value))
      this.store.update('offline_sync_task', taskId, this.project, patch, { expectedVersion: current.version });
  }

  #finishStandard(task, pending, { reconciled = false, proof = this.#standardReceipt(task, pending) } = {}) {
    if (!proof) throw fail(409, '原落地结果待核对，不重新执行', 'SYNC_RESULT_UNCONFIRMED');
    const run = this.store.update('offline_sync_run', pending.id, this.project, {
      ...standardLandingOutput(proof), landingReceiptHash: proof.receiptHash, status: 'SUCCEEDED',
      sourceType: task.sourceType, actualExecution: true, fullLifecycleE2E: false,
      ...(task.sourceType === 'SERVER_MYSQL' ? { sourceStrategy: task.mode === 'FULL'
        ? 'BOUNDED_FULL_SNAPSHOT' : 'BOUNDED_SNAPSHOT_DIFF_UPSERT' } : {}),
      durationMs: Date.parse(proof.landedAt) - Date.parse(pending.startedAt), finishedAt: proof.landedAt,
      ...(reconciled ? { reconciled: true, recoveredFromStatus: pending.status } : {}),
      error: undefined, errorCode: undefined,
    }, { expectedVersion: pending.version });
    this.#updateTaskRunSummary(task.id, run.id, { status: 'SUCCEEDED', watermark: run.watermark });
    return run;
  }

  #replayStandard(task, prior) {
    const proof = this.#standardReceipt(task, prior);
    if (proof && prior.status === 'SUCCEEDED')
      this.#updateTaskRunSummary(task.id, prior.id, { status: 'SUCCEEDED', watermark: prior.watermark });
    else if (proof && ['RUNNING', 'UNCONFIRMED', 'INTERRUPTED'].includes(prior.status))
      return { ...this.#finishStandard(task, prior, { reconciled: true, proof }), replayed: true };
    if (['SUCCEEDED', 'FAILED'].includes(prior.status)) return { ...prior, replayed: true };
    throw fail(409, '该同步请求仍在运行或已中断，请先检查运行记录', 'SYNC_RUN_UNCERTAIN');
  }

  #preserveStandardCommit(task, pending, cause) {
    let current, proof;
    try {
      current = this.store.get('offline_sync_run', pending.id, this.project);
      proof = this.#standardReceipt(task, current ?? pending);
      if (!proof && cause?.code !== 'SYNC_RESULT_UNCONFIRMED') return; // An ordinary precommit failure.
    } catch {
      // Corrupt or inaccessible evidence cannot justify a terminal failure.
    }
    try {
      if (current?.status !== 'SUCCEEDED') {
        this.store.update('offline_sync_run', pending.id, this.project, {
          status: 'UNCONFIRMED', error: '原落地结果待核对，不重新执行', errorCode: 'SYNC_RESULT_UNCONFIRMED',
        });
        this.#updateTaskRunSummary(task.id, pending.id, { status: 'UNCONFIRMED' });
      }
    } catch { /* Keep the original request even if metadata is temporarily unavailable. */ }
    throw Object.assign(fail(409, '原落地结果待核对，不重新执行', 'SYNC_RESULT_UNCONFIRMED'), { runId: pending.id });
  }

  createTask(input) {
    if(!input||typeof input!=='object'||Array.isArray(input))throw fail(422,'同步配置须为对象','INVALID_SYNC_CONFIG');
    if(['operationField','sequenceField','deleteValues','changePolicy'].some(k=>Object.hasOwn(input,k)))throw fail(422,'请使用独立变更模式和完整changeConfig，不接受忽略的删除控项','UNKNOWN_CHANGE_OPTIONS');
    const config=this.#normalizeTask(input);
    let registry;
    if(config.mode===changelogMode){
      registry=this.store.list('sync_change_target',this.project).find(r=>r.targetTable===config.targetTable);
      if(registry){if(registry.epochId!==config.changeConfig.epochId||registry.specHash!==config.changeSpecHash)throw fail(409,'目标已绑定其他变更代号或映射','CHANGE_TARGET_BINDING_MISMATCH');}
      else{
        if(this.store.list('offline_sync_task',this.project).some(t=>t.targetTable===config.targetTable)||this.landingStore.readTable(config.targetTable).length||this.landingStore.changeStatus(config.targetTable))throw fail(409,'已有目标或旧变更控制状态不完整，请恢复完整状态或使用空的新目标','CHANGE_TARGET_NOT_EMPTY');
        const metadata=this.store.get('source_metadata',config.metadataVersionId,this.project),columns=new Map(metadata.columns.map(c=>[c.name,c]));
        registry=this.store.create('sync_change_target',this.project,{targetTable:config.targetTable,epochId:config.changeConfig.epochId,specHash:config.changeSpecHash,status:'DRAFT',stateHash:null,targetFields:Object.entries(config.mapping).map(([from,name])=>({name,type:columns.get(from)?.type??'STRING',nullable:columns.get(from)?.nullable??true}))});
      }
    }else if(input.changeConfig!==undefined||this.store.list('sync_change_target',this.project).some(r=>r.targetTable===config.targetTable))throw fail(409,'变更受控目标不可用旧模式覆盖，changeConfig仅供变更模式','CHANGE_TARGET_MANAGED');
    return this.store.create('offline_sync_task',this.project,{...config,...(registry?{changeRegistryId:registry.id}:{})});
  }

  #changeRegistry(task){const r=this.store.get('sync_change_target',task.changeRegistryId,this.project);if(!r||r.targetTable!==task.targetTable||r.epochId!==task.changeConfig?.epochId||r.specHash!==task.changeSpecHash)throw fail(409,'变更目标登记与原任务不一致，不能推断恢复状态','CHANGE_REGISTRY_MISSING');return r;}
  #changeReceipt(task,pending){
    const r=this.#changeRegistry(task),marker=this.landingStore.changeStatus(task.targetTable);if(!marker||marker.last_run_id!==pending.id)return undefined;
    const value=marker.receipt,metadata=this.store.get('source_metadata',task.metadataVersionId,this.project);
    if(value.taskId!==task.id||value.configHash!==task.configHash||value.sourceHash!==metadata?.contentHash||value.epochId!==r.epochId||value.specHash!==r.specHash)throw fail(409,'原变更提交回执与任务版本不符','CHANGE_RECEIPT_MISMATCH');
    return {targetTable:value.targetTable,readCount:value.readCount,inserted:value.inserted,updated:value.updated,unchanged:value.unchanged,deleted:value.deleted,finalCount:value.finalCount,targetHash:value.targetHash,snapshotStatus:value.snapshotStatus,...(value.landingSnapshotHash?{landingSnapshotHash:value.landingSnapshotHash}:{}),sourceHash:value.sourceHash,changeState:{epochId:value.epochId,specHash:value.specHash,changeStateHash:value.changeStateHash,appliedEvents:value.appliedEvents,deleteEvents:value.deleteEvents,duplicateEvents:value.duplicateEvents,staleEvents:value.staleEvents}};
  }
  #finishChange(task,pending,output,{reconciled=false}={}){
    const registry=this.#changeRegistry(task);this.store.update('sync_change_target',registry.id,this.project,{status:'READY',stateHash:output.changeState.changeStateHash,lastRunId:pending.id,...(registry.pendingTargetFields?{targetFields:registry.pendingTargetFields}:{}),pendingTargetFields:undefined,pendingRunId:undefined,previousStatus:undefined,previousStateHash:undefined});
    const run=this.store.update('offline_sync_run',pending.id,this.project,{...output,status:'SUCCEEDED',actualExecution:true,fullLifecycleE2E:false,finishedAt:new Date(this.now()).toISOString(),durationMs:this.now()-Date.parse(pending.startedAt),...(reconciled?{reconciled:true,recoveredFromStatus:pending.status}:{}),error:undefined,errorCode:undefined});
    this.store.update('offline_sync_task',task.id,this.project,{status:'SUCCEEDED',lastRunId:run.id});return run;
  }
  #reserveChange(task,pending){
    const r=this.#changeRegistry(task),marker=this.landingStore.changeStatus(task.targetTable);
    const reused=r.status==='UPDATING'&&r.pendingRunId===pending.id,status=reused?r.previousStatus:r.status,hash=reused?r.previousStateHash:r.stateHash;
    if(status==='DRAFT'&&(!marker&&this.landingStore.readTable(task.targetTable).length===0)||status==='READY'&&marker?.state_hash===hash&&marker?.epoch_id===r.epochId&&marker?.spec_hash===r.specHash){
      const before={...r,status,stateHash:hash};if(!reused){const metadata=this.store.get('source_metadata',task.metadataVersionId,this.project),columns=new Map(metadata.columns.map(c=>[c.name,c]));this.store.update('sync_change_target',r.id,this.project,{status:'UPDATING',pendingRunId:pending.id,previousStatus:status,previousStateHash:hash,...(status==='DRAFT'?{pendingTargetFields:Object.entries(task.mapping).map(([from,name])=>({name,type:columns.get(from)?.type??'STRING',nullable:columns.get(from)?.nullable??true}))}:{})});}
      return {before,guard:{initialize:status==='DRAFT',expectedStateHash:hash,epochId:r.epochId,specHash:r.specHash}};
    }
    throw fail(409,'变更状态缺失或有未确认原提交；先按原请求核对，不得重新初始化','CHANGE_STATE_UNCONFIRMED');
  }
  #rollbackChange(task,pending,reservation){
    if(!reservation)return;const marker=this.landingStore.changeStatus(task.targetTable),old=reservation.before;
    if(old.status==='DRAFT'&&!marker&&this.landingStore.readTable(task.targetTable).length===0||old.status==='READY'&&marker?.state_hash===old.stateHash)this.store.update('sync_change_target',old.id,this.project,{status:old.status,stateHash:old.stateHash,pendingTargetFields:undefined,pendingRunId:undefined,previousStatus:undefined,previousStateHash:undefined});
  }

  syncRecoveryPreview(taskId) {
    const task = this.#task(taskId);
    const run = this.store.get("offline_sync_run", task.lastRunId ?? "", this.project);
    const recoverable = run?.errorCode ? Object.hasOwn(staleSyncErrors, run.errorCode) : Object.values(staleSyncErrors).includes(run?.error);
    if (task.sourceType !== "LOCAL_CSV" || task.status !== "FAILED" || run?.status !== "FAILED" ||
        run.taskId !== task.id || run.configHash !== task.configHash || run.sourceRevisionId !== task.sourceRevisionId ||
        run.metadataVersionId !== task.metadataVersionId || !recoverable)
      throw fail(409, "当前任务没有因源或元数据版本变化而失败的原运行", "SYNC_RECOVERY_NOT_APPLICABLE");

    const source = this.#source(task.sourceId);
    const metadata = (id, revisionId) => {
      const item = this.store.get("source_metadata", id ?? "", this.project);
      if (item?.sourceId !== source.id || item.revisionId !== revisionId || item.classification !== "ACTUAL_FILE_SCAN" ||
          item.status !== "COLLECTED" || !Array.isArray(item.columns) ||
          item.schemaHash !== ingestionSchemaHash(item.columns)) return undefined;
      return { sourceRevisionId: revisionId, metadataVersionId: item.id, schemaHash: item.schemaHash,
        columns: item.columns.map(({name,type,nullable}) => ({name,type,nullable})), contentHash: item.contentHash };
    };
    const previous = metadata(task.metadataVersionId, task.sourceRevisionId);
    const current = metadata(source.currentMetadataId, source.currentRevisionId);
    if (!previous || !current || previous.metadataVersionId === current.metadataVersionId)
      throw fail(409, "请先采集当前源版本并核对原元数据，再准备恢复映射", "SYNC_RECOVERY_METADATA_REQUIRED");
    const suggestedMapping = Object.fromEntries(Object.entries(task.mapping)
      .filter(([name]) => current.columns.some(column => column.name === name)));
    const evidence = { protocol: "shuduo-sync-recovery/v1", previousTaskId: task.id, failedRunId: run.id,
      previousConfigHash: task.configHash, targetTable: task.targetTable, mode: task.mode, keyFields: task.keyFields,
      watermarkField: task.watermarkField, previous, current, previousMapping: task.mapping, suggestedMapping };
    return { ...evidence, basisDigest: stableHash(evidence) };
  }

  createSyncRecovery(taskId, input) {
    if (input?.confirm !== true || typeof input.basisDigest !== "string" || !/^[a-f0-9]{64}$/.test(input.basisDigest) ||
        Object.keys(input).some(key => !["confirm", "basisDigest", "mapping"].includes(key)))
      throw fail(422, "请审阅新旧映射并确认对应的恢复依据", "SYNC_RECOVERY_CONFIRMATION_REQUIRED");
    const mapping = normalizeMapping(input.mapping);
    const signature = stableHash({taskId, basisDigest: input.basisDigest, mapping});
    return this.store.deduplicate(`${this.project}:sync-recovery:${signature}`, signature, () => {
      const preview = this.syncRecoveryPreview(taskId);
      if (preview.basisDigest !== input.basisDigest)
        throw fail(409, "源版本或原运行已有变化，请重新核对恢复映射", "SYNC_RECOVERY_CHANGED");
      const task = this.#task(taskId);
      const config = this.#normalizeTask({ ...task, name: "恢复 · " + task.name.slice(0,75), mapping,
        sourceRevisionId:preview.current.sourceRevisionId,metadataVersionId:preview.current.metadataVersionId });
      if (task.mode === "INCREMENTAL_UPSERT") {
        const targetTypes = (mapping, schema) => Object.fromEntries(Object.entries(mapping)
          .map(([source, target]) => [target, schema.columns.find(column => column.name === source)?.type]));
        if (stableHash(targetTypes(task.mapping, preview.previous)) !== stableHash(targetTypes(config.mapping, preview.current)))
          throw fail(409, "增量恢复须保留原目标字段和类型；需要改变结构时请创建全量任务", "SYNC_RECOVERY_TARGET_SCHEMA_CHANGED");
      }
      return this.store.create("offline_sync_task", this.project, { ...config, recovery: {
        previousTaskId: task.id, failedRunId: preview.failedRunId, basisDigest: preview.basisDigest,
      } });
    });
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
    if (
      source.sourceType === "SERVER_MYSQL" &&
      this.serverMysqlAdapter?.supportsOfflineSync !== true
    )
      throw fail(409, "SERVER_MYSQL首期仅支持连接与元数据采集，尚未开放同步执行", "MYSQL_SYNC_NOT_ENABLED");
    if (!metadata || metadata.revisionId !== revision.id)
      throw fail(409, "请先采集当前数据源版本的元数据", "METADATA_REQUIRED");
    if ((input.sourceRevisionId===undefined)!==(input.metadataVersionId===undefined))
      throw fail(400,"源版本与元数据版本须同时提供","SYNC_SOURCE_BINDING_REQUIRED");
    if(input.sourceRevisionId!==undefined&&(input.sourceRevisionId!==revision.id||input.metadataVersionId!==metadata.id))
      throw fail(409,"源版本或元数据已变化，请重新读取并核对字段映射","SYNC_SOURCE_BINDING_CHANGED");
    const mapping = normalizeMapping(input.mapping),
      sourceFields = new Set(metadata.columns.map((column) => column.name));
    if (!Object.keys(mapping).every((field) => sourceFields.has(field)))
      throw fail(400, "字段映射引用了不存在的源字段", "UNKNOWN_SOURCE_FIELD");
    const mode = input.mode;
    if (!["FULL", "INCREMENTAL_UPSERT",changelogMode].includes(mode))
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
    let changeConfig,changeSpec;
    if(mode===changelogMode){
      if(!this.allowChangelog||source.sourceType!=='LOCAL_CSV')throw fail(403,'CSV变更模式当前仅供本机CSV目标','CHANGE_LOCAL_ONLY');
      changeConfig=normalizeChangeConfig(input.changeConfig,mapping,keyFields);
      if(!sourceFields.has(changeConfig.operationField)||!sourceFields.has(changeConfig.sequenceField)||watermarkField)throw fail(422,'操作/序号源字段须存在，变更模式不使用旧记录水位','CHANGE_SOURCE_FIELDS_INVALID');
      changeSpec=changeSpecHash(changeConfig,mapping,keyFields);
    }else if(input.changeConfig!==undefined)throw fail(422,'changeConfig仅供独立变更模式','CHANGE_MODE_REQUIRED');
    const config = {
      name: text(input.name, "同步任务名称", 2, 80),
      sourceId: source.id,
      sourceType: source.sourceType,
      sourceRevisionId: revision.id,
      metadataVersionId: metadata.id,
      targetTable: identifier(input.targetTable, "目标表"),
      mode,
      mapping,
      keyFields,
      watermarkField,
      ...(changeConfig?{changeConfig,changeSpecHash:changeSpec}:{}),
      status: "READY",
    };
    return {
      ...config,
      configHash: stableHash({
        sourceRevisionId: revision.id,
        sourceType: source.sourceType,
        metadataVersionId: metadata.id,
        targetTable: input.targetTable,
        mode,
        mapping,
        keyFields,
        watermarkField,
        ...(changeConfig?{changeConfig,changeSpecHash:changeSpec}:{}),
      }),
    };
  }

  runTask(taskId, request = {}) {
    const task = this.#task(taskId),
      started = this.now();
    let resumed,changeReservation;
    let landingAttempted = false;
    if(task.mode!==changelogMode&&this.store.list('sync_change_target',this.project).some(r=>r.targetTable===task.targetTable))throw fail(409,'变更受控目标不可用旧任务覆盖','CHANGE_TARGET_MANAGED');
    if(task.mode===changelogMode&&!this.allowChangelog)throw fail(403,'变更模式当前仅供本机执行','CHANGE_LOCAL_ONLY');
    if (request.requestKey) {
      const prior = this.store
        .list("offline_sync_run", this.project)
        .find((run) => run.requestKey === request.requestKey);
      if (prior) {
        if (prior.taskId !== task.id || prior.requestSignature !== request.requestSignature)
          throw fail(
            409,
            "相同幂等键不能用于不同同步请求",
            "SYNC_IDEMPOTENCY_CONFLICT",
          );
        if (task.mode !== changelogMode) return this.#replayStandard(task, prior);
        if(!['SUCCEEDED','FAILED'].includes(prior.status)){
          const receipt=this.#changeReceipt(task,prior);if(receipt)return {...this.#finishChange(task,prior,receipt,{reconciled:true}),replayed:true};
          const r=this.#changeRegistry(task);if(r.status!=='UPDATING'||r.pendingRunId!==prior.id)throw fail(409,'原变更请求缺少可核对的控制状态','CHANGE_STATE_UNCONFIRMED');resumed=prior;
        }
        if (["SUCCEEDED", "FAILED"].includes(prior.status))
          return { ...prior, replayed: true };
        if(!resumed)throw fail(
          409,
          "该同步请求仍在运行或已中断，请先检查运行记录",
          "SYNC_RUN_UNCERTAIN",
        );
      }
    }
    if(task.mode===changelogMode&&!resumed&&(()=>{const r=this.#changeRegistry(task);return r.status==='UPDATING'||r.lastRunId&&this.store.get('offline_sync_run',r.lastRunId,this.project)?.status!=='SUCCEEDED';})())throw fail(409,'目标有未确认的原请求，请先恢复原请求','CHANGE_STATE_UNCONFIRMED');
    const pending = resumed??this.store.create("offline_sync_run", this.project, {
      taskId: task.id,
      status: "RUNNING",
      sourceRevisionId: task.sourceRevisionId,
      metadataVersionId: task.metadataVersionId,
      configHash: task.configHash,
      ...(task.mode === changelogMode ? {} : { standardReceiptVersion: 1, sourceType: task.sourceType }),
      requestKey: request.requestKey,
      requestSignature: request.requestSignature,
      startedAt: new Date(started).toISOString(),
      actualExecution: true,
      fullLifecycleE2E: false,
    });
    try {
      this.#beginTaskRun(task, pending);
      const source = this.#source(task.sourceId);
      if (source.sourceType === "SERVER_MYSQL")
        throw fail(
          409,
          "SERVER_MYSQL请使用异步服务端同步执行",
          "SERVER_SOURCE_ASYNC_REQUIRED",
        );
      if (source.currentRevisionId !== task.sourceRevisionId)
        throw fail(
          409,
          staleSyncErrors.SOURCE_REVISION_STALE,
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
          staleSyncErrors.METADATA_STALE,
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
      const watermark=ingestionWatermark(parsed.rows,task.watermarkField?Object.entries(task.mapping).find(([,target])=>target===task.watermarkField)?.[0]:undefined,metadata.columns);
      if(task.mode===changelogMode)changeReservation=this.#reserveChange(task,pending);
      landingAttempted = true;
      const output = this.landingStore.sync({
        ...(changeReservation?{changeConfig:task.changeConfig,changeGuard:changeReservation.guard}:{}),
        ...(task.mode === changelogMode ? {} : { standardExecution: {
          sourceType: task.sourceType, requestHash: standardRunRequestHash(pending), watermark, now: () => this.now(),
        } }),
        runId: pending.id,
        snapshotBinding: syncLandingBinding(task, this.project, input.fileHash),
        targetTable: task.targetTable,
        mode: task.mode,
        rows: parsed.rows,
        mapping: task.mapping,
        keyFields: task.keyFields,
        sourceHash: input.fileHash,
        syncedAt: new Date(this.now()).toISOString(),
      });
      if(task.mode===changelogMode)return this.#finishChange(task,pending,{...output,sourceHash:input.fileHash},{reconciled:Boolean(resumed)});
      return this.#finishStandard(task, pending);
    } catch (error) {
      if(task.mode===changelogMode){
        let receipt;try{receipt=this.#changeReceipt(task,pending);}catch{throw Object.assign(fail(409,'原变更控制证据待核对，保留原请求','CHANGE_STATE_UNCONFIRMED'),{runId:pending.id});}
        if(receipt){try{const r=this.#changeRegistry(task);this.store.update('sync_change_target',r.id,this.project,{status:'UPDATING',pendingRunId:pending.id});this.store.update('offline_sync_run',pending.id,this.project,{status:'UNCONFIRMED',error:'落地已提交，元数据结果待原请求核对',errorCode:'CHANGE_RESULT_UNCONFIRMED'});this.store.update('offline_sync_task',task.id,this.project,{status:'UNCONFIRMED',lastRunId:pending.id});}catch{}throw Object.assign(fail(409,'落地已提交，请使用原请求回读，不重新落地','CHANGE_RESULT_UNCONFIRMED'),{runId:pending.id});}
        if(resumed&&!changeReservation)changeReservation=this.#reserveChange(task,pending);
        this.#rollbackChange(task,pending,changeReservation);
      } else if (landingAttempted) this.#preserveStandardCommit(task, pending, error);
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
        errorCode: error.code ?? "CSV_SYNC_FAILED",
        durationMs: this.now() - started,
        finishedAt: new Date(this.now()).toISOString(),
        actualExecution: true,
        fullLifecycleE2E: false,
        }, { expectedVersion: pending.version },
      );
      this.#updateTaskRunSummary(task.id, run.id, { status: 'FAILED' });
      throw Object.assign(error, { runId: run.id });
    }
  }

  async runServerMysqlTask(taskId, request = {}) {
    const task = this.#task(taskId),
      started = this.now();
    if (this.store.list('sync_change_target', this.project).some(r => r.targetTable === task.targetTable))
      throw fail(409, '变更受控目标不可被MySQL任务覆盖', 'CHANGE_TARGET_MANAGED');
    if (task.sourceType !== "SERVER_MYSQL")
      throw fail(409, "当前同步任务不是SERVER_MYSQL", "SOURCE_TYPE_MISMATCH");
    if (request.requestKey) {
      const prior = this.store
        .list("offline_sync_run", this.project)
        .find((run) => run.requestKey === request.requestKey);
      if (prior) {
        if (prior.taskId !== task.id || prior.requestSignature !== request.requestSignature)
          throw fail(409, "相同幂等键不能用于不同同步请求", "SYNC_IDEMPOTENCY_CONFLICT");
        return this.#replayStandard(task, prior);
      }
    }
    const source = this.#source(task.sourceId);
    if (source.sourceType !== "SERVER_MYSQL")
      throw fail(409, "当前同步任务不是SERVER_MYSQL", "SOURCE_TYPE_MISMATCH");
    if (this.serverMysqlAdapter?.supportsOfflineSync !== true)
      throw fail(409, "服务端MySQL同步尚未启用", "MYSQL_SYNC_NOT_ENABLED");
    const pending = this.store.create("offline_sync_run", this.project, {
      taskId: task.id,
      status: "RUNNING",
      sourceType: "SERVER_MYSQL",
      sourceRevisionId: task.sourceRevisionId,
      metadataVersionId: task.metadataVersionId,
      configHash: task.configHash,
      standardReceiptVersion: 1,
      requestKey: request.requestKey,
      requestSignature: request.requestSignature,
      startedAt: new Date(started).toISOString(),
      actualExecution: true,
      fullLifecycleE2E: false,
    });
    let landingAttempted = false;
    try {
      this.#beginTaskRun(task, pending);
      if (source.currentRevisionId !== task.sourceRevisionId)
        throw fail(409, "数据源版本已变化，请新建同步任务版本", "SOURCE_REVISION_STALE");
      const metadata = this.store.get("source_metadata", task.metadataVersionId, this.project);
      if (!metadata || source.currentMetadataId !== metadata.id)
        throw fail(409, "元数据版本已变化，请重新配置同步任务", "METADATA_STALE");
      const revision = this.#revision(task.sourceRevisionId),
        described = await this.serverMysqlAdapter.describe(revision.tableName),
        currentColumns = described.columns.map((column) => ({
          ...column,
          distinctCount: undefined,
        })),
        currentSchemaHash = stableHash(
          currentColumns.map(({ name, type, nullable }) => ({ name, type, nullable })),
        );
      if (currentSchemaHash !== metadata.schemaHash)
        throw fail(409, "MySQL表结构在元数据采集后发生变化", "SOURCE_CHANGED");
      const snapshot = await this.serverMysqlAdapter.readRows(revision.tableName),
        sourceKeyFields = task.keyFields.map(
          (target) =>
            Object.entries(task.mapping).find(([, mapped]) => mapped === target)?.[0],
        ),
        rows = snapshot.rows.slice().sort((left, right) =>
          sourceKeyFields
            .map((field) => String(left[field] ?? ""))
            .join("\u0000")
            .localeCompare(
              sourceKeyFields
                .map((field) => String(right[field] ?? ""))
                .join("\u0000"),
            ),
        ),
        sourceHash = stableHash(rows),
        watermark=ingestionWatermark(rows,task.watermarkField?Object.entries(task.mapping).find(([,target])=>target===task.watermarkField)?.[0]:undefined,metadata.columns);
      landingAttempted = true;
      this.landingStore.sync({
          standardExecution: { sourceType: task.sourceType, requestHash: standardRunRequestHash(pending), watermark, now: () => this.now() },
          runId: pending.id,
          snapshotBinding: syncLandingBinding(task, this.project, sourceHash),
          targetTable: task.targetTable,
          mode: task.mode,
          rows,
          mapping: task.mapping,
          keyFields: task.keyFields,
          sourceHash,
          syncedAt: new Date(this.now()).toISOString(),
      });
      return this.#finishStandard(task, pending);
    } catch (error) {
      if (landingAttempted) this.#preserveStandardCommit(task, pending, error);
      const run = this.store.update("offline_sync_run", pending.id, this.project, {
        status: "FAILED",
        sourceType: "SERVER_MYSQL",
        sourceRevisionId: task.sourceRevisionId,
        metadataVersionId: task.metadataVersionId,
        configHash: task.configHash,
        error: "服务端MySQL同步失败",
        errorCode: error.code ?? "MYSQL_SYNC_FAILED",
        durationMs: this.now() - started,
        finishedAt: new Date(this.now()).toISOString(),
        actualExecution: true,
        fullLifecycleE2E: false,
      }, { expectedVersion: pending.version });
      this.#updateTaskRunSummary(task.id, run.id, { status: 'FAILED' });
      throw Object.assign(error, { runId: run.id });
    }
  }

  previewTarget(targetTable) {
    return this.landingStore.readTable(targetTable);
  }

  retainedRunSnapshot(taskId,runId) {
    const task=this.#task(taskId),run=this.store.get('offline_sync_run',runId,this.project);
    if (!run || run.taskId!==task.id) throw fail(404,'同步运行不存在','SYNC_RUN_NOT_FOUND');
    if (run.status!=='SUCCEEDED'||run.actualExecution!==true) throw fail(409,'只有实际成功的批次可核对落地快照','SYNC_RUN_NOT_SUCCEEDED');
    if (run.configHash!==task.configHash||run.sourceRevisionId!==task.sourceRevisionId||run.metadataVersionId!==task.metadataVersionId||run.targetTable!==task.targetTable)
      throw fail(409,'运行与原任务版本不一致','SYNC_SNAPSHOT_MISMATCH');
    this.#standardReceipt(task, run);
    const summary={taskId:task.id,runId:run.id,targetTable:run.targetTable,rowCount:run.finalCount,targetHash:run.targetHash};
    if (run.snapshotStatus!=='RETAINED') return {...summary,status:'NOT_RETAINED',reason:run.snapshotStatus==='NOT_RETAINED_LIMIT'?'RETENTION_LIMIT':'LEGACY_RUN'};
    const value=this.landingStore.readRunSnapshot({runId,targetTable:task.targetTable,binding:syncLandingBinding(task, this.project, run.sourceHash),
      targetHash:run.targetHash,rowCount:run.finalCount,snapshotHash:run.landingSnapshotHash});
    return {...summary,status:'VERIFIED',integrityVerified:true,snapshotHash:run.landingSnapshotHash,createdAt:value.createdAt,rows:value.rows};
  }

  previewRunSnapshot(taskId,runId,{page=1,pageSize=50}={}) {
    if (!Number.isSafeInteger(page)||page<1||!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>100)
      throw fail(422,'页码须为正整数，每页1—100行','INVALID_SNAPSHOT_PAGE');
    const value=this.retainedRunSnapshot(taskId,runId);
    if(value.status!=='VERIFIED')return {...value,page,pageSize};
    const task=this.#task(taskId),totalPages=Math.max(1,Math.ceil(value.rows.length/pageSize));
    if (page>totalPages) throw fail(422,'页码超过原批次范围','INVALID_SNAPSHOT_PAGE');
    let currentTarget;
    try {
      const current=this.landingStore.inspectTarget(task.targetTable);
      currentTarget={status:'VERIFIED',runId:current.runId,rowCount:current.rowCount,targetHash:current.targetHash,
        matchesOriginalRun:current.runId===runId&&current.targetHash===value.targetHash};
    } catch { currentTarget={status:'UNCONFIRMED'}; }
    return {...value,
      currentTarget,
      columns:[...new Set(value.rows.flatMap(row=>Object.keys(row)))].filter(key=>key!=='rowKey'),
      page,pageSize,totalPages,rows:value.rows.slice((page-1)*pageSize,page*pageSize)};
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

  #createServerMysqlRevision(source, input) {
    if (input.credentialRef || input.password || input.host || input.user)
      throw fail(400, "SERVER_MYSQL只允许服务端配置，不接受浏览器凭证", "UNEXPECTED_CREDENTIAL");
    const tableName = identifier(input.tableName, "MySQL数据表");
    if (!this.serverMysqlAdapter?.allowTables?.includes(tableName))
      throw fail(422, "MySQL数据表不在服务端白名单中", "MYSQL_TABLE_NOT_ALLOWED");
    const count = this.store
      .list("source_revision", this.project)
      .filter((item) => item.sourceId === source.id).length;
    return this.store.create("source_revision", this.project, {
      sourceId: source.id,
      revisionNumber: count + 1,
      sourceType: "SERVER_MYSQL",
      tableName,
      connectionProfile: this.serverMysqlAdapter.profileId,
      sourceConfigHash: stableHash({ profile: this.serverMysqlAdapter.profileId, tableName }),
    });
  }

  readRegisteredCsv({sourceId,sourceRevisionId,metadataVersionId,contentHash}) {
    const source=this.#source(sourceId),revision=this.#revision(sourceRevisionId),metadata=this.store.get('source_metadata',metadataVersionId,this.project);
    if(source.sourceType!=='LOCAL_CSV'||revision.sourceType!=='LOCAL_CSV'||revision.sourceId!==source.id||
        !metadata||metadata.sourceId!==source.id||metadata.revisionId!==revision.id||metadata.contentHash!==contentHash)
      throw fail(409,'原CSV版本、元数据或摘要未核对一致','SOURCE_EVIDENCE_CHANGED');
    let input;
    try { input=this.#read(revision.fileName); }
    catch(cause) {
      const allowed=['SOURCE_FILE_NOT_FOUND','SOURCE_SYMLINK_FORBIDDEN','SOURCE_PATH_FORBIDDEN','INVALID_SOURCE_FILE','INVALID_FILE_NAME'];
      throw fail(allowed.includes(cause.code)?(cause.status??409):409,'原登记CSV不可读取，请使用原文件离线核验',allowed.includes(cause.code)?cause.code:'SOURCE_FILE_UNAVAILABLE');
    }
    if(input.fileHash!==contentHash||input.bytes!==metadata.bytes||Buffer.byteLength(input.content)!==input.bytes)
      throw fail(409,'原CSV字节已变化，请使用原文件离线核验；未采用当前版本替代','SOURCE_CHANGED');
    return input.content;
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
