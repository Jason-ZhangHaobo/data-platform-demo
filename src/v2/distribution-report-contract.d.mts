export type DistributionReportWidget={id:string;type:'PIE'|'BAR';title:string;aggregation:'VALUE';field:string;dimension:string;partitionBy:string[]};
export const distributionReportMetricIds:readonly string[];
export function distributionReportTemplate(contractId:string|undefined):{widgets:DistributionReportWidget[];notes:string[]}|undefined;
export function distributionReportTemplateForContext(contextId:string):{widgets:DistributionReportWidget[];notes:string[]}|undefined;
export const fundReportContractId:string;
export function distributionReportMetadata(id:string|undefined):{id:string;contextIds:string[];dimension:string;fields:{name:string;type:string;scale?:number}[]}|undefined;
