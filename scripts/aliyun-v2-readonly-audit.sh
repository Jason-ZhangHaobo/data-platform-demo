#!/usr/bin/env bash
set -euo pipefail

audit_region="${V2_AUDIT_REGION:-cn-hangzhou}"
audit_rds_id="${V2_AUDIT_RDS_INSTANCE_ID:-}"
audit_function="${V2_AUDIT_FC_FUNCTION_NAME:-}"
audit_dedicated_function="${V2_AUDIT_EXPECTED_DEDICATED_FUNCTION_NAME:-}"
audit_bucket="${V2_AUDIT_OSS_BUCKET:-}"
audit_cycle="${V2_AUDIT_BILLING_CYCLE:-$(TZ=Asia/Shanghai date +%Y-%m)}"
audit_profile="${V2_AUDIT_OAUTH_PROFILE:-}"
audit_root="$(mktemp -d)"
result_path="$(mktemp "${TMPDIR:-/tmp}/shuduo-v2-readonly-audit.XXXXXX")"
aliyun_bin="$(command -v aliyun)"

cleanup() {
  rm -rf "$audit_root"
  unset ALIBABA_CLOUD_ACCESS_KEY_ID ALIBABA_CLOUD_ACCESS_KEY_SECRET
  unset ALIBABA_CLOUD_SECURITY_TOKEN ALIBABA_CLOUD_IGNORE_PROFILE
  unset ALIBABACLOUD_ACCESS_KEY_ID ALIBABACLOUD_ACCESS_KEY_SECRET
  unset ALIBABACLOUD_SECURITY_TOKEN
  unset OSS_ACCESS_KEY_ID OSS_ACCESS_KEY_SECRET OSS_SESSION_TOKEN OSS_STS_TOKEN
  unset OSS_AUDIT_BUCKET_COUNT OSS_AUDIT_SELECTED_BY_UNIQUE_INVENTORY
}
trap cleanup EXIT

if [[ -z "$audit_rds_id" || -z "$audit_function" ]]; then
  echo "Set V2_AUDIT_RDS_INSTANCE_ID and V2_AUDIT_FC_FUNCTION_NAME" >&2
  exit 1
fi
if [[ ! "$audit_cycle" =~ ^[0-9]{4}-(0[1-9]|1[0-2])$ ]]; then
  echo "V2_AUDIT_BILLING_CYCLE must use YYYY-MM" >&2
  exit 1
fi
if [[ "$#" -ne 0 ]]; then
  echo "The audit always creates a new protected JSON file under /tmp" >&2
  exit 1
fi
audit_is_dedicated=false
if [[ -n "$audit_dedicated_function" && "$audit_function" == "$audit_dedicated_function" ]]; then
  audit_is_dedicated=true
fi
audit_function_hash="$(printf '%s' "$audit_function" | shasum -a 256 | awk '{print $1}')"

if [[ -n "$audit_profile" ]]; then
  if [[ ! "$audit_profile" =~ ^[A-Za-z0-9_-]{1,64}$ ]]; then
    echo "V2_AUDIT_OAUTH_PROFILE is invalid" >&2
    exit 1
  fi
  oauth_config="${HOME}/.aliyun/config.json"
  if [[ ! -f "$oauth_config" || -L "$oauth_config" ]]; then
    echo "OAuth configuration is missing or unsafe" >&2
    exit 1
  fi
  if [[ "$(uname -s)" == "Darwin" ]]; then
    oauth_mode="$(stat -f '%Lp' "$oauth_config")"
  else
    oauth_mode="$(stat -c '%a' "$oauth_config")"
  fi
  if [[ "$oauth_mode" != "600" ]]; then
    echo "OAuth configuration must use mode 0600" >&2
    exit 1
  fi
  "$aliyun_bin" sts GetCallerIdentity --profile "$audit_profile" >/dev/null
  oauth_profile_json="$(jq -ce --arg name "$audit_profile" '.profiles[] | select(.name == $name and .mode == "OAuth")' "$oauth_config")"
  ALIBABA_CLOUD_ACCESS_KEY_ID="$(jq -er '.access_key_id | select(length > 0)' <<<"$oauth_profile_json")"
  ALIBABA_CLOUD_ACCESS_KEY_SECRET="$(jq -er '.access_key_secret | select(length > 0)' <<<"$oauth_profile_json")"
  ALIBABA_CLOUD_SECURITY_TOKEN="$(jq -er '.sts_token | select(length > 0)' <<<"$oauth_profile_json")"
  export ALIBABA_CLOUD_ACCESS_KEY_ID ALIBABA_CLOUD_ACCESS_KEY_SECRET
  export ALIBABA_CLOUD_SECURITY_TOKEN
  export ALIBABACLOUD_ACCESS_KEY_ID="$ALIBABA_CLOUD_ACCESS_KEY_ID"
  export ALIBABACLOUD_ACCESS_KEY_SECRET="$ALIBABA_CLOUD_ACCESS_KEY_SECRET"
  export ALIBABACLOUD_SECURITY_TOKEN="$ALIBABA_CLOUD_SECURITY_TOKEN"
  export OSS_ACCESS_KEY_ID="$ALIBABA_CLOUD_ACCESS_KEY_ID"
  export OSS_ACCESS_KEY_SECRET="$ALIBABA_CLOUD_ACCESS_KEY_SECRET"
  export OSS_SESSION_TOKEN="$ALIBABA_CLOUD_SECURITY_TOKEN"
  export OSS_STS_TOKEN="$ALIBABA_CLOUD_SECURITY_TOKEN"
  export ALIBABA_CLOUD_IGNORE_PROFILE=TRUE
  unset ALIBABA_CLOUD_PROFILE oauth_profile_json
