#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { createV2Server } from "../src/v2/server.mjs";
import { MetadataStore } from "../src/v2/store.mjs";
import {
  m1EvaluationCases,
  m1EvaluationContract,
  summarizeM1Evaluation,
  validateM1EvaluationCases,
} from "../src/v2/evaluation.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  runId = randomUUID(),
  artifactDirectory = join(root, ".v2-artifacts", "evaluations", runId),
  cases = m1EvaluationCases(),
  outcomes = [];
validateM1EvaluationCases(cases);
mkdirSync(artifactDirectory, { recursive: true });

const store = new MetadataStore(
  join(mkdtempSync(join(tmpdir(), "shuduo-m1-eval-")), "metadata.sqlite"),
);
const app = createV2Server({ root, store, env: process.env });
await new Promise((resolveListen) =>
  app.server.listen(0, "127.0.0.1", resolveListen),
);
const base = `http://127.0.0.1:${app.server.address().port}/api/v2`;
const idempotencyKey = (caseId) =>
  "m1-" +
  createHash("sha256")
    .update(`${m1EvaluationContract.id}:${runId}:${caseId}`)
    .digest("hex");
const request = async (path, body, idempotencyKey) => {
  const response = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shuduo-Client": "workbench",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.message ?? `请求失败 ${response.status}`);
  return value;
};
const wait = async (id) => {
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    const task = await request(`/agent/tasks/${id}`);
    if (!["QUEUED", "RUNNING"].includes(task.status)) return task;
    await new Promise((resolveWait) => setTimeout(resolveWait, 600));
  }
  throw new Error("评测场景等待超过240秒");
};
const persist = () => {
  const summary = summarizeM1Evaluation(cases, outcomes);
  writeFileSync(
    join(artifactDirectory, "report.json"),
    JSON.stringify(
      {
        ...summary,
        evaluationRunId: runId,
        startedAt,
        updatedAt: new Date().toISOString(),
        outcomes,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  return summary;
};

const startedAt = new Date().toISOString();
try {
  const status = await request("/status");
  if (!status.model.configured)
    throw new Error("本机模型密钥未配置，M1真实评测不会回退到测试替身");
  if (!status.spark.available)
    throw new Error("Spark运行环境未就绪，M1真实评测不会跳过执行");
  for (const item of cases) {
    const caseStartedAt = new Date().toISOString();
    try {
      const task = await request(
        "/agent/tasks",
        {
          message: item.request,
          sql: item.seedSql,
          contextId: item.contextId,
        },
        idempotencyKey(item.id),
      );
      const completed = await wait(task.id),
        lastAttempt = completed.attempts?.at(-1),
        run = lastAttempt?.runId
          ? await request(`/runs/${lastAttempt.runId}`)
          : undefined,
        regressions = run?.validation?.regressions ?? [],
        codeStageSucceeded = Boolean(
          completed.status === "SUCCEEDED" &&
            completed.completionScope === "SQL_DEVELOPMENT" &&
            completed.fullLifecycleE2E === false &&
            run?.status === "SUCCEEDED" &&
            run.validation?.passed &&
            run.validation?.contractId === status.validationContract.id &&
            regressions.length === status.validationContract.fixtureCount &&
            regressions.every((check) => check.passed),
        ),
        inputTokens = (completed.attempts ?? []).reduce(
          (sum, attempt) =>
            sum +
            Number(
              attempt.usage?.prompt_tokens ?? attempt.usage?.input_tokens ?? 0,
            ),
          0,
        ),
        outputTokens = (completed.attempts ?? []).reduce(
          (sum, attempt) =>
            sum +
            Number(
              attempt.usage?.completion_tokens ??
                attempt.usage?.output_tokens ??
                0,
            ),
          0,
        );
      outcomes.push({
        caseId: item.id,
        contextId: item.contextId,
        category: item.category,
        codeStageSucceeded,
        taskId: completed.id,
        taskStatus: completed.status,
        runId: run?.id,
        runStatus: run?.status,
        revisionId: completed.revisionId,
        attemptCount: completed.attempts?.length ?? 0,
        usedTokens: completed.usedTokens ?? 0,
        inputTokens,
        outputTokens,
        validationContractId: run?.validation?.contractId,
        regressionCount: regressions.length,
        error: completed.error ?? run?.error,
        startedAt: caseStartedAt,
        finishedAt: new Date().toISOString(),
      });
    } catch (error) {
      outcomes.push({
        caseId: item.id,
        contextId: item.contextId,
        category: item.category,
        codeStageSucceeded: false,
        attemptCount: 0,
        usedTokens: 0,
        error: error.message,
        startedAt: caseStartedAt,
        finishedAt: new Date().toISOString(),
      });
    }
    const summary = persist();
    process.stdout.write(
      `${summary.completedCaseCount}/${summary.frozenCaseCount} ${item.id} ${outcomes.at(-1).codeStageSucceeded ? "PASS" : "FAIL"}\n`,
    );
  }
  const summary = persist();
  process.stdout.write(
    JSON.stringify(
      {
        evaluationRunId: runId,
        artifact: join(artifactDirectory, "report.json"),
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
