#!/usr/bin/env node
import {fileURLToPath} from 'node:url';
import {assertNewSessionFile, loginSession, normalizeSessionBase, readSessionCredential} from '../src/v2/session-credential.mjs';
import {waitForInvitedLogin} from '../src/v2/invited-login-readiness.mjs';
import {readSessionPassword} from './session-password-input.mjs';

const usage = [
  '登录数舵：node bin/shuduo-session.mjs login --base-url API_BASE --email EMAIL --file NEW_SESSION_FILE',
  '检查本机会话：node bin/shuduo-session.mjs status --base-url API_BASE --file SESSION_FILE',
  '可用 --project 指定项目。登录密码从终端隐藏输入或标准输入读取。',
].join('\n');

const loginReasons = new Map([
  ['INVALID_LOGIN', '账号邮箱或密码未通过验证，请核对后重新输入。'],
  ['INVALID_EMAIL', '邮箱格式无效，请核对邮箱地址。'],
  ['AUTH_RATE_LIMITED', '登录尝试已限流，请在 15 分钟窗口结束后再试。'],
  ['CLOUD_STARTUP_PENDING', '服务正在启动，请稍后再登录。'],
  ['CLOUD_STARTUP_UNAVAILABLE', '服务暂时未就绪，请稍后再登录。'],
  ['REQUEST_LANE_BUSY', '服务正在处理其他请求，请稍后再登录。'],
  ['REQUEST_OUTCOME_UNCONFIRMED', '服务尚未确认这次登录的结果。请先核对会话状态。'],
  ['AUTH_ATTEMPT_STATE_INVALID', '服务暂时无法校验登录状态，请稍后再试。'],
]);
const diagnostics = new Map([
  ['SESSION_ARGUMENTS_INVALID', usage],
  ['LOGIN_EMAIL_REQUIRED', '请用 --email 指定受邀账号的邮箱。'],
  ['LOGIN_PREFLIGHT_PENDING', '服务仍在恢复或繁忙，本次尚未提交密码。请稍后再登录。'],
  ['LOGIN_PREFLIGHT_RATE_LIMITED', '登录服务已限流，本次尚未提交密码。请稍后再登录。'],
  ['LOGIN_PREFLIGHT_UNCONFIRMED', '无法确认受邀登录服务已就绪，本次尚未提交密码。请核对地址和网络。'],
  ['LOGIN_INPUT_INVALID', '密码输入无效，请输入单行数舵登录密码。'],
  ['LOGIN_INPUT_TOO_LARGE', '输入过长，请只输入本次登录密码。'],
  ['LOGIN_INPUT_CANCELLED', '输入已取消，本次尚未提交密码。'],
  ['LOGIN_INPUT_UNAVAILABLE', '无法安全读取密码，请从本机终端重新打开。'],
  ['LOGIN_TRANSPORT_UNCONFIRMED', '未收到登录响应，结果尚未确认。请检查网络连接。'],
  ['SESSION_FILE_ALREADY_EXISTS', '会话文件已存在。可先用 status 检查；再次登录请指定新的文件路径。'],
  ['SESSION_SCOPE_OR_EXPIRY_INVALID', '会话范围或有效期不符，请核对服务地址、项目和到期时间。'],
  ['SESSION_FILE_PERMISSIONS_INVALID', '请使用仅本人可读写的普通会话文件。'],
  ['SESSION_FILE_INVALID', '会话文件无法解析。'],
  ['SESSION_PROJECT_MISMATCH', '登录返回的用户不属于指定项目。'],
  ['SESSION_TRANSPORT_UNSAFE', '远端服务需使用 HTTPS，本机开发可使用回环地址。'],
  ['ERR_INVALID_URL', '服务地址格式无效，请核对 --base-url。'],
  ['EEXIST', '会话文件已存在，请核对原文件。'],
  ['EACCES', '当前用户无法访问指定会话文件或目录。'],
  ['EPERM', '当前操作未获得本机文件访问权限。'],
  ['ELOOP', '会话路径不能是符号链接。'],
  ['ENOENT', '请确认会话文件路径和上级目录是否存在。'],
  ['ENOTDIR', '会话文件的上级路径必须是目录。'],
]);

function sessionErrorMessage(e) {
  const status = Number.isInteger(e?.httpStatus) && e.httpStatus >= 100 && e.httpStatus <= 599 ? `（HTTP ${e.httpStatus}）` : '';
  if (e?.code === 'LOGIN_RESPONSE_INVALID') return `登录响应无法解析或格式异常${status}，结果尚未确认。`;
  if (e?.code === 'LOGIN_REJECTED') return `LOGIN_REJECTED${status} ${loginReasons.get(e.reason) ?? '服务未确认登录，具体原因未知。'}`;
  const message = diagnostics.get(e?.code);
  return message ? `${e.code} ${message}` : '会话操作未确认。';
}

export async function runSessionCli(argv, env=process.env, {
  input=process.stdin, out=console.log, error=console.error, prompt=text=>process.stderr.write(text), fetchImpl=fetch, wait,
}={}) {
  try {
    if (argv.length===1 && ['--help','-h'].includes(argv[0])) { out(usage); return 0; }
    const [action,...rest] = argv, args={};
    for(let n=0;n<rest.length;n+=2){
      const flag=rest[n],key=flag.slice(2);
      if(!['--base-url','--project','--email','--file'].includes(flag)||!rest[n+1]||Object.hasOwn(args,key))
        throw Object.assign(Error(),{code:'SESSION_ARGUMENTS_INVALID'});
      args[key]=rest[n+1];
    }
    if(!['login','status'].includes(action)||!args.file)throw Object.assign(Error(),{code:'SESSION_ARGUMENTS_INVALID'});
    const baseUrl=normalizeSessionBase(args['base-url']??env.SHUDUO_V2_API_BASE_URL??'http://127.0.0.1:3100/api/v2');
    const projectId=args.project??'project-securities-lab';
    if(action==='status'){
      const s=readSessionCredential(args.file,baseUrl,projectId);
      out(JSON.stringify({validLocalScope:true,expiresAt:s.expiresAt,serverAuthenticationVerified:false}));
      return 0;
    }
    if(!args.email)throw Object.assign(Error(),{code:'LOGIN_EMAIL_REQUIRED'});
    assertNewSessionFile(args.file);
    const password=await readSessionPassword(input,prompt);
    const url=new URL(baseUrl);
    if(url.protocol==='https:'&&!['127.0.0.1','localhost','[::1]'].includes(url.hostname))
      await waitForInvitedLogin({baseUrl,fetchImpl,wait});
    const result=await loginSession({baseUrl,projectId,email:args.email,password,path:args.file,fetchImpl});
    out(JSON.stringify(result));
    return 0;
  }catch(e){error(sessionErrorMessage(e));return 1;}
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1])process.exitCode=await runSessionCli(process.argv.slice(2));
