#!/usr/bin/env node
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MetadataStore } from "../src/v2/store.mjs";
import { BusinessQueryStore } from "../src/v2/data-services.mjs";
import { createV2Server, PROJECT } from "../src/v2/server.mjs";
import {
  pythonLifecycleCases,
  pythonLifecycleStages,
  summarizePythonLifecycleEvaluation,
  validatePythonLifecycleCases,
} from "../src/v2/python-lifecycle-evaluation.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  cases = pythonLifecycleCases(),
  requestedLimit = Number(process.env.V2_E2E_CASE_LIMIT ?? cases.length),
  evaluationRunId = randomUUID(),
  artifactDirectory = join(
    root,
    ".v2-artifacts",
    "python-full-lifecycle",
    evaluationRunId,
  ),
  reportPath = join(artifactDirectory, "report.json"),
  latestPath = join(
    root,
    ".v2-artifacts",
    "python-full-lifecycle",
    "latest.json",
  ),
  outcomes = [],
  startedAt = new Date().toISOString(),
  seedCode = `def transform(data, params):
    return []`;
validatePythonLifecycleCases(cases);
if (
  !Number.isSafeInteger(requestedLimit) ||
  requestedLimit < 1 ||
  requestedLimit > cases.length
)
  throw new Error("V2_E2E_CASE_LIMIT必须为1—5");
mkdirSync(artifactDirectory, { recursive: true });

const tempRoot = mkdtempSync(join(tmpdir(), "shuduo-python-e2e-")),
  store = new MetadataStore(join(tempRoot, "platform.sqlite")),
  businessStore = new BusinessQueryStore(join(tempRoot, "business.sqlite")),
  app = createV2Server({
    root,
    store,
    businessStore,
    env: { ...process.env, V2_LOCAL_DEVELOPMENT: "true" },
    releaseTimeUnitMs: 5,
  });
await new Promise((resolveListen) =>
  app.server.listen(0, "127.0.0.1", resolveListen),
);
const base = `http://127.0.0.1:${app.server.address().port}/api/v2`;
const key = (caseId, action) =>
  `python-e2e-${createHash("sha256")
    .update(`${evaluationRunId}:${caseId}:${action}`)
    .digest("hex")}`;
class ApiFailure extends Error {
  constructor(status, body) {
    super(body.message ?? `请求失败${status}`);
    this.status = status;
    this.body = body;
  }
}
const request = async (
  path,
  { body, headers = {}, idempotencyKey } = {},
) => {
  const response = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Accept: "application/json",
        "X-Shuduo-Client": "workbench",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(idempotencyKey
          ? { "Idempotency-Key": idempotencyKey }
          : {}),
        ...headers,
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
    await new Promise((resolveWait) => setTimeout(resolveWait, 200));
  }
  throw new Error(`${label}等待超过${timeoutMs}ms`);
};
const emptyStages = () =>
  Object.fromEntries(
    pythonLifecycleStages.map((stage) => [
      stage,
      { status: "NOT_RUN", evidenceIds: [] },
    ]),
  );
const persist = () => {
  const summary = summarizePythonLifecycleEvaluation(cases, outcomes),
    report = {
      ...summary,
      evaluationRunId,
      startedAt,
      updatedAt: new Date().toISOString(),
      outcomes,
    };
  for (const path of [reportPath, latestPath])
    writeFileSync(path, JSON.stringify(report, null, 2) + "\n", {
      mode: 0o600,
    });
  return summary;
};

