import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { sqlRequirementProtocol } from "./sql-requirement-contract.mjs";
import { sqlRequirementBinding } from "./sql-requirements.mjs";

const uuid = value => typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const record = value => value && typeof value === "object" && !Array.isArray(value);
const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const invalid = () => Object.assign(new Error("交付准备须绑定原代码版本、SQL 摘要和 Spark 批次"), {status:422});

export function readDeliveryPreparationSource(body, taskId) {
  if (!record(body) || Object.keys(body).some(key => key !== "expectedSource")) throw invalid();
  if (!Object.hasOwn(body, "expectedSource")) return;
  const source = body.expectedSource, binding = source?.requirementBinding;
  if (!record(source) || Object.keys(source).some(key => !["revisionId","revisionHash","runId","requirementBinding"].includes(key)) ||
      !uuid(source.revisionId) || !digest(source.revisionHash) || !uuid(source.runId)) throw invalid();
  if (Object.hasOwn(source,"requirementBinding") &&
      (!record(binding) || Object.keys(binding).length !== 4 || binding.protocol !== sqlRequirementProtocol ||
        binding.taskId !== taskId || !uuid(binding.taskId) || !digest(binding.basisDigest) || !digest(binding.reportDigest)))
    throw invalid();
  return {revisionId:source.revisionId, revisionHash:source.revisionHash, runId:source.runId,
    ...(binding ? {requirementBinding:{protocol:binding.protocol, taskId:binding.taskId,
      basisDigest:binding.basisDigest, reportDigest:binding.reportDigest}} : {})};
}

export function deliveryPreparationRequirement(code) {
  const stored = code.requirementEvidence ? sqlRequirementBinding(code.requirementEvidence) : undefined;
  if (stored && code.requirementBinding && !isDeepStrictEqual(stored,code.requirementBinding)) throw invalid();
  return code.requirementBinding ?? stored;
}

export function deliveryPreparationBody(code) {
  const requirementBinding = deliveryPreparationRequirement(code);
  return {expectedSource:readDeliveryPreparationSource({expectedSource:{
    revisionId:code.revisionId, revisionHash:code.revisionHash, runId:code.runId,
    ...(requirementBinding ? {requirementBinding} : {}),
  }},code.taskId)};
}

export function deliveryPreparationHashMatches(bodyHash, code) {
  try { return bodyHash === hash({}) || bodyHash === hash(deliveryPreparationBody(code)); }
  catch { return false; }
}

export function readDeliveryAdvance(body) {
  const bad = () => Object.assign(new Error("须提供原交付版本、包与演练批次"), {status:422});
  if (!record(body) || Object.keys(body).some(key => !["expectedVersion","rehearsal"].includes(key)) ||
      !Number.isSafeInteger(body.expectedVersion) || body.expectedVersion < 1) throw bad();
  if (!Object.hasOwn(body,"rehearsal")) return {version:body.expectedVersion};
  const value = body.rehearsal;
  if (!record(value) || Object.keys(value).some(key => !["packageId","packageDigest","verificationId"].includes(key)) ||
      !uuid(value.packageId) || !digest(value.packageDigest) ||
      (Object.hasOwn(value,"verificationId") && !uuid(value.verificationId))) throw bad();
  return {version:body.expectedVersion, rehearsal:value};
}
