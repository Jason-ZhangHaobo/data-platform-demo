export const fundContractId = "securities-fund-lookthrough-v1";

type ComposableService = {
  id: string; serviceType: string; status: string;
  publishedVersion?: { id: string; fields?: string[]; sourceReleaseRunId?: string; outputContractId?:string; snapshotHash?:string };
};

export function compositionChoices<T extends ComposableService>(services: T[], options: {
  privateCloud: boolean; sourceRunId: string; holdingsVersionId: string; cashVersionId: string; outputContractId?:string;
}) {
  const fund = options.outputContractId === fundContractId;
  const scoped=services.filter(s=>s.serviceType==="DAPI"&&s.status==="PUBLISHED"&&s.publishedVersion&&
    (!options.privateCloud && !fund || Boolean(options.sourceRunId)&&s.publishedVersion.sourceReleaseRunId===options.sourceRunId));
  const typed=scoped.filter(s=>s.publishedVersion!.outputContractId===options.outputContractId);
  const holdingsOptions = typed.filter(service => {
    const fields = service.publishedVersion!.fields;
    return fund ? fields?.includes("exposure_amount") && !fields.includes("exposure_ratio") : fields?.includes("holding_market_value");
  });
  const holdings=options.holdingsVersionId ? holdingsOptions.find(s=>s.publishedVersion!.id===options.holdingsVersionId) : holdingsOptions[0];
  const cashOptions = typed.filter(service => {
    const version = service.publishedVersion!, amount = holdings?.publishedVersion;
    const metric = fund ? version.fields?.includes("exposure_ratio") && !version.fields.includes("exposure_amount") :
      version.fields?.includes(options.outputContractId ? "market_value_ratio" : "available_cash");
    return service.id !== holdings?.id && metric && (!options.outputContractId ||
      version.sourceReleaseRunId === amount?.sourceReleaseRunId && version.snapshotHash === amount?.snapshotHash);
  });
  const cash=options.cashVersionId ? cashOptions.find(s=>s.publishedVersion!.id===options.cashVersionId) : cashOptions[0];
  return {holdingsOptions,cashOptions,holdings,cash};
}