try {
  for (let index = 0; index < requestedLimit; index++) {
    const item = cases[index],
      caseStarted = Date.now(),
      stages = emptyStages(),
      detours = [],
      outcome = {
        caseId: item.caseId,
        contextId: item.contextId,
        category: item.category,
        stages,
        detours,
        modelAttemptCount: 0,
        reportedTokens: 0,
        scheduledBatchCount: 0,
        localFullLifecycleE2E: false,
        agentIndependentE2E: false,
        publicDeployed: false,
        startedAt: new Date(caseStarted).toISOString(),
      };
    try {
      const agent = await request("/agent/tasks", {
          body: {
            message: item.requirement,
            language: "PYTHON",
            code: seedCode,
            contextId: item.contextId,
          },
          idempotencyKey: key(item.caseId, "agent"),
        }),
        completedAgent = await waitFor(
          () => request(`/agent/tasks/${agent.id}`),
          (value) =>
            ["SUCCEEDED", "FAILED", "CANCELLED"].includes(value.status),
          240_000,
          "Python Agent",
        );
      stages.requirementUnderstanding = {
        status: "PASSED",
        evidenceIds: [agent.id],
        requirementSha256: createHash("sha256")
          .update(item.requirement)
          .digest("hex"),
        liveModel: true,
      };
      outcome.modelAttemptCount = completedAgent.attempts?.length ?? 0;
      outcome.reportedTokens = Number(completedAgent.usedTokens ?? 0);
      outcome.agentStatus = completedAgent.status;
      outcome.agentError = completedAgent.error;
      outcome.agentAttempts = (completedAgent.attempts ?? []).map((attempt) => {
        const run = attempt.runId
          ? store.get("python_run", attempt.runId, PROJECT)
          : undefined;
        return {
          attempt: attempt.attempt,
          runId: attempt.runId,
          revisionId: attempt.revisionId,
          status: attempt.status,
          model: attempt.model,
          issues: run?.validation?.issues ?? [],
          error: run?.error ?? attempt.error,
        };
      });
      if (completedAgent.status !== "SUCCEEDED")
        throw new Error(`Python Agent未成功：${completedAgent.status}`);
      const lastAttempt = completedAgent.attempts.at(-1),
        pythonRun = store.get("python_run", lastAttempt.runId, PROJECT),
        pythonRevision = store.get(
          "python_revision",
          lastAttempt.revisionId,
          PROJECT,
        );
      if (
        !pythonRun?.validation?.passed ||
        pythonRun.validation.regressions?.length !== 5 ||
        pythonRun.validation.regressions.some((entry) => !entry.passed)
      )
        throw new Error("Python Agent缺少五套断言证据");
      outcome.sourceAgentTaskId = completedAgent.id;
      outcome.modelAttemptCount = completedAgent.attempts.length;
      outcome.reportedTokens = Number(completedAgent.usedTokens ?? 0);
      stages.codeAndDebug = {
        status: "PASSED",
        evidenceIds: [pythonRevision.id, pythonRun.id],
        codeHash: pythonRevision.codeHash,
        engine: pythonRun.engine,
        engineVersion: pythonRun.engineVersion,
        regressionCount: pythonRun.validation.regressions.length,
        attemptCount: completedAgent.attempts.length,
      };

      const delivery = await request(
          `/agent/tasks/${completedAgent.id}/prepare-delivery`,
          {
            body: {},
            idempotencyKey: key(item.caseId, "delivery"),
          },
        ),
        prepared = await waitFor(
          () => request(`/agent/deliveries/${delivery.id}`),
          (value) => ["SUCCEEDED", "FAILED", "CANCELLED"].includes(value.status),
          180_000,
          "Python交付准备",
        );
      if (prepared.status !== "SUCCEEDED")
        throw new Error(`Python交付准备未成功：${prepared.status}`);
      const packageItem = await request(
          `/delivery/packages/${prepared.packageId}`,
        ),
        verification = await request(
          `/delivery/verifications/${prepared.verificationId}`,
        ),
        fileNames = Object.keys(packageItem.files ?? {});
      stages.scheduleFiles = {
        status:
          fileNames.includes("schedule.json") &&
          fileNames.includes("calendar.json")
            ? "PASSED"
            : "FAILED",
        evidenceIds: [packageItem.id],
        packageDigest: packageItem.digest,
      };
      stages.deploymentFiles = {
        status:
          fileNames.includes("deployment.json") &&
          fileNames.includes("main.py") &&
          verification.status === "SUCCEEDED"
            ? "PASSED"
            : "FAILED",
        evidenceIds: [packageItem.id, verification.id],
        actualPythonFileRehearsal: true,
      };

      if (index === 0) {
        try {
          await request(`/delivery/packages/${packageItem.id}/approve`, {
            body: {
              packageDigest: "0".repeat(64),
              reviewId: randomUUID(),
            },
            idempotencyKey: key(item.caseId, "blocked-approval"),
          });
          throw new Error("错误摘要审批未被阻止");
        } catch (error) {
          if (!(error instanceof ApiFailure) || error.status !== 409) throw error;
          detours.push({
            stage: "engineerReview",
            status: "BLOCKED",
            rescued: true,
            reason: error.message,
          });
        }
      }
      const review = await request(
          `/delivery/packages/${packageItem.id}/review`,
          {
            body: {
              packageDigest: packageItem.digest,
              verificationId: verification.id,
              reviewNote: `评测执行者确认${item.caseId} Python代码、断言、交付文件和本机范围`,
              attestations: {
                code: true,
                assertions: true,
                deliveryFiles: true,
                localScope: true,
              },
            },
            idempotencyKey: key(item.caseId, "review"),
          },
        ),
        approval = await request(
          `/delivery/packages/${packageItem.id}/approve`,
          {
            body: {
              packageDigest: packageItem.digest,
              reviewId: review.id,
            },
            idempotencyKey: key(item.caseId, "approval"),
          },
        );
      stages.engineerReview = {
        status: "PASSED",
        evidenceIds: [review.id, approval.id],
        evaluatorAttestation: true,
        disclosure: "本机合成评测审阅，不是生产批准。",
      };

      const release = await request("/releases", {
          body: {
            approvalId: approval.id,
            triggerAfterSeconds: 1,
            intervalSeconds: 1,
            runCount: 2,
          },
          idempotencyKey: key(item.caseId, "release"),
        }),
        healthy = await waitFor(
          () => request(`/releases/${release.id}`),
          (value) =>
            value.health === "HEALTHY" &&
            value.successfulRunCount >= 2 &&
            value.openAlertCount === 0,
          180_000,
          "Python双批发布",
        ),
        releaseRuns = store
          .list("release_run", PROJECT)
          .filter((value) => value.releaseId === release.id);
      if (
        releaseRuns.length !== 2 ||
        releaseRuns.some(
          (value) =>
            value.status !== "SUCCEEDED" ||
            value.engine !== "CPython" ||
            value.codeExecuted !== true ||
            value.schedulerTriggered !== true ||
            value.validation?.passed !== true,
        )
      )
        throw new Error("Python本机发布批次证据不完整");
      stages.localRelease = {
        status: "PASSED",
        evidenceIds: [release.id, ...releaseRuns.map((value) => value.id)],
        schedulerTriggered: true,
        actualPythonBatchCount: releaseRuns.length,
      };
      const monitorEvents = store
          .list("monitor_event", PROJECT)
          .filter((value) => value.releaseId === release.id),
        openAlerts = store
          .list("monitor_alert", PROJECT)
          .filter(
            (value) => value.releaseId === release.id && value.status === "OPEN",
          );
      stages.postReleaseMonitoring = {
        status:
          healthy.health === "HEALTHY" &&
          monitorEvents.filter((event) => event.type === "BATCH_SUCCEEDED")
            .length >= 2 &&
          openAlerts.length === 0
            ? "PASSED"
            : "FAILED",
        evidenceIds: [release.id, ...monitorEvents.map((event) => event.id)],
        health: healthy.health,
        openAlertCount: openAlerts.length,
      };

      const sourceRun = releaseRuns.at(-1),
        dapi = await request("/data-services/dapis", {
          body: {
            name: `Python资产查询 ${index + 1}`,
            slug: `python-assets-${index + 1}-${evaluationRunId.slice(0, 8)}`,
            sourceReleaseRunId: sourceRun.id,
            fields: [
              "client_id",
              "holding_market_value",
              "available_cash",
              "total_assets",
              "security_count",
            ],
            timeoutMs: 1000,
            rateLimitPerMinute: 10,
          },
          idempotencyKey: key(item.caseId, "dapi"),
        });
      await request(`/data-services/dapis/${dapi.id}/test`, {
        body: { page: 1, page_size: 10 },
        idempotencyKey: key(item.caseId, "dapi-test"),
      });
      const published = await request(
          `/data-services/dapis/${dapi.id}/publish`,
          { body: {}, idempotencyKey: key(item.caseId, "dapi-publish") },
        ),
        issued = await request("/data-services/applications", {
          body: {
            name: `Python评测调用方 ${index + 1}`,
            serviceIds: [dapi.id],
          },
          idempotencyKey: key(item.caseId, "application"),
        }),
        invocation = await request(
          `/open/dapis/${published.service.slug}?page=1&page_size=10`,
          { headers: { Authorization: `Bearer ${issued.token}` } },
        );
      if (!invocation.data?.length || invocation.localTestOnly !== true)
        throw new Error("Python DAPI授权调用没有返回实际快照结果");
      stages.dapiConsumption = {
        status: "PASSED",
        evidenceIds: [dapi.id, invocation.callId],
        sourceEngine: published.version.sourceEngine,
        rowCount: invocation.data.length,
        localTestOnly: true,
      };
      outcome.modelAttemptCount = completedAgent.attempts.length;
      outcome.reportedTokens = Number(completedAgent.usedTokens ?? 0);
      outcome.scheduledBatchCount = releaseRuns.length;
      outcome.packageId = packageItem.id;
      outcome.releaseId = release.id;
      outcome.dapiId = dapi.id;
      outcome.localFullLifecycleE2E = pythonLifecycleStages.every(
        (stage) => stages[stage].status === "PASSED",
      );
    } catch (error) {
      outcome.error = String(error.message).slice(0, 1000);
      const firstNotRun = pythonLifecycleStages.find(
        (stage) => stages[stage].status === "NOT_RUN",
      );
      if (firstNotRun)
        stages[firstNotRun] = {
          status: "FAILED",
          evidenceIds: [],
          error: outcome.error,
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
    JSON.stringify({ evaluationRunId, artifact: reportPath, ...summary }, null, 2) +
      "\n",
  );
  if (outcomes.some((item) => item.localFullLifecycleE2E !== true))
    process.exitCode = 1;
} finally {
  await new Promise((resolveClose) => app.server.close(resolveClose));
  businessStore.close();
  store.close();
}
