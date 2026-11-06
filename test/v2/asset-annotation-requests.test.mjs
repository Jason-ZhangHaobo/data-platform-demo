import test from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {MetadataStore} from '../../src/v2/store.mjs';
import {createV2Server,PROJECT} from '../../src/v2/server.mjs';
import {createAssetAnnotationRequests} from '../../src/v2/asset-annotation-requests.mjs';
import {ANNOTATION_WRITE_PROTOCOL,normalizeAnnotationWrite,validAnnotationReceipt} from '../../src/v2/asset-annotation-contract.mjs';
import {checkedAnnotationResult} from '../../src/v2/asset-annotation-client.mjs';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,assetId='fixture:positions';
const values={businessName:'虚构客户持仓',description:'虚构证券持仓说明',domain:'财富管理',owner:'虚构负责人',classification:'INTERNAL_DEMO',tags:['证券']};
function fixture(t){const root=mkdtempSync(join(tmpdir(),'shuduo-annotation-v2-')),store=new MetadataStore(':memory:'),app=createV2Server({root,store,env:{V2_LOCAL_DEVELOPMENT:'true',V2_RELEASE_SCHEDULER_MODE:'DISABLED'}}),requests=createAssetAnnotationRequests({store,assets:app.assets,project:PROJECT});t.after(()=>{app.server.emit('close');store.close();});const body=(n=1,patch={})=>({protocol:ANNOTATION_WRITE_PROTOCOL,requestId:id(n),expected:{revision:0,evidenceHash:app.assets.detail(assetId).evidenceHash},annotation:{...values},...patch});return{store,app,requests,body};}

