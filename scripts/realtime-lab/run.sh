#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ $# -lt 1 || $# -gt 2 || ! -d "$1" || -z "${JAVA_HOME:-}" || (${2:-} != "" && ${2:-} != "--checkpoint-crash" && ${2:-} != "--window-crash" && ${2:-} != "--broker-crash") ]]; then
  echo "Usage: JAVA_HOME=/path/to/jdk17 bash scripts/realtime-lab/run.sh EXISTING_PRIVATE_DIRECTORY [--checkpoint-crash|--window-crash|--broker-crash]" >&2
  exit 2
fi

repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
parent=$(cd "$1" && pwd -P)
work=$(mktemp -d "$parent/quote-replay.XXXXXXXX")
mkdir "$work/classes"
printf 'Run directory: %s\n' "$work"

cat > "$work/settings.xml" <<'XML'
<settings xmlns="http://maven.apache.org/SETTINGS/1.2.0"/>
XML

maven_mode=()
if [[ ${SHUDUO_REALTIME_OFFLINE:-0} == 1 ]]; then maven_mode+=(-o); fi
"${MAVEN_BIN:-mvn}" -B -C -q "${maven_mode[@]}" -s "$work/settings.xml" -f "$repo/scripts/realtime-lab/pom.xml" \
  "-Dmaven.repo.local=${SHUDUO_REALTIME_MAVEN_REPO:-$parent/maven-repo}" \
  "-Dmdep.outputFile=$work/classpath.txt" dependency:build-classpath > "$work/maven.log" 2>&1

classpath=$(cat "$work/classpath.txt")
"$JAVA_HOME/bin/javac" --release 17 -cp "$classpath" -d "$work/classes" \
  "$repo/scripts/realtime-lab/src/main/java/cn/shuduo/lab/"*.java

"$JAVA_HOME/bin/java" -Xmx1024m -Dorg.slf4j.simpleLogger.defaultLogLevel=warn \
  -cp "$work/classes:$classpath" cn.shuduo.lab.QuoteReplay "$repo" "$work/run" "${@:2}" > "$work/engine.log" 2>&1

cat "$work/run/evidence.json"
