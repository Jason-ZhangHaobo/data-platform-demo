#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { V2Client } from "../src/v2/client.mjs";
import { validateDeliveryPackage } from "../src/v2/delivery.mjs";

// Continue the clean, fictional manual reference run. Only this local test
// issues approval and short-lived application credentials.
const [origin, confirmation, ...extra] = process.argv.slice(2);
const input = ".v2-artifacts/reference-reproduction.json";
const output = ".v2-artifacts/reference-wealth-release.json";
const ids = {};
const batches = [];
const calls = { dapi: [], xapi: [] };
const applications = [];
const requests = [];
const expected = [
  { client_id: "CLIENT-001", holding_market_value: "1500.00", available_cash: "300.00", total_assets: "1800.00", security_count: 2 },
  { client_id: "CLIENT-002", holding_market_value: "750.00", available_cash: "200.00", total_assets: "950.00", security_count: 1 },
];
const digest = value => createHash("sha256").update(value).digest("hex");
const identifier = /^[a-f0-9-]{36}$/;
let run, client, step = "输入与本机范围", result, checkpointCreated = false;

function save(checkpoint, first = false) {
  const path = first ? output : output + "." + randomUUID();
  writeFileSync(path, JSON.stringify(checkpoint, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  if (!first) renameSync(path, output);
}

async function post(name, path, body) {
  step = name;
  const record = { name, path, key: randomUUID(), bodySha256: digest(JSON.stringify(body)), status: "SUBMITTING" };
  requests.push(record);
  save(run);
  const response = await client.request(path, { method: "POST", idempotencyKey: record.key, body });
  record.status = "CONFIRMED";
  const id = response.id ?? response.application?.id;
  if (identifier.test(id ?? "")) record.id = id;
  save(run);
  return response;
}

function verifySpark(record, files) {
  assert.equal(record.status, "SUCCEEDED");
  assert.equal(record.engine, "Apache Spark");
  assert.equal(record.engineVersion, "3.5.9");
  assert.equal(record.mainSqlExecuted, true);
  assert.notEqual(record.testDouble, true);
  assert.equal(record.validation?.passed, true);
  assert.equal(record.validation.regressions?.length, 5);
  assert.ok(record.validation.regressions.every(item => item.passed));
  if (files) assert.equal(record.testSqlValidation?.passed, true);
}

async function publishService(kind, name, body) {
  const path = "/data-services/" + kind + "s";
  const draft = await post("创建 " + name, path, body);
  await post("测试 " + name, path + "/" + draft.id + "/test", {});
  const current = await client.request(path + "/" + draft.id);
  await post("发布 " + name, path + "/" + draft.id + "/publish", { configHash: current.currentVersion.configHash });
  const published = await client.request(path + "/" + draft.id);
  assert.equal(published.status, "PUBLISHED");
  assert.equal(published.publishedVersion.id, current.currentVersion.id);
  return published;
}

async function checkConsumption(service, paths, targetRows, deniedPath) {
  const name = "本机复刻-" + randomUUID();
  const app = { name, serviceId: service.id };
  applications.push(app);
  const issued = await post("签发仅限 " + service.slug + " 的本机应用", "/data-services/applications", {
    name, serviceIds: [service.id], ttlSeconds: 300,
  });
  app.id = issued.application.id;
  assert.equal(issued.tokenShownOnce, true);
  assert.match(issued.token, /^sz_local_[A-Za-z0-9_-]+$/);
  assert.deepEqual(issued.application.serviceIds, [service.id]);
  assert.ok(Date.parse(issued.application.expiresAt) > Date.now());
  const options = { authorization: "Bearer " + issued.token };
  await assert.rejects(client.request(paths[0]), { status: 401 });
  for (const [index, path] of paths.entries()) {
    step = "独立接口查询 " + service.slug;
    const reply = await client.request(path, options);
    assert.equal(reply.service.versionId, service.publishedVersion.id);
    assert.deepEqual(reply.data, targetRows[index]);
    calls[service.serviceType.toLowerCase()].push(reply.callId);
  }
  await assert.rejects(client.request(deniedPath, options), { status: 403 });
  const revoke = await post("撤销 " + service.slug, "/data-services/applications/" + app.id + "/revoke", {});
  app.revoked = revoke.id === app.id && revoke.status === "REVOKED";
  assert.equal(app.revoked, true);
  await assert.rejects(client.request(paths[0], options), { status: 401 });
}

async function main() {
  assert.ok(!extra.length && confirmation === "--confirm-local-test" && /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(origin ?? ""));
  assert.ok(Number(new URL(origin).port) <= 65535);
  const checkpoint = lstatSync(input);
  assert.ok(checkpoint.isFile() && (checkpoint.mode & 0o077) === 0 && checkpoint.size < 10000);
  const reference = JSON.parse(readFileSync(input, "utf8"));
  assert.ok(reference.origin === origin && Object.keys(reference.ids).length === 4);
  assert.ok(["revision", "run", "package", "verification"].every(name => identifier.test(reference.ids[name])));

  client = new V2Client({ baseUrl: origin + "/api/v2", timeoutMs: 10_000 });
  const status = await client.request("/status");
  assert.equal(status.mode, "LOCAL_DEVELOPMENT");
  assert.equal(status.model.configured, false);
  assert.equal(status.spark.isolation, "LOCAL_PROCESS");
  assert.equal(status.spark.available, true);
  assert.equal(status.agentDevelopment.durableEnabled, false);
  assert.equal(status.agentDevelopment.publishAvailable, true);
  const [bundle, verification, development, revision] = await Promise.all([
    client.request("/delivery/packages/" + reference.ids.package),
    client.request("/delivery/verifications/" + reference.ids.verification),
    client.request("/runs/" + reference.ids.run),
    client.request("/revisions/" + reference.ids.revision),
  ]);
  const plan = validateDeliveryPackage(bundle, reference.digest);
  assert.equal(revision.source, "MANUAL");
  assert.deepEqual([plan.source.revisionId, plan.source.runId, plan.source.contextId], [revision.id, development.id, "holdings-t1"]);
  assert.equal(plan.source.sqlHash, digest(revision.sql));
  assert.equal(verification.packageId, bundle.id);
  assert.equal(verification.packageDigest, reference.digest);
  verifySpark(development, false);
  verifySpark(verification, true);
  for (const path of ["/agent/tasks", "/release/approvals", "/releases", "/release/runs", "/data-services/applications"])
    assert.deepEqual(await client.request(path), []);

  Object.assign(ids, reference.ids);
  run = { scope: "LOCAL_FICTIONAL_ENGINEER_AUTHORED", syntheticReview: true, packageDigest: bundle.digest, ids, requests, applications, batches, calls };
  save(run, true);
  checkpointCreated = true;
  const base = "/delivery/packages/" + bundle.id;
  const review = await post("合成测试审阅", base + "/review", {
    packageDigest: bundle.digest, verificationId: verification.id,
    reviewNote: "本机洁净检出的合成测试审阅，仅批准虚构样例测试。",
    attestations: { code: true, assertions: true, deliveryFiles: true, localScope: true },
  });
  const approval = await post("合成测试批准", base + "/approve", { packageDigest: bundle.digest, reviewId: review.id });
  const release = await post("发起两个本机调度测试批次", "/releases", {
    approvalId: approval.id, triggerAfterSeconds: 1, intervalSeconds: 2, runCount: 2,
  });
  Object.assign(ids, { review: review.id, approval: approval.id, release: release.id });

  step = "读取原调度批次和监控";
  let observed;
  for (let attempt = 0; attempt < 95; attempt++) {
    observed = await client.request("/monitoring/overview");
    if (observed.counts.failed || observed.counts.unknown || observed.counts.openAlerts) throw Error("LOCAL_BATCH_NEEDS_REVIEW");
    if (observed.counts.succeeded === 2 && observed.recentEvents.filter(event =>
      event.releaseId === release.id && event.type === "BATCH_SUCCEEDED").length === 2) break;
    await delay(1500);
  }
  const timedRuns = observed.recentRuns.filter(item => item.releaseId === release.id).sort((a, b) => a.sequence - b.sequence);
  assert.equal(timedRuns.length, 2);
  assert.equal(observed.activeRelease.health, "HEALTHY");
  for (const batch of timedRuns) {
    verifySpark(batch, true);
    assert.equal(batch.schedulerTriggered, true);
    assert.equal(batch.clockMode, "WALL_CLOCK_TIMER");
    assert.equal(batch.packageDigest, bundle.digest);
    const events = observed.recentEvents.filter(event => event.releaseRunId === batch.id && event.type === "BATCH_SUCCEEDED");
    assert.ok(events.length === 1 && events[0].packageDigest === bundle.digest && Date.parse(events[0].observedAt) >= Date.parse(batch.finishedAt));
    batches.push({ id: batch.id, sequence: batch.sequence, event: events[0].id });
  }
  const batchId = batches[0].id;
  const fields = [["client_id", "holding_market_value", "security_count"], ["client_id", "available_cash", "total_assets"]];
  const holdings = await publishService("dapi", "持仓", { name: "复刻持仓", slug: "reference-holdings", sourceReleaseRunId: batchId, fields: fields[0] });
  const cash = await publishService("dapi", "现金", { name: "复刻现金", slug: "reference-cash", sourceReleaseRunId: batchId, fields: fields[1] });
  const assets = await publishService("xapi", "客户资产组合", { name: "复刻客户资产", slug: "reference-assets", steps: [
    { alias: "positions", dapiId: holdings.id }, { alias: "cash", dapiId: cash.id },
  ] });
  assert.deepEqual(assets.publishedVersion.steps.map(item => item.dapiVersionId), [holdings.publishedVersion.id, cash.publishedVersion.id]);
  const project = (row, names) => Object.fromEntries(names.map(name => [name, row[name]]));
  const pages = path => [1, 2].map(page => path + "?page=" + page + "&pageSize=1");
  const assetPath = "/open/xapis/reference-assets";
  await checkConsumption(holdings, pages("/open/dapis/reference-holdings"), expected.map(row => [project(row, fields[0])]), assetPath);
  await checkConsumption(cash, pages("/open/dapis/reference-cash"), expected.map(row => [project(row, fields[1])]), assetPath);
  const combined = expected.map(({ client_id, holding_market_value, security_count, available_cash, total_assets }) =>
    ({ client_id, positions: { holding_market_value, security_count }, cash: { available_cash, total_assets } }));
  await checkConsumption(assets, [assetPath, ...pages(assetPath)], [combined, [combined[0]], [combined[1]]], "/open/dapis/reference-cash");
  const report = await post("从同批次生成报表", "/reports/published", {
    name: "复刻虚构客户资产报表", source: { kind: "MANUAL", releaseId: release.id, batchId, packageDigest: bundle.digest,
      revisionId: revision.id, runId: development.id },
  });
  assert.equal(report.status, "SUCCEEDED");
  Object.assign(ids, { report: report.reportId, reportRun: report.reportRunId });
  assert.deepEqual(await client.request("/agent/tasks"), []);
  result = { status: "PASSED", scope: run.scope, packageDigest: bundle.digest, ids, batches, calls,
    modelCalls: 0, syntheticReview: true, newSparkRuns: 2, publicDeployed: false };
}

try {
  await main();
} catch (error) {
  result = { status: "FAILED", step, httpStatus: Number.isInteger(error?.status) ? error.status : undefined,
    errorCode: /^[A-Z][A-Z0-9_]{0,79}$/.test(error?.code ?? "") ? error.code : undefined, checkpoint: output };
  process.exitCode = 1;
} finally {
  if (checkpointCreated) {
    for (const app of applications.filter(item => !item.revoked)) {
      try {
        if (!app.id) {
          const found = (await client.request("/data-services/applications")).filter(item =>
            item.name === app.name && item.serviceIds?.length === 1 && item.serviceIds[0] === app.serviceId);
          if (found.length === 1) app.id = found[0].id;
        }
        if (app.id) {
          const record = await post("回收原本机测试应用", "/data-services/applications/" + app.id + "/revoke", {});
          app.revoked = record.status === "REVOKED";
        }
      } catch { app.cleanupUnconfirmed = true; }
    }
    save({ ...run, result });
  }
  console.log(JSON.stringify(result));
}
