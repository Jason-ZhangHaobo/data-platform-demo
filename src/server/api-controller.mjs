import { analyzeSql, maskValue, validateAccessCheckInput, validateAgentConfirmInput, validateAgentPlanInput, validateAssetInput, validateDevJobInput, validateMaskingRuleInput, validateTaskInput } from "../shared/validation.mjs";
import { planAgentRequest } from "./services/data-agent.mjs";

const result = (status, body) => ({ status, body });
const taskRoute = (pathname) => {
  const match = pathname.match(/^\/api\/tasks\/([^/]+)(?:\/(runs|run|stop|toggle))?$/);
  return match ? { id: decodeURIComponent(match[1]), action: match[2] } : undefined;
};
const devJobRoute = (pathname) => {
  const match = pathname.match(/^\/api\/dev\/jobs\/([^/]+)(?:\/(runs|validate|run))?$/);
  return match ? { id: decodeURIComponent(match[1]), action: match[2] } : undefined;
};
const maskingRoute = (pathname) => {
  const match = pathname.match(/^\/api\/masking\/rules\/([^/]+)(?:\/(preview|toggle))?$/);
  return match ? { id: decodeURIComponent(match[1]), action: match[2] } : undefined;
};
const assetRoute = (pathname) => {
  const match = pathname.match(/^\/api\/assets\/([^/]+)$/);
  return match ? { id: decodeURIComponent(match[1]) } : undefined;
};
const securitySensitivityRank = { PUBLIC: 0, INTERNAL: 1, SENSITIVE: 2, RESTRICTED: 3 };
const agentPlanRoute = (pathname) => {
  const match = pathname.match(/^\/api\/agent\/plans\/([^/]+)\/confirm$/);
  return match ? decodeURIComponent(match[1]) : undefined;
};

