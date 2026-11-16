package com.minimalistalliance.desk.deskd.browser;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

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
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.junit.jupiter.api.io.TempDir;

/**
 * The office's portal against a real Chromium, headless, that blocks the office by policy as a desk's does: the image's own
 * URLBlocklist ({@code image/recipe/.../ma.json}) with the staging names image 0.3.6 adds, put in through Chromium's policy test
 * page ({@code chrome://policy/test}), as a build machine has no /etc to write it to. It goes through the same URLBlocklist
 * handler and navigation throttle, and so the same {@code ERR_BLOCKED_BY_ADMINISTRATOR} page, as a managed policy file. The
 * portal is a page of a local server. Run it with a binary named:
 *
 * <pre>DESKD_CHROMIUM_BIN=/path/to/chrome ./mvnw -q -pl deskd verify -Dtest=none -Dsurefire.failIfNoSpecifiedTests=false -Dit.test=PortalRedirectChromiumIT</pre>
 *
 * <p>Every name but loopback resolves to nothing, so no request ever leaves the machine, the office's least of all: had the
 * policy not applied, the office would fail to resolve, and these tests would fail. Headless, with {@code --no-sandbox}, as
 * {@link ChromiumIT} runs.
 */
@EnabledIfEnvironmentVariable(named = "DESKD_CHROMIUM_BIN", matches = ".+")
class PortalRedirectChromiumIT {

    private static final String POLICY_FILE = "image/recipe/files/etc/chromium/policies/managed/ma.json";
    /** What image 0.3.6 adds for staging. */
    private static final List<String> STAGING_BLOCKED = List.of(
            "office.staging.minimalistalliance.com",
            "desk.staging.minimalistalliance.com",
            "api.staging.minimalistalliance.com",
            "auth.staging.minimalistalliance.com",
            "gw.staging.minimalistalliance.com");
    private static final String BLOCKED = "net::ERR_BLOCKED_BY_ADMINISTRATOR";
    private static final String ERROR_PAGE = "chrome-error://chromewebdata/";
    /** A link or a button over the page's top left, where a click lands. */
    private static final String TOP_LEFT = "position:fixed;left:0;top:0;width:200px;height:50px;display:block";

    @TempDir
    Path dir;

    private int port;
    private Process chromium;
    private HttpServer pages;
    /** The local server by its address. */
    private String base;
    /** The same server by another name: another site. */
    private String otherSite;
    private String portal;
    private BrowserRig rig;
    private TestClient client;
    private final List<String> portalReferers = new java.util.concurrent.CopyOnWriteArrayList<>();

