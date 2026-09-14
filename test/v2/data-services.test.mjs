import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MetadataStore } from "../../src/v2/store.mjs";
import {
  BusinessQueryStore,
  DataServiceManager,
  serviceHash,
} from "../../src/v2/data-services.mjs";
import { getContext } from "../../src/v2/context.mjs";
import { PROJECT } from "../../src/v2/server.mjs";
import { generateDataServicePlan } from "../../src/v2/model.mjs";

function setup(options = {}) {
  const root = mkdtempSync(join(tmpdir(), "shuzhan-data-services-")),
    store = new MetadataStore(join(root, "platform.sqlite")),
    businessStore = new BusinessQueryStore(join(root, "business.sqlite")),
    releaseRun = store.create("release_run", PROJECT, {
      releaseId: "release-real-local",
      status: "SUCCEEDED",
      published: true,
      publicDeployed: false,
      schedulerTriggered: true,
      engine: "Apache Spark",
      engineVersion: "3.5.7",
      rows: getContext("holdings-t1").expected,
      validation: { passed: true },
    }),
    manager = new DataServiceManager({
      store,
      businessStore,
      project: PROJECT,
      releaseRunFor: (id) => store.get("release_run", id, PROJECT),
      ...options,
    });
  return {
    root,
    store,
    businessStore,
    releaseRun,
    manager,
    close() {
      businessStore.close();
      store.close();
    },
  };
}

async function publishedDapi(manager, releaseRun, input) {
  const created = manager.createDapi({
    sourceReleaseRunId: releaseRun.id,
    timeoutMs: 500,
    rateLimitPerMinute: 60,
    ...input,
  });
  const detail = manager.detail(created.id);
  const tested = await manager.test(created.id, { clientId: "CLIENT-001" });
  assert.equal(tested.test.status, "PASSED");
  return manager.publish(created.id).service;
}

test("business snapshots are immutable and queried with exact decimal strings", () => {
  const app = setup();
  try {
    const rows = getContext("holdings-t1").expected,
      first = app.businessStore.materialize("snapshot-demo", rows),
      replay = app.businessStore.materialize("snapshot-demo", rows),
      result = app.businessStore.queryAssets(
        "snapshot-demo",
        { clientId: "CLIENT-001", page: 1, pageSize: 10 },
        ["client_id", "total_assets"],
      );
    assert.equal(first.replayed, false);
    assert.equal(replay.replayed, true);
    assert.deepEqual(result.rows, [
      { client_id: "CLIENT-001", total_assets: "1800.00" },
    ]);
    assert.equal(result.pagination.total, 1);
    assert.throws(
      () =>
        app.businessStore.materialize("snapshot-demo", [
          { ...rows[0], total_assets: "999.00" },
        ]),
      { status: 409, code: "SNAPSHOT_CONFLICT" },
    );
  } finally {
    app.close();
  }
});

test("DAPI uses a real scheduled release result, versioned tests and OpenAPI", async () => {
  const app = setup();
  try {
    const service = await publishedDapi(app.manager, app.releaseRun, {
      name: "客户总资产查询",
      slug: "customer-assets",
      fields: ["client_id", "total_assets"],
    });
    const detail = app.manager.detail(service.id),
      spec = app.manager.openApi(service.id);
    assert.equal(detail.status, "PUBLISHED");
    assert.equal(detail.publishedVersion.status, "PUBLISHED");
    assert.equal(detail.publishedVersion.sourceReleaseRunId, app.releaseRun.id);
    assert.equal(detail.publishedVersion.snapshotHash.length, 64);
    assert.equal(
      spec.paths["/api/v2/open/dapis/customer-assets"].get.responses[429]
        .description,
      "超过版本限流",
    );
    assert.equal(spec["x-shuzhan-scope"], "LOCAL_TEST_ONLY");
    const version2 = app.manager.createDapiVersion(service.id, {
      sourceReleaseRunId: app.releaseRun.id,
      fields: ["client_id", "holding_market_value"],
    });
    await app.manager.test(service.id, { clientId: "CLIENT-001" });
    app.manager.publish(service.id);
    let switched = app.manager.detail(service.id);
    assert.equal(switched.publishedVersion.id, version2.id);
    assert.equal(switched.versions.find((item) => item.versionNumber === 1).status, "RETIRED");
    const version1 = switched.versions.find((item) => item.versionNumber === 1);
    app.manager.activate(service.id, version1.id);
    switched = app.manager.detail(service.id);
    assert.equal(switched.publishedVersion.id, version1.id);
    assert.equal(switched.currentVersionId, version1.id);
  } finally {
    app.close();
  }
});

