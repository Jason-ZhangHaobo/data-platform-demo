export function isAgentSampleLanding(href: string) {
  const {searchParams, hash} = new URL(href);
  return !hash && (searchParams.size === 0 ||
    searchParams.size === 1 && searchParams.get("module") === "agent-center");
}

export function publicAgentSamples(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => item?.classification === "SYNTHETIC" &&
    item.capabilities?.agentDevelopment !== false && item.capabilities?.scope !== "LOCAL_ONLY" &&
    typeof item.id === "string" && /^[a-z0-9-]{1,100}$/.test(item.id) &&
    typeof item.name === "string" && typeof item.definition === "string" &&
    typeof item.businessDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(item.businessDate)
    ? [{id:item.id as string, name:item.name as string, definition:item.definition as string, businessDate:item.businessDate as string}] : []);
}
