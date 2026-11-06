export type ReportTemplateWidget={id:string;type:'KPI'|'BAR'|'PIE';title:string;aggregation:'SUM'|'COUNT_DISTINCT';field:string;dimension?:string};
export function securitiesReportTemplate(fields?:readonly string[]):{widgets:ReportTemplateWidget[];notes:string[]};
