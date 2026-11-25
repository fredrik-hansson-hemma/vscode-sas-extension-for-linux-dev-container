# iom-java — Plan

Mål: kunna köra SAS 9.4 via IOM från VS Code på Linux, utan Windows-klient. De befintliga anslutningstyperna `itc` och `com` kräver Windows (PowerShell respektive COM); `iom-java` pratar IOM direkt via SAS Integration Technologies Java-klient och fungerar överallt där Java finns. Det möjliggör i sin tur säkrare AI-assisterad SAS-utveckling på Linux.

## Nuläge

- Anslutningstypen `iom-java` är inkopplad: profiltyp, schemavalidering, lösenordsprompt via VS Code SecretStorage, `LibraryAdapterFactory`, lokaliseringssträngar.
- Reflection-baserad Java-bridge i [iom-java-bridge/](../../iom-java-bridge/) som kompileras utan SAS/CORBA på classpath och pratar JSON över stdio med Node-sidan. SAS-namn saneras mot code injection.
- Java 11+ stöds via automatisk detektering av GlassFish ORB i `sasJarPath` ([tools/fetch-orb.sh](../../tools/fetch-orb.sh)). SAS-JARs hämtas med [tools/copy-sas-jars.sh](../../tools/copy-sas-jars.sh).
- `send()` har 5 minuters timeout och avvisas om bridgen dör; anrop köas i sessionen.
- Förbyggd JAR (~2.2 MB) är incheckad och kopieras till `client/dist/node/` av [tools/build.mjs](../../tools/build.mjs), så tillägget kan byggas utan Maven.
- Dokumentation: [sas9iomjava.md](../../website/docs/Configurations/Profiles/sas9iomjava.md), matrix, accessLibraries, FAQ och [DEVELOPMENT.md](../../DEVELOPMENT.md).
- Körningar och biblioteksfrågor köas i sessionen och läser loggen tills en slutmarkör syns. Table viewer läser rader via ett DATA-steg som skriver en loggrad per cell (värden över ~200 tecken trunkeras).
- Ej stöd ännu (markerat ✗ i matrix): filter i table viewer, avbryt körning, ODS HTML5-resultat.

## 1. Verifiera mot riktig server (nästa steg)

1. [ ] **End-to-end:** profil i `settings.json`, kör `data _null_; put 'hello'; run;` och verifiera loggen. Kör `proc print data=sashelp.class;` och verifiera Libraries-trädet.
2. [ ] **Felfall:** fel lösenord, tom `sasJarPath`, ingen `java` på PATH, Java 11 utan GlassFish-JARs. Notera obegripliga felmeddelanden och förbättra dem.

## 2. Funktionalitet

1. [ ] `cancel` bridge-kommando kopplat till `ILanguageService.Cancel`.
2. [ ] Strukturerat `getRows` bridge-kommando (t.ex. JSON) så att långa värden inte trunkeras.
3. [ ] ODS HTML5-resultat tillbaka till VS Code.
4. [ ] Översätt `TableQuery`-filter till WHERE-klausul.

## 3. Robusthet

- `findMethod` matchar första metoden med givet namn — versionsrisk vid overloads.
- Singleton-session: byte av profil utan close kan ge inaktuell anslutning.
- Stderr från bridgen loggas oförändrat till `console.warn`.
- `maxNumberOfRowsToRead: 100` är hårdkodat i `IomJavaLibraryAdapter`.
- Bridgens metadatafrågor (`getLibraries`/`getTables`/`getColumns`) har en fast gräns på 60 s; mycket stora bibliotek på en långsam server kan behöva en längre eller konfigurerbar gräns.
- Avslutsmarkören i `submitAndCollectLog` dyker aldrig upp om användarens kod lämnar en öppen kommentar, sträng eller makro; då pollas loggen tills sessionen stängs.
- Testluckor: `getRowsAsCSV`, `getTableInfo`, felvägar (bridgen dör mitt i request, JAR saknas, fel `sasJarPath`). Bridge-projektet saknar tester.

## 4. Upstream-PR (valfritt)

1. Bygg JAR:en i `vscode:prepublish` i stället för att checka in den.
2. Täck felvägar med tester.

## 5. Säker AI-assistans (det egentliga målet)

1. **Minsta privilegier i SAS:** kontot som används från Linux-maskinen bör inte ha skrivrätt mot produktionsbibliotek.
2. **Spårbarhet:** `OPTIONS source notes;` och en autoexec så varje submit kan spåras till en agent/session.
3. **Granskning av AI-genererad SAS-kod:** pre-tool-use hook i `.claude/settings.json` som flaggar farliga operationer (`proc datasets ... delete`, biblioteksallokeringar mot prod, `x`-kommandon etc.).
4. **Anslutningspolicy:** separat read-only-profil och utvecklingsprofil; växla aktivt i stället för full skrivåtkomst som standard.
