package com.minimalistalliance.desk.deskd.browser;

import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.browser.minified.LocationBlank;
import com.minimalistalliance.desk.deskd.browser.minified.MinifiedModule;
import com.minimalistalliance.desk.deskd.browser.minified.MinifiedSwitch;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.io.IOException;
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
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.junit.jupiter.api.io.TempDir;

/**
 * Not a test: the harness that scores deskd's own simplified view on the 42 real pages of the prototype's run
 * ({@code services/deskd/real-sites/README.md}). deskd's real walker, distiller and MDoc builder, through the same RPCs a
 * client uses, against a real headless Chromium on the public web. Its name matches neither surefire's nor failsafe's
 * patterns, so no build runs it; it runs only when asked for by name, with {@code MINIFIED_RUN_OUT} set.
 *
 * <p>Per page: navigate, wait for the load, scroll the real page through 8 screens and back from the harness's own
 * debugging socket (as the prototype's run did, so lazy content is there; {@code MINIFIED_RUN_NO_SCROLL=1} leaves the
 * page as a member's tab is), then {@code browser.minified.get}; once deskd's own pre-scroll of the page has ended,
 * {@code get} again, as a member's client does when the topic says the view changed; and {@code browser.minified.island}
 * for the main island. {@code get}'s result, as a client gets it, goes to
 * {@code PNN.mdoc.json}, which the Product Designer's check reads as it is; the rest (timings, the island's reply, the
 * tab) to {@code PNN.run.json}. One page at a time, 4 s apart, signed out, nothing clicked, no consent answered: the
 * switch has {@code consent-reject} and {@code media-actions} off.
 *
 * <p>With {@code MINIFIED_RUN_SHOTS=1}, for a rater: the images the view names, as {@code browser.minified.image} gives
 * them ({@code PNN.img/}), and the real page's first three screens of 1800 px at half size ({@code PNN.orig-N.jpg}),
 * taken after the view, with any place the page names blanked by the same generic rule first.
 */
@EnabledIfEnvironmentVariable(named = "MINIFIED_RUN_OUT", matches = ".+")
@EnabledIfEnvironmentVariable(named = "DESKD_CHROMIUM_BIN", matches = ".+")
class MinifiedRealSites {

    private static final Duration BETWEEN_PAGES = Duration.ofSeconds(4);
    private static final Duration LOAD_WAIT = Duration.ofSeconds(45);
    private static final Duration VIEW_WAIT = Duration.ofSeconds(25);
    private static final Duration PRESCROLL_WAIT = Duration.ofSeconds(6);

    @TempDir
    Path dir;

    private int cdpPort;
    private Process chromium;
    private BrowserRig rig;
    private TestClient client;
    private final AtomicLong ids = new AtomicLong(1);

    @Test
    @SuppressWarnings("unchecked")
    void run() throws Exception {
        Path out = Path.of(System.getenv("MINIFIED_RUN_OUT"));
        Files.createDirectories(out);
        Path here = Path.of("real-sites");
        Path sites = Path.of(env("MINIFIED_RUN_SITES", here.resolve("sites.json").toString()));
        Set<String> only = Set.of(env("MINIFIED_RUN_ONLY", "").split(","));
        boolean shots = "1".equals(System.getenv("MINIFIED_RUN_SHOTS"));
        List<Map<String, Object>> pages = (List<Map<String, Object>>) Json.parseObject(
                ("{\"pages\":" + Files.readString(sites) + "}").getBytes(StandardCharsets.UTF_8)).get("pages");

        cdpPort = freePort();
        startChromium();
        try {
            await().atMost(Duration.ofSeconds(30)).until(this::debuggingPortAnswers);
            rig = new BrowserRig(dir, cdpPort, BrowserRig.timing(Duration.ofMillis(250), Duration.ofMinutes(5)));
            rig.module.enableMinified(dir, Clock.systemUTC(), new MinifiedModule.Timing(
                    Duration.ofSeconds(10), Duration.ofSeconds(8), Duration.ofSeconds(20), Duration.ofMillis(24),
                    Duration.ofMillis(100), Duration.ofSeconds(30)), switchFor(MinifiedSwitch.fixed(true, false, false)));
            client = rig.connect("cs-a");
            String tabId = null;
            for (Map<String, Object> page : pages) {
                String id = (String) page.get("id");
                if (!(only.size() == 1 && only.contains("")) && !only.contains(id)) {
                    continue;
                }
                System.out.println("== " + id + " " + page.get("url"));
                Map<String, Object> result = new LinkedHashMap<>();
                result.put("id", id);
                result.put("url", page.get("url"));
                try {
                    tabId = visit(tabId, (String) page.get("url"), result, shots ? out.resolve(id) : null);
                } catch (Exception e) {
                    result.put("error", e.getClass().getSimpleName() + ": " + String.valueOf(e.getMessage()));
                }
                // get's result as a client gets it, without the test client's own frame fields.
                Map<String, Object> view = new LinkedHashMap<>();
                if (result.remove("get") instanceof Map<?, ?> reply) {
                    reply.forEach((k, v) -> {
                        if (!String.valueOf(k).startsWith("_")) {
                            view.put(String.valueOf(k), v);
                        }
                    });
                } else {
                    view.put("error", String.valueOf(result.get("error")));
                }
                // Never where this machine is (a store or delivery town, a ZIP): blanked by a generic rule.
                Files.write(out.resolve(id + ".mdoc.json"), LocationBlank.blank(Json.bytes(view)));
                Files.write(out.resolve(id + ".run.json"), LocationBlank.blank(Json.bytes(result)));
                Thread.sleep(BETWEEN_PAGES);
            }
        } finally {
            if (rig != null) {
                rig.close();
            }
            stopChromium();
        }
    }

