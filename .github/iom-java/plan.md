# iom-java — Plan för fortsatt arbete

- **Skapad:** 2026-05-28
- **Branch:** `claude/add-iom-java-linux-xFZay`
- **HEAD:** `fc9c5d0` (docs: expand iom-java profile page with server and network requirements)
- **Spann:** `ce55b9f..HEAD` (5 commits, +1970 / -22 rader, 22 filer)

Övergripande mål: kunna använda SAS 9.4 IOM från Linux i en VS Code dev-container och därigenom möjliggöra säkrare AI-assisterad SAS-utveckling.

---

## 1. Sammanfattning av nuläget (review)

### Vad som är klart och fungerar bra

- Ny `iom-java` connection type är fullt inwirad: profil-typ, schema-validering, prompt-flöde, `LibraryAdapterFactory`, lokaliseringssträngar.
- **Reflection-baserad Java-bridge** i [iom-java-bridge/](../../iom-java-bridge/) — kompileras utan SAS/CORBA på classpath. JSON-stdio-protokoll mot Node-sidan.
- **Java 11+ stöds** via auto-detection av GlassFish ORB (`com.sun.corba.ee.impl.orb.ORBImpl`) i `sasJarPath`.
- Tester för session-spawn/connect/run/close samt adapter-mappning av `getLibraries`/`getTables`/`getColumns`/`getTableRowCount`/`deleteTable`.
- Doc-sida ([sas9iomjava.md](../../website/docs/Configurations/Profiles/sas9iomjava.md)) + matrix + accessLibraries + FAQ är på plats. [DEVELOPMENT.md](../../DEVELOPMENT.md) beskriver bygge.
- Säker lösenordshantering via VS Code SecretStorage. SAS-namn saneras i bridge mot SAS code injection.
- Pre-built JAR (~2.2 MB) committad och kopieras till `client/dist/node/` av [tools/build.mjs](../../tools/build.mjs) — extension går att installera utan att slutanvändaren har Maven.

### Allvarligare problem (bör fixas innan extern PR)

