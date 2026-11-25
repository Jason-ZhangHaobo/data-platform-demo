import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {readSessionPassword} from '../../bin/session-password-input.mjs';

function terminal(initialRaw=false) {
  const input=new PassThrough(), messages=[];
  input.isTTY=true;
  input.isRaw=initialRaw;
  input.setRawMode=enabled=>{input.isRaw=enabled;return input;};
  const result=readSessionPassword(input,text=>messages.push(text));
  return {input,result,messages};
}

test('piped UTF-8 works across byte boundaries and preserves spaces and all but the final newline', async()=>{
  const value='  测试🔐文字  ',raw=Buffer.from(value+'\r\n');
  const noPrompt=()=>assert.fail('piped input must not prompt');
  assert.ok(await readSessionPassword([...raw].map(byte=>Buffer.from([byte])),noPrompt)===value);
  assert.equal(await readSessionPassword(['a\n\n'],noPrompt),'a\n');
  assert.equal(await readSessionPassword(['z'.repeat(1024)],noPrompt),'z'.repeat(1024));
  await assert.rejects(readSessionPassword(['z'.repeat(1024),'x'],noPrompt),{code:'LOGIN_INPUT_TOO_LARGE'});
});

test('an interactive line is edited with echo suppressed and initial terminal mode restored',async()=>{
  for(const initiallyRaw of [false,true]){
    const {input,result,messages}=terminal(initiallyRaw);
    assert.equal(input.isRaw,true);
    input.write('示例X');
    input.write('\x7f');
    input.write('🔐  ');
    input.write('\r');
    assert.ok(await result==='示例🔐  ');
    assert.equal(input.isRaw,initiallyRaw);
    assert.deepEqual(messages,['数舵登录密码（输入时隐藏，按回车提交）：','\n']);
    input.destroy();
  }
});

test('cancellation, disconnected terminal, and oversized input discard the line and restore mode',async()=>{
  for(const [act,code] of [
    [s=>s.write('虚构输入\x03'),'LOGIN_INPUT_CANCELLED'],
    [s=>s.write('\x04'),'LOGIN_INPUT_CANCELLED'],
    [s=>s.end('虚构输入'),'LOGIN_INPUT_CANCELLED'],
    [s=>s.write('字'.repeat(342)),'LOGIN_INPUT_TOO_LARGE'],
    [s=>s.destroy(new Error('synthetic-private-stream-error')),'LOGIN_INPUT_UNAVAILABLE'],
  ]){
    const {input,result,messages}=terminal();
    act(input);
    await assert.rejects(result,e=>e.code===code&&e.message===code);
    assert.equal(input.isRaw,false);
    assert.equal(messages.length,2);
    assert.ok(!messages.join('').includes('虚构输入'));
    input.destroy();
  }
});

test('unexpected input and output errors return a fixed diagnostic',async()=>{
  const bad=(async function*(){throw Object.assign(new Error('synthetic-private-detail'),{code:'SYNTHETIC_PRIVATE_CODE'});})();
  await assert.rejects(readSessionPassword(bad),e=>e.message==='LOGIN_INPUT_UNAVAILABLE');
  const input=new PassThrough();
  input.isTTY=true;
  await assert.rejects(readSessionPassword(input,()=>assert.fail('unsafe terminal must not prompt')),{code:'LOGIN_INPUT_UNAVAILABLE'});
});
