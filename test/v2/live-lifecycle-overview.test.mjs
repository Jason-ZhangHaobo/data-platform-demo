import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {get} from "node:http";
import {mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createV2Server} from "../../src/v2/server.mjs";
import {MetadataStore} from "../../src/v2/store.mjs";
import {
  advanceLiveLifecycleCase, currentLiveLifecycleContract, legacyLiveLifecycleContract,
  liveCaseCheckpoint, liveLifecyclePlan,
} from "../../src/v2/live-lifecycle-evaluation.mjs";
import {liveLifecycleOverview} from "../../src/v2/live-lifecycle-overview.mjs";
import {createLiveLifecycleFixture} from "./fixtures/live-lifecycle-case.mjs";

const v3 = currentLiveLifecycleContract.id;
const rootFor = t => {
  const path = mkdtempSync(join(tmpdir(), "shuduo-live-overview-"));
  t.after(() => rmSync(path, {recursive:true, force:true}));
  return path;
};
function save(root, state) {
  const directory = join(root, ".v2-artifacts", "live-lifecycle", state.evaluationRunId);
  mkdirSync(directory, {recursive:true, mode:0o700});
  const path = join(directory, "checkpoint.json");
  writeFileSync(path, JSON.stringify(state), {mode:0o600});
  return path;
}
function runState({id=randomUUID(), contractId=v3, limit=1, startedAt="2026-09-15T00:00:00.000Z", origin="http://127.0.0.1:3100", outcomes=[]}={}) {
  const plan = liveLifecyclePlan(limit, {contractId});
  return {evaluationRunId:id, contract:plan.contract, caseSetDigest:plan.caseSetDigest, caseLimit:limit, startedAt, origin, outcomes};
}
test("overview shows all frozen v3 cases even if only legacy records exist", t => {
  const root = rootFor(t);
  const empty = liveLifecycleOverview(root);
  assert.deepEqual(readdirSync(root), []);
  const path = save(root, runState({contractId:legacyLiveLifecycleContract.id}));
  const original = readFileSync(path, "utf8");
  const overview = liveLifecycleOverview(root);
  assert.equal(overview.cases.length, 20);
  assert.equal(overview.cases.filter(row => row.kind === "DERIVED").length, 10);
  assert(overview.cases.every(row => row.status === "NOT_RUN"));
  assert.equal(overview.selectedId, null);
  assert.equal(overview.legacyCount, 1);
  assert.equal(overview.verifiedCaseCount, 0);
  assert.equal(overview.autonomousCompletionRate, null);
  assert.equal(overview.measurementStatus, empty.measurementStatus);
  assert.equal(readFileSync(path, "utf8"), original);
});

