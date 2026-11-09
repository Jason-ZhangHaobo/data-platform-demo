import React from 'react';
import {MessageSquareReply,Send} from 'lucide-react';
export function AgentClarificationReply({answer,onChange,onReply,disabled,reason,background}:{answer:string;onChange:(value:string)=>void;onReply:()=>void;disabled:boolean;reason?:string;
 background?:{checked:boolean;onChange:(value:boolean)=>void}}){
 return <form className="agent-dev-compose agent-clarification-compose" onSubmit={e=>{e.preventDefault();if(!disabled&&answer.trim()&&answer.length<=1000)onReply();}}>
  <label htmlFor="agent-clarification-answer"><MessageSquareReply size={15}/>回答上方澄清问题</label>
  <p>原需求、问题与代码输入会一起保留；本次创建独立后续任务，原任务及已发生用量不变。</p>
  <textarea id="agent-clarification-answer" value={answer} maxLength={1000} disabled={disabled} onChange={e=>onChange(e.target.value)} placeholder="例如：先按已登记的五项指标计算，行业分布另行补充口径。"/>
  {background&&<label className="agent-dev-consent"><input type="checkbox" checked={background.checked} disabled={disabled} onChange={e=>background.onChange(e.target.checked)}/>委托云后台推进本次开发（15分钟、最多20个事件；沿用预算，不自动发布）</label>}
  <div><small>{reason??'按当前模型与执行预算继续，不自动发布；人工澄清不计直接自主完成。'}</small>
   <button className="button primary" type="submit" disabled={disabled||!answer.trim()||answer.length>1000}><Send size={14}/>提交答复并继续开发</button></div>
 </form>;
}
