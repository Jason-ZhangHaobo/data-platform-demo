// Separate human grants; never rewrite the history or limits of an old scope.
export const READONLY_ENTRY_SCOPE='INVITED_READ_ONLY_OPENING_V2';
export const READONLY_FILING_SCOPE='INVITED_READ_ONLY_FILING_REPAIR';
export const READONLY_RUNTIME_SCOPE='INVITED_READ_ONLY_RUNTIME_DIAGNOSTIC';
export const INVITED_READONLY_CODE_SCOPE='INVITED_READ_ONLY_CODE_REFRESH';
export const INVITED_READONLY_FILING_CODE_SCOPE='INVITED_READ_ONLY_FILING_CODE_REFRESH';
export const INVITED_READONLY_RUNTIME_CODE_SCOPE='INVITED_READ_ONLY_RUNTIME_CODE_REFRESH';
export function openingScope(value){
 if(value===READONLY_ENTRY_SCOPE)return{authorization:value,codeAuthorization:INVITED_READONLY_CODE_SCOPE,historicalRequests:55,historicalConfigurationReads:0,filingRepair:false,runtimeVerification:false,requestLimit:60,reservedCny:12};
 if(value===READONLY_FILING_SCOPE)return{authorization:value,codeAuthorization:INVITED_READONLY_FILING_CODE_SCOPE,historicalRequests:61,historicalConfigurationReads:58,filingRepair:true,runtimeVerification:false,requestLimit:60,reservedCny:14};
 if(value===READONLY_RUNTIME_SCOPE)return{authorization:value,codeAuthorization:INVITED_READONLY_RUNTIME_CODE_SCOPE,historicalRequests:69,historicalConfigurationReads:131,filingRepair:true,runtimeVerification:true,requestLimit:20,reservedCny:16};
 throw Object.assign(new Error('OPENING_NEW_GRANT_REQUIRED'),{safeCode:'OPENING_NEW_GRANT_REQUIRED'});
}
export function publicSitePatch(site){
 if(!site||Object.keys(site).sort().join()!=='icpNumber,registeredName'||Object.values(site).some(v=>typeof v!=='string'||!v.trim()||v!==v.trim()||v.length>80||/[\r\n\x00]/.test(v)))throw Object.assign(new Error('OPENING_PUBLIC_SITE_INVALID'),{safeCode:'OPENING_PUBLIC_SITE_INVALID'});
 return{V2_SITE_ICP_NUMBER:site.icpNumber,V2_SITE_REGISTERED_NAME:site.registeredName};
}
