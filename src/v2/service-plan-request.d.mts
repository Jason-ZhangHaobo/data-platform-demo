export type ServicePlanSource=({taskId:string;manualDeliveryTaskId?:never}|{taskId?:never;manualDeliveryTaskId:string})&{packageDigest:string;releaseId:string;sourceReleaseRunId:string};
export function servicePlanSourceBinding(input:unknown):ServicePlanSource;
export function servicePlanSourceQuery(query:URLSearchParams):ServicePlanSource|undefined;
export function servicePlanSourcePath(binding:ServicePlanSource):string;
export function serviceAgentContextPath(binding:ServicePlanSource):string;
