const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function agentSubmissionRequest(href:string){
  const query=new URL(href).searchParams,value=query.get("agent_request");
  return query.getAll("agent_request").length===1&&value&&uuid.test(value)?value:undefined;
}
export function agentSubmissionLocation(href:string,key:string){
  if(!uuid.test(key))throw Error("Agent提交恢复编号不合法");
  const url=new URL(href);url.username="";url.password="";url.search="";url.hash="";url.searchParams.set("module","agent-center");url.searchParams.set("agent_request",key);return url;
}
export function agentDevelopmentReadiness(status?:{mode?:string;model?:{configured?:boolean};spark?:{available?:boolean};agentDevelopment?:{durableEnabled?:boolean}}){
  if(!status)return {ready:false,reason:"正在读取服务状态；不会自动提交。"};
  if(status.mode!=="LOCAL_DEVELOPMENT"&&status.agentDevelopment?.durableEnabled!==true)return {ready:false,reason:"当前服务尚未启用持久 Agent；历史任务仍可读取。"};
  if(status.model?.configured!==true)return {ready:false,reason:"模型尚未配置，请到平台设置连接个人项目的模型服务；历史任务仍可读取。"};
  if(status.spark?.available!==true)return {ready:false,reason:"Spark 执行环境尚未就绪；历史任务仍可读取。"};
  return {ready:true,reason:"可以提交任务，实际连接与结果以本次执行为准。"};
}
export function agentTaskReceiptValid(task:{id?:unknown;version?:unknown;message?:unknown;contextId?:unknown;attempts?:unknown;language?:unknown;runId?:unknown}){
  return typeof task.id==="string"&&uuid.test(task.id)&&Number.isSafeInteger(task.version)&&Number(task.version)>0&&
    typeof task.message==="string"&&typeof task.contextId==="string"&&task.contextId.length>0&&Array.isArray(task.attempts)&&
    task.attempts.every(attempt=>attempt&&typeof attempt==="object"&&Number.isSafeInteger(attempt.attempt)&&attempt.attempt>0&&typeof attempt.status==="string")&&
    (task.language===undefined||task.language==="SPARK_SQL")&&(task.runId===undefined||(typeof task.runId==="string"&&uuid.test(task.runId)));
}
type Api=<T>(path:string,body?:unknown,options?:{idempotencyKey?:string})=>Promise<T>;
export function createAgentSubmission<T extends {id:string}>({api,initialKey,onPending,makeKey=()=>crypto.randomUUID()}:{api:Api;initialKey?:string;onPending:(key:string|undefined)=>void;makeKey?:()=>string}){
  let pending:{key:string;payload?:string}|undefined=initialKey&&uuid.test(initialKey)?{key:initialKey}:undefined;
  let flight:Promise<T>|undefined,closed=false,generation=0;
  const run=(operation:(assertCurrent:()=>void)=>Promise<T>)=>{
    if(closed)return Promise.reject(Error("提交恢复已关闭"));
    if(flight)return flight;
    const stamp=generation,key=pending?.key;
    const assertCurrent=()=>{if(closed||stamp!==generation||key!==pending?.key)throw Error("提交结果已过期，请按原编号查询");};
    const request=Promise.resolve().then(()=>{assertCurrent();return operation(assertCurrent);}).then(task=>{
      assertCurrent();
      if(!uuid.test(task?.id))throw Error("任务回执不完整，保留原提交编号");
      return task;
    });
    const completion=request.finally(()=>{if(flight===completion)flight=undefined;});flight=completion;return completion;
  };
  const read=()=>{if(!pending)throw Error("没有待确认的原提交编号");return api<T>(`/agent/requests/${pending.key}`);};
  return {
    snapshot:()=>({key:pending?.key,canRetry:Boolean(pending?.payload),closed}),
    submit(body:unknown){
      if(pending)return Promise.reject(Error("请先确认原提交结果，不新建第二个请求编号"));
      const key=makeKey();if(!uuid.test(key))return Promise.reject(Error("提交编号不合法"));
      pending={key,payload:JSON.stringify(body)};onPending(key);
      return run(()=>api<T>("/agent/tasks",JSON.parse(pending!.payload!),{idempotencyKey:key}));
    },
    recover:()=>run(read),
    retry(){
      if(!pending?.payload)return Promise.reject(Error("本页没有原提交内容；仅可查询服务端记录，不能自动重发"));
      const original={...pending};
      return run(async assertCurrent=>{
        try{return await read();}catch(cause){if((cause as {status?:number})?.status!==404)throw cause;}
        assertCurrent();
        return api<T>("/agent/tasks",JSON.parse(original.payload!),{idempotencyKey:original.key});
      });
    },
    acknowledge(key:string){if(pending?.key!==key)throw Error("提交编号与回执不一致");pending=undefined;generation++;onPending(undefined);},
    close(){closed=true;generation++;},
  };
}