    /** {@code MINIFIED_RUN_NO_PRESCROLL=1}: deskd's own pre-scroll off, as its {@code prescroll-off} switch has it. */
    private static MinifiedSwitch switchFor(MinifiedSwitch base) {
        if (!"1".equals(System.getenv("MINIFIED_RUN_NO_PRESCROLL"))) {
            return base;
        }
        return new MinifiedSwitch() {
            @Override
            public boolean on() {
                return base.on();
            }

            @Override
            public boolean mediaActions() {
                return base.mediaActions();
            }

            @Override
            public boolean consentReject() {
                return base.consentReject();
            }

            @Override
            public boolean prescroll() {
                return false;
            }
        };
    }

    @SuppressWarnings("unchecked")
    private String visit(String tabId, String url, Map<String, Object> result, Path shots) throws Exception {
        Map<String, Object> params = new LinkedHashMap<>();
        params.put("url", url);
        if (tabId != null) {
            params.put("tabId", tabId);
        }
        long started = System.nanoTime();
        Map<String, Object> nav = rig.call(client, "browser.tab.navigate", params);
        result.put("navigate", nav);
        if (!"RES".equals(nav.get("_kind"))) {
            return tabId;
        }
        String tab = (String) nav.get("tabId");
        long deadline = System.nanoTime() + LOAD_WAIT.toNanos();
        while (System.nanoTime() < deadline && Boolean.TRUE.equals(tab(tab).get("loading"))) {
            Thread.sleep(500);
        }
        result.put("loadMs", (System.nanoTime() - started) / 1_000_000);
        Thread.sleep(2000);
        // The real page through 8 screens and back, as the prototype's run did, from the harness's own socket.
        // MINIFIED_RUN_NO_SCROLL=1 leaves the page as a member's tab is, which nothing scrolls before the view.
        if (!"1".equals(System.getenv("MINIFIED_RUN_NO_SCROLL"))) {
            result.put("scroll", inPage(tab, "(async () => { for (let i = 0; i < 8; i++) { scrollBy(0, innerHeight);"
                    + " await new Promise(r => setTimeout(r, 350)); } scrollTo(0, 0); await new Promise(r => setTimeout(r, 300));"
                    + " return document.documentElement.scrollHeight; })()"));
        }
        Thread.sleep(1500);
        Map<String, Object> view = null;
        long viewStarted = System.nanoTime();
        long viewDeadline = viewStarted + VIEW_WAIT.toNanos();
        while (System.nanoTime() < viewDeadline) {
            view = rig.call(client, "browser.minified.get", Map.of("tabId", tab), null);
            Object shown = view.get("view");
            // A view of a document still loading (a page that went on to another address) is a client's first look, not
            // its last: the client gets the loaded one from the topic, so the harness asks again until the page is loaded.
            boolean stillLoading = "simplified".equals(shown) && view.get("mdoc") instanceof Map<?, ?> m && Boolean.TRUE.equals(m.get("loading"));
            if (("simplified".equals(shown) && !stillLoading) || "stream".equals(shown) || !"RES".equals(view.get("_kind"))) {
                break;
            }
            Thread.sleep(500);
        }
        result.put("getMs", (System.nanoTime() - viewStarted) / 1_000_000);
        // deskd's pre-scroll starts once a client has the view, and what it brings in is the view's next look, which a
        // member's client gets from the topic: the harness waits for it to end and asks again, as that client would.
        if (view != null && "simplified".equals(view.get("view"))) {
            long until = System.nanoTime() + PRESCROLL_WAIT.toNanos();
            Map<String, Object> pre = rig.module.minified().lastPrescroll(tab);
            while (System.nanoTime() < until && (pre.isEmpty() || "pending".equals(pre.get("outcome")))) {
                Thread.sleep(100);
                pre = rig.module.minified().lastPrescroll(tab);
            }
            result.put("prescroll", pre);
            if (pre.get("steps") instanceof Number steps && steps.intValue() > 0) {
                result.put("firstView", Map.of("rev", String.valueOf(view.get("rev")), "blocks",
                        view.get("mdoc") instanceof Map<?, ?> m && m.get("blocks") instanceof List<?> b ? b.size() : 0));
                Thread.sleep(500);
                Map<String, Object> again = rig.call(client, "browser.minified.get", Map.of("tabId", tab), null);
                if ("RES".equals(again.get("_kind")) && again.get("view") != null) {
                    view = again;
                }
            }
        }
        result.put("get", view);
        result.put("judged", rig.module.minified().lastJudged(tab));
        Map<String, Object> entry = tab(tab);
        result.put("tab", Map.of("url", String.valueOf(entry.get("url")), "title", String.valueOf(entry.get("title"))));
        if (view != null && view.get("mdoc") instanceof Map<?, ?> mdoc) {
            Map<String, Object> island = mainIsland((Map<String, Object>) mdoc);
            if (island != null && island.get("island") != null) {
                result.put("island", rig.call(client, "browser.minified.island",
                        Map.of("tabId", tab, "islandId", island.get("island")), null));
            }
            if (shots != null) {
                result.put("images", saveImages(tab, (Map<String, Object>) mdoc, shots));
            }
        }
        if (shots != null) {
            try {
                result.put("shots", shoot(tab, shots));
            } catch (Exception e) {
                result.put("shots", "failed: " + e.getClass().getSimpleName());
            }
        }
        return tab;
    }