    @BeforeEach
    void setUp() throws Exception {
        port = freePort();
        pages = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
        pages.createContext("/portal/", exchange -> {
            // What the portal hears of where a member came from: nothing, it should be.
            portalReferers.add(String.valueOf(exchange.getRequestHeaders().getFirst("Referer")));
            byte[] body = "<title>Portal</title>through".getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "text/html; charset=utf-8");
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        page("/start", "<title>start</title>start");
        page("/forums", "<title>Forums</title>forums");
        page("/links", "<title>links</title><a href=\"https://office.minimalistalliance.com/from-a-link?x=1\" style=\"" + TOP_LEFT
                + "\">office</a>");
        page("/staging-link", "<title>staging link</title><a href=\"https://desk.staging.minimalistalliance.com/\" style=\""
                + TOP_LEFT + "\">desk</a>");
        page("/redirect-link", "<title>redirect link</title><a href=\"/to-office\" style=\"" + TOP_LEFT + "\">away</a>");
        page("/opener", "<title>opener</title><button style=\"" + TOP_LEFT
                + "\" onclick=\"window.open('https://desk.minimalistalliance.com/from-window-open')\">open</button>");
        page("/frames", "<title>frames</title><iframe src=\"https://office.minimalistalliance.com/in-a-frame\"></iframe>");
        pages.createContext("/to-office", exchange -> {
            exchange.getResponseHeaders().set("Location", "https://office.minimalistalliance.com/from-a-redirect");
            exchange.sendResponseHeaders(302, -1);
            exchange.close();
        });
        pages.start();
        base = "http://127.0.0.1:" + pages.getAddress().getPort();
        otherSite = "http://localhost:" + pages.getAddress().getPort();
        portal = base + "/portal/";
        startChromium();
        await().atMost(Duration.ofSeconds(30)).until(this::debuggingPortAnswers);
        blockAsTheImageDoes();
        rig = new BrowserRig(dir, port, timing());
        rig.module.redirectOfficeTo(portal, () -> "prod");
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

    // ---- what a member does

    @Test
    void aLinkClickLandsOnThePortal() throws Exception {
        String tabId = open("/links", "links");

        clickTopLeft(tabId);

        awaitOn(tabId, portal, "Portal");
        // In place of the office's entry.
        assertThat(history(tabId)).endsWith(base + "/links", portal).noneMatch(PortalRedirect::isOffice);
        assertThat(rig.module.portalCounts().redirected()).isEqualTo(1);
        // From Chromium's error page, no referrer: the portal never learns the office's path, or the page before.
        assertThat(portalReferers).containsExactly("null");
    }

    @Test
    void aStagingOfficeLinkLandsOnThePortalOnceTheImageBlocksIt() throws Exception {
        String tabId = open("/staging-link", "staging link");

        clickTopLeft(tabId);

        awaitOn(tabId, portal, "Portal");
        assertThat(history(tabId)).endsWith(base + "/staging-link", portal).noneMatch(PortalRedirect::isOffice);
    }

    @Test
    void deskdsOwnNavigationGoesStraightThere() throws Exception {
        String tabId = open("/start", "start");

        Map<String, Object> typed = rig.call(client, "browser.tab.navigate", Map.of("url", "https://office.minimalistalliance.com/typed"));

        assertThat(typed).containsEntry("_kind", "RES").containsEntry("tabId", tabId).doesNotContainKey("netError");
        awaitOn(tabId, portal, "Portal");
        // Never a blocked page, and no entry for the office.
        assertThat(history(tabId)).endsWith(base + "/start", portal).noneMatch(PortalRedirect::isOffice);
        assertThat(rig.module.portalCounts()).isEqualTo(new PortalRedirect.Counts(0, 1, 0, 0, 0));
        assertThat(portalReferers).containsExactly("null");
        // A new tab too.
        Map<String, Object> opened = rig.call(client, "browser.tab.open", Map.of("url", "https://desk.minimalistalliance.com/new"));
        assertThat(opened).containsEntry("_kind", "RES");
        String newTab = (String) opened.get("tabId");
        awaitOn(newTab, portal, "Portal");
        assertThat(history(newTab)).endsWith(portal).noneMatch(PortalRedirect::isOffice);
    }

    @Test
    void windowOpenInANewTabLandsOnThePortal() throws Exception {
        String opener = open("/opener", "opener");

        clickTopLeft(opener);

        await().atMost(Duration.ofSeconds(15)).until(() -> tabs().size() == 2);
        String popup = tabs().stream().map(tab -> (String) tab.get("tabId")).filter(id -> !id.equals(opener)).findFirst().orElseThrow();
        awaitOn(popup, portal, "Portal");
        assertThat(history(popup)).containsExactly(portal);
        assertThat(tab(opener)).containsEntry("url", base + "/opener");
    }

    @Test
    void aServersRedirectToTheOfficeLandsOnThePortal() throws Exception {
        String tabId = open("/redirect-link", "redirect link");

        clickTopLeft(tabId);

        awaitOn(tabId, portal, "Portal");
        assertThat(history(tabId)).endsWith(base + "/redirect-link", portal).noneMatch(PortalRedirect::isOffice);

        // And typed, where the office only comes with the redirect: the reply says nothing went wrong, as the tab is on its way.
        Map<String, Object> typed = rig.call(client, "browser.tab.navigate", Map.of("url", base + "/to-office"));
        assertThat(typed).containsEntry("_kind", "RES").doesNotContainKey("netError");
        await().atMost(Duration.ofSeconds(15)).untilAsserted(() -> assertThat(history(tabId)).last().isEqualTo(portal));
        assertThat(rig.module.portalCounts().redirected()).isEqualTo(2);
    }

    @Test
    void backAfterARedirectLeavesAtOnceAndForwardIsThePortal() throws Exception {
        String tabId = open("/links", "links");
        clickTopLeft(tabId);
        awaitOn(tabId, portal, "Portal");

        assertThat(rig.call(client, "browser.tab.back", Map.of())).containsEntry("_kind", "RES");

        awaitOn(tabId, base + "/links", "links");
        Thread.sleep(1000);
        assertThat(tab(tabId)).containsEntry("url", base + "/links");
        assertThat(rig.call(client, "browser.tab.forward", Map.of())).containsEntry("_kind", "RES");
        awaitOn(tabId, portal, "Portal");
        assertThat(rig.module.portalCounts().redirected()).isEqualTo(1);
    }

    /**
     * A blocked office page left in the history while the portal was off, as one from a moment deskd wasn't connected is: Back
     * to it goes to the portal in its place, once, and the next Back leaves. Never a trap.
     */
    @Test
    void backToABlockedOfficePageThatStayedGoesOnOnceAndTheNextBackLeaves() throws Exception {
        rig.module.redirectOfficeTo("off", () -> "prod");
        String tabId = open("/links", "links");
        clickTopLeft(tabId);
        await().atMost(Duration.ofSeconds(15)).untilAsserted(() ->
                assertThat(tab(tabId)).containsEntry("url", "https://office.minimalistalliance.com/from-a-link?x=1"));
        assertThat(inPage(tabId, "location.href")).isEqualTo(ERROR_PAGE);
        navigate("/start");
        awaitOn(tabId, base + "/start", "start");
        rig.module.redirectOfficeTo(portal, () -> "prod");

        assertThat(rig.call(client, "browser.tab.back", Map.of())).containsEntry("_kind", "RES");

        awaitOn(tabId, portal, "Portal");
        assertThat(history(tabId)).endsWith(base + "/links", portal, base + "/start").noneMatch(PortalRedirect::isOffice);
        assertThat(rig.call(client, "browser.tab.back", Map.of())).containsEntry("_kind", "RES");
        awaitOn(tabId, base + "/links", "links");
        assertThat(rig.module.portalCounts().redirected()).isEqualTo(1);
    }

    /** Chromium blocks a frame by policy in a process of its own: an iframe target, whose page is the blocked one. */
    @Test
    void anOfficeFrameStaysBlockedInsideThePage() throws Exception {
        String tabId = open("/frames", "frames");

        String frame = await().atMost(Duration.ofSeconds(15)).until(this::officeFrame, java.util.Objects::nonNull);
        await().atMost(Duration.ofSeconds(15)).until(() -> ERROR_PAGE.equals(inPage(frame, "location.href")));
        Thread.sleep(1000);

        assertThat(inPage(frame, "location.href")).isEqualTo(ERROR_PAGE);
        // The policy's page as a frame shows it: no code, and the info icon by the frame's own message. The main frame's
        // signature (#main-content's icon) isn't there, so even a hook handed a frame couldn't read it as the policy's.
        assertThat(inPage(frame, "document.querySelector('.error-code').textContent.trim() + '|' + "
                + "(document.querySelector('#main-content .icon.icon-info') !== null) + '|' + "
                + "document.querySelector('#sub-frame-error .icon').className.trim()")).isEqualTo("|false|icon icon-info");
        assertThat(tab(tabId)).containsEntry("url", base + "/frames").containsEntry("title", "frames");
        assertThat(history(tabId)).last().isEqualTo(base + "/frames");
        assertThat(rig.module.portalCounts()).isEqualTo(new PortalRedirect.Counts(0, 0, 0, 0, 0));
    }

    /** The iframe target of the office, or null if there's none yet. */
    @SuppressWarnings("unchecked")
    private String officeFrame() throws Exception {
        try (RawCdp browser = RawCdp.connect(port)) {
            for (Object info : (List<Object>) browser.call("Target.getTargets", Map.of(), null).get("targetInfos")) {
                Map<String, Object> target = (Map<String, Object>) info;
                if ("iframe".equals(target.get("type")) && PortalRedirect.isOffice((String) target.get("url"))) {
                    return (String) target.get("targetId");
                }
            }
            return null;
        }
    }

    @Test
    void apiStaysChromiumsBlockedPage() throws Exception {
        String tabId = open("/start", "start");

        Map<String, Object> reply = rig.call(client, "browser.tab.navigate", Map.of("url", "https://api.minimalistalliance.com/v1/x"));

        assertThat(reply).containsEntry("_kind", "ERR").containsEntry("code", "forbidden").containsEntry("details", Map.of("reason", "blocked"));
        await().atMost(Duration.ofSeconds(10)).untilAsserted(() ->
                assertThat(tab(tabId)).containsEntry("url", "https://api.minimalistalliance.com/v1/x"));
        Thread.sleep(1000);
        assertThat(inPage(tabId, "location.href")).isEqualTo(ERROR_PAGE);
        // What deskd reads it by: no code shown, and the info icon.
        assertThat(inPage(tabId, "document.querySelector('.error-code').textContent.trim() + '|' + "
                + "(document.querySelector('#main-content .icon.icon-info') !== null)")).isEqualTo("|true");
        assertThat(rig.module.portalCounts()).isEqualTo(new PortalRedirect.Counts(0, 0, 0, 0, 0));
    }

    @Test
    void anotherSiteOpensNormally() throws Exception {
        String tabId = open("/start", "start");

        Map<String, Object> reply = rig.call(client, "browser.tab.navigate", Map.of("url", otherSite + "/forums"));

        assertThat(reply).containsEntry("_kind", "RES").doesNotContainKey("netError");
        awaitOn(tabId, otherSite + "/forums", "Forums");
        assertThat(rig.module.portalCounts()).isEqualTo(new PortalRedirect.Counts(0, 0, 0, 0, 0));
    }

    // ---- Chromium, the policy and the pages

    private void startChromium() throws IOException {
        chromium = new ProcessBuilder(
                        System.getenv("DESKD_CHROMIUM_BIN"),
                        "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
                        "--noerrdialogs", "--disable-session-crashed-bubble", "--disable-infobars", "--disable-breakpad",
                        "--password-store=basic", "--window-size=1280,800",
                        "--user-data-dir=" + dir.resolve("profile"),
                        "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=" + port,
                        // Nothing but loopback resolves, so nothing leaves the machine.
                        "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost",
                        "about:blank")
                .redirectErrorStream(true)
                .redirectOutput(ProcessBuilder.Redirect.appendTo(dir.resolve("chromium.log").toFile()))
                .start();
    }

    /** The image's URLBlocklist, and 0.3.6's staging names, through chrome://policy/test; then proof that it holds. */
    @SuppressWarnings("unchecked")
    private void blockAsTheImageDoes() throws Exception {
        Map<String, Object> policy = Json.parseObject(Files.readAllBytes(repoFile(POLICY_FILE)));
        List<String> blocklist = new ArrayList<>((List<String>) policy.get("URLBlocklist"));
        assertThat(blocklist).contains("office.minimalistalliance.com", "desk.minimalistalliance.com", "api.minimalistalliance.com");
        for (String name : STAGING_BLOCKED) {
            if (!blocklist.contains(name)) {
                blocklist.add(name);
            }
        }
        String policies = new String(Json.bytes(List.of(
                Map.of("name", "URLBlocklist", "level", 1, "scope", 1, "source", 4, "value", blocklist))), StandardCharsets.UTF_8);
        try (RawCdp browser = RawCdp.connect(port)) {
            String page = (String) browser.call("Target.createTarget", Map.of("url", "chrome://policy/test"), null).get("targetId");
            String session = (String) browser.call("Target.attachToTarget", Map.of("targetId", page, "flatten", true), null).get("sessionId");
            await().atMost(Duration.ofSeconds(15)).until(() -> "function complete".equals(browser.value(session,
                    "typeof chrome.send + ' ' + document.readyState")));
            browser.value(session, "chrome.send('setLocalTestPolicies', ['ma-it', " + new String(Json.bytes(policies), StandardCharsets.UTF_8)
                    + ", '']), 'sent'");
            browser.call("Target.closeTarget", Map.of("targetId", page), null);
            // It holds once a navigation to the office is the policy's.
            String probe = (String) browser.call("Target.createTarget", Map.of("url", "about:blank"), null).get("targetId");
            String probeSession = (String) browser.call("Target.attachToTarget", Map.of("targetId", probe, "flatten", true), null).get("sessionId");
            await().atMost(Duration.ofSeconds(15)).untilAsserted(() -> assertThat(browser.call(
                    "Page.navigate", Map.of("url", "https://office.staging.minimalistalliance.com/probe"), probeSession))
                    .as("the test policy holds").containsEntry("errorText", BLOCKED));
            browser.call("Target.closeTarget", Map.of("targetId", probe), null);
        }
    }

    private static Path repoFile(String relative) {
        for (Path at = Path.of("").toAbsolutePath(); at != null; at = at.getParent()) {
            if (Files.isRegularFile(at.resolve(relative))) {
                return at.resolve(relative);
            }
        }
        throw new IllegalStateException("no " + relative + " above the working directory");
    }

    private void page(String path, String html) {
        pages.createContext(path, exchange -> {
            if (!exchange.getRequestURI().getPath().equals(path)) {
                exchange.sendResponseHeaders(404, -1);
                exchange.close();
                return;
            }
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

    // ---- through deskd, as the Desk app

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> tabs() throws Exception {
        Map<String, Object> reply = rig.call(client, "browser.tab.list", Map.of(), null);
        assertThat(reply).containsEntry("_kind", "RES");
        return (List<Map<String, Object>>) reply.get("tabs");
    }

    private Map<String, Object> tab(String id) throws Exception {
        return tabs().stream().filter(tab -> id.equals(tab.get("tabId"))).findFirst().orElseThrow();
    }

    private Map<String, Object> navigate(String path) throws Exception {
        return rig.call(client, "browser.tab.navigate", Map.of("url", base + path));
    }

    /** The one tab, on this page. @return its id */
    private String open(String path, String title) throws Exception {
        assertThat(navigate(path)).containsEntry("_kind", "RES");
        List<Map<String, Object>> tabs = tabs();
        assertThat(tabs).hasSize(1);
        String tabId = (String) tabs.get(0).get("tabId");
        awaitOn(tabId, base + path, title);
        return tabId;
    }

    private void awaitOn(String tabId, String url, String title) {
        await().atMost(Duration.ofSeconds(15)).untilAsserted(() -> assertThat(tab(tabId)).containsEntry("url", url).containsEntry("title", title));
    }

    // ---- on the page's own debugging socket, from the test's side

    /** A real click at the top left, through the page's input path, as the stream sends it. */
    private void clickTopLeft(String tabId) throws Exception {
        for (String type : List.of("mousePressed", "mouseReleased")) {
            onPage(tabId, "Input.dispatchMouseEvent", Map.of("type", type, "x", 20, "y", 20, "button", "left", "buttons", 1, "clickCount", 1));
        }
    }

    /** The tab's history, as Chromium has it. */
    @SuppressWarnings("unchecked")
    private List<String> history(String tabId) throws Exception {
        Map<String, Object> result = onPage(tabId, "Page.getNavigationHistory", Map.of());
        List<String> urls = new ArrayList<>();
        for (Object entry : (List<Object>) result.get("entries")) {
            urls.add((String) ((Map<String, Object>) entry).get("url"));
        }
        return urls;
    }

    @SuppressWarnings("unchecked")
    private String inPage(String tabId, String expression) throws Exception {
        Map<String, Object> result = onPage(tabId, "Runtime.evaluate", Map.of("expression", expression, "returnByValue", true));
        return String.valueOf(((Map<String, Object>) result.get("result")).get("value"));
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> onPage(String tabId, String method, Map<String, Object> params) throws Exception {
        try (HttpClient http = HttpClient.newHttpClient()) {
            CompletableFuture<String> reply = new CompletableFuture<>();
            StringBuilder text = new StringBuilder();
            WebSocket socket = http.newWebSocketBuilder()
                    .buildAsync(URI.create("ws://127.0.0.1:" + port + "/devtools/page/" + tabId), new WebSocket.Listener() {
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
            Map<String, Object> answer = Json.parseObject(reply.get(10, TimeUnit.SECONDS).getBytes(StandardCharsets.UTF_8));
            socket.abort();
            assertThat(answer).as(method).doesNotContainKey("error");
            return (Map<String, Object>) answer.get("result");
        }
    }

    /** Chromium's browser-wide debugging socket, for setting the test up before deskd connects. Replies by id; events dropped. */
    private static final class RawCdp implements AutoCloseable {
        private final WebSocket socket;
        private final Map<Long, CompletableFuture<Map<String, Object>>> waiting;
        private final AtomicLong ids = new AtomicLong();

        private RawCdp(WebSocket socket, Map<Long, CompletableFuture<Map<String, Object>>> waiting) {
            this.socket = socket;
            this.waiting = waiting;
        }

        static RawCdp connect(int port) throws Exception {
            String version;
            try (HttpClient http = HttpClient.newHttpClient()) {
                version = http.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + "/json/version")).build(),
                        HttpResponse.BodyHandlers.ofString()).body();
            }
            String url = (String) Json.parseObject(version.getBytes(StandardCharsets.UTF_8)).get("webSocketDebuggerUrl");
            Map<Long, CompletableFuture<Map<String, Object>>> waiting = new ConcurrentHashMap<>();
            StringBuilder text = new StringBuilder();
            WebSocket socket = HttpClient.newHttpClient().newWebSocketBuilder()
                    .buildAsync(URI.create(url), new WebSocket.Listener() {
                        @Override
                        public java.util.concurrent.CompletionStage<?> onText(WebSocket webSocket, CharSequence data, boolean last) {
                            text.append(data);
                            if (last) {
                                try {
                                    Map<String, Object> message = Json.parseObject(text.toString().getBytes(StandardCharsets.UTF_8));
                                    if (message.get("id") instanceof Number id) {
                                        CompletableFuture<Map<String, Object>> reply = waiting.remove(id.longValue());
                                        if (reply != null) {
                                            reply.complete(message);
                                        }
                                    }
                                } catch (Exception e) {
                                    // Not a reply anyone waits for.
                                }
                                text.setLength(0);
                            }
                            webSocket.request(1);
                            return null;
                        }
                    })
                    .get(5, TimeUnit.SECONDS);
            return new RawCdp(socket, waiting);
        }

        @SuppressWarnings("unchecked")
        Map<String, Object> call(String method, Map<String, Object> params, String sessionId) throws Exception {
            long id = ids.incrementAndGet();
            CompletableFuture<Map<String, Object>> reply = new CompletableFuture<>();
            waiting.put(id, reply);
            Map<String, Object> message = new java.util.LinkedHashMap<>();
            message.put("id", id);
            message.put("method", method);
            message.put("params", params);
            if (sessionId != null) {
                message.put("sessionId", sessionId);
            }
            socket.sendText(new String(Json.bytes(message), StandardCharsets.UTF_8), true).get(5, TimeUnit.SECONDS);
            Map<String, Object> answer = reply.get(30, TimeUnit.SECONDS);
            assertThat(answer).as(method).doesNotContainKey("error");
            return (Map<String, Object>) answer.get("result");
        }

        @SuppressWarnings("unchecked")
        String value(String sessionId, String expression) throws Exception {
            Map<String, Object> result = call("Runtime.evaluate", Map.of("expression", expression, "returnByValue", true), sessionId);
            return String.valueOf(((Map<String, Object>) result.get("result")).get("value"));
        }

        @Override
        public void close() {
            socket.abort();
        }
    }
}
