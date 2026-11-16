package com.minimalistalliance.desk.deskd.browser;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.Frame;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.testing.TestClient;
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
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Predicate;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;

/**
 * The Browser's zoom against a real Chromium, headless, at the desk's window size, with local pages on two hosts
 * ({@code 127.0.0.1} and {@code localhost}, two sites to Chromium's per-site zoom), under no policy, the image's
 * {@code ma.json}, and {@code ma.json} with the teen lock: that Chromium's default zoom from its hidden Password Manager page
 * reflows every member tab and new ones, sharp (a page's {@code innerWidth} and {@code devicePixelRatio}); that it's kept
 * through a restart of deskd and of Chromium, and set again for a Chromium that lost it; that Chromium's own keys in a tab
 * fold in, and that a site's remembered level is erased. A second DevTools client of the test's own looks into the pages and
 * presses Chromium's keys, as desk-rtc's would. Run it as ChromiumIT is run:
 *
 * <pre>DESKD_CHROMIUM_BIN=/path/to/chrome ./mvnw -q -pl deskd verify -Dtest=none -Dsurefire.failIfNoSpecifiedTests=false -Dit.test=BrowserZoomChromiumIT</pre>
 *
 * <p>The policies go in through {@code chrome://policy/test}, as the image's files can't on a build box. There the teen
 * lock's {@code ProxyMode: direct} hangs Chromium's whole browser process (Chrome for Testing 156), so it goes in as
 * {@code ProxySettings: {ProxyMode: direct}}, its dictionary form, the same policy; the image's file isn't changed. It can't
 * cover a headed kiosk window or X keys (the spike's {@code HEADFUL=1} runs did: the same results).
 */
@EnabledIfEnvironmentVariable(named = "DESKD_CHROMIUM_BIN", matches = ".+")
class BrowserZoomChromiumIT {

    /** The policies Chromium runs under. */
    enum Policies {
        NONE,
        MA,
        TEEN
    }

    private static final Path REPO = Path.of("").toAbsolutePath().resolve("../..").normalize();
    private static final String PAGE = "<!doctype html><title>zoom</title><style>body{margin:0;font:16px sans-serif}"
            + "#box{width:600px;height:40px;background:#08f}</style><div id=box>box</div><p>Some text to read at a zoom.</p>";
    private static final BrowserZoom.Timing TIMING = new BrowserZoom.Timing(
            Duration.ofMillis(300), Duration.ofMillis(500), Duration.ofMillis(1500), Duration.ofSeconds(2), Duration.ofSeconds(2),
            Duration.ofSeconds(10));
    private static final Duration A_WHILE = Duration.ofSeconds(15);

    @TempDir
    Path dir;

    private int port;
    private Process chromium;
    private HttpServer pages;
    private String hostA;
    private String hostB;
    private BrowserRig rig;
    private BrowserZoom zoom;
    private TestClient client;
    private Cdp cdp;

    @AfterEach
    void tearDown() throws Exception {
        stopDeskd();
        stopChromium();
        if (pages != null) {
            pages.stop(0);
        }
    }

    // ---- the runs

    @ParameterizedTest
    @EnumSource(Policies.class)
    void aLevelReflowsEveryMemberTabNowAndLaterSharpAndTheTopicSaysIt(Policies policies) throws Exception {
        start(policies, "profile");
        String a = memberTab(hostA + "/a");
        String b = openTab(hostB + "/b");
        // The first connection's sweep passes Chromium's default over its steps and back to the level.
        awaitSwept();
        assertThat(seen(a)).isEqualTo(List.of(1920, 1.0));
        assertThat(client.subscribe("browser.view", null)).containsEntry("_kind", "RES");
        awaitView(view -> Integer.valueOf(100).equals(view.get("zoom")));

        assertThat(call("browser.zoom.set", Map.of("level", 150))).containsEntry("level", 150);

        for (String tab : List.of(a, b)) {
            await().atMost(A_WHILE).untilAsserted(() -> assertThat(seen(tab)).isEqualTo(List.of(1280, 1.5)));
            assertThat(layoutZoom(tab)).isCloseTo(1.5, within(0.001));
        }
        awaitView(view -> Integer.valueOf(150).equals(view.get("zoom")));
        // A tab opened later is at the level from its first page.
        String c = openTab(hostA + "/c");
        assertThat(seen(c)).isEqualTo(List.of(1280, 1.5));
        // Chromium's own 2/3.
        assertThat(call("browser.zoom.set", Map.of("level", 67))).containsEntry("level", 67);
        await().atMost(A_WHILE).untilAsserted(() -> assertThat(seen(a).get(0)).isEqualTo(2880));
        assertThat(call("browser.zoom.get", Map.of())).containsEntry("level", 67);
        // The hidden page goes after its linger, and was never a tab of the member's.
        await().atMost(A_WHILE).until(() -> targetUrls().stream().noneMatch(url -> url.startsWith("chrome://password-manager")));
        assertThat(memberTabUrls()).noneMatch(url -> url.startsWith("chrome://"));
        assertSameUnderPolicies(policies);
    }

