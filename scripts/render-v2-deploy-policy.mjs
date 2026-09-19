import { fileURLToPath } from "node:url";

const accountPattern = /^\d{12,20}$/;
const regionPattern = /^[a-z][a-z0-9-]{2,31}$/;
const roleArnPattern = /^acs:ram::(\d{12,20}):role\/([a-z0-9-]{1,64})$/;
const resourceIdPattern = /^[a-z][a-z0-9-]{5,127}$/;

export function renderV2DeployPolicy(input = {}) {
  const accountId = input.ALIYUN_ACCOUNT_ID?.trim();
  const regionId = input.ALIBABA_CLOUD_REGION_ID?.trim();
  const roleArn = input.V2_FUNCTION_ROLE_ARN?.trim();
  const vSwitchId = input.V2_VSW_ID?.trim();
  const securityGroupId = input.V2_SECURITY_GROUP_ID?.trim();
  const roleMatch = roleArnPattern.exec(roleArn ?? "");
  const errors = [];
  if (!accountPattern.test(accountId ?? "")) errors.push("INVALID:ALIYUN_ACCOUNT_ID");
  if (!regionPattern.test(regionId ?? "")) errors.push("INVALID:ALIBABA_CLOUD_REGION_ID");
  if (!roleMatch) errors.push("INVALID:V2_FUNCTION_ROLE_ARN");
  if (roleMatch && accountId && roleMatch[1] !== accountId) errors.push("ACCOUNT_MISMATCH:V2_FUNCTION_ROLE_ARN");
  if (!resourceIdPattern.test(vSwitchId ?? "") || !vSwitchId.startsWith("vsw-")) errors.push("INVALID:V2_VSW_ID");
  if (!resourceIdPattern.test(securityGroupId ?? "") || !securityGroupId.startsWith("sg-")) errors.push("INVALID:V2_SECURITY_GROUP_ID");
  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    policy: {
      Version: "1",
      Statement: [
        {
          Effect: "Allow",
          Action: ["ram:GetRole", "ram:ListPoliciesForRole"],
          Resource: roleArn,
        },
        {
          Effect: "Allow",
          Action: "ram:PassRole",
          Resource: roleArn,
          Condition: { StringEquals: { "acs:Service": "fc.aliyuncs.com" } },
        },
        {
          Effect: "Allow",
          Action: "vpc:DescribeVSwitches",
          Resource: `acs:vpc:${regionId}:${accountId}:vswitch/${vSwitchId}`,
        },
        {
          Effect: "Allow",
          Action: "ecs:DescribeSecurityGroups",
          Resource: `acs:ecs:${regionId}:${accountId}:securitygroup/${securityGroupId}`,
        },
        {
          Effect: "Allow",
          Action: [
            "fc:CreateFunction",
            "fc:GetFunction",
            "fc:UpdateFunction",
            "fc:PutConcurrencyConfig",
            "fc:GetConcurrencyConfig",
            "fc:PutScalingConfig",
            "fc:GetScalingConfig",
          ],
          Resource: "*",
        },
      ],
    },
  };
}

function run() {
  const result = renderV2DeployPolicy(process.env);
  if (!result.ok) {
    process.stderr.write(JSON.stringify(result) + "\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write(JSON.stringify(result.policy, null, 2) + "\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) run();
