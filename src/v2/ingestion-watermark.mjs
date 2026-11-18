const decimal=value=>{
  const text=String(value).trim();
  if(text.length>1024)return;
  const match=text.match(/^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d{1,3}))?$/);
  if(!match)return;
  return {coefficient:BigInt((match[1]==='-'?'-':'')+match[2]+(match[3]??'')),scale:(match[3]?.length??0)-Number(match[4]??0)};
};
const compare=(a,b)=>{
  const scale=Math.max(a.scale,b.scale),left=a.coefficient*10n**BigInt(scale-a.scale),right=b.coefficient*10n**BigInt(scale-b.scale);
  return left===right?0:left>right?1:-1;
};
export function ingestionWatermark(rows,sourceField,columns){
  if(!sourceField)return;
  const numeric=/^(?:TINYINT|SMALLINT|MEDIUMINT|BIGINT|INT|INTEGER|DECIMAL|NUMERIC|FLOAT|DOUBLE|REAL)\b/i.test(columns.find(c=>c.name===sourceField)?.type??'');
  let maximum,parsedMaximum;
  for(const row of rows){
    const value=row[sourceField];if(value===null||value===undefined)continue;
    const parsed=numeric?decimal(value):String(value);
    if(parsed===undefined)throw Object.assign(Error('水位字段包含不符合数值类型的值，未写入落地数据'),{status:422,code:'INVALID_WATERMARK_VALUE'});
    if(maximum===undefined||(numeric?compare(parsed,parsedMaximum)>0:parsed>parsedMaximum)){maximum=String(value);parsedMaximum=parsed;}
  }
  return maximum;
}
