import {useEffect,useRef,useState} from 'react';
import {agentConsumptionPath,agentConsumptionReceiptPath,readAgentConsumption} from '../../src/v2/agent-consumption-request.mjs';
import type {AgentConsumptionInput} from '../../src/v2/agent-consumption-request.mjs';
import {agentConsumptionLocation,agentConsumptionRequestMarker,checkedAgentConsumptionReceipt} from './agent-consumption-view';
import {applicationStatusText} from './service-consumption-scope';
import type {agentConsumptionTarget} from './agent-consumption-view';
import './agent-development.css';

type Target=NonNullable<ReturnType<typeof agentConsumptionTarget>>;
type Api=<T>(path:string,body?:unknown,options?:{idempotencyKey?:string})=>Promise<T>;
type InChat={requestId?:string;source:AgentConsumptionInput['sourceBinding'];pin:(key:string)=>void;
  requestKey:(input:AgentConsumptionInput)=>Promise<string>;beforeWrite:()=>Promise<void>;afterRead:()=>void};
const messages={DELIVERY_UNKNOWN:'委托送达待确认。',QUEUED:'已提交后台委托，等待原接口回执。',
  RESULT_UNCONFIRMED:'部分结果尚待核对。',COMPLETED:'原 DAPI 与 XAPI 调用已核验。',FAILED:'原委托未通过业务断言。'};

export default function AgentConsumptionPanel({api,target,readOnlySelection,canAct=false,applicationStatus,inChat}:
  {api:Api;target?:Target;readOnlySelection?:AgentConsumptionInput;canAct?:boolean;applicationStatus?:string;inChat?:InChat}) {
  const initial=useRef(inChat?inChat.requestId:agentConsumptionRequestMarker(location.href));
  const [requestId,setRequestId]=useState(initial.current);
  const [receipt,setReceipt]=useState<ReturnType<typeof checkedAgentConsumptionReceipt>>();
  const [confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [missing,setMissing]=useState(false);
  const epoch=useRef(0),inFlight=useRef(false);
  const selection=readOnlySelection??target?.input;

  function start(){const sequence=++epoch.current;inFlight.current=true;setBusy(true);setError('');return sequence;}
  function finish(sequence:number){if(sequence===epoch.current){inFlight.current=false;setBusy(false);}}
  async function read(key:string,sequence:number,refresh=false) {
    try {
      const value=checkedAgentConsumptionReceipt(await api(agentConsumptionReceiptPath(key)),key,selection);
      if(inChat&&Object.entries(inChat.source).some(([k,v])=>value.sourceBinding[k as keyof typeof value.sourceBinding]!==v))
        throw Object.assign(Error(),{code:'AGENT_CONSUMPTION_SCOPE_MISMATCH'});
      if(sequence===epoch.current){setMissing(false);setReceipt(value);if(refresh)inChat?.afterRead();}
    } catch(cause) {
      if(sequence!==epoch.current)return;
      setReceipt(undefined);
      const {status,code}=(cause??{}) as {status?:number;code?:string};
      const originalKey=status===404&&inChat&&target?await inChat.requestKey(target.input):undefined;
      if(sequence!==epoch.current)return;
      setMissing(Boolean(originalKey===key));
      setError(code==='AGENT_CONSUMPTION_SCOPE_MISMATCH'?'回执与所选发布批次、应用或接口版本不一致。':
        status===401?'登录原受邀账号后可查询此回执。':status===404?'当前账号尚未查到该原委托。可按同一编号再次核对。':'暂时无法核对原回执，请重新读取。');
    } finally {finish(sequence);}
  }
  useEffect(()=>{
    if(initial.current&&(selection||inChat))void read(initial.current,start());
    return()=>{epoch.current++;inFlight.current=false;};
  },[]);

  async function submit(){
    const retry=inChat&&(missing||receipt?.state==='DELIVERY_UNKNOWN');
    if(!target||!canAct||!confirmed||requestId!==undefined&&!retry||inFlight.current)return;
    const sequence=start();
    let writtenKey:string|undefined;
    try{
      const key=requestId??(inChat?await inChat.requestKey(target.input):crypto.randomUUID());
      const body=readAgentConsumption(target.input,key);
      if(inChat){await inChat.beforeWrite();if(sequence!==epoch.current)return;inChat.pin(key);}
      else history.replaceState(history.state,'',agentConsumptionLocation(location.href,key));
      writtenKey=key;
      setRequestId(key);
      const value=checkedAgentConsumptionReceipt(await api(agentConsumptionPath,body,{idempotencyKey:key}),key,body);
      if(sequence===epoch.current){setReceipt(value);setMissing(false);setConfirmed(false);inChat?.afterRead();}
    }catch(cause){
      if(sequence===epoch.current){
        if(writtenKey){await read(writtenKey,sequence,true);return;}
        setError(inChat?(cause as Error).message:'无法保存原请求编号，请重新打开此批次。');
      }
    }finally{finish(sequence);}
  }

  const source=receipt??selection;
  return <section id="agent-consumption-receipt" className="agent-delivery-panel" aria-label="Agent 消费核验">
    <header><strong>{target?'Agent 消费核验':'Agent 消费回执'}</strong>{!target&&<small>只读</small>}</header>
    {source&&<dl className="delivery-review-source">
      <dt>发布</dt><dd>{source.sourceBinding.releaseId}</dd>
      <dt>批次</dt><dd>{source.sourceBinding.sourceReleaseRunId}</dd>
      <dt>授权应用</dt><dd>{target ? `${target.applicationName} · ${applicationStatusText(applicationStatus??'')}` : source.applicationId}</dd>
      <dt>DAPI 版本</dt><dd>{target&&`${target.dapiName} · `}{source.dapiVersionId}</dd>
      <dt>XAPI 版本</dt><dd>{target&&`${target.xapiName} · `}{source.xapiVersionId}</dd>
      {typeof requestId==='string'&&<><dt>原请求</dt><dd>{requestId}</dd></>}
    </dl>}
    {requestId===null&&<p role="alert">回执地址中的请求编号无效。</p>}
    {busy?<p role="status">正在核对原委托…</p>:error?<p role="alert">{error}</p>:receipt?<p role="status">{messages[receipt.state]}</p>:null}
    {receipt?.calls.length? <ul className="agent-dev-attempts">{receipt.calls.map(call=><li key={call.callIdDigest}>
      <strong>{call.type} · {call.rowCount} 行</strong><code>调用摘要 {call.callIdDigest}</code>
    </li>)}</ul>:null}
    {target&&(requestId===undefined||inChat&&(missing||receipt?.state==='DELIVERY_UNKNOWN'))&&<>
      <label><input type="checkbox" disabled={!canAct||busy} checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/>
        允许 Agent 对上述 DAPI 和 XAPI 各查询一次。</label>
      <div className="agent-delivery-actions"><button className="button primary" type="button" disabled={!confirmed||!canAct||busy} onClick={()=>void submit()}>
        {requestId?'按原编号继续委托':'委托 Agent 消费'}
      </button></div>
    </>}
    {typeof requestId==='string'&&(selection||inChat)&&<div className="agent-delivery-actions">
      <button className="button" type="button" disabled={busy} onClick={()=>{if(!inFlight.current)void read(requestId,start(),true);}}>核对原委托</button>
      {target&&!inChat&&<a className="button" href={agentConsumptionLocation(location.href,requestId,target.input).href}>打开只读回执</a>}
    </div>}
  </section>;
}
