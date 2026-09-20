import test from "node:test";
import assert from "node:assert/strict";
import {
  pythonLifecycleCases,
  pythonLifecycleContract,
  pythonLifecycleStages,
  summarizePythonLifecycleEvaluation,
  validatePythonLifecycleCases,
} from "../../src/v2/python-lifecycle-evaluation.mjs";

test("Python lifecycle freezes five contexts separately from SQL evidence", () => {
  const cases = pythonLifecycleCases(),
    validated = validatePythonLifecycleCases(cases);
  assert.equal(cases.length, 5);
  assert.equal(new Set(cases.map((item) => item.caseId)).size, 5);
  assert.equal(pythonLifecycleContract.targetRate, 0.85);
  assert.equal(validated.caseSetDigest.length, 64);
  assert.deepEqual(Object.values(validated.perContext), [1, 1, 1, 1, 1]);
});

test("Python lifecycle requires every stage and every frozen case", () => {
  const cases = pythonLifecycleCases(),
    passedStages = Object.fromEntries(
      pythonLifecycleStages.map((stage) => [
        stage,
        { status: "PASSED", evidenceIds: [stage] },
      ]),
    ),
    outcomes = cases.map((item) => ({
      caseId: item.caseId,
      stages: structuredClone(passedStages),
      localFullLifecycleE2E: true,
      publicDeployed: false,
      modelAttemptCount: 1,
      reportedTokens: 100,
      scheduledBatchCount: 2,
    }));
  const complete = summarizePythonLifecycleEvaluation(cases, outcomes);
  assert.equal(complete.succeededCaseCount, 5);
  assert.equal(complete.targetMet, true);
  assert.equal(complete.totalScheduledBatches, 10);
  assert.equal(complete.agentIndependentE2E, false);
  const partial = summarizePythonLifecycleEvaluation(cases, outcomes.slice(0, 4));
  assert.equal(partial.finalRateAvailable, false);
  assert.equal(partial.targetMet, false);
  outcomes[0].stages.dapiConsumption.status = "FAILED";
  const failed = summarizePythonLifecycleEvaluation(cases, outcomes);
  assert.equal(failed.succeededCaseCount, 4);
  assert.equal(failed.targetMet, false);
});