test("application authorization never stores the raw token and DAPI logs real calls", async () => {
  const app = setup();
  try {
    const service = await publishedDapi(app.manager, app.releaseRun, {
        name: "客户持仓市值",
        slug: "holding-market-value",
        fields: ["client_id", "holding_market_value", "security_count"],
        rateLimitPerMinute: 2,
      }),
      issued = app.manager.createApplication({
        name: "财富顾问演示系统",
        serviceIds: [service.id],
      });
    assert.match(issued.token, /^sz_local_[A-Za-z0-9_-]{32}$/);
    assert.ok(
      !JSON.stringify(app.store.list("service_app", PROJECT)).includes(
        issued.token,
      ),
    );
    assert.equal(
      JSON.stringify(app.manager.listApplications()).includes("tokenHash"),
      false,
    );
    await assert.rejects(
      app.manager.invoke("DAPI", service.slug, "", {}),
      { status: 401 },
    );
    const first = await app.manager.invoke(
      "DAPI",
      service.slug,
      `Bearer ${issued.token}`,
      { clientId: "CLIENT-001" },
    );
    assert.deepEqual(first.data, [
      {
        client_id: "CLIENT-001",
        holding_market_value: "1500.00",
        security_count: 2,
      },
    ]);
    assert.equal(first.service.version, 1);
    assert.equal(first.localTestOnly, true);
    await app.manager.invoke("DAPI", service.slug, `Bearer ${issued.token}`, {
      clientId: "CLIENT-002",
    });
    await assert.rejects(
      app.manager.invoke("DAPI", service.slug, `Bearer ${issued.token}`, {}),
      { status: 429, code: "RATE_LIMITED" },
    );
    const calls = app.manager.listCalls(service.id);
    assert.equal(calls.filter((item) => item.outcome === "SUCCEEDED").length, 2);
    assert.equal(calls.filter((item) => item.outcome === "RATE_LIMITED").length, 1);
    assert.ok(calls.every((item) => !JSON.stringify(item).includes(issued.token)));
    const revoked = app.manager.revokeApplication(issued.application.id);
    assert.equal(revoked.status, "REVOKED");
    await assert.rejects(
      app.manager.invoke("DAPI", service.slug, `Bearer ${issued.token}`, {}),
      { status: 401 },
    );
  } finally {
    app.close();
  }
});

test("XAPI pins published DAPI versions and composes holdings with cash", async () => {
  const app = setup();
  try {
    const holdings = await publishedDapi(app.manager, app.releaseRun, {
        name: "持仓查询",
        slug: "holdings-view",
        fields: ["client_id", "holding_market_value", "security_count"],
      }),
      cash = await publishedDapi(app.manager, app.releaseRun, {
        name: "现金与总资产查询",
        slug: "cash-assets-view",
        fields: ["client_id", "available_cash", "total_assets"],
      }),
      xapi = app.manager.createXapi({
        name: "财富顾问客户资产组合查询",
        slug: "advisor-asset-overview",
        steps: [
          { alias: "positions", dapiId: holdings.id },
          { alias: "cash", dapiId: cash.id },
        ],
      }),
      testResult = await app.manager.test(xapi.id, {
        clientId: "CLIENT-001",
      });
    assert.deepEqual(testResult.response.data, [
      {
        client_id: "CLIENT-001",
        positions: {
          holding_market_value: "1500.00",
          security_count: 2,
        },
        cash: { available_cash: "300.00", total_assets: "1800.00" },
      },
    ]);
    const xapiVersion2 = app.manager.createXapiVersion(xapi.id, {
      rateLimitPerMinute: 25,
    });
    assert.equal(xapiVersion2.versionNumber, 2);
    assert.equal(xapiVersion2.steps.length, 2);
    await app.manager.test(xapi.id, { clientId: "CLIENT-001" });
    const published = app.manager.publish(xapi.id).service,
      issued = app.manager.createApplication({
        name: "证券财富分析门户",
        serviceIds: [published.id],
      }),
      response = await app.manager.invoke(
        "XAPI",
        published.slug,
        `Bearer ${issued.token}`,
        { clientId: "CLIENT-002" },
      );
    assert.equal(response.data[0].positions.holding_market_value, "750.00");
    assert.equal(response.data[0].cash.total_assets, "950.00");
    assert.equal(response.service.type, "XAPI");
    assert.equal(response.service.version, 2);
    assert.equal(app.manager.listCalls(published.id)[0].outcome, "SUCCEEDED");
  } finally {
    app.close();
  }
});

