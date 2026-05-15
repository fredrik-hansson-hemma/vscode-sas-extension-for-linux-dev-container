// Copyright © 2024, SAS Institute Inc., Cary, NC, USA.  All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
package com.sas.iomjavabridge;

import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.PrintStream;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.net.URL;
import java.net.URLClassLoader;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Newline-delimited JSON bridge between Node.js and SAS IOM via the
 * SAS Integration Technologies Java client JARs.
 *
 * All SAS and CORBA API calls go through reflection so this JAR compiles
 * with any JDK >= 8 without compile-time access to the SAS or CORBA JARs.
 * At runtime the user-supplied sasJarPath directory must contain the SAS
 * Integration Technologies JARs (sas.core.jar, sas.svc.connection.jar, etc.).
 * CORBA is available from the JDK on Java 8 and on Java 9/10 with
 * --add-modules java.corba; for Java 11+ include the GlassFish ORB JARs
 * in sasJarPath.
 */
public class IomJavaBridge {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    // Loaded lazily on "connect"
    private ClassLoader sasLoader;

    // Live CORBA / SAS objects held as plain Object
    private Object cfmFactory;      // ConnectionFactoryInterface
    private Object connection;      // ConnectionInterface
    private Object workspace;       // IWorkspace (CORBA)
    private Object languageService; // ILanguageService (CORBA)

    public static void main(String[] args) throws Exception {
        new IomJavaBridge().run();
    }

    // -------------------------------------------------------------------------
    // Main loop
    // -------------------------------------------------------------------------

