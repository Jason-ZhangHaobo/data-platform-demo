import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID} from 'node:crypto';
import {checkedSourceReportPlan} from '../../web/src/source-report-plan.ts';
import {customerAnalysisKind,customerAnalysisMetrics,customerBalanceMetrics,customerDistributionMetrics} from '../../src/v2/customer-analysis-plan-contract.mjs';
import {serviceHandoffLocation} from '../../web/src/service-source-binding.ts';
import {appliedChatReport,chatBatchCandidates,chatBatchFromServiceHref,chatBatchLocation,chatBatchTarget,sameReportSource} from '../../web/src/agent-report-chat.ts';

const binding={sourceKind:'AGENT',scope:'LOCAL_TEST_ONLY',taskId:randomUUID(),releaseId:randomUUID(),
  packageDigest:'a'.repeat(64),revisionId:randomUUID(),runId:randomUUID()};
const source={kind:'AGENT',taskId:binding.taskId,releaseId:binding.releaseId,packageDigest:binding.packageDigest,
  revisionId:binding.revisionId,runId:binding.runId,batchId:randomUUID()};
const origin='http://127.0.0.1:3100';

test('report chat links retain the selected batch only and restore the original submission',()=>{
  const url=serviceHandoffLocation(origin+'/v2/?task=other',binding);
  url.searchParams.set('release_batch',source.batchId);
  const chat=new URL(chatBatchFromServiceHref(url.href),origin);
  assert.deepEqual(chatBatchTarget(chat.href),{source});
  assert.equal(chat.hash,'#agent-chat');
  assert.equal(chat.searchParams.has('task'),false);
  const requestId=randomUUID();
  const restored=new URL(chatBatchLocation(chat.href,source,requestId),origin);
  assert.deepEqual(chatBatchTarget(restored.href),{source,requestId});
  for(const change of [
    q=>q.append('chat_request',requestId), q=>q.append('chat_batch',source.batchId),
    q=>q.set('task',randomUUID()), q=>q.set('source_kind','MANUAL'), q=>q.set('source_scope','PRIVATE_CLOUD_TEST'),
    q=>q.set('report_request',randomUUID()), q=>q.delete('source_run'), q=>q.set('module','reports')
  ]){
    const bad=new URL(restored.href);change(bad.searchParams);assert.equal(chatBatchTarget(bad.href),null);
  }
  assert.equal(chatBatchTarget(origin+'/v2/?module=agent-center'),undefined);
});

test('a shared report receipt is usable only for the matching specialist and original exact source',()=>{
  const id=randomUUID(), rid=randomUUID(),s={...source};
  const receipt={protocol:'shuduo-published-report-creation/v1',id:randomUUID(),name:'证券客户报表',requestId:id,
    scope:'LOCAL_TEST_ONLY',status:'SUCCEEDED',stage:'COMPLETE',source:s,sourceEvidenceHash:'b'.repeat(64),
    datasetId:randomUUID(),snapshotId:randomUUID(),reportId:rid,reportVersionId:randomUUID(),reportRunId:randomUUID(),
    resultHash:'c'.repeat(64),rowCount:2,widgetCount:3,agentIndependentE2E:false,publicDeployed:false};
  const plan={id,status:'APPLIED',planMode:'PUBLISHED_SOURCE_REPORT_V1',requestBasisState:'VERIFIED',sourceBinding:s,reportId:rid,reportCreation:receipt};
  assert.deepEqual(appliedChatReport(plan,s),receipt);
  assert.equal(appliedChatReport({...plan,requestBasisState:'UNCONFIRMED'},s),undefined);
  assert.equal(appliedChatReport({...plan,reportId:randomUUID()},s),undefined);
  assert.equal(appliedChatReport(plan,{...s,batchId:randomUUID()}),undefined);
  const manual={...s,kind:'MANUAL'};delete manual.taskId;
  assert.deepEqual(appliedChatReport({...plan,sourceBinding:manual,reportCreation:{...receipt,source:manual}},manual)?.reportId,rid);
  assert.throws(()=>chatBatchLocation(origin,manual));
  assert.ok(!sameReportSource(manual,s));
  assert.deepEqual(chatBatchCandidates([{sourceKind:'MANUAL_NO_ARCHIVE'}]),[]);
});


test('five-metric plan binds three balance widgets and both verified archive distributions',()=>{
  const widgets=customerBalanceMetrics.map(id=>({id,title:'虚构指标 '+id}));
  const proposal={kind:'PUBLISHED_REPORT',name:'顾问持仓分析',metricIds:[...customerAnalysisMetrics],widgets,
    customerAnalysis:{kind:customerAnalysisKind,metricIds:[...customerDistributionMetrics]}};
  const plan={id:randomUUID(),requestId:randomUUID(),planMode:'PUBLISHED_SOURCE_REPORT_V1',status:'SUCCEEDED',
    message:'分析本批的五项指标',sourceBinding:source,sourceEvidenceHash:'b'.repeat(64),contextHash:'c'.repeat(64),proposalHash:'d'.repeat(64),proposal};
  assert.equal(checkedSourceReportPlan(plan,source),plan);
  for(const bad of [
    {...proposal,customerAnalysis:undefined}, {...proposal,widgets:widgets.slice(0,2)},
    {...proposal,widgets:[widgets[0],widgets[0],widgets[2]]},
    {...proposal,customerAnalysis:{...proposal.customerAnalysis,metricIds:['asset_class_distribution']}},
    {...proposal,customerAnalysis:{...proposal.customerAnalysis,metricIds:['asset_class_distribution','asset_class_distribution']}},
    {...proposal,metricIds:customerBalanceMetrics},
  ])assert.throws(()=>checkedSourceReportPlan({...plan,proposal:bad},source));
  const manual={...source,kind:'MANUAL'};delete manual.taskId;
  assert.throws(()=>checkedSourceReportPlan({...plan,sourceBinding:manual},manual));
  const ordinary={...plan,sourceBinding:manual,proposal:{kind:'PUBLISHED_REPORT',name:'持仓基本指标',metricIds:customerBalanceMetrics,widgets}};
  assert.equal(checkedSourceReportPlan(ordinary,manual),ordinary);
});
