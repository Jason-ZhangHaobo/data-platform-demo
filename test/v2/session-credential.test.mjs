import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,mkdtempSync,readFileSync,writeFileSync,chmodSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {loginSession,readSessionCredential,saveSessionCredential} from '../../src/v2/session-credential.mjs';
import {V2Client} from '../../src/v2/client.mjs';
import {createV2Server,PROJECT} from '../../src/v2/server.mjs';
import {runSessionCli} from '../../bin/shuduo-session.mjs';

test('login failures preserve caller codes and display only the matched status and known reason', async () => {
  const path=join(mkdtempSync(join(tmpdir(),'shuduo-login-reason-')),'session.json');
  const baseUrl='https://example.invalid/api/v2',email='fictional@example.invalid',password='SyntheticSecret!2026';
  const cases=[
    [401,'INVALID_LOGIN','账号邮箱或密码未通过验证'],
    [400,'INVALID_EMAIL','邮箱格式无效'],
    [429,'AUTH_RATE_LIMITED','15 分钟'],
    [503,'CLOUD_STARTUP_PENDING','服务正在启动'],
    [503,'REQUEST_LANE_BUSY','其他请求'],
    [503,'AUTH_ATTEMPT_STATE_INVALID','暂时无法校验登录状态'],
    [503,'REQUEST_OUTCOME_UNCONFIRMED','尚未确认这次登录的结果'],
    [503,'INVALID_LOGIN','原因未知'],
    [401,'SECRET_SERVER_ERROR','原因未知'],
    [502,null,'响应无法解析'],
  ];
  for (const [status,code,expectedMessage] of cases) {
    let calls=0, reads=0;
    const fetchImpl=async (url,options)=>{
      if(options.method==='GET'){
        assert.equal(url,baseUrl+'/auth/session');reads++;
        return Response.json({authenticated:false,mode:'INVITATION_SESSION'});
      }
      calls++;
      assert.equal(options.method,'POST');
      assert.equal(url,baseUrl+'/auth/login');
      return code ? Response.json({code,message:password,privateDetail:email},{status})
        : new Response('<html>'+password+'</html>',{status});
    };
    await assert.rejects(loginSession({baseUrl,email,projectId:PROJECT,password,path,fetchImpl}), e=>{
      assert.equal(e.code,code?'LOGIN_REJECTED':'LOGIN_RESPONSE_INVALID');
      assert.equal(e.httpStatus,status);
      assert.equal(e.reason,code&&expectedMessage!=='原因未知'?code:undefined);
      return true;
    });
    assert.equal(calls,1);
    let diagnostic='';
    assert.equal(await runSessionCli(['login','--base-url',baseUrl,'--email',email,'--file',path],{},{
      input:[password],out:()=>assert.fail('unexpected success'),error:text=>{diagnostic=text;},fetchImpl,
    }),1);
    assert.equal(calls,2,'one login request per explicit submission');
    assert.equal(reads,1,'only the remote CLI checks anonymous readiness');
    assert.ok(diagnostic.includes(expectedMessage)&&diagnostic.includes('HTTP '+status));
    assert.ok(![email,password,'SECRET_SERVER_ERROR','<html>'].some(s=>diagnostic.includes(s)));
    assert.equal(existsSync(path),false);
  }
});

test('the remote CLI waits for anonymous readiness and submits a password only once',async()=>{
  const path=join(mkdtempSync(join(tmpdir(),'shuduo-login-ready-')),'session.json');
  const methods=[],waits=[];let saved,diagnostic;
  const baseUrl='https://example.invalid/api/v2',record=fixture(baseUrl);
  const code=await runSessionCli(['login','--email','engineer@example.invalid','--base-url',baseUrl,'--file',path],{},{
    input:['SyntheticOnly!2026\n'],out:s=>saved=JSON.parse(s),error:s=>diagnostic=s,wait:async ms=>waits.push(ms),
    fetchImpl:async(url,options)=>{
      methods.push(options.method);
      if(methods.length===1)return Response.json({code:'CLOUD_STARTUP_PENDING'},{status:503});
      if(options.method==='GET')return Response.json({mode:'INVITATION_SESSION',authenticated:false});
      assert.equal(url,baseUrl+'/auth/login');
      return Response.json({user:{projectId:PROJECT},role:'ENGINEER',csrfToken:record.csrfToken,expiresAt:record.expiresAt},
        {headers:{'set-cookie':record.cookie+'; HttpOnly; Path=/api/v2'}});
    },
  });
  assert.equal(code,0);
  assert.equal(diagnostic,undefined);
  assert.deepEqual(methods,['GET','GET','POST']);assert.equal(waits.length,1);
  assert.equal(saved.sessionSaved,true);assert.equal(saved.role,'ENGINEER');
  assert.equal(Boolean(readSessionCredential(path,baseUrl,PROJECT)),true);
});

test('failed anonymous readiness never submits a password or saves a session',async()=>{
  const path=join(mkdtempSync(join(tmpdir(),'shuduo-login-limited-')),'session.json');
  const methods=[];let diagnostic='';
  const code=await runSessionCli(['login','--email','pm@example.invalid','--base-url','https://example.invalid/api/v2','--file',path],{},{
    input:['SyntheticOnly!2026'],out:()=>assert.fail('unexpected success'),error:s=>{diagnostic=s;},
    fetchImpl:async(_url,options)=>{methods.push(options.method);return Response.json({message:'synthetic private response'},{status:429});},
  });
  assert.equal(code,1);assert.deepEqual(methods,['GET']);assert.equal(existsSync(path),false);
  assert.match(diagnostic,/限流.*尚未提交密码/);assert.doesNotMatch(diagnostic,/synthetic private response/i);
});

