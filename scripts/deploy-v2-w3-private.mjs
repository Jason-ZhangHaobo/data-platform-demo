import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { queueConfigFromEnvironment, createQueuedSparkJob, verifyQueuedSparkResult, ossSparkQueueTransportFromEnvironment } from "../src/v2/remote-spark-queue.mjs";
import { privateSparkSmokePayload } from "../src/v2/spark-worker-private-smoke.mjs";
import { extractAliyunErrorCode } from "./extract-aliyun-error-code.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const fingerprint = (value) => createHash("sha256").update(String(value)).digest("hex");
const names = { worker: "dataplatform-v2-staging-spark-worker", control: "dataplatform-v2-staging-api" };
const triggerName = "shuduo-v2-spark-queue-put-v1";
const prefixes = { worker: "spark-worker", control: "control-plane" };
const keyFor = (kind, pkg) => `data-platform-demo/v2/${prefixes[kind]}/${pkg.sha256}.zip`;
const safeFailure = (message) => Object.assign(new Error(message), { code: message });
export const isMissingTrigger = (code) => /(?:TriggerNotFound|ResourceNotFound|TriggerNotExist|NotFound\.Trigger)$/.test(code??"");
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
  ? Object.fromEntries(Object.keys(value).sort().map((key)=>[key,canonical(value[key])])) : value;
const same = (a,b) => JSON.stringify(canonical(a))===JSON.stringify(canonical(b));

export function verifyPrivateFunctionBaseline(kind, fn, capacity, scaling, expectedRole) {
  if (fn?.functionName !== names[kind] || fn.role !== expectedRole ||
      fn.internetAccess !== (kind === "control") || Number(fn.instanceConcurrency) !== 1 ||
      Number(capacity?.reservedConcurrency) !== 1 || Number(scaling?.minInstances) !== 0 ||
      scaling?.enableOnDemandScaling === false || !fn.vpcConfig?.vpcId ||
      !["custom.debian10", "custom.debian12"].includes(fn.runtime))
    throw safeFailure("PRIVATE_FUNCTION_BASELINE_MISMATCH");
}

export function queueEnvironment(kind, existing, env, jobId) {
  const secretKey = kind === "worker" ? "V2_SPARK_WORKER_SECRET" : "V2_SPARK_EXECUTOR_SECRET";
  if (existing[secretKey] && fingerprint(existing[secretKey]) !== fingerprint(env.V2_SPARK_EXECUTOR_SECRET))
    throw safeFailure("WORKER_SECRET_MISMATCH");
  return {
    ...existing,
    OSS_BUCKET: env.V2_OSS_BUCKET,
    OSS_REGION: "cn-hangzhou",
    OSS_ENDPOINT: "https://oss-cn-hangzhou-internal.aliyuncs.com",
    V2_PROJECT_ID: "project-securities-lab",
    ...(kind === "worker" ? {
      V2_SPARK_QUEUE_CONSUMER_ENABLED: "true",
      V2_SPARK_QUEUE_TIMEOUT_MS: "120000",
    } : {
      V2_SPARK_EXECUTOR_TRANSPORT: "OSS_QUEUE",
      V2_SPARK_EXECUTOR_SECRET: env.V2_SPARK_EXECUTOR_SECRET,
      V2_SPARK_QUEUE_READY_JOB_ID: jobId,
      V2_SPARK_QUEUE_TIMEOUT_MS: "180000",
    }),
  };
}

