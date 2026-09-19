import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

test("platform RDS account helper hides input and grants only platform_meta", () => {
  const root = mkdtempSync(join(tmpdir(), "shuduo-platform-account-")),
    fakeCli = join(root, "aliyun"),
    created = join(root, "created");
  writeFileSync(
    fakeCli,
    `#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  *DescribeDBInstanceAttribute*)
    printf '%s\n' '{"Items":{"DBInstanceAttribute":[{"DBInstanceStatus":"Running"}]}}'
    ;;
  *DescribeAccounts*)
    if [[ -f "$FAKE_CREATED" ]]; then
      printf '%s\n' '{"Accounts":{"DBInstanceAccount":[{"AccountName":"platform_app","AccountStatus":"Available","AccountType":"Normal","DatabasePrivileges":{"DatabasePrivilege":[{"DBName":"platform_meta","AccountPrivilege":"ReadWrite"}]}}]}}'
    else
      printf '%s\n' '{"Accounts":{"DBInstanceAccount":[]}}'
    fi
    ;;
  *CreateAccount*)
    [[ "$*" == *"--AccountName platform_app"* ]]
    [[ "$*" == *"--AccountPassword TestOnly9!Safe"* ]]
    touch "$FAKE_CREATED"
    printf '%s\n' '{"RequestId":"synthetic"}'
    ;;
  *GrantAccountPrivilege*)
    [[ "$*" == *"--DBName platform_meta"* ]]
    [[ "$*" == *"--AccountPrivilege ReadWrite"* ]]
    printf '%s\n' '{"RequestId":"synthetic"}'
    ;;
  *) exit 3 ;;
esac
`,
    { mode: 0o700 },
  );
  chmodSync(fakeCli, 0o700);
  const result = spawnSync("bash", ["scripts/create-platform-rds-account.sh"], {
    cwd: process.cwd(),
    input: "TestOnly9!Safe\nTestOnly9!Safe\n",
    encoding: "utf8",
    env: {
      ...process.env,
      FAKE_CREATED: created,
      V2_ALIYUN_CLI: fakeCli,
      V2_RDS_INSTANCE_ID: "rm-synthetic1234",
    },
  });
  try {
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      accountExists: true,
      accountStatus: "Available",
      accountType: "Normal",
      platformMetaReadWrite: true,
    });
    assert.doesNotMatch(result.stdout + result.stderr, /TestOnly9!Safe/);
    assert.doesNotMatch(
      readFileSync("scripts/create-platform-rds-account.sh", "utf8"),
      /TestOnly9!Safe/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
