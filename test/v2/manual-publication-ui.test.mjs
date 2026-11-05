import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {publicationSelector,publicationSelectionKey,publicationReadPath,publicationReleaseMatches,checkedPublication,publicationWriteAllowed,publicationCancellationAllowed,cloudPublicationRequest,createPublicationAttempt} from '../../web/src/publication-selection.ts';
import {createPublicationReader} from '../../web/src/publication-read.ts';

let source=ts.transpileModule(readFileSync('web/src/AgentPublicationReview.tsx','utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
for(const pkg of ['react','react/jsx-runtime'])source=source.replaceAll(`from "${pkg}"`,`from ${JSON.stringify(import.meta.resolve(pkg))}`);
source=source.replaceAll('from "./delivery-presentation"',`from ${JSON.stringify(new URL('../../web/src/delivery-presentation.ts',import.meta.url).href)}`);
const {AgentPublicationReview,publicationTargetMatches}=await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const attestations={code:true,assertions:true,deliveryFiles:true,cloudScope:true};
function fixture(tag='a'){
  const selection={taskId:'origin-agent',manual:true,runId:`manual-run-${tag}`,revisionId:`manual-revision-${tag}`,contextId:'stock-cash-t1'};
  const workflow={report:{taskId:selection.taskId,sourceKind:'MANUAL',agentIndependentE2E:false,runId:selection.runId,revisionId:selection.revisionId,contextId:selection.contextId},
    delivery:{sourceKind:'MANUAL',sourceRunId:selection.runId,sourceRevisionId:selection.revisionId,packageId:`package-${tag}`,packageDigest:tag.repeat(64),verificationId:`verification-${tag}`},
    package:{id:`package-${tag}`,digest:tag.repeat(64)},verification:{id:`verification-${tag}`}};
  const selector=publicationSelector(selection,workflow,true);
  const publication={release:{id:`release-${tag}`,sourceKind:'MANUAL',sourceRunId:selection.runId,sourceAgentTaskId:selection.taskId,
    sourceRevisionId:selection.revisionId,packageDigest:selector.packageDigest,verificationId:selector.verificationId,status:'WAITING_SCHEDULER',agentIndependentE2E:false},
    runs:[{id:`batch-${tag}`,status:'SCHEDULED'}],alerts:[],events:[]};
  return {selection,workflow,selector,publication};
}
function elements(root,type){if(!React.isValidElement(root))return[];return [...(root.type===type?[root]:[]),...React.Children.toArray(root.props.children).flatMap(child=>elements(child,type))];}
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};};

test('manual reads require the exact confirmed workflow source, package and rehearsal',()=>{
  const a=fixture(),b=fixture('b');
  assert.deepEqual(a.selector,{sourceKind:'MANUAL',sourceRunId:'manual-run-a',packageDigest:'a'.repeat(64),verificationId:'verification-a'});
  assert.notEqual(publicationSelectionKey(a.selection.taskId,a.selector),publicationSelectionKey(b.selection.taskId,b.selector));
  assert.equal(publicationSelector(a.selection,a.workflow,false),undefined);
  assert.equal(publicationSelector(a.selection,undefined,true),undefined);
  assert.equal(publicationSelector(b.selection,a.workflow,true),undefined);
  for(const mutate of [f=>delete f.report.sourceKind,f=>f.report.agentIndependentE2E=true,f=>f.delivery.sourceKind='AGENT',f=>f.delivery.sourceRunId='foreign',
    f=>f.delivery.packageDigest='b'.repeat(64),f=>f.delivery.verificationId='another',f=>f.report.revisionId='another',f=>delete f.verification]){
    const workflow=structuredClone(a.workflow);mutate(workflow);assert.equal(publicationSelector(a.selection,workflow,true),undefined);
  }
  const url=new URL(publicationReadPath(a.selection.taskId,a.selector,'release-a'),'https://example.invalid');
  assert.equal(url.pathname,'/agent/tasks/origin-agent/publication');
  assert.deepEqual(Object.fromEntries(url.searchParams),{...a.selector,releaseId:'release-a'});
});

