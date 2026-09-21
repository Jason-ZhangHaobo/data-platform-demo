import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const roleArn = /^acs:ram::(\d{12,20}):role\/[a-z0-9-]{1,64}$/;
const functionName = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const hash = (value) => createHash("sha256").update(String(value)).digest("hex");

export function renderV2W3InvokeBoundary(input = {}) {
  const accountId = input.ALIYUN_ACCOUNT_ID?.trim(),
    controlRole = input.V2_FUNCTION_ROLE_ARN?.trim(),
    workerName = input.V2_SPARK_WORKER_FUNCTION_NAME?.trim(),
    controlMatch = roleArn.exec(controlRole ?? ""),
    errors = [];
  if (!/^\d{12,20}$/.test(accountId ?? ""))
    errors.push("INVALID:ALIYUN_ACCOUNT_ID");
  if (!controlMatch) errors.push("INVALID:V2_FUNCTION_ROLE_ARN");
  if (controlMatch && accountId && controlMatch[1] !== accountId)
    errors.push("ACCOUNT_MISMATCH:V2_FUNCTION_ROLE_ARN");
  if (!functionName.test(workerName ?? ""))
    errors.push("INVALID:V2_SPARK_WORKER_FUNCTION_NAME");
  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    decision: "PENDING_USER_APPROVAL",
    current: {
      controlRoleHash: hash(controlRole),
      workerFunctionHash: hash(workerName),
      sharedRuntimeRoleMustBeSeparated: true,
    },
    options: {
      directInvoke: {
        implementationEffort: "LOW",
        policy: {
          Version: "1",
          Statement: [
            { Effect: "Allow", Action: "fc:InvokeFunction", Resource: "*" },
          ],
        },
        resourceScopedByRam: false,
        applicationTargetAllowlistRequired: true,
        dedicatedWorkerRuntimeRoleRequired: true,
        risk: "A compromised control runtime can invoke other account functions because FC does not expose a function-scoped RAM resource for this action.",
      },
      privateOssQueue: {
        implementationEffort: "HIGH",
        fcInvokePermissionOnControlRole: false,
        durable: true,
        recoverableAfterFreeze: true,
        requiredPieces: [
          "create-only signed job object",
          "OSS object-created trigger bound to the Worker",
          "immutable result object",
          "timeout, cancellation and orphan recovery",
          "dedicated trigger invocation role",
          "dedicated empty Worker runtime role",
        ],
        risk: "More code and trigger configuration must be validated before the control plane can use it.",
      },
    },
    recommendation: "PRIVATE_OSS_QUEUE",
    reason:
      "The product requires durable background work and rejects account-wide Invoke permission. OSS jobs also survive Function Compute freeze and restart.",
    rollback: {
      directInvoke: "Detach the single-action custom policy from the control runtime role.",
      privateOssQueue:
        "Disable the trigger, stop producing job objects and retain immutable evidence objects for audit.",
    },
    apply: false,
  };
}

function run() {
  const result = renderV2W3InvokeBoundary(process.env);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) run();
