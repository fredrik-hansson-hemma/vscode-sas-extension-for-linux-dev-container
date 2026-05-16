#!/bin/bash
# Copies the required SAS Integration Technologies Java client JARs from a
# remote SAS server into the repository's sas-jars/ directory, which an
# iom-java profile can use as its sasJarPath.
#
# Usage:
#   ./tools/copy-sas-jars.sh
#   ./tools/copy-sas-jars.sh --server sas.example.com --sashome /opt/sas/SASHome

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JAR_DIR="$(dirname "$SCRIPT_DIR")/sas-jars"

# ---------------------------------------------------------------------------
# Parse arguments
# ---------------------------------------------------------------------------
SAS_SERVER=""
SASHOME=""

while [[ $# -gt 0 ]]; do
  case $1 in
    --server)  SAS_SERVER="$2"; shift 2 ;;
    --sashome) SASHOME="$2";    shift 2 ;;
    *) echo "Unknown argument: $1"; exit 1 ;;
  esac
done

# ---------------------------------------------------------------------------
# Prompt for missing values
# ---------------------------------------------------------------------------
if [ -z "$SAS_SERVER" ]; then
  read -rp "SAS server hostname or IP: " SAS_SERVER
fi

if [ -z "$SASHOME" ]; then
  read -rp "SASHOME on the SAS server [/opt/sas/SASHome]: " SASHOME
  SASHOME="${SASHOME:-/opt/sas/SASHome}"
fi

JAR_REPO="$SASHOME/SASVersionedJarRepository/eclipse/plugins"

# ---------------------------------------------------------------------------
# Copy JARs
# ---------------------------------------------------------------------------
mkdir -p "$JAR_DIR"

echo "Copying SAS Integration Technologies JARs from $SAS_SERVER:$JAR_REPO ..."
COPIED=0
for JAR in sas.core sas.svc.connection sas.entities sas.rutil; do
  # Filenames include a version suffix, e.g. sas.core_9.4.jar
  if scp "$SAS_SERVER:${JAR_REPO}/${JAR}_*.jar" "$JAR_DIR/" 2>/dev/null; then
    echo "  Copied ${JAR}_*.jar"
    COPIED=$((COPIED + 1))
  else
    echo "  Warning: ${JAR}_*.jar not found at $JAR_REPO"
    echo "  Try locating it manually: ssh $SAS_SERVER find $SASHOME -name '${JAR}*.jar'"
  fi
done

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
TOTAL=$(find "$JAR_DIR" -name '*.jar' | wc -l)
echo "Done. $TOTAL JAR file(s) in sas-jars/."

if [ "$COPIED" -lt 4 ]; then
  echo ""
  echo "One or more JARs could not be found. The typical SASHOME path on a"
  echo "Linux SAS server is /opt/sas/SASHome or /usr/local/SASHome. To check:"
  echo "  ssh $SAS_SERVER ls /opt/sas /usr/local 2>/dev/null"
fi

echo ""
echo "If you run Java 11 or later, GlassFish ORB JARs are also required."
echo "Fetch them with: ./tools/fetch-orb.sh"
