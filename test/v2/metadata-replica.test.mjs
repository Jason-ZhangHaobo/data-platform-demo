import test from "node:test";
import assert from "node:assert/strict";
import {
  MemorySnapshotBackend,
  ReplicatedMetadataStore,
} from "../../src/v2/metadata-replica.mjs";
import { AuthManager } from "../../src/v2/auth.mjs";
import { PROJECT } from "../../src/v2/server.mjs";

test("replicated metadata survives reopening with documents and idempotency", async () => {
  const backend = new MemorySnapshotBackend(),
    first = await ReplicatedMetadataStore.open({ backend, project: PROJECT });
  const item = first.create("revision", PROJECT, {
      sql: "SELECT 1",
      hash: "hash",
    }),
    deduplicated = first.deduplicate(
      `${PROJECT}:demo-key`,
      "signature",
      () => first.create("demo", PROJECT, { value: 1 }),
    );
  await first.flush();
  assert.equal(first.replicationStatus().remoteRevision, 1);
  const second = await ReplicatedMetadataStore.open({ backend, project: PROJECT });
  assert.equal(second.get("revision", item.id, PROJECT).sql, "SELECT 1");
  assert.equal(
    second.deduplicate(`${PROJECT}:demo-key`, "signature", () => {
      throw new Error("不应重复创建");
    }).id,
    deduplicated.id,
  );
  await second.closeReplicated();
  await first.closeReplicated();
});

test("compare-and-swap conflict rejects overwrite and refreshes the winner", async () => {
  const backend = new MemorySnapshotBackend(),
    first = await ReplicatedMetadataStore.open({ backend, project: PROJECT }),
    stale = await ReplicatedMetadataStore.open({ backend, project: PROJECT });
  const winner = first.create("revision", PROJECT, { value: "winner" });
  await first.flush();
  const loser = stale.create("revision", PROJECT, { value: "loser" });
  await assert.rejects(stale.flush(), {
    status: 409,
    code: "CLOUD_METADATA_CONFLICT",
  });
  const refreshed = await stale.refresh();
  assert.equal(refreshed.recoveredFromConflict, true);
  assert.equal(stale.get("revision", loser.id, PROJECT), undefined);
  assert.equal(stale.get("revision", winner.id, PROJECT).value, "winner");
  await first.closeReplicated();
  await stale.closeReplicated();
});

test("invited users and sessions persist in replicated cloud metadata", async () => {
  const backend = new MemorySnapshotBackend(),
    first = await ReplicatedMetadataStore.open({ backend, project: PROJECT }),
    auth = new AuthManager({ store: first, project: PROJECT, env: {} });
  auth.bootstrapAdmin({
    email: "admin@example.test",
    password: "StrongAdmin#2026",
    displayName: "虚构管理员",
  });
  const login = auth.login({
    email: "admin@example.test",
    password: "StrongAdmin#2026",
  });
  await first.flush();
  const second = await ReplicatedMetadataStore.open({ backend, project: PROJECT }),
    restored = new AuthManager({ store: second, project: PROJECT, env: {} }),
    session = restored.sessionFromHeaders({
      cookie: `shuzhan_session=${login.rawToken}`,
    });
  assert.equal(session.user.email, "admin@example.test");
  assert.equal(session.role, "ADMIN");
  assert.equal(second.replicationStatus().healthy, true);
  await second.closeReplicated();
  await first.closeReplicated();
});
