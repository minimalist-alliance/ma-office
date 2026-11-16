package com.minimalistalliance.desk.deskd.agent;

import com.minimalistalliance.desk.deskd.files.AgentFiles;
import com.minimalistalliance.desk.deskd.files.AgentFilesRig;
import com.minimalistalliance.desk.deskd.notebook.NotebookCalls;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.rpc.Caller;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import com.minimalistalliance.desk.deskd.tools.FilesTools;
import com.minimalistalliance.desk.deskd.tools.HostedCall;
import com.minimalistalliance.desk.deskd.tools.HostedDecls;
import com.minimalistalliance.desk.deskd.tools.HostedTool;
import com.minimalistalliance.desk.deskd.tools.NotebookTools;
import com.minimalistalliance.desk.deskd.tools.RunLedger;
import com.minimalistalliance.desk.deskd.tools.ToolFailure;
import com.minimalistalliance.desk.deskd.tools.ToolHost;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.stream.Stream;

/**
 * W7's local rig (Maia Mode Phase 0; {@code tools/agent-harness/README.md}): a real deskd's relay, tickets,
 * {@code ToolHost} and access record, deskd's real Files tools on a real tree, deskd's real Notebook tools over the real
 * desk-notebook (Node), and the real desk-agent jar as a child process whose Anthropic URL is the stand-in model's (or a
 * real one's). Every tool deskd runs goes through a counting wrapper, so the capability and soak runners can prove 0
 * double executions. HTTP on 127.0.0.1 only, one request at a time; the endpoints are the harness contract's.
 *
 * <p>Started by {@code tools/agent-harness/rig.sh}, never by a build: it's a test-scope program with a {@code main}.
 * The rig's deskd clock is a fixed test clock, so a yes never passes its 10 minutes here; desk-agent's is real.
 */
public final class HarnessRig implements AutoCloseable {

    private static final String KEY = "sk-ant-api03-stand-in-key-0001";

    private final Path dir;
    private final String modelUrl;
    private final String model;
    private final String key;
    private final Path deskAgentJar;
    private final List<String> notebookCmd;
    private final List<Map<String, Object>> executions = new CopyOnWriteArrayList<>();
    /** The run's secret path segment: 128 random bits. */
    private final String token = HexFormat.of().formatHex(randomBytes(16));
    private final AtomicLong seq = new AtomicLong();
    private final StringBuilder deskAgentLog = new StringBuilder();

    private AgentRig rig;
    private AgentFilesRig files;
    private ToolHost host;
    private TestClient owner;
    private Process deskAgent;
    private Process notebook;
    private NotebookCalls notebookCalls;
    private String keyId;
    private int notebookGeneration;
    private final Map<String, Map<String, Object>> accessOf = new LinkedHashMap<>();
    private HttpServer http;

    HarnessRig(Path dir, String modelUrl, String model, String key, Path deskAgentJar, List<String> notebookCmd) {
        this.dir = dir;
        this.modelUrl = modelUrl;
        this.model = model;
        this.key = key;
        this.deskAgentJar = deskAgentJar;
        this.notebookCmd = notebookCmd;
    }

    public static void main(String[] argv) throws Exception {
        Map<String, String> a = new LinkedHashMap<>();
        for (int i = 0; i + 1 < argv.length; i += 2) {
            a.put(argv[i].replaceFirst("^--", ""), argv[i + 1]);
        }
        Path dir = Path.of(a.getOrDefault("dir", Files.createTempDirectory("mm-harness-rig").toString()));
        List<String> nb = a.containsKey("notebook-main") ? List.of(a.getOrDefault("node", "node"), a.get("notebook-main"))
                : List.of();
        // The key comes from a file, never the command line, where other processes could read it.
        String key = a.containsKey("key-file") ? Files.readString(Path.of(a.get("key-file"))).strip() : KEY;
        HarnessRig rig = new HarnessRig(dir, a.get("model-url"), a.getOrDefault("model", "claude-sonnet-5-5"),
                key, Path.of(a.get("desk-agent-jar")), nb);
        Runtime.getRuntime().addShutdownHook(new Thread(rig::close));
        rig.start(Integer.parseInt(a.getOrDefault("port", "0")));
        // The base URL carries the run's token as its first path segment: the rig answers nothing else (Security's
        // MMH-I1), so another local user or a page in a browser on the box can't drive it or spend its key.
        System.out.println("RIG http://127.0.0.1:" + rig.http.getAddress().getPort() + "/" + rig.token);
        System.out.flush();
        Thread.currentThread().join();
    }

