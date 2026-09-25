import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { renderV2ControlPackagePolicy } from "../../scripts/render-v2-control-package-policy.mjs";

const input = {
  ALIYUN_ACCOUNT_ID: "1234567890123456",
  V2_OSS_BUCKET: "synthetic-private-bucket",
  V2_CONTROL_PACKAGE_SHA256: "b".repeat(64),
  V2_CONTROL_PACKAGE_BYTES: "46860069",
};

test("control package policy allows only one immutable object", () => {
  const result = renderV2ControlPackagePolicy(input);
  assert.equal(result.ok, true);
  assert.deepEqual(result.policy.Statement, [{
    Effect: "Allow",
    Action: ["oss:GetObject", "oss:PutObject"],
    Resource: `acs:oss:*:1234567890123456:synthetic-private-bucket/data-platform-demo/v2/control-plane/${"b".repeat(64)}.zip`,
  }]);
  assert.equal(JSON.stringify(result.policy).includes("oss:DeleteObject"), false);
  assert.equal(JSON.stringify(result.policy).includes("oss:ListObjects"), false);
});

test("control package policy rejects missing identities and oversized objects", () => {
  const result = renderV2ControlPackagePolicy({
    ...input,
    ALIYUN_ACCOUNT_ID: "bad",
    V2_CONTROL_PACKAGE_SHA256: "missing",
    V2_CONTROL_PACKAGE_BYTES: "73400321",
  });
  assert.deepEqual(result.errors, [
    "INVALID:ALIYUN_ACCOUNT_ID",
    "INVALID:V2_CONTROL_PACKAGE_SHA256",
    "INVALID:V2_CONTROL_PACKAGE_BYTES",
  ]);
});

test("control upload workflow binds one successful main build and never overwrites or deletes", () => {
  const workflow = readFileSync(".github/workflows/upload-v2-control-plane.yml", "utf8");
  assert.match(workflow, /\.head_sha == \$sha and \.head_branch == "main" and \.conclusion == "success"/);
  assert.match(workflow, /actions\/download-artifact@v6/);
  assert.match(workflow, /--forbid-overwrite true/);
  assert.match(workflow, /--object-acl private/);
  assert.match(workflow, /query-v2-monthly-spend\.sh/);
  assert.match(workflow, /sha256sum "\$downloaded"/);
  assert.doesNotMatch(workflow, /delete-object|DeleteObject|oss:ListObjects|fc:CreateFunction/i);
});
