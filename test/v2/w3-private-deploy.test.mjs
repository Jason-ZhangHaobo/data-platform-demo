import test from "node:test";
import assert from "node:assert/strict";
import { assertMutableStateAcceptance, isMissingTrigger, queueEnvironment, redactCliFailure, verifyPrivateFunctionBaseline } from "../../scripts/deploy-v2-w3-private.mjs";
import { renderV2W3OssTriggerPlan } from "../../scripts/render-v2-w3-oss-trigger-plan.mjs";

test("W3 queue configuration preserves existing credentials and refuses a mismatched shared key", () => {
  const secret="synthetic-shared-key-with-32-characters";
  const env={V2_OSS_BUCKET:"synthetic-private-bucket",V2_SPARK_EXECUTOR_SECRET:secret};
  const existing={V2_SPARK_WORKER_SECRET:secret,JAVA_HOME:"/opt/java17",V2_PYTHON:"/opt/python3.10/bin/python3"};
  const next=queueEnvironment("worker",existing,env,"synthetic");
  assert.equal(next.V2_SPARK_WORKER_SECRET,secret);
  assert.equal(next.JAVA_HOME,existing.JAVA_HOME);
  assert.equal(next.V2_SPARK_QUEUE_CONSUMER_ENABLED,"true");
  assert.throws(()=>queueEnvironment("worker",{...existing,V2_SPARK_WORKER_SECRET:"wrong"},env,"synthetic"),/WORKER_SECRET_MISMATCH/);
  const control=queueEnvironment("control",{V2_MYSQL_PASSWORD:"synthetic-db-password"},env,"synthetic-job");
  assert.equal(control.V2_MYSQL_PASSWORD,"synthetic-db-password");
  assert.equal(control.V2_SPARK_QUEUE_READY_JOB_ID,"synthetic-job");
});

test("W3 private deployment refuses public egress or expanded concurrency", () => {
  const fn={functionName:"dataplatform-v2-staging-spark-worker",role:"synthetic-role",internetAccess:false,instanceConcurrency:1,vpcConfig:{vpcId:"synthetic-vpc"},runtime:"custom.debian10"};
  const capacity={reservedConcurrency:1},scaling={minInstances:0};
  verifyPrivateFunctionBaseline("worker",fn,capacity,scaling,"synthetic-role");
  assert.throws(()=>verifyPrivateFunctionBaseline("worker",{...fn,internetAccess:true},capacity,scaling,"synthetic-role"),/BASELINE/);
  assert.throws(()=>verifyPrivateFunctionBaseline("worker",fn,{reservedConcurrency:2},scaling,"synthetic-role"),/BASELINE/);
  const control={...fn,functionName:"dataplatform-v2-staging-api",internetAccess:true,runtime:"custom.debian12"};
  verifyPrivateFunctionBaseline("control",control,capacity,scaling,"synthetic-role");
  assert.throws(()=>verifyPrivateFunctionBaseline("control",{...control,internetAccess:false},capacity,scaling,"synthetic-role"),/BASELINE/);
});

test("W3 rejects an invalid fixed smoke object identity", () => {
  const result=renderV2W3OssTriggerPlan({V2_W3_SMOKE_JOB_ID:"../unrelated"});
  assert.ok(result.errors.includes("INVALID:V2_W3_SMOKE_JOB_ID"));
});

test("W3 creates a named trigger only after an explicit not-found response",()=>{
  assert.equal(isMissingTrigger("FC_GET_TriggerNotFound"),true);
  assert.equal(isMissingTrigger("FC_GET_AccessDenied"),false);
  assert.equal(isMissingTrigger("FC_GET_UNKNOWN_ALIYUN_ERROR"),false);
  assert.equal(isMissingTrigger("FC_GET_FunctionNotFound"),false);
});

test("W3 failure diagnostics redact literal and encoded credentials and signed URLs",()=>{
  const secret="synthetic+token/with=value";
  const text=`Message: missing oss:GetBucketEventNotification; ${secret}; ${encodeURIComponent(secret)}; https://example.invalid/?token=${encodeURIComponent(secret)}`;
  const safe=redactCliFailure(text,[secret]);
  assert.ok(safe.includes("oss:GetBucketEventNotification"));
  assert.ok(!safe.includes(secret)&&!safe.includes(encodeURIComponent(secret))&&!safe.includes("https://"));
});

test("W3 control switch fails closed for failed or stale mutable-state evidence", () => {
  const now = Date.parse("2026-10-08T08:00:00Z");
  const proof = { verifiedAt: new Date(now).toISOString(), createOnly: { passed: true }, conditionalUpdate: { passed: true } };
  assertMutableStateAcceptance(proof, now);
  assert.throws(() => assertMutableStateAcceptance({ ...proof, conditionalUpdate: { passed: false } }, now), /CONTROL_MUTABLE_STATE_NOT_VERIFIED/);
  assert.throws(() => assertMutableStateAcceptance(proof, now + 7 * 3600000), /CONTROL_MUTABLE_STATE_NOT_VERIFIED/);
  assert.throws(() => assertMutableStateAcceptance({}, now), /CONTROL_MUTABLE_STATE_NOT_VERIFIED/);
});
