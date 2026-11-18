export const csvChangeMode='INCREMENTAL_CHANGELOG';
export function csvChangeConfig(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==3||Object.keys(value).some(k=>!['epochId','operationField','sequenceField'].includes(k))||!(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i).test(value.epochId??'')||!['operationField','sequenceField'].every(k=>typeof value[k]==='string'&&/^[a-z][a-z0-9_]{0,62}$/.test(value[k]))||value.operationField===value.sequenceField)throw Error('请提供完整变更代号UUID、操作字段与不同的精确序号字段');
 return {epochId:value.epochId,operationField:value.operationField,sequenceField:value.sequenceField};
}
export function csvChangeRequestId(value){if(typeof value!=='string'||!(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i).test(value))throw Error('请使用原执行请求UUID');return value;}
