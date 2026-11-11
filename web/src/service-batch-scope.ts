import type {ServiceSourceBinding} from "./service-source-binding.ts";

// An optional batch pin narrows an existing Agent publication binding.
export function serviceBatchFromLocation(href: string, binding?: ServiceSourceBinding): string | null | undefined {
  const query = new URL(href).searchParams;
  const values = query.getAll("release_batch");
  if (!values.length) return undefined;
  const [batch] = values;
  if (values.length !== 1 || query.get("module") !== "services" || binding?.sourceKind !== "AGENT" ||
      binding.scope !== "PRIVATE_CLOUD_TEST" || !binding.runId || !binding.revisionId ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(batch)) return null;
  return batch;
}
