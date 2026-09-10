const statusMeta = {
  DRAFT: ["草稿", "neutral"], READY: ["待运行", "info"], RUNNING: ["运行中", "running"],
  SUCCESS: ["成功", "success"], FAILED: ["失败", "danger"], STOPPED: ["已停用", "neutral"],
};
const devStatusMeta = { DRAFT: ["草稿", "neutral"], READY: ["待发布", "info"], PUBLISHED: ["已发布", "success"], RUNNING: ["运行中", "running"], SUCCESS: ["成功", "success"], FAILED: ["失败", "danger"] };
const maskingStrategyMeta = { PHONE: ["手机号", "保留前三位与后四位"], ID_CARD: ["投资者标识", "保留前四位与后四位"], SECURITY_ACCOUNT: ["证券账户", "保留前三位与后四位"], BANK_CARD: ["银行卡号", "仅保留后四位"], NAME: ["姓名", "保留首字" ] };
const requestedView = () => {
  const view = new URLSearchParams(window.location.search).get("view");
  if (["sources", "sync", "realtime", "development", "quality", "assets", "masking", "holdings-report", "ops", "security", "agent"].includes(view)) return view;
  return window.location.hash === "#development" ? "development" : "sync";
};
const state = { view: requestedView(), tasks: [], summary: {}, selectedId: undefined, runs: [], editing: undefined, devJobs: [], devRuns: [], devSelectedId: undefined, devEditing: undefined, maskingRules: [], maskingPreview: undefined, maskingEditing: undefined, assets: [], assetSelectedId: undefined, assetDetail: undefined, assetQuery: "", securityUsers: [], securityRoles: [], securityAudit: [], securityCheckResult: undefined, securitySelectedUserId: undefined, agentMessage: "", agentPlan: undefined, agentPlans: [], qualityRules: [], qualitySummary: {}, qualitySelectedRuleId: undefined, qualityRuns: [], holdingsReport: undefined, streamJobs: [], dataSources: [], opsIncidents: [], error: undefined, busyId: undefined };
const app = document.querySelector("#app");
const API_BASE_URL = String(globalThis.DATA_PLATFORM_API_BASE_URL ?? "").replace(/\/$/, "");
const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
const formatTime = (value) => value ? new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value)) : "尚未运行";
const primaryNavItems = [["sources", "数据源"], ["sync", "数据同步"], ["realtime", "实时同步"], ["development", "数据开发"], ["quality", "数据质量"], ["assets", "数据资产"], ["masking", "数据脱敏"], ["holdings-report", "数据报表"], ["ops", "运维监控"], ["security", "账号权限"], ["agent", "Data Agent"]];
const primaryNav = (active) => primaryNavItems.map(([view, label]) => `<a class="nav-item ${active === view ? "active" : ""}" href="?view=${view}#${view}">${label}</a>`).join("");
function applyPrimaryNav() { const nav = app.querySelector(".topbar nav"); if (nav) { nav.className = "primary-nav"; nav.innerHTML = primaryNav(state.view); } }

async function request(path, options) {
  const accessToken = sessionStorage.getItem("demoAccessToken");
  const response = await fetch(`${API_BASE_URL}${path}`, { ...options, headers: { "Content-Type": "application/json", ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}), ...options?.headers } });
  const body = response.status === 204 ? undefined : await response.json().catch(() => ({}));
  if (response.status === 401 && !options?.retried) {
    const nextToken = window.prompt("请输入云端 Demo 访问码");
    if (nextToken) {
      sessionStorage.setItem("demoAccessToken", nextToken);
      return request(path, { ...options, retried: true });
    }
  }
  if (!response.ok) throw new Error(body?.message ?? `请求失败（${response.status}）`);
  return body;
}

async function refresh() {
  [state.tasks, state.summary] = await Promise.all([request("/api/tasks"), request("/api/summary")]);
  state.selectedId ??= state.tasks[0]?.id;
  if (!state.tasks.some((task) => task.id === state.selectedId)) state.selectedId = state.tasks[0]?.id;
  state.runs = state.selectedId ? await request(`/api/tasks/${state.selectedId}/runs`) : [];
  state.busyId = undefined;
  render();
}

async function refreshDevelopment() {
  state.devJobs = await request("/api/dev/jobs");
  state.devSelectedId ??= state.devJobs[0]?.id;
  if (!state.devJobs.some((job) => job.id === state.devSelectedId)) state.devSelectedId = state.devJobs[0]?.id;
  state.devRuns = state.devSelectedId ? await request(`/api/dev/jobs/${state.devSelectedId}/runs`) : [];
  state.busyId = undefined;
  render();
}

async function refreshMasking() {
  state.maskingRules = await request("/api/masking/rules");
  state.busyId = undefined;
  render();
}

async function refreshAssets() {
  const suffix = state.assetQuery ? `?q=${encodeURIComponent(state.assetQuery)}` : "";
  [state.assets, state.dataSources] = await Promise.all([request(`/api/assets${suffix}`), request("/api/sources")]);
  state.assetSelectedId ??= state.assets[0]?.id;
  if (!state.assets.some((asset) => asset.id === state.assetSelectedId)) state.assetSelectedId = state.assets[0]?.id;
  state.assetDetail = state.assetSelectedId ? await request(`/api/assets/${state.assetSelectedId}`) : undefined;
  state.busyId = undefined;
  render();
}

async function refreshSecurity() {
  [state.securityUsers, state.securityRoles, state.securityAudit] = await Promise.all([request("/api/security/users"), request("/api/security/roles"), request("/api/security/audit")]);
  state.securitySelectedUserId ??= state.securityUsers[0]?.id;
  state.busyId = undefined;
  render();
}

async function refreshAgent() {
  state.agentPlans = await request("/api/agent/plans");
  state.busyId = undefined;
  render();
}

async function refreshQuality() {
  [state.qualityRules, state.qualitySummary] = await Promise.all([request("/api/quality/rules"), request("/api/quality/summary")]);
  state.qualitySelectedRuleId ??= state.qualityRules[0]?.id;
  state.qualityRuns = state.qualitySelectedRuleId ? await request(`/api/quality/rules/${state.qualitySelectedRuleId}/runs`) : [];
  state.busyId = undefined;
  render();
}

async function refreshHoldingsReport() { state.holdingsReport = await request("/api/reports/holdings"); render(); }
async function refreshRealtime() { state.streamJobs = await request("/api/stream/jobs"); render(); }
async function refreshSources() { state.dataSources = await request("/api/sources"); render(); }
async function refreshOps() { [state.tasks, state.qualitySummary, state.streamJobs, state.opsIncidents] = await Promise.all([request("/api/tasks"), request("/api/quality/summary"), request("/api/stream/jobs"), request("/api/ops/incidents")]); state.busyId = undefined; render(); }

const refreshCurrentView = () => state.view === "sources" ? refreshSources() : state.view === "development" ? refreshDevelopment() : state.view === "masking" ? refreshMasking() : state.view === "assets" ? refreshAssets() : state.view === "security" ? refreshSecurity() : state.view === "agent" ? refreshAgent() : state.view === "quality" ? refreshQuality() : state.view === "holdings-report" ? refreshHoldingsReport() : state.view === "realtime" ? refreshRealtime() : state.view === "ops" ? refreshOps() : refresh();

const selectedTask = () => state.tasks.find((task) => task.id === state.selectedId);

function taskCard(task) {
  const [label, tone] = statusMeta[task.status];
  return `<article class="task-card ${task.id === state.selectedId ? "selected" : ""}" data-select="${task.id}">
    <div class="task-card-main">
      <div class="task-title-row"><span class="status-dot ${tone}"></span><h3>${escapeHtml(task.name)}</h3><span class="status-badge ${tone}">${label}</span></div>
      <p>${escapeHtml(task.sourceName)} <span>→</span> ${escapeHtml(task.targetName)}</p>
      <div class="task-meta"><span>${task.syncMode === "FULL" ? "全量" : "增量"}</span><span>${escapeHtml(task.schedule)}</span><span>${escapeHtml(task.owner)}</span><span>最近：${formatTime(task.lastRunAt)}</span></div>
    </div>
    <div class="task-actions">
      <button class="button button-quiet" data-edit="${task.id}">编辑</button>
      <button class="button button-secondary" data-action="toggle" data-id="${task.id}" ${state.busyId === task.id || task.status === "RUNNING" ? "disabled" : ""}>${task.enabled ? "停用" : "启用"}</button>
      <button class="button button-run" data-action="${task.status === "RUNNING" ? "stop" : "run"}" data-id="${task.id}" ${state.busyId === task.id || !task.enabled ? "disabled" : ""}>${task.status === "RUNNING" ? "停止" : "运行"}</button>
    </div>
  </article>`;
}

