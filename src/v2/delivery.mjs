import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, lstatSync } from "node:fs";
import { resolve, join } from "node:path";
import { getContext, contextIds, validationContractId } from "./context.mjs";

export const deliveryFormat = "shuduo-delivery/v1";
export const deliveryFiles = [
  "main.sql",
  "tests.sql",
  "schedule.json",
  "deployment.json",
  "calendar.json",
  "fixtures.json",
  "validation.json",
  "README.md",
];
export const sha256 = (text) => createHash("sha256").update(text).digest("hex");
const supportedSparkVersions = new Set(["3.5.7", "3.5.8", "3.5.9"]);
const cloudSparkVersions = new Set(["3.5.8", "3.5.9"]);
const fail = (message) => Object.assign(new Error(message), { status: 422 });
const canonical = (value) =>
  JSON.stringify(
    value && typeof value === "object"
      ? Array.isArray(value)
        ? value.map((v) => JSON.parse(canonical(v)))
        : Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((k) => [k, JSON.parse(canonical(value[k]))]),
          )
      : value,
  );
const encoded = (value) => JSON.stringify(value, null, 2) + "\n";
const same = (a, b) => canonical(a) === canonical(b);
const keysExactly = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  same(Object.keys(value).sort(), [...keys].sort());
export const computeManifestDigest = (manifest) => sha256(canonical(manifest));
const literal = (value) => "'" + String(value).replaceAll("'", "''") + "'";

export function createTestSql(expected) {
  const fields = [
    "holding_market_value",
    "available_cash",
    "total_assets",
    "security_count",
  ];
  const checks = expected.map((row) => {
    const matches = fields.map((field) => {
      if (!/^-?\d+(\.\d+)?$/.test(String(row[field])))
        throw fail("预期金额/数量不是有效数值");
      return (
        "CAST(" +
        field +
        " AS DECIMAL(38,2)) = CAST(" +
        literal(row[field]) +
        " AS DECIMAL(38,2))"
      );
    });
    return (
      "SUM(CASE WHEN client_id = " +
      literal(row.client_id) +
      " AND " +
      matches.join(" AND ") +
      " THEN 1 ELSE 0 END) = 1"
    );
  });
  return (
    "-- Generated from independent synthetic assertions, not from model output.\nSELECT CASE WHEN COUNT(*) = " +
    expected.length +
    " AND COUNT(DISTINCT client_id) = " +
    expected.length +
    "\n  AND " +
    checks.join("\n  AND ") +
    "\nTHEN true ELSE false END AS passed\nFROM __shuduo_result\n"
  );
}

