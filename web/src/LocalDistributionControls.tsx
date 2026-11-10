import React,{useRef,useState} from 'react';
import type {RollbackTarget} from './agent-delivery-evidence-read';
type Release={id:string;status:string;packageDigest?:string;rolledBackToTaskId?:string};
type Api=<T>(path:string,body?:unknown,options?:{idempotencyKey?:string})=>Promise<T>;
export function LocalDistributionControls({api,release,targets,canWrite,ready,canRollback,onRefresh}:{api:Api;release:Release;targets:RollbackTarget[];canWrite:boolean;ready:boolean;canRollback:boolean;onRefresh:()=>Promise<unknown>}){
 const [selected,setSelected]=useState(''),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[unknown,setUnknown]=useState<'stop'|'rollback'>();
 const rollbackRequest=useRef<{body:unknown;key:string}|undefined>(undefined);
 const active=release.status==='ACTIVE_LOCAL',target=targets.find(t=>t.id===selected);
 async function stop(){
  if(!canWrite||!ready||!active||busy||!release.packageDigest)return;setBusy(true);setError('');
  try{
   if(unknown){const current=await api<Release>(`/releases/${release.id}`);if(current.id!==release.id||current.packageDigest!==release.packageDigest)throw Error('原发布来源未确认');await onRefresh();if(current.status!=='ACTIVE_LOCAL'){setUnknown(undefined);return;}}
   await api(`/releases/${release.id}/cancel`,{packageDigest:release.packageDigest});await onRefresh();setUnknown(undefined);
  }catch(e){setUnknown('stop');setError((e as Error).message+' 停止结果未确认；先刷新这个发布，不重新发布。');}finally{setBusy(false);}
 }
 async function rollback(){
  if(!canWrite||!ready||!canRollback||!active||busy||!target||!confirmed)return;setBusy(true);setError('');
  rollbackRequest.current??={key:crypto.randomUUID(),body:{targetReleaseId:target.id,reason:'工程师确认恢复同族已验证历史版本',distributionRollback:{scope:'LOCAL_TEST_RELEASE',targetPackageDigest:target.packageDigest,metadataHash:target.metadataHash,confirmFrozenFictionalData:true}}};
  try{
   if(unknown){const current=await api<Release>(`/releases/${release.id}`);if(current.id!==release.id||current.packageDigest!==release.packageDigest)throw Error('原发布来源未确认');await onRefresh();if(current.status!=='ACTIVE_LOCAL'){setUnknown(undefined);return;}}
   const request=rollbackRequest.current;await api(`/releases/${release.id}/rollback`,request.body,{idempotencyKey:request.key});await onRefresh();setUnknown(undefined);
  }catch(e){setUnknown('rollback');setError((e as Error).message+' 回滚结果未确认；只读刷新后按原编号恢复，不创建新的恢复批次。');}finally{setBusy(false);}
 }
 return <section className="agent-verification-card local-distribution-controls" aria-label="本机分布发布控制"><h4>本机测试控制</h4>
  <p>停止只影响此发布的后续批次。回滚须选择同一分布契约的健康历史包，并重新验证两个冻结批次；验证成功后才解除原失败告警。</p>
  {active&&<button className="button" disabled={!canWrite||!ready||busy} onClick={()=>void stop()}>停止此本机测试发布</button>}
  {active&&<><label>恢复目标<select aria-label="分布回滚目标" value={selected} disabled={!canWrite||!ready||!canRollback||busy||!targets.length||Boolean(unknown)} onChange={e=>{setSelected(e.target.value);setConfirmed(false);rollbackRequest.current=undefined;}}><option value="">{targets.length?'请选择已验证历史版本':'暂无同族健康历史版本'}</option>{targets.map(t=><option key={t.id} value={t.id}>版本 {t.sourceRevisionId.slice(0,8)} · 成功批次 {t.successfulRunCount} · 包 {t.packageDigest.slice(0,8)}</option>)}</select></label>
   <label className="agent-file-review-check"><input type="checkbox" checked={confirmed} disabled={!target||!canWrite||busy||Boolean(unknown)} onChange={e=>setConfirmed(e.target.checked)}/>明确恢复此历史包，重新运行两个本机虚构样例批次</label>
   <button className="button" disabled={!canWrite||!ready||!canRollback||busy||!target||!confirmed} onClick={()=>void rollback()}>确认回滚到此版本</button></>}
  {release.rolledBackToTaskId&&<a className="button" href={`/v2/?module=agent-center&task=${encodeURIComponent(release.rolledBackToTaskId)}#agent-publication`}>查看回滚目标和恢复批次</a>}
  {unknown&&<button className="button" disabled={busy} onClick={()=>{setBusy(true);void onRefresh().catch(e=>setError((e as Error).message)).finally(()=>setBusy(false));}}>只读刷新当前发布</button>}
  {error&&<p role="alert">{error}</p>}
 </section>;
}
