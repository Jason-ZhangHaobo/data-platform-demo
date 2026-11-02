import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createV2Server,PROJECT} from '../../src/v2/server.mjs';
import {createFcIngress} from '../../src/v2/fc-ingress.mjs';
import {AuthManager} from '../../src/v2/auth.mjs';
import {MetadataStore} from '../../src/v2/store.mjs';
import {MemorySnapshotBackend,ReplicatedMetadataStore} from '../../src/v2/metadata-replica.mjs';

// Synthetic accounts only; loopback HTTP and an in-memory persistence backend.
const password='FictionalOld!2026',nextPassword='FictionalNew!2026',email='owner@example.invalid',origin='https://securities-fixture.invalid';
const now=Date.parse('2026-11-02T01:00:00Z'),uuid=n=>`${String(n).padStart(8,'0')}-0000-4000-8000-000000000001`;
function acceptsStoredPassword(user,secret){
  const isolated=new MetadataStore(':memory:');
  try{isolated.create('auth_user',PROJECT,user);const auth=new AuthManager({store:isolated,project:PROJECT,env:{},now:()=>now});return auth.login({email:user.email,password:secret}).user.email===user.email;}
  finally{isolated.close();}
}
function scopeEnvironment(scope){
  const shared={V2_LOCAL_DEVELOPMENT:'false',V2_HOST:'127.0.0.1',V2_PUBLIC_ORIGIN:origin,V2_BOOTSTRAP_ADMIN_EMAIL:email,
    V2_PROVISIONING_ONLY:'true',V2_DURABLE_SQL_AGENT_ENABLED:'true'};
  if(scope==='development')return{...shared,V2_FC_PUBLIC_WRITE_SCOPE:'DEVELOPMENT_ONLY',V2_PUBLIC_DEVELOPMENT_TASK_ID:uuid(1),
    V2_PUBLIC_DEVELOPMENT_STARTS_AT:new Date(now-1000).toISOString(),V2_PUBLIC_DEVELOPMENT_EXPIRES_AT:new Date(now+3600000).toISOString()};
  if(scope==='publication')return{...shared,V2_FC_PUBLIC_WRITE_SCOPE:'PUBLICATION_ONLY',V2_PUBLIC_PUBLICATION_TASK_ID:uuid(1),V2_PUBLIC_PUBLICATION_PACKAGE_DIGEST:'a'.repeat(64),V2_PUBLIC_PUBLICATION_VERIFICATION_ID:uuid(2),
    V2_PUBLIC_PUBLICATION_STARTS_AT:new Date(now-1000).toISOString(),V2_PUBLIC_PUBLICATION_EXPIRES_AT:new Date(now+3600000).toISOString()};
  if(scope==='service')return{...shared,V2_PRIVATE_SMOKE_ENABLED:'true',V2_PRIVATE_DATA_SERVICES_ENABLED:'true',V2_FC_PUBLIC_WRITE_SCOPE:'SERVICE_CONSUMPTION_ONLY',
    V2_PUBLIC_SERVICE_STARTS_AT:new Date(now-1000).toISOString(),V2_PUBLIC_SERVICE_EXPIRES_AT:new Date(now+3600000).toISOString(),
    V2_PUBLIC_SERVICE_PLAN:JSON.stringify({taskId:uuid(1),packageDigest:'a'.repeat(64),sourceReleaseRunId:uuid(2),applicationName:'虚构证券应用',
      dapis:[{name:'虚构持仓',slug:'fictional-holdings',fields:['client_id','holding_market_value'],timeoutMs:1000,rateLimitPerMinute:3},
        {name:'虚构现金',slug:'fictional-cash',fields:['client_id','available_cash'],timeoutMs:1000,rateLimitPerMinute:3}],
      xapi:{name:'虚构组合',slug:'fictional-assets',timeoutMs:1500,rateLimitPerMinute:3,steps:[{alias:'holdings',dapiSlug:'fictional-holdings'},{alias:'cash',dapiSlug:'fictional-cash'}]}})};
  return shared;
}
async function setup(t,{scope='readonly',role='ADMIN',backend}={}){
  const root=mkdtempSync(join(tmpdir(),'shuduo-password-maintenance-')),
    store=backend?await ReplicatedMetadataStore.open({backend,project:PROJECT,autoFlush:false}):new MetadataStore(':memory:');
  let clock=now;
  const noExecution=()=>{throw Error('synthetic authentication test must never execute');},runner=Object.assign(noExecution,{durable:{prepare:noExecution,submit:noExecution,read:noExecution,cancel:noExecution}});
  const app=createV2Server({root,store,runner,generator:noExecution,env:scopeEnvironment(scope),now:()=>clock,ingress:createFcIngress({publicHttpEnabled:true,publicReadOnly:scope==='readonly'})});
  const owner=app.auth.bootstrapAdmin({email,password,displayName:'虚构账户持有人'}),other=app.auth.bootstrapAdmin({email:'other@example.invalid',password:'FictionalOther!2026',displayName:'另一虚构用户'});
  store.update('auth_user',owner.id,PROJECT,{memberships:[{projectId:PROJECT,role}]});await store.flush?.();
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  t.after(async()=>{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));if(backend){await store.refresh();await store.closeReplicated();}else store.close();rmSync(root,{recursive:true,force:true});});
  const call=async(path,body,session={},extra={})=>{
    const r=await fetch(`http://127.0.0.1:${app.server.address().port}/api/v2${path}`,{method:body===undefined?'GET':'POST',headers:{origin,'content-type':'application/json','x-shuduo-client':'workbench',...session,...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const cookies=r.headers.getSetCookie();return{status:r.status,body:await r.json(),cookies,cookie:cookies.map(c=>c.split(';')[0]).join('; ')};
  };
  const login=(address=email,secret=password)=>call('/auth/login',{email:address,password:secret});
  const session=r=>({cookie:r.cookie,'x-csrf-token':r.body.csrfToken});
  return{app,store,owner,other,call,login,session,setClock:v=>clock=v};
}
function boundary(body){return Object.fromEntries(Object.entries(body).filter(([k])=>k==='permissions'||k==='readOnly'||k.startsWith('development')||k.startsWith('publication')||k.startsWith('consumption')));}
test('readonly self-password maintenance requires identity, CSRF and current password; cannot target another account or write business data',async t=>{
  const f=await setup(t,{role:'VIEWER'}),initial=f.store.get('auth_user',f.owner.id,PROJECT).passwordHash,otherHash=f.store.get('auth_user',f.other.id,PROJECT).passwordHash;
  const input={currentPassword:password,newPassword:nextPassword};
  assert.equal((await f.call('/auth/password',input)).status,401);
  const login=await f.login(),s=f.session(login);assert.deepEqual(login.body.permissions,['SESSION']);
  assert.equal((await f.call('/auth/password',input,{cookie:s.cookie})).body.code,'CSRF_REQUIRED');
  assert.equal((await f.call('/auth/password',input,s,{'x-project-id':'another-project'})).status,403);
  assert.equal((await f.call('/auth/password',input,s,{origin:'https://foreign.example.invalid'})).status,403);
  assert.equal((await f.call('/auth/password',{...input,currentPassword:'FictionalWrong!2026'},s)).body.code,'CURRENT_PASSWORD_INVALID');
  assert.equal((await f.call('/auth/password',{...input,userId:f.other.id},s)).body.code,'PASSWORD_CHANGE_INPUT_INVALID');
  assert.equal((await f.call('/auth/password',{...input,role:'ADMIN'},s)).body.code,'PASSWORD_CHANGE_INPUT_INVALID');
  assert.equal((await f.call('/auth/password',{...input,newPassword:'weak'},s)).body.code,'WEAK_PASSWORD');
  assert.equal(f.store.get('auth_user',f.owner.id,PROJECT).passwordHash,initial);
  const changed=await f.call('/auth/password',input,s);assert.equal(changed.status,200);assert.equal(changed.body.user.id,f.owner.id);assert.equal(changed.body.role,'VIEWER');
  assert.deepEqual(boundary(changed.body),boundary(login.body));assert.equal(changed.body.readOnly,true);assert.notEqual(changed.cookie,login.cookie);
  assert.ok(changed.cookies.every(c=>c.includes('SameSite=Strict')&&c.includes('Secure')));assert.match(changed.cookies[0],/HttpOnly/);
  assert.equal((await f.call('/auth/session',undefined,s)).body.authenticated,false);
  assert.equal((await f.call('/auth/password',input,s)).status,401);
  const active=f.session(changed);assert.equal((await f.call('/auth/session',undefined,active)).body.authenticated,true);
  assert.equal((await f.call('/auth/password',{currentPassword:nextPassword,newPassword:'FictionalThird!2026'},{cookie:changed.cookie,'x-csrf-token':login.body.csrfToken})).body.code,'CSRF_REQUIRED');
  for(const path of ['/agent/tasks','/runs','/revisions','/releases','/auth/invitations','/auth/redeem','/settings/model-key']){
    const r=await f.call(path,{},active);assert.equal(r.status,403);assert.equal(r.body.code,'PUBLIC_READ_ONLY');
  }
  assert.equal(f.store.get('auth_user',f.other.id,PROJECT).passwordHash,otherHash);
  assert.equal((await f.login(email,password)).status,401);assert.equal((await f.login(email,nextPassword)).status,200);
  const persisted=JSON.stringify(['auth_user','auth_session','auth_audit','auth_attempt'].flatMap(k=>f.store.list(k,PROJECT)));
  for(const secret of [password,nextPassword,'FictionalWrong!2026'])assert.equal(persisted.includes(secret),false);
  for(const k of ['agent','run','release','release_approval','auth_invitation'])assert.equal(f.store.list(k,PROJECT).length,0);
});
test('password refresh preserves each live and expired development, publication and service session boundary',async t=>{
  for(const scope of ['development','publication','service'])await t.test(scope,async t=>{
    const f=await setup(t,{scope}),login=await f.login(),changed=await f.call('/auth/password',{currentPassword:password,newPassword:nextPassword},f.session(login));
    assert.equal(changed.status,200);assert.deepEqual(boundary(changed.body),boundary(login.body));assert.equal(changed.body.permissions.includes('*'),false);
    assert.equal((await f.call('/auth/session',undefined,f.session(login))).body.authenticated,false);
    f.setClock(now+3600000);
    const expired=await f.call('/auth/session',undefined,f.session(changed));assert.equal(expired.body.readOnly,true);
    const again=await f.call('/auth/password',{currentPassword:nextPassword,newPassword:'FictionalThird!2026'},f.session(changed));
    assert.equal(again.status,200);assert.deepEqual(boundary(again.body),boundary(expired.body));assert.deepEqual(again.body.permissions,['SESSION']);
    assert.equal((await f.call('/revisions',{},f.session(again))).status,403);
    assert.equal((await f.call('/auth/invitations',{},f.session(again))).status,403);
    assert.equal((await f.call('/auth/session',undefined,f.session(changed))).body.authenticated,false);
  });
});
test('failed password persistence never returns a session cookie or authenticated success, including unknown commit acknowledgement',async t=>{
  for(const committed of [false,true])await t.test(committed?'saved remotely but reply lost':'not committed',async t=>{
    const backend=new MemorySnapshotBackend(),f=await setup(t,{backend}),login=await f.login(),original=backend.compareAndSwap.bind(backend);
    backend.compareAndSwap=async(project,version,payload)=>{
      if(payload.documents.some(d=>d.kind==='auth_user'&&d.id===f.owner.id&&JSON.parse(d.data).passwordChangedAt)){
        if(committed)await original(project,version,payload);
        throw Object.assign(Error('synthetic unavailable'),{status:503,code:'SYNTHETIC_STORAGE_FAILURE'});
      }
      return original(project,version,payload);
    };
    const failed=await f.call('/auth/password',{currentPassword:password,newPassword:nextPassword},f.session(login));
    assert.equal(failed.status,503);assert.equal(failed.cookies.length,0);assert.equal(failed.body.user,undefined);assert.equal(failed.body.csrfToken,undefined);
    const replica=await ReplicatedMetadataStore.open({backend,project:PROJECT,autoFlush:false});
    try{
      const user=replica.get('auth_user',f.owner.id,PROJECT),auth=new AuthManager({store:replica,project:PROJECT,env:{},now:()=>now});
      assert.equal(acceptsStoredPassword(user,committed?nextPassword:password),true);
      assert.equal(Boolean(auth.sessionFromHeaders(f.session(login))),!committed);
    }finally{await replica.closeReplicated();}
    backend.compareAndSwap=original;await f.store.refresh();
    assert.equal((await f.login(email,committed?nextPassword:password)).status,200);
  });
});
test('successful password change survives metadata replica replacement with old sessions revoked',async t=>{
  const backend=new MemorySnapshotBackend(),f=await setup(t,{backend}),login=await f.login();
  const changed=await f.call('/auth/password',{currentPassword:password,newPassword:nextPassword},f.session(login));assert.equal(changed.status,200);
  const replica=await ReplicatedMetadataStore.open({backend,project:PROJECT,autoFlush:false});
  try{
    const auth=new AuthManager({store:replica,project:PROJECT,env:{},now:()=>now});
    assert.equal(auth.sessionFromHeaders(f.session(login)),undefined);
    assert.equal(auth.sessionFromHeaders(f.session(changed)).user.id,f.owner.id);
    assert.equal(acceptsStoredPassword(replica.get('auth_user',f.owner.id,PROJECT),nextPassword),true);
  }finally{await replica.closeReplicated();}
});
