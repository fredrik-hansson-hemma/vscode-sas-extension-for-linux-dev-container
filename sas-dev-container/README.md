# SAS Development Container

A [VS Code Dev Container](https://code.visualstudio.com/docs/devcontainers/containers) for writing and running SAS 9.4 code from Linux or macOS. The container includes Java and is pre-configured to connect to a remote SAS 9.4 Workspace Server using the SAS Integration Technologies Java client — no Windows machine required.

## What is included

| Component | Details |
| --------- | ------- |
| Base image | Ubuntu LTS (`mcr.microsoft.com/devcontainers/base:ubuntu`) |
| Java | OpenJDK 11 (via devcontainer feature) |
| VS Code extension | [SAS Extension for VS Code](https://marketplace.visualstudio.com/items?itemName=SAS.sas-lsp) |
| GlassFish ORB JARs | Downloaded automatically on first container start (required for Java 11+) |
| SAS IT JARs | Copied from your SAS server by running `scripts/copy-sas-jars.sh` |

## Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (or Docker Engine on Linux)
- [Visual Studio Code](https://code.visualstudio.com/) with the [Dev Containers extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers)
- SSH access to a SAS 9.4 server with a Workspace Server running on TCP port 8591 (or another configured port)

> **Note on the SAS extension version**
>
> The `iom-java` connection type used by this container is not yet available in the official marketplace release of the SAS extension. Until it is merged, install the extension manually from a VSIX build of the fork. See [Installing a custom VSIX build](#installing-a-custom-vsix-build) below.

## Setup

### 1. Clone this repository

```sh
git clone https://github.com/your-org/sas-dev-container.git
cd sas-dev-container
```

### 2. Copy SAS JARs from your SAS server

The SAS Integration Technologies Java client JARs are distributed with SAS and must be copied to the `sas-jars/` directory before starting the container:

```sh
bash scripts/copy-sas-jars.sh
```

The script prompts you for the server hostname and the `SASHOME` path and copies the four required JARs (`sas.core`, `sas.svc.connection`, `sas.entities`, `sas.rutil`) using `scp`. Make sure you have SSH access to the SAS server before running the script.

If the script cannot locate the JARs automatically, see [Locating the SAS JARs manually](#locating-the-sas-jars-manually).

### 3. Configure the connection profile

Open `.devcontainer/devcontainer.json` and update the connection profile with your server details:

```json
"SAS.connectionProfiles": {
  "activeProfile": "my-sas-server",
  "profiles": {
    "my-sas-server": {
      "connectionType": "iom-java",
      "host": "your-sas-server.example.com",
      "port": 8591,
      "username": "your-username",
      "sasJarPath": "/opt/sas-jars"
    }
  }
}
```

Do not change `sasJarPath` — it points to the fixed path inside the container where the `sas-jars/` directory is mounted.

### 4. Open the container in VS Code

Open the `sas-dev-container` folder in VS Code. When prompted, click **Reopen in Container**. If you are not prompted automatically, open the Command Palette (`F1`) and run **Dev Containers: Reopen in Container**.

On the first start, VS Code builds the container image, installs Java, and downloads the GlassFish ORB JARs. This takes a few minutes. Subsequent starts are fast.

### 5. Connect to SAS and run code

Open a `.sas` file and click **Run** in the toolbar, or press `F8` to run the selected code. The extension prompts you for your SAS password on the first connection.

## Locating the SAS JARs manually

If `scripts/copy-sas-jars.sh` cannot find the JARs, you can locate them on the SAS server yourself:

```sh
# Find the SAS Integration Technologies JAR directory on the server
ssh your-sas-server "find /opt /usr/local -name 'sas.core_*.jar' 2>/dev/null"
```

Once you know the path, copy the JARs to your local `sas-jars/` directory:

```sh
SAS_SERVER=your-sas-server.example.com
JAR_DIR=/opt/sas/SASHome/SASVersionedJarRepository/eclipse/plugins
LOCAL_JARS=./sas-jars

for JAR in sas.core sas.svc.connection sas.entities sas.rutil; do
  scp "$SAS_SERVER:${JAR_DIR}/${JAR}_*.jar" "$LOCAL_JARS/"
done
```

## Verifying network connectivity

Before opening the container, verify that port 8591 is reachable from your machine:

```sh
nc -z your-sas-server.example.com 8591 && echo "Port open" || echo "Port closed"
```

If the port is closed, contact your SAS administrator to confirm the Workspace Server is running and that any firewall allows outbound TCP connections on that port.

## Installing a custom VSIX build

Until the `iom-java` connection type is merged into the official SAS extension, you need to install a custom build:

1. Clone the fork and check out the feature branch:
   ```sh
   git clone https://github.com/fredrik-hansson-hemma/vscode-sas-extension-for-linux-dev-container.git
   cd vscode-sas-extension-for-linux-dev-container
   git checkout claude/add-iom-java-linux-xFZay
   ```

2. Build the VSIX:
   ```sh
   npm install
   npm install -g @vscode/vsce
   vsce package
   ```

3. Inside the running container, open the Command Palette (`F1`) and run **Extensions: Install from VSIX…**, then select the generated `.vsix` file.

Alternatively, add the following to `.devcontainer/devcontainer.json` to run the install automatically when the container starts (adjust the path to the VSIX):

```json
"postCreateCommand": "bash .devcontainer/postCreate.sh && code --install-extension /path/to/sas-lsp-*.vsix"
```

## Troubleshooting

### `java: command not found` or `spawn java ENOENT`

The container's Java installation may not have completed. Try rebuilding the container: open the Command Palette and run **Dev Containers: Rebuild Container**.

### Connection fails with class-not-found errors

The `sas-jars/` directory does not contain the required SAS JARs. Run `bash scripts/copy-sas-jars.sh` from outside the container (on your host machine) and rebuild the container.

### GlassFish ORB JAR download fails during postCreate

If the container cannot reach Maven Central (for example, due to a corporate proxy), download the JARs manually on your host machine and place them in `sas-jars/`:

```sh
GLASSFISH_VERSION=4.2.4
MAVEN="https://repo1.maven.org/maven2/com/sun/corba/ee"
for ART in glassfish-corba-orb glassfish-corba-omgapi; do
  curl -fsSL "$MAVEN/$ART/$GLASSFISH_VERSION/$ART-$GLASSFISH_VERSION.jar" \
       -o "sas-jars/$ART-$GLASSFISH_VERSION.jar"
done
```

Then rebuild the container.

### Password prompt appears on every connection

The VS Code secret storage persists passwords across sessions. If you are prompted every time, check that the VS Code extension host has write access to the secret storage. On Linux, this sometimes requires unlocking the system keyring.
