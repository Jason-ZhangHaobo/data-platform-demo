export type ReportTemplateWidget={id:string;type:'KPI'|'BAR'|'PIE';title:string;aggregation:'SUM'|'COUNT_DISTINCT'|'VALUE';field:string;dimension?:string;partitionBy?:string[]};
export function securitiesReportTemplate(fields?:readonly string[]):{widgets:ReportTemplateWidget[];notes:string[]};
export function publishedReportTemplate(fields:readonly string[],contextId:string):{widgets:ReportTemplateWidget[];notes:string[]};
