type ComposableService = {
  id: string; serviceType: string; status: string;
  publishedVersion?: { id: string; fields?: string[]; sourceReleaseRunId?: string; outputContractId?:string; snapshotHash?:string };
};

export function compositionChoices<T extends ComposableService>(services: T[], options: {
  privateCloud: boolean; sourceRunId: string; holdingsVersionId: string; cashVersionId: string; outputContractId?:string;
}) {
  const scoped=services.filter(s=>s.serviceType==="DAPI"&&s.status==="PUBLISHED"&&s.publishedVersion&&
    (!options.privateCloud || Boolean(options.sourceRunId)&&s.publishedVersion.sourceReleaseRunId===options.sourceRunId));
  const typed=scoped.filter(s=>s.publishedVersion!.outputContractId===options.outputContractId);
  const holdingsOptions=typed.filter(s=>s.publishedVersion!.fields?.includes("holding_market_value"));
  const holdings=options.holdingsVersionId ? holdingsOptions.find(s=>s.publishedVersion!.id===options.holdingsVersionId) : holdingsOptions[0];
  const cashOptions=typed.filter(s=>s.id!==holdings?.id&&s.publishedVersion!.fields?.includes(options.outputContractId?"market_value_ratio":"available_cash")&&(!options.outputContractId||s.publishedVersion!.sourceReleaseRunId===holdings?.publishedVersion?.sourceReleaseRunId&&s.publishedVersion!.snapshotHash===holdings?.publishedVersion?.snapshotHash));
  const cash=options.cashVersionId ? cashOptions.find(s=>s.publishedVersion!.id===options.cashVersionId) : cashOptions[0];
  return {holdingsOptions,cashOptions,holdings,cash};
}
