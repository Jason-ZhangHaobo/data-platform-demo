import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readOnlyFunctionAudit,
  sanitizedFunction,
  sanitizedError,
} from "../../scripts/aliyun-v2-fc-readonly.mjs";

test("FC SDK audit uses temporary OAuth STS but emits only sanitized readiness", async () => {
  const root = mkdtempSync(join(tmpdir(), "shuzhan-fc-readonly-")),
    configPath = join(root, "config.json"),
    bait = "SECRET-BUCKET-HOST-ACCOUNT-TOKEN";
  writeFileSync(
    configPath,
    JSON.stringify({
      profiles: [{
        name: "TestOAuth",
        mode: "OAuth",
        access_key_id: "secret-ak",
        access_key_secret: "secret-sk",
        sts_token: "secret-sts",
      }],
    }),
    { mode: 0o600 },
  );
  let called = 0;
  try {
    const result = await readOnlyFunctionAudit({
      profile: "TestOAuth",
      region: "cn-hangzhou",
      functionName: "personal-staging-function",
      configPath,
      refreshCredentials: () => { called++; return "1234567890123456"; },
      sdkClientFactory: ({ accessKeyId, accessKeySecret, securityToken, accountId }) => {
        assert.equal(accessKeyId, "secret-ak");
        assert.equal(accessKeySecret, "secret-sk");
        assert.equal(securityToken, "secret-sts");
        assert.equal(accountId, "1234567890123456");
        return {
          functionName: bait,
          role: bait,
          vpcConfig: { vpcId: bait },
          runtime: "custom.debian12",
          cpu: 0.25,
          memorySize: 512,
          diskSize: 512,
          timeout: 120,
          instanceConcurrency: 1,
          environmentVariables: {
            OSS_BUCKET: bait,
            V2_MYSQL_HOST: bait,
            V2_MYSQL_USER: bait,
            V2_MYSQL_PASSWORD: bait,
            V2_MYSQL_DATABASE: bait,
            COMPANY_INTERNAL_KEY: bait,
          },
        };
      },
    });
    assert.equal(called, 1);
    assert.equal(result.available, true);
    assert.equal(result.v2EnvironmentReady, true);
    assert.equal(result.environmentKeyCount, 6);
    assert.equal(result.roleConfigured, true);
    assert.equal(JSON.stringify(result).includes(bait), false);
    assert.equal(JSON.stringify(result).includes("secret-sts"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("FC audit rejects unsafe credential files and never exposes error text", async () => {
  const root = mkdtempSync(join(tmpdir(), "shuzhan-fc-unsafe-")),
    configPath = join(root, "config.json");
  writeFileSync(configPath, "{}", { mode: 0o644 });
  try {
    await assert.rejects(
      readOnlyFunctionAudit({
        profile: "TestOAuth",
        region: "cn-hangzhou",
        functionName: "personal-staging-function",
        configPath,
        sdkClientFactory: () => { throw new Error("should not call"); },
      }),
      /权限0600/,
    );
    assert.deepEqual(
      sanitizedError({
        code: "AccessDenied",
        message: "SECRET-ADDRESS-BUCKET-ACCOUNT",
      }),
      {
        available: false,
        errorCode: "AccessDenied",
        diagnostic: "UNCLASSIFIED",
      },
    );
    assert.equal(
      sanitizedError({
        code: "AccessDenied",
        message: "missing parameter SecurityToken for SECRET-ACCOUNT",
      }).diagnostic,
      "MISSING_STS_TOKEN",
    );
    assert.equal(sanitizedFunction({ environmentVariables: {} }).v2EnvironmentReady, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
