import {regressionsMatchFamily,validationFamilyForContextId} from './validation-family.ts';
import type {InvitedStartWindow} from './invited-chat-start';
import type {Workflow} from './agent-workflow-read';

export function invitedDeliveryWriteWindow(access:InvitedStartWindow,taskId:string,now=Date.now()){
  return access.deliverySupported===true && access.developmentOnly && access.canWrite &&
    Date.parse(access.startsAt??'')<=now && now<Math.min(Date.parse(access.expiresAt??''),Date.parse(access.sessionExpiresAt??'')) &&
    (!access.taskOnly||access.targetTaskId===taskId) && (!access.windowTaskId||access.windowTaskId===taskId);
}

export function invitedRehearsalStatus(workflow:Workflow,requested:boolean){
  const delivery=workflow.delivery, result=workflow.verification;
  if(result?.workerResult==='PENDING')return 'Worker 结果待核对';
  if(delivery?.status==='SUCCEEDED'&&result?.status==='SUCCEEDED'){
    const family=validationFamilyForContextId(workflow.report.contextId,workflow.report.validationContractId);
    return workflow.invitedRehearsalEvidence==='VERIFIED' && result.engine==='Apache Spark' && Boolean(result.engineVersion) && result.mainSqlExecuted===true &&
      result.testSqlValidation?.passed && regressionsMatchFamily(result.validation,family)?'演练通过':'演练依据待核对';
  }
  if(result?.status==='FAILED'||delivery?.status==='FAILED')return workflow.invitedRehearsalEvidence==='FAILED'?'演练失败':'演练失败记录待核对';
  if(delivery?.status==='INTERRUPTED'||result?.status==='INTERRUPTED')return '演练中断';
  if(delivery?.status==='CANCELLED'||result?.status==='CANCELLED')return '演练已取消';
  if(result||delivery?.rehearsalBackground?.state==='BATCH_RESERVED')return '等待原演练批次结果';
  if(delivery?.rehearsalBackground?.state==='QUEUED')return '已委托后台演练';
  if(delivery?.rehearsalBackground||requested)return '演练委托待核对';
  return workflow.package?'文件已生成，待演练':delivery?'文件保存中':'尚未生成文件';
}