export function createDeliveryPackage({
  run,
  revision,
  name = "客户资产 T+1",
}) {
  const remoteExecution = run?.isolation === "FUNCTION_PROCESS";
  if (
    ![run?.id, run?.projectId, revision?.id, revision?.projectId].every(
      (value) =>
        typeof value === "string" && value.length > 0 && value.length <= 100,
    )
  )
    throw Object.assign(new Error("缺少有效的源运行、项目或代码版本标识"), {
      status: 409,
    });
  if (
    !run ||
    !revision ||
    run.projectId !== revision.projectId ||
    run.revisionId !== revision.id ||
    run.status !== "SUCCEEDED" ||
    run.engine !== "Apache Spark" ||
    !supportedSparkVersions.has(run.engineVersion) ||
    (remoteExecution && !cloudSparkVersions.has(run.engineVersion)) ||
    !run.validation?.passed ||
    run.validation.contractId !== validationContractId ||
    run.revisionHash !== revision.hash ||
    sha256(revision.sql) !== revision.hash
  )
    throw Object.assign(
      new Error(
        "只能从当前验证范围通过、代码哈希一致的真实 Spark 运行生成交付包",
      ),
      { status: 409 },
    );
  if (
    !contextIds.every((id) =>
      run.validation.regressions?.some(
        (check) => check.contextId === id && check.passed,
      ),
    )
  )
    throw Object.assign(new Error("缺少五场景验证证据，请先重新运行 SQL"), {
      status: 409,
    });
  if (typeof name !== "string" || !name.trim() || name.length > 80)
    throw fail("任务名称需为1–80个字符");
  const context = getContext(revision.contextId);
  if (!context) throw fail("输入上下文不存在");
  const calendar = {
    schema: "shuduo-calendar/v1",
    kind: "SYNTHETIC_DEMO",
    timezone: "Asia/Shanghai",
    range: { start: "2026-09-10", end: "2026-09-14" },
    tradingDays: ["2026-09-10", "2026-09-11", "2026-09-14"],
    notice: "仅验证样例 T+1 关系，不是交易所官方日历；范围外拒绝推断。",
  };
  const nodes = [
    { id: "execute", kind: "spark_sql", file: "main.sql", dependsOn: [] },
    {
      id: "validate",
      kind: "sql_assertions",
      file: "tests.sql",
      dependsOn: ["execute"],
    },
    { id: "evidence", kind: "record_evidence", dependsOn: ["validate"] },
  ];
  const schedule = {
    schema: "shuduo-schedule/v1",
    timezone: "Asia/Shanghai",
    at: "09:00:00",
    calendar: "calendar.json",
    businessDate: { rule: "previous_trading_day" },
    concurrency: 1,
    retries: 0,
    nodes,
  };
  const deployment = {
    schema: "shuduo-deployment/v1",
    adapter: remoteExecution ? "remote-spark-worker-v1" : "local-spark-v1",
    environment: remoteExecution
      ? "cloud-isolated-rehearsal"
      : "local-rehearsal",
    runtime: {
      engine: "Apache Spark",
      version: run.engineVersion,
      timeoutSeconds: 90,
      parallelism: 1,
      driverMemoryMiB: remoteExecution ? 2048 : 768,
    },
    entrypoint: "main.sql",
    tests: "tests.sql",
    schedule: "schedule.json",
    inputs: "fixtures.json",
    secretReferences: [],
    published: false,
    notice: remoteExecution
      ? "隔离Worker文件演练；仍未发布上线，必须保留Worker运行与断言证据。"
      : "本机文件演练；未创建云资源，未发布上线，不代表OS级沙箱。",
  };
  const files = {
    "main.sql": revision.sql,
    "tests.sql": createTestSql(context.expected),
    "schedule.json": encoded(schedule),
    "deployment.json": encoded(deployment),
    "calendar.json": encoded(calendar),
    "fixtures.json": encoded({
      context,
      validationContexts: contextIds.map(getContext),
    }),
    "validation.json": encoded({
      sourceRunId: run.id,
      revisionHash: revision.hash,
      engine: run.engine,
      engineVersion: run.engineVersion,
      isolation: run.isolation ?? "LOCAL_PROCESS",
      report: run.validation,
    }),
    "README.md":
      `# ${remoteExecution ? "隔离Worker" : "本机"}交付包\n\n包含 SQL、实际执行的测试 SQL、调度、部署和样例交易日历。\n适配器 ${deployment.adapter}，Spark ${run.engineVersion}；当前只是演练，尚未发布或适配 DataWorks/EMR。\n演练时间：2026-09-11T09:00:00+08:00，对应业务日2026-09-10。\n散列只能校验与指定摘要一致，不构成生产审批或发布签名。\n`,
  };
  const manifest = {
    format: deliveryFormat,
    name: name.trim(),
    source: {
      runId: run.id,
      revisionId: revision.id,
      projectId: run.projectId,
      sqlHash: revision.hash,
      contextId: context.id,
      validationContractId,
    },
    files: Object.fromEntries(
      deliveryFiles.map((file) => [
        file,
        { sha256: sha256(files[file]), bytes: Buffer.byteLength(files[file]) },
      ]),
    ),
    releaseState: "NOT_PUBLISHED",
    createdAt: new Date().toISOString(),
  };
  return { manifest, files, digest: computeManifestDigest(manifest) };
}

