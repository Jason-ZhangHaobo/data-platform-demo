import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import ts from 'typescript';
import {manualRunRecovery} from '../../web/src/manual-run-recovery.ts';
import {serviceBatchFromLocation} from '../../web/src/service-batch-scope.ts';
import {validServiceSourceBinding,serviceSourceKey,serviceSourceScope,sourceBindingEnvironmentMatches,serviceSourceFromLocation,serviceHandoffLocation,serviceReturnLocation,currentAgentTaskLocation,publicationSourceLocation,returnedPublicationMatches,localAgentPublicationPath,
  serviceSourcesPath,serviceEvidencePath,serviceReadCurrent,sourceRunMatches,sourceRunEligible,agentReturnSourceMatches,sourceBoundServices,sourceBoundCalls,sourceBoundSwitches,sourceBindingScopeCompatible,defaultBoundSourceRun} from '../../web/src/service-source-binding.ts';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const binding={taskId:id(1),packageDigest:'a'.repeat(64),releaseId:id(2),sourceKind:'MANUAL',revisionId:id(3),runId:id(4)};
const run=(n=5,patch={})=>({id:id(n),releaseId:binding.releaseId,sourceAgentTaskId:binding.taskId,packageDigest:binding.packageDigest,sourceKind:'MANUAL',sourceAttribution:'ENGINEER_ASSISTED',agentIndependentE2E:false,
  sourceRevisionId:binding.revisionId,sourceRunId:binding.runId,
  status:'SUCCEEDED',published:true,schedulerTriggered:true,engine:'Apache Spark',mainSqlExecuted:true,testSqlValidation:{passed:true},validation:{passed:true},...patch});
const dapi=(n,source=id(5),digest=binding.packageDigest)=>{const v={id:`version-${n}`,sourcePackageDigest:digest,sourceReleaseRunId:source,fields:['client_id'],timeoutMs:1500,rateLimitPerMinute:10};return{id:`service-${n}`,name:`接口${n}`,slug:`service-${n}`,serviceType:'DAPI',status:'PUBLISHED',currentVersion:v,publishedVersion:v,versions:[v]};};
const xapi=(n,children)=>{const v={id:`version-${n}`,steps:children.map((s,i)=>({alias:`step${i}`,dapiId:s.id,dapiVersionId:s.publishedVersion.id})),timeoutMs:2500,rateLimitPerMinute:10};return{id:`service-${n}`,name:`组合${n}`,slug:`service-${n}`,serviceType:'XAPI',status:'PUBLISHED',currentVersion:v,publishedVersion:v,versions:[v]};};

test('a batch location narrows the verified Agent publication and fails closed for incomplete or duplicate pins',()=>{
  const native={...binding,sourceKind:'AGENT',scope:'PRIVATE_CLOUD_TEST'};
  const url=serviceHandoffLocation('https://example.invalid/v2/',native);
  assert.equal(serviceBatchFromLocation(url.href,native),undefined);
  url.searchParams.set('release_batch',id(7));
  assert.equal(serviceBatchFromLocation(url.href,native),id(7));
  assert.equal(serviceBatchFromLocation(url.href),null);
  assert.equal(serviceBatchFromLocation(url.href,binding),null);
  assert.equal(serviceBatchFromLocation(url.href+'&release_batch='+id(5),native),null);
  assert.equal(serviceBatchFromLocation(url.href.replace(id(7),'invalid'),native),null);
  assert.equal(serviceBatchFromLocation(url.href.replace('module=services','module=ops'),native),null);

  const first=dapi(1), second=dapi(2,id(7)), cash=dapi(3,id(7));
  const composition=xapi(4,[second,cash]), mixed=xapi(5,[first,cash]);
  const runs=[run(5,{sourceKind:'AGENT',scope:'PRIVATE_CLOUD_TEST'}),run(7,{sourceKind:'AGENT',scope:'PRIVATE_CLOUD_TEST'})];
  const chosen=serviceBatchFromLocation(url.href,native);
  const services=sourceBoundServices([first,second,cash,composition,mixed],native,runs.filter(r=>r.id===chosen));
  assert.deepEqual(services.map(s=>s.id),[second.id,cash.id,composition.id]);
  assert.deepEqual(sourceBoundCalls([first,second].map(s=>({serviceId:s.id,serviceVersionId:s.currentVersion.id})),services),[
    {serviceId:second.id,serviceVersionId:second.currentVersion.id},
  ]);
});

