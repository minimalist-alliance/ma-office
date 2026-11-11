package com.minimalistalliance.desk.deskd.browser;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.platform.AgeBand;
import com.minimalistalliance.desk.deskd.platform.PlatformHttp;
import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.Frame;
import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.testing.FakeDoh;
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
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.junit.jupiter.api.io.TempDir;

/**
 * The Browser module against a real Chromium, headless, with its debugging port on loopback and small
 * pages from a local server. Only the desk-rtc and units.sock ends are fakes. It proves what a fake can't:
 * what Chromium really accepts and sends. Run it with a binary named, since a build machine may have none:
 *
 * <pre>DESKD_CHROMIUM_BIN=/path/to/chrome ./mvnw -q -pl deskd verify -Dtest=none -Dsurefire.failIfNoSpecifiedTests=false -Dit.test=ChromiumIT</pre>
 *
 * <p>It can't cover: the URLBlocklist (that needs a managed policy in /etc), a headed kiosk window or the
 * sandbox (this runs headless with --no-sandbox, as the build machine forbids user namespaces). Nor the teen policy's
 * resolver: {@code filtered.test} and {@code open.test} are mapped to what it answers, and {@link FakeDoh} stands in for it.
 */
@EnabledIfEnvironmentVariable(named = "DESKD_CHROMIUM_BIN", matches = ".+")
class ChromiumIT {

    private static final String FORM = "<title>form</title><input id=i autofocus oninput=\"document.title='typed:'+this.value\">";
    private static final String LONG_FORM = "<title>long</title><input id=i autofocus oninput=\"document.title='len:'+this.value.length\">";
    /** Every character Chromium escapes in /json/list. */
    private static final String TRICKY_TITLE = "Q&A: <b> \"quoted\" it's";
    private static final String ESCAPED_TRICKY_TITLE = "Q&amp;A: &lt;b&gt; &quot;quoted&quot; it&#39;s";
    private static final String TITLE_BY_SCRIPT = "Later & <i> \"again\" it's";
    /** A page's request for a key system, as a player makes one before it plays, with each answer added to the title. */
    private static final String ASK_KEY_SYSTEM = "const cfg = [{initDataTypes: ['cenc'], videoCapabilities: [{contentType: 'video/mp4; codecs=\"avc1.42E01E\"'}]}];"
            + "const answers = [];"
            + "function ask(ks) { navigator.requestMediaKeySystemAccess(ks, cfg).then("
            + "(a) => { answers.push('granted:' + a.keySystem); document.title = answers.join(' '); },"
            + "(e) => { answers.push('refused:' + e.name + ':' + e.message); document.title = answers.join(' '); }); }";

    @TempDir
    Path dir;

    private int port;
    private Process chromium;
    private HttpServer pages;
    private String base;
    private BrowserRig rig;
    private TestClient client;
    private FakeDoh doh;
    private PlatformHttp dohHttp;

