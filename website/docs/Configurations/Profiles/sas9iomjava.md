---
sidebar_position: 5
---

# SAS 9.4 (remote - IOM Java) Connection Profile

To use a SAS 9.4 (remote - IOM Java) connection type, your SAS server must be a SAS 9.4 Workspace Server reachable over TCP (default port 8591). Unlike the [SAS 9.4 (remote - IOM)](./sas9iom.md) connection type, this connection type uses the SAS Integration Technologies Java client instead of Windows-only COM libraries. It runs on Linux, macOS, and Windows, and requires no changes to your SAS server.

:::note

You can use the console log to help debug connection issues. For more information, see [How do I debug connection failures?](../../faq.md#how-do-i-debug-connection-failures)

:::

## Prerequisites

### SAS Server Requirements

The SAS 9.4 server must have a **Workspace Server** configured and running, managed by the SAS Object Spawner service. This is the standard configuration for remote SAS 9.4 access and requires no special setup beyond what is already in place for other IOM-based clients such as SAS Enterprise Guide.

This connection type connects **directly** to the Workspace Server using its host name and port. A SAS Metadata Server is **not** required.

TCP port 8591 (or the port configured for your Workspace Server) must be reachable from the machine where VS Code is running. You can verify network connectivity from a terminal before configuring the extension:

```sh
# Check that the port is reachable
nc -z sas-server.example.com 8591 && echo "Port open" || echo "Port closed"
```

If the port is not reachable, contact your SAS administrator to confirm the Workspace Server is running and that any firewall between your machine and the server allows outbound TCP connections on that port.

### Java Runtime

The extension spawns a small Java process to manage the IOM connection, so a Java executable must be available on the machine where VS Code is running. Java 8 is recommended.

| Java version | Support |
| ------------ | ------- |
| Java 8 | Fully supported |
| Java 9–10 | Supported (`--add-modules java.corba` is added automatically) |
| Java 11+ | Requires [GlassFish ORB JARs](#java-11-and-later) in `sasJarPath` |

You can verify your Java version with:

```sh
java -version
```

### SAS Integration Technologies Java Client JARs

The extension connects to SAS using the SAS Integration Technologies Java client. The required JAR files are distributed with SAS and must be copied to a local directory on the VS Code client machine.

The following JAR files are required:

- `sas.core.jar`
- `sas.svc.connection.jar`
- `sas.entities.jar`
- `sas.rutil.jar`

These files are typically located under `$SASHOME/SASVersionedJarRepository/eclipse/plugins/` on your SAS server. The filenames include a version suffix, for example `sas.core_9.4.jar`. The extension loads all JAR files found in the `sasJarPath` directory, so copying the files as-is is sufficient.

You can copy these files from your SAS server to a local directory:

```sh
SAS_SERVER=sas-server.example.com
SASHOME=/opt/sas/SASHome
LOCAL_JAR_DIR=$HOME/sas-jars

mkdir -p $LOCAL_JAR_DIR
for JAR in sas.core sas.svc.connection sas.entities sas.rutil; do
  scp "$SAS_SERVER:$SASHOME/SASVersionedJarRepository/eclipse/plugins/${JAR}_*.jar" \
      "$LOCAL_JAR_DIR/"
done
```

If you are not sure of the `SASHOME` path on your server, ask your SAS administrator or run `ls /opt/sas /usr/local/SASHome 2>/dev/null` on the server.

#### Java 11 and later

Java 11 removed the CORBA module that the SAS IOM Java client depends on. To use this connection type with Java 11 or later, place the [GlassFish ORB](https://github.com/eclipse-ee4j/orb) JARs in the same directory as the SAS JARs. The extension detects them automatically by looking for the `com.sun.corba.ee.impl.orb.ORBImpl` class.

The required JARs are published on Maven Central under the group `com.sun.corba.ee`. Download them and place them in your `sasJarPath` directory:

| Maven artifact | Description |
| -------------- | ----------- |
| `com.sun.corba.ee:glassfish-corba-orb` | ORB implementation (`ORBImpl`) |
| `com.sun.corba.ee:glassfish-corba-omgapi` | CORBA API interfaces |

You can download both JARs using Maven:

```sh
mvn dependency:copy \
  -Dartifact=com.sun.corba.ee:glassfish-corba-orb:4.2.4 \
  -DoutputDirectory=$LOCAL_JAR_DIR
mvn dependency:copy \
  -Dartifact=com.sun.corba.ee:glassfish-corba-omgapi:4.2.4 \
  -DoutputDirectory=$LOCAL_JAR_DIR
```

Or download them manually from [Maven Central](https://search.maven.org/search?q=g:com.sun.corba.ee) and place them in your `sasJarPath` directory alongside the SAS JARs.

:::note

Newer SAS 9.4 maintenance releases (M6 and later) may include GlassFish ORB JARs in the `SASVersionedJarRepository`. Check whether files matching `glassfish-corba-*.jar` already exist under `$SASHOME/SASVersionedJarRepository/` before downloading separately.

:::

## Profile Anatomy

A SAS 9.4 (remote - IOM Java) connection profile includes the following parameters:

`"connectionType": "iom-java"`

| Name         | Description                                 | Additional Notes                                                            |
| ------------ | ------------------------------------------- | --------------------------------------------------------------------------- |
| `host`       | IOM Server Host                             | Appears when hovering over the status bar.                                  |
| `username`   | IOM Server Username                         | The username to establish the IOM connection to the server.                 |
| `port`       | IOM Server Port                             | The port of the IOM server. The default value is 8591.                      |
| `sasJarPath` | Path to SAS Integration Technologies JARs  | A fully qualified path to a local directory containing the required JAR files. |
| `javaPath`   | Path to the Java executable (optional)      | Defaults to `java` resolved from the system PATH.                           |

## Connection Profile Examples

```json
{
  "SAS.connectionProfiles": {
    "activeProfile": "sas9-iom-java",
    "profiles": {
      "sas9-iom-java": {
        "connectionType": "iom-java",
        "host": "sas-server.example.com",
        "port": 8591,
        "username": "myuser",
        "sasJarPath": "/home/myuser/sas-jars"
      }
    }
  }
}
```

To use a specific Java installation, add the `javaPath` parameter:

```json
"sas9-iom-java": {
    "connectionType": "iom-java",
    "host": "sas-server.example.com",
    "port": 8591,
    "username": "myuser",
    "sasJarPath": "/home/myuser/sas-jars",
    "javaPath": "/usr/lib/jvm/java-8-openjdk-amd64/bin/java"
}
```

## Authenticating to a SAS Server

When connecting, the extension prompts you to enter your password in a secure input box. The password is stored in VS Code's built-in secret storage and reused for subsequent connections until the session is closed or you switch profiles.
