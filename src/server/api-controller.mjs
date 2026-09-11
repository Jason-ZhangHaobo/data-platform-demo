import { analyzeSql, maskValue, validateAccessCheckInput, validateAgentConfirmInput, validateAgentPlanInput, validateAssetInput, validateDataSourceInput, validateDevJobInput, validateMaskingRuleInput, validateQualityRuleInput, validateStreamJobInput, validateTaskInput } from "../shared/validation.mjs";
import { planAgentRequest } from "./services/data-agent.mjs";
import { evaluationCases, runAgentEvaluation } from "./services/agent-evaluation.mjs";
import { searchSemanticContext } from "../shared/semantic-context.mjs";

const result = (status, body) => ({ status, body });
const taskRoute = (pathname) => {
  const match = pathname.match(/^\/api\/tasks\/([^/]+)(?:\/(runs|run|stop|toggle))?$/);
  return match ? { id: decodeURIComponent(match[1]), action: match[2] } : undefined;
};
const devJobRoute = (pathname) => {
  const match = pathname.match(/^\/api\/dev\/jobs\/([^/]+)(?:\/(runs|validate|run|deploy))?$/);
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
const qualityRuleRoute = (pathname) => {
  const match = pathname.match(/^\/api\/quality\/rules\/([^/]+)(?:\/(runs|run|toggle))?$/);
  return match ? { id: decodeURIComponent(match[1]), action: match[2] } : undefined;
};
const streamJobRoute = (pathname) => {
  const match = pathname.match(/^\/api\/stream\/jobs\/([^/]+)(?:\/(start|stop))?$/);
  return match ? { id: decodeURIComponent(match[1]), action: match[2] } : undefined;
};
const dataSourceRoute = (pathname) => {
  const match = pathname.match(/^\/api\/sources\/([^/]+)\/(test|metadata)$/);
  return match ? { id: decodeURIComponent(match[1]), action: match[2] } : undefined;
};
const dataContractRoute = (pathname) => {
  const match = pathname.match(/^\/api\/contracts\/([^/]+)$/);
  return match ? decodeURIComponent(match[1]) : undefined;
};
const opsIncidentRoute = (pathname) => {
  const match = pathname.match(/^\/api\/ops\/incidents\/([^/]+)\/(acknowledge|resolve)$/);
  return match ? { id: decodeURIComponent(match[1]), action: match[2] } : undefined;
};
const metadataProfiles = {
  MYSQL: { objectCount: 2, fieldCount: 9, sensitiveFieldCount: 5, assetPhysicalNames: ["dwd_investor_account", "dwd_order_trade"] },
  CSV: { objectCount: 1, fieldCount: 4, sensitiveFieldCount: 2, assetPhysicalNames: ["dws_position_snapshot"] },
  KAFKA: { objectCount: 1, fieldCount: 4, sensitiveFieldCount: 0, assetPhysicalNames: ["ods_security_master"] },
  HIVE_SPARK: { objectCount: 2, fieldCount: 8, sensitiveFieldCount: 3, assetPhysicalNames: ["dws_position_snapshot", "ads_fund_nav_metric"] },
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
    if (method === "GET" && pathname === "/api/ops/incidents") return result(200, await store.listOpsIncidents());
    const opsIncident = opsIncidentRoute(pathname);
    if (opsIncident) {
      const incident = await store.getOpsIncident(opsIncident.id);
      if (!incident) return result(404, { message: "未找到运维告警" });
      if (method !== "POST") return result(405, { message: "不支持的运维告警请求方法" });
      if (opsIncident.action === "acknowledge") {
        if (incident.status !== "OPEN") return result(409, { message: "只有未确认的告警可以确认" });
        const updated = await store.updateOpsIncident(incident.id, { status: "ACKNOWLEDGED", acknowledgedAt: new Date().toISOString(), acknowledgedBy: "数据运维组" });
        await store.createAuditLog({ actorId: "user-platform-admin", actorName: "许平台", action: "ops.acknowledge", resourceType: "ops_incident", resourceId: incident.id, sensitivity: "INTERNAL", result: "ALLOW", reason: "确认虚构运维告警并开始处置" });
        return result(200, updated);
      }
      if (incident.status !== "ACKNOWLEDGED") return result(409, { message: "请先确认告警，再标记恢复" });
      const updated = await store.updateOpsIncident(incident.id, { status: "RESOLVED", resolvedAt: new Date().toISOString(), resolvedBy: "数据运维组" });
      await store.createAuditLog({ actorId: "user-platform-admin", actorName: "许平台", action: "ops.resolve", resourceType: "ops_incident", resourceId: incident.id, sensitivity: "INTERNAL", result: "ALLOW", reason: "虚构告警已按处置手册恢复" });
      return result(200, updated);
    }
    if (method === "GET" && pathname === "/api/reports/holdings") return result(200, {
      reportName: "财富顾问客户持仓分析",
      generatedAt: new Date().toISOString(),
      scope: "OWN_CLIENTS_ONLY",
      freshness: "T+1 模拟数据",
      metrics: { totalAssets: 12_800_000, holdingMarketValue: 12_000_000, securityCount: 8 },
      assetClassDistribution: [{ name: "股票", value: 7_200_000, ratio: 60 }, { name: "债券", value: 3_600_000, ratio: 30 }, { name: "基金", value: 1_200_000, ratio: 10 }],
      industryDistribution: [{ name: "金融", value: 4_200_000, ratio: 35 }, { name: "信息技术", value: 3_000_000, ratio: 25 }, { name: "医药", value: 2_400_000, ratio: 20 }, { name: "其他", value: 2_400_000, ratio: 20 }],
      disclaimer: "虚构数据，仅用于学习演示，不构成投资建议。",
    });
    if (method === "GET" && pathname === "/api/semantic/context") return result(200, searchSemanticContext(query?.get("q") ?? ""));
    if (method === "GET" && pathname === "/api/tasks") return result(200, await store.listTasks());
    if (method === "POST" && pathname === "/api/tasks") return result(201, await store.createTask(validateTaskInput(body)));
    if (method === "GET" && pathname === "/api/dev/jobs") return result(200, await store.listDevJobs());
    if (method === "POST" && pathname === "/api/dev/jobs") return result(201, await store.createDevJob(validateDevJobInput(body)));
    if (method === "GET" && pathname === "/api/masking/rules") return result(200, await store.listMaskingRules());
    if (method === "POST" && pathname === "/api/masking/rules") return result(201, await store.createMaskingRule(validateMaskingRuleInput(body)));
    if (method === "GET" && pathname === "/api/assets") return result(200, await store.listAssets({ q: query?.get("q"), domain: query?.get("domain"), sensitivity: query?.get("sensitivity") }));
    if (method === "POST" && pathname === "/api/assets") return result(201, await store.createAsset(validateAssetInput(body)));
    if (method === "GET" && pathname === "/api/contracts") return result(200, await store.listDataContracts());
    const contractId = dataContractRoute(pathname);
    if (contractId) {
      const contract = await store.getDataContract(contractId);
      if (!contract) return result(404, { message: "未找到数据契约" });
      return method === "GET" ? result(200, contract) : result(405, { message: "不支持的数据契约请求方法" });
    }
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
    if (method === "GET" && pathname === "/api/agent/evaluation/cases") return result(200, evaluationCases);
    if (method === "GET" && pathname === "/api/agent/evaluation/runs") return result(200, await store.listAgentEvalRuns());
    if (method === "POST" && pathname === "/api/agent/evaluation/run") {
      const evaluation = runAgentEvaluation();
      const saved = await store.createAgentEvalRun(evaluation);
      return result(200, saved);
    }
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
      else if (plan.intent === "REALTIME_SYNC") execution = await store.createStreamJob(validateStreamJobInput(plan.draft));
      else if (plan.intent === "OPS_INCIDENT") {
        const incidents = await store.listOpsIncidents();
        const query = String(plan.draft.query ?? "").toLowerCase();
        const incident = incidents.find((item) => item.status === "OPEN" && [item.title, item.source, item.asset, item.impact].join(" ").toLowerCase().includes(query));
        if (!incident) return result(409, { message: "没有匹配的待处置虚构告警，请到运维监控确认当前状态" });
        const updated = await store.updateOpsIncident(incident.id, { status: "ACKNOWLEDGED", acknowledgedAt: new Date().toISOString(), acknowledgedBy: plan.draft.escalationOwner });
        await store.createAuditLog({ actorId: input.userId, actorName: input.userId, action: "agent.ops_acknowledge", resourceType: "ops_incident", resourceId: incident.id, sensitivity: "INTERNAL", result: "ALLOW", reason: "用户确认 Data Agent 运维诊断计划，转交数据运维组处置" });
        execution = { type: "OPS_INCIDENT", status: "ACKNOWLEDGED", incident: updated, impact: updated.impact, runbook: updated.runbook, opsUrl: plan.draft.opsUrl };
      }
      else if (plan.intent === "HOLDINGS_REPORT") {
        const createdDevJob = await store.createDevJob(validateDevJobInput(effectiveDraft.devJob ? { ...effectiveDraft.devJob, sql: effectiveDraft.sql } : { name: "财富顾问客户持仓分析 SQL", description: "Data Agent 生成的 Hive/Spark SQL 草稿，第一版仅模拟执行。", jobType: "SQL", sql: effectiveDraft.sql, schedule: "交易日 T+1 02:30", owner: "数据开发组", enabled: false }));
        const devJob = await store.updateDevJob(createdDevJob.id, { scheduleConfig: effectiveDraft.scheduleConfig, deploymentConfig: effectiveDraft.deploymentConfig, agentPlanId: plan.id });
        execution = { type: "HOLDINGS_REPORT", status: "DRAFT_CREATED", devJob, artifacts: { engine: effectiveDraft.engine, sql: effectiveDraft.sql, testSql: effectiveDraft.testSql, scheduleConfig: effectiveDraft.scheduleConfig, deploymentConfig: effectiveDraft.deploymentConfig }, reportSpec: effectiveDraft.reportSpec, permissionScope: effectiveDraft.permissionScope, reportUrl: "?view=holdings-report#holdings-report" };
      }
      else return result(409, { message: "当前计划没有可执行模块" });
      const completed = await store.updateAgentPlan(plan.id, { status: "COMPLETED", confirmedBy: input.userId, confirmedAt: new Date().toISOString(), execution });
      await store.createAuditLog({ actorId: input.userId, actorName: input.userId, action: "agent.confirm", resourceType: plan.intent, resourceId: plan.id, sensitivity: "INTERNAL", result: "ALLOW", reason: "用户确认 Data Agent 计划并执行" });
      return result(200, completed);
    }
    if (method === "GET" && pathname === "/api/quality/rules") return result(200, await store.listQualityRules());
    if (method === "POST" && pathname === "/api/quality/rules") return result(201, await store.createQualityRule(validateQualityRuleInput(body)));
    if (method === "GET" && pathname === "/api/quality/summary") {
      const rules = await store.listQualityRules();
      return result(200, { totalRules: rules.length, enabledRules: rules.filter((rule) => rule.enabled).length, passRules: rules.filter((rule) => rule.lastStatus === "PASS").length, warnRules: rules.filter((rule) => rule.lastStatus === "WARN").length, failRules: rules.filter((rule) => rule.lastStatus === "FAIL").length });
    }
    const quality = qualityRuleRoute(pathname);
    if (quality) {
      const rule = await store.getQualityRule(quality.id);
      if (!rule) return result(404, { message: "未找到对应质量规则" });
      if (method === "GET" && quality.action === "runs") return result(200, await store.listQualityRuns(rule.id));
      if (method === "POST" && quality.action === "toggle") return result(200, await store.updateQualityRule(rule.id, { enabled: !rule.enabled }));
      if (method === "POST" && quality.action === "run") {
        if (!rule.enabled) return result(409, { message: "请先启用质量规则" });
        const metrics = { NOT_NULL: { score: 100, status: "PASS", observed: "0 个空值" }, UNIQUE: { score: 98, status: "PASS", observed: "重复率 0.2%" }, ROW_COUNT: { score: 100, status: "PASS", observed: "读取 1280 行" }, FRESHNESS: { score: 92, status: "WARN", observed: "延迟 18 分钟" } }[rule.ruleType] ?? { score: 0, status: "FAIL", observed: "无法识别规则" };
        const run = await store.createQualityRun({ ruleId: rule.id, status: metrics.status, score: metrics.score, observed: metrics.observed, rowsChecked: 1280, message: metrics.status === "PASS" ? "质量检查通过。" : "质量检查有提醒，请关注时效。" });
        await store.updateQualityRule(rule.id, { lastStatus: metrics.status, lastScore: metrics.score });
        return result(200, run);
      }
      return result(405, { message: "不支持的质量规则请求方法" });
    }
    if (method === "GET" && pathname === "/api/stream/jobs") return result(200, await store.listStreamJobs());
    if (method === "POST" && pathname === "/api/stream/jobs") return result(201, await store.createStreamJob(validateStreamJobInput(body)));
    if (method === "GET" && pathname === "/api/sources") return result(200, await store.listDataSources());
    if (method === "POST" && pathname === "/api/sources") return result(201, await store.createDataSource(validateDataSourceInput(body)));
    const sourceRoute = dataSourceRoute(pathname);
    if (sourceRoute) {
      const source = await store.getDataSource(sourceRoute.id);
      if (!source) return result(404, { message: "未找到数据源" });
      if (method === "POST" && sourceRoute.action === "test") return result(200, await store.updateDataSource(sourceRoute.id, { status: source.sourceType === "KAFKA" || source.sourceType === "HIVE_SPARK" ? "SIMULATED" : "CONNECTED", lastTestAt: new Date().toISOString() }));
      if (method === "GET" && sourceRoute.action === "metadata") return result(200, { source, metadata: source.metadata ?? null });
      if (method === "POST" && sourceRoute.action === "metadata") {
        if (source.status === "NOT_TESTED") return result(409, { message: "请先完成连接测试，再采集元数据" });
        const profile = metadataProfiles[source.sourceType] ?? { objectCount: 0, fieldCount: 0, sensitiveFieldCount: 0, assetPhysicalNames: [] };
        const metadata = { status: "COLLECTED", collectedAt: new Date().toISOString(), classification: "SIMULATED", ...profile };
        return result(200, await store.updateDataSource(sourceRoute.id, { metadata }));
      }
      return result(405, { message: "不支持的数据源请求方法" });
    }
    const stream = streamJobRoute(pathname);
    if (stream) {
      const job = await store.getStreamJob(stream.id);
      if (!job) return result(404, { message: "未找到实时任务" });
      if (method === "POST" && stream.action === "start") return result(200, await store.updateStreamJob(job.id, { status: "RUNNING", enabled: true, metrics: { lagMs: 420, throughput: 1280, events: 1280 } }));
      if (method === "POST" && stream.action === "stop") return result(200, await store.updateStreamJob(job.id, { status: "STOPPED", enabled: false }));
      if (method === "GET" && !stream.action) return result(200, job);
      return result(405, { message: "不支持的实时任务请求方法" });
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
      if (method === "GET" && !devRoute.action) return result(200, job);
      if (method === "GET" && devRoute.action === "runs") return result(200, await store.listDevRuns(job.id));
      if (method === "POST" && devRoute.action === "validate") return result(200, { ...analyzeSql(job.sql), jobId: job.id });
      if (method === "POST" && devRoute.action === "deploy") {
        if (job.release?.status === "PUBLISHED") return result(409, { message: "任务已经发布到模拟调度环境" });
        const analysis = analyzeSql(job.sql);
        if (!analysis.valid) return result(400, { message: "SQL 校验未通过", ...analysis });
        const blockingWarnings = analysis.warnings.filter((warning) => /高风险|缺少 WHERE/.test(warning));
        if (blockingWarnings.length) return result(409, { message: "发布被风险校验拦截", warnings: blockingWarnings });
        const release = {
          status: "PUBLISHED",
          releasedAt: new Date().toISOString(),
          environment: job.deploymentConfig?.environment ?? "staging",
          platform: job.deploymentConfig?.platform ?? "local-simulator",
          artifact: job.deploymentConfig?.artifact ?? job.name,
          schedule: job.scheduleConfig ?? { frequency: job.schedule, approval: "human_confirmation", rollback: true },
          mode: "SIMULATED",
        };
        const published = await store.updateDevJob(job.id, { enabled: true, status: "PUBLISHED", release });
        await store.createAuditLog({ actorId: "user-platform-admin", actorName: "许平台", action: "dev.deploy", resourceType: "dev_job", resourceId: job.id, sensitivity: "INTERNAL", result: "ALLOW", reason: "发布到虚构 staging 调度环境" });
        return result(200, published);
      }
      if (method === "POST" && devRoute.action === "run") {
        if (!job.enabled) return result(409, { message: "请先启用数据开发任务" });
        const analysis = analyzeSql(job.sql);
        if (!analysis.valid) return result(400, { message: "SQL 校验未通过", ...analysis });
        const startedAt = new Date().toISOString();
        const run = await store.createDevRun({ jobId: job.id, status: "RUNNING", startedAt, message: "正在模拟提交 SQL 执行……" });
        await store.updateDevJob(job.id, { status: "RUNNING" });
        await new Promise((resolve) => setTimeout(resolve, simulationDelayMs));
        const completed = await store.updateDevRun(run.id, { status: "SUCCESS", finishedAt: new Date().toISOString(), rowsAffected: 128, message: "SQL 模拟执行完成，未连接真实生产数据。" });
        await store.updateDevJob(job.id, { status: job.release?.status === "PUBLISHED" ? "PUBLISHED" : "SUCCESS" });
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
