import {useEffect,useRef,useState} from "react";
import {checkedFrozenAssetQuality,frozenQualityPath,frozenQualityRules,readFrozenAssetQuality} from "../../src/v2/frozen-asset-quality-client.mjs";
import type {FrozenAssetQuality,FrozenQualitySource} from "../../src/v2/frozen-asset-quality-client.mjs";

type Api=<T>(path:string,body?:unknown)=>Promise<T>;

export function FrozenAssetQualityPanel({api,source,canWrite,initiallyOpen=false}:
  {api:Api;source:FrozenQualitySource;canWrite:boolean;initiallyOpen?:boolean}) {
  const {assetId,batchId,releaseId,snapshotHash,evidenceHash,rowCount}=source;
  const [open,setOpen]=useState(initiallyOpen),[cycle,setCycle]=useState(0);
  const [result,setResult]=useState<FrozenAssetQuality>(),[error,setError]=useState("");
  const [busy,setBusy]=useState(false),generation=useRef(0),inFlight=useRef(false);
  useEffect(()=>{
    if(!open)return;
    const current=++generation.current;
    setResult(undefined);setError("");setBusy(false);
    void readFrozenAssetQuality({request:path=>api(path)},{assetId,batchId,releaseId,snapshotHash,evidenceHash,rowCount}).then(
      value=>{if(generation.current===current)setResult(value);},
      cause=>{if(generation.current===current)setError((cause as Error).message);},
    );
    return()=>{generation.current++;inFlight.current=false;};
  },[api,assetId,batchId,releaseId,snapshotHash,evidenceHash,rowCount,open,cycle]);
  async function run() {
    if(!canWrite||!open||result?.status!=="PENDING"||inFlight.current)return;
    const current=generation.current,basisDigest=result.basisDigest;
    inFlight.current=true;setBusy(true);setError("");
    try{
      const value=checkedFrozenAssetQuality(await api(frozenQualityPath(assetId),{confirm:true,basisDigest}),source);
      if(value.status==="PENDING"||value.basisDigest!==basisDigest)throw Error("原质量回执未确认");
      if(generation.current===current)setResult(value);
    }catch{
      if(generation.current===current){
        setResult(undefined);
        setError("未确认检测回执。请先重新读取原回执。");
      }
    }finally{
      if(generation.current===current){inFlight.current=false;setBusy(false);}
    }
  }
  return <section className="lineage-boundary-v2" aria-label="原批次质量回执">
    <div>
      <h4>原批次质量</h4>
      <button className="button" type="button" aria-expanded={open} onClick={()=>setOpen(value=>!value)} disabled={busy}>{open?"收起质量回执":"查看原批次质量"}</button>
      {open&&<>
        {!result&&!error&&<p role="status">正在读取原批次质量回执…</p>}
        {error&&<p role="alert">{error}</p>}
        {result&&<>
          <p>批次 <code title={result.batchId}>{result.batchId.slice(0,8)}</code> · {result.rowCount} 行 · 规则 {result.ruleSet}</p>
          <ul>{frozenQualityRules().map((rule,index)=>{
            const check=result.status==="PENDING"?undefined:result.checks[index];
            return <li key={rule.id}>{rule.name}{check&&<strong> · {check.status==="PASSED"?"通过":"未通过"} {check.passedCount}/{check.evaluatedCount} 行</strong>}</li>;
          })}</ul>
          <p role="status">{result.status==="PENDING"?"原批次尚无质量回执":result.status==="PASSED"?"原批次质量检测通过":"原批次质量检测未通过"}</p>
          {result.status==="PENDING"&&canWrite&&<button className="button" disabled={busy} onClick={()=>void run()}>{busy?"正在检测…":"确认检测原批次"}</button>}
          {result.status!=="PENDING"&&<small>回执 <code title={result.checkId}>{result.checkId.slice(0,8)}</code></small>}
        </>}
        {(result||error)&&<button className="button" disabled={busy} onClick={()=>setCycle(value=>value+1)}>重新读取质量回执</button>}
      </>}
    </div>
  </section>;
}
