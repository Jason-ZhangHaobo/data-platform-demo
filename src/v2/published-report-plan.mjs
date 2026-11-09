import {publishedReportMetrics,publishedReportSource} from './published-report-request.mjs';
import {publishedReportHash} from './published-report-source.mjs';
import {publishedReportTemplate} from './report-template.mjs';
const invalid=message=>Object.assign(Error(message),{status:422,code:'INVALID_PUBLISHED_REPORT_PLAN'});
export function publishedReportPlanningContext(resolved){
 const template=publishedReportTemplate(resolved.asset.fields.map(f=>f.name),resolved.context.id);
 return {source:resolved.source,sourceEvidenceHash:resolved.asset.evidenceHash,context:resolved.context,fields:resolved.asset.fields.map(({name,type})=>({name,type})),rowCount:resolved.rows.length,availableWidgets:template.widgets,missingDimensions:template.notes};
}
export function validatePublishedReportPlan(value,context){
 if(!value||typeof value!=='object'||Array.isArray(value))throw invalid('模型未返回合法的同源报表方案');
 if(value.kind==='CLARIFICATION_REQUIRED'){
  if(Object.keys(value).some(k=>!['kind','question'].includes(k))||typeof value.question!=='string'||value.question.trim().length<4||value.question.length>300)throw invalid('缺失字段的方案须给出一个明确澄清问题');
  return {kind:value.kind,question:value.question.trim()};
 }
 if(value.kind!=='PUBLISHED_REPORT'||Object.keys(value).some(k=>!['kind','name','metricIds'].includes(k))||typeof value.name!=='string'||value.name.trim().length<2||value.name.length>80)throw invalid('同源报表方案只接受名称与已登记指标，不接受模型指定其他来源');
 let metricIds;try{metricIds=publishedReportMetrics(value.metricIds);}catch{throw invalid('方案包含未登记指标，需先澄清字段或口径，未执行');}
 const widgets=context.availableWidgets.filter(w=>metricIds.includes(w.id));
 if(widgets.length!==metricIds.length)throw invalid('方案包含此发布结果不支持的指标，未执行');
 return {kind:'PUBLISHED_REPORT',name:value.name.trim(),metricIds,widgets};
}
export const publishedReportPlanHash=(source,contextHash,proposal)=>publishedReportHash({source:publishedReportSource(source),contextHash,proposal});
export function samePublishedReportSource(a,b){return JSON.stringify(publishedReportSource(a))===JSON.stringify(publishedReportSource(b));}
