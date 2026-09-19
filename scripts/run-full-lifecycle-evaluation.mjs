#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MetadataStore } from "../src/v2/store.mjs";
import { createV2Server, PROJECT } from "../src/v2/server.mjs";
import {
  fullLifecycleContract,
  lifecycleStages,
  summarizeLifecycleEvaluation,
  validateFrozenCodeEvidence,
} from "../src/v2/lifecycle-evaluation.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  evidencePath = join(root, "fixtures", "e2e", "m1-code-evidence.json"),
  evidence = JSON.parse(readFileSync(evidencePath, "utf8")),
  evaluationRunId = randomUUID(),
  artifactDirectory = join(
    root,
    ".v2-artifacts",
    "full-lifecycle",
    evaluationRunId,
  ),
  reportPath = join(artifactDirectory, "report.json"),
  latestReportPath = join(
    root,
    ".v2-artifacts",
    "full-lifecycle",
    "latest.json",
  ),
  outcomes = [],
  startedAt = new Date().toISOString(),
  requestedLimit = Number(
    process.env.V2_E2E_CASE_LIMIT ?? evidence.cases.length,
  );
validateFrozenCodeEvidence(evidence);
if (
  !Number.isSafeInteger(requestedLimit) ||
  requestedLimit < 1 ||
  requestedLimit > evidence.cases.length
)
  throw new Error("V2_E2E_CASE_LIMIT必须为1—20");
mkdirSync(artifactDirectory, { recursive: true });

const tempRoot = mkdtempSync(join(tmpdir(), "shuduo-full-e2e-")),
  store = new MetadataStore(join(tempRoot, "platform.sqlite")),
  app = createV2Server({
    root,
    store,
    env: { ...process.env, V2_LOCAL_DEVELOPMENT: "true" },
    releaseTimeUnitMs: 1,
  });
await new Promise((resolveListen) =>
  app.server.listen(0, "127.0.0.1", resolveListen),
);
const base = `http://127.0.0.1:${app.server.address().port}/api/v2`;

const key = (caseId, action, suffix = "") =>
  `e2e-${createHash("sha256")
    .update(`${evaluationRunId}:${caseId}:${action}:${suffix}`)
    .digest("hex")}`;
