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
import java.nio.file.Path;
import java.time.Duration;
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
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.junit.jupiter.api.io.TempDir;

/**
 * The phone view against a real Chromium, headless, at the desk's window size, with local pages: what a page really sees
 * while a phone looks, that a press of the mouse really is a finger to it, that deskd's binding is heard with no
 * {@code Runtime.enable}, that a pinch zooms, and that the tab keeps its place. A second DevTools client of the test's own
 * looks into the page and presses, as desk-rtc's pointer would. Run it as ChromiumIT is run:
 *
 * <pre>DESKD_CHROMIUM_BIN=/path/to/chrome ./mvnw -q -pl deskd verify -Dtest=none -Dsurefire.failIfNoSpecifiedTests=false -Dit.test=BrowserViewChromiumIT</pre>
 *
 * <p>It can't cover the X screen: where the view is drawn and that desk-rtc's X pointer is a finger too. Headless has no X.
 */
@EnabledIfEnvironmentVariable(named = "DESKD_CHROMIUM_BIN", matches = ".+")
class BrowserViewChromiumIT {

    private static final Map<String, Object> PHONE = Map.of("kind", "phone", "width", 390, "height", 844);
    /** min(1920 / 390, 1080 / 844), to two places, down. */
    private static final double SCALE = 1.27;
    private static final String PHONE_PAGE = "<meta name=viewport content=\"width=device-width, initial-scale=1\"><title>phone</title>"
            + "<style>body{margin:0}</style>"
            + "<input id=e type=email enterkeyhint=next style=\"position:absolute;left:20px;top:300px;width:200px;height:40px\">"
            + "<input id=d type=date style=\"position:absolute;left:20px;top:400px;width:200px;height:40px\">"
            + "<input id=r readonly style=\"position:absolute;left:20px;top:460px;width:200px;height:40px\">"
            + "<label for=e style=\"position:absolute;left:20px;top:520px;width:200px;height:40px\">Email</label>"
            + "<div contenteditable style=\"position:absolute;left:20px;top:580px;width:200px;height:40px\"><b>bold</b></div>"
            + "<div style=\"height:3000px\"></div>"
            + "<script>window.seen = [];"
            + "for (const t of ['touchstart', 'touchend', 'click', 'pointerdown']) {"
            + "  addEventListener(t, (e) => seen.push(t + ':' + (e.pointerType || '')"
            + "    + (e.clientX === undefined ? '' : ':' + Math.round(e.clientX) + ',' + Math.round(e.clientY))), true); }</script>";
    private static final String LONG_PAGE = "<meta name=viewport content=\"width=device-width, initial-scale=1\"><title>long</title>"
            + "<style>p{font:16px/1.5 sans-serif;margin:0 0 12px}</style>"
            + "<script>for (let i = 0; i < 300; i++) document.write('<p id=p' + i + '>' + i + ' ' + 'words in a line that wraps '.repeat(6) + '</p>');</script>";

    @TempDir
    Path dir;

    private int port;
    private Process chromium;
    private HttpServer pages;
    private String base;
    private BrowserRig rig;
    private TestClient phone;
    private Cdp cdp;

    @BeforeEach
    void setUp() throws Exception {
        port = freePort();
        chromium = new ProcessBuilder(
                        System.getenv("DESKD_CHROMIUM_BIN"),
                        "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
                        "--noerrdialogs", "--disable-infobars", "--disable-breakpad", "--password-store=basic",
                        "--window-size=1920,1080",
                        "--user-data-dir=" + dir.resolve("profile"),
                        "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=" + port,
                        "about:blank")
                .redirectErrorStream(true)
                .redirectOutput(ProcessBuilder.Redirect.appendTo(dir.resolve("chromium.log").toFile()))
                .start();
        pages = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
        page("/phone", PHONE_PAGE);
        page("/long", LONG_PAGE);
        pages.start();
        base = "http://127.0.0.1:" + pages.getAddress().getPort();
        await().atMost(Duration.ofSeconds(30)).until(this::debuggingPortAnswers);
        rig = new BrowserRig(dir, port, timing());
        rig.module.view().timing(new BrowserView.Timing(Duration.ofMillis(100), Duration.ofMillis(300), Duration.ofMillis(300), Duration.ofSeconds(5)));
        phone = rig.connect("cs-phone");
        cdp = Cdp.open(port);
    }

