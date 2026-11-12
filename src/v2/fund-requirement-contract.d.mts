export const fundConstraintLabels: Readonly<Record<string, string>>;
export const fundRequirementContractId: string;
export function fundRequirementScope(id: string | undefined): {
  id: string; definition: string; definitionVersion: number; grain: string; constraints: string[];
  metrics: { field: string; label: string; sourceFields: string[] }[];
  tables: { name: string; columns: [string, string][] }[];
} | undefined;
