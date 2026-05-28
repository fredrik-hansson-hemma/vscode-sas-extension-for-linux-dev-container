# Development Guide – IOM Java Connection

This document describes how to build and test the `iom-java` connection type,
which lets VS Code connect to a remote SAS 9.4 Workspace Server from Linux
using the SAS Integration Technologies Java client.

## Architecture

```
VS Code Extension (TypeScript/Node.js)
    ↓  newline-delimited JSON over stdin/stdout
iom-java-bridge.jar  (spawned as child_process)
    ↓  IOM CORBA / SAS Java API (user-supplied JARs)
SAS 9.4 Workspace Server (TCP port 8591)
```

## Prerequisites

| Tool    | Version           | Notes                                                                                        |
| ------- | ----------------- | -------------------------------------------------------------------------------------------- |
| Node.js | LTS               | See `.nvmrc`                                                                                 |
| Java    | **8** recommended | Java 9/10 need `--add-modules java.corba`; Java 11+ needs GlassFish ORB JARs in `sasJarPath` |
| Maven   | 3.x               | For building the Java bridge                                                                 |
| vsce    | latest            | For packaging the VSIX                                                                       |

### Using the devcontainer (recommended)

Open the repository in VS Code and select **Reopen in Container**. The
devcontainer installs Node.js LTS, JDK 11, Maven, and `vsce` automatically.

> **Note on Java runtime**: JDK 11 is used to _compile_ the bridge JAR. The
> JAR targets Java 8 bytecode (`--release 8`). At runtime you need Java 8 on
> the machine running VS Code, or Java 9/10 with `--add-modules java.corba`.
> For Java 11+, place GlassFish ORB JARs
> (`glassfish-corba-orb-*.jar`, `glassfish-corba-omgapi-*.jar`) alongside the
> SAS JARs in your `sasJarPath` directory; the bridge detects them automatically.

## Building

### 1. Build the Java bridge

```bash
mvn package -f iom-java-bridge/pom.xml
```

Output: `iom-java-bridge/target/iom-java-bridge.jar`

### 2. Build the extension

```bash
npm install
npm run compile
```

### 3. Package the VSIX

```bash
npm run package
# or
vsce package
```

The resulting `.vsix` file can be installed in VS Code via
**Extensions → Install from VSIX…**

## SAS JAR files

The bridge loads SAS Integration Technologies JARs at runtime from the
`sasJarPath` directory you configure. Copy these from your SAS 9.4 installation
(typically under `$SASHOME/SASVersionedJarRepository/eclipse/plugins/`) to a
local directory accessible from the VS Code host:

```bash
# Example: copy from a remote server
scp sasserver:/opt/sas/SASVersionedJarRepository/eclipse/plugins/sas.core_*.jar ./sas-jars/
scp sasserver:/opt/sas/SASVersionedJarRepository/eclipse/plugins/sas.svc.connection_*.jar ./sas-jars/
scp sasserver:/opt/sas/SASVersionedJarRepository/eclipse/plugins/sas.entities_*.jar ./sas-jars/
scp sasserver:/opt/sas/SASVersionedJarRepository/eclipse/plugins/sas.rutil_*.jar ./sas-jars/
```

Minimum required JARs:

- `sas.core.jar`
- `sas.svc.connection.jar`
- `sas.entities.jar`
- `sas.rutil.jar`

## Connection profile

Add a profile to your VS Code settings (`settings.json`):

```json
{
  "SAS.connectionProfiles": {
    "activeProfile": "my-sas9-iom",
    "profiles": {
      "my-sas9-iom": {
        "connectionType": "iom-java",
        "host": "sas-server.example.com",
        "port": 8591,
        "username": "myuser",
        "sasJarPath": "/home/me/sas-jars",
        "javaPath": "/usr/bin/java"
      }
    }
  }
}
```

`javaPath` is optional and defaults to `java` (resolved from `PATH`).

## Testing the bridge manually

You can drive the bridge interactively from a terminal to verify connectivity
before opening VS Code:

```bash
java -jar iom-java-bridge/target/iom-java-bridge.jar
```

Then type commands (one JSON object per line) and observe responses:

```json
{"cmd":"connect","host":"sas-server.example.com","port":8591,"username":"myuser","password":"secret","sasJarPath":"/home/me/sas-jars"}
{"cmd":"submit","code":"proc print data=sashelp.class(obs=3); run;"}
{"cmd":"flushLog"}
{"cmd":"getLibraries"}
{"cmd":"getTables","libref":"SASHELP"}
{"cmd":"getColumns","libref":"SASHELP","table":"CLASS"}
{"cmd":"disconnect"}
```

## Bridge command reference

| Command        | Required fields                                      | Response `data`                                     |
| -------------- | ---------------------------------------------------- | --------------------------------------------------- |
| `connect`      | `host`, `port`, `username`, `password`, `sasJarPath` | —                                                   |
| `submit`       | `code`                                               | —                                                   |
| `flushLog`     | —                                                    | `string` (log text)                                 |
| `flushList`    | —                                                    | `string` (list output text)                         |
| `getLibraries` | —                                                    | `Array<{id, name, readOnly}>`                       |
| `getTables`    | `libref`                                             | `string[]` (table names)                            |
| `getColumns`   | `libref`, `table`                                    | `Array<{index, name, type, length, label, format}>` |
| `disconnect`   | —                                                    | —                                                   |

Every response is `{"status":"ok",...}` or `{"status":"error","message":"..."}`.

## Known limitations

- **Java 11+**: CORBA is not included in JDK 11+. Place GlassFish ORB JARs in
  `sasJarPath` to work around this (automatic detection is built in).
- **Grid Manager**: Not supported in this iteration.
- **Keychain integration**: Passwords are stored in VS Code's secret storage
  (per-session encrypted store), not in the system keychain.
- **HTML output**: ODS HTML5 output is not yet streamed back; full log text is
  returned instead. HTML5 result display is a planned follow-up.
