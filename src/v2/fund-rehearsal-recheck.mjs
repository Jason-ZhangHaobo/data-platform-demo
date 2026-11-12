const uuid = value => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const protocol = "shuduo-fund-rehearsal-recheck/v1";
const invalid = () => Object.assign(new Error("须指定原交付编号与当前版本"), { status: 422 });

export function readFundRehearsalRecheck(body) {
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).length !== 1 || !Object.hasOwn(body, "expectedVersion") ||
      !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1) throw invalid();
  return body.expectedVersion;
}

export function fundRehearsalRecheckResult(task, status) {
  return { protocol, status, deliveryTaskId: task.id, packageDigest: task.packageDigest,
    verificationId: task.verificationId, version: task.version };
}

export async function recheckFundRehearsal(client, input) {
  if (!input || Object.keys(input).length !== 2 || !uuid(input.deliveryTaskId)) throw invalid();
  const { deliveryTaskId, expectedVersion } = input;
  readFundRehearsalRecheck({ expectedVersion });
  const result = await client.request(`/agent/deliveries/${deliveryTaskId}/recheck-receipt`, {
    method: "POST", body: { expectedVersion },
  });
  if (result?.protocol !== protocol || result.deliveryTaskId !== deliveryTaskId || !uuid(result.verificationId) ||
      typeof result.packageDigest !== "string" || !/^[a-f0-9]{64}$/.test(result.packageDigest) ||
      !["RECOVERED", "UNCONFIRMED"].includes(result.status) ||
      result.version !== expectedVersion + (result.status === "RECOVERED" ? 1 : 0) ||
      Object.keys(result).length !== 6) throw new Error("原演练回执核对响应与所选交付不符");
  return result;
}
