import {agentConsumptionPath,agentConsumptionReceiptPath} from '../../src/v2/agent-consumption-request.mjs';
import {reportEvidenceDigest} from '../../src/v2/report-provenance-client.mjs';
import {checkedAgentConsumptionReceipt} from './agent-consumption-view.ts';
import {invitedConsumptionRequestId,issueInvitedApplication,readInvitedServiceCatalog,type Api,type Scope,type Source} from './invited-batch-services.ts';

const bad=()=>Error('分页数据、接口版本或授权回执未通过原批次核对。');
const record=(v:unknown):v is Record<string,unknown>=>Boolean(v&&typeof v==='object'&&!Array.isArray(v));
const uuid=(v:unknown)=>typeof v==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v);
const isSlug=(v:string)=>/^[a-z][a-z0-9-]{2,47}$/.test(v);
export function invitedPagePlan(total?:number){
  if(total===undefined||!Number.isSafeInteger(total)||total<1||total>100)return;
  const pageSize=Math.ceil(total/2);
  return {total,pageSize,totalPages:Math.ceil(total/pageSize)};
}
type PagePlan=NonNullable<ReturnType<typeof invitedPagePlan>>;
export function checkedConsumerPage(value:unknown,binding:{type:string;id:string;versionId:string;slug:string},page:number,plan:PagePlan){
  const expectedCount=Math.min(plan.pageSize,plan.total-(page-1)*plan.pageSize);
  if(!record(value)||value.scope!=='PRIVATE_CLOUD_TEST'||value.localTestOnly!==false||!uuid(value.callId)||
    !record(value.service)||!Object.entries(binding).every(([k,v])=>v===(value.service as Record<string,unknown>)[k])||
    !Number.isSafeInteger(page)||page<1||page>plan.totalPages||!Array.isArray(value.data)||value.data.length!==expectedCount||
    !value.data.every(record)||!record(value.pagination)||value.pagination.page!==page||value.pagination.pageSize!==plan.pageSize||
    value.pagination.total!==plan.total||value.pagination.totalPages!==plan.totalPages)throw bad();
  return {rows:value.data as Record<string,unknown>[],steps:value.service.steps,callId:value.callId as string};
}
export async function runInvitedConsumptionPages(api:Api,scope:Scope,source:Source,batchId:string,
  assertOpen:()=>void,pin:(key:string)=>void,progress:(message:string)=>void){
  const current=await readInvitedServiceCatalog(api,scope,source,batchId);
  const pages=invitedPagePlan(current.rowCount);
  if(!pages||current.target||![scope.plan.dapis[0],scope.plan.xapi].every(s=>isSlug(s.slug)&&s.rateLimitPerMinute>=pages.totalPages+1))
    throw Error('分页核验需要 1–100 行发布结果、尚未签发的应用，以及足够完成签名与分页查询的调用限额。');
  if(location.protocol!=='https:'&&!['localhost','127.0.0.1','[::1]'].includes(location.hostname))
    throw Error('此入口无法通过加密连接核验测试应用。');
  const {applicationId,token}=await issueInvitedApplication(api,scope,source,batchId,assertOpen);
  if(!token)throw Error('一次性凭证未随本次签发返回。请核对原应用，可继续签名委托或撤销授权。');
  const pathname=(type:string)=>'/api/v2/open/'+(type==='DAPI'?'dapis/'+scope.plan.dapis[0].slug:'xapis/'+scope.plan.xapi.slug);
  const request=(type:string,page:number)=>{
    assertOpen();
    return fetch(pathname(type)+'?page='+page+'&page_size='+pages.pageSize,{credentials:'omit',mode:'same-origin',redirect:'error',cache:'no-store',
      referrerPolicy:'no-referrer',headers:{Authorization:'Bearer '+token},signal:AbortSignal.timeout(8000)});
  };
  const result:{clientId:string;assets?:string}[]=[];
  try{
    const catalog=await readInvitedServiceCatalog(api,scope,source,batchId);
    if(!catalog.grantCurrent||!catalog.target||catalog.target.application.id!==applicationId)throw bad();
    const input=catalog.target.input;
    const requestId=await invitedConsumptionRequestId(input);
    assertOpen();pin(requestId);progress('已签发本批应用，正在核对原签名委托。');
    let raw:unknown;
    try{raw=await api(agentConsumptionPath,input,{idempotencyKey:requestId});}
    catch{raw=await api(agentConsumptionReceiptPath(requestId));}
    let receipt=checkedAgentConsumptionReceipt(raw,requestId,input);
    for(const delay of [750,1500,3000,5000,8000,12000,15000,15000]){
      if(receipt.state==='COMPLETED')break;
      if(receipt.state==='FAILED'||receipt.state==='DELIVERY_UNKNOWN')throw Error('原委托尚未确认完成，请按原编号核对。');
      await new Promise(resolve=>setTimeout(resolve,delay));assertOpen();
      receipt=checkedAgentConsumptionReceipt(await api(agentConsumptionReceiptPath(requestId)),requestId,input);
    }
    if(receipt.state!=='COMPLETED')throw Error('本次等待已结束，可按原编号读取后台结果。');
    const callIds=new Set<string>();
    for(const call of receipt.calls){
      const service=catalog.services.find(s=>s.id===call.serviceId&&s.publishedVersion?.id===call.versionId);
      if(!service||call.rowCount!==pages.total)throw bad();
      const type=service.serviceType,binding={type,id:service.id,slug:service.slug,versionId:call.versionId};
      const rows=[];
      for(let page=1;page<=pages.totalPages;page++){
        progress('正在核对 '+type+' 第 '+page+' 页。');
        const response=await request(type,page);
        if(response.status!==200)throw Error(type+' 第 '+page+' 页返回 HTTP '+response.status+'。');
        const checked=checkedConsumerPage(await response.json(),binding,page,pages);
        if(callIds.has(checked.callId)||type==='XAPI'&&await reportEvidenceDigest(checked.steps??null)!==await reportEvidenceDigest(service.publishedVersion?.steps))throw bad();
        callIds.add(checked.callId);rows.push(...checked.rows);
      }
      if(rows.length!==call.rowCount||await reportEvidenceDigest(rows)!==call.rowsDigest)throw bad();
      if(type==='XAPI')for(const row of rows){
        const aliases=scope.plan.xapi.steps.map(s=>row[s.alias]).filter(record);
        const amount=aliases.map(v=>v.total_assets).find(v=>typeof v==='string');
        result.push({clientId:String(row.client_id),...(typeof amount==='string'?{assets:amount}:{})});
      }
    }
  }finally{
    // This request may have been revoked in another tab. Verify the same
    // grant before cleanup and never issue another application after a loss.
    assertOpen();
    const revoked=await api<{id:string;status:string}>('/data-services/applications/'+applicationId+'/revoke',{});
    if(revoked.id!==applicationId||revoked.status!=='REVOKED')throw Error('原应用的撤销回执待核对。');
  }
  const denied=await request('DAPI',1);
  if(denied.status!==401||!/^application\/json\b/i.test(denied.headers.get('content-type')??''))throw Error('应用已撤销，旧凭证的拒绝应答待核对。');
  const denial=await denied.json();
  if(denial?.code!=='TOKEN_INVALID'||Object.hasOwn(denial,'data'))throw Error('应用已撤销，旧凭证的拒绝原因待核对。');
  return result;
}