function runHistory(task) {
  if (!task) return `<div class="empty-state">请选择一个同步任务。</div>`;
  const list = state.runs.length ? state.runs.slice(0, 6).map((run) => `<li>
    <span class="timeline-dot ${run.status.toLowerCase()}"></span>
    <div><div class="run-row"><strong>${run.status === "SUCCESS" ? "执行成功" : run.status === "RUNNING" ? "执行中" : run.status === "STOPPED" ? "已停止" : "执行失败"}</strong><time>${formatTime(run.startedAt)}</time></div><p>${escapeHtml(run.message)}</p><small>读取 ${run.rowsRead.toLocaleString()} 行 · 写入 ${run.rowsWritten.toLocaleString()} 行</small></div>
  </li>`).join("") : `<li class="empty-state">还没有运行记录，点击“运行”生成第一条模拟日志。</li>`;
  return `<div class="selected-task-summary"><span class="source-icon">⇄</span><div><strong>${escapeHtml(task.name)}</strong><small>${escapeHtml(task.description || "暂无任务说明")}</small></div></div><ol class="run-list">${list}</ol>`;
}

function taskForm(task) {
  const value = task ?? { name: "", description: "", sourceType: "MySQL", sourceName: "", targetType: "PostgreSQL", targetName: "", syncMode: "INCREMENTAL", schedule: "每天 02:00", owner: "产品体验组", enabled: true };
  const options = (items, selected) => items.map((item) => `<option value="${item[0]}" ${item[0] === selected ? "selected" : ""}>${item[1]}</option>`).join("");
  const sourceOptions = [["MySQL", "MySQL"], ["PostgreSQL", "PostgreSQL"], ["Oracle", "Oracle"], ["CSV", "CSV"]];
  return `<div class="modal-backdrop"><section class="task-form" role="dialog" aria-modal="true">
    <div class="form-heading"><div><p class="eyebrow">SYNC TASK</p><h2>${task ? "编辑同步任务" : "新建同步任务"}</h2></div><button class="icon-button" data-close>×</button></div>
    <form id="task-form">
      <label class="field field-wide"><span>任务名称</span><input name="name" required minlength="2" maxlength="60" value="${escapeHtml(value.name)}"></label>
      <label class="field field-wide"><span>任务说明</span><textarea name="description" maxlength="200" rows="2">${escapeHtml(value.description)}</textarea></label>
      <label class="field"><span>源端类型</span><select name="sourceType">${options(sourceOptions, value.sourceType)}</select></label>
      <label class="field"><span>源端对象</span><input name="sourceName" required value="${escapeHtml(value.sourceName)}" placeholder="demo_trade.orders"></label>
      <label class="field"><span>目标端类型</span><select name="targetType">${options(sourceOptions, value.targetType)}</select></label>
      <label class="field"><span>目标端对象</span><input name="targetName" required value="${escapeHtml(value.targetName)}" placeholder="demo_dw.dwd_orders"></label>
      <label class="field"><span>同步模式</span><select name="syncMode">${options([["FULL", "全量同步"], ["INCREMENTAL", "增量同步"]], value.syncMode)}</select></label>
      <label class="field"><span>调度周期</span><input name="schedule" required value="${escapeHtml(value.schedule)}"></label>
      <label class="field"><span>负责人</span><input name="owner" required value="${escapeHtml(value.owner)}"></label>
      <label class="checkbox-field"><input name="enabled" type="checkbox" ${value.enabled ? "checked" : ""}><span>创建后立即启用</span></label>
      <div class="form-actions field-wide"><button class="button button-secondary" type="button" data-close>取消</button><button class="button button-primary" type="submit">保存任务</button></div>
    </form>
  </section></div>`;
}

function devJobCard(job) {
  const [label, tone] = devStatusMeta[job.status] ?? devStatusMeta.DRAFT;
  return `<article class="task-card ${job.id === state.devSelectedId ? "selected" : ""}" data-dev-select="${job.id}">
    <div class="task-card-main"><div class="task-title-row"><span class="status-dot ${tone}"></span><h3>${escapeHtml(job.name)}</h3><span class="status-badge ${tone}">${label}</span></div>
    <p>${escapeHtml(job.owner)} <span>·</span> ${escapeHtml(job.schedule)}</p><pre class="sql-preview">${escapeHtml(job.sql)}</pre></div>
    <div class="task-actions"><button class="button button-quiet" data-dev-action="validate" data-id="${job.id}">校验 SQL</button><button class="button button-primary" data-dev-action="deploy" data-id="${job.id}" ${state.busyId === job.id || job.release?.status === "PUBLISHED" ? "disabled" : ""}>${job.release?.status === "PUBLISHED" ? "已发布" : "发布调度"}</button><button class="button button-run" data-dev-action="run" data-id="${job.id}" ${state.busyId === job.id || !job.enabled ? "disabled" : ""}>模拟运行</button></div>
  </article>`;
}

function devRunHistory(job) {
  if (!job) return `<div class="empty-state">请选择一个数据开发任务。</div>`;
  const list = state.devRuns.length ? state.devRuns.slice(0, 6).map((run) => `<li><span class="timeline-dot ${run.status.toLowerCase()}"></span><div><div class="run-row"><strong>${run.status === "SUCCESS" ? "执行成功" : run.status === "RUNNING" ? "执行中" : "执行失败"}</strong><time>${formatTime(run.startedAt)}</time></div><p>${escapeHtml(run.message)}</p><small>影响 ${Number(run.rowsAffected ?? 0).toLocaleString()} 行</small></div></li>`).join("") : `<li class="empty-state">还没有运行记录。</li>`;
  const release = job.release ? `<div class="metadata-source"><strong>已发布至 ${escapeHtml(job.release.environment)} · ${escapeHtml(job.release.platform)}</strong><span>产物：${escapeHtml(job.release.artifact)} · 调度：${escapeHtml(job.release.schedule.frequency ?? job.schedule)}</span><small>发布：${formatTime(job.release.releasedAt)} · ${escapeHtml(job.release.mode)}</small></div>` : `<div class="metadata-source"><strong>尚未发布</strong><span>先校验 SQL，再人工确认发布到模拟调度环境。</span></div>`;
  return `<div class="selected-task-summary"><span class="source-icon">SQL</span><div><strong>${escapeHtml(job.name)}</strong><small>${escapeHtml(job.description || "暂无任务说明")}</small></div></div>${release}<ol class="run-list">${list}</ol>`;
}

function devJobForm(job) {
  const value = job ?? { name: "", description: "", jobType: "SQL", sql: "SELECT * FROM business_demo.customer_profile LIMIT 1000;", schedule: "手动", owner: "数据开发组", enabled: false };
  return `<div class="modal-backdrop"><section class="task-form" role="dialog" aria-modal="true"><div class="form-heading"><div><p class="eyebrow">DATA DEVELOPMENT</p><h2>新建 SQL 任务</h2></div><button class="icon-button" data-dev-close>×</button></div><form id="dev-job-form">
    <label class="field field-wide"><span>任务名称</span><input name="name" required minlength="2" maxlength="60" value="${escapeHtml(value.name)}"></label>
    <label class="field field-wide"><span>任务说明</span><textarea name="description" maxlength="200" rows="2">${escapeHtml(value.description)}</textarea></label>
    <label class="field field-wide"><span>SQL</span><textarea name="sql" required rows="8">${escapeHtml(value.sql)}</textarea></label>
    <label class="field"><span>调度周期</span><input name="schedule" required value="${escapeHtml(value.schedule)}"></label><label class="field"><span>负责人</span><input name="owner" required value="${escapeHtml(value.owner)}"></label>
    <label class="checkbox-field"><input name="enabled" type="checkbox" ${value.enabled ? "checked" : ""}><span>创建后进入待发布</span></label>
    <div class="form-actions field-wide"><button class="button button-secondary" type="button" data-dev-close>取消</button><button class="button button-primary" type="submit">保存任务</button></div>
  </form></section></div>`;
}

function maskingRuleCard(rule) {
  const [label, hint] = maskingStrategyMeta[rule.strategy] ?? [rule.strategy, "规则策略"];
  return `<article class="task-card ${rule.enabled ? "selected" : ""}">
    <div class="task-card-main"><div class="task-title-row"><span class="status-dot ${rule.enabled ? "success" : "neutral"}"></span><h3>${escapeHtml(rule.name)}</h3><span class="status-badge ${rule.enabled ? "success" : "neutral"}">${rule.enabled ? "已启用" : "已停用"}</span></div>
    <p>${escapeHtml(rule.fieldName)} · ${escapeHtml(label)}</p><div class="task-meta"><span>${escapeHtml(hint)}</span><span>预览 ${Number(rule.previewCount ?? 0)} 次</span><span>${escapeHtml(rule.owner)}</span></div></div>
    <div class="task-actions"><button class="button button-quiet" data-mask-preview="${rule.id}">预览脱敏</button><button class="button button-secondary" data-mask-toggle="${rule.id}">${rule.enabled ? "停用" : "启用"}</button></div>
  </article>`;
}