    private static BrowserTabs.Timing timing() {
        BrowserTabs.Timing real = BrowserTabs.Timing.DEFAULT;
        return new BrowserTabs.Timing(
                real.publishEvery(), Duration.ofMinutes(5), Duration.ofSeconds(5), Duration.ofSeconds(10), Duration.ofSeconds(10),
                real.navigate(), real.settle(), real.listEvery(), real.visibility(), real.restartEvery(), real.cdp());
    }

    @AfterEach
    void tearDown() throws Exception {
        if (cdp != null) {
            cdp.close();
        }
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

    // ---- what the page sees

    @Test
    void whileThePhoneLooksThePageIsOnAPhoneAndAfterwardsItsBackOnTheDesk() throws Exception {
        String tab = open("/phone");
        String desk = "[innerWidth, devicePixelRatio, matchMedia('(pointer: coarse)').matches, navigator.maxTouchPoints > 0]";
        assertThat(cdp.eval(tab, desk)).isEqualTo(List.of(1920, 1, false, false));

        phoneLooks();

        List<?> seen = (List<?>) cdp.eval(tab, "[innerWidth, innerHeight, screen.width, screen.height,"
                + " matchMedia('(pointer: coarse)').matches, matchMedia('(hover: none)').matches, navigator.maxTouchPoints,"
                + " screen.orientation.type, devicePixelRatio]");
        assertThat(seen.subList(0, 8)).isEqualTo(List.of(390, 844, 390, 844, true, true, 5, "portrait-primary"));
        assertThat(((Number) seen.get(8)).doubleValue()).isCloseTo(SCALE, within(0.001));
        // No user agent of a phone's: a site's sign-in, or its wall's clearance, can be bound to the one it saw.
        assertThat((String) cdp.eval(tab, "navigator.userAgent")).doesNotContain("Mobile");
        // Touch handlers on window come with a document made under the emulation: the page there now has none, the next has.
        assertThat(cdp.eval(tab, "'ontouchstart' in window")).isEqualTo(false);
        assertThat(rig.call(phone, "browser.tab.navigate", Map.of("tabId", tab, "url", base + "/phone?again"))).containsEntry("_kind", "RES");
        await().atMost(Duration.ofSeconds(10)).until(() -> Boolean.TRUE.equals(cdp.eval(tab, "'ontouchstart' in window")));

        rig.sessions.close("cs-phone", 1000, "closed_by_client");

        await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> assertThat(cdp.eval(tab, desk)).isEqualTo(List.of(1920, 1, false, false)));
    }