function jsonFile(bundle, name) {
  try {
    return JSON.parse(bundle.files[name]);
  } catch {
    throw fail(name + " 不是有效 JSON");
  }
}
export function validateDeliveryPackage(bundle, expectedDigest) {
  if (
    !bundle ||
    bundle.manifest?.format !== deliveryFormat ||
    typeof bundle.files !== "object" ||
    !bundle.files
  )
    throw fail("交付包格式不支持");
  if (!/^[a-f0-9]{64}$/.test(expectedDigest ?? ""))
    throw fail("必须提供从可信项目记录取得的交付包摘要");
  if (
    bundle.digest !== expectedDigest ||
    computeManifestDigest(bundle.manifest) !== expectedDigest
  )
    throw fail("交付包摘要不一致，文件或清单已变更");
  if (
    !same(Object.keys(bundle.files).sort(), [...deliveryFiles].sort()) ||
    !same(
      Object.keys(bundle.manifest.files ?? {}).sort(),
      [...deliveryFiles].sort(),
    )
  )
    throw fail("交付包缺少文件或包含不允许的路径");
  let total = 0;
  for (const name of deliveryFiles) {
    const content = bundle.files[name],
      entry = bundle.manifest.files[name];
    if (
      typeof content !== "string" ||
      Buffer.byteLength(content) > 250000 ||
      entry.bytes !== Buffer.byteLength(content) ||
      entry.sha256 !== sha256(content)
    )
      throw fail(name + " 内容或校验值不一致");
    total += Buffer.byteLength(content);
  }
  if (total > 750000) throw fail("交付包超过本机演练大小限制");
  const source = bundle.manifest.source;
  if (
    !keysExactly(bundle.manifest, [
      "format",
      "name",
      "source",
      "files",
      "releaseState",
      "createdAt",
    ]) ||
    !keysExactly(source, [
      "runId",
      "revisionId",
      "projectId",
      "sqlHash",
      "contextId",
      "validationContractId",
    ])
  )
    throw fail("交付清单包含未定义字段");
  if (
    !source ||
    source.sqlHash !== sha256(bundle.files["main.sql"]) ||
    source.validationContractId !== validationContractId ||
    bundle.manifest.releaseState !== "NOT_PUBLISHED"
  )
    throw fail("源代码或验证契约已过期，需要重新生成交付包");
  const schedule = jsonFile(bundle, "schedule.json"),
    deployment = jsonFile(bundle, "deployment.json");
  const calendar = jsonFile(bundle, "calendar.json"),
    fixtures = jsonFile(bundle, "fixtures.json"),
    proof = jsonFile(bundle, "validation.json"),
    localTarget =
      deployment.adapter === "local-spark-v1" &&
      deployment.environment === "local-rehearsal" &&
      deployment.runtime?.driverMemoryMiB === 768,
    remoteTarget =
      deployment.adapter === "remote-spark-worker-v1" &&
      deployment.environment === "cloud-isolated-rehearsal" &&
      deployment.runtime?.driverMemoryMiB === 2048;
  if (
    !keysExactly(schedule, [
      "schema",
      "timezone",
      "at",
      "calendar",
      "businessDate",
      "concurrency",
      "retries",
      "nodes",
    ]) ||
    !keysExactly(schedule.businessDate, ["rule"]) ||
    schedule.schema !== "shuduo-schedule/v1" ||
    schedule.timezone !== "Asia/Shanghai" ||
    schedule.at !== "09:00:00" ||
    schedule.calendar !== "calendar.json" ||
    schedule.businessDate?.rule !== "previous_trading_day" ||
    schedule.concurrency !== 1 ||
    schedule.retries !== 0
  )
    throw fail("当前仅支持样例交易日09:00、T+1、串行且不自动重试的演练调度");
  const order = validateDag(schedule.nodes);
  if (
    !keysExactly(deployment, [
      "schema",
      "adapter",
      "environment",
      "runtime",
      "entrypoint",
      "tests",
      "schedule",
      "inputs",
      "secretReferences",
      "published",
      "notice",
    ]) ||
    deployment.schema !== "shuduo-deployment/v1" ||
    (!localTarget && !remoteTarget) ||
    deployment.published !== false ||
    deployment.entrypoint !== "main.sql" ||
    deployment.tests !== "tests.sql" ||
    deployment.schedule !== "schedule.json" ||
    deployment.inputs !== "fixtures.json" ||
    !same(deployment.secretReferences, []) ||
    !keysExactly(deployment.runtime, [
      "engine",
      "version",
      "timeoutSeconds",
      "parallelism",
      "driverMemoryMiB",
    ]) ||
    deployment.runtime.engine !== "Apache Spark" ||
    !supportedSparkVersions.has(deployment.runtime.version) ||
    (remoteTarget && !cloudSparkVersions.has(deployment.runtime.version)) ||
    deployment.runtime.timeoutSeconds !== 90 ||
    deployment.runtime.parallelism !== 1
  )
    throw fail(
      "部署清单包含未实现的目标、命令、资源配置或凭证；不会尝试云端部署",
    );
  if (
    !same(fixtures.context, getContext(source.contextId)) ||
    !same(fixtures.validationContexts, contextIds.map(getContext))
  )
    throw fail("演练输入不是当前已登记的合成数据契约");
  if (
    proof.sourceRunId !== source.runId ||
    proof.revisionHash !== source.sqlHash ||
    proof.engine !== deployment.runtime.engine ||
    proof.engineVersion !== deployment.runtime.version ||
    (remoteTarget && proof.isolation !== "FUNCTION_PROCESS") ||
    !proof.report?.passed ||
    proof.report.contractId !== validationContractId
  )
    throw fail("源验证报告与代码或契约不一致");
  validateCalendar(calendar);
  return {
    source,
    schedule,
    deployment,
    calendar,
    fixtures,
    order,
    digest: expectedDigest,
  };
}

