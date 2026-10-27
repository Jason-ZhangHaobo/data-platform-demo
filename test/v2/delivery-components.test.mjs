import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { deliveryFiles } from '../../src/v2/delivery.mjs';
import { deliveryReviewRequirements } from '../../web/src/delivery-presentation.ts';

// Render the actual TSX components without a browser or network. These are
// markup/semantics tests, not visual or click-interaction acceptance.
async function component(name, exportName = name) {
  const file = new URL(`../../web/src/${name}.tsx`, import.meta.url);
  let source = ts.transpileModule(readFileSync(file, 'utf8'), {compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
  for (const dependency of ['react', 'react/jsx-runtime', 'lucide-react']) source = source.replaceAll(`from "${dependency}"`, `from ${JSON.stringify(import.meta.resolve(dependency))}`);
  source = source.replaceAll('from "./delivery-presentation"', `from ${JSON.stringify(new URL('../../web/src/delivery-presentation.ts', import.meta.url).href)}`);
  source = source.replaceAll('from "./manual-run-recovery"', `from ${JSON.stringify(new URL('../../web/src/manual-run-recovery.ts', import.meta.url).href)}`);
  return (await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`))[exportName];
}
const FilePreview = await component('DeliveryFilePreview');
const Review = await component('AgentPublicationReview');
const publicationTargetMatches = await component('AgentPublicationReview', 'publicationTargetMatches');
const ManualDelivery = await component('DeliveryWorkbench');
const bundle = {id:'fictional-package',digest:'fictional-digest',files:Object.fromEntries(deliveryFiles.map(name=>[name,'fictional content']))};
test('actual embedded manual delivery locks the source selector and does not execute on render',()=>{
  const html=renderToStaticMarkup(React.createElement(ManualDelivery,{api:()=>{throw Error('must not call on render');},runs:[{id:'manual-run',status:'SUCCEEDED',revisionId:'manual-revision',contextId:'holdings-t1',validationContractId:'contract',createdAt:'2026-01-01'}],contractId:'contract',sourceRunId:'manual-run',lockSource:true,canWrite:false,onBack:()=>{}}));
  assert.match(html,/<select[^>]*id="delivery-source"[^>]*disabled=""/);
  assert.match(html,/manual-run/);
});

test('actual file component renders all guided files, version identity and escaped content', () => {
  const html = renderToStaticMarkup(React.createElement(FilePreview,{bundle:{...bundle,files:{...bundle.files,'schedule.json':'<script>unsafe()</script>'}},current:false,onDownload:()=>{throw Error('render must not download');}}));
  for (const name of deliveryFiles) assert(html.includes(name));
  assert.match(html,/历史交付文件/);
  assert.match(html,/fictional-digest/);
  assert.match(html,/&lt;script&gt;/);
  assert(!html.includes('<script>unsafe()'));
  assert.match(html,/aria-pressed="true"/);
  assert.match(html,/下载此文件/);
});
test('empty file package presents a recovery message instead of a blank preview', () => {
  const html=renderToStaticMarkup(React.createElement(FilePreview,{bundle:{...bundle,files:{}},current:true,onDownload:()=>{}}));
  assert.match(html,/role="alert"/);
  assert.match(html,/没有可预览的文件/);
  assert(!html.includes('下载此文件'));
});
test('actual review requires explicit scope confirmations and shows frozen provenance', () => {
  const props={cloud:true,packageDigest:'frozen-digest',revisionId:'revision-one',runId:'run-one',verificationId:'rehearsal-one',confirmed:{},disabled:false,onConfirm:()=>{},onPublish:()=>{throw Error('render must not publish');},onCancel:()=>{}};
  const render = extra => renderToStaticMarkup(React.createElement(Review,{...props,...extra}));
  const html=render({});
  for(const id of ['frozen-digest','revision-one','run-one','rehearsal-one']) assert(html.includes(id));
  assert.match(html,/disabled="">确认并发布此版本/);
  assert.match(html,/暂不发布/);
  assert.match(html,/同一冻结业务日期的两个样例批次，不是两个交易日或生产调度/);
  assert.doesNotMatch(html,/checked=""/);
  const confirmed=Object.fromEntries(deliveryReviewRequirements(true).map(item=>[item.id,true]));
  assert(!/disabled="">确认并发布此版本/.test(render({confirmed})));
  assert.match(render({confirmed,disabled:true}),/disabled="">确认并发布此版本/);
  assert.match(render({confirmed,runId:undefined}),/disabled="">确认并发布此版本/);
  assert.match(render({confirmed,cloud:false}),/disabled="">确认并发布此版本/);
});
test('publication target requires the actual task, package, verification and live window', () => {
  const now=Date.parse('2026-10-27T02:00:00Z'),target={taskId:'fictional-task',packageDigest:'fictional-package-digest',verificationId:'fictional-verification',startsAt:new Date(now-1000).toISOString(),expiresAt:new Date(now+60000).toISOString()};
  const actual={taskId:target.taskId,packageDigest:target.packageDigest,verificationId:target.verificationId};
  assert.equal(publicationTargetMatches(target,actual,now),true);
  for(const field of ['taskId','packageDigest','verificationId']) {
    assert.equal(publicationTargetMatches(target,{...actual,[field]:'different'},now),false);
    assert.equal(publicationTargetMatches(target,{...actual,[field]:undefined},now),false);
    assert.equal(publicationTargetMatches({...target,[field]:''},actual,now),false);
  }
  assert.equal(publicationTargetMatches(target,actual,now-1001),false);
  assert.equal(publicationTargetMatches(target,actual,now+60000),false);
  assert.equal(publicationTargetMatches({...target,expiresAt:'invalid'},actual,now),false);
  assert.equal(publicationTargetMatches(target,actual,NaN),false);
  assert.equal(publicationTargetMatches(undefined,actual,now),true);
});
test('file rehearsal exposes complete source identifiers before publication is enabled', () => {
  const panel=readFileSync(new URL('../../web/src/AgentDeliveryPanel.tsx',import.meta.url),'utf8');
  const files=panel.slice(panel.indexOf('<div id="agent-files"'),panel.indexOf('<div id="agent-publication"'));
  assert.match(files,/\{workflow.verification && <>/);
  const identity=files.match(/<dl className="delivery-review-source" aria-label="交付演练来源">[\s\S]*?<\/dl>/)?.[0];
  assert.ok(identity,'read-only source identity belongs to the file rehearsal section');
  assert.match(identity,/<dt>文件演练编号<\/dt><dd>\{workflow.verification.id\}<\/dd>/);
  assert.match(identity,/<dt>源代码版本<\/dt><dd>\{delivery\?\.sourceRevisionId \?\? "未确认"\}<\/dd>/);
  assert.match(identity,/<dt>源运行批次<\/dt><dd>\{delivery\?\.sourceRunId \?\? "未确认"\}<\/dd>/);
  assert.doesNotMatch(identity,/slice\(|canWrite|publication.available|onClick|<button/);
  assert.doesNotMatch(files,/workflow.publication.available/);
  assert.match(files,/不代表已经批准或发布；未开放发布时仍可核对来源/);
});
