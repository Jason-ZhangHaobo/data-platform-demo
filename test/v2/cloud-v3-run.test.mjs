import test from "node:test";
import assert from "node:assert/strict";
import { cloudV3CompletionScope } from "../../scripts/cloud-v3-run.mjs";

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
