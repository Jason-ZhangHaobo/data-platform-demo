import { createHash } from "node:crypto";

const fail = (status, message, code) =>
  Object.assign(new Error(message), { status, code });
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
const stableHash = (value) =>
  createHash("sha256").update(canonical(value)).digest("hex");
const text = (value, name, min = 1, max = 120) => {
  if (
    typeof value !== "string" ||
    value.trim().length < min ||
    value.length > max
  )
    throw fail(400, `${name}长度必须为${min}—${max}个字符`, "INVALID_TEXT");
  return value.trim();
};
const identifier = (value, name) => {
  const result = text(value, name, 2, 63);
  if (!/^[a-z][a-z0-9_]*$/.test(result))
    throw fail(400, `${name}只能使用小写字母、数字和下划线`, "INVALID_IDENTIFIER");
  return result;
};
const normalizedType = (value) =>
  text(value, "字段类型", 2, 60).replaceAll(" ", "").toUpperCase();
const compatibility = (value) => {
  const result = text(value ?? "BACKWARD", "兼容策略", 4, 20).toUpperCase();
  if (!new Set(["BACKWARD", "FULL", "NONE"]).has(result))
    throw fail(400, "兼容策略必须是BACKWARD、FULL或NONE", "INVALID_CONTRACT_COMPATIBILITY");
  return result;
};
const rate = (value) => {
  const result = value === undefined ? 0.99 : Number(value);
  if (!Number.isFinite(result) || result < 0.5 || result > 1)
    throw fail(400, "质量通过率必须在0.5—1之间", "INVALID_CONTRACT_SLO");
  return Number(result.toFixed(4));
};
const positiveInteger = (value, fallback, name) => {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(result) || result < 1 || result > 2_678_400)
    throw fail(400, `${name}必须是1—2678400秒`, "INVALID_CONTRACT_SLO");
  return result;
};

const normalizeFields = (fields) => {
  if (!Array.isArray(fields) || !fields.length || fields.length > 200)
    throw fail(400, "契约字段必须包含1—200项", "INVALID_CONTRACT_FIELDS");
  const normalized = fields.map((field) => {
    if (!field || typeof field !== "object" || Array.isArray(field))
      throw fail(400, "契约字段格式不合法", "INVALID_CONTRACT_FIELDS");
    if (field.nullable !== undefined && typeof field.nullable !== "boolean")
      throw fail(400, "字段nullable必须是布尔值", "INVALID_CONTRACT_FIELDS");
    return {
      name: identifier(field.name, "字段名"),
      type: normalizedType(field.type),
      nullable: field.nullable !== false,
      description:
        field.description === undefined
          ? undefined
          : text(field.description, "字段说明", 2, 200),
    };
  });
  if (new Set(normalized.map((field) => field.name)).size !== normalized.length)
    throw fail(400, "契约字段名不能重复", "DUPLICATE_CONTRACT_FIELD");
  return normalized;
};

const changesBetween = (before, after, policy) => {
  const previous = new Map(before.map((field) => [field.name, field])),
    next = new Map(after.map((field) => [field.name, field])),
    added = after
      .filter((field) => !previous.has(field.name))
      .map((field) => field.name),
    removed = before
      .filter((field) => !next.has(field.name))
      .map((field) => field.name),
    typeChanged = after
      .filter(
        (field) =>
          previous.has(field.name) &&
          previous.get(field.name).type !== field.type,
      )
      .map((field) => ({
        field: field.name,
        from: previous.get(field.name).type,
        to: field.type,
      })),
    nullabilityChanged = after
      .filter(
        (field) =>
          previous.has(field.name) &&
          previous.get(field.name).nullable !== field.nullable,
      )
      .map((field) => ({
        field: field.name,
        from: previous.get(field.name).nullable,
        to: field.nullable,
      }));
  let breakingReasons = [];
  if (policy === "BACKWARD") {
    breakingReasons = [
      ...after
        .filter((field) => !previous.has(field.name) && field.nullable === false)
        .map((field) => `ADDED_REQUIRED:${field.name}`),
      ...removed.map((field) => `REMOVED:${field}`),
      ...typeChanged.map((item) => `TYPE_CHANGED:${item.field}`),
      ...nullabilityChanged
        .filter((item) => item.from === false && item.to === true)
        .map((item) => `BECAME_NULLABLE:${item.field}`),
    ];
  } else if (policy === "FULL") {
    breakingReasons = [
      ...added.map((field) => `ADDED:${field}`),
      ...removed.map((field) => `REMOVED:${field}`),
      ...typeChanged.map((item) => `TYPE_CHANGED:${item.field}`),
      ...nullabilityChanged.map((item) => `NULLABILITY_CHANGED:${item.field}`),
    ];
  }
  return {
    added,
    removed,
    typeChanged,
    nullabilityChanged,
    breaking: breakingReasons.length > 0,
    breakingReasons,
  };
};