test('manual publication navigation uses resolved exact version and never falls back from unavailable provenance',()=>{
  const target={taskId:binding.taskId,packageDigest:binding.packageDigest,verificationId:id(6)},source={status:'RESOLVED',...target,sourceKind:'MANUAL',revisionId:binding.revisionId,runId:binding.runId};
  const href=publicationSourceLocation('https://example.invalid/v2/?module=settings&task='+id(99),target,source);
  assert.equal(href.searchParams.get('task'),null);assert.equal(href.hash,'#agent-publication');
  assert.deepEqual(manualRunRecovery(href.href),{revisionId:binding.revisionId,runId:binding.runId,originTaskId:binding.taskId,requestKey:undefined});
  for(const patch of [{status:'UNAVAILABLE'},{sourceKind:undefined},{runId:undefined},{packageDigest:'b'.repeat(64)},{verificationId:id(99)}])assert.equal(publicationSourceLocation(href.href,target,{...source,...patch}),undefined);
  assert.equal(publicationSourceLocation(href.href,target),undefined,'a specified package cannot fall back to an unverified Agent source');
  assert.equal(publicationSourceLocation(href.href,target,{...source,sourceKind:'AGENT'}).searchParams.get('task'),binding.taskId,'resolved Agent navigation remains supported');
  assert.equal(serviceSourceFromLocation(`https://example.invalid/v2/?module=agent-center&task=${binding.taskId}`).status,'ABSENT','direct legacy Agent task URLs are not rewritten');
});

test('handoff URL refresh and return retain task/package/release and manual revision/run without carrying input or credentials',()=>{
  const url=serviceHandoffLocation(`https://example.invalid/v2/?module=agent-center&task=${binding.taskId}&revision=${id(99)}&run_request=${id(88)}&sql=SYNTHETIC_INPUT_NOT_CARRIED`,binding);
  assert.equal(url.searchParams.get('module'),'services');assert.equal(url.searchParams.get('task'),null);assert.equal(url.searchParams.get('run_request'),null);
  assert.deepEqual(serviceSourceFromLocation(url.href),{status:'VALID',binding});
  assert.equal(url.searchParams.has('sql'),false);
  const back=serviceReturnLocation(url.href,binding);assert.equal(back.searchParams.get('module'),'agent-center');
  assert.deepEqual(manualRunRecovery(back.href),{revisionId:binding.revisionId,runId:binding.runId,originTaskId:binding.taskId,requestKey:undefined});
  assert.equal([...back.searchParams.keys()].some(key=>key.startsWith('source_')),false);
  const agent={...binding,sourceKind:'AGENT',revisionId:undefined,runId:undefined};assert.equal(serviceReturnLocation(url.href,agent).searchParams.get('task'),binding.taskId);
});

test('incomplete, duplicate, unknown and former manual deep links are invalid rather than all-project fallback',()=>{
  const url=serviceHandoffLocation('https://example.invalid/v2/',binding);
  for(const href of [url.href+'&source_kind=MANUAL',url.href+'&source_actor=other',url.href.replace('source_release=','missing_release='),url.href.replace(binding.runId,'not-uuid'),
    `https://example.invalid/v2/?module=services&origin_task=${binding.taskId}&revision=${binding.revisionId}&run=${binding.runId}`])assert.equal(serviceSourceFromLocation(href).status,'INVALID');
  assert.equal(serviceSourceFromLocation(`https://example.invalid/v2/?module=agent-center&origin_task=${binding.taskId}`,true).status,'INVALID');
  assert.deepEqual(serviceSourceFromLocation('https://example.invalid/v2/?module=services'),{status:'ABSENT'});
  assert.equal(validServiceSourceBinding({...binding,runId:undefined}),false);assert.throws(()=>serviceHandoffLocation(url.href,{...binding,releaseId:undefined}));
});

