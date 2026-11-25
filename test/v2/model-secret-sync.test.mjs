import test from "node:test";
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { functionDigest } from "../../scripts/refresh-v2-spark-readiness.mjs";
import { preservedModelConfigDigest, syncControlModelSecret } from "../../scripts/sync-v2-control-model-secret.mjs";

const name = "dataplatform-v2-synthetic-api";
const oldKey = "sk-TEST-ONLY-old-model-sentinel";
const newKey = "sk-TEST-ONLY-new-model-sentinel";
const otherSecret = "test-only-unrelated-sensitive-value";

function originalFunction() {
  return {
    functionName: name, runtime: "custom.debian12", codeChecksum: "123456", codeSize: 2048,
    role: "synthetic-role", instanceConcurrency: 8, state: "Active", lastUpdateStatus: "Successful",
    vpcConfig: { vpcId: "vpc-synthetic" }, futureConfig: { nested: ["preserve"] },
    environmentVariables: {
      V2_LOCAL_DEVELOPMENT: "false", V2_PROVISIONING_ONLY: "true", V2_PRIVATE_SMOKE_ENABLED: "true",
      V2_FC_PUBLIC_HTTP_ENABLED: "true", V2_FC_PUBLIC_READ_ONLY: "true", V2_PRIVATE_RELEASE_ENABLED: "false",
      V2_MYSQL_USER: "platform_app", V2_MYSQL_DATABASE: "platform_meta", V2_MYSQL_PASSWORD: otherSecret,
      V2_MODEL_BASE_URL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      V2_MODEL: "qwen3.7-plus", DASHSCOPE_API_KEY: oldKey, FUTURE_UNKNOWN_SETTING: "preserve",
    },
  };
}

function harness(before = originalFunction(), {onRead, onPut, onProbe} = {}) {
  const live = structuredClone(before), calls = [], puts = [], probes = [];
  let reads = 0;
  const input = {
    name, modelKey: newKey, baselineDigest: functionDigest(before), preservedDigest: preservedModelConfigDigest(before),
    readDelay: async () => {},
    probe: async ({baseUrl,model,modelKey}) => {
      assert.ok(modelKey === newKey, "only the replacement key may be checked");
      probes.push({baseUrl,model});
      calls.push("PROBE");
      return onProbe ? onProbe(live) : true;
    },
    api: async (method, path, body) => {
      assert.equal(path, "/2023-03-30/functions/" + name);
      calls.push(method);
      if (method === "GET") {
        onRead?.(live, ++reads);
      } else {
        assert.equal(method, "PUT");
        puts.push(structuredClone(body));
        if (onPut) await onPut(live, body);
        else live.environmentVariables = structuredClone(body.environmentVariables);
      }
      return structuredClone(live);
    },
  };
  return { live, calls, puts, probes, run: (mode = "apply", overrides = {}) => syncControlModelSecret({...input, mode, ...overrides}) };
}

function assertSafe(value) {
  const serialized = [String(value), JSON.stringify(value), value?.stack, String(value?.cause ?? "")].join("\n");
  for (const sensitive of [oldKey, newKey, otherSecret]) assert.ok(!serialized.includes(sensitive), "summary contains a sensitive sentinel");
}

async function rejected(operation, expectedCode, expectedPutAttempts = 0) {
  await assert.rejects(operation, err => {
    assertSafe(err);
    assert.ok(err.code === expectedCode, "unexpected failure classification");
    assert.ok(err.putAttempts === expectedPutAttempts, "unexpected write attempt count");
    return true;
  });
}

