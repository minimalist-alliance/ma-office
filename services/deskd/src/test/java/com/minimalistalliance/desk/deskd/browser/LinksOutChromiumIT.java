package com.minimalistalliance.desk.deskd.browser;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.FrameKind;
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
import java.nio.file.StandardCopyOption;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.junit.jupiter.api.io.TempDir;

/**
 * Links out against a real Chromium: a click on a {@code mailto:}, {@code tel:} or meeting link in a page, Chromium handing
 * it to {@code xdg-email} or {@code xdg-open}, the real stand-in ({@code desk-tools/xdg-open}) on Chromium's {@code PATH},
 * links.sock, and the {@code linkOut} a subscriber gets. What no fake can show: that Chromium runs the stand-in at all,
 * with what, and that a page gets one launch per input from the member, however often it tries.
 *
 * <pre>DESKD_CHROMIUM_BIN=/path/to/chrome ./mvnw -q -pl deskd verify -Dtest=none -Dsurefire.failIfNoSpecifiedTests=false -Dit.test=LinksOutChromiumIT</pre>
 *
 * <p>As on a desk, Chromium has no session bus (desk-browser.service gives it none): with one, Chromium asks the desktop's
 * portal to open the link before it runs xdg-open. The desk's policy that lets the listed schemes launch with no prompt
 * ({@code AutoLaunchProtocolsFromOrigins}) needs a managed policy in /etc, so the profile's own "always allow" for the test
 * page stands in for it; {@code mailto} needs neither. Headless, no sandbox, as {@link ChromiumIT}.
 */
@EnabledIfEnvironmentVariable(named = "DESKD_CHROMIUM_BIN", matches = ".+")
class LinksOutChromiumIT {

    private static final Path STAND_IN = Path.of("desk-tools", "xdg-open");
    /** Four links in a column, each 200 by 40 at the left, to click at x 20. */
    private static final String LINKS = "<title>links</title><style>a{position:fixed;left:0;width:200px;height:40px}</style>"
            + "<a href=\"mailto:a@example.com?subject=Hi%20there\" style=\"top:0\">mail</a>"
            + "<a href=\"tel:+15551234567\" style=\"top:50px\">call</a>"
            + "<a href=\"zoommtg://zoom.us/join?action=join&amp;confno=123\" style=\"top:100px\">zoom</a>"
            + "<a href=\"slack://open\" style=\"top:150px\">slack</a>";
    /** A page that tries a launch every 100 ms for 2 s, with no input, then a link to click. */
    private static final String LOOPS = "<title>loops</title>"
            + "<a href=\"mailto:clicked@example.com\" style=\"position:fixed;left:0;top:0;width:200px;height:40px\">mail</a>"
            + "<script>let n = 0; const t = setInterval(() => { location.href = 'mailto:loop' + n++ + '@example.com';"
            + " if (n === 20) { clearInterval(t); document.title = 'done'; } }, 100);</script>";

    @TempDir
    Path dir;

    private int port;
    private Process chromium;
    private HttpServer pages;
    private String base;
    private BrowserRig rig;
    private TestClient client;