export function validateDag(nodes) {
  if (!Array.isArray(nodes) || nodes.length !== 3)
    throw fail("演练 DAG 必须包含执行、SQL测试和证据三个节点");
  const kinds = {
      spark_sql: "main.sql",
      sql_assertions: "tests.sql",
      record_evidence: undefined,
    },
    map = new Map();
  for (const node of nodes) {
    if (
      !node ||
      !keysExactly(
        node,
        node.kind === "record_evidence"
          ? ["id", "kind", "dependsOn"]
          : ["id", "kind", "file", "dependsOn"],
      ) ||
      !/^[a-z][a-z0-9_-]{0,40}$/.test(node.id ?? "") ||
      map.has(node.id) ||
      !Object.hasOwn(kinds, node.kind) ||
      node.file !== kinds[node.kind] ||
      !Array.isArray(node.dependsOn) ||
      !node.dependsOn.every((id) => typeof id === "string") ||
      new Set(node.dependsOn).size !== node.dependsOn.length
    )
      throw fail("DAG 节点类型、文件或依赖不合法");
    map.set(node.id, node);
  }
  if (new Set(nodes.map((n) => n.kind)).size !== 3)
    throw fail("DAG 节点类型必须各一个");
  const order = [],
    visiting = new Set(),
    done = new Set();
  const visit = (id) => {
    if (done.has(id)) return;
    if (visiting.has(id) || !map.has(id)) throw fail("DAG 存在环或缺失依赖");
    visiting.add(id);
    for (const dependency of map.get(id).dependsOn) visit(dependency);
    visiting.delete(id);
    done.add(id);
    order.push(map.get(id));
  };
  for (const node of nodes) visit(node.id);
  const execute = nodes.find((n) => n.kind === "spark_sql"),
    validate = nodes.find((n) => n.kind === "sql_assertions"),
    evidence = nodes.find((n) => n.kind === "record_evidence");
  if (
    execute.dependsOn.length ||
    !same(validate.dependsOn, [execute.id]) ||
    !same(evidence.dependsOn, [validate.id])
  )
    throw fail("必须按 SQL执行 → SQL测试 → 记录证据的真实依赖执行");
  return order;
}

