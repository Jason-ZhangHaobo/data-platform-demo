import test from "node:test";
import assert from "node:assert/strict";
import {
  MemorySnapshotBackend,
  ReplicatedMetadataStore,
} from "../../src/v2/metadata-replica.mjs";
import { createV2Server, PROJECT } from "../../src/v2/server.mjs";
import { referenceSql } from "../../src/v2/context.mjs";

test("mutation response waits for replicated metadata before returning success", async () => {
  const backend = new MemorySnapshotBackend(),
    store = await ReplicatedMetadataStore.open({ backend, project: PROJECT }),
    app = createV2Server({
      store,
      env: {
        V2_LOCAL_DEVELOPMENT: "true",
        V2_META_DRIVER: "mysql-project-snapshot-cas",
      },
    });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}/api/v2`;
  try {
    const response = await fetch(base + "/revisions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shuzhan-Client": "workbench",
        "Idempotency-Key": "replicated-revision",
      },
      body: JSON.stringify({ sql: referenceSql, contextId: "holdings-t1" }),
    });
    assert.equal(response.status, 201);
    const created = await response.json(),
      restored = await ReplicatedMetadataStore.open({ backend, project: PROJECT });
    assert.equal(restored.get("revision", created.id, PROJECT).hash, created.hash);
    const status = await fetch(base + "/status").then((value) => value.json());
    assert.equal(status.metadata.driver, "mysql-project-snapshot-cas");
    assert.equal(status.metadata.cloudVerified, true);
    await restored.closeReplicated();
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    await store.closeReplicated();
  }
});
