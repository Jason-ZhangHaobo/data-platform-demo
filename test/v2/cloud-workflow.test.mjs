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
  assert.match(workflow, /verify-v2-staging-config\.mjs/);
  assert.match(workflow, /export-v2-staging-secret-bundle\.mjs/);
  assert.match(workflow, /V2_DEPLOY_ROLE_ARN/);
  assert.match(workflow, /V2_AUDIT_EVIDENCE_FILE/);
  assert.match(workflow, /query-v2-monthly-spend\.sh/);
  assert.doesNotMatch(workflow, /QueryBillOverview/);
  assert.match(workflow, /V2_VPC_ID/);
  assert.match(workflow, /V2_SECURITY_GROUP_ID/);
  assert.match(workflow, /data-platform-demo\/v2\/state/);
  assert.match(workflow, /data-platform-demo\/v2\/artifacts/);
  assert.match(workflow, /\.functionName == \$name and \.instanceConcurrency == 1/);
  assert.match(workflow, /current-v2-concurrency\.json/);
  assert.match(workflow, /\.reservedConcurrency == 1/);
  assert.match(workflow, /current-v2-scaling\.json/);
  assert.match(workflow, /\.minInstances == 0 and \.enableOnDemandScaling != false/);
  assert.doesNotMatch(workflow, /V2_PRIVATE_SMOKE_ENABLED/);
  assert.doesNotMatch(workflow, /V2_PROVISIONING_ONLY:\"true\"/);
});

test("V2 provisioning workflow is create-only and budget/network gated", () => {
  const workflow = readFileSync(
    ".github/workflows/provision-v2-staging.yml",
    "utf8",
  );
  assert.doesNotMatch(workflow, /UpdateFunction|DeleteFunction|DeleteService/);
  assert.match(workflow, /workflow_dispatch/);
  assert.match(workflow, /query-v2-monthly-spend\.sh/);
  assert.doesNotMatch(workflow, /QueryBillOverview/);
  assert.match(workflow, /V2_FUNCTION_ROLE_ARN/);
  assert.match(workflow, /verify-v2-staging-config\.mjs/);
  assert.ok(workflow.indexOf("verify-v2-staging-config.mjs") < workflow.indexOf("npm ci"));
  assert.ok(workflow.indexOf("Configure Alibaba Cloud credentials with GitHub OIDC") < workflow.indexOf("npm ci"));
  assert.ok(workflow.indexOf("Stop before build if the current bill or role boundary is unsafe") < workflow.indexOf("npm ci"));
  assert.ok(workflow.indexOf("DescribeVSwitchAttributes") < workflow.indexOf("npm ci"));
  assert.match(workflow, /FunctionNotFound/);
  assert.match(workflow, /extract-aliyun-error-code\.mjs "\$response_file" "\$error_file"/);
  assert.doesNotMatch(workflow, /\.Code \/\/ \.code \/\/ \.ErrorCode/);
  assert.match(workflow, /POST \/2023-03-30\/functions/);
  assert.match(workflow, /instanceConcurrency:1/);
  assert.match(workflow, /custom\.debian12/);
  assert.match(workflow, /V2_VPC_ID/);
  assert.match(workflow, /V2_SECURITY_GROUP_ID/);
  assert.match(workflow, /DescribeVSwitchAttributes/);
  assert.doesNotMatch(workflow, /DescribeVSwitches/);
  assert.match(workflow, /\.Status == "Available"/);
  assert.match(workflow, /v2-function-verified\.json/);
  assert.match(workflow, /rm -rf \/tmp\/shuduo-v2-runtime-check/);
  assert.doesNotMatch(workflow, /rm -f[^\n]*\/tmp\/shuduo-v2-runtime-check/);
  assert.match(workflow, /data-platform-demo\/v2\/state/);
  assert.match(workflow, /data-platform-demo\/v2\/artifacts/);
  assert.match(workflow, /functions\/\$FUNCTION_NAME\/concurrency/);
  assert.match(workflow, /\{reservedConcurrency:1\}/);
  assert.match(workflow, /functions\/\$FUNCTION_NAME\/scaling-config/);
  assert.match(workflow, /minInstances:0/);
  assert.match(workflow, /\.reservedConcurrency == 1/);
  assert.match(workflow, /\.minInstances == 0 and \.enableOnDemandScaling != false/);
  assert.match(workflow, /V2_PROVISIONING_ONLY:\"true\"/);
  assert.match(workflow, /V2_PRIVATE_SMOKE_ENABLED:\"true\"/);
});
