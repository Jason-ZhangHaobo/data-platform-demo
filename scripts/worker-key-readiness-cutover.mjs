// Pure verification only. No CLI, environment reads, cloud requests or writes.
// Returned patch contains secrets: never print or attach it to public evidence.
import {isDeepStrictEqual} from 'node:util';
import {functionSnapshot,functionDigest} from './refresh-v2-spark-readiness.mjs';
import {queueConfigFromEnvironment,verifyQueuedSparkJob,verifyQueuedSparkResult} from '../src/v2/remote-spark-queue.mjs';
import {privateSparkSmokePayload} from '../src/v2/spark-worker-private-smoke.mjs';

export const workerKeyReadinessCutoverScope='shuduo-worker-key-readiness-cutover/v1';
const fail=code=>{throw Object.assign(new Error(code),{safeCode:code});};
const check=(value,code)=>{if(!value)fail(code);};
const validSecret=value=>typeof value==='string'&&value.length>=32&&value.length<=512&&value.trim()===value&&!/[\s\u0000-\u001f\u007f]/.test(value);
const validId=value=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const functionName=value=>typeof value==='string'&&/^dataplatform-v2-[a-z0-9-]{1,60}$/.test(value);
const stable=value=>value&&(!value.state||value.state==='Active')&&(!value.lastUpdateStatus||value.lastUpdateStatus==='Successful');
const sameKeys=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));

