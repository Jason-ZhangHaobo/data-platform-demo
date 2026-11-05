import test from 'node:test';
import assert from 'node:assert/strict';
import {createSecureConfigServer} from '../../scripts/start-v2-secure-config.mjs';
import {mountSecureConfigForm} from '../../scripts/secure-config-client.mjs';
const input=()=>({mysql:'SyntheticMysql!42',currentPassword:'OldSynthetic!42',password:'NewSynthetic!42',confirm:'NewSynthetic!42',modelKey:'sk-synthetic-status-key'});
const standard=()=>({mysql:'SyntheticMysql!42',email:'owner@example.invalid',password:'NewSynthetic!42',confirm:'NewSynthetic!42'});
async function fixture(t,options={}){
 const calls=[],entry=createSecureConfigServer({random:n=>Buffer.alloc(n,7),ghRunner:async(args)=>calls.push(args),...options}),{url}=await entry.listen();
 t.after(async()=>{if(entry.server.listening){entry.server.closeAllConnections();await new Promise(resolve=>entry.server.close(resolve));}});
 const page=await fetch(url),cookie=page.headers.getSetCookie()[0].split(';')[0];await page.text();
 const headers={origin:url,cookie,'x-setup-token':'07'.repeat(32),'content-type':'application/json'};
 const call=async(path,method='GET',body,overrides={})=>{const r=await fetch(url+path,{method,headers:{...headers,...overrides},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,body:await r.json()};};
 return {entry,url,cookie,headers,calls,call};
}
test('status requires the current setup identity and returns no credential values or outbound side effects',async t=>{
 const f=await fixture(t,{prepareOnly:true,plannedEmail:'owner@example.invalid'});
 for(const patch of [{cookie:''},{'x-setup-token':'wrong'},{origin:'https://evil.invalid'},{'sec-fetch-site':'cross-site'}])assert.equal((await f.call('/status','GET',undefined,patch)).status,403);
 assert.equal((await f.call('/status')).body.state,'EMPTY');assert.equal(f.calls.length,0);
 const values=input(),saved=await f.call('/save','POST',values);assert.equal(saved.status,200);
 const ready=await f.call('/status');assert.equal(ready.body.state,'PREPARED');assert.equal(ready.body.mode,'PREPARE_ONLY');
 for(const value of Object.values(values))assert.equal(JSON.stringify(ready.body).includes(value),false);
 assert.equal(JSON.stringify(ready.body).includes('owner@example.invalid'),false);assert.equal(f.entry.consumePrepared().modelKey,values.modelKey);
 assert.equal((await f.call('/status')).body.state,'CONSUMED');assert.throws(()=>f.entry.consumePrepared(),/没有可领取/);assert.equal(f.calls.length,0);
});
test('unknown secret writes remain blocked and status cannot repeat or expose them',async t=>{
 let writes=0;const f=await fixture(t,{ghRunner:async()=>{writes++;throw Error('SYNTHETIC_PRIVATE_SECRET_MUST_NOT_LEAK');}});
 assert.equal((await f.call('/save','POST',standard())).status,400);const state=(await f.call('/status')).body;
 assert.equal(state.state,'UNKNOWN');assert.equal(state.attemptedSecrets,1);assert.equal(state.confirmedSecrets,0);assert.equal(JSON.stringify(state).includes('PRIVATE_SECRET'),false);
 assert.equal((await f.call('/save','POST',standard())).status,409);await f.call('/status');assert.equal(writes,1);
});
test('confirmed full setup values stay saved when workflow dispatch is unconfirmed',async t=>{
 let writes=0,dispatches=0;const f=await fixture(t,{ghRunner:async args=>{if(args[0]==='secret')writes++;else{dispatches++;throw Error('private dispatch details');}}});
 const saved=await f.call('/save','POST',standard());assert.equal(saved.status,200);assert.deepEqual(saved.body,{ok:true,workflowStarted:false});
 const state=(await f.call('/status')).body;assert.equal(state.state,'COMPLETED');assert.equal(state.confirmedSecrets,3);assert.equal(state.workflowStarted,false);
 assert.equal((await f.call('/save','POST',standard())).status,409);assert.equal(writes,3);assert.equal(dispatches,1);
});
test('read-only status respects the original preparation expiry and does not extend or consume it',async t=>{
 let now=Date.now();const f=await fixture(t,{prepareOnly:true,plannedEmail:'owner@example.invalid',now:()=>now,preparedTtlMs:1000});
 const saved=(await f.call('/save','POST',input())).body;assert.equal((await f.call('/status')).body.expiresAt,saved.expiresAt);
 now+=1000;const expired=(await f.call('/status')).body;assert.equal(expired.state,'EXPIRED');assert.equal(expired.expiresAt,saved.expiresAt);
 assert.equal((await f.call('/save','POST',input())).status,410);assert.throws(()=>f.entry.consumePrepared(),/没有可领取/);assert.equal(f.calls.length,0);
});
test('independent entries keep separate cookie names and reject another entry identity',async t=>{
 const a=await fixture(t),b=await fixture(t,{random:n=>Buffer.alloc(n,8)});assert.notEqual(a.cookie.split('=')[0],b.cookie.split('=')[0]);
 assert.equal((await a.call('/status','GET',undefined,{cookie:b.cookie})).status,403);assert.equal((await a.call('/status','GET',undefined,{cookie:a.cookie+'; '+b.cookie})).status,200);
 assert.equal(a.calls.length+b.calls.length,0);
});

function client(fetchImpl,{mode='PREPARE_ONLY',storage=new Map(),values=input(),timeoutMs=15000}={}){
 const form={hidden:false,listeners:{},addEventListener(k,fn){this.listeners[k]=fn;}},save={disabled:false,textContent:'保存合成配置'},recover={hidden:true,disabled:false,addEventListener(){}},result={textContent:''};
 const fields=Object.fromEntries(Object.entries(values).map(([k,value])=>[k,{value,readOnly:false}]));
 const store={getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)};
 const control=mountSecureConfigForm({form,save,recover,result,fields,token:'synthetic-token',entryId:'synthetic-entry',mode,storage:store,fetchImpl,timeoutMs,
  messages:{prepared:'本机准备已确认',consumed:'已交给驱动，执行结果以回执为准',saved:'已加密保存并启动校验',savedUnconfirmed:'已加密保存，启动尚未确认'}});
 return {form,save,recover,result,fields,storage,control,submit:()=>form.listeners.submit({preventDefault(){}})};
}
const state=(value,mode='PREPARE_ONLY')=>({protocol:'shuduo-local-setup-status/v1',entryId:'synthetic-entry',mode,state:value,workflowStarted:false,
 ...(['PREPARED','CONSUMED'].includes(value)?{expiresAt:new Date(Date.now()+60000).toISOString()}: {})});
