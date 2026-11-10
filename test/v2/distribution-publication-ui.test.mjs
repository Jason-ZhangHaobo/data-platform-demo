import test from 'node:test';import assert from 'node:assert/strict';import{readFileSync}from'node:fs';import ts from'typescript';import React from'react';import{renderToStaticMarkup}from'react-dom/server';
async function component(name){let code=ts.transpileModule(readFileSync(`web/src/${name}.tsx`,'utf8'),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
 for(const dep of ['react','react/jsx-runtime'])code=code.replaceAll(`from '${dep}'`,`from ${JSON.stringify(import.meta.resolve(dep))}`).replaceAll(`from "${dep}"`,`from ${JSON.stringify(import.meta.resolve(dep))}`);
 code=code.replaceAll('from "./delivery-presentation"',`from ${JSON.stringify(new URL('../../web/src/delivery-presentation.ts',import.meta.url).href)}`);
 return(await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64')))[name];}
const Review=await component('AgentPublicationReview'),Controls=await component('LocalDistributionControls');
test('distribution publication review explicitly confirms two frozen local batches and does not inherit file review',()=>{
 const props={cloud:false,distribution:true,packageDigest:'a'.repeat(64),revisionId:'revision',runId:'run',verificationId:'verification',confirmed:{},disabled:false,onConfirm:()=>{throw Error('render must not confirm');},onPublish:()=>{throw Error('render must not publish');},onCancel:()=>{}};
 const html=renderToStaticMarkup(React.createElement(Review,props));assert.match(html,/同一冻结业务日/);assert.match(html,/不调用模型/);assert.match(html,/0 \/ 4/);assert.match(html,/<button[^>]*disabled=""/);
 const complete=renderToStaticMarkup(React.createElement(Review,{...props,confirmed:{code:true,assertions:true,deliveryFiles:true,localScope:true}}));assert.match(complete,/4 \/ 4/);assert.match(complete,/确认并发布此版本/);
});
test('local controls preserve readonly scope and expose the exact rollback target task without executing on render',()=>{
 const props={api:()=>{throw Error('render must not mutate');},release:{id:'release',status:'ACTIVE_LOCAL',packageDigest:'a'.repeat(64)},targets:[],canWrite:false,ready:true,canRollback:true,onRefresh:async()=>{throw Error('render must not read');}};
 const html=renderToStaticMarkup(React.createElement(Controls,props));assert.match(html,/停止此本机测试发布/);assert.match(html,/暂无同族健康历史版本/);assert.match(html,/<select[^>]*disabled=""/);
 const rolled=renderToStaticMarkup(React.createElement(Controls,{...props,release:{...props.release,status:'ROLLED_BACK_LOCAL',rolledBackToTaskId:'00000000-0000-4000-8000-000000000001'}}));assert.match(rolled,/task=00000000-0000-4000-8000-000000000001/);assert.doesNotMatch(rolled,/停止此本机测试发布/);
});
