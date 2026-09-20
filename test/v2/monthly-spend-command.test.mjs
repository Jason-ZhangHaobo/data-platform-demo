import test from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("monthly spend command paginates QueryBill and prints only conservative spend", () => {
  const root = mkdtempSync(join(tmpdir(), "shuduo-bill-command-")),
    fake = join(root, "aliyun"),
    calls = join(root, "calls"),
    script = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> ${JSON.stringify(calls)}
page=1
while [[ $# -gt 0 ]]; do
  if [[ "$1" == --PageNum ]]; then page="$2"; shift 2; else shift; fi
done
if [[ "$page" == 1 ]]; then
  printf '%s\\n' '{"Success":true,"Data":{"BillingCycle":"2026-09","PageNum":1,"PageSize":2,"TotalCount":3,"Items":{"Item":[{"PretaxAmount":"1.001","Currency":"CNY"},{"PretaxAmount":"2","Currency":"CNY"}]}}}'
else
  printf '%s\\n' '{"Success":true,"Data":{"BillingCycle":"2026-09","PageNum":2,"PageSize":2,"TotalCount":3,"Items":{"Item":[{"PretaxAmount":"-1","Currency":"CNY"}]}}}'
fi
`;
  writeFileSync(fake, script, { mode: 0o700 });
  chmodSync(fake, 0o700);
  const result = spawnSync("bash", ["scripts/query-v2-monthly-spend.sh"], {
    cwd: new URL("../..", import.meta.url),
    env: {
      ...process.env,
      ALIYUN_CLI: fake,
      V2_BILLING_CYCLE: "2026-09",
    },
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "3.01\n");
  assert.equal(result.stderr, "");
  assert.match(
    readFileSync(calls, "utf8"),
    /bssopenapi QueryBill --BillingCycle 2026-09 --PageNum 2 --PageSize 300/,
  );
});

test("monthly spend command reduces cloud errors to a bounded code", () => {
  const root = mkdtempSync(join(tmpdir(), "shuduo-bill-error-")),
    fake = join(root, "aliyun");
  writeFileSync(
    fake,
    "#!/usr/bin/env bash\nprintf '%s\\n' 'ErrorCode: NoPermission' >&2\nprintf '%s\\n' 'private request details' >&2\nexit 1\n",
    { mode: 0o700 },
  );
  const result = spawnSync("bash", ["scripts/query-v2-monthly-spend.sh"], {
    cwd: new URL("../..", import.meta.url),
    env: {
      ...process.env,
      ALIYUN_CLI: fake,
      V2_BILLING_CYCLE: "2026-09",
    },
    encoding: "utf8",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /"code":"NoPermission"/);
  assert.equal(result.stderr.includes("private request details"), false);
});

