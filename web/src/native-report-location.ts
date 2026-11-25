import type {PublishedReportBinding} from '../../src/v2/published-report-request.mjs';
import {reportRequestId} from '../../src/v2/published-report-request.mjs';
import {serviceSourceFromLocation} from './service-source-binding.ts';
import type {ServiceSourceBinding} from './service-source-binding.ts';

export type WealthReportTarget = {binding:ServiceSourceBinding;source:PublishedReportBinding;requestId?:string};
export function wealthReportTarget(href:string): WealthReportTarget | null | undefined {
  const url=new URL(href), query=url.searchParams;
  if(!query.has('report_batch') && url.hash!=='#customer-asset-report') return undefined;
  const location=serviceSourceFromLocation(href), batch=query.get('report_batch'), request=query.get('report_request');
  if(query.get('module')!=='reports'||query.getAll('module').length!==1||query.getAll('report_batch').length!==1||
    query.getAll('report_request').length>1||location.status!=='VALID') return null;
  const binding=location.binding;
  if(binding.sourceKind!=='AGENT'||binding.scope!=='LOCAL_TEST_ONLY'||!binding.taskId||!binding.revisionId||!binding.runId) return null;
  try{
    const source={kind:'AGENT' as const,taskId:binding.taskId,releaseId:binding.releaseId,packageDigest:binding.packageDigest,
      revisionId:binding.revisionId,runId:binding.runId,batchId:reportRequestId(batch)};
    return {binding,source,...(request!==null?{requestId:reportRequestId(request)}:{})};
  }catch{return null;}
}

export function wealthReportLocation(serviceHref:string) {
  const url=new URL(serviceHref,'http://localhost/');
  const batch=url.searchParams.get('release_batch');
  if(!batch) throw Error('请选择原发布批次');
  url.searchParams.delete('release_batch');
  url.searchParams.set('module','reports');
  url.searchParams.set('report_batch',batch);
  url.hash='customer-asset-report';
  if(!wealthReportTarget(url.href)) throw Error('原报表批次来源未确认');
  return url.pathname+url.search+url.hash;
}