export class DataContractManager {
  constructor({ store, assets, project, now = () => Date.now() }) {
    this.store = store;
    this.assets = assets;
    this.project = project;
    this.now = now;
  }

  list() {
    return this.store
      .list("data_contract", this.project)
      .map((contract) => this.detail(contract.id));
  }

  detail(id) {
    const contract = this.#contract(id),
      versions = this.store
        .list("data_contract_version", this.project)
        .filter((version) => version.contractId === contract.id)
        .sort((a, b) => b.versionNumber - a.versionNumber),
      assessments = this.store
        .list("data_contract_assessment", this.project)
        .filter((item) => item.contractId === contract.id),
      checks = this.store
        .list("data_contract_check", this.project)
        .filter((item) => item.contractId === contract.id),
      alerts = this.store
        .list("data_contract_alert", this.project)
        .filter((item) => item.contractId === contract.id);
    return {
      ...contract,
      currentVersion: versions.find(
        (version) => version.id === contract.currentVersionId,
      ),
      versions,
      assessments,
      checks,
      alerts,
      impact: this.#impact(contract.assetId),
    };
  }

  create(input) {
    const asset = this.assets.detail(text(input.assetId, "资产编号", 4, 160)),
      code = identifier(input.code, "契约代码");
    if (
      this.store
        .list("data_contract", this.project)
        .some((contract) => contract.code === code)
    )
      throw fail(409, "数据契约代码已存在", "DUPLICATE_CONTRACT_CODE");
    const policy = compatibility(input.compatibility),
      fields = normalizeFields(asset.fields),
      contract = this.store.create("data_contract", this.project, {
        name: text(input.name, "契约名称", 2, 80),
        code,
        assetId: asset.id,
        owner: text(input.owner, "责任人", 2, 50),
        description: text(input.description, "契约说明", 4, 500),
        compatibility: policy,
        qualitySlo: {
          minPassRate: rate(input.qualitySlo?.minPassRate),
          maxFreshnessSeconds: positiveInteger(
            input.qualitySlo?.maxFreshnessSeconds,
            86_400,
            "最大新鲜度",
          ),
        },
        status: "ACTIVE",
      }),
      version = this.store.create("data_contract_version", this.project, {
        contractId: contract.id,
        versionNumber: 1,
        fields,
        schemaHash: stableHash(fields),
        assetEvidenceHash: asset.evidenceHash,
        source: "ASSET_SNAPSHOT",
        status: "ACTIVE",
        change: {
          added: fields.map((field) => field.name),
          removed: [],
          typeChanged: [],
          nullabilityChanged: [],
          breaking: false,
          breakingReasons: [],
        },
      });
    this.store.update("data_contract", contract.id, this.project, {
      currentVersionId: version.id,
    });
    return this.detail(contract.id);
  }

  assess(id, input = {}) {
    const contract = this.#contract(id),
      current = this.#version(contract.currentVersionId),
      asset = this.assets.detail(contract.assetId),
      fields = normalizeFields(input.fields ?? asset.fields),
      change = changesBetween(
        current.fields,
        fields,
        contract.compatibility,
      ),
      impact = this.#impact(contract.assetId),
      assessment = this.store.create(
        "data_contract_assessment",
        this.project,
        {
          contractId: contract.id,
          baseVersionId: current.id,
          proposedFields: fields,
          proposedSchemaHash: stableHash(fields),
          assetEvidenceHash: asset.evidenceHash,
          compatibility: contract.compatibility,
          change,
          downstream: impact.downstream,
          status: change.breaking ? "BREAKING" : "COMPATIBLE",
          appliedVersionId: undefined,
        },
      );
    return assessment;
  }

