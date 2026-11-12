import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
let source=ts.transpileModule(readFileSync('web/src/LocalDistributionReview.tsx','utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
for(const dependency of ['react','react/jsx-runtime'])source=source.replaceAll(`from '${dependency}'`,`from ${JSON.stringify(import.meta.resolve(dependency))}`).replaceAll(`from "${dependency}"`,`from ${JSON.stringify(import.meta.resolve(dependency))}`);
const {LocalDistributionReview}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const props={api:()=>{throw Error('render must not write');},packageId:'synthetic-package',packageDigest:'a'.repeat(64),verificationId:'synthetic-verification',enabled:true,onRefresh:async()=>{throw Error('render must not read');}};
test('local distribution review requires four explicit checks, remains distinct from publication, and never writes on render',()=>{
 const html=renderToStaticMarkup(React.createElement(LocalDistributionReview,props));assert.equal((html.match(/type="checkbox"/g)??[]).length,4);
 assert.match(html,/复合键、占比分母与六位精度/);assert.match(html,/不批准发布/);assert.match(html,/<button[^>]*disabled=""/);
 const readonly=renderToStaticMarkup(React.createElement(LocalDistributionReview,{...props,enabled:false}));assert.equal((readonly.match(/type="checkbox"[^>]*disabled=""/g)??[]).length,4);
});
test('a historical review is shown as retained evidence rather than current approval',()=>{
 const review={id:'synthetic-review',status:'REVIEWED',packageId:props.packageId,packageDigest:props.packageDigest,verificationId:props.verificationId,reviewedAt:'2026-09-10',scope:'LOCAL_FILE_REVIEW'};
 const current=renderToStaticMarkup(React.createElement(LocalDistributionReview,{...props,review}));assert.match(current,/此包本机文件已审阅/);assert.match(current,/不代表批准发布/);
 const stale=renderToStaticMarkup(React.createElement(LocalDistributionReview,{...props,review,current:false,enabled:false}));assert.match(stale,/当前依据需重新核验/);assert.doesNotMatch(stale,/class="passed"/);
});
test('a signed fund review shows its current rehearsal digest and asks for fresh checks after replacement',()=>{
 const signed=renderToStaticMarkup(React.createElement(LocalDistributionReview,{...props,fund:true,staleReview:true,fundReview:{status:'READY',digest:'b'.repeat(64)}}));
 assert.match(signed,/签名演练摘要 bbbbbbbbbbbbbbbb/);
 assert.match(signed,/演练依据已更新，请重新逐项审阅/);
 assert.doesNotMatch(signed,/checked=""/);
 const unavailable=renderToStaticMarkup(React.createElement(LocalDistributionReview,{...props,fund:true,fundReview:{status:'UNAVAILABLE'}}));
 assert.match(unavailable,/签名演练依据暂未核对/);
 assert.equal((unavailable.match(/type="checkbox"[^>]*disabled=""/g)??[]).length,4);
});
