import {RefreshCw} from "lucide-react";
export function AgentSubmissionRecovery({requestKey,recoveryHref,canRetry,busy,onRead,onRetry}:{requestKey:string;recoveryHref:string;canRetry:boolean;busy:boolean;onRead:()=>void;onRetry:()=>void}){
  return <div className="agent-dev-alert agent-submission-recovery" role="status" aria-label="原Agent提交恢复">
    <div><strong>Agent 提交结果待确认</strong><p>恢复编号：{requestKey}。查询不会重发需求或调用模型；请使用原创建账号。</p>
      <p>{canRetry?"原提交内容仍在本页。重试会先查询，必要时只按原内容和原编号提交，不使用当前的新修改。":"刷新后仅保留恢复编号，未保存的需求和代码无法从链接找回；不会自动重发。"}</p>
      <a href={recoveryHref} target="_blank" rel="noopener noreferrer">原请求恢复链接</a> · <a href="/v2/?module=agent-center" target="_blank" rel="noopener noreferrer">另开工作台查看其他任务</a>
    </div>
    <div><button className="button" disabled={busy} onClick={onRead}><RefreshCw size={14}/>查询原任务</button>
      {canRetry&&<button className="button" disabled={busy} onClick={onRetry}>按原内容、原编号重试</button>}
    </div>
  </div>;
}
