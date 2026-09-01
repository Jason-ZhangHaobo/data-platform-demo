import { randomUUID } from "node:crypto";
import { createSeedState, summaryFromState } from "./store.mjs";

export class MemoryTaskStore {
  constructor(initialState = createSeedState()) { this.state = structuredClone(initialState); }
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
  async persist() {}
}