test("authorization scope and execution timeout fail closed with audit logs", async () => {
  const app = setup();
  try {
    const allowed = await publishedDapi(app.manager, app.releaseRun, {
      name: "允许的服务",
      slug: "allowed-service",
      timeoutMs: 100,
      }),
      denied = await publishedDapi(app.manager, app.releaseRun, {
        name: "未授权服务",
        slug: "denied-service",
      }),
      issued = app.manager.createApplication({
        name: "最小权限调用方",
        serviceIds: [allowed.id],
      });
    await assert.rejects(
      app.manager.invoke("DAPI", denied.slug, `Bearer ${issued.token}`, {}),
      { status: 403 },
    );
    app.manager.executeDapi = () =>
      new Promise((resolve) =>
        setTimeout(() => resolve({ rows: [], pagination: {} }), 150),
      );
    await assert.rejects(
      app.manager.invoke("DAPI", allowed.slug, `Bearer ${issued.token}`, {}),
      { status: 504, code: "SERVICE_TIMEOUT" },
    );
    assert.equal(
      app.manager.listCalls(allowed.id).find((item) => item.outcome === "TIMED_OUT")
        .statusCode,
      504,
    );
  } finally {
    app.close();
  }
});

test("DAPI creation rejects simulated, untriggered or unverified runs", () => {
  const app = setup();
  try {
    for (const patch of [
      { published: false },
      { schedulerTriggered: false },
      { engine: "SIMULATED" },
      { validation: { passed: false } },
    ]) {
      const run = app.store.create("release_run", PROJECT, {
        ...app.releaseRun,
        ...patch,
      });
      assert.throws(
        () =>
          app.manager.createDapi({
            name: "不可发布服务",
            slug: `invalid-${run.id.slice(0, 8)}`,
            sourceReleaseRunId: run.id,
          }),
        { status: 409, code: "INVALID_RELEASE_RUN" },
      );
    }
  } finally {
    app.close();
  }
});

test("service hashes are stable across object key order", () => {
  assert.equal(serviceHash({ a: 1, b: 2 }), serviceHash({ b: 2, a: 1 }));
});

test("data-service model adapter sends only governed resource summaries", async () => {
  let request;
  const generated = await generateDataServicePlan(
    {
      message: "创建持仓DAPI",
      services: [],
      releaseRuns: [{ id: "run-demo", releaseId: "release-demo", rows: [{ secret: "not-sent" }] }],
    },
    { DASHSCOPE_API_KEY: "TEST_ONLY" },
    async (url, options) => {
      request = { url, options };
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  serviceType: "DAPI",
                  name: "客户持仓查询",
                  slug: "agent-holdings",
                  sourceReleaseRunId: "run-demo",
                  fields: ["client_id", "holding_market_value"],
                  timeoutMs: 1500,
                  rateLimitPerMinute: 60,
                  explanation: "绑定真实发布批次",
                }),
              },
            },
          ],
          usage: { total_tokens: 120 },
        }),
      );
    },
  );
  const payload = JSON.parse(request.options.body),
    prompt = payload.messages[1].content;
  assert.equal(request.options.headers.Authorization, "Bearer TEST_ONLY");
  assert.equal(request.options.redirect, "error");
  assert.equal(prompt.includes("not-sent"), false);
  assert.equal(generated.plan.slug, "agent-holdings");
  assert.equal(generated.explanation, "绑定真实发布批次");
  assert.equal("explanation" in generated.plan, false);
});
