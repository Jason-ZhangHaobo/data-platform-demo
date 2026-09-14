import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MetadataStore } from "../../src/v2/store.mjs";
import { createV2Server } from "../../src/v2/server.mjs";

test("latest lifecycle report API exposes local scope without relabeling it public", async () => {
  const root = mkdtempSync(join(tmpdir(), "shuzhan-lifecycle-api-")),
    reportRoot = join(root, ".v2-artifacts", "full-lifecycle"),
    store = new MetadataStore(join(root, "platform.sqlite"));
  mkdirSync(reportRoot, { recursive: true });
  writeFileSync(
    join(reportRoot, "latest.json"),
    JSON.stringify({
      format: "shuzhan-full-lifecycle-evaluation/v1",
      frozenCaseCount: 20,
      completedCaseCount: 20,
      succeededCaseCount: 20,
      localFullLifecycleRate: 1,
      targetMet: true,
      deploymentScope: "LOCAL_ACTUAL",
      publicDeployed: false,
      outcomes: Array.from({ length: 20 }, (_, index) => ({
        caseId: `case-${index + 1}`,
      })),
    }),
  );
  const app = createV2Server({
    root,
    store,
    env: { V2_LOCAL_DEVELOPMENT: "true" },
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  try {
    const response = await fetch(
      `http://127.0.0.1:${app.server.address().port}/api/v2/evaluations/full-lifecycle/latest`,
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.succeededCaseCount, 20);
    assert.equal(body.deploymentScope, "LOCAL_ACTUAL");
    assert.equal(body.publicDeployed, false);
    assert.equal(body.outcomes.length, 20);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
    store.close();
  }
});