    // ---------------------------------------------------------------- start and stop

    void start(int port) throws Exception {
        Files.createDirectories(dir);
        files = new AgentFilesRig(dir.resolve("files"));
        startNotebook(false);
        startDeskd();
        startDeskAgent();
        Map<String, Object> added = call("agent.key.add", m("provider", "anthropic", "label", "Harness", "secret", key));
        keyId = (String) ((Map<String, Object>) added.get("key")).get("keyId");
        http = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), port), 16);
        http.createContext("/", this::serve);
        http.setExecutor(Executors.newSingleThreadExecutor());
        http.start();
    }

    private void startDeskd() throws Exception {
        rig = new AgentRig(dir, false);
        host = new ToolHost(rig.clock, agentId -> Caller.THE_OWNER, () -> false, () -> true);
        host.tickets((approvalId, sha256, agentId, runId, tool, context, args) -> {
            var redeemed = rig.module.approvalTickets().redeem(approvalId, sha256, agentId, runId, tool, context, args);
            return redeemed.ok() ? null : redeemed.refusal().code();
        });
        host.area(HostedDecls.FILES, counted(new FilesTools(files.files().agentAccess())));
        if (notebookCalls != null) {
            host.area(HostedDecls.NOTEBOOK, counted(new NotebookTools(notebookCalls, () -> false)));
        }
        rig.module.hostTools(host);
    }

    private void startDeskAgent() throws Exception {
        Files.createDirectories(dir.resolve("agent-data"));
        int uid = (Integer) Files.getAttribute(Path.of("/proc/self"), "unix:uid");
        List<String> command = new ArrayList<>(List.of(
                Path.of(System.getProperty("java.home"), "bin", "java").toString(), "-Xmx384m",
                "-jar", deskAgentJar.toString(),
                "--desk.agent.socket=" + dir.resolve("agent.sock"),
                "--desk.agent.admin.socket=" + dir.resolve("agent-admin.sock"),
                "--desk.agent.data.dir=" + dir.resolve("agent-data"),
                "--desk.agent.peer.uid=" + uid,
                "--desk.agent.anthropic.url=" + modelUrl));
        deskAgent = new ProcessBuilder(command).redirectErrorStream(true).start();
        Thread.ofVirtual().start(() -> {
            try (var in = deskAgent.getInputStream()) {
                byte[] buf = new byte[8192];
                int n;
                while ((n = in.read(buf)) > 0) {
                    synchronized (deskAgentLog) {
                        deskAgentLog.append(new String(buf, 0, n, StandardCharsets.UTF_8));
                    }
                }
            } catch (IOException e) {
                // the process went
            }
        });
        long until = System.nanoTime() + Duration.ofSeconds(90).toNanos();
        while (!rig.module.link().isConnected()) {
            if (!deskAgent.isAlive() || System.nanoTime() > until) {
                throw new IllegalStateException("desk-agent didn't start");
            }
            Thread.sleep(100);
        }
        owner = rig.connect("rig-" + System.nanoTime());
    }

    private void startNotebook(boolean fresh) throws Exception {
        if (notebookCmd.isEmpty()) {
            return;
        }
        if (fresh) {
            notebookGeneration++;
        }
        Path data = Files.createDirectories(dir.resolve("notebook-" + notebookGeneration));
        Path socket = dir.resolve("nb.sock");
        Files.deleteIfExists(socket);
        ProcessBuilder pb = new ProcessBuilder(notebookCmd).redirectErrorStream(true)
                .redirectOutput(dir.resolve("notebook.log").toFile());
        pb.environment().put("DESK_NOTEBOOK_SOCKET", socket.toString());
        pb.environment().put("DESK_NOTEBOOK_DATA_DIR", data.toString());
        notebook = pb.start();
        long until = System.nanoTime() + Duration.ofSeconds(30).toNanos();
        while (!Files.exists(socket)) {
            if (!notebook.isAlive() || System.nanoTime() > until) {
                throw new IllegalStateException("desk-notebook didn't start");
            }
            Thread.sleep(50);
        }
        if (notebookCalls == null) {
            notebookCalls = new NotebookCalls(socket, () -> null, Duration.ofSeconds(10));
        }
    }

    private void stopNotebook() throws InterruptedException {
        if (notebook != null) {
            notebook.destroy();
            notebook.waitFor(10, TimeUnit.SECONDS);
            notebook.destroyForcibly();
        }
    }

    @Override
    public void close() {
        try {
            if (http != null) {
                http.stop(0);
            }
            if (deskAgent != null) {
                deskAgent.destroyForcibly();
            }
            stopNotebook();
            if (rig != null) {
                rig.close();
            }
            if (files != null) {
                files.close();
            }
        } catch (Exception e) {
            // best effort on the way out
        }
    }

    // ---------------------------------------------------------------- counting what deskd runs

    private HostedTool counted(HostedTool inner) {
        return new HostedTool() {
            @Override
            public Look look(HostedCall call, RunLedger.Run run) throws ToolFailure, InterruptedException {
                return inner.look(call, run);
            }

            @Override
            public Result run(HostedCall call, RunLedger.Run run) throws ToolFailure, InterruptedException {
                Map<String, Object> e = new LinkedHashMap<>();
                e.put("seq", seq.incrementAndGet());
                e.put("tool", call.tool());
                e.put("agentId", call.agentId());
                e.put("runId", call.runId());
                e.put("approvalId", call.approval() == null ? null : call.approval().approvalId());
                e.put("auto", call.autoApprovalId() == null ? null : "auto");
                e.put("autoApprovalId", call.autoApprovalId());
                e.put("key", ToolHost.hash(call.agentId(), call.runId(), call.tool(),
                        call.context() == null ? "agent" : call.context(), call.args()));
                e.put("at", System.currentTimeMillis());
                try {
                    Result r = inner.run(call, run);
                    e.put("ok", true);
                    e.put("code", null);
                    return r;
                } catch (ToolFailure f) {
                    e.put("ok", false);
                    e.put("code", f.reason());
                    throw f;
                } finally {
                    if (!"read".equalsIgnoreCase(HostedDecls.get(call.tool()).floor().name())
                            || !Boolean.FALSE.equals(e.get("ok"))) {
                        executions.add(e);
                    }
                }
            }

            @Override
            public void runEnded(String runId) {
                inner.runEnded(runId);
            }

            @Override
            public boolean available() {
                return inner.available();
            }

            @Override
            public boolean offers(String tool) {
                return inner.offers(tool);
            }
        };
    }

    // ---------------------------------------------------------------- the owner's calls through deskd's relay

    @SuppressWarnings("unchecked")
    private Map<String, Object> call(String method, Map<String, Object> params) throws Exception {
        Map<String, Object> reply = rig.call(owner, method, params);
        if (!"RES".equals(reply.get("_kind"))) {
            Map<String, Object> details = reply.get("details") instanceof Map<?, ?> d ? (Map<String, Object>) d : Map.of();
            throw new RigError(String.valueOf(reply.get("code")), String.valueOf(details.get("reason")));
        }
        Map<String, Object> out = new LinkedHashMap<>(reply);
        out.remove("_kind");
        out.remove("_id");
        return out;
    }

    static final class RigError extends Exception {
        private static final long serialVersionUID = 1L;
        final String code;
        final String reason;

        RigError(String code, String reason) {
            super(code + " " + reason);
            this.code = code;
            this.reason = reason;
        }
    }

    // ---------------------------------------------------------------- HTTP

    private static byte[] randomBytes(int n) {
        byte[] b = new byte[n];
        new java.security.SecureRandom().nextBytes(b);
        return b;
    }

    /** The path after the run's token, or null when the request doesn't carry it. */
    private String underToken(String path) {
        String prefix = "/" + token;
        if (path == null || path.length() < prefix.length() || !MessageDigest.isEqual(
                path.substring(0, prefix.length()).getBytes(StandardCharsets.UTF_8),
                prefix.getBytes(StandardCharsets.UTF_8))) {
            return null;
        }
        String rest = path.substring(prefix.length());
        return rest.startsWith("/") ? rest : null;
    }

    private void serve(HttpExchange ex) throws IOException {
        Map<String, Object> out;
        int status = 200;
        try {
            String path = underToken(ex.getRequestURI().getPath());
            if (path == null) {
                ex.sendResponseHeaders(404, -1);
                ex.close();
                return;
            }
            Map<String, Object> body = ex.getRequestBody().available() >= 0
                    ? parse(ex.getRequestBody().readAllBytes()) : Map.of();
            out = switch (ex.getRequestMethod() + " " + path) {
                case "GET /health" -> health();
                case "POST /reset" -> reset(body);
                case "POST /agent" -> newAgent((String) body.get("name"));
                case "POST /access" -> access(body);
                case "POST /call" -> ok("result", call((String) body.get("method"), params(body.get("params"))));
                case "POST /decide" -> decide(body);
                case "GET /files" -> files();
                case "GET /notebook" -> notebookPages();
                case "GET /executions" -> ok("executions", List.copyOf(executions));
                case "POST /fault" -> fault((String) body.get("kind"));
                case "GET /audit-verify" -> auditVerify();
                case "GET /logs" -> {
                    synchronized (deskAgentLog) {
                        yield ok("deskAgent", deskAgentLog.toString());
                    }
                }
                case "POST /stop" -> {
                    Thread.ofVirtual().start(() -> {
                        close();
                        System.exit(0);
                    });
                    yield ok();
                }
                default -> {
                    status = 404;
                    yield err("not_found", path);
                }
            };
        } catch (RigError e) {
            out = err(e.code, e.reason);
        } catch (Exception e) {
            status = 500;
            out = err("internal", e.getClass().getSimpleName());
        }
        byte[] bytes = Json.bytes(out);
        ex.getResponseHeaders().add("content-type", "application/json");
        ex.sendResponseHeaders(status, bytes.length);
        try (OutputStream os = ex.getResponseBody()) {
            os.write(bytes);
        }
    }

    private static Map<String, Object> parse(byte[] bytes) throws Exception {
        return bytes.length == 0 ? Map.of() : Json.parseObject(bytes);
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> params(Object p) {
        return p instanceof Map<?, ?> m ? (Map<String, Object>) m : Map.of();
    }

    private static Map<String, Object> m(Object... kv) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) {
            m.put((String) kv[i], kv[i + 1]);
        }
        return m;
    }

    private static Map<String, Object> ok(Object... kv) {
        Map<String, Object> out = m(kv);
        out.put("ok", true);
        return out;
    }

    private static Map<String, Object> err(String code, String reason) {
        return m("ok", false, "code", code, "reason", reason);
    }

    // ---------------------------------------------------------------- endpoints

    private Map<String, Object> health() {
        return ok("deskAgent", deskAgent != null && deskAgent.isAlive() && rig.module.link().isConnected(),
                "notebook", notebook != null && notebook.isAlive(), "model",
                modelUrl.startsWith("http://127.0.0.1") ? "stand-in" : "real", "modelUrl", modelUrl);
    }

    private Map<String, Object> newAgent(String name) throws Exception {
        // A desk holds a few agents (agent_cap): the last task's goes first. A run can't outlive its task, as the
        // runners wait for each to end.
        for (String old : List.copyOf(accessOf.keySet())) {
            try {
                call("agent.delete", m("agentId", old));
            } catch (RigError e) {
                // gone already
            }
            accessOf.remove(old);
        }
        Map<String, Object> made = call("agent.create", m("name", name, "keyId", keyId, "model", model));
        String agentId = (String) ((Map<String, Object>) made.get("agent")).get("id");
        Map<String, Object> access = m("agentId", agentId, "apps", m("notebook", true, "files", true, "browser", true,
                "courier", false, "todos", true), "auto", m("notebook", null, "files", null, "todos", false));
        call("agent.access.set", access);
        accessOf.put(agentId, access);
        return ok("agentId", agentId);
    }

    private Map<String, Object> access(Map<String, Object> body) throws Exception {
        Map<String, Object> saved = call("agent.access.set", body);
        accessOf.put((String) body.get("agentId"), body);
        return ok("access", saved.get("access"));
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> decide(Map<String, Object> body) throws Exception {
        Map<String, Object> card = (Map<String, Object>) call("agent.approval.get", m("approvalId",
                body.get("approvalId"))).get("approval");
        String sha = ToolHost.hash((String) card.get("agentId"), (String) card.get("runId"), (String) card.get("tool"),
                (String) card.get("context"), (Map<String, Object>) card.get("payload"));
        Map<String, Object> p = m("approvalId", body.get("approvalId"), "approve", body.get("approve"), "sha256", sha);
        if (body.get("note") != null) {
            p.put("note", body.get("note"));
        }
        Map<String, Object> r = call("agent.approval.decide", p);
        Object state = r.get("approval") instanceof Map<?, ?> a ? a.get("state") : null;
        return ok("state", state);
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> reset(Map<String, Object> body) throws Exception {
        executions.clear();
        // ---- Files: Harness/ to the trash, then the world, through deskd's own Files (so its search sees it)
        AgentFiles fa = files.files().agentAccess();
        if (Files.exists(files.root().resolve("Harness"))) {
            fa.trash("Harness");
        }
        fa.mkdir("Harness");
        Map<String, Object> world = params(body.get("files"));
        for (String path : new TreeMap<>(world).keySet()) {
            String clean = path.endsWith("/") ? path.substring(0, path.length() - 1) : path;
            String[] parts = clean.split("/");
            StringBuilder at = new StringBuilder();
            for (int i = 0; i < parts.length - 1; i++) {
                at.append(i == 0 ? "" : "/").append(parts[i]);
                if (!Files.isDirectory(files.root().resolve(at.toString()))) {
                    fa.mkdir(at.toString());
                }
            }
            Object v = world.get(path);
            if (path.endsWith("/") || v == null) {
                if (!Files.isDirectory(files.root().resolve(clean))) {
                    fa.mkdir(clean);
                }
            } else {
                fa.write(clean, String.valueOf(v).getBytes(StandardCharsets.UTF_8), false, null);
            }
        }
        // ---- Notebook: a fresh service, then the tabs and pages
        Map<String, String> tabs = new LinkedHashMap<>();
        List<Map<String, Object>> pages = new ArrayList<>();
        if (!notebookCmd.isEmpty()) {
            stopNotebook();
            startNotebook(true);
            Map<String, Object> nb = (Map<String, Object>) nb("notebook.notebook.create", m("title", "Notebook"));
            String notebookId = (String) ((Map<String, Object>) nb.get("notebook")).get("id");
            List<Map<String, Object>> want = body.get("notebook") instanceof List<?> l
                    ? (List<Map<String, Object>>) l : List.of();
            List<String> names = new ArrayList<>();
            names.add("Harness");
            for (Map<String, Object> p : want) {
                if (!names.contains((String) p.get("tab"))) {
                    names.add((String) p.get("tab"));
                }
            }
            for (String name : names) {
                Map<String, Object> tab = (Map<String, Object>) nb("notebook.tab.create", m("notebookId", notebookId, "title", name));
                Map<String, Object> t = tab.get("tab") instanceof Map<?, ?> inner ? (Map<String, Object>) inner : tab;
                tabs.put(name, (String) t.get("id"));
            }
            for (Map<String, Object> p : want) {
                // A page is made with its title as its heading: a world's Markdown that starts with the same heading
                // gives it once.
                String md = String.valueOf(p.get("markdown"));
                String heading = "# " + p.get("title") + "\n";
                if (md.startsWith(heading)) {
                    md = md.substring(heading.length()).replaceFirst("^\n", "");
                }
                Map<String, Object> made = (Map<String, Object>) notebookCalls.call(Caller.THE_OWNER,
                        "notebook.page.agentEdit", m("new", m("tabId", tabs.get((String) p.get("tab")), "title",
                                p.get("title")), "op", "create", "markdown", md, "agentName",
                                "Harness setup", "untrusted", false), true);
                pages.add(m("pageId", made.get("pageId"), "tab", p.get("tab"), "title", p.get("title")));
            }
        }
        return ok("tabs", tabs, "pages", pages);
    }

    private Map<String, Object> files() throws IOException {
        Map<String, Object> out = new TreeMap<>();
        Path root = files.root();
        Path harness = root.resolve("Harness");
        if (Files.isDirectory(harness)) {
            try (Stream<Path> s = Files.walk(harness)) {
                for (Path p : s.sorted().toList()) {
                    String rel = root.relativize(p).toString();
                    if (p.getFileName().toString().startsWith(".agent-")) {
                        continue;
                    }
                    out.put(Files.isDirectory(p) ? rel + "/" : rel, Files.isDirectory(p) ? null
                            : Files.readString(p, StandardCharsets.UTF_8));
                }
            }
        }
        List<String> trash = new ArrayList<>();
        Path t = root.resolve(".trash");
        if (Files.isDirectory(t)) {
            // Files' trash: .trash/<id>/item, and meta.json with the item's name and where it was.
            try (Stream<Path> s = Files.list(t)) {
                for (Path entry : s.sorted().toList()) {
                    Path meta = entry.resolve("meta.json");
                    if (Files.isRegularFile(meta)) {
                        Object name = Json.parseObject(Files.readAllBytes(meta)).get("name");
                        if (name instanceof String n) {
                            trash.add(n);
                        }
                    }
                }
            } catch (com.minimalistalliance.desk.deskd.protocol.JsonFormatException e) {
                throw new IOException("a trash entry's meta.json isn't JSON", e);
            }
        }
        return ok("files", out, "trash", trash);
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> notebookPages() throws Exception {
        List<Map<String, Object>> out = new ArrayList<>();
        if (notebookCalls == null || notebook == null || !notebook.isAlive()) {
            return ok("pages", out);
        }
        Map<String, String> tabTitles = new LinkedHashMap<>();
        List<Map<String, Object>> pages = new ArrayList<>();
        String cursor = null;
        do {
            Map<String, Object> tree = (Map<String, Object>) nb("notebook.tree", cursor == null ? m() : m("cursor", cursor));
            for (Map<String, Object> t : (List<Map<String, Object>>) tree.get("tabs")) {
                tabTitles.put((String) t.get("id"), (String) t.get("title"));
            }
            pages.addAll((List<Map<String, Object>>) tree.get("pages"));
            cursor = tree.get("next") instanceof String n ? n : null;
        } while (cursor != null);
        for (Map<String, Object> page : pages) {
            Map<String, Object> md = (Map<String, Object>) notebookCalls.call(Caller.THE_OWNER, "notebook.page.markdown",
                    m("pageId", page.get("id")), false);
            out.add(m("pageId", page.get("id"), "tab", tabTitles.get((String) page.get("tabId")), "title",
                    md.get("title"), "markdown", md.get("markdown"), "trashed", Boolean.TRUE.equals(md.get("trashed"))));
        }
        return ok("pages", out);
    }

    /**
     * One call to desk-notebook as the owner, on a connection of its own, for what deskd's own tools never ask (making a
     * notebook and its tabs, the tree): the same frames as {@code NotebookCalls}.
     */
    @SuppressWarnings("unchecked")
    private Map<String, Object> nb(String method, Map<String, Object> params) throws Exception {
        try (java.nio.channels.SocketChannel ch = java.nio.channels.SocketChannel.open(
                java.net.StandardProtocolFamily.UNIX)) {
            ch.connect(java.net.UnixDomainSocketAddress.of(dir.resolve("nb.sock")));
            frame(ch, m("t", "hello", "sessionId", "harness-rig-" + seq.incrementAndGet(), "sub", Caller.OWNER,
                    "caller", Caller.THE_OWNER.toJson()));
            frame(ch, m("t", "req", "id", 1, "m", method, "p", params));
            ByteBuffer header = ByteBuffer.allocate(5);
            while (true) {
                header.clear();
                fill(ch, header);
                int length = header.getInt(0);
                ByteBuffer body = ByteBuffer.allocate(length - 1);
                fill(ch, body);
                if (header.get(4) != 0x01) {
                    continue;
                }
                Map<String, Object> msg = Json.parseObject(body.array());
                if (msg.get("id") instanceof Number n && n.longValue() == 1) {
                    if ("res".equals(msg.get("t"))) {
                        return msg.get("r") instanceof Map<?, ?> r ? (Map<String, Object>) r : Map.of();
                    }
                    throw new RigError("notebook", String.valueOf(msg.get("code")));
                }
            }
        }
    }

    private static void frame(java.nio.channels.SocketChannel ch, Map<String, Object> message) throws IOException {
        byte[] body = Json.bytes(message);
        ByteBuffer f = ByteBuffer.allocate(5 + body.length);
        f.putInt(1 + body.length).put((byte) 0x01).put(body).flip();
        while (f.hasRemaining()) {
            ch.write(f);
        }
    }

    private static void fill(java.nio.channels.SocketChannel ch, ByteBuffer b) throws IOException {
        while (b.hasRemaining()) {
            if (ch.read(b) < 0) {
                throw new IOException("closed");
            }
        }
    }

    private Map<String, Object> fault(String kind) throws Exception {
        switch (kind) {
            case "kill-desk-agent" -> {
                deskAgent.destroyForcibly();
                deskAgent.waitFor(10, TimeUnit.SECONDS);
                startDeskAgent();
            }
            case "restart-deskd" -> {
                // deskd's RAM goes: its tickets, its kept replies, its sessions; the link drops and comes back. The
                // member's setup choices are on /data/desk on a desk; this rig keeps them in memory, so they're saved
                // again from the owner's session, as the confirm screen would.
                rig.close();
                startDeskd();
                long until = System.nanoTime() + Duration.ofSeconds(60).toNanos();
                while (!rig.module.link().isConnected() && System.nanoTime() < until) {
                    Thread.sleep(100);
                }
                owner = rig.connect("rig-" + System.nanoTime());
                for (Map<String, Object> access : accessOf.values()) {
                    try {
                        call("agent.access.set", access);
                    } catch (RigError e) {
                        // an agent removed since
                    }
                }
            }
            case "notebook-down" -> stopNotebook();
            case "notebook-up" -> startNotebook(false);
            case "files-away" -> Files.move(files.root(), dir.resolve("files-away"));
            case "files-back" -> Files.move(dir.resolve("files-away"), files.root());
            default -> throw new RigError("bad_request", "kind");
        }
        return ok();
    }

    /** desk-agent's hash chain, checked from its file as {@code AuditLog.verify} does. */
    private Map<String, Object> auditVerify() throws Exception {
        Path db = dir.resolve("agent-data").resolve("audit.db");
        long rows = 0;
        Long broken = null;
        try (Connection c = DriverManager.getConnection("jdbc:sqlite:file:" + db + "?mode=ro");
                Statement s = c.createStatement();
                ResultSet r = s.executeQuery("SELECT seq, at_ms, actor, action, target, payload_sha256, decision,"
                        + " cost_microusd, prev_hash, hash FROM audit ORDER BY seq")) {
            byte[] expectedPrev = null;
            long last = 0;
            while (r.next()) {
                long rowSeq = r.getLong(1);
                long cost = r.getLong(8);
                Long costOrNull = r.wasNull() ? null : cost;
                byte[] prev = r.getBytes(9);
                byte[] hash = r.getBytes(10);
                if (rows == 0) {
                    expectedPrev = rowSeq == 1 ? new byte[32] : prev;
                } else if (rowSeq != last + 1) {
                    broken = rowSeq;
                    break;
                }
                byte[] encoded = encode(rowSeq, r.getLong(2), r.getString(3), r.getString(4), r.getString(5),
                        r.getBytes(6), r.getString(7), costOrNull);
                MessageDigest d = MessageDigest.getInstance("SHA-256");
                d.update(prev);
                if (!Arrays.equals(prev, expectedPrev) || !Arrays.equals(hash, d.digest(encoded))) {
                    broken = rowSeq;
                    break;
                }
                expectedPrev = hash;
                last = rowSeq;
                rows++;
            }
        }
        return ok("intact", broken == null, "rows", rows, "brokenAt", broken);
    }

    /** {@code AuditLog.encode}, byte for byte. */
    static byte[] encode(long seq, long at, String actor, String action, String target, byte[] payloadSha,
            String decision, Long cost) {
        byte[][] s = {actor.getBytes(StandardCharsets.UTF_8), action.getBytes(StandardCharsets.UTF_8),
            target.getBytes(StandardCharsets.UTF_8), decision.getBytes(StandardCharsets.UTF_8)};
        byte[] payload = payloadSha == null ? new byte[0] : payloadSha;
        ByteBuffer b = ByteBuffer.allocate(8 + 8 + 16 + s[0].length + s[1].length + s[2].length + s[3].length + 1
                + payload.length + 1 + 8);
        b.putLong(seq).putLong(at);
        for (int i = 0; i < 3; i++) {
            b.putInt(s[i].length).put(s[i]);
        }
        b.put((byte) payload.length).put(payload);
        b.putInt(s[3].length).put(s[3]);
        if (cost == null) {
            b.put((byte) 0);
        } else {
            b.put((byte) 1).putLong(cost);
        }
        return Arrays.copyOf(b.array(), b.position());
    }

    @SuppressWarnings("unused")
    private static String hex(byte[] b) {
        return HexFormat.of().formatHex(b);
    }

    @SuppressWarnings("unused")
    private static final Comparator<Path> BY_NAME = Comparator.comparing(Path::toString);
}
