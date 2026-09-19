#!/usr/bin/env bash
set -euo pipefail
set +x
umask 077

script_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
aliyun_cli="${V2_ALIYUN_CLI:-$script_root/.runtime/aliyun-cli/aliyun}"
aliyun_profile="${V2_ALIYUN_PROFILE:-ShuduoOAuth}"
rds_region="${V2_RDS_REGION:-cn-hangzhou}"
rds_instance="${V2_RDS_INSTANCE_ID:-}"
account_name="platform_app"
database_name="platform_meta"

cleanup() {
  unset account_password account_password_repeat
}
trap cleanup EXIT

if [[ ! -x "$aliyun_cli" ]]; then
  echo "未找到项目内阿里云CLI，请先完成OAuth CLI安装。" >&2
  exit 1
fi
if [[ ! "$rds_instance" =~ ^rm-[a-z0-9-]{8,80}$ ]]; then
  echo "V2_RDS_INSTANCE_ID格式不合法。" >&2
  exit 1
fi

read -r -s -p "请设置 platform_app 密码（12—32位）：" account_password
printf '\n'
read -r -s -p "请再次输入同一密码：" account_password_repeat
printf '\n'

if [[ "$account_password" != "$account_password_repeat" ]]; then
  echo "两次密码不一致，未调用阿里云。" >&2
  exit 1
fi
if (( ${#account_password} < 12 || ${#account_password} > 32 )); then
  echo "密码必须为12—32位，未调用阿里云。" >&2
  exit 1
fi
if [[ ! "$account_password" =~ ^[A-Za-z0-9!@#%+=_()*^-]+$ ]]; then
  echo "密码只允许大小写字母、数字及 !@#%+=_()*^-，未调用阿里云。" >&2
  exit 1
fi
password_categories=0
[[ "$account_password" =~ [a-z] ]] && ((password_categories += 1))
[[ "$account_password" =~ [A-Z] ]] && ((password_categories += 1))
[[ "$account_password" =~ [0-9] ]] && ((password_categories += 1))
[[ "$account_password" =~ [!@#%+=_\(\)\*\^-] ]] && ((password_categories += 1))
if (( password_categories < 3 )); then
  echo "密码须包含大小写字母、数字、特殊字符中的至少三类，未调用阿里云。" >&2
  exit 1
fi

rds_state="$($aliyun_cli rds DescribeDBInstanceAttribute \
  --profile "$aliyun_profile" \
  --RegionId "$rds_region" \
  --DBInstanceId "$rds_instance" |
  jq -r '.Items.DBInstanceAttribute[0].DBInstanceStatus // .DBInstances.DBInstance[0].DBInstanceStatus // "UNKNOWN"')"
if [[ "$rds_state" == "STOPPED" || "$rds_state" == "Stopped" || "$rds_state" == "stopped" ]]; then
  echo "RDS处于自动暂停状态，正在唤醒现有实例…"
  $aliyun_cli rds StartDBInstance \
    --profile "$aliyun_profile" \
    --RegionId "$rds_region" \
    --DBInstanceId "$rds_instance" >/dev/null
  for attempt in {1..24}; do
    sleep 5
    rds_state="$($aliyun_cli rds DescribeDBInstanceAttribute \
      --profile "$aliyun_profile" \
      --RegionId "$rds_region" \
      --DBInstanceId "$rds_instance" |
      jq -r '.Items.DBInstanceAttribute[0].DBInstanceStatus // .DBInstances.DBInstance[0].DBInstanceStatus // "UNKNOWN"')"
    [[ "$rds_state" == "Running" || "$rds_state" == "RUNNING" || "$rds_state" == "running" ]] && break
  done
fi
if [[ "$rds_state" != "Running" && "$rds_state" != "RUNNING" && "$rds_state" != "running" ]]; then
  echo "RDS未在限定时间内进入Running，未创建账号。" >&2
  exit 1
fi

existing="$($aliyun_cli rds DescribeAccounts \
  --profile "$aliyun_profile" \
  --RegionId "$rds_region" \
  --DBInstanceId "$rds_instance")"
if jq -e --arg name "$account_name" \
  '.Accounts.DBInstanceAccount // [] | any(.AccountName == $name)' \
  <<<"$existing" >/dev/null; then
  echo "platform_app已存在；为避免意外改密，本脚本拒绝覆盖。" >&2
  exit 2
fi

$aliyun_cli rds CreateAccount \
  --profile "$aliyun_profile" \
  --RegionId "$rds_region" \
  --DBInstanceId "$rds_instance" \
  --AccountName "$account_name" \
  --AccountPassword "$account_password" \
  --AccountType Normal \
  --AccountDescription "数舵V2平台元数据最小权限账号" >/dev/null
unset account_password account_password_repeat

$aliyun_cli rds GrantAccountPrivilege \
  --profile "$aliyun_profile" \
  --RegionId "$rds_region" \
  --DBInstanceId "$rds_instance" \
  --AccountName "$account_name" \
  --DBName "$database_name" \
  --AccountPrivilege ReadWrite >/dev/null

$aliyun_cli rds DescribeAccounts \
  --profile "$aliyun_profile" \
  --RegionId "$rds_region" \
  --DBInstanceId "$rds_instance" \
  --AccountName "$account_name" |
  jq --arg database "$database_name" '
    (.Accounts.DBInstanceAccount // [])[0] as $account
    | {
        accountExists:($account != null),
        accountStatus:$account.AccountStatus,
        accountType:$account.AccountType,
        platformMetaReadWrite:(
          ($account.DatabasePrivileges.DatabasePrivilege // [])
          | any(.DBName == $database and .AccountPrivilege == "ReadWrite")
        )
      }
  '