test('source, package, rehearsal and release mismatches cannot replace the selected publication',()=>{
  const a=fixture(),b=fixture('b');
  assert.equal(checkedPublication(a.publication,a.selection.taskId,a.selector),a.publication);
  assert.equal(a.publication.release.status,'WAITING_SCHEDULER','view must not synthesize executed/successful publication');
  assert.equal(publicationReleaseMatches(b.publication.release,a.selection.taskId,a.selector),false);
  for(const patch of [{sourceKind:undefined},{sourceRunId:'manual-run-b'},{sourceAgentTaskId:'another'},{packageDigest:'b'.repeat(64)},{verificationId:'verification-b'}]){
    assert.throws(()=>checkedPublication({...a.publication,release:{...a.publication.release,...patch}},a.selection.taskId,a.selector),/未采用其他历史发布/);
  }
  assert.throws(()=>checkedPublication(a.publication,a.selection.taskId,a.selector,'release-b'));
  assert.throws(()=>checkedPublication({runs:[],alerts:[],events:[]},a.selection.taskId,a.selector,undefined,true));
  const agentSelector={sourceKind:'AGENT',packageDigest:a.selector.packageDigest,verificationId:a.selector.verificationId};
  assert.equal(publicationReleaseMatches({...a.publication.release,sourceKind:undefined},a.selection.taskId,agentSelector),true,'legacy AGENT attribution is not MANUAL');
});

test('switching two manual packages ignores old successes and failures and never issues a write',async()=>{
  const a=fixture(),b=fixture('b'),old=deferred(),next=deferred(),values=[],errors=[],paths=[];
  let active=publicationSelectionKey(a.selection.taskId,a.selector);
  const make=(f,pending)=>{
    const key=publicationSelectionKey(f.selection.taskId,f.selector);
    return createPublicationReader({read:()=>{paths.push(publicationReadPath(f.selection.taskId,f.selector));return pending.promise.then(value=>checkedPublication(value,f.selection.taskId,f.selector));},
      onValue:value=>{if(active===key)values.push(value.release.id);},onError:error=>{if(active===key)errors.push(error.message);}});
  };
  const first=make(a,old),readA=first.refresh();await Promise.resolve();
  active=publicationSelectionKey(b.selection.taskId,b.selector);first.close();
  const second=make(b,next),readB=second.refresh();next.resolve(b.publication);await readB;
  old.resolve(a.publication);await readA;
  assert.deepEqual(values,['release-b']);assert.deepEqual(errors,[]);assert.equal(paths.length,2);
  assert.equal(new URL(paths[1],'https://example.invalid').searchParams.get('sourceRunId'),'manual-run-b');
  second.close();
});

test('unknown publish is read first, never automatically reposted, and explicit retry preserves the frozen request',async()=>{
  const a=fixture(),request=cloudPublicationRequest(a.selector,a.workflow.package.id,attestations),original=structuredClone(request),attempt=createPublicationAttempt(request),posts=[];
  const post=async value=>{posts.push(value);if(posts.length===1)throw Error('synthetic unknown response');return a.publication;};
  await assert.rejects(attempt.submit(post),/unknown response/);assert.equal(attempt.snapshot().status,'UNKNOWN');
  request.body.packageDigest='b'.repeat(64);request.idempotencyKey='changed';
  await assert.rejects(attempt.submit(post,true),/先读取/);assert.equal(posts.length,1);
  const reader=createPublicationReader({read:async()=>({runs:[],alerts:[],events:[]}),onValue:value=>attempt.readback(Boolean(value.release)),onError:()=>assert.fail()});
  await reader.refresh();assert.equal(posts.length,1);
  await assert.rejects(attempt.submit(post),/不自动重复提交/);assert.equal(posts.length,1);
  const result=await attempt.submit(post,true);assert.equal(result.release.status,'WAITING_SCHEDULER');
  assert.deepEqual(posts,[original,original]);assert.equal(attempt.snapshot().status,'CONFIRMED');
  await assert.rejects(attempt.submit(post,true),/已确认/);assert.equal(posts.length,2);reader.close();
});

