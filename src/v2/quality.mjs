import { createHash } from "node:crypto";

const fail = (status, message, code) =>
  Object.assign(new Error(message), { status, code });
const hash = (value) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");
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
const stableHash = (value) => hash(canonical(value));
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
const integer = (value, name, min, max) => {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max)
    throw fail(400, `${name}必须为${min}—${max}的整数`, "INVALID_INTEGER");
  return result;
};
const decimalCents = (value, name) => {
  const input = String(value);
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(input))
    throw fail(400, `${name}必须是不超过两位小数的数值`, "INVALID_DECIMAL");
  const negative = input.startsWith("-"),
    [whole, fraction = ""] = input.replace("-", "").split("."),
    cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  return negative ? -cents : cents;
};

export class QualityManager {
  constructor({ store, assets, project, now = () => Date.now() }) {
    this.store = store;
    this.assets = assets;
    this.project = project;
    this.now = now;
  }

  listRules() {
    return this.store
      .list("quality_rule", this.project)
      .map((rule) => this.detail(rule.id));
  }

  detail(id) {
    const rule = this.#rule(id),
      versions = this.store
        .list("quality_rule_version", this.project)
        .filter((version) => version.ruleId === rule.id)
        .sort((a, b) => b.versionNumber - a.versionNumber),
      runs = this.store
        .list("quality_run", this.project)
        .filter((run) => run.ruleId === rule.id),
      alerts = this.store
        .list("quality_alert", this.project)
        .filter((alert) => alert.ruleId === rule.id);
    return {
      ...rule,
      currentVersion: versions.find(
        (version) => version.id === rule.currentVersionId,
      ),
      versions,
      runs,
      alerts,
    };
  }

  createRule(input) {
    const normalized = this.#normalize(input),
      code = identifier(input.code, "规则代码");
    if (
      this.store
        .list("quality_rule", this.project)
        .some((rule) => rule.code === code)
    )
      throw fail(409, "质量规则代码已存在", "DUPLICATE_QUALITY_RULE");
    const rule = this.store.create("quality_rule", this.project, {
        name: text(input.name, "规则名称", 2, 80),
        code,
        assetId: normalized.assetId,
        status: "ACTIVE",
      }),
      version = this.store.create("quality_rule_version", this.project, {
        ruleId: rule.id,
        versionNumber: 1,
        ...normalized,
        status: "ACTIVE",
      });
    this.store.update("quality_rule", rule.id, this.project, {
      currentVersionId: version.id,
    });
    return this.detail(rule.id);
  }

