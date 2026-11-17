import {useEffect,useRef,useState} from 'react';
import {agentConsumptionPath,agentConsumptionReceiptPath,readAgentConsumption} from '../../src/v2/agent-consumption-request.mjs';
import {agentConsumptionLocation,agentConsumptionRequestMarker,checkedAgentConsumptionReceipt} from './agent-consumption-view';
import {applicationStatusText} from './service-consumption-scope';
import type {agentConsumptionTarget} from './agent-consumption-view';
import './agent-development.css';

type Target=NonNullable<ReturnType<typeof agentConsumptionTarget>>;
type Api=<T>(path:string,body?:unknown,options?:{idempotencyKey?:string})=>Promise<T>;
const messages={DELIVERY_UNKNOWN:'委托送达待确认。',QUEUED:'已提交后台委托，等待原接口回执。',
  RESULT_UNCONFIRMED:'部分结果尚待核对。',COMPLETED:'原 DAPI 与 XAPI 调用已核验。',FAILED:'原委托未通过业务断言。'};

export default function AgentConsumptionPanel({api,target,canAct=false,applicationStatus}:{api:Api;target?:Target;canAct?:boolean;applicationStatus?:string}) {
  const initial=useRef(agentConsumptionRequestMarker(location.href));
  const [requestId,setRequestId]=useState(initial.current);
  const [receipt,setReceipt]=useState<ReturnType<typeof checkedAgentConsumptionReceipt>>();
  const [confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const epoch=useRef(0),inFlight=useRef(false);

  function start(){const sequence=++epoch.current;inFlight.current=true;setBusy(true);setError('');return sequence;}
  function finish(sequence:number){if(sequence===epoch.current){inFlight.current=false;setBusy(false);}}
  async function read(key:string,sequence:number) {
    try {
      const value=checkedAgentConsumptionReceipt(await api(agentConsumptionReceiptPath(key)),key,target?.input);
      if(sequence===epoch.current)setReceipt(value);
    } catch(cause) {
      if(sequence!==epoch.current)return;
      setReceipt(undefined);
      const {status}=(cause??{}) as {status?:number};
      setError(status===401?'登录原受邀账号后可查询此回执。':status===404?'当前账号尚未查到该原委托。可按同一编号再次核对。':'暂时无法核对原回执，请重新读取。');
    } finally {finish(sequence);}
  }
  useEffect(()=>{
    if(initial.current)void read(initial.current,start());
    return()=>{epoch.current++;inFlight.current=false;};
  },[]);

  async function submit(){
    if(!target||!canAct||!confirmed||requestId!==undefined||inFlight.current)return;
    const key=crypto.randomUUID(),sequence=start();
    try{
      const body=readAgentConsumption(target.input,key);
      history.replaceState(history.state,'',agentConsumptionLocation(location.href,key));
      setRequestId(key);
      const value=checkedAgentConsumptionReceipt(await api(agentConsumptionPath,body,{idempotencyKey:key}),key,body);
      if(sequence===epoch.current)setReceipt(value);
    }catch{
      if(sequence===epoch.current){
        if(agentConsumptionRequestMarker(location.href)===key){await read(key,sequence);return;}
        setError('无法保存原请求编号，请重新打开此批次。');
      }
    }finally{finish(sequence);}
  }

  const source=receipt??target?.input;
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
    {target&&requestId===undefined&&<>
      <label><input type="checkbox" disabled={!canAct||busy} checked={confirmed} onChange={event=>setConfirmed(event.target.checked)}/>
        允许 Agent 对上述 DAPI 和 XAPI 各查询一次。</label>
      <div className="agent-delivery-actions"><button className="button primary" type="button" disabled={!confirmed||!canAct||busy} onClick={()=>void submit()}>
        委托 Agent 消费
      </button></div>
    </>}
    {typeof requestId==='string'&&<div className="agent-delivery-actions">
      <button className="button" type="button" disabled={busy} onClick={()=>{if(!inFlight.current)void read(requestId,start());}}>核对原委托</button>
      {target&&<a className="button" href={agentConsumptionLocation(location.href,requestId,true).href}>打开只读回执</a>}
    </div>}
  </section>;
}
