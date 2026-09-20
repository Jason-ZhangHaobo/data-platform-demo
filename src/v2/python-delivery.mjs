import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  contextIds,
  getContext,
  validationContractId,
} from "./context.mjs";
import {
  resolveDeliverySchedule,
  validateCalendar,
} from "./delivery.mjs";
import { pythonRuntimeConfig, runRestrictedPython } from "./python.mjs";

export const pythonDeliveryFormat = "shuduo-python-delivery/v1";
export const pythonDeliveryFiles = [
  "main.py",
  "schedule.json",
  "deployment.json",
  "calendar.json",
  "fixtures.json",
  "validation.json",
  "README.md",
];
const fail = (message) => Object.assign(new Error(message), { status: 422 });
const encoded = (value) => JSON.stringify(value, null, 2) + "\n";
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
const same = (left, right) => canonical(left) === canonical(right);
export const pythonSha256 = (value) =>
  createHash("sha256").update(value).digest("hex");
export const computePythonManifestDigest = (manifest) =>
  pythonSha256(canonical(manifest));

const calendar = () => ({
  schema: "shuduo-calendar/v1",
  kind: "SYNTHETIC_DEMO",
  timezone: "Asia/Shanghai",
  range: { start: "2026-09-10", end: "2026-09-14" },
  tradingDays: ["2026-09-10", "2026-09-11", "2026-09-14"],
  notice: "仅验证样例T+1关系，不是交易所官方日历；范围外拒绝推断。",
});

export function createPythonDeliveryPackage({
  run,
  revision,
  name = "客户资产 T+1 · Python",
}) {
  if (
    !run ||
    !revision ||
    run.projectId !== revision.projectId ||
    run.revisionId !== revision.id ||
    run.status !== "SUCCEEDED" ||
    run.engine !== "CPython" ||
    !/^\d+\.\d+(?:\.\d+)?$/.test(run.engineVersion ?? "") ||
    run.validationContractId !== validationContractId ||
    run.validation?.passed !== true ||
    run.revisionHash !== revision.codeHash ||
    pythonSha256(revision.code) !== revision.codeHash ||
    run.resourceLimits?.cpu !== true ||
    run.resourceLimits?.fileSize !== true
  )
    throw Object.assign(
      new Error("只能从代码哈希一致且独立断言通过的真实受限Python运行生成交付包"),
      { status: 409 },
    );
  if (
    !contextIds.every((id) =>
      run.validation.regressions?.some(
        (check) => check.contextId === id && check.passed,
      ),
    )
  )
    throw Object.assign(new Error("缺少五场景Python验证证据"), {
      status: 409,
    });
  if (typeof name !== "string" || !name.trim() || name.length > 80)
    throw fail("任务名称需为1–80个字符");
  const context = getContext(revision.contextId);
  if (!context) throw fail("输入上下文不存在");
  const taskCalendar = calendar(),
    nodes = [
      { id: "execute", kind: "python_transform", file: "main.py", dependsOn: [] },
      {
        id: "validate",
        kind: "python_assertions",
        file: "validation.json",
        dependsOn: ["execute"],
      },
      { id: "evidence", kind: "record_evidence", dependsOn: ["validate"] },
    ],
    schedule = {
      schema: "shuduo-schedule/v1",
      timezone: "Asia/Shanghai",
      at: "09:00:00",
      calendar: "calendar.json",
      businessDate: { rule: "previous_trading_day" },
      concurrency: 1,
      retries: 0,
      nodes,
    },
    deployment = {
      schema: "shuduo-python-deployment/v1",
      adapter: "local-restricted-python-v1",
      environment: "local-rehearsal",
      runtime: {
        engine: "CPython",
        version: run.engineVersion,
        timeoutSeconds: 10,
        parallelism: 1,
        memoryLimitVerified: run.resourceLimits?.addressSpace === true,
      },
      entrypoint: "main.py",
      schedule: "schedule.json",
      inputs: "fixtures.json",
      secretReferences: [],
      published: false,
      publicDeployed: false,
      notice:
        "本机受限Python文件演练；禁止import/文件/网络，未创建云资源且未发布。",
    },
    files = {
      "main.py": revision.code,
      "schedule.json": encoded(schedule),
      "deployment.json": encoded(deployment),
      "calendar.json": encoded(taskCalendar),
      "fixtures.json": encoded({
        context,
        validationContexts: contextIds.map(getContext),
      }),
      "validation.json": encoded({
        sourceRunId: run.id,
        revisionHash: revision.codeHash,
        engine: run.engine,
        engineVersion: run.engineVersion,
        report: run.validation,
        resourceLimits: run.resourceLimits,
      }),
      "README.md":
        `# 受限Python交付包\n\n包含transform代码、调度、部署清单、五套合成证券输入和验证证据。\n当前适配器 ${deployment.adapter}，CPython ${run.engineVersion}；只完成本机按文件演练，尚未适配云Python Worker、DataWorks或EMR。\n演练时间：2026-09-11T09:00:00+08:00，对应业务日2026-09-10。\n`,
    },
    manifest = {
      format: pythonDeliveryFormat,
      name: name.trim(),
      source: {
        runId: run.id,
        revisionId: revision.id,
        projectId: run.projectId,
        codeHash: revision.codeHash,
        contextId: context.id,
        validationContractId,
      },
      files: Object.fromEntries(
        pythonDeliveryFiles.map((file) => [
          file,
          {
            sha256: pythonSha256(files[file]),
            bytes: Buffer.byteLength(files[file]),
          },
        ]),
      ),
      releaseState: "NOT_PUBLISHED",
      createdAt: new Date().toISOString(),
    };
  return { manifest, files, digest: computePythonManifestDigest(manifest) };
}

