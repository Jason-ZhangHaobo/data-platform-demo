import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MetadataStore } from "../../src/v2/store.mjs";
import { BusinessQueryStore } from "../../src/v2/data-services.mjs";
import { createV2Server, PROJECT } from "../../src/v2/server.mjs";
import { getContext } from "../../src/v2/context.mjs";

async function listen({ store, businessStore, local = true, ...options }) {
  const app = createV2Server({
    store,
    businessStore,
    env: { V2_LOCAL_DEVELOPMENT: String(local) },
    ...options,
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  return { app, base };
}

async function waitForPlan(base, id, expected) {
  for (let index = 0; index < 60; index++) {
    const result = await request(
      base,
      `/api/v2/data-services/agent/plans/${id}`,
    );
    if (result.body.status === expected) return result.body;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`数据服务Agent方案未达到${expected}`);
}

async function request(base, path, options = {}) {
  const response = await fetch(base + path, {
    method: options.body === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shuduo-Client": "workbench",
      "Idempotency-Key": options.key ?? "data-services-api-test",
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, body: await response.json() };
}

async function createAndPublishDapi(base, input, key) {
  const created = await request(base, "/api/v2/data-services/dapis", {
    key,
    body: input,
  });
  assert.equal(created.status, 201);
  assert.equal(
    (
      await request(base, "/api/v2/data-services/dapis", {
        key,
        body: input,
      })
    ).body.id,
    created.body.id,
  );
  const tested = await request(
    base,
    `/api/v2/data-services/dapis/${created.body.id}/test`,
    { key: `${key}-test`, body: { clientId: "CLIENT-001" } },
  );
  assert.equal(tested.body.test.status, "PASSED");
  const published = await request(
    base,
    `/api/v2/data-services/dapis/${created.body.id}/publish`,
    { key: `${key}-publish`, body: {configHash:created.body.currentVersion.configHash} },
  );
  assert.equal(published.body.service.status, "PUBLISHED");
  return published.body.service;
}

test("V2 API exposes versioned DAPI/XAPI to an authorized external caller", async () => {
  const root = mkdtempSync(join(tmpdir(), "shuduo-data-services-api-")),
    store = new MetadataStore(join(root, "platform.sqlite")),
    businessStore = new BusinessQueryStore(join(root, "business.sqlite")),
    releaseRun = store.create("release_run", PROJECT, {
      releaseId: "release-api-test",
      status: "SUCCEEDED",
      published: true,
      publicDeployed: false,
      schedulerTriggered: true,
      engine: "Apache Spark",
      engineVersion: "3.5.7",
      mainSqlExecuted: true,
      testSqlValidation: { passed: true },
      rows: getContext("holdings-t1").expected,
      validation: { passed: true },
    });
  let server = await listen({ store, businessStore });
  try {
    const holdings = await createAndPublishDapi(
        server.base,
        {
          name: "客户持仓服务",
          slug: "customer-holdings-api",
          sourceReleaseRunId: releaseRun.id,
          fields: ["client_id", "holding_market_value", "security_count"],
          timeoutMs: 1000,
          rateLimitPerMinute: 10,
        },
        "create-holdings-dapi",
      ),
      cash = await createAndPublishDapi(
        server.base,
        {
          name: "客户现金服务",
          slug: "customer-cash-api",
          sourceReleaseRunId: releaseRun.id,
          fields: ["client_id", "available_cash", "total_assets"],
        },
        "create-cash-dapi",
      ),
      xapi = await request(server.base, "/api/v2/data-services/xapis", {
        key: "create-asset-xapi",
        body: {
          name: "客户资产组合服务",
          slug: "customer-asset-overview",
          steps: [
            { alias: "positions", dapiId: holdings.id },
            { alias: "cash", dapiId: cash.id },
          ],
        },
      });
    assert.equal(xapi.status, 201);
    const testedXapi = await request(
      server.base,
      `/api/v2/data-services/xapis/${xapi.body.id}/test`,
      { key: "test-asset-xapi", body: { clientId: "CLIENT-001" } },
    );
    assert.equal(testedXapi.body.response.data[0].cash.total_assets, "1800.00");
    const publishedXapi = await request(
      server.base,
      `/api/v2/data-services/xapis/${xapi.body.id}/publish`,
      { key: "publish-asset-xapi", body: {configHash:xapi.body.currentVersion.configHash} },
    );
    assert.equal(publishedXapi.body.version.status, "PUBLISHED");
    const issued = await request(
      server.base,
      "/api/v2/data-services/applications",
      {
        key: "create-external-app",
        body: {
          name: "证券财富管理演示前台",
          serviceIds: [holdings.id, xapi.body.id],
        },
      },
    );
    assert.equal(issued.status, 201);
    assert.equal(issued.body.tokenShownOnce, true);
    const repeatedIssue = await request(
      server.base,
      "/api/v2/data-services/applications",
      {
        key: "create-external-app",
        body: {
          name: "证券财富管理演示前台",
          serviceIds: [holdings.id, xapi.body.id],
        },
      },
    );
    assert.equal(repeatedIssue.status, 200);
    assert.equal(repeatedIssue.body.application.id, issued.body.application.id);
    assert.equal(repeatedIssue.body.token, null);
    assert.equal(repeatedIssue.body.tokenShownOnce, false);
    const authorization = `Bearer ${issued.body.token}`,
      dapiResponse = await request(
        server.base,
        "/api/v2/open/dapis/customer-holdings-api?client_id=CLIENT-001&page=1&page_size=5",
        { headers: { Authorization: authorization } },
      ),
      xapiResponse = await request(
        server.base,
        "/api/v2/open/xapis/customer-asset-overview?client_id=CLIENT-002",
        { headers: { Authorization: authorization } },
      );
    assert.equal(dapiResponse.status, 200);
    assert.equal(dapiResponse.body.data[0].holding_market_value, "1500.00");
    assert.equal(dapiResponse.body.pagination.total, 1);
    assert.equal(dapiResponse.body.service.version, 1);
    assert.equal(xapiResponse.status, 200);
    assert.equal(xapiResponse.body.data[0].positions.security_count, 1);
    assert.equal(xapiResponse.body.data[0].cash.total_assets, "950.00");
    const applications = await request(
      server.base,
      "/api/v2/data-services/applications",
    );
    assert.equal(JSON.stringify(applications.body).includes(issued.body.token), false);
    assert.equal(JSON.stringify(applications.body).includes("tokenHash"), false);
    const calls = await request(server.base, "/api/v2/data-services/calls");
    assert.equal(calls.body.length, 2);
    assert.deepEqual(
      new Set(calls.body.map((item) => item.outcome)),
      new Set(["SUCCEEDED"]),
    );
    const spec = await request(
      server.base,
      `/api/v2/data-services/xapis/${xapi.body.id}/openapi`,
    );
    assert.equal(spec.body.openapi, "3.1.0");
    assert.ok(
      spec.body.paths["/api/v2/open/xapis/customer-asset-overview"],
    );
    const grant={name:"虚构单客户应用",serviceIds:[holdings.id,xapi.body.id],
      customerAccess:{clientId:"CLIENT-001",maskedFields:["client_id","available_cash","security_count"]}};
    const issue=body=>request(server.base,"/api/v2/data-services/applications",{key:"restricted-app",body});
    const invalid=await issue({...grant,customerAccess:{...grant.customerAccess,maskedFields:["unregistered_field"]}});
    assert.equal(invalid.body.code,"INVALID_CUSTOMER_ACCESS");
    const restricted=await issue(grant);
    assert.equal(restricted.status,201);
    assert.deepEqual(restricted.body.application.versionGrants,{
      [holdings.id]:holdings.publishedVersionId,[xapi.body.id]:publishedXapi.body.version.id,
    });
    const allowed=path=>request(server.base,"/api/v2/open/"+path,{headers:{Authorization:"Bearer "+restricted.body.token}});
    const [positions,combined]=await Promise.all([allowed("dapis/customer-holdings-api"),allowed("xapis/customer-asset-overview")]);
    assert.equal(positions.status,200);
    assert.equal(combined.status,200);
    assert.deepEqual(positions.body.data,[{client_id:"******",holding_market_value:"1500.00",security_count:"******"}]);
    assert.deepEqual(combined.body.data,[{client_id:"******",positions:{holding_market_value:"1500.00",security_count:"******"},
      cash:{available_cash:"******",total_assets:"1800.00"}}]);
    assert.equal(positions.body.pagination.total,1);
    assert.equal(combined.body.pagination.total,1);
    const pageTwo=await allowed("xapis/customer-asset-overview?page=2&page_size=1");
    assert.deepEqual(pageTwo.body.data,[]);
    assert.equal(pageTwo.body.pagination.total,1);
    const denied=await allowed("xapis/customer-asset-overview?client_id=CLIENT-002");
    assert.equal(denied.status,403);
    assert.equal(denied.body.code,"CUSTOMER_SCOPE_FORBIDDEN");
    assert.equal((await allowed("dapis/customer-cash-api")).body.code,"SERVICE_FORBIDDEN");
    assert.equal((await issue({...grant,customerAccess:{...grant.customerAccess,clientId:"CLIENT-002"}})).status,409);
    const revokedRestricted=await request(server.base,`/api/v2/data-services/applications/${restricted.body.application.id}/revoke`,{body:{}});
    assert.equal(revokedRestricted.status,200);
    assert.equal((await allowed("xapis/customer-asset-overview")).status,401);
    const evidence=await server.app.dataServices.recheckCall(xapi.body.id,combined.body.callId);
    assert.equal(evidence.verified,true);
    assert.equal(evidence.rowCount,1);
    assert.equal(evidence.data,undefined);
    const savedApp=store.get("service_app",restricted.body.application.id,PROJECT);
    store.update("service_app",savedApp.id,PROJECT,{customerAccess:{clientId:"CLIENT-002",maskedFields:[]}});
    await assert.rejects(server.app.dataServices.recheckCall(xapi.body.id,combined.body.callId), {code:"CONSUMPTION_RECEIPT_UNAVAILABLE"});
    store.update("service_app",savedApp.id,PROJECT,{customerAccess:savedApp.customerAccess});
    const status = await request(server.base, "/api/v2/status");
    assert.equal(status.body.dataServices.serviceCount, 3);
    assert.equal(status.body.dataServices.cloudVerified, false);

    await new Promise((resolve) => server.app.server.close(resolve));
    server = await listen({ store, businessStore, local: false });
    const publicRead = await request(
      server.base,
      "/api/v2/open/xapis/customer-asset-overview?client_id=CLIENT-001",
      { headers: { Authorization: authorization } },
    );
    assert.equal(publicRead.status, 200);
    assert.equal(publicRead.body.localTestOnly, true);
    assert.equal(
      (
        await request(server.base, "/api/v2/data-services/dapis", {
          key: "public-write-rejected",
          body: {
            name: "拒绝创建",
            slug: "rejected-service",
            sourceReleaseRunId: releaseRun.id,
          },
        })
      ).status,
      401,
    );
    await new Promise((resolve) => server.app.server.close(resolve));
    server = await listen({ store, businessStore, local: true });
    const revoked = await request(
      server.base,
      `/api/v2/data-services/applications/${issued.body.application.id}/revoke`,
      { key: "revoke-external-app", body: {} },
    );
    assert.equal(revoked.body.status, "REVOKED");
    assert.equal(
      (
        await request(
          server.base,
          "/api/v2/open/dapis/customer-holdings-api?client_id=CLIENT-001",
          { headers: { Authorization: authorization } },
        )
      ).status,
      401,
    );
  } finally {
    await new Promise((resolve) => server.app.server.close(resolve));
    businessStore.close();
    store.close();
  }
});

test("V2 service API rejects unpublished data, missing app grants and invalid inputs", async () => {
  const root = mkdtempSync(join(tmpdir(), "shuduo-data-services-api-deny-")),
    store = new MetadataStore(join(root, "platform.sqlite")),
    businessStore = new BusinessQueryStore(":memory:"),
    untriggered = store.create("release_run", PROJECT, {
      status: "SUCCEEDED",
      published: false,
      schedulerTriggered: false,
      rows: getContext().expected,
    }),
    server = await listen({ store, businessStore });
  try {
    const bad = await request(server.base, "/api/v2/data-services/dapis", {
      key: "bad-source",
      body: {
        name: "无效服务",
        slug: "invalid-source",
        sourceReleaseRunId: untriggered.id,
      },
    });
    assert.equal(bad.status, 409);
    assert.equal(bad.body.code, "INVALID_RELEASE_RUN");
    const unknown = await request(
      server.base,
      "/api/v2/open/dapis/not-published?client_id=CLIENT-001",
      { headers: { Authorization: "Bearer sz_local_" + "a".repeat(32) } },
    );
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.code, "SERVICE_NOT_FOUND");
  } finally {
    await new Promise((resolve) => server.app.server.close(resolve));
    businessStore.close();
    store.close();
  }
});

test("Data Agent plans a governed DAPI and only creates a draft after apply", async () => {
  const root = mkdtempSync(join(tmpdir(), "shuduo-service-agent-api-")),
    store = new MetadataStore(join(root, "platform.sqlite")),
    businessStore = new BusinessQueryStore(":memory:"),
    releaseRun = store.create("release_run", PROJECT, {
      releaseId: "release-agent-test",
      status: "SUCCEEDED",
      published: true,
      publicDeployed: false,
      schedulerTriggered: true,
      engine: "Apache Spark",
      engineVersion: "3.5.7",
      mainSqlExecuted: true,
      testSqlValidation: { passed: true },
      rows: getContext().expected,
      validation: { passed: true },
    }),
    server = await listen({
      store,
      businessStore,
      servicePlanner: async () => ({
        plan: {
          serviceType: "DAPI",
          name: "Agent客户资产查询",
          slug: "agent-customer-assets",
          sourceReleaseRunId: releaseRun.id,
          fields: ["client_id", "total_assets"],
          timeoutMs: 1200,
          rateLimitPerMinute: 40,
        },
        explanation: "使用当前可用的真实发布批次生成草稿",
        model: "TEST_DOUBLE",
        usage: { total_tokens: 100 },
      }),
    });
  try {
    const started = await request(
        server.base,
        "/api/v2/data-services/agent/plans",
        {
          key: "service-agent-plan",
          body: { message: "创建客户资产DAPI，只返回客户和总资产" },
        },
      ),
      completed = await waitForPlan(server.base, started.body.id, "SUCCEEDED");
    assert.equal(started.status, 202);
    assert.equal(completed.completionScope, "DATA_SERVICE_DESIGN");
    assert.equal(completed.fullLifecycleE2E, false);
    assert.equal(completed.proposal.serviceType, "DAPI");
    assert.equal(store.list("data_service", PROJECT).length, 0);
    const applied = await request(
      server.base,
      `/api/v2/data-services/agent/plans/${completed.id}/apply`,
      { key: "apply-service-agent-plan", body: {} },
    );
    assert.equal(applied.status, 201);
    assert.equal(applied.body.status, "DRAFT");
    assert.equal(applied.body.currentVersion.sourceReleaseRunId, releaseRun.id);
    assert.equal(
      (await request(server.base, `/api/v2/data-services/agent/plans/${completed.id}`))
        .body.status,
      "APPLIED",
    );
  } finally {
    await new Promise((resolve) => server.app.server.close(resolve));
    businessStore.close();
    store.close();
  }
});

test("a local application TTL is enforced by the HTTP query path and replay cannot extend it", async t => {
  const store = new MetadataStore(":memory:"), businessStore = new BusinessQueryStore();
  const source = store.create("release_run",PROJECT,{releaseId:"ttl-fixture",status:"SUCCEEDED",published:true,publicDeployed:false,
    schedulerTriggered:true,engine:"Apache Spark",engineVersion:"3.5.9",mainSqlExecuted:true,testSqlValidation:{passed:true},
    rows:getContext("holdings-t1").expected,validation:{passed:true}});
  const {app,base} = await listen({store,businessStore});
  t.after(async () => {
    app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve));
    app.dispose(); store.close(); businessStore.close();
  });
  const service=await createAndPublishDapi(base,{name:"短时应用查询",slug:"short-lived-assets",sourceReleaseRunId:source.id,
    fields:["client_id","total_assets"]},"ttl-service");
  const path="/api/v2/data-services/applications",key="one-short-lived-grant";
  const grant={name:"短时样例客户端",serviceIds:[service.id],ttlSeconds:1};
  const invalid=await request(base,path,{key,body:{...grant,ttlSeconds:"1"}});
  assert.equal(invalid.status,400);assert.equal(invalid.body.code,"APPLICATION_TTL_INVALID");
  const before=Date.now(), first=await request(base,path,{key,body:grant});
  assert.equal(first.status,201);
  const {id,expiresAt}=first.body.application, boundary=Date.parse(expiresAt);
  assert.ok(boundary>=before+1000 && boundary<=Date.now()+1000);
  const query=()=>request(base,"/api/v2/open/dapis/short-lived-assets?client_id=CLIENT-001",{headers:{Authorization:"Bearer "+first.body.token}});
  // This check uses the server's actual clock; the manager test also exercises
  // the exact last allowed millisecond independently of OS scheduling.
  await new Promise(resolve=>setTimeout(resolve,Math.max(0,boundary-Date.now()+2)));
  const expired=await query();
  assert.equal(expired.status,401);assert.equal(expired.body.code,"TOKEN_EXPIRED");
  const replay=await request(base,path,{key,body:grant});
  assert.equal(replay.status,200);assert.equal(replay.body.token,null);
  assert.deepEqual([replay.body.application.id,replay.body.application.expiresAt,replay.body.application.status],[id,expiresAt,"EXPIRED"]);
  assert.equal((await request(base,path,{key,body:{...grant,ttlSeconds:300}})).status,409);
  assert.equal((await request(base,path+"/"+id+"/revoke",{key:"revoke-expired-grant",body:{}})).status,200);
  assert.equal((await query()).status,401);
  assert.equal(store.list("service_app",PROJECT).length,1);
});
