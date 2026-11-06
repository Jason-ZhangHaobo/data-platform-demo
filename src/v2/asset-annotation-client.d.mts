export type AnnotationValues={businessName:string;description:string;domain:string;owner:string;classification:"PUBLIC_DEMO"|"INTERNAL_DEMO"|"RESTRICTED_DEMO";tags:string[]};
export type AnnotationWrite={protocol:"shuduo-asset-annotation-write/v2";requestId:string;expected:{revision:number;evidenceHash:string};annotation:AnnotationValues};
export type AnnotationSnapshot=AnnotationValues&{id:string;revision:number;evidenceHash:string;createdAt:string};
export type AnnotationResult={protocol:"shuduo-asset-annotation-result/v2";id:string;assetId:string;requestId:string;receiptHash:string;replayed:boolean;currentMatches:boolean;current:{state:"AVAILABLE";revision:number;evidenceHash:string}|{state:"UNAVAILABLE"};receipt:{protocol:"shuduo-asset-annotation-receipt/v2";assetId:string;requestId:string;request:{expected:AnnotationWrite["expected"];annotation:AnnotationValues};outcome:"APPLIED"|"REJECTED";annotation:AnnotationSnapshot|null;rejection:{code:"BASE_STALE";observed:AnnotationWrite["expected"]}|null}};
type Client={request(path:string,options?:{method?:string;body?:unknown;idempotencyKey?:string}):Promise<unknown>};
export function checkedAnnotationResult(value:unknown,assetId:string,requestId:string,expectedRequest?:AnnotationWrite):Promise<AnnotationResult>;
export function submitAssetAnnotation(client:Client,assetId:string,input:AnnotationWrite):Promise<AnnotationResult>;
export function readAssetAnnotationRequest(client:Client,assetId:string,requestId:string):Promise<AnnotationResult>;
export function normalizeAnnotationValues(value:unknown):AnnotationValues;
