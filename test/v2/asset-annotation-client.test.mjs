import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MetadataStore} from '../../src/v2/store.mjs';
import {createV2Server,PROJECT} from '../../src/v2/server.mjs';
import {createAssetAnnotationRequests} from '../../src/v2/asset-annotation-requests.mjs';
import {createAnnotationSubmission,annotationRecoveryMarker,annotationRecoveryLocation,assetLocationTarget} from '../../web/src/asset-annotation-submission.ts';
import {runV2Cli} from '../../bin/shuduo.mjs';
import {handleV2Mcp} from '../../bin/shuduo-mcp.mjs';
const assetId='fixture:positions',id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
function fixture(t){const root=mkdtempSync(join(tmpdir(),'shuduo-annotation-client-')),store=new MetadataStore(':memory:'),app=createV2Server({root,store,env:{V2_LOCAL_DEVELOPMENT:'true',V2_RELEASE_SCHEDULER_MODE:'DISABLED'}}),manager=createAssetAnnotationRequests({store,assets:app.assets,project:PROJECT});t.after(()=>{app.server.emit('close');store.close();});const body={protocol:'shuduo-asset-annotation-write/v2',requestId:id(1),expected:{revision:0,evidenceHash:app.assets.detail(assetId).evidenceHash},annotation:{businessName:'虚构客户持仓',description:'虚构证券标注恢复',domain:'财富管理',owner:'虚构负责人',classification:'INTERNAL_DEMO',tags:['证券']}};return{root,store,app,manager,body};}
const apiFor=(f,calls,options={})=>async(path,body,request)=>{
 calls.push({path,body,request});const key=path.split('/').at(-1);
 if(body!==undefined){if(options.beforeWrite)throw Error('synthetic request not received');const result=f.manager.submit(assetId,body,'actor-a',request.idempotencyKey);if(options.lostReply)throw Error('synthetic reply lost');return result;}
 return f.manager.lookup(assetId,key,'actor-a');
};
test('lost save replies restore the exact original result without another write',async t=>{
 const f=fixture(t),calls=[],pending=[],options={lostReply:true},controller=createAnnotationSubmission({api:apiFor(f,calls,options),assetId,onPending:key=>pending.push(key),makeKey:()=>id(1)});
 const body={expected:f.body.expected,annotation:{...f.body.annotation}};await assert.rejects(controller.submit(body));body.annotation.businessName='不得代替原内容';f.app.assets.annotate(assetId,{owner:'后续负责人'});
 const result=await controller.retry();assert.equal(result.receipt.annotation.businessName,'虚构客户持仓');assert.equal(result.receipt.annotation.revision,1);assert.equal(result.current.revision,2);assert.equal(result.currentMatches,false);assert.equal(calls.filter(call=>call.body!==undefined).length,1);controller.acknowledge(id(1));assert.deepEqual(pending,[id(1),undefined]);
});
test('explicit retry after not-found uses the frozen original body and same UUID',async t=>{
 const f=fixture(t),calls=[],options={beforeWrite:true},controller=createAnnotationSubmission({api:apiFor(f,calls,options),assetId,onPending(){},makeKey:()=>id(1)});const body={expected:f.body.expected,annotation:{...f.body.annotation}};
 await assert.rejects(controller.submit(body));body.annotation.owner='不应写入';options.beforeWrite=false;const result=await controller.retry();assert.equal(result.receipt.annotation.owner,'虚构负责人');assert.equal(result.requestId,id(1));assert.equal(calls.filter(call=>call.body!==undefined).length,2);assert.equal(f.store.list('asset_annotation',PROJECT).length,1);
});
test('reloaded controllers only query and cannot reconstruct missing source text',async t=>{
 const f=fixture(t),calls=[],controller=createAnnotationSubmission({api:apiFor(f,calls),assetId,initialKey:id(1),onPending(){}});await assert.rejects(controller.recover());await assert.rejects(controller.retry(),/仅可查询|仅能查询|仅可读取|仅可|仅能/);assert.equal(calls.filter(call=>call.body!==undefined).length,0);
});
test('known stale rejection is recoverable and cannot be applied by a later replay',async t=>{
 const f=fixture(t),calls=[];f.app.assets.annotate(assetId,{owner:'先行负责人'});const controller=createAnnotationSubmission({api:apiFor(f,calls),assetId,onPending(){},makeKey:()=>id(1)});const result=await controller.submit({expected:f.body.expected,annotation:f.body.annotation});assert.equal(result.receipt.outcome,'REJECTED');controller.acknowledge(result.requestId);assert.equal(f.store.list('asset_annotation',PROJECT).length,1);
});
test('recovery URLs carry only bounded original identifiers, never annotation values',()=>{
 const url=annotationRecoveryLocation('https://demo.example.invalid/v2/?module=assets&description=not-carried&token=never-copy',assetId,id(1));assert.equal(url.searchParams.get('description'),null);assert.equal(url.searchParams.get('token'),null);assert.deepEqual(annotationRecoveryMarker(url.href),{state:'VALID',assetId,requestId:id(1)});assert.equal(assetLocationTarget(url.href),assetId);
 for(const bad of [url.href+'&annotation_request='+id(2),url.href.replace('annotation_asset=','missing_asset='),url.href.replace(id(1),'bad-id')])assert.equal(annotationRecoveryMarker(bad).state,'INVALID');
 assert.equal(annotationRecoveryMarker(annotationRecoveryLocation(url.href,assetId).href).state,'ABSENT');
});
test('CLI and MCP share condition checks and distinguish rejection from applied writes',async t=>{
 const f=fixture(t),calls=[],client={request:async(path,options)=>{calls.push({path,options});return options?.body?f.manager.submit(assetId,options.body,'actor-a',options.idempotencyKey):f.manager.lookup(assetId,path.split('/').at(-1),'actor-a');}};
 const file=join(f.root,'request.json');writeFileSync(file,JSON.stringify(f.body));assert.equal(await runV2Cli(['assets','annotation-submit','--id',assetId,'--file',file],{},{client,output(){},error(){}}),0);
 const read=JSON.parse(await handleV2Mcp({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'asset_annotation_request',arguments:{assetId,requestId:id(1)}}},{client}));assert.equal(read.result.structuredContent.receipt.annotation.revision,1);
 const rejected={...f.body,requestId:id(2)};writeFileSync(file,JSON.stringify(rejected));assert.equal(await runV2Cli(['assets','annotation-submit','--id',assetId,'--file',file],{},{client,output(){},error(){}}),2);
 const replay=JSON.parse(await handleV2Mcp({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'asset_annotation_submit',arguments:{assetId,request:rejected}}},{client}));assert.equal(replay.result.isError,true);assert.equal(replay.result.structuredContent.receipt.outcome,'REJECTED');assert.equal(f.store.list('asset_annotation',PROJECT).length,1);assert(calls.every(call=>!call.path.includes('%')));
});
