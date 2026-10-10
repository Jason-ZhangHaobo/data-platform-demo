import { randomUUID } from "node:crypto";
import { durableSqlAgentMode } from "./durable-agent.mjs";

export const agentTickProtocol = "shuduo-private-agent-tick/v1";
const fail = (status, code) => Object.assign(new Error(code), { status, code });
const safeCode = error => /^[A-Z][A-Z0-9_]{2,64}$/.test(error?.code ?? "") ? error.code : "AGENT_TICK_STEP_FAILED";

// A bounded IAM-private invocation, not an in-process timer. The caller must
// keep supplying ticks; durable checkpoints survive caller/service restarts.
export function createAgentDispatcher({ store, project, engine, persist, now = Date.now,
  leaseMs = 120000, cooldownMs = 5000 }) {
  if (!engine || !Number.isSafeInteger(leaseMs) || leaseMs < 120000 || leaseMs > 300000 ||
      !Number.isSafeInteger(cooldownMs) || cooldownMs < 1000 || cooldownMs > 60000)
    throw new Error("Agent 后台推进配置不合法");
  const response = (state, rest = {}) => ({ protocol: agentTickProtocol, state, ...rest });
  const allowed = task => {
    const user = store.get("auth_user", task.submittedBy, project);
    return user?.status === "ACTIVE" && user.memberships?.some(m => m.projectId === project && ["ADMIN", "ENGINEER"].includes(m.role));
  };
  const checkpoint = task => {
    const item = store.deduplicate(`${project}:agent-dispatch-state:${task.id}`, task.id,
      () => store.create("agent_dispatch_state", project, { taskId: task.id, nextAt: 0, lastAt: 0, failures: 0 }));
    return store.get("agent_dispatch_state", item.id, project);
  };

  async function tick({ requestId } = {}) {
    if (typeof requestId !== "string" || !/^[a-f0-9-]{36}$/.test(requestId)) throw fail(422, "AGENT_TICK_REQUEST_INVALID");
    const prior = store.list("agent_tick", project).find(t => t.requestId === requestId);
    if (prior) return prior.result ?? response("IN_PROGRESS", { requestId });
    const guard = store.deduplicate(`${project}:agent-dispatch-guard`, "v1",
      () => store.create("agent_dispatch_guard", project, { expiresAt: 0 }));
    const currentGuard = store.get("agent_dispatch_guard", guard.id, project);
    if (currentGuard.expiresAt > now()) return response("BUSY");
    const tasks = store.list("agent", project).filter(t => t.executionMode === durableSqlAgentMode &&
      ["QUEUED", "RUNNING", "INTERRUPTED"].includes(t.status) && t.stage !== "MODEL_OUTCOME_UNKNOWN");
    // Respect an in-flight model lease, including one started by a manual call.
    if (tasks.some(t => t.stage === "MODEL_IN_FLIGHT" && Date.parse(t.durable.leaseExpiresAt) > now()))
      return response("BUSY");
    const candidates = tasks.map(task => ({ task, state: checkpoint(task) }))
      .filter(({ task, state }) => state.nextAt <= now() &&
        (state.failures < 3 || state.taskVersion !== task.version) && (allowed(task) || task.stage === "CANCELLING"))
      .sort((a, b) => a.state.lastAt - b.state.lastAt || a.task.createdAt.localeCompare(b.task.createdAt));
    if (!candidates.length) return response("IDLE", { pending: tasks.length });
    const { task, state } = candidates[0], token = randomUUID();
    const receipt = store.deduplicate(`${project}:agent-tick:${requestId}`, "v1", () => {
      store.update("agent_dispatch_guard", guard.id, project, { token, expiresAt: now() + leaseMs }, { expectedVersion: currentGuard.version });
      return store.create("agent_tick", project, { requestId, taskId: task.id, startedAt: now(), token });
    });
    await persist(); // No model or queue side effects until the claim is durable.
    const owns = () => {
      const lease = store.get("agent_dispatch_guard", guard.id, project);
      return lease.token === token && lease.expiresAt > now();
    };
    if (!owns()) return response("LEASE_EXPIRED", { requestId });
    let result, failed = false;
    try {
      const fresh = store.get("agent", task.id, project);
      if (!allowed(fresh) && fresh.stage !== "CANCELLING") throw fail(403, "AGENT_OWNER_PERMISSION_REVOKED");
      const advanced = await engine.advance(task.id, { expectedVersion: fresh.version });
      result = response("ADVANCED", { requestId, taskId: task.id, status: advanced.status, stage: advanced.stage });
    } catch (error) {
      failed = true;
      result = response("STEP_FAILED", { requestId, taskId: task.id, code: safeCode(error) });
    }
    // A late tick must not overwrite a newer driver's lease or dispatch state.
    if (!owns()) return response("LEASE_EXPIRED", { requestId });
    const taskVersion = store.get("agent", task.id, project).version;
    const failures = failed ? (state.taskVersion === task.version ? state.failures : 0) + 1 : 0;
    store.update("agent_dispatch_state", state.id, project, { lastAt: now(), failures,
      taskVersion, ...(failed ? { lastCode: result.code } : { lastCode: undefined }),
      nextAt: now() + Math.min(60000, cooldownMs * 2 ** Math.min(failures, 4)) }, { expectedVersion: state.version });
    store.update("agent_tick", receipt.id, project, { result, finishedAt: now() });
    const lease = store.get("agent_dispatch_guard", guard.id, project);
    store.update("agent_dispatch_guard", guard.id, project, { token: undefined, expiresAt: 0 }, { expectedVersion: lease.version });
    await persist();
    return result;
  }
  return { tick };
}
