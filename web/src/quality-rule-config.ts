export type QualityConfigDraft={type:string;min:string;max:string;valuesText:string;allowEmpty:boolean;maxAgeSeconds:string;valuesJson?:string};
export type QualityVersionDraft=QualityConfigDraft&{baseVersionId:string;field:string;description:string};
export type QualityEditableVersion={id:string;field:string;type:string;config:Record<string,unknown>;description:string};
export const qualityTypes=['VALUE_RANGE','NOT_NULL','UNIQUE','ALLOWED_VALUES','FRESHNESS_SECONDS'] as const;
export function qualityConfigDraft(type='VALUE_RANGE',config:Record<string,unknown>={}):QualityConfigDraft {
 const values=Array.isArray(config.values)?config.values.filter((value):value is string=>typeof value==='string'):['股票','债券','基金'];
 return {type,min:String(config.min??'0.00'),max:String(config.max??'5000.00'),valuesText:values.filter(value=>value!=='').join('\n'),allowEmpty:values.includes(''),maxAgeSeconds:String(config.maxAgeSeconds??300),...(values.some(value=>/[\r\n]/.test(value))?{valuesJson:JSON.stringify(values,null,2)}:{})};
}
export function qualityVersionDraft(version:QualityEditableVersion):QualityVersionDraft{return {...qualityConfigDraft(version.type,version.config),baseVersionId:version.id,field:version.field,description:version.description};}
function cents(value:string){if(value.length>80||! /^-?\d+(?:\.\d{1,2})?$/.test(value))throw Error('范围须为不超过两位小数的数值');const negative=value.startsWith('-'),[whole,fraction='']=value.replace(/^-/,'').split('.');const amount=BigInt(whole)*100n+BigInt(fraction.padEnd(2,'0'));return negative?-amount:amount;}
export function qualityConfig(draft:QualityConfigDraft):Record<string,unknown>{
 if(draft.type==='VALUE_RANGE'){const min=draft.min.trim(),max=draft.max.trim();if(cents(min)>cents(max))throw Error('最小值不能大于最大值');return {min,max};}
 if(draft.type==='ALLOWED_VALUES'){let input:unknown;if(draft.valuesJson!==undefined){try{input=JSON.parse(draft.valuesJson);}catch{throw Error('允许值JSON须为文本数组');}}else input=[...draft.valuesText.split(/\r?\n/).filter(value=>value!==''),...(draft.allowEmpty?['']:[])];if(!Array.isArray(input)||input.some(value=>typeof value!=='string'))throw Error('允许值须为文本数组');const values=[...new Set(input as string[])];if(values.length<1||values.length>30||values.some(value=>value.length>80))throw Error('允许值须为1—30项，每项最多80字符');return {values};}
 if(draft.type==='FRESHNESS_SECONDS'){const value=draft.maxAgeSeconds.trim();if(!/^\d+$/.test(value)||!Number.isSafeInteger(Number(value))||Number(value)<1||Number(value)>2678400)throw Error('时效阈值须为1—2678400的整数秒');return {maxAgeSeconds:Number(value)};}
 if(['NOT_NULL','UNIQUE'].includes(draft.type))return {};
 throw Error('请选择已支持的规则类型');
}
export function qualityConfigProblem(draft:QualityConfigDraft){try{qualityConfig(draft);return '';}catch(error){return error instanceof Error?error.message:'规则配置未通过校验';}}
export function qualityVersionBody(draft:QualityVersionDraft){if(!draft.field)throw Error('请选择检测字段');if(draft.description.trim().length<4||draft.description.length>500)throw Error('版本说明须为4—500字符');return {expectedVersionId:draft.baseVersionId,field:draft.field,type:draft.type,config:qualityConfig(draft),description:draft.description.trim()};}
