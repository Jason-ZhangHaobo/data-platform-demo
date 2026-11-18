import {isDeepStrictEqual as same} from 'node:util';
import {createSignedTaskWakeDriver,signedTaskWakeView} from './signed-task-wake.mjs';
import {agentConsumptionQuery} from './agent-consumption-request.mjs';
import {consumerDigest,consumerParametersDigest,consumerWireQueryDigest} from './consumer-source.mjs';
import {serviceHash} from './data-services.mjs';

const protocol='shuduo-agent-consumption-wake/v1',kind='agent_consumption_wake';
const fail=(status,code,message)=>Object.assign(Error(message),{status,code});
const wakeKey=(project,actorId,requestId)=>`${project}:agent-consumption:${actorId}:${requestId}`;
const stepKey=(project,wakeId,type)=>`${project}:agent-consumption-step:${wakeId}:${type}`;
const types=['DAPI','XAPI'];
const assertionFailed='AGENT_CONSUMPTION_ASSERTION_FAILED';

function lookupStep(store,project,binding,wakeId,type) {
  const versionId=type==='DAPI'?binding.dapiVersionId:binding.xapiVersionId;
  const id=store.deduplicatedId(stepKey(project,wakeId,type),versionId);
  const step=id&&store.get('agent_consumption_step',id,project);
  return step?.wakeId===wakeId&&step.type===type&&step.versionId===versionId?step:undefined;
}

export function storedAgentConsumptionCall(store,project,binding,wakeId,type) {
  const step=lookupStep(store,project,binding,wakeId,type);
  if(!step)return;
  const calls=store.list('service_call',project).filter(call=>call.invocationEvidence?.delegation?.stepId===step.id);
  if(!calls.length)return;
  const [call]=calls, invocation=call.invocationEvidence;
  if(calls.length!==1||call.customerAccessHash!==undefined||!same(invocation.delegation,{wakeId,stepId:step.id,requestId:binding.requestId})||
    step.failureCode||invocation.channel!=='SIGNED_AGENT_CONSUMPTION'||call.serviceType!==type||call.serviceVersionId!==step.versionId||
    call.serviceId!==step.serviceId||call.applicationId!==binding.applicationId||call.outcome!=='SUCCEEDED'||call.statusCode!==200||
    call.resultHash!==step.rowsDigest||invocation.paginationDigest!==step.paginationDigest||call.rowCount!==step.rowCount||
    invocation.issuanceDigest!==binding.issuanceDigest||invocation.queryDigest!==consumerWireQueryDigest(agentConsumptionQuery)||
    invocation.parametersDigest!==consumerParametersDigest({page:1,pageSize:100})||!same(call.parameters,{page:1,pageSize:100}))
    throw fail(409,'AGENT_CONSUMPTION_RECEIPT_MISMATCH','原委托的接口调用记录不一致');
  return call;
}

export function readAgentConsumptionReceipt(store,project,actorId,requestId) {
  const key=wakeKey(project,actorId,requestId),id=store.deduplicatedId(key),wake=id&&store.get(kind,id,project);
  if(!wake||wake.binding.actorId!==actorId||wake.binding.requestId!==requestId)
    throw fail(404,'AGENT_CONSUMPTION_NOT_FOUND','当前账号没有该原委托');
  if(store.deduplicatedId(key,consumerDigest(JSON.stringify(wake.binding)))!==id)
    throw fail(409,'AGENT_CONSUMPTION_RECEIPT_MISMATCH','原委托的绑定与登记摘要不一致');
  const {sourceBinding,applicationId,dapiVersionId,xapiVersionId}=wake.binding;
  const calls=types.flatMap(type=>{
    const call=storedAgentConsumptionCall(store,project,wake.binding,wake.id,type);
    return call?[{type,serviceId:call.serviceId,versionId:call.serviceVersionId,callIdDigest:consumerDigest(call.id),
      rowsDigest:call.resultHash,paginationDigest:call.invocationEvidence.paginationDigest,rowCount:call.rowCount}]:[];
  });
  if(wake.state==='COMPLETED'&&calls.length!==types.length)
    throw fail(409,'AGENT_CONSUMPTION_RECEIPT_MISMATCH','原委托的双接口回执不全');
  const steps=types.map(type=>lookupStep(store,project,wake.binding,wake.id,type));
  const failed=steps.find(step=>step?.failureCode===assertionFailed);
  return {protocol,requestId,...signedTaskWakeView(wake),sourceBinding,applicationId,dapiVersionId,xapiVersionId,calls,
    ...(failed?{state:'FAILED',failure:{type:failed.type,code:assertionFailed}}:steps.some(Boolean)&&wake.state!=='COMPLETED'?{state:'RESULT_UNCONFIRMED'}:{}),
    agentInitiated:wake.state==='COMPLETED',externalSystemVerified:false};
}

export function createAgentConsumptionWake({store,project,manager,authorize,...options}) {
  const assertScope=binding=>{
    const another=store.list(kind,project).some(item=>item.binding.pilotId===binding.pilotId&&
      item.binding.applicationId===binding.applicationId&&item.binding.requestId!==binding.requestId);
    if(another)throw fail(409,'AGENT_CONSUMPTION_ALREADY_DELEGATED','应用已有原委托，请按原请求读取');
    return authorize(binding);
  };
  return createSignedTaskWakeDriver({...options,store,project,kind,protocol,codePrefix:'AGENT_CONSUMPTION_WAKE',
    assertScope,bindingKey:binding=>wakeKey(project,binding.actorId,binding.requestId),completedState:'COMPLETED',
    async execute(binding,wakeId){
      for(const type of types){
        const {targets,expected}=assertScope(binding),version=targets[type];
        if(storedAgentConsumptionCall(store,project,binding,wakeId,type))continue;
        const {id:stepId,replayed}=store.deduplicate(stepKey(project,wakeId,type),version.id,
          ()=>store.create('agent_consumption_step',project,{wakeId,type,versionId:version.id,serviceId:version.serviceId,
            rowsDigest:serviceHash(expected[type].data),paginationDigest:serviceHash(expected[type].pagination),rowCount:expected[type].data.length}));
        if(replayed){
          if(lookupStep(store,project,binding,wakeId,type)?.failureCode===assertionFailed)
            throw fail(409,assertionFailed,'原接口调用未通过独立预期');
          throw fail(503,'AGENT_CONSUMPTION_OUTCOME_UNCONFIRMED','只核对该接口原调用，不重复执行');
        }
        await options.persist();
        assertScope(binding);
        try {
          await manager.invokeDelegated({serviceId:version.serviceId,versionId:version.id,applicationId:binding.applicationId},agentConsumptionQuery,{
            delegation:{wakeId,stepId,requestId:binding.requestId},assertAccess:()=>assertScope(binding),
            assertResult:result=>{
              if(!same({data:result.data,pagination:result.pagination},expected[type]))
                throw fail(409,assertionFailed,'原批次结果与登记的虚构证券预期不一致');
            },
          });
        } catch(error) {
          if(error.code===assertionFailed){
            store.update('agent_consumption_step',stepId,project,{failureCode:assertionFailed});
            await options.persist();
          }
          throw error;
        }
        await options.persist();
      }
      return {};
    }});
}
