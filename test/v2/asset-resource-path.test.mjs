import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assetResourcePath, isAssetResourceId } from "../../src/v2/asset-resource-path.mjs";
import { createFcIngress } from "../../src/v2/fc-ingress.mjs";
import { createV2Server, PROJECT } from "../../src/v2/server.mjs";
import { MetadataStore } from "../../src/v2/store.mjs";
import { assetDetailValid } from "../../web/src/asset-read.ts";
import { runV2Cli } from "../../bin/shuduo.mjs";
import { handleV2Mcp } from "../../bin/shuduo-mcp.mjs";

test("canonical asset IDs remain valid path segments without weakening ingress",()=>{
 const ingress=createFcIngress({publicHttpEnabled:true,publicReadOnly:true});
 for(const id of ["fixture:positions","source:00000000-0000-4000-8000-000000000001","landing:raw_positions","stream-source:sample","dataset:customer_assets_t1","service:sample"]){
  assert(isAssetResourceId(id));const path=assetResourcePath(id);assert.equal(path,`/assets/${id}`);assert.equal(ingress.assertRequest({url:'/api/v2'+path,method:'GET',headers:{},rawHeaders:[],socket:{}}),'HTTP');
  assert.throws(()=>ingress.assertRequest({url:'/api/v2/assets/'+encodeURIComponent(id),method:'GET',headers:{},rawHeaders:[],socket:{}}),error=>error.ingressReason==='TARGET_ENCODING');
 }
 for(const id of [null,[],17,"../unsafe","fixture:a/b","fixture:a?b","fixture:a#b","fixture:a%3Ab"," fixture:positions","fixture:证券",'x'.repeat(161)])assert.throws(()=>assetResourcePath(id));
 assert.throws(()=>assetResourcePath('fixture:positions','../internal'));
});

test("CLI and MCP use the same canonical read and annotation paths",async()=>{
 const calls=[],client={request:async(path,options)=>{calls.push({path,options});return{synthetic:true};}};
 for(const [cli,tool,action] of [['show','asset_detail',undefined],['lineage','asset_lineage','lineage'],['impact','asset_impact','impact']]){
  assert.equal(await runV2Cli(['assets',cli,'--id','fixture:positions'],{},{client,output(){},error(){}}),0);
  const result=JSON.parse(await handleV2Mcp({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:tool,arguments:{assetId:'fixture:positions'}}},{client}));assert.equal(result.error,undefined);
  assert.equal(calls.at(-1).path,assetResourcePath('fixture:positions',action));assert.equal(calls.at(-2).path,calls.at(-1).path);
 }
 assert.equal(await runV2Cli(['assets','annotate','--id','fixture:positions','--business-name','虚构持仓','--description','虚构证券说明','--domain','财富管理','--owner','虚构负责人'],{},{client,output(){},error(){}}),0);
 const annotated=JSON.parse(await handleV2Mcp({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'asset_annotate',arguments:{assetId:'fixture:positions',businessName:'虚构持仓',description:'虚构证券说明',domain:'财富管理',owner:'虚构负责人',tags:['虚构']}}},{client}));
 assert.equal(annotated.error,undefined);assert.equal(calls.at(-1).path,'/assets/fixture:positions/annotation');assert.equal(calls.at(-2).path,calls.at(-1).path);
 assert.equal(calls.length,8);assert(calls.every(call=>!call.path.includes('%')));
 const before=calls.length;assert.equal(await runV2Cli(['assets','show','--id','fixture:a/b'],{},{client,output(){},error(){}}),1);assert.equal(calls.length,before);
});

test("real readonly FC routing permits authenticated canonical reads and keeps encoded paths and writes closed",async t=>{
 const root=mkdtempSync(join(tmpdir(),'shuduo-asset-uri-')),store=new MetadataStore(':memory:'),origin='https://synthetic.example.invalid';
 const app=createV2Server({root,store,ingress:createFcIngress({publicHttpEnabled:true,publicReadOnly:true}),env:{V2_LOCAL_DEVELOPMENT:'false',V2_PUBLIC_ORIGIN:origin,V2_BOOTSTRAP_ADMIN_EMAIL:'synthetic-admin@example.invalid',V2_BOOTSTRAP_ADMIN_PASSWORD:'SyntheticOnly#Admin2026',V2_BOOTSTRAP_ADMIN_NAME:'虚构管理员'}});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${app.server.address().port}/api/v2`;
 t.after(async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));store.close();});
 const login=await fetch(base+'/auth/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Shuduo-Client':'workbench'},body:JSON.stringify({email:'synthetic-admin@example.invalid',password:'SyntheticOnly#Admin2026'})});assert.equal(login.status,200);
 const cookie=login.headers.getSetCookie().map(value=>value.split(';',1)[0]).join('; ');await login.arrayBuffer();
 const request=(path,method='GET')=>fetch(base+path,{method,headers:{Cookie:cookie,Origin:origin,'Content-Type':'application/json','X-Shuduo-Client':'workbench'},...(method==='POST'?{body:'{}'}:{})});
 const detail=await request(assetResourcePath('fixture:positions'));assert.equal(detail.status,200);assert.equal(assetDetailValid(await detail.json(),'fixture:positions'),true);
 for(const action of ['lineage','impact']){const result=await request(assetResourcePath('fixture:positions',action));assert.equal(result.status,200);await result.arrayBuffer();}
 const encoded=await request('/assets/fixture%3Apositions');assert.equal(encoded.status,404);assert.equal((await encoded.json()).code,'INGRESS_DENIED');
 const write=await request(assetResourcePath('fixture:positions','annotation'),'POST');assert.equal(write.status,403);assert.equal((await write.json()).code,'PUBLIC_READ_ONLY');
 const anonymous=await fetch(base+assetResourcePath('fixture:positions'));assert.equal(anonymous.status,401);await anonymous.arrayBuffer();
 assert.equal(store.list('asset_annotation',PROJECT).length,0);
});

test("annotation tags distinguish omission from an explicit empty set",async t=>{
 const root=mkdtempSync(join(tmpdir(),'shuduo-asset-tags-')),store=new MetadataStore(':memory:'),app=createV2Server({root,store,env:{V2_LOCAL_DEVELOPMENT:'true',V2_RELEASE_SCHEDULER_MODE:'DISABLED'}});
 await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${app.server.address().port}/api/v2`;
 t.after(async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));store.close();});
 const path=assetResourcePath('fixture:positions'),initial=await(await fetch(base+path)).json();assert(initial.tags.length>0);
 const post=async(body,key)=>{const r=await fetch(base+path+'/annotation',{method:'POST',headers:{'Content-Type':'application/json','X-Shuduo-Client':'workbench','Idempotency-Key':key},body:JSON.stringify(body)});assert.equal(r.status,201);return r.json();};
 const kept=await post({businessName:'虚构持仓说明'},'omit-tags');assert.deepEqual(kept.tags,initial.tags);
 const cleared=await post({tags:[]},'clear-tags');assert.deepEqual(cleared.tags,[]);
 const reread=await(await fetch(base+path)).json();assert.deepEqual(reread.tags,[]);assert.equal(reread.annotation.revision,2);assert.equal(store.list('asset_annotation',PROJECT).length,2);
});
