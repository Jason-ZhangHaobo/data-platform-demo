import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mergeSecretBundle } from "./export-v2-staging-secret-bundle.mjs";
import { validateV2StagingConfig } from "./verify-v2-staging-config.mjs";

const boundedSecret = (value) =>
  typeof value === "string" &&
  value.length >= 32 &&
  value.length <= 512 &&
  !/[\r\n\u0000]/.test(value);

export function validateV2ProtectedConfig(input = {}) {
  let effective;
  try {
    effective = mergeSecretBundle(input);
  } catch {
    return { ok: false, missing: [], errors: ["JASONSECRETS_FORMAT_INVALID"] };
  }
  const staging = validateV2StagingConfig(effective),
    missing = [...staging.missing],
    errors = [...staging.errors],
    workerSecret = effective.V2_SPARK_EXECUTOR_SECRET,
    schedulerSecret = effective.V2_SCHEDULER_TICK_SECRET;
  if (!workerSecret) missing.push("V2_SPARK_EXECUTOR_SECRET");
  else if (!boundedSecret(workerSecret))
    errors.push("INVALID_VALUE:V2_SPARK_EXECUTOR_SECRET");
  if (!schedulerSecret) missing.push("V2_SCHEDULER_TICK_SECRET");
  else if (!boundedSecret(schedulerSecret))
    errors.push("INVALID_VALUE:V2_SCHEDULER_TICK_SECRET");
  const sourceKeys = [
      "V2_MYSQL_SOURCE_HOST",
      "V2_MYSQL_SOURCE_PORT",
      "V2_MYSQL_SOURCE_USER",
      "V2_MYSQL_SOURCE_PASSWORD",
      "V2_MYSQL_SOURCE_DATABASE",
    ],
    sourceCount = sourceKeys.filter((key) => Boolean(effective[key])).length;
  if (sourceCount > 0 && sourceCount !== sourceKeys.length)
    errors.push("V2_MYSQL_SOURCE_CONFIG_PARTIAL");
  const uniqueMissing = [...new Set(missing)],
    uniqueErrors = [...new Set(errors)];
  return {
    ok: uniqueMissing.length === 0 && uniqueErrors.length === 0,
    missing: uniqueMissing,
    errors: uniqueErrors,
    present: {
      platformMysql:
        [
          "V2_MYSQL_HOST",
          "V2_MYSQL_USER",
          "V2_MYSQL_PASSWORD",
          "V2_MYSQL_DATABASE",
        ].every((key) => Boolean(effective[key])),
      bootstrapAdmin:
        [
          "V2_BOOTSTRAP_ADMIN_EMAIL",
          "V2_BOOTSTRAP_ADMIN_PASSWORD_HASH",
        ].every((key) => Boolean(effective[key])),
      model: Boolean(effective.DASHSCOPE_API_KEY),
      worker: boundedSecret(workerSecret),
      scheduler: boundedSecret(schedulerSecret),
      sourceMysql: sourceCount === sourceKeys.length,
    },
    containsSecretValues: false,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = validateV2ProtectedConfig(process.env);
  process.stdout.write(JSON.stringify(result) + "\n");
  if (!result.ok) process.exitCode = 1;
}

