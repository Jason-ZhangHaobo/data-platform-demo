import {createAgentSubmission} from './agent-submission.ts';
import {checkedAnnotationResult,readAssetAnnotationRequest,submitAssetAnnotation} from '../../src/v2/asset-annotation-client.mjs';
import type {AnnotationResult} from '../../src/v2/asset-annotation-client.mjs';
import {assetResourcePath} from '../../src/v2/asset-resource-path.mjs';
type Api=<T>(path:string,body?:unknown,options?:{idempotencyKey?:string})=>Promise<T>;
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
export function annotationRecoveryMarker(href:string){
 const query=new URL(href).searchParams,assetId=query.get('annotation_asset')??undefined,requestId=query.get('annotation_request')??undefined;
 if(!assetId&&!requestId)return{state:'ABSENT' as const};
 try{if(!assetId||!uuid(requestId)||query.getAll('annotation_asset').length!==1||query.getAll('annotation_request').length!==1)throw Error();assetResourcePath(assetId);return{state:'VALID' as const,assetId,requestId:requestId.toLowerCase()};}catch{return{state:'INVALID' as const};}
}
export function assetLocationTarget(href:string){const query=new URL(href).searchParams;if(query.getAll('asset').length>1)return'invalid asset link';return query.get('asset')??undefined;}
export function annotationRecoveryLocation(href:string,assetId:string,requestId?:string){
 assetResourcePath(assetId);if(requestId!==undefined&&!uuid(requestId))throw Error('标注恢复编号不合法');
 const url=new URL(href);url.username='';url.password='';url.hash='';url.search='';url.searchParams.set('module','assets');url.searchParams.set('asset',assetId);
 if(requestId){url.searchParams.set('annotation_asset',assetId);url.searchParams.set('annotation_request',requestId);}
 return url;
}
export function createAnnotationSubmission({api,assetId,initialKey,onPending,makeKey}:{api:Api;assetId:string;initialKey?:string;onPending:(key:string|undefined)=>void;makeKey?:()=>string}){
 assetResourcePath(assetId);
 let original:object|undefined;
 const client={request:<T,>(path:string,options?:{method?:string;body?:unknown;idempotencyKey?:string})=>api<T>(path,options?.body,{idempotencyKey:options?.idempotencyKey})};
 return createAgentSubmission<AnnotationResult>({initialKey,onPending,makeKey,api:async<T,>(path:string,body?:unknown,options?:{idempotencyKey?:string})=>{
  if(path==='/agent/tasks'&&options?.idempotencyKey&&body&&typeof body==='object'){original=JSON.parse(JSON.stringify(body));return await submitAssetAnnotation(client,assetId,{...original,protocol:'shuduo-asset-annotation-write/v2',requestId:options.idempotencyKey} as never) as T;}
  const match=path.match(/^\/agent\/requests\/([a-f0-9-]+)$/i);if(match){const result=await readAssetAnnotationRequest(client,assetId,match[1]);return await checkedAnnotationResult(result,assetId,match[1],original?{...original,protocol:'shuduo-asset-annotation-write/v2',requestId:match[1]} as never:undefined) as T;}
  throw Error('标注恢复接口不匹配，未发送请求');
 }});
}
