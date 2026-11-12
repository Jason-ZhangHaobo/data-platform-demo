import test from "node:test";
import assert from "node:assert/strict";
import { cloudV3CompletionScope, cloudV3FailureReceipt } from "../../scripts/cloud-v3-run.mjs";

test("an HTTPS completion requires both matched batches and the original approved application", () => {
  const source = "a".repeat(40);
  const state = { origin: "https://fixture.example", reviewedSource: source, submission: {
    windowApprovalDigest: "b".repeat(64),
    application: { applicationSource: source, inspectionDigest: "c".repeat(64) },
  } };
  const matched = [{ status: "MATCHED" }, { status: "MATCHED" }];
  const local = [{ status: "MATCHED_ONLY" }, { status: "MATCHED_ONLY" }];
  assert.equal(cloudV3CompletionScope(state, matched), "INVITED_CLOUD_MATCHED");
  assert.equal(cloudV3CompletionScope({ origin: "http://127.0.0.1:3100" }, local), "LOCAL_MATCHED_ONLY");
  for (const input of [matched.slice(0, 1), local, [matched[0], local[1]]])
    assert.throws(() => cloudV3CompletionScope(state, input));
  assert.throws(() => cloudV3CompletionScope({ ...state, reviewedSource: "d".repeat(40) }, matched));
  assert.throws(() => cloudV3CompletionScope({ ...state, submission: undefined }, matched));
});

test("a settled failure is separately classified and binds the original HTTPS application", () => {
  const source="a".repeat(40), taskId="00000000-0000-4000-8000-000000000001";
  const timestamp=new Date().toISOString(), item={taskId,caseId:"fixture-case",evaluationStartedAt:timestamp,
    actions:{agent:{status:"CONFIRMED",id:taskId}}};
  const state={origin:"https://fixture.example",reviewedSource:source,submission:{
    windowApprovalDigest:"b".repeat(64),application:{applicationSource:source,inspectionDigest:"c".repeat(64)},
  }};
  const original={state,text:"fixture checkpoint"};
  const failure={stage:"FAILED",taskVersion:4,finishedAt:timestamp,modelAttempts:1,ledgerTokens:12,
    sparkRunIds:[],sparkDurationMs:0};
  assert.equal(cloudV3FailureReceipt(original,item,failure,timestamp).scope,"INVITED_CLOUD_SETTLED_FAILURE");
  assert.throws(()=>cloudV3FailureReceipt({...original,state:{...state,submission:undefined}},item,failure,timestamp));
  assert.throws(()=>cloudV3FailureReceipt(original,{...item,actions:{...item.actions,delivery:{status:"UNKNOWN"}}},failure,timestamp));
  assert.throws(()=>cloudV3FailureReceipt(original,item,{...failure,sparkDurationMs:100},timestamp));
});
