#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
stage="${1:?Usage: stage-v2-spark-worker-sources.sh STAGE_DIRECTORY}"
fund_dir="$repo_root/fixtures/fund-lookthrough"

mkdir -p "$stage/src/v2" "$stage/fixtures/fund-lookthrough"
cp "$repo_root/deploy/spark-worker/package.json" "$stage/package.json"
cp \
  "$repo_root/src/v2/remote-spark-worker.mjs" \
  "$repo_root/src/v2/remote-spark.mjs" \
  "$repo_root/src/v2/remote-spark-queue.mjs" \
  "$repo_root/src/v2/oss-client.mjs" \
  "$repo_root/src/v2/oss-request-retry.mjs" \
  "$repo_root/src/v2/spark-worker-private-smoke.mjs" \
  "$repo_root/src/v2/spark.mjs" \
  "$repo_root/src/v2/worker.py" \
  "$repo_root/src/v2/output_contracts.py" \
  "$repo_root/src/v2/output-contracts.json" \
  "$repo_root/src/v2/output-contract-metadata.json" \
  "$repo_root/src/v2/fund_lookthrough.py" \
  "$stage/src/v2/"
cp \
  "$fund_dir/contract.json" \
  "$fund_dir/cases.json" \
  "$fund_dir/case.json" \
  "$fund_dir/case-next-trading-day.json" \
  "$stage/fixtures/fund-lookthrough/"