test('explicit local source is native AGENT only and environment/scope matching never crosses local and private cloud',()=>{
  const local={...binding,sourceKind:'AGENT',scope:'LOCAL_TEST_ONLY'};
  assert.equal(validServiceSourceBinding(local),true);assert.equal(sourceBindingEnvironmentMatches(local,false,'LOCAL_DEVELOPMENT'),true);
  assert.equal(sourceBindingEnvironmentMatches(local,false),false);assert.equal(sourceBindingEnvironmentMatches(local,true,'PUBLIC_INVITATION'),false);
  for(const patch of [{sourceKind:'MANUAL'},{revisionId:undefined},{runId:undefined},{scope:'UNKNOWN'}])assert.equal(validServiceSourceBinding({...local,...patch}),false);
  assert.equal(serviceSourceScope(binding),'PRIVATE_CLOUD_TEST');assert.equal(sourceBindingEnvironmentMatches(binding,true,'PUBLIC_INVITATION'),true);
  assert.equal(sourceBindingEnvironmentMatches(binding,false,'LOCAL_DEVELOPMENT'),false);
  const native=run(5,{scope:'LOCAL_TEST_ONLY',sourceKind:'AGENT'});assert.equal(sourceRunMatches(native,local),true);
  assert.equal(sourceRunMatches({...native,scope:'PRIVATE_CLOUD_TEST'},local),false);assert.equal(sourceRunMatches({...native,scope:undefined},local),false);
  assert.equal(sourceRunMatches(run(),{...binding,scope:'PRIVATE_CLOUD_TEST'}),false,'explicit cloud scope requires the matching response scope');
  assert.equal(sourceRunMatches(run(5,{scope:'PRIVATE_CLOUD_TEST'}),binding),true,'legacy omitted scope remains private-compatible');
  assert.equal(sourceRunMatches(run(5,{scope:'LOCAL_TEST_ONLY'}),binding),false);
  assert.notEqual(serviceSourceKey(local),serviceSourceKey({...local,scope:'PRIVATE_CLOUD_TEST'}));
  assert.equal(sourceBindingScopeCompatible(local,{taskId:local.taskId,plan:{taskId:local.taskId,packageDigest:local.packageDigest,sourceReleaseRunId:native.id}},[native]),false,'a local source cannot expand a cloud-only consumption window');
});

test('local handoff refresh and Agent return preserve the exact tuple without generating manual origin fields',()=>{
  const local={...binding,sourceKind:'AGENT',scope:'LOCAL_TEST_ONLY'},services=serviceHandoffLocation('http://127.0.0.1:3100/v2/?module=agent-center',local);
  assert.equal(services.searchParams.get('source_scope'),'LOCAL_TEST_ONLY');assert.deepEqual(serviceSourceFromLocation(services.href),{status:'VALID',binding:local});
  const back=serviceReturnLocation(services.href,local);assert.equal(back.searchParams.get('task'),local.taskId);
  assert.equal(back.searchParams.get('source_revision'),local.revisionId);assert.equal(back.searchParams.get('source_run'),local.runId);
  assert.equal(back.searchParams.get('source_scope'),'LOCAL_TEST_ONLY');assert.equal(back.searchParams.has('origin_task'),false);assert.equal(back.searchParams.has('revision'),false);
  assert.deepEqual(serviceSourceFromLocation(back.href),{status:'VALID',binding:local});
  const current=currentAgentTaskLocation(back.href,local.taskId);assert.deepEqual([...current.searchParams.keys()],['module','task']);assert.equal(current.searchParams.get('task'),local.taskId);
  assert.equal(serviceSourceFromLocation(services.href.replace('LOCAL_TEST_ONLY','MANUAL_LOCAL')).status,'INVALID');
});

