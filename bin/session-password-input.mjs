import {emitKeypressEvents} from 'node:readline';

const byteLimit=1024;
const fail=code=>Object.assign(new Error(code),{code});

async function readPipe(input) {
  const buffer=Buffer.alloc(byteLimit);
  let length=0;
  try {
    for await (const chunk of input) {
      if(typeof chunk!=='string'&&!(chunk instanceof Uint8Array))throw fail('LOGIN_INPUT_UNAVAILABLE');
      const size=Buffer.byteLength(chunk);
      if(length+size>byteLimit)throw fail('LOGIN_INPUT_TOO_LARGE');
      if(typeof chunk==='string')buffer.write(chunk,length,size,'utf8');
      else buffer.set(chunk,length);
      length+=size;
    }
    return buffer.toString('utf8',0,length).replace(/\r?\n$/,'');
  } finally { buffer.fill(0); }
}

async function readTerminal(input,prompt) {
  if(typeof input.setRawMode!=='function')throw fail('LOGIN_INPUT_UNAVAILABLE');
  const wasRaw=Boolean(input.isRaw), wasFlowing=input.readableFlowing===true;
  const line=[];
  let bytes=0, cleanup=()=>{};
  try {
    input.setRawMode(true);
    if(input.isRaw!==true)throw fail('LOGIN_INPUT_UNAVAILABLE');
    emitKeypressEvents(input);
    return await new Promise((resolve,reject)=>{
      const cancel=()=>reject(fail('LOGIN_INPUT_CANCELLED'));
      const unavailable=()=>reject(fail('LOGIN_INPUT_UNAVAILABLE'));
      const keypress=(text,key)=>{
        if(key.ctrl&&['c','d','z'].includes(key.name))return cancel();
        if(key.name==='return'||key.name==='enter')return resolve(line.join(''));
        if(key.name==='backspace'){
          bytes-=Buffer.byteLength(line.pop()??'');
          return;
        }
        if(key.ctrl&&key.name==='u'){line.length=0;bytes=0;return;}
        if(!text||key.ctrl||key.meta||/[\u0000-\u001f\u007f]/u.test(text))return;
        bytes+=Buffer.byteLength(text);
        if(bytes>byteLimit)return reject(fail('LOGIN_INPUT_TOO_LARGE'));
        line.push(text);
      };
      cleanup=()=>{
        input.off('keypress',keypress);
        input.off('end',cancel);
        input.off('close',cancel);
        input.off('error',unavailable);
      };
      input.on('keypress',keypress);
      input.once('end',cancel);
      input.once('close',cancel);
      input.once('error',unavailable);
      input.resume();
      prompt('数舵登录密码（输入时隐藏，按回车提交）：');
    });
  } finally {
    cleanup();
    line.length=0;
    if(!wasFlowing)input.pause();
    if(Boolean(input.isRaw)!==wasRaw)input.setRawMode(wasRaw);
    prompt('\n');
  }
}

export async function readSessionPassword(input=process.stdin,prompt=text=>process.stderr.write(text)) {
  try {
    return input.isTTY ? await readTerminal(input,prompt) : await readPipe(input);
  } catch (error) {
    if(error?.code==='LOGIN_INPUT_CANCELLED'||error?.code==='LOGIN_INPUT_TOO_LARGE')throw fail(error.code);
    throw fail('LOGIN_INPUT_UNAVAILABLE');
  }
}