function maskingRuleForm(rule) {
  const value = rule ?? { name: "", description: "", fieldName: "investor_phone", strategy: "PHONE", sampleValue: "13812348000", owner: "数据安全组", enabled: true };
  const options = Object.entries(maskingStrategyMeta).map(([key, [label]]) => `<option value="${key}" ${key === value.strategy ? "selected" : ""}>${label}</option>`).join("");
  return `<div class="modal-backdrop"><section class="task-form" role="dialog" aria-modal="true"><div class="form-heading"><div><p class="eyebrow">DATA MASKING</p><h2>新建脱敏规则</h2></div><button class="icon-button" data-mask-close>×</button></div><form id="masking-rule-form">
    <label class="field field-wide"><span>规则名称</span><input name="name" required minlength="2" maxlength="60" value="${escapeHtml(value.name)}"></label>
    <label class="field field-wide"><span>规则说明</span><textarea name="description" maxlength="200" rows="2">${escapeHtml(value.description)}</textarea></label>
    <label class="field"><span>敏感字段</span><input name="fieldName" required value="${escapeHtml(value.fieldName)}" placeholder="investor_phone"></label><label class="field"><span>脱敏策略</span><select name="strategy">${options}</select></label>
    <label class="field field-wide"><span>虚构样例值</span><input name="sampleValue" required value="${escapeHtml(value.sampleValue)}"></label><label class="field"><span>负责人</span><input name="owner" required value="${escapeHtml(value.owner)}"></label>
    <label class="checkbox-field"><input name="enabled" type="checkbox" ${value.enabled ? "checked" : ""}><span>创建后启用规则</span></label>
    <div class="form-actions field-wide"><button class="button button-secondary" type="button" data-mask-close>取消</button><button class="button button-primary" type="submit">保存规则</button></div>
  </form></section></div>`;
}

function renderMasking() {
  const preview = state.maskingPreview;
  return `<div class="app-shell"><header class="topbar"><a class="brand" href="#top"><span class="brand-mark">数</span><span><strong>数栈</strong><small>DATA PLATFORM LAB</small></span></a><nav><a class="nav-item" href="?view=sync#tasks">同步任务</a><a class="nav-item" href="?view=development#development">数据开发</a><a class="nav-item active" href="?view=masking#masking">数据脱敏</a><a class="nav-item" href="?view=assets#assets">数据资产</a><a class="nav-item" href="?view=security#security">账号权限</a></nav><div class="environment-pill"><span></span>本地演示环境</div></header><main id="top">
    <section class="hero"><div><p class="eyebrow">DATA MASKING · MVP 0.1</p><h1>让敏感数据<br>可用但不可见。</h1><p class="hero-copy">围绕投资者、证券账户和资金信息建立可预览、可审计的脱敏规则；当前仅处理虚构样例。</p></div><button class="button button-primary hero-action" data-new-masking><span>＋</span> 新建脱敏规则</button></section>
    <section class="summary-grid"><article><span>规则总数</span><strong>${state.maskingRules.length}</strong><small>条脱敏规则</small></article><article><span>已启用</span><strong>${state.maskingRules.filter((rule) => rule.enabled).length}</strong><small>进入数据使用流程</small></article><article><span>预览次数</span><strong>${state.maskingRules.reduce((sum, rule) => sum + Number(rule.previewCount ?? 0), 0)}</strong><small>虚构样例预览</small></article><article class="success-card"><span>当前阶段</span><strong>0.1</strong><small>规则与预览</small></article></section>
    ${state.error ? `<div class="error-banner"><span>!</span>${escapeHtml(state.error)}<button data-dismiss>关闭</button></div>` : ""}
    ${preview ? `<section class="panel preview-panel"><div class="panel-heading"><div><p class="eyebrow">PREVIEW RESULT</p><h2>${escapeHtml(preview.ruleName)}</h2></div><button class="button button-quiet" data-mask-dismiss-preview>清除预览</button></div><div class="preview-values"><div><span>原始样例</span><code>${escapeHtml(preview.input)}</code></div><div class="preview-arrow">→</div><div><span>脱敏结果</span><code>${escapeHtml(preview.output)}</code></div></div><small>策略：${escapeHtml(maskingStrategyMeta[preview.strategy]?.[0] ?? preview.strategy)} · 操作人：${escapeHtml(preview.operator)}</small></section>` : ""}
    <section class="workspace"><div class="panel task-panel"><div class="panel-heading"><div><p class="eyebrow">MASKING RULES</p><h2>脱敏规则</h2></div><span>${state.maskingRules.length} 项</span></div><div class="task-list">${state.maskingRules.map(maskingRuleCard).join("")}</div></div><aside class="panel detail-panel"><div class="panel-heading"><div><p class="eyebrow">SECURITY CONTEXT</p><h2>安全边界</h2></div><span>虚构演示</span></div><div class="empty-state">仅对虚构投资者、证券账户、银行卡和姓名样例执行预览。真实数据访问、生产脱敏和监管报送将在权限与审计模块完成后再评估。</div></aside></section>
  </main><footer><span>数栈 Data Platform Lab</span><span>虚构证券行业数据 · 学习环境 · 禁止接入真实生产</span></footer>${state.maskingEditing !== undefined ? maskingRuleForm(state.maskingEditing) : ""}</div>`;
}

function assetSensitivityMeta(level) {
  return { PUBLIC: ["公开", "success"], INTERNAL: ["内部", "info"], SENSITIVE: ["敏感", "running"], RESTRICTED: ["受限", "danger"] }[level] ?? [level, "neutral"];
}

function assetCard(asset) {
  const [label, tone] = assetSensitivityMeta(asset.sensitivity);
  return `<article class="task-card ${asset.id === state.assetSelectedId ? "selected" : ""}" data-asset-select="${asset.id}"><div class="task-card-main"><div class="task-title-row"><span class="status-dot ${tone}"></span><h3>${escapeHtml(asset.name)}</h3><span class="status-badge ${tone}">${label}</span></div><p>${escapeHtml(asset.physicalName)} · ${escapeHtml(asset.layer)} · ${escapeHtml(asset.domain)}</p><div class="task-meta"><span>${asset.fields.length} 个字段</span><span>${escapeHtml(asset.owner)}</span><span>${asset.tags.map((tag) => `#${escapeHtml(tag)}`).join(" ")}</span></div></div><div class="task-actions"><button class="button button-quiet" data-asset-select="${asset.id}">查看详情</button></div></article>`;
}

function renderAssetDetail(asset) {
  if (!asset) return `<div class="empty-state">请选择一个数据资产查看字段、敏感等级和血缘摘要。</div>`;
  const [label, tone] = assetSensitivityMeta(asset.sensitivity);
  const source = state.dataSources.find((item) => item.metadata?.assetPhysicalNames?.includes(asset.physicalName));
  const metadataContext = source ? `<div class="metadata-source"><strong>元数据采集来源：${escapeHtml(source.name)}</strong><span>${source.metadata.objectCount} 个对象 · ${source.metadata.fieldCount} 个字段 · ${source.metadata.sensitiveFieldCount} 个敏感字段</span><small>最近采集：${formatTime(source.metadata.collectedAt)} · 虚构环境</small></div>` : `<div class="metadata-source"><strong>尚未建立采集来源关联</strong><span>请到“数据源”完成连接测试和元数据采集。</span></div>`;
  return `<div class="asset-detail"><div class="selected-task-summary"><span class="source-icon">表</span><div><strong>${escapeHtml(asset.name)}</strong><small>${escapeHtml(asset.description)}</small></div></div><div class="asset-detail-meta"><span class="status-badge ${tone}">${label}</span><span>${escapeHtml(asset.assetType)} · ${escapeHtml(asset.layer)}</span><span>负责人：${escapeHtml(asset.owner)}</span></div>${metadataContext}<div class="lineage-block"><p class="eyebrow">LINEAGE</p><p>${asset.upstream.length ? asset.upstream.map((item) => `<span class="lineage-chip">${escapeHtml(item)}</span>`).join(" <span class=\"lineage-arrow\">→</span> ") : "暂无上游登记"}</p></div><div class="field-table"><div class="field-table-row field-table-head"><span>字段</span><span>业务名称</span><span>类型</span><span>敏感等级</span></div>${asset.fields.map((field) => { const [fieldLabel, fieldTone] = assetSensitivityMeta(field.sensitivity); return `<div class="field-table-row"><span><code>${escapeHtml(field.name)}</code></span><span>${escapeHtml(field.label)}</span><span>${escapeHtml(field.type)}</span><span class="status-badge ${fieldTone}">${fieldLabel}</span></div>`; }).join("")}</div></div>`;
}

function renderAssets() {
  return `<div class="app-shell"><header class="topbar"><a class="brand" href="#top"><span class="brand-mark">数</span><span><strong>数栈</strong><small>DATA PLATFORM LAB</small></span></a><nav><a class="nav-item" href="?view=sync#tasks">同步任务</a><a class="nav-item" href="?view=development#development">数据开发</a><a class="nav-item" href="?view=masking#masking">数据脱敏</a><a class="nav-item active" href="?view=assets#assets">数据资产</a><a class="nav-item" href="?view=security#security">账号权限</a></nav><div class="environment-pill"><span></span>本地演示环境</div></header><main id="top">
    <section class="hero"><div><p class="eyebrow">DATA ASSET CATALOG · MVP 0.1</p><h1>让每张表都有<br>可理解的上下文。</h1><p class="hero-copy">围绕证券主数据、投资者账户、订单成交、持仓和基金净值，建立字段、敏感等级、负责人和血缘摘要。</p></div><form class="asset-search" id="asset-search-form"><input name="q" value="${escapeHtml(state.assetQuery)}" placeholder="搜索资产、字段、业务域或标签"><button class="button button-primary" type="submit">搜索资产</button></form></section>
    <section class="summary-grid"><article><span>资产总数</span><strong>${state.assets.length}</strong><small>当前检索结果</small></article><article><span>受限资产</span><strong>${state.assets.filter((asset) => asset.sensitivity === "RESTRICTED").length}</strong><small>需要权限审计</small></article><article><span>字段总数</span><strong>${state.assets.reduce((sum, asset) => sum + asset.fields.length, 0)}</strong><small>已登记字段</small></article><article class="success-card"><span>当前阶段</span><strong>0.1</strong><small>元数据检索</small></article></section>
    ${state.error ? `<div class="error-banner"><span>!</span>${escapeHtml(state.error)}<button data-dismiss>关闭</button></div>` : ""}
    <section class="workspace"><div class="panel task-panel"><div class="panel-heading"><div><p class="eyebrow">ASSET CATALOG</p><h2>证券数据资产</h2></div><span>${state.assets.length} 项</span></div><div class="task-list">${state.assets.map(assetCard).join("")}</div></div><aside class="panel detail-panel"><div class="panel-heading"><div><p class="eyebrow">METADATA CONTEXT</p><h2>资产详情</h2></div><span>只读上下文</span></div>${renderAssetDetail(state.assetDetail)}</aside></section>
  </main><footer><span>数栈 Data Platform Lab</span><span>虚构证券行业数据 · 学习环境 · 禁止接入真实生产</span></footer></div>`;
}

