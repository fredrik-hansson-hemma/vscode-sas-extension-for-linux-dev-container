---
sidebar_position: 5
---

# SAS 9.4 (remote - IOM Java) Connection Profile

To use a SAS 9.4 (remote - IOM Java) connection type, your SAS server must be a SAS 9.4 Workspace Server reachable over TCP (default port 8591). Unlike the [SAS 9.4 (remote - IOM)](./sas9iom.md) connection type, this connection type uses the SAS Integration Technologies Java client instead of Windows-only COM libraries. It runs on Linux, macOS, and Windows, and requires no changes to your SAS server.

:::note

You can use the console log to help debug connection issues. For more information, see [How do I debug connection failures?](../../faq.md#how-do-i-debug-connection-failures)

:::

## Prerequisites

### Java Runtime

Java 8 is recommended. The extension spawns a small Java process to manage the IOM connection, so a Java executable must be available on the machine where VS Code is running.

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

You can copy these files from your SAS installation (typically located under `$SASHOME/SASVersionedJarRepository/eclipse/plugins/`) to a local directory:

```sh
# Example: copy from a remote SAS server
SAS_SERVER=sas-server.example.com
SASHOME=/opt/sas/SASHome
LOCAL_JAR_DIR=$HOME/sas-jars

mkdir -p $LOCAL_JAR_DIR
for JAR in sas.core sas.svc.connection sas.entities sas.rutil; do
  scp "$SAS_SERVER:$SASHOME/SASVersionedJarRepository/eclipse/plugins/${JAR}_*.jar" \
      "$LOCAL_JAR_DIR/"
done
```

#### Java 11 and later

Java 11 removed the CORBA module that the SAS IOM Java client depends on. To use this connection type with Java 11 or later, place the [GlassFish ORB](https://github.com/eclipse-ee4j/orb) JARs in the same directory as the SAS JARs. The extension detects them automatically.

Download the following JARs from Maven Central and add them to your `sasJarPath` directory:

- `glassfish-corba-orb-*.jar`
- `glassfish-corba-omgapi-*.jar`

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
