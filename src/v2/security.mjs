import { createHash } from "node:crypto";
import { getContext } from "./context.mjs";

const fail = (status, message, code, extra = {}) =>
  Object.assign(new Error(message), { status, code, ...extra });
const hash = (value) => createHash("sha256").update(String(value)).digest("hex");
const canonical = (value) =>
  JSON.stringify(
    value && typeof value === "object"
      ? Array.isArray(value)
        ? value.map((item) => JSON.parse(canonical(item)))
        : Object.fromEntries(
            Object.keys(value)
              .filter((key) => value[key] !== undefined)
              .sort()
              .map((key) => [key, JSON.parse(canonical(value[key]))]),
          )
      : value,
  );
const stableHash = (value) => hash(canonical(value));
const text = (value, name, min = 1, max = 120) => {
  if (
    typeof value !== "string" ||
    value.trim().length < min ||
    value.length > max
  )
    throw fail(400, `${name}长度必须为${min}—${max}个字符`, "INVALID_TEXT");
  return value.trim();
};
const identifier = (value, name) => {
  const result = text(value, name, 2, 63);
  if (!/^[a-z][a-z0-9_]*$/.test(result))
    throw fail(400, `${name}只能使用小写字母、数字和下划线`, "INVALID_IDENTIFIER");
  return result;
};
const PERSONAS = Object.freeze([
  {
    id: "user-wealth-advisor",
    displayName: "虚构财富顾问A",
    role: "WEALTH_ADVISOR",
    advisorId: "ADVISOR-DEMO-A",
  },
  {
    id: "user-data-engineer",
    displayName: "虚构数据开发工程师",
    role: "DATA_ENGINEER",
  },
  {
    id: "user-auditor",
    displayName: "虚构审计员",
    role: "AUDITOR",
  },
  {
    id: "user-data-owner",
    displayName: "虚构数据负责人",
    role: "DATA_OWNER",
  },
]);
const ACTIONS = new Set(["ALLOW", "MASK_PARTIAL", "MASK_FULL", "HASH", "DENY"]);
const ROW_SCOPES = new Set(["ALL", "ADVISOR_CLIENTS", "DENY"]);

export class SecurityManager {
  constructor({ store, assets, project, now = () => Date.now() }) {
    this.store = store;
    this.assets = assets;
    this.project = project;
    this.now = now;
  }

  personas() {
    return PERSONAS.map((item) => ({ ...item, authentication: "LOCAL_SYNTHETIC_HEADER" }));
  }

  listPolicies() {
    return this.store
      .list("security_policy", this.project)
      .map((policy) => this.policyDetail(policy.id));
  }

  policyDetail(id) {
    const policy = this.#policy(id),
      versions = this.store
        .list("security_policy_version", this.project)
        .filter((version) => version.policyId === policy.id)
        .sort((a, b) => b.versionNumber - a.versionNumber);
    return {
      ...policy,
      currentVersion: versions.find(
        (version) => version.id === policy.currentVersionId,
      ),
      versions,
    };
  }

  createPolicy(input) {
    const normalized = this.#normalizePolicy(input),
      code = identifier(input.code, "策略代码");
    if (
      this.store
        .list("security_policy", this.project)
        .some((policy) => policy.code === code)
    )
      throw fail(409, "安全策略代码已存在", "DUPLICATE_SECURITY_POLICY");
    const policy = this.store.create("security_policy", this.project, {
        name: text(input.name, "策略名称", 2, 80),
        code,
        assetId: normalized.assetId,
        status: "ACTIVE",
      }),
      version = this.store.create("security_policy_version", this.project, {
        policyId: policy.id,
        versionNumber: 1,
        ...normalized,
        status: "ACTIVE",
      });
    this.store.update("security_policy", policy.id, this.project, {
      currentVersionId: version.id,
    });
    return this.policyDetail(policy.id);
  }