class ApiFailure extends Error {
  constructor(status, body) {
    super(body.message ?? `请求失败 ${status}`);
    this.status = status;
    this.body = body;
  }
}
const request = async (path, body, idempotencyKey) => {
  const response = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shuduo-Client": "workbench",
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    value = await response.json();
  if (!response.ok) throw new ApiFailure(response.status, value);
  return value;
};
const waitFor = async (read, done, timeoutMs, label) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (done(value)) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  }
  throw new Error(`${label}等待超过${timeoutMs}ms`);
};
const persist = () => {
  const summary = summarizeLifecycleEvaluation(evidence, outcomes),
    report = {
      ...summary,
      evaluationRunId,
      startedAt,
      updatedAt: new Date().toISOString(),
      sourceEvidence: {
        path: "fixtures/e2e/m1-code-evidence.json",
        sourceEvaluationRunId: evidence.sourceEvaluationRunId,
        sourceReportSha256: evidence.sourceReportSha256,
      },
      outcomes,
    };
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
  writeFileSync(latestReportPath, JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
  return summary;
};
const emptyStages = () =>
  Object.fromEntries(
    lifecycleStages.map((stage) => [
      stage,
      { status: "NOT_RUN", evidenceIds: [] },
    ]),
  );

try {
  for (let index = 0; index < requestedLimit; index++) {
    const item = evidence.cases[index],
      caseStarted = Date.now(),
      stages = emptyStages(),
      detours = [],
      outcome = {
        caseId: item.caseId,
        contextId: item.contextId,
        category: item.category,
        sourceAgentTaskId: item.original.agentTaskId,
        sourceAgentAttempts: item.original.attemptCount,
        sourceAgentTokens: item.original.usedTokens,
        stages,
        detours,
        scheduledBatchCount: 0,
        localFullLifecycleE2E: false,
        publicDeployed: false,
        startedAt: new Date(caseStarted).toISOString(),
      };
    try {
      stages.requirementUnderstanding = {
        status: "PASSED",
        evidenceIds: [item.original.agentTaskId],
        requirementSha256: createHash("sha256")
          .update(item.requirement)
          .digest("hex"),
        liveModel: true,
      };
      const revision = store.create("revision", PROJECT, {
          sql: item.code.sql,
          contextId: item.contextId,
          source: "IMPORTED_FROZEN_LIVE_MODEL",
          hash: item.code.sqlHash,
          author: "m1-evaluation-import",
          provenance: {
            originalRevisionId: item.original.revisionId,
            sourceEvaluationRunId: evidence.sourceEvaluationRunId,
          },
        }),
        startedRun = await request(
          "/runs",
          { revisionId: revision.id },
          key(item.caseId, "current-spark-run"),
        ),
        run = await waitFor(
          () => request(`/runs/${startedRun.id}`),
          (value) =>
            ["SUCCEEDED", "FAILED", "VALIDATION_FAILED", "CANCELLED"].includes(
              value.status,
            ),
          180000,
          "当前Spark代码执行",
        );
      if (
        run.status !== "SUCCEEDED" ||
        run.engine !== "Apache Spark" ||
        !run.mainSqlExecuted ||
        !run.validation?.passed ||
        run.validation.regressions?.some((check) => !check.passed)
      )
        throw new Error(`当前Spark代码执行未通过：${run.status}`);
      stages.codeAndDebug = {
        status: "PASSED",
        evidenceIds: [
          item.original.revisionId,
          item.original.runId,
          revision.id,
          run.id,
        ],
        sqlHash: revision.hash,
        attemptCount: item.original.attemptCount,
        regressionCount: item.execution.validation.regressions.length,
        importedFromFrozenLiveEvidence: true,
        currentSparkRunId: run.id,
        currentSparkVersion: run.engineVersion,
      };

      const packageItem = await request(
        "/delivery/packages",
        {
          sourceRunId: run.id,
          name: `E2E ${index + 1} ${item.caseId}`,
        },
        key(item.caseId, "package"),
      );
      const fileNames = Object.keys(packageItem.files ?? {});
      stages.scheduleFiles = {
        status:
          fileNames.includes("schedule.json") &&
          fileNames.includes("calendar.json") &&
          packageItem.manifest?.format === "shuduo-delivery/v1"
            ? "PASSED"
            : "FAILED",
        evidenceIds: [packageItem.id],
        packageDigest: packageItem.digest,
        files: [
          ...fileNames.filter((name) =>
            ["schedule.json", "calendar.json"].includes(name),
          ),
          "manifest",
        ],
      };
      stages.deploymentFiles = {
        status:
          fileNames.includes("deployment.json") &&
          fileNames.includes("main.sql") &&
          fileNames.includes("tests.sql")
            ? "PASSED"
            : "FAILED",
        evidenceIds: [packageItem.id],
        files: fileNames.filter((name) =>
          ["deployment.json", "main.sql", "tests.sql"].includes(name),
        ),
      };

      if (index === 0) {
        try {
          await request(
            `/delivery/packages/${packageItem.id}/verify`,
            { scheduledFor: "2026-09-12T09:00:00+08:00" },
            key(item.caseId, "blocked-calendar"),
          );
          throw new Error("非交易日演练未被阻止");
        } catch (error) {
          if (!(error instanceof ApiFailure) || error.status !== 422) throw error;
          detours.push({
            stage: "scheduleFiles",
            status: "BLOCKED",
            reason: error.message,
            rescued: true,
          });
        }
      }

      let verification;
      if (index === 5) {
        const cancelled = await request(
          `/delivery/packages/${packageItem.id}/verify`,
          { scheduledFor: "2026-09-11T09:00:00+08:00" },
          key(item.caseId, "cancelled-verification"),
        );
        await request(
          `/delivery/verifications/${cancelled.id}/cancel`,
          {},
          key(item.caseId, "cancel"),
        );
        const terminal = await waitFor(
          () => request(`/delivery/verifications/${cancelled.id}`),
          (value) => ["CANCELLED", "FAILED", "SUCCEEDED"].includes(value.status),
          120000,
          "取消演练",
        );
        if (terminal.status !== "CANCELLED")
          throw new Error("受控取消没有保留CANCELLED终态");
        detours.push({
          stage: "deploymentFiles",
          status: "CANCELLED",
          evidenceId: terminal.id,
          rescued: true,
        });
      }
      const startedVerification = await request(
        `/delivery/packages/${packageItem.id}/verify`,
        { scheduledFor: "2026-09-11T09:00:00+08:00" },
        key(item.caseId, "verification", index === 5 ? "retry" : "first"),
      );
      verification = await waitFor(
        () => request(`/delivery/verifications/${startedVerification.id}`),
        (value) =>
          ["SUCCEEDED", "FAILED", "VALIDATION_FAILED", "CANCELLED"].includes(
            value.status,
          ),
        180000,
        "文件演练",
      );
      if (verification.status !== "SUCCEEDED")
        throw new Error(`文件演练未通过：${verification.status}`);
      stages.deploymentFiles.evidenceIds.push(verification.id);
      stages.deploymentFiles.actualSparkRehearsal = true;
      stages.deploymentFiles.rehearsalStatus = verification.status;

      const review = await request(
        `/delivery/packages/${packageItem.id}/review`,
        {
          packageDigest: packageItem.digest,
          verificationId: verification.id,
          reviewNote: `评测执行者确认${item.caseId}代码、断言、DAG/部署文件与本机合成数据范围`,
          attestations: {
            code: true,
            assertions: true,
            deliveryFiles: true,
            localScope: true,
          },
        },
        key(item.caseId, "review"),
      );
      stages.engineerReview = {
        status: "PASSED",
        evidenceIds: [review.id, verification.id],
        packageDigest: review.packageDigest,
        verificationId: review.verificationId,
        reviewScope: review.scope,
        evaluatorAttestation: true,
        disclosure:
          "这是冻结合成评测的执行者审阅记录，不是公网受邀用户的生产批准。",
      };

      if (index === 10) {
        try {
          await request(
          `/delivery/packages/${packageItem.id}/approve`,
          {
            packageDigest: "0".repeat(64),
            reviewId: review.id,
            },
            key(item.caseId, "blocked-approval"),
          );
          throw new Error("错误摘要审批未被拒绝");
        } catch (error) {
          if (!(error instanceof ApiFailure) || error.status !== 409) throw error;
          detours.push({
            stage: "localRelease",
            status: "BLOCKED",
            reason: error.message,
            rescued: true,
          });
        }
      }
      if (index === 15) {
        try {
          await request(
            "/delivery/packages",
            { sourceRunId: run.id, name: `冲突 ${item.caseId}` },
            key(item.caseId, "package"),
          );
          throw new Error("幂等冲突未被拒绝");
        } catch (error) {
          if (!(error instanceof ApiFailure) || error.status !== 409) throw error;
          detours.push({
            stage: "deploymentFiles",
            status: "BLOCKED",
            reason: error.message,
            rescued: true,
          });
        }
      }

      const approval = await request(
          `/delivery/packages/${packageItem.id}/approve`,
          {
            packageDigest: packageItem.digest,
            reviewId: review.id,
          },
          key(item.caseId, "approval"),
        ),
        release = await request(
          "/releases",
          {
            approvalId: approval.id,
            triggerAfterSeconds: 1,
            intervalSeconds: 1,
            runCount: 2,
          },
          key(item.caseId, "release"),
        ),
        healthy = await waitFor(
          () => request(`/releases/${release.id}`),
          (value) =>
            value.health === "HEALTHY" &&
            value.successfulRunCount >= 2 &&
            value.openAlertCount === 0,
          300000,
          "本机发布双批监控",
        ),
        releaseRuns = store
          .list("release_run", PROJECT)
          .filter((value) => value.releaseId === release.id),
        monitorEvents = store
          .list("monitor_event", PROJECT)
          .filter((value) => value.releaseId === release.id),
        alerts = store
          .list("monitor_alert", PROJECT)
          .filter((value) => value.releaseId === release.id);
      if (
        releaseRuns.length !== 2 ||
        releaseRuns.some(
          (value) =>
            value.status !== "SUCCEEDED" ||
            value.schedulerTriggered !== true ||
            value.clockMode !== "WALL_CLOCK_TIMER" ||
            value.engine !== "Apache Spark" ||
            !value.validation?.passed,
        )
      )
        throw new Error("本机上线批次缺少实际Spark/调度/断言证据");
      stages.localRelease = {
        status: "PASSED",
        evidenceIds: [review.id, approval.id, release.id, ...releaseRuns.map((value) => value.id)],
        packageDigest: packageItem.digest,
        approvalBound: approval.packageDigest === packageItem.digest,
        schedulerTriggered: true,
        actualSparkBatchCount: releaseRuns.length,
        deploymentScope: "LOCAL_ACTUAL",
      };
      stages.postReleaseMonitoring = {
        status:
          healthy.health === "HEALTHY" &&
          monitorEvents.filter((event) => event.type === "BATCH_SUCCEEDED").length >=
            2 &&
          alerts.filter((alert) => alert.status === "OPEN").length === 0
            ? "PASSED"
            : "FAILED",
        evidenceIds: [release.id, ...monitorEvents.map((event) => event.id)],
        health: healthy.health,
        successfulRunCount: healthy.successfulRunCount,
        openAlertCount: healthy.openAlertCount,
      };
      outcome.scheduledBatchCount = releaseRuns.length;
      outcome.localFullLifecycleE2E = lifecycleStages.every(
        (stage) => stages[stage].status === "PASSED",
      );
      outcome.packageId = packageItem.id;
      outcome.releaseId = release.id;
    } catch (error) {
      outcome.error = error.message;
      const firstNotRun = lifecycleStages.find(
        (stage) => stages[stage].status === "NOT_RUN",
      );
      if (firstNotRun)
        stages[firstNotRun] = {
          status: "FAILED",
          evidenceIds: [],
          error: error.message,
        };
    }
    outcome.finishedAt = new Date().toISOString();
    outcome.durationMs = Date.now() - caseStarted;
    outcomes.push(outcome);
    const summary = persist();
    process.stdout.write(
      `${summary.completedCaseCount}/${summary.frozenCaseCount} ${item.caseId} ${outcome.localFullLifecycleE2E ? "PASS" : "FAIL"} ${(outcome.durationMs / 1000).toFixed(1)}s\n`,
    );
  }
  const summary = persist();
  process.stdout.write(
    JSON.stringify(
      {
        evaluationRunId,
        artifact: reportPath,
        ...summary,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await new Promise((resolveClose) => app.server.close(resolveClose));
  store.close();
}