test('conditional writes return immutable original receipts after later versions',async t=>{
 const f=fixture(t),body=f.body(),first=f.requests.submit(assetId,body,'actor-a',id(1));assert.equal(first.receipt.outcome,'APPLIED');assert.equal(first.receipt.annotation.revision,1);assert(first.currentMatches);assert(validAnnotationReceipt(first.receipt));
 f.app.assets.annotate(assetId,{businessName:'后续虚构名称'});const original=f.requests.lookup(assetId,id(1),'actor-a');assert.deepEqual(original.receipt,first.receipt);assert.equal(original.receiptHash,first.receiptHash);assert.equal(original.current.revision,2);assert.equal(original.currentMatches,false);
 const replay=f.requests.submit(assetId,body,'actor-a',id(1));assert.deepEqual(replay.receipt,first.receipt);assert.equal(f.store.list('asset_annotation',PROJECT).length,2);await checkedAnnotationResult(replay,assetId,id(1),body);
});
test('stale baselines create stable rejection receipts and no annotation',t=>{
 const f=fixture(t),first=f.body();f.requests.submit(assetId,first,'actor-a',id(1));const second=f.requests.submit(assetId,{...first,requestId:id(2)},'actor-b',id(2));assert.equal(second.receipt.outcome,'REJECTED');assert.equal(second.receipt.rejection.code,'BASE_STALE');assert.equal(second.receipt.annotation,null);assert.equal(f.store.list('asset_annotation',PROJECT).length,1);
 f.app.assets.annotate(assetId,{owner:'后续虚构负责人'});const repeated=f.requests.submit(assetId,{...first,requestId:id(2)},'actor-b',id(2));assert.deepEqual(repeated.receipt,second.receipt);assert.equal(f.store.list('asset_annotation',PROJECT).length,2);
});
test('same request UUID is isolated by identity and cannot be used with changed content',t=>{
 const f=fixture(t),body=f.body();const a=f.requests.submit(assetId,body,'actor-a',id(1));assert.throws(()=>f.requests.lookup(assetId,id(1),'actor-b'),error=>error.status===404);const b=f.requests.submit(assetId,body,'actor-b',id(1));assert.equal(b.receipt.outcome,'REJECTED');assert.notEqual(a.id,b.id);assert.equal(f.requests.lookup(assetId,id(1),'actor-a').receipt.outcome,'APPLIED');assert.throws(()=>f.requests.submit(assetId,{...body,annotation:{...values,owner:'不同负责人'}},'actor-a',id(1)),error=>error.status===409);assert.equal(f.store.list('asset_annotation',PROJECT).length,1);
});
test('evidence changes are rejected even when the annotation revision is unchanged',t=>{
 const f=fixture(t),body=f.body(3,{expected:{revision:0,evidenceHash:'f'.repeat(64)}});const rejected=f.requests.submit(assetId,body,'actor-a',id(3));assert.equal(rejected.receipt.outcome,'REJECTED');assert.equal(f.store.list('asset_annotation',PROJECT).length,0);
});
test('legacy records are preserved and never migrated into v2 requests',t=>{
 const f=fixture(t),legacy=f.app.assets.annotate(assetId,{businessName:'旧协议名称'});f.store.deduplicate(`${PROJECT}:asset-annotation:${assetId}:${id(1)}`,'legacy-body',()=>f.store.get('asset_annotation',legacy.annotation.id,PROJECT));assert.throws(()=>f.requests.lookup(assetId,id(1),'actor-a'),error=>error.status===404);const result=f.requests.submit(assetId,f.body(1,{expected:{revision:1,evidenceHash:f.app.assets.detail(assetId).evidenceHash}}),'actor-a',id(1));assert.equal(result.receipt.annotation.revision,2);assert(f.store.get('asset_annotation',legacy.annotation.id,PROJECT));
});
test('original receipts remain readable when current asset projection is unavailable',t=>{
 const f=fixture(t),first=f.requests.submit(assetId,f.body(),'actor-a',id(1));const requests=createAssetAnnotationRequests({store:f.store,assets:{detail(){throw Error('synthetic current projection failure');}},project:PROJECT});const original=requests.lookup(assetId,id(1),'actor-a');assert.deepEqual(original.receipt,first.receipt);assert.deepEqual(original.current,{state:'UNAVAILABLE'});assert.equal(original.currentMatches,false);
});
test('corrupt receipts or original annotation rows are rejected without repair or replay',t=>{
 const f=fixture(t),result=f.requests.submit(assetId,f.body(),'actor-a',id(1));const record=f.store.get('asset_annotation_request_v2',result.id,PROJECT);f.store.update('asset_annotation_request_v2',record.id,PROJECT,{receiptHash:'0'.repeat(64)});assert.throws(()=>f.requests.lookup(assetId,id(1),'actor-a'),error=>error.code==='ANNOTATION_RECEIPT_CORRUPT');assert.equal(f.store.list('asset_annotation',PROJECT).length,1);
});
test('validation rejects actor spoofing, incomplete bodies and conflicting header keys',t=>{
 const f=fixture(t),body=f.body();for(const value of [{...body,actorId:'other'},{...body,expected:{revision:0}},{...body,annotation:{...values,secret:'not-allowed'}},{...body,expected:{...body.expected,revision:-1}}])assert.throws(()=>f.requests.submit(assetId,value,'actor-a',id(1)),error=>error.status===400);assert.throws(()=>f.requests.submit(assetId,body,'actor-a',id(2)),error=>error.status===400);assert.equal(f.store.list('asset_annotation',PROJECT).length,0);assert.equal(f.store.list('asset_annotation_request_v2',PROJECT).length,0);
 assert.equal(normalizeAnnotationWrite(assetId,{...body,annotation:{...values,businessName:' 虚构客户持仓 '}}).annotation.businessName,values.businessName);
});
test('receipt digest and exact original request are independently verified by the shared client',async t=>{
 const f=fixture(t),body=f.body(),result=f.requests.submit(assetId,body,'actor-a',id(1));assert.equal((await checkedAnnotationResult(result,assetId,id(1),body)).id,result.id);await assert.rejects(checkedAnnotationResult({...result,receiptHash:'0'.repeat(64)},assetId,id(1)));await assert.rejects(checkedAnnotationResult(result,assetId,id(1),{...body,annotation:{...values,businessName:'另一请求名称'}}));await assert.rejects(checkedAnnotationResult({...result,currentMatches:false},assetId,id(1)));
});
test('receipt creation failure rolls back the annotation and permits a later exact retry',t=>{
 const f=fixture(t),create=f.store.create.bind(f.store);f.store.create=(kind,...args)=>{if(kind==='asset_annotation_request_v2')throw Error('synthetic receipt failure');return create(kind,...args);};assert.throws(()=>f.requests.submit(assetId,f.body(),'actor-a',id(1)),/receipt failure/);assert.equal(f.store.list('asset_annotation',PROJECT).length,0);f.store.create=create;assert.equal(f.requests.submit(assetId,f.body(),'actor-a',id(1)).receipt.annotation.revision,1);
});
test('receipts and condition checks survive a fresh SQLite connection',()=>{
 const root=mkdtempSync(join(tmpdir(),'shuduo-annotation-restart-')),file=join(root,'metadata.sqlite');let store=new MetadataStore(file),app=createV2Server({root,store,env:{V2_LOCAL_DEVELOPMENT:'true',V2_RELEASE_SCHEDULER_MODE:'DISABLED'}}),manager=createAssetAnnotationRequests({store,assets:app.assets,project:PROJECT});const body={protocol:ANNOTATION_WRITE_PROTOCOL,requestId:id(1),expected:{revision:0,evidenceHash:app.assets.detail(assetId).evidenceHash},annotation:values},original=manager.submit(assetId,body,'actor-a',id(1));app.server.emit('close');store.close();
 store=new MetadataStore(file);app=createV2Server({root,store,env:{V2_LOCAL_DEVELOPMENT:'true',V2_RELEASE_SCHEDULER_MODE:'DISABLED'}});manager=createAssetAnnotationRequests({store,assets:app.assets,project:PROJECT});try{assert.deepEqual(manager.lookup(assetId,id(1),'actor-a').receipt,original.receipt);assert.equal(manager.submit(assetId,body,'actor-a',id(1)).receipt.annotation.revision,1);assert.equal(store.list('asset_annotation',PROJECT).length,1);}finally{app.server.emit('close');store.close();}
});
