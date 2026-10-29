// UI QA only: the model and OSS event bus are test doubles. No Spark result is
// fabricated: the task stays WAITING_FOR_RESULT until stopped by the tester.
import {mkdtempSync,cpSync,readFileSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {createV2Server} from "../../src/v2/server.mjs";
import {createPreviewServer} from "../../scripts/run-v2-cloudshell-preview.mjs";
import {createQueuedSparkJob} from "../../src/v2/remote-spark-queue.mjs";
import {referenceSql,referenceSqlForContext} from "../../src/v2/context.mjs";
import {AGENT_WAKE_PREFIX} from "../../src/v2/agent-event-driver.mjs";
import {modelFailure} from "../../src/v2/model-diagnostics.mjs";
const port=Number(process.env.V2_QA_PORT??3194);
if(!Number.isSafeInteger(port)||port<1024||port>65535)throw Error("LOCAL_UI_PORT_INVALID");
const root=mkdtempSync(join(tmpdir(),"shuduo-event-ui-")),origin=`http://127.0.0.1:${port}`,objects=new Map();
let app,models=0,submissions=0;
const queueConfig={projectId:"project-securities-lab",sharedSecret:"synthetic-worker-secret-".repeat(3),jobPrefix:"data-platform-demo/v2/spark-queue/jobs",
  resultPrefix:"data-platform-demo/v2/spark-queue/results",cancellationPrefix:"data-platform-demo/v2/spark-queue/cancellations",timeoutMs:180000};
const invoke=async payload=>{
  const r=await fetch(`http://127.0.0.1:${app.server.address().port}/invoke`,{method:"POST",headers:{"content-type":"application/octet-stream"},body:JSON.stringify(payload)});
  if(!r.ok)throw Error("LOCAL_UI_EVENT_REJECTED");return r.json();
};
const runner=async()=>{throw Error("UI fixture never executes Spark");};
runner.descriptor={engine:"Apache Spark",isolation:"REMOTE_FUNCTION",transport:"SYNTHETIC_UI_QUEUE",publicWriteEnabled:true};
runner.durable={prepare:(input,id)=>{const q=createQueuedSparkJob(input,queueConfig,{requestId:id});return{...q,serialized:JSON.stringify(q.job)};},
  submit:async queued=>{if(!objects.has(queued.jobKey)){objects.set(queued.jobKey,queued.serialized);submissions++;}},read:async()=>undefined,cancel:async()=>{}};
app=createV2Server({root,runner,generator:async input=>{models++;if(process.env.V2_QA_FIRST_MODEL_FAILURE==="true"&&models===1)throw modelFailure("MODEL_HTTP_ERROR","RESPONSE",{httpStatus:429,elapsedMs:80});return{sql:referenceSqlForContext(input.context.id)??referenceSql,explanation:"本机UI测试模型替身，不代表真实模型质量或Spark执行。",model:"TEST_DOUBLE",usage:{total_tokens:20}};},
  env:{V2_LOCAL_DEVELOPMENT:"false",V2_PROVISIONING_ONLY:"true",V2_PRIVATE_SMOKE_ENABLED:"true",V2_DURABLE_SQL_AGENT_ENABLED:"true",V2_AGENT_DRIVER_MODE:"OSS_EVENTS",
    DASHSCOPE_API_KEY:"synthetic-ui-key-not-valid",V2_MODEL:"SYNTHETIC_UI_MODEL",
    OSS_BUCKET:"fictional-securities-test",V2_AGENT_EVENT_ACCOUNT_ID:"111122223333",V2_SCHEDULER_TICK_SECRET:"synthetic-wake-secret-".repeat(3),V2_SPARK_EXECUTOR_SECRET:queueConfig.sharedSecret,V2_SPARK_EXECUTOR_TRANSPORT:"OSS_QUEUE"},
  agentWakeTransport:{read:async key=>objects.get(key),create:async(key,body)=>{
    if(objects.has(key)){if(objects.get(key)!==body)throw Error("immutable fixture conflict");return;}
    objects.set(key,body);
    if(key.startsWith(AGENT_WAKE_PREFIX+"/"))setTimeout(()=>void invoke({events:[{eventSource:"acs:oss",eventName:"ObjectCreated:PutObject",eventVersion:"1.0",eventTime:new Date().toISOString(),
      oss:{bucket:{name:"fictional-securities-test",ownerIdentity:"111122223333"},object:{key}}}]}).catch(()=>{}),50);
  }}});
app.auth.bootstrapAdmin({email:"event-qa@example.invalid",password:"SyntheticPassword!2026",displayName:"本机测试工程师"});
await new Promise(r=>app.server.listen(0,"127.0.0.1",r));
const web=join(root,"web");cpSync(resolve("web-dist"),web,{recursive:true});
const index=join(web,"index.html");writeFileSync(index,readFileSync(index,"utf8").replace("<body>",'<body><div role="status" style="position:sticky;top:0;z-index:9999;padding:8px;background:#fff0e8;color:#903c20">仅本机UI测试：模型与OSS事件均为替身，未执行Spark、未部署云端；不计E2E。</div>'));
const preview=createPreviewServer({origin,webRoot:web,invoke,allowAgent:true});
await new Promise(r=>preview.listen(port,"127.0.0.1",r));
console.log(JSON.stringify({url:origin+"/v2/?module=agent-center",scope:"LOCAL_SYNTHETIC_EVENT_UI",modelCallsAreTestDouble:true,sparkActuallyExecuted:false}));
let closing=false;const close=async()=>{if(closing)return;closing=true;preview.closeAllConnections();app.server.closeAllConnections();await Promise.all([new Promise(r=>preview.close(r)),new Promise(r=>app.server.close(r))]);app.store.close();rmSync(root,{recursive:true,force:true});console.log(JSON.stringify({closed:true,modelTestDoubleCalls:models,queuedTestDoubleJobs:submissions}));};
process.once("SIGINT",()=>void close());process.once("SIGTERM",()=>void close());setTimeout(()=>void close(),10*60000).unref();
