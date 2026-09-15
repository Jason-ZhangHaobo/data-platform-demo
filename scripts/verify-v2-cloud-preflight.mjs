import { lstatSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const expectedCycle = (date) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
  }).format(new Date(date)).replace("/", "-");

export function hasSensitiveEvidence(value) {
  if (Array.isArray(value)) return value.some(hasSensitiveEvidence);
  if (value && typeof value === "object")
    return Object.entries(value).some(
      ([key, item]) =>
        /access[_-]?key|secret|password|token|account.?id|arn|function.?name|bucket.?name|vpc.?id|vswitch.?id|security.?group.?id|request.?id|connection.?string|email|payload|rows|environmentKeys/i.test(key) ||
        hasSensitiveEvidence(item),
    );
  return (
    typeof value === "string" &&
    /\b\d{12,24}\b|\b(?:rm|vpc|vsw|sg)-[a-z0-9]{12,}\b|oss:\/\/|@|(?:sk-|aliyuncs\.com)/i.test(value)
  );
}

export function evaluateCloudPreflight(report, now = Date.now(), target = {}) {
  let publicHost;
  try {
    const url = new URL(target.publicUrl);
    if (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !isIP(url.hostname) &&
      url.hostname.includes(".") &&
      url.hostname !== "localhost"
    ) publicHost = url.hostname.toLowerCase();
  } catch {
    // Missing or malformed public URL is a closed gate.
  }
  const checks = {
    sanitizedFormat: report?.format === "shuzhan-aliyun-readonly-audit/v1",
    sanitizedEvidence: !hasSensitiveEvidence(report),
    region: report?.region === "cn-hangzhou",
    freshEvidence:
      Number.isFinite(Date.parse(report?.generatedAt)) &&
      Date.parse(report.generatedAt) <= now &&
      now - Date.parse(report.generatedAt) <= 24 * 60 * 60 * 1000,
    currentBillingCycle: report?.billingCycle === expectedCycle(now),
    billAvailable:
      report?.bill?.available === true &&
      Number.isFinite(report.bill.pretaxAmount) &&
      report.bill.pretaxAmount >= 0,
    belowHardBudget:
      Number.isFinite(report?.bill?.pretaxAmount) &&
      report.bill.pretaxAmount < 200,
    mysqlReady:
      report?.rds?.available === true &&
      String(report.rds.status).toLowerCase() === "running" &&
      report.rds.engine === "MySQL" &&
      String(report.rds.engineVersion).startsWith("8") &&
      report.rds.serverless?.AutoPause === true &&
      report.rds.network?.intranet > 0 &&
      report.rds.databases?.platformMetaExists === true &&
      report.rds.accounts?.platformAppExists === true,
    privateOssReady:
      report?.oss?.available === true &&
      report.oss.location === "oss-cn-hangzhou" &&
      report.oss.acl === "private",
    dedicatedFunctionVerified:
      report?.function?.available === true &&
      report.function.dedicatedFunctionTarget === true &&
      report.function.roleConfigured === true &&
      report.function.vpcConfigured === true &&
      report.function.instanceConcurrency === 1,
    functionTargetMatches:
      typeof target.functionName === "string" &&
      /^[A-Za-z][A-Za-z0-9_-]{1,127}$/.test(target.functionName) &&
      report?.function?.targetHash === sha256(target.functionName),
    sameVpc: report?.crossChecks?.sameVpc === true,
    domainFiledAndOwned:
      report?.domain?.icpVerified === true &&
      report.domain.ownershipMatched === true &&
      report.domain.httpsReady === true,
    publicHostMatches:
      Boolean(publicHost) &&
      report?.domain?.hostHash === sha256(publicHost),
  };
  return {
    ready: Object.values(checks).every(Boolean),
    checks,
    failedChecks: Object.entries(checks)
      .filter(([, passed]) => !passed)
      .map(([name]) => name),
    scope: "V2_CLOUD_DEPLOYMENT_PREFLIGHT_ONLY",
    notice:
      "当期脱敏证据与预算通过也不能替代真实云函数数据面冷启动、公网受邀访问和独立Spark验收。",
  };
}

export function readPreflightEvidence(path) {
  const target = resolve(path),
    prefix = resolve(root, "docs", "evidence"),
    suffix = relative(prefix, target),
    stat = lstatSync(target);
  if (
    !suffix ||
    suffix.startsWith("..") ||
    suffix.includes(sep) ||
    !suffix.endsWith(".json") ||
    !stat.isFile() ||
    stat.isSymbolicLink()
  )
    throw new Error("审计证据必须是docs/evidence下的单个非链接JSON文件");
  const source = readFileSync(target, "utf8");
  if (source.length > 40_000) throw new Error("审计证据过大");
  return JSON.parse(source);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const path = process.argv[2];
    if (!path || process.argv.length !== 3)
      throw new Error("用法：node scripts/verify-v2-cloud-preflight.mjs docs/evidence/审计.json");
    const result = evaluateCloudPreflight(readPreflightEvidence(path), Date.now(), {
      functionName: process.env.FUNCTION_NAME,
      publicUrl: process.env.PUBLIC_URL,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ready) process.exitCode = 1;
  } catch {
    process.stdout.write(
      `${JSON.stringify({ ready: false, failedChecks: ["evidenceUnavailable"] })}\n`,
    );
    process.exitCode = 1;
  }
}
