#!/bin/bash
set -euo pipefail

WORKSPACE_JARS="$(pwd)/sas-jars"
CONTAINER_JARS="/opt/sas-jars"

# Make sure the sas-jars workspace directory exists
mkdir -p "$WORKSPACE_JARS"

# Expose the JAR directory at the fixed path the connection profile expects
if [ ! -L "$CONTAINER_JARS" ]; then
  sudo ln -s "$WORKSPACE_JARS" "$CONTAINER_JARS"
fi

# On Java 11+ the JDK no longer bundles the CORBA module that the SAS IOM
# client depends on. Download GlassFish ORB JARs from Maven Central so the
# iom-java connection type works out of the box.
JAVA_MAJOR=$(java -version 2>&1 | grep -oP '(?<=version ")[^"]+' | cut -d. -f1)
# Handle 1.x versioning (Java 8 reports as "1.8")
[ "$JAVA_MAJOR" = "1" ] && JAVA_MAJOR=$(java -version 2>&1 | grep -oP '(?<=version ")[^"]+' | cut -d. -f2)

if [ "${JAVA_MAJOR:-0}" -ge 11 ] 2>/dev/null; then
  echo "Java ${JAVA_MAJOR} detected — downloading GlassFish ORB JARs for Java 11+ CORBA support..."
  GLASSFISH_VERSION="4.2.4"
  MAVEN_CENTRAL="https://repo1.maven.org/maven2/com/sun/corba/ee"
  for ARTIFACT in glassfish-corba-orb glassfish-corba-omgapi; do
    JAR="${ARTIFACT}-${GLASSFISH_VERSION}.jar"
    if [ ! -f "$WORKSPACE_JARS/$JAR" ]; then
      curl -fsSL \
        "${MAVEN_CENTRAL}/${ARTIFACT}/${GLASSFISH_VERSION}/${JAR}" \
        -o "$WORKSPACE_JARS/$JAR" \
        && echo "  Downloaded $JAR" \
        || echo "  Warning: could not download $JAR — try running scripts/copy-sas-jars.sh --glassfish"
    fi
  done
fi

echo ""
echo "╔═══════════════════════════════════════════════════════════╗"
echo "║          SAS Development Environment — ready              ║"
echo "╠═══════════════════════════════════════════════════════════╣"

SAS_JAR_COUNT=$(find "$WORKSPACE_JARS" -name 'sas.*.jar' 2>/dev/null | wc -l)
if [ "$SAS_JAR_COUNT" -eq 0 ]; then
  echo "║ ⚠  SAS JARs not found in sas-jars/.                      ║"
  echo "║    Run: bash scripts/copy-sas-jars.sh                    ║"
else
  echo "║ ✓  SAS JARs found ($SAS_JAR_COUNT files)                          ║"
fi

echo "║                                                           ║"
echo "║ Before connecting, update the host, port, and username   ║"
echo "║ in .devcontainer/devcontainer.json and rebuild the       ║"
echo "║ container — or edit the profile in VS Code settings.     ║"
echo "╚═══════════════════════════════════════════════════════════╝"
