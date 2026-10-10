import { createHash } from "node:crypto";
import { getContext, contextIds } from "./context.mjs";

const fail = (status, code) => Object.assign(new Error(code), { status, code });
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const money = value => {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) throw fail(422, "RECOVERY_AMOUNT_INVALID");
  return (BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"))).toString();
};
const normalized = rows => rows.map(row => ({ client_id: row.client_id,
  holding_market_value: money(row.holding_market_value), available_cash: money(row.available_cash),
  total_assets: money(row.total_assets), security_count: String(row.security_count),
})).sort((a, b) => a.client_id.localeCompare(b.client_id));

// Fixed fictional fixture only, callable inside the existing IAM-private gate.
// No user SQL, credentials, URLs, arbitrary account changes or kill operation.
export async function privateAgentRecovery(input, { store, project, engine, persist, bootId }) {
  if (!input || input.operation !== "PRIVATE_AGENT_RECOVERY_V1" ||
      Object.keys(input).some(k => !["operation", "action", "requestId", "taskId"].includes(k)) ||
      !["prepare", "generate", "read", "finish"].includes(input.action) ||
      Boolean(input.requestId) === Boolean(input.taskId) ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(input.requestId ?? input.taskId ?? "") ||
      (input.taskId && !["read", "finish"].includes(input.action)))
    throw fail(422, "PRIVATE_AGENT_RECOVERY_INVALID");
  if (!engine) throw fail(503, "DURABLE_AGENT_DISABLED");
  let record = store.list("agent_recovery_acceptance", project).find(r => input.taskId ? r.taskId === input.taskId : r.requestId === input.requestId);
  if (!record && input.action !== "prepare") throw fail(404, "RECOVERY_FIXTURE_NOT_FOUND");
  if (input.action === "prepare" && !record) {
    const receipt = store.deduplicate(`${project}:agent-recovery-fixture:${input.requestId}`, "v1", () => {
      const actor = store.create("auth_user", project, { status: "ACTIVE", displayName: "虚构证券恢复验收",
        source: "PRIVATE_AGENT_RECOVERY", memberships: [{ projectId: project, role: "ENGINEER" }] });
      return store.create("agent_recovery_acceptance", project, { requestId: input.requestId, actorId: actor.id, initialBootId: bootId });
    });
    record = store.get("agent_recovery_acceptance", receipt.id, project);
    await persist();
  }
  if (input.action === "prepare" && !record.taskId) {
    const task = await engine.create({ actorId: record.actorId, idempotencyKey: `recovery-${input.requestId}`,
      contextId: "holdings-t1", currentSql: "SELECT 1 AS pending",
      message: "按给定口径生成T+1客户资产Spark SQL，输出客户、持仓市值、可用现金、总资产、去重证券数量。独立汇总现金，按position_id去重持仓，包含仅有现金的客户。不要使用预设答案，先编写并验证代码。" });
    record = store.update("agent_recovery_acceptance", record.id, project, { taskId: task.id });
    await persist();
  }
  if (!record.taskId) throw fail(409, "RECOVERY_PREPARATION_INCOMPLETE");
  let task = store.get("agent", record.taskId, project);
  if (input.action === "generate" && task.stage === "READY_FOR_MODEL" && task.attempts.length === 0)
    await engine.advance(task.id, { expectedVersion: task.version });
  task = store.get("agent", record.taskId, project);
  const revision = task.revisionId && store.get("revision", task.revisionId, project);
  const run = task.runId && store.get("run", task.runId, project);
  let independentResultMatches = false;
  try { independentResultMatches = Array.isArray(run?.rows) && hash(normalized(run.rows)) === hash(normalized(getContext("holdings-t1").expected)); } catch {}
  const realModel = task.attempts.length > 0 && task.attempts.every(a => typeof a.model === "string" &&
    !/test|mock|synthetic|unconfirmed/i.test(a.model) && a.usageEstimated === false);
  const verified = task.status === "SUCCEEDED" && realModel && independentResultMatches &&
    run?.engine === "Apache Spark" && run.engineVersion === "3.5.9" && run.mainSqlExecuted === true &&
    run.validation?.passed === true && contextIds.every(id => run.validation.regressions?.some(r => r.contextId === id && r.passed));
  if (input.action === "finish") {
    if (!["SUCCEEDED", "FAILED", "CANCELLED"].includes(task.status)) throw fail(409, "RECOVERY_TASK_STILL_ACTIVE");
    const actor = store.get("auth_user", record.actorId, project);
    if (actor?.source !== "PRIVATE_AGENT_RECOVERY") throw fail(409, "RECOVERY_ACTOR_BOUNDARY_INVALID");
    store.update("auth_user", actor.id, project, { status: "DISABLED" });
    await persist();
  }
  return { protocol: "shuduo-private-agent-recovery/v1", requestId: record.requestId, bootId,
    initialBootId: record.initialBootId, differentRuntimeInstance: bootId !== record.initialBootId,
    taskId: task.id, taskVersion: task.version, stage: task.stage, status: task.status,
    revisionId: revision?.id, revisionHash: revision?.hash, runId: run?.id,
    attempts: task.attempts.map(a => ({ model: a.model, usage: a.usage, usageEstimated: a.usageEstimated, status: a.status, revisionId: a.revisionId, runId: a.runId })),
    usedTokens: task.usedTokens, engine: run?.engine, engineVersion: run?.engineVersion,
    regressionCount: run?.validation?.regressions?.length ?? 0, independentResultMatches,
    realModel, verified, fullLifecycleE2E: false, publicDeployed: false };
}