    // ---- For a rater (MINIFIED_RUN_SHOTS=1)

    private static final int MAX_IMAGES = 120;

    /** Every image the view names, as the renderer would ask for it; {@code index.json} maps ids to files. */
    private Map<String, Object> saveImages(String tab, Map<String, Object> mdoc, Path base) throws Exception {
        Set<String> ids = new LinkedHashSet<>();
        imageIds(mdoc, ids);
        Path dir = base.resolveSibling(base.getFileName() + ".img");
        Files.createDirectories(dir);
        Map<String, Object> index = new LinkedHashMap<>();
        Map<String, Integer> reasons = new LinkedHashMap<>();
        int missing = 0;
        for (String id : ids) {
            if (index.size() + missing >= MAX_IMAGES) {
                break;
            }
            Map<String, Object> reply = rig.call(client, "browser.minified.image", Map.of("tabId", tab, "imageId", id), null);
            if (reply.get("data") instanceof String data && reply.get("mime") instanceof String mime) {
                String file = "i" + index.size() + "." + mime.substring(mime.indexOf('/') + 1);
                Files.write(dir.resolve(file), Base64.getDecoder().decode(data));
                index.put(id, Map.of("file", file, "mime", mime));
            } else {
                missing++;
                Object details = reply.get("details") instanceof Map<?, ?> d ? d.get("reason") : null;
                reasons.merge(reply.get("code") + (details == null ? "" : "/" + details), 1, Integer::sum);
            }
        }
        Files.write(dir.resolve("index.json"), Json.bytes(index));
        return Map.of("named", ids.size(), "saved", index.size(), "missing", missing, "why", reasons);
    }

    @SuppressWarnings("unchecked")
    private static void imageIds(Object node, Set<String> ids) {
        if (node instanceof Map<?, ?> map) {
            for (Map.Entry<?, ?> e : map.entrySet()) {
                String key = String.valueOf(e.getKey());
                if (e.getValue() instanceof String v && (key.equals("image") || key.equals("icon") || key.equals("poster"))) {
                    ids.add(v);
                } else {
                    imageIds(e.getValue(), ids);
                }
            }
        } else if (node instanceof List<?> list) {
            list.forEach(v -> imageIds(v, ids));
        }
    }

