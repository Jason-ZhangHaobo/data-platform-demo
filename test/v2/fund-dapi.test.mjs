import test from "node:test";
import assert from "node:assert/strict";
import { BusinessQueryStore, DataServiceManager } from "../../src/v2/data-services.mjs";
import { MetadataStore } from "../../src/v2/store.mjs";
import { fundContext } from "../../src/v2/fund-lookthrough.mjs";

test("fund DAPI pins the composite grain, independently checked snapshot and authorized version", async t => {
  const project = "demo", store = new MetadataStore(":memory:"), businessStore = new BusinessQueryStore();
  t.after(() => { store.close(); businessStore.close(); });
  const rows = fundContext().expected;
  const run = { id: "fixture-batch", releaseId: "fixture-release", packageDigest: "a".repeat(64),
    engine: "Apache Spark", engineVersion: "3.5.9", status: "SUCCEEDED", rows,
    published: true, schedulerTriggered: true, publicDeployed: false, mainSqlExecuted: true,
    testSqlValidation: { passed: true }, validation: { passed: true } };
  const evidence = { eligibleForService: true, businessDate: "2026-09-10", packageDigest: run.packageDigest };
  let current = { evidence, rows };
  const manager = new DataServiceManager({ project, store, businessStore,
    releaseRunFor: id => id === run.id ? run : undefined, fundSourceFor: () => current });
  const service = manager.createDapi({ name: "基金敞口", slug: "fixture-fund", sourceReleaseRunId: run.id, fields: ["exposure_ratio"] });
  const version = manager.detail(service.id).currentVersion;
  assert.deepEqual(version.fields, ["portfolio_id", "trade_date", "asset_class", "exposure_ratio"]);
  assert.throws(() => manager.publish(service.id), { code: "SERVICE_TEST_REQUIRED" });
  await assert.rejects(manager.test(service.id, { client_id: "CLIENT-001" }), { code: "INVALID_FUND_QUERY" });
  await assert.rejects(manager.test(service.id, { trade_date: "2026-09-31" }), { code: "INVALID_FUND_QUERY" });
  await assert.rejects(manager.test(service.id, { page_size: true }), { code: "INVALID_FUND_QUERY" });
  const valid = await manager.test(service.id, { page_size: 2, trade_date: "2026-09-10" });
  assert.equal(valid.response.pagination.total, 7);
  assert.equal(valid.response.resultContract.paginationUnit, "FUND_EXPOSURE_ROWS");
  manager.publish(service.id);
  const second = manager.createDapi({ name: "另一个接口", slug: "fixture-fund-other", sourceReleaseRunId: run.id });
  await manager.test(second.id);
  manager.publish(second.id);
  assert.throws(() => manager.createXapi({ name: "组合待接入", slug: "fixture-fund-composite",
    steps: [{ alias: "ratio", dapiId: service.id }, { alias: "amount", dapiId: second.id }] }), { code: "INVALID_DISTRIBUTION_SERVICE" });
  const { token, application } = manager.createApplication({ name: "局部授权", serviceIds: [service.id] });
  const invoke = (query, path = "fixture-fund") => manager.invoke("DAPI", path, "Bearer " + token, query);
  await assert.rejects(invoke({}, "fixture-fund-other"), { status: 403 });
  const result = await invoke({ asset_class: "未穿透", portfolio_id: rows.find(row => row.exposure_amount === "450.00").portfolio_id });
  assert.equal(result.service.versionId, version.id);
  assert.equal(result.data[0].exposure_ratio, "0.225000");
  assert.ok(!Object.hasOwn(result.data[0], "exposure_amount"));
  const operation = manager.openApi(service.id).paths["/api/v2/open/dapis/fixture-fund"].get;
  assert.deepEqual(operation.parameters.map(parameter => parameter.name), ["portfolio_id", "trade_date", "asset_class", "page", "page_size"]);
  current = { evidence, rows: rows.map((row, index) => index === 0 ? { ...row, exposure_amount: "0.00" } : row) };
  await assert.rejects(invoke({}), { code: "FUND_SNAPSHOT_SOURCE_CHANGED" });
  current = { evidence: { ...evidence, packageDigest: "b".repeat(64) }, rows };
  await assert.rejects(invoke({}), { code: "FUND_SNAPSHOT_SOURCE_CHANGED" });
  manager.revokeApplication(application.id);
  await assert.rejects(invoke({}), { status: 401 });
});

