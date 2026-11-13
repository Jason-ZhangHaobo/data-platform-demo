import {checkDistributionResponse} from './distribution-consumption-check.mjs';
import {distributionFields,distributionComposition,distributionResponseSchema,combineDistributionResults,snapshotContractById} from './distribution-services.mjs';
import {initDistributionStore,distributionDescriptor,materializeDistribution,distributionSnapshotEvidence,queryDistribution,resultSnapshotHash} from './distribution-query-store.mjs';
import { fundDapiContract, normalizeFundFilters } from "./fund-dapi-contract.mjs";
import { expectedFundCallRows } from "./fund-call-result.mjs";
import { fundContext } from "./fund-lookthrough.mjs";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { validateDeliveryPackage, sha256, validationMatchesFamily } from "./delivery.mjs";
import { syncServiceProtocol } from "./sync-sql-service-source.mjs";

const fail = (status, message, code) =>
  Object.assign(new Error(message), { status, code });
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
const isSync = version => version?.sourceEvidence?.protocol === syncServiceProtocol;
const syncChanged = () => fail(409, "冻结持仓接口的来源、固定版本或查询结果已变化", "SYNC_SERVICE_SOURCE_CHANGED");
const sameSyncEvidence = (a, b) => a && b && serviceHash(a) === serviceHash(b);
export const serviceHash = (value) =>
  createHash("sha256").update(canonical(value)).digest("hex");
export function serviceVersionConfigValid(version) {
  if(!version || !['DAPI','XAPI'].includes(version.serviceType))return false;
  const keys=version.serviceType==='DAPI'?
    ['sourceReleaseRunId','sourceReleaseId','sourceEngine','sourceEngineVersion','sourcePackageDigest','scope','snapshotId','snapshotHash','fields','timeoutMs','rateLimitPerMinute','parameterSchema','queryTemplate']:
    ['steps','scope','joinKey','timeoutMs','rateLimitPerMinute','parameterSchema'];
  const config={serviceType:version.serviceType};
  for(const key of [...keys,"outputContractId","sourceEvidence","composition","groupKeys","joinKeys"])if(Object.hasOwn(version,key))config[key]=version[key];
  try{return serviceHash(config)===version.configHash;}catch{return false;}
}
const text = (value, name, min = 1, max = 100) => {
  if (
    typeof value !== "string" ||
    value.trim().length < min ||
    value.length > max
  )
    throw fail(400, `${name}长度必须为${min}—${max}个字符`, "INVALID_TEXT");
  return value.trim();
};
const integer = (value, name, fallback, min, max) => {
  const resolved = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(resolved) || resolved < min || resolved > max)
    throw fail(400, `${name}必须是${min}—${max}的整数`, "INVALID_INTEGER");
  return resolved;
};
const slug = (value) => {
  const resolved = text(value, "服务路径", 3, 48).toLowerCase();
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(resolved))
    throw fail(
      400,
      "服务路径只允许小写字母、数字和单个短横线，且必须以字母开头",
      "INVALID_SLUG",
    );
  return resolved;
};
const clientId = (value) => {
  if (value === undefined || value === null || value === "") return undefined;
  const resolved = text(value, "客户编号", 3, 64);
  if (!/^[A-Z0-9][A-Z0-9-]*$/.test(resolved))
    throw fail(400, "客户编号格式不合法", "INVALID_CLIENT_ID");
  return resolved;
};
const decimal2 = (value) => {
  const resolved = String(value);
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(resolved))
    throw fail(409, "源发布金额不是两位精度以内的十进制数", "INVALID_DECIMAL");
  const [whole, fraction = ""] = resolved.split(".");
  return `${whole}.${fraction.padEnd(2, "0")}`;
};
const assetFields = [
  "client_id",
  "holding_market_value",
  "available_cash",
  "total_assets",
  "security_count",
];
const normalizeFields = (value) => {
  const fields = value === undefined ? assetFields : value;
  if (
    !Array.isArray(fields) ||
    !fields.length ||
    fields.length > assetFields.length ||
    !fields.every((field) => assetFields.includes(field)) ||
    new Set(fields).size !== fields.length
  )
    throw fail(400, "返回字段不在客户资产输出契约内", "INVALID_FIELDS");
  return fields.includes("client_id") ? fields : ["client_id", ...fields];
};
const normalizeQuery = (value = {}) => {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => !["clientId", "client_id", "page", "pageSize", "page_size"].includes(k)))
    throw fail(400, "查询只接受客户编号和分页参数", "INVALID_QUERY");
  return ({
  clientId: clientId(value.clientId ?? value.client_id),
  page: integer(value.page, "页码", 1, 1, 10000),
  pageSize: integer(value.pageSize ?? value.page_size, "每页数量", 20, 1, 100),
}); };
const fundParameters = {
  portfolio_id: { type: "string", pattern: "^[A-Z0-9][A-Z0-9-]{2,63}$" },
  trade_date: { type: "string", format: "date" },
  asset_class: { type: "string", maxLength: 40 },
};
const queryFor = (contractId, input = {}) => {
  if (contractId !== fundDapiContract.id) return normalizeQuery(input);
  const filters = normalizeFundFilters(input);
  const page = input.page, pageSize = input.pageSize === undefined ? input.page_size : input.pageSize;
  for (const value of [page, pageSize]) {
    if (value !== undefined && typeof value !== "number" && !(typeof value === "string" && /^[1-9]\d*$/.test(value)))
      throw fail(400, "分页参数必须为正整数", "INVALID_FUND_QUERY");
  }
  return { ...filters, page: integer(page, "页码", 1, 1, 10000),
    pageSize: integer(pageSize, "每页数量", 20, 1, 100) };
};
const publicApp = (app, now = Date.now()) => {
  if (!app) return app;
  const { tokenHash, ...safe } = app;
  if (safe.status === "ACTIVE" && Object.hasOwn(safe, "expiresAt") &&
      (!Number.isFinite(Date.parse(safe.expiresAt)) || now >= Date.parse(safe.expiresAt))) safe.status = "EXPIRED";
  return safe;
};

export function normalizedServiceSourceRows(rows) {
    if (!Array.isArray(rows) || !rows.length || rows.length > 1000)
      throw fail(409, "源发布批次没有可服务的结果", "INVALID_SOURCE_ROWS");
    const normalized = rows.map((row) => {
      if (
        !row ||
        typeof row !== "object" ||
        !assetFields.every((field) => Object.hasOwn(row, field)) ||
        !/^[A-Z0-9][A-Z0-9-]{2,63}$/.test(String(row.client_id)) ||
        !["holding_market_value", "available_cash", "total_assets"].every(
          (field) => /^-?\d+(?:\.\d{1,2})?$/.test(String(row[field])),
        ) ||
        !Number.isSafeInteger(Number(row.security_count)) ||
        Number(row.security_count) < 0
      )
        throw fail(409, "源发布结果不符合客户资产服务契约", "INVALID_SOURCE_ROWS");
      return {
        client_id: String(row.client_id),
        holding_market_value: decimal2(row.holding_market_value),
        available_cash: decimal2(row.available_cash),
        total_assets: decimal2(row.total_assets),
        security_count: Number(row.security_count),
      };
    });
    if (new Set(normalized.map((row) => row.client_id)).size !== normalized.length)
      throw fail(409, "源发布结果包含重复客户", "DUPLICATE_CLIENT");
    normalized.sort((a, b) => a.client_id.localeCompare(b.client_id));
    return normalized;
}

export class BusinessQueryStore {
  #distributionAvailable;

