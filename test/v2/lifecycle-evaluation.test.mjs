import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  fullLifecycleContract,
  lifecycleStages,
  summarizeLifecycleEvaluation,
  validateFrozenCodeEvidence,
} from "../../src/v2/lifecycle-evaluation.mjs";

const evidence = JSON.parse(
  readFileSync("fixtures/e2e/m1-code-evidence.json", "utf8"),
);

test("frozen code evidence retains all 20 real Agent and Spark cases without logs", () => {
  const validated = validateFrozenCodeEvidence(evidence);
  assert.equal(validated.caseCount, 20);
  assert.equal(
    validated.contract.sourceCodeEvaluationRunId,
    "a6ccf750-836d-4f1b-8e73-a66da710e1bb",
  );
  assert.ok(
    evidence.cases.every(
      (item) =>
        item.code.source === "LIVE_MODEL" &&
        item.execution.engine === "Apache Spark" &&
        item.execution.validation.regressions.every((check) => check.passed),
    ),
  );
  assert.equal(evidence.logsIncluded, false);
  assert.doesNotMatch(JSON.stringify(evidence), /NativeCodeLoader|\/Users\//);
});

test("lifecycle rate requires every stage and all 20 retained outcomes", () => {
  const passedStages = Object.fromEntries(
      lifecycleStages.map((stage) => [stage, { status: "PASSED", evidenceIds: [stage] }]),
    ),
    outcomes = evidence.cases.map((item) => ({
      caseId: item.caseId,
      stages: structuredClone(passedStages),
      localFullLifecycleE2E: true,
      publicDeployed: false,
      scheduledBatchCount: 2,
      detours: [],
    }));
  let summary = summarizeLifecycleEvaluation(evidence, outcomes.slice(0, 19));
  assert.equal(summary.finalRateAvailable, false);
  assert.equal(summary.targetMet, false);
  outcomes[0].stages.postReleaseMonitoring.status = "FAILED";
  summary = summarizeLifecycleEvaluation(evidence, outcomes);
  assert.equal(summary.succeededCaseCount, 19);
  assert.equal(summary.localFullLifecycleRate, 0.95);
  assert.equal(summary.targetMet, true);
  assert.equal(summary.fullLifecycleE2E, false);
  outcomes[0].stages.postReleaseMonitoring.status = "PASSED";
  outcomes[0].detours = [
    { status: "CANCELLED", rescued: true },
    { status: "BLOCKED", rescued: true },
  ];
  summary = summarizeLifecycleEvaluation(evidence, outcomes);
  assert.equal(summary.succeededCaseCount, 20);
  assert.equal(summary.localFullLifecycleRate, 1);
  assert.equal(summary.fullLifecycleE2E, true);
  assert.deepEqual(summary.detourCounts, {
    blocked: 1,
    cancelled: 1,
    failed: 0,
    rescued: 2,
  });
  assert.equal(summary.publicDeployed, false);
  assert.equal(summary.contract.id, fullLifecycleContract.id);
});
