export type DistributionReportWidget={id:string;type:'PIE'|'BAR';title:string;aggregation:'VALUE';field:string;dimension:string;partitionBy:string[]};
export const distributionReportMetricIds:readonly string[];
export function distributionReportTemplate(contractId:string|undefined):{widgets:DistributionReportWidget[];notes:string[]}|undefined;
export function distributionReportTemplateForContext(contextId:string):{widgets:DistributionReportWidget[];notes:string[]}|undefined;
