export type FundPreparationInput = { contextId: string; businessDate: string; message: string; metrics: string[] };
type Client = { request: (path: string, options?: { method?: string; body?: unknown; idempotencyKey?: string }) => Promise<unknown> };
export type FundPreparationReceipt = {
  requestId: string; input: FundPreparationInput;
  basis: { contextId: string; contextName: string; definition: string; digest: string;
    parameters: { manager_id: string; trade_date: string }; grain: string; constraints: string[];
    metrics: { field: string; label: string; sourceFields: string[] }[];
    tables: { name: string; columns: [string, string][] }[] };
  execution: { state: "AWAITING_EXECUTION_AUTHORIZATION"; engine: string; dialect: string; rehearsalAt: string;
    inputDigest: string; schemaDigest: string; assertionDigest: string };
  modelCalls: 0; sparkRuns: 0;
};
export function submitFundPreparation(client: Client, input: FundPreparationInput, requestId: string): Promise<FundPreparationReceipt>;
export function readFundPreparation(client: Client, requestId: string): Promise<FundPreparationReceipt>;