test("model sync changes one environment value and returns only a safe confirmation", async () => {
  const before = originalFunction(), f = harness(before);
  const result = await f.run();
  assertSafe(result);
  assert.equal(result.status, "CONFIG_VERIFIED");
  assert.equal(result.configurationVerified, true);
  assert.equal(result.putAttempts, 1);
  assert.equal(result.catalogueVerified, true);
  assert.equal(result.modelInferenceVerified, false);
  assert.deepEqual(f.probes,[{baseUrl:before.environmentVariables.V2_MODEL_BASE_URL,model:before.environmentVariables.V2_MODEL}]);
  assert.ok(f.calls.indexOf("GET") < f.calls.indexOf("PROBE") && f.calls.indexOf("PROBE") < f.calls.indexOf("PUT"));
  assert.equal(f.puts.length, 1);
  assert.deepEqual(Object.keys(f.puts[0]), ["environmentVariables"]);
  const expected = structuredClone(before);
  expected.environmentVariables.DASHSCOPE_API_KEY = newKey;
  assert.ok(isDeepStrictEqual(f.live, expected), "a field outside the model credential changed");
  assert.equal(preservedModelConfigDigest(f.live), preservedModelConfigDigest(before));
  assert.notEqual(functionDigest(f.live), functionDigest(before));
  const reconciled = await f.run("verify");
  assert.equal(reconciled.configurationVerified, true);
  assert.equal(reconciled.putAttempts, 0);
  assert.equal(f.puts.length, 1);
});

test("unchanged and verification-only model config operations never write", async () => {
  const same = originalFunction();
  same.environmentVariables.DASHSCOPE_API_KEY = newKey;
  const f = harness(same);
  for (const mode of ["apply", "verify"]) {
    const receipt = await f.run(mode);
    assert.equal(receipt.putAttempts, 0);
    assert.equal(receipt.configurationVerified, true);
  }
  assert.equal(f.puts.length, 0);
  const previous = harness();
  await rejected(previous.run("verify"), "MODEL_SYNC_NOT_MATCHED");
  assert.equal(previous.puts.length, 0);
});

test("verification of the original attempted update waits for a stable configuration before the single catalogue probe", async () => {
  const observed = harness(originalFunction(),{
    onRead(fn,i) {
      fn.lastUpdateStatus = i === 1 ? "InProgress" : "Successful";
      if (i >= 2) fn.environmentVariables.DASHSCOPE_API_KEY = newKey;
    },
    onProbe(fn) { return fn.lastUpdateStatus === "Successful"; },
  });
  const result = await observed.run("verify");
  assert.equal(result.configurationVerified,true);
  assert.equal(observed.calls.indexOf("PROBE"),2);
  assert.equal(observed.probes.length,1);
  assert.equal(observed.puts.length,0);
});

test("model sync refuses a changed target, open window or non-Beijing model endpoint before writing", async () => {
  for (const mutate of [
    fn => {fn.functionName = "dataplatform-v2-another-api";},
    fn => {fn.instanceConcurrency = 1;},
    fn => {fn.environmentVariables.V2_LOCAL_DEVELOPMENT = "true";},
    fn => {fn.environmentVariables.V2_FC_PUBLIC_READ_ONLY = "false";},
    fn => {fn.environmentVariables.V2_FC_PUBLIC_WRITE_SCOPE = "DEVELOPMENT_ONLY";},
    fn => {fn.environmentVariables.V2_PRIVATE_RELEASE_ENABLED = "true";},
    fn => {fn.environmentVariables.V2_MODEL_BASE_URL = "https://other.example.invalid/compatible-mode/v1";},
    fn => {fn.environmentVariables.V2_MODEL_BASE_URL = "https://example.invalid@dashscope.aliyuncs.com/compatible-mode/v1";},
    fn => {fn.environmentVariables.V2_MODEL_BASE_URL = "https://fictional.cn-shanghai.maas.aliyuncs.com/compatible-mode/v1";},
    fn => {fn.environmentVariables.V2_MODEL_BASE_URL = "https://trial.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";},
    fn => {fn.environmentVariables.V2_MODEL_BASE_URL = "https://dashscope.aliyuncs.com:8443/compatible-mode/v1";},
    fn => {fn.environmentVariables.V2_MODEL_BASE_URL += "?route=another";},
  ]) {
    const before = originalFunction(); mutate(before);
    const f = harness(before);
    await rejected(f.run(), "MODEL_SYNC_BOUNDARY_MISMATCH");
    assert.equal(f.puts.length, 0);
    assert.equal(f.probes.length, 0);
  }
});

