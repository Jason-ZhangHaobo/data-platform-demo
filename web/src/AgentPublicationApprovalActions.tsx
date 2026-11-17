import React, {useEffect,useRef,useState} from "react";
import {publicationRequestReceiptPath} from "../../src/v2/publication-request.mjs";
import {checkedExactPublicationApproval,checkedExactPublicationReceipt} from "./agent-delivery-evidence-read";
import type {ExactPublicationSource} from "./agent-delivery-evidence-read";

type Approval = ReturnType<typeof checkedExactPublicationApproval>;
type ApprovalState = {phase:"LOADING"|"READY"|"SENDING"|"UNKNOWN"|"RELEASED"; approval?:Approval; message?:string};
type Props = {
  requestId:string;
  expected:ExactPublicationSource;
  window:{startsAt:string;expiresAt:string};
  disabled:boolean;
  confirmed:boolean;
  api:<T>(path:string,body?:unknown,options?:{idempotencyKey?:string})=>Promise<T>;
  beforeWrite:()=>Promise<void>;
  onSaved:()=>void;
  onReleased:(releaseId:string)=>void;
  onClose:()=>void;
};

export function AgentPublicationApprovalActions({requestId,expected,window,disabled,confirmed,api,beforeWrite,onSaved,onReleased,onClose}:Props) {
  const [state,setState]=useState<ApprovalState>({phase:"LOADING"});
  const epoch=useRef(0), busy=useRef(false);
  const path=publicationRequestReceiptPath(expected.taskId,requestId);

  async function read(approval?:Approval) {
    const current=++epoch.current;
    setState({phase:"LOADING",approval});
    try {
      const value=await api<{protocol?:string}>(path);
      if (epoch.current!==current) return;
      if (value?.protocol==="shuduo-cloud-publication-receipt/v1") {
        const releaseId=checkedExactPublicationReceipt(value,expected,approval?.approvalId);
        setState({phase:"RELEASED"}); onReleased(releaseId);
      } else {
        const saved=checkedExactPublicationApproval(value,expected,window);
        if (approval && approval.approvalId!==saved.approvalId) throw Error("原批准编号发生变化。");
        setState({phase:"READY",approval:saved});
        onSaved();
      }
    } catch (cause) {
      if (epoch.current!==current) return;
      if ((cause as {status?:number}).status===404 && !approval) setState({phase:"READY"});
      else setState({phase:"UNKNOWN",approval,message:"未能核对原请求。请重新读取回执。"});
    }
  }
  useEffect(()=>{void read();return()=>{epoch.current++;};},[path]);

  async function submit() {
    const approval=state.approval;
    if (busy.current || disabled || state.phase!=="READY" || !approval&&!confirmed) return;
    busy.current=true;
    const current=++epoch.current;
    setState({phase:"SENDING",approval});
    try {
      await beforeWrite();
      if (epoch.current!==current) return;
      const value=await api(`/agent/tasks/${expected.taskId}/publication`,{
        sourceKind:"AGENT",sourceRunId:expected.runId,packageDigest:expected.packageDigest,verificationId:expected.verificationId,
        reviewDigest:expected.reviewDigest,attestations:{code:true,assertions:true,deliveryFiles:true,cloudScope:true},
        ...(approval?{approvalId:approval.approvalId}:{approvalOnly:true})
      },{idempotencyKey:requestId});
      if (epoch.current!==current) return;
      if (approval) {
        const releaseId=checkedExactPublicationReceipt(value,expected,approval.approvalId);
        setState({phase:"RELEASED"}); onReleased(releaseId);
      } else {
        setState({phase:"READY",approval:checkedExactPublicationApproval(value,expected,window)});
        onSaved();
      }
    } catch (cause) {
      if (epoch.current===current) setState({phase:"UNKNOWN",approval,message:`${(cause as Error).message} 请先核对原请求回执。`});
    } finally {busy.current=false;}
  }

  const approval=state.approval;
  return <>
    <p role={state.message?"alert":"status"}>{state.message??(state.phase==="LOADING"?"正在读取原请求回执…":
      state.phase==="SENDING"?(approval?"正在发起原批准的测试发布…":"正在保存确切批准…"):
      state.phase==="RELEASED"?"已确认原发布，正在读取批次…":
      approval?<>批准已保存 · 尚未发起测试发布。<br/>批准编号 {approval.approvalId}</>:"先保存此版本的批准，再单独发起两个测试批次。")}</p>
    <div className="agent-delivery-actions">
      {state.phase==="UNKNOWN"? <button className="button" type="button" onClick={()=>void read(approval)}>核对原请求回执</button>:
        <button className="button primary" type="button" disabled={disabled||state.phase!=="READY"||!approval&&!confirmed} onClick={()=>void submit()}>
          {approval?"使用原批准发起测试发布":"保存此版本的批准"}
        </button>}
      <button className="button" type="button" disabled={state.phase==="SENDING"} onClick={onClose}>关闭审阅</button>
    </div>
  </>;
}