    /** The real page's text, with whatever says where this machine is blanked: LocationBlank's rule, in the page. */
    private static final String STATES = "A[LKZR]|C[AOT]|D[EC]|FL|GA|HI|I[DLNA]|K[SY]|LA|M[EDAINSOT]|N[EVHJMYCD]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[TA]|W[AVIY]";
    private static final String BLANK_PLACES = "(() => { const B = '\u2587\u2587\u2587';"
            + " const led = /((?:deliver(?:ing)? to|ship(?:ping|s)? to|your (?:location|store|zip)|my store|(?:in|out of) stock (?:in|at)"
            + "|not sold (?:in|at)|available (?:in|at|near)|pick ?up (?:in|at)|stores? near|near you in|weather (?:in|for)|forecast for))"
            + " ([A-Za-z0-9][\\w.'-]*(?:,? [A-Za-z0-9][\\w.'-]*){0,3})/gi;"
            + " const ip = /[^\\n]{0,80}from your (?:ip address|ip|location)/gi;"
            + " const place = /\\b(?:[A-Z][a-z]+(?: [A-Z][a-z]+){0,3}, ){0,2}[A-Z][a-z]+(?: [A-Z][a-z]+){0,2}, (?:" + STATES + ")(?: \\d{5}(?:-\\d{4})?)?\\b/g;"
            + " const zip = /\\b[A-Z][a-z]+ \\d{5}(?:-\\d{4})?\\b/g; const bare = /^\\s*\\d{5}(?:-\\d{4})?\\s*$/;"
            + " const fix = (t) => bare.test(t) ? B : t.replace(led, '$1 ' + B).replace(ip, B).replace(place, B).replace(zip, B);"
            + " let n = 0; const walk = (root) => { const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);"
            + " for (let x = w.nextNode(); x; x = w.nextNode()) { if (x.parentElement && x.parentElement.closest('pre,code')) continue; const v = fix(x.nodeValue); if (v !== x.nodeValue) { x.nodeValue = v; n++; } }"
            + " for (const el of root.querySelectorAll('*')) { if (el.shadowRoot) walk(el.shadowRoot); } };"
            + " walk(document); for (const i of document.querySelectorAll('input')) { const v = fix(i.value || ''); if (v !== i.value) { i.value = v; n++; } }"
            + " return n; })()";

    private static final int SHOT_H = 1800;
    private static final int SHOT_MAX = 3 * SHOT_H;

    @SuppressWarnings("unchecked")
    private Map<String, Object> shoot(String tab, Path base) throws Exception {
        Map<String, Object> shots = new LinkedHashMap<>();
        shots.put("blanked", value(inPage(tab, BLANK_PLACES)));
        Object height = value(inPage(tab, "Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)"));
        int total = height instanceof Number h ? h.intValue() : SHOT_H;
        shots.put("pageHeight", total);
        int n = 0;
        for (int y = 0; y < Math.min(total, SHOT_MAX); y += SHOT_H, n++) {
            Map<String, Object> clip = Map.of("x", 0, "y", y, "width", 1366, "height", Math.min(SHOT_H, total - y), "scale", 0.5);
            String reply = onPage(tab, "Page.captureScreenshot", Map.of("format", "jpeg", "quality", 60,
                    "captureBeyondViewport", true, "clip", clip), Duration.ofSeconds(30));
            Map<String, Object> parsed = Json.parseObject(reply.getBytes(StandardCharsets.UTF_8));
            if (parsed.get("result") instanceof Map<?, ?> r && r.get("data") instanceof String data) {
                Files.write(base.resolveSibling(base.getFileName() + ".orig-" + n + ".jpg"), Base64.getDecoder().decode(data));
            }
        }
        shots.put("tiles", n);
        return shots;
    }

    @SuppressWarnings("unchecked")
    private static Object value(String reply) throws Exception {
        Map<String, Object> parsed = Json.parseObject(reply.getBytes(StandardCharsets.UTF_8));
        if (parsed.get("result") instanceof Map<?, ?> r && r.get("result") instanceof Map<?, ?> v) {
            return v.get("value");
        }
        return null;
    }

    /** The island the renderer would play: the one marked main, else the largest that isn't an ad. */
    @SuppressWarnings("unchecked")
    private static Map<String, Object> mainIsland(Map<String, Object> mdoc) {
        Map<String, Object> best = null;
        for (Map<String, Object> block : (List<Map<String, Object>>) mdoc.getOrDefault("blocks", List.of())) {
            if (!"island".equals(block.get("t")) || Boolean.TRUE.equals(block.get("ad"))) {
                continue;
            }
            if (Boolean.TRUE.equals(block.get("main"))) {
                return block;
            }
            if (best == null || area(block) > area(best)) {
                best = block;
            }
        }
        return best;
    }

