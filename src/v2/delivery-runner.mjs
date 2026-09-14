import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  loadDeliveryDirectory,
  resolveDeliverySchedule,
  sha256,
} from "./delivery.mjs";
import { runSpark, runtimeConfig } from "./spark.mjs";

export async function verifyDeliveryDirectory(
  { directory, expectedDigest, scheduledFor, signal },
  options = {},
) {
  const { bundle, plan } = loadDeliveryDirectory(directory, expectedDigest);
  const occurrence = resolveDeliverySchedule(plan, scheduledFor);
  if (!occurrence.eligible)
    throw Object.assign(new Error("样例非交易日，不执行 SQL"), { status: 422 });
  if (occurrence.businessDate !== plan.fixtures.context.businessDate)
    throw Object.assign(
      new Error(
        "解析出的T+1业务日与冻结输入日期不一致，不能把旧数据当作新批次",
      ),
      { status: 422 },
    );
  const startedAt = new Date().toISOString();
  const runner =
    options.runner ??
    ((input) => runSpark(input, options.runtime ?? runtimeConfig()));
  const raw = await runner({
    sql: bundle.files["main.sql"],
    testSql: bundle.files["tests.sql"],
    context: plan.fixtures.context,
    validationContexts: plan.fixtures.validationContexts,
    timeoutMs: plan.deployment.runtime.timeoutSeconds * 1000,
    signal,
  });
  const { directory: privateDirectory, ...result } = raw;
  const regressionIds = plan.fixtures.validationContexts.map(
    (context) => context.id,
  );
  const checked = Boolean(
    result.validation?.passed &&
      result.testSqlValidation?.passed &&
      result.testSqlValidation.sqlHash === sha256(bundle.files["tests.sql"]) &&
      regressionIds.every((id) =>
        result.validation.regressions?.some(
          (check) => check.contextId === id && check.passed,
        ),
      ),
  );
  const passed =
    result.status === "SUCCEEDED" &&
    result.mainSqlExecuted === true &&
    checked &&
    result.engine === "Apache Spark" &&
    result.engineVersion === plan.deployment.runtime.version;
  const receipt = {
    ...result,
    status: passed
      ? "SUCCEEDED"
      : result.status === "SUCCEEDED"
        ? "FAILED"
        : result.status,
    mode:
      plan.deployment.adapter === "remote-spark-worker-v1"
        ? "CLOUD_ISOLATED_FILE_REHEARSAL"
        : "LOCAL_FILE_REHEARSAL",
    published: false,
    schedulerTriggered: false,
    clockMode: "EXPLICIT_REHEARSAL_TIME",
    startedAt,
    finishedAt: new Date().toISOString(),
    occurrence,
    source: plan.source,
    packageDigest: expectedDigest,
    fileHashes: Object.fromEntries(
      Object.entries(bundle.manifest.files).map(([name, entry]) => [
        name,
        entry.sha256,
      ]),
    ),
    workflowTrace: plan.order.map((node) => ({
      id: node.id,
      kind: node.kind,
      status:
        node.kind === "spark_sql"
          ? result.mainSqlExecuted
            ? "SUCCEEDED"
            : "FAILED"
          : node.kind === "sql_assertions"
            ? result.mainSqlExecuted
              ? checked
                ? "SUCCEEDED"
                : "FAILED"
              : "BLOCKED"
            : passed
              ? "SUCCEEDED"
              : "BLOCKED",
    })),
    notice:
      plan.deployment.adapter === "remote-spark-worker-v1"
        ? "已按调度/部署文件交给隔离Worker演练；不是定时触发，也未发布上线。"
        : "已按调度/部署文件解析并执行本机演练；不是定时调度触发，也未发布上线。",
  };
  if (!passed && !receipt.error)
    receipt.error = "运行、测试SQL、回归证据或引擎版本未满足交付清单";
  writeFileSync(
    join(directory, "verification-" + randomUUID() + ".json"),
    JSON.stringify(receipt, null, 2),
    { flag: "wx", mode: 0o600 },
  );
  return receipt;
}
