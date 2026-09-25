#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
output_path="${1:-$repo_root/v2-function.zip}"
node_binary="${V2_NODE_BINARY:-$(command -v node)}"
stage_root="$(mktemp -d)"
stage="$stage_root/function"

cleanup() {
  rm -rf "$stage_root"
}
trap cleanup EXIT

if [[ "$(uname -s)" != "Linux" || "$(uname -m)" != "x86_64" ]]; then
  echo "V2 FC package must be built on Linux x86_64" >&2
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
if [[ "$($node_binary -p 'Number(process.versions.node.split(".")[0])')" -lt 24 ]]; then
  echo "V2 FC package requires Node.js 24 or newer for node:sqlite" >&2
  exit 1
fi

mkdir -p "$stage/runtime"
cp -R "$repo_root/src" "$stage/src"
cp -R "$repo_root/web-dist" "$stage/web-dist"
cp -R "$repo_root/fixtures" "$stage/fixtures"
cp "$repo_root/deploy/v2/package.json" "$repo_root/deploy/v2/package-lock.json" "$stage/"
cp -L "$node_binary" "$stage/runtime/node"
chmod 0755 "$stage/runtime/node"

npm ci \
  --prefix "$stage" \
  --omit=dev \
  --ignore-scripts \
  --no-audit \
  --no-fund

if find "$stage" -type f \( -name '.env' -o -name '.env.local' -o -name '*.pem' -o -name '*.key' \) | grep -q .; then
  echo "Refusing to package credential-like files" >&2
  exit 1
fi

# Checkout and install times must not change the identity of a versioned code
# object. Normalize the staged tree and use stable path order and ZIP headers.
find "$stage" -exec touch -h -t 198001010000 {} +
(
  cd "$stage"
  LC_ALL=C find . -type f -print | LC_ALL=C sort | zip -X -q "$output_path" -@
)

archive_bytes="$(wc -c < "$output_path" | tr -d ' ')"
if [[ "$archive_bytes" -gt 73400320 ]]; then
  echo "Package exceeds the 70 MiB safety cap for base64 FC API upload" >&2
  exit 1
fi
unzip -tq "$output_path" >/dev/null
echo "Created $output_path ($archive_bytes bytes); deploy through private OSS"