function renderSources() {
  const typeLabel = { MYSQL: "MySQL", CSV: "CSV", KAFKA: "Kafka", HIVE_SPARK: "Hive/Spark" };
  const collectedCount = state.dataSources.filter((source) => source.metadata?.status === "COLLECTED").length;
  return `<div class="app-shell"><header class="topbar"><a class="brand" href="#top"><span class="brand-mark">数</span><span><strong>数栈</strong><small>DATA PLATFORM LAB</small></span></a><nav></nav><div class="environment-pill"><span></span>数据源管理</div></header><main id="top"><section class="hero"><div><p class="eyebrow">DATA SOURCES · MVP 0.2</p><h1>先知道数据从哪里来。</h1><p class="hero-copy">连接测试后采集对象、字段和敏感字段摘要，再把上下文交给数据资产、同步和质量模块。</p></div><div class="security-summary"><strong>${state.dataSources.length}</strong><span>数据源</span><strong>${collectedCount}</strong><span>已采集元数据</span></div></section><section class="workspace"><div class="panel task-panel"><div class="panel-heading"><div><p class="eyebrow">SOURCE REGISTRY</p><h2>数据源清单</h2></div><span>${state.dataSources.length} 项</span></div><div class="task-list">${state.dataSources.map((source) => { const metadata = source.metadata; return `<article class="task-card"><div class="task-card-main"><div class="task-title-row"><span class="status-dot ${source.status === "CONNECTED" ? "success" : "neutral"}"></span><h3>${escapeHtml(source.name)}</h3><span class="status-badge ${source.status === "CONNECTED" ? "success" : "neutral"}">${source.status === "CONNECTED" ? "已连接" : source.status === "SIMULATED" ? "模拟连接" : "未测试"}</span></div><p>${escapeHtml(typeLabel[source.sourceType] ?? source.sourceType)} · ${escapeHtml(source.environment)} · ${escapeHtml(source.endpoint)}</p><div class="task-meta"><span>${escapeHtml(source.owner)}</span><span>${escapeHtml(source.description)}</span></div>${metadata ? `<div class="metadata-source"><strong>已采集元数据</strong><span>${metadata.objectCount} 个对象 · ${metadata.fieldCount} 个字段 · ${metadata.sensitiveFieldCount} 个敏感字段</span><small>最近采集：${formatTime(metadata.collectedAt)} · 虚构环境</small></div>` : `<div class="metadata-source"><strong>尚未采集元数据</strong><span>先测试连接，再采集对象和字段摘要。</span></div>`}</div><div class="task-actions"><button class="button button-quiet" data-source-test="${source.id}">测试连接</button><button class="button button-primary" data-source-metadata="${source.id}">采集元数据</button></div></article>`; }).join("")}</div></div><aside class="panel detail-panel"><div class="panel-heading"><div><p class="eyebrow">SOURCE SAFETY</p><h2>连接边界</h2></div><span>虚构环境</span></div><div class="empty-state">生产接入前需要凭证托管、网络白名单、权限审批、连接测试、元数据采集和敏感字段分类。当前采集结果为虚构摘要，不读取或展示真实数据内容。</div></aside></section></main><footer><span>数栈 Data Platform Lab</span><span>虚构证券行业数据 · 禁止连接真实生产</span></footer></div>`;
}

