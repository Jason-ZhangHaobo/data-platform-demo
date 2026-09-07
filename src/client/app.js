const statusMeta = {
  DRAFT: ["草稿", "neutral"], READY: ["待运行", "info"], RUNNING: ["运行中", "running"],
  SUCCESS: ["成功", "success"], FAILED: ["失败", "danger"], STOPPED: ["已停用", "neutral"],
};
const devStatusMeta = { DRAFT: ["草稿", "neutral"], READY: ["待发布", "info"], RUNNING: ["运行中", "running"], SUCCESS: ["成功", "success"], FAILED: ["失败", "danger"] };
const state = { view: window.location.hash === "#development" ? "development" : "sync", tasks: [], summary: {}, selectedId: undefined, runs: [], editing: undefined, devJobs: [], devRuns: [], devSelectedId: undefined, devEditing: undefined, error: undefined, busyId: undefined };
const app = document.querySelector("#app");
const API_BASE_URL = String(globalThis.DATA_PLATFORM_API_BASE_URL ?? "").replace(/\/$/, "");
const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
const formatTime = (value) => value ? new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value)) : "尚未运行";

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
    <div class="task-actions"><button class="button button-quiet" data-dev-action="validate" data-id="${job.id}">校验 SQL</button><button class="button button-run" data-dev-action="run" data-id="${job.id}" ${state.busyId === job.id || !job.enabled ? "disabled" : ""}>模拟运行</button></div>
  </article>`;
}

function devRunHistory(job) {
  if (!job) return `<div class="empty-state">请选择一个数据开发任务。</div>`;
  const list = state.devRuns.length ? state.devRuns.slice(0, 6).map((run) => `<li><span class="timeline-dot ${run.status.toLowerCase()}"></span><div><div class="run-row"><strong>${run.status === "SUCCESS" ? "执行成功" : run.status === "RUNNING" ? "执行中" : "执行失败"}</strong><time>${formatTime(run.startedAt)}</time></div><p>${escapeHtml(run.message)}</p><small>影响 ${Number(run.rowsAffected ?? 0).toLocaleString()} 行</small></div></li>`).join("") : `<li class="empty-state">还没有运行记录。</li>`;
  return `<div class="selected-task-summary"><span class="source-icon">SQL</span><div><strong>${escapeHtml(job.name)}</strong><small>${escapeHtml(job.description || "暂无任务说明")}</small></div></div><ol class="run-list">${list}</ol>`;
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

function renderDevelopment() {
  const job = state.devJobs.find((item) => item.id === state.devSelectedId);
  const enabled = state.devJobs.filter((item) => item.enabled).length;
  return `<div class="app-shell"><header class="topbar"><a class="brand" href="#top"><span class="brand-mark">数</span><span><strong>数栈</strong><small>DATA PLATFORM LAB</small></span></a><nav><a class="nav-item" href="#tasks">同步任务</a><a class="nav-item active" href="#development">数据开发</a><span class="nav-item muted">数据资产 · 即将开放</span></nav><div class="environment-pill"><span></span>本地演示环境</div></header><main id="top">
    <section class="hero"><div><p class="eyebrow">DATA DEVELOPMENT · MVP 0.1</p><h1>把 SQL 变成<br>可校验、可运行的任务。</h1><p class="hero-copy">这一版只做虚构数据模拟执行，先跑通 SQL 草稿、风险提示、运行记录和后续发布的产品流程。</p></div><button class="button button-primary hero-action" data-new-dev><span>＋</span> 新建 SQL 任务</button></section>
    <section class="summary-grid"><article><span>任务总数</span><strong>${state.devJobs.length}</strong><small>个 SQL 任务</small></article><article><span>待发布</span><strong>${enabled}</strong><small>可进入模拟执行</small></article><article><span>运行记录</span><strong>${state.devRuns.length}</strong><small>当前任务记录</small></article><article class="success-card"><span>当前阶段</span><strong>0.1</strong><small>模拟执行</small></article></section>
    ${state.error ? `<div class="error-banner"><span>!</span>${escapeHtml(state.error)}<button data-dismiss>关闭</button></div>` : ""}
    <section class="workspace"><div class="panel task-panel"><div class="panel-heading"><div><p class="eyebrow">SQL JOBS</p><h2>数据开发任务</h2></div><span>${state.devJobs.length} 项</span></div><div class="task-list">${state.devJobs.map(devJobCard).join("")}</div></div><aside class="panel detail-panel"><div class="panel-heading"><div><p class="eyebrow">RUN HISTORY</p><h2>运行记录</h2></div><span>${job ? devStatusMeta[job.status]?.[0] : "—"}</span></div>${devRunHistory(job)}</aside></section>
  </main><footer><span>数栈 Data Platform Lab</span><span>虚构数据 · 学习环境 · 禁止连接真实生产</span></footer>${state.devEditing !== undefined ? devJobForm(state.devEditing) : ""}</div>`;
}

function render() {
  if (state.view === "development") return renderDevelopment();
  const summary = { totalTasks: 0, enabledTasks: 0, runningTasks: 0, runsToday: 0, successRate: 100, ...state.summary };
  const task = selectedTask();
  app.innerHTML = `<div class="app-shell">
    <header class="topbar"><a class="brand" href="#top"><span class="brand-mark">数</span><span><strong>数栈</strong><small>DATA PLATFORM LAB</small></span></a><nav><a class="nav-item active" href="#tasks">同步任务</a><a class="nav-item" href="#development">数据开发</a><span class="nav-item muted">数据资产 · 即将开放</span></nav><div class="environment-pill"><span></span>本地演示环境</div></header>
    <main id="top">
      <section class="hero"><div><p class="eyebrow">OFFLINE SYNC CENTER · MVP 0.1</p><h1>让每一次数据流动<br>都清晰、可控、可追溯。</h1><p class="hero-copy">这是一个使用完全虚构数据构建的产品 Demo，用来练习从需求、前后端开发、自动测试到生产审批发布的完整闭环。</p></div><button class="button button-primary hero-action" data-new><span>＋</span> 新建同步任务</button></section>
      <section class="summary-grid"><article><span>任务总数</span><strong>${summary.totalTasks}</strong><small>个已登记任务</small></article><article><span>已启用</span><strong>${summary.enabledTasks}</strong><small>等待调度或手动运行</small></article><article><span>运行中</span><strong class="${summary.runningTasks ? "accent" : ""}">${summary.runningTasks}</strong><small>实时模拟执行</small></article><article><span>今日运行</span><strong>${summary.runsToday}</strong><small>次执行记录</small></article><article class="success-card"><span>执行成功率</span><strong>${summary.successRate}%</strong><small>基于已完成记录</small></article></section>
      ${state.error ? `<div class="error-banner"><span>!</span>${escapeHtml(state.error)}<button data-dismiss>关闭</button></div>` : ""}
      <section class="workspace" id="tasks"><div class="panel task-panel"><div class="panel-heading"><div><p class="eyebrow">TASKS</p><h2>同步任务</h2></div><span>${state.tasks.length} 项</span></div><div class="task-list">${state.tasks.map(taskCard).join("")}</div></div><aside class="panel detail-panel"><div class="panel-heading"><div><p class="eyebrow">RUN HISTORY</p><h2>运行记录</h2></div><span>${task ? statusMeta[task.status][0] : "—"}</span></div>${runHistory(task)}</aside></section>
    </main>
    <footer><span>数栈 Data Platform Lab</span><span>虚构数据 · 学习环境 · 禁止接入真实业务</span></footer>
    ${state.editing !== undefined ? taskForm(state.editing) : ""}
  </div>`;
}

async function action(id, type) {
  state.busyId = id; state.error = undefined; render();
  try { await request(`/api/tasks/${id}/${type}`, { method: "POST" }); state.selectedId = id; await refresh(); }
  catch (error) { state.error = error.message; state.busyId = undefined; render(); }
}

document.addEventListener("click", async (event) => {
  const target = event.target?.closest?.("button, [data-select], [data-dev-select], a.nav-item")
    ?? event.target?.parentElement?.closest?.("button, [data-select], [data-dev-select], a.nav-item");
  if (!target) return;
  if (target.classList.contains("nav-item")) {
    event.preventDefault();
    state.view = target.getAttribute("href") === "#development" ? "development" : "sync";
    window.history.replaceState({}, "", target.getAttribute("href"));
    // Switch the visible view immediately. The data refresh can involve a
    // network round trip; waiting for it made navigation look unresponsive.
    render();
    (state.view === "development" ? refreshDevelopment() : refresh()).catch((error) => { state.error = error.message; render(); });
    return;
  }
  if (target.dataset.new !== undefined) { state.editing = null; return render(); }
  if (target.dataset.newDev !== undefined) { state.devEditing = null; return render(); }
  const clickedBackdrop = event.target?.classList?.contains?.("modal-backdrop") ?? false;
  if (target.dataset.devClose !== undefined || clickedBackdrop) { state.devEditing = undefined; return render(); }
  if (target.dataset.close !== undefined || clickedBackdrop) { state.editing = undefined; return render(); }
  if (target.dataset.dismiss !== undefined) { state.error = undefined; return render(); }
  if (target.dataset.edit) { state.editing = state.tasks.find((task) => task.id === target.dataset.edit); return render(); }
  if (target.dataset.action) return action(target.dataset.id, target.dataset.action);
  if (target.dataset.devSelect) { state.devSelectedId = target.dataset.devSelect; state.devRuns = await request(`/api/dev/jobs/${state.devSelectedId}/runs`); return render(); }
  if (target.dataset.devAction) {
    state.busyId = target.dataset.id; state.error = undefined; render();
    try {
      const response = await request(`/api/dev/jobs/${target.dataset.id}/${target.dataset.devAction}`, { method: "POST" });
      if (target.dataset.devAction === "validate") window.alert(response.warnings?.length ? `SQL 校验通过，但有提醒：\n${response.warnings.join("\n")}` : "SQL 校验通过");
      state.devSelectedId = target.dataset.id; await refreshDevelopment();
    } catch (error) { state.error = error.message; state.busyId = undefined; render(); }
    return;
  }
  if (target.dataset.select) { state.selectedId = target.dataset.select; state.runs = await request(`/api/tasks/${state.selectedId}/runs`); return render(); }
});

document.addEventListener("submit", async (event) => {
  if (event.target.id === "dev-job-form") {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target)); data.jobType = "SQL"; data.enabled = event.target.elements.enabled.checked;
    try { const saved = await request("/api/dev/jobs", { method: "POST", body: JSON.stringify(data) }); state.devSelectedId = saved.id; state.devEditing = undefined; await refreshDevelopment(); }
    catch (error) { state.error = error.message; state.devEditing = undefined; render(); }
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

const initialLoad = state.view === "development" ? refreshDevelopment() : refresh();
initialLoad.catch((error) => { state.error = error.message; render(); });
window.addEventListener("hashchange", () => { state.view = window.location.hash === "#development" ? "development" : "sync"; (state.view === "development" ? refreshDevelopment() : refresh()).catch((error) => { state.error = error.message; render(); }); });
setInterval(() => { if (state.tasks.some((task) => task.status === "RUNNING")) refresh().catch(() => {}); }, 900);
