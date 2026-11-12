import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  loadDeliveryDirectory,
  resolveDeliverySchedule,
  sha256,
  validationMatchesFamily,
} from "./delivery.mjs";
import { runSpark, runtimeConfig } from "./spark.mjs";
import { verifiedFundRun } from "./fund-delivery.mjs";
import { verifyFundSignedDelivery } from "./fund-signed-delivery.mjs";
import { assertSyncSqlOutputSchema, syncSqlColumnsMatch, syncSqlOutputSchemaCode, syncSqlOutputSchemaMessage, syncSqlRowsMatch } from "./sync-sql-input.mjs";

export function assertSyncSqlRehearsal(plan, bundle, receipt) {
  if (!plan.source.syncInput) return;
  const family = { id: plan.source.validationContractId, contextIds: plan.fixtures.validationContexts.map(context => context.id) };
  if (receipt.status !== "SUCCEEDED" || receipt.testDouble === true || receipt.mainSqlExecuted !== true ||
      receipt.engine !== "Apache Spark" || receipt.engineVersion !== plan.deployment.runtime.version ||
      receipt.packageDigest !== plan.digest || !isDeepStrictEqual(receipt.source, plan.source) ||
      receipt.published !== false || receipt.schedulerTriggered !== false || receipt.mode !== "LOCAL_FILE_REHEARSAL" ||
      receipt.occurrence?.businessDate !== plan.fixtures.context.businessDate ||
      !isDeepStrictEqual(receipt.fileHashes, Object.fromEntries(Object.entries(bundle.manifest.files).map(([name, entry]) => [name, entry.sha256]))) ||
      receipt.testSqlValidation?.passed !== true || receipt.testSqlValidation.sqlHash !== sha256(bundle.files["tests.sql"]) ||
      !validationMatchesFamily(receipt.validation, family) || receipt.validation.selectedPassed !== true ||
      !syncSqlRowsMatch(receipt.rows, plan.fixtures.context))
    throw Object.assign(Error("文件演练未证明原冻结批次的实际结果"), { status: 409 });
  assertSyncSqlOutputSchema(receipt.columns);
}

export async function verifyDeliveryDirectory(
  { directory, expectedDigest, scheduledFor, signal, beforeRun },
  options = {},
) {
  const { bundle, plan } = loadDeliveryDirectory(directory, expectedDigest);
  const input = plan.source.fundSignedExecution !== undefined || options.fundSignedExecution !== undefined
    ? verifyFundSignedDelivery(bundle, plan, options.fundSignedExecution)
    : { sql:bundle.files["main.sql"], testSql:bundle.files["tests.sql"],
      context:plan.fixtures.context, validationContexts:plan.fixtures.validationContexts };
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
  beforeRun?.();
  const raw = await runner({
    ...input,
    timeoutMs: plan.deployment.runtime.timeoutSeconds * 1000,
    signal,
  });
  const { directory: privateDirectory, ...result } = raw;
  const regressionIds = plan.fixtures.validationContexts.map(
    (context) => context.id,
  );
  const schemaMismatch = plan.source.syncInput && result.status === "SUCCEEDED" &&
    !syncSqlColumnsMatch(result.columns);
  const checked = Boolean(
    result.validation?.passed &&
      result.testSqlValidation?.passed &&
      result.testSqlValidation.sqlHash === sha256(bundle.files["tests.sql"]) &&
      (!plan.source.fundLookthrough || verifiedFundRun(result, plan.source.contextId)) &&
      !schemaMismatch &&
      (!plan.source.syncInput || result.testDouble !== true && result.validation.selectedPassed === true &&
        syncSqlRowsMatch(result.rows, plan.fixtures.context)) &&
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
    ...(schemaMismatch ? { error: syncSqlOutputSchemaMessage, errorCode: syncSqlOutputSchemaCode } : {}),
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