const jsonFile = (bundle, name) => {
  try {
    return JSON.parse(bundle.files[name]);
  } catch {
    throw fail(name + "不是有效JSON");
  }
};

export function validatePythonDeliveryPackage(bundle, expectedDigest) {
  if (
    bundle?.manifest?.format !== pythonDeliveryFormat ||
    typeof bundle.files !== "object" ||
    !/^[a-f0-9]{64}$/.test(expectedDigest ?? "") ||
    bundle.digest !== expectedDigest ||
    computePythonManifestDigest(bundle.manifest) !== expectedDigest ||
    !same(Object.keys(bundle.files).sort(), [...pythonDeliveryFiles].sort()) ||
    !same(
      Object.keys(bundle.manifest.files ?? {}).sort(),
      [...pythonDeliveryFiles].sort(),
    )
  )
    throw fail("Python交付包格式、摘要或文件集合不合法");
  for (const name of pythonDeliveryFiles) {
    const content = bundle.files[name],
      entry = bundle.manifest.files[name];
    if (
      typeof content !== "string" ||
      Buffer.byteLength(content) > 250_000 ||
      entry?.bytes !== Buffer.byteLength(content) ||
      entry?.sha256 !== pythonSha256(content)
    )
      throw fail(name + "内容或校验值不一致");
  }
  const source = bundle.manifest.source,
    schedule = jsonFile(bundle, "schedule.json"),
    deployment = jsonFile(bundle, "deployment.json"),
    taskCalendar = jsonFile(bundle, "calendar.json"),
    fixtures = jsonFile(bundle, "fixtures.json"),
    proof = jsonFile(bundle, "validation.json");
  if (
    source.codeHash !== pythonSha256(bundle.files["main.py"]) ||
    source.validationContractId !== validationContractId ||
    bundle.manifest.releaseState !== "NOT_PUBLISHED" ||
    schedule.schema !== "shuduo-schedule/v1" ||
    schedule.timezone !== "Asia/Shanghai" ||
    schedule.at !== "09:00:00" ||
    schedule.calendar !== "calendar.json" ||
    schedule.businessDate?.rule !== "previous_trading_day" ||
    schedule.concurrency !== 1 ||
    schedule.retries !== 0 ||
    deployment.schema !== "shuduo-python-deployment/v1" ||
    deployment.adapter !== "local-restricted-python-v1" ||
    deployment.environment !== "local-rehearsal" ||
    deployment.entrypoint !== "main.py" ||
    deployment.schedule !== "schedule.json" ||
    deployment.inputs !== "fixtures.json" ||
    deployment.published !== false ||
    deployment.publicDeployed !== false ||
    deployment.runtime?.engine !== "CPython" ||
    !/^\d+\.\d+(?:\.\d+)?$/.test(deployment.runtime.version ?? "") ||
    deployment.runtime.timeoutSeconds !== 10 ||
    deployment.runtime.parallelism !== 1 ||
    !same(deployment.secretReferences, [])
  )
    throw fail("Python调度或部署清单包含未实现目标、命令或凭证");
  const expectedKinds = [
      ["python_transform", "main.py"],
      ["python_assertions", "validation.json"],
      ["record_evidence", undefined],
    ],
    order = schedule.nodes ?? [];
  if (
    order.length !== 3 ||
    !expectedKinds.every(
      ([kind, file], index) =>
        order[index]?.kind === kind && order[index]?.file === file,
    ) ||
    order[0].dependsOn?.length !== 0 ||
    !same(order[1].dependsOn, [order[0].id]) ||
    !same(order[2].dependsOn, [order[1].id])
  )
    throw fail("Python DAG必须按执行、断言、证据顺序运行");
  if (
    !same(fixtures.context, getContext(source.contextId)) ||
    !same(fixtures.validationContexts, contextIds.map(getContext)) ||
    proof.sourceRunId !== source.runId ||
    proof.revisionHash !== source.codeHash ||
    proof.engine !== "CPython" ||
    proof.engineVersion !== deployment.runtime.version ||
    proof.report?.passed !== true
  )
    throw fail("Python输入或源验证证据与清单不一致");
  validateCalendar(taskCalendar);
  return {
    source,
    schedule,
    deployment,
    calendar: taskCalendar,
    fixtures,
    proof,
    order,
    digest: expectedDigest,
  };
}