test('a matching recovered release resolves unknown outcome without another POST or approval',async()=>{
  const a=fixture(),attempt=createPublicationAttempt(cloudPublicationRequest(a.selector,a.workflow.package.id,attestations));let posts=0;
  await assert.rejects(attempt.submit(async()=>{posts++;throw Error('lost reply');}));
  const reader=createPublicationReader({read:async()=>checkedPublication(a.publication,a.selection.taskId,a.selector),onValue:value=>attempt.readback(Boolean(value.release)),onError:()=>assert.fail()});
  await reader.refresh();assert.equal(attempt.snapshot().status,'CONFIRMED');
  await assert.rejects(attempt.submit(async()=>{posts++;return a.publication;},true));assert.equal(posts,1);reader.close();
});

test('a read started during a POST cannot authorize retry after that POST becomes unknown',async()=>{
  const a=fixture(),pending=deferred(),attempt=createPublicationAttempt(cloudPublicationRequest(a.selector,a.workflow.package.id,attestations));
  const sending=attempt.submit(()=>pending.promise);attempt.readback(false);pending.reject(Error('lost reply'));await assert.rejects(sending);
  assert.equal(attempt.snapshot().readChecked,false);
  await assert.rejects(attempt.submit(async()=>a.publication,true),/先读取/);
});

test('manual PUBLICATION_ONLY permits review without development write, but never inherits it as publication permission',()=>{
  const base={manual:true,canPublish:true,canWrite:false,cloud:true,hasSelector:true,targetMatches:true};
  assert.equal(publicationWriteAllowed(base),true);
  for(const patch of [{canPublish:false,canWrite:true},{canPublish:undefined,canWrite:true},{hasSelector:false},{targetMatches:false},{cloud:false}])assert.equal(publicationWriteAllowed({...base,...patch}),false);
  const now=Date.parse('2026-11-05T10:00:00Z'),a=fixture(),target={taskId:a.selection.taskId,packageDigest:a.selector.packageDigest,verificationId:a.selector.verificationId,startsAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+1000).toISOString()};
  const actual={taskId:a.selection.taskId,packageDigest:a.selector.packageDigest,verificationId:a.selector.verificationId};
  assert.equal(publicationTargetMatches(target,actual,now),true);assert.equal(publicationTargetMatches(target,actual,now+1000),false);
  assert.equal(publicationTargetMatches(target,{...actual,verificationId:'new-rehearsal'},now),false);
});

test('known exact release can be stopped despite a failed/loading monitor read, never from an unconfirmed or other-package cache',()=>{
  const a=fixture(),b=fixture('b'),key=publicationSelectionKey(a.selection.taskId,a.selector);
  const known={taskId:a.selection.taskId,selector:a.selector,release:a.publication.release,publicationKey:key,confirmedReadKey:key,
    pinnedReleaseId:a.publication.release.id,canPublish:true,dirty:false,working:false};
  for(const monitorState of ['READY','ERROR','LOADING'])assert.equal(publicationCancellationAllowed({...known,monitorState}),true);
  for(const patch of [
    {publicationKey:''},{confirmedReadKey:''},{confirmedReadKey:publicationSelectionKey(b.selection.taskId,b.selector)},
    {pinnedReleaseId:undefined},{pinnedReleaseId:b.publication.release.id},{release:undefined},
    {pinnedReleaseId:undefined,release:{...a.publication.release,id:undefined}},
    {selector:b.selector},{release:b.publication.release},{taskId:'other-agent'},
    {canPublish:false},{dirty:true},{working:true},
  ])assert.equal(publicationCancellationAllowed({...known,...patch}),false);
  const now=Date.parse('2026-11-05T10:00:00Z'),target={taskId:a.selection.taskId,packageDigest:a.selector.packageDigest,verificationId:a.selector.verificationId,startsAt:new Date(now-1000).toISOString(),expiresAt:new Date(now).toISOString()};
  assert.equal(publicationCancellationAllowed({...known,canPublish:publicationTargetMatches(target,{taskId:a.selection.taskId,...a.selector},now)}),false);
  const calls=[];
  for(const state of [known,{...known,confirmedReadKey:''}])if(publicationCancellationAllowed(state))calls.push({...state.selector,releaseId:state.pinnedReleaseId});
  assert.deepEqual(calls,[{...a.selector,releaseId:'release-a'}]);
});