    @BeforeEach
    void setUp() throws Exception {
        port = freePort();
        startChromium();
        pages = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
        page("/a", "<title>Page A</title>a");
        page("/b", "<title>Page B</title>b");
        page("/form", FORM);
        page("/long", LONG_FORM);
        page("/moves-itself", "<title>moves</title><script>setTimeout(() => { location.href = '/b'; }, 200)</script>");
        page("/pushes", "<title>pushes</title><script>setTimeout(() => { history.pushState(null, '', '/pushed'); document.title = 'Pushed'; }, 200)</script>");
        // A link at the top left, to click on, and a field that has the focus.
        page("/links", "<title>links</title><a href=/behind style=\"position:fixed;left:0;top:0;width:200px;height:50px\">go</a>"
                + "<input id=i style=\"position:fixed;top:100px\" autofocus oninput=\"document.title='typed:'+this.value\">");
        // The same field, on a page that says it's on screen in its own world whatever is true.
        page("/behind", "<title>behind</title><script>Object.defineProperty(document, 'visibilityState', {get: () => 'visible'});"
                + "Object.defineProperty(document, 'hidden', {get: () => false});</script>"
                + "<input id=i autofocus oninput=\"document.title='typed:'+this.value\">");
        page("/hostile", "<title>x</title><script>"
                + "history.replaceState(null, '', '#' + 'u'.repeat(1900000));"
                + "let n = 0; setInterval(() => { document.title = 'T'.repeat(500000) + n++; }, 20);"
                + "</script>");
        page("/tricky", "<title>" + ESCAPED_TRICKY_TITLE + "</title>tricky");
        // Well after load, with nothing else happening, so no event and no load can be what brings it.
        page("/retitles", "<title>before</title><script>addEventListener('load', () => setTimeout(() => {"
                + "document.title = 'Later & <i> \"again\" it\\'s'; }, 700))</script>");
        page("/ampersands", "<title>" + "&amp;".repeat(BrowserTabs.TITLE_CHARS + 50) + "</title>");
        // Protected playback (TD-225): asked as the page parses, before deskd can be listening in it; asked well after,
        // twice; and ClearKey, which Chromium has.
        page("/widevine", "<title>widevine</title><script>" + ASK_KEY_SYSTEM + "ask('com.widevine.alpha');</script>");
        page("/fairplay-later", "<title>fairplay</title><script>" + ASK_KEY_SYSTEM
                + "setTimeout(() => { ask('com.apple.fps.1_0'); ask('com.microsoft.playready'); }, 1500);</script>");
        page("/clearkey", "<title>clearkey</title><script>" + ASK_KEY_SYSTEM + "ask('org.w3.clearkey');</script>");
        // A file the server says to save, as the sweep's download did (LS-31).
        pages.createContext("/report", exchange -> {
            byte[] body = "a report\n".repeat(1000).getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/octet-stream");
            exchange.getResponseHeaders().set("Content-Disposition", "attachment; filename=\"report.txt\"");
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        pages.start();
        base = "http://127.0.0.1:" + pages.getAddress().getPort();
        await().atMost(Duration.ofSeconds(30)).until(this::debuggingPortAnswers);
        doh = new FakeDoh();
        doh.filter("filtered.test");
        doh.allow("open.test");
        dohHttp = new PlatformHttp();
        rig = new BrowserRig(dir, port, timing(), new FamilyDns(dohHttp, doh.endpoint(), FamilyDns.TIMEOUT));
        client = rig.connect("cs-a");
    }

    /** The real numbers, but for a recent call lasting long enough to see a whole test through. */
    private static BrowserTabs.Timing timing() {
        BrowserTabs.Timing real = BrowserTabs.Timing.DEFAULT;
        return new BrowserTabs.Timing(
                real.publishEvery(), Duration.ofMinutes(5), Duration.ofSeconds(5), Duration.ofSeconds(10), Duration.ofSeconds(10),
                real.navigate(), real.settle(), real.listEvery(), real.visibility(), real.restartEvery(), real.cdp());
    }

    @AfterEach
    void tearDown() throws Exception {
        if (rig != null) {
            rig.close();
        }
        if (pages != null) {
            pages.stop(0);
        }
        if (doh != null) {
            doh.close();
        }
        if (dohHttp != null) {
            dohHttp.close();
        }
        stopChromium();
    }

    private void startChromium() throws IOException {
        // Where downloads go, as the desk's DownloadDirectory policy says, so none lands in this user's own Downloads.
        Path preferences = dir.resolve("profile").resolve("Default").resolve("Preferences");
        if (!java.nio.file.Files.exists(preferences)) {
            java.nio.file.Files.createDirectories(preferences.getParent());
            java.nio.file.Files.writeString(preferences, "{\"download\":{\"default_directory\":\"" + dir.resolve("downloads")
                    + "\",\"prompt_for_download\":false,\"directory_upgrade\":true}}");
        }
        // The same flags as desk-browser.service wherever they can apply without a display.
        chromium = new ProcessBuilder(
                        System.getenv("DESKD_CHROMIUM_BIN"),
                        "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
                        "--noerrdialogs", "--disable-session-crashed-bubble", "--disable-infobars", "--disable-breakpad",
                        "--password-store=basic", "--window-size=1280,800",
                        "--user-data-dir=" + dir.resolve("profile"),
                        "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=" + port,
                        // What the family resolver answers for a filtered name, and a site that's just down.
                        "--host-resolver-rules=MAP filtered.test 0.0.0.0, MAP open.test 127.0.0.1:1",
                        "about:blank")
                .redirectErrorStream(true)
                .redirectOutput(ProcessBuilder.Redirect.appendTo(dir.resolve("chromium.log").toFile()))
                .start();
    }

    private void stopChromium() throws Exception {
        if (chromium != null) {
            chromium.toHandle().descendants().forEach(ProcessHandle::destroy);
            chromium.destroy();
            if (!chromium.waitFor(10, TimeUnit.SECONDS)) {
                chromium.toHandle().descendants().forEach(ProcessHandle::destroyForcibly);
                chromium.destroyForcibly();
            }
            chromium.waitFor(5, TimeUnit.SECONDS);
        }
    }

    private void page(String path, String html) {
        pages.createContext(path, exchange -> {
            byte[] body = html.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "text/html; charset=utf-8");
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
    }

    private boolean debuggingPortAnswers() {
        return portAnswers("127.0.0.1");
    }

    private boolean portAnswers(String host) {
        try (HttpClient http = HttpClient.newHttpClient()) {
            return http.send(
                    HttpRequest.newBuilder(URI.create("http://" + host + ":" + port + "/json/version")).timeout(Duration.ofSeconds(2)).build(),
                    HttpResponse.BodyHandlers.discarding()).statusCode() == 200;
        } catch (IOException e) {
            return false;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    private static int freePort() throws IOException {
        try (ServerSocket socket = new ServerSocket(0)) {
            return socket.getLocalPort();
        }
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> tabs() throws Exception {
        Map<String, Object> reply = rig.call(client, "browser.tab.list", Map.of(), null);
        assertThat(reply).containsEntry("_kind", "RES");
        return (List<Map<String, Object>>) reply.get("tabs");
    }

    private Map<String, Object> onlyTab() throws Exception {
        List<Map<String, Object>> tabs = tabs();
        assertThat(tabs).hasSize(1);
        return tabs.get(0);
    }

    private Map<String, Object> tab(String id) throws Exception {
        return tabs().stream().filter(tab -> id.equals(tab.get("tabId"))).findFirst().orElseThrow();
    }

    private String active() throws Exception {
        return tabs().stream().filter(tab -> Boolean.TRUE.equals(tab.get("active"))).map(tab -> (String) tab.get("tabId")).findFirst().orElse(null);
    }

    private Map<String, Object> navigate(String path) throws Exception {
        return rig.call(client, "browser.tab.navigate", Map.of("url", base + path));
    }

    /** One command on a page's own debugging socket, as a person or another program could cause. */
    private void onPageSocket(String targetId, String method, Map<String, Object> params) throws Exception {
        try (HttpClient http = HttpClient.newHttpClient()) {
            java.util.concurrent.CompletableFuture<String> reply = new java.util.concurrent.CompletableFuture<>();
            WebSocket socket = http.newWebSocketBuilder()
                    .buildAsync(URI.create("ws://127.0.0.1:" + port + "/devtools/page/" + targetId), new WebSocket.Listener() {
                        @Override
                        public java.util.concurrent.CompletionStage<?> onText(WebSocket webSocket, CharSequence data, boolean last) {
                            reply.complete(data.toString());
                            return null;
                        }
                    })
                    .get(5, TimeUnit.SECONDS);
            socket.sendText(new String(Json.bytes(Map.of("id", 1, "method", method, "params", params)), StandardCharsets.UTF_8), true);
            assertThat(reply.get(10, TimeUnit.SECONDS)).doesNotContain("\"error\"");
            socket.abort();
        }
    }

    /** One command on a page's own debugging socket, and what it answered. */
    private String onPageSocketReply(String targetId, String method, Map<String, Object> params) throws Exception {
        try (HttpClient http = HttpClient.newHttpClient()) {
            java.util.concurrent.CompletableFuture<String> reply = new java.util.concurrent.CompletableFuture<>();
            StringBuilder text = new StringBuilder();
            WebSocket socket = http.newWebSocketBuilder()
                    .buildAsync(URI.create("ws://127.0.0.1:" + port + "/devtools/page/" + targetId), new WebSocket.Listener() {
                        @Override
                        public java.util.concurrent.CompletionStage<?> onText(WebSocket webSocket, CharSequence data, boolean last) {
                            text.append(data);
                            if (last) {
                                reply.complete(text.toString());
                            }
                            webSocket.request(1);
                            return null;
                        }
                    })
                    .get(5, TimeUnit.SECONDS);
            socket.sendText(new String(Json.bytes(Map.of("id", 1, "method", method, "params", params)), StandardCharsets.UTF_8), true);
            String answer = reply.get(10, TimeUnit.SECONDS);
            socket.abort();
            return answer;
        }
    }

    /** A script's value in the page's own world, from the test's side. */
    @SuppressWarnings("unchecked")
    private String inPage(String targetId, String expression) throws Exception {
        Map<String, Object> reply = Json.parseObject(onPageSocketReply(
                targetId, "Runtime.evaluate", Map.of("expression", expression, "returnByValue", true)).getBytes(StandardCharsets.UTF_8));
        Map<String, Object> result = (Map<String, Object>) ((Map<String, Object>) reply.get("result")).get("result");
        return String.valueOf(result.get("value"));
    }

    private void teen() throws Exception {
        Path file = dir.resolve(AgeBand.FILE);
        java.nio.file.Files.writeString(file, "teen\n");
        rig.module.followAgeBand(new AgeBand(file));
    }

    /** A middle click on the link, as trusted input through the page's own input path: what the stream sends. */
    private void middleClickTheLink(String targetId) throws Exception {
        for (String type : List.of("mousePressed", "mouseReleased")) {
            onPageSocket(targetId, "Input.dispatchMouseEvent", Map.of(
                    "type", type, "x", 20, "y", 20, "button", "middle", "buttons", 4, "clickCount", 1));
        }
    }

    private String openBehindTheLink() throws Exception {
        navigate("/links");
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> assertThat(onlyTab()).containsEntry("title", "links"));
        String member = (String) onlyTab().get("tabId");
        middleClickTheLink(member);
        await().atMost(Duration.ofSeconds(10)).until(() -> tabs().size() == 2);
        String behind = tabs().stream().map(tab -> (String) tab.get("tabId")).filter(id -> !id.equals(member)).findFirst().orElseThrow();
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> assertThat(tab(behind)).containsEntry("title", "behind"));
        return behind;
    }

    /**
     * Regression, and what no fake can show: Chromium sorts /json/list by when a tab was last shown or made,
     * so a tab a member opens with a middle click comes first while it's hidden. Text left without a tabId
     * went into it, a page the member wasn't looking at.
     */
    @Test
    void aTabOpenedBehindTheOneInViewIsntActiveAndGetsNoText() throws Exception {
        String behind = openBehindTheLink();
        String member = tabs().stream().map(tab -> (String) tab.get("tabId")).filter(id -> !id.equals(behind)).findFirst().orElseThrow();

        assertThat(active()).isEqualTo(member);
        assertThat(rig.call(client, "browser.text.insert", Map.of("text", "SECRET"))).containsEntry("_kind", "RES");
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> assertThat(tab(member)).containsEntry("title", "typed:SECRET"));
        assertThat(tab(behind)).containsEntry("title", "behind");

        // Activating what's already in view changes nothing in Chromium's order, and it still stands.
        assertThat(rig.call(client, "browser.tab.activate", Map.of("tabId", member))).containsEntry("tabId", member);
        assertThat(active()).isEqualTo(member);
        assertThat(rig.call(client, "browser.tab.reload", Map.of())).containsEntry("tabId", member);
    }

    @Test
    void aTabBroughtIntoViewBecomesActiveWithNoCallFromDeskd() throws Exception {
        String behind = openBehindTheLink();
        String member = tabs().stream().map(tab -> (String) tab.get("tabId")).filter(id -> !id.equals(behind)).findFirst().orElseThrow();
        assertThat(active()).isEqualTo(member);

        // As on the keyboard: nothing tells deskd, and for this one the order doesn't change either.
        onPageSocket(behind, "Page.bringToFront", Map.of());
        await().atMost(Duration.ofSeconds(10)).until(() -> behind.equals(active()));
        assertThat(rig.call(client, "browser.text.insert", Map.of("text", "x"))).containsEntry("_kind", "RES");
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> assertThat(tab(behind)).containsEntry("title", "typed:x"));

        onPageSocket(member, "Page.bringToFront", Map.of());
        await().atMost(Duration.ofSeconds(10)).until(() -> member.equals(active()));

        // And a deskd that starts now works it out from nothing.
        rig.close();
        Path second = dir.resolve("second");
        java.nio.file.Files.createDirectories(second);
        rig = new BrowserRig(second, port, timing());
        client = rig.connect("cs-b");
        assertThat(active()).isEqualTo(member);
    }

    /** The page Ctrl+T opens is a chrome: page that is the member's, so it's the one kind of those deskd asks. */
    @Test
    void theNewTabPageCanSayItsOnScreen() throws Exception {
        String first = (String) onlyTab().get("tabId");
        onPageSocket(first, "Target.createTarget", Map.of("url", "chrome://newtab/"));
        await().atMost(Duration.ofSeconds(10)).until(() -> tabs().size() == 2);
        String ntp = tabs().stream().map(tab -> (String) tab.get("tabId")).filter(id -> !id.equals(first)).findFirst().orElseThrow();
        System.out.println("new tab page: " + tab(ntp).get("url"));
        await().atMost(Duration.ofSeconds(10)).until(() -> ntp.equals(active()));
        assertThat(rig.call(client, "browser.tab.reload", Map.of())).containsEntry("tabId", ntp);
    }

    /** A move to another site swaps the renderer, and the tab still has to be able to answer. */
    @Test
    void aTabThatMovedToAnotherSiteCanStillSayItsOnScreen() throws Exception {
        String behind = openBehindTheLink();
        String member = tabs().stream().map(tab -> (String) tab.get("tabId")).filter(id -> !id.equals(behind)).findFirst().orElseThrow();
        String other = base.replace("127.0.0.1", "localhost");
        assertThat(rig.call(client, "browser.tab.navigate", Map.of("url", other + "/form", "tabId", member))).containsEntry("_kind", "RES");
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> assertThat(tab(member)).containsEntry("title", "form"));
        assertThat(active()).isEqualTo(member);

        onPageSocket(behind, "Page.bringToFront", Map.of());
        await().atMost(Duration.ofSeconds(10)).until(() -> behind.equals(active()));
        onPageSocket(member, "Page.bringToFront", Map.of());
        await().atMost(Duration.ofSeconds(10)).until(() -> member.equals(active()));
        assertThat(rig.call(client, "browser.text.insert", Map.of("text", "x"))).containsEntry("_kind", "RES");
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> assertThat(tab(member)).containsEntry("title", "typed:x"));
    }

