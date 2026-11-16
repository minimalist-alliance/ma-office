package com.minimalistalliance.desk.deskd.browser;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.browser.minified.MinifiedModule;
import com.minimalistalliance.desk.deskd.browser.minified.MinifiedSwitch;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.rpc.Caller;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import com.minimalistalliance.desk.deskd.tools.BrowserTools;
import com.minimalistalliance.desk.deskd.tools.HostedCall;
import com.minimalistalliance.desk.deskd.tools.HostedTool;
import com.minimalistalliance.desk.deskd.tools.RunLedger;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.WebSocket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.junit.jupiter.api.io.TempDir;

/**
 * The draft ADR's §17 Browser row, "no context leak after 1,000 runs": each run of the Agent browses in an off-the-record
 * context of its own (§5), so nothing one run's pages store (a cookie, local storage) is there for the next, none of it
 * reaches the member's own profile, and nothing of a run (its context, its hidden tabs, deskd's own records of them) is
 * left once it ends. Against a real Chromium, headless, on pages from a local server only ({@code a.test} mapped to it).
 * Each run opens a page that shows what it finds stored, checks it finds nothing, stores its own marks, reads them back
 * in its own context, and ends; every 100 runs, and at the end, Chromium's own list of contexts (from this test's own
 * debugging socket, not deskd's) holds none of the Agent's, deskd holds no Agent tab, and the member's cookies are as
 * they were. Two runs at once each see only their own. Chromium's memory is noted at run 100 and at the end, and mustn't
 * have grown past what a leak would leave.
 *
 * <pre>DESKD_CHROMIUM_BIN=/path/to/chrome ./mvnw -q -pl deskd verify -Dtest=none -Dsurefire.failIfNoSpecifiedTests=false -Dit.test=AgentBrowsingLeakIT</pre>
 * {@code AGENT_LEAK_RUNS} changes the count (1,000).
 */
@EnabledIfEnvironmentVariable(named = "DESKD_CHROMIUM_BIN", matches = ".+")
@SuppressWarnings("unchecked")
class AgentBrowsingLeakIT {

    @TempDir
    Path dir;

    private int port;
    private int cdpPort;
    private Process chromium;
    private HttpServer pages;
    private BrowserRig rig;
    private TestClient client;
    private AgentBrowsing agent;
    private BrowserTools tools;
    private final RunLedger ledger = new RunLedger(Clock.systemUTC(), runId -> {});