const isDate = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(value + "T00:00:00Z")) &&
  new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value;
export function validateCalendar(calendar) {
  if (
    !keysExactly(calendar, [
      "schema",
      "kind",
      "timezone",
      "range",
      "tradingDays",
      "notice",
    ]) ||
    !keysExactly(calendar.range, ["start", "end"]) ||
    calendar?.schema !== "shuduo-calendar/v1" ||
    calendar.kind !== "SYNTHETIC_DEMO" ||
    calendar.timezone !== "Asia/Shanghai" ||
    !isDate(calendar.range?.start) ||
    !isDate(calendar.range?.end) ||
    calendar.range.start > calendar.range.end ||
    !Array.isArray(calendar.tradingDays) ||
    !calendar.tradingDays.length ||
    calendar.tradingDays.length > 100 ||
    !calendar.tradingDays.every(
      (day) =>
        isDate(day) && day >= calendar.range.start && day <= calendar.range.end,
    ) ||
    !same(calendar.tradingDays, [...new Set(calendar.tradingDays)].sort())
  )
    throw fail("样例交易日历无效");
}
export function resolveDeliverySchedule(plan, scheduledFor) {
  if (
    typeof scheduledFor !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00$/.test(scheduledFor)
  )
    throw fail("请提供北京时间，例如2026-09-11T09:00:00+08:00");
  const day = scheduledFor.slice(0, 10),
    time = scheduledFor.slice(11, 19);
  if (!isDate(day) || time !== plan.schedule.at)
    throw fail("演练时间必须落在配置的09:00调度时刻");
  if (day < plan.calendar.range.start || day > plan.calendar.range.end)
    throw fail("超出样例日历范围，不能推断真实交易日");
  const index = plan.calendar.tradingDays.indexOf(day);
  if (index === -1)
    return { eligible: false, reason: "NON_TRADING_DAY", scheduledFor };
  if (index === 0) throw fail("日历缺少前一个交易日，不能推断业务日期");
  return {
    eligible: true,
    scheduledFor,
    businessDate: plan.calendar.tradingDays[index - 1],
    timezone: "Asia/Shanghai",
  };
}

export function unpackDeliveryPackage(bundle, directory, expectedDigest) {
  validateDeliveryPackage(bundle, expectedDigest);
  const target = resolve(directory);
  mkdirSync(target, { recursive: false });
  for (const name of deliveryFiles)
    writeFileSync(join(target, name), bundle.files[name], {
      flag: "wx",
      mode: 0o600,
    });
  writeFileSync(join(target, "manifest.json"), encoded(bundle.manifest), {
    flag: "wx",
    mode: 0o600,
  });
  return target;
}
export function loadDeliveryDirectory(directory, expectedDigest) {
  const target = resolve(directory);
  const read = (name) => {
    const path = join(target, name),
      stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 250000)
      throw fail("交付文件不能为符号链接、目录或超限文件");
    return readFileSync(path, "utf8");
  };
  let manifest;
  try {
    manifest = JSON.parse(read("manifest.json"));
  } catch {
    throw fail("无法读取交付清单");
  }
  const bundle = {
    manifest,
    digest: expectedDigest,
    files: Object.fromEntries(deliveryFiles.map((name) => [name, read(name)])),
  };
  return { bundle, plan: validateDeliveryPackage(bundle, expectedDigest) };
}
