#!/usr/bin/env bash
set -euo pipefail

audit_region="${V2_AUDIT_REGION:-cn-hangzhou}"
audit_rds_id="${V2_AUDIT_RDS_INSTANCE_ID:-}"
audit_function="${V2_AUDIT_FC_FUNCTION_NAME:-}"
audit_bucket="${V2_AUDIT_OSS_BUCKET:-}"
audit_cycle="${V2_AUDIT_BILLING_CYCLE:-$(TZ=Asia/Shanghai date +%Y-%m)}"
audit_root="$(mktemp -d)"
result_path="$(mktemp /tmp/shuzhan-v2-readonly-audit.XXXXXX.json)"

cleanup() {
  rm -rf "$audit_root"
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

capture_json() {
  local name="$1"
  shift
  local output="$audit_root/$name.json"
  if "$@" >"$output" 2>/dev/null && jq -e . "$output" >/dev/null 2>&1; then
    return 0
  fi
  jq -n --arg operation "$name" '{auditStatus:"UNAVAILABLE",operation:$operation}' >"$output"
}

capture_json identity aliyun sts GetCallerIdentity
capture_json rds_attribute aliyun rds DescribeDBInstanceAttribute \
  --RegionId "$audit_region" --DBInstanceId "$audit_rds_id"
capture_json rds_network aliyun rds DescribeDBInstanceNetInfo \
  --RegionId "$audit_region" --DBInstanceId "$audit_rds_id"
capture_json rds_databases aliyun rds DescribeDatabases \
  --RegionId "$audit_region" --DBInstanceId "$audit_rds_id"
capture_json rds_accounts aliyun rds DescribeAccounts \
  --RegionId "$audit_region" --DBInstanceId "$audit_rds_id"
capture_json fc_function aliyun fc GetFunction \
  --region "$audit_region" --functionName "$audit_function"
capture_json bill_overview aliyun bssopenapi QueryBillOverview \
  --BillingCycle "$audit_cycle"

if [[ -z "$audit_bucket" ]]; then
  audit_bucket="$(jq -r '.environmentVariables.OSS_BUCKET // empty' "$audit_root/fc_function.json")"
fi
if [[ -n "$audit_bucket" ]] && command -v ossutil >/dev/null 2>&1; then
  capture_json oss_bucket ossutil api get-bucket-info \
    --bucket "$audit_bucket" --region "$audit_region" --output-format json
else
  jq -n '{auditStatus:"UNAVAILABLE",operation:"oss_bucket"}' >"$audit_root/oss_bucket.json"
fi

jq -n \
  --arg generatedAt "$(TZ=Asia/Shanghai date -Iseconds)" \
  --arg region "$audit_region" \
  --arg billingCycle "$audit_cycle" \
  --slurpfile identity "$audit_root/identity.json" \
  --slurpfile attr "$audit_root/rds_attribute.json" \
  --slurpfile network "$audit_root/rds_network.json" \
  --slurpfile databases "$audit_root/rds_databases.json" \
  --slurpfile accounts "$audit_root/rds_accounts.json" \
  --slurpfile function "$audit_root/fc_function.json" \
  --slurpfile oss "$audit_root/oss_bucket.json" \
  --slurpfile bill "$audit_root/bill_overview.json" '
  def number: (tonumber? // 0);
  def attrItem: (($attr[0].Items.DBInstanceAttribute // $attr[0].DBInstances.DBInstance // [])[0] // {});
  def nets: ($network[0].DBInstanceNetInfos.DBInstanceNetInfo // []);
  def dbs: ($databases[0].Databases.Database // []);
  def accts: ($accounts[0].Accounts.DBInstanceAccount // []);
  def billItems: ($bill[0].Data.Items.Item // []);
  {
    format:"shuzhan-aliyun-readonly-audit/v1",
    generatedAt:$generatedAt,
    region:$region,
    billingCycle:$billingCycle,
    identity:{available:($identity[0].auditStatus != "UNAVAILABLE")},
    rds:{
      available:($attr[0].auditStatus != "UNAVAILABLE"),
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
      serverless:attrItem.ServerlessConfig,
      network:{
        endpointCount:(nets|length),
        intranet:(nets|map(select((.IPType // .ConnectionStringType // "")|ascii_downcase|contains("intranet")))|length),
        internet:(nets|map(select((.IPType // .ConnectionStringType // "")|ascii_downcase|contains("internet")))|length)
      },
      databases:{
        count:(dbs|length),
        businessDemoExists:(dbs|any(.DBName == "business_demo")),
        platformMetaExists:(dbs|any(.DBName == "platform_meta"))
      },
      accounts:{
        count:(accts|length),
        syncWriterExists:(accts|any(.AccountName == "sync_writer")),
        platformAppExists:(accts|any(.AccountName == "platform_app"))
      },
      _vpcId:attrItem.VpcId
    },
    function:{
      available:($function[0].auditStatus != "UNAVAILABLE"),
      runtime:$function[0].runtime,
      cpu:$function[0].cpu,
      memoryMiB:$function[0].memorySize,
      diskMiB:$function[0].diskSize,
      timeoutSeconds:$function[0].timeout,
      instanceConcurrency:$function[0].instanceConcurrency,
      internetAccess:$function[0].internetAccess,
      roleConfigured:(($function[0].role // "")|length > 0),
      vpcConfigured:(($function[0].vpcConfig.vpcId // "")|length > 0),
      environmentKeys:(($function[0].environmentVariables // {})|keys|sort),
      _vpcId:$function[0].vpcConfig.vpcId
    },
    oss:{
      available:($oss[0].auditStatus != "UNAVAILABLE"),
      location:($oss[0].bucketInfo.location // $oss[0].BucketInfo.Bucket.Location),
      storageClass:($oss[0].bucketInfo.storageClass // $oss[0].BucketInfo.Bucket.StorageClass),
      acl:($oss[0].bucketInfo.acl // $oss[0].BucketInfo.Bucket.AccessControlList.Grant),
      versioning:($oss[0].bucketInfo.versioning // $oss[0].BucketInfo.Bucket.Versioning)
    },
    bill:{
      available:($bill[0].auditStatus != "UNAVAILABLE"),
      currency:(billItems[0].Currency // "CNY"),
      pretaxAmount:(billItems|map(.PretaxAmount|number)|add // 0),
      paymentAmount:(billItems|map(.PaymentAmount|number)|add // 0),
      outstandingAmount:(billItems|map(.OutstandingAmount|number)|add // 0),
      cashAmount:(billItems|map(.CashAmount|number)|add // 0),
      products:(billItems|map(.ProductCode)|map(select(. != null))|unique|sort)
    }
  }
  | .crossChecks = {
      sameVpc:(.rds._vpcId != null and .rds._vpcId != "" and .rds._vpcId == .function._vpcId),
      rdsReady:(.rds.status == "Running"),
      mysql8:(.rds.engine == "MySQL" and (.rds.engineVersion|tostring|startswith("8"))),
      platformDatabaseReady:(.rds.databases.platformMetaExists and .rds.accounts.platformAppExists),
      singleRequestConcurrency:(.function.instanceConcurrency == 1),
      withinHardBudget:(.bill.available and .bill.pretaxAmount < 200)
    }
  | del(.rds._vpcId,.function._vpcId)
  ' >"$result_path"

chmod 0600 "$result_path"
echo "$result_path"