    @ParameterizedTest
    @EnumSource(Policies.class)
    void theLevelIsKeptThroughRestartsAndSetAgainForAChromiumThatLostIt(Policies policies) throws Exception {
        start(policies, "profile");
        memberTab(hostA + "/a");
        assertThat(call("browser.zoom.set", Map.of("level", 125))).containsEntry("level", 125);
        Thread.sleep(11_000); // Chromium writes its prefs within 10 s

        // deskd and Chromium both start again, on the same profile and the same desk volume.
        stopDeskd();
        stopChromium();
        launchChromium(policies, "profile");
        startDeskd();
        assertThat(call("browser.zoom.get", Map.of())).containsEntry("level", 125);
        String a = memberTab(hostA + "/a?again");
        assertThat(seen(a)).isEqualTo(List.of(1536, 1.25));

        // A Chromium with a profile of its own (it lost its prefs): deskd's file wins as it connects.
        stopDeskd();
        stopChromium();
        launchChromium(policies, "fresh-profile");
        startDeskd();
        String fresh = memberTab(hostB + "/b");
        await().atMost(A_WHILE).untilAsserted(() -> assertThat(seen(fresh)).isEqualTo(List.of(1536, 1.25)));
        assertSameUnderPolicies(policies);
    }

    @ParameterizedTest
    @EnumSource(Policies.class)
    void chromiumsKeysInATabFoldInAndASitesRememberedLevelIsErased(Policies policies) throws Exception {
        start(policies, "profile");
        String a = memberTab(hostA + "/a");
        String b = openTab(hostB + "/b");
        assertThat(call("browser.zoom.set", Map.of("level", 150))).containsEntry("level", 150);
        await().atMost(A_WHILE).untilAsserted(() -> assertThat(seen(b)).isEqualTo(List.of(1280, 1.5)));
        assertThat(client.subscribe("browser.view", null)).containsEntry("_kind", "RES");

        // Ctrl+= in the stream on b: Chromium's next step, 175%, on that site; deskd makes it the level, every tab's.
        cdp.call(null, "Target.activateTarget", Map.of("targetId", b));
        Thread.sleep(300);
        key(b, "=", "Equal", 187);
        awaitView(view -> Integer.valueOf(175).equals(view.get("zoom")));
        assertThat(call("browser.zoom.get", Map.of())).containsEntry("level", 175);
        for (String tab : List.of(a, b)) {
            await().atMost(A_WHILE).untilAsserted(() -> assertThat(layoutZoom(tab)).isCloseTo(1.75, within(0.001)));
        }

        // With deskd away, Ctrl+- leaves b's site at 150% in Chromium's memory. deskd back: the site's level goes, the
        // desk's stays.
        stopDeskd();
        key(b, "-", "Minus", 189);
        await().atMost(A_WHILE).untilAsserted(() -> assertThat(layoutZoom(b)).isCloseTo(1.5, within(0.001)));
        assertThat(layoutZoom(a)).isCloseTo(1.75, within(0.001));
        startDeskd();
        assertThat(call("browser.tab.list", Map.of())).containsEntry("_kind", "RES");
        await().atMost(A_WHILE).untilAsserted(() -> assertThat(layoutZoom(b)).isCloseTo(1.75, within(0.001)));
        assertThat(call("browser.zoom.get", Map.of())).containsEntry("level", 175);
        assertSameUnderPolicies(policies);
    }

    // ---- set up

