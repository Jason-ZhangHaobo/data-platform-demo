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
