type ComposableService = {
  id: string; serviceType: string; status: string;
  publishedVersion?: { id: string; fields?: string[]; sourceReleaseRunId?: string };
};

export function compositionChoices<T extends ComposableService>(services: T[], options: {
  privateCloud: boolean; sourceRunId: string; holdingsVersionId: string; cashVersionId: string;
}) {
  const scoped=services.filter(s=>s.serviceType==="DAPI"&&s.status==="PUBLISHED"&&s.publishedVersion&&
    (!options.privateCloud || Boolean(options.sourceRunId)&&s.publishedVersion.sourceReleaseRunId===options.sourceRunId));
  const holdingsOptions=scoped.filter(s=>s.publishedVersion!.fields?.includes("holding_market_value"));
  const holdings=options.holdingsVersionId ? holdingsOptions.find(s=>s.publishedVersion!.id===options.holdingsVersionId) : holdingsOptions[0];
  const cashOptions=scoped.filter(s=>s.id!==holdings?.id&&s.publishedVersion!.fields?.includes("available_cash"));
  const cash=options.cashVersionId ? cashOptions.find(s=>s.publishedVersion!.id===options.cashVersionId) : cashOptions[0];
  return {holdingsOptions,cashOptions,holdings,cash};
}
