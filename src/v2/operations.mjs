const fail = (status, message, code) =>
  Object.assign(new Error(message), { status, code });
const text = (value, name, min = 1, max = 500) => {
  if (
    typeof value !== "string" ||
    value.trim().length < min ||
    value.length > max
  )
    throw fail(400, `${name}长度必须为${min}—${max}个字符`, "INVALID_TEXT");
  return value.trim();
};

const FAILURE_SOURCES = [
  {
    kind: "offline_sync_run",
    domain: "离线同步",
    failed: (item) => item.status === "FAILED",
    resource: (item) => ({ type: "offline_sync_task", id: item.taskId }),
  },
  {
    kind: "stream_run",
    domain: "实时同步",
    failed: (item) => item.status === "FAILED",
    resource: (item) => ({ type: "stream_job", id: item.jobId }),
  },
  {
    kind: "quality_run",
    domain: "数据质量",
    failed: (item) => item.status === "FAILED",
    resource: (item) => ({ type: "quality_rule", id: item.ruleId }),
  },
  {
    kind: "release_run",
    domain: "调度发布",
    failed: (item) => ["FAILED", "VALIDATION_FAILED"].includes(item.status),
    resource: (item) => ({ type: "release", id: item.releaseId }),
  },
  {
    kind: "data_service_test",
    domain: "数据服务",
    failed: (item) => item.status === "FAILED",
    resource: (item) => ({ type: "data_service", id: item.serviceId }),
  },
];

export class OperationsManager {
  constructor({ store, project, now = () => Date.now() }) {
    this.store = store;
    this.project = project;
    this.now = now;
  }

  refresh() {
    const created = [],
      updated = [];
    for (const source of FAILURE_SOURCES)
      for (const failure of this.store
        .list(source.kind, this.project)
        .filter(source.failed)) {
        const existing = this.store
            .list("ops_incident", this.project)
            .find(
              (incident) =>
                incident.sourceKind === source.kind &&
                incident.sourceId === failure.id,
            ),
          resource = source.resource(failure),
          recovery = this.#recovery(source.kind, failure),
          data = {
            domain: source.domain,
            sourceKind: source.kind,
            sourceId: failure.id,
            sourceStatus: failure.status,
            sourceCreatedAt: failure.createdAt,
            resourceType: resource.type,
            resourceId: resource.id,
            severity:
              source.kind === "release_run" || source.kind === "stream_run"
                ? "HIGH"
                : "MEDIUM",
            title: `${source.domain}运行失败`,
            errorCode: failure.errorCode ?? failure.code ?? "EXECUTION_FAILED",
            message: String(failure.error ?? "实际运行未通过").slice(0, 500),
            status: recovery ? "RESOLVED" : "OPEN",
            recoveryKind: recovery?.kind,
            recoveryId: recovery?.id,
            resolutionMode: recovery?.mode,
            resolvedAt: recovery?.resolvedAt,
            containsBusinessRows: false,
          };
        if (!existing)
          created.push(this.store.create("ops_incident", this.project, data));
        else if (
          existing.status !== data.status ||
          existing.recoveryId !== data.recoveryId
        )
          updated.push(
            this.store.update("ops_incident", existing.id, this.project, data),
          );
      }
    return {
      scannedKinds: FAILURE_SOURCES.map((source) => source.kind),
      created,
      updated,
      overview: this.overview(),
    };
  }

  listIncidents() {
    return this.store.list("ops_incident", this.project);
  }

  incidentDetail(id) {
    const incident = this.#incident(id),
      source = this.store.get(
        incident.sourceKind,
        incident.sourceId,
        this.project,
      ),
      recovery = incident.recoveryKind
        ? this.store.get(
            incident.recoveryKind,
            incident.recoveryId,
            this.project,
          )
        : undefined;
    return {
      ...incident,
      sourceEvidence: publicEvidence(source),
      recoveryEvidence: publicEvidence(recovery),
      acknowledgements: this.store
        .list("ops_incident_event", this.project)
        .filter((event) => event.incidentId === incident.id),
    };
  }

  acknowledge(id, input) {
    const incident = this.#incident(id);
    if (!new Set(["OPEN", "ACKNOWLEDGED"]).has(incident.status))
      throw fail(409, "已恢复事故不需要确认", "INCIDENT_NOT_OPEN");
    const event = this.store.create("ops_incident_event", this.project, {
      incidentId: incident.id,
      type: "ACKNOWLEDGED",
      actor: text(input.actor ?? "local-operator", "操作人", 3, 80),
      note: text(input.note, "确认说明", 4, 500),
      observedAt: new Date(this.now()).toISOString(),
    });
    this.store.update("ops_incident", incident.id, this.project, {
      status: "ACKNOWLEDGED",
      acknowledgedAt: event.observedAt,
      acknowledgedBy: event.actor,
    });
    return this.incidentDetail(incident.id);
  }