export function unpackPythonDeliveryPackage(bundle, directory, expectedDigest) {
  validatePythonDeliveryPackage(bundle, expectedDigest);
  const target = resolve(directory);
  mkdirSync(target, { recursive: false });
  for (const name of pythonDeliveryFiles)
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

export function loadPythonDeliveryDirectory(directory, expectedDigest) {
  const target = resolve(directory),
    read = (name) => {
      const path = join(target, name),
        stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 250_000)
        throw fail("Python交付文件不能为符号链接、目录或超限文件");
      return readFileSync(path, "utf8");
    };
  let manifest;
  try {
    manifest = JSON.parse(read("manifest.json"));
  } catch {
    throw fail("无法读取Python交付清单");
  }
  const bundle = {
    manifest,
    digest: expectedDigest,
    files: Object.fromEntries(
      pythonDeliveryFiles.map((name) => [name, read(name)]),
    ),
  };
  return {
    bundle,
    plan: validatePythonDeliveryPackage(bundle, expectedDigest),
  };
}

export async function verifyPythonDeliveryDirectory(
  { directory, expectedDigest, scheduledFor, signal },
  options = {},
) {
  const { bundle, plan } = loadPythonDeliveryDirectory(
      directory,
      expectedDigest,
    ),
    occurrence = resolveDeliverySchedule(plan, scheduledFor);
  if (!occurrence.eligible)
    throw Object.assign(new Error("样例非交易日，不执行Python"), {
      status: 422,
    });
  if (occurrence.businessDate !== plan.fixtures.context.businessDate)
    throw Object.assign(
      new Error("解析出的T+1业务日与冻结Python输入日期不一致"),
      { status: 422 },
    );
  const startedAt = new Date().toISOString(),
    runner =
      options.pythonRunner ??
      ((input) =>
        runRestrictedPython(
          input,
          options.pythonRuntime ?? pythonRuntimeConfig(),
        )),
    result = await runner({
      code: bundle.files["main.py"],
      context: plan.fixtures.context,
      validationContexts: plan.fixtures.validationContexts,
      timeoutMs: plan.deployment.runtime.timeoutSeconds * 1000,
      signal,
    }),
    regressionIds = plan.fixtures.validationContexts.map((item) => item.id),
    passed = Boolean(
      result.status === "SUCCEEDED" &&
        result.engine === "CPython" &&
        result.engineVersion === plan.deployment.runtime.version &&
        result.validation?.passed === true &&
        regressionIds.every((id) =>
          result.validation.regressions?.some(
            (check) => check.contextId === id && check.passed,
          ),
        ),
    ),
    receipt = {
      ...result,
      status: passed
        ? "SUCCEEDED"
        : result.status === "SUCCEEDED"
          ? "FAILED"
          : result.status,
      mode: "LOCAL_PYTHON_FILE_REHEARSAL",
      codeExecuted: true,
      codeHash: pythonSha256(bundle.files["main.py"]),
      published: false,
      publicDeployed: false,
      schedulerTriggered: false,
      clockMode: "EXPLICIT_REHEARSAL_TIME",
      startedAt,
      finishedAt: new Date().toISOString(),
      occurrence,
      source: plan.source,
      packageDigest: expectedDigest,
      workflowTrace: plan.order.map((node) => ({
        id: node.id,
        kind: node.kind,
        status:
          node.kind === "python_transform"
            ? result.status === "SUCCEEDED"
              ? "SUCCEEDED"
              : "FAILED"
            : node.kind === "python_assertions"
              ? passed
                ? "SUCCEEDED"
                : "FAILED"
              : passed
                ? "SUCCEEDED"
                : "BLOCKED",
      })),
      notice:
        "已按调度/部署文件执行本机受限Python演练；不是定时触发、云沙箱或发布上线。",
    };
  if (!passed && !receipt.error)
    receipt.error = "Python运行、五套断言或引擎版本未满足交付清单";
  writeFileSync(
    join(directory, "verification-" + randomUUID() + ".json"),
    JSON.stringify(receipt, null, 2),
    { flag: "wx", mode: 0o600 },
  );
  return receipt;
}