export function createApiController({ store, simulationDelayMs = 1_200, environment = "local", accessToken, requireAccessToken = false, syncService, realSyncEnabled = false }) {
  return async function handle({ method, pathname, body = {}, headers = {}, query }) {
    if (method === "GET" && pathname === "/api/health") return result(200, { status: "ok", service: "data-platform-demo", environment, time: new Date().toISOString() });
    const protectedApi = pathname.startsWith("/api/") && pathname !== "/api/health";
    if (protectedApi && requireAccessToken) {
      if (!accessToken) return result(503, { message: "服务未配置演示访问码" });
      if (headers.authorization !== `Bearer ${accessToken}`) return result(401, { message: "请输入正确的演示访问码" });
    }
    if (method === "GET" && pathname === "/api/summary") return result(200, await store.getSummary());
    if (method === "GET" && pathname === "/api/tasks") return result(200, await store.listTasks());
    if (method === "POST" && pathname === "/api/tasks") return result(201, await store.createTask(validateTaskInput(body)));
    if (method === "GET" && pathname === "/api/dev/jobs") return result(200, await store.listDevJobs());
    if (method === "POST" && pathname === "/api/dev/jobs") return result(201, await store.createDevJob(validateDevJobInput(body)));
    if (method === "GET" && pathname === "/api/masking/rules") return result(200, await store.listMaskingRules());
    if (method === "POST" && pathname === "/api/masking/rules") return result(201, await store.createMaskingRule(validateMaskingRuleInput(body)));
    if (method === "GET" && pathname === "/api/assets") return result(200, await store.listAssets({ q: query?.get("q"), domain: query?.get("domain"), sensitivity: query?.get("sensitivity") }));
    if (method === "POST" && pathname === "/api/assets") return result(201, await store.createAsset(validateAssetInput(body)));
    if (method === "GET" && pathname === "/api/security/users") return result(200, await store.listSecurityUsers());
    if (method === "GET" && pathname === "/api/security/roles") return result(200, await store.listSecurityRoles());
    if (method === "GET" && pathname === "/api/security/audit") return result(200, await store.listAuditLogs({ q: query?.get("q"), result: query?.get("result") }));
    if (method === "POST" && pathname === "/api/security/access-check") {
      const input = validateAccessCheckInput(body);
      const user = await store.getSecurityUser(input.userId);
      const roles = await store.listSecurityRoles();
      const userRoles = user ? roles.filter((role) => user.roleIds.includes(role.id) && role.enabled !== false) : [];
      const allowed = Boolean(user && user.status === "ACTIVE" && userRoles.some((role) => role.permissions.includes(input.permission) && securitySensitivityRank[input.sensitivity] <= securitySensitivityRank[role.maxSensitivity]));
      const reason = !user ? "未找到演示用户" : user.status !== "ACTIVE" ? "用户已停用" : allowed ? "角色权限与敏感等级均满足要求" : "角色权限或最高可访问敏感等级不足";
      const audit = await store.createAuditLog({ actorId: input.userId, actorName: user?.name ?? "未知用户", action: input.permission, resourceType: input.resourceType, resourceId: "security-access-check", sensitivity: input.sensitivity, result: allowed ? "ALLOW" : "DENY", reason });
      return result(200, { allowed, reason, user: user?.name, roles: userRoles.map((role) => role.name), auditId: audit.id });
    }
    if (method === "GET" && pathname === "/api/agent/plans") return result(200, await store.listAgentPlans());
    if (method === "POST" && pathname === "/api/agent/plan") {
      const input = validateAgentPlanInput(body);
      const plan = planAgentRequest(input.message);
      const created = await store.createAgentPlan({ ...plan, userId: input.userId, message: input.message });
      await store.createAuditLog({ actorId: input.userId, actorName: input.userId, action: "agent.plan", resourceType: "agent_plan", resourceId: created.id, sensitivity: "INTERNAL", result: "ALLOW", reason: "生成 Data Agent 计划，不执行写入" });
      return result(201, created);
    }
    const agentPlanId = agentPlanRoute(pathname);
    if (method === "POST" && agentPlanId) {
      const input = validateAgentConfirmInput(body);
      const plan = await store.getAgentPlan(agentPlanId);
      if (!plan) return result(404, { message: "未找到 Data Agent 计划" });
      if (plan.userId !== input.userId) return result(403, { message: "只能由原计划用户确认执行" });
      if (plan.questions?.length) return result(409, { message: "计划仍有待澄清问题，请先补充信息", questions: plan.questions });
      const effectiveDraft = input.draft ? { ...plan.draft, ...input.draft } : plan.draft;
      let execution;
      if (plan.intent === "SYNC_TASK") execution = await store.createTask(validateTaskInput(plan.draft));
      else if (plan.intent === "MASKING_RULE") execution = await store.createMaskingRule(validateMaskingRuleInput(plan.draft));
      else if (plan.intent === "DEV_JOB") execution = await store.createDevJob(validateDevJobInput(plan.draft));
      else if (plan.intent === "ASSET_SEARCH") execution = await store.listAssets({ q: plan.draft.query });
      else if (plan.intent === "HOLDINGS_REPORT") {
        const devJob = await store.createDevJob(validateDevJobInput(effectiveDraft.devJob ? { ...effectiveDraft.devJob, sql: effectiveDraft.sql } : { name: "财富顾问客户持仓分析 SQL", description: "Data Agent 生成的 Hive/Spark SQL 草稿，第一版仅模拟执行。", jobType: "SQL", sql: effectiveDraft.sql, schedule: "交易日 T+1 02:30", owner: "数据开发组", enabled: false }));
        execution = { type: "HOLDINGS_REPORT", status: "DRAFT_CREATED", devJob, artifacts: { engine: effectiveDraft.engine, sql: effectiveDraft.sql, testSql: effectiveDraft.testSql, scheduleConfig: effectiveDraft.scheduleConfig, deploymentConfig: effectiveDraft.deploymentConfig }, reportSpec: effectiveDraft.reportSpec, permissionScope: effectiveDraft.permissionScope };
      }
      else return result(409, { message: "当前计划没有可执行模块" });
      const completed = await store.updateAgentPlan(plan.id, { status: "COMPLETED", confirmedBy: input.userId, confirmedAt: new Date().toISOString(), execution });
      await store.createAuditLog({ actorId: input.userId, actorName: input.userId, action: "agent.confirm", resourceType: plan.intent, resourceId: plan.id, sensitivity: "INTERNAL", result: "ALLOW", reason: "用户确认 Data Agent 计划并执行" });
      return result(200, completed);
    }

    const asset = assetRoute(pathname);
    if (asset) {
      const item = await store.getAsset(asset.id);
      if (!item) return result(404, { message: "未找到对应数据资产" });
      if (method === "GET") return result(200, item);
      return result(405, { message: "不支持的数据资产请求方法" });
    }

    const masking = maskingRoute(pathname);
    if (masking) {
      const rule = await store.getMaskingRule(masking.id);
      if (!rule) return result(404, { message: "未找到对应脱敏规则" });
      if (method === "POST" && masking.action === "toggle") return result(200, await store.updateMaskingRule(rule.id, { enabled: !rule.enabled }));
      if (method === "POST" && masking.action === "preview") {
        const sampleValue = typeof body.value === "string" && body.value.trim() ? body.value.trim() : rule.sampleValue;
        const maskedValue = rule.enabled ? maskValue(rule.strategy, sampleValue) : sampleValue;
        const preview = await store.createMaskingPreview({ ruleId: rule.id, fieldName: rule.fieldName, strategy: rule.strategy, input: sampleValue, output: maskedValue, operator: typeof body.operator === "string" ? body.operator.slice(0, 40) : "演示用户" });
        await store.updateMaskingRule(rule.id, { previewCount: (rule.previewCount ?? 0) + 1 });
        return result(200, { ...preview, ruleName: rule.name, enabled: rule.enabled });
      }
      if (method === "GET" && masking.action === "preview") return result(200, await store.listMaskingPreviews(rule.id));
      return result(405, { message: "不支持的脱敏规则请求方法" });
    }

    const devRoute = devJobRoute(pathname);
    if (devRoute) {
      const job = await store.getDevJob(devRoute.id);
      if (!job) return result(404, { message: "未找到对应数据开发任务" });
      if (method === "GET" && devRoute.action === "runs") return result(200, await store.listDevRuns(job.id));
      if (method === "POST" && devRoute.action === "validate") return result(200, { ...analyzeSql(job.sql), jobId: job.id });
      if (method === "POST" && devRoute.action === "run") {
        if (!job.enabled) return result(409, { message: "请先启用数据开发任务" });
        const analysis = analyzeSql(job.sql);
        if (!analysis.valid) return result(400, { message: "SQL 校验未通过", ...analysis });
        const startedAt = new Date().toISOString();
        const run = await store.createDevRun({ jobId: job.id, status: "RUNNING", startedAt, message: "正在模拟提交 SQL 执行……" });
        await store.updateDevJob(job.id, { status: "RUNNING" });
        await new Promise((resolve) => setTimeout(resolve, simulationDelayMs));
        const completed = await store.updateDevRun(run.id, { status: "SUCCESS", finishedAt: new Date().toISOString(), rowsAffected: 128, message: "SQL 模拟执行完成，未连接真实生产数据。" });
        await store.updateDevJob(job.id, { status: "SUCCESS" });
        return result(200, completed);
      }
      return result(405, { message: "不支持的数据开发请求方法" });
    }

    const route = taskRoute(pathname);
    if (!route) return pathname.startsWith("/api/") ? result(404, { message: "未找到对应资源" }) : undefined;
    const task = await store.getTask(route.id);
    if (!task) return result(404, { message: "未找到对应资源" });
    if (method === "GET" && !route.action) return result(200, task);
    if (method === "PUT" && !route.action) return result(200, await store.updateTask(route.id, validateTaskInput(body)));
    if (method === "DELETE" && !route.action) { await store.deleteTask(route.id); return result(204); }
    if (method === "GET" && route.action === "runs") return result(200, await store.listRuns(route.id));
    if (method === "POST" && route.action === "toggle") {
      if (task.status === "RUNNING") return result(409, { message: "运行中的任务不能直接停用" });
      const enabled = !task.enabled;
      return result(200, await store.updateTask(task.id, { enabled, status: enabled ? "READY" : "STOPPED" }));
    }
    if (method === "POST" && route.action === "run") {
      if (!task.enabled) return result(409, { message: "请先启用任务" });
      if (task.status === "RUNNING") return result(409, { message: "任务已经在运行" });
      const startedAt = new Date().toISOString();
      const run = await store.createRun({ taskId: task.id, status: "RUNNING", startedAt, rowsRead: 0, rowsWritten: 0, message: "正在模拟读取源端数据……" });
      await store.updateTask(task.id, { status: "RUNNING", lastRunAt: startedAt });
      if (realSyncEnabled && task.sourceType === "CSV" && task.targetType === "MySQL") {
        try {
          if (!syncService) throw new Error("真实同步服务未配置");
          const completed = await syncService.runTask(task);
          const completedRun = await store.updateRun(run.id, { status: "SUCCESS", finishedAt: new Date().toISOString(), ...completed });
          await store.updateTask(task.id, { status: "SUCCESS", lastRunAt: startedAt });
          return result(200, completedRun);
        } catch (error) {
          await store.updateRun(run.id, { status: "FAILED", finishedAt: new Date().toISOString(), message: error.message });
          await store.updateTask(task.id, { status: "FAILED", lastRunAt: startedAt });
          throw error;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, simulationDelayMs));
      const current = await store.getTask(task.id);
      if (!current || current.status !== "RUNNING") {
        const stoppedRun = (await store.listRuns(task.id)).find((item) => item.id === run.id);
        return result(200, stoppedRun ?? run);
      }
      const rows = 1_000 + Math.floor(Math.random() * 18_000);
      const completedRun = await store.updateRun(run.id, { status: "SUCCESS", finishedAt: new Date().toISOString(), rowsRead: rows, rowsWritten: rows, message: "模拟执行完成，源端与目标端记录数一致。" });
      await store.updateTask(task.id, { status: "SUCCESS", lastRunAt: startedAt });
      return result(200, completedRun);
    }
    if (method === "POST" && route.action === "stop") {
      if (task.status !== "RUNNING") return result(409, { message: "只有运行中的任务可以停止" });
      const runningRun = (await store.listRuns(task.id)).find((run) => run.status === "RUNNING");
      if (runningRun) await store.updateRun(runningRun.id, { status: "STOPPED", finishedAt: new Date().toISOString(), message: "用户手动停止了模拟任务。" });
      return result(200, await store.updateTask(task.id, { status: "STOPPED" }));
    }
    return result(405, { message: "不支持的请求方法" });
  };
}
