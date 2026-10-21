import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  fullLifecycleContract,
  lifecycleStages,
  summarizeLifecycleEvaluation,
  validateFrozenCodeEvidence,
  inspectLifecycleOutcome,
  verifyLifecycleReport,
} from "../../src/v2/lifecycle-evaluation.mjs";
import {lifecycleOutcome,lifecycleReport} from './lifecycle-fixtures.mjs';

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
  assert.ok(lifecycleStages.includes("engineerReview"));
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
  const outcomes = evidence.cases.map(lifecycleOutcome);
  let summary = summarizeLifecycleEvaluation(evidence, outcomes.slice(0, 19));
  assert.equal(summary.finalRateAvailable, false);
  assert.equal(summary.localFullLifecycleRate, 0.95);
  assert.equal(summary.targetMet, false);
  outcomes[0].stages.postReleaseMonitoring.status = "FAILED";
  summary = summarizeLifecycleEvaluation(evidence, outcomes);
  assert.equal(summary.succeededCaseCount, 19);
  assert.equal(summary.localFullLifecycleRate, 0.95);
  assert.equal(summary.targetMet, true);
  assert.equal(summary.fullLifecycleE2E, false);
  outcomes[0].stages.postReleaseMonitoring.status = "PASSED";
  outcomes[0].stages.engineerReview.status = "FAILED";
  summary = summarizeLifecycleEvaluation(evidence, outcomes);
  assert.equal(summary.succeededCaseCount, 19);
  assert.equal(summary.fullLifecycleE2E, false);
  outcomes[0].stages.engineerReview.status = "PASSED";
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
  assert.equal(summary.agentIndependentE2E, false);
  assert.equal(summary.agentE2ETargetMet, false);
  assert.equal(summary.modelEvidenceMode, 'FROZEN_REPLAY');
  assert.equal(summary.rescuedSucceededCaseCount, 1);
});

test('status labels alone, missing files or mismatched provenance never qualify as complete evidence',()=>{
 const item=evidence.cases[0];
 const missing=lifecycleOutcome(item);for(const stage of Object.values(missing.stages))stage.evidenceIds=[];
 assert.equal(inspectLifecycleOutcome(item,missing).passed,false);
 for(const mutate of [o=>o.stages.codeAndDebug.sqlHash='0'.repeat(64),o=>o.stages.codeAndDebug.currentSparkRunId=item.original.runId,
  o=>o.stages.scheduleFiles.files=['schedule.json'],o=>o.stages.deploymentFiles.packageDigest='0'.repeat(64),
  o=>o.stages.engineerReview.verificationId='other-verification',o=>o.stages.localRelease.batches[0].releaseId='other-release',
  o=>o.stages.localRelease.batches[1].id=o.stages.localRelease.batches[0].id,
  o=>o.stages.localRelease.batches[0].startedAt='2026-09-14T00:00:00.000Z',
  o=>o.stages.postReleaseMonitoring.successfulEvents[1].releaseRunId=o.stages.postReleaseMonitoring.successfulEvents[0].releaseRunId,
  o=>o.stages.postReleaseMonitoring.successfulEvents[0].observedAt='2026-09-14T00:00:00.000Z',
  o=>o.stages.postReleaseMonitoring.openAlertCount=1]){
  const outcome=lifecycleOutcome(item);mutate(outcome);assert.equal(inspectLifecycleOutcome(item,outcome).passed,false);
 }
});

test('report validation retains honest failures and partial runs but refuses altered totals or frozen source',()=>{
 const outcomes=evidence.cases.map(lifecycleOutcome);outcomes[0].stages.postReleaseMonitoring.status='FAILED';
 const report=lifecycleReport(outcomes),verified=verifyLifecycleReport(evidence,report);
 assert.equal(verified.failedCaseCount,1);assert.equal(verified.outcomes.length,20);
 assert.throws(()=>verifyLifecycleReport(evidence,{...report,succeededCaseCount:20,targetMet:true}),/不一致/);
 assert.equal(verifyLifecycleReport(evidence,lifecycleReport(outcomes.slice(1,2))).localFullLifecycleRate,0.05);
 const modified=structuredClone(evidence);modified.cases[0].original.usedTokens++;
 assert.throws(()=>validateFrozenCodeEvidence(modified),/冻结/);
 assert.throws(()=>verifyLifecycleReport(evidence,{...report,format:'shuduo-full-lifecycle-evaluation/v1'}),/契约/);
});

test('the complete local replay threshold is exactly 17 of 20 and does not grant autonomous success',()=>{
 const outcomes=evidence.cases.map(lifecycleOutcome);
 for(let index=0;index<3;index++)outcomes[index].stages.postReleaseMonitoring.status='FAILED';
 let result=summarizeLifecycleEvaluation(evidence,outcomes);
 assert.equal(result.localFullLifecycleRate,0.85);assert.equal(result.targetMet,true);assert.equal(result.agentE2ETargetMet,false);
 outcomes[3].stages.postReleaseMonitoring.status='FAILED';result=summarizeLifecycleEvaluation(evidence,outcomes);
 assert.equal(result.localFullLifecycleRate,0.8);assert.equal(result.targetMet,false);
 const empty=summarizeLifecycleEvaluation(evidence,[]);assert.equal(empty.localFullLifecycleRate,0);assert.equal(empty.unexecutedCaseCount,20);
});
