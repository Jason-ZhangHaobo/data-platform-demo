import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { syncMysqlSecret } from "../../scripts/sync-v2-control-mysql-secret.mjs";

const name = "dataplatform-v2-synthetic-api";
const password = "Synthetic!new-password42";
const fixture = () => ({ functionName: name, runtime: "custom.debian12", instanceConcurrency: 1, codeChecksum: "synthetic-checksum", codeSize: 42, role: "synthetic-role", vpcConfig: { vpcId: "synthetic-vpc" }, customRuntimeConfig: { command: ["node"], args: ["cloud-server.mjs"] }, cpu: .25, memorySize: 512, environmentVariables: { V2_LOCAL_DEVELOPMENT: "false", V2_PROVISIONING_ONLY: "true", V2_PRIVATE_SMOKE_ENABLED: "true", V2_MYSQL_USER: "platform_app", V2_MYSQL_DATABASE: "platform_meta", V2_MYSQL_PASSWORD: "Synthetic!old-password42", V2_BOOTSTRAP_ADMIN_PASSWORD_HASH: "synthetic-unchanged-hash", DASHSCOPE_API_KEY: "synthetic-unchanged-model-key", CUSTOM_FUTURE_SETTING: "preserve" } });
const publicReadonlyFixture = () => {
  const value = fixture();
  value.instanceConcurrency = 8;
  Object.assign(value.environmentVariables, {
    V2_FC_PUBLIC_HTTP_ENABLED: "true",
    V2_FC_PUBLIC_READ_ONLY: "true",
    V2_PRIVATE_RELEASE_ENABLED: "false",
    V2_AGENT_DRIVER_MODE: "OSS_EVENTS",
  });
  return value;
};

function harness(value = fixture(), mutate) {
  const calls = [];
  let current = structuredClone(value), reads = 0;
  const api = async (method, path, body) => {
    calls.push({ method, path, body: structuredClone(body) });
    if (method === "PUT") current.environmentVariables = structuredClone(body.environmentVariables);
    else if (mutate) mutate(current, ++reads);
    return structuredClone(current);
  };
  return { api, calls, current: () => current };
}

test("private MySQL secret sync changes only the connection password, not account or code", async () => {
  const h = harness();
  const result = await syncMysqlSecret({ name, password, api: h.api });
  assert.equal(result.ok, true);
  assert.equal(result.configurationVerified, true);
  assert.equal(result.databaseConnectionVerified, false);
  assert.equal(result.databasePasswordReset, false);
  const puts = h.calls.filter(x => x.method === "PUT");
  assert.equal(puts.length, 1);
  assert.deepEqual(Object.keys(puts[0].body), ["environmentVariables"]);
  const expected = fixture(); expected.environmentVariables.V2_MYSQL_PASSWORD = password;
  assert.deepEqual(h.current(), expected);
  assert.equal(JSON.stringify(result).includes(password), false);
  assert.ok(h.calls.every(x => x.path === `/2023-03-30/functions/${name}`));
});

test("unchanged password needs no FC update", async () => {
  for (const makeFixture of [fixture, publicReadonlyFixture]) {
    const f = makeFixture(); f.environmentVariables.V2_MYSQL_PASSWORD = password;
    const h = harness(f);
    assert.equal((await syncMysqlSecret({ name, password, api: h.api })).changed, false);
    assert.deepEqual(h.calls.map(x => x.method), ["GET", "GET", "GET"]);
    assert.deepEqual(h.current(), f);
  }
});

test("public read-only MySQL sync preserves concurrency 8 and all non-password settings", async () => {
  const original = publicReadonlyFixture(), h = harness(original);
  const result = await syncMysqlSecret({ name, password, api: h.api });
  const expected = structuredClone(original);
  expected.environmentVariables.V2_MYSQL_PASSWORD = password;
  assert.deepEqual(result, { ok: true, changed: true, configurationVerified: true, databaseConnectionVerified: false, databasePasswordReset: false, containsSecretValues: false });
  assert.deepEqual(h.calls.map(x => x.method), ["GET", "GET", "PUT", "GET"]);
  assert.deepEqual(h.calls[2].body, { environmentVariables: expected.environmentVariables });
  assert.deepEqual(h.current(), expected);
  assert.ok(h.calls.every(x => x.path === `/2023-03-30/functions/${name}`));
  assert.equal(JSON.stringify(result).includes(password), false);
});

