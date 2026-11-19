const uuid=v=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v),sha=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const record=v=>v&&typeof v==='object'&&!Array.isArray(v),same=(a,b)=>JSON.stringify(a,(_k,v)=>record(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v)===JSON.stringify(b,(_k,v)=>record(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
export function checkedAgentCalendarSource(taskId,source){
 const r=source?.requirementBinding;
 if(!uuid(taskId)||!record(source)||Object.keys(source).some(k=>!['revisionId','revisionHash','runId','requirementBinding'].includes(k))||!uuid(source.revisionId)||!sha(source.revisionHash)||!uuid(source.runId)||r!==undefined&&(!record(r)||Object.keys(r).length!==4||r.protocol!=='shuduo-sql-requirements/v1'||r.taskId!==taskId||!sha(r.basisDigest)||!sha(r.reportDigest)))throw Error('日历交付须绑定确切代码、需求与批次');
 return {revisionId:source.revisionId,revisionHash:source.revisionHash,runId:source.runId,...(r?{requirementBinding:{protocol:r.protocol,taskId:r.taskId,basisDigest:r.basisDigest,reportDigest:r.reportDigest}}:{})};
}
export function agentCalendarBody({taskId,source,calendarSelection}){
 const expectedSource=checkedAgentCalendarSource(taskId,source),c=calendarSelection;
 if(!record(c)||Object.keys(c).length!==2||typeof c.calendarId!=='string'||!(/^[a-z0-9-]{1,80}$/).test(c.calendarId)||!sha(c.calendarDigest))throw Error('请选择确切日历版本及摘要');
 return {expectedSource,calendarSelection:{calendarId:c.calendarId,calendarDigest:c.calendarDigest}};
}
export function checkedCalendarDelivery(value,input){
 const body=agentCalendarBody(input);
 if(!uuid(value?.id)||value.sourceAgentTaskId!==input.taskId||value.sourceRevisionId!==body.expectedSource.revisionId||value.sourceRunId!==body.expectedSource.runId||value.sourceSqlHash!==body.expectedSource.revisionHash||!same(value.sourceRequirementBinding,body.expectedSource.requirementBinding)||!same(value.calendarSelection,body.calendarSelection)||!['QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED','INTERRUPTED'].includes(value.status))throw Error('原日历交付回执与所选代码、批次或日历不一致；保留原请求编号');return value;
}
export async function prepareAgentCalendar(client,input){
 if(Object.keys(input).some(k=>!['taskId','source','calendarSelection','requestId','confirm'].includes(k))||input.confirm!==true||!uuid(input.requestId))throw Error('请确认确切来源和日历，使用稳定请求UUID');
 return checkedCalendarDelivery(await client.request(`/agent/tasks/${input.taskId}/prepare-delivery`,{method:'POST',body:agentCalendarBody(input),idempotencyKey:input.requestId}),input);
}
export function agentDeliveryWorkflowPath(taskId,deliveryId){if(!uuid(taskId)||deliveryId!==undefined&&!uuid(deliveryId))throw Error('请指定原任务和交付编号');return `/agent/tasks/${taskId}/workflow`+(deliveryId?'?deliveryId='+deliveryId:'');}
const pendingKeys=['calendar_request','calendar_agent','calendar_draft'];
export function pendingAgentCalendar(href,taskId){
 const q=new URL(href).searchParams;if(q.get('calendar_agent')!==taskId)return;
 try{const requestId=q.get('calendar_request'),body=JSON.parse(q.get('calendar_draft'));if(!uuid(requestId)||!record(body)||Object.keys(body).length!==2||!Object.hasOwn(body,'expectedSource')||!Object.hasOwn(body,'calendarSelection'))throw Error();return {taskId,requestId,body:agentCalendarBody({taskId,source:body.expectedSource,calendarSelection:body.calendarSelection})};}catch{throw Error('原日历交付恢复链接不完整；请保留原任务，不自动重提');}
}
export function agentCalendarLocation(href,pending){const url=new URL(href);url.searchParams.set('calendar_agent',pending.taskId);url.searchParams.set('calendar_request',pending.requestId);url.searchParams.set('calendar_draft',JSON.stringify(agentCalendarBody({taskId:pending.taskId,source:pending.body.expectedSource,calendarSelection:pending.body.calendarSelection})));return url.pathname+url.search+url.hash;}
export function selectedAgentDelivery(href,taskId,source){const q=new URL(href).searchParams;return (!source||q.get('delivery_revision')===source.revisionId&&q.get('delivery_run')===source.runId)&&q.get('delivery_agent')===taskId&&uuid(q.get('delivery_task'))?q.get('delivery_task'):undefined;}
export function agentDeliveryLocation(href,taskId,deliveryId,source){agentDeliveryWorkflowPath(taskId,deliveryId);const url=new URL(href);for(const k of pendingKeys)url.searchParams.delete(k);url.searchParams.set('delivery_agent',taskId);url.searchParams.set('delivery_task',deliveryId);if(source){url.searchParams.set('delivery_revision',source.revisionId);url.searchParams.set('delivery_run',source.runId);}return url.pathname+url.search+url.hash;}

export function leaveAgentCalendarRecovery(href){const url=new URL(href);for(const k of [...pendingKeys,'delivery_agent','delivery_task','delivery_revision','delivery_run'])url.searchParams.delete(k);return url.pathname+url.search+url.hash;}

export function agentCalendarRequestWorkflowPath(taskId,requestId){agentDeliveryWorkflowPath(taskId);if(!uuid(requestId))throw Error('请使用原日历准备请求UUID');return `/agent/tasks/${taskId}/workflow?requestId=${requestId}`;}
