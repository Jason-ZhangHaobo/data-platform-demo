import {createAgentSubmission} from './agent-submission.ts';
import {bindInvitedSqlStart,invitedSqlStartBody} from '../../src/v2/invited-sql-start.mjs';

type Api = <T>(path:string, body?:unknown, options?:{idempotencyKey?:string})=>Promise<T>;
type Draft = {message:string;contextId:string};
type Options = {
  api:Api;
  initialKey?:string;
  onPending:(requestId:string|undefined)=>void;
  canSubmit:()=>boolean;
  acceptsContext:(contextId:string)=>boolean;
};
type Task = Record<string,unknown> & {id:string;message:string;contextId:string};
type Selection = {taskId:string;requestId:string};

// The ordinary invited window accepts a single native development request.
// Reuse the editor's write-ahead request key and reconciliation protocol.
export function createInvitedSqlSubmission({api,initialKey,onPending,canSubmit,acceptsContext}:Options) {
  const writesAllowed=(contextId:string)=>{
    if(!canSubmit() || !acceptsContext(contextId))
      throw Error('当前受邀窗口或数据口径未开放新 SQL 任务。');
  };
  const controller=createAgentSubmission<Task>({
    initialKey,onPending,
    api:(path,body,options)=>{
      if(body!==undefined)writesAllowed((body as Draft).contextId);
      return api(path,body,options);
    },
  });
  if(initialKey!==undefined && controller.snapshot().key!==initialKey)
    throw Error('受邀开发请求编号无效。');
  let confirming:Promise<Selection>|undefined;

  async function bind(result:Promise<Task>,key:string):Promise<Selection>{
    const task=await result,expected=controller.expectedBody();
    if(controller.snapshot().closed || controller.snapshot().key!==key)throw Error('原请求已切换。');
    const selected=await bindInvitedSqlStart({request:path=>api(path)},task,key,expected);
    if(controller.snapshot().closed || controller.snapshot().key!==key)throw Error('原请求已切换。');
    controller.acknowledge(key);
    return selected;
  }

  function confirm(result:Promise<Task>){
    const key=controller.snapshot().key!;
    const settled=bind(result,key).finally(()=>{if(confirming===settled)confirming=undefined;});
    confirming=settled;
    return settled;
  }
  return {
    snapshot:controller.snapshot,
    close:controller.close,
    async submit({message,contextId}:Draft){
      if(controller.snapshot().closed || controller.snapshot().key)
        throw Error('请先按原请求核对任务。');
      const body=invitedSqlStartBody({message,contextId});
      writesAllowed(contextId);
      return confirm(controller.submit(body));
    },
    recover(){return confirming??confirm(controller.recover());},
    retry(){return confirming??confirm(controller.retry());},
  };
}