  createVersion(id, input) {
    const contract = this.#contract(id),
      current = this.#version(contract.currentVersionId),
      assessment = this.store.get(
        "data_contract_assessment",
        text(input.assessmentId, "评估编号", 4, 100),
        this.project,
      );
    if (!assessment || assessment.contractId !== contract.id)
      throw fail(404, "未找到该契约的变更评估", "CONTRACT_ASSESSMENT_NOT_FOUND");
    if (assessment.appliedVersionId)
      return this.detail(contract.id);
    if (assessment.baseVersionId !== current.id)
      throw fail(409, "契约已产生新版本，请重新评估", "CONTRACT_ASSESSMENT_STALE");
    if (assessment.change.breaking && input.acknowledgeBreaking !== true)
      throw fail(409, "该变更不兼容，必须审阅下游影响后明确确认", "CONTRACT_BREAKING_CHANGE");
    this.store.update("data_contract_version", current.id, this.project, {
      status: "RETIRED",
      retiredAt: new Date(this.now()).toISOString(),
    });
    const version = this.store.create("data_contract_version", this.project, {
      contractId: contract.id,
      versionNumber: current.versionNumber + 1,
      fields: assessment.proposedFields,
      schemaHash: assessment.proposedSchemaHash,
      assetEvidenceHash: assessment.assetEvidenceHash,
      source: "REVIEWED_ASSESSMENT",
      status: "ACTIVE",
      change: assessment.change,
      breakingAcknowledged: assessment.change.breaking,
      assessmentId: assessment.id,
    });
    this.store.update("data_contract", contract.id, this.project, {
      currentVersionId: version.id,
    });
    this.store.update(
      "data_contract_assessment",
      assessment.id,
      this.project,
      {
        status: "APPLIED",
        appliedVersionId: version.id,
        appliedAt: new Date(this.now()).toISOString(),
      },
    );
    return this.detail(contract.id);
  }

