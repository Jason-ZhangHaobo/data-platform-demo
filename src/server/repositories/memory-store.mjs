import { randomUUID } from "node:crypto";
import { createSeedState, summaryFromState } from "./store.mjs";

export class MemoryTaskStore {
  constructor(initialState = createSeedState()) { this.replaceState(initialState); }
  replaceState(initialState) {
    const seed = createSeedState();
    const provided = structuredClone(initialState);
    this.state = {
      ...seed,
      ...provided,
      tasks: provided.tasks ?? seed.tasks,
      runs: provided.runs ?? seed.runs,
      devJobs: provided.devJobs ?? seed.devJobs,
      devRuns: provided.devRuns ?? seed.devRuns,
      maskingRules: provided.maskingRules ?? seed.maskingRules,
      maskingPreviews: provided.maskingPreviews ?? seed.maskingPreviews,
      assets: provided.assets ?? seed.assets,
      securityRoles: provided.securityRoles ?? seed.securityRoles,
      securityUsers: provided.securityUsers ?? seed.securityUsers,
      auditLogs: provided.auditLogs ?? seed.auditLogs,
      agentPlans: provided.agentPlans ?? seed.agentPlans,
      qualityRules: provided.qualityRules ?? seed.qualityRules,
      qualityRuns: provided.qualityRuns ?? seed.qualityRuns,
      agentEvalRuns: provided.agentEvalRuns ?? seed.agentEvalRuns,
    };
    return this.state;
  }
  async listTasks() { return structuredClone([...this.state.tasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))); }
  async getTask(id) { const task = this.state.tasks.find((item) => item.id === id); return task ? structuredClone(task) : undefined; }
  async createTask(input) {
    const now = new Date().toISOString();
    const task = { ...input, id: randomUUID(), status: input.enabled ? "READY" : "STOPPED", createdAt: now, updatedAt: now };
    this.state.tasks.push(task); await this.persist(); return structuredClone(task);
  }
  async updateTask(id, input) {
    const index = this.state.tasks.findIndex((task) => task.id === id); if (index < 0) return undefined;
    this.state.tasks[index] = { ...this.state.tasks[index], ...input, updatedAt: new Date().toISOString() };
    await this.persist(); return structuredClone(this.state.tasks[index]);
  }
  async deleteTask(id) {
    const before = this.state.tasks.length;
    this.state.tasks = this.state.tasks.filter((task) => task.id !== id);
    this.state.runs = this.state.runs.filter((run) => run.taskId !== id);
    const deleted = this.state.tasks.length < before; if (deleted) await this.persist(); return deleted;
  }
  async listRuns(taskId) {
    const runs = taskId ? this.state.runs.filter((run) => run.taskId === taskId) : this.state.runs;
    return structuredClone([...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt)));
  }
  async createRun(input) { const run = { ...input, id: randomUUID() }; this.state.runs.push(run); await this.persist(); return structuredClone(run); }
  async updateRun(id, patch) {
    const index = this.state.runs.findIndex((run) => run.id === id); if (index < 0) return undefined;
    this.state.runs[index] = { ...this.state.runs[index], ...patch }; await this.persist(); return structuredClone(this.state.runs[index]);
  }
  async getSummary() { return summaryFromState(this.state); }
  async listDevJobs() { return structuredClone([...this.state.devJobs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))); }
  async getDevJob(id) { const job = this.state.devJobs.find((item) => item.id === id); return job ? structuredClone(job) : undefined; }
  async createDevJob(input) {
    const now = new Date().toISOString();
    const job = { ...input, id: randomUUID(), status: input.enabled ? "READY" : "DRAFT", createdAt: now, updatedAt: now };
    this.state.devJobs.push(job); await this.persist(); return structuredClone(job);
  }
  async updateDevJob(id, input) {
    const index = this.state.devJobs.findIndex((job) => job.id === id); if (index < 0) return undefined;
    this.state.devJobs[index] = { ...this.state.devJobs[index], ...input, updatedAt: new Date().toISOString() };
    await this.persist(); return structuredClone(this.state.devJobs[index]);
  }
  async listDevRuns(jobId) {
    const runs = jobId ? this.state.devRuns.filter((run) => run.jobId === jobId) : this.state.devRuns;
    return structuredClone([...runs].sort((a, b) => b.startedAt.localeCompare(a.startedAt)));
  }
  async createDevRun(input) { const run = { ...input, id: randomUUID() }; this.state.devRuns.push(run); await this.persist(); return structuredClone(run); }
  async updateDevRun(id, patch) {
    const index = this.state.devRuns.findIndex((run) => run.id === id); if (index < 0) return undefined;
    this.state.devRuns[index] = { ...this.state.devRuns[index], ...patch }; await this.persist(); return structuredClone(this.state.devRuns[index]);
  }
  async listMaskingRules() { return structuredClone([...this.state.maskingRules].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))); }
  async getMaskingRule(id) { const rule = this.state.maskingRules.find((item) => item.id === id); return rule ? structuredClone(rule) : undefined; }
  async createMaskingRule(input) {
    const now = new Date().toISOString();
    const rule = { ...input, id: randomUUID(), createdAt: now, updatedAt: now, previewCount: 0 };
    this.state.maskingRules.push(rule); await this.persist(); return structuredClone(rule);
  }
  async updateMaskingRule(id, patch) {
    const index = this.state.maskingRules.findIndex((rule) => rule.id === id); if (index < 0) return undefined;
    this.state.maskingRules[index] = { ...this.state.maskingRules[index], ...patch, updatedAt: new Date().toISOString() };
    await this.persist(); return structuredClone(this.state.maskingRules[index]);
  }
  async createMaskingPreview(input) { const preview = { ...input, id: randomUUID(), createdAt: new Date().toISOString() }; this.state.maskingPreviews.push(preview); await this.persist(); return structuredClone(preview); }
  async listMaskingPreviews(ruleId) { return structuredClone(this.state.maskingPreviews.filter((item) => !ruleId || item.ruleId === ruleId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))); }
  async listAssets(filters = {}) {
    const query = String(filters.q ?? "").trim().toLowerCase();
    const domain = String(filters.domain ?? "").trim();
    const sensitivity = String(filters.sensitivity ?? "").trim();
    const matches = (asset) => !query || [asset.name, asset.physicalName, asset.domain, asset.owner, asset.description, ...asset.tags, ...asset.fields.flatMap((field) => [field.name, field.label, field.description])].join(" ").toLowerCase().includes(query);
    return structuredClone(this.state.assets.filter((asset) => matches(asset) && (!domain || asset.domain === domain) && (!sensitivity || asset.sensitivity === sensitivity)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  }
  async getAsset(id) { const asset = this.state.assets.find((item) => item.id === id); return asset ? structuredClone(asset) : undefined; }
  async createAsset(input) {
    const now = new Date().toISOString();
    const asset = { ...input, id: randomUUID(), updatedAt: now, indexedAt: now, status: "ACTIVE" };
    this.state.assets.push(asset); await this.persist(); return structuredClone(asset);
  }
  async listSecurityRoles() { return structuredClone(this.state.securityRoles); }
  async listSecurityUsers() { return structuredClone(this.state.securityUsers); }
  async getSecurityUser(id) { const user = this.state.securityUsers.find((item) => item.id === id); return user ? structuredClone(user) : undefined; }
  async listAuditLogs(filters = {}) {
    const query = String(filters.q ?? "").trim().toLowerCase();
    const result = filters.result ? String(filters.result).trim() : "";
    const matches = (item) => !query || [item.actorName, item.action, item.resourceType, item.resourceId, item.reason].join(" ").toLowerCase().includes(query);
    return structuredClone(this.state.auditLogs.filter((item) => matches(item) && (!result || item.result === result)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }
  async createAuditLog(input) { const log = { ...input, id: randomUUID(), createdAt: new Date().toISOString() }; this.state.auditLogs.push(log); await this.persist(); return structuredClone(log); }
  async listAgentPlans() { return structuredClone([...this.state.agentPlans].sort((a, b) => b.createdAt.localeCompare(a.createdAt))); }
  async getAgentPlan(id) { const plan = this.state.agentPlans.find((item) => item.id === id); return plan ? structuredClone(plan) : undefined; }
  async createAgentPlan(input) { const plan = { ...input, id: randomUUID(), status: "AWAITING_CONFIRMATION", createdAt: new Date().toISOString() }; this.state.agentPlans.push(plan); await this.persist(); return structuredClone(plan); }
  async updateAgentPlan(id, patch) { const index = this.state.agentPlans.findIndex((plan) => plan.id === id); if (index < 0) return undefined; this.state.agentPlans[index] = { ...this.state.agentPlans[index], ...patch }; await this.persist(); return structuredClone(this.state.agentPlans[index]); }
  async listQualityRules() { return structuredClone([...this.state.qualityRules].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))); }
  async getQualityRule(id) { const rule = this.state.qualityRules.find((item) => item.id === id); return rule ? structuredClone(rule) : undefined; }
  async createQualityRule(input) { const now = new Date().toISOString(); const rule = { ...input, id: randomUUID(), updatedAt: now, lastStatus: "NOT_RUN", lastScore: null }; this.state.qualityRules.push(rule); await this.persist(); return structuredClone(rule); }
  async updateQualityRule(id, patch) { const index = this.state.qualityRules.findIndex((rule) => rule.id === id); if (index < 0) return undefined; this.state.qualityRules[index] = { ...this.state.qualityRules[index], ...patch, updatedAt: new Date().toISOString() }; await this.persist(); return structuredClone(this.state.qualityRules[index]); }
  async listQualityRuns(ruleId) { return structuredClone(this.state.qualityRuns.filter((run) => !ruleId || run.ruleId === ruleId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))); }
  async createQualityRun(input) { const run = { ...input, id: randomUUID(), createdAt: new Date().toISOString() }; this.state.qualityRuns.push(run); await this.persist(); return structuredClone(run); }
  async listAgentEvalRuns() { return structuredClone([...this.state.agentEvalRuns].sort((a, b) => b.createdAt.localeCompare(a.createdAt))); }
  async createAgentEvalRun(input) { const run = { ...input, id: randomUUID(), createdAt: new Date().toISOString() }; this.state.agentEvalRuns.push(run); await this.persist(); return structuredClone(run); }
  async persist() {}
}
