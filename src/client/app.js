const statusMeta = {
  DRAFT: ["草稿", "neutral"], READY: ["待运行", "info"], RUNNING: ["运行中", "running"],
  SUCCESS: ["成功", "success"], FAILED: ["失败", "danger"], STOPPED: ["已停用", "neutral"],
};
const state = { tasks: [], summary: {}, selectedId: undefined, runs: [], editing: undefined, error: undefined, busyId: undefined };
const app = document.querySelector("#app");
const escapeHtml = (value = "") => String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
const formatTime = (value) => value ? new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value)) : "尚未运行";

async function request(path, options) {
  const response = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options?.headers } });
  const body = response.status === 204 ? undefined : await response.json().catch(() => ({}));
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

function render() {
  const summary = { totalTasks: 0, enabledTasks: 0, runningTasks: 0, runsToday: 0, successRate: 100, ...state.summary };
  const task = selectedTask();
  app.innerHTML = `<div class="app-shell">
    <header class="topbar"><a class="brand" href="#top"><span class="brand-mark">数</span><span><strong>数栈</strong><small>DATA PLATFORM LAB</small></span></a><nav><a class="nav-item active" href="#tasks">同步任务</a><span class="nav-item muted">数据开发 · 即将开放</span><span class="nav-item muted">数据资产 · 即将开放</span></nav><div class="environment-pill"><span></span>本地演示环境</div></header>
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

app.addEventListener("click", async (event) => {
  const target = event.target.closest("button, [data-select]");
  if (!target) return;
  if (target.dataset.new !== undefined) { state.editing = null; return render(); }
  if (target.dataset.close !== undefined || event.target.classList.contains("modal-backdrop")) { state.editing = undefined; return render(); }
  if (target.dataset.dismiss !== undefined) { state.error = undefined; return render(); }
  if (target.dataset.edit) { state.editing = state.tasks.find((task) => task.id === target.dataset.edit); return render(); }
  if (target.dataset.action) return action(target.dataset.id, target.dataset.action);
  if (target.dataset.select) { state.selectedId = target.dataset.select; state.runs = await request(`/api/tasks/${state.selectedId}/runs`); return render(); }
});

app.addEventListener("submit", async (event) => {
  if (event.target.id !== "task-form") return;
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  data.enabled = event.target.elements.enabled.checked;
  try {
    const saved = await request(state.editing ? `/api/tasks/${state.editing.id}` : "/api/tasks", { method: state.editing ? "PUT" : "POST", body: JSON.stringify(data) });
    state.selectedId = saved.id; state.editing = undefined; await refresh();
  } catch (error) { state.error = error.message; state.editing = undefined; render(); }
});

refresh().catch((error) => { state.error = error.message; render(); });
setInterval(() => { if (state.tasks.some((task) => task.status === "RUNNING")) refresh().catch(() => {}); }, 900);