    /**
     * As the X pointer's press would be: Input's mouse is in the window's pixels, as X's is. Under touch emulation Chromium
     * never answers it (Chrome for Testing 158), so it's sent and not waited for.
     */
    @Test
    void aPressIsAFingerToThePageAtTheScreensScaleFromTheTopLeft() throws Exception {
        String tab = open("/phone");
        phoneLooks();
        cdp.fire(tab, "Input.dispatchMouseEvent", Map.of("type", "mousePressed", "x", 300, "y", 200, "button", "left", "clickCount", 1));
        cdp.fire(tab, "Input.dispatchMouseEvent", Map.of("type", "mouseReleased", "x", 300, "y", 200, "button", "left", "clickCount", 1));

        String at = Math.round(300 / SCALE) + "," + Math.round(200 / SCALE);
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> assertThat(seen(tab))
                .contains("pointerdown:touch:" + at, "click:touch:" + at)
                .anyMatch(event -> event.startsWith("touchstart:"))
                .anyMatch(event -> event.startsWith("touchend:"))
                .noneMatch(event -> event.startsWith("pointerdown:mouse")));
    }

    // ---- the keyboard's two questions

    @Test
    void aFocusedFieldIsToldWithNoRuntimeEnable() throws Exception {
        String tab = open("/phone");
        assertThat(phone.subscribe("browser.view", null)).containsEntry("_kind", "RES");
        // A desk's kiosk window has X's focus. Headless has none, and with none a page's focus events don't fire.
        cdp.call(tab, "Emulation.setFocusEmulationEnabled", Map.of("enabled", true));
        phoneLooks();
        awaitView(view -> "phone".equals(view.get("mode")));

        cdp.eval(tab, "document.getElementById('e').focus(), 1");

        Map<String, Object> view = awaitView(v -> v.get("field") != null);
        Map<?, ?> field = (Map<?, ?>) view.get("field");
        assertThat(field.get("kind")).isEqualTo("email_address");
        assertThat(field.get("enterKey")).isEqualTo("next");
        Map<?, ?> box = (Map<?, ?>) field.get("box");
        assertThat(((Number) box.get("x")).doubleValue()).isCloseTo(65535 * 20 * SCALE / 1920, within(60.0));
        assertThat(((Number) box.get("y")).doubleValue()).isCloseTo(65535 * 300 * SCALE / 1080, within(60.0));

        // A date isn't typed into, so there's no keyboard for it.
        cdp.eval(tab, "document.getElementById('d').focus(), 1");
        awaitView(v -> "phone".equals(v.get("mode")) && v.get("field") == null);

        cdp.eval(tab, "document.querySelector('[contenteditable]').focus(), 1");
        awaitView(v -> v.get("field") instanceof Map<?, ?> f && "multiline".equals(f.get("kind")));

        cdp.eval(tab, "document.activeElement.blur(), 1");
        awaitView(v -> "phone".equals(v.get("mode")) && v.get("field") == null);
    }

    @Test
    void fieldAtFindsWhatATapWouldFocus() throws Exception {
        open("/phone");
        phoneLooks();
        assertThat(at(120, 320)).isEqualTo(Map.of("kind", "email_address", "enterKey", "next"));
        assertThat(at(120, 540)).isEqualTo(Map.of("kind", "email_address", "enterKey", "next"));
        assertThat(at(30, 600)).containsEntry("kind", "multiline");
        assertThat(at(120, 420)).isNull();
        assertThat(at(120, 480)).isNull();
        assertThat(at(300, 700)).isNull();
    }

    // ---- a pinch, and the place kept

    @Test
    void aPinchZoomsInAroundItsPoint() throws Exception {
        String tab = open("/phone");
        phoneLooks();
        assertThat(((Number) cdp.eval(tab, "visualViewport.scale")).doubleValue()).isEqualTo(1.0);

        Map<String, Object> reply = rig.call(phone, "browser.pinch", Map.of("x", normX(195), "y", normY(422), "scale", 2));

        assertThat(reply).containsEntry("_kind", "RES");
        List<?> after = (List<?>) cdp.eval(tab, "[visualViewport.scale, visualViewport.offsetLeft, visualViewport.offsetTop]");
        double scale = ((Number) after.get(0)).doubleValue();
        assertThat(scale).isCloseTo(2.0, within(0.2));
        // The point under the fingers stays put: (195, 422) of the view is the page's (left + 195 / scale, top + 422 / scale).
        assertThat(((Number) after.get(1)).doubleValue() + 195 / scale).isCloseTo(195, within(25.0));
        assertThat(((Number) after.get(2)).doubleValue() + 422 / scale).isCloseTo(422, within(25.0));
    }

    @Test
    void aPinchOnTheDesksOwnViewZoomsToo() throws Exception {
        String tab = open("/phone");
        // (600, 400) of the 1920x1080 screen, which is the page's own pixels in the desk's view.
        Map<String, Object> reply = rig.call(phone, "browser.pinch", Map.of(
                "x", (int) Math.round(65535.0 * 600 / 1920), "y", (int) Math.round(65535.0 * 400 / 1080), "scale", 2));

        assertThat(reply).containsEntry("_kind", "RES");
        List<?> after = (List<?>) cdp.eval(tab, "[visualViewport.scale, visualViewport.offsetLeft, visualViewport.offsetTop]");
        assertThat(((Number) after.get(0)).doubleValue()).isCloseTo(2.0, within(0.2));
        assertThat(((Number) after.get(1)).doubleValue()).isCloseTo(300, within(25.0));
        assertThat(((Number) after.get(2)).doubleValue()).isCloseTo(200, within(25.0));
    }

    @Test
    void theTabOnScreenKeepsItsPlaceBothWays() throws Exception {
        String tab = open("/long");
        cdp.eval(tab, "document.getElementById('p120').scrollIntoView(), 1");
        assertThat(((Number) cdp.eval(tab, "document.getElementById('p120').getBoundingClientRect().top")).doubleValue()).isCloseTo(0, within(2.0));

        phoneLooks();
        await().atMost(Duration.ofSeconds(10)).until(() -> ((Number) cdp.eval(tab, "innerWidth")).intValue() == 390);
        // At 390 wide a paragraph is several times as tall, so a page that kept its scroll offset would be far away.
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> assertThat(
                ((Number) cdp.eval(tab, "document.getElementById('p120').getBoundingClientRect().top")).doubleValue())
                .isBetween(-40.0, 60.0));

        rig.sessions.close("cs-phone", 1000, "closed_by_client");
        await().atMost(Duration.ofSeconds(10)).until(() -> ((Number) cdp.eval(tab, "innerWidth")).intValue() == 1920);
        await().atMost(Duration.ofSeconds(5)).untilAsserted(() -> assertThat(
                ((Number) cdp.eval(tab, "document.getElementById('p120').getBoundingClientRect().top")).doubleValue())
                .isBetween(-40.0, 60.0));
    }

    // ---- helpers

    private List<String> seen(String tab) throws Exception {
        return ((List<?>) cdp.eval(tab, "seen")).stream().map(String::valueOf).toList();
    }

    private void phoneLooks() throws Exception {
        assertThat(rig.call(phone, "browser.stream.set", Map.of("state", "live"), null)).containsEntry("state", "live");
        assertThat(rig.call(phone, "desk.attention.set", Map.of("seen", true, "device", PHONE), null)).containsEntry("_kind", "RES");
        await().atMost(Duration.ofSeconds(10)).until(() -> "phone".equals(rig.module.view().state().get("mode")));
    }

    /** Opens the page in the one tab there is, and attaches the test's own client to it. */
    private String open(String path) throws Exception {
        Map<String, Object> list = rig.call(phone, "browser.tab.list", Map.of(), null);
        String tabId = (String) ((Map<?, ?>) ((List<?>) list.get("tabs")).get(0)).get("tabId");
        assertThat(rig.call(phone, "browser.tab.navigate", Map.of("tabId", tabId, "url", base + path))).containsEntry("_kind", "RES");
        cdp.attach(tabId);
        await().atMost(Duration.ofSeconds(10)).until(() -> "complete".equals(cdp.eval(tabId, "document.readyState")));
        return tabId;
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> at(double viewX, double viewY) throws Exception {
        Map<String, Object> reply = rig.call(phone, "browser.field.at", Map.of("x", normX(viewX), "y", normY(viewY)), null);
        assertThat(reply).containsEntry("_kind", "RES");
        return (Map<String, Object>) reply.get("field");
    }

    /** A point in the phone's own CSS pixels as a client sends it, normalized to the 1920x1080 picture. */
    private static int normX(double viewX) {
        return (int) Math.round(65535 * viewX * SCALE / 1920);
    }

    private static int normY(double viewY) {
        return (int) Math.round(65535 * viewY * SCALE / 1080);
    }

    private Map<String, Object> awaitView(Predicate<Map<String, Object>> wanted) throws Exception {
        long deadline = System.nanoTime() + Duration.ofSeconds(10).toNanos();
        while (System.nanoTime() < deadline) {
            Frame frame = rig.fake.pollFrame(phone.handle(), Channels.EVENTS, 100);
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
            Map<String, Object> attached = send(null, "Target.attachToTarget", Map.of("targetId", targetId, "flatten", true));
            sessions.put(targetId, (String) attached.get("sessionId"));
        }

        Map<String, Object> call(String targetId, String method, Map<String, Object> params) throws Exception {
            return send(sessions.get(targetId), method, params);
        }

        /** Sends, and doesn't wait for a reply. */
        void fire(String targetId, String method, Map<String, Object> params) throws Exception {
            Map<String, Object> message = new LinkedHashMap<>();
            message.put("id", ids.incrementAndGet());
            message.put("method", method);
            message.put("params", params);
            message.put("sessionId", sessions.get(targetId));
            socket.sendText(new String(Json.bytes(message), StandardCharsets.UTF_8), true).get(10, TimeUnit.SECONDS);
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