  resolve(id, input) {
    const incident = this.#incident(id);
    if (!new Set(["OPEN", "ACKNOWLEDGED"]).has(incident.status))
      throw fail(409, "事故已经恢复", "INCIDENT_ALREADY_RESOLVED");
    const evidenceKind = text(input.evidenceKind, "恢复证据类型", 3, 80),
      evidenceId = text(input.evidenceId, "恢复证据编号", 3, 80),
      evidence = this.store.get(evidenceKind, evidenceId, this.project);
    if (!evidence)
      throw fail(404, "未找到恢复证据", "RECOVERY_EVIDENCE_NOT_FOUND");
    if (!new Set(["SUCCEEDED", "PASSED"]).has(evidence.status))
      throw fail(409, "恢复证据未成功", "RECOVERY_EVIDENCE_NOT_SUCCESSFUL");
    if (
      !sameResource(incident, evidenceKind, evidence) ||
      Date.parse(evidence.createdAt) <= Date.parse(incident.sourceCreatedAt)
    )
      throw fail(
        409,
        "恢复证据必须属于同一资源且晚于失败",
        "RECOVERY_EVIDENCE_MISMATCH",
      );
    const event = this.store.create("ops_incident_event", this.project, {
      incidentId: incident.id,
      type: "RESOLVED",
      actor: text(input.actor ?? "local-operator", "操作人", 3, 80),
      note: text(input.note, "恢复说明", 4, 500),
      evidenceKind,
      evidenceId,
      observedAt: new Date(this.now()).toISOString(),
    });
    this.store.update("ops_incident", incident.id, this.project, {
      status: "RESOLVED",
      recoveryKind: evidenceKind,
      recoveryId: evidenceId,
      resolutionMode: "VERIFIED_EVIDENCE",
      resolvedAt: event.observedAt,
    });
    return this.incidentDetail(incident.id);
  }

  overview() {
    const incidents = this.listIncidents(),
      domainCounts = {};
    for (const domain of [
      "数据开发",
      "离线同步",
      "实时同步",
      "调度发布",
      "数据质量",
      "数据服务",
      "数据报表",
      "安全审计",
    ])
      domainCounts[domain] = { failures: 0, running: 0, succeeded: 0 };
    const mappings = [
      ["run", "数据开发"],
      ["offline_sync_run", "离线同步"],
      ["stream_run", "实时同步"],
      ["release_run", "调度发布"],
      ["quality_run", "数据质量"],
      ["data_service_test", "数据服务"],
      ["report_run", "数据报表"],
    ];
    const activity = [];
    for (const [kind, domain] of mappings)
      for (const item of this.store.list(kind, this.project)) {
        if (["FAILED", "VALIDATION_FAILED"].includes(item.status))
          domainCounts[domain].failures++;
        else if (["RUNNING", "QUEUED", "SCHEDULED"].includes(item.status))
          domainCounts[domain].running++;
        else if (["SUCCEEDED", "PASSED"].includes(item.status))
          domainCounts[domain].succeeded++;
        activity.push({
          id: item.id,
          kind,
          domain,
          status: item.status,
          createdAt: item.createdAt,
          durationMs: item.durationMs,
          errorCode: item.errorCode,
        });
      }
    domainCounts["安全审计"].succeeded = this.store
      .list("security_audit", this.project)
      .filter((item) => item.decision === "ALLOW").length;
    domainCounts["安全审计"].failures = this.store
      .list("security_audit", this.project)
      .filter((item) => item.decision === "DENY").length;
    return {
      scope: "LOCAL_CROSS_MODULE_OBSERVABILITY",
      publicDeployed: false,
      fullLifecycleE2E: false,
      health:
        incidents.some((item) => item.status === "OPEN")
          ? "DEGRADED"
          : incidents.some((item) => item.status === "ACKNOWLEDGED")
            ? "OBSERVING"
            : "HEALTHY",
      counts: {
        incidents: incidents.length,
        open: incidents.filter((item) => item.status === "OPEN").length,
        acknowledged: incidents.filter((item) => item.status === "ACKNOWLEDGED").length,
        resolved: incidents.filter((item) => item.status === "RESOLVED").length,
        activities: activity.length,
      },
      domainCounts,
      incidents,
      recentActivity: activity
        .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
        .slice(0, 50),
    };
  }

  agentContext() {
    const overview = this.overview();
    return {
      health: overview.health,
      domainCounts: overview.domainCounts,
      incidents: overview.incidents.map((incident) => ({
        id: incident.id,
        domain: incident.domain,
        title: incident.title,
        status: incident.status,
        severity: incident.severity,
        errorCode: incident.errorCode,
        message: incident.message,
        sourceKind: incident.sourceKind,
        sourceId: incident.sourceId,
        recoveryKind: incident.recoveryKind,
        recoveryId: incident.recoveryId,
      })),
    };
  }

