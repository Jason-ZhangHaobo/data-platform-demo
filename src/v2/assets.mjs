import { createHash } from "node:crypto";
import { getContext } from "./context.mjs";

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
const tags = (value) => {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length > 12 ||
    value.some((item) => typeof item !== "string" || !item.trim() || item.length > 24)
  )
    throw fail(400, "标签必须是不超过12个的短文本", "INVALID_TAGS");
  return [...new Set(value.map((item) => item.trim()))];
};
const assetId = (value) => text(value, "资产编号", 4, 160);
const fieldFrom = (asset, name, required = true) => {
  if (!name && !required) return undefined;
  const normalized = identifier(name, "字段名"),
    field = asset.fields.find((item) => item.name === normalized);
  if (!field)
    throw fail(400, `资产中不存在字段${normalized}`, "ASSET_FIELD_NOT_FOUND");
  return field;
};
const publicAnnotation = (item) =>
  item
    ? {
        id: item.id,
        revision: item.revision,
        businessName: item.businessName,
        description: item.description,
        domain: item.domain,
        owner: item.owner,
        classification: item.classification,
        tags: item.tags,
        createdAt: item.createdAt,
      }
    : undefined;
const decimalCents = (value) => {
  const input = String(value ?? "");
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(input))
    throw fail(422, "指标字段包含非两位小数", "INVALID_METRIC_DECIMAL");
  const negative = input.startsWith("-"),
    [whole, fraction = ""] = input.replace("-", "").split("."),
    cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  return negative ? -cents : cents;
};
const formatCents = (value) => {
  const negative = value < 0n,
    absolute = negative ? -value : value,
    whole = absolute / 100n,
    fraction = String(absolute % 100n).padStart(2, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
};

export class AssetCatalogManager {
  constructor({ store, landingStore, stateStore, dataServices, project, now = () => Date.now() }) {
    this.store = store;
    this.landingStore = landingStore;
    this.stateStore = stateStore;
    this.dataServices = dataServices;
    this.project = project;
    this.now = now;
  }

  listAssets(query = {}) {
    const all = this.#inventory(),
      normalized = String(query.q ?? "").trim().toLowerCase(),
      kind = String(query.kind ?? "").trim();
    return all.filter((asset) => {
      if (kind && asset.kind !== kind) return false;
      if (!normalized) return true;
      const searchable = [
        asset.name,
        asset.businessName,
        asset.system,
        asset.domain,
        asset.description,
        ...asset.tags,
        ...asset.fields.flatMap((field) => [field.name, field.type]),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return searchable.includes(normalized);
    });
  }

  detail(id) {
    const item = this.#inventory().find((asset) => asset.id === assetId(id));
    if (!item) throw fail(404, "未找到当前项目的数据资产", "ASSET_NOT_FOUND");
    return {
      ...item,
      lineage: this.lineage(item.id),
      metrics: this.listMetrics().filter((metric) => metric.assetId === item.id),
      standards: this.listStandards().filter(
        (standard) => standard.assetId === item.id,
      ),
    };
  }

  annotate(id, input) {
    const item = this.#asset(id),
      prior = this.#latestAnnotation(item.id),
      annotation = this.store.create("asset_annotation", this.project, {
        assetId: item.id,
        revision: Number(prior?.revision ?? 0) + 1,
        businessName: text(
          input.businessName ?? prior?.businessName ?? item.businessName,
          "业务名称",
          2,
          80,
        ),
        description: text(
          input.description ?? prior?.description ?? item.description,
          "资产说明",
          4,
          500,
        ),
        domain: text(input.domain ?? prior?.domain ?? "财富管理", "业务域", 2, 40),
        owner: text(input.owner ?? prior?.owner ?? "数据产品负责人", "负责人", 2, 40),
        classification: ["PUBLIC_DEMO", "INTERNAL_DEMO", "RESTRICTED_DEMO"].includes(
          input.classification ?? prior?.classification,
        )
          ? input.classification ?? prior.classification
          : "INTERNAL_DEMO",
        tags: tags(input.tags ?? prior?.tags),
        evidenceHash: item.evidenceHash,
      });
    return { ...item, annotation: publicAnnotation(annotation) };
  }

  lineage(id) {
    const focus = this.#asset(id),
      inventory = this.#inventory(),
      nodes = new Map(inventory.map((item) => [item.id, item])),
      allEdges = this.#lineageEdges(inventory),
      selected = new Set([focus.id]),
      selectedEdges = new Set(),
      upstream = [focus.id],
      downstream = [focus.id];
    for (let depth = 0; depth < 4; depth++) {
      const nextUpstream = [],
        nextDownstream = [];
      for (const current of upstream)
        for (const edge of allEdges.filter((item) => item.to === current)) {
          selectedEdges.add(edge.id);
          if (!selected.has(edge.from)) {
            selected.add(edge.from);
            nextUpstream.push(edge.from);
          }
        }
      for (const current of downstream)
        for (const edge of allEdges.filter((item) => item.from === current)) {
          selectedEdges.add(edge.id);
          if (!selected.has(edge.to)) {
            selected.add(edge.to);
            nextDownstream.push(edge.to);
          }
        }
      upstream.splice(0, upstream.length, ...nextUpstream);
      downstream.splice(0, downstream.length, ...nextDownstream);
    }
    return {
      focusAssetId: focus.id,
      nodes: [...selected].map((nodeId) => nodes.get(nodeId)).filter(Boolean),
      edges: allEdges.filter((edge) => selectedEdges.has(edge.id)),
      derivation: "VERSION_BINDINGS",
      sqlColumnLineageParsed: false,
    };
  }

  impact(id) {
    const focus = this.#asset(id),
      inventory = this.#inventory(),
      edges = this.#lineageEdges(inventory),
      downstream = new Set(),
      queue = [focus.id];
    while (queue.length) {
      const current = queue.shift();
      for (const edge of edges.filter((item) => item.from === current))
        if (!downstream.has(edge.to)) {
          downstream.add(edge.to);
          queue.push(edge.to);
        }
    }
    return {
      assetId: focus.id,
      downstream: [...downstream]
        .map((item) => inventory.find((asset) => asset.id === item))
        .filter(Boolean),
      edges: edges.filter(
        (edge) => edge.from === focus.id || downstream.has(edge.from),
      ),
      notice: "影响分析来自当前版本绑定；尚未解析Spark SQL字段级表达式。",
    };
  }

  listMetrics() {
    return this.store.list("metric_definition", this.project).map((metric) => ({
      ...metric,
      runs: this.store
        .list("metric_run", this.project)
        .filter((run) => run.metricId === metric.id),
    }));
  }

  createMetric(input) {
    const asset = this.#asset(input.assetId);
    if (!asset.executableMetrics)
      throw fail(
        422,
        "首版指标只允许在有实际本机行数据的落地表或实时状态表上定义",
        "METRIC_ASSET_NOT_EXECUTABLE",
      );
    const aggregation = text(input.aggregation, "聚合方式", 3, 30);
    if (!["SUM", "COUNT_DISTINCT", "COUNT_ROWS"].includes(aggregation))
      throw fail(400, "聚合方式不支持", "INVALID_METRIC_AGGREGATION");
    const field = aggregation === "COUNT_ROWS" ? undefined : fieldFrom(asset, input.field).name,
      groupBy = fieldFrom(asset, input.groupBy, false)?.name,
      code = identifier(input.code, "指标代码");
    if (
      this.store
        .list("metric_definition", this.project)
        .some((metric) => metric.code === code)
    )
      throw fail(409, "指标代码已存在", "DUPLICATE_METRIC_CODE");
    return this.store.create("metric_definition", this.project, {
      name: text(input.name, "指标名称", 2, 80),
      code,
      assetId: asset.id,
      aggregation,
      field,
      groupBy,
      unit: aggregation === "SUM" ? "CNY" : "COUNT",
      definition: text(input.definition, "指标口径", 4, 500),
      status: "ACTIVE",
      definitionVersion: 1,
      assetEvidenceHash: asset.evidenceHash,
    });
  }

  runMetric(id) {
    const metric = this.#metric(id),
      asset = this.#asset(metric.assetId),
      rows = this.#rows(asset),
      started = this.now(),
      grouped = new Map();
    for (const row of rows) {
      const group = metric.groupBy ? String(row[metric.groupBy] ?? "NULL") : "ALL";
      if (!grouped.has(group)) grouped.set(group, []);
      grouped.get(group).push(row);
    }
    const values = [...grouped.entries()]
      .map(([group, items]) => {
        let value;
        if (metric.aggregation === "COUNT_ROWS") value = String(items.length);
        else if (metric.aggregation === "COUNT_DISTINCT")
          value = String(new Set(items.map((item) => String(item[metric.field]))).size);
        else
          value = formatCents(
            items.reduce((sum, item) => sum + decimalCents(item[metric.field]), 0n),
          );
        return { group, value };
      })
      .sort((a, b) => a.group.localeCompare(b.group, "zh-CN"));
    const run = this.store.create("metric_run", this.project, {
      metricId: metric.id,
      assetId: asset.id,
      assetEvidenceHash: asset.evidenceHash,
      status: "SUCCEEDED",
      rowCount: rows.length,
      values,
      resultHash: stableHash(values),
      durationMs: this.now() - started,
      actualExecution: true,
      fullLifecycleE2E: false,
    });
    return run;
  }

  listStandards() {
    return this.store.list("data_standard", this.project).map((standard) => ({
      ...standard,
      checks: this.store
        .list("standard_check", this.project)
        .filter((check) => check.standardId === standard.id),
    }));
  }

  createStandard(input) {
    const asset = this.#asset(input.assetId);
    if (!asset.executableMetrics)
      throw fail(
        422,
        "首版标准只允许绑定可实际检查的落地表或实时状态表",
        "STANDARD_ASSET_NOT_EXECUTABLE",
      );
    const semanticType = text(input.semanticType, "语义类型", 3, 40);
    if (!["SECURITY_CODE", "CLIENT_ID", "DECIMAL_18_2", "TRADE_DATE"].includes(semanticType))
      throw fail(400, "语义类型不支持", "INVALID_SEMANTIC_TYPE");
    const code = identifier(input.code, "标准代码"),
      field = fieldFrom(asset, input.field).name;
    if (
      this.store
        .list("data_standard", this.project)
        .some((standard) => standard.code === code)
    )
      throw fail(409, "标准代码已存在", "DUPLICATE_STANDARD_CODE");
    return this.store.create("data_standard", this.project, {
      name: text(input.name, "标准名称", 2, 80),
      code,
      assetId: asset.id,
      field,
      semanticType,
      description: text(input.description, "标准说明", 4, 500),
      status: "ACTIVE",
      standardVersion: 1,
    });
  }

  checkStandard(id) {
    const standard = this.#standard(id),
      asset = this.#asset(standard.assetId),
      rows = this.#rows(asset),
      validator = {
        SECURITY_CODE: (value) => /^SEC-[A-Z0-9-]+$/.test(String(value ?? "")),
        CLIENT_ID: (value) => /^CLIENT-[A-Z0-9-]+$/.test(String(value ?? "")),
        DECIMAL_18_2: (value) => /^-?\d+(?:\.\d{2})$/.test(String(value ?? "")),
        TRADE_DATE: (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? "")),
      }[standard.semanticType],
      invalid = rows.filter((row) => !validator(row[standard.field])),
      result = {
        standardId: standard.id,
        assetId: asset.id,
        assetEvidenceHash: asset.evidenceHash,
        status: invalid.length ? "FAILED" : "PASSED",
        evaluatedCount: rows.length,
        passedCount: rows.length - invalid.length,
        failedCount: invalid.length,
        invalidValueHashes: invalid
          .slice(0, 10)
          .map((row) => hash(String(row[standard.field] ?? "NULL"))),
        actualExecution: true,
        fullLifecycleE2E: false,
      };
    return this.store.create("standard_check", this.project, result);
  }

  agentContext() {
    const assets = this.listAssets().map((asset) => ({
        id: asset.id,
        name: asset.name,
        businessName: asset.businessName,
        kind: asset.kind,
        system: asset.system,
        rowCount: asset.rowCount,
        fields: asset.fields.map((field) => ({ name: field.name, type: field.type })),
        tags: asset.tags,
      })),
      lineage = this.#lineageEdges(this.#inventory()).map((edge) => ({
        from: edge.from,
        to: edge.to,
        type: edge.type,
      }));
    return { assets, lineage };
  }

  validateAgentInsight(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw fail(422, "Agent未返回可验证的资产回答", "INVALID_ASSET_INSIGHT");
    const known = new Set(this.#inventory().map((asset) => asset.id)),
      assetIds = Array.isArray(value.assetIds)
        ? [...new Set(value.assetIds.map((id) => assetId(id)))]
        : [];
    if (!assetIds.length || assetIds.length > 8 || assetIds.some((id) => !known.has(id)))
      throw fail(422, "Agent引用了未知或过多资产", "UNKNOWN_AGENT_ASSET");
    const lineageFocusAssetId = value.lineageFocusAssetId
      ? assetId(value.lineageFocusAssetId)
      : assetIds[0];
    if (!known.has(lineageFocusAssetId))
      throw fail(422, "Agent血缘焦点资产不存在", "UNKNOWN_AGENT_ASSET");
    return {
      answer: text(value.answer, "Agent回答", 4, 1600),
      assetIds,
      lineageFocusAssetId,
      caveats: Array.isArray(value.caveats)
        ? value.caveats.slice(0, 6).map((item) => text(item, "边界说明", 2, 240))
        : [],
    };
  }

  executionRows(id) {
    const asset = this.#asset(id);
    if (!asset.executableMetrics)
      throw fail(
        422,
        "资产没有可执行的本机行数据",
        "ASSET_ROWS_UNAVAILABLE",
      );
    return { asset, rows: this.#rows(asset) };
  }

  reportRows(id) {
    const asset = this.#asset(id);
    if (!asset.reportable)
      throw fail(422, "资产当前不支持报表快照", "ASSET_NOT_REPORTABLE");
    if (asset.kind === "PUBLISHED_DATASET") {
      const run = this.store.get("release_run", asset.versionId, this.project);
      if (!run?.rows)
        throw fail(409, "发布数据集缺少可验证结果行", "REPORT_SOURCE_MISSING");
      return { asset, rows: structuredClone(run.rows) };
    }
    return { asset, rows: this.#rows(asset) };
  }

  #inventory() {
    const items = [],
      context = getContext("holdings-t1");
    for (const table of context.tables)
      items.push({
        id: `fixture:${table.name}`,
        kind: "FIXTURE_TABLE",
        name: table.name,
        businessName: table.label,
        system: "SPARK_FIXTURE",
        domain: "财富管理",
        description: "标杆Spark任务使用的虚构证券输入表",
        status: "VERIFIED_FIXTURE",
        rowCount: table.rows.length,
        fields: table.columns.map(([name, type]) => ({ name, type, nullable: true })),
        tags: ["虚构证券", "Spark输入"],
        evidenceHash: stableHash({ name: table.name, columns: table.columns, rows: table.rows }),
        executableMetrics: false,
        reportable: false,
      });
    for (const source of this.store.list("ingestion_source", this.project)) {
      const metadata = this.store.get(
        "source_metadata",
        source.currentMetadataId,
        this.project,
      );
      if (!metadata) continue;
      items.push({
        id: `source:${source.id}`,
        kind: "SOURCE_TABLE",
        name: metadata.objectName,
        businessName: source.name,
        system: source.sourceType,
        domain: "经纪与财富管理",
        description: "由真实文件扫描得到的源表资产",
        status: source.status,
        rowCount: metadata.rowCount,
        fields: metadata.columns.map(({ name, type, nullable, distinctCount }) => ({
          name,
          type,
          nullable,
          distinctCount,
        })),
        tags: ["虚构证券", "源数据"],
        evidenceHash: metadata.contentHash,
        versionId: metadata.id,
        executableMetrics: false,
        reportable: false,
      });
    }
    const targets = new Map();
    for (const task of this.store.list("offline_sync_task", this.project))
      if (!targets.has(task.targetTable)) targets.set(task.targetTable, task);
    for (const [targetTable, task] of targets) {
      const metadata = this.store.get("source_metadata", task.metadataVersionId, this.project),
        types = new Map(metadata?.columns.map((field) => [field.name, field]) ?? []),
        rows = this.landingStore.readTable(targetTable),
        fields = Object.entries(task.mapping).map(([from, to]) => ({
          name: to,
          type: types.get(from)?.type ?? "STRING",
          nullable: types.get(from)?.nullable ?? true,
        }));
      items.push({
        id: `landing:${targetTable}`,
        kind: "LANDING_TABLE",
        name: targetTable,
        businessName: targetTable === "raw_positions" ? "证券持仓落地表" : task.name,
        system: "LOCAL_SQLITE_LANDING",
        domain: "经纪与财富管理",
        description: "由版本化离线同步任务实际写入的本机落地表",
        status: task.status,
        rowCount: rows.length,
        fields,
        tags: ["虚构证券", "离线同步", task.mode],
        evidenceHash: task.runs?.[0]?.targetHash ?? stableHash(rows),
        versionId: task.id,
        executableMetrics: true,
        reportable: true,
      });
    }
    for (const source of this.store.list("stream_source", this.project)) {
      const revision = this.store.get(
        "stream_source_revision",
        source.currentRevisionId,
        this.project,
      );
      if (!revision) continue;
      items.push({
        id: `stream-source:${source.id}`,
        kind: "STREAM_SOURCE",
        name: source.topic,
        businessName: source.name,
        system: source.adapter,
        domain: "证券行情",
        description: "版本化虚构证券行情事件日志",
        status: source.status,
        rowCount: revision.lineCount,
        fields: quoteFields(),
        tags: ["虚构证券", "实时源"],
        evidenceHash: revision.contentHash,
        versionId: revision.id,
        executableMetrics: false,
        reportable: false,
      });
    }
    for (const job of this.store.list("stream_job", this.project)) {
      const state = this.stateStore.state(job.id);
      items.push({
        id: `stream:${job.id}`,
        kind: "STREAM_STATE_TABLE",
        name: job.targetTable,
        businessName: job.name,
        system: "LOCAL_STREAM_STATE",
        domain: "证券行情",
        description: "由实时任务实际维护的最新证券状态表",
        status: job.status,
        rowCount: state.length,
        eventCount: this.stateStore.eventCount(job.id),
        fields: quoteFields(),
        tags: ["虚构证券", "实时状态", "Checkpoint"],
        evidenceHash: job.stateHash ?? stableHash(state),
        versionId: job.id,
        executableMetrics: true,
        reportable: true,
      });
    }
    const publishedRuns = this.store.list("release_run", this.project).filter(
      (item) =>
        item.status === "SUCCEEDED" &&
        item.published === true &&
        item.schedulerTriggered === true &&
        item.validation?.passed,
    );
    if (publishedRuns.length) {
      const run = publishedRuns[0];
      const fields = (run.columns ?? Object.keys(run.rows?.[0] ?? {}).map((name) => ({ name, type: "STRING" }))).map(
        (field) =>
          Array.isArray(field)
            ? { name: field[0], type: field[1], nullable: true }
            : { name: field.name, type: field.type ?? "STRING", nullable: true },
      );
      items.push({
        id: "dataset:customer_assets_t1",
        kind: "PUBLISHED_DATASET",
        name: "customer_assets_t1",
        businessName: "客户T+1资产结果",
        system: "LOCAL_SPARK_RELEASE",
        domain: "财富管理",
        description: "由实际调度发布批次生成并通过独立断言的数据集",
        status: "PUBLISHED_LOCAL",
        rowCount: run.rows?.length ?? 0,
        fields,
        tags: ["虚构证券", "Spark结果", "已验证"],
        evidenceHash: run.outputHash ?? stableHash(run.rows ?? []),
        versionId: run.id,
        versionCount: publishedRuns.length,
        runIds: publishedRuns.map((item) => item.id),
        executableMetrics: false,
        reportable: true,
      });
    }
    for (const service of this.dataServices.list()) {
      const version = service.publishedVersion ?? service.currentVersion,
        fields =
          service.serviceType === "DAPI"
            ? (version?.fields ?? []).map((name) => ({ name, type: "API_FIELD", nullable: true }))
            : (version?.steps ?? []).map((step) => ({ name: step.alias, type: "DAPI_RESULT", nullable: true }));
      items.push({
        id: `service:${service.id}`,
        kind: service.serviceType,
        name: service.slug,
        businessName: service.name,
        system: "V2_DATA_SERVICE",
        domain: "数据服务",
        description: service.serviceType === "DAPI" ? "参数化数据查询服务" : "固定子版本的声明式组合服务",
        status: service.status,
        rowCount: undefined,
        fields,
        tags: [service.serviceType, "版本化接口"],
        evidenceHash: version?.configHash ?? stableHash(service),
        versionId: version?.id,
        executableMetrics: false,
        reportable: false,
      });
    }
    return items.map((item) => {
      const annotation = this.#latestAnnotation(item.id);
      return {
        ...item,
        businessName: annotation?.businessName ?? item.businessName,
        description: annotation?.description ?? item.description,
        domain: annotation?.domain ?? item.domain,
        owner: annotation?.owner,
        classification: annotation?.classification ?? "SYNTHETIC_ONLY",
        tags: annotation?.tags?.length ? annotation.tags : item.tags,
        annotation: publicAnnotation(annotation),
      };
    });
  }

  #lineageEdges(inventory) {
    const ids = new Set(inventory.map((item) => item.id)),
      edges = [];
    for (const task of this.store.list("offline_sync_task", this.project)) {
      const from = `source:${task.sourceId}`,
        to = `landing:${task.targetTable}`;
      if (ids.has(from) && ids.has(to))
        edges.push({
          id: `sync:${task.id}`,
          from,
          to,
          type: task.mode,
          fieldMappings: Object.entries(task.mapping).map(([source, target]) => ({ source, target })),
          evidenceId: task.id,
          evidenceHash: task.configHash,
        });
    }
    for (const job of this.store.list("stream_job", this.project)) {
      const from = `stream-source:${job.sourceId}`,
        to = `stream:${job.id}`;
      if (ids.has(from) && ids.has(to))
        edges.push({
          id: `stream-job:${job.id}`,
          from,
          to,
          type: "REALTIME_STATE",
          fieldMappings: quoteFields().map((field) => ({ source: field.name, target: field.name })),
          evidenceId: job.lastRunId ?? job.id,
          evidenceHash: job.configHash,
        });
    }
    for (const asset of inventory.filter((item) => item.kind === "PUBLISHED_DATASET"))
      for (const source of ["fixture:accounts", "fixture:positions", "fixture:cash"])
        if (ids.has(source))
          edges.push({
            id: `spark:${source}:${asset.versionId}`,
            from: source,
            to: asset.id,
            type: "SPARK_SQL",
            fieldMappings: [],
            evidenceId: asset.versionId,
            evidenceHash: asset.evidenceHash,
          });
    for (const service of this.dataServices.list()) {
      const version = service.publishedVersion ?? service.currentVersion,
        to = `service:${service.id}`;
      if (service.serviceType === "DAPI") {
        const dataset = inventory.find(
            (item) =>
              item.kind === "PUBLISHED_DATASET" &&
              item.runIds?.includes(version?.sourceReleaseRunId),
          ),
          from = dataset?.id;
        if (ids.has(from) && ids.has(to))
          edges.push({
            id: `dapi:${version.id}`,
            from,
            to,
            type: "DAPI_PUBLISH",
            fieldMappings: (version.fields ?? []).map((field) => ({ source: field, target: field })),
            evidenceId: version.id,
            evidenceHash: version.configHash,
          });
      } else
        for (const step of version?.steps ?? []) {
          const from = `service:${step.dapiId}`;
          if (ids.has(from) && ids.has(to))
            edges.push({
              id: `xapi:${version.id}:${step.alias}`,
              from,
              to,
              type: "XAPI_COMPOSE",
              fieldMappings: [],
              evidenceId: version.id,
              evidenceHash: version.configHash,
            });
        }
    }
    return edges;
  }

  #rows(asset) {
    if (asset.kind === "LANDING_TABLE") return this.landingStore.readTable(asset.name);
    if (asset.kind === "STREAM_STATE_TABLE")
      return this.stateStore.state(asset.id.slice("stream:".length));
    throw fail(422, "资产没有可执行的本机行数据", "ASSET_ROWS_UNAVAILABLE");
  }

  #asset(id) {
    const item = this.#inventory().find((asset) => asset.id === assetId(id));
    if (!item) throw fail(404, "未找到当前项目的数据资产", "ASSET_NOT_FOUND");
    return item;
  }

  #latestAnnotation(id) {
    return this.store
      .list("asset_annotation", this.project)
      .filter((item) => item.assetId === id)
      .sort((a, b) => b.revision - a.revision)[0];
  }

  #metric(id) {
    const item = this.store.get("metric_definition", text(id, "指标编号", 3, 80), this.project);
    if (!item) throw fail(404, "未找到指标", "METRIC_NOT_FOUND");
    return item;
  }

  #standard(id) {
    const item = this.store.get("data_standard", text(id, "标准编号", 3, 80), this.project);
    if (!item) throw fail(404, "未找到数据标准", "STANDARD_NOT_FOUND");
    return item;
  }
}

function quoteFields() {
  return [
    ["event_id", "STRING"],
    ["sequence", "INTEGER"],
    ["security_code", "STRING"],
    ["event_time", "TIMESTAMP"],
    ["price", "DECIMAL(18,2)"],
    ["volume", "INTEGER"],
  ].map(([name, type]) => ({ name, type, nullable: false }));
}
