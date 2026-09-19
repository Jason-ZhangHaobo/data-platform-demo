#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
output_path="${1:-$repo_root/v2-spark-worker.zip}"
python_binary="${V2_WORKER_BUILD_PYTHON:-$(command -v python3)}"
stage_root="$(mktemp -d)"
stage="$stage_root/function"

cleanup() {
  rm -rf "$stage_root"
}
trap cleanup EXIT

if [[ "$(uname -s)" != "Linux" || "$(uname -m)" != "x86_64" ]]; then
  echo "Spark Worker package must be built on Linux x86_64" >&2
  exit 1
fi
if [[ "$output_path" != "$repo_root/"*.zip && "$output_path" != /tmp/*.zip ]]; then
  echo "Output must be a ZIP under the repository root or /tmp" >&2
  exit 1
fi
if [[ -e "$output_path" ]]; then
  echo "Refusing to overwrite existing package: $output_path" >&2
  exit 1
fi
if [[ "$($python_binary -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')" != "3.10" ]]; then
  echo "Spark Worker package requires Python 3.10 to match FC custom.debian10" >&2
  exit 1
fi

mkdir -p "$stage/src/v2" "$stage/python"
cp "$repo_root/deploy/spark-worker/package.json" "$stage/package.json"
cp \
  "$repo_root/src/v2/remote-spark-worker.mjs" \
  "$repo_root/src/v2/remote-spark.mjs" \
  "$repo_root/src/v2/spark.mjs" \
  "$repo_root/src/v2/worker.py" \
  "$stage/src/v2/"

"$python_binary" -m pip install \
  --requirement "$repo_root/deploy/spark-worker/requirements.txt" \
  --target "$stage/python" \
  --no-compile \
  --require-hashes \
  --disable-pip-version-check

find "$stage/python" -type d \( -name '__pycache__' -o -name 'tests' \) -prune -exec rm -rf {} +
if find "$stage" -type f \( -name '.env' -o -name '.env.local' -o -name '*.pem' -o -name '*.key' \) | grep -q .; then
  echo "Refusing to package credential-like files" >&2
  exit 1
fi
test -f "$stage/python/pyspark/jars/spark-sql_2.12-3.5.9.jar"
test -f "$stage/python/py4j-0.10.9.9.dist-info/METADATA"
test -f "$stage/python/sqlglot-27.14.0.dist-info/METADATA"

# A versioned deployment package must be reproducible: pip and checkout times
# are irrelevant to its identity. Normalize timestamps, drop ZIP extra fields,
# and feed files in a stable byte-order so two clean Linux builds hash equally.
find "$stage" -exec touch -h -t 198001010000 {} +
(
  cd "$stage"
  LC_ALL=C find . -type f -print | LC_ALL=C sort | zip -X -q "$output_path" -@
)
archive_bytes="$(wc -c < "$output_path" | tr -d ' ')"
if [[ "$archive_bytes" -gt 503316480 ]]; then
  echo "Spark Worker package exceeds the 480 MiB safety cap" >&2
  exit 1
fi
unzip -tq "$output_path" >/dev/null
echo "Created $output_path ($archive_bytes bytes); deploy through OSS, not base64 API upload"