    private void run() throws Exception {
        // Replies go to the real stdout; anything the SAS or ORB libraries
        // print with System.out is sent to stderr so it cannot be mistaken
        // for a reply.
        PrintStream out = new PrintStream(
                new FileOutputStream(FileDescriptor.out), true, "UTF-8");
        System.setOut(System.err);
        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, "UTF-8"));
        String line;
        while ((line = in.readLine()) != null) {
            line = line.trim();
            if (line.isEmpty()) {
                continue;
            }
            out.println(dispatch(line));
        }
    }

    // -------------------------------------------------------------------------
    // Dispatch
    // -------------------------------------------------------------------------

    @SuppressWarnings("unchecked")
    private String dispatch(String json) {
        try {
            Map<String, Object> cmd = MAPPER.readValue(json, Map.class);
            String name = (String) cmd.get("cmd");
            Map<String, Object> reply = new LinkedHashMap<>();

            switch (name == null ? "" : name) {
                case "connect":
                    doConnect(cmd);
                    reply.put("status", "ok");
                    break;
                case "submit":
                    doSubmit((String) cmd.get("code"));
                    reply.put("status", "ok");
                    break;
                case "flushLog":
                    reply.put("status", "ok");
                    reply.put("data", doFlushLog());
                    break;
                case "flushList":
                    reply.put("status", "ok");
                    reply.put("data", doFlushList());
                    break;
                case "getLibraries":
                    reply.put("status", "ok");
                    reply.put("data", doGetLibraries());
                    break;
                case "getTables":
                    reply.put("status", "ok");
                    reply.put("data", doGetTables((String) cmd.get("libref")));
                    break;
                case "getColumns":
                    reply.put("status", "ok");
                    reply.put("data", doGetColumns(
                            (String) cmd.get("libref"),
                            (String) cmd.get("table")));
                    break;
                case "disconnect":
                    doDisconnect();
                    reply.put("status", "ok");
                    break;
                default:
                    reply.put("status", "error");
                    reply.put("message", "Unknown command: " + name);
            }
            return MAPPER.writeValueAsString(reply);
        } catch (Exception e) {
            return errorJson(e);
        }
    }

    // -------------------------------------------------------------------------
    // connect
    // -------------------------------------------------------------------------

    private void doConnect(Map<String, Object> cmd) throws Exception {
        String host = (String) cmd.get("host");
        int port = ((Number) cmd.get("port")).intValue();
        String username = (String) cmd.get("username");
        String password = (String) cmd.get("password");
        String sasJarPath = (String) cmd.get("sasJarPath");

        sasLoader = buildClassLoader(sasJarPath);

        // Optionally configure a standalone ORB so the bridge works on Java 11+
        // when GlassFish ORB JARs are present in sasJarPath.
        configureOrb();

        // --- ConnectionFactoryManager ---
        Class<?> cfmClass = sasLoader.loadClass(
                "com.sas.services.connection.ConnectionFactoryManager");
        Object cfm = cfmClass.getDeclaredConstructor().newInstance();

        // --- BridgeServer(host, port) ---
        Class<?> bridgeServerClass = sasLoader.loadClass(
                "com.sas.services.connection.BridgeServer");
        Object server;
        try {
            server = bridgeServerClass
                    .getConstructor(String.class, int.class)
                    .newInstance(host, port);
        } catch (NoSuchMethodException e) {
            // Some versions expose BridgeServer(String uri)
            String uri = "iom://" + host + ":" + port + "?service=sasomi";
            server = bridgeServerClass.getConstructor(String.class).newInstance(uri);
        }

        // --- ManualConnectionFactoryConfiguration(BridgeServer) ---
        Class<?> configClass = sasLoader.loadClass(
                "com.sas.services.connection.ManualConnectionFactoryConfiguration");
        Class<?> serverClass = sasLoader.loadClass("com.sas.services.connection.Server");
        Object config = configClass.getConstructor(serverClass).newInstance(server);

        // --- cfm.getFactory(config) ---
        Method getFactory = findMethod(cfmClass, "getFactory");
        cfmFactory = getFactory.invoke(cfm, config);

        // --- PasswordCredentials(username, password) ---
        Class<?> credsClass = sasLoader.loadClass(
                "com.sas.security.util.PasswordCredentials");
        Object creds;
        try {
            creds = credsClass.getConstructor(String.class, char[].class)
                    .newInstance(username, password.toCharArray());
        } catch (NoSuchMethodException e) {
            creds = credsClass.getConstructor(String.class, String.class)
                    .newInstance(username, password);
        }

        // --- factory.getConnection(creds) ---
        Method getConnection = findMethod(cfmFactory.getClass(), "getConnection");
        connection = getConnection.invoke(cfmFactory, creds);

        // --- connection.getObject() → narrow to IWorkspace ---
        Method getObject = findMethod(connection.getClass(), "getObject");
        Object corbaObj = getObject.invoke(connection);

        Class<?> helperClass = sasLoader.loadClass(
                "com.sas.iom.workspace.IWorkspaceHelper");
        Class<?> corbaObjIface = sasLoader.loadClass("org.omg.CORBA.Object");
        workspace = helperClass.getMethod("narrow", corbaObjIface).invoke(null, corbaObj);

        // --- workspace.LanguageService() ---
        Method lsMethod = findMethod(workspace.getClass(), "LanguageService");
        languageService = lsMethod.invoke(workspace);
    }

    // -------------------------------------------------------------------------
    // submit / flushLog / flushList
    // -------------------------------------------------------------------------

    private void requireConnected() {
        if (languageService == null) {
            throw new IllegalStateException("Not connected to SAS. Send 'connect' first.");
        }
    }

    private void doSubmit(String code) throws Exception {
        requireConnected();
        Method submit = findMethod(languageService.getClass(), "Submit");
        submit.invoke(languageService, code);
    }

    private String doFlushLog() throws Exception {
        return flushHolder("FlushLog");
    }

    private String doFlushList() throws Exception {
        return flushHolder("FlushList");
    }

    private String flushHolder(String methodName) throws Exception {
        requireConnected();
        Class<?> holderClass = loadCorbaClass("org.omg.CORBA.StringHolder");
        Object holder = holderClass.getDeclaredConstructor().newInstance();
        Method m = findMethod(languageService.getClass(), methodName);
        m.invoke(languageService, holder);
        Field valueField = holderClass.getField("value");
        String result = (String) valueField.get(holder);
        return result == null ? "" : result;
    }

    // -------------------------------------------------------------------------
    // Library / table / column browsing via submitted SAS code
    // -------------------------------------------------------------------------

    private static final String TAG_LIB = "IOMBRIDGE_LIB:";
    private static final String TAG_TBL = "IOMBRIDGE_TBL:";
    private static final String TAG_COL = "IOMBRIDGE_COL:";
    private static final String TAG_DONE = "IOMBRIDGE_DONE";
    // Written as %str(IOMBRIDGE)_DONE so the echoed source line in the log
    // does not contain TAG_DONE; only the line printed by %put does.
    private static final String DONE_STATEMENT = "%put %str(IOMBRIDGE)_DONE;\n";
    private static final Pattern DONE_LINE =
            Pattern.compile("^" + TAG_DONE + "\\s*$", Pattern.MULTILINE);
    private static final long METADATA_TIMEOUT_MS = 60_000;

    private List<Map<String, Object>> doGetLibraries() throws Exception {
        String code =
                "data _null_;\n" +
                "  set sashelp.vlibnam;\n" +
                "  put \"" + TAG_LIB + "\" libname \" \" readonly;\n" +
                "run;\n" +
                DONE_STATEMENT;
        doSubmit(code);
        String log = collectUntilDone();

        // sashelp.vlibnam has one row per physical path, so concatenated
        // libraries such as SASHELP appear more than once.
        List<Map<String, Object>> libs = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        for (String raw : log.split("\n")) {
            String line = raw.trim();
            if (!line.startsWith(TAG_LIB)) {
                continue;
            }
            String[] parts = line.substring(TAG_LIB.length()).trim().split("\\s+", 2);
            if (parts.length < 1 || parts[0].isEmpty()) {
                continue;
            }
            Map<String, Object> lib = new LinkedHashMap<>();
            String libName = parts[0].trim();
            if (!seen.add(libName)) {
                continue;
            }
            String readOnly = parts.length > 1 ? parts[1].trim() : "no";
            lib.put("id", libName);
            lib.put("name", libName);
            lib.put("readOnly", "yes".equalsIgnoreCase(readOnly));
            libs.add(lib);
        }
        return libs;
    }

    private List<String> doGetTables(String libref) throws Exception {
        String code =
                "data _null_;\n" +
                "  set sashelp.vmember(where=(libname='" + safe(libref) + "'" +
                " and memtype='DATA'));\n" +
                "  put \"" + TAG_TBL + "\" memname;\n" +
                "run;\n" +
                DONE_STATEMENT;
        doSubmit(code);
        String log = collectUntilDone();

        List<String> tables = new ArrayList<>();
        for (String raw : log.split("\n")) {
            String line = raw.trim();
            if (line.startsWith(TAG_TBL)) {
                String tbl = line.substring(TAG_TBL.length()).trim();
                if (!tbl.isEmpty()) {
                    tables.add(tbl);
                }
            }
        }
        return tables;
    }

    private List<Map<String, Object>> doGetColumns(String libref, String table) throws Exception {
        String code =
                "data _null_;\n" +
                "  set sashelp.vcolumn(where=(libname='" + safe(libref) + "'" +
                " and memname='" + safe(table) + "'));\n" +
                "  put \"" + TAG_COL + "\" name \"|\" type \"|\" length \"|\" format \"|\" informat \"|\" label;\n" +
                "run;\n" +
                DONE_STATEMENT;
        doSubmit(code);
        String log = collectUntilDone();

        List<Map<String, Object>> cols = new ArrayList<>();
        int index = 0;
        for (String raw : log.split("\n")) {
            String line = raw.trim();
            if (!line.startsWith(TAG_COL)) {
                continue;
            }
            String payload = line.substring(TAG_COL.length()).trim();
            // payload: name|type|length|format|informat|label (the label is
            // last and may itself contain '|')
            String[] parts = payload.split("\\|", 6);
            if (parts.length < 6) {
                continue;
            }
            Map<String, Object> col = new LinkedHashMap<>();
            col.put("index", index++);
            col.put("name", parts[0].trim());
            col.put("type", parts[1].trim());
            col.put("length", parseIntSafe(parts[2].trim()));
            col.put("format", parts[3].trim());
            col.put("informat", parts[4].trim());
            col.put("label", parts[5].trim());
            cols.add(col);
        }
        return cols;
    }

    /**
     * Flush the log until the line printed by DONE_STATEMENT appears. Fails
     * instead of returning a partial result when SAS does not finish in time,
     * so callers never show an incomplete list as if it were complete.
     */
    private String collectUntilDone() throws Exception {
        StringBuilder sb = new StringBuilder();
        long deadline = System.currentTimeMillis() + METADATA_TIMEOUT_MS;
        while (true) {
            sb.append(doFlushLog());
            if (DONE_LINE.matcher(sb).find()) {
                return sb.toString();
            }
            if (System.currentTimeMillis() >= deadline) {
                throw new IllegalStateException(
                        "SAS did not finish within " + (METADATA_TIMEOUT_MS / 1000)
                                + " seconds; the result would be incomplete.");
            }
            Thread.sleep(200);
        }
    }

    // -------------------------------------------------------------------------
    // disconnect
    // -------------------------------------------------------------------------

    private void doDisconnect() throws Exception {
        if (connection != null) {
            try {
                Method close = findMethod(connection.getClass(), "close");
                close.invoke(connection);
            } catch (Exception ignored) {
                // Best-effort cleanup
            }
        }
        connection = null;
        workspace = null;
        languageService = null;
        cfmFactory = null;
    }

    // -------------------------------------------------------------------------
    // Helpers
    // -------------------------------------------------------------------------

    private ClassLoader buildClassLoader(String sasJarPath) throws Exception {
        File dir = new File(sasJarPath);
        if (!dir.isDirectory()) {
            throw new RuntimeException("sasJarPath is not a directory: " + sasJarPath);
        }
        File[] jars = dir.listFiles((f, n) -> n.endsWith(".jar"));
        if (jars == null || jars.length == 0) {
            throw new RuntimeException("No JAR files found in: " + sasJarPath);
        }
        Arrays.sort(jars);
        URL[] urls = new URL[jars.length];
        for (int i = 0; i < jars.length; i++) {
            urls[i] = jars[i].toURI().toURL();
        }
        // Parent = this class's loader so Jackson (in the fat JAR) is accessible
        return new URLClassLoader(urls, IomJavaBridge.class.getClassLoader());
    }

    /**
     * If a standalone ORB implementation (e.g. GlassFish) is present in the
     * sasJarPath, configure it before the first ORB.init() call.
     */
    private void configureOrb() {
        if (sasLoader == null) {
            return;
        }
        try {
            sasLoader.loadClass("com.sun.corba.ee.impl.orb.ORBImpl");
            System.setProperty("org.omg.CORBA.ORBClass",
                    "com.sun.corba.ee.impl.orb.ORBImpl");
            System.setProperty("org.omg.CORBA.ORBSingletonClass",
                    "com.sun.corba.ee.impl.orb.ORBSingleton");
        } catch (ClassNotFoundException ignored) {
            // Built-in JDK CORBA (Java 8/9/10) will be used
        }
    }

    /** Load a CORBA class, trying the sasLoader first (GlassFish), then system. */
    private Class<?> loadCorbaClass(String name) throws ClassNotFoundException {
        if (sasLoader != null) {
            try {
                return sasLoader.loadClass(name);
            } catch (ClassNotFoundException ignored) {
                // fall through to system loader
            }
        }
        return Class.forName(name);
    }

    /** Find the first public method with a given simple name (no overload ambiguity needed). */
    private static Method findMethod(Class<?> cls, String name) throws NoSuchMethodException {
        // Walk the class hierarchy including interfaces
        Class<?> c = cls;
        while (c != null) {
            for (Method m : c.getMethods()) {
                if (m.getName().equals(name)) {
                    return m;
                }
            }
            c = c.getSuperclass();
        }
        throw new NoSuchMethodException(cls.getName() + "." + name);
    }

    /** Sanitise a SAS name to prevent SAS code injection. */
    private static String safe(String s) {
        if (s == null) {
            return "";
        }
        return s.replaceAll("[^A-Za-z0-9_]", "").toUpperCase();
    }

    private static int parseIntSafe(String s) {
        try {
            return Integer.parseInt(s.trim());
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    private static String errorJson(Exception e) {
        String msg = e.getMessage();
        if (msg == null) {
            msg = e.getClass().getName();
        }
        // Escape JSON manually to avoid any dependency on MAPPER being healthy
        msg = msg.replace("\\", "\\\\").replace("\"", "\\\"")
                .replace("\n", "\\n").replace("\r", "\\r");
        return "{\"status\":\"error\",\"message\":\"" + msg + "\"}";
    }
}