export function buildWorkerKeyReadyCutover({controlBefore,workerBefore,workerAfter,newSecret,proof,now}={}){
  check(Number.isSafeInteger(now)&&now>=0,'WORKER_CUTOVER_CLOCK_REQUIRED');
  const env=controlBefore?.environmentVariables,oldSecret=env?.V2_SPARK_EXECUTOR_SECRET;
  // Preserve the existing control limit from the provisioning/deployment
  // workflows and the Worker envelope from render-v2-spark-worker-w2-plan.
  check(functionName(controlBefore?.functionName)&&stable(controlBefore)&&controlBefore.runtime==='custom.debian12'&&
    controlBefore.cpu===0.25&&controlBefore.memorySize===512&&controlBefore.instanceConcurrency===8&&
    Number.isSafeInteger(controlBefore.timeout)&&controlBefore.timeout>0&&controlBefore.timeout<=120&&
    env?.V2_LOCAL_DEVELOPMENT==='false'&&env.V2_PROVISIONING_ONLY==='true'&&env.V2_FC_PUBLIC_HTTP_ENABLED==='true'&&
    env.V2_FC_PUBLIC_READ_ONLY==='true'&&!env.V2_FC_PUBLIC_WRITE_SCOPE&&env.V2_PRIVATE_RELEASE_ENABLED!=='true',
    'WORKER_CUTOVER_READONLY_CONTROL_REQUIRED');
  check(validSecret(oldSecret)&&validSecret(newSecret)&&newSecret!==oldSecret,'WORKER_CUTOVER_NEW_SECRET_REQUIRED');
  check(functionName(workerBefore?.functionName)&&workerBefore.functionName!==controlBefore.functionName&&stable(workerBefore)&&stable(workerAfter)&&
    workerBefore.runtime==='custom.debian10'&&workerBefore.cpu===1&&workerBefore.memorySize===2048&&workerBefore.diskSize===10240&&
    workerBefore.timeout===180&&workerBefore.instanceConcurrency===1&&workerBefore.internetAccess===false&&
    workerBefore.environmentVariables?.V2_SPARK_WORKER_RUN_TIMEOUT_MS==='120000'&&
    workerBefore.environmentVariables.V2_SPARK_QUEUE_CONSUMER_ENABLED==='true'&&workerBefore.environmentVariables.V2_SPARK_WORKER_SECRET===oldSecret,
    'WORKER_CUTOVER_ORIGINAL_WORKER_REQUIRED');
  const expectedWorker={...workerBefore,environmentVariables:{...workerBefore.environmentVariables,V2_SPARK_WORKER_SECRET:newSecret}};
  check(workerAfter.environmentVariables?.V2_SPARK_WORKER_SECRET===newSecret&&
    isDeepStrictEqual(functionSnapshot(workerAfter),functionSnapshot(expectedWorker)),'WORKER_CUTOVER_WORKER_DRIFT');
  const originalQueue=queueConfigFromEnvironment(env),workerQueue=queueConfigFromEnvironment({...workerBefore.environmentVariables,
    V2_SPARK_EXECUTOR_TRANSPORT:'OSS_QUEUE',V2_SPARK_EXECUTOR_SECRET:oldSecret});
  check(originalQueue&&validId(originalQueue.readyJobId)&&originalQueue.projectId==='project-securities-lab'&&
    ['jobPrefix','resultPrefix','cancellationPrefix','projectId','timeoutMs'].every(key=>originalQueue[key]===workerQueue[key]),'WORKER_CUTOVER_QUEUE_BOUNDARY_CHANGED');
  check(sameKeys(proof,['scope','issuedAt','expiresAt','boundaryDigest','oldReadyJobId','workerAfterDigest','job','envelope'])&&
    proof.scope===workerKeyReadinessCutoverScope&&Number.isSafeInteger(proof.issuedAt)&&Number.isSafeInteger(proof.expiresAt)&&
    proof.issuedAt<=now&&now-proof.issuedAt<=900000&&proof.expiresAt>now&&proof.expiresAt<=proof.issuedAt+900000,
    'WORKER_CUTOVER_PROOF_WINDOW_INVALID');
  check(proof.boundaryDigest===functionDigest(controlBefore)&&proof.oldReadyJobId===originalQueue.readyJobId&&
    proof.workerAfterDigest===functionDigest(workerAfter),'WORKER_CUTOVER_BASELINE_CHANGED');
  const queue={...originalQueue,sharedSecret:newSecret},job=proof.job;
  check(validId(job?.jobId)&&job.jobId!==originalQueue.readyJobId,'WORKER_CUTOVER_NEW_JOB_REQUIRED');
  const payload=verifyQueuedSparkJob(job,queue,now,{allowExpired:true}),submitted=Date.parse(payload.submittedAt),timestamp=Number(job.timestamp),expires=Date.parse(job.expiresAt);
  check(Number.isSafeInteger(timestamp)&&submitted===timestamp&&submitted<=now+60000&&now-submitted<=900000&&
    Number.isFinite(expires)&&expires===timestamp+queue.timeoutMs,'WORKER_CUTOVER_JOB_TIME_INVALID');
  check(isDeepStrictEqual(payload,privateSparkSmokePayload({requestId:job.jobId,submittedAt:payload.submittedAt})),
    'WORKER_CUTOVER_FIXED_SMOKE_REQUIRED');
  const result=verifyQueuedSparkResult(proof.envelope,job.jobId,queue),completed=Date.parse(proof.envelope.completedAt);
  check(Number.isFinite(completed)&&completed>=submitted&&completed<=now+60000&&now-completed<=900000&&completed-submitted<=300000,
    'WORKER_CUTOVER_COMPLETION_TIME_INVALID');
  check(result?.status==='SUCCEEDED'&&result.engine==='Apache Spark'&&result.engineVersion==='3.5.9'&&result.mainSqlExecuted===true&&
    result.testDouble!==true&&result.validation?.passed===true,'WORKER_CUTOVER_SUCCESSFUL_RESULT_REQUIRED');
  const expected=privateSparkSmokePayload({}).context.expected[0];
  check(Array.isArray(result.rows)&&result.rows.length===1,'WORKER_CUTOVER_ROW_COUNT_FAILED');
  check(sameKeys(result.rows[0],Object.keys(expected))&&Object.entries(expected).every(([key,value])=>result.rows[0][key]===value),
    'WORKER_CUTOVER_INDEPENDENT_ASSERTION_FAILED');
  const environmentVariables={...structuredClone(env),V2_SPARK_EXECUTOR_SECRET:newSecret,V2_SPARK_QUEUE_READY_JOB_ID:job.jobId};
  return{
    patch:{environmentVariables},expectedControlDigest:functionDigest({...controlBefore,environmentVariables}),
    // Only this allowlisted summary is suitable for logs. It contains no IDs,
    // config values, key fingerprints, job payloads or original error contents.
    summary:{protocol:workerKeyReadinessCutoverScope,authorized:false,executed:false,independentAssertions:6,
      workerSecretOnlyDeltaVerified:true,controlKeyAndReadyPaired:true,
      changedControlEnvironmentKeys:['V2_SPARK_EXECUTOR_SECRET','V2_SPARK_QUEUE_READY_JOB_ID'],
      requiresQuiescenceEvidence:true,requiresFreshCloudReadback:true,requiresBudgetAndScopeApproval:true,
      requiresSingleJobExecutionEvidence:true,historicalCloudCompatibilityAccepted:false},
  };
}