    /** What a member reaches on the keyboard with Ctrl+H. deskd never asks a page like that anything. */
    @Test
    void withAnInternalPageOnScreenALeftOutTabIdFailsClosed() throws Exception {
        navigate("/form");
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> assertThat(onlyTab()).containsEntry("title", "form"));
        String member = (String) onlyTab().get("tabId");
        assertThat(active()).isEqualTo(member);
        onPageSocket(member, "Target.createTarget", Map.of("url", "chrome://version/"));
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() ->
                assertThat(rig.call(client, "browser.text.insert", Map.of("text", "x")))
                        .containsEntry("code", "unavailable").containsEntry("details", Map.of("reason", "active_tab")));
        assertThat(onlyTab()).containsEntry("tabId", member).containsEntry("active", true).containsEntry("title", "form");
    }

    /** These ran into java.net.URI's grammar. What Chromium says of them is the point. */
    @Test
    void urlsOutsideJavasGrammarReachChromium() throws Exception {
        page("/odd", "<title>odd</title>");
        assertThat(navigate("/odd[1]?a[b]=100%#x#y")).containsEntry("_kind", "RES").doesNotContainKey("netError");
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> assertThat((String) onlyTab().get("url"))
                .isEqualTo(base + "/odd%5B1%5D?a%5Bb%5D=100%25#x%23y"));
        // A real name won't resolve under .invalid, which is an ordinary result, and shows it got that far.
        Map<String, Object> underscore = rig.call(client, "browser.tab.navigate", Map.of("url", "http://foo_bar.invalid/"));
        assertThat(underscore).containsEntry("_kind", "RES");
        assertThat((String) underscore.get("netError")).startsWith("net::ERR_");
    }

    @Test
    void connectsWithNoOriginAndAnOriginIsRefused() throws Exception {
        assertThat(onlyTab()).containsEntry("url", "about:blank").containsEntry("active", true);

        String version;
        try (HttpClient http = HttpClient.newHttpClient()) {
            version = http.send(
                    HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/json/version")).build(),
                    HttpResponse.BodyHandlers.ofString()).body();
            String url = Json.string(Json.parseObject(version.getBytes(StandardCharsets.UTF_8)), "webSocketDebuggerUrl");
            System.out.println("chromium: " + Json.string(Json.parseObject(version.getBytes(StandardCharsets.UTF_8)), "Browser"));
            assertThatThrownBy(() -> http.newWebSocketBuilder()
                            .header("Origin", "http://evil.example")
                            .buildAsync(URI.create(url), new WebSocket.Listener() {})
                            .get(5, TimeUnit.SECONDS))
                    .hasCauseInstanceOf(java.net.http.WebSocketHandshakeException.class);
        }
    }

    @Test
    void navigationHistoryAndReload() throws Exception {
        long start = System.nanoTime();
        assertThat(navigate("/a")).containsEntry("_kind", "RES").doesNotContainKey("netError");
        System.out.printf("browser.tab.navigate, loopback page: %d ms%n", TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - start));
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> assertThat(onlyTab()).containsEntry("title", "Page A").containsEntry("loading", false));
        navigate("/b");
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> assertThat(onlyTab())
                .containsEntry("url", base + "/b").containsEntry("title", "Page B").containsEntry("canGoBack", true).containsEntry("canGoForward", false));

        assertThat(rig.call(client, "browser.tab.back", Map.of())).containsEntry("_kind", "RES");
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> assertThat(onlyTab())
                .containsEntry("url", base + "/a").containsEntry("canGoForward", true));
        assertThat(rig.call(client, "browser.tab.forward", Map.of())).containsEntry("_kind", "RES");
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> assertThat(onlyTab())
                .containsEntry("url", base + "/b").containsEntry("canGoForward", false));
        assertThat(rig.call(client, "browser.tab.reload", Map.of())).containsEntry("_kind", "RES");
    }

    /**
     * TD-225, what no fake can show: the page's own world wraps the request, deskd's isolated world hears of a refusal
     * through the DOM, and its binding reaches deskd with Runtime never enabled. The page gets Chromium's own answer
     * either way. A Chromium with Widevine, as Chrome for Testing has, grants that one, and then there's nothing to tell.
     */
    @Test
    void aPageRefusedProtectedPlaybackMarksItsTabUntilItNavigates() throws Exception {
        navigate("/widevine");
        await().atMost(Duration.ofSeconds(10)).until(() -> String.valueOf(onlyTab().get("title")).matches("(refused|granted):.*"));
        String answer = (String) onlyTab().get("title");
        String id = (String) onlyTab().get("tabId");
        System.out.printf("com.widevine.alpha here: %s%n", answer);
        if (answer.startsWith("refused:")) {
            assertThat(answer).isEqualTo("refused:NotSupportedError:Unsupported keySystem or supportedConfigurations.");
            await().atMost(Duration.ofSeconds(10)).untilAsserted(() ->
                    assertThat(Json.object(onlyTab(), "protectedMedia")).containsEntry("keySystem", "com.widevine.alpha"));
        } else {
            Thread.sleep(1000);
            assertThat(onlyTab()).doesNotContainKey("protectedMedia");
        }
        // Nothing of deskd's has a name in the page's world, and the method keeps its own.
        assertThat(inPage(id, "Object.getOwnPropertyNames(window).filter(k => /^ma[0-9a-f]{16}/.test(k)).length")).isEqualTo("0");
        assertThat(inPage(id, "navigator.requestMediaKeySystemAccess.name + navigator.requestMediaKeySystemAccess.length"))
                .isEqualTo("requestMediaKeySystemAccess2");

        // A new page clears it, and is watched afresh: asked well after deskd is listening, twice, it's one mark.
        navigate("/fairplay-later");
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() ->
                assertThat(onlyTab()).containsEntry("url", base + "/fairplay-later").doesNotContainKey("protectedMedia"));
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> {
            assertThat(String.valueOf(onlyTab().get("title"))).matches("refused:\\S+ .*refused:.*");
            assertThat(onlyTab()).containsKey("protectedMedia");
        });
        Map<String, Object> seen = Json.object(onlyTab(), "protectedMedia");
        assertThat(seen.get("keySystem")).isIn("com.apple.fps", "com.microsoft.playready");
        Thread.sleep(500);
        assertThat(Json.object(onlyTab(), "protectedMedia")).isEqualTo(seen);

        // ClearKey is granted, so there's nothing to tell.
        navigate("/clearkey");
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> assertThat(onlyTab()).containsEntry("title", "granted:org.w3.clearkey"));
        Thread.sleep(500);
        assertThat(onlyTab()).doesNotContainKey("protectedMedia");
    }

    @Test
    void aFailedNavigationIsANetError() throws Exception {
        // .invalid never resolves, whatever the network here is doing.
        Map<String, Object> reply = rig.call(client, "browser.tab.navigate", Map.of("url", "http://no-such-host.invalid/"));
        assertThat(reply).containsEntry("_kind", "RES");
        assertThat((String) reply.get("netError")).startsWith("net::ERR_");
    }

    @Test
    void whatThePageDoesByItselfReachesSubscribers() throws Exception {
        client.subscribe("browser.tabs", null);
        snapshotWhere(tabs -> !tabs.isEmpty());
        navigate("/moves-itself");
        snapshotWhere(tabs -> (base + "/b").equals(tabs.get(0).get("url")) && "Page B".equals(tabs.get(0).get("title")) && Boolean.TRUE.equals(tabs.get(0).get("canGoBack")));
        navigate("/pushes");
        snapshotWhere(tabs -> (base + "/pushed").equals(tabs.get(0).get("url")) && "Pushed".equals(tabs.get(0).get("title")));
        // And when it's all settled, the topic is quiet.
        await().atMost(Duration.ofSeconds(5)).until(() -> rig.fake.pollFrame(client.handle(), Channels.EVENTS, 1000) == null);
    }

    /**
     * Regression, from a real stream check: titles came from /json/list, where Chromium escapes them for HTML, so a
     * client got Q&amp;amp;A. It also shows what FakeCdp models is still so: the list escapes, and the targets don't.
     */
    @Test
    void aTitleArrivesAsThePageSetItOnTheListAndTheTopic() throws Exception {
        client.subscribe("browser.tabs", null);
        snapshotWhere(tabs -> !tabs.isEmpty());
        // A title with nothing else happening is read only while someone is viewing.
        assertThat(rig.call(client, "browser.stream.set", Map.of("state", "warm"), null)).containsEntry("_kind", "RES");

        navigate("/tricky");
        snapshotWhere(tabs -> TRICKY_TITLE.equals(tabs.get(0).get("title")));
        assertThat(onlyTab()).containsEntry("title", TRICKY_TITLE);
        String id = (String) onlyTab().get("tabId");
        assertThat(titleInList(id)).isEqualTo(ESCAPED_TRICKY_TITLE);

        navigate("/retitles");
        snapshotWhere(tabs -> TITLE_BY_SCRIPT.equals(tabs.get(0).get("title")));
        assertThat(onlyTab()).containsEntry("title", TITLE_BY_SCRIPT);

        // Read once a second with no change is quiet, where each read used to flip it to the other form and back.
        await().atMost(Duration.ofSeconds(10)).until(() -> rig.fake.pollFrame(client.handle(), Channels.EVENTS, 1000) == null);
        assertThat(rig.fake.pollFrame(client.handle(), Channels.EVENTS, 2500)).isNull();
        assertThat(onlyTab()).containsEntry("title", TITLE_BY_SCRIPT);
    }

    /** Regression: the cut fell on the escaped text, so this page's title came out as 51 ampersands and a piece of one. */
    @Test
    void theCutIsOfWhatThePageSet() throws Exception {
        navigate("/ampersands");
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() ->
                assertThat(onlyTab()).containsEntry("title", "&".repeat(BrowserTabs.TITLE_CHARS)));
    }

    private String titleInList(String targetId) throws Exception {
        try (HttpClient http = HttpClient.newHttpClient()) {
            String body = http.send(
                    HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/json/list")).build(),
                    HttpResponse.BodyHandlers.ofString()).body();
            List<?> entries = (List<?>) Json.parseObject(("{\"list\":" + body + "}").getBytes(StandardCharsets.UTF_8)).get("list");
            return entries.stream()
                    .map(entry -> (Map<?, ?>) entry)
                    .filter(entry -> targetId.equals(entry.get("id")))
                    .map(entry -> (String) entry.get("title"))
                    .findFirst()
                    .orElseThrow();
        }
    }

    @SuppressWarnings("unchecked")
    private void snapshotWhere(java.util.function.Predicate<List<Map<String, Object>>> wanted) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15);
        List<Object> seen = new ArrayList<>();
        while (System.nanoTime() < deadline) {
            Frame frame = rig.fake.pollFrame(client.handle(), Channels.EVENTS, 500);
            if (frame != null && !frame.more()) {
                Map<String, Object> event = Json.parseObject(frame.payload());
                List<Map<String, Object>> tabs = (List<Map<String, Object>>) Json.object(event, "data").get("tabs");
                seen.add(tabs);
                if (wanted.test(tabs)) {
                    return;
                }
            }
        }
        throw new AssertionError("no snapshot like that came: " + seen);
    }

    @Test
    void tabsOpenActivateAndClose() throws Exception {
        String first = (String) onlyTab().get("tabId");
        String second = (String) rig.call(client, "browser.tab.open", Map.of("url", base + "/a")).get("tabId");
        assertThat(second).isNotNull().isNotEqualTo(first);
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> assertThat(tab(second)).containsEntry("title", "Page A"));
        assertThat(active()).isEqualTo(second);

        assertThat(rig.call(client, "browser.tab.activate", Map.of("tabId", first))).containsEntry("tabId", first);
        assertThat(active()).isEqualTo(first);

        String blank = (String) rig.call(client, "browser.tab.open", Map.of()).get("tabId");
        assertThat(tab(blank)).containsEntry("url", "about:blank");

        assertThat(rig.call(client, "browser.tab.close", Map.of("tabId", second))).containsEntry("_kind", "RES");
        assertThat(tabs()).hasSize(2);
        assertThat(rig.call(client, "browser.tab.close", Map.of("tabId", second))).containsEntry("code", "not_found");
    }

    @Test
    void closingTheLastTabLeavesChromiumRunning() throws Exception {
        String only = (String) onlyTab().get("tabId");
        assertThat(rig.call(client, "browser.tab.close", Map.of("tabId", only))).containsEntry("_kind", "RES");
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> assertThat(onlyTab()).containsEntry("url", "about:blank"));
        assertThat((String) onlyTab().get("tabId")).isNotEqualTo(only);
        assertThat(chromium.isAlive()).isTrue();
    }

    @Test
    void insertTextReachesThePageActiveOrNot() throws Exception {
        navigate("/form");
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> assertThat(onlyTab()).containsEntry("title", "form"));
        String form = (String) onlyTab().get("tabId");
        assertThat(rig.call(client, "browser.text.insert", Map.of("text", "héllo 😀"))).containsEntry("_kind", "RES");
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> assertThat(onlyTab()).containsEntry("title", "typed:héllo 😀"));

        String other = (String) rig.call(client, "browser.tab.open", Map.of("url", base + "/a")).get("tabId");
        await().atMost(Duration.ofSeconds(10)).until(() -> other.equals(active()));
        assertThat(rig.call(client, "browser.text.insert", Map.of("text", "!", "tabId", form))).containsEntry("_kind", "RES");
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> assertThat(tab(form)).containsEntry("title", "typed:héllo 😀!"));
    }

    /** The JDK's client sends a long text in several frames, so this shows Chromium takes those. */
    @Test
    void aLongInsertGoesThroughInSeveralFrames() throws Exception {
        navigate("/long");
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> assertThat(onlyTab()).containsEntry("title", "long"));
        int length = BrowserTabs.MAX_INSERT_CHARS;
        assertThat(rig.call(client, "browser.text.insert", Map.of("text", "x".repeat(length)))).containsEntry("_kind", "RES");
        await().atMost(Duration.ofSeconds(20)).untilAsserted(() -> assertThat(onlyTab()).containsEntry("title", "len:" + length));
    }

    @Test
    void aHostilePageStaysBounded() throws Exception {
        client.subscribe("browser.tabs", null);
        navigate("/hostile");
        // A 2 MB URL, and a 500 KB title changing 50 times a second.
        await().atMost(Duration.ofSeconds(15)).untilAsserted(() -> {
            Map<String, Object> tab = onlyTab();
            assertThat((String) tab.get("url")).hasSize(BrowserTabs.URL_CHARS);
            assertThat((String) tab.get("title")).hasSize(BrowserTabs.TITLE_CHARS);
        });
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(3);
        int pings = 0;
        while (System.nanoTime() < deadline) {
            client.sendJson(Channels.CTL, FrameKind.PING, ++pings, Map.of());
            assertThat(client.nextJson(Channels.CTL, FrameKind.PONG)).isNotNull();
            Thread.sleep(100);
        }
        Runtime runtime = Runtime.getRuntime();
        System.out.printf("hostile page: %d pings answered, heap in use %d MiB%n", pings, (runtime.totalMemory() - runtime.freeMemory()) / (1024 * 1024));
        assertThat(rig.call(client, "browser.tab.navigate", Map.of("url", base + "/a"))).containsEntry("_kind", "RES");
        await().atMost(Duration.ofSeconds(15)).untilAsserted(() -> assertThat(onlyTab()).containsEntry("title", "Page A"));
    }

    /**
     * LS-31 on a real Chromium: with the behavior left at {@code default}, Chromium still saves where its own setting says,
     * and deskd hears the download start and finish.
     */
    @Test
    @SuppressWarnings("unchecked")
    void aDownloadIsHeardFromStartToEndAndSavedWhereChromiumSavesThem() throws Exception {
        assertThat(client.subscribe(BrowserDownloads.TOPIC, null)).containsEntry("_kind", "RES");
        navigate("/a");
        rig.call(client, "browser.tab.navigate", Map.of("url", base + "/report"));
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(20);
        List<Object> seen = new ArrayList<>();
        Map<String, Object> done = null;
        while (done == null && System.nanoTime() < deadline) {
            Frame frame = rig.fake.pollFrame(client.handle(), Channels.EVENTS, 500);
            if (frame == null || frame.more()) {
                continue;
            }
            Map<String, Object> event = Json.parseObject(frame.payload());
            Object downloads = Json.object(event, "data").get("downloads");
            seen.add(downloads);
            if (downloads instanceof List<?> list && !list.isEmpty()
                    && "completed".equals(((Map<String, Object>) list.get(0)).get("state"))) {
                done = (Map<String, Object>) list.get(0);
            }
        }
        assertThat(done).as("snapshots: " + seen).isNotNull();
        assertThat(done).containsEntry("name", "report.txt").containsEntry("receivedBytes", 9000).doesNotContainKey("filesPath");
        assertThat(seen.toString()).doesNotContain("127.0.0.1");
        assertThat(dir.resolve("downloads").resolve("report.txt")).hasSize(9000);
    }

    @Test
    void aRestartOfDeskdDisturbsNothing() throws Exception {
        navigate("/form");
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> assertThat(onlyTab()).containsEntry("title", "form"));
        rig.call(client, "browser.text.insert", Map.of("text", "kept"));
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> assertThat(onlyTab()).containsEntry("title", "typed:kept"));
        String id = (String) onlyTab().get("tabId");

        rig.close();
        Path second = dir.resolve("second");
        java.nio.file.Files.createDirectories(second);
        rig = new BrowserRig(second, port, timing());
        client = rig.connect("cs-b");

        assertThat(onlyTab()).containsEntry("tabId", id).containsEntry("title", "typed:kept").containsEntry("url", base + "/form");
        assertThat(chromium.isAlive()).isTrue();
    }

    @Test
    void chromiumDyingIsUnavailableAndComingBackIsAFirstSnapshot() throws Exception {
        client.subscribe("browser.tabs", null);
        snapshotWhere(tabs -> !tabs.isEmpty());
        chromium.toHandle().descendants().forEach(ProcessHandle::destroyForcibly);
        chromium.destroyForcibly();
        chromium.waitFor(10, TimeUnit.SECONDS);
        await().atMost(Duration.ofSeconds(20)).untilAsserted(() -> assertThat(rig.call(client, "browser.tab.list", Map.of(), null))
                .containsEntry("code", "unavailable"));
        assertThat(rig.hub.hasSubscribers("browser.tabs")).isTrue();

        startChromium();
        snapshotWhere(tabs -> !tabs.isEmpty());
        assertThat(tabs()).isNotEmpty();
    }

    /**
     * What a fake can't show. Chromium really goes to ::1 if 127.0.0.1 is taken as it starts, stays there once that's
     * free, and takes 127.0.0.1 when it's restarted, here as desk-units would do it.
     */
    @Test
    void chromiumPushedOffThePortComesBackToItOnARestart() throws Exception {
        assertThat(tabs()).isNotEmpty();
        int uid = BrowserRig.ownUid();
        CdpListener table = new CdpListener(CdpListener.PROC_TCP, CdpListener.PROC_TCP6, port, uid);
        stopChromium();
        await().atMost(Duration.ofSeconds(20)).until(() -> table.get().kind() == CdpListener.Kind.NONE);

        try (ServerSocket holder = new ServerSocket()) {
            holder.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), port), 1);
            startChromium();
            await().atMost(Duration.ofSeconds(30)).until(() -> portAnswers("[::1]"));
        }
        assertThat(table.get()).isEqualTo(new CdpListener.Verdict(CdpListener.Kind.DISPLACED, uid));

        rig.units.onRequest(request -> {
            try {
                if (request.equals("stop desk-browser")) {
                    stopChromium();
                } else if (request.equals("start desk-browser")) {
                    startChromium();
                }
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            } catch (Exception e) {
                throw new IllegalStateException(e);
            }
        });
        assertThat(rig.call(client, "browser.tab.list", Map.of(), null)).containsEntry("code", "unavailable");
        await().atMost(Duration.ofSeconds(60)).untilAsserted(() -> assertThat(tabs()).isNotEmpty());
        assertThat(rig.units.requests()).containsSubsequence("stop desk-browser", "start desk-browser");
        assertThat(table.get().kind()).isEqualTo(CdpListener.Kind.TRUSTED);
    }

    @Test
    void hostileUrlsNeverGetThere() throws Exception {
        for (String url : List.of("javascript:document.title='no'", "file:///etc/passwd", "chrome://settings", "data:text/html,no", "about:blank")) {
            assertThat(rig.call(client, "browser.tab.navigate", Map.of("url", url)))
                    .containsEntry("code", "bad_request")
                    .containsEntry("details", Map.of("reason", "scheme"));
        }
        assertThat(onlyTab()).containsEntry("url", "about:blank");
    }

    @Test
    void onlyMemberPagesAreListed() throws Exception {
        // Chrome starts extensions' service workers and its own UI targets (browser_ui), as seen probing it.
        for (Map<String, Object> tab : tabs()) {
            assertThat((String) tab.get("url")).doesNotStartWith("chrome").doesNotStartWith("devtools");
        }
    }

    /**
     * What a teen sees, and what no fake can show: Chromium's own error page really is replaced, by a write in a world made
     * in it, and the Back button really goes back.
     */
    @Test
    void aTeensFilteredSiteGetsOurPageAndItsBackButtonWorks() throws Exception {
        teen();
        navigate("/a");
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> assertThat(onlyTab()).containsEntry("title", "Page A"));
        String tabId = (String) onlyTab().get("tabId");

        assertThat(rig.call(client, "browser.tab.navigate", Map.of("url", "https://filtered.test/")))
                .containsEntry("netError", "net::ERR_CONNECTION_REFUSED");

        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> assertThat(onlyTab())
                .containsEntry("title", FilteredPage.TITLE)
                .containsEntry("url", "https://filtered.test/"));
        assertThat(inPage(tabId, "document.body.innerText")).contains(FilteredPage.TITLE).contains(FilteredPage.LINE);
        assertThat(inPage(tabId, "String(document.querySelector('.error-code'))")).isEqualTo("null");
        assertThat(inPage(tabId, "location.href")).isEqualTo("chrome-error://chromewebdata/");
        assertThat(doh.questions()).extracting(FakeDoh.Question::name).containsExactly("filtered.test");

        // A real click, through the page's input path, as the stream sends it.
        Map<String, Object> box = Json.parseObject(inPage(tabId,
                "JSON.stringify(document.querySelector('button').getBoundingClientRect())").getBytes(StandardCharsets.UTF_8));
        double x = ((Number) box.get("x")).doubleValue() + ((Number) box.get("width")).doubleValue() / 2;
        double y = ((Number) box.get("y")).doubleValue() + ((Number) box.get("height")).doubleValue() / 2;
        for (String type : List.of("mousePressed", "mouseReleased")) {
            onPageSocket(tabId, "Input.dispatchMouseEvent", Map.of(
                    "type", type, "x", x, "y", y, "button", "left", "buttons", 1, "clickCount", 1));
        }
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> assertThat(onlyTab()).containsEntry("title", "Page A"));
    }

    @Test
    void aTeensSiteThatsOnlyDownKeepsChromiumsPage() throws Exception {
        teen();
        assertThat(rig.call(client, "browser.tab.navigate", Map.of("url", "https://open.test/")))
                .containsEntry("netError", "net::ERR_CONNECTION_REFUSED");
        String tabId = (String) onlyTab().get("tabId");

        await().atMost(Duration.ofSeconds(10)).until(() -> rig.module.filteredCounts().finished() == 1);
        assertThat(doh.questions()).extracting(FakeDoh.Question::name).containsExactly("open.test");
        assertThat(inPage(tabId, "document.querySelector('.error-code').textContent")).isEqualTo("ERR_CONNECTION_REFUSED");
        assertThat(onlyTab()).containsEntry("title", "open.test");
    }

    @Test
    void anAdultsFilteredSiteKeepsChromiumsPage() throws Exception {
        assertThat(rig.call(client, "browser.tab.navigate", Map.of("url", "https://filtered.test/")))
                .containsEntry("netError", "net::ERR_CONNECTION_REFUSED");
        String tabId = (String) onlyTab().get("tabId");

        await().during(Duration.ofSeconds(1)).atMost(Duration.ofSeconds(5)).until(() -> doh.questions().isEmpty());
        assertThat(inPage(tabId, "document.querySelector('.error-code').textContent")).isEqualTo("ERR_CONNECTION_REFUSED");
        assertThat(rig.module.filteredCounts().finished()).isZero();
    }
}