  createPolicyVersion(policyId, input) {
    const policy = this.#policy(policyId),
      current = this.#version(policy.currentVersionId),
      normalized = this.#normalizePolicy({
        assetId: policy.assetId,
        roles: input.roles ?? current.roles,
        rowScope: input.rowScope ?? current.rowScope,
        fieldActions: input.fieldActions ?? current.fieldActions,
        defaultAction: input.defaultAction ?? current.defaultAction,
        description: input.description ?? current.description,
      });
    this.store.update("security_policy_version", current.id, this.project, {
      status: "RETIRED",
      retiredAt: new Date(this.now()).toISOString(),
    });
    const version = this.store.create("security_policy_version", this.project, {
      policyId: policy.id,
      versionNumber:
        this.store
          .list("security_policy_version", this.project)
          .filter((item) => item.policyId === policy.id).length + 1,
      ...normalized,
      status: "ACTIVE",
    });
    this.store.update("security_policy", policy.id, this.project, {
      currentVersionId: version.id,
    });
    return this.policyDetail(policy.id);
  }

  validateAgentPlan(value) {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      value.kind !== "SECURITY_POLICY"
    )
      throw fail(422, "Agent未返回可验证的安全策略", "INVALID_SECURITY_PLAN");
    return {
      kind: "SECURITY_POLICY",
      name: text(value.name, "策略名称", 2, 80),
      code: identifier(value.code, "策略代码"),
      ...this.#normalizePolicy(value),
    };
  }

  evaluate(actorId, assetId) {
    const actor = this.#actor(actorId),
      { asset } = this.assets.executionRows(assetId),
      policy = this.listPolicies().find(
        (item) =>
          item.assetId === asset.id &&
          item.status === "ACTIVE" &&
          item.currentVersion.roles.includes(actor.role),
      ),
      grant = this.#activeGrant(actor.id, asset.id);
    if (!policy && !grant)
      return {
        actor,
        assetId: asset.id,
        decision: "DENY",
        reason: "没有匹配的生效策略或临时授权",
        authentication: "LOCAL_SYNTHETIC_HEADER",
        publicEnforced: false,
      };
    const version = policy?.currentVersion,
      fieldActions =
        version?.fieldActions ??
        (grant?.scope === "READ_FULL"
          ? Object.fromEntries(asset.fields.map((field) => [field.name, "ALLOW"]))
          : defaultGrantActions(asset.fields.map((field) => field.name))),
      rowScope = version?.rowScope ?? (actor.role === "WEALTH_ADVISOR" ? "ADVISOR_CLIENTS" : "ALL");
    return {
      actor,
      assetId: asset.id,
      decision: rowScope === "DENY" ? "DENY" : "ALLOW",
      reason: policy ? "命中版本化策略" : "命中已审批临时授权",
      policyId: policy?.id,
      policyVersionId: version?.id,
      grantId: grant?.id,
      rowScope,
      fieldActions,
      authentication: "LOCAL_SYNTHETIC_HEADER",
      publicEnforced: false,
    };
  }

  query(actorId, assetId) {
    const evaluation = this.evaluate(actorId, assetId),
      started = this.now();
    if (evaluation.decision !== "ALLOW") {
      const audit = this.#audit({
        actorId: evaluation.actor.id,
        action: "SECURE_QUERY",
        assetId: evaluation.assetId,
        decision: "DENY",
        reason: evaluation.reason,
        rowCount: 0,
      });
      throw fail(403, "当前虚构身份无权查询该资产", "SECURITY_ACCESS_DENIED", {
        auditId: audit.id,
      });
    }
    const { asset, rows } = this.assets.executionRows(assetId),
      scoped = this.#scopeRows(evaluation.actor, evaluation.rowScope, rows),
      allowedFields = asset.fields
        .map((field) => field.name)
        .filter(
          (field) =>
            (evaluation.fieldActions[field] ?? "DENY") !== "DENY",
        ),
      maskedFields = allowedFields.filter(
        (field) =>
          (evaluation.fieldActions[field] ?? "DENY") !== "ALLOW",
      ),
      output = scoped.map((row) =>
        Object.fromEntries(
          allowedFields.map((field) => [
            field,
            mask(row[field], evaluation.fieldActions[field] ?? "DENY"),
          ]),
        ),
      ),
      audit = this.#audit({
        actorId: evaluation.actor.id,
        action: "SECURE_QUERY",
        assetId: asset.id,
        decision: "ALLOW",
        reason: evaluation.reason,
        policyId: evaluation.policyId,
        policyVersionId: evaluation.policyVersionId,
        grantId: evaluation.grantId,
        rowCount: output.length,
        maskedFields,
        durationMs: this.now() - started,
        resultHash: stableHash(output),
      });
    return {
      actor: evaluation.actor,
      assetId: asset.id,
      assetEvidenceHash: asset.evidenceHash,
      decision: "ALLOW",
      policyId: evaluation.policyId,
      policyVersionId: evaluation.policyVersionId,
      grantId: evaluation.grantId,
      rowScope: evaluation.rowScope,
      columns: allowedFields,
      maskedFields,
      rowCount: output.length,
      rows: output,
      auditId: audit.id,
      authentication: "LOCAL_SYNTHETIC_HEADER",
      publicEnforced: false,
    };
  }

  createRequest(actorId, input) {
    const actor = this.#actor(actorId),
      { asset } = this.assets.executionRows(text(input.assetId, "资产编号", 4, 160)),
      scope = input.scope;
    if (!new Set(["READ_MASKED", "READ_FULL"]).has(scope))
      throw fail(400, "申请范围不支持", "INVALID_ACCESS_SCOPE");
    const request = this.store.create("access_request", this.project, {
      requesterId: actor.id,
      requesterRole: actor.role,
      assetId: asset.id,
      scope,
      reason: text(input.reason, "申请理由", 4, 500),
      status: "PENDING",
      authentication: "LOCAL_SYNTHETIC_HEADER",
    });
    this.#audit({
      actorId: actor.id,
      action: "ACCESS_REQUEST_CREATED",
      assetId: asset.id,
      decision: "PENDING",
      requestId: request.id,
    });
    return request;
  }

  listRequests() {
    return this.store.list("access_request", this.project);
  }

  reviewRequest(reviewerId, requestId, input) {
    const reviewer = this.#actor(reviewerId);
    if (reviewer.role !== "DATA_OWNER")
      throw fail(403, "只有虚构数据负责人可以审批", "SECURITY_REVIEW_FORBIDDEN");
    const request = this.store.get("access_request", text(requestId, "申请编号", 3, 80), this.project);
    if (!request) throw fail(404, "未找到权限申请", "ACCESS_REQUEST_NOT_FOUND");
    if (request.status !== "PENDING")
      throw fail(409, "权限申请已经处理", "ACCESS_REQUEST_REVIEWED");
    const decision = input.decision;
    if (!["APPROVE", "REJECT"].includes(decision))
      throw fail(400, "审批决定不支持", "INVALID_REVIEW_DECISION");
    let grant;
    if (decision === "APPROVE") {
      const hours = Number(input.durationHours ?? 24);
      if (!Number.isSafeInteger(hours) || hours < 1 || hours > 168)
        throw fail(400, "临时授权必须为1—168小时", "INVALID_GRANT_DURATION");
      grant = this.store.create("security_grant", this.project, {
        requestId: request.id,
        actorId: request.requesterId,
        assetId: request.assetId,
        scope: request.scope,
        status: "ACTIVE",
        approvedBy: reviewer.id,
        expiresAt: new Date(this.now() + hours * 3_600_000).toISOString(),
      });
    }
    const reviewed = this.store.update("access_request", request.id, this.project, {
      status: decision === "APPROVE" ? "APPROVED" : "REJECTED",
      reviewerId: reviewer.id,
      reviewNote: text(input.reviewNote, "审批意见", 2, 500),
      grantId: grant?.id,
      reviewedAt: new Date(this.now()).toISOString(),
    });
    this.#audit({
      actorId: reviewer.id,
      action: "ACCESS_REQUEST_REVIEWED",
      assetId: request.assetId,
      decision,
      requestId: request.id,
      grantId: grant?.id,
    });
    return { request: reviewed, grant };
  }

  listAudits() {
    return this.store.list("security_audit", this.project);
  }

  overview() {
    const policies = this.listPolicies(),
      requests = this.listRequests(),
      audits = this.listAudits(),
      grants = this.store.list("security_grant", this.project);
    return {
      scope: "LOCAL_SYNTHETIC_POLICY_ENGINE",
      publicAuthentication: false,
      personas: this.personas(),
      policies,
      requests,
      counts: {
        policies: policies.length,
        pendingRequests: requests.filter((item) => item.status === "PENDING").length,
        activeGrants: grants.filter(
          (item) => item.status === "ACTIVE" && Date.parse(item.expiresAt) > this.now(),
        ).length,
        allowAudits: audits.filter((item) => item.decision === "ALLOW").length,
        denyAudits: audits.filter((item) => item.decision === "DENY").length,
      },
      recentAudits: audits.slice(0, 30),
    };
  }

  agentContext() {
    return {
      personas: this.personas().map(({ id, displayName, role, advisorId }) => ({
        id,
        displayName,
        role,
        advisorId,
      })),
      assets: this.assets
        .listAssets()
        .filter((asset) => asset.executableMetrics)
        .map((asset) => ({
          id: asset.id,
          businessName: asset.businessName,
          kind: asset.kind,
          fields: asset.fields.map(({ name, type }) => ({ name, type })),
        })),
      policies: this.listPolicies().map((policy) => ({
        id: policy.id,
        code: policy.code,
        assetId: policy.assetId,
        roles: policy.currentVersion.roles,
        rowScope: policy.currentVersion.rowScope,
        fieldActions: policy.currentVersion.fieldActions,
      })),
    };
  }

  #normalizePolicy(input) {
    const { asset } = this.assets.executionRows(text(input.assetId, "资产编号", 4, 160)),
      roles = Array.isArray(input.roles)
        ? [...new Set(input.roles.map((role) => text(role, "角色", 3, 40)))]
        : [];
    if (
      !roles.length ||
      roles.length > PERSONAS.length ||
      roles.some((role) => !PERSONAS.some((persona) => persona.role === role))
    )
      throw fail(400, "策略角色必须来自本机合成身份", "INVALID_POLICY_ROLES");
    const rowScope = text(input.rowScope, "行范围", 3, 40);
    if (!ROW_SCOPES.has(rowScope))
      throw fail(400, "行范围不支持", "INVALID_ROW_SCOPE");
    const defaultAction = input.defaultAction ?? "DENY";
    if (!ACTIONS.has(defaultAction))
      throw fail(400, "默认字段动作不支持", "INVALID_FIELD_ACTION");
    if (
      !input.fieldActions ||
      typeof input.fieldActions !== "object" ||
      Array.isArray(input.fieldActions)
    )
      throw fail(400, "字段动作必须是对象", "INVALID_FIELD_ACTIONS");
    const known = new Set(asset.fields.map((field) => field.name)),
      fieldActions = Object.fromEntries(
        Object.entries(input.fieldActions).map(([field, action]) => {
          if (!known.has(field))
            throw fail(400, `策略引用未知字段${field}`, "SECURITY_FIELD_NOT_FOUND");
          if (!ACTIONS.has(action))
            throw fail(400, `字段${field}动作不支持`, "INVALID_FIELD_ACTION");
          return [field, action];
        }),
      ),
      config = { roles, rowScope, defaultAction, fieldActions };
    return {
      assetId: asset.id,
      ...config,
      description: text(input.description, "策略说明", 4, 500),
      configHash: stableHash({ assetId: asset.id, ...config }),
    };
  }

  #scopeRows(actor, scope, rows) {
    if (scope === "ALL") return rows;
    if (scope === "DENY") return [];
    if (!actor.advisorId) return [];
    const context = getContext("holdings-t1"),
      accounts = context.tables.find((table) => table.name === "accounts"),
      allowed = new Set(
        accounts.rows
          .filter((row) => row[1] === actor.advisorId)
          .map((row) => row[0]),
      );
    return rows.filter((row) => allowed.has(row.client_id));
  }

  #activeGrant(actorId, assetId) {
    return this.store
      .list("security_grant", this.project)
      .find(
        (grant) =>
          grant.actorId === actorId &&
          grant.assetId === assetId &&
          grant.status === "ACTIVE" &&
          Date.parse(grant.expiresAt) > this.now(),
      );
  }

  #audit(data) {
    return this.store.create("security_audit", this.project, {
      ...data,
      observedAt: new Date(this.now()).toISOString(),
      containsRowData: false,
    });
  }

  #actor(id) {
    const actor = PERSONAS.find((item) => item.id === text(id, "虚构身份", 3, 80));
    if (!actor) throw fail(401, "未知的本机合成身份", "UNKNOWN_LOCAL_ACTOR");
    return actor;
  }

  #policy(id) {
    const item = this.store.get("security_policy", text(id, "策略编号", 3, 80), this.project);
    if (!item) throw fail(404, "未找到安全策略", "SECURITY_POLICY_NOT_FOUND");
    return item;
  }

  #version(id) {
    const item = this.store.get("security_policy_version", text(id, "策略版本", 3, 80), this.project);
    if (!item) throw fail(404, "未找到安全策略版本", "SECURITY_VERSION_NOT_FOUND");
    return item;
  }
}

function mask(value, action) {
  if (action === "ALLOW") return value;
  if (action === "MASK_FULL") return "******";
  if (action === "HASH") return `sha256:${hash(value).slice(0, 16)}`;
  if (action === "MASK_PARTIAL") {
    const input = String(value ?? "");
    if (input.length <= 4) return "****";
    return `${input.slice(0, 3)}***${input.slice(-3)}`;
  }
  return undefined;
}

function defaultGrantActions(fields) {
  return Object.fromEntries(
    fields.map((field) => [
      field,
      field === "client_id"
        ? "MASK_PARTIAL"
        : field === "position_id"
          ? "MASK_FULL"
          : "ALLOW",
    ]),
  );
}