  createVersion(ruleId, input) {
    const rule = this.#rule(ruleId),
      current = this.#version(rule.currentVersionId),
      normalized = this.#normalize({
        assetId: rule.assetId,
        field: input.field ?? current.field,
        type: input.type ?? current.type,
        config: input.config ?? current.config,
        description: input.description ?? current.description,
      });
    if (normalized.assetId !== rule.assetId)
      throw fail(409, "规则版本不能切换资产", "QUALITY_ASSET_IMMUTABLE");
    this.store.update("quality_rule_version", current.id, this.project, {
      status: "RETIRED",
      retiredAt: new Date(this.now()).toISOString(),
    });
    const version = this.store.create("quality_rule_version", this.project, {
      ruleId: rule.id,
      versionNumber:
        this.store
          .list("quality_rule_version", this.project)
          .filter((item) => item.ruleId === rule.id).length + 1,
      ...normalized,
      status: "ACTIVE",
    });
    this.store.update("quality_rule", rule.id, this.project, {
      currentVersionId: version.id,
      status: "ACTIVE",
    });
    return this.detail(rule.id);
  }

  validateAgentPlan(value) {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      value.kind !== "QUALITY_RULE"
    )
      throw fail(422, "Agent未返回可验证的质量规则", "INVALID_QUALITY_PLAN");
    return {
      kind: "QUALITY_RULE",
      name: text(value.name, "规则名称", 2, 80),
      code: identifier(value.code, "规则代码"),
      ...this.#normalize(value),
    };
  }

  runRule(ruleId) {
    const rule = this.#rule(ruleId),
      version = this.#version(rule.currentVersionId),
      { asset, rows } = this.assets.executionRows(rule.assetId),
      started = this.now(),
      invalidIndexes = this.#evaluate(version, rows),
      passed = rows.length - invalidIndexes.length,
      run = this.store.create("quality_run", this.project, {
        ruleId: rule.id,
        ruleVersionId: version.id,
        ruleConfigHash: version.configHash,
        assetId: asset.id,
        assetEvidenceHash: asset.evidenceHash,
        status: invalidIndexes.length ? "FAILED" : "PASSED",
        evaluatedCount: rows.length,
        passedCount: passed,
        failedCount: invalidIndexes.length,
        passRate: rows.length ? Number((passed / rows.length).toFixed(4)) : 1,
        invalidRowHashes: invalidIndexes
          .slice(0, 10)
          .map((index) => hash(canonical(rows[index]))),
        durationMs: this.now() - started,
        actualExecution: true,
        fullLifecycleE2E: false,
      });
    if (run.status === "FAILED") {
      this.store.create("quality_alert", this.project, {
        ruleId: rule.id,
        ruleVersionId: version.id,
        runId: run.id,
        assetId: asset.id,
        status: "OPEN",
        severity: invalidIndexes.length === rows.length ? "CRITICAL" : "ERROR",
        code: "QUALITY_RULE_FAILED",
        message: `${rule.name}有${invalidIndexes.length}行未通过`,
        openedAt: new Date(this.now()).toISOString(),
      });
      this.store.update("quality_rule", rule.id, this.project, {
        health: "FAILED",
        lastRunId: run.id,
      });
    } else {
      const resolvedAlertIds = [];
      for (const alert of this.store.list("quality_alert", this.project))
        if (alert.ruleId === rule.id && alert.status === "OPEN") {
          resolvedAlertIds.push(alert.id);
          this.store.update("quality_alert", alert.id, this.project, {
            status: "RESOLVED",
            recoveryRunId: run.id,
            resolvedAt: new Date(this.now()).toISOString(),
          });
        }
      this.store.update("quality_rule", rule.id, this.project, {
        health: "HEALTHY",
        lastRunId: run.id,
        resolvedAlertIds,
      });
    }
    return { rule: this.detail(rule.id), run };
  }

  overview() {
    const rules = this.listRules(),
      runs = this.store.list("quality_run", this.project),
      alerts = this.store.list("quality_alert", this.project);
    return {
      scope: "LOCAL_ACTUAL_ROWS",
      publicDeployed: false,
      rules,
      counts: {
        rules: rules.length,
        healthy: rules.filter((rule) => rule.health === "HEALTHY").length,
        failed: rules.filter((rule) => rule.health === "FAILED").length,
        runs: runs.length,
        openAlerts: alerts.filter((alert) => alert.status === "OPEN").length,
        resolvedAlerts: alerts.filter((alert) => alert.status === "RESOLVED").length,
      },
    };
  }

  agentContext() {
    return {
      assets: this.assets
        .listAssets()
        .filter((asset) => asset.executableMetrics)
        .map((asset) => ({
          id: asset.id,
          name: asset.name,
          businessName: asset.businessName,
          kind: asset.kind,
          rowCount: asset.rowCount,
          fields: asset.fields.map(({ name, type, nullable }) => ({
            name,
            type,
            nullable,
          })),
        })),
      rules: this.listRules().map((rule) => ({
        id: rule.id,
        code: rule.code,
        assetId: rule.assetId,
        health: rule.health,
        currentVersion: {
          type: rule.currentVersion.type,
          field: rule.currentVersion.field,
          config: rule.currentVersion.config,
        },
        latestRun: rule.runs[0]
          ? {
              status: rule.runs[0].status,
              evaluatedCount: rule.runs[0].evaluatedCount,
              failedCount: rule.runs[0].failedCount,
            }
          : undefined,
      })),
    };
  }

  #normalize(input) {
    const { asset } = this.assets.executionRows(text(input.assetId, "资产编号", 4, 160)),
      field = identifier(input.field, "字段名"),
      fieldMeta = asset.fields.find((item) => item.name === field);
    if (!fieldMeta)
      throw fail(400, `资产中不存在字段${field}`, "QUALITY_FIELD_NOT_FOUND");
    const type = text(input.type, "规则类型", 4, 40),
      config = this.#config(type, input.config ?? {});
    return {
      assetId: asset.id,
      field,
      type,
      config,
      description: text(input.description, "规则说明", 4, 500),
      configHash: stableHash({ assetId: asset.id, field, type, config }),
    };
  }

  #config(type, config) {
    if (!config || typeof config !== "object" || Array.isArray(config))
      throw fail(400, "质量规则配置必须是对象", "INVALID_QUALITY_CONFIG");
    if (["NOT_NULL", "UNIQUE"].includes(type)) return {};
    if (type === "VALUE_RANGE") {
      const min = String(config.min),
        max = String(config.max),
        minValue = decimalCents(min, "最小值"),
        maxValue = decimalCents(max, "最大值");
      if (minValue > maxValue)
        throw fail(400, "最小值不能大于最大值", "INVALID_QUALITY_RANGE");
      return { min, max };
    }
    if (type === "ALLOWED_VALUES") {
      if (
        !Array.isArray(config.values) ||
        !config.values.length ||
        config.values.length > 30 ||
        config.values.some((value) => typeof value !== "string" || value.length > 80)
      )
        throw fail(400, "允许值必须为1—30个短文本", "INVALID_ALLOWED_VALUES");
      return { values: [...new Set(config.values)] };
    }
    if (type === "FRESHNESS_SECONDS")
      return {
        maxAgeSeconds: integer(
          config.maxAgeSeconds,
          "最大延迟秒数",
          1,
          2_678_400,
        ),
      };
    throw fail(400, "质量规则类型不支持", "INVALID_QUALITY_TYPE");
  }

  #evaluate(version, rows) {
    if (version.type === "NOT_NULL")
      return rows
        .map((row, index) => (row[version.field] === null || row[version.field] === "" ? index : -1))
        .filter((index) => index >= 0);
    if (version.type === "UNIQUE") {
      const seen = new Set(),
        invalid = [];
      rows.forEach((row, index) => {
        const value = canonical(row[version.field]);
        if (seen.has(value)) invalid.push(index);
        else seen.add(value);
      });
      return invalid;
    }
    if (version.type === "VALUE_RANGE") {
      const min = decimalCents(version.config.min, "最小值"),
        max = decimalCents(version.config.max, "最大值");
      return rows
        .map((row, index) => {
          try {
            const value = decimalCents(row[version.field], "字段值");
            return value < min || value > max ? index : -1;
          } catch {
            return index;
          }
        })
        .filter((index) => index >= 0);
    }
    if (version.type === "ALLOWED_VALUES") {
      const allowed = new Set(version.config.values);
      return rows
        .map((row, index) => (allowed.has(String(row[version.field])) ? -1 : index))
        .filter((index) => index >= 0);
    }
    const cutoff = this.now() - version.config.maxAgeSeconds * 1000;
    return rows
      .map((row, index) => {
        const value = Date.parse(String(row[version.field]));
        return Number.isNaN(value) || value < cutoff ? index : -1;
      })
      .filter((index) => index >= 0);
  }

  #rule(id) {
    const item = this.store.get("quality_rule", text(id, "规则编号", 3, 80), this.project);
    if (!item) throw fail(404, "未找到质量规则", "QUALITY_RULE_NOT_FOUND");
    return item;
  }

  #version(id) {
    const item = this.store.get("quality_rule_version", text(id, "规则版本", 3, 80), this.project);
    if (!item) throw fail(404, "未找到质量规则版本", "QUALITY_VERSION_NOT_FOUND");
    return item;
  }
}
