import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { durableSqlAgentMode } from "./durable-agent.mjs";
import { SPARK_QUEUE_PREFIXES, verifyQueuedSparkResult } from "./remote-spark-queue.mjs";

export const AGENT_WAKE_PREFIX = "data-platform-demo/v2/agent-wakes";
export const agentEventProtocol = "shuduo-agent-event-driver/v1";
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const hash = text => createHash("sha256").update(text).digest("hex");
const fail = (status, code) => Object.assign(new Error(code), {status,code});
const ready = new Set(["READY_FOR_MODEL","READY_FOR_RUN"]);
const terminal = new Set(["SUCCEEDED","FAILED","CANCELLED"]);
const safeCode = e => /^[A-Z][A-Z0-9_]{2,64}$/.test(e?.code ?? "") ? e.code : "AGENT_EVENT_FAILED";
const signature = (body, secret) => createHmac("sha256", secret).update(`shuduo-agent-wake/v1\n${JSON.stringify(body)}`).digest("hex");
const equal = (a,b) => typeof a === "string" && /^[a-f0-9]{64}$/.test(a) && timingSafeEqual(Buffer.from(a),Buffer.from(b));

export function agentEventConfigFromEnvironment(env) {
  if (env.V2_AGENT_DRIVER_MODE !== "OSS_EVENTS") return undefined;
  const config = {bucket:env.OSS_BUCKET,accountId:env.V2_AGENT_EVENT_ACCOUNT_ID,project:env.V2_PROJECT_ID ?? "project-securities-lab",
    wakePrefix:AGENT_WAKE_PREFIX,resultPrefix:env.V2_SPARK_QUEUE_RESULT_PREFIX ?? SPARK_QUEUE_PREFIXES.results};
  const master=env.V2_SCHEDULER_TICK_SECRET || env.V2_SPARK_EXECUTOR_SECRET;
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(config.bucket ?? "") || !/^\d{12,20}$/.test(config.accountId ?? "") ||
    typeof master !== "string" || master.length<32 || master.length>512 || /\s/.test(master) ||
    config.resultPrefix!==SPARK_QUEUE_PREFIXES.results || config.project!=="project-securities-lab") throw fail(503,"AGENT_EVENT_CONFIG_INVALID");
  config.secret=createHmac("sha256",master).update(`shuduo-agent-wake-key/v1\n${config.project}`).digest("hex");
  return config;
}

export function parseAgentObjectEvent(event,config) {
  if(!config || !event || !Array.isArray(event.events) || event.events.length!==1)throw fail(422,"AGENT_OBJECT_EVENT_INVALID");
  const item=event.events[0],key=item?.oss?.object?.key;
  if(item?.eventSource!=="acs:oss" || item.eventName!=="ObjectCreated:PutObject" || item.eventVersion!=="1.0" ||
    item.oss?.bucket?.name!==config.bucket || item.oss?.bucket?.ownerIdentity!==config.accountId ||
    !Number.isFinite(Date.parse(item.eventTime)) || typeof key!=="string")throw fail(401,"AGENT_OBJECT_SOURCE_INVALID");
  for(const [kind,prefix] of [["WAKE",config.wakePrefix],["RESULT",config.resultPrefix]]){
    if(key.startsWith(prefix+"/") && key.endsWith(".json")){
      const id=key.slice(prefix.length+1,-5);
      if(uuid.test(id))return{kind,key,id};
    }
  }
  throw fail(422,"AGENT_OBJECT_KEY_INVALID");
}