function renderOps() {
  const status = { OPEN: ["待处置", "danger"], ACKNOWLEDGED: ["处置中", "running"], RESOLVED: ["已恢复", "success"] };
  const openCount = state.opsIncidents.filter((item) => item.status === "OPEN").length;
  const processingCount = state.opsIncidents.filter((item) => item.status === "ACKNOWLEDGED").length;
  return `<div class="app-shell"><header class="topbar"><a class="brand" href="#top"><span class="brand-mark">数</span><span><strong>数栈</strong><small>DATA PLATFORM LAB</small></span></a><nav></nav><div class="environment-pill"><span></span>运维监控</div></header><main id="top"><section class="hero"><div><p class="eyebrow">DATA OPERATIONS · MVP 0.2</p><h1>让异常变成<br>可解释、可恢复。</h1><p class="hero-copy">统一查看虚构证券数据任务、质量和实时流；告警必须明确影响范围、责任人和处置手册，避免只看到一个红点。</p></div><div class="agent-badge"><strong>${openCount}</strong><span>待处置</span><strong>${processingCount}</strong><span>处置中</span></div></section><section class="summary-grid"><article><span>同步任务</span><strong>${state.tasks.length}</strong><small>当前登记</small></article><article><span>实时任务</span><strong>${state.streamJobs.length}</strong><small>Kafka/Flink 模拟</small></article><article><span>质量提醒</span><strong>${state.qualitySummary.warnRules ?? 0}</strong><small>触发告警源</small></article><article class="success-card"><span>当前阶段</span><strong>0.2</strong><small>告警处置闭环</small></article></section>${state.error ? `<div class="error-banner"><span>!</span>${escapeHtml(state.error)}<button data-dismiss>关闭</button></div>` : ""}<section class="panel audit-panel"><div class="panel-heading"><div><p class="eyebrow">INCIDENT CENTER</p><h2>告警与影响分析</h2></div><span>${state.opsIncidents.length} 项</span></div><div class="task-list">${state.opsIncidents.map((incident) => { const [label, tone] = status[incident.status] ?? status.OPEN; return `<article class="task-card"><div class="task-card-main"><div class="task-title-row"><span class="status-dot ${tone}"></span><h3>${escapeHtml(incident.title)}</h3><span class="status-badge ${tone}">${label}</span></div><p>${escapeHtml(incident.source)} · ${escapeHtml(incident.asset)}</p><div class="task-meta"><span>影响：${escapeHtml(incident.impact)}</span><span>负责人：${escapeHtml(incident.owner)}</span><span>发现：${formatTime(incident.detectedAt)}</span></div><div class="runbook"><strong>处置手册</strong><ol>${incident.runbook.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ol></div></div><div class="task-actions">${incident.status === "OPEN" ? `<button class="button button-primary" data-ops-ack="${incident.id}">确认告警</button>` : incident.status === "ACKNOWLEDGED" ? `<button class="button button-run" data-ops-resolve="${incident.id}">标记已恢复</button>` : `<span class="status-badge success">已完成</span>`}</div></article>`; }).join("") || `<div class="empty-state">当前没有待处置告警。</div>`}</div></section></main><footer><span>数栈 Data Platform Lab</span><span>虚构证券行业数据 · 不连接真实生产</span></footer></div>`;
}

function renderRealtime() {
  return `<div class="app-shell"><header class="topbar"><a class="brand" href="#top"><span class="brand-mark">数</span><span><strong>数栈</strong><small>DATA PLATFORM LAB</small></span></a><nav><a class="nav-item" href="?view=agent#agent">Data Agent</a><a class="nav-item active" href="?view=realtime#realtime">实时同步</a><a class="nav-item" href="?view=quality#quality">数据质量</a><a class="nav-item" href="?view=holdings-report#holdings-report">持仓看板</a></nav><div class="environment-pill"><span></span>Kafka/Flink 模拟</div></header><main id="top"><section class="hero"><div><p class="eyebrow">REALTIME INGESTION · MVP 0.1</p><h1>离线与实时<br>共享一套任务模型。</h1><p class="hero-copy">当前用虚构行情事件模拟 Kafka → Flink SQL → 实时表，展示状态、吞吐、延迟和检查点。</p></div><div class="agent-badge"><strong>${state.streamJobs.length}</strong><span>实时任务</span><strong>${state.streamJobs.filter((job) => job.status === "RUNNING").length}</strong><span>运行中</span></div></section><section class="workspace"><div class="panel task-panel"><div class="panel-heading"><div><p class="eyebrow">STREAM JOBS</p><h2>实时同步任务</h2></div><span>${state.streamJobs.length} 项</span></div><div class="task-list">${state.streamJobs.map((job) => `<article class="task-card"><div class="task-card-main"><div class="task-title-row"><span class="status-dot ${job.status === "RUNNING" ? "running" : "neutral"}"></span><h3>${escapeHtml(job.name)}</h3><span class="status-badge ${job.status === "RUNNING" ? "running" : "neutral"}">${job.status === "RUNNING" ? "运行中" : "已停止"}</span></div><p>${escapeHtml(job.sourceTopic)} · ${escapeHtml(job.engine)} · ${escapeHtml(job.targetTable)}</p><div class="task-meta"><span>延迟 ${job.metrics.lagMs}ms</span><span>吞吐 ${job.metrics.throughput}/s</span><span>事件 ${job.metrics.events}</span><span>Checkpoint ${job.checkpointIntervalMs}ms</span></div></div><div class="task-actions">${job.status === "RUNNING" ? `<button class="button button-secondary" data-stream-stop="${job.id}">停止</button>` : `<button class="button button-run" data-stream-start="${job.id}">启动模拟</button>`}</div></article>`).join("")}</div></div><aside class="panel detail-panel"><div class="panel-heading"><div><p class="eyebrow">STREAM SAFETY</p><h2>实时边界</h2></div><span>虚构事件</span></div><div class="empty-state">生产接入前需要完成 Topic 权限、Watermark、Checkpoint、延迟 SLA、回放策略和告警配置。</div></aside></section></main><footer><span>数栈 Data Platform Lab</span><span>虚构证券行情事件 · 不连接真实 Kafka/Flink</span></footer></div>`;
}

function renderSecurity() {
  const result = state.securityCheckResult;
  const sensitivityLabels = { PUBLIC: "公开", INTERNAL: "内部", SENSITIVE: "敏感", RESTRICTED: "受限" };
  return `<div class="app-shell"><header class="topbar"><a class="brand" href="#top"><span class="brand-mark">数</span><span><strong>数栈</strong><small>DATA PLATFORM LAB</small></span></a><nav><a class="nav-item" href="?view=sync#tasks">同步任务</a><a class="nav-item" href="?view=development#development">数据开发</a><a class="nav-item" href="?view=masking#masking">数据脱敏</a><a class="nav-item" href="?view=assets#assets">数据资产</a><a class="nav-item active" href="?view=security#security">账号权限</a></nav><div class="environment-pill"><span></span>本地演示环境</div></header><main id="top">
    <section class="hero"><div><p class="eyebrow">SECURITY & AUDIT · MVP 0.1</p><h1>让每一次访问<br>都有边界、有记录。</h1><p class="hero-copy">使用虚构证券行业岗位验证最小权限：角色决定动作权限，敏感等级决定数据访问范围，允许和拒绝都写入审计。</p></div><div class="security-summary"><strong>${state.securityUsers.length}</strong><span>个演示用户</span><strong>${state.securityRoles.length}</strong><span>个角色</span></div></section>
    <section class="summary-grid"><article><span>演示用户</span><strong>${state.securityUsers.length}</strong><small>全部为虚构身份</small></article><article><span>角色</span><strong>${state.securityRoles.length}</strong><small>最小权限集合</small></article><article><span>审计记录</span><strong>${state.securityAudit.length}</strong><small>允许与拒绝</small></article><article class="success-card"><span>当前阶段</span><strong>0.1</strong><small>访问检查</small></article></section>
    ${state.error ? `<div class="error-banner"><span>!</span>${escapeHtml(state.error)}<button data-dismiss>关闭</button></div>` : ""}
    <section class="workspace security-workspace"><div class="panel task-panel"><div class="panel-heading"><div><p class="eyebrow">ROLES</p><h2>角色与权限</h2></div><span>${state.securityRoles.length} 项</span></div><div class="role-list">${state.securityRoles.map((role) => `<article class="role-card"><div><h3>${escapeHtml(role.name)}</h3><p>${escapeHtml(role.description)}</p></div><div class="task-meta"><span>最高：${escapeHtml(sensitivityLabels[role.maxSensitivity] ?? role.maxSensitivity)}</span><span>${role.permissions.length} 项权限</span></div><div class="permission-chips">${role.permissions.map((permission) => `<code>${escapeHtml(permission)}</code>`).join("")}</div></article>`).join("")}</div></div><aside class="panel detail-panel"><div class="panel-heading"><div><p class="eyebrow">ACCESS CHECK</p><h2>访问检查</h2></div><span>只影响演示审计</span></div><form id="security-check-form" class="security-form"><label class="field"><span>演示用户</span><select name="userId">${state.securityUsers.map((user) => `<option value="${user.id}" ${user.id === state.securitySelectedUserId ? "selected" : ""}>${escapeHtml(user.name)} · ${escapeHtml(user.department)}</option>`).join("")}</select></label><label class="field"><span>访问动作</span><select name="permission"><option value="asset.read">读取资产</option><option value="asset.sensitive.read">读取敏感资产</option><option value="asset.restricted.read">读取受限资产</option><option value="masking.preview">预览脱敏</option><option value="audit.read">读取审计</option></select></label><label class="field"><span>资源敏感等级</span><select name="sensitivity">${Object.entries(sensitivityLabels).map(([key, label]) => `<option value="${key}">${label}</option>`).join("")}</select></label><button class="button button-primary" type="submit">检查并记录</button></form>${result ? `<div class="access-result ${result.allowed ? "allow" : "deny"}"><strong>${result.allowed ? "允许访问" : "拒绝访问"}</strong><p>${escapeHtml(result.reason)}</p><small>审计 ID：${escapeHtml(result.auditId)}</small></div>` : ""}</aside></section>
    <section class="panel audit-panel"><div class="panel-heading"><div><p class="eyebrow">AUDIT LOG</p><h2>最近审计记录</h2></div><span>${state.securityAudit.length} 条</span></div><div class="audit-list">${state.securityAudit.slice(0, 8).map((log) => `<div class="audit-row"><span class="audit-result ${log.result === "ALLOW" ? "allow" : "deny"}">${log.result === "ALLOW" ? "允许" : "拒绝"}</span><div><strong>${escapeHtml(log.actorName)} · ${escapeHtml(log.action)}</strong><small>${escapeHtml(log.resourceId)} · ${escapeHtml(log.reason)}</small></div><time>${formatTime(log.createdAt)}</time></div>`).join("")}</div></section>
  </main><footer><span>数栈 Data Platform Lab</span><span>虚构证券行业数据 · 学习环境 · 禁止连接真实生产</span></footer></div>`;
}

function renderAgent() {
  const plan = state.agentPlan;
  const intentLabels = { SYNC_TASK: "数据同步", MASKING_RULE: "数据脱敏", DEV_JOB: "数据开发", ASSET_SEARCH: "资产检索", HOLDINGS_REPORT: "持仓分析", UNKNOWN: "待澄清" };
  const holdings = plan?.intent === "HOLDINGS_REPORT";
  const holdingsDraft = holdings ? plan.draft : undefined;
  const releaseHandoff = holdings && plan?.status === "COMPLETED" ? `<div class="metadata-source"><strong>Agent 已创建未发布开发任务</strong><span>下一步：校验 SQL，再人工确认发布到模拟调度环境。</span><a class="button button-quiet" href="?view=development#development">进入数据开发</a></div>` : "";
  return `<div class="app-shell"><header class="topbar"><a class="brand" href="#top"><span class="brand-mark">数</span><span><strong>数栈</strong><small>DATA PLATFORM LAB</small></span></a><nav><a class="nav-item" href="?view=sync#tasks">同步任务</a><a class="nav-item" href="?view=development#development">数据开发</a><a class="nav-item" href="?view=masking#masking">数据脱敏</a><a class="nav-item" href="?view=assets#assets">数据资产</a><a class="nav-item" href="?view=security#security">账号权限</a><a class="nav-item active" href="?view=agent#agent">Data Agent</a></nav><div class="environment-pill"><span></span>规则编排演示</div></header><main id="top">
    <section class="hero"><div><p class="eyebrow">DATA AGENT LITE · MVP 0.1</p><h1>用一句话，<br>开始数据中台工作。</h1><p class="hero-copy">先用可测试的规则编排服务同步、开发、脱敏和资产模块；每次写入或执行前都展示计划，必须由用户确认。</p></div><div class="agent-badge"><strong>4</strong><span>模块路由</span><strong>0</strong><span>外部模型调用</span></div></section>
    <section class="agent-workspace"><section class="panel agent-input-panel"><div class="panel-heading"><div><p class="eyebrow">NATURAL LANGUAGE REQUEST</p><h2>描述你的证券数据需求</h2></div><span>虚构环境</span></div><form id="agent-plan-form" class="agent-form"><textarea name="message" rows="5" placeholder="例如：帮我把虚构券商投资者持仓 CSV 增量同步到 MySQL 持仓表，每个工作日凌晨 2 点执行。">${escapeHtml(state.agentMessage)}</textarea><label class="field"><span>确认用户</span><select name="userId"><option value="user-platform-admin">许平台 · 平台运营部</option><option value="user-data-engineer">周开发 · 数据开发部</option><option value="user-data-security">顾安全 · 数据安全部</option><option value="user-investor-analyst">林分析 · 财富管理部</option></select></label><button class="button button-primary" type="submit">生成计划</button></form><div class="agent-prompts"><button type="button" data-agent-prompt="帮我找出和投资者持仓相关的证券数据资产，并说明敏感等级。">资产检索示例</button><button type="button" data-agent-prompt="为投资者手机号创建脱敏规则，保留前三位和后四位。">脱敏规则示例</button><button type="button" data-agent-prompt="帮我创建每个工作日凌晨 2 点把虚构投资者持仓 CSV 增量同步到 MySQL 持仓表的任务。">同步任务示例</button></div></section>
    <section class="panel agent-plan-panel"><div class="panel-heading"><div><p class="eyebrow">PLAN & CONFIRMATION</p><h2>计划预览</h2></div><span>${plan ? intentLabels[plan.intent] ?? plan.intent : "等待输入"}</span></div>${plan ? `<div class="agent-plan"><h3>${escapeHtml(plan.title)}</h3><p class="agent-summary">${escapeHtml(plan.summary)}</p><div class="agent-columns"><div><strong>执行步骤</strong><ol>${plan.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ol></div><div><strong>风险与边界</strong><ul>${plan.risks.map((risk) => `<li>${escapeHtml(risk)}</li>`).join("")}</ul></div></div>${holdings ? `<section class="agent-code-workspace"><div class="code-heading"><strong>Hive/Spark SQL</strong><span>${escapeHtml(holdingsDraft.engine)}</span></div><textarea id="agent-sql-editor" spellcheck="false">${escapeHtml(holdingsDraft.sql)}</textarea><div class="artifact-grid"><div><strong>测试 SQL</strong><pre>${escapeHtml(holdingsDraft.testSql)}</pre></div><div><strong>调度配置</strong><pre>${escapeHtml(JSON.stringify(holdingsDraft.scheduleConfig, null, 2))}</pre></div><div><strong>部署文件</strong><pre>${escapeHtml(JSON.stringify(holdingsDraft.deploymentConfig, null, 2))}</pre></div></div><div class="report-spec"><strong>看板指标</strong><span>${holdingsDraft.reportSpec.metrics.map((metric) => escapeHtml(metric)).join(" · ")}</span><small>权限范围：${escapeHtml(holdingsDraft.permissionScope)}</small><small>语义证据：${holdingsDraft.semanticContext?.items?.length ?? 0} 项</small></div></section>` : ""}${releaseHandoff}${plan.questions.length ? `<div class="agent-questions"><strong>需要澄清</strong>${plan.questions.map((question) => `<p>？${escapeHtml(question)}</p>`).join("")}</div>` : `<button class="button button-primary" data-agent-confirm="${plan.id}">${plan.status === "COMPLETED" ? "已完成" : "确认并执行"}</button>`}</div>` : `<div class="empty-state">输入需求后，Agent 会先生成意图、步骤、风险和待确认项，不会直接执行。</div>`}</section></section>
    <section class="panel agent-history"><div class="panel-heading"><div><p class="eyebrow">PLAN HISTORY</p><h2>最近计划</h2></div><span>${state.agentPlans.length} 条</span></div><div class="audit-list">${state.agentPlans.slice(0, 6).map((item) => `<div class="audit-row"><span class="audit-result ${item.status === "COMPLETED" ? "allow" : "deny"}">${item.status === "COMPLETED" ? "已完成" : "待确认"}</span><div><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.message)}</small></div><time>${formatTime(item.createdAt)}</time></div>`).join("")}</div></section>
  </main><footer><span>数栈 Data Platform Lab</span><span>虚构证券行业数据 · 学习环境 · 不连接真实生产</span></footer></div>`;
}

