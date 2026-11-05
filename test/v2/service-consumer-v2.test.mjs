import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { validateConsumerPlan } from "../../scripts/verify-service-consumer.mjs";
import { consumerCanonical, consumerDigest, validateConsumerSource, sourceDigest, consumerV2PlanEvidence } from "../../src/v2/consumer-source.mjs";
import { createConsumerFixture, configureConsumerV2Fixture, privateConsumerJson, SYNTHETIC_CONSUMER_TOKEN } from "./fixtures/service-consumer.mjs";

// Real loopback HTTP with separate literal expected rows. Every identity,
// credential and result is synthetic; none is real cloud/model/Spark evidence.
const load = file => JSON.parse(readFileSync(file, "utf8"));
async function fixture(t, behavior = {}, options = {}) { return configureConsumerV2Fixture(await createConsumerFixture(t, behavior), options); }

test("V2 records frozen source and precise target before HTTP, with independent row/version proofs and no raw values", async t => {
  let f;
  const reservations = [];
  f = await fixture(t, { onRequest: () => { reservations.push(load(f.plan.reportFile).requests.at(-1)); } });
  const result = await f.run();
  assert.equal(result.protocol, "SERVICE_CONSUMER_V2"); assert.equal(result.result, "PASSED"); assert.equal(result.requestCount, 14);
  assert.equal(result.externalSystemVerified, false); assert.equal(result.agentIndependentE2E, false);
  const report = load(f.plan.reportFile), metadata = consumerV2PlanEvidence(f.plan);
  for (const [key,value] of Object.entries(metadata)) assert.deepEqual(report[key], value);
  assert.equal(report.sourceDigest, sourceDigest(f.plan.source));
  assert.equal(report.expectedRowsDigest, consumerDigest(consumerCanonical(f.plan.expectedRows)));
  assert.equal(report.planDigest, consumerDigest(consumerCanonical(f.plan)));
  assert.equal(report.origin, f.plan.origin); assert.equal(report.scope, "LOCAL_TEST_ONLY"); assert.equal(report.evidence, "LOCAL_HTTP_FIXTURE");
  assert.equal(report.startedAt, f.plan.startedAt); assert.ok(Number.isFinite(Date.parse(report.finishedAt)));
  assert.equal(reservations.length, 14);
  assert.ok(reservations.every((entry,index) => entry.sequence === index+1 && entry.result === "PENDING" && entry.serviceId && entry.type &&
    entry.versionId && /^[a-f0-9]{64}$/.test(entry.configHash) && /^[a-f0-9]{64}$/.test(entry.queryDigest) && entry.expectedStatus));
  assert.ok(reservations.every(entry => entry.rowsDigest === undefined && entry.versionBindingsVerified === undefined));
  const xapi = report.requests.find(entry => entry.check === "SERVICE_2_FILTER");
  assert.equal(xapi.serviceId, f.plan.xapi.id); assert.equal(xapi.type, "XAPI"); assert.equal(xapi.versionId, f.plan.xapi.versionId);
  assert.equal(xapi.configHash, f.plan.xapi.configHash); assert.equal(xapi.versionBindingsVerified, true); assert.equal(xapi.rowCount, 1);
  const independentlyExpected = [{ client_id: "DEMO-102", holdings: { holding_market_value: "230.00", total_assets: "270.00", security_count: 1 }, cash: { available_cash: "40.00" } }];
  assert.equal(xapi.rowsDigest, consumerDigest(consumerCanonical(independentlyExpected)));
  assert.notEqual(xapi.responseDigest, xapi.rowsDigest, "pagination-inclusive digest is distinct from row digest");
  assert.equal(xapi.queryDigest, consumerDigest(consumerCanonical({ page:1,page_size:1,client_id:"DEMO-102" })));
  assert.equal(xapi.childBindingsDigest, consumerDigest(consumerCanonical(f.plan.dapis.map(child => ({ alias:child.alias,dapiId:child.id,dapiVersionId:child.versionId })))));
  assert.ok(report.requests.filter(entry => entry.statusCode === 200).every(entry => entry.versionBindingsVerified === true && /^[a-f0-9]{64}$/.test(entry.callIdDigest)));
  assert.ok(report.requests.filter(entry => entry.statusCode !== 200).every(entry => entry.versionBindingsVerified === undefined && entry.rowsDigest === undefined));
  const bytes = readFileSync(f.plan.reportFile,"utf8");
  for (const forbidden of [SYNTHETIC_CONSUMER_TOKEN,"Authorization","expectedRows\"","DEMO-101","DEMO-102","120.00","230.00","fixture-call-"])
    assert.equal(bytes.includes(forbidden),false,forbidden);
  assert.equal(statSync(f.plan.reportFile).mode&0o777,0o600);
  f.state.revoked = true; await f.run({ phase:"revoked" });
  const final = load(f.plan.reportFile); assert.deepEqual(final.phases,{ consume:"PASSED",revoked:"PASSED" });
  assert.deepEqual(final.requests.slice(0,14),report.requests);assert.equal(final.requestCount,15);assert.ok(Number.isFinite(Date.parse(final.finishedAt)));
  assert.equal(final.externalSystemVerified,false);assert.ok(f.state.requests.every(entry=>entry.method==="GET"));
});

