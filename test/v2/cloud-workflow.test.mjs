import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("V2 cloud deployment does not embed cloud IDs or inherit stale function secrets", () => {
  const workflow = readFileSync(
    ".github/workflows/deploy-v2-staging.yml",
    "utf8",
  );
  for (const forbidden of ["$current +", "current_env="])
    assert.equal(workflow.includes(forbidden), false, forbidden);
  for (const pattern of [
    /acs:ram::\d{10,24}:/,
    /["'](?:vpc|vsw|sg)-[a-z0-9]{15,}["']/,
  ])
    assert.doesNotMatch(workflow, pattern);
  assert.match(workflow, /verify-v2-cloud-preflight\.mjs/);
  assert.match(workflow, /V2_DEPLOY_ROLE_ARN/);
  assert.match(workflow, /V2_AUDIT_EVIDENCE_FILE/);
  assert.match(workflow, /QueryBillOverview/);
  assert.match(workflow, /V2_VPC_ID/);
  assert.match(workflow, /V2_SECURITY_GROUP_ID/);
  assert.match(workflow, /\.functionName == \$name and \.instanceConcurrency == 1/);
});
