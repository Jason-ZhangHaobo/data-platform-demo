import { analyzeSql, maskValue, validateDevJobInput, validateMaskingRuleInput, validateTaskInput } from "../shared/validation.mjs";

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

export function createApiController({ store, simulationDelayMs = 1_200, environment = "local", accessToken, requireAccessToken = false, syncService, realSyncEnabled = false }) {
  return async function handle({ method, pathname, body = {}, headers = {} }) {
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
