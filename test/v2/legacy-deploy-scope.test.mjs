import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { matchesGlob, dirname, join, normalize } from "node:path";

test("legacy deployment only auto-triggers for V1 runtime or shared manifests", () => {
  const workflow = readFileSync(".github/workflows/deploy-staging.yml", "utf8");
  const block = workflow.split("    paths:\n")[1].split("\npermissions:")[0];
  const paths = [...block.matchAll(/^      - "([^"]+)"/gm)].map(m => m[1]);
  const triggers = path => paths.some(pattern => matchesGlob(path, pattern));
  for (const path of ["src/server/index.mjs", "src/shared/contracts.mjs", "src/client/app.js", "src/v2/oss-client.mjs", "package.json", "package-lock.json", "s.yaml"])
    assert.equal(triggers(path), true, path);
  for (const path of ["src/v2/server.mjs", "src/v2/durable-agent.mjs", "web/src/App.tsx", "docs/goal-mode-next.md", "test/v2/durable-agent.test.mjs", ".github/workflows/deploy-staging.yml"])
    assert.equal(triggers(path), false, path);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /npm run ci/);
  assert.match(workflow, /branches: \[main\]/);
  // Guard against future cross-directory imports silently escaping the filter.
  const seen = new Set(), queue = ["src/server/index.mjs"];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file); assert.equal(triggers(file), true, `V1 runtime dependency ${file}`);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/(?:from\s*|import\s*\()\s*["'](\.[^"']+)["']/g))
      queue.push(normalize(join(dirname(file), match[1])));
  }
});