    @BeforeEach
    void setUp() throws Exception {
        pages = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
        port = pages.getAddress().getPort();
        pages.createContext("/", exchange -> {
            String path = exchange.getRequestURI().getPath();
            String query = exchange.getRequestURI().getRawQuery();
            String mark = query != null && query.matches("who=[a-z0-9-]+") ? query.substring(4) : null;
            if (path.equals("/set") && mark != null) {
                exchange.getResponseHeaders().add("Set-Cookie", "who=" + mark + "; Path=/; Max-Age=3600");
            }
            String prose = "The lamp has lit the reading rooms of the world for a long time, and it is still the best way to read at "
                    + "night without waking anyone else in the house. ";
            // What the page finds stored: its cookies and its local storage, as text the walker reads.
            String body = "<title>Store</title><main><h1>Store</h1><p id=c>none</p><p id=s>none</p><p>" + prose.repeat(3) + "</p></main>"
                    + "<script>"
                    + (path.equals("/set") && mark != null ? "localStorage.setItem('who','" + mark + "');" : "")
                    + "document.getElementById('c').textContent='cookies: ('+document.cookie+')';"
                    + "document.getElementById('s').textContent='stored: ('+(localStorage.getItem('who')||'')+')';"
                    + "</script>";
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "text/html; charset=utf-8");
            exchange.sendResponseHeaders(200, bytes.length);
            exchange.getResponseBody().write(bytes);
            exchange.close();
        });
        pages.start();
        cdpPort = freePort();
        chromium = new ProcessBuilder(
                        System.getenv("DESKD_CHROMIUM_BIN"),
                        "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
                        "--noerrdialogs", "--disable-breakpad", "--password-store=basic", "--window-size=1280,800",
                        "--user-data-dir=" + dir.resolve("profile"),
                        "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=" + cdpPort,
                        "--host-resolver-rules=MAP a.test 127.0.0.1",
                        "about:blank")
                .redirectErrorStream(true)
                .redirectOutput(ProcessBuilder.Redirect.appendTo(dir.resolve("chromium.log").toFile()))
                .start();
        await().atMost(Duration.ofSeconds(30)).until(this::debuggingPortAnswers);
        rig = new BrowserRig(dir, cdpPort, BrowserRig.timing(Duration.ofMillis(250), Duration.ofMinutes(5)));
        rig.module.enableMinified(dir, Clock.systemUTC(), new MinifiedModule.Timing(
                Duration.ofSeconds(10), Duration.ofSeconds(8), Duration.ofSeconds(20), Duration.ofMillis(24), Duration.ofMillis(100),
                Duration.ofSeconds(30)), MinifiedSwitch.fixed(true, false, false));
        agent = (AgentBrowsing) rig.module.enableAgentBrowsing(() -> false);
        tools = new BrowserTools(agent);
        client = rig.connect("cs-a");
        // The member's own cookie, which no run may see or change.
        Map<String, Object> reply = rig.call(client, "browser.tab.navigate", Map.of("url", "http://a.test:" + port + "/set?who=member"));
        assertThat(reply).containsEntry("_kind", "RES");
        await().atMost(Duration.ofSeconds(10)).until(() -> memberCookies().contains("who=member"));
    }

    @AfterEach
    void tearDown() throws Exception {
        if (rig != null) {
            rig.close();
        }
        if (pages != null) {
            pages.stop(0);
        }
        if (chromium != null) {
            chromium.toHandle().descendants().forEach(ProcessHandle::destroy);
            chromium.destroy();
            if (!chromium.waitFor(10, TimeUnit.SECONDS)) {
                chromium.toHandle().descendants().forEach(ProcessHandle::destroyForcibly);
                chromium.destroyForcibly();
            }
        }
    }

    @Test
    void aThousandRunsEachInAContextOfItsOwnLeaveNothingBehind() throws Exception {
        int runs = Integer.parseInt(System.getenv().getOrDefault("AGENT_LEAK_RUNS", "1000"));
        long memoryAt100 = 0;
        try (BrowserSocket browser = new BrowserSocket(cdpPort)) {
            int contextsBefore = agentContexts(browser);
            for (int i = 1; i <= runs; i++) {
                String runId = "leak-" + i;
                String tab = (String) ((Map<String, Object>) exec(runId, "browser_open", Map.of("url", url("/show"))).content()).get("tabId");
                // Nothing an earlier run stored is here, and nothing of the member's.
                assertThat(text(runId, tab)).as("run " + i + " before").contains("cookies: ()").contains("stored: ()");
                agent.navigate(runId, tab, url("/set?who=run" + i));
                agent.navigate(runId, tab, url("/show"));
                // Its own marks are there, in its own context.
                assertThat(text(runId, tab)).as("run " + i + " after").contains("cookies: (who=run" + i + ")")
                        .contains("stored: (run" + i + ")");
                tools.runEnded(runId);
                if (i % 100 == 0 || i == runs) {
                    await().atMost(Duration.ofSeconds(10)).until(() -> agent.agentTabs() == 0 && agentContexts(browser) == contextsBefore);
                    assertThat(memberCookies()).as("the member's cookies at run " + i).containsExactly("who=member");
                    if (i == 100) {
                        memoryAt100 = chromiumKb();
                    }
                }
            }
            long memoryAtEnd = chromiumKb();
            Files.writeString(dir.resolve("leak.txt"), "runs " + runs + ", chromium kB at 100 " + memoryAt100 + ", at end " + memoryAtEnd);
            System.out.println("agent leak: runs " + runs + ", chromium RSS kB at run 100 " + memoryAt100 + ", at the end " + memoryAtEnd);
            if (runs >= 1000 && memoryAt100 > 0) {
                // 900 more runs leaking a context's or a tab's worth each would be hundreds of MB; Chromium's own caches
                // and the member's tab may grow a little.
                assertThat(memoryAtEnd).as("Chromium's memory after " + runs + " runs").isLessThan(memoryAt100 + 150 * 1024);
            }
        }
    }

    @Test
    void twoRunsAtOnceEachSeeOnlyTheirOwn() throws Exception {
        String a = (String) ((Map<String, Object>) exec("run-a", "browser_open", Map.of("url", url("/set?who=alpha"))).content()).get("tabId");
        String b = (String) ((Map<String, Object>) exec("run-b", "browser_open", Map.of("url", url("/set?who=beta"))).content()).get("tabId");
        agent.navigate("run-a", a, url("/show"));
        agent.navigate("run-b", b, url("/show"));
        assertThat(text("run-a", a)).contains("cookies: (who=alpha)").contains("stored: (alpha)").doesNotContain("beta");
        assertThat(text("run-b", b)).contains("cookies: (who=beta)").contains("stored: (beta)").doesNotContain("alpha");
        tools.runEnded("run-a");
        tools.runEnded("run-b");
        await().atMost(Duration.ofSeconds(10)).until(() -> agent.agentTabs() == 0);
        assertThat(memberCookies()).containsExactly("who=member");
    }

    // ---- small things

    private String url(String path) {
        return "http://a.test:" + port + path;
    }

    private HostedTool.Result exec(String runId, String tool, Map<String, Object> args) throws Exception {
        HostedCall call = new HostedCall(1, runId, "ag-1", tool, new LinkedHashMap<>(args), null, false, Caller.THE_OWNER, null);
        RunLedger.Run run = ledger.join(runId, "ag-1", Caller.THE_OWNER, List.of());
        HostedTool.Look look = tools.look(call, run);
        assertThat(look.refusal()).isNull();
        return tools.run(call, run);
    }

    private String text(String runId, String tabId) throws Exception {
        Map<String, Object> content = (Map<String, Object>) exec(runId, "browser_read", Map.of("tabId", tabId)).content();
        assertThat(content).containsEntry("view", "page");
        return (String) content.get("text");
    }

    private List<String> memberCookies() throws Exception {
        return rig.module.cookies().stream().map(c -> c.get("name") + "=" + c.get("value")).sorted().toList();
    }

    /** Contexts made by Target.createBrowserContext, as Chromium lists them to any client: the Agent's are the only ones. */
    private static int agentContexts(BrowserSocket browser) throws Exception {
        Object ids = browser.call("Target.getBrowserContexts", Map.of()).get("browserContextIds");
        return ids instanceof List<?> list ? list.size() : 0;
    }

    /** Chromium's resident memory, every process of it, in kB. */
    private long chromiumKb() {
        List<ProcessHandle> all = new ArrayList<>();
        all.add(chromium.toHandle());
        chromium.toHandle().descendants().forEach(all::add);
        long kb = 0;
        for (ProcessHandle p : all) {
            try {
                for (String line : Files.readAllLines(Path.of("/proc/" + p.pid() + "/status"))) {
                    if (line.startsWith("VmRSS:")) {
                        kb += Long.parseLong(line.replaceAll("[^0-9]", ""));
                    }
                }
            } catch (IOException | RuntimeException e) {
                // Gone: its memory with it.
            }
        }
        return kb;
    }

    private boolean debuggingPortAnswers() {
        try (HttpClient http = HttpClient.newHttpClient()) {
            return http.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + cdpPort + "/json/version")).build(),
                    HttpResponse.BodyHandlers.ofString()).statusCode() == 200;
        } catch (IOException | InterruptedException e) {
            return false;
        }
    }

    private static int freePort() throws IOException {
        try (ServerSocket socket = new ServerSocket(0)) {
            return socket.getLocalPort();
        }
    }

    /** This test's own debugging socket on the browser itself: one connection, many commands, events ignored. */
    static final class BrowserSocket implements AutoCloseable {
        private final HttpClient http = HttpClient.newHttpClient();
        private final WebSocket socket;
        private final AtomicInteger ids = new AtomicInteger();
        private final Map<Integer, CompletableFuture<Map<String, Object>>> waiting = new ConcurrentHashMap<>();

        BrowserSocket(int port) throws Exception {
            String version = http.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/json/version")).build(),
                    HttpResponse.BodyHandlers.ofString()).body();
            String endpoint = Json.string(Json.parseObject(version.getBytes(StandardCharsets.UTF_8)), "webSocketDebuggerUrl");
            StringBuilder text = new StringBuilder();
            socket = http.newWebSocketBuilder().buildAsync(URI.create(endpoint), new WebSocket.Listener() {
                @Override
                public CompletionStage<?> onText(WebSocket webSocket, CharSequence data, boolean last) {
                    text.append(data);
                    if (last) {
                        String message = text.toString();
                        text.setLength(0);
                        try {
                            Map<String, Object> parsed = Json.parseObject(message.getBytes(StandardCharsets.UTF_8));
                            if (parsed.get("id") instanceof Number id) {
                                CompletableFuture<Map<String, Object>> reply = waiting.remove(id.intValue());
                                if (reply != null) {
                                    reply.complete(parsed);
                                }
                            }
                        } catch (RuntimeException | com.minimalistalliance.desk.deskd.protocol.JsonFormatException e) {
                            // An event this doesn't read.
                        }
                    }
                    webSocket.request(1);
                    return null;
                }
            }).get(5, TimeUnit.SECONDS);
        }

        Map<String, Object> call(String method, Map<String, Object> params) throws Exception {
            int id = ids.incrementAndGet();
            CompletableFuture<Map<String, Object>> reply = new CompletableFuture<>();
            waiting.put(id, reply);
            socket.sendText(new String(Json.bytes(Map.of("id", id, "method", method, "params", params)), StandardCharsets.UTF_8), true)
                    .get(5, TimeUnit.SECONDS);
            Map<String, Object> answer = reply.get(30, TimeUnit.SECONDS);
            if (answer.get("error") != null) {
                throw new IllegalStateException(method + " failed");
            }
            return Json.object(answer, "result");
        }

        @Override
        public void close() {
            socket.abort();
            http.close();
        }
    }
}