// No process timer, idle polling, publication or user-controlled command. Each
// event can claim only its opted-in task and one durable development boundary.
export function createAgentEventDriver({store,project,dispatcher,engine,transport,config,queueConfig,persist,now=Date.now}) {
  if(!dispatcher || !transport?.create || !transport?.read || config?.project!==project || queueConfig?.projectId!==project)
    throw fail(503,"AGENT_EVENT_DEPENDENCY_INVALID");
  const getTask=id=>{
    const task=store.get("agent",id,project);
    if(!task || task.executionMode!==durableSqlAgentMode)throw fail(404,"AGENT_EVENT_TASK_NOT_FOUND");
    return task;
  };
  const ownerAllowed=task=>{
    const owner=store.get("auth_user",task.submittedBy,project);
    return owner?.status==="ACTIVE" && owner.memberships?.some(m=>m.projectId===project && ["ADMIN","ENGINEER"].includes(m.role));
  };
  const grantFor=id=>store.list("agent_background",project).find(g=>g.taskId===id && g.status==="ACTIVE");
  const view=(g,delivery)=>({protocol:agentEventProtocol,taskId:g.taskId,status:g.status,expiresAt:g.expiresAt,maxEvents:g.maxEvents,
    consumedEvents:g.consumedEvents,delivery:delivery ?? g.delivery,state:g.state,code:g.code,
    cloudDriverVerified:false,publicationAutomatic:false});
  const patch=(g,value)=>store.update("agent_background",g.id,project,value,{expectedVersion:g.version});
  const stop=async(g,status,code)=>{g=patch(g,{status,state:status,code});await persist();return view(g);};
  const live=async(g,task)=>{
    if(g.expiresAt<=now())return stop(g,"EXPIRED","AGENT_BACKGROUND_DEADLINE");
    if(!ownerAllowed(task))return stop(g,"PAUSED","AGENT_OWNER_PERMISSION_REVOKED");
    if(task.durable.contextDigest!==g.contextDigest)return stop(g,"PAUSED","AGENT_BACKGROUND_CONTEXT_CHANGED");
    if(terminal.has(task.status))return stop(g,"COMPLETED",undefined);
    if(task.stage==="MODEL_OUTCOME_UNKNOWN")return stop(g,"NEEDS_CONFIRMATION","MODEL_OUTCOME_UNKNOWN");
    return undefined;
  };
  async function schedule(g,task) {
    const gated=await live(g,task);if(gated)return gated;
    if(!ready.has(task.stage) && task.stage!=="WAITING_FOR_RUN" && task.stage!=="CANCELLING")return view(g,"WAITING_FOR_CHECKPOINT");
    if(g.consumedEvents>=g.maxEvents)return stop(g,"PAUSED","AGENT_BACKGROUND_EVENT_LIMIT");
    const dedup=store.deduplicate(`${project}:agent-wake:${g.id}:${task.version}`,task.stage,()=>store.create("agent_wake",project,{grantId:g.id,taskId:task.id,taskVersion:task.version,status:"PREPARED"}));
    let wake=store.get("agent_wake",dedup.id,project);
    if(!wake.body){
      const body={protocol:"shuduo-agent-wake/v1",wakeId:wake.id,grantId:g.id,taskId:task.id,taskVersion:task.version,projectId:project,expiresAt:g.expiresAt};
      const serialized=JSON.stringify({body,signature:signature(body,config.secret)});
      wake=store.update("agent_wake",wake.id,project,{body:serialized,bodyHash:hash(serialized)},{expectedVersion:wake.version});
    }
    if(wake.status==="DONE")return view(g,"ALREADY_CONSUMED");
    await persist(); // Stable wake id/body before external Put, including unknown ACK.
    try{
      await transport.create(`${config.wakePrefix}/${wake.id}.json`,wake.body);
      if(wake.status==="PREPARED")store.update("agent_wake",wake.id,project,{status:"SENT"},{expectedVersion:wake.version});
      g=patch(g,{state:"QUEUED",delivery:"ACKNOWLEDGED",code:undefined});await persist();
      return view(g,"ACKNOWLEDGED");
    }catch(e){
      g=store.get("agent_background",g.id,project);
      g=patch(g,{delivery:"UNCONFIRMED",code:safeCode(e)});await persist();
      // Caller may retry this exact outbox, never recreate the task/model call.
      return view(g,"UNCONFIRMED");
    }
  }
  async function enable(taskId,actorId,{expectedVersion,maxEvents=20,durationMs=15*60000}={}) {
    const task=getTask(taskId);
    if(task.submittedBy!==actorId || !ownerAllowed(task))throw fail(403,"AGENT_BACKGROUND_OWNER_REQUIRED");
    if(expectedVersion!==task.version)throw fail(409,"STALE_AGENT_VERSION");
    if(!Number.isSafeInteger(maxEvents)||maxEvents<1||maxEvents>20||!Number.isSafeInteger(durationMs)||durationMs<60000||durationMs>30*60000)
      throw fail(422,"AGENT_BACKGROUND_LIMIT_INVALID");
    let g=store.list("agent_background",project).find(x=>x.taskId===taskId);
    if(g && g.status!=="ACTIVE")throw fail(409,"AGENT_BACKGROUND_REVIEW_REQUIRED");
    if(!g)g=store.create("agent_background",project,{taskId,actorId,status:"ACTIVE",state:"QUEUED",contextDigest:task.durable.contextDigest,
      expiresAt:now()+durationMs,maxEvents,consumedEvents:0,scope:"SQL_DEVELOPMENT",publicationAutomatic:false});
    await persist();return schedule(g,task);
  }
  async function cancel(taskId,actorId) {
    const task=getTask(taskId),g=grantFor(taskId);
    if(task.submittedBy!==actorId)throw fail(403,"AGENT_BACKGROUND_OWNER_REQUIRED");
    if(!g)return{protocol:agentEventProtocol,taskId,status:"INACTIVE"};
    return stop(g,"CANCELLED","USER_STOPPED_BACKGROUND");
  }
  async function resume(taskId,actorId,{expectedVersion,confirmModelRetry=false}={}) {
    const task=getTask(taskId);
    if(task.submittedBy!==actorId || !ownerAllowed(task))throw fail(403,"AGENT_BACKGROUND_OWNER_REQUIRED");
    let g=store.list("agent_background",project).find(x=>x.taskId===taskId);
    if(!g || !["NEEDS_CONFIRMATION","EXPIRED","PAUSED","CANCELLED"].includes(g.status))throw fail(409,"AGENT_BACKGROUND_REVIEW_REQUIRED");
    if(g.contextDigest!==task.durable.contextDigest)throw fail(409,"AGENT_BACKGROUND_CONTEXT_CHANGED");
    if(g.consumedEvents>=g.maxEvents)throw fail(409,"AGENT_BACKGROUND_EVENT_LIMIT");
    if(!engine?.prepareResume)throw fail(503,"AGENT_BACKGROUND_RESUME_UNAVAILABLE");
    await engine.prepareResume(taskId,{expectedVersion,confirmModelRetry});
    // No limit/count reset. The review renews only a bounded execution window.
    g=patch(g,{status:"ACTIVE",state:"QUEUED",code:undefined,expiresAt:now()+15*60000,
      review:{actorId,taskVersion:expectedVersion,reviewedAt:new Date(now()).toISOString(),confirmModelRetry}});
    await persist();return schedule(g,getTask(taskId));
  }
  const status=taskId=>{
    const g=store.list("agent_background",project).find(x=>x.taskId===taskId);
    return g?view(g):{protocol:agentEventProtocol,taskId,status:"INACTIVE",cloudDriverVerified:false};
  };
  async function consumeWake(object) {
    const wake=store.get("agent_wake",object.id,project);
    if(!wake)return{protocol:agentEventProtocol,state:"IGNORED_UNREGISTERED"};
    let g=store.get("agent_background",wake.grantId,project);
    if(!g || g.status!=="ACTIVE")return{protocol:agentEventProtocol,state:"INACTIVE"};
    const raw=await transport.read(object.key);
    if(typeof raw!=="string"||Buffer.byteLength(raw)>16384||hash(raw)!==wake.bodyHash)throw fail(401,"AGENT_WAKE_BODY_MISMATCH");
    let envelope;try{envelope=JSON.parse(raw);}catch{throw fail(422,"AGENT_WAKE_INVALID");}
    const b=envelope?.body;
    if(!b || b.wakeId!==wake.id || b.grantId!==g.id || b.taskId!==g.taskId || b.taskVersion!==wake.taskVersion || b.projectId!==project ||
      b.protocol!=="shuduo-agent-wake/v1" || !equal(envelope.signature,signature(b,config.secret)))throw fail(401,"AGENT_WAKE_SIGNATURE_INVALID");
    if(b.expiresAt!==g.expiresAt)return{protocol:agentEventProtocol,state:"IGNORED_SUPERSEDED"};
    if(wake.status==="DONE"){
      const current=getTask(g.taskId);
      if(ready.has(current.stage)){
        const next=await schedule(g,current);
        if(next.delivery==="UNCONFIRMED")throw fail(503,"AGENT_WAKE_DELIVERY_UNCONFIRMED");
        return next;
      }
      return{protocol:agentEventProtocol,state:"REPLAYED"};
    }
    const task=getTask(g.taskId),gated=await live(g,task);if(gated)return gated;
    if(wake.status!=="CLAIMED"){
      if(g.consumedEvents>=g.maxEvents)return stop(g,"PAUSED","AGENT_BACKGROUND_EVENT_LIMIT");
      if(task.version!==wake.taskVersion){
        store.update("agent_wake",wake.id,project,{status:"DONE",outcome:"STALE"},{expectedVersion:wake.version});await persist();
        return ready.has(task.stage)?schedule(g,task):view(g,"STALE_EVENT");
      }
      g=patch(g,{consumedEvents:g.consumedEvents+1,state:"RUNNING"});
      store.update("agent_wake",wake.id,project,{status:"CLAIMED"},{expectedVersion:wake.version});await persist();
    }
    const result=await dispatcher.tick({requestId:wake.id,taskId:g.taskId});
    if(["BUSY","IN_PROGRESS","LEASE_EXPIRED"].includes(result.state))throw fail(503,"AGENT_EVENT_LEASE_BUSY");
    g=store.get("agent_background",g.id,project);
    const fresh=getTask(g.taskId);
    if(result.state==="STEP_FAILED")return stop(g,"PAUSED",result.code);
    const ended=await live(g,fresh);
    const receipt=store.get("agent_wake",wake.id,project);
    store.update("agent_wake",receipt.id,project,{status:"DONE",outcome:result.state},{expectedVersion:receipt.version});await persist();
    if(ended)return ended;
    if(ready.has(fresh.stage)){
      const next=await schedule(g,fresh);
      if(next.delivery==="UNCONFIRMED")throw fail(503,"AGENT_WAKE_DELIVERY_UNCONFIRMED");
      return next;
    }
    g=patch(g,{state:fresh.stage==="WAITING_FOR_RUN"?"WAITING_FOR_RESULT":fresh.stage});await persist();return view(g);
  }
  async function consumeResult(object) {
    const run=store.get("run",object.id,project);
    if(!run || run.remoteSubmission?.prepared?.resultKey!==object.key)return{protocol:agentEventProtocol,state:"IGNORED_UNREGISTERED"};
    const task=store.list("agent",project).find(t=>t.executionMode===durableSqlAgentMode && t.runId===run.id),g=task&&grantFor(task.id);
    if(!g)return{protocol:agentEventProtocol,state:"INACTIVE"};
    const gated=await live(g,task);if(gated)return gated;
    const raw=await transport.read(object.key);
    if(typeof raw!=="string" || Buffer.byteLength(raw)>2*1024*1024)throw fail(422,"AGENT_RESULT_OBJECT_INVALID");
    let envelope;try{envelope=JSON.parse(raw);}catch{throw fail(422,"AGENT_RESULT_OBJECT_INVALID");}
    verifyQueuedSparkResult(envelope,run.id,queueConfig);
    if(task.stage!=="WAITING_FOR_RUN")return view(g,"STALE_RESULT");
    return schedule(g,task);
  }
  async function consume(event) {
    const object=parseAgentObjectEvent(event,config);
    return object.kind==="WAKE"?consumeWake(object):consumeResult(object);
  }
  return{enable,resume,cancel,status,consume};
}