fi

capture_json() {
  local name="$1"
  shift
  local output="$audit_root/$name.json"
  local error_output="$audit_root/$name.error"
  if "$@" >"$output" 2>"$error_output" &&
    jq -e 'type == "object" and (.Success != false) and ((.error_code // .ErrorCode // .Code // .code // "") as $code | ($code == "" or $code == "Success"))' "$output" >/dev/null 2>&1; then
    return 0
  fi
  local error_code="COMMAND_FAILED"
  for candidate in "$output" "$error_output"; do
    if jq -e . "$candidate" >/dev/null 2>&1; then
      candidate_code="$(jq -r '.error_code // .ErrorCode // .Code // .code // empty' "$candidate")"
      if [[ "$candidate_code" == "Success" ]]; then
        candidate_code=""
      fi
      if [[ "$candidate_code" =~ ^[A-Za-z0-9_.-]{1,80}$ ]]; then
        error_code="$candidate_code"
        break
      fi
    fi
  done
  jq -n --arg operation "$name" --arg errorCode "$error_code" '{auditStatus:"UNAVAILABLE",operation:$operation,errorCode:$errorCode}' >"$output"
}

capture_oss_json() {
  local name="$1"
  shift
  local output="$audit_root/$name.json"
  local raw="$audit_root/$name.raw"
  if "$@" >"$raw" 2>/dev/null; then
    sed '/elapsed$/d' "$raw" >"$output"
    if jq -e 'type == "object"' "$output" >/dev/null 2>&1; then
      return 0
    fi
  fi
  jq -n --arg operation "$name" '{auditStatus:"UNAVAILABLE",operation:$operation,errorCode:"OSS_COMMAND_FAILED"}' >"$output"
}

capture_json identity "$aliyun_bin" sts GetCallerIdentity
capture_json rds_attribute "$aliyun_bin" rds DescribeDBInstanceAttribute \
  --RegionId "$audit_region" --DBInstanceId "$audit_rds_id"
capture_json rds_network "$aliyun_bin" rds DescribeDBInstanceNetInfo \
  --RegionId "$audit_region" --DBInstanceId "$audit_rds_id"
capture_json rds_databases "$aliyun_bin" rds DescribeDatabases \
  --RegionId "$audit_region" --DBInstanceId "$audit_rds_id"
capture_json rds_accounts "$aliyun_bin" rds DescribeAccounts \
  --RegionId "$audit_region" --DBInstanceId "$audit_rds_id"
capture_json fc_function "$aliyun_bin" fc get-function \
  --region "$audit_region" --function-name "$audit_function"
capture_json bill_overview "$aliyun_bin" bssopenapi QueryBillOverview \
  --BillingCycle "$audit_cycle"

if [[ -z "$audit_bucket" ]]; then
  audit_bucket="$(jq -r '.environmentVariables.OSS_BUCKET // empty' "$audit_root/fc_function.json")"
fi
oss_bucket_count=""
oss_selected_by_unique_inventory=false
if [[ -z "$audit_bucket" ]] && command -v ossutil >/dev/null 2>&1; then
  capture_oss_json oss_inventory ossutil api list-buckets \
    --region "$audit_region" --output-format json --quiet
  if [[ "$(jq -r '.auditStatus // empty' "$audit_root/oss_inventory.json")" != "UNAVAILABLE" ]]; then
    oss_bucket_count="$(jq -r '(.Buckets.Bucket // []) as $items | if ($items|type) == "array" then ($items|length) elif ($items|type) == "object" then 1 else 0 end' "$audit_root/oss_inventory.json")"
    if [[ "$oss_bucket_count" == "1" ]]; then
      audit_bucket="$(jq -r '(.Buckets.Bucket // []) as $items | if ($items|type) == "array" then $items[0].Name else $items.Name end' "$audit_root/oss_inventory.json")"
      oss_selected_by_unique_inventory=true
    fi
  fi
