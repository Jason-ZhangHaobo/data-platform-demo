import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createV2Server, PROJECT } from "../../src/v2/server.mjs";
import { MetadataStore } from "../../src/v2/store.mjs";
import {
  createDeliveryPackage,
  loadDeliveryDirectory,
  sha256,
} from "../../src/v2/delivery.mjs";
import {
  contextIds,
  referenceSql,
  validationContractId,
} from "../../src/v2/context.mjs";
import {
  localScheduleSpec,
  plannedLocalRuns,
} from "../../src/v2/release-scheduler.mjs";

const source = (name = "客户资产 T+1") => {
  const revision = {
      id: "revision-test",
      projectId: PROJECT,
      sql: referenceSql,
      hash: sha256(referenceSql),
      contextId: "holdings-t1",
    },
    run = {
      id: "run-test",
      projectId: PROJECT,
      revisionId: revision.id,
      revisionHash: revision.hash,
      status: "SUCCEEDED",
      engine: "Apache Spark",
      engineVersion: "3.5.7",
      validation: {
        passed: true,
        contractId: validationContractId,
        regressions: contextIds.map((contextId) => ({
          contextId,
          passed: true,
        })),
      },
    };
  return createDeliveryPackage({ run, revision, name });
};
const success = (input) => ({
  status: "SUCCEEDED",
  engine: "Apache Spark",
  engineVersion: "3.5.7",
  mainSqlExecuted: true,
  durationMs: 12,
  testSqlValidation: { passed: true, sqlHash: sha256("test") },
  validation: {
    passed: true,
    regressions: contextIds.map((contextId) => ({ contextId, passed: true })),
  },
  log: `synthetic run ${input.scheduledFor}`,
});
const waitFor = async (read, check, timeoutMs = 2000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (check(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("等待本机调度状态超时");
};

async function setup({ runner = success } = {}) {
  const root = mkdtempSync(join(tmpdir(), "shuzhan-release-api-")),
    store = new MetadataStore(join(root, "metadata.sqlite")),
    app = createV2Server({
      root,
      store,
      env: { V2_LOCAL_DEVELOPMENT: "true" },
      releaseRunner: async (input) => {
        loadDeliveryDirectory(input.directory, input.expectedDigest);
        return runner(input);
      },
      releaseTimeUnitMs: 5,
    });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}/api/v2`;
  let sequence = 0;
  const call = async (path, body) => {
    const response = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shuzhan-Client": "workbench",
        "Idempotency-Key": `release-test-${sequence++}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const seed = (name) => {
    const bundle = source(name),
      item = store.create("delivery_package", PROJECT, {
        ...bundle,
        stage: "M2A",
        published: false,
      });
    const rehearsal = store.create("delivery_verification", PROJECT, {
      packageId: item.id,
      packageDigest: item.digest,
      status: "SUCCEEDED",
      published: false,
      fullLifecycleE2E: false,
    });
    return { item, rehearsal };
  };
  const review = async (item, rehearsal, reviewNote = "已核对代码、断言、调度部署文件与本机范围") =>
    call(`/delivery/packages/${item.id}/review`, {
      packageDigest: item.digest,
      verificationId: rehearsal.id,
      reviewNote,
      attestations: {
        code: true,
        assertions: true,
        deliveryFiles: true,
        localScope: true,
      },
    });
  return {
    root,
    store,
    app,
    call,
    seed,
    review,
    close: async () => {
      await new Promise((resolve) => app.server.close(resolve));
      store.close();
    },
  };
}

test("local schedule configuration is bounded and creates wall-clock plans", () => {
  assert.deepEqual(localScheduleSpec(), {
    triggerAfterSeconds: 5,
    intervalSeconds: 15,
    runCount: 2,
  });
  assert.throws(() => localScheduleSpec({ runCount: 1 }), { status: 400 });
  assert.throws(() => localScheduleSpec({ intervalSeconds: 0 }), {
    status: 400,
  });
  const runs = plannedLocalRuns({
    releaseId: "release",
    packageId: "package",
    packageDigest: "digest",
    businessScheduledFor: "2026-09-11T09:00:00+08:00",
    spec: { triggerAfterSeconds: 2, intervalSeconds: 3, runCount: 2 },
    nowMs: Date.parse("2026-09-14T00:00:00Z"),
  });
  assert.equal(runs.length, 2);
  assert.equal(runs[0].scheduledTriggerAt, "2026-09-14T00:00:02.000Z");
  assert.equal(runs[1].scheduledTriggerAt, "2026-09-14T00:00:05.000Z");
  assert.ok(runs.every((run) => run.schedulerTriggered === false));
});

test("approval binds a successful rehearsal and two actual timer batches establish health", async () => {
  let calls = 0;
  const testApp = await setup({
    runner: async (input) => {
      calls++;
      return success(input);
    },
  });
  try {
    const { item, rehearsal } = testApp.seed("定时发布版本A");
    assert.equal(
      (
        await testApp.call(`/delivery/packages/${item.id}/approve`, {
          packageDigest: "0".repeat(64),
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await testApp.call(`/delivery/packages/${item.id}/approve`, {
          packageDigest: item.digest,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await testApp.call(`/delivery/packages/${item.id}/review`, {
          packageDigest: item.digest,
          verificationId: rehearsal.id,
          reviewNote: "不完整审阅不得作为发布依据",
          attestations: {
            code: true,
            assertions: false,
            deliveryFiles: true,
            localScope: true,
          },
        })
      ).status,
      422,
    );
    const review = (await testApp.review(item, rehearsal)).body;
    assert.equal(review.status, "REVIEWED");
    assert.equal(review.packageDigest, item.digest);
    const approval = (
      await testApp.call(`/delivery/packages/${item.id}/approve`, {
        packageDigest: item.digest,
        reviewId: review.id,
      })
    ).body;
    assert.equal(approval.status, "APPROVED");
    assert.equal(approval.packageDigest, item.digest);
    const input = {
        approvalId: approval.id,
        triggerAfterSeconds: 1,
        intervalSeconds: 1,
        runCount: 2,
      },
      release = (await testApp.call("/releases", input)).body;
    assert.equal(release.status, "ACTIVE_LOCAL");
    assert.equal(release.publicDeployed, false);
    assert.equal(release.artifactReady, true);
    assert.equal("artifactDirectory" in release, false);
    assert.equal((await testApp.call("/releases", input)).body.id, release.id);
    const overview = await waitFor(
      async () => (await testApp.call("/monitoring/overview")).body,
      (value) => value.counts.succeeded === 2,
    );
    assert.equal(calls, 2);
    assert.equal(overview.activeRelease.health, "HEALTHY");
    assert.equal(overview.counts.openAlerts, 0);
    assert.ok(
      overview.recentRuns.every(
        (run) =>
          run.schedulerTriggered === true &&
          run.clockMode === "WALL_CLOCK_TIMER" &&
          run.publicDeployed === false,
      ),
    );
    assert.equal(overview.fullLifecycleE2E, false);
  } finally {
    await testApp.close();
  }
});

test("failed scheduled batch opens an alert and later batches resolve it", async () => {
  let calls = 0;
  const testApp = await setup({
    runner: async (input) => {
      calls++;
      if (calls === 1)
        return {
          status: "FAILED",
          engine: "Apache Spark",
          engineVersion: "3.5.7",
          error: "受控故障：测试批次失败",
          durationMs: 4,
        };
      return success(input);
    },
  });
  try {
    const { item, rehearsal } = testApp.seed("故障恢复版本"),
      review = (await testApp.review(item, rehearsal)).body;
    const approval = (
      await testApp.call(`/delivery/packages/${item.id}/approve`, {
        packageDigest: item.digest,
        reviewId: review.id,
      })
    ).body;
    const release = (
      await testApp.call("/releases", {
        approvalId: approval.id,
        triggerAfterSeconds: 1,
        intervalSeconds: 1,
        runCount: 3,
      })
    ).body;
    const overview = await waitFor(
      async () => (await testApp.call("/monitoring/overview")).body,
      (value) =>
        value.counts.failed === 1 && value.counts.succeeded === 2,
    );
    assert.equal(overview.activeRelease.id, release.id);
    assert.equal(overview.activeRelease.health, "HEALTHY");
    assert.equal(overview.counts.openAlerts, 0);
    const alert = overview.alerts.find(
      (item) => item.releaseId === release.id,
    );
    assert.equal(alert.status, "RESOLVED");
    assert.ok(alert.recoveryRunId);
    assert.ok(overview.recentEvents.some((event) => event.type === "BATCH_FAILED"));
    assert.ok(
      overview.recentEvents.filter((event) => event.type === "BATCH_SUCCEEDED")
        .length >= 2,
    );
  } finally {
    await testApp.close();
  }
});

test("rollback restores only a previously healthy local release and schedules verification", async () => {
  const testApp = await setup();
  try {
    const publish = async (name) => {
      const { item, rehearsal } = testApp.seed(name),
        review = (await testApp.review(item, rehearsal)).body,
        approval = (
          await testApp.call(`/delivery/packages/${item.id}/approve`, {
            packageDigest: item.digest,
            reviewId: review.id,
          })
        ).body;
      return (
        await testApp.call("/releases", {
          approvalId: approval.id,
          triggerAfterSeconds: 1,
          intervalSeconds: 1,
          runCount: 2,
        })
      ).body;
    };
    const first = await publish("稳定版本A");
    await waitFor(
      async () => (await testApp.call(`/releases/${first.id}`)).body,
      (value) => value.health === "HEALTHY",
    );
    const second = await publish("待回滚版本B");
    await waitFor(
      async () => (await testApp.call(`/releases/${second.id}`)).body,
      (value) => value.health === "HEALTHY",
    );
    assert.equal(
      (await testApp.call(`/releases/${first.id}`)).body.status,
      "SUPERSEDED_LOCAL",
    );
    const alert = testApp.store.create("monitor_alert", PROJECT, {
      releaseId: second.id,
      releaseRunId: "controlled-failure",
      status: "OPEN",
      severity: "ERROR",
      message: "受控回滚测试告警",
    });
    const response = await testApp.call(`/releases/${second.id}/rollback`, {
      targetReleaseId: first.id,
      triggerAfterSeconds: 1,
      intervalSeconds: 1,
      reason: "恢复最近稳定版本并重新验证",
    });
    assert.equal(response.status, 202);
    assert.equal(response.body.activeRelease.id, first.id);
    assert.deepEqual(response.body.rollback.resolvedAlertIds, [alert.id]);
    await waitFor(
      async () => (await testApp.call("/release/runs")).body,
      (runs) =>
        runs.filter(
          (run) =>
            run.releaseId === first.id &&
            run.triggerReason === "ROLLBACK_RECOVERY" &&
            run.status === "SUCCEEDED",
        ).length === 2,
    );
    assert.equal(
      (await testApp.call(`/releases/${second.id}`)).body.status,
      "ROLLED_BACK_LOCAL",
    );
    assert.equal(
      (await testApp.call(`/releases/${first.id}`)).body.status,
      "ACTIVE_LOCAL",
    );
    const overview = (await testApp.call("/monitoring/overview")).body;
    assert.equal(
      overview.alerts.find((item) => item.id === alert.id).resolutionMode,
      "ROLLBACK",
    );
    assert.ok(
      overview.recentEvents.some((event) => event.type === "ROLLBACK_ACTIVATED"),
    );
  } finally {
    await testApp.close();
  }
});