function renderQuality() {
  const statusLabel = { PASS: "通过", WARN: "提醒", FAIL: "失败", NOT_RUN: "未运行" };
  return `<div class="app-shell"><header class="topbar"><a class="brand" href="#top"><span class="brand-mark">数</span><span><strong>数栈</strong><small>DATA PLATFORM LAB</small></span></a><nav><a class="nav-item" href="?view=agent#agent">Data Agent</a><a class="nav-item active" href="?view=quality#quality">数据质量</a><a class="nav-item" href="?view=assets#assets">数据资产</a><a class="nav-item" href="?view=security#security">账号权限</a></nav><div class="environment-pill"><span></span>质量模拟环境</div></header><main id="top">
    <section class="hero"><div><p class="eyebrow">DATA QUALITY & OPS · MVP 0.1</p><h1>让每个任务<br>都有可解释的质量结果。</h1><p class="hero-copy">围绕财富顾问持仓分析，先验证空值、唯一性、行数和 T+1 时效，再接入真实质量规则和运维告警。</p></div><div class="agent-badge"><strong>${state.qualitySummary.enabledRules ?? 0}</strong><span>启用规则</span><strong>${state.qualitySummary.passRules ?? 0}</strong><span>通过规则</span></div></section>
    <section class="summary-grid"><article><span>规则总数</span><strong>${state.qualitySummary.totalRules ?? 0}</strong><small>资产质量规则</small></article><article><span>通过</span><strong>${state.qualitySummary.passRules ?? 0}</strong><small>最近检查</small></article><article><span>提醒</span><strong>${state.qualitySummary.warnRules ?? 0}</strong><small>需要关注</small></article><article class="success-card"><span>当前阶段</span><strong>0.1</strong><small>模拟检查</small></article></section>
    ${state.error ? `<div class="error-banner"><span>!</span>${escapeHtml(state.error)}<button data-dismiss>关闭</button></div>` : ""}
    <section class="workspace"><div class="panel task-panel"><div class="panel-heading"><div><p class="eyebrow">QUALITY RULES</p><h2>持仓质量规则</h2></div><span>${state.qualityRules.length} 项</span></div><div class="task-list">${state.qualityRules.map((rule) => `<article class="task-card ${rule.id === state.qualitySelectedRuleId ? "selected" : ""}" data-quality-select="${rule.id}"><div class="task-card-main"><div class="task-title-row"><span class="status-dot ${rule.lastStatus === "PASS" ? "success" : rule.lastStatus === "WARN" ? "running" : "neutral"}"></span><h3>${escapeHtml(rule.name)}</h3><span class="status-badge ${rule.lastStatus === "PASS" ? "success" : rule.lastStatus === "WARN" ? "running" : "neutral"}">${statusLabel[rule.lastStatus] ?? rule.lastStatus}</span></div><p>${escapeHtml(rule.assetId)} · ${escapeHtml(rule.ruleType)} · ${escapeHtml(rule.fieldName || "整表")}</p><div class="task-meta"><span>得分 ${rule.lastScore ?? "—"}</span><span>${escapeHtml(rule.owner)}</span></div></div><div class="task-actions"><button class="button button-quiet" data-quality-run="${rule.id}">运行检查</button><button class="button button-secondary" data-quality-toggle="${rule.id}">${rule.enabled ? "停用" : "启用"}</button></div></article>`).join("")}</div></div><aside class="panel detail-panel"><div class="panel-heading"><div><p class="eyebrow">QUALITY HISTORY</p><h2>检查历史</h2></div><span>${state.qualityRuns.length} 条</span></div><div class="run-list">${state.qualityRuns.slice(0, 8).map((run) => `<div class="audit-row"><span class="audit-result ${run.status === "PASS" ? "allow" : "deny"}">${statusLabel[run.status]}</span><div><strong>得分 ${run.score}</strong><small>${escapeHtml(run.observed)} · ${escapeHtml(run.message)}</small></div><time>${formatTime(run.createdAt)}</time></div>`).join("") || `<div class="empty-state">选择规则并运行一次检查。</div>`}</div></aside></section>
  </main><footer><span>数栈 Data Platform Lab</span><span>虚构证券行业数据 · 学习环境 · 禁止连接真实生产</span></footer></div>`;
}

function renderHoldingsReport() {
  const report = state.holdingsReport;
  const money = (value) => `¥${Number(value).toLocaleString("zh-CN")}`;
  return `<div class="app-shell"><header class="topbar"><a class="brand" href="#top"><span class="brand-mark">数</span><span><strong>数栈</strong><small>DATA PLATFORM LAB</small></span></a><nav><a class="nav-item" href="?view=agent#agent">Data Agent</a><a class="nav-item active" href="?view=holdings-report#holdings-report">持仓看板</a><a class="nav-item" href="?view=quality#quality">数据质量</a><a class="nav-item" href="?view=assets#assets">数据资产</a></nav><div class="environment-pill"><span></span>T+1 模拟看板</div></header><main id="top">
    <section class="hero"><div><p class="eyebrow">WEALTH MANAGEMENT · HOLDINGS REPORT</p><h1>财富顾问客户持仓分析</h1><p class="hero-copy">权限范围：${escapeHtml(report?.scope ?? "OWN_CLIENTS_ONLY")} · 数据时效：${escapeHtml(report?.freshness ?? "T+1 模拟数据")}</p></div><div class="report-disclaimer">${escapeHtml(report?.disclaimer ?? "虚构数据，仅用于学习演示")}</div></section>
    ${report ? `<section class="report-metrics"><article><span>客户总资产</span><strong>${money(report.metrics.totalAssets)}</strong><small>T+1 快照</small></article><article><span>持仓市值</span><strong>${money(report.metrics.holdingMarketValue)}</strong><small>可用资产</small></article><article><span>证券数量</span><strong>${report.metrics.securityCount}</strong><small>去重证券</small></article></section><section class="report-grid"><div class="panel report-panel"><div class="panel-heading"><h2>资产类别分布</h2><span>市值占比</span></div>${report.assetClassDistribution.map((item) => `<div class="distribution-row"><div><strong>${escapeHtml(item.name)}</strong><span>${money(item.value)}</span></div><div class="bar"><i style="width:${item.ratio}%"></i></div><b>${item.ratio}%</b></div>`).join("")}</div><div class="panel report-panel"><div class="panel-heading"><h2>行业分布</h2><span>市值占比</span></div>${report.industryDistribution.map((item) => `<div class="distribution-row"><div><strong>${escapeHtml(item.name)}</strong><span>${money(item.value)}</span></div><div class="bar blue"><i style="width:${item.ratio}%"></i></div><b>${item.ratio}%</b></div>`).join("")}</div></section>` : `<div class="empty-state">正在加载持仓分析结果。</div>`}
  </main><footer><span>数栈 Data Platform Lab</span><span>虚构证券行业数据 · 不构成投资建议</span></footer></div>`;
}