test("fund XAPI joins exact amount and ratio snapshots and retains complete portfolio-date pages", async t => {
  const project = "demo", store = new MetadataStore(":memory:"), businessStore = new BusinessQueryStore();
  t.after(() => { store.close(); businessStore.close(); });
  const rows = fundContext().expected;
  const run = { id: "first-batch", releaseId: "fixture-release", packageDigest: "a".repeat(64), rows,
    engine: "Apache Spark", engineVersion: "3.5.9", status: "SUCCEEDED", published: true, schedulerTriggered: true,
    publicDeployed: false, mainSqlExecuted: true, testSqlValidation: { passed: true }, validation: { passed: true } };
  const runs = [run, { ...run, id: "other-batch" }];
  let sourceChanged = false;
  const manager = new DataServiceManager({ project, store, businessStore, releaseRunFor: id => runs.find(record => record.id === id),
    fundSourceFor: record => ({ rows, evidence: { eligibleForService: true, batchId: record.id, changed: sourceChanged } }) });
  const create = async (slug, field, batch = run.id) => {
    const service = manager.createDapi({ name: "基金数据测试", slug, sourceReleaseRunId: batch, fields: [field] });
    await manager.test(service.id);
    return manager.publish(service.id);
  };
  const amount = await create("test-fund-amount", "exposure_amount");
  const ratio = await create("test-fund-ratio", "exposure_ratio");
  const other = await create("test-fund-other-ratio", "exposure_ratio", runs[1].id);
  const steps = [
    { alias: "amount", dapiId: amount.service.id, dapiVersionId: amount.version.id },
    { alias: "ratio", dapiId: ratio.service.id, dapiVersionId: ratio.version.id },
  ];
  const input = { name: "基金资产敞口组合", slug: "test-fund-composite", steps };
  assert.throws(() => manager.createXapi({ ...input, steps: [steps[0], { alias: "ratio", dapiId: other.service.id }] }),
    { code: "INVALID_DISTRIBUTION_SERVICE" });
  assert.throws(() => manager.createXapi({ ...input, steps: [steps[0], { ...steps[1], alias: "exposures" }] }),
    { code: "INVALID_DISTRIBUTION_SERVICE" });
  const xapi = manager.createXapi(input);
  await manager.test(xapi.id);
  const published = manager.publish(xapi.id);
  assert.deepEqual(published.version.parameterSchema.trade_date, { type: "string", format: "date" });
  const { token, application } = manager.createApplication({ name: "组合授权", serviceIds: [xapi.id] });
  const bearer = "Bearer " + token;
  await assert.rejects(manager.invoke("DAPI", "test-fund-amount", bearer), { status: 403 });
  const invoke = query => manager.invoke("XAPI", input.slug, bearer, query);
  const first = await invoke({ page_size: 1 }), second = await invoke({ page: 2, page_size: 1 });
  assert.equal(first.pagination.total, 2);
  assert.equal(first.resultContract.paginationUnit, "PORTFOLIO_DATE_GROUPS");
  assert.notEqual(first.data[0].portfolio_id, second.data[0].portfolio_id);
  assert.equal(first.data[0].exposures.length + second.data[0].exposures.length, 7);
  const uncovered = first.data[0].exposures.find(item => item.asset_class === "未穿透");
  assert.deepEqual(uncovered, { asset_class: "未穿透", amount: { exposure_amount: "450.00" }, ratio: { exposure_ratio: "0.225000" } });
  const filtered = await invoke({ asset_class: "未穿透", trade_date: "2026-09-10" });
  assert.ok(filtered.data.every(group => group.exposures.length === 1 && group.exposures[0].asset_class === "未穿透"));
  assert.equal((await invoke({ portfolio_id: "PORT-NOT-FOUND" })).pagination.total, 0);

  manager.createDapiVersion(amount.service.id, { sourceReleaseRunId: run.id, rateLimitPerMinute: 99 });
  await manager.test(amount.service.id);
  assert.notEqual(manager.publish(amount.service.id).version.id, amount.version.id);
  assert.equal((await invoke({})).service.steps[0].dapiVersionId, amount.version.id);
  assert.equal((await manager.recheckCall(xapi.id, first.callId)).verified, true);
  const schema = manager.openApi(xapi.id).paths["/api/v2/open/xapis/test-fund-composite"].get.responses[200].content["application/json"].schema;
  assert.equal(schema.properties.data.items.properties.exposures.items.properties.ratio.properties.exposure_ratio.type, "string");
  sourceChanged = true;
  await assert.rejects(invoke({}), { code: "FUND_SNAPSHOT_SOURCE_CHANGED" });
  manager.revokeApplication(application.id);
  await assert.rejects(invoke({}), { status: 401 });
});
