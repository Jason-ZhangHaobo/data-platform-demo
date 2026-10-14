import {AGENT_WAKE_PREFIX} from "../src/v2/agent-event-driver.mjs";
import {SPARK_QUEUE_PREFIXES} from "../src/v2/remote-spark-queue.mjs";
import {fileURLToPath} from "node:url";

// Planning only. Existing OSS-role InvokeFunction must be read back separately;
// FC 3.0 documents this action as Resource '*', not function-level permission.
export function renderAgentEventPlan(input={}) {
  const account=input.accountId,region=input.region,bucket=input.bucket,fn=input.functionName,role=input.ossInvocationRoleArn;
  if(!/^\d{12,20}$/.test(account??"")||region!=="cn-hangzhou"||!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket??"")||
    !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(fn??"")||!new RegExp(`^acs:ram::${account}:role/[a-z0-9-]{1,64}$`).test(role??""))return{ok:false,code:"AGENT_EVENT_PLAN_TARGET_INVALID",apply:false};
  const objectArn=key=>`acs:oss:*:${account}:${bucket}/${key}`;
  return{ok:true,apply:false,decision:"PENDING_EXPLICIT_CLOUD_APPROVAL_AND_ROLE_READBACK",functionName:fn,
    runtimePolicy:{Version:"1",Statement:[{Effect:"Allow",Action:["oss:GetObject","oss:PutObject"],Resource:objectArn(`${AGENT_WAKE_PREFIX}/*.json`)}]},
    requiredExistingResultRead:{Action:"oss:GetObject",Resource:objectArn(`${SPARK_QUEUE_PREFIXES.results}/*.json`)},
    invocationPolicyChange:null,fcInvokeResourceLevelSupported:false,
    invocationRoleGate:{reuseOnly:role,actualRolePolicyMustBeReadBack:true,stopIfExistingInvokeMissing:true,neverGrantInvokeToRuntimeRole:true},
    triggers:[["shuduo-v2-agent-wake-put-v1",AGENT_WAKE_PREFIX],["shuduo-v2-agent-result-put-v1",SPARK_QUEUE_PREFIXES.results]].map(([triggerName,prefix])=>({
      triggerName,triggerType:"oss",invocationRole:role,sourceArn:`acs:oss:${region}:${account}:${bucket}`,qualifier:"LATEST",
      triggerConfig:{events:["oss:ObjectCreated:PutObject"],filter:{key:{prefix:prefix+"/",suffix:".json"}}}
    })),
    configurationPatch:{V2_AGENT_DRIVER_MODE:"OSS_EVENTS",V2_AGENT_EVENT_ACCOUNT_ID:account},
    limits:{taskDurationMs:900000,maximumDurationMs:1800000,maxEventsPerTask:20,maxModelAttempts:3,
      idlePolling:false,timerTriggers:false,automaticPublication:false,publicEndpoints:false,newFunction:false,newCapacity:false},
    acceptance:{newFictionalTasks:1,maxModelCalls:3,maxSparkRuns:3,incrementalCostLimitCny:5,totalMonthlyLimitCny:200,
      closeBrowser:true,stopLocalDrivers:true,verifyDistinctBackendBoots:true,duplicateEventAndCancellation:true},
    gates:["current full bill plus trial expiry and cost reservation","exact deployed source/package and rollback object",
      "private bucket and scoped runtime policy","existing OSS invocation role and bucket event registration readback",
      "non-overlapping trigger filters and no events for artifact/result rewrites","successful CI and local event recovery tests",
      "bounded async retry/invoke limits; unconfirmed failures preserve outbox and require visible recovery"],
    cleanup:"Disable/remove only these exact two triggers and mode; preserve tasks, snapshots and immutable code objects."};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
  const result=renderAgentEventPlan({accountId:process.env.ALIYUN_ACCOUNT_ID,region:process.env.ALIBABA_CLOUD_REGION_ID,
    bucket:process.env.V2_OSS_BUCKET,functionName:process.env.V2_FUNCTION_NAME,ossInvocationRoleArn:process.env.V2_W3_OSS_TRIGGER_ROLE_ARN});
  console.log(JSON.stringify(result,null,2));if(!result.ok)process.exitCode=1;
}
