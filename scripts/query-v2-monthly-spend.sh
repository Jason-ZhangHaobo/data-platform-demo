#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
aliyun_bin="${ALIYUN_CLI:-aliyun}"
bill_root="$(mktemp -d)"
error_file="$(mktemp)"
trap 'rm -rf "$bill_root"; rm -f "$error_file"' EXIT
umask 077

billing_cycle="${V2_BILLING_CYCLE:-$(TZ=Asia/Shanghai date +%Y-%m)}"
[[ "$billing_cycle" =~ ^[0-9]{4}-[0-9]{2}$ ]] || {
  printf '%s\n' '{"ok":false,"code":"INVALID_BILLING_CYCLE"}' >&2
  exit 1
}

page=1
seen=0
total=1
while (( seen < total )); do
  (( page <= 100 )) || {
    printf '%s\n' '{"ok":false,"code":"BILL_PAGE_LIMIT_EXCEEDED"}' >&2
    exit 1
  }
  printf -v page_label '%03d' "$page"
  file="$bill_root/page-$page_label.json"
  : > "$error_file"
  if ! "$aliyun_bin" bssopenapi QueryBill \
    --BillingCycle "$billing_cycle" \
    --PageNum "$page" \
    --PageSize 300 > "$file" 2> "$error_file"; then
    code="$(node "$root_dir/scripts/extract-aliyun-error-code.mjs" "$file" "$error_file")"
    printf '{"ok":false,"code":"%s"}\n' "$code" >&2
    exit 1
  fi
  if ! count="$(jq -er '.Data.Items.Item | if type == "array" then length else error("items") end' "$file")" ||
    ! total="$(jq -er '.Data.TotalCount | tonumber' "$file")"; then
    printf '%s\n' '{"ok":false,"code":"BILL_PAGE_RESPONSE_INVALID"}' >&2
    exit 1
  fi
  seen=$((seen + count))
  page=$((page + 1))
done

bill_files=("$bill_root"/page-*.json)
result="$(
  V2_HARD_MONTHLY_BUDGET_CNY="${V2_HARD_MONTHLY_BUDGET_CNY:-200}" \
    node "$root_dir/scripts/verify-v2-monthly-bill-pages.mjs" "${bill_files[@]}"
)"
jq -e '.ok == true and .belowBudget == true' <<<"$result" >/dev/null
spend="$(jq -er '.spendCny | select(test("^[0-9]{1,16}\\.[0-9]{2}$"))' <<<"$result")"
printf '%s\n' "$spend"
