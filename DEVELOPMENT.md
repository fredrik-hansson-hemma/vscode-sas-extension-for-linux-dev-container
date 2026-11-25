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

> **Note on Java runtime**: any JDK 11+ can _compile_ the bridge JAR. The
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

Output: `iom-java-bridge/target/iom-java-bridge.jar`. Copy it to
`client/src/connection/iom_java/`, where `npm run compile` picks it up:

```bash
cp iom-java-bridge/target/iom-java-bridge.jar client/src/connection/iom_java/
```

A prebuilt copy is already checked in there, so this step is only needed after
changing the bridge.

### 2. Build the extension

```bash
npm install
npm run compile
```

### 3. Package the VSIX

```bash
npx @vscode/vsce package
```

This runs lint and compile (`vscode:prepublish`) and writes
`sas-lsp-<version>.vsix` to the repository root. The bridge JAR is included at
`client/dist/node/iom-java-bridge.jar`.

### 4. Install the VSIX

```bash
code --install-extension sas-lsp-*.vsix
```

or **Extensions → ⋯ → Install from VSIX…** in VS Code. This replaces the
marketplace version of the SAS extension if it is installed. Then set up the
JARs and a connection profile as described below and in
[sas9iomjava.md](website/docs/Configurations/Profiles/sas9iomjava.md).

## SAS JAR files

The bridge loads SAS Integration Technologies JARs at runtime from the
`sasJarPath` directory you configure. The repository includes a `sas-jars/`
folder (gitignored except for its README) which is a convenient default
location. Copy these from your SAS 9.4 installation (typically under
`$SASHOME/SASVersionedJarRepository/eclipse/plugins/`) to that directory or
another local path accessible from the VS Code host:

```bash
# Copy over SSH from the SAS server (prompts for host and SASHOME)
./tools/copy-sas-jars.sh
./tools/copy-sas-jars.sh --server sasserver --sashome /opt/sas/SASHome
```

Minimum required JARs:

- `sas.core.jar`
- `sas.svc.connection.jar`
- `sas.entities.jar`
- `sas.rutil.jar`

For Java 11+, fetch the GlassFish ORB JARs into the same directory:

```bash
./tools/fetch-orb.sh           # defaults to ./sas-jars
./tools/fetch-orb.sh /custom   # or a different directory
```

VS Code users can run **Tasks: Run Task → Fetch GlassFish ORB**.

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

- **Bridge metadata timeout**: `getLibraries`, `getTables` and `getColumns`
  fail with an error if SAS has not finished within 60 seconds, rather than
  returning a partial list.
- **Java 11+**: CORBA is not included in JDK 11+. Place GlassFish ORB JARs in
  `sasJarPath` to work around this (automatic detection is built in).
- **Grid Manager**: Not supported in this iteration.
- **Keychain integration**: Passwords are stored in VS Code's secret storage
  (per-session encrypted store), not in the system keychain.
- **HTML output**: ODS HTML5 output is not yet streamed back; full log text is
  returned instead. HTML5 result display is a planned follow-up.
- **Table viewer**: rows are read with a DATA step that writes one log line
  per cell, so values longer than the SAS log line size (about 200
  characters) are truncated.
- **Filter on table viewer**: ignored. The `LibraryAdapter.getRows` interface
  accepts a `TableQuery`, but iom-java does not translate it to a SAS WHERE
  clause yet; the filter UI does nothing for iom-java profiles.
- **Cancel running program**: not yet supported. Needs a `cancel` bridge
  command wired to `ILanguageService.Cancel`.