fi
if [[ -n "$audit_bucket" ]] && command -v ossutil >/dev/null 2>&1; then
  capture_oss_json oss_bucket ossutil api get-bucket-info \
    --bucket "$audit_bucket" --region "$audit_region" --output-format json --quiet
  capture_oss_json oss_versioning ossutil api get-bucket-versioning \
    --bucket "$audit_bucket" --region "$audit_region" --output-format json --quiet
else
  jq -n '{auditStatus:"UNAVAILABLE",operation:"oss_bucket",errorCode:"COMMAND_NOT_INSTALLED"}' >"$audit_root/oss_bucket.json"
  jq -n '{auditStatus:"UNAVAILABLE",operation:"oss_versioning",errorCode:"COMMAND_NOT_INSTALLED"}' >"$audit_root/oss_versioning.json"
fi

export OSS_AUDIT_BUCKET_COUNT="$oss_bucket_count"
export OSS_AUDIT_SELECTED_BY_UNIQUE_INVENTORY="$oss_selected_by_unique_inventory"

jq -n \
  --arg generatedAt "$(TZ=Asia/Shanghai date -Iseconds)" \
  --arg region "$audit_region" \
  --arg billingCycle "$audit_cycle" \
  --argjson dedicatedTarget "$audit_is_dedicated" \
  --arg targetHash "$audit_function_hash" \
  --slurpfile identity "$audit_root/identity.json" \
  --slurpfile attr "$audit_root/rds_attribute.json" \
  --slurpfile network "$audit_root/rds_network.json" \
  --slurpfile databases "$audit_root/rds_databases.json" \
  --slurpfile accounts "$audit_root/rds_accounts.json" \
  --slurpfile function "$audit_root/fc_function.json" \
  --slurpfile oss "$audit_root/oss_bucket.json" \
  --slurpfile ossVersion "$audit_root/oss_versioning.json" \
  --slurpfile bill "$audit_root/bill_overview.json" '
  def number: (tonumber? // 0);
  def money: ((number * 100) | round / 100);
  def attrItem: (($attr[0].Items.DBInstanceAttribute // $attr[0].DBInstances.DBInstance // [])[0] // {});
  def nets: ($network[0].DBInstanceNetInfos.DBInstanceNetInfo // []);
  def dbs: ($databases[0].Databases.Database // []);
  def accts: ($accounts[0].Accounts.DBInstanceAccount // []);
  def billItems: ($bill[0].Data.Items.Item // []);
  {
    format:"shuduo-aliyun-readonly-audit/v1",
    generatedAt:$generatedAt,
    region:$region,
    billingCycle:$billingCycle,
    identity:{available:($identity[0].auditStatus != "UNAVAILABLE")},
    rds:{
      available:($attr[0].auditStatus != "UNAVAILABLE"),
      errorCode:$attr[0].errorCode,
      status:attrItem.DBInstanceStatus,
      payType:attrItem.PayType,
      engine:attrItem.Engine,
      engineVersion:attrItem.EngineVersion,
      category:attrItem.Category,
      instanceType:attrItem.DBInstanceType,
      storageType:attrItem.DBInstanceStorageType,
      storageGiB:attrItem.DBInstanceStorage,
      createTime:attrItem.CreateTime,
      expireTime:attrItem.ExpireTime,
      serverless:{
        AutoPause:attrItem.ServerlessConfig.AutoPause,
        ScaleMin:attrItem.ServerlessConfig.ScaleMin,
        ScaleMax:attrItem.ServerlessConfig.ScaleMax,
        SwitchForce:attrItem.ServerlessConfig.SwitchForce
      },
      network:{
        endpointCount:(nets|length),
        intranet:(nets|map(select(((.IPType // .ConnectionStringType // "")|ascii_downcase) as $kind | ($kind|contains("intranet")) or ($kind|contains("private"))))|length),
        internet:(nets|map(select(((.IPType // .ConnectionStringType // "")|ascii_downcase) as $kind | ($kind|contains("internet")) or ($kind|contains("public"))))|length)
      },
      databases:{
        queryAvailable:($databases[0].auditStatus != "UNAVAILABLE"),
        errorCode:$databases[0].errorCode,
        count:(dbs|length),
        businessDemoExists:(if ($databases[0].auditStatus == "UNAVAILABLE" or (attrItem.DBInstanceStatus|ascii_downcase) != "running") then null else (dbs|any(.DBName == "business_demo")) end),
        platformMetaExists:(if ($databases[0].auditStatus == "UNAVAILABLE" or (attrItem.DBInstanceStatus|ascii_downcase) != "running") then null else (dbs|any(.DBName == "platform_meta")) end)
      },
      accounts:{
        queryAvailable:($accounts[0].auditStatus != "UNAVAILABLE"),
        errorCode:$accounts[0].errorCode,
        count:(accts|length),
        syncWriterExists:(if ($accounts[0].auditStatus == "UNAVAILABLE" or (attrItem.DBInstanceStatus|ascii_downcase) != "running") then null else (accts|any(.AccountName == "sync_writer")) end),
        platformAppExists:(if ($accounts[0].auditStatus == "UNAVAILABLE" or (attrItem.DBInstanceStatus|ascii_downcase) != "running") then null else (accts|any(.AccountName == "platform_app")) end)
      },
      _vpcId:attrItem.VpcId
    },
    function:{
      available:($function[0].auditStatus != "UNAVAILABLE"),
      errorCode:$function[0].errorCode,
      dedicatedFunctionTarget:$dedicatedTarget,
      targetHash:$targetHash,
      runtime:$function[0].runtime,
      cpu:$function[0].cpu,
      memoryMiB:$function[0].memorySize,
      diskMiB:$function[0].diskSize,
      timeoutSeconds:$function[0].timeout,
      instanceConcurrency:$function[0].instanceConcurrency,
      internetAccess:$function[0].internetAccess,
      roleConfigured:(($function[0].role // "")|length > 0),
      vpcConfigured:(($function[0].vpcConfig.vpcId // "")|length > 0),
      environmentKeyCount:(($function[0].environmentVariables // {})|keys|length),
      v2EnvironmentReady:(["V2_MYSQL_HOST","V2_MYSQL_USER","V2_MYSQL_PASSWORD","V2_MYSQL_DATABASE","OSS_BUCKET"]|all(. as $key | ($function[0].environmentVariables // {})|has($key))),
      _vpcId:$function[0].vpcConfig.vpcId
    },
    oss:{
      available:($oss[0].auditStatus != "UNAVAILABLE"),
      errorCode:$oss[0].errorCode,
      location:($oss[0].bucketInfo.location // $oss[0].BucketInfo.Bucket.Location // $oss[0].Bucket.Location),
      storageClass:($oss[0].bucketInfo.storageClass // $oss[0].BucketInfo.Bucket.StorageClass // $oss[0].Bucket.StorageClass),
      acl:($oss[0].bucketInfo.acl // $oss[0].BucketInfo.Bucket.AccessControlList.Grant // $oss[0].Bucket.AccessControlList.Grant),
      versioning:(if $ossVersion[0].auditStatus == "UNAVAILABLE" then null else ($ossVersion[0].VersioningConfiguration.Status // $ossVersion[0].Status // $ossVersion[0].status // $oss[0].bucketInfo.versioning // $oss[0].BucketInfo.Bucket.Versioning // "UNCONFIGURED") end),
      bucketCount:(if ($ENV.OSS_AUDIT_BUCKET_COUNT // "") == "" then null else ($ENV.OSS_AUDIT_BUCKET_COUNT|tonumber) end),
      selectedByUniqueInventory:($ENV.OSS_AUDIT_SELECTED_BY_UNIQUE_INVENTORY == "true")
    },
    bill:{
      available:($bill[0].auditStatus != "UNAVAILABLE"),
      errorCode:$bill[0].errorCode,
      currency:(billItems[0].Currency // "CNY"),
      pretaxAmount:(billItems|map(.PretaxAmount|number)|add // 0|money),
      paymentAmount:(billItems|map(.PaymentAmount|number)|add // 0|money),
      outstandingAmount:(billItems|map(.OutstandingAmount|number)|add // 0|money),
      cashAmount:(billItems|map(.CashAmount|number)|add // 0|money),
      products:(billItems|map(.ProductCode)|map(select(. != null))|unique|sort)
    }
  }
  | .crossChecks = {
      sameVpc:(.rds._vpcId != null and .rds._vpcId != "" and .rds._vpcId == .function._vpcId),
      rdsReady:((.rds.status // "")|ascii_downcase == "running"),
      mysql8:(.rds.engine == "MySQL" and (.rds.engineVersion|tostring|startswith("8"))),
      platformDatabaseReady:(.rds.databases.platformMetaExists and .rds.accounts.platformAppExists),
      singleRequestConcurrency:(.function.instanceConcurrency == 1),
      withinHardBudget:(.bill.available and .bill.pretaxAmount < 200)
    }
  | del(.rds._vpcId,.function._vpcId)
  ' >"$result_path"

chmod 0600 "$result_path"
echo "$result_path"