function renderDevelopment() {
  const job = state.devJobs.find((item) => item.id === state.devSelectedId);
  const pendingRelease = state.devJobs.filter((item) => item.release?.status !== "PUBLISHED").length;
  return `<div class="app-shell"><header class="topbar"><a class="brand" href="#top"><span class="brand-mark">数</span><span><strong>数栈</strong><small>DATA PLATFORM LAB</small></span></a><nav><a class="nav-item" href="?view=sync#tasks">同步任务</a><a class="nav-item active" href="?view=development#development">数据开发</a><a class="nav-item" href="?view=masking#masking">数据脱敏</a><a class="nav-item" href="?view=assets#assets">数据资产</a><a class="nav-item" href="?view=security#security">账号权限</a></nav><div class="environment-pill"><span></span>本地演示环境</div></header><main id="top">
    <section class="hero"><div><p class="eyebrow">DATA DEVELOPMENT · MVP 0.2</p><h1>把 SQL 变成<br>可校验、可发布、可运行的任务。</h1><p class="hero-copy">遵循“草稿 → 校验 → 人工确认发布 → 调度运行”的最小闭环；发布仅模拟 staging 调度，不连接真实 DataWorks/EMR。</p></div><button class="button button-primary hero-action" data-new-dev><span>＋</span> 新建 SQL 任务</button></section>
    <section class="summary-grid"><article><span>任务总数</span><strong>${state.devJobs.length}</strong><small>个 SQL 任务</small></article><article><span>待发布</span><strong>${pendingRelease}</strong><small>可进入发布审核</small></article><article><span>已发布</span><strong>${state.devJobs.filter((item) => item.release?.status === "PUBLISHED").length}</strong><small>模拟调度环境</small></article><article class="success-card"><span>当前阶段</span><strong>0.2</strong><small>发布生命周期</small></article></section>
    ${state.error ? `<div class="error-banner"><span>!</span>${escapeHtml(state.error)}<button data-dismiss>关闭</button></div>` : ""}
    <section class="workspace"><div class="panel task-panel"><div class="panel-heading"><div><p class="eyebrow">SQL JOBS</p><h2>数据开发任务</h2></div><span>${state.devJobs.length} 项</span></div><div class="task-list">${state.devJobs.map(devJobCard).join("")}</div></div><aside class="panel detail-panel"><div class="panel-heading"><div><p class="eyebrow">RUN HISTORY</p><h2>运行记录</h2></div><span>${job ? devStatusMeta[job.status]?.[0] : "—"}</span></div>${devRunHistory(job)}</aside></section>
  </main><footer><span>数栈 Data Platform Lab</span><span>虚构数据 · 学习环境 · 禁止连接真实生产</span></footer>${state.devEditing !== undefined ? devJobForm(state.devEditing) : ""}</div>`;
}

function render() {
  if (state.view === "sources") { app.innerHTML = renderSources(); applyPrimaryNav(); return; }
  if (state.view === "development") { app.innerHTML = renderDevelopment(); applyPrimaryNav(); return; }
  if (state.view === "masking") { app.innerHTML = renderMasking(); applyPrimaryNav(); return; }
  if (state.view === "assets") { app.innerHTML = renderAssets(); applyPrimaryNav(); return; }
  if (state.view === "security") { app.innerHTML = renderSecurity(); applyPrimaryNav(); return; }
  if (state.view === "agent") { app.innerHTML = renderAgent(); applyPrimaryNav(); return; }
  if (state.view === "quality") { app.innerHTML = renderQuality(); applyPrimaryNav(); return; }
  if (state.view === "holdings-report") { app.innerHTML = renderHoldingsReport(); applyPrimaryNav(); return; }
  if (state.view === "realtime") { app.innerHTML = renderRealtime(); applyPrimaryNav(); return; }
  if (state.view === "ops") { app.innerHTML = renderOps(); applyPrimaryNav(); return; }
  const summary = { totalTasks: 0, enabledTasks: 0, runningTasks: 0, runsToday: 0, successRate: 100, ...state.summary };
  const task = selectedTask();
  app.innerHTML = `<div class="app-shell">
    <header class="topbar"><a class="brand" href="#top"><span class="brand-mark">数</span><span><strong>数栈</strong><small>DATA PLATFORM LAB</small></span></a><nav><a class="nav-item active" href="?view=sync#tasks">同步任务</a><a class="nav-item" href="?view=development#development">数据开发</a><a class="nav-item" href="?view=masking#masking">数据脱敏</a><a class="nav-item" href="?view=assets#assets">数据资产</a><a class="nav-item" href="?view=security#security">账号权限</a></nav><div class="environment-pill"><span></span>本地演示环境</div></header>
    <main id="top">
      <section class="hero"><div><p class="eyebrow">OFFLINE SYNC CENTER · MVP 0.1</p><h1>让每一次数据流动<br>都清晰、可控、可追溯。<br>这是我的第一次 Git 分支练习。</h1><p class="hero-copy">这是一个使用完全虚构数据构建的产品 Demo，用来练习从需求、前后端开发、自动测试到生产审批发布的完整闭环。</p></div><button class="button button-primary hero-action" data-new><span>＋</span> 新建同步任务</button></section>
      <section class="summary-grid"><article><span>任务总数</span><strong>${summary.totalTasks}</strong><small>个已登记任务</small></article><article><span>已启用</span><strong>${summary.enabledTasks}</strong><small>等待调度或手动运行</small></article><article><span>运行中</span><strong class="${summary.runningTasks ? "accent" : ""}">${summary.runningTasks}</strong><small>实时模拟执行</small></article><article><span>今日运行</span><strong>${summary.runsToday}</strong><small>次执行记录</small></article><article class="success-card"><span>执行成功率</span><strong>${summary.successRate}%</strong><small>基于已完成记录</small></article></section>
      ${state.error ? `<div class="error-banner"><span>!</span>${escapeHtml(state.error)}<button data-dismiss>关闭</button></div>` : ""}
      <section class="workspace" id="tasks"><div class="panel task-panel"><div class="panel-heading"><div><p class="eyebrow">TASKS</p><h2>同步任务</h2></div><span>${state.tasks.length} 项</span></div><div class="task-list">${state.tasks.map(taskCard).join("")}</div></div><aside class="panel detail-panel"><div class="panel-heading"><div><p class="eyebrow">RUN HISTORY</p><h2>运行记录</h2></div><span>${task ? statusMeta[task.status][0] : "—"}</span></div>${runHistory(task)}</aside></section>
    </main>
    <footer><span>数栈 Data Platform Lab</span><span>虚构数据 · 学习环境 · 禁止接入真实业务</span></footer>
    ${state.editing !== undefined ? taskForm(state.editing) : ""}
  </div>`;
  applyPrimaryNav();
}

async function action(id, type) {
  state.busyId = id; state.error = undefined; render();
  try { await request(`/api/tasks/${id}/${type}`, { method: "POST" }); state.selectedId = id; await refresh(); }
  catch (error) { state.error = error.message; state.busyId = undefined; render(); }
}

