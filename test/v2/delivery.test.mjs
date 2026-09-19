import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  renameSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  createDeliveryPackage,
  validateDeliveryPackage,
  computeManifestDigest,
  resolveDeliverySchedule,
  validateDag,
  unpackDeliveryPackage,
  loadDeliveryDirectory,
  sha256,
} from "../../src/v2/delivery.mjs";
import { verifyDeliveryDirectory } from "../../src/v2/delivery-runner.mjs";
import {
  contextIds,
  getContext,
  referenceSql,
  validationContractId,
} from "../../src/v2/context.mjs";
import { createV2Server, PROJECT } from "../../src/v2/server.mjs";
import { MetadataStore } from "../../src/v2/store.mjs";

function source() {
  const revision = {
    id: "revision-test",
    projectId: PROJECT,
    sql: referenceSql,
    hash: sha256(referenceSql),
    contextId: "holdings-t1",
  };
  const run = {
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
      regressions: contextIds.map((contextId) => ({ contextId, passed: true })),
    },
  };
  return { run, revision };
}
const build = () => createDeliveryPackage(source());
function edited(bundle, file, value) {
  const changed = structuredClone(bundle);
  changed.files[file] =
    typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n";
  changed.manifest.files[file] = {
    sha256: sha256(changed.files[file]),
    bytes: Buffer.byteLength(changed.files[file]),
  };
  changed.digest = computeManifestDigest(changed.manifest);
  return changed;
}
function folder(bundle) {
  const parent = mkdtempSync(join(tmpdir(), "shuduo-package-test-"));
  const directory = join(parent, "delivery");
  unpackDeliveryPackage(bundle, directory, bundle.digest);
  return directory;
}
test("delivery package binds verified SQL and contains executable test and configuration files", () => {
  const bundle = build(),
    plan = validateDeliveryPackage(bundle, bundle.digest);
  assert.equal(Object.keys(bundle.files).length, 8);
  assert.equal(bundle.manifest.releaseState, "NOT_PUBLISHED");
  assert.equal(plan.deployment.adapter, "local-spark-v1");
  assert.deepEqual(
    plan.order.map((n) => n.kind),
    ["spark_sql", "sql_assertions", "record_evidence"],
  );
  assert.match(bundle.files["tests.sql"], /FROM __shuduo_result/);
  assert.ok(!JSON.stringify(bundle).includes("DASHSCOPE_API_KEY"));
});
test("cloud delivery binds the verified Spark 3.5.9 Worker instead of historical 3.5.7", () => {
  const value = source();
  value.run.engineVersion = "3.5.9";
  value.run.isolation = "FUNCTION_PROCESS";
  const bundle = createDeliveryPackage(value),
    plan = validateDeliveryPackage(bundle, bundle.digest);
  assert.equal(plan.deployment.adapter, "remote-spark-worker-v1");
  assert.equal(plan.deployment.environment, "cloud-isolated-rehearsal");
  assert.equal(plan.deployment.runtime.version, "3.5.9");
  assert.equal(plan.deployment.runtime.driverMemoryMiB, 2048);
  assert.match(bundle.files["README.md"], /Spark 3\.5\.9/);

  value.run.engineVersion = "3.5.7";
  assert.throws(() => createDeliveryPackage(value), { status: 409 });
});
test("failed, stale, incomplete or mismatched source evidence cannot create packages", () => {
  for (const modify of [
    (s) => (s.run.status = "FAILED"),
    (s) => (s.run.validation.contractId = "old"),
    (s) => s.run.validation.regressions.pop(),
    (s) => (s.revision.sql += "\n--changed"),
    (s) => (s.run.projectId = "other"),
    (s) => (s.run.engine = "simulated"),
  ]) {
    const value = source();
    modify(value);
    assert.throws(() => createDeliveryPackage(value), { status: 409 });
  }
});
test("tampering and recomputing internal hashes cannot bypass a separately trusted digest", () => {
  const bundle = build(),
    changed = edited(
      bundle,
      "main.sql",
      bundle.files["main.sql"] + "\n-- changed",
    );
  assert.throws(() => validateDeliveryPackage(changed, bundle.digest), /摘要/);
  const broken = structuredClone(bundle);
  broken.files["tests.sql"] = "SELECT true";
  assert.throws(() => validateDeliveryPackage(broken, bundle.digest), /校验值/);
});
test("DAG is sorted by real dependencies and rejects cycles, missing dependencies and shell nodes", () => {
  const nodes = JSON.parse(build().files["schedule.json"]).nodes;
  assert.deepEqual(
    validateDag([...nodes].reverse()).map((n) => n.id),
    ["execute", "validate", "evidence"],
  );
  for (const mutate of [
    (v) => v[0].dependsOn.push("evidence"),
    (v) => (v[1].dependsOn = ["missing"]),
    (v) => (v[1].dependsOn = []),
    (v) => (v[0].kind = "shell"),
    (v) => (v[0].command = "echo unsafe"),
  ]) {
    const changed = structuredClone(nodes);
    mutate(changed);
    assert.throws(() => validateDag(changed));
  }
});
test("unsupported cloud targets, extra commands and credential references fail closed", () => {
  const bundle = build();
  for (const mutate of [
    (v) => (v.adapter = "dataworks"),
    (v) => (v.command = "curl example"),
    (v) => (v.secretReferences = ["API_KEY"]),
    (v) => (v.runtime.parallelism = 2),
    (v) => (v.published = true),
  ]) {
    const deploy = JSON.parse(bundle.files["deployment.json"]);
    mutate(deploy);
    const changed = edited(bundle, "deployment.json", deploy);
    assert.throws(() => validateDeliveryPackage(changed, changed.digest));
  }
});
test("sample trading calendar resolves T+1 and does not invent missing days", () => {
  const bundle = build(),
    plan = validateDeliveryPackage(bundle, bundle.digest);
  assert.equal(
    resolveDeliverySchedule(plan, "2026-09-11T09:00:00+08:00").businessDate,
    "2026-09-10",
  );
  assert.equal(
    resolveDeliverySchedule(plan, "2026-09-14T09:00:00+08:00").businessDate,
    "2026-09-11",
  );
  assert.equal(
    resolveDeliverySchedule(plan, "2026-09-12T09:00:00+08:00").eligible,
    false,
  );
  for (const date of [
    "2026-09-15T09:00:00+08:00",
    "2026-09-10T09:00:00+08:00",
    "2026-09-31T09:00:00+08:00",
    "2026-09-11T10:00:00+08:00",
    "2026-09-11T01:00:00Z",
  ])
    assert.throws(() => resolveDeliverySchedule(plan, date));
});
test("unpacked files roundtrip through the CLI and existing directories are never overwritten", () => {
  const bundle = build(),
    directory = folder(bundle);
  assert.equal(
    loadDeliveryDirectory(directory, bundle.digest).bundle.files["main.sql"],
    bundle.files["main.sql"],
  );
  assert.throws(() => unpackDeliveryPackage(bundle, directory, bundle.digest), {
    code: "EEXIST",
  });
  const command = spawnSync(
    process.execPath,
    [
      "bin/shuduo-package.mjs",
      "plan",
      directory,
      "--digest",
      bundle.digest,
      "--scheduled-for",
      "2026-09-11T09:00:00+08:00",
    ],
    { encoding: "utf8" },
  );
  assert.equal(command.status, 0, command.stderr);
  assert.equal(JSON.parse(command.stdout).executed, false);
});
test("file mutations and symlinks are rejected by the directory loader", () => {
  const bundle = build(),
    directory = folder(bundle);
  writeFileSync(join(directory, "main.sql"), "SELECT 'changed'");
  assert.throws(
    () => loadDeliveryDirectory(directory, bundle.digest),
    /校验值/,
  );
  const clean = folder(bundle);
  renameSync(join(clean, "main.sql"), join(clean, "backup.sql"));
  symlinkSync(join(clean, "backup.sql"), join(clean, "main.sql"));
  assert.throws(() => loadDeliveryDirectory(clean, bundle.digest), /符号链接/);
});
test("extra package paths are rejected before writing files", () => {
  const bundle = build();
  bundle.files["../outside.txt"] = "do not write";
  const parent = mkdtempSync(join(tmpdir(), "shuduo-no-traversal-")),
    target = join(parent, "new");
  assert.throws(() => unpackDeliveryPackage(bundle, target, bundle.digest));
  assert.equal(existsSync(target), false);
});
const proof = (input) => ({
  status: "SUCCEEDED",
  engine: "Apache Spark",
  engineVersion: "3.5.7",
  mainSqlExecuted: true,
  testSqlValidation: { passed: true, sqlHash: sha256(input.testSql) },
  validation: {
    passed: true,
    regressions: contextIds.map((contextId) => ({ contextId, passed: true })),
  },
  testDouble: true,
});
test("file verifier consumes test SQL and returns explicit unpublished rehearsal evidence", async () => {
  const bundle = build(),
    directory = folder(bundle);
  let input;
  const receipt = await verifyDeliveryDirectory(
    {
      directory,
      expectedDigest: bundle.digest,
      scheduledFor: "2026-09-11T09:00:00+08:00",
    },
    {
      runner: async (value) => {
        input = value;
        return proof(value);
      },
    },
  );
  assert.equal(input.testSql, bundle.files["tests.sql"]);
  assert.equal(input.sql, bundle.files["main.sql"]);
  assert.equal(receipt.status, "SUCCEEDED");
  assert.equal(receipt.published, false);
  assert.equal(receipt.schedulerTriggered, false);
  assert.deepEqual(
    receipt.workflowTrace.map((n) => n.status),
    ["SUCCEEDED", "SUCCEEDED", "SUCCEEDED"],
  );
});
test("missing or failing SQL tests cannot produce a passing file rehearsal", async () => {
  const bundle = build(),
    directory = folder(bundle);
  for (const broken of ["missing", "failed"]) {
    const receipt = await verifyDeliveryDirectory(
      {
        directory,
        expectedDigest: bundle.digest,
        scheduledFor: "2026-09-11T09:00:00+08:00",
      },
      {
        runner: async (input) => ({
          ...proof(input),
          testSqlValidation:
            broken === "missing"
              ? undefined
              : { passed: false, sqlHash: sha256(input.testSql) },
        }),
      },
    );
    assert.equal(receipt.status, "FAILED");
    assert.equal(receipt.workflowTrace[2].status, "BLOCKED");
  }
});
test("non-trading days and mismatched business dates never invoke execution", async () => {
  const bundle = build(),
    directory = folder(bundle);
  let calls = 0;
  for (const scheduledFor of [
    "2026-09-12T09:00:00+08:00",
    "2026-09-14T09:00:00+08:00",
  ]) {
    await assert.rejects(
      verifyDeliveryDirectory(
        { directory, expectedDigest: bundle.digest, scheduledFor },
        {
          runner: async () => {
            calls++;
          },
        },
      ),
      { status: 422 },
    );
  }
  assert.equal(calls, 0);
});
test("package APIs preserve idempotency and run only the selected immutable package", async () => {
  const root = mkdtempSync(join(tmpdir(), "shuduo-delivery-api-")),
    store = new MetadataStore(join(root, "db.sqlite"));
  let calls = 0;
  const app = createV2Server({
    root,
    store,
    env: { V2_LOCAL_DEVELOPMENT: "true" },
    deliveryRunner: async ({ directory, expectedDigest }) => {
      calls++;
      loadDeliveryDirectory(directory, expectedDigest);
      return { status: "SUCCEEDED", mode: "TEST_DOUBLE", published: false };
    },
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + app.server.address().port + "/api/v2";
  const call = async (path, body) => {
    const response = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shuduo-Client": "workbench",
        "Idempotency-Key": "stable",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    const fixture = source(),
      revision = store.create("revision", PROJECT, fixture.revision);
    const run = store.create("run", PROJECT, {
      ...fixture.run,
      revisionId: revision.id,
    });
    const first = await call("/delivery/packages", { sourceRunId: run.id }),
      again = await call("/delivery/packages", { sourceRunId: run.id });
    assert.equal(first.status, 201);
    assert.equal(again.body.id, first.body.id);
    assert.equal(first.body.artifact.driver, "local-immutable-file");
    assert.equal(first.body.artifact.digest, first.body.digest);
    assert.equal(
      existsSync(
        join(
          root,
          ".v2-artifacts",
          "object-store",
          first.body.artifact.key,
        ),
      ),
      true,
    );
    const path = "/delivery/packages/" + first.body.id + "/verify";
    assert.equal(
      (await call(path, { scheduledFor: "2026-09-12T09:00:00+08:00" })).status,
      422,
    );
    const started = await call(path, {
      scheduledFor: "2026-09-11T09:00:00+08:00",
    });
    const repeat = await call(path, {
      scheduledFor: "2026-09-11T09:00:00+08:00",
    });
    assert.equal(started.status, 202);
    assert.equal(started.body.id, repeat.body.id);
    for (let i = 0; i < 30; i++) {
      if (
        (await call("/delivery/verifications/" + started.body.id)).body
          .status === "SUCCEEDED"
      )
        break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(calls, 1);
    assert.equal(
      (await call("/delivery/verifications/" + started.body.id)).body
        .fullLifecycleE2E,
      false,
    );
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    store.close();
  }
});