  constructor(path = ":memory:", { readOnly = false } = {}) {
    if (!readOnly && path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path, { readOnly });
    // Archived customer-asset stores predate the distribution snapshot table.
    this.#distributionAvailable = !readOnly || Boolean(this.db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='service_distribution_snapshots'",
    ).get());
    if (readOnly) return;
    this.db.exec(
      "PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS service_snapshots(id TEXT PRIMARY KEY, content_hash TEXT NOT NULL, row_count INTEGER NOT NULL, created_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS customer_assets(snapshot_id TEXT NOT NULL, client_id TEXT NOT NULL, holding_market_value TEXT NOT NULL, available_cash TEXT NOT NULL, total_assets TEXT NOT NULL, security_count INTEGER NOT NULL, PRIMARY KEY(snapshot_id,client_id), FOREIGN KEY(snapshot_id) REFERENCES service_snapshots(id)); CREATE INDEX IF NOT EXISTS customer_assets_snapshot ON customer_assets(snapshot_id,client_id);",
    );
    initDistributionStore(this.db);
    this.mutationListener = undefined;
  }

  #distributionFor(snapshotId) {
    return this.#distributionAvailable ? distributionDescriptor(this.db, snapshotId) : undefined;
  }

  setMutationListener(listener) {
    this.mutationListener = listener;
  }

  materialize(snapshotId, rows, now = new Date().toISOString(),outputContractId) {
    if(outputContractId)return materializeDistribution(this,text(snapshotId,"快照编号",3,120),rows,now,outputContractId,serviceHash);
    const id = text(snapshotId, "快照编号", 3, 120);
    const normalized = normalizedServiceSourceRows(rows);
    const contentHash = serviceHash(normalized),
      prior = this.db
        .prepare("SELECT * FROM service_snapshots WHERE id=?")
        .get(id);
    if (prior) {
      if (prior.content_hash !== contentHash)
        throw fail(409, "相同快照编号不能对应不同结果", "SNAPSHOT_CONFLICT");
      return {
        id,
        contentHash,
        rowCount: prior.row_count,
        replayed: true,
      };
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("INSERT INTO service_snapshots VALUES(?,?,?,?)")
        .run(id, contentHash, normalized.length, now);
      const insert = this.db.prepare(
        "INSERT INTO customer_assets VALUES(?,?,?,?,?,?)",
      );
      for (const row of normalized)
        insert.run(
          id,
          row.client_id,
          row.holding_market_value,
          row.available_cash,
          row.total_assets,
          row.security_count,
        );
      this.db.exec("COMMIT");
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
    this.mutationListener?.();
    return { id, contentHash, rowCount: normalized.length, replayed: false };
  }

  queryAssets(snapshotId, input = {}, fields) {
    const descriptor=this.#distributionFor(snapshotId);
    if(descriptor)return queryDistribution(this,text(snapshotId,"快照编号",3,120),queryFor(descriptor.output_contract_id,input),fields,descriptor);
    const id = text(snapshotId, "快照编号", 3, 120),
      query = normalizeQuery(input),
      projection = normalizeFields(fields),
      where = query.clientId ? " AND client_id=?" : "",
      parameters = query.clientId ? [id, query.clientId] : [id],
      total = this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM customer_assets WHERE snapshot_id=?${where}`,
        )
        .get(...parameters).count,
      rows = this.db
        .prepare(
          `SELECT ${projection.join(",")} FROM customer_assets WHERE snapshot_id=?${where} ORDER BY client_id LIMIT ? OFFSET ?`,
        )
        .all(
          ...parameters,
          query.pageSize,
          (query.page - 1) * query.pageSize,
        )
        .map((row) => ({ ...row }));
    return {
      rows,
      pagination: {
        page: query.page,
        pageSize: query.pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
      },
      query,
    };
  }

  close() {
    this.db.close();
  }

  snapshot(id) {
    const value=this.db.prepare("SELECT id,content_hash,row_count FROM service_snapshots WHERE id=?").get(id);
    const d=value?this.#distributionFor(id):undefined;
    return value ? {id:value.id,contentHash:value.content_hash,rowCount:value.row_count,...(d?{outputContractId:d.output_contract_id}:{})} : undefined;
  }

  snapshotEvidence(id) {
    const snapshot = this.snapshot(id);
    if (!snapshot) return undefined;
    const d=this.#distributionFor(id);if(d)return distributionSnapshotEvidence(this,snapshot,d,serviceHash);
    // The materialization contract permits at most 1,000 rows. Reading one
    // extra detects corrupt restores without allowing an unbounded scan.
    const rows = this.db.prepare(
      `SELECT ${assetFields.join(',')} FROM customer_assets WHERE snapshot_id=? LIMIT 1001`,
    ).all(id).map(row => ({ ...row }));
    rows.sort((a, b) => a.client_id.localeCompare(b.client_id));
    const computedHash = serviceHash(rows);
    return {
      ...snapshot,
      actualRowCount: rows.length,
      computedHash,
      integrityVerified: snapshot.rowCount >= 1 && snapshot.rowCount <= 1000 &&
        rows.length === snapshot.rowCount && computedHash === snapshot.contentHash,
    };
  }
}

export class DataServiceManager {
  constructor({
    store,
    businessStore,
    project,
    releaseRunFor,
    scope = "LOCAL_TEST_ONLY",
    verifySource,
    distributionSourceFor,
    fundSourceFor,
    syncSourceFor,
    now = () => Date.now(),
    executeDapi,
    contractGate,
  }) {
    this.store = store;
    this.businessStore = businessStore;
    this.project = project;
    this.releaseRunFor = releaseRunFor;
    if (!["LOCAL_TEST_ONLY", "PRIVATE_CLOUD_TEST"].includes(scope)) throw new Error("Unsupported service scope");
    this.scope = scope;
    this.verifySource = verifySource;
    this.distributionSourceFor=distributionSourceFor;
    this.fundSourceFor = fundSourceFor;
    this.syncSourceFor = syncSourceFor;
    this.contractGate = contractGate;
    this.now = now;
    this.executeDapi =
      executeDapi ??
      ((version, input) => {
        const snapshot = this.businessStore.snapshotEvidence(version.snapshotId);
        if(!snapshot?.integrityVerified || snapshot.contentHash!==version.snapshotHash||snapshot.outputContractId!==version.outputContractId)
          throw fail(409,"服务结果快照缺失或摘要不一致，不能以空结果冒充恢复成功","SOURCE_SNAPSHOT_UNAVAILABLE");
        return this.businessStore.queryAssets(
          version.snapshotId,
          input,
          version.fields,
        ); });
  }

  list(type) {
    return this.store
      .list("data_service", this.project)
      .filter((item) => !type || item.serviceType === type)
      .map((item) => this.detail(item.id));
  }

  detail(id) {
    const service = this.#service(id),
      versions = this.store
        .list("data_service_version", this.project)
        .filter((version) => version.serviceId === service.id)
        .sort((a, b) => b.versionNumber - a.versionNumber);
    return {
      ...service,
      currentVersion: versions.find(
        (version) => version.id === service.currentVersionId,
      ),
      publishedVersion: versions.find(
        (version) => version.id === service.publishedVersionId,
      ),
      versions,
    };
  }

  createDapi(input) {
    const name = text(input.name, "DAPI名称", 2, 80),
      path = slug(input.slug),
      timeoutMs = integer(input.timeoutMs, "超时时间", 1500, 100, 5000),
      rateLimitPerMinute = integer(
        input.rateLimitPerMinute,
        "每分钟限流",
        60,
        1,
        600,
      );
    this.#uniqueSlug(path);
    const releaseRun = this.releaseRunFor(
      text(input.sourceReleaseRunId, "源发布批次", 3, 80),
    );
    this.#assertReleaseRun(releaseRun);
    const fund = this.#fundSource(releaseRun), source = fund ?? this.#distribution(releaseRun), sync = this.#syncSource(releaseRun);
    const fields = source ? distributionFields(source.outputContractId, input.fields) : normalizeFields(input.fields);
    const snapshot = this.businessStore.materialize(
        `release-run:${releaseRun.id}`,
        fund?.rows ?? releaseRun.rows,
        new Date(this.now()).toISOString(),
        source?.outputContractId,
      ),
      service = this.store.create("data_service", this.project, {
        serviceType: "DAPI",
        name,
        slug: path,
        status: "DRAFT",
      }),
      version = this.#createVersion(service, {
        sourceReleaseRunId: releaseRun.id,
        sourceReleaseId: releaseRun.releaseId,
        sourceEngine: releaseRun.engine,
        sourceEngineVersion: releaseRun.engineVersion,
        ...(releaseRun.packageDigest ? { sourcePackageDigest: releaseRun.packageDigest } : {}),
        scope: this.scope,
        snapshotId: snapshot.id,
        snapshotHash: snapshot.contentHash,
        ...(source ? { outputContractId: source.outputContractId, sourceEvidence: source.sourceEvidence } : {}),
        ...(sync ? { sourceEvidence: sync.sourceEvidence } : {}),
        fields,
        timeoutMs,
        rateLimitPerMinute,
        parameterSchema: {
          ...(fund ? fundParameters : { client_id: { type: "string", required: false } }),
          page: { type: "integer", default: 1 },
          page_size: { type: "integer", default: 20, maximum: 100 },
        },
        queryTemplate:
          fund ? "SELECT <registered fields> FROM immutable_fund_snapshot WHERE <portfolio_id,trade_date,asset_class> ORDER BY portfolio_id,trade_date,asset_class LIMIT :limit OFFSET :offset" : source ? "SELECT <registered fields> FROM immutable_distribution_snapshot WHERE client_id = :client_id ORDER BY <client_id,trade_date,dimension> LIMIT :limit OFFSET :offset":"SELECT <fields> FROM customer_assets WHERE snapshot_id = :snapshot_id AND (:client_id IS NULL OR client_id = :client_id) ORDER BY client_id LIMIT :limit OFFSET :offset",
      });
    return this.store.update("data_service", service.id, this.project, {
      currentVersionId: version.id,
    });
  }

  createDapiVersion(serviceId, input) {
    const service = this.#service(serviceId, "DAPI"),
      releaseRun = this.releaseRunFor(
        text(input.sourceReleaseRunId, "源发布批次", 3, 80),
      );
    this.#assertReleaseRun(releaseRun);
    const fund = this.#fundSource(releaseRun), source = fund ?? this.#distribution(releaseRun), sync = this.#syncSource(releaseRun);
    const prior = this.#version(service.currentVersionId);
    if ((sync || isSync(prior)) && !sameSyncEvidence(sync?.sourceEvidence, prior.sourceEvidence)) throw syncChanged();
    const fields = source ? distributionFields(source.outputContractId, input.fields ?? prior.fields) : normalizeFields(input.fields ?? prior.fields);
    if(prior.outputContractId!==source?.outputContractId)throw fail(409,'服务版本不能隐式切换输出粒度','OUTPUT_GRAIN_CHANGED');
    const snapshot = this.businessStore.materialize(
        `release-run:${releaseRun.id}`,
        fund?.rows ?? releaseRun.rows,
        new Date(this.now()).toISOString(),
        source?.outputContractId,
      ),
      version = this.#createVersion(service, {
        sourceReleaseRunId: releaseRun.id,
        sourceReleaseId: releaseRun.releaseId,
        sourceEngine: releaseRun.engine,
        sourceEngineVersion: releaseRun.engineVersion,
        ...(releaseRun.packageDigest ? { sourcePackageDigest: releaseRun.packageDigest } : {}),
        scope: this.scope,
        snapshotId: snapshot.id,
        snapshotHash: snapshot.contentHash,
        ...(source ? { outputContractId: source.outputContractId, sourceEvidence: source.sourceEvidence } : {}),
        ...(sync ? { sourceEvidence: sync.sourceEvidence } : {}),
        fields,
        timeoutMs: integer(
          input.timeoutMs,
          "超时时间",
          prior.timeoutMs,
          100,
          5000,
        ),
        rateLimitPerMinute: integer(
          input.rateLimitPerMinute,
          "每分钟限流",
          prior.rateLimitPerMinute,
          1,
          600,
        ),
        parameterSchema: prior.parameterSchema,
        queryTemplate: prior.queryTemplate,
      });
    this.store.update("data_service", service.id, this.project, {
      currentVersionId: version.id,
      status: service.publishedVersionId ? "PUBLISHED" : "DRAFT",
    });
    return version;
  }

  createXapi(input) {
    const name = text(input.name, "XAPI名称", 2, 80),
      path = slug(input.slug),
      timeoutMs = integer(input.timeoutMs, "超时时间", 2500, 100, 5000),
      rateLimitPerMinute = integer(
        input.rateLimitPerMinute,
        "每分钟限流",
        30,
        1,
        600,
      );
    this.#uniqueSlug(path);
    const steps = this.#steps(input.steps),
      composition=this.#xapiComposition(steps.map(s=>this.#version(s.dapiVersionId)),steps),
      service = this.store.create("data_service", this.project, {
        serviceType: "XAPI",
        name,
        slug: path,
        status: "DRAFT",
      }),
      version = this.#createVersion(service, {
        steps,
        ...(composition??{}),
        scope: this.scope,
        joinKey: composition?.groupKeys?.[0] ?? "client_id",
        timeoutMs,
        rateLimitPerMinute,
        parameterSchema: {
          ...(composition?.outputContractId === fundDapiContract.id ? fundParameters : { client_id: { type: "string", required: false } }),
          page: { type: "integer", default: 1 },
          page_size: { type: "integer", default: 20, maximum: 100 },
        },
      });
    return this.store.update("data_service", service.id, this.project, {
      currentVersionId: version.id,
    });
  }

  createXapiVersion(serviceId, input) {
    const service = this.#service(serviceId, "XAPI"),
      prior = this.#version(service.currentVersionId),
      steps=input.steps===undefined?prior.steps:this.#steps(input.steps),
      composition=this.#xapiComposition(steps.map(s=>this.#version(s.dapiVersionId)),steps),
      version = (()=>{if((isSync(prior)||isSync(composition))&&!sameSyncEvidence(prior.sourceEvidence,composition?.sourceEvidence))throw syncChanged();if(prior.outputContractId!==composition?.outputContractId)throw fail(409,'组合版本不能隐式切换粒度','OUTPUT_GRAIN_CHANGED');return this.#createVersion(service, {
        steps,
        ...(composition??{}),
        scope: this.scope,
        joinKey: composition?.groupKeys?.[0] ?? "client_id",
        timeoutMs: integer(
          input.timeoutMs,
          "超时时间",
          prior.timeoutMs,
          100,
          5000,
        ),
        rateLimitPerMinute: integer(
          input.rateLimitPerMinute,
          "每分钟限流",
          prior.rateLimitPerMinute,
          1,
          600,
        ),
        parameterSchema: prior.parameterSchema,
      });})();
    this.store.update("data_service", service.id, this.project, {
      currentVersionId: version.id,
      status: service.publishedVersionId ? "PUBLISHED" : "DRAFT",
    });
    return version;
  }

  validateAgentPlan(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw fail(422, "Agent未返回可验证的数据服务方案", "INVALID_AGENT_PLAN");
    const serviceType = value.serviceType;
    if (!['DAPI', 'XAPI'].includes(serviceType))
      throw fail(422, "Agent服务类型必须是DAPI或XAPI", "INVALID_AGENT_PLAN");
    const common = {
      serviceType,
      name: text(value.name, "服务名称", 2, 80),
      slug: slug(value.slug),
      timeoutMs: integer(
        value.timeoutMs,
        "超时时间",
        serviceType === "DAPI" ? 1500 : 2500,
        100,
        5000,
      ),
      rateLimitPerMinute: integer(
        value.rateLimitPerMinute,
        "每分钟限流",
        serviceType === "DAPI" ? 60 : 30,
        1,
        600,
      ),
    };
    this.#uniqueSlug(common.slug);
    if (serviceType === "DAPI") {
      const sourceReleaseRunId = text(
          value.sourceReleaseRunId,
          "源发布批次",
          3,
          80,
        ),
        releaseRun = this.releaseRunFor(sourceReleaseRunId);
      this.#assertReleaseRun(releaseRun);
      if (this.#fundSource(releaseRun)) throw fail(422, "基金接口请通过 DAPI 工作台配置", "FUND_AGENT_PLAN_UNSUPPORTED");
      return {
        ...common,
        sourceReleaseRunId,
        fields: this.#distribution(releaseRun)?distributionFields(this.#distribution(releaseRun).outputContractId,value.fields):normalizeFields(value.fields),
      };
    }
    return { ...common, steps: this.#steps(value.steps) };
  }

  async test(serviceId, input = {}) {
    const service = this.#service(serviceId),
      version = this.#version(service.currentVersionId),
      started = this.now();
    try {
      const query = queryFor(version.outputContractId, input);
      const response = await this.#execute(version, query);
      const test = this.store.create("data_service_test", this.project, {
        serviceId: service.id,
        versionId: version.id,
        configHash: version.configHash,
        status: "PASSED",
        rowCount: response.data.length,
        resultHash: serviceHash(response.data),
        durationMs: this.now() - started,
        parameters: query,
      });
      return { test, response };
    } catch (error) {
      this.store.create("data_service_test", this.project, {
        serviceId: service.id,
        versionId: version.id,
        configHash: version.configHash,
        status: "FAILED",
        durationMs: this.now() - started,
        error: error.message,
      });
      throw error;
    }
  }

  publish(serviceId) {
    const service = this.#service(serviceId),
      version = this.#version(service.currentVersionId),
      test = this.store
        .list("data_service_test", this.project)
        .find(
          (item) =>
            item.serviceId === service.id &&
            item.versionId === version.id &&
            item.configHash === version.configHash &&
            item.status === "PASSED",
        );
    if (!test)
      throw fail(
        409,
        "当前版本尚无通过的真实查询测试，不能发布",
        "SERVICE_TEST_REQUIRED",
      );
    const dataVersions=version.serviceType==='DAPI'?[version]:version.steps.map(step=>this.#version(step.dapiVersionId));
    this.#syncVersion(version);
    for(const dataVersion of dataVersions){
      this.#assertFundVersion(dataVersion);
      const snapshot=this.businessStore.snapshotEvidence(dataVersion.snapshotId);
      if(!snapshot?.integrityVerified || snapshot.contentHash!==dataVersion.snapshotHash)
        throw fail(409,'已测试快照当前缺失或变化，不能发布','SOURCE_SNAPSHOT_UNAVAILABLE');
    }
    if(service.publishedVersionId===version.id && version.status==='PUBLISHED')
      return {service,version,test,replayed:true};
    const contractGate=this.contractGate?.evaluate({service,version,dataVersions,action:'PUBLISH'});
    if (service.publishedVersionId) {
      const prior = this.#version(service.publishedVersionId);
      if (prior.id !== version.id)
        this.store.update("data_service_version", prior.id, this.project, {
          status: "RETIRED",
          retiredAt: new Date(this.now()).toISOString(),
        });
    }
    const publishedVersion = this.store.update(
      "data_service_version",
      version.id,
      this.project,
      {
        status: "PUBLISHED",
        publishedAt: new Date(this.now()).toISOString(),
        testId: test.id,
        ...(contractGate?.id?{contractGateDecisionId:contractGate.id}:{}),
      },
    );
    const published = this.store.update("data_service", service.id, this.project, {
      status: "PUBLISHED",
      publishedVersionId: version.id,
      endpoint: `/api/v2/open/${service.serviceType.toLowerCase()}s/${service.slug}`,
      publishedAt: new Date(this.now()).toISOString(),
    });
    return { service: published, version: publishedVersion, test,...(contractGate?{contractGate}:{}) };
  }

  prepareActivation(serviceId,versionId){
    const service=this.#service(serviceId),version=this.#version(text(versionId,'版本编号',3,80));
    if(version.serviceId!==service.id||!['PUBLISHED','RETIRED'].includes(version.status))throw fail(409,'只能切换已发布历史版本','INVALID_VERSION');
    const dataVersions=version.serviceType==='DAPI'?[version]:version.steps.map(step=>this.#version(step.dapiVersionId));
    this.#syncVersion(version);
    for(const v of dataVersions){this.#assertFundVersion(v);const evidence=this.businessStore.snapshotEvidence(v.snapshotId);if(!evidence?.integrityVerified||evidence.contentHash!==v.snapshotHash)throw fail(409,'目标版本源快照缺失或变化，不能切换','SOURCE_SNAPSHOT_UNAVAILABLE');}
    return this.contractGate?.evaluate({service,version,dataVersions,action:'ACTIVATE'});
  }

  activate(serviceId, versionId, {preparedGate}={}) {
    const service = this.#service(serviceId),
      target = this.#version(text(versionId, "版本编号", 3, 80));
    if (target.serviceId !== service.id || !["PUBLISHED", "RETIRED"].includes(target.status))
      throw fail(409, "只能切换到该服务已经测试发布过的版本", "INVALID_VERSION");
    const gate=preparedGate??this.prepareActivation(serviceId,target.id);
    if(gate&&this.contractGate){const dataVersions=target.serviceType==='DAPI'?[target]:target.steps.map(step=>this.#version(step.dapiVersionId));this.contractGate.verifyPrepared({service,version:target,dataVersions,receipt:gate,action:'ACTIVATE'});}
    if (service.publishedVersionId && service.publishedVersionId !== target.id)
      this.store.update(
        "data_service_version",
        service.publishedVersionId,
        this.project,
        { status: "RETIRED", retiredAt: new Date(this.now()).toISOString() },
      );
    this.store.update("data_service_version", target.id, this.project, {
      status: "PUBLISHED",
      reactivatedAt: new Date(this.now()).toISOString(),
      ...(gate?.id?{contractGateActivationDecisionId:gate.id}:{}),
    });
    return this.store.update("data_service", service.id, this.project, {
      status: "PUBLISHED",
      currentVersionId: target.id,
      publishedVersionId: target.id,
      versionSwitchedAt: new Date(this.now()).toISOString(),
    });
  }

  createApplication(input, { expiresAt } = {}) {
    const name = text(input.name, "应用名称", 2, 80),
      serviceIds = input.serviceIds;
    if (
      !Array.isArray(serviceIds) ||
      !serviceIds.length ||
      serviceIds.length > 20 ||
      new Set(serviceIds).size !== serviceIds.length
    )
      throw fail(400, "应用必须授权1—20个不重复的数据服务", "INVALID_GRANTS");
    const grants = [];
    for (const id of serviceIds) {
      const service = this.#service(id);
      if (service.status !== "PUBLISHED")
        throw fail(409, "应用只能授权已发布的数据服务", "UNPUBLISHED_GRANT");
      const version = this.#version(service.publishedVersionId);
      const proof = this.#syncVersion(version);
      if (this.scope==="PRIVATE_CLOUD_TEST" && version.outputContractId===fundDapiContract.id) {
        const children=version.serviceType==="DAPI" ? [version] : version.steps.map(step=>this.#version(step.dapiVersionId));
        for(const child of children) this.#assertFundVersion(child);
        if (version.serviceType==="XAPI") this.#xapiComposition(children,version.steps);
        grants.push({id,versionId:version.id,evidence:children[0].sourceEvidence});
      } else if (proof) grants.push({ id, versionId: version.id, evidence: proof.sourceEvidence });
    }
    if (grants.length) {
      if (grants.length !== serviceIds.length || grants.some(grant => !sameSyncEvidence(grant.evidence, grants[0].evidence)))
        throw fail(409, "应用须授权同一确切发布批次的服务版本", "SYNC_SERVICE_MIXED_GRANTS");
      expiresAt ??= new Date(this.now() + 3600000).toISOString();
    }
    if (expiresAt !== undefined && (typeof expiresAt !== "string" ||
        !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= this.now() ||
        Date.parse(expiresAt) - this.now() > 2 * 3600000))
      throw fail(400, "临时应用有效期必须在未来两小时内", "APPLICATION_EXPIRY_INVALID");
    const token = (this.scope === "PRIVATE_CLOUD_TEST" ? "sz_private_" : "sz_local_") + randomBytes(24).toString("base64url"),
      app = this.store.create("service_app", this.project, {
        name,
        status: "ACTIVE",
        serviceIds,
        tokenHash: serviceHash(token),
        tokenPrefix: token.slice(0, 17),
        createdBy: "local-engineer",
        scope: this.scope,
        ...(grants.length ? { versionGrants: Object.fromEntries(grants.map(grant => [grant.id, grant.versionId])) } : {}),
        ...(expiresAt === undefined ? {} : { expiresAt }),
      });
    return { application: publicApp(app, this.now()), token, tokenShownOnce: true };
  }

  listApplications() {
    return this.store.list("service_app", this.project).map(app => publicApp(app, this.now()));
  }

  application(id) {
    const app = this.store.get(
      "service_app",
      text(id, "应用编号", 3, 80),
      this.project,
    );
    if (!app) throw fail(404, "未找到调用应用", "APPLICATION_NOT_FOUND");
    return publicApp(app, this.now());
  }

  revokeApplication(id) {
    const app = this.store.get("service_app", id, this.project);
    if (!app) throw fail(404, "未找到调用应用", "APPLICATION_NOT_FOUND");
    if (app.status === "REVOKED") return publicApp(app, this.now());
    return publicApp(
      this.store.update("service_app", app.id, this.project, {
        status: "REVOKED",
        revokedAt: new Date(this.now()).toISOString(),
        revokedBy: "local-engineer",
      }), this.now(),
    );
  }

  listCalls(serviceId) {
    return this.store
      .list("service_call", this.project)
      .filter((item) => !serviceId || item.serviceId === serviceId);
  }

  // Recheck an existing successful receipt without invoking an application,
  // consuming rate limits, recording another call or returning business rows.
  async recheckCall(serviceId, callId, { pinnedVersionId } = {}) {
    const service = this.#service(serviceId),
      call = this.store.get("service_call", callId, this.project);
    const unavailable = () => fail(409, "所选接口版本尚无可对照的非空成功调用", "CONSUMPTION_RECEIPT_UNAVAILABLE");
    if (!call || !call.parameters || typeof call.parameters!=="object" || call.serviceId !== service.id ||
        call.serviceVersionId !== (pinnedVersionId ?? service.publishedVersionId) || call.outcome !== "SUCCEEDED" ||
        call.statusCode !== 200 || !Number.isSafeInteger(call.rowCount) || call.rowCount < 1 || !/^[a-f0-9]{64}$/.test(call.resultHash ?? ""))
      throw unavailable();
    const version = this.#version(call.serviceVersionId);
    const historical = pinnedVersionId !== undefined || isSync(version);
    const children = historical ? this.#assertHistoricalCall(service, version, call) : [];
    const response = await this.#execute(version, queryFor(version.outputContractId, call.parameters), Math.min(version.timeoutMs, 1000));
    if (historical) {
      const savedCall = this.store.get("service_call", call.id, this.project), savedVersion = this.#version(version.id);
      if (!savedCall || serviceHash(savedCall) !== serviceHash(call) || savedVersion.configHash !== version.configHash)
        throw unavailable();
      const savedChildren = this.#assertHistoricalCall(service, savedVersion, savedCall);
      if (children.some((child, index) => savedChildren[index]?.configHash !== child.configHash)) throw unavailable();
    }
    const checkedSync = isSync(version) && this.application(call.applicationId).versionGrants?.[service.id] === version.id &&
      call.sourceEvidenceHash === serviceHash(version.sourceEvidence) && call.paginationHash === serviceHash(response.pagination);
    return { callId: call.id, versionId: version.id, configHash: version.configHash, rowCount: call.rowCount,
      resultHash: call.resultHash,
      ...(isSync(version) ? { independentResultVerified: checkedSync } : {}),
      verified: (!isSync(version) || checkedSync) && response.data.length === call.rowCount && serviceHash(response.data) === call.resultHash };
  }

  #assertHistoricalCall(service, version, call) {
    const invalid = () => fail(409, "原调用的发布版本或当时的应用授权未确认", "HISTORICAL_CONSUMPTION_UNCONFIRMED");
    const app = this.application(call.applicationId), startedAt = Date.parse(call.startedAt);
    const wasPublished = item => item.scope === this.scope && ["PUBLISHED", "RETIRED"].includes(item.status) &&
      Date.parse(item.publishedAt) <= startedAt;
    if (version.serviceId !== service.id || version.serviceType !== service.serviceType || call.serviceType !== version.serviceType ||
        call.versionNumber !== version.versionNumber || Array.isArray(call.parameters) ||
        !wasPublished(version) || !(startedAt <= Date.parse(call.finishedAt)) ||
        (version.status === "RETIRED" && !(startedAt <= Date.parse(version.retiredAt))) ||
        app.scope !== this.scope || !app.serviceIds?.includes(service.id) || !["ACTIVE", "EXPIRED", "REVOKED"].includes(app.status) ||
        !(Date.parse(app.createdAt) <= startedAt) || (app.expiresAt !== undefined && !(startedAt < Date.parse(app.expiresAt))) ||
        (app.status === "REVOKED" && !(startedAt <= Date.parse(app.revokedAt)))) throw invalid();
    if (version.serviceType !== "XAPI") return [];
    if (!Array.isArray(version.steps) || version.steps.length < 2 || version.steps.length > 5) throw invalid();
    return version.steps.map(step => {
      const child = this.#version(step.dapiVersionId);
      if (child.serviceId !== step.dapiId || child.serviceType !== "DAPI" || !wasPublished(child)) throw invalid();
      return child;
    });
  }

  async recheckFundCall(serviceId, callId) {
    const invalid = () => fail(409, "基金历史调用的授权、版本或独立结果未确认", "FUND_CALL_EVIDENCE_UNCONFIRMED");
    const service = this.#service(serviceId), call = this.store.get("service_call", callId, this.project);
    if (call?.serviceId !== service.id || call.outcome !== "SUCCEEDED" ||
        call.statusCode !== 200 || !call.parameters || typeof call.parameters !== "object" || Array.isArray(call.parameters) ||
        !Number.isSafeInteger(call.rowCount) || call.rowCount < 0 || !/^[a-f0-9]{64}$/.test(call.resultHash ?? "")) throw invalid();
    const version = this.#version(call.serviceVersionId), app = this.application(call.applicationId);
    const startedAt = Date.parse(call.startedAt);
    if (version.serviceId !== service.id || version.serviceType !== service.serviceType || call.serviceType !== version.serviceType ||
        version.outputContractId !== fundDapiContract.id || version.scope !== this.scope ||
        !["PUBLISHED", "RETIRED"].includes(version.status) || !serviceVersionConfigValid(version) ||
        !Number.isFinite(startedAt) || !(Date.parse(version.publishedAt) <= startedAt && startedAt <= Date.parse(call.finishedAt)) ||
        app.scope !== this.scope || !app.serviceIds.includes(service.id) ||
        this.scope==="PRIVATE_CLOUD_TEST" && app.versionGrants?.[service.id]!==version.id ||
        !(Date.parse(app.createdAt) <= startedAt) ||
        app.expiresAt !== undefined && !(startedAt < Date.parse(app.expiresAt)) ||
        app.status === "REVOKED" && !(startedAt <= Date.parse(app.revokedAt))) throw invalid();
    if (version.serviceType === "XAPI" && (!Array.isArray(version.steps) || version.steps.length < 2)) throw invalid();
    const children = version.serviceType === "DAPI" ? [version] : version.steps.map(step => this.#version(step.dapiVersionId));
    const certify = () => {
      for (const child of children) {
        const saved = this.#version(child.id);
        if (saved.configHash !== child.configHash || !serviceVersionConfigValid(saved)) throw invalid();
        this.#assertFundVersion(saved);
      }
    };
    certify();
    const contextId = this.releaseRunFor(children[0].sourceReleaseRunId)?.source?.contextId;
    const context = contextId && fundContext(contextId);
    if (!context || children.some(child => child.sourceReleaseRunId !== children[0].sourceReleaseRunId)) throw invalid();
    const query = queryFor(version.outputContractId, call.parameters);
    const expected = expectedFundCallRows(version, children, query, context);
    const response = await this.#execute({ ...version, timeoutMs: Math.min(version.timeoutMs, 1000) }, query);
    certify();
    const savedCall = this.store.get("service_call", call.id, this.project), savedVersion = this.#version(version.id);
    if (!savedCall || serviceHash(savedCall) !== serviceHash(call) ||
        savedVersion.configHash !== version.configHash || !serviceVersionConfigValid(savedVersion)) throw invalid();
    return { callId: call.id, versionId: version.id, configHash: version.configHash, rowCount: call.rowCount, resultHash: call.resultHash,
      verified: response.data.length === call.rowCount && serviceHash(response.data) === call.resultHash,
      independentResultVerified: expected.length === call.rowCount && serviceHash(expected) === call.resultHash,
      expectedRowCount: expected.length, paginationUnit: response.resultContract?.paginationUnit };
  }

  async recheckDistributionCall(serviceId,callId) {
    const service=this.#service(serviceId),call=this.store.get('service_call',callId,this.project);
    if(this.scope!=='LOCAL_TEST_ONLY'||!call||call.serviceId!==service.id||call.serviceVersionId!==service.publishedVersionId||call.outcome!=='SUCCEEDED'||call.statusCode!==200||!call.parameters||typeof call.parameters!=='object'||Array.isArray(call.parameters)||!Number.isSafeInteger(call.rowCount)||call.rowCount<0||!/^[a-f0-9]{64}$/.test(call.resultHash??''))throw fail(409,'分布历史调用未确认','DISTRIBUTION_CALL_UNAVAILABLE');
    const version=this.#version(call.serviceVersionId),children=version.serviceType==='DAPI'?[version]:(version.steps??[]).map(s=>this.#version(s.dapiVersionId));
    if(version.scope!=='LOCAL_TEST_ONLY'||!version.outputContractId||!children.length||children.some(v=>v.scope!=='LOCAL_TEST_ONLY'))throw fail(409,'分布固定版本未确认','DISTRIBUTION_CALL_UNAVAILABLE');
    const certify=()=>children.map(v=>{const current=this.#version(v.id);if(!serviceVersionConfigValid(current)||current.configHash!==v.configHash)throw fail(409,'固定子版本变化','DISTRIBUTION_CALL_UNAVAILABLE');const proof=this.#distribution(this.releaseRunFor(v.sourceReleaseRunId));if(!proof||serviceHash(proof.sourceEvidence)!==serviceHash(v.sourceEvidence))throw fail(409,'分布调用来源变化','DISTRIBUTION_CALL_UNAVAILABLE');return proof;});
    const proofs=certify(),run=this.releaseRunFor(children[0].sourceReleaseRunId),query=normalizeQuery(call.parameters),response=await this.#execute({...version,timeoutMs:Math.min(version.timeoutMs,1000)},query);
    const check=checkDistributionResponse({contextId:run.source.contextId,version,children,query,response});
    if(serviceHash(certify())!==serviceHash(proofs)||!serviceVersionConfigValid(this.#version(version.id))||serviceHash(this.store.get('service_call',call.id,this.project))!==serviceHash(call)||this.#service(serviceId).publishedVersionId!==version.id)throw fail(409,'核验期间发布来源变化','DISTRIBUTION_CALL_UNAVAILABLE');
    return {callId:call.id,versionId:version.id,configHash:version.configHash,rowCount:call.rowCount,resultHash:call.resultHash,verified:response.data.length===call.rowCount&&serviceHash(response.data)===call.resultHash,...check};
  }

  openApi(serviceId, origin = "http://127.0.0.1:3100") {
    const service = this.#service(serviceId),
      version = this.#version(service.publishedVersionId ?? service.currentVersionId),
      endpoint = `/api/v2/open/${service.serviceType.toLowerCase()}s/${service.slug}`;
    return {
      openapi: "3.1.0",
      info: {
        title: service.name,
        version: String(version.versionNumber),
        description: this.scope === "PRIVATE_CLOUD_TEST" ? "虚构证券发布结果的私有云快照查询，不是公网生产服务。" : "虚构证券数据服务；当前本机测试，不代表公网可用。",
      },
      servers: [{ url: origin }],
      paths: {
        [endpoint]: {
          get: {
            operationId: `query${service.serviceType}${service.id.replaceAll("-", "")}`,
            security: [{ bearerAuth: [] }],
            parameters: [
              ...Object.entries(version.outputContractId === fundDapiContract.id ? fundParameters : { client_id: { type: "string" } })
                .map(([name, schema]) => ({ name, in: "query", required: false, schema })),
              { name: "page", in: "query", required: false, schema: { type: "integer", minimum: 1, default: 1 } },
              { name: "page_size", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 100, default: 20 } },
            ],
            responses: {
              200: { description: "查询成功",...(version.outputContractId?{content:{"application/json":{schema:distributionResponseSchema(version,(version.steps??[]).map(s=>this.#version(s.dapiVersionId)))}}}:{}) },
              401: { description: "应用令牌无效" },
              403: { description: "应用未获服务授权" },
              429: { description: "超过版本限流" },
              504: { description: "查询超过版本超时" },
            },
          },
        },
      },
      components: {
        securitySchemes: {
          bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "opaque" },
        },
      },
      "x-shuduo-scope": this.scope,
      "x-shuduo-service-version-id": version.id,
    };
  }

  async invoke(type, path, authorization, input = {}, { assertAccess } = {}) {
    const service = this.store
      .list("data_service", this.project)
      .find((item) => item.slug === path && item.serviceType === type);
    if (!service || service.status !== "PUBLISHED" || !service.publishedVersionId)
      throw fail(404, "数据服务不存在或尚未发布", "SERVICE_NOT_FOUND");
    const app = this.#authorize(authorization, service.id),
      version = this.#version(service.publishedVersionId),
      query = queryFor(version.outputContractId, input),
      windowStart = this.now() - 60_000,
      used = this.listCalls(service.id).filter(
        (call) =>
          call.applicationId === app.id &&
          call.outcome !== "RATE_LIMITED" &&
          Date.parse(call.startedAt) >= windowStart,
      ).length;
    if ((isSync(version) || app.versionGrants) && app.versionGrants?.[service.id] !== version.id)
      throw fail(403, "应用只获原接口版本授权，请重新核对授权", "SERVICE_VERSION_FORBIDDEN");
    if (used >= version.rateLimitPerMinute) {
      this.#callLog(service, version, app, query, this.now(), {
        outcome: "RATE_LIMITED",
        statusCode: 429,
        rowCount: 0,
      });
      throw fail(429, "请求超过当前服务版本的每分钟限流", "RATE_LIMITED");
    }
    const started = this.now();
    try {
      assertAccess?.({service,application:app,version});
      const response = await this.#execute(version, query),
        call = this.#callLog(service, version, app, query, started, {
          outcome: "SUCCEEDED",
          statusCode: 200,
          rowCount: response.data.length,
          resultHash: serviceHash(response.data),
          ...(isSync(version) ? { sourceEvidenceHash: serviceHash(version.sourceEvidence), paginationHash: serviceHash(response.pagination) } : {}),
        });
      return {
        ...response,
        service: {
          id: service.id,
          type: service.serviceType,
          slug: service.slug,
          version: version.versionNumber,
          versionId: version.id,
          ...(version.serviceType === "XAPI" ? { steps: version.steps.map(({ alias, dapiId, dapiVersionId }) => ({ alias, dapiId, dapiVersionId })) } : {}),
        },
        callId: call.id,
        localTestOnly: this.scope === "LOCAL_TEST_ONLY",
        scope: this.scope,
        publicDeployed: false,
      };
    } catch (error) {
      if (!error.logged)
        this.#callLog(service, version, app, query, started, {
          outcome: error.status === 504 ? "TIMED_OUT" : "FAILED",
          statusCode: error.status ?? 500,
          rowCount: 0,
          error: error.message,
        });
      throw error;
    }
  }

  #service(id, type) {
    const service = this.store.get("data_service", id, this.project);
    if (!service || (type && service.serviceType !== type))
      throw fail(404, "未找到当前项目的数据服务", "SERVICE_NOT_FOUND");
    return service;
  }

  #version(id) {
    const version = this.store.get("data_service_version", id, this.project);
    if (!version)
      throw fail(404, "未找到数据服务版本", "VERSION_NOT_FOUND");
    if(!serviceVersionConfigValid(version))
      throw fail(409,'不可变版本配置与摘要不一致，不能执行或切换','SERVICE_VERSION_CORRUPT');
    return version;
  }

  #uniqueSlug(path) {
    if (
      this.store
        .list("data_service", this.project)
        .some((item) => item.slug === path)
    )
      throw fail(409, "服务路径已存在", "DUPLICATE_SLUG");
  }

  #distribution(run){const proof=this.distributionSourceFor?.(run);if(proof&&this.scope!=="LOCAL_TEST_ONLY")throw fail(422,"分布查询尚未开放私有云适配","DISTRIBUTION_SCOPE_DISABLED");return proof;}

  #syncSource(run) {
    if (!this.syncSourceFor) return;
    return this.syncSourceFor(run);
  }

  #syncDapi(version) {
    const proof = this.syncSourceFor && this.#syncSource(this.releaseRunFor(version.sourceReleaseRunId));
    if (!proof && !isSync(version)) return;
    if (!proof || !isSync(version) || !serviceVersionConfigValid(version) || version.outputContractId !== undefined ||
        !sameSyncEvidence(proof.sourceEvidence, version.sourceEvidence) ||
        version.snapshotId !== `release-run:${version.sourceReleaseRunId}` ||
        serviceHash(normalizedServiceSourceRows(proof.expected)) !== version.snapshotHash) throw syncChanged();
    return proof;
  }

  #syncVersion(version) {
    if (!this.syncSourceFor && !isSync(version)) return;
    if (version.serviceType === "DAPI") return this.#syncDapi(version);
    const children = version.steps.map(step => this.#version(step.dapiVersionId));
    const proof = this.#syncComposition(children);
    if (!proof && !isSync(version)) return;
    if (!proof || !isSync(version) || !serviceVersionConfigValid(version) ||
        !sameSyncEvidence(proof.sourceEvidence, version.sourceEvidence)) throw syncChanged();
    return { ...proof, children };
  }

  #syncComposition(children) {
    const sources = children.map(child => this.#syncDapi(child));
    const proof = sources.find(Boolean);
    if (proof && sources.some(source => !sameSyncEvidence(source?.sourceEvidence, proof.sourceEvidence)))
      throw fail(409, "冻结持仓 XAPI 的子接口须属于同一确切发布批次", "SYNC_SERVICE_MIXED_SOURCES");
    return proof;
  }

  #assertSyncResponse(version, query, result, proof) {
    const current = this.#syncVersion(version);
    if (!current || !sameSyncEvidence(current.sourceEvidence, proof.sourceEvidence)) throw syncChanged();
    const rows = normalizedServiceSourceRows(proof.expected).filter(row => !query.clientId || row.client_id === query.clientId);
    const project = (row, fields) => Object.fromEntries(fields.map(field => [field, row[field]]));
    const start = (query.page - 1) * query.pageSize;
    const expected = rows.slice(start, start + query.pageSize).map(row => version.serviceType === "DAPI"
      ? project(row, version.fields)
      : { client_id: row.client_id, ...Object.fromEntries(version.steps.map((step, i) =>
        [step.alias, project(row, proof.children[i].fields.filter(field => field !== "client_id"))])) });
    const page = { page: query.page, pageSize: query.pageSize, total: rows.length, totalPages: Math.max(1, Math.ceil(rows.length / query.pageSize)) };
    if (serviceHash(expected) !== serviceHash(result.rows) || serviceHash(page) !== serviceHash(result.pagination)) throw syncChanged();
  }

  #fundSource(run) {
    const source = this.fundSourceFor?.(run);
    if (!source) return undefined;
    if ((source.evidence.scope ?? "LOCAL_TEST_ONLY") !== this.scope || !source.evidence.eligibleForService || !source.rows)
      throw fail(422, "基金组合穿透需要真实本机双批结果才能生成接口快照", "FUND_SNAPSHOT_SOURCE_REQUIRED");
    return { outputContractId: fundDapiContract.id, sourceEvidence: source.evidence, rows: source.rows };
  }

  #assertFundVersion(version) {
    if (version.serviceType !== "DAPI" || version.outputContractId !== fundDapiContract.id) return;
    const current = this.#fundSource(this.releaseRunFor(version.sourceReleaseRunId));
    if (!current || serviceHash(current.sourceEvidence) !== serviceHash(version.sourceEvidence) ||
        version.snapshotId !== `release-run:${version.sourceReleaseRunId}` ||
        resultSnapshotHash(fundDapiContract.id, current.rows, serviceHash) !== version.snapshotHash)
      throw fail(409, "基金接口绑定的原发布来源已变化", "FUND_SNAPSHOT_SOURCE_CHANGED");
  }

  #assertReleaseRun(run) {
    if (this.scope === "PRIVATE_CLOUD_TEST") {
      if (typeof this.verifySource !== "function") throw fail(409,"缺少私有来源核验器","INVALID_RELEASE_PROVENANCE");
      this.verifySource(run);
    }
    const sparkEvidence =
        run?.engine === "Apache Spark" &&
        run.mainSqlExecuted === true &&
        run.testSqlValidation?.passed === true,
      pythonEvidence =
        run?.engine === "CPython" &&
        run.codeExecuted === true &&
        /^\d+\.\d+(?:\.\d+)?$/.test(run.engineVersion ?? "");
    if (
      !run ||
      run.status !== "SUCCEEDED" ||
      run.published !== true ||
      run.schedulerTriggered !== true ||
      run.publicDeployed !== false ||
      (!sparkEvidence && !pythonEvidence) ||
      !run.validation?.passed ||
      !Array.isArray(run.rows)
    )
      throw fail(
        409,
        "DAPI只能绑定已由调度器真实执行并验证通过的发布批次",
        "INVALID_RELEASE_RUN",
      );
  }

  #createVersion(service, config) {
    const versions = this.store
        .list("data_service_version", this.project)
        .filter((item) => item.serviceId === service.id),
      versionNumber = Math.max(0, ...versions.map((item) => item.versionNumber)) + 1,
      configHash = serviceHash({ serviceType: service.serviceType, ...config });
    return this.store.create("data_service_version", this.project, {
      serviceId: service.id,
      serviceType: service.serviceType,
      versionNumber,
      status: "DRAFT",
      ...config,
      configHash,
    });
  }

  #steps(value) {
    if (!Array.isArray(value) || value.length < 2 || value.length > 5)
      throw fail(400, "XAPI必须编排2—5个已发布DAPI", "INVALID_STEPS");
    const aliases = new Set(),
      serviceIds = new Set();
    const steps = value.map((step) => {
      const alias = text(step?.alias, "步骤别名", 2, 30),
        dapiId = text(step?.dapiId, "DAPI编号", 3, 80);
      if (!/^[a-z][a-z0-9_]*$/.test(alias) || aliases.has(alias))
        throw fail(400, "XAPI步骤别名不合法或重复", "INVALID_ALIAS");
      if (serviceIds.has(dapiId))
        throw fail(400, "XAPI不能重复编排同一个DAPI", "DUPLICATE_STEP");
      const dapi = this.#service(dapiId, "DAPI");
      if (dapi.status !== "PUBLISHED" || !dapi.publishedVersionId)
        throw fail(409, "XAPI只能绑定已发布DAPI版本", "UNPUBLISHED_STEP");
      if(step.dapiVersionId!==undefined && step.dapiVersionId!==dapi.publishedVersionId)
        throw fail(409,'指定DAPI版本已变化，请重新审阅；不会静默替换为最新版','STALE_SERVICE_VERSION');
      aliases.add(alias);
      serviceIds.add(dapiId);
      return {
        alias,
        dapiId,
        dapiVersionId: dapi.publishedVersionId,
      };
    });
    if (this.scope === "PRIVATE_CLOUD_TEST") {
      const versions=steps.map(s=>this.#version(s.dapiVersionId));
      if (versions.some(v=>v.scope!==this.scope || !v.sourcePackageDigest || v.sourceReleaseRunId!==versions[0].sourceReleaseRunId || v.snapshotHash!==versions[0].snapshotHash || v.sourcePackageDigest!==versions[0].sourcePackageDigest))
        throw fail(409,"私有XAPI必须组合同一已核验发布批次的DAPI版本","MIXED_SOURCE_VERSIONS");
    }
    return steps;
  }

  async #execute(version, query, timeoutMs = version.timeoutMs) {
    this.#assertFundVersion(version);
    const sync = this.#syncVersion(version);
    const task =
      version.serviceType === "DAPI"
        ? Promise.resolve().then(() => this.executeDapi(version, query))
        : this.#executeXapi(version, query);
    let timer;
    try {
      const result = await Promise.race([
        task,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(fail(504, "数据服务执行超时", "SERVICE_TIMEOUT")),
            timeoutMs,
          );
          timer.unref?.();
        }),
      ]);
      if (!result || !Array.isArray(result.rows) || !result.pagination)
        throw fail(500, "数据服务执行结果格式不合法", "INVALID_RESULT");
      if (sync) {
        this.#assertSyncResponse(version, query, result, sync);
        return { data: result.rows, pagination: result.pagination, sourceEvidence: sync.sourceEvidence };
      }
      const contract = snapshotContractById(version.outputContractId);
      if (!contract) return { data: result.rows, pagination: result.pagination };
      const fund = contract.id === fundDapiContract.id;
      const dapi = version.serviceType === "DAPI";
      const resultContract = { id: contract.id, keyFields: dapi ? contract.keyFields : version.groupKeys,
        grain: dapi ? contract.grain : fund ? "PORTFOLIO_TRADE_DATE_WITH_EXPOSURE_ARRAY" : "CLIENT_TRADE_DATE_WITH_DISTRIBUTION_ARRAY",
        paginationUnit: dapi ? (fund ? "FUND_EXPOSURE_ROWS" : "DISTRIBUTION_ROWS") : (fund ? "PORTFOLIO_DATE_GROUPS" : "CLIENT_DATE_GROUPS") };
      return { data: result.rows, pagination: result.pagination, resultContract, sourceEvidence: version.sourceEvidence };
    } finally {
      clearTimeout(timer);
    }
  }

  #xapiComposition(children, steps) {
    for (const child of children) this.#assertFundVersion(child);
    const sync = this.#syncComposition(children);
    if (sync) return { sourceEvidence: sync.sourceEvidence };
    return distributionComposition(children, steps);
  }

  async #executeXapi(version, query) {
    const children = version.steps.map(step => this.#version(step.dapiVersionId));
    const current = this.#xapiComposition(children, version.steps);
    const fund = version.outputContractId === fundDapiContract.id;
    if (current?.outputContractId !== version.outputContractId || current?.composition !== version.composition ||
        fund && (serviceHash(current.sourceEvidence) !== serviceHash(version.sourceEvidence) ||
          serviceHash(current.groupKeys) !== serviceHash(version.groupKeys) || serviceHash(current.joinKeys) !== serviceHash(version.joinKeys)))
      throw fail(409, "组合粒度与子接口版本不一致", "OUTPUT_GRAIN_CHANGED");
    if (version.outputContractId) {
      const results = [];
      const filters = fund ? normalizeFundFilters(query) : { clientId: query.clientId };
      for (const [index, step] of version.steps.entries()) {
        const child = children[index], rows = [];
        let total;
        for (let page = 1; page <= 10; page++) {
          const result = await this.executeDapi(child, { ...filters, page, pageSize: 100 });
          if (!result?.pagination || !Array.isArray(result.rows) || !Number.isSafeInteger(result.pagination.total) ||
              result.pagination.total < 0 || result.pagination.total > 1000 || total !== undefined && total !== result.pagination.total)
            throw fail(409, "组合子结果分页不一致", "INVALID_RESULT");
          total = result.pagination.total;
          rows.push(...result.rows);
          if (page * 100 >= total) break;
        }
        if (rows.length !== total) throw fail(409, "组合子结果不完整", "INVALID_RESULT");
        results.push({ alias: step.alias, rows });
      }
      return combineDistributionResults(results, version.outputContractId, query);
    }
    const results = await Promise.all(
        version.steps.map(async (step) => {
          const child = this.#version(step.dapiVersionId),
            result = await this.executeDapi(child, query);
          return { alias: step.alias, result };
        }),
      ),
      records = new Map();
    for (const { alias, result } of results) {
      for (const row of result.rows) {
        const key = row[version.joinKey];
        if (!records.has(key)) records.set(key, { [version.joinKey]: key });
        records.get(key)[alias] = Object.fromEntries(
          Object.entries(row).filter(([field]) => field !== version.joinKey),
        );
      }
    }
    const rows = [...records.values()].sort((a, b) =>
      String(a[version.joinKey]).localeCompare(String(b[version.joinKey])),
    );
    return {
      rows,
      pagination: results[0]?.result.pagination ?? {
        page: query.page,
        pageSize: query.pageSize,
        total: 0,
        totalPages: 1,
      },
    };
  }

  #authorize(authorization, serviceId) {
    if (typeof authorization !== "string" || !authorization.startsWith("Bearer "))
      throw fail(401, "需要应用Bearer令牌", "TOKEN_REQUIRED");
    const token = authorization.slice(7);
    const prefix=this.scope === "PRIVATE_CLOUD_TEST" ? "sz_private_" : "sz_local_";
    if (!new RegExp(`^${prefix}[A-Za-z0-9_-]{32}$`).test(token))
      throw fail(401, "应用令牌无效", "TOKEN_INVALID");
    const tokenHash = serviceHash(token),
      app = this.store
        .list("service_app", this.project)
        .find((item) => item.tokenHash === tokenHash && item.status === "ACTIVE" && item.scope === this.scope);
    if (!app) throw fail(401, "应用令牌无效", "TOKEN_INVALID");
    if (Object.hasOwn(app, "expiresAt") &&
        (!Number.isFinite(Date.parse(app.expiresAt)) || this.now() >= Date.parse(app.expiresAt)))
      throw fail(401, "应用令牌已到期", "TOKEN_EXPIRED");
    if (!app.serviceIds.includes(serviceId))
      throw fail(403, "应用未获当前数据服务授权", "SERVICE_FORBIDDEN");
    return app;
  }

  #callLog(service, version, app, query, started, detail) {
    return this.store.create("service_call", this.project, {
      serviceId: service.id,
      serviceType: service.serviceType,
      serviceVersionId: version.id,
      versionNumber: version.versionNumber,
      applicationId: app.id,
      startedAt: new Date(started).toISOString(),
      finishedAt: new Date(this.now()).toISOString(),
      durationMs: Math.max(0, this.now() - started),
      parameters: query,
      ...detail,
    });
  }
}

export const dataServiceFields = Object.freeze([...assetFields]);

// Validate stored, already executed output. Never rerun Spark or substitute fixtures.
export function verifiedPrivateServiceSource({run,release,bundle,approval,delivery,verification,review,releaseRuns}) {
  if (!run || !release || !bundle || !approval || run.publicDeployed!==false || release.publicDeployed!==false || release.scope!=="PRIVATE_CLOUD_TEST" || approval.packageId!==bundle.id) throw fail(409,"缺少发布来源证据","INVALID_RELEASE_PROVENANCE");
  const plan=validateDeliveryPackage(bundle,bundle.digest);
  const attribution=plan.source.attribution,records=[run,release,approval,bundle];
  const manual=attribution!==undefined||records.some(record=>record.sourceKind==='MANUAL'||record.sourceAttribution==='ENGINEER_ASSISTED');
  if(records.some(record=>record.sourceKind!==undefined&&!['AGENT','MANUAL'].includes(record.sourceKind)))
    throw fail(409,"发布来源类型不合法","INVALID_RELEASE_PROVENANCE");
  const standalone=attribution?.kind==='ENGINEER_AUTHORED';
  if(standalone){
    const id=release.manualDeliveryTaskId,actor=attribution.actorId,origin={kind:'MANUAL_RUN',runId:plan.source.runId,revisionId:plan.source.revisionId,revisionHash:plan.source.sqlHash,manualDeliveryTaskId:id},family={id:plan.source.validationContractId,contextIds:plan.fixtures.validationContexts.map(c=>c.id)},matches=r=>r&&r.source&&typeof r.source==='object'&&r.sourceKind==='MANUAL'&&r.sourceAttribution==='ENGINEER_AUTHORED'&&r.agentIndependentE2E===false&&r.sourceRunId===plan.source.runId&&r.submittedBy===actor&&r.manualDeliveryTaskId===id&&r.sourceAgentTaskId===undefined&&serviceHash(r.source)===serviceHash(origin),validBatch=r=>matches(r)&&r.releaseId===release.id&&r.mode===release.mode&&r.status==='SUCCEEDED'&&r.publicDeployed===false&&r.published===true&&r.schedulerTriggered===true&&r.clockMode==='FC_TIMER'&&r.packageId===bundle.id&&r.packageDigest===bundle.digest&&r.engine==='Apache Spark'&&r.engineVersion==='3.5.9'&&r.mainSqlExecuted===true&&r.testDouble!==true&&r.testSqlValidation?.passed===true&&r.testSqlValidation.sqlHash===sha256(bundle.files['tests.sql'])&&validationMatchesFamily(r.validation,family)&&Array.isArray(r.rows)&&serviceHash(normalizedServiceSourceRows(r.rows))===serviceHash(normalizedServiceSourceRows(plan.fixtures.context.expected));
    if(!delivery||!verification||!review||typeof id!=='string'||bundle.manualDeliveryTaskId!==id||bundle.agentDeliveryTaskId!==undefined||bundle.sourceKind!=='MANUAL'||bundle.agentIndependentE2E!==false||bundle.sourceRunId!==plan.source.runId||attribution.agentIndependentE2E!==false||attribution.originAgentTaskId!==undefined||
      ![release,approval,review].every(matches)||delivery?.id!==id||delivery.mode!=='DURABLE_MANUAL_DELIVERY_V1'||delivery.status!=='SUCCEEDED'||delivery.actualExecution!==true||delivery.sourceKind!=='MANUAL'||delivery.sourceAttribution!=='ENGINEER_AUTHORED'||delivery.agentIndependentE2E!==false||delivery.submittedBy!==actor||delivery.sourceAgentTaskId!==undefined||delivery.sourceRunId!==plan.source.runId||delivery.sourceRevisionId!==plan.source.revisionId||delivery.sourceSqlHash!==plan.source.sqlHash||delivery.packageId!==bundle.id||delivery.packageDigest!==bundle.digest||delivery.verificationId!==release.verificationId||
      verification?.id!==release.verificationId||verification.manualDeliveryTaskId!==id||verification.agentDeliveryTaskId!==undefined||verification.packageId!==bundle.id||verification.packageDigest!==bundle.digest||verification.status!=='SUCCEEDED'||verification.actualExecution!==true||verification.isolation!=='FUNCTION_PROCESS'||verification.engine!=='Apache Spark'||verification.engineVersion!=='3.5.9'||verification.mainSqlExecuted!==true||verification.testSqlValidation?.passed!==true||verification.testSqlValidation.sqlHash!==sha256(bundle.files['tests.sql'])||!validationMatchesFamily(verification.validation,family)||
      review.id!==release.reviewId||review.id!==approval.reviewId||review.status!=='REVIEWED'||review.packageId!==bundle.id||review.packageDigest!==bundle.digest||review.verificationId!==verification.id||!['code','assertions','deliveryFiles','cloudScope'].every(k=>review.attestations?.[k]===true)||approval.rehearsalId!==verification.id||[release,approval].some(r=>r.sourceRevisionId!==plan.source.revisionId||r.sourceCodeHash!==plan.source.sqlHash)||
      !Array.isArray(releaseRuns)||releaseRuns.length!==2||new Set(releaseRuns.map(r=>r.id)).size!==2||new Set(releaseRuns.map(r=>r.sequence)).size!==2||!releaseRuns.every(r=>[1,2].includes(r.sequence)&&validBatch(r))||!validBatch(run))throw fail(409,'独立手工发布、审阅、演练及两个批次来源不一致','INVALID_RELEASE_PROVENANCE');
  }
  if(manual && !standalone && (attribution?.kind!=='ENGINEER_ASSISTED'||attribution.agentIndependentE2E!==false||
      bundle.sourceKind!=='MANUAL'||bundle.agentIndependentE2E!==false||bundle.sourceRunId!==plan.source.runId||
      [run,release,approval].some(record=>record.sourceKind!=='MANUAL'||record.sourceAttribution!=='ENGINEER_ASSISTED'||
        record.agentIndependentE2E!==false||record.sourceRunId!==plan.source.runId||record.submittedBy!==attribution.actorId)||
      release.sourceAgentTaskId!==attribution.originAgentTaskId||run.sourceAgentTaskId!==attribution.originAgentTaskId||
      [release,approval].some(record=>record.sourceRevisionId!==plan.source.revisionId||record.sourceCodeHash!==plan.source.sqlHash)||
      (run.sourceRevisionId!==undefined&&run.sourceRevisionId!==plan.source.revisionId)||
      (run.sourceCodeHash!==undefined&&run.sourceCodeHash!==plan.source.sqlHash)))
    throw fail(409,"人工发布来源、工程师与不可变交付包不一致","INVALID_RELEASE_PROVENANCE");
  if (run.mode!=="DURABLE_PRIVATE_RELEASE_V1" || release.mode!==run.mode || run.releaseId!==release.id || release.status!=="COMPLETED_CLOUD_TEST" || release.health!=="HEALTHY" || run.status!=="SUCCEEDED" || !run.published || !run.schedulerTriggered || run.clockMode!=="FC_TIMER" || run.packageId!==bundle.id || release.packageId!==bundle.id || run.packageDigest!==bundle.digest || release.packageDigest!==bundle.digest || release.sourceCodeHash!==plan.source.sqlHash || approval.id!==release.approvalId || approval.status!=="APPROVED" || approval.packageDigest!==bundle.digest || run.engine!=="Apache Spark" || run.engineVersion!==plan.deployment.runtime.version || run.mainSqlExecuted!==true || run.testSqlValidation?.passed!==true || run.testSqlValidation.sqlHash!==sha256(bundle.files["tests.sql"]) || !validationMatchesFamily(run.validation,{id:plan.source.validationContractId,contextIds:plan.fixtures.validationContexts.map(context=>context.id)}) || !Array.isArray(run.rows) || run.testDouble===true)
    throw fail(409,"发布版本、实际执行与独立断言证据不一致","INVALID_RELEASE_PROVENANCE");
  return run;
}