test('native Agent return accepts only matching current code, immutable revision/run and verified release sources',()=>{
  const local={...binding,sourceKind:'AGENT',scope:'LOCAL_TEST_ONLY'},hash='c'.repeat(64);
  const task={id:local.taskId,contextId:'holdings-t1',sql:'SELECT original',revisionId:local.revisionId,runId:local.runId};
  const actual={id:local.runId,agentTaskId:local.taskId,contextId:task.contextId,revisionId:local.revisionId,revisionHash:hash};
  const revision={id:local.revisionId,contextId:task.contextId,sql:task.sql,hash,source:'LIVE_MODEL'},sources=[run(5,{scope:'LOCAL_TEST_ONLY',sourceKind:'AGENT'})];
  assert.equal(agentReturnSourceMatches(local,task,actual,revision,sources),true);
  assert.equal(agentReturnSourceMatches(local,{...task,revisionId:undefined,runId:undefined,attempts:[{revisionId:local.revisionId,runId:local.runId}]},actual,revision,sources),true,'legacy native tasks may expose the latest source through their attempt');
  for(const changed of [{...task,sql:'SELECT latest'},{...task,runId:id(99)},{...task,revisionId:id(99)},{...task,id:id(99)}])assert.equal(agentReturnSourceMatches(local,changed,actual,revision,sources),false);
  for(const changed of [{...actual,revisionHash:'d'.repeat(64)},{...actual,contextId:'other'},{...actual,agentTaskId:id(99)}])assert.equal(agentReturnSourceMatches(local,task,changed,revision,sources),false);
  assert.equal(agentReturnSourceMatches(local,task,actual,{...revision,source:'MANUAL'},sources),false);
  for(const changed of [[],[run(5,{sourceKind:'AGENT',scope:'PRIVATE_CLOUD_TEST'})],[{...sources[0],releaseId:id(99)}]])assert.equal(agentReturnSourceMatches(local,task,actual,revision,changed),false);
  const ui=readFileSync('web/src/AgentDevelopmentWorkbench.tsx','utf8'),main=readFileSync('web/src/main.tsx','utf8');
  assert.match(ui,/readOnly=requestedReadOnly\|\|sourceReturnActive/);assert.match(ui,/if\(!agentReturnSourceMatches/);assert.match(ui,/打开当前任务继续处理/);
  assert.match(ui,/api<unknown>\(serviceSourcesPath\(expectedSourceBinding\)\)/);assert.match(main,/expectedSourceBinding=\{sourceBinding\?\.sourceKind==="AGENT"/);
});

test('returned local publication selects the frozen release and never pins the latest workflow verification',()=>{
  const local={...binding,sourceKind:'AGENT',scope:'LOCAL_TEST_ONLY'},url=new URL(localAgentPublicationPath(local),'http://127.0.0.1');
  assert.deepEqual(Object.fromEntries(url.searchParams),{sourceKind:'AGENT',sourceRunId:local.runId,packageDigest:local.packageDigest,releaseId:local.releaseId});
  assert.equal(url.searchParams.has('verificationId'),false);
  const release={id:local.releaseId,packageDigest:local.packageDigest,sourceRevisionId:local.revisionId,sourceRunId:local.runId,sourceAgentTaskId:local.taskId,sourceKind:'AGENT'};
  assert.equal(returnedPublicationMatches(local,{release}),true);
  for(const patch of [{id:id(99)},{sourceRevisionId:id(99)},{sourceRunId:id(99)},{packageDigest:'b'.repeat(64)}])assert.equal(returnedPublicationMatches(local,{release:{...release,...patch}}),false);
  assert.equal(returnedPublicationMatches(local,{}),false);assert.throws(()=>localAgentPublicationPath(binding));
  const panel=readFileSync('web/src/AgentDeliveryPanel.tsx','utf8');assert.match(panel,/localAgentPublicationPath\(expectedSourceBinding\)/);assert.match(panel,/!returnedPublicationMatches\(expectedSourceBinding,value\)/);
});

test('sources and consumption reads bind release_id and consumption only uses successful published release_run IDs',()=>{
  for(const path of [serviceSourcesPath(binding),serviceEvidencePath(binding)])assert.deepEqual(Object.fromEntries(new URL(path,'https://example.invalid').searchParams),{agent_task_id:binding.taskId,package_digest:binding.packageDigest,release_id:binding.releaseId});
  assert.equal(sourceRunMatches(run(),binding),true);assert.notEqual(run().id,binding.runId);
  for(const patch of [{releaseId:id(9)},{sourceAgentTaskId:id(9)},{packageDigest:'b'.repeat(64)},{sourceKind:'AGENT'},{agentIndependentE2E:true},{sourceAttribution:undefined},{sourceRunId:id(99)},{sourceRevisionId:id(99)},{sourceRevisionId:undefined}])assert.equal(sourceRunMatches(run(5,patch),binding),false);
  for(const patch of [{status:'FAILED'},{published:false},{schedulerTriggered:false},{validation:{passed:false}},{mainSqlExecuted:false},{testSqlValidation:{passed:false}}])assert.equal(sourceRunEligible(run(5,patch)),false);
});

test('bound service list excludes newer foreign releases, mismatched current versions and mixed XAPI versions',()=>{
  const holdings=dapi(1),cash=dapi(2),good=xapi(3,[holdings,cash]),foreign=dapi(4,id(99)),cross=xapi(5,[holdings,foreign]);
  const moved={...holdings,id:'moved',currentVersion:{...holdings.currentVersion,sourceReleaseRunId:id(99)}};
  assert.deepEqual(sourceBoundServices([holdings,cash,good,foreign,cross,moved],binding,[run()]).map(s=>s.id),[holdings.id,cash.id,good.id]);
  const otherBatch=dapi(6,id(7)),mixedBatch=xapi(7,[holdings,otherBatch]);
  assert.equal(sourceBoundServices([holdings,otherBatch,mixedBatch],binding,[run(),run(7)]).some(s=>s.id===mixedBatch.id),false);
  assert.deepEqual(sourceBoundServices([holdings,cash,good],binding,[]),[]);
  const oldVersion={...cash.currentVersion,id:'foreign-history',sourceReleaseRunId:id(99)},history={...cash,versions:[cash.currentVersion,oldVersion]};
  assert.deepEqual(sourceBoundServices([history],binding,[run()])[0].versions.map(v=>v.id),[cash.currentVersion.id]);
});

test('XAPI pinned to a valid historical DAPI version stays visible after the DAPI moves to another package',()=>{
  const holdings=dapi(1),cash=dapi(2),pinned=xapi(3,[holdings,cash]);
  const newer={...holdings.currentVersion,id:'foreign-latest',sourcePackageDigest:'b'.repeat(64),sourceReleaseRunId:id(99)};
  const upgraded={...holdings,currentVersion:newer,publishedVersion:newer,versions:[holdings.currentVersion,newer]},before=structuredClone(upgraded);
  const visible=sourceBoundServices([upgraded,cash,pinned],binding,[run()]);
  assert.deepEqual(visible.map(service=>service.id),[cash.id,pinned.id]);
  assert.equal(visible[1].currentVersion.steps[0].dapiVersionId,holdings.currentVersion.id);
  assert.deepEqual(upgraded,before,'display must never rebind the DAPI current/published version');
  assert.equal(sourceBoundServices([{...upgraded,versions:[newer]},cash,pinned],binding,[run()]).some(service=>service.id===pinned.id),false,'missing immutable old version cannot be reconstructed');
});

test('default batch follows existing same-source services instead of backend newest-first order, without overriding explicit choice',()=>{
  const first=run(5,{sequence:1}),second=run(7,{sequence:2}),runs=[second,first],holdings=dapi(1,id(5)),cash=dapi(2,id(5));
  assert.equal(defaultBoundSourceRun(binding,runs,[holdings,cash]),first.id);
  assert.equal(defaultBoundSourceRun(binding,runs,[holdings,cash],{currentRunId:second.id}),second.id);
  const selected=dapi(3,id(7));
  assert.equal(defaultBoundSourceRun(binding,runs,[holdings,cash,selected],{selectedServiceId:selected.id}),second.id);
  assert.equal(defaultBoundSourceRun(binding,runs,[holdings,cash,selected],{currentRunId:first.id,selectedServiceId:selected.id}),first.id);
  const newer={...holdings.currentVersion,id:'foreign-current',sourcePackageDigest:'b'.repeat(64),sourceReleaseRunId:id(99)},upgraded={...holdings,currentVersion:newer,publishedVersion:newer,versions:[holdings.currentVersion,newer]},pinned=xapi(4,[holdings,cash]);
  assert.equal(defaultBoundSourceRun(binding,runs,[upgraded,cash,pinned],{selectedServiceId:pinned.id}),first.id,'a pinned XAPI follows its immutable common child run, never new DAPI current');
  assert.match(readFileSync('web/src/DataServicesWorkbench.tsx','utf8'),/setSourceRunId\(previous=>defaultBoundSourceRun/,'in-flight reload must preserve the latest user selection, not its stale closure');
});

test('with no existing service default chooses earliest eligible sequence stably and never leaves the exact binding',()=>{
  const first=run(5,{sequence:1,createdAt:'2026-11-05T02:00:00Z'}),second=run(7,{sequence:2,createdAt:'2026-11-05T01:00:00Z'}),foreign=run(9,{sequence:0,releaseId:id(99)});
  for(const runs of [[second,foreign,first],[first,second,foreign]])assert.equal(defaultBoundSourceRun(binding,runs,[]),first.id);
  assert.equal(defaultBoundSourceRun(binding,[second,foreign,first],[],{currentRunId:foreign.id}),first.id);
  assert.equal(defaultBoundSourceRun(binding,[foreign],[]),undefined);
  const one=run(5,{createdAt:'2026-11-05T01:00:00Z'}),two=run(7,{createdAt:'2026-11-05T02:00:00Z'});
  assert.equal(defaultBoundSourceRun(binding,[two,one],[]),one.id);
  assert.equal(defaultBoundSourceRun(binding,[run(7),run(5)],[]),id(5),'last-resort ID ordering is deterministic');
});

test('bound call and switch evidence require explicit immutable versions, excluding same-service other-package history',()=>{
  const service=dapi(1),old={...service.currentVersion,id:'same-source-old'},foreign={...service.currentVersion,id:'foreign',sourceReleaseRunId:id(99)};
  const visible=sourceBoundServices([{...service,versions:[old,service.currentVersion,foreign]}],binding,[run()]);
  const calls=[{id:'good',serviceId:service.id,serviceVersionId:old.id},{id:'current',serviceId:service.id,serviceVersionId:service.currentVersion.id},
    {id:'foreign',serviceId:service.id,serviceVersionId:foreign.id},{id:'no-version',serviceId:service.id},{id:'wrong-service',serviceId:'other',serviceVersionId:old.id}];
  assert.deepEqual(sourceBoundCalls(calls,visible).map(call=>call.id),['good','current']);
  const switches=[{id:'within',fromVersionId:old.id,toVersionId:service.currentVersion.id},{id:'leaving',fromVersionId:old.id,toVersionId:foreign.id},
    {id:'entering',fromVersionId:foreign.id,toVersionId:service.currentVersion.id},{id:'missing',toVersionId:service.currentVersion.id}];
  assert.deepEqual(sourceBoundSwitches(switches,visible[0]).map(receipt=>receipt.id),['within']);
  const ui=readFileSync('web/src/DataServicesWorkbench.tsx','utf8');
  assert.match(ui,/visibleCalls=bindingDeclared\?sourceBoundCalls\(calls,services\):calls/);
  assert.match(ui,/bindingDeclared\?sourceBoundSwitches\(rows,resource\):rows/);
});

test('binding intersects, never expands, a narrower consumption plan',()=>{
  const scope={taskId:binding.taskId,plan:{taskId:binding.taskId,packageDigest:binding.packageDigest,sourceReleaseRunId:id(5)}};
  assert.equal(sourceBindingScopeCompatible(binding,scope,[run()]),true);
  for(const wrong of [{...scope,taskId:id(9)},{...scope,plan:{...scope.plan,packageDigest:'b'.repeat(64)}},{...scope,plan:{...scope.plan,sourceReleaseRunId:id(9)}},{}])assert.equal(sourceBindingScopeCompatible(binding,wrong,[run()]),false);
});

test('old source reads cannot replace another binding or a newer same-source refresh',async()=>{
  const oldKey=serviceSourceKey(binding),newKey=serviceSourceKey({...binding,releaseId:id(9)}),accepted=[];
  let activeKey=oldKey,activeRequest=1,resolve;
  const pending=new Promise(done=>resolve=done).then(value=>{if(serviceReadCurrent(oldKey,1,activeKey,activeRequest))accepted.push(value);});
  activeKey=newKey;activeRequest=2;resolve('old data');await pending;assert.deepEqual(accepted,[]);
  assert.equal(serviceReadCurrent(newKey,2,newKey,2),true);assert.equal(serviceReadCurrent(newKey,1,newKey,2),false);assert.equal(serviceReadCurrent(newKey,2,newKey,2,false),false);
});

const compile=name=>{
  let text=ts.transpileModule(readFileSync(`web/src/${name}.tsx`,'utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
  text=text.replaceAll('from "../../src/v2/fund-contexts.mjs"',`from ${JSON.stringify(new URL('../../src/v2/fund-contexts.mjs',import.meta.url).href)}`);
  text=text.replaceAll('from "../../src/v2/output-contract-metadata.mjs"',`from ${JSON.stringify(new URL('../../src/v2/output-contract-metadata.mjs',import.meta.url).href)}`);
  for(const pkg of ['react','react/jsx-runtime','lucide-react'])text=text.replaceAll(`from "${pkg}"`,`from ${JSON.stringify(import.meta.resolve(pkg))}`).replaceAll(`from '${pkg}'`,`from ${JSON.stringify(import.meta.resolve(pkg))}`);
  for(const helper of ['service-composition','service-consumption-scope','service-source-binding','service-plan-source','private-service-plan','service-batch-scope'])text=text.replaceAll(`from "./${helper}"`,`from ${JSON.stringify(new URL(`../../web/src/${helper}.ts`,import.meta.url).href)}`).replaceAll(`from './${helper}'`,`from ${JSON.stringify(new URL(`../../web/src/${helper}.ts`,import.meta.url).href)}`);
  if(name==='DataServicesWorkbench')text=text.replaceAll('from "./EvidenceDownload"',`from ${JSON.stringify(compile('EvidenceDownload'))}`);
  if(name==='DataServicesWorkbench')text=text.replaceAll("from './PrivateServiceAgentStudio'",`from ${JSON.stringify(compile('PrivateServiceAgentStudio'))}`);
  return 'data:text/javascript;base64,'+Buffer.from(text).toString('base64');
};
const {DataServicesWorkbench}=await import(compile('DataServicesWorkbench'));
const {evidenceExportHref}=await import(compile('EvidenceDownload'));
test('actual bound workspace shows provenance and recovery, no write on render and no all-project fallback for invalid input',()=>{
  let calls=0;const props={api:async()=>{calls++;throw Error('render must not fetch or write');},canWrite:true,privateCloud:true,cloudAccess:'invited'};
  const html=renderToStaticMarkup(React.createElement(DataServicesWorkbench,{...props,sourceBinding:binding}));
  assert.match(html,/工程师接管结果 · 非 Agent 自主完成/);assert.match(html,/返回原版本的链接将在同源核对后开放/);assert.doesNotMatch(html,/href=.*origin_task/);
  assert.match(html,/正在核对确切发布来源/);assert.match(html,/当前范围统计尚未确认/);assert.doesNotMatch(html,/>新建 DAPI<|创建DAPI草稿/);
  const invalid=renderToStaticMarkup(React.createElement(DataServicesWorkbench,{...props,sourceBindingError:'来源不完整，不回退全项目'}));
  assert.match(invalid,/来源不完整，不回退全项目/);assert.doesNotMatch(invalid,/返回原人工版本/);assert.equal(calls,0);
  const exportUrl=new URL(evidenceExportHref({kind:'consumption',id:binding.taskId,digest:binding.packageDigest,releaseId:binding.releaseId}),'https://example.invalid');assert.equal(exportUrl.searchParams.get('releaseId'),binding.releaseId);
  assert.equal(new URL(evidenceExportHref({kind:'consumption',id:binding.taskId,digest:binding.packageDigest}),'https://example.invalid').searchParams.has('releaseId'),false);
});

test('actual local bound workspace accepts only confirmed local environment and keeps writes closed before readback',()=>{
  const local={...binding,sourceKind:'AGENT',scope:'LOCAL_TEST_ONLY'},props={api:async()=>assert.fail('render cannot fetch'),canWrite:true,sourceBinding:local,privateCloud:false,runtimeMode:'LOCAL_DEVELOPMENT'};
  const html=renderToStaticMarkup(React.createElement(DataServicesWorkbench,props));
  assert.match(html,/正在核对确切发布来源/);assert.doesNotMatch(html,/交接范围与当前运行环境不一致/);assert.match(html,/当前范围统计尚未确认/);assert.doesNotMatch(html,/>新建 DAPI<|创建DAPI草稿/);
  for(const patch of [{runtimeMode:undefined},{runtimeMode:'PUBLIC_INVITATION',privateCloud:true}])assert.match(renderToStaticMarkup(React.createElement(DataServicesWorkbench,{...props,...patch})),/交接范围与当前运行环境不一致/);
  const main=readFileSync('web/src/main.tsx','utf8');assert.match(main,/privateCloud=\{workbench.cloudServices\} runtimeMode=\{workbench.runtimeMode\}/);
  assert.doesNotMatch(main,/if\(workbench.cloudServices\)\{const url=serviceHandoffLocation/);
});

test('source-bound Agent studio requires the explicit local capability and never opens private or consumption-only planning',()=>{
 let calls=0;const local={...binding,sourceKind:'AGENT',scope:'LOCAL_TEST_ONLY'},props={api:async()=>{calls++;throw Error('render cannot request');},canWrite:true,sourceBinding:local,
  privateCloud:false,runtimeMode:'LOCAL_DEVELOPMENT',sourceBoundAgentPlansEnabled:true,modelConfigured:true};
 const html=renderToStaticMarkup(React.createElement(DataServicesWorkbench,props));assert.match(html,/aria-label="Agent规划成功批次"/);assert.match(html,/先规划持仓 DAPI/);
 assert.match(html,/disabled=""[^>]*>[\s\S]*?生成受治理方案/);
 for(const patch of [{sourceBoundAgentPlansEnabled:false},{privateCloud:true,runtimeMode:'PUBLIC_INVITATION'},{consumptionScope:{}}])
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(DataServicesWorkbench,{...props,...patch})),/aria-label="Agent规划成功批次"/);
 assert.equal(calls,0);
});

test('private context inspection is explicitly read-only and does not render the local model studio',()=>{
 let calls=0;const props={api:async()=>{calls++;throw Error('render cannot request');},canWrite:false,sourceBinding:binding,
  privateCloud:true,runtimeMode:'PUBLIC_INVITATION',sourceBoundAgentContextEnabled:true,sourceBoundAgentPlansEnabled:true,modelConfigured:true};
 const html=renderToStaticMarkup(React.createElement(DataServicesWorkbench,props));
 assert.match(html,/aria-label="私有Agent规划上下文"/);assert.match(html,/核对上下文不会调用模型、创建方案或发布接口/);
 assert.doesNotMatch(html,/生成受治理方案/);assert.match(html,/disabled=""[^>]*>[\s\S]*?核对规划上下文/);
 for(const patch of [{sourceBoundAgentContextEnabled:false},{privateCloud:false},{sourceBindingError:'当前来源不可用'},{sourceBinding:undefined}])
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(DataServicesWorkbench,{...props,...patch})),/aria-label="私有Agent规划上下文"/);
 assert.equal(calls,0);
});
