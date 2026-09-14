import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const fail = (status, message, code) =>
  Object.assign(new Error(message), { status, code });
const hash = (value) => createHash("sha256").update(String(value)).digest("hex");
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
const decimalCents = (value) => {
  const input = String(value ?? "");
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(input))
    throw fail(422, "报表度量包含非两位小数", "INVALID_REPORT_DECIMAL");
  const negative = input.startsWith("-"),
    [whole, fraction = ""] = input.replace("-", "").split("."),
    cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  return negative ? -cents : cents;
};
const formatCents = (value) => {
  const negative = value < 0n,
    absolute = negative ? -value : value;
  return `${negative ? "-" : ""}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
};

export class ReportDataStore {
  constructor(path = ":memory:") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS report_snapshots(id TEXT PRIMARY KEY,asset_id TEXT NOT NULL,content_hash TEXT NOT NULL,row_count INTEGER NOT NULL,rows_json TEXT NOT NULL,created_at TEXT NOT NULL);",
    );
  }

  materialize(assetId, rows, createdAt) {
    const normalized = structuredClone(rows),
      contentHash = stableHash(normalized),
      id = randomUUID();
    this.db
      .prepare("INSERT INTO report_snapshots VALUES(?,?,?,?,?,?)")
      .run(
        id,
        assetId,
        contentHash,
        normalized.length,
        canonical(normalized),
        createdAt,
      );
    return { id, assetId, contentHash, rowCount: normalized.length, createdAt };
  }

  read(id) {
    const row = this.db
      .prepare("SELECT * FROM report_snapshots WHERE id=?")
      .get(id);
    if (!row) throw fail(404, "未找到报表数据快照", "REPORT_SNAPSHOT_NOT_FOUND");
    return {
      id: row.id,
      assetId: row.asset_id,
      contentHash: row.content_hash,
      rowCount: row.row_count,
      rows: JSON.parse(row.rows_json),
      createdAt: row.created_at,
    };
  }

  close() {
    this.db.close();
  }
}

export class ReportManager {
  constructor({ store, reportStore, assets, project, now = () => Date.now() }) {
    this.store = store;
    this.reportStore = reportStore;
    this.assets = assets;
    this.project = project;
    this.now = now;
  }

  listDatasets() {
    return this.store
      .list("report_dataset", this.project)
      .map((dataset) => this.datasetDetail(dataset.id));
  }

  datasetDetail(id) {
    const dataset = this.#dataset(id),
      snapshots = this.store
        .list("report_snapshot", this.project)
        .filter((snapshot) => snapshot.datasetId === dataset.id);
    return {
      ...dataset,
      currentSnapshot: snapshots.find(
        (snapshot) => snapshot.id === dataset.currentSnapshotId,
      ),
      snapshots,
    };
  }

  createDataset(input) {
    const { asset } = this.assets.reportRows(text(input.assetId, "资产编号", 4, 160)),
      fields = normalizeFields(input.fields, asset.fields.map((field) => field.name)),
      code = identifier(input.code, "数据集代码");
    if (
      this.store
        .list("report_dataset", this.project)
        .some((dataset) => dataset.code === code)
    )
      throw fail(409, "报表数据集代码已存在", "DUPLICATE_REPORT_DATASET");
    return this.store.create("report_dataset", this.project, {
      name: text(input.name, "数据集名称", 2, 80),
      code,
      assetId: asset.id,
      fields,
      status: "DRAFT",
      actualSnapshot: false,
    });
  }

  refreshDataset(id) {
    const dataset = this.#dataset(id),
      { asset, rows } = this.assets.reportRows(dataset.assetId),
      projected = rows.map((row) =>
        Object.fromEntries(dataset.fields.map((field) => [field, row[field]])),
      ),
      materialized = this.reportStore.materialize(
        asset.id,
        projected,
        new Date(this.now()).toISOString(),
      ),
      snapshot = this.store.create("report_snapshot", this.project, {
        datasetId: dataset.id,
        dataSnapshotId: materialized.id,
        assetId: asset.id,
        assetVersionId: asset.versionId,
        assetEvidenceHash: asset.evidenceHash,
        contentHash: materialized.contentHash,
        rowCount: materialized.rowCount,
        fields: dataset.fields,
        status: "READY",
        actualMaterialization: true,
      });
    this.store.update("report_dataset", dataset.id, this.project, {
      currentSnapshotId: snapshot.id,
      status: "READY",
      actualSnapshot: true,
    });
    return this.datasetDetail(dataset.id);
  }

  listReports() {
    return this.store
      .list("report", this.project)
      .map((report) => this.reportDetail(report.id));
  }

  reportDetail(id) {
    const report = this.#report(id),
      versions = this.store
        .list("report_version", this.project)
        .filter((version) => version.reportId === report.id)
        .sort((a, b) => b.versionNumber - a.versionNumber),
      runs = this.store
        .list("report_run", this.project)
        .filter((run) => run.reportId === report.id)
        .map(publicReportRun);
    return {
      ...report,
      currentVersion: versions.find(
        (version) => version.id === report.currentVersionId,
      ),
      versions,
      runs,
    };
  }

  createReport(input) {
    const normalized = this.#normalizeReport(input),
      code = identifier(input.code, "报表代码");
    if (
      this.store.list("report", this.project).some((report) => report.code === code)
    )
      throw fail(409, "报表代码已存在", "DUPLICATE_REPORT");
    const report = this.store.create("report", this.project, {
        name: text(input.name, "报表名称", 2, 80),
        code,
        datasetId: normalized.datasetId,
        status: "DRAFT",
      }),
      version = this.store.create("report_version", this.project, {
        reportId: report.id,
        versionNumber: 1,
        ...normalized,
        status: "DRAFT",
      });
    this.store.update("report", report.id, this.project, {
      currentVersionId: version.id,
    });
    return this.reportDetail(report.id);
  }

  createReportVersion(reportId, input) {
    const report = this.#report(reportId),
      current = this.#version(report.currentVersionId),
      normalized = this.#normalizeReport({
        datasetId: report.datasetId,
        widgets: input.widgets ?? current.widgets,
        description: input.description ?? current.description,
      });
    this.store.update("report_version", current.id, this.project, {
      status: "RETIRED",
      retiredAt: new Date(this.now()).toISOString(),
    });
    const version = this.store.create("report_version", this.project, {
      reportId: report.id,
      versionNumber:
        this.store
          .list("report_version", this.project)
          .filter((item) => item.reportId === report.id).length + 1,
      ...normalized,
      status: "DRAFT",
    });
    this.store.update("report", report.id, this.project, {
      currentVersionId: version.id,
      status: "DRAFT",
    });
    return this.reportDetail(report.id);
  }

  validateAgentPlan(value) {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      value.kind !== "REPORT"
    )
      throw fail(422, "Agent未返回可验证的报表方案", "INVALID_REPORT_PLAN");
    return {
      kind: "REPORT",
      name: text(value.name, "报表名称", 2, 80),
      code: identifier(value.code, "报表代码"),
      ...this.#normalizeReport(value),
    };
  }

  runReport(id) {
    const report = this.#report(id),
      version = this.#version(report.currentVersionId),
      snapshotMeta = this.store.get(
        "report_snapshot",
        version.datasetSnapshotId,
        this.project,
      );
    if (!snapshotMeta)
      throw fail(409, "报表绑定的数据集快照不存在", "REPORT_SNAPSHOT_MISSING");
    const snapshot = this.reportStore.read(snapshotMeta.dataSnapshotId),
      started = this.now(),
      widgets = version.widgets.map((widget) =>
        executeWidget(widget, snapshot.rows),
      ),
      run = this.store.create("report_run", this.project, {
        reportId: report.id,
        reportVersionId: version.id,
        reportConfigHash: version.configHash,
        datasetId: version.datasetId,
        datasetSnapshotId: snapshotMeta.id,
        datasetContentHash: snapshot.contentHash,
        status: "SUCCEEDED",
        widgets,
        resultHash: stableHash(widgets),
        durationMs: this.now() - started,
        actualExecution: true,
        publicDeployed: false,
        fullLifecycleE2E: false,
      });
    this.store.update("report_version", version.id, this.project, {
      status: "VERIFIED",
      lastRunId: run.id,
    });
    this.store.update("report", report.id, this.project, {
      status: "VERIFIED_LOCAL",
      lastRunId: run.id,
    });
    return { report: this.reportDetail(report.id), run };
  }

  exportReport(id) {
    const report = this.reportDetail(id),
      run = report.runs.find((item) => item.id === report.lastRunId);
    if (!run || run.status !== "SUCCEEDED")
      throw fail(409, "报表尚无成功运行，不能导出", "REPORT_RUN_REQUIRED");
    const rows = [["widget_id", "title", "group", "value"]];
    for (const widget of run.widgets) {
      if (widget.value !== undefined)
        rows.push([widget.id, widget.title, "ALL", widget.value]);
      else
        for (const item of widget.series)
          rows.push([widget.id, widget.title, item.group, item.value]);
    }
    const content = rows.map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
    return {
      fileName: `${report.code}-${run.id.slice(0, 8)}.csv`,
      contentType: "text/csv; charset=utf-8",
      content,
      contentHash: hash(content),
      reportId: report.id,
      reportVersionId: run.reportVersionId,
      runId: run.id,
      publicDeployed: false,
    };
  }

  agentContext() {
    return {
      datasets: this.listDatasets()
        .filter((dataset) => dataset.status === "READY")
        .map((dataset) => ({
          id: dataset.id,
          name: dataset.name,
          code: dataset.code,
          assetId: dataset.assetId,
          fields: dataset.fields,
          rowCount: dataset.currentSnapshot.rowCount,
          snapshotId: dataset.currentSnapshot.id,
          contentHash: dataset.currentSnapshot.contentHash,
        })),
      reports: this.listReports().map((report) => ({
        id: report.id,
        name: report.name,
        code: report.code,
        datasetId: report.datasetId,
        status: report.status,
        widgets: report.currentVersion.widgets.map(({ id, type, title }) => ({
          id,
          type,
          title,
        })),
      })),
    };
  }

  overview() {
    const datasets = this.listDatasets(),
      reports = this.listReports(),
      runs = this.store.list("report_run", this.project);
    return {
      scope: "LOCAL_AGGREGATED_REPORTING",
      publicDeployed: false,
      datasets,
      reports,
      counts: {
        datasets: datasets.length,
        readyDatasets: datasets.filter((item) => item.status === "READY").length,
        reports: reports.length,
        verifiedReports: reports.filter((item) => item.status === "VERIFIED_LOCAL").length,
        runs: runs.length,
      },
    };
  }

  #normalizeReport(input) {
    const dataset = this.#dataset(text(input.datasetId, "数据集编号", 3, 80)),
      detail = this.datasetDetail(dataset.id);
    if (!detail.currentSnapshot || detail.status !== "READY")
      throw fail(409, "请先刷新数据集快照", "REPORT_DATASET_NOT_READY");
    if (!Array.isArray(input.widgets) || !input.widgets.length || input.widgets.length > 8)
      throw fail(400, "报表必须包含1—8个组件", "INVALID_REPORT_WIDGETS");
    const widgets = input.widgets.map((widget) =>
      normalizeWidget(widget, dataset.fields),
    );
    if (new Set(widgets.map((widget) => widget.id)).size !== widgets.length)
      throw fail(400, "报表组件ID不能重复", "DUPLICATE_WIDGET_ID");
    const config = {
      datasetId: dataset.id,
      datasetSnapshotId: detail.currentSnapshot.id,
      widgets,
      description: text(input.description, "报表说明", 4, 500),
    };
    return { ...config, configHash: stableHash(config) };
  }

  #dataset(id) {
    const item = this.store.get("report_dataset", text(id, "数据集编号", 3, 80), this.project);
    if (!item) throw fail(404, "未找到报表数据集", "REPORT_DATASET_NOT_FOUND");
    return item;
  }

  #report(id) {
    const item = this.store.get("report", text(id, "报表编号", 3, 80), this.project);
    if (!item) throw fail(404, "未找到报表", "REPORT_NOT_FOUND");
    return item;
  }

  #version(id) {
    const item = this.store.get("report_version", text(id, "报表版本", 3, 80), this.project);
    if (!item) throw fail(404, "未找到报表版本", "REPORT_VERSION_NOT_FOUND");
    return item;
  }
}

function normalizeFields(value, available) {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 40 ||
    new Set(value).size !== value.length ||
    value.some((field) => !available.includes(field))
  )
    throw fail(400, "数据集字段必须来自资产且不能重复", "INVALID_DATASET_FIELDS");
  return [...value];
}

function normalizeWidget(input, fields) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw fail(400, "报表组件必须是对象", "INVALID_REPORT_WIDGET");
  const type = text(input.type, "组件类型", 3, 20),
    id = identifier(input.id, "组件ID"),
    title = text(input.title, "组件标题", 2, 80),
    aggregation = text(input.aggregation, "聚合方式", 3, 30);
  if (!["KPI", "BAR", "PIE"].includes(type))
    throw fail(400, "报表组件类型不支持", "INVALID_REPORT_WIDGET_TYPE");
  if (!["SUM", "COUNT_DISTINCT", "COUNT_ROWS"].includes(aggregation))
    throw fail(400, "报表聚合方式不支持", "INVALID_REPORT_AGGREGATION");
  const field = aggregation === "COUNT_ROWS" ? undefined : input.field;
  if (field && !fields.includes(field))
    throw fail(400, `报表引用未知字段${field}`, "REPORT_FIELD_NOT_FOUND");
  const dimension = type === "KPI" ? undefined : input.dimension;
  if (type !== "KPI" && !fields.includes(dimension))
    throw fail(400, "分布组件必须选择已登记维度", "REPORT_DIMENSION_NOT_FOUND");
  return { id, type, title, aggregation, field, dimension };
}

function executeWidget(widget, rows) {
  if (widget.type === "KPI")
    return {
      ...widget,
      value: aggregate(widget, rows),
      evaluatedCount: rows.length,
    };
  const groups = new Map();
  for (const row of rows) {
    const key = displayDimension(
      widget.dimension,
      String(row[widget.dimension] ?? "NULL"),
    );
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return {
    ...widget,
    series: [...groups.entries()]
      .map(([group, items]) => ({ group, value: aggregate(widget, items) }))
      .sort((a, b) => a.group.localeCompare(b.group, "zh-CN")),
    evaluatedCount: rows.length,
  };
}

function displayDimension(field, value) {
  if (field === "position_id") return "******";
  if (field === "client_id") {
    if (value.length <= 4) return "****";
    return `${value.slice(0, 3)}***${value.slice(-3)}`;
  }
  return value;
}

function publicReportRun(run) {
  const widgets = run.widgets.map((widget) => ({
      ...widget,
      ...(widget.series
        ? {
            series: widget.series.map((item) => ({
              ...item,
              group: displayDimension(widget.dimension, String(item.group)),
            })),
          }
        : {}),
    })),
    displayResultHash = stableHash(widgets);
  return { ...run, widgets, displayResultHash };
}

function aggregate(widget, rows) {
  if (widget.aggregation === "COUNT_ROWS") return String(rows.length);
  if (widget.aggregation === "COUNT_DISTINCT")
    return String(new Set(rows.map((row) => String(row[widget.field]))).size);
  return formatCents(
    rows.reduce((sum, row) => sum + decimalCents(row[widget.field]), 0n),
  );
}

function csvCell(value) {
  const input = String(value ?? "");
  return /[",\n]/.test(input) ? `"${input.replaceAll('"', '""')}"` : input;
}
