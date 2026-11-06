import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {MetadataStore} from '../../src/v2/store.mjs';
import {createV2Server,PROJECT} from '../../src/v2/server.mjs';
import {createFcIngress} from '../../src/v2/fc-ingress.mjs';
import {createAssetAnnotationRequests} from '../../src/v2/asset-annotation-requests.mjs';
import {checkedAnnotationResult} from '../../src/v2/asset-annotation-client.mjs';
const assetId='fixture:positions',id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,path='/assets/'+assetId+'/annotation-requests',origin='https://synthetic.example.invalid';
const annotation={businessName:'虚构证券持仓',description:'虚构客户持仓标注',domain:'财富管理',owner:'虚构负责人',classification:'INTERNAL_DEMO',tags:['证券']};
async function start(t,readonly=false){const root=mkdtempSync(join(tmpdir(),'shuduo-annotation-api-')),store=new MetadataStore(':memory:'),app=createV2Server({root,store,ingress:createFcIngress({publicHttpEnabled:true,publicReadOnly:readonly}),env:{V2_LOCAL_DEVELOPMENT:'false',V2_PUBLIC_ORIGIN:origin,V2_BOOTSTRAP_ADMIN_EMAIL:'admin@example.invalid',V2_BOOTSTRAP_ADMIN_PASSWORD:'SyntheticAdmin#2026'}});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));store.close();});const base=`http://127.0.0.1:${app.server.address().port}/api/v2`;const request=async(route,body,session,key=id(1),extra={})=>{const r=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Shuduo-Client':'workbench','Idempotency-Key':key,...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}:{}),...extra},body:body===undefined?undefined:JSON.stringify(body)});const value=await r.json();return{status:r.status,body:value,cookie:r.headers.getSetCookie().map(c=>c.split(';',1)[0]).join('; ')}};return{store,app,request};}
async function users(f){const a=await f.request('/auth/login',{email:'admin@example.invalid',password:'SyntheticAdmin#2026'});assert.equal(a.status,200);const admin={cookie:a.cookie,csrf:a.body.csrfToken,id:a.body.user.id};const invited=await f.request('/auth/invitations',{email:'engineer@example.invalid',role:'ENGINEER'},admin);assert.equal(invited.status,201);const b=await f.request('/auth/redeem',{inviteCode:invited.body.inviteCode,displayName:'虚构工程师',password:'SyntheticEngineer#2026'});assert.equal(b.status,200);return{admin,engineer:{cookie:b.cookie,csrf:b.body.csrfToken,id:b.body.user.id}};}

test('HTTP binds original requests to backend identity and keeps rejected writes unapplied',async t=>{
 const f=await start(t),{admin,engineer}=await users(f),body={protocol:'shuduo-asset-annotation-write/v2',requestId:id(1),expected:{revision:0,evidenceHash:f.app.assets.detail(assetId).evidenceHash},annotation};
 const a=await f.request(path,body,admin);assert.equal(a.status,201);assert.equal(a.body.receipt.outcome,'APPLIED');await checkedAnnotationResult(a.body,assetId,id(1),body);
 const denied=await f.request(path+'/'+id(1),undefined,engineer);assert.equal(denied.status,404);const spoof=await f.request(path+'/'+id(1),undefined,engineer,id(1),{'X-Actor-Id':admin.id});assert.equal(spoof.status,404);
 const b=await f.request(path,body,engineer);assert.equal(b.status,201);assert.equal(b.body.receipt.outcome,'REJECTED');assert.equal(f.store.list('asset_annotation',PROJECT).length,1);
 const later=await f.request('/assets/'+assetId+'/annotation',{businessName:'后续版本'},admin,id(2));assert.equal(later.status,201);const own=await f.request(path+'/'+id(1),undefined,admin);assert.equal(own.body.receipt.annotation.revision,1);assert.equal(own.body.current.revision,2);assert.equal(own.body.currentMatches,false);
 const replay=await f.request(path,body,admin);assert.equal(replay.status,200);assert.deepEqual(replay.body.receipt,a.body.receipt);assert.equal(f.store.list('asset_annotation',PROJECT).length,2);
 const user=f.store.get('auth_user',engineer.id,PROJECT);f.store.update('auth_user',user.id,PROJECT,{memberships:user.memberships.map(m=>({...m,role:'VIEWER'}))});assert.equal((await f.request(path,{...body,requestId:id(3)},engineer,id(3))).status,403);assert.equal((await f.request(path+'/'+id(1),undefined,engineer)).status,200);
});
test('readonly FC permits receipt lookup without opening new writes or anonymous access',async t=>{
 const f=await start(t,true),login=await f.request('/auth/login',{email:'admin@example.invalid',password:'SyntheticAdmin#2026'}),admin={cookie:login.cookie,csrf:login.body.csrfToken,id:login.body.user.id};assert.equal(login.status,200);
 const body={protocol:'shuduo-asset-annotation-write/v2',requestId:id(1),expected:{revision:0,evidenceHash:f.app.assets.detail(assetId).evidenceHash},annotation};const manager=createAssetAnnotationRequests({store:f.store,assets:f.app.assets,project:PROJECT});manager.submit(assetId,body,admin.id,id(1));
 const blocked=await f.request(path,{...body,requestId:id(2)},admin,id(2));assert.equal(blocked.status,403);assert.equal(blocked.body.code,'PUBLIC_READ_ONLY');assert.equal((await f.request(path+'/'+id(1),undefined,admin)).status,200);assert.equal((await f.request(path+'/'+id(1))).status,401);assert.equal(f.store.list('asset_annotation',PROJECT).length,1);
});
