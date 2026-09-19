#!/usr/bin/env node
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { m1EvaluationCases, validateM1EvaluationCases } from "../src/v2/evaluation.mjs";

const [databaseArgument, reportArgument, outputArgument] = process.argv.slice(2);
if (!databaseArgument || !reportArgument || !outputArgument)
  throw new Error(
    "用法：node scripts/export-m1-code-evidence.mjs <metadata.sqlite> <report.json> <output.json>",
  );
const databasePath = resolve(databaseArgument),
  reportPath = resolve(reportArgument),
  outputPath = resolve(outputArgument),
  reportSource = readFileSync(reportPath, "utf8"),
  report = JSON.parse(reportSource),
  cases = m1EvaluationCases(),
  coverage = validateM1EvaluationCases(cases),
  database = new DatabaseSync(databasePath),
  document = (id) => {
    const row = database
      .prepare("SELECT kind,data FROM documents WHERE id=?")
      .get(id);
    if (!row) throw new Error(`冻结数据库缺少记录 ${id}`);
    return { kind: row.kind, value: JSON.parse(row.data) };
  };
try {
  if (
    report.evaluationRunId !== "a6ccf750-836d-4f1b-8e73-a66da710e1bb" ||
    report.caseSetDigest !== coverage.caseSetDigest ||
    report.completedCaseCount !== 20 ||
    report.succeededCaseCount !== 20
  )
    throw new Error("输入不是已验收的正式20例M1报告");
  const caseById = new Map(cases.map((item) => [item.id, item])),
    evidence = report.outcomes.map((outcome) => {
      const definition = caseById.get(outcome.caseId);
      if (!definition || !outcome.codeStageSucceeded)
        throw new Error(`场景未通过或未冻结 ${outcome.caseId}`);
      const revisionDocument = document(outcome.revisionId),
        runDocument = document(outcome.runId),
        agentDocument = document(outcome.taskId),
        revision = revisionDocument.value,
        run = runDocument.value,
        agent = agentDocument.value;
      if (
        revisionDocument.kind !== "revision" ||
        runDocument.kind !== "run" ||
        agentDocument.kind !== "agent" ||
        run.revisionId !== revision.id ||
        run.revisionHash !== revision.hash ||
        createHash("sha256").update(revision.sql).digest("hex") !== revision.hash ||
        run.status !== "SUCCEEDED" ||
        !run.validation?.passed ||
        run.validation?.regressions?.length !== 5 ||
        run.validation.regressions.some((item) => !item.passed) ||
        agent.status !== "SUCCEEDED"
      )
        throw new Error(`场景证据不一致 ${outcome.caseId}`);
      return {
        caseId: outcome.caseId,
        contextId: outcome.contextId,
        category: outcome.category,
        requirement: definition.request,
        seedSqlHash: createHash("sha256")
          .update(definition.seedSql)
          .digest("hex"),
        original: {
          agentTaskId: agent.id,
          runId: run.id,
          revisionId: revision.id,
          attemptCount: outcome.attemptCount,
          usedTokens: outcome.usedTokens,
          startedAt: outcome.startedAt,
          finishedAt: outcome.finishedAt,
        },
        code: {
          sql: revision.sql,
          sqlHash: revision.hash,
          source: revision.source,
        },
        execution: {
          engine: run.engine,
          engineVersion: run.engineVersion,
          durationMs: run.durationMs,
          rows: run.rows,
          columns: run.columns,
          validation: run.validation,
          validationContractId: run.validationContractId,
        },
      };
    });
  const output = {
    format: "shuduo-frozen-code-evidence/v1",
    sourceEvaluationRunId: report.evaluationRunId,
    sourceReportSha256: createHash("sha256").update(reportSource).digest("hex"),
    caseSetDigest: coverage.caseSetDigest,
    caseCount: evidence.length,
    classification: "SYNTHETIC_SECURITIES_ONLY",
    logsIncluded: false,
    fullLifecycleE2E: false,
    generatedAt: new Date().toISOString(),
    cases: evidence,
  };
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(output, null, 2) + "\n", {
    mode: 0o600,
  });
  process.stdout.write(
    JSON.stringify({
      outputPath,
      caseCount: evidence.length,
      sourceEvaluationRunId: output.sourceEvaluationRunId,
      sourceReportSha256: output.sourceReportSha256,
    }) + "\n",
  );
} finally {
  database.close();
}