async function deploy(env = process.env) {
  if (env.V2_W3_PRIVATE_APPROVED !== "true") throw safeFailure("W3_APPROVAL_MISSING");
  const account = /^acs:ram::(\d+):role\//.exec(env.V2_DEPLOY_ROLE_ARN ?? "")?.[1];
  const jobId = env.V2_W3_SMOKE_JOB_ID;
  if (!account || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(jobId ?? "") ||
      !/^[a-z0-9][a-z0-9-]+$/.test(env.V2_OSS_BUCKET ?? "") ||
      (env.V2_SPARK_EXECUTOR_SECRET?.length ?? 0) < 32)
    throw safeFailure("W3_CONFIGURATION_INVALID");
  const workerRole = `acs:ram::${account}:role/shuduo-v2-spark-queue-runtime-role`;
  const triggerRole = `acs:ram::${account}:role/shuduo-v2-oss-trigger-role`;
  const transfer = JSON.parse(readFileSync("docs/evidence/v2-w3-private-transfer-20260928.json", "utf8"));
  const age = Date.now() - Date.parse(transfer.verifiedAt);
  if (!Number.isFinite(age) || age < -300000 || age > 6 * 3600000 ||
      !Object.values(transfer.packages).every((p) => p.serverCrc64Verified && Object.values(p.privacyChecks).every(Boolean)))
    throw safeFailure("TRANSFER_PROOF_NOT_CURRENT");
  const root = mkdtempSync(join(tmpdir(), "shuduo-private-w3-"));
  let bodyNumber = 0;
  const report = { publicDeployed: false, jobId, startedAt: new Date().toISOString(), stage: "PREFLIGHT" };
  function fc(method, path, body) {
    report.lastOperation = { method, target: path.replace(/dataplatform-v2-staging-spark-worker/g,"worker").replace(/dataplatform-v2-staging-api/g,"control") };
    const args = ["fc", method, `/2023-03-30${path}`, "--region", "cn-hangzhou"];
    if (body !== undefined) {
      const file = join(root, `request-${++bodyNumber}.json`);
      writeFileSync(file, JSON.stringify(body), { mode: 0o600 });
      args.push("--body-file", file);
    }
    const r = spawnSync("aliyun", args, { encoding: "utf8", timeout:45000, maxBuffer:8*1024*1024 });
    if (r.status !== 0) {
      const raw=`${r.stdout??""}\n${r.stderr??""}`;
      const diagnostic = raw.split("\n").find(line=>/^ERROR:/.test(line)&&!/(?:https?:|STS\.|CAIS|SecurityToken|AccessKey|Signature)/i.test(line));
      let message=raw.match(/^Message:\s*(.+)$/m)?.[1];
      if(message && /https?:|STS\.|CAIS|SecurityToken=|AccessKeySecret|Signature=|[A-Za-z0-9+/=]{100}/i.test(message))message=undefined;
      if(message)message=message.replace(/acs:[^\s'";,]+/g,"[resource]").replace(/\b\d{12,20}\b/g,"[account]").slice(0,500);
      report.callFailure = { exit:r.status, signal:r.signal, processCode:r.error?.code, timeout:/timeout|deadline/i.test(raw), diagnostic:diagnostic?.slice(0,200), message };
      throw safeFailure(`FC_${method}_${extractAliyunErrorCode(r.stdout ?? "", r.stderr ?? "")}`);
    }
    try { return JSON.parse(r.stdout); } catch { throw safeFailure("FC_RESPONSE_INVALID"); }
  }
  const readFunction = (kind) => fc("GET", `/functions/${names[kind]}`);
  async function update(kind, before, environmentVariables, role) {
    const pkg = transfer.packages[kind];
    const changed = String(before.codeChecksum) !== pkg.crc64 || before.role !== role ||
      Object.entries(environmentVariables).some(([k,v]) => before.environmentVariables?.[k] !== v);
    if (changed) fc("PUT", `/functions/${names[kind]}`, {
      code: { ossBucketName:env.V2_OSS_BUCKET, ossObjectName:keyFor(kind,pkg), checksum:pkg.crc64 },
      role, environmentVariables,
    });
    let after;
    for (let n=0;n<15;n++) {
      after=readFunction(kind);
      if (String(after.codeChecksum)===pkg.crc64 && Number(after.codeSize)===pkg.bytes &&
          (!after.lastUpdateStatus || after.lastUpdateStatus==="Successful")) break;
      await sleep(2000);
    }
    if (String(after.codeChecksum)!==pkg.crc64 || Number(after.codeSize)!==pkg.bytes || after.role!==role ||
        Object.entries(environmentVariables).some(([k,v])=>after.environmentVariables?.[k]!==v))
      throw safeFailure("FUNCTION_UPDATE_NOT_VERIFIED");
    for(const field of ["functionName","runtime","cpu","memorySize","diskSize","timeout","instanceConcurrency","internetAccess","vpcConfig","customRuntimeConfig","layers"])
      if(!same(after[field],before[field]))throw safeFailure("FUNCTION_BOUNDARY_DRIFT");
    return { changed, crc64Verified:true, environmentVerified:true };
  }
  try {
    const before={worker:readFunction("worker"),control:readFunction("control")};
    for(const kind of Object.keys(names)) {
      const allowed=kind==="worker"&&before.worker.role===workerRole?workerRole:env.V2_FUNCTION_ROLE_ARN;
      verifyPrivateFunctionBaseline(kind,before[kind],fc("GET",`/functions/${names[kind]}/concurrency`),fc("GET",`/functions/${names[kind]}/scaling-config`),allowed);
    }
    report.controlTriggersChanged=false;
    report.stage="WORKER_UPDATE";
    report.worker=await update("worker",before.worker,queueEnvironment("worker",before.worker.environmentVariables,env,jobId),workerRole);
    console.log(JSON.stringify({stage:report.stage,ok:true}));
    report.stage="OSS_TRIGGER";
    const trigger={triggerName,triggerType:"oss",invocationRole:triggerRole,sourceArn:`acs:oss:cn-hangzhou:${account}:${env.V2_OSS_BUCKET}`,qualifier:"LATEST",triggerConfig:JSON.stringify({events:["oss:ObjectCreated:PutObject"],filter:{key:{prefix:"data-platform-demo/v2/spark-queue/jobs/",suffix:".json"}}})};
    let actual;
    try { actual=fc("GET",`/functions/${names.worker}/triggers/${triggerName}`); }
    catch(error) {
      if(!isMissingTrigger(error.code))throw error;
      fc("POST",`/functions/${names.worker}/triggers`,trigger);
      actual=fc("GET",`/functions/${names.worker}/triggers/${triggerName}`);
    }
    if(["triggerType","invocationRole","sourceArn","qualifier"].some(k=>actual[k]!==trigger[k])||!same(JSON.parse(actual.triggerConfig),JSON.parse(trigger.triggerConfig)))throw safeFailure("TRIGGER_NOT_VERIFIED");
    delete report.callFailure;
    console.log(JSON.stringify({stage:report.stage,ok:true}));
    report.stage="SIGNED_QUEUE_SMOKE";
    const transportEnv={...env,OSS_BUCKET:env.V2_OSS_BUCKET,OSS_REGION:"cn-hangzhou",OSS_ENDPOINT:"https://oss-cn-hangzhou.aliyuncs.com",V2_SPARK_EXECUTOR_TRANSPORT:"OSS_QUEUE",V2_SPARK_QUEUE_TIMEOUT_MS:"300000"};
    const config=queueConfigFromEnvironment(transportEnv);
    const transport=ossSparkQueueTransportFromEnvironment(transportEnv,(url,options)=>fetch(url,{...options,signal:AbortSignal.timeout(15000)}));
    const queued=createQueuedSparkJob(privateSparkSmokePayload({requestId:jobId,submittedAt:new Date().toISOString()}),config,{requestId:jobId});
    let result;
    const old=await transport.read(queued.resultKey);
    if(old) result=verifyQueuedSparkResult(JSON.parse(old),jobId,config);
    else {
      if(await transport.read(queued.jobKey))throw safeFailure("SMOKE_JOB_ALREADY_SUBMITTED_WITHOUT_RESULT");
      await transport.create(queued.jobKey,JSON.stringify(queued.job));
      const deadline=Date.now()+240000;
      while(Date.now()<deadline){const raw=await transport.read(queued.resultKey);if(raw){result=verifyQueuedSparkResult(JSON.parse(raw),jobId,config);break;}await sleep(3000);}
    }
    if(result?.status!=="SUCCEEDED"||result.engineVersion!=="3.5.9"||!result.mainSqlExecuted||result.validation?.passed!==true||String(result.rows?.[0]?.total_assets)!=="175.00")throw safeFailure("SPARK_QUEUE_SMOKE_NOT_VERIFIED");
    report.smoke={status:result.status,engineVersion:result.engineVersion,totalAssets:result.rows[0].total_assets,assertionsPassed:true};
    console.log(JSON.stringify({stage:report.stage,...report.smoke}));
    report.stage="CONTROL_UPDATE";
    report.control=await update("control",before.control,queueEnvironment("control",before.control.environmentVariables,env,jobId),env.V2_FUNCTION_ROLE_ARN);
    report.stage="COMPLETED";report.ok=true;report.controlBootVerified=false;
  } catch(error) {
    report.ok=false;report.error=/^[A-Za-z0-9_.-]+$/.test(error.code??"")?error.code:"PRIVATE_W3_FAILED";
    process.exitCode=1;
  } finally {
    report.finishedAt=new Date().toISOString();
    writeFileSync("w3-private-result.json",JSON.stringify(report,null,2),{mode:0o600});
    console.log(JSON.stringify(report));
    rmSync(root,{recursive:true,force:true});
  }
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1])deploy().catch(e=>{console.error(JSON.stringify({ok:false,code:e.code??"W3_PREFLIGHT_FAILED"}));process.exitCode=1;});
