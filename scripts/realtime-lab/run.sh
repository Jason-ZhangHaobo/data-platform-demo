#!/usr/bin/env bash
set -euo pipefail
umask 077

if [[ $# != 1 || ! -d "$1" || -z "${JAVA_HOME:-}" ]]; then
  echo "Usage: JAVA_HOME=/path/to/jdk17 bash scripts/realtime-lab/run.sh EXISTING_PRIVATE_DIRECTORY" >&2
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

"${MAVEN_BIN:-mvn}" -B -C -q -s "$work/settings.xml" -f "$repo/scripts/realtime-lab/pom.xml" \
  "-Dmaven.repo.local=${SHUDUO_REALTIME_MAVEN_REPO:-$parent/maven-repo}" \
  "-Dmdep.outputFile=$work/classpath.txt" dependency:build-classpath > "$work/maven.log" 2>&1

classpath=$(cat "$work/classpath.txt")
"$JAVA_HOME/bin/javac" --release 17 -cp "$classpath" -d "$work/classes" \
  "$repo/scripts/realtime-lab/src/main/java/cn/shuduo/lab/QuoteReplay.java"

"$JAVA_HOME/bin/java" -Xmx1024m -Dorg.slf4j.simpleLogger.defaultLogLevel=warn \
  -cp "$work/classes:$classpath" cn.shuduo.lab.QuoteReplay "$repo" "$work/run" > "$work/engine.log" 2>&1

cat "$work/run/evidence.json"
