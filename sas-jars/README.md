# sas-jars/

Local directory for JAR files the `iom-java` connection type loads at runtime.
This directory is gitignored so binaries from a SAS install never end up in
version control.

## Required SAS Integration Technologies Java client JARs

Copy these four files from a SAS 9.4 server into this directory. They live
under `$SASHOME/SASVersionedJarRepository/eclipse/plugins/` and carry a version
suffix (for example `sas.core_9.4.jar`) — the extension loads everything in
this folder, so copying them as-is is fine.

| File                     | Description                               |
| ------------------------ | ----------------------------------------- |
| `sas.core.jar`           | SAS Integration Technologies core         |
| `sas.svc.connection.jar` | Connection-factory and workspace types    |
| `sas.entities.jar`       | Shared SAS object entities                |
| `sas.rutil.jar`          | Remote utility classes used by the client |

See [website/docs/Configurations/Profiles/sas9iomjava.md](../website/docs/Configurations/Profiles/sas9iomjava.md)
for the `scp` snippet that copies them from a server.

## GlassFish ORB (Java 11+)

If the Java runtime on your machine is Java 11 or newer, you also need the
GlassFish ORB JARs. The easiest way is to run the helper script:

```sh
./tools/fetch-orb.sh
```

(or pick the **Tasks: Run Task → Fetch GlassFish ORB** action in VS Code). It
fetches the two JARs from Maven Central into this directory.

Java 8–10 do not need the ORB JARs — the SAS client uses the JDK-bundled CORBA
classes there.

## How the extension uses this directory

Point the `sasJarPath` field of an `iom-java` profile at the absolute path of
this directory. The Java bridge classloader includes every `*.jar` it finds
here, so adding or removing files only requires re-opening the connection.
