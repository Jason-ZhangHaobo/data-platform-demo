#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .runtime
task_python="${V2_BOOTSTRAP_PYTHON:-python3}"
if [ ! -x .runtime/python/bin/python ]; then "$task_python" -m venv .runtime/python; fi
.runtime/python/bin/python -m pip install --disable-pip-version-check -r scripts/spark-requirements.txt
if [ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] && [ ! -x .runtime/java/Contents/Home/bin/java ]; then
  curl --fail --location --show-error --continue-at - --max-time 600 --output .runtime/jdk.tar.gz 'https://github.com/adoptium/temurin17-binaries/releases/download/jdk-17.0.20.1%2B1/OpenJDK17U-jdk_aarch64_mac_hotspot_17.0.20.1_1.tar.gz'
  printf '%s  %s\n' '196d13ba5f10414bef7f6a05a9b3f00edacb18ebacef2b99485db9e2ee18f0e8' '.runtime/jdk.tar.gz' | shasum -a 256 --check
  mkdir -p .runtime/java
  tar -xzf .runtime/jdk.tar.gz -C .runtime/java --strip-components=1
fi
printf '%s\n' 'Spark dependencies ready. On Linux set JAVA_HOME to Java 17; local macOS arm64 JDK is project-scoped.'