  validateAgentDiagnosis(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw fail(422, "Agent未返回可验证的运维诊断", "INVALID_OPS_DIAGNOSIS");
    const incident = this.#incident(text(value.incidentId, "事故编号", 3, 80)),
      evidenceIds = Array.isArray(value.evidenceIds)
        ? [...new Set(value.evidenceIds.map((id) => text(id, "证据编号", 3, 80)))]
        : [];
    const allowedEvidence = new Set(
      [incident.sourceId, incident.recoveryId].filter(Boolean),
    );
    if (
      !evidenceIds.length ||
      evidenceIds.length > 6 ||
      evidenceIds.some((id) => !allowedEvidence.has(id))
    )
      throw fail(422, "Agent诊断引用了未知证据", "UNKNOWN_OPS_EVIDENCE");
    if (
      !Array.isArray(value.recommendedActions) ||
      !value.recommendedActions.length ||
      value.recommendedActions.length > 6
    )
      throw fail(422, "Agent处置建议数量不合法", "INVALID_OPS_ACTIONS");
    const confidence = Number(value.confidence);
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)
      throw fail(422, "Agent置信度不合法", "INVALID_OPS_CONFIDENCE");
    return {
      incidentId: incident.id,
      diagnosis: text(value.diagnosis, "诊断", 4, 1600),
      recommendedActions: value.recommendedActions.map((action) =>
        text(action, "处置建议", 2, 300),
      ),
      evidenceIds,
      confidence,
      executable: false,
      requiresHumanApproval: true,
    };
  }

  #recovery(kind, failure) {
    if (kind === "stream_run") {
      const alert = this.store
        .list("stream_alert", this.project)
        .find((item) => item.runId === failure.id && item.status === "RESOLVED");
      return alert?.recoveryRunId
        ? {
            kind: "stream_run",
            id: alert.recoveryRunId,
            mode: "CHECKPOINT_RECOVERY",
            resolvedAt: alert.resolvedAt,
          }
        : undefined;
    }
    if (kind === "quality_run") {
      const alert = this.store
        .list("quality_alert", this.project)
        .find((item) => item.runId === failure.id && item.status === "RESOLVED");
      return alert?.recoveryRunId
        ? {
            kind: "quality_run",
            id: alert.recoveryRunId,
            mode: "RULE_VERSION_RECOVERY",
            resolvedAt: alert.resolvedAt,
          }
        : undefined;
    }
    if (kind === "release_run") {
      const alert = this.store
        .list("monitor_alert", this.project)
        .find(
          (item) =>
            (item.runId === failure.id || item.releaseRunId === failure.id) &&
            item.status === "RESOLVED",
        );
      const run = alert?.recoveryReleaseId
        ? this.store
            .list("release_run", this.project)
            .find(
              (item) =>
                item.releaseId === alert.recoveryReleaseId &&
                item.status === "SUCCEEDED" &&
                Date.parse(item.createdAt) > Date.parse(failure.createdAt),
            )
        : undefined;
      return run
        ? {
            kind: "release_run",
            id: run.id,
            mode: "ROLLBACK_RECOVERY",
            resolvedAt: alert.resolvedAt,
          }
        : undefined;
    }
    return undefined;
  }

  #incident(id) {
    const item = this.store.get("ops_incident", text(id, "事故编号", 3, 80), this.project);
    if (!item) throw fail(404, "未找到运维事故", "OPS_INCIDENT_NOT_FOUND");
    return item;
  }
}

function publicEvidence(item) {
  if (!item) return undefined;
  return {
    id: item.id,
    status: item.status,
    createdAt: item.createdAt,
    finishedAt: item.finishedAt,
    durationMs: item.durationMs,
    errorCode: item.errorCode,
    error: item.error,
    actualExecution: item.actualExecution,
    validationPassed: item.validation?.passed,
    containsBusinessRows: false,
  };
}

function sameResource(incident, kind, evidence) {
  if (incident.resourceType === "offline_sync_task")
    return kind === "offline_sync_run" && evidence.taskId === incident.resourceId;
  if (incident.resourceType === "stream_job")
    return kind === "stream_run" && evidence.jobId === incident.resourceId;
  if (incident.resourceType === "quality_rule")
    return kind === "quality_run" && evidence.ruleId === incident.resourceId;
  if (incident.resourceType === "release")
    return kind === "release_run" && evidence.releaseId === incident.resourceId;
  if (incident.resourceType === "data_service")
    return kind === "data_service_test" && evidence.serviceId === incident.resourceId;
  return false;
}