test("V2 preserves two granted DAPIs and an explicitly described fourth ungranted service",async t=>{
  const f=await fixture(t,{twoGranted:true});
  assert.equal(validateConsumerPlan(f.plan).plannedRequests,18);
  assert.equal((await f.run()).requestCount,17);
  const report=load(f.plan.reportFile),probe=report.requests.find(entry=>entry.check==="UNGRANTED_SERVICE");
  assert.deepEqual(report.ungrantedService,{id:"service-other",type:"DAPI",versionId:"version-other-1",configHash:consumerDigest("synthetic-config-service-other")});
  assert.equal(probe.serviceId,"service-other");assert.equal(probe.versionId,"version-other-1");assert.equal(probe.statusCode,403);
  assert.equal(probe.versionBindingsVerified,undefined,"403 only validates denial, not the proposed version");
  assert.equal(report.requests.filter(entry=>entry.type==="DAPI"&&entry.statusCode===200&&entry.serviceId==="service-cash").length,3);
  f.state.revoked=true;assert.equal((await f.run({phase:"revoked"})).requestCount,18);
});

test("manual V2 source remains explicitly engineer-assisted and never declares autonomous or external completion",async t=>{
  const f=await fixture(t,{}, {sourceKind:"MANUAL"});await f.run();
  const report=load(f.plan.reportFile);assert.equal(report.source.sourceKind,"MANUAL");assert.equal(report.sourceAttribution,"ENGINEER_ASSISTED");
  assert.equal(report.agentIndependentE2E,false);assert.equal(report.externalSystemVerified,false);assert.equal(report.publicDeployed,false);
});

test("V2 rejects malformed source, scope, extra fields and inconsistent service identities before HTTP or report creation",async t=>{
  const f=await fixture(t),base=structuredClone(f.plan);
  for(const change of [
    p=>{delete p.source;},p=>{p.source.schema="old";},p=>{p.source.sourceKind="UNKNOWN";},p=>{p.source.scope="PRIVATE_CLOUD_TEST";},
    p=>{p.source.sourceReleaseRunId=p.source.developmentRunId;},p=>{p.source.revisionHash="wrong";},p=>{p.source.secret="SYNTHETIC_SECRET";},
    p=>{p.source.agentIndependentE2E=true;},p=>{p.source.taskId="../other";},p=>{p.secret="SYNTHETIC_SECRET";},
    p=>{p.dapis[0].secret="SYNTHETIC_SECRET";},p=>{p.dapis[0].configHash="wrong";},p=>{p.xapi.versionId=p.dapis[0].versionId;},
    p=>{p.xapi.secret="SYNTHETIC_SECRET";},p=>{p.rateLimit.secret="SYNTHETIC_SECRET";},p=>{p.ungranted.secret="SYNTHETIC_SECRET";},
    p=>{p.expectedRows[0].secret="SYNTHETIC_SECRET";},p=>{p.dapis[1].fields=["client_id","available_cash"];p.dapis[0].fields=["client_id","holding_market_value"];},
    p=>{Object.assign(p.ungranted,{id:"not-cash",versionId:"version-cash-1",configHash:p.dapis[1].configHash});},
    p=>{p.startedAt="September 15 2026 (SYNTHETIC_SECRET)";},
  ]) { const plan=structuredClone(base);change(plan);assert.throws(()=>validateConsumerPlan(plan)); }
  f.plan.source.scope="PRIVATE_CLOUD_TEST";f.save();await assert.rejects(f.run(),{code:"CONSUMER_SOURCE_SCOPE_MISMATCH"});
  assert.equal(f.state.requests.length,0);assert.equal(existsSync(f.plan.reportFile),false);
  const fourth=await fixture(t,{twoGranted:true});delete fourth.plan.ungranted.configHash;
  assert.throws(()=>validateConsumerPlan(fourth.plan));assert.equal(fourth.state.requests.length,0);
  assert.deepEqual(validateConsumerSource(base.source),base.source);
});

