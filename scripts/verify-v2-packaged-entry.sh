#!/usr/bin/env bash
# Exercise the runtime in the actual release ZIP. No checkout application
# modules, provider credentials or live stores are used by the fixture.
set -euo pipefail
archive="${1:?expected the built FC ZIP}"
source_root="${2:?expected the selected application checkout}"
test_file=test/v2/invited-task-context.test.mjs
fixture=test/v2/fixtures/agent-context-derivation.mjs
package_root=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/fc-entry-XXXXXX")
trap 'rm -rf "$package_root"' EXIT
unzip -q "$archive" -d "$package_root"
chmod 0755 "$package_root/runtime/node"
(
  cd "$package_root"
  test "$(./runtime/node -p 'process.platform + "/" + process.arch')" = "linux/x64"
  ./runtime/node -e 'import("node:sqlite").then(() => console.log("Packaged SQLite runtime ready"))'
)

if [[ -f "$source_root/$test_file" || -f "$source_root/src/v2/invited-task-context.mjs" ]]; then
  mkdir -p "$package_root/test/v2/fixtures"
  cp "$source_root/$test_file" "$package_root/$test_file"
  cp "$source_root/$fixture" "$package_root/$fixture"
  (cd "$package_root" && ./runtime/node --test "$test_file")
else
  echo "Selected historical source predates the invited task HTTP test"
fi
