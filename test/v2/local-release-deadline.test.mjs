import test from "node:test";
import assert from "node:assert/strict";
import { MetadataStore } from "../../src/v2/store.mjs";
import { LocalReleaseScheduler } from "../../src/v2/release-scheduler.mjs";

// In-memory metadata, injected wall clock/timers and a fake runner only.
function fixture(t) {
  const store = new MetadataStore(":memory:"), project = "synthetic-deadline";
  const timers = [], calls = [], persisted = [];
  let now = 1000;
  const bundle = store.create("delivery_package", project, { digest: "a".repeat(64) });
  const release = store.create("release", project, { status: "ACTIVE_LOCAL" });
  const run = store.create("release_run", project, { releaseId: release.id,
    packageId: bundle.id, packageDigest: bundle.digest, status: "SCHEDULED",
    scheduledTriggerAt: new Date(1010).toISOString(), schedulerTriggered: false });
  const scheduler = new LocalReleaseScheduler({ store, project, now: () => now,
    packageFor: id => store.get("delivery_package", id, project),
    setTimer: (callback, delay) => {
      const timer = { callback, delay, cleared: false, unref() {} };
      timers.push(timer); return timer;
    },
    clearTimer: timer => { timer.cleared = true; },
    persist: async () => { persisted.push(store.get("release_run", run.id, project).status); },
    resolveDirectory: async () => undefined,
    runPackage: async () => { calls.push(now); return { status: "SUCCEEDED" }; },
  });
  t.after(() => { scheduler.shutdown(); store.close(); });
  return { store, project, release, run, scheduler, timers, calls, persisted,
    time: value => { now = value; }, current: () => store.get("release_run", run.id, project) };
}

test("an early timer keeps the batch scheduled and executes exactly once at its real deadline", async t => {
  const f = fixture(t); f.scheduler.schedule(f.run);
  assert.equal(f.timers[0].delay, 10);
  f.time(1009); f.timers[0].callback(); await f.scheduler.waitForIdle();
  assert.equal(f.current().status, "SCHEDULED"); assert.equal(f.current().schedulerTriggered, false);
  assert.equal(f.current().triggeredAt, undefined); assert.deepEqual(f.calls, []); assert.deepEqual(f.persisted, []);
  assert.equal(f.scheduler.controllers.size, 0); assert.equal(f.scheduler.timers.size, 1);
  assert.equal(f.timers[1].delay, 1);
  f.timers[0].callback(); await f.scheduler.waitForIdle();
  assert.equal(f.scheduler.timers.get(f.run.id), f.timers[1], "a stale callback cannot remove the replacement timer");
  f.time(1010); f.timers[1].callback(); await f.scheduler.waitForIdle();
  assert.deepEqual(f.calls, [1010]); assert.equal(f.current().status, "SUCCEEDED");
  assert.equal(f.current().triggeredAt, f.run.scheduledTriggerAt);
  assert.deepEqual(f.persisted, ["RUNNING", "SUCCEEDED"]);
  assert.equal(f.scheduler.controllers.size, 0); assert.equal(f.scheduler.timers.size, 0);
  f.timers[1].callback(); await f.scheduler.enqueue(f.run.id);
  assert.deepEqual(f.calls, [1010]); assert.equal(f.store.list("monitor_event", f.project).length, 1);
});

test("cancelling a rearmed or already queued batch cannot start it or recreate a timer", async t => {
  for (const queued of [false, true]) {
    const f = fixture(t); f.scheduler.schedule(f.run);
    f.time(1009); f.timers[0].callback(); await f.scheduler.waitForIdle();
    const rearmed = f.timers[1];
    if (queued) { f.time(1010); rearmed.callback(); }
    f.scheduler.cancelRelease(f.release.id);
    f.time(1020); rearmed.callback(); await f.scheduler.waitForIdle();
    assert.equal(f.current().status, "CANCELLED"); assert.equal(f.current().triggeredAt, undefined);
    assert.deepEqual(f.calls, []); assert.equal(f.scheduler.controllers.size, 0); assert.equal(f.scheduler.timers.size, 0);
    assert.equal(f.store.list("monitor_event", f.project).length, 0);
    if (!queued) assert.equal(rearmed.cleared, true);
  }
});

test("the serial queue rechecks a clock rollback and clears overlapping wakeups before claiming", async t => {
  const f = fixture(t); let releaseQueue;
  f.scheduler.queue = new Promise(resolve => { releaseQueue = resolve; });
  f.scheduler.schedule(f.run); f.time(1010); f.timers[0].callback();
  f.time(1008); releaseQueue(); await f.scheduler.waitForIdle();
  assert.deepEqual(f.calls, []); assert.equal(f.current().status, "SCHEDULED");
  assert.equal(f.timers[1].delay, 2); assert.equal(f.scheduler.controllers.size, 0);
  f.time(1010); await f.scheduler.enqueue(f.run.id);
  assert.equal(f.timers[1].cleared, true, "claiming queued work clears its outstanding timer");
  f.timers[1].callback(); await f.scheduler.waitForIdle();
  assert.deepEqual(f.calls, [1010]); assert.equal(f.current().triggeredAt, f.run.scheduledTriggerAt);
  assert.equal(f.scheduler.timers.size, 0); assert.equal(f.scheduler.controllers.size, 0);
});

test("a restarted local claim records one unknown result and a later batch cannot resolve it", async t => {
  const f = fixture(t), { store, project, release, run, scheduler } = f;
  store.update("release", release.id, project, { packageId: run.packageId, packageDigest: run.packageDigest, publicDeployed: false });
  store.update("release_run", run.id, project, { status: "RUNNING", mode: "LOCAL_SCHEDULED_RELEASE",
    clockMode: "WALL_CLOCK_TIMER", schedulerTriggered: true, triggeredAt: new Date(1010).toISOString() });
  const sibling = store.create("release_run", project, { releaseId: release.id, packageId: run.packageId,
    packageDigest: run.packageDigest, status: "SCHEDULED", scheduledTriggerAt: new Date(1020).toISOString() });
  f.time(1015);
  store.interruptPending(project);
  scheduler.start(); scheduler.start();
  assert.equal(f.current().status, "INTERRUPTED");
  assert.equal(f.current().resultUnknown, true);
  assert.equal(f.current().finishedAt, undefined);
  assert.equal(scheduler.timers.has(run.id), false);
  assert.equal(scheduler.timers.has(sibling.id), true);
  const [event] = store.list("monitor_event", project), [alert] = store.list("monitor_alert", project);
  assert.equal(event.type, "BATCH_RESULT_UNKNOWN");
  assert.equal(event.releaseRunId, run.id);
  assert.equal(alert.code, "LOCAL_RELEASE_RESULT_UNKNOWN");
  assert.equal(store.get("release", release.id, project).health, "CRITICAL");
  f.time(1020);
  await scheduler.enqueue(run.id);
  await scheduler.enqueue(sibling.id);
  assert.deepEqual(f.calls, [1020]);
  assert.equal(f.current().resultUnknown, true);
  assert.equal(store.get("monitor_alert", alert.id, project).status, "OPEN");
  assert.equal(store.list("monitor_alert", project).length, 1);
  assert.equal(store.list("monitor_event", project).length, 2);
  assert.equal(store.get("release", release.id, project).health, "CRITICAL");
  assert.equal(store.get("release", release.id, project).failedRunCount, 0);
});
