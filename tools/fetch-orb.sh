#!/usr/bin/env bash
# Download GlassFish ORB jars used by the iom-java connection on Java 11+.
#
# Java 11 removed the built-in CORBA classes. The SAS Integration Technologies
# Java client expects an ORB on the classpath, so we fetch the GlassFish ORB
# implementation from Maven Central into the directory where the SAS JARs live.
#
# Usage:
#   tools/fetch-orb.sh [target-directory]
#
# Defaults to ./sas-jars relative to the workspace root.

set -euo pipefail

ORB_VERSION="4.2.4"
TARGET_DIR="${1:-sas-jars}"

mkdir -p "$TARGET_DIR"

ABS_TARGET="$(cd "$TARGET_DIR" && pwd)"

echo "Fetching GlassFish ORB ${ORB_VERSION} into ${ABS_TARGET}"

mvn -q dependency:copy \
  -Dartifact="com.sun.corba.ee:glassfish-corba-orb:${ORB_VERSION}" \
  -DoutputDirectory="$ABS_TARGET"

mvn -q dependency:copy \
  -Dartifact="com.sun.corba.ee:glassfish-corba-omgapi:${ORB_VERSION}" \
  -DoutputDirectory="$ABS_TARGET"

echo "Done. Files in ${ABS_TARGET}:"
ls -1 "$ABS_TARGET" | grep -E '^glassfish-corba-' || true