1. **Tabell-data via PROC SQL-logparsing fungerar troligen inte** — [IomJavaLibraryAdapter.ts:160-180](../../client/src/connection/iom_java/IomJavaLibraryAdapter.ts#L160-L180) `split(/\t/)` mot SAS-logg. PROC SQL skriver inte tab-separerade rader. Matrix säger Table viewer ✓ men den är trasig.
2. **`buildWhereClause` är en no-op** ([IomJavaLibraryAdapter.ts:268-271](../../client/src/connection/iom_java/IomJavaLibraryAdapter.ts#L268-L271)) — returnerar `(1=1 /* filter: ... */)`.
3. **`_html5FileName` sätts aldrig** ([index.ts:36, 111](../../client/src/connection/iom_java/index.ts#L36)) — ODS HTML5-grenen körs aldrig. Antingen implementera eller städa bort.
4. **`cancel()` saknas** men matrix markerar "Able to cancel ✓". Antingen implementera eller uppdatera matrix.
5. **Lint-fel kvar:** `err as Error` i [index.test.ts:137](../../client/test/connection/iom_java/index.test.ts#L137) bryter `assertionStyle: never`.
6. **Prettier failar** i 4 filer (index.ts, IomJavaLibraryAdapter.ts, IomJavaLibraryAdapter.test.ts, sas9iomjava.md).

### Mindre / robusthet

- Inget request-timeout i [IomJavaSession.send](../../client/src/connection/iom_java/index.ts#L155); enda `_pendingResolve`-slot.
- `collectUntilDone` pollar 200 ms — ger latens i library-fetch.
- `findMethod` matchar första metoden med givet namn — versionsrisk vid overloads.
- Singleton-session: byte av profil utan close kan ge stale connection.
- Död kod: `_password`-fält sätts men läses aldrig.
- Stderr från bridge loggas oförändrat till `console.warn` (möjliga sas-stacktraces i devtools-konsolen).
- `maxNumberOfRowsToRead: 100` hårdkodat i [IomJavaLibraryAdapter.ts:213](../../client/src/connection/iom_java/IomJavaLibraryAdapter.ts#L213).
- 2.2 MB JAR i git — bör byggas vid `vscode:prepublish` istället, särskilt inför upstream-PR.

### Testtäckning — luckor

- `getRows`, `getRowsAsCSV`, `getTableInfo` saknar tester (just `getRows` är där bug #1 sitter).
- Inga error-path-tester (bridge dör mitt i request, JAR saknas, fel `sasJarPath`).
- Bridge-projektet har ingen `tests/`-katalog.
- Testet [index.test.ts:181-189](../../client/test/connection/iom_java/index.test.ts#L181-L189) maskerar bug #3 — verifierar att `html5` är `undefined`, vilket alltid är sant.

---

## 2. Plan i fyra faser

### Fas 0 — Stäng av regressioner (0.5 dag) ✅

Mål: `npm run lint` och `npx prettier --check .` gröna.

1. [x] Fix lint i [index.test.ts:137](../../client/test/connection/iom_java/index.test.ts#L137) — byt `err as Error` mot `if (err instanceof Error) caughtError = err;`.
2. [x] `npx prettier --write` på de 4 filerna ovan (plus 4 ytterligare iom-java-rörda filer: `LibraryAdapterFactory.ts`, `profile.ts`, `connection/index.ts`, `DEVELOPMENT.md`).
3. [x] `prettier --check` finns redan som `npm run format:check` och körs i `.github/workflows/pr.yml`. Inget mer behövs.
4. [x] **Commit:** `chore(iom-java): fix lint/format regressions` (`6b38cba`).

### Fas 1 — Verifiera MVP i devcontainern (1–2 dagar) — punkt 1-3 klara (`d04e910`)

Mål: connect → submit → log fungerar end-to-end mot en riktig SAS 9.4-server. Det räcker för AI-assistentens grundvärde.

1. [x] **Bygg-skript för bridgen i postCreate.** Tillagt i [.devcontainer/devcontainer.json](../../.devcontainer/devcontainer.json) — `mvn ... package && cp ... iom-java-bridge.jar client/src/connection/iom_java/`. Bekräftat: build går igenom, JAR-en hamnar där `tools/build.mjs` förväntar sig den. Klippnotering i [DEVELOPMENT.md](../../DEVELOPMENT.md) uppdaterad.
2. [x] **GlassFish ORB automatiskt.** [tools/fetch-orb.sh](../../tools/fetch-orb.sh) hämtar `glassfish-corba-orb` + `glassfish-corba-omgapi` 4.2.4 till `sas-jars/` (eller annan katalog). Exponerad som VS Code task "Fetch GlassFish ORB" i [.vscode/tasks.json](../../.vscode/tasks.json). Refererad från både [sas9iomjava.md](../../website/docs/Configurations/Profiles/sas9iomjava.md) och DEVELOPMENT.md.
3. [x] **`sas-jars/`-policy.** [.gitignore](../../.gitignore) ignorerar `sas-jars/*` men whitelistar `sas-jars/README.md`. README listar de fyra SAS-JARs och pekar på `fetch-orb.sh` för Java 11+.
4. [ ] **End-to-end-test mot riktig server:** profil i `settings.json`, kör `data _null_; put 'hello'; run;`, verifiera log. Kör `proc print data=sashelp.class;` och verifiera Libraries-trädet. _Kan inte köras härifrån — kräver SAS 9.4-server. Pausad tills Fredrik kör manuellt._
5. [ ] **Felfallstester:** fel lösenord, tom `sasJarPath`, ingen `java` på PATH, Java 11 utan GlassFish-jars. Notera vilka felmeddelanden som idag är obegripliga och förbättra dem i Fas 2. _Beror på (4)._

### Fas 2 — Adressera de allvarligare buggarna (1–3 dagar) ✅ — alla punkter klara

Prioritera efter vad Fas 1 visar att man faktiskt stöter på.

1. [x] **`cancel()`** — markerad ✗ i matrix tills `cancel` bridge-kommando implementeras (`5439f8e`). Implementation skjuten till framtida iteration (kräver e2e-validering mot SAS).
2. [x] **Logg-/HTML5-rensning** — `_html5FileName`-blocket borttaget (`7932c32`). Testet som maskerade buggen uppdaterat. ODS HTML5 är fortfarande en planerad follow-up.
3. [x] **`getRows`** — Table viewer markerad ✗ i matrix (`5439f8e`). Behåller existerande PROC SQL-parsning som best-effort tills strukturerad `getRows` bridge-kommando implementeras.
4. [x] **`buildWhereClause`** — borttaget (`bff5bd5`). `query`-parameter behålls i signaturen (interface-kontrakt) men ignoreras med kommentar + targeted eslint-disable.
5. [x] **Robusthet i `send()`** — 5-minuters request-timeout + concurrency-guard med tydligt felmeddelande, plus rejection vid bridge-exit (`8f61009`). Nytt unit-test för concurrency-guarden.
6. [x] **Död kod** — `_password`-fält borttaget (`3136736`).

Varje punkt blir egen commit så historiken förblir granskbar.

### Fas 3 — PR-redo (om upstream är målet, valfri)

1. **Bygg JAR i `vscode:prepublish`** istället för att committa den. ITC committar `.ps1` (text); en kompilerad artefakt drar repo-tyngd över tid.
2. **Återförfattarskap** — alla iom-java-commits är signerade "Claude". Squasha och re-författa innan upstream-PR.
3. **Test-täckning för error paths** + integrationstest mot mockad bridge-stdio (kompletterar befintliga filer).

Om upstream inte är målet, hoppa över Fas 3.

### Fas 4 — Säker AI-assistans (separat spår, det egentliga målet)

iom-java är medlet. Det här är vad som behöver finnas **utanför** själva extension:en:

1. **Minimum-privilegier i SAS:** dev-container-användarens SAS-konto bör inte ha skrivrätt mot produktionsbibliotek. Dokumentera i [DEVELOPMENT.md](../../DEVELOPMENT.md) eller `SECURITY.md`.
2. **Audit:** sätt `OPTIONS source notes;` + en `sasprogramfile`-autoexec så varje submit kan spåras tillbaka till en agent/session.
3. **Granskning av AI-genererad SAS-kod:** pre-tool-use hook i `.claude/settings.json` som flaggar farliga operationer (`proc datasets ... delete`, biblioteksallokeringar mot prod, `proc os` etc.).
4. **Connection-policy:** håll en read-only profil och en utvecklingsprofil separat — växla aktivt mellan dem snarare än att ge AI full skrivåtkomst som default.

Punkt 3 kan skissas när Fas 1 är verifierad — då vet vi vilka kodmönster som faktiskt dyker upp i praktiken.

---

## 3. Förslag på första steg

- Fas 0 (~30 min) + Fas 1 punkt 1 + 4 (build automation + end-to-end-test).
- Det validerar att grundpremissen håller innan tid läggs på Fas 2/3/4.
