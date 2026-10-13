#!/usr/bin/env node
import {fileURLToPath} from 'node:url';
import {loginSession,readSessionCredential} from '../src/v2/session-credential.mjs';
export async function runSessionCli(argv,env=process.env,{input=process.stdin,out=console.log,error=console.error}={}){
  try{
    const [action,...rest]=argv,args={};
    for(let n=0;n<rest.length;n+=2){if(!['--base-url','--project','--email','--file'].includes(rest[n])||!rest[n+1])throw Error('SESSION_ARGUMENTS_INVALID');args[rest[n].slice(2)]=rest[n+1];}
    if(!['login','status'].includes(action)||!args.file)throw Error('用法：node bin/shuduo-session.mjs login --email 邮箱 --file 会话路径；密码只从标准输入读取，不放参数或聊天。');
    const baseUrl=args['base-url']??env.SHUDUO_V2_API_BASE_URL??'http://127.0.0.1:3100/api/v2',projectId=args.project??'project-securities-lab';
    if(action==='status'){const s=readSessionCredential(args.file,baseUrl,projectId);out(JSON.stringify({validLocalScope:true,expiresAt:s.expiresAt,serverAuthenticationVerified:false}));return 0;}
    if(!args.email)throw Error('LOGIN_EMAIL_REQUIRED');let raw='';for await(const chunk of input){raw+=chunk.toString();if(Buffer.byteLength(raw)>1024)throw Error('LOGIN_INPUT_TOO_LARGE');}
    const result=await loginSession({baseUrl,projectId,email:args.email,password:raw.replace(/\r?\n$/,''),path:args.file});raw='';out(JSON.stringify(result));return 0;
  }catch(e){error(e.code??(/^[-_A-Z]+$/.test(e.message)?e.message:'会话操作未确认；没有回显密码或Cookie。'));return 1;}
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1])process.exitCode=await runSessionCli(process.argv.slice(2));
