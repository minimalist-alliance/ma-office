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
import java.util.LinkedHashMap;
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
 * debugging socket (as the prototype's run did, so lazy content is there), then {@code browser.minified.get}, and
 * {@code browser.minified.island} for the main island. {@code get}'s result, as a client gets it, goes to
 * {@code PNN.mdoc.json}, which the Product Designer's check reads as it is; the rest (timings, the island's reply, the
 * tab) to {@code PNN.run.json}. One page at a time, 4 s apart, signed out, nothing clicked, no consent answered: the
 * switch has {@code consent-reject} and {@code media-actions} off.
 */
@EnabledIfEnvironmentVariable(named = "MINIFIED_RUN_OUT", matches = ".+")
@EnabledIfEnvironmentVariable(named = "DESKD_CHROMIUM_BIN", matches = ".+")
class MinifiedRealSites {

    private static final Duration BETWEEN_PAGES = Duration.ofSeconds(4);
    private static final Duration LOAD_WAIT = Duration.ofSeconds(45);
    private static final Duration VIEW_WAIT = Duration.ofSeconds(25);

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
        List<Map<String, Object>> pages = (List<Map<String, Object>>) Json.parseObject(
                ("{\"pages\":" + Files.readString(sites) + "}").getBytes(StandardCharsets.UTF_8)).get("pages");

        cdpPort = freePort();
        startChromium();
        try {
            await().atMost(Duration.ofSeconds(30)).until(this::debuggingPortAnswers);
            rig = new BrowserRig(dir, cdpPort, BrowserRig.timing(Duration.ofMillis(250), Duration.ofMinutes(5)));
            rig.module.enableMinified(dir, Clock.systemUTC(), new MinifiedModule.Timing(
                    Duration.ofSeconds(10), Duration.ofSeconds(8), Duration.ofSeconds(20), Duration.ofMillis(24),
                    Duration.ofMillis(100), Duration.ofSeconds(30)), MinifiedSwitch.fixed(true, false, false));
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
                    tabId = visit(tabId, (String) page.get("url"), result);
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

    @SuppressWarnings("unchecked")
    private String visit(String tabId, String url, Map<String, Object> result) throws Exception {
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
        result.put("scroll", inPage(tab, "(async () => { for (let i = 0; i < 8; i++) { scrollBy(0, innerHeight);"
                + " await new Promise(r => setTimeout(r, 350)); } scrollTo(0, 0); await new Promise(r => setTimeout(r, 300));"
                + " return document.documentElement.scrollHeight; })()"));
        Thread.sleep(1500);
        Map<String, Object> view = null;
        long viewStarted = System.nanoTime();
        long viewDeadline = viewStarted + VIEW_WAIT.toNanos();
        while (System.nanoTime() < viewDeadline) {
            view = rig.call(client, "browser.minified.get", Map.of("tabId", tab), null);
            Object shown = view.get("view");
            if ("simplified".equals(shown) || "stream".equals(shown) || !"RES".equals(view.get("_kind"))) {
                break;
            }
            Thread.sleep(500);
        }
        result.put("getMs", (System.nanoTime() - viewStarted) / 1_000_000);
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
        }
        return tab;
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
