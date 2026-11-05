// This self-contained function is embedded under the page's CSP nonce. Only a
// non-secret pending entry marker is stored; credential values stay in memory.
export function mountSecureConfigForm({form,save,recover,result,fields,token,entryId,mode,messages,fetchImpl=globalThis.fetch,storage,timeoutMs=15000}){
 const initialLabel=save.textContent,markerKey='shuduo-setup-pending';
 let frozenBody,busy=false,hadPending=false;
 try{hadPending=storage?.getItem(markerKey)===entryId;}catch{}
 const mark=()=>{hadPending=true;try{storage?.setItem(markerKey,entryId);}catch{}};
 const unmark=()=>{hadPending=false;try{if(storage?.getItem(markerKey)===entryId)storage.removeItem(markerKey);}catch{}};
 const lock=value=>{for(const field of Object.values(fields))field.readOnly=value;};
 const unknown=()=>{save.disabled=true;recover.hidden=false;lock(true);result.textContent='本机服务未能确认原保存结果，输入已保留。不会自动重新提交；请核对原保存状态，不要将密码或 Key 发到聊天。';};
 const saved=(state,receipt)=>{
  for(const field of Object.values(fields))field.value='';frozenBody=undefined;unmark();form.hidden=true;save.disabled=true;recover.hidden=true;
  result.textContent=mode==='PREPARE_ONLY'?(state==='CONSUMED'?messages.consumed:messages.prepared)+(receipt.expiresAt?' 暂存到期时间：'+new Date(receipt.expiresAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})+'（北京时间）':''):
   receipt.workflowStarted?messages.saved:messages.savedUnconfirmed;
 };
 const request=async(path,options)=>{
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeoutMs);
  try{const response=await fetchImpl(path,{credentials:'same-origin',...options,headers:{'X-Setup-Token':token,...options.headers},signal:controller.signal});
   let value;try{value=await response.json();}catch{throw Error('UNCONFIRMED_RESPONSE');}return {response,value};
  }finally{clearTimeout(timer);}
 };
 const validState=value=>value&&value.protocol==='shuduo-local-setup-status/v1'&&value.entryId===entryId&&value.mode===mode&&
  ['EMPTY','REJECTED','SAVING','UNKNOWN','COMPLETED','PREPARED','CONSUMED','EXPIRED'].includes(value.state)&&typeof value.workflowStarted==='boolean'&&
  !(mode==='PREPARE_ONLY'&&value.state==='COMPLETED')&&!(mode!=='PREPARE_ONLY'&&['PREPARED','CONSUMED','EXPIRED'].includes(value.state))&&
  (!['PREPARED','CONSUMED'].includes(value.state)||typeof value.expiresAt==='string'&&Number.isFinite(Date.parse(value.expiresAt)))&&
  !(value.state==='PREPARED'&&Date.parse(value.expiresAt)<=Date.now());
 async function reconcile(){
  recover.disabled=true;result.textContent='正在只读核对原保存状态…';
  try{
   const {response,value}=await request('/status',{method:'GET'});if(!response.ok||!validState(value))throw Error('UNCONFIRMED_STATUS');
   if(['COMPLETED','PREPARED','CONSUMED'].includes(value.state)){saved(value.state,value);return;}
   recover.hidden=false;lock(true);save.disabled=true;
   if(value.state==='SAVING')result.textContent='原保存仍在处理，输入已保留。请稍后核对，不要重复提交。';
   else if(value.state==='UNKNOWN')result.textContent='原保存已有步骤尚未确认，输入已保留。不会重复写入；请返回对话核对原执行回执。';
   else if(value.state==='EXPIRED')result.textContent='本机入口或暂存已过期，不能再次提交。输入仍保留在此页，请等待新的有效入口，不要发到聊天。';
   else if(value.state==='REJECTED'){
    frozenBody=undefined;unmark();lock(false);save.disabled=false;save.textContent=initialLabel;
    result.textContent=typeof value.validationError==='string'?value.validationError:'输入未通过校验，没有开始保存；请检查后重新提交。';
   }else if(frozenBody){save.disabled=false;save.textContent='明确重试原保存';result.textContent='原服务暂未记录本次保存。可明确重试相同内容，不会自动重发或替换输入。';}
   else if(hadPending)result.textContent='页面已恢复，原输入未写入浏览器存储；原结果仍需核对。不会换一份输入重复提交。';
   else{lock(false);save.disabled=false;recover.hidden=true;result.textContent='本机安全入口已就绪。';}
  }catch{unknown();}finally{recover.disabled=false;}
 }
 form.addEventListener('submit',async event=>{
  event.preventDefault();if(busy||save.disabled)return;
  if(!frozenBody){const input=Object.fromEntries(Object.entries(fields).map(([key,field])=>[key,field.value]));
   if(input.password!==undefined&&input.password!==input.confirm){result.textContent='两次登录密码不一致';return;}frozenBody=JSON.stringify(input);
  }
  busy=true;mark();lock(true);save.disabled=true;recover.hidden=true;result.textContent='正在提交原保存，请稍候…';
  try{
   const {response,value}=await request('/save',{method:'POST',headers:{'Content-Type':'application/json'},body:frozenBody});
   const prepared=mode==='PREPARE_ONLY'&&value?.ok===true&&value.mode==='PREPARE_ONLY'&&value.status==='PREPARED_IN_MEMORY'&&
    Number.isFinite(Date.parse(value.expiresAt))&&Date.parse(value.expiresAt)>Date.now()&&['databaseChanged','loginChanged','secretsChanged','cloudChanged','modelCalled','workerSecretGenerated'].every(key=>value[key]===false);
   const encrypted=mode!=='PREPARE_ONLY'&&value?.ok===true&&typeof value.workflowStarted==='boolean';
   if(response.ok&&(prepared||encrypted))saved(prepared?'PREPARED':'COMPLETED',value);else await reconcile();
  }catch{await reconcile();}finally{busy=false;}
 });
 recover.addEventListener('click',()=>{if(!busy)void reconcile();});save.disabled=true;lock(true);
 const ready=reconcile();return {ready,reconcile};
}