    private void start(Policies policies, String profile) throws Exception {
        pages = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
        pages.createContext("/", exchange -> {
            byte[] body = PAGE.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "text/html; charset=utf-8");
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        pages.start();
        int at = pages.getAddress().getPort();
        hostA = "http://127.0.0.1:" + at;
        hostB = "http://localhost:" + at;
        launchChromium(policies, profile);
        startDeskd();
    }

    private void launchChromium(Policies policies, String profile) throws Exception {
        port = freePort();
        chromium = new ProcessBuilder(
                        System.getenv("DESKD_CHROMIUM_BIN"),
                        "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
                        "--noerrdialogs", "--disable-infobars", "--disable-breakpad", "--password-store=basic",
                        "--window-size=1920,1080",
                        "--user-data-dir=" + dir.resolve(profile),
                        "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost",
                        "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=" + port,
                        "about:blank")
                .redirectErrorStream(true)
                .redirectOutput(ProcessBuilder.Redirect.appendTo(dir.resolve("chromium.log").toFile()))
                .start();
        await().atMost(Duration.ofSeconds(30)).until(this::debuggingPortAnswers);
        cdp = Cdp.open(port);
        applyPolicies(policies);
    }

    private void startDeskd() throws Exception {
        BrowserTabs.Timing real = BrowserTabs.Timing.DEFAULT;
        rig = new BrowserRig(dir, port, new BrowserTabs.Timing(
                real.publishEvery(), Duration.ofMinutes(5), Duration.ofSeconds(5), Duration.ofSeconds(10), Duration.ofSeconds(10),
                real.navigate(), real.settle(), real.listEvery(), real.visibility(), real.restartEvery(), real.cdp()));
        Path volume = dir.resolve("desk");
        Files.createDirectories(volume);
        zoom = rig.module.enableZoom(volume, TIMING);
        client = rig.connect("cs-" + System.nanoTime());
    }

    /** The once-per-desk sweep done, and the page it used closed again. */
    private void awaitSwept() {
        await().atMost(A_WHILE).until(() -> {
            Path file = dir.resolve("desk").resolve(BrowserZoom.FILE);
            return Files.exists(file) && Boolean.TRUE.equals(Json.parseObject(Files.readAllBytes(file)).get("swept"))
                    && Boolean.FALSE.equals(zoom.health().get("page"));
        });
    }

    private void stopDeskd() throws Exception {
        if (rig != null) {
            rig.close();
            rig = null;
        }
    }

    private void stopChromium() throws InterruptedException {
        if (cdp != null) {
            cdp.close();
            cdp = null;
        }
        if (chromium != null) {
            chromium.toHandle().descendants().forEach(ProcessHandle::destroy);
            chromium.destroy();
            if (!chromium.waitFor(10, TimeUnit.SECONDS)) {
                chromium.toHandle().descendants().forEach(ProcessHandle::destroyForcibly);
                chromium.destroyForcibly();
            }
            chromium = null;
        }
    }

    /**
     * The image's policies, through Chromium's policy test page: {@code ma.json}, and for the teen lock its file on top,
     * with {@code ProxyMode} as {@code ProxySettings} (see the class comment). Then {@code chrome://policy} must list them all.
     */
    private void applyPolicies(Policies policies) throws Exception {
        if (policies == Policies.NONE) {
            return;
        }
        Map<String, Object> all = new LinkedHashMap<>(
                Json.parseObject(Files.readAllBytes(REPO.resolve("image/recipe/files/etc/chromium/policies/managed/ma.json"))));
        if (policies == Policies.TEEN) {
            Map<String, Object> teen = new LinkedHashMap<>(
                    Json.parseObject(Files.readAllBytes(REPO.resolve("image/recipe/files/etc/ma/chromium-teen.json"))));
            Object proxy = teen.remove("ProxyMode");
            assertThat(proxy).isEqualTo("direct");
            teen.put("ProxySettings", Map.of("ProxyMode", proxy));
            all.putAll(teen);
        }
        List<Map<String, Object>> list = new ArrayList<>();
        for (Map.Entry<String, Object> entry : all.entrySet()) {
            list.add(Map.of("name", entry.getKey(), "level", 1, "scope", 1, "source", 4, "value", entry.getValue()));
        }
        String json = new String(Json.bytes(Map.of("l", list)), StandardCharsets.UTF_8);
        String test = cdp.newTab("chrome://policy/test");
        await().atMost(A_WHILE).until(() -> "function".equals(cdp.eval(test, "typeof chrome.send")));
        cdp.eval(test, "setTimeout(() => chrome.send('setLocalTestPolicies', ['zoom-it', JSON.stringify((" + json + ").l), '']), 0), 'sent'");
        Thread.sleep(1000);
        cdp.call(null, "Target.closeTarget", Map.of("targetId", test));
        String shown = cdp.newTab("chrome://policy");
        String walk = "(() => { let s = ''; const walk = (n) => { if (n.shadowRoot) walk(n.shadowRoot); for (const c of n.childNodes) {"
                + " if (c.nodeType === 3) s += c.textContent.trim() + ' '; else walk(c); } }; walk(document.body); return s; })()";
        await().atMost(A_WHILE).untilAsserted(() -> {
            String text = String.valueOf(cdp.eval(shown, walk));
            for (String name : all.keySet()) {
                assertThat(text).as(name).contains(name);
            }
        });
        cdp.call(null, "Target.closeTarget", Map.of("targetId", shown));
    }

    /** What the policies do still holds while the zoom works: the office's hosts are blocked by the administrator. */
    private void assertSameUnderPolicies(Policies policies) throws Exception {
        if (policies == Policies.NONE) {
            return;
        }
        String probe = cdp.newTab("about:blank");
        Map<String, Object> went = cdp.call(probe, "Page.navigate", Map.of("url", "https://office.minimalistalliance.com/x"));
        assertThat(went.get("errorText")).isEqualTo("net::ERR_BLOCKED_BY_ADMINISTRATOR");
        cdp.call(null, "Target.closeTarget", Map.of("targetId", probe));
    }

    // ---- the member's tabs, through deskd, and looked at by the test's own client

    private Map<String, Object> call(String method, Map<String, Object> params) throws Exception {
        Map<String, Object> reply = rig.call(client, method, params);
        assertThat(reply).containsEntry("_kind", "RES");
        return reply;
    }

    /** The one tab there is, at this page. */
    private String memberTab(String url) throws Exception {
        Map<String, Object> list = call("browser.tab.list", Map.of());
        String tabId = (String) ((Map<?, ?>) ((List<?>) list.get("tabs")).get(0)).get("tabId");
        call("browser.tab.navigate", Map.of("tabId", tabId, "url", url));
        loaded(tabId);
        return tabId;
    }

    private String openTab(String url) throws Exception {
        String tabId = (String) call("browser.tab.open", Map.of("url", url)).get("tabId");
        loaded(tabId);
        return tabId;
    }

    private void loaded(String tabId) throws Exception {
        cdp.attach(tabId);
        await().atMost(A_WHILE).until(() -> "complete".equals(cdp.eval(tabId, "document.readyState"))
                && Boolean.TRUE.equals(cdp.eval(tabId, "!!document.getElementById('box')")));
    }

    /** {@code [innerWidth, devicePixelRatio]}: a page laid out again at the zoom, drawn at its scale. */
    private List<Object> seen(String tab) throws Exception {
        List<?> got = (List<?>) cdp.eval(tab, "[innerWidth, Math.round(devicePixelRatio * 1000) / 1000]");
        return List.of(((Number) got.get(0)).intValue(), ((Number) got.get(1)).doubleValue());
    }

    private double layoutZoom(String tab) throws Exception {
        Map<String, Object> metrics = cdp.call(tab, "Page.getLayoutMetrics", Map.of());
        return ((Number) Json.object(metrics, "cssVisualViewport").get("zoom")).doubleValue();
    }

    /** Ctrl and a key, as Chromium's accelerators take it from CDP (the spike: the same as X's keys in a kiosk window). */
    private void key(String tab, String key, String code, int virtualKey) throws Exception {
        for (String type : List.of("rawKeyDown", "keyUp")) {
            cdp.call(tab, "Input.dispatchKeyEvent", Map.of(
                    "type", type, "modifiers", 2, "key", key, "code", code, "windowsVirtualKeyCode", virtualKey,
                    "nativeVirtualKeyCode", virtualKey));
        }
    }

    private List<String> targetUrls() throws Exception {
        List<String> urls = new ArrayList<>();
        for (Object info : (List<?>) cdp.call(null, "Target.getTargets", Map.of()).get("targetInfos")) {
            urls.add(String.valueOf(((Map<?, ?>) info).get("url")));
        }
        return urls;
    }

    private List<String> memberTabUrls() throws Exception {
        List<String> urls = new ArrayList<>();
        for (Object tab : (List<?>) call("browser.tab.list", Map.of()).get("tabs")) {
            urls.add(String.valueOf(((Map<?, ?>) tab).get("url")));
        }
        return urls;
    }

    private Map<String, Object> awaitView(Predicate<Map<String, Object>> wanted) throws Exception {
        long deadline = System.nanoTime() + A_WHILE.toNanos();
        while (System.nanoTime() < deadline) {
            Frame frame = rig.fake.pollFrame(client.handle(), Channels.EVENTS, 100);
            if (frame == null) {
                continue;
            }
            Map<String, Object> data = Json.object(TestClient.parse(frame.payload()), "data");
            if (data != null && data.containsKey("mode") && wanted.test(data)) {
                return data;
            }
        }
        throw new AssertionError("no such browser.view");
    }

    private boolean debuggingPortAnswers() {
        try (HttpClient http = HttpClient.newHttpClient()) {
            return http.send(
                    HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/json/version")).timeout(Duration.ofSeconds(2)).build(),
                    HttpResponse.BodyHandlers.discarding()).statusCode() == 200;
        } catch (IOException e) {
            return false;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    private static int freePort() throws IOException {
        try (ServerSocket socket = new ServerSocket(0, 1, InetAddress.getLoopbackAddress())) {
            return socket.getLocalPort();
        }
    }

    /** The test's own DevTools client: flat sessions, no Runtime.enable, a reply per call. */
    private static final class Cdp implements WebSocket.Listener, AutoCloseable {
        private final Map<Long, CompletableFuture<Map<String, Object>>> waiting = new ConcurrentHashMap<>();
        private final Map<String, String> sessions = new ConcurrentHashMap<>();
        private final AtomicLong ids = new AtomicLong();
        private final StringBuilder partial = new StringBuilder();
        private WebSocket socket;

        static Cdp open(int port) throws Exception {
            try (HttpClient http = HttpClient.newHttpClient()) {
                String version = http.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/json/version")).build(),
                        HttpResponse.BodyHandlers.ofString()).body();
                String url = Json.string(Json.parseObject(version.getBytes(StandardCharsets.UTF_8)), "webSocketDebuggerUrl");
                Cdp cdp = new Cdp();
                cdp.socket = HttpClient.newHttpClient().newWebSocketBuilder().buildAsync(URI.create(url), cdp).get(10, TimeUnit.SECONDS);
                return cdp;
            }
        }

        void attach(String targetId) throws Exception {
            if (sessions.containsKey(targetId)) {
                return;
            }
            Map<String, Object> attached = send(null, "Target.attachToTarget", Map.of("targetId", targetId, "flatten", true));
            sessions.put(targetId, (String) attached.get("sessionId"));
        }

        /** A tab of the test's own, attached. */
        String newTab(String url) throws Exception {
            String targetId = (String) send(null, "Target.createTarget", Map.of("url", url)).get("targetId");
            attach(targetId);
            return targetId;
        }

        Map<String, Object> call(String targetId, String method, Map<String, Object> params) throws Exception {
            return send(targetId == null ? null : sessions.get(targetId), method, params);
        }

        Object eval(String targetId, String expression) throws Exception {
            Map<String, Object> reply = call(targetId, "Runtime.evaluate", Map.of("expression", expression, "returnByValue", true));
            Map<String, Object> result = Json.object(reply, "result");
            return result == null ? null : result.get("value");
        }

        private Map<String, Object> send(String sessionId, String method, Map<String, Object> params) throws Exception {
            long id = ids.incrementAndGet();
            CompletableFuture<Map<String, Object>> reply = new CompletableFuture<>();
            waiting.put(id, reply);
            Map<String, Object> message = new LinkedHashMap<>();
            message.put("id", id);
            message.put("method", method);
            message.put("params", params);
            if (sessionId != null) {
                message.put("sessionId", sessionId);
            }
            socket.sendText(new String(Json.bytes(message), StandardCharsets.UTF_8), true).get(10, TimeUnit.SECONDS);
            Map<String, Object> answer = reply.get(10, TimeUnit.SECONDS);
            if (answer.get("error") != null) {
                throw new IllegalStateException(method + ": " + answer.get("error"));
            }
            Map<String, Object> result = Json.object(answer, "result");
            return result == null ? Map.of() : result;
        }

        @Override
        public CompletionStage<?> onText(WebSocket webSocket, CharSequence data, boolean last) {
            partial.append(data);
            if (last) {
                try {
                    Map<String, Object> message = Json.parseObject(partial.toString().getBytes(StandardCharsets.UTF_8));
                    if (message.get("id") instanceof Number id) {
                        CompletableFuture<Map<String, Object>> reply = waiting.remove(id.longValue());
                        if (reply != null) {
                            reply.complete(message);
                        }
                    }
                } catch (Exception e) {
                    // An event too odd to read is nothing this test waits for.
                }
                partial.setLength(0);
            }
            webSocket.request(1);
            return null;
        }

        @Override
        public void close() {
            if (socket != null) {
                socket.abort();
            }
        }
    }
}
