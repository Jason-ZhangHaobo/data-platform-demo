import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { syncLandingEvidenceMessage, unconfirmedSyncLandingEvidence } from "../../web/src/sync-landing-evidence.ts";

test("only recognized diagnostics on unconfirmed current sync sources disable row actions", () => {
  for (const [evidenceCode, message] of [
    ["SYNC_LANDING_RECEIPT_MISSING", /缺少落地回执/],
    ["SYNC_LANDING_RECEIPT_MISMATCH", /回执与原任务或落地结果不一致/],
    ["SYNC_LANDING_RESULT_UNCONFIRMED", /当前同步批次尚未确认/],
  ]) {
    assert.match(syncLandingEvidenceMessage(evidenceCode), message);
    assert.match(unconfirmedSyncLandingEvidence({ status: "UNCONFIRMED", evidenceCode }), message);
    assert.equal(unconfirmedSyncLandingEvidence({ status: "VERIFIED", evidenceCode }), undefined);
  }
  assert.equal(unconfirmedSyncLandingEvidence({ status: "UNCONFIRMED" }), undefined);
  assert.equal(unconfirmedSyncLandingEvidence(undefined), undefined);
  assert.equal(syncLandingEvidenceMessage("SYNC_SQL_INPUT_UNAVAILABLE"), undefined);
});

test("current-row actions are guarded independently from frozen evidence", async () => {
  const read = name => readFile(new URL("../../web/src/" + name, import.meta.url), "utf8");
  const [assets, quality, reports, agent] = await Promise.all([
    read("AssetWorkbench.tsx"), read("QualityWorkbench.tsx"), read("ReportsWorkbench.tsx"), read("AgentDevelopmentWorkbench.tsx"),
  ]);
  assert.match(assets, /const canRunAssetRows = canWrite && !landingEvidenceProblem/);
  assert.match(assets, /runMetric\(metric\.id\)\} disabled=\{!canRunAssetRows/);
  assert.match(assets, /checkStandard\(standard\.id\)\} disabled=\{!canRunAssetRows/);
  assert.match(assets, /metric\.runs\[0\]/);
  assert.match(quality, /selectedRule && !ruleLandingEvidence &&\s*action/);
  assert.match(quality, /selectedRule\.runs\.map\(/);
  assert.match(reports, /selectedAsset\?\.reportable && !newDatasetLandingEvidence/);
  assert.match(reports, /selectedDataset\?\.publishedSource \? undefined :/);
  assert.match(reports, /selectedDataset && !currentDatasetLandingEvidence &&\s*action/);
  assert.match(reports, /selectedReport &&\s*action\(\s*"run"/);
  assert.match(agent, /const syncSelectionPending = maySelectSync && syncRequested && !selectedSync/);
  assert.match(agent, /syncSelectionPending \? "核对通过后才可使用该批次提交。"/);
  assert.match(agent, /if\(selectedSync && \(landingEvidenceMessage \|\|/);
});
