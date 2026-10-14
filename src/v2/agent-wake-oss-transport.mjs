import {createOssRequest} from "./oss-client.mjs";
import {requestOssWithRetry} from "./oss-request-retry.mjs";

const fail=code=>Object.assign(new Error(code),{status:503,code});
export function createAgentWakeOssTransport({bucket,endpoint,credentialsProvider,wakePrefix,resultPrefix,fetchImpl=fetch}) {
  const allowed=(key,write)=>typeof key==="string" && [wakePrefix,...(write?[]:[resultPrefix])].some(p=>new RegExp(`^${p}/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\\.json$`).test(key));
  const request=async(method,key,body)=>{
    if(!allowed(key,method==="PUT"))throw fail("AGENT_WAKE_OBJECT_DENIED");
    const credentials=await credentialsProvider();
    return requestOssWithRetry(()=>{
      const r=createOssRequest({method,bucket,endpoint,key,credentials,body,...(method==="PUT"?{ifNoneMatch:"*"}:{})});
      return{url:r.url,options:{...r.options,redirect:"error",signal:AbortSignal.timeout(10000)}};
    },fetchImpl,{attempts:2});
  };
  const read=async key=>{
    const r=await request("GET",key);if(r.status===404)return undefined;
    if(!r.ok)throw fail("AGENT_WAKE_READ_FAILED");
    const length=Number(r.headers.get("content-length"));if(length>2*1024*1024)throw fail("AGENT_WAKE_OBJECT_TOO_LARGE");
    const chunks=[];let bytes=0;
    for await(const chunk of r.body){bytes+=chunk.byteLength;if(bytes>2*1024*1024)throw fail("AGENT_WAKE_OBJECT_TOO_LARGE");chunks.push(Buffer.from(chunk));}
    return Buffer.concat(chunks).toString("utf8");
  };
  return {read,create:async(key,body)=>{
    if(typeof body!=="string"||Buffer.byteLength(body)>16384)throw fail("AGENT_WAKE_BODY_TOO_LARGE");
    const r=await request("PUT",key,body);
    if(r.ok)return;
    if([409,412].includes(r.status) && await read(key)===body)return;
    throw fail("AGENT_WAKE_PUT_UNCONFIRMED");
  }};
}
