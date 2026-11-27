export type ConsumptionPlan = {
  taskId?: string; manualDeliveryTaskId?:string; packageDigest: string; sourceReleaseRunId: string; outputContractId?:string;
  agentConsumptionAvailable?:true;
  dapis: { name: string; slug: string; fields: string[]; timeoutMs: number; rateLimitPerMinute: number }[];
  xapi: { name: string; slug: string; timeoutMs: number; rateLimitPerMinute: number; steps: { alias: string; dapiSlug: string }[] };
  applicationName: string;
};
export type ConsumptionScope = { pilotId?: string; taskId?: string; manualDeliveryTaskId?:string; plan?: ConsumptionPlan; startsAt?: string; expiresAt?: string };
export function consumptionPlanAvailable(scope?: ConsumptionScope): scope is ConsumptionScope & {plan: ConsumptionPlan; pilotId: string} {
  const p=scope?.plan;
  return Boolean(scope?.pilotId && p && (p.manualDeliveryTaskId?scope.manualDeliveryTaskId===p.manualDeliveryTaskId&&scope.taskId===undefined&&p.taskId===undefined:typeof p.taskId==='string'&&scope.taskId===p.taskId&&!scope.manualDeliveryTaskId)&&p.packageDigest && p.sourceReleaseRunId &&
    Array.isArray(p.dapis)&&p.dapis.length===2&&p.dapis.every(d=>d.name&&d.slug&&Array.isArray(d.fields)&&d.fields.length)&&
    new Set(p.dapis.map(d=>d.slug)).size===2&&p.xapi?.name&&p.xapi.slug&&!p.dapis.some(d=>d.slug===p.xapi.slug)&&
    Array.isArray(p.xapi.steps)&&p.xapi.steps.length===2&&p.xapi.steps.every(s=>s.alias&&p.dapis.some(d=>d.slug===s.dapiSlug))&&
    new Set(p.xapi.steps.map(s=>s.dapiSlug)).size===2&&p.applicationName);
}
export function consumptionWindowOpen(scope?: ConsumptionScope, now=Date.now()) {
  return consumptionPlanAvailable(scope)&&Number.isFinite(now)&&now>=Date.parse(scope.startsAt??'')&&now<Date.parse(scope.expiresAt??'');
}
