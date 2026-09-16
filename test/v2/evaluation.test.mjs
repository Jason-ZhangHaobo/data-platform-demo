import test from "node:test";
import assert from "node:assert/strict";
import {
  m1EvaluationCases,
  m1EvaluationContract,
  summarizeM1Evaluation,
  validateM1EvaluationCases,
} from "../../src/v2/evaluation.mjs";

test("M1 evaluation freezes 20 balanced securities code-stage cases", () => {
  const cases = m1EvaluationCases(),
    validation = validateM1EvaluationCases(cases);
  assert.equal(cases.length, 20);
  assert.equal(new Set(cases.map((item) => item.id)).size, 20);
  assert.deepEqual(new Set(Object.values(validation.perContext)), new Set([4]));
  assert.deepEqual(new Set(Object.values(validation.perCategory)), new Set([5]));
  assert.match(validation.caseSetDigest, /^[a-f0-9]{64}$/);
  assert.equal(m1EvaluationContract.fullLifecycleE2E, false);
});

test("M1 summary never presents partial or SQL-stage evidence as full E2E", () => {
  const cases = m1EvaluationCases(),
    partial = cases.slice(0, 17).map((item) => ({
      caseId: item.id,
      codeStageSucceeded: true,
      attemptCount: 1,
      usedTokens: 100,
    })),
    summary = summarizeM1Evaluation(cases, partial);
  assert.equal(summary.completedCaseCount, 17);
  assert.equal(summary.codeStageCompletionRate, 1);
  assert.equal(summary.finalRateAvailable, false);
  assert.equal(summary.targetMet, false);
  assert.equal(summary.fullLifecycleE2E, false);
  assert.match(summary.disclosure, /代码阶段/);
});

test("M1 target is only evaluated after all frozen cases are retained", () => {
  const cases = m1EvaluationCases(),
    outcomes = cases.map((item, index) => ({
      caseId: item.id,
      codeStageSucceeded: index < 17,
      attemptCount: index % 2 ? 2 : 1,
      usedTokens: 200,
    })),
    summary = summarizeM1Evaluation(cases, outcomes);
  assert.equal(summary.succeededCaseCount, 17);
  assert.equal(summary.failedCaseCount, 3);
  assert.equal(summary.unexecutedCaseCount, 0);
  assert.equal(summary.codeStageCompletionRate, 0.85);
  assert.equal(summary.targetMet, true);
  assert.equal(summary.fullLifecycleE2E, false);
});

test("M1 summary rejects duplicated or unknown outcome manipulation", () => {
  const cases = m1EvaluationCases();
  assert.throws(() =>
    summarizeM1Evaluation(cases, [
      { caseId: cases[0].id },
      { caseId: cases[0].id },
    ]),
  );
  assert.throws(() =>
    summarizeM1Evaluation(cases, [{ caseId: "not-registered" }]),
  );
});