test("wrong-account, wrong-function and invalid backend configurations fail closed in both modes", async () => {
  for (const makeFixture of [fixture, publicReadonlyFixture]) {
    for (const mutate of [
      f => f.environmentVariables.V2_PROVISIONING_ONLY = "false",
      f => f.environmentVariables.V2_LOCAL_DEVELOPMENT = "true",
      f => f.environmentVariables.V2_PRIVATE_SMOKE_ENABLED = "false",
      f => f.environmentVariables.V2_MYSQL_USER = "different_user",
      f => f.environmentVariables.V2_MYSQL_DATABASE = "business_demo",
      f => f.functionName = "different-function",
      f => f.runtime = "custom.debian10",
      f => f.instanceConcurrency = 10,
      f => f.environmentVariables.V2_FC_PUBLIC_WRITE_SCOPE = "DEVELOPMENT_ONLY",
      f => f.environmentVariables.V2_FC_PUBLIC_WRITE_SCOPE = "PUBLICATION_ONLY",
      f => f.environmentVariables.V2_FC_PUBLIC_WRITE_SCOPE = "SERVICE_CONSUMPTION_ONLY",
    ]) {
      const f = makeFixture(); mutate(f); const h = harness(f);
      await assert.rejects(syncMysqlSecret({ name, password, api: h.api }), { code: "PRIVATE_CONTROL_BOUNDARY_MISMATCH" });
      assert.deepEqual(h.calls.map(x => x.method), ["GET"]);
    }
  }
});

test("public read-only mode requires explicit backend flags and exact numeric concurrency", async () => {
  for (const mutate of [
    f => delete f.environmentVariables.V2_FC_PUBLIC_HTTP_ENABLED,
    f => f.environmentVariables.V2_FC_PUBLIC_HTTP_ENABLED = "false",
    f => f.environmentVariables.V2_FC_PUBLIC_HTTP_ENABLED = true,
    f => delete f.environmentVariables.V2_FC_PUBLIC_READ_ONLY,
    f => f.environmentVariables.V2_FC_PUBLIC_READ_ONLY = "false",
    f => f.environmentVariables.V2_FC_PUBLIC_READ_ONLY = true,
    f => f.environmentVariables.V2_PRIVATE_RELEASE_ENABLED = "true",
    f => f.instanceConcurrency = 1,
    f => f.instanceConcurrency = 2,
    f => f.instanceConcurrency = "8",
  ]) {
    const f = publicReadonlyFixture(); mutate(f); const h = harness(f);
    await assert.rejects(syncMysqlSecret({ name, password, api: h.api }), { code: "PRIVATE_CONTROL_BOUNDARY_MISMATCH" });
    assert.deepEqual(h.calls.map(x => x.method), ["GET"]);
  }
  for (const readonly of [undefined, "false", "true"]) {
    const f = fixture();
    f.environmentVariables.V2_FC_PUBLIC_HTTP_ENABLED = "true";
    f.environmentVariables.V2_FC_PUBLIC_READ_ONLY = readonly;
    const h = harness(f);
    await assert.rejects(syncMysqlSecret({ name, password, api: h.api }), { code: "PRIVATE_CONTROL_BOUNDARY_MISMATCH" });
    assert.deepEqual(h.calls.map(x => x.method), ["GET"]);
  }
});

test("pre-update drift blocks writes and post-update drift fails readback", async () => {
  for (const makeFixture of [fixture, publicReadonlyFixture]) {
    for (const at of [2, 3]) {
      for (const mutate of [
        f => f.environmentVariables.CUSTOM_FUTURE_SETTING = "changed",
        f => f.environmentVariables.V2_FC_PUBLIC_READ_ONLY = "false",
        f => f.instanceConcurrency = 4,
        f => f.codeChecksum = "different-checksum",
        f => f.role = "different-role",
      ]) {
        const h = harness(makeFixture(), (current, reads) => { if (reads === at) mutate(current); });
        await assert.rejects(syncMysqlSecret({ name, password, api: h.api }), { code: at === 2 ? "FUNCTION_CHANGED_BEFORE_UPDATE" : "FUNCTION_READBACK_MISMATCH" });
        assert.equal(h.calls.filter(x => x.method === "PUT").length, at === 2 ? 0 : 1);
      }
    }
  }
});

test("invalid sync inputs never invoke cloud API", async () => {
  for (const input of [{ name: "legacy-api", password }, { name, password: "short" }, { name, password: password + "\n" }])
    await assert.rejects(syncMysqlSecret({ ...input, api: () => assert.fail("cloud call prohibited") }), { code: "MYSQL_SYNC_INPUT_INVALID" });
});

test("all control mutation workflows share a lock and secret sync stays main-only and least privilege", () => {
  for (const file of ["provision-v2-staging", "deploy-v2-staging", "sync-v2-control-mysql-secret"])
    assert.match(readFileSync(`.github/workflows/${file}.yml`, "utf8"), /group: v2-staging-control-mutation/);
  const workflow = readFileSync(".github/workflows/sync-v2-control-mysql-secret.yml", "utf8");
  assert.match(workflow, /github.ref == 'refs\/heads\/main'/);
  assert.match(workflow, /name: v2-staging/);
  assert.deepEqual([...workflow.matchAll(/secrets\.([A-Z0-9_]+)/g)].map(x => x[1]), ["V2_MYSQL_PASSWORD"]);
  assert.doesNotMatch(workflow, /CreateFunction|ResetAccountPassword|InvokeFunction|AttachPolicy|V2_BOOTSTRAP_ADMIN/);
});