test('actual manual review requires four human attestations and never publishes through a forced disabled callback',()=>{
  const a=fixture(),confirmations=[],published=[],base={cloud:true,sourceKind:'MANUAL',originTaskId:a.selection.taskId,packageDigest:a.selector.packageDigest,
    revisionId:a.selection.revisionId,runId:a.selection.runId,verificationId:a.selector.verificationId,confirmed:{},disabled:false,
    onConfirm:(id,checked)=>confirmations.push([id,checked]),onPublish:()=>published.push('publish'),onCancel:()=>{}};
  const tree=AgentPublicationReview(base),html=renderToStaticMarkup(tree),checkboxes=elements(tree,'input');
  assert.match(html,/工程师接管版本/);assert.match(html,/不计作 Agent 自主完成/);assert.equal(checkboxes.length,4);
  assert.equal(checkboxes.every(input=>input.props.checked===false),true);assert.deepEqual(confirmations,[]);
  elements(tree,'button')[0].props.onClick();assert.deepEqual(published,[]);
  checkboxes[0].props.onChange({target:{checked:true}});assert.deepEqual(confirmations,[['code',true]]);
  for(const patch of [{disabled:true},{confirmed:{...attestations,cloudScope:false}},{runId:undefined},{verificationId:undefined}]){
    const blocked=AgentPublicationReview({...base,confirmed:attestations,...patch}),button=elements(blocked,'button')[0];
    assert.equal(button.props.disabled,true);button.props.onClick();assert.deepEqual(published,[]);
  }
  const complete=AgentPublicationReview({...base,confirmed:attestations});elements(complete,'button')[0].props.onClick();assert.deepEqual(published,['publish']);
  assert.throws(()=>cloudPublicationRequest(a.selector,a.workflow.package.id,{...attestations,cloudScope:false}),/逐项审阅/);
});

test('real panel binds manual selectors, guards stale reads/cancel, and does not reset approvals through a new key',()=>{
  const panel=readFileSync('web/src/AgentDeliveryPanel.tsx','utf8'),workbench=readFileSync('web/src/AgentDevelopmentWorkbench.tsx','utf8');
  assert.match(panel,/activePublicationKey\.current!==key/);assert.match(panel,/activeWorkflowSource\.current===workflowSourceKey/);
  assert.match(panel,/publicationReadPath\(taskId,selector,pinned\)/);assert.match(panel,/\{\.\.\.selector,releaseId:selectedReleaseId\}/);
  assert.match(panel,/publicationAttempts\.current\.get\(key\)/);assert.match(panel,/attempt\.submit/);
  assert.match(panel,/idempotencyKey:frozen\.idempotencyKey/);assert.match(panel,/setReview\(false\); setConfirmed\(\{\}\);.*publicationKey/);
  assert.match(panel,/publicationReadKey===publicationKey&&publicationRead==="READY"/);
  assert.match(panel,/publicationReaderKey\.current!==activePublicationKey\.current/);
  assert.match(panel,/!publicationWritable \|\| working \|\| !publicationReady.*!verified.*!fileVerified/);
  assert.match(panel,/disabled=\{!cancellationWritable\}/);
  assert.match(panel,/if \(!publicationCancellationAllowed\(cancellationInput\)\|\|!selector\) return/);
  assert.doesNotMatch(panel,/disabled=\{[^}]*cancellationWritable[^}]*publicationReady/);
  assert.match(workbench,/manual api=.*canPublish=\{canPublish\} publicationTarget=\{publicationTarget\}/);
  assert.match(workbench,/打开本机人工交付流程/);
});
