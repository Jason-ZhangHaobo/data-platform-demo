import { useMemo, useState } from "react";
import { Download } from "lucide-react";

type Request = {kind:"recovery";type:"dapi"|"xapi";id:string} | {kind:"consumption";id:string;digest:string};
export function evidenceExportHref(request: Request): string {
  const query = new URLSearchParams(request);
  return `/api/v2/evidence-export?${query}`;
}

// A click requests a download; browsers do not confirm that a file was saved.
// Keep the anchor connected and the object URL alive long enough for Safari.
export function requestTextDownload(name: string, body: string, type = "application/json;charset=utf-8"): void {
  let url: string | undefined;
  let link: HTMLAnchorElement | undefined;
  try {
    url = URL.createObjectURL(new Blob([body], { type }));
    link = document.createElement("a");
    link.href = url; link.download = name; link.hidden = true;
    document.body.appendChild(link);
    link.click();
  } finally {
    try { link?.remove(); }
    finally { if (url) { const ownedUrl = url; setTimeout(() => URL.revokeObjectURL(ownedUrl), 60_000); } }
  }
}

export function EvidenceDownload({name,value,request,children}:{name:string;value:unknown;request:Request;children:string}) {
  const [notice,setNotice] = useState("");
  const body = useMemo(() => {
    try { const text = JSON.stringify(value, null, 2); return text === undefined ? undefined : text + "\n"; }
    catch { return undefined; }
  }, [value]);
  const privatePreview = typeof document !== "undefined" && document.querySelector('meta[name="shuduo-private-preview"]')?.getAttribute("content") === "true";
  return <div className="evidence-download">
    {privatePreview ? <a className="button" href={evidenceExportHref(request)} download={name} target="_blank" rel="noopener noreferrer" onClick={()=>setNotice("已请求保存实时只读报告，请核对浏览器下载列表；没有文件不算导出完成。也可展开下方本页报告文本。")}><Download size={14}/>{children}</a>
      : <button className="button" disabled={body === undefined} onClick={()=>{
        if (body === undefined) return;
        try { requestTextDownload(name, body); setNotice("已请求浏览器保存，请核对下载列表；没有文件不算导出完成。也可展开下方本页报告文本。"); }
        catch { setNotice("未确认保存，报告仍保留在下方文本中；不会重新运行任务或创建凭证。"); }
      }}><Download size={14}/>{children}</button>}
    {notice&&<small role="status">{notice}</small>}
    <details className="evidence-text">
      <summary>下载没有反应？查看报告文本</summary>
      <p>以下是本页已读取的报告快照；展开不会请求接口、重新计算或创建凭证。报告可能包含私有任务、版本和应用标识，请勿公开。</p>
      {body === undefined ? <p role="status">报告文本暂不可用，请返回原位置刷新只读证据；不会自动重跑任务。</p>
        : <pre tabIndex={0} aria-label={`${name} 报告文本`}>{body}</pre>}
    </details>
  </div>;
}