    private static long area(Map<String, Object> block) {
        return ((Number) block.getOrDefault("width", 0)).longValue() * ((Number) block.getOrDefault("height", 0)).longValue();
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> tab(String tabId) throws Exception {
        Map<String, Object> reply = rig.call(client, "browser.tab.list", Map.of(), null);
        return ((List<Map<String, Object>>) reply.getOrDefault("tabs", List.of())).stream()
                .filter(t -> tabId.equals(t.get("tabId"))).findFirst().orElse(Map.of());
    }

    // ---- Chromium

    /** A desk's Chromium's own user agent, the major version as the binary's, never "HeadlessChrome". */
    private static final String DESK_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/"
            + System.getenv().getOrDefault("MINIFIED_RUN_CHROME_MAJOR", "156") + ".0.0.0 Safari/537.36";

    private void startChromium() throws IOException {
        Path profile = Files.createTempDirectory(dir, "profile");
        chromium = new ProcessBuilder(
                        System.getenv("DESKD_CHROMIUM_BIN"),
                        "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
                        "--noerrdialogs", "--disable-breakpad", "--password-store=basic", "--window-size=1366,900",
                        "--lang=en-US", "--mute-audio", "--hide-scrollbars", "--allow-file-access-from-files",
                        // As the desk's kiosk Chromium presents itself, not as headless Chromium, which sites serve
                        // other pages or a bot wall (the prototype's kit does the same).
                        "--user-agent=" + DESK_UA, "--disable-blink-features=AutomationControlled",
                        "--user-data-dir=" + profile,
                        "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=" + cdpPort,
                        "about:blank")
                .redirectErrorStream(true)
                .redirectOutput(ProcessBuilder.Redirect.appendTo(dir.resolve("chromium.log").toFile()))
                .start();
    }

    private void stopChromium() throws InterruptedException {
        if (chromium == null) {
            return;
        }
        chromium.toHandle().descendants().forEach(ProcessHandle::destroy);
        chromium.destroy();
        if (!chromium.waitFor(10, TimeUnit.SECONDS)) {
            chromium.toHandle().descendants().forEach(ProcessHandle::destroyForcibly);
            chromium.destroyForcibly();
        }
        chromium = null;
    }

    private boolean debuggingPortAnswers() {
        try (HttpClient http = HttpClient.newHttpClient()) {
            return http.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + cdpPort + "/json/version"))
                    .timeout(Duration.ofSeconds(2)).build(), HttpResponse.BodyHandlers.discarding()).statusCode() == 200;
        } catch (IOException e) {
            return false;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return false;
        }
    }

    private String inPage(String targetId, String expression) throws Exception {
        return onPage(targetId, "Runtime.evaluate", Map.of("expression", expression, "returnByValue", true, "awaitPromise", true),
                Duration.ofSeconds(20));
    }

    /** One command on the page's own debugging socket, as the page itself could run it: the harness's, not deskd's. */
    private String onPage(String targetId, String method, Map<String, Object> params, Duration wait) throws Exception {
        try (HttpClient http = HttpClient.newHttpClient()) {
            CompletableFuture<String> reply = new CompletableFuture<>();
            StringBuilder text = new StringBuilder();
            long id = ids.getAndIncrement();
            List<String> seen = new ArrayList<>();
            WebSocket socket = http.newWebSocketBuilder()
                    .buildAsync(URI.create("ws://127.0.0.1:" + cdpPort + "/devtools/page/" + targetId), new WebSocket.Listener() {
                        @Override
                        public java.util.concurrent.CompletionStage<?> onText(WebSocket webSocket, CharSequence data, boolean last) {
                            text.append(data);
                            if (last) {
                                String message = text.toString();
                                text.setLength(0);
                                seen.add(message);
                                if (message.contains("\"id\":" + id + ",") || message.contains("\"id\":" + id + "}")) {
                                    reply.complete(message);
                                }
                            }
                            webSocket.request(1);
                            return null;
                        }
                    })
                    .get(5, TimeUnit.SECONDS);
            socket.sendText(new String(Json.bytes(Map.of("id", id, "method", method, "params", params)), StandardCharsets.UTF_8), true);
            String answer = reply.get(wait.toMillis(), TimeUnit.MILLISECONDS);
            socket.abort();
            return answer;
        }
    }

    private static int freePort() throws IOException {
        try (ServerSocket socket = new ServerSocket(0)) {
            return socket.getLocalPort();
        }
    }

    private static String env(String name, String fallback) {
        String value = System.getenv(name);
        return value == null || value.isBlank() ? fallback : value;
    }
}