const reply=(value,ok=true)=>({ok,json:async()=>value});
test('a lost POST reply recovers the original consumed preparation without another submit or retained credential values',async()=>{
 let posts=0,submitted=false;const c=client(async(path)=>{if(path==='/save'){posts++;submitted=true;throw TypeError('Failed to fetch');}return reply(state(submitted?'CONSUMED':'EMPTY'));});
 await c.control.ready;assert.equal(c.save.disabled,false);await c.submit();assert.equal(posts,1);assert.equal(c.form.hidden,true);assert.ok(Object.values(c.fields).every(f=>f.value===''));
 assert.match(c.result.textContent,/执行结果以回执为准/);assert.equal(c.storage.size,0);
});
test('network loss keeps values and blocks repeat writes; later read-only reconciliation clears them only after proof',async()=>{
 let posts=0,connected=true,submitted=false;const c=client(async(path)=>{if(path==='/save'){posts++;submitted=true;connected=false;throw TypeError('Failed to fetch');}if(!connected)throw TypeError('Failed to fetch');return reply(state(submitted?'PREPARED':'EMPTY'));});
 await c.control.ready;await c.submit();assert.equal(c.save.disabled,true);assert.equal(c.recover.hidden,false);assert.deepEqual(Object.fromEntries(Object.entries(c.fields).map(([k,f])=>[k,f.value])),input());
 assert.doesNotMatch(c.result.textContent,/Failed to fetch/);assert.deepEqual([...c.storage.values()],['synthetic-entry']);await c.submit();assert.equal(posts,1);
 connected=true;await c.control.reconcile();assert.equal(posts,1);assert.equal(c.form.hidden,true);assert.ok(Object.values(c.fields).every(f=>f.value===''));
});
test('unparsed and mismatched status replies never clear values or show raw response errors',async()=>{
 let posted=false;const c=client(async path=>{if(path==='/save'){posted=true;return {ok:true,json:async()=>{throw SyntaxError('SYNTHETIC_PRIVATE_BODY');}};}return reply(posted?{...state('PREPARED'),entryId:'another-entry'}:state('EMPTY'));});
 await c.control.ready;await c.submit();assert.equal(c.save.disabled,true);assert.equal(c.form.hidden,false);assert.equal(c.fields.modelKey.value,input().modelKey);assert.doesNotMatch(c.result.textContent,/PRIVATE_BODY|SyntaxError/);
});
test('an explicit original retry uses the frozen payload, while reload never reconstructs a lost credential body',async()=>{
 let posts=0;const bodies=[],storage=new Map();const c=client(async(path,options)=>{if(path==='/save'){bodies.push(options.body);posts++;if(posts===1)throw TypeError('offline');return reply({ok:true,workflowStarted:true});}return reply(state('EMPTY','MYSQL_ONLY'));},{mode:'MYSQL_ONLY',storage,values:{mysql:'SyntheticMysql!42'}});
 await c.control.ready;await c.submit();assert.equal(c.save.disabled,false);assert.equal(c.save.textContent,'明确重试原保存');c.fields.mysql.value='DifferentSynthetic!42';await c.submit();assert.equal(bodies[1],bodies[0]);
 const reloadedStorage=new Map([['shuduo-setup-pending','synthetic-entry']]);let writes=0;
 const reloaded=client(async(path)=>{if(path==='/save')writes++;return reply(state('EMPTY'));},{storage:reloadedStorage,values:{...input(),mysql:''}});
 await reloaded.control.ready;assert.equal(reloaded.save.disabled,true);await reloaded.submit();assert.equal(writes,0);assert.equal(reloaded.storage.size,1);
});

test('only a confirmed validation rejection unlocks correction; a timed-out in-flight save remains blocked',async()=>{
 let rejected=false;const c=client(async path=>{if(path==='/save'){rejected=true;return reply({error:'ignored raw error'},false);}return reply(rejected?{...state('REJECTED'),validationError:'两次登录密码不一致'}:state('EMPTY'));});
 await c.control.ready;await c.submit();assert.equal(c.save.disabled,false);assert.ok(Object.values(c.fields).every(f=>f.readOnly===false));assert.match(c.result.textContent,/两次登录密码/);assert.equal(c.storage.size,0);
 let posts=0,aborted=false;const slow=client(async(path,options)=>{
  if(path==='/save'){posts++;return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>{aborted=true;reject(Error('private timeout details'));},{once:true}));}
  return reply(state(posts?'SAVING':'EMPTY'));
 },{timeoutMs:20});
 await slow.control.ready;await slow.submit();assert.equal(aborted,true);assert.equal(posts,1);assert.equal(slow.save.disabled,true);assert.match(slow.result.textContent,/仍在处理/);assert.doesNotMatch(slow.result.textContent,/private timeout/);
});
