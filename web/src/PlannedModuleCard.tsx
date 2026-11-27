import {ArrowRight,Circle} from 'lucide-react';

export default function PlannedModuleCard({active,services,onDevelop}:{active?:{stage:string;name:string;features:string[]};services:boolean;onDevelop:()=>void}){
  return <div className="stage-card">
    <span className="stage-label">{active?.stage} · 已纳入新版计划</span>
    <h2>{services?"让业务数据成为可调用的服务":"让 "+active?.name+" 与 Agent 协同工作"}</h2>
    <p>{services?"DAPI 通过参数化 SQL 提供查询；XAPI 编排多个查询和接口。发布、授权、版本和监控共同建设。":"该模块将与代码工作台共用项目上下文、资源模型与运行记录。当前显示规划范围，未宣称已具备实际执行能力。"}</p>
    <div className="feature-list">{active?.features.map(feature=><div key={feature}><Circle size={13}/>{feature}</div>)}</div>
    <button className="button primary" onClick={onDevelop}>体验已实现的代码工作台<ArrowRight size={15}/></button>
  </div>;
}