test('invalid success metadata never reaches CLI output, and unused sessions can be closed',async()=>{
  const path=join(mkdtempSync(join(tmpdir(),'shuduo-login-payload-')),'session.json');
  const baseUrl='http://127.0.0.1:3100/api/v2',record=fixture(baseUrl),requests=[];
  let diagnostic='';
  const cli=await runSessionCli(['login','--email','engineer@example.invalid','--file',path],{},{
    input:['SyntheticOnly!2026'],out:()=>assert.fail('unexpected success'),error:s=>{diagnostic=s;},
    fetchImpl:async(url)=>{requests.push(url);return url.endsWith('/auth/logout')?Response.json({loggedOut:true}):
      Response.json({user:{projectId:PROJECT},role:'SYNTHETIC_PRIVATE_RESPONSE',csrfToken:record.csrfToken,expiresAt:record.expiresAt},
        {headers:{'set-cookie':record.cookie+'; HttpOnly; Path=/api/v2'}});},
  });
  assert.equal(cli,1);assert.equal(existsSync(path),false);
  assert.deepEqual(requests,[baseUrl+'/auth/login',baseUrl+'/auth/logout']);
  assert.match(diagnostic,/结果尚未确认/);
  assert.ok(![record.cookie,record.csrfToken,'SYNTHETIC_PRIVATE_RESPONSE'].some(s=>diagnostic.includes(s)));
});

test('an unknown transport result does not re-submit credentials or display the raw exception',async()=>{
  const path=join(mkdtempSync(join(tmpdir(),'shuduo-login-network-')),'session.json');
  let calls=0,diagnostic='';
  const result=await runSessionCli(['login','--email','fictional@example.invalid','--file',path],{},{
    input:['SyntheticSecret!2026'],out:()=>assert.fail('unexpected success'),error:text=>{diagnostic=text;},
    fetchImpl:async()=>{calls++;throw new Error('SyntheticSecret!2026');}
  });
  assert.equal(result,1);
  assert.equal(calls,1);
  assert.match(diagnostic,/未收到登录响应/);
  assert.doesNotMatch(diagnostic,/SyntheticSecret/);
  assert.equal(existsSync(path),false);
});

test('help, bad arguments and existing output paths do not prompt or contact a service',async()=>{
  const path=join(mkdtempSync(join(tmpdir(),'shuduo-login-existing-')),'existing.json');
  writeFileSync(path,'original file',{mode:0o600});
  for(const [args,expectedCode,pattern] of [
    [['--help'],0,/status --base-url/],
    [['login','--unknown','SYNTHETIC_PRIVATE_ARGUMENT'],1,/SESSION_ARGUMENTS_INVALID/],
    [['login','--file',path,'--base-url','https://example.invalid/api/v2','--email','engineer@example.invalid'],1,/SESSION_FILE_ALREADY_EXISTS/],
    [['login','--file',join(path,'nested','s.json'),'--email','engineer@example.invalid'],1,/ENOTDIR|ENOENT/],
  ]){
    let message='',reads=0,calls=0;
    const input={async *[Symbol.asyncIterator](){reads++;yield 'unused';}};
    const rc=await runSessionCli(args,{},{
      input,out:s=>message=s,error:s=>message=s,fetchImpl:async()=>{calls++;throw Error('unexpected request');},
    });
    assert.equal(rc,expectedCode);assert.match(message,pattern);assert.doesNotMatch(message,/SYNTHETIC_PRIVATE_ARGUMENT/);
    assert.equal(reads,0);assert.equal(calls,0);assert.equal(readFileSync(path,'utf8'),'original file');
  }
});

test('errors from a broken input stream never echo unrecognized codes or messages',async()=>{
  const path=join(mkdtempSync(join(tmpdir(),'shuduo-login-input-')),'session.json');
  const source={async *[Symbol.asyncIterator](){throw Object.assign(Error('SYNTHETIC_INPUT_MESSAGE'),{code:'SYNTHETIC_INPUT_CODE'});}};
  let diagnostic='',posts=0;
  const rc=await runSessionCli(['login','--file',path,'--email','engineer@example.invalid'],{},{
    input:source,error:s=>diagnostic=s,fetchImpl:async()=>{posts++;},
  });
  assert.equal(rc,1);assert.equal(posts,0);assert.ok(diagnostic.length>0);assert.doesNotMatch(diagnostic,/SYNTHETIC_INPUT/);
});
const fixture=(base='https://example.invalid/api/v2')=>({protocol:'shuduo-invite-session/v1',apiBaseUrl:base,projectId:PROJECT,cookie:'shuduo_session='+'a'.repeat(43),csrfToken:'b'.repeat(43),expiresAt:new Date(Date.now()+60000).toISOString()});
test('only the session file protocol fields survive persistence',()=>{
  const path=join(mkdtempSync(join(tmpdir(),'shuduo-login-fields-')),'session.json');
  const value=fixture();
  saveSessionCredential(path,{...value,debug:'synthetic-private-field',unused:true});
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(path,'utf8'))).sort(),Object.keys(value).sort());
});

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
