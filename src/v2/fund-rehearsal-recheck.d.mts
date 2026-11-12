export type FundRehearsalRecheck = {
  protocol: "shuduo-fund-rehearsal-recheck/v1";
  status: "RECOVERED" | "UNCONFIRMED";
  deliveryTaskId: string;
  packageDigest: string;
  verificationId: string;
  version: number;
};

export function recheckFundRehearsal(
  client: { request(path: string, options: { method: "POST"; body: { expectedVersion: number } }): Promise<unknown> },
  input: { deliveryTaskId: string; expectedVersion: number },
): Promise<FundRehearsalRecheck>;
