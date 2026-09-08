import { createHmac } from "node:crypto";
import { MemoryTaskStore } from "./memory-store.mjs";
import { createSeedState } from "./store.mjs";

const encodeKey = (key) => key.split("/").map(encodeURIComponent).join("/");

export class StorageConflictError extends Error {
  constructor() {
    super("云端数据刚刚被其他操作更新，请刷新后重试");
    this.name = "StorageConflictError";
  }
}

export function createOssRequest({ method, bucket, key, endpoint, credentials, body, etag }) {
  const date = new Date().toUTCString();
  const contentType = body === undefined ? "" : "application/json; charset=utf-8";
  const securityHeader = credentials.securityToken ? `x-oss-security-token:${credentials.securityToken}\n` : "";
  const canonicalResource = `/${bucket}/${key}`;
  const stringToSign = `${method}\n\n${contentType}\n${date}\n${securityHeader}${canonicalResource}`;
  const signature = createHmac("sha1", credentials.accessKeySecret).update(stringToSign, "utf8").digest("base64");
  const headers = {
    Date: date,
    Authorization: `OSS ${credentials.accessKeyId}:${signature}`,
  };
  if (contentType) headers["Content-Type"] = contentType;
  if (credentials.securityToken) headers["x-oss-security-token"] = credentials.securityToken;
  if (etag) headers["If-Match"] = etag;
  const host = endpoint.replace(/^https?:\/\//, "").replace(/\/$/, "");
  return {
    url: `https://${bucket}.${host}/${encodeKey(key)}`,
    options: { method, headers, body },
    stringToSign,
  };
}

export class OssTaskStore extends MemoryTaskStore {
  constructor(config, state, fetchImpl = fetch) {
    super(state);
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  static async open(config, fetchImpl = fetch) {
    const store = new OssTaskStore(config, createSeedState(), fetchImpl);
    const remote = await store.readRemote();
    if (remote) {
      store.replaceState(remote.state);
      store.etag = remote.etag;
    }
    else await store.persist();
    return store;
  }

  async request(method, body, etag) {
    const request = createOssRequest({ ...this.config, method, body, etag });
    return this.fetchImpl(request.url, request.options);
  }

  async readRemote() {
    const response = await this.request("GET");
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`OSS 读取失败（${response.status}）`);
    return { state: await response.json(), etag: response.headers.get("etag") };
  }

  async refresh() {
    const remote = await this.readRemote();
    if (remote) {
      this.replaceState(remote.state);
      this.etag = remote.etag;
    }
  }

  async persist() {
    const response = await this.request("PUT", JSON.stringify(this.state), this.etag);
    if (response.status === 412) throw new StorageConflictError();
    if (!response.ok) throw new Error(`OSS 写入失败（${response.status}）`);
    this.etag = response.headers.get("etag") ?? this.etag;
  }

  async listTasks() { await this.refresh(); return super.listTasks(); }
  async getTask(id) { await this.refresh(); return super.getTask(id); }
  async createTask(input) { await this.refresh(); return super.createTask(input); }
  async updateTask(id, input) { await this.refresh(); return super.updateTask(id, input); }
  async deleteTask(id) { await this.refresh(); return super.deleteTask(id); }
  async listRuns(taskId) { await this.refresh(); return super.listRuns(taskId); }
  async createRun(input) { await this.refresh(); return super.createRun(input); }
  async updateRun(id, patch) { await this.refresh(); return super.updateRun(id, patch); }
  async getSummary() { await this.refresh(); return super.getSummary(); }
  async listMaskingRules() { await this.refresh(); return super.listMaskingRules(); }
  async getMaskingRule(id) { await this.refresh(); return super.getMaskingRule(id); }
  async createMaskingRule(input) { await this.refresh(); return super.createMaskingRule(input); }
  async updateMaskingRule(id, patch) { await this.refresh(); return super.updateMaskingRule(id, patch); }
  async createMaskingPreview(input) { await this.refresh(); return super.createMaskingPreview(input); }
  async listMaskingPreviews(ruleId) { await this.refresh(); return super.listMaskingPreviews(ruleId); }
  async listAssets(filters) { await this.refresh(); return super.listAssets(filters); }
  async getAsset(id) { await this.refresh(); return super.getAsset(id); }
  async createAsset(input) { await this.refresh(); return super.createAsset(input); }
  async listSecurityRoles() { await this.refresh(); return super.listSecurityRoles(); }
  async listSecurityUsers() { await this.refresh(); return super.listSecurityUsers(); }
  async getSecurityUser(id) { await this.refresh(); return super.getSecurityUser(id); }
  async listAuditLogs(filters) { await this.refresh(); return super.listAuditLogs(filters); }
  async createAuditLog(input) { await this.refresh(); return super.createAuditLog(input); }
  async listAgentPlans() { await this.refresh(); return super.listAgentPlans(); }
  async getAgentPlan(id) { await this.refresh(); return super.getAgentPlan(id); }
  async createAgentPlan(input) { await this.refresh(); return super.createAgentPlan(input); }
  async updateAgentPlan(id, patch) { await this.refresh(); return super.updateAgentPlan(id, patch); }
}

export function ossConfigFromEnvironment(env = process.env) {
  const required = [
    "OSS_BUCKET",
    "ALIBABA_CLOUD_ACCESS_KEY_ID",
    "ALIBABA_CLOUD_ACCESS_KEY_SECRET",
  ];
  const missing = required.filter((key) => !env[key]);
  if (missing.length) throw new Error(`OSS 配置缺失：${missing.join(", ")}`);
  const region = env.FC_REGION ?? env.OSS_REGION ?? "cn-hangzhou";
  return {
    bucket: env.OSS_BUCKET,
    endpoint: env.OSS_ENDPOINT ?? `oss-${region}-internal.aliyuncs.com`,
    key: env.OSS_OBJECT_KEY ?? "data-platform-demo/store.json",
    credentials: {
      accessKeyId: env.ALIBABA_CLOUD_ACCESS_KEY_ID,
      accessKeySecret: env.ALIBABA_CLOUD_ACCESS_KEY_SECRET,
      securityToken: env.ALIBABA_CLOUD_SECURITY_TOKEN,
    },
  };
}
