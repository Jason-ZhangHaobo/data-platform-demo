import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

test("Alibaba Cloud read-only audit emits a sanitized decision record", () => {
  const bin = mkdtempSync(join(tmpdir(), "shuzhan-audit-bin-")),
    home = mkdtempSync(join(tmpdir(), "shuzhan-audit-home-")),
    aliyun = join(bin, "aliyun"),
    ossutil = join(bin, "ossutil");
  writeFileSync(
    aliyun,
    `#!/usr/bin/env bash
case "$*" in
  *GetCallerIdentity*) printf '%s\n' '{"AccountId":"SECRET-ACCOUNT","Arn":"SECRET-ARN"}' ;;
  *DescribeDBInstanceAttribute*) printf '%s\n' '{"Items":{"DBInstanceAttribute":[{"DBInstanceStatus":"Running","PayType":"Serverless","Engine":"MySQL","EngineVersion":"8.0","Category":"Basic","DBInstanceType":"Primary","DBInstanceStorageType":"cloud_essd","DBInstanceStorage":50,"CreateTime":"2026-09-06T00:00:00Z","ExpireTime":"2026-12-06T00:00:00Z","VpcId":"vpc-secret","ServerlessConfig":{"AutoPause":true,"ScaleMin":0.5,"ScaleMax":2}}]}}' ;;
  *DescribeDBInstanceNetInfo*) printf '%s\n' '{"DBInstanceNetInfos":{"DBInstanceNetInfo":[{"IPType":"Intranet","ConnectionString":"SECRET-HOST"}]}}' ;;
  *DescribeDatabases*) printf '%s\n' '{"Databases":{"Database":[{"DBName":"business_demo"},{"DBName":"platform_meta"}]}}' ;;
  *DescribeAccounts*) printf '%s\n' '{"Accounts":{"DBInstanceAccount":[{"AccountName":"sync_writer"},{"AccountName":"platform_app"}]}}' ;;
  *get-function*) [[ "$ALIBABA_CLOUD_SECURITY_TOKEN" == "SECRET-TOKEN" && "$ALIBABACLOUD_SECURITY_TOKEN" == "SECRET-TOKEN" ]] || exit 3; printf '%s\n' '{"functionName":"private-function","runtime":"custom.debian12","cpu":0.25,"memorySize":512,"diskSize":512,"timeout":120,"instanceConcurrency":1,"internetAccess":true,"role":"SECRET-ROLE","vpcConfig":{"vpcId":"vpc-secret"},"environmentVariables":{"OSS_BUCKET":"SECRET-BUCKET","V2_MYSQL_PASSWORD":"DONT-LEAK"}}' ;;
  *QueryBillOverview*) printf '%s\n' '{"Success":true,"Data":{"AccountID":"SECRET-ACCOUNT","AccountName":"SECRET-NAME","Items":{"Item":[{"Currency":"CNY","ProductCode":"rds","PretaxAmount":12.5,"PaymentAmount":10,"OutstandingAmount":2.5,"CashAmount":10}]}}}' ;;
  *) exit 2 ;;
esac
`,
    { mode: 0o700 },
  );
  writeFileSync(
    ossutil,
    `#!/usr/bin/env bash
printf '%s\n' '{"bucketInfo":{"name":"SECRET-BUCKET","location":"oss-cn-hangzhou","storageClass":"Standard","acl":"private","versioning":"Enabled"}}'
`,
    { mode: 0o700 },
  );
  chmodSync(aliyun, 0o700);
  chmodSync(ossutil, 0o700);
  const configRoot = join(home, ".aliyun");
  mkdirSync(configRoot, { recursive: true });
  writeFileSync(
    join(configRoot, "config.json"),
    JSON.stringify({
      profiles: [
        {
          name: "AuditOAuth",
          mode: "OAuth",
          access_key_id: "SECRET-AK",
          access_key_secret: "SECRET-SK",
          sts_token: "SECRET-TOKEN",
        },
      ],
    }),
    { mode: 0o600 },
  );
  const result = spawnSync("bash", ["scripts/aliyun-v2-readonly-audit.sh"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      PATH: `${bin}:${process.env.PATH}`,
      V2_AUDIT_RDS_INSTANCE_ID: "rm-secret",
      V2_AUDIT_FC_FUNCTION_NAME: "private-function",
      V2_AUDIT_EXPECTED_DEDICATED_FUNCTION_NAME: "private-function",
      V2_AUDIT_BILLING_CYCLE: "2026-09",
      V2_AUDIT_OAUTH_PROFILE: "AuditOAuth",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const output = result.stdout.trim(),
    audit = JSON.parse(readFileSync(output, "utf8")),
    encoded = JSON.stringify(audit);
  try {
    assert.equal(statSync(output).mode & 0o777, 0o600);
    assert.equal(audit.crossChecks.sameVpc, true);
    assert.equal(audit.crossChecks.platformDatabaseReady, true);
    assert.equal(audit.crossChecks.singleRequestConcurrency, true);
    assert.equal(audit.crossChecks.withinHardBudget, true);
    assert.equal(audit.bill.pretaxAmount, 12.5);
    assert.equal(audit.oss.acl, "private");
    assert.equal(audit.function.errorCode, null);
    assert.equal(audit.function.dedicatedFunctionTarget, true);
    assert.match(audit.function.targetHash, /^[a-f0-9]{64}$/);
    assert.equal(audit.bill.errorCode, null);
    assert.equal(audit.function.environmentKeyCount, 2);
    assert.equal(audit.function.v2EnvironmentReady, false);
    for (const forbidden of [
      "SECRET-ACCOUNT",
      "SECRET-ARN",
      "SECRET-HOST",
      "SECRET-BUCKET",
      "SECRET-ROLE",
      "SECRET-NAME",
      "DONT-LEAK",
      "SECRET-AK",
      "SECRET-SK",
      "SECRET-TOKEN",
      "vpc-secret",
      "rm-secret",
      "private-function",
    ])
      assert.equal(encoded.includes(forbidden), false, forbidden);
  } finally {
    rmSync(output, { force: true });
    rmSync(bin, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
