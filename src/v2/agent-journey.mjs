import { createHash } from "node:crypto";
import { validateDeliveryPackage } from "./delivery.mjs";

const digest = (value) => createHash("sha256").update(String(value)).digest("hex");
const stage = (id, label, actor, status, evidence = {}, note = "") => ({
  id, label, actor, status, evidence, note,
});

export function agentEvidenceJourney({ store, project, task }) {
  const attempts = task.attempts ?? [],
    last = attempts.at(-1),
    revision = last?.revisionId
      ? store.get("revision", last.revisionId, project)
      : undefined,
    run = last?.runId ? store.get("run", last.runId, project) : undefined,
    codePassed =
      task.status === "SUCCEEDED" &&
      task.mode === "LIVE_MODEL" &&
      typeof last?.model === "string" &&
      !last.model.includes("TEST_DOUBLE") &&
      last?.status === "SUCCEEDED" &&
      revision?.id === run?.revisionId &&
      revision?.hash === run?.revisionHash,
    debugPassed =
      codePassed &&
      run.engine === "Apache Spark" &&
      /^\d+\.\d+\.\d+$/.test(run.engineVersion ?? "") &&
      run.testDouble !== true &&
      run.validation?.passed === true &&
      run.validation.regressions?.every((item) => item.passed) === true,
    packages = store
      .list("delivery_package", project)
      .filter(
        (item) =>
          item.sourceRunId === run?.id &&
          item.manifest?.source?.revisionId === revision?.id,
      ),
    selectedPackage = packages[0];
  const agentPreparedPackage = Boolean(selectedPackage?.agentDeliveryTaskId);
  let fileValid = false;
  if (selectedPackage) {
    try {
      validateDeliveryPackage(selectedPackage, selectedPackage.digest);
      fileValid = true;
    } catch {
      // A broken package cannot earn a journey milestone.
    }
  }
  const rehearsal = selectedPackage
      ? store
          .list("delivery_verification", project)
          .find(
            (item) =>
              item.packageId === selectedPackage.id &&
              item.packageDigest === selectedPackage.digest &&
              item.status === "SUCCEEDED" &&
              item.mode === "LOCAL_FILE_REHEARSAL" &&
              item.engine === "Apache Spark" &&
              item.mainSqlExecuted === true &&
              item.testSqlValidation?.passed === true &&
              item.validation?.passed === true &&
              item.testDouble !== true,
          )
      : undefined,
    approval = selectedPackage
      ? store
          .list("release_approval", project)
          .find(
            (item) =>
              item.packageId === selectedPackage.id &&
              item.packageDigest === selectedPackage.digest &&
              item.status === "APPROVED",
          )
      : undefined,
    release = approval
      ? store
          .list("release", project)
          .find(
            (item) =>
              item.packageId === selectedPackage.id &&
              item.packageDigest === selectedPackage.digest &&
              item.approvalId === approval.id,
          )
      : undefined,
    batches = release
      ? store
          .list("release_run", project)
          .filter((item) => item.releaseId === release.id)
      : [],
    successfulBatches = batches.filter(
      (item) =>
        item.status === "SUCCEEDED" &&
        item.schedulerTriggered === true &&
        item.clockMode === "WALL_CLOCK_TIMER" &&
        item.packageDigest === selectedPackage.digest &&
        item.validation?.passed === true &&
        item.engine === "Apache Spark" &&
        item.mainSqlExecuted === true &&
        item.testSqlValidation?.passed === true &&
        item.testDouble !== true,
    ),
    openAlerts = release
      ? store
          .list("monitor_alert", project)
          .filter((item) => item.releaseId === release.id && item.status === "OPEN")
      : [],
    currentlyActive = release?.status === "ACTIVE_LOCAL",
    deployPassed = fileValid && debugPassed && Boolean(rehearsal),
    publishPassed =
      deployPassed &&
      currentlyActive &&
      approval?.status === "APPROVED" &&
      successfulBatches.length >= 2,
    monitorPassed =
      publishPassed && release?.health === "HEALTHY" && openAlerts.length === 0;
  const agentPreparedRehearsal = Boolean(rehearsal?.agentDeliveryTaskId);

  const stages = [
    stage("REQUIREMENT", "理解需求与证券口径", "ENGINEER_AND_AGENT",
      task.contextId && task.message ? "SUCCEEDED" : "WAITING",
      { contextId: task.contextId, requirementHash: digest(task.message ?? "") },
      "只证明已提交给代码Agent的已知上下文；未验证未知业务歧义。"),
    stage("CODE", "生成并审阅SQL版本", "DATA_AGENT_THEN_ENGINEER",
      codePassed ? "SUCCEEDED" : task.status === "FAILED" ? "FAILED" :
        task.status === "SUCCEEDED" ? "UNVERIFIED" : "WAITING",
      { revisionId: revision?.id, sqlHash: revision?.hash, attemptCount: attempts.length,
        model: last?.model },
      "代码Agent不会自动批准调度或发布。"),
    stage("DEBUG", "Spark调试与独立断言", "DATA_AGENT_AND_SPARK",
      debugPassed ? "SUCCEEDED" : run?.status === "SUCCEEDED" ? "UNVERIFIED" :
        run && run.status !== "RUNNING" ? "FAILED" : "WAITING",
      { runId: run?.id, engineVersion: run?.engineVersion,
        regressionCount: run?.validation?.regressions?.length ?? 0,
        issueCount: run?.validation?.issues?.length ?? 0 },
      "只读取运行状态、版本和计数，不返回业务行或原始报错。"),
    stage("SCHEDULE_FILE", "调度文件与日历",
      agentPreparedPackage ? "AGENT_DELIVERY_ORCHESTRATOR" : "ENGINEER_VIA_DELIVERY_API",
      fileValid && debugPassed ? "SUCCEEDED" : selectedPackage && !fileValid ? "FAILED" : "WAITING",
      { packageId: selectedPackage?.id, packageDigest: selectedPackage?.digest,
        scheduleHash: selectedPackage?.manifest?.files?.["schedule.json"]?.sha256 },
      agentPreparedPackage
        ? "Agent从已验证代码自动生成标准文件；工程师仍须审阅。"
        : "由工程师或受控API生成；不是代码Agent独立完成。"),
    stage("DEPLOY_FILE", "部署清单与按文件演练",
      agentPreparedRehearsal ? "AGENT_ORCHESTRATOR_AND_SPARK" : "ENGINEER_AND_SPARK",
      deployPassed ? "SUCCEEDED" : selectedPackage && !fileValid ? "FAILED" : "WAITING",
      { packageId: selectedPackage?.id, deploymentHash:
        selectedPackage?.manifest?.files?.["deployment.json"]?.sha256,
        rehearsalId: rehearsal?.id },
      agentPreparedRehearsal
        ? "Agent自动编排真实Spark文件演练；不自动批准或公网部署。"
        : "演练与真实云上线分开，不把配置文本冒充执行。"),
    stage("PUBLISH", "审批版本与计时发布", "ENGINEER_APPROVAL_THEN_SCHEDULER",
      publishPassed ? "SUCCEEDED" : release && !currentlyActive ? "HISTORICAL" : "WAITING",
      { approvalId: approval?.id, releaseId: release?.id,
        successfulBatchCount: successfulBatches.length,
        publicDeployed: false },
      "本机墙上时钟批次，不是公网或Agent自主发布。"),
    stage("MONITOR", "上线后运行监控", "SCHEDULER_AND_ENGINEER",
      monitorPassed ? "SUCCEEDED" : release && !currentlyActive ? "HISTORICAL" : "WAITING",
      { releaseId: release?.id, health: release?.health,
        successfulBatchCount: successfulBatches.length,
        openAlertCount: openAlerts.length,
        publicDeployed: false },
      "需至少两个真实计时批次且当前健康，历史成功不冒充现行健康。"),
  ];
  return {
    format: "shuzhan-agent-evidence-journey/v1",
    taskId: task.id,
    projectId: project,
    stages,
    localEvidenceComplete: stages.every((item) => item.status === "SUCCEEDED"),
    agentIndependentE2E: false,
    publicDeployed: false,
    evaluatedAsFullLifecycle: false,
    packageCandidateCount: packages.length,
    notice:
      "该只读旅程串联现有证据和责任归属；代码Agent范围仍为SQL_DEVELOPMENT。人工交付/审批/发布不计Agent自主端到端完成率。",
  };
}