test("V2 still compares independent values and exact returned versions, never just caller-supplied source labels",async t=>{
  for(const [mutate,code] of [
    [body=>{body.data[0].total_assets="999.00";},"BUSINESS_ROWS_MISMATCH"],
    [body=>{body.service.versionId="version-foreign";},"EXACT_VERSION_MISMATCH"],
    [(body,context)=>{if(context.isXapi)body.service.steps[1].dapiVersionId="version-foreign";},"CHILD_VERSION_MISMATCH"],
    [body=>{body.scope="PRIVATE_CLOUD_TEST";},"EVIDENCE_SCOPE_MISMATCH"],
  ]) {
    const f=await fixture(t,{mutate});await assert.rejects(f.run(),{code});
    const report=load(f.plan.reportFile);assert.equal(report.phases.consume,"FAILED");assert.equal(report.requests.at(-1).result,"FAILED");
    assert.equal(report.requests.at(-1).versionBindingsVerified,undefined);assert.equal(report.requests.at(-1).rowsDigest,undefined);
    assert.equal(report.externalSystemVerified,false);
  }
});

test("V2 unknown HTTP outcome keeps the reservation and cannot retry or append raw error data",async t=>{
  let f,reserved;
  f=await fixture(t,{disconnect:true,onRequest:()=>{reserved=load(f.plan.reportFile).requests[0];}});
  await assert.rejects(f.run(),{code:"TRANSPORT_FAILED"});assert.equal(reserved.result,"PENDING");assert.equal(reserved.serviceId,f.plan.dapis[0].id);
  assert.equal(reserved.expectedStatus,200);assert.ok(/^[a-f0-9]{64}$/.test(reserved.queryDigest));
  await assert.rejects(f.run(),{code:"PHASE_ALREADY_ATTEMPTED"});assert.equal(f.state.requests.length,1);
  const report=load(f.plan.reportFile);assert.equal(report.requestCount,1);assert.equal(report.requests[0].failure,"TRANSPORT_FAILED");
  report.requests[0].query={secret:"SYNTHETIC_RAW_QUERY"};privateConsumerJson(f.plan.reportFile,report);
  await assert.rejects(f.run({phase:"revoked"}),{code:"REPORT_COUNTER_INVALID"});assert.equal(f.state.requests.length,1);
});

test("legacy reports and altered V2 source/config claims are never migrated or accepted for the next phase",async t=>{
  const legacy=await createConsumerFixture(t);await legacy.run();const old=readFileSync(legacy.plan.reportFile,"utf8");configureConsumerV2Fixture(legacy);
  await assert.rejects(legacy.run({phase:"revoked"}),{code:"REPORT_BINDING_INVALID"});assert.equal(readFileSync(legacy.plan.reportFile,"utf8"),old);assert.equal(legacy.state.requests.length,14);
  const f=await fixture(t);await f.run();const before=load(f.plan.reportFile),count=f.state.requests.length;
  for(const change of [r=>{r.protocol="SERVICE_CONSUMER_V1";},r=>{r.source.releaseId="other-release";},r=>{r.sourceDigest="f".repeat(64);},
    r=>{r.expectedRowsDigest="f".repeat(64);},r=>{r.services[0].configHash="f".repeat(64);},r=>{r.origin="https://different.invalid";},
    r=>{r.externalSystemVerified=true;},r=>{r.sourceAttribution="ENGINEER_ASSISTED";},r=>{r.secret="SYNTHETIC_SECRET";}]){
    const report=structuredClone(before);change(report);privateConsumerJson(f.plan.reportFile,report);
    await assert.rejects(f.run({phase:"revoked"}),{code:"REPORT_BINDING_INVALID"});assert.equal(f.state.requests.length,count);
  }
  privateConsumerJson(f.plan.reportFile,before);f.plan.source.releaseId="other-release";f.save();
  await assert.rejects(f.run({phase:"revoked"}),{code:"REPORT_BINDING_INVALID"});assert.equal(f.state.requests.length,count);
});

test("V2 plan-only never reads a token, writes a report or self-declares execution",async t=>{
  const f=await fixture(t),result=await f.run({execute:false,tokenFile:undefined});
  assert.equal(result.protocol,"SERVICE_CONSUMER_V2");assert.equal(result.mode,"PLAN_ONLY");assert.equal(result.evidence,"NOT_EXECUTED");
  assert.equal(result.requests,0);assert.equal(existsSync(f.plan.reportFile),false);assert.equal(f.state.requests.length,0);
  f.plan.authorized=false;f.save();await assert.rejects(f.run(),{code:"EXPLICIT_AUTHORIZATION_REQUIRED"});assert.equal(f.state.requests.length,0);
});