    @BeforeEach
    void setUp() throws Exception {
        pages = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
        page("/links", LINKS);
        page("/loops", LOOPS);
        pages.start();
        base = "http://127.0.0.1:" + pages.getAddress().getPort();
        port = freePort();
        startChromium();
        await().atMost(Duration.ofSeconds(30)).until(this::debuggingPortAnswers);
        rig = new BrowserRig(dir, port, timing());
        // No repeat or rate limit to speak of here: this is about what Chromium does.
        assertThat(rig.module.serveLinks(dir.resolve("links.sock"), BrowserRig.ownUid(),
                new BrowserLinks.Timing(Duration.ofMillis(1), Duration.ofSeconds(1), 100), Clock.systemUTC(), System::nanoTime)).isTrue();
        client = rig.connect("cs-a");
        assertThat(client.subscribe(BrowserLinks.TOPIC, null)).containsEntry("_kind", "RES");
    }

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
        if (chromium != null) {
            chromium.toHandle().descendants().forEach(ProcessHandle::destroy);
            chromium.destroy();
            if (!chromium.waitFor(10, TimeUnit.SECONDS)) {
                chromium.toHandle().descendants().forEach(ProcessHandle::destroyForcibly);
                chromium.destroyForcibly();
            }
        }
    }

    /** The stand-in under both of the names Chromium runs, first on its PATH, and a profile that lets the page launch. */
    private void startChromium() throws IOException {
        Path bin = Files.createDirectories(dir.resolve("bin"));
        Files.copy(STAND_IN, bin.resolve("xdg-open"), StandardCopyOption.COPY_ATTRIBUTES);
        Files.createSymbolicLink(bin.resolve("xdg-email"), bin.resolve("xdg-open"));
        Path preferences = Files.createDirectories(dir.resolve("profile").resolve("Default")).resolve("Preferences");
        Files.writeString(preferences, "{\"protocol_handler\":{\"allowed_origin_protocol_pairs\":{\"" + base
                + "\":{\"tel\":true,\"zoommtg\":true,\"slack\":true}}}}");
        ProcessBuilder builder = new ProcessBuilder(
                        System.getenv("DESKD_CHROMIUM_BIN"),
                        "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
                        "--noerrdialogs", "--disable-session-crashed-bubble", "--disable-infobars", "--disable-breakpad",
                        "--password-store=basic", "--window-size=1280,800",
                        "--user-data-dir=" + dir.resolve("profile"),
                        "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=" + port,
                        "about:blank")
                .redirectErrorStream(true)
                .redirectOutput(ProcessBuilder.Redirect.appendTo(dir.resolve("chromium.log").toFile()));
        Map<String, String> env = builder.environment();
        env.remove("DBUS_SESSION_BUS_ADDRESS");
        env.remove("DISPLAY");
        env.remove("WAYLAND_DISPLAY");
        env.put("DBUS_SYSTEM_BUS_ADDRESS", "unix:path=/dev/null/no-system-bus");
        env.put("XDG_RUNTIME_DIR", Files.createDirectories(dir.resolve("runtime")).toString());
        env.put("PATH", bin + ":/usr/bin:/bin");
        env.put("MA_LINKS_SOCKET", dir.resolve("links.sock").toString());
        chromium = builder.start();
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
        try (ServerSocket socket = new ServerSocket(0)) {
            return socket.getLocalPort();
        }
    }

    /** Navigates the only tab there, and waits for its title: then deskd knows it's the tab on screen. */
    @SuppressWarnings("unchecked")
    private String open(String path, String title) throws Exception {
        assertThat(rig.call(client, "browser.tab.navigate", Map.of("url", base + path))).containsEntry("_kind", "RES");
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> {
            List<Map<String, Object>> tabs = (List<Map<String, Object>>) rig.call(client, "browser.tab.list", Map.of(), null).get("tabs");
            assertThat(tabs).hasSize(1);
            assertThat(tabs.get(0)).containsEntry("title", title).containsEntry("active", true);
        });
        List<Map<String, Object>> tabs = (List<Map<String, Object>>) rig.call(client, "browser.tab.list", Map.of(), null).get("tabs");
        return (String) tabs.get(0).get("tabId");
    }

    /** A left click as trusted input through the page's own input path, which is what the stream's input is. */
    private void click(String targetId, int y) throws Exception {
        for (String type : List.of("mousePressed", "mouseReleased")) {
            onPageSocket(targetId, "Input.dispatchMouseEvent", Map.of(
                    "type", type, "x", 20, "y", y, "button", "left", "buttons", type.equals("mousePressed") ? 1 : 0, "clickCount", 1));
        }
    }

    private void onPageSocket(String targetId, String method, Map<String, Object> params) throws Exception {
        try (HttpClient http = HttpClient.newHttpClient()) {
            CompletableFuture<String> reply = new CompletableFuture<>();
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

    @SuppressWarnings("unchecked")
    private Map<String, Object> nextLink() throws Exception {
        Map<String, Object> event = client.nextJson(Channels.EVENTS, FrameKind.EVT);
        assertThat(event).containsEntry("type", "linkOut");
        return (Map<String, Object>) event.get("data");
    }

    private List<Map<String, Object>> linksWithin(long millis) throws Exception {
        List<Map<String, Object>> links = new ArrayList<>();
        long deadline = System.currentTimeMillis() + millis;
        while (System.currentTimeMillis() < deadline) {
            var frame = rig.fake.pollFrame(client.handle(), Channels.EVENTS, 100);
            if (frame != null) {
                links.add(nextLinkFrom(frame.payload()));
            }
        }
        return links;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> nextLinkFrom(byte[] payload) throws Exception {
        Map<String, Object> event = Json.parseObject(payload);
        assertThat(event).containsEntry("type", "linkOut");
        return (Map<String, Object>) event.get("data");
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> droppedCounts() {
        Map<String, Object> browser = (Map<String, Object>) rig.module.health().get("browser");
        return (Map<String, Object>) ((Map<String, Object>) browser.get("links")).get("dropped");
    }

    @Test
    void aClickOnAMailtoTelOrMeetingLinkReachesTheOfficeNamingTheTab() throws Exception {
        String tab = open("/links", "links");

        click(tab, 20);
        assertThat(nextLink()).containsEntry("url", "mailto:a@example.com?subject=Hi%20there").containsEntry("scheme", "mailto")
                .containsEntry("displayText", "mailto:a@example.com?subject=Hi there").containsEntry("reason", "externalScheme")
                .containsEntry("tabId", tab).containsKey("at");

        click(tab, 70);
        assertThat(nextLink()).containsEntry("url", "tel:+15551234567").containsEntry("tabId", tab);

        click(tab, 120);
        assertThat(nextLink()).containsEntry("url", "zoommtg://zoom.us/join?action=join&confno=123").containsEntry("scheme", "zoommtg");

        // Chromium hands it out as it does the others, and deskd drops it: not on the list.
        click(tab, 170);
        await().atMost(Duration.ofSeconds(10)).until(() -> Long.valueOf(1).equals(droppedCounts().get("scheme")));
        assertThat(linksWithin(500)).isEmpty();
        // The page itself is still there: a link out doesn't navigate the tab.
        assertThat(open("/links", "links")).isEqualTo(tab);
    }

    @Test
    void aPageGetsOneLaunchPerInputFromTheMemberHoweverOftenItTries() throws Exception {
        String tab = open("/loops", "loops");
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> assertThat(
                rig.call(client, "browser.tab.list", Map.of(), null).toString()).contains("title=done"));
        // Twenty tries with no input: Chromium lets through at most the one it allows a page before any input.
        List<Map<String, Object>> unasked = linksWithin(1500);
        assertThat(unasked).hasSizeLessThanOrEqualTo(1);

        click(tab, 20);
        assertThat(nextLink()).containsEntry("url", "mailto:clicked@example.com").containsEntry("tabId", tab);
        assertThat(linksWithin(1000)).isEmpty();
    }
}
