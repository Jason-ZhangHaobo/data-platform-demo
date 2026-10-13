import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,chmodSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {loginSession,readSessionCredential,saveSessionCredential} from '../../src/v2/session-credential.mjs';
import {V2Client} from '../../src/v2/client.mjs';
import {createV2Server,PROJECT} from '../../src/v2/server.mjs';
const fixture=(base='https://example.invalid/api/v2')=>({protocol:'shuduo-invite-session/v1',apiBaseUrl:base,projectId:PROJECT,cookie:'shuduo_session='+'a'.repeat(43),csrfToken:'b'.repeat(43),expiresAt:new Date(Date.now()+60000).toISOString()});
test('credential files require owner-only regular storage and exact endpoint/project/expiry',()=>{
  const dir=mkdtempSync(join(tmpdir(),'shuduo-session-')),path=join(dir,'session.json'),value=fixture();saveSessionCredential(path,value);
  assert.equal(readSessionCredential(path,value.apiBaseUrl,PROJECT).cookie,value.cookie);
  assert.throws(()=>saveSessionCredential(path,value));
  for(const[base,project,now]of[['https://foreign.invalid/api/v2',PROJECT,Date.now()],[value.apiBaseUrl,'other-project',Date.now()],[value.apiBaseUrl,PROJECT,Date.now()+120000]])assert.throws(()=>readSessionCredential(path,base,project,now));
  chmodSync(path,0o644);assert.throws(()=>readSessionCredential(path,value.apiBaseUrl,PROJECT),/PERMISSIONS/);chmodSync(path,0o600);
  const link=join(dir,'link.json');symlinkSync(path,link);assert.throws(()=>readSessionCredential(link,value.apiBaseUrl,PROJECT));
  writeFileSync(path,'{secret-do-not-echo');assert.throws(()=>readSessionCredential(path,value.apiBaseUrl,PROJECT),e=>e.message==='SESSION_FILE_INVALID');
});
test('invitation transport adds cookie/CSRF, forbids actor override and never mixes application identity',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'shuduo-transport-')),path=join(dir,'session.json'),value=fixture();saveSessionCredential(path,value);
  const seen=[],client=new V2Client({baseUrl:value.apiBaseUrl,sessionFile:path,fetchImpl:async(url,opts)=>{seen.push({url,opts});return Response.json({ok:true});}});
  await client.request('/data-services/applications');await client.request('/auth/logout',{method:'POST',body:{}});
  assert.equal(seen[0].opts.headers.Cookie,value.cookie);assert.equal(seen[0].opts.headers['X-CSRF-Token'],undefined);assert.equal(seen[1].opts.headers['X-CSRF-Token'],value.csrfToken);
  await assert.rejects(client.request('/status',{actorId:'fake-admin'}),/OVERRIDE/);await assert.rejects(client.request('/../../outside'),/REQUEST_SCOPE/);assert.equal(seen.length,2);
  chmodSync(path,0o644);await client.request('/open/xapis/demo',{authorization:'Bearer synthetic-app'});assert.equal(seen[2].opts.headers.Cookie,undefined);assert.equal(seen[2].opts.headers.Authorization,'Bearer synthetic-app');
});
test('real invited local API authenticates the CLI and MCP without argv secrets or fake actor headers',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'shuduo-login-')),path=join(dir,'session.json');
  const app=createV2Server({root:dir,env:{V2_LOCAL_DEVELOPMENT:'false',V2_ALLOW_INSECURE_PUBLIC_COOKIES:'true',V2_PROVISIONING_ONLY:'true',V2_PRIVATE_SMOKE_ENABLED:'true',V2_PRIVATE_DATA_SERVICES_ENABLED:'true'}});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(async()=>{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));app.store.close();});
  const email='synthetic-cli@example.invalid',password='SyntheticPassword!2026',base=`http://127.0.0.1:${app.server.address().port}/api/v2`;
  app.auth.bootstrapAdmin({email,password,displayName:'合成CLI工程师'});
  const cli=spawn(process.execPath,['bin/shuduo-session.mjs','login','--base-url',base,'--email',email,'--file',path],{stdio:['pipe','pipe','pipe']});
  let out='',err='';cli.stdout.on('data',c=>out+=c);cli.stderr.on('data',c=>err+=c);cli.stdin.end(password+'\n');
  const exit=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{cli.kill();reject(Error('LOGIN_TEST_DEADLINE'));},5000);cli.once('close',n=>{clearTimeout(timer);resolve(n);});cli.once('error',reject);});
  assert.equal(exit,0,err);assert.equal(JSON.parse(out).authenticated,true);const saved=JSON.parse(readFileSync(path));for(const secret of [password,saved.cookie,saved.csrfToken])assert.ok(!out.includes(secret)&&!err.includes(secret));
  const client=new V2Client({baseUrl:base,sessionFile:path});assert.equal((await client.request('/auth/session')).authenticated,true);
  const mcp=spawn(process.execPath,['bin/shuduo-mcp.mjs'],{env:{...process.env,SHUDUO_V2_API_BASE_URL:base,SHUDUO_V2_SESSION_FILE:path},stdio:['pipe','pipe','pipe']});
  let stdout='',stderr='';mcp.stdout.on('data',c=>stdout+=c);mcp.stderr.on('data',c=>stderr+=c);mcp.stdin.end(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'service_application_list',arguments:{}}})+'\n');
  const mcpExit=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{mcp.kill();reject(Error('MCP_TEST_DEADLINE'));},5000);mcp.once('close',n=>{clearTimeout(timer);resolve(n);});mcp.once('error',reject);});
  assert.equal(mcpExit,0,stderr);const reply=JSON.parse(stdout);assert.equal(reply.error,undefined,stdout);assert.deepEqual(reply.result.structuredContent,[]);assert.ok(!stdout.includes(saved.cookie));
  await client.request('/auth/logout',{method:'POST',body:{}});assert.equal((await client.request('/auth/session')).authenticated,false,'server revocation overrides still-valid local scope');
});
test('login refuses unsafe transport and an existing file before sending credentials',async()=>{
  let calls=0;const dir=mkdtempSync(join(tmpdir(),'shuduo-login-scope-')),path=join(dir,'existing.json');writeFileSync(path,'unrelated file');
  const input={baseUrl:'https://example.invalid/api/v2',projectId:PROJECT,email:'synthetic@example.invalid',password:'SyntheticPassword!2026',path,fetchImpl:async()=>{calls++;return Response.json({});}};
  await assert.rejects(loginSession(input));await assert.rejects(loginSession({...input,path:join(dir,'new.json'),baseUrl:'http://foreign.invalid/api/v2'}),/UNSAFE/);assert.equal(calls,0);
});
test('a concurrent file creation is preserved and the unused new session is logged out',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'shuduo-session-race-')),path=join(dir,'session.json'),record=fixture(),seen=[];
  const fetchImpl=async(url,options)=>{seen.push({url,options});if(url.endsWith('/auth/login')){writeFileSync(path,'preserve unrelated file');const headers=new Headers({'set-cookie':record.cookie+'; HttpOnly; Path=/api/v2'});return Response.json({user:{projectId:PROJECT},role:'ENGINEER',csrfToken:record.csrfToken,expiresAt:record.expiresAt},{headers});}return Response.json({authenticated:false});};
  await assert.rejects(loginSession({baseUrl:record.apiBaseUrl,projectId:PROJECT,email:'synthetic@example.invalid',password:'SyntheticPassword!2026',path,fetchImpl}));
  assert.equal(readFileSync(path,'utf8'),'preserve unrelated file');assert.equal(seen.length,2);assert.ok(seen[1].url.endsWith('/auth/logout'));assert.equal(seen[1].options.headers.Cookie,record.cookie);
});