test("changes since review and between the two pre-write reads refuse the update", async () => {
  for (const changeAt of [1, 2]) for (const mutate of [
    fn => {delete fn.environmentVariables.FUTURE_UNKNOWN_SETTING;},
    fn => {fn.environmentVariables.ADDED_BY_PROVIDER = "preserve";},
    fn => {fn.environmentVariables.FUTURE_UNKNOWN_SETTING = "someone-else-updated";},
    fn => {fn.environmentVariables.DASHSCOPE_API_KEY = "sk-TEST-ONLY-third-model-value";},
    fn => {fn.futureConfig.nested.push("someone-else-updated");},
    fn => {fn.codeChecksum = "different-code";},
  ]) {
    const f = harness(originalFunction(), {onRead(fn, i) {if (i === changeAt) mutate(fn);}});
    await rejected(f.run(), "MODEL_SYNC_CONFIG_DRIFT");
    assert.equal(f.puts.length, 0);
  }
});

test("invalid candidate and unavailable function cannot authorize a write", async () => {
  for (const modelKey of ["", "not-a-model-key", "sk-synthetic\nsecond-line", "sk-******"]) {
    const f = harness();
    await rejected(f.run("apply", {modelKey}), "MODEL_SYNC_INPUT_INVALID");
    assert.equal(f.calls.length, 0);
  }
  for (const mutate of [fn => {fn.state = "Pending";}, fn => {fn.lastUpdateStatus = "Failed";}]) {
    const before = originalFunction(); mutate(before);
    const f = harness(before);
    await rejected(f.run(), "MODEL_SYNC_UNCONFIRMED");
    await rejected(f.run("verify"), "MODEL_SYNC_UNCONFIRMED");
    assert.equal(f.puts.length, 0);
    assert.equal(f.probes.length, 0);
  }
});

test("a Beijing workspace can confirm its original model, while any unconfirmed probe prevents updates", async () => {
  const before = originalFunction();
  before.environmentVariables.V2_MODEL_BASE_URL = "https://ws-synthetic.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";
  const good = harness(before);
  assert.equal((await good.run()).catalogueVerified,true);
  assert.deepEqual(good.probes,[{baseUrl:before.environmentVariables.V2_MODEL_BASE_URL,model:before.environmentVariables.V2_MODEL}]);
  for (const onProbe of [() => false, () => undefined, () => { throw Error("synthetic response " + newKey); }]) {
    const f = harness(before,{onProbe});
    await rejected(f.run(), "MODEL_SYNC_CATALOGUE_UNCONFIRMED");
    assert.equal(f.probes.length,1);
    assert.equal(f.puts.length,0);
  }
  const drift = harness(before,{onProbe(fn) { fn.environmentVariables.FUTURE_UNKNOWN_SETTING="changed-during-catalogue-read"; return true; }});
  await rejected(drift.run(),"MODEL_SYNC_CONFIG_DRIFT");
  assert.equal(drift.puts.length,0);
});

test("lost write acknowledgement is settled by exact readback, including pending FC state", async () => {
  let committed = false, afterWriteReads = 0;
  const f = harness(originalFunction(), {
    onPut(fn, body) {
      fn.environmentVariables = structuredClone(body.environmentVariables);
      committed = true;
      throw Error("synthetic transport failure " + newKey);
    },
    onRead(fn) {
      if (committed) fn.lastUpdateStatus = ++afterWriteReads === 1 ? "InProgress" : "Successful";
    },
  });
  const result = await f.run();
  assertSafe(result);
  assert.equal(result.configurationVerified, true);
  assert.ok(afterWriteReads >= 2);
  assert.equal(f.puts.length, 1);
});

test("a lost PUT with the original state, a third state, or unreadable state never resubmits", async () => {
  for (const scenario of ["old", "changed", "unknown"]) {
    let attempted = false;
    const f = harness(originalFunction(), {
      onPut(fn) {
        attempted = true;
        if (scenario === "changed") fn.environmentVariables.FUTURE_UNKNOWN_SETTING = "concurrent-update";
        throw Error("synthetic write response " + newKey);
      },
      onRead() {if (attempted && scenario === "unknown") throw Error("synthetic read error " + otherSecret);},
    });
    const expected = scenario === "changed" ? "MODEL_SYNC_CONFIG_DRIFT" : "MODEL_SYNC_UNCONFIRMED";
    await rejected(f.run(), expected, 1);
    assert.equal(f.puts.length, 1);
    assert.ok(f.calls.slice(f.calls.indexOf("PUT") + 1).includes("GET"), "original operation was not reconciled");
  }
});
