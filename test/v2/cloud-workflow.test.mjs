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

test("V2 provisioning workflow is create-only and budget/network gated", () => {
  const workflow = readFileSync(
    ".github/workflows/provision-v2-staging.yml",
    "utf8",
  );
  assert.doesNotMatch(workflow, /UpdateFunction|DeleteFunction|DeleteService/);
  assert.match(workflow, /workflow_dispatch/);
  assert.match(workflow, /QueryBillOverview/);
  assert.match(workflow, /spend < 200/);
  assert.match(workflow, /V2_FUNCTION_ROLE_ARN/);
  assert.match(workflow, /function execution role must be different/);
  assert.match(workflow, /FunctionNotFound/);
  assert.match(workflow, /POST \/2023-03-30\/functions/);
  assert.match(workflow, /instanceConcurrency:1/);
  assert.match(workflow, /custom\.debian12/);
  assert.match(workflow, /V2_VPC_ID/);
  assert.match(workflow, /V2_SECURITY_GROUP_ID/);
  assert.match(workflow, /v2-function-verified\.json/);
});