document.addEventListener("click", async (event) => {
  const selector = "button, [data-select], [data-dev-select], a.nav-item";
  const target = event.composedPath?.().find((node) => node?.matches?.(selector))
    ?? event.target?.closest?.(selector)
    ?? event.target?.parentElement?.closest?.(selector);
  if (!target) return;
  if (target.classList.contains("nav-item")) {
    event.preventDefault();
    const href = target.getAttribute("href");
    state.view = href.includes("view=sources") || href.endsWith("#sources") ? "sources" : href.includes("view=development") || href.endsWith("#development") ? "development" : href.includes("view=masking") || href.endsWith("#masking") ? "masking" : href.includes("view=assets") || href.endsWith("#assets") ? "assets" : href.includes("view=security") || href.endsWith("#security") ? "security" : href.includes("view=agent") || href.endsWith("#agent") ? "agent" : href.includes("view=quality") || href.endsWith("#quality") ? "quality" : href.includes("view=holdings-report") || href.endsWith("#holdings-report") ? "holdings-report" : href.includes("view=realtime") || href.endsWith("#realtime") ? "realtime" : href.includes("view=ops") || href.endsWith("#ops") ? "ops" : "sync";
    window.history.replaceState({}, "", href);
    // Switch the visible view immediately. The data refresh can involve a
    // network round trip; waiting for it made navigation look unresponsive.
    render();
    refreshCurrentView().catch((error) => { state.error = error.message; render(); });
    return;
  }
  if (target.dataset.new !== undefined) { state.editing = null; return render(); }
  if (target.dataset.newDev !== undefined) { state.devEditing = null; return render(); }
  if (target.dataset.newMasking !== undefined) { state.maskingEditing = null; return render(); }
  const clickedBackdrop = event.target?.classList?.contains?.("modal-backdrop") ?? false;
  if (target.dataset.devClose !== undefined || clickedBackdrop) { state.devEditing = undefined; return render(); }
  if (target.dataset.maskClose !== undefined) { state.maskingEditing = undefined; return render(); }
  if (target.dataset.close !== undefined || clickedBackdrop) { state.editing = undefined; return render(); }
  if (target.dataset.dismiss !== undefined) { state.error = undefined; return render(); }
  if (target.dataset.maskDismissPreview !== undefined) { state.maskingPreview = undefined; return render(); }
  if (target.dataset.edit) { state.editing = state.tasks.find((task) => task.id === target.dataset.edit); return render(); }
  if (target.dataset.action) return action(target.dataset.id, target.dataset.action);
  if (target.dataset.devSelect) { state.devSelectedId = target.dataset.devSelect; state.devRuns = await request(`/api/dev/jobs/${state.devSelectedId}/runs`); return render(); }
  if (target.dataset.devAction) {
    state.busyId = target.dataset.id; state.error = undefined; render();
    try {
      const response = await request(`/api/dev/jobs/${target.dataset.id}/${target.dataset.devAction}`, { method: "POST" });
      if (target.dataset.devAction === "validate") window.alert(response.warnings?.length ? `SQL 校验通过，但有提醒：\n${response.warnings.join("\n")}` : "SQL 校验通过");
      if (target.dataset.devAction === "deploy") window.alert(`已发布到模拟 ${response.release.environment} 调度环境。`);
      state.devSelectedId = target.dataset.id; await refreshDevelopment();
    } catch (error) { state.error = error.message; state.busyId = undefined; render(); }
    return;
  }
  if (target.dataset.maskToggle) {
    state.busyId = target.dataset.maskToggle; state.error = undefined; render();
    try { await request(`/api/masking/rules/${target.dataset.maskToggle}/toggle`, { method: "POST" }); await refreshMasking(); }
    catch (error) { state.error = error.message; state.busyId = undefined; render(); }
    return;
  }
  if (target.dataset.maskPreview) {
    state.busyId = target.dataset.maskPreview; state.error = undefined; render();
    try { state.maskingPreview = await request(`/api/masking/rules/${target.dataset.maskPreview}/preview`, { method: "POST", body: JSON.stringify({ operator: "演示用户" }) }); await refreshMasking(); }
    catch (error) { state.error = error.message; state.busyId = undefined; render(); }
    return;
  }
  if (target.dataset.assetSelect) {
    state.assetSelectedId = target.dataset.assetSelect;
    state.assetDetail = await request(`/api/assets/${state.assetSelectedId}`);
    return render();
  }
  if (target.dataset.agentPrompt) { state.agentMessage = target.dataset.agentPrompt; return render(); }
  if (target.dataset.agentConfirm) {
    state.busyId = target.dataset.agentConfirm; state.error = undefined; render();
    try { const sql = document.querySelector("#agent-sql-editor")?.value; const result = await request(`/api/agent/plans/${target.dataset.agentConfirm}/confirm`, { method: "POST", body: JSON.stringify({ planId: target.dataset.agentConfirm, userId: state.agentPlan?.userId ?? "user-platform-admin", draft: sql ? { sql } : undefined }) }); state.agentPlan = result; await refreshAgent(); }
    catch (error) { state.error = error.message; state.busyId = undefined; render(); }
    return;
  }
  if (target.dataset.qualitySelect) { state.qualitySelectedRuleId = target.dataset.qualitySelect; state.qualityRuns = await request(`/api/quality/rules/${state.qualitySelectedRuleId}/runs`); return render(); }
  if (target.dataset.qualityToggle) {
    state.busyId = target.dataset.qualityToggle; state.error = undefined; render();
    try { await request(`/api/quality/rules/${target.dataset.qualityToggle}/toggle`, { method: "POST" }); await refreshQuality(); }
    catch (error) { state.error = error.message; state.busyId = undefined; render(); }
    return;
  }
  if (target.dataset.qualityRun) {
    state.busyId = target.dataset.qualityRun; state.error = undefined; render();
    try { state.qualitySelectedRuleId = target.dataset.qualityRun; await request(`/api/quality/rules/${target.dataset.qualityRun}/run`, { method: "POST" }); await refreshQuality(); }
    catch (error) { state.error = error.message; state.busyId = undefined; render(); }
    return;
  }
  if (target.dataset.streamStart || target.dataset.streamStop) {
    const action = target.dataset.streamStart ? "start" : "stop";
    const id = target.dataset.streamStart ?? target.dataset.streamStop;
    state.busyId = id; state.error = undefined; render();
    try { await request(`/api/stream/jobs/${id}/${action}`, { method: "POST" }); await refreshRealtime(); }
    catch (error) { state.error = error.message; state.busyId = undefined; render(); }
    return;
  }
  if (target.dataset.sourceTest) {
    state.busyId = target.dataset.sourceTest; state.error = undefined; render();
    try { await request(`/api/sources/${target.dataset.sourceTest}/test`, { method: "POST" }); await refreshSources(); }
    catch (error) { state.error = error.message; state.busyId = undefined; render(); }
    return;
  }
  if (target.dataset.sourceMetadata) {
    state.busyId = target.dataset.sourceMetadata; state.error = undefined; render();
    try { await request(`/api/sources/${target.dataset.sourceMetadata}/metadata`, { method: "POST" }); await refreshSources(); }
    catch (error) { state.error = error.message; state.busyId = undefined; render(); }
    return;
  }
  if (target.dataset.opsAck || target.dataset.opsResolve) {
    const action = target.dataset.opsAck ? "acknowledge" : "resolve";
    const id = target.dataset.opsAck ?? target.dataset.opsResolve;
    state.busyId = id; state.error = undefined; render();
    try { await request(`/api/ops/incidents/${id}/${action}`, { method: "POST" }); await refreshOps(); }
    catch (error) { state.error = error.message; state.busyId = undefined; render(); }
    return;
  }
  if (target.dataset.select) { state.selectedId = target.dataset.select; state.runs = await request(`/api/tasks/${state.selectedId}/runs`); return render(); }
});

document.addEventListener("submit", async (event) => {
  if (event.target.id === "agent-plan-form") {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target));
    state.agentMessage = data.message;
    try { state.agentPlan = await request("/api/agent/plan", { method: "POST", body: JSON.stringify(data) }); await refreshAgent(); }
    catch (error) { state.error = error.message; render(); }
    return;
  }
  if (event.target.id === "asset-search-form") {
    event.preventDefault();
    state.assetQuery = new FormData(event.target).get("q")?.toString().trim() ?? "";
    await refreshAssets().catch((error) => { state.error = error.message; render(); });
    return;
  }
  if (event.target.id === "security-check-form") {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target));
    state.securitySelectedUserId = data.userId;
    try { state.securityCheckResult = await request("/api/security/access-check", { method: "POST", body: JSON.stringify({ ...data, resourceType: "asset" }) }); await refreshSecurity(); }
    catch (error) { state.error = error.message; render(); }
    return;
  }
  if (event.target.id === "dev-job-form") {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target)); data.jobType = "SQL"; data.enabled = event.target.elements.enabled.checked;
    try { const saved = await request("/api/dev/jobs", { method: "POST", body: JSON.stringify(data) }); state.devSelectedId = saved.id; state.devEditing = undefined; await refreshDevelopment(); }
    catch (error) { state.error = error.message; state.devEditing = undefined; render(); }
    return;
  }
  if (event.target.id === "masking-rule-form") {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target)); data.enabled = event.target.elements.enabled.checked;
    try { state.maskingPreview = undefined; state.maskingEditing = undefined; await request("/api/masking/rules", { method: "POST", body: JSON.stringify(data) }); await refreshMasking(); }
    catch (error) { state.error = error.message; state.maskingEditing = undefined; render(); }
    return;
  }
  if (event.target.id !== "task-form") return;
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  data.enabled = event.target.elements.enabled.checked;
  try {
    const saved = await request(state.editing ? `/api/tasks/${state.editing.id}` : "/api/tasks", { method: state.editing ? "PUT" : "POST", body: JSON.stringify(data) });
    state.selectedId = saved.id; state.editing = undefined; await refresh();
  } catch (error) { state.error = error.message; state.editing = undefined; render(); }
});

render();
const initialLoad = refreshCurrentView();
initialLoad.catch((error) => { state.error = error.message; render(); });
window.addEventListener("hashchange", () => {
  state.view = requestedView();
  render();
  refreshCurrentView().catch((error) => { state.error = error.message; render(); });
});
setInterval(() => { if (state.tasks.some((task) => task.status === "RUNNING")) refresh().catch(() => {}); }, 900);