  check(id) {
    const contract = this.#contract(id),
      version = this.#version(contract.currentVersionId),
      asset = this.assets.detail(contract.assetId),
      expected = new Map(version.fields.map((field) => [field.name, field])),
      actual = new Map(
        asset.fields.map((field) => [field.name, {
          ...field,
          type: normalizedType(field.type),
          nullable: field.nullable !== false,
        }]),
      ),
      missing = version.fields
        .filter((field) => !actual.has(field.name))
        .map((field) => field.name),
      typeMismatch = version.fields
        .filter(
          (field) =>
            actual.has(field.name) && actual.get(field.name).type !== field.type,
        )
        .map((field) => ({
          field: field.name,
          expected: field.type,
          actual: actual.get(field.name).type,
        })),
      unexpected =
        contract.compatibility === "FULL"
          ? asset.fields
              .filter((field) => !expected.has(field.name))
              .map((field) => field.name)
          : [];
    let actualRows = false,
      evaluatedRows = 0,
      nullViolations = [],
      rowFailureCount = 0,
      rowPassRate,
      freshnessMeasured = false,
      freshnessSeconds,
      freshnessPassed;
    try {
      const rows = this.assets.executionRows(asset.id).rows;
      actualRows = true;
      evaluatedRows = rows.length;
      const required = version.fields.filter((field) => field.nullable === false),
        invalidRows = rows.filter((row) =>
          required.some(
            (field) =>
              row[field.name] === null || row[field.name] === undefined,
          ),
        );
      nullViolations = required
        .filter((field) =>
          invalidRows.some(
            (row) =>
              row[field.name] === null || row[field.name] === undefined,
          ),
        )
        .map((field) => field.name);
      rowFailureCount = invalidRows.length;
      rowPassRate = rows.length
        ? Number(((rows.length - invalidRows.length) / rows.length).toFixed(4))
        : 1;
      const timestamps = rows
        .map((row) => row.syncedAt ?? row.updatedAt ?? row.event_time)
        .map((value) => Date.parse(value))
        .filter(Number.isFinite);
      if (timestamps.length) {
        freshnessMeasured = true;
        freshnessSeconds = Math.max(
          0,
          Math.floor((this.now() - Math.max(...timestamps)) / 1000),
        );
        freshnessPassed =
          freshnessSeconds <= contract.qualitySlo.maxFreshnessSeconds;
      }
    } catch (error) {
      if (error.code !== "ASSET_ROWS_UNAVAILABLE") throw error;
    }
    const structuralFailed = Boolean(
        missing.length || typeMismatch.length || unexpected.length
      ),
      rowSloPassed = actualRows
        ? rowPassRate >= contract.qualitySlo.minPassRate
        : undefined,
      failed = Boolean(
        structuralFailed || rowSloPassed === false || freshnessPassed === false
      ),
      partial = !failed && (!actualRows || !freshnessMeasured),
      check = this.store.create("data_contract_check", this.project, {
        contractId: contract.id,
        contractVersionId: version.id,
        contractSchemaHash: version.schemaHash,
        assetId: asset.id,
        assetEvidenceHash: asset.evidenceHash,
        status: failed ? "FAILED" : partial ? "PARTIAL" : "PASSED",
        missing,
        typeMismatch,
        unexpected,
        nullViolations,
        evaluatedRows,
        rowFailureCount,
        rowPassRate,
        minPassRate: contract.qualitySlo.minPassRate,
        rowSloPassed,
        freshnessMeasured,
        freshnessSeconds,
        maxFreshnessSeconds: contract.qualitySlo.maxFreshnessSeconds,
        freshnessPassed,
        actualMetadata: true,
        actualRows,
      });
    if (failed)
      this.store.create("data_contract_alert", this.project, {
        contractId: contract.id,
        contractVersionId: version.id,
        checkId: check.id,
        status: "OPEN",
        code: "DATA_CONTRACT_VIOLATION",
        affectedFields: [
          ...missing,
          ...typeMismatch.map((item) => item.field),
          ...unexpected,
          ...nullViolations,
        ],
      });
    else if (check.status === "PASSED")
      for (const alert of this.store
        .list("data_contract_alert", this.project)
        .filter(
          (item) =>
            item.contractId === contract.id && item.status === "OPEN",
        ))
        this.store.update("data_contract_alert", alert.id, this.project, {
          status: "RESOLVED",
          recoveryCheckId: check.id,
          resolvedAt: new Date(this.now()).toISOString(),
        });
    return { contract: this.detail(contract.id), check };
  }

  agentContext() {
    return this.list().map((contract) => ({
      id: contract.id,
      code: contract.code,
      name: contract.name,
      assetId: contract.assetId,
      compatibility: contract.compatibility,
      schemaHash: contract.currentVersion.schemaHash,
      fields: contract.currentVersion.fields.map(({ name, type, nullable }) => ({
        name,
        type,
        nullable,
      })),
      latestCheck: contract.checks[0]
        ? {
            status: contract.checks[0].status,
            missing: contract.checks[0].missing,
            typeMismatch: contract.checks[0].typeMismatch,
          }
        : undefined,
      downstreamCount: contract.impact.downstream.length,
    }));
  }

  #impact(assetId) {
    const impact = this.assets.impact(assetId);
    return {
      downstream: impact.downstream.map((asset) => ({
        id: asset.id,
        name: asset.businessName,
        kind: asset.kind,
        status: asset.status,
      })),
      edgeCount: impact.edges.length,
      derivation: "VERSION_BINDINGS",
    };
  }

  #contract(id) {
    const item = this.store.get(
      "data_contract",
      text(id, "契约编号", 4, 100),
      this.project,
    );
    if (!item) throw fail(404, "未找到数据契约", "DATA_CONTRACT_NOT_FOUND");
    return item;
  }

  #version(id) {
    const item = this.store.get(
      "data_contract_version",
      text(id, "契约版本", 4, 100),
      this.project,
    );
    if (!item)
      throw fail(404, "未找到数据契约版本", "DATA_CONTRACT_VERSION_NOT_FOUND");
    return item;
  }
}

export const contractSchemaHash = stableHash;
export const assessContractCompatibility = changesBetween;
