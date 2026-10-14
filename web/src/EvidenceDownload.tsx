import { useState } from "react";
import { Download } from "lucide-react";

type Request = {kind:"recovery";type:"dapi"|"xapi";id:string} | {kind:"consumption";id:string;digest:string};
export function evidenceExportHref(request: Request): string {
  const query = new URLSearchParams(request);
  return `/api/v2/evidence-export?${query}`;
}

export function EvidenceDownload({name,value,request,children}:{name:string;value:unknown;request:Request;children:string}) {
  const [notice,setNotice] = useState("");
  const privatePreview = document.querySelector('meta[name="shuduo-private-preview"]')?.getAttribute("content") === "true";
  if(privatePreview) return <span className="evidence-download"><a className="button" href={evidenceExportHref(request)} download={name} target="_blank" rel="noopener noreferrer" onClick={()=>setNotice("已请求保存实时只读报告，请核对浏览器下载列表；没有文件不算导出完成。")}><Download size={14}/>{children}</a>{notice&&<small role="status">{notice}</small>}</span>;
  return <span className="evidence-download"><button className="button" onClick={()=>{
    let url: string | undefined;
    try {
      const body=JSON.stringify(value,null,2)+"\n";
      url=URL.createObjectURL(new Blob([body],{type:"application/json;charset=utf-8"}));
      const link=document.createElement("a");link.href=url;link.download=name;link.hidden=true;
      document.body.appendChild(link);
      try{link.click();}finally{link.remove();}
      const ownedUrl=url;setTimeout(()=>URL.revokeObjectURL(ownedUrl),60000);
      setNotice("已请求浏览器保存，请核对下载列表；没有文件不算导出完成。");
    }catch{if(url)URL.revokeObjectURL(url);setNotice("未确认保存，请保留当前报告并重试；不会重新运行任务。");}
  }}><Download size={14}/>{children}</button>{notice&&<small role="status">{notice}</small>}</span>;
}