test("HTTP overview preserves waiting stages and binds navigation to one original v3 run", async t => {
  const root = rootFor(t);
  const store = new MetadataStore(":memory:");
  const app = createV2Server({root, store, env:{V2_LOCAL_DEVELOPMENT:"true", V2_RELEASE_SCHEDULER_MODE:"DISABLED"}});
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    app.releaseScheduler.shutdown();app.server.closeAllConnections();
    await new Promise(resolve => app.server.close(resolve));store.close();
  });
  const origin = "http://127.0.0.1:" + app.server.address().port;
  const older = runState({origin, limit:4});
  const {selectedCases:[definition, reviewCase, monitorCase, unknownCase]} = liveLifecyclePlan(4,{contractId:v3});
  const fixture = createLiveLifecycleFixture({definition, contractId:v3, evaluationRunId:older.evaluationRunId});
  delete fixture.adapter.testDouble;
  const options = {maxPolls:2, pause:async()=>{}};
  const review = await advanceLiveLifecycleCase(definition, fixture.checkpoint, fixture.adapter, options);
  fixture.reviewNow();
  const waiting = await advanceLiveLifecycleCase(definition, review, fixture.adapter, options);
  assert.equal(waiting.status, "AWAITING_CONSUMPTION");
  function pending(item, status, phase, unknown=false) {
    const taskId = randomUUID();
    return {...liveCaseCheckpoint(item, older.startedAt, older.caseSetDigest, {contractId:v3, evaluationRunId:older.evaluationRunId}),
      status, phase, taskId, actions:{agent:{id:taskId, status:unknown?"SUBMITTING":"CONFIRMED"}}};
  }
  older.outcomes = [
    waiting, pending(reviewCase, "AWAITING_ENGINEER_REVIEW", "ENGINEER_REVIEW_AND_PUBLICATION"),
    pending(monitorCase, "AWAITING_MONITORING", "POST_RELEASE_MONITORING"),
    pending(unknownCase, "PAUSED", "CODE_AND_DEBUG", true),
  ];
  older.privateField = "EXAMPLE_NEVER_RETURN_CHECKPOINT_CONTENT";
  const path = save(root, older), before = readFileSync(path, "utf8");
  const latest = runState({origin, startedAt:"2026-09-16T00:00:00.000Z"});
  save(root, latest);
  const url = origin + "/api/v2/evaluations/live-lifecycle/overview";
  const response = await fetch(url);
  assert.equal(response.status, 200);
  const current = await response.json();
  assert.equal(current.selectedId, latest.evaluationRunId);
  assert.equal(current.cases[0].status, "NOT_RUN");
  const selected = await (await fetch(url + "?run_id=" + older.evaluationRunId)).json();
  assert.equal(selected.selectedId, older.evaluationRunId);
  assert.deepEqual(selected.cases.slice(0,5).map(row => row.status), [
    "AWAITING_CONSUMPTION","AWAITING_ENGINEER_REVIEW","AWAITING_MONITORING","SUBMISSION_UNKNOWN","OUTSIDE_RUN",
  ]);
  const [row,,,unknown] = selected.cases;
  assert.equal(row.taskUrl, origin + "/v2/?module=agent-center&task=" + fixture.task.id);
  const service = new URL(row.servicesUrl);
  assert.equal(service.searchParams.get("source_release"), fixture.release.id);
  assert.equal(service.searchParams.get("source_package"), fixture.bundle.digest);
  assert.equal(service.searchParams.get("source_revision"), fixture.revision.id);
  assert.equal(unknown.taskUrl, undefined);
  assert(!JSON.stringify(selected).includes(older.privateField));
  assert.equal(readFileSync(path, "utf8"), before);
  assert.deepEqual(readdirSync(join(root, ".v2-artifacts", "live-lifecycle", older.evaluationRunId)), ["checkpoint.json"]);
  assert.equal((await fetch(url + "?run_id=" + randomUUID())).status, 404);
  assert.equal((await fetch(url + "?run_id=../../other")).status, 422);
  const reboundStatus = await new Promise((resolve, reject) => {
    get(url, {headers:{host:"rebound.invalid"}}, response => {
      response.resume();
      resolve(response.statusCode);
    }).on("error", reject);
  });
  assert.equal(reboundStatus, 403);

  fixture.consumeNow();
  const complete = await advanceLiveLifecycleCase(definition, waiting, fixture.adapter, options);
  assert.equal(complete.status, "SUCCEEDED");
  older.outcomes[0] = complete;
  save(root, older);
  assert.equal(liveLifecycleOverview(root, older.evaluationRunId).verifiedCaseCount, 1);
  older.outcomes[0].actions.agent.status = "UNKNOWN";
  save(root, older);
  const conflicted = liveLifecycleOverview(root, older.evaluationRunId);
  assert.equal(conflicted.verifiedCaseCount, 0);
  assert.equal(conflicted.cases[0].status, "SUBMISSION_UNKNOWN");
  assert.equal(conflicted.cases[0].taskUrl, undefined);
});

test("reported success with synthetic or incomplete evidence never becomes a recorded pass", t => {
  const root = rootFor(t), state = runState();
  const {selectedCases:[definition]} = liveLifecyclePlan(1,{contractId:v3});
  const outcome = liveCaseCheckpoint(definition,state.startedAt,state.caseSetDigest,{contractId:v3,evaluationRunId:state.evaluationRunId});
  state.outcomes = [{...outcome, status:"SUCCEEDED", phase:"COMPLETE", testDouble:true}];
  save(root, state);
  assert.equal(liveLifecycleOverview(root).cases[0].status, "TEST_HARNESS");
  delete state.outcomes[0].testDouble;
  save(root, state);
  const current = liveLifecycleOverview(root);
  assert.equal(current.verifiedCaseCount, 0);
  assert.equal(current.cases[0].status, "UNCONFIRMED");
  state.outcomes[0].evaluationRunId = randomUUID();
  save(root, state);
  assert.throws(() => liveLifecycleOverview(root, state.evaluationRunId), {status:404});
  assert.equal(liveLifecycleOverview(root).unreadableCount, 1);
  const alias = join(root, ".v2-artifacts", "live-lifecycle", randomUUID());
  symlinkSync(join(root, ".v2-artifacts", "live-lifecycle", state.evaluationRunId), alias);
  assert.equal(liveLifecycleOverview(root).unreadableCount, 2);
});
