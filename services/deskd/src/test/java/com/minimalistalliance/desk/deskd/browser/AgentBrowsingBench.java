package com.minimalistalliance.desk.deskd.browser;

import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.browser.minified.MinifiedModule;
import com.minimalistalliance.desk.deskd.browser.minified.MinifiedSwitch;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.rpc.Caller;
import com.minimalistalliance.desk.deskd.tools.BrowserTools;
import com.minimalistalliance.desk.deskd.tools.HostedCall;
import com.minimalistalliance.desk.deskd.tools.HostedTool;
import com.minimalistalliance.desk.deskd.tools.RunLedger;
import com.minimalistalliance.desk.deskd.tools.ToolFailure;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
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
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.junit.jupiter.api.io.TempDir;

/**
 * Not a test: the harness that measures the Agent's Browser tools against the draft ADR's §17 Browser row. deskd's real
 * Agent Browser, walker and action proxy, called as deskd's {@code ToolHost} calls an area (look, then run), against a
 * real Chromium. Its name matches neither surefire's nor failsafe's patterns, so no build runs it; it runs only when
 * asked for by name, with {@code AGENT_BENCH_OUT} and {@code DESKD_CHROMIUM_BIN} set. Wired as
 * {@code AgentBrowsingChromiumIT} is, but with deskd's production timing (a load is waited for up to 30 s, as on a desk).
 *
 * <p>{@code AGENT_BENCH_PARTS} picks what runs, comma-separated:
 * <ul>
 *   <li>{@code corpus}: bar items 1 to 3. Each of the 58 pages of {@code real-sites/} ({@code sites.json} then
 *       {@code sites-2026-11-11.json}) in a run of its own: {@code browser_open}, then {@code browser_read} until the view
 *       isn't {@code loading} (25 s at most), deskd's own measure of the tab's memory ({@code memoryOf}) and Chromium's
 *       total PSS before and after, then the run's end. One page at a time, 4 s apart, signed out, a desk's user agent,
 *       as {@code MinifiedRealSites} visits them.
 *   <li>{@code actions}: bar item 4. Two local pages (a simple one, and B8's heavy one: about 5,000 elements and 20
 *       frames, 4 from the second site) behind a TCP relay of this harness's that holds every chunk RTT/2 each way, for
 *       each profile of {@code AGENT_BENCH_PROFILES} ({@code 30,70,90,70L}: RTT in ms, {@code L} for a lossy link). Five
 *       actions, each from a fresh read, timed as the whole tool call and as deskd's act alone; for the two that
 *       navigate, the site's share is timed at the relay.
 *   <li>{@code fps}: bar item 5, run headful ({@code DESKD_CHROMIUM_HEADFUL=1} under {@code xvfb-run}, pinned with
 *       {@code taskset}). The member's own visible tab plays an animation and counts its frames; the harness reads that
 *       count once a second on the member's tab only, idle and while the Agent browses.
 * </ul>
 *
 * <p>Also: {@code AGENT_BENCH_ONLY} (corpus ids), {@code AGENT_BENCH_RUNS} (60) and {@code AGENT_BENCH_WARMUP} (5), and
 * {@code AGENT_BENCH_CAP_MB}, which lifts deskd's 300 MB cap on a tab for a diagnostic pass (deskd's checks still run).
 * Each part writes {@code <part>.json} to {@code AGENT_BENCH_OUT}. Commands and results: the bench's {@code README.md},
 * outside git.
 *
 * <p>Nothing written or printed names a page: counts, timings, view kinds, fallback reasons and corpus ids only.
 */
@EnabledIfEnvironmentVariable(named = "AGENT_BENCH_OUT", matches = ".+")
@EnabledIfEnvironmentVariable(named = "DESKD_CHROMIUM_BIN", matches = ".+")
@SuppressWarnings("unchecked")
class AgentBrowsingBench {

    private static final Duration BETWEEN_PAGES = Duration.ofSeconds(4);
    private static final Duration READ_WAIT = Duration.ofSeconds(25);
    private static final Duration PAUSE = Duration.ofMillis(100);
    private static final int MIN_CHARS = 200;
    private static final long CAP_BYTES = AgentBrowsing.TAB_MEMORY_BYTES;
    /** Kinds of page the corpus expects to fall back: a not_readable view of one of these is a success. */
    private static final Set<String> FALLBACK_KINDS = Set.of("video", "app", "sensitive", "probe");
    private static final List<String> ACTIONS = List.of("click_button", "type_20", "press_escape", "enter_search", "click_link");
    private static final String TYPED_A = "brass lamps for desk";
    private static final String TYPED_B = "warm light at night.";

    @TempDir
    Path dir;

    private int cdpPort;
    private Process chromium;
    private volatile Integer chromiumExit;
    private HttpServer pages;
    private Relay relay;
    private BrowserRig rig;
    private AgentBrowsing agent;
    private Timed timed;
    private BrowserTools tools;
    private RunLedger ledger;
    private final Map<String, byte[]> built = new ConcurrentHashMap<>();

    @Test
    void run() throws Exception {
        Path out = Path.of(System.getenv("AGENT_BENCH_OUT"));
        Files.createDirectories(out);
        Set<String> parts = Set.of(env("AGENT_BENCH_PARTS", "corpus,actions").split(","));
        startPages();
        cdpPort = freePort();
        startChromium();
        try {
            await().atMost(Duration.ofSeconds(30)).until(this::debuggingPortAnswers);
            // deskd's production timing, not the IT's short one: deskd's open waits for a load up to 30 s, as on a desk.
            rig = new BrowserRig(dir, cdpPort, BrowserTabs.Timing.DEFAULT);
            rig.module.enableMinified(dir, Clock.systemUTC(), MinifiedModule.Timing.DEFAULT, MinifiedSwitch.fixed(true, false, false));
            agent = (AgentBrowsing) rig.module.enableAgentBrowsing(() -> false);
            // Only for a diagnostic pass: what pages deskd closes would hold with the cap lifted. The bar's runs keep 300 MB.
            if (System.getenv("AGENT_BENCH_CAP_MB") != null) {
                agent.memoryCap(Long.parseLong(System.getenv("AGENT_BENCH_CAP_MB")) << 20, AgentBrowsing.MEMORY_EVERY);
            }
            timed = new Timed(agent);
            tools = new BrowserTools(timed.proxy());
            ledger = new RunLedger(Clock.systemUTC(), runId -> tools.runEnded(runId));
            rig.connect("cs-a");
            for (String part : List.of("corpus", "actions", "fps")) {
                if (!parts.contains(part)) {
                    continue;
                }
                Map<String, Object> facts = facts();
                Map<String, Object> result = switch (part) {
                    case "corpus" -> corpus();
                    case "actions" -> actions();
                    default -> fps();
                };
                facts.put("loadAfter", loadAverage());
                facts.put("capMb", env("AGENT_BENCH_CAP_MB", "300"));
                result.put("machine", facts);
                Files.write(out.resolve(part + ".json"), Json.bytes(result));
            }
        } finally {
            if (rig != null) {
                rig.close();
            }
            stopChromium();
            if (relay != null) {
                relay.close();
            }
            pages.stop(0);
        }
    }

    // ---- 1 to 3: the corpus

    private Map<String, Object> corpus() throws Exception {
        Path here = Path.of("real-sites");
        List<Map<String, Object>> list = new ArrayList<>(sites(here.resolve("sites.json")));
        list.addAll(sites(here.resolve("sites-2026-11-11.json")));
        Set<String> only = Set.of(env("AGENT_BENCH_ONLY", "").split(","));
        List<Map<String, Object>> rows = new ArrayList<>();
        for (Map<String, Object> site : list) {
            String id = (String) site.get("id");
            if (!(only.size() == 1 && only.contains("")) && !only.contains(id)) {
                continue;
            }
            boolean fallbackOk = expectsFallback(site);
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("id", id);
            row.put("kind", site.get("kind"));
            row.put("fallbackOk", fallbackOk);
            row.putAll(visit("corpus-" + id, (String) site.get("url")));
            judge(row, fallbackOk);
            System.out.println("== " + id + " " + row.get("outcome") + " " + row.getOrDefault("word", ""));
            rows.add(row);
            Thread.sleep(BETWEEN_PAGES);
        }
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("summary", corpusSummary(rows));
        result.put("pages", rows);
        return result;
    }

    /**
     * One page in a run of its own, as the Agent reads one: open, read until it isn't loading, then deskd's and Chromium's
     * measures of what the tab holds, then the run's end. Only counts and words are kept.
     */
    private Map<String, Object> visit(String runId, String url) throws Exception {
        Map<String, Object> row = new LinkedHashMap<>();
        // The last run's tab has gone and its renderer with it, so the PSS before is Chromium without an Agent tab.
        for (long until = System.nanoTime() + 15_000_000_000L; agent.agentTabs() > 0 && System.nanoTime() < until; ) {
            Thread.sleep(100);
        }
        long pssBefore = chromiumPssKb();
        long started = System.nanoTime();
        try {
            Map<String, Object> page = content(exec(runId, "browser_open", Map.of("url", url)));
            long returned = System.nanoTime();
            // deskd's open (Page.navigate, then Chromium's load or 30 s) returned at openedAt; its first read follows in the call.
            row.put("loadMs", ms(timed.openedAt - started));
            row.put("openCallMs", ms(returned - started));
            String tabId = (String) page.get("tabId");
            int reads = 1;
            long deadline = returned + READ_WAIT.toNanos();
            while ("loading".equals(page.get("view")) && System.nanoTime() < deadline) {
                // A read that says loading has waited in deskd already (up to 6 looks 250 ms apart); a short pause more.
                Thread.sleep(50);
                page = content(exec(runId, "browser_read", Map.of("tabId", tabId)));
                reads++;
            }
            long done = System.nanoTime();
            row.put("toolReads", reads);
            row.put("view", page.get("view"));
            if (page.get("reason") != null) {
                row.put("reason", String.valueOf(page.get("reason")));
            }
            if (page.get("netError") instanceof String net) {
                row.put("netError", net);
            }
            row.put("chars", page.get("total") instanceof Number n ? n.intValue() : 0);
            // Item 2: from deskd's open returning (the load) to the end of the first read whose view was ready.
            if (timed.readyAt > 0) {
                row.put("readyAfterLoadMs", ms(timed.readyAt - timed.openedAt));
            }
            // The same as the tool's caller sees it: 0 when browser_open's own result was the view.
            row.put("readyAfterOpenCallMs", reads == 1 ? 0.0 : ms(done - returned));
            try {
                memory(tabId, row);
            } catch (ReflectiveOperationException e) {
                row.put("memoryError", e.getClass().getSimpleName());
            }
        } catch (ToolFailure e) {
            row.put("view", "error");
            row.put("error", e.code() + "/" + e.reason() + (chromiumExit == null ? "" : " (chromium exited " + chromiumExit + ")"));
        } catch (RuntimeException e) {
            row.put("view", "error");
            // deskd's refusal of its own command names the method only, deskd's constant: worth keeping.
            row.put("error", e instanceof AgentCdp.NotAllowed ? e.getMessage() : e.getClass().getSimpleName());
        }
        row.put("pssBeforeKb", pssBefore);
        row.put("pssDeltaKb", chromiumPssKb() - pssBefore);
        ledger.end(runId);
        return row;
    }

    /** Item 1's rule: a page of 200 characters or more, or a fallback where the corpus says the page falls back. */
    private static void judge(Map<String, Object> row, boolean fallbackOk) {
        String view = String.valueOf(row.get("view"));
        String word = switch (view) {
            case "page" -> ((Number) row.get("chars")).intValue() >= MIN_CHARS ? null : "empty";
            case "not_readable" -> fallbackOk ? null : String.valueOf(row.get("reason"));
            case "loading" -> "loading";
            default -> String.valueOf(row.get("error"));
        };
        row.put("outcome", word == null ? "pass" : "fail");
        if (word != null) {
            row.put("word", word);
        }
    }

    private static boolean expectsFallback(Map<String, Object> site) {
        String why = String.valueOf(site.get("why")).toLowerCase(java.util.Locale.ROOT);
        return FALLBACK_KINDS.contains(String.valueOf(site.get("kind"))) || why.contains("fallback") || why.contains("fall back");
    }

    private Map<String, Object> corpusSummary(List<Map<String, Object>> rows) {
        Map<String, Object> s = new LinkedHashMap<>();
        long all = rows.stream().filter(r -> "pass".equals(r.get("outcome"))).count();
        List<Map<String, Object>> first = rows.stream().filter(r -> ((String) r.get("id")).startsWith("P")).toList();
        long firstPass = first.stream().filter(r -> "pass".equals(r.get("outcome"))).count();
        s.put("pass", all + " of " + rows.size());
        s.put("passRate", rows.isEmpty() ? 0 : 100.0 * all / rows.size());
        s.put("pass42", firstPass + " of " + first.size());
        s.put("pass42Rate", first.isEmpty() ? 0 : 100.0 * firstPass / first.size());
        s.put("failures", rows.stream().filter(r -> "fail".equals(r.get("outcome"))).map(r -> r.get("id") + " " + r.get("word")).toList());
        s.put("fallbacks", rows.stream().filter(r -> "not_readable".equals(r.get("view"))).map(r -> r.get("id") + " " + r.get("reason")).toList());
        s.put("readyAfterLoadMs", stats(values(rows, "readyAfterLoadMs", 1)));
        s.put("readyAfterOpenCallMs", stats(values(rows, "readyAfterOpenCallMs", 1)));
        s.put("loadMs", stats(values(rows, "loadMs", 1)));
        s.put("memoryOfMb", stats(values(rows, "memoryOfBytes", 1024 * 1024)));
        s.put("perIsolateMb", stats(values(rows, "perIsolateBytes", 1024 * 1024)));
        s.put("pssDeltaMb", stats(values(rows, "pssDeltaKb", 1024)));
        s.put("memoryOfOver300", rows.stream().filter(r -> r.get("memoryOfBytes") instanceof Number n && n.longValue() > CAP_BYTES)
                .map(r -> r.get("id")).toList());
        s.put("pssDeltaOver300", rows.stream().filter(r -> r.get("pssDeltaKb") instanceof Number n && n.longValue() * 1024 > CAP_BYTES)
                .map(r -> r.get("id")).toList());
        s.put("closedForMemory", rows.stream().filter(r -> String.valueOf(r.get("error")).endsWith("/memory")).map(r -> r.get("id")).toList());
        return s;
    }

    // ---- 4: MA's overhead per action, over the relay

    private Map<String, Object> actions() throws Exception {
        List<String> profiles = List.of(env("AGENT_BENCH_PROFILES", "30,70,90,70L").split(","));
        int runs = Integer.parseInt(env("AGENT_BENCH_RUNS", "60"));
        int warmups = Integer.parseInt(env("AGENT_BENCH_WARMUP", "5"));
        List<Map<String, Object>> summary = new ArrayList<>();
        List<Map<String, Object>> samples = new ArrayList<>();
        for (String profile : profiles) {
            relay.set(Integer.parseInt(profile.replace("L", "")), profile.endsWith("L"));
            relay.dropAll();
            for (String kind : List.of("simple", "heavy")) {
                String runId = "act-" + profile + "-" + kind;
                String start = local("a.test", "/" + kind + "/start");
                String tabId = (String) content(exec(runId, "browser_open", Map.of("url", start))).get("tabId");
                for (String action : ACTIONS) {
                    List<Map<String, Object>> batch = new ArrayList<>();
                    for (int i = 0; i < warmups + runs; i++) {
                        Map<String, Object> sample = once(runId, tabId, kind, action, i, start);
                        // deskd's action proxy admits 30 actions a second a tab, a runaway guard a model's pace never
                        // nears; back to back, a fast page's runs reach it. B8 paused 100 ms between actions too.
                        Thread.sleep(PAUSE);
                        if (i >= warmups) {
                            sample.put("profile", profile);
                            sample.put("page", kind);
                            sample.put("action", action);
                            batch.add(sample);
                        }
                    }
                    Map<String, Object> row = actionSummary(profile, kind, action, batch);
                    System.out.println("== " + profile + " " + kind + " " + action + " " + row.get("totalMs") + " site " + row.get("siteMs"));
                    summary.add(row);
                    samples.addAll(batch);
                }
                ledger.end(runId);
            }
        }
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("summary", summary);
        result.put("samples", samples);
        return result;
    }

    /**
     * One timed action from a fresh read, as the model's next call follows one: the whole tool call (look, then run, whose
     * result is the page read again), and deskd's act alone within it. A navigating one is taken back to the start after.
     */
    private Map<String, Object> once(String runId, String tabId, String kind, String action, int i, String start) throws Exception {
        String text = (String) content(exec(runId, "browser_read", Map.of("tabId", tabId))).get("text");
        // A script's button, typing, Escape in the same field, Enter in a GET search form's box, and a link.
        String tool = action.startsWith("click") ? "browser_click" : action.equals("type_20") ? "browser_type" : "browser_press";
        String label = switch (action) {
            case "click_button" -> "Show more";
            case "enter_search" -> "Find";
            case "click_link" -> "Next page";
            default -> "Memo";
        };
        String goes = action.equals("enter_search") ? "/" + kind + "/results" : action.equals("click_link") ? "/" + kind + "/next" : null;
        Map<String, Object> args = new LinkedHashMap<>(Map.of("tabId", tabId, "ref", ref(text, label)));
        if (action.equals("type_20")) {
            args.put("text", i % 2 == 0 ? TYPED_A : TYPED_B);
        } else if (tool.equals("browser_press")) {
            args.put("key", goes == null ? "Escape" : "Enter");
        }
        HostedCall call = new HostedCall(1, runId, "ag-1", tool, args, null, false, Caller.THE_OWNER, null);
        RunLedger.Run run = ledger.join(runId, "ag-1", Caller.THE_OWNER, List.of());
        relay.watch(goes);
        long t0 = System.nanoTime();
        HostedTool.Look look = tools.look(call, run);
        if (look.refusal() != null || look.risk() != null) {
            throw new AssertionError(action + " looked like " + look.risk() + " " + look.refusal());
        }
        long t1 = System.nanoTime();
        Map<String, Object> content = content(tools.run(call, run));
        long t2 = System.nanoTime();
        relay.unwatch();
        Map<String, Object> sample = new LinkedHashMap<>();
        sample.put("done", Boolean.TRUE.equals(content.get("done")));
        // The page's own title says where the action left it: my local pages' Start, Next or Results.
        sample.put("landed", String.valueOf(content.get("title")).equals(goes == null ? "Start" : goes.endsWith("results") ? "Results" : "Next"));
        sample.put("lookMs", ms(t1 - t0));
        sample.put("actMs", ms(timed.actNanos));
        sample.put("readMs", ms(timed.readNanos));
        sample.put("totalMs", ms(t2 - t0));
        sample.put("requests", relay.requests.get());
        if (goes != null && relay.firstIn > 0 && relay.lastOut > relay.firstIn) {
            double site = ms(relay.lastOut - relay.firstIn);
            sample.put("siteMs", site);
            sample.put("totalLessSiteMs", ms(t2 - t0) - site);
            sample.put("actLessSiteMs", ms(timed.actNanos) - site);
        }
        // What the tab holds now, by deskd's measure and once per isolate, after the timing.
        memory(tabId, sample);
        if (goes != null) {
            agent.navigate(runId, tabId, start);
        }
        return sample;
    }

    private static Map<String, Object> actionSummary(String profile, String page, String action, List<Map<String, Object>> batch) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("profile", profile);
        row.put("page", page);
        row.put("action", action);
        row.put("n", batch.size());
        row.put("done", batch.stream().filter(s -> Boolean.TRUE.equals(s.get("done")) && Boolean.TRUE.equals(s.get("landed"))).count());
        for (String key : List.of("totalMs", "actMs", "lookMs", "readMs", "siteMs", "totalLessSiteMs", "actLessSiteMs", "memoryOfBytes",
                "perIsolateBytes", "afterGcBytes")) {
            List<Double> v = values(batch, key, key.endsWith("Bytes") ? 1 << 20 : 1);
            if (!v.isEmpty()) {
                row.put(key, stats(v));
            }
        }
        row.put("maxRequests", batch.stream().mapToInt(s -> (Integer) s.get("requests")).max().orElse(0));
        return row;
    }

    // ---- 5: the member's frames while the Agent browses

    private Map<String, Object> fps() throws Exception {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("headful", System.getenv("DESKD_CHROMIUM_HEADFUL") != null);
        try (Cdp member = new Cdp(cdpPort, memberTarget())) {
            // The member's own page: an animation, and a count of its frames the harness reads on this tab alone.
            member.call("Page.navigate", Map.of("url", "http://127.0.0.1:" + pages.getAddress().getPort() + "/anim"));
            Thread.sleep(3000);
            result.put("idle", fpsStats(sampleFps(member, 30), 0));
            AtomicInteger read = new AtomicInteger();
            result.put("corpus", fpsStats(whileBrowsing(member, 60, stop -> corpusLoop(stop, read)), read.get()));
            relay.set(0, false);
            AtomicInteger heavy = new AtomicInteger();
            result.put("heavy", fpsStats(whileBrowsing(member, 60, stop -> heavyLoop(stop, heavy)), heavy.get()));
        }
        return result;
    }

    interface Loop {
        void run(AtomicBoolean stop) throws Exception;
    }

    /** The member's frame rate each second for that long, with the Agent's loop running beside it on a thread of its own. */
    private List<Double> whileBrowsing(Cdp member, int seconds, Loop loop) throws Exception {
        AtomicBoolean stop = new AtomicBoolean();
        AtomicReference<Exception> failed = new AtomicReference<>();
        Thread agentThread = Thread.ofPlatform().name("bench-agent").start(() -> {
            try {
                loop.run(stop);
            } catch (Exception e) {
                failed.set(e);
            }
        });
        List<Double> fps = sampleFps(member, seconds);
        stop.set(true);
        agentThread.join(Duration.ofSeconds(60));
        if (failed.get() != null) {
            System.out.println("agent loop ended: " + failed.get().getClass().getSimpleName());
        }
        return fps;
    }

    /** Corpus pages one after another, as in part 1 (4 s apart), from the first. */
    private void corpusLoop(AtomicBoolean stop, AtomicInteger read) throws Exception {
        List<Map<String, Object>> list = sites(Path.of("real-sites", "sites.json"));
        for (int i = 0; !stop.get(); i++) {
            Map<String, Object> site = list.get(i % list.size());
            Map<String, Object> row = visit("fps-" + i, (String) site.get("url"));
            if (!"error".equals(row.get("view"))) {
                read.incrementAndGet();
            }
            for (long until = System.nanoTime() + BETWEEN_PAGES.toNanos(); !stop.get() && System.nanoTime() < until; ) {
                Thread.sleep(100);
            }
        }
    }

    /** The heavy local page, opened, read, a button clicked and read again, in a loop with no pause. */
    private void heavyLoop(AtomicBoolean stop, AtomicInteger read) throws Exception {
        for (int i = 0; !stop.get(); i++) {
            String runId = "fps-heavy-" + i;
            Map<String, Object> page = content(exec(runId, "browser_open", Map.of("url", local("a.test", "/heavy/start"))));
            String tabId = (String) page.get("tabId");
            String text = (String) content(exec(runId, "browser_read", Map.of("tabId", tabId))).get("text");
            exec(runId, "browser_click", Map.of("tabId", tabId, "ref", ref(text, "Show more")));
            ledger.end(runId);
            read.incrementAndGet();
            await().atMost(Duration.ofSeconds(15)).until(() -> agent.agentTabs() == 0);
        }
    }

    /** Once a second, the member page's frames since the last look over the time between them, by the page's own clock. */
    private static List<Double> sampleFps(Cdp member, int seconds) throws Exception {
        List<Double> fps = new ArrayList<>();
        double[] last = frames(member);
        long start = System.nanoTime();
        for (int i = 1; i <= seconds; i++) {
            long wait = start + i * 1_000_000_000L - System.nanoTime();
            if (wait > 0) {
                Thread.sleep(Duration.ofNanos(wait));
            }
            double[] now = frames(member);
            fps.add((now[0] - last[0]) * 1000.0 / (now[1] - last[1]));
            last = now;
        }
        return fps;
    }

    private static double[] frames(Cdp member) throws Exception {
        Map<String, Object> reply = member.call("Runtime.evaluate",
                Map.of("expression", "[window.__n || 0, performance.now()]", "returnByValue", true));
        List<Object> v = (List<Object>) ((Map<String, Object>) ((Map<String, Object>) reply.get("result")).get("result")).get("value");
        return new double[] {((Number) v.get(0)).doubleValue(), ((Number) v.get(1)).doubleValue()};
    }

    private static Map<String, Object> fpsStats(List<Double> fps, int pages) {
        Map<String, Object> s = new LinkedHashMap<>();
        s.put("seconds", fps.size());
        s.put("min", fps.stream().mapToDouble(Double::doubleValue).min().orElse(Double.NaN));
        s.put("p5", pct(fps, 5));
        s.put("p50", pct(fps, 50));
        s.put("agentPages", pages);
        s.put("perSecond", fps.stream().map(f -> Math.round(f * 10) / 10.0).toList());
        return s;
    }

    /** The member's one tab: the only page target, as Agent tabs are hidden ones Chromium lists as "other". */
    private String memberTarget() throws Exception {
        String body = get("/json/list");
        List<Map<String, Object>> list = (List<Map<String, Object>>) Json.parseObject(
                ("{\"l\":" + body + "}").getBytes(StandardCharsets.UTF_8)).get("l");
        return list.stream().filter(t -> "page".equals(t.get("type"))).map(t -> (String) t.get("id")).findFirst()
                .orElseThrow(() -> new AssertionError("no member tab"));
    }

    // ---- the tool calls, as ToolHost makes them: look, then run with the same call

    private HostedTool.Result exec(String runId, String tool, Map<String, Object> args) throws Exception {
        HostedCall call = new HostedCall(1, runId, "ag-1", tool, new LinkedHashMap<>(args), null, false, Caller.THE_OWNER, null);
        RunLedger.Run run = ledger.join(runId, "ag-1", Caller.THE_OWNER, List.of());
        HostedTool.Look look = tools.look(call, run);
        if (look.refusal() != null) {
            throw ToolFailure.forbidden(look.refusal());
        }
        return tools.run(call, run);
    }

    private static Map<String, Object> content(HostedTool.Result result) {
        return (Map<String, Object>) result.content();
    }

    private static String ref(String text, String label) {
        Matcher m = Pattern.compile("\\[(n[0-9]+) [a-z ]+(?:[a-z_]+)?: " + Pattern.quote(label)).matcher(text == null ? "" : text);
        if (!m.find()) {
            // Only ever the harness's own local pages, so their text may be shown.
            throw new AssertionError("no ref for " + label + " in " + (text == null ? "" : text.substring(0, Math.min(800, text.length()))));
        }
        return m.group(1);
    }

    /**
     * deskd's own measure of a tab ({@code AgentBrowsing.memoryOf}: {@code Runtime.getHeapUsage} summed over the tab's
     * session and each of its out-of-process frames' sessions), and the same sum with each V8 isolate counted once, as
     * {@code getHeapUsage} answers for its whole isolate and frames of one site share a process. deskd's tab is private, so
     * both are reached by reflection, the second over deskd's own connection; nothing once the tab has gone.
     */
    private void memory(String tabId, Map<String, Object> row) throws Exception {
        Object tab = ((Map<String, Object>) field(agent, "byTarget")).get(tabId);
        if (tab == null) {
            return;
        }
        Method memoryOf = AgentBrowsing.class.getDeclaredMethod("memoryOf", tab.getClass());
        memoryOf.setAccessible(true);
        row.put("memoryOfBytes", memoryOf.invoke(agent, tab));
        List<String> sessions = new ArrayList<>(List.of((String) field(tab, "sessionId")));
        ((Map<String, String>) field(agent, "frameSessions")).forEach((session, owner) -> {
            if (tabId.equals(owner)) {
                sessions.add(session);
            }
        });
        CdpClient cdp = (CdpClient) field(field(agent, "cdp"), "cdp");
        Map<Object, Long> byIsolate = new LinkedHashMap<>();
        for (String session : sessions) {
            try {
                Object isolate = cdp.call(session, "Runtime.getIsolateId", Map.of(), Duration.ofSeconds(5)).get("id");
                Map<String, Object> usage = cdp.call(session, "Runtime.getHeapUsage", Map.of(), Duration.ofSeconds(5));
                long bytes = 0;
                for (String key : List.of("totalSize", "embedderHeapUsedSize", "backingStorageSize")) {
                    bytes += usage.get(key) instanceof Number n ? n.longValue() : 0;
                }
                byIsolate.put(isolate, bytes);
            } catch (CdpException e) {
                // A frame that went between the list and the ask: as memoryOf, it counts nothing.
            }
        }
        row.put("sessions", sessions.size());
        row.put("isolates", byIsolate.size());
        row.put("perIsolateBytes", byIsolate.values().stream().mapToLong(Long::longValue).sum());
        // Diagnostic only (AGENT_BENCH_GC_PROBE=1): the same after a full collection, to tell garbage from what's held.
        if (System.getenv("AGENT_BENCH_GC_PROBE") != null) {
            long after = 0;
            Set<Object> seen = new java.util.HashSet<>();
            for (String session : sessions) {
                try {
                    if (seen.add(cdp.call(session, "Runtime.getIsolateId", Map.of(), Duration.ofSeconds(5)).get("id"))) {
                        cdp.call(session, "HeapProfiler.collectGarbage", Map.of(), Duration.ofSeconds(30));
                        Map<String, Object> usage = cdp.call(session, "Runtime.getHeapUsage", Map.of(), Duration.ofSeconds(5));
                        for (String key : List.of("totalSize", "embedderHeapUsedSize", "backingStorageSize")) {
                            after += usage.get(key) instanceof Number n ? n.longValue() : 0;
                        }
                    }
                } catch (CdpException e) {
                    // Gone: nothing.
                }
            }
            row.put("afterGcBytes", after);
        }
    }

    private static Object field(Object owner, String name) throws ReflectiveOperationException {
        Field field = owner.getClass().getDeclaredField(name);
        field.setAccessible(true);
        return field.get(owner);
    }

    /** Chromium's whole footprint: the sum of {@code Pss} in {@code smaps_rollup} over the process tree this harness started. */
    private long chromiumPssKb() {
        long kb = 0;
        List<ProcessHandle> tree = new ArrayList<>(chromium.toHandle().descendants().toList());
        tree.add(chromium.toHandle());
        for (ProcessHandle process : tree) {
            try {
                for (String line : Files.readAllLines(Path.of("/proc", String.valueOf(process.pid()), "smaps_rollup"))) {
                    if (line.startsWith("Pss:")) {
                        kb += Long.parseLong(line.replaceAll("[^0-9]", ""));
                    }
                }
            } catch (IOException | RuntimeException e) {
                // A process that ended between the list and the read holds nothing.
            }
        }
        return kb;
    }

    /**
     * deskd's Agent Browser as the tools reach it, every call passed on unchanged, with the moments the bench needs: when
     * deskd's open returned (it waits for the load), the end of the first read after it whose view was ready (a simplified
     * view with its MDoc, or the real page with its reason, as BrowserTools reads them), and the last read's and act's own
     * time.
     */
    private static final class Timed implements InvocationHandler {
        private final AgentBrowser real;
        volatile long openedAt;
        volatile long readyAt;
        volatile long readNanos;
        volatile long actNanos;

        Timed(AgentBrowser real) {
            this.real = real;
        }

        AgentBrowser proxy() {
            return (AgentBrowser) Proxy.newProxyInstance(AgentBrowser.class.getClassLoader(), new Class<?>[] {AgentBrowser.class}, this);
        }

        @Override
        public Object invoke(Object proxy, Method method, Object[] args) throws Throwable {
            if (method.getName().equals("open")) {
                openedAt = 0;
                readyAt = 0;
            }
            long started = System.nanoTime();
            Object result;
            try {
                result = method.invoke(real, args);
            } catch (InvocationTargetException e) {
                throw e.getCause();
            } finally {
                if (method.getName().equals("act")) {
                    actNanos = System.nanoTime() - started;
                }
            }
            long now = System.nanoTime();
            if (method.getName().equals("open")) {
                openedAt = now;
            } else if (method.getName().equals("read") && result instanceof Map<?, ?> reply) {
                readNanos = now - started;
                Object view = reply.get("view");
                boolean ready = "simplified".equals(view) && reply.get("mdoc") != null || "stream".equals(view) && reply.get("fallback") != null;
                if (ready && readyAt == 0 && openedAt != 0) {
                    readyAt = now;
                }
            }
            return result;
        }
    }

    // ---- the local pages and the relay in front of them

    private static final String PROSE = "The lamp has lit the reading rooms of the world for a long time, and it is still the best way to "
            + "read at night without waking anyone else in the house. ";
    private static final String SHORT = "A lamp for the long evenings";
    private static final int SECTIONS = 67;
    private static final int FRAMES = 20;
    /** Six rows of four cells, as B8's page has in each section. */
    private static final String TABLE = "<table><tbody>" + ("<tr>" + "<td>0</td>".repeat(4) + "</tr>").repeat(6) + "</tbody></table>";

    private void startPages() throws IOException {
        pages = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
        pages.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
        pages.createContext("/", exchange -> {
            byte[] body = page(exchange.getRequestURI().getPath(), exchange.getRequestURI().getRawQuery());
            if (body == null) {
                exchange.sendResponseHeaders(404, -1);
                exchange.close();
                return;
            }
            exchange.getResponseHeaders().set("Content-Type", "text/html; charset=utf-8");
            // Every document comes from the site each time, as a navigation's document does: no cache.
            exchange.getResponseHeaders().set("Cache-Control", "no-store");
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        pages.start();
        relay = new Relay(pages.getAddress().getPort());
    }

    /** {@code a.test} and {@code b.test} both map to loopback, at the relay's port: two sites, as the IT has them. */
    private String local(String host, String path) {
        return "http://" + host + ":" + relay.port() + path;
    }

    private byte[] page(String path, String query) {
        if (path.equals("/frame")) {
            return ("<!doctype html><html><head><title>Frame</title></head><body style=\"margin:0\"><p>Frame " + query
                    + "</p><button type=button>Inside</button></body></html>").getBytes(StandardCharsets.UTF_8);
        }
        if (path.equals("/anim")) {
            return ANIMATION.getBytes(StandardCharsets.UTF_8);
        }
        String[] parts = path.split("/");
        if (parts.length != 3 || !(parts[1].equals("simple") || parts[1].equals("heavy"))
                || !Set.of("start", "next", "results").contains(parts[2])) {
            return null;
        }
        String title = Character.toUpperCase(parts[2].charAt(0)) + parts[2].substring(1);
        return built.computeIfAbsent(path, p -> (parts[1].equals("simple") ? simple(title) : heavy(title)).getBytes(StandardCharsets.UTF_8));
    }

    /** What each action works on, first in the page's main text: a script's button, a field, a GET search form, a link. */
    private static String controls(String kind) {
        return "<p><label>Memo <input type=text name=memo id=memo onkeydown=\"if(event.key==='Escape'){this.dataset.esc=(+this.dataset.esc||0)+1}\"></label></p>"
                + "<p><button type=button onclick=\"window.shown=(window.shown||0)+1;document.getElementById('st').textContent='Shown '+window.shown\">"
                + "Show more</button></p><p id=st>Nothing shown yet</p>"
                + "<p><label>Find <input type=search name=q id=q value=\"brass lamps\" form=fs></label> <button form=fs>Go</button></p>"
                + "<p><a href=\"/" + kind + "/next\">Next page</a></p>";
    }

    private static String form(String kind) {
        return "<form id=fs action=\"/" + kind + "/results\" method=get role=search></form>";
    }

    private static String simple(String title) {
        return "<!doctype html><html><head><title>" + title + "</title></head><body><main><h1>The lamp shop</h1>" + controls("simple")
                + ("<p>" + PROSE + PROSE + "</p>").repeat(12) + "</main>" + form("simple") + "</body></html>";
    }

    /** B8's heavy page, with the controls first: about 5,000 elements, 20 frames, every fifth from the other site. */
    private String heavy(String title) {
        StringBuilder h = new StringBuilder(400_000);
        h.append("<!doctype html><html><head><title>").append(title)
                .append("</title><style>iframe{display:block;border:0;margin:24px 0}</style></head><body><main><h1>The lamp shop</h1>")
                .append(controls("heavy")).append("<p>").append(PROSE).append("</p>");
        int frame = 0;
        for (int s = 0; s < SECTIONS; s++) {
            h.append("<section><h2>Room ").append(s).append("</h2>");
            for (int p = 0; p < 3; p++) {
                h.append("<p>").append(SHORT).append(", <a href=\"/room/").append(s).append('/').append(p).append("\">more on room ")
                        .append(s).append("</a> and <em>its lamps</em>.</p>");
            }
            h.append("<ul>");
            for (int i = 0; i < 8; i++) {
                h.append("<li><a href=\"/lamp/").append(s).append('/').append(i).append("\">Lamp ").append(s).append('.').append(i)
                        .append("</a> <span>in stock</span></li>");
            }
            h.append("</ul>").append(TABLE).append("</section>");
            if (s % 3 == 2 && frame < FRAMES) {
                String host = frame % 5 == 4 ? "b.test" : "a.test";
                h.append("<iframe src=\"").append(local(host, "/frame?n=" + frame)).append("\" width=\"320\" height=\"160\" title=\"Frame ")
                        .append(frame).append("\"></iframe>");
                frame++;
            }
        }
        h.append("</main><nav><ul>");
        for (int i = 0; i < 80; i++) {
            h.append("<li><a href=\"/shelf/").append(i).append("\">Shelf ").append(i).append("</a></li>");
        }
        h.append("</ul></nav><footer>");
        for (int i = 0; i < 100; i++) {
            h.append("<div><a href=\"/about/").append(i).append("\">About ").append(i).append("</a></div>");
        }
        return h.append("</footer>").append(form("heavy")).append("</body></html>").toString();
    }

    /** The member's page: a box that moves and turns, and a number that changes, every frame, with a count of frames. */
    private static final String ANIMATION = "<!doctype html><html><head><title>Member</title><style>body{margin:0;font:16px sans-serif}"
            + "#b{position:absolute;top:120px;width:160px;height:160px;background:#2a5bd7}</style></head><body><p id=t>0</p><div id=b></div>"
            + "<script>window.__n=0;function f(ts){window.__n++;document.getElementById('b').style.transform="
            + "'translateX('+((ts/3)%900)+'px) rotate('+(ts/8)+'deg)';document.getElementById('t').textContent=String(window.__n);"
            + "requestAnimationFrame(f)}requestAnimationFrame(f)</script></body></html>";

    /**
     * A TCP relay in front of the local pages. Every chunk read each way is held RTT/2 before it's written on, and a
     * connection's first chunk toward the site one RTT more, for its handshake. On a lossy link 2% of chunks are held
     * 200 ms + RTT more, and what's behind them waits, as a lost segment's retransmission holds it. It also times the site's
     * share of a navigation: the first byte of the watched document request in, to the last byte of any response out.
     */
    private static final class Relay implements AutoCloseable {
        private final ServerSocket server;
        private final int target;
        private final Random random = new Random(47);
        private final Set<Socket> open = ConcurrentHashMap.newKeySet();
        private volatile int rttMs;
        private volatile boolean lossy;
        /** While timing: the document's path to watch for ("" for none); null when not timing. */
        private volatile String watch;
        volatile long firstIn;
        volatile long lastOut;
        final AtomicInteger requests = new AtomicInteger();

        Relay(int target) throws IOException {
            this.target = target;
            server = new ServerSocket(0, 128, InetAddress.getLoopbackAddress());
            Thread.ofPlatform().daemon().name("relay-accept").start(this::accept);
        }

        int port() {
            return server.getLocalPort();
        }

        void set(int rtt, boolean lossy) {
            this.rttMs = rtt;
            this.lossy = lossy;
        }

        /** Times what follows, watching for this document's request (null: none); {@code watch(null)} then {@code unwatch()}. */
        void watch(String path) {
            firstIn = 0;
            lastOut = 0;
            requests.set(0);
            watch = path == null ? "" : path;
        }

        void unwatch() {
            watch = null;
        }

        /** Closes every connection, so the next profile's connections start with their handshake. */
        void dropAll() {
            open.forEach(this::quietly);
        }

        private void accept() {
            while (!server.isClosed()) {
                try {
                    Socket client = server.accept();
                    Socket site = new Socket(InetAddress.getLoopbackAddress(), target);
                    client.setTcpNoDelay(true);
                    site.setTcpNoDelay(true);
                    open.add(client);
                    open.add(site);
                    AtomicReference<String> path = new AtomicReference<>("");
                    AtomicInteger ends = new AtomicInteger(2);
                    pipe(client, site, true, path, ends);
                    pipe(site, client, false, path, ends);
                } catch (IOException e) {
                    // Closed, or the site refused: the next accept.
                }
            }
        }

        private void pipe(Socket from, Socket to, boolean toSite, AtomicReference<String> path, AtomicInteger ends) {
            LinkedBlockingQueue<Object[]> queue = new LinkedBlockingQueue<>();
            Thread.ofVirtual().start(() -> {
                long due = 0;
                boolean first = toSite;
                byte[] buffer = new byte[64 * 1024];
                try {
                    InputStream in = from.getInputStream();
                    for (int n; (n = in.read(buffer)) > 0; ) {
                        long now = System.nanoTime();
                        if (toSite) {
                            seen(buffer, n, now, path);
                        }
                        int rtt = rttMs;
                        long hold = rtt * 500_000L + (first ? rtt * 1_000_000L : 0)
                                + (lossy && random.nextInt(50) == 0 ? (200L + rtt) * 1_000_000L : 0);
                        first = false;
                        due = Math.max(due, now + hold);
                        queue.add(new Object[] {Arrays.copyOf(buffer, n), due});
                    }
                } catch (IOException e) {
                    // The other side went: what was read still goes, then the end.
                }
                queue.add(new Object[] {null, due});
            });
            Thread.ofVirtual().start(() -> {
                try {
                    OutputStream out = to.getOutputStream();
                    while (true) {
                        Object[] chunk = queue.take();
                        long wait = (long) chunk[1] - System.nanoTime();
                        if (wait > 0) {
                            Thread.sleep(Duration.ofNanos(wait));
                        }
                        if (chunk[0] == null) {
                            to.shutdownOutput();
                            break;
                        }
                        out.write((byte[]) chunk[0]);
                        out.flush();
                        if (!toSite && watch != null && !path.get().equals("/favicon.ico")) {
                            lastOut = System.nanoTime();
                        }
                    }
                } catch (IOException | InterruptedException e) {
                    ends.set(1);
                }
                if (ends.decrementAndGet() == 0) {
                    quietly(from);
                    quietly(to);
                }
            });
        }

        /** A request's first line: its path is what this connection answers next, and the watched one starts the site's share. */
        private void seen(byte[] buffer, int n, long now, AtomicReference<String> path) {
            String head = new String(buffer, 0, Math.min(n, 512), StandardCharsets.ISO_8859_1);
            Matcher m = REQUEST.matcher(head);
            if (!m.lookingAt()) {
                return;
            }
            path.set(m.group(1));
            String watching = watch;
            if (watching != null && !m.group(1).equals("/favicon.ico")) {
                requests.incrementAndGet();
                if (!watching.isEmpty() && firstIn == 0 && m.group(1).equals(watching)) {
                    firstIn = now;
                }
            }
        }

        private static final Pattern REQUEST = Pattern.compile("[A-Z]+ ([^ ?]*)[^ ]* HTTP/1\\.[01]\r\n");

        private void quietly(Socket socket) {
            open.remove(socket);
            try {
                socket.close();
            } catch (IOException e) {
                // Gone already.
            }
        }

        @Override
        public void close() throws IOException {
            server.close();
            dropAll();
        }
    }

    // ---- the harness's own debugging connection, on the member's tab only

    /** One page target's socket, kept open: a command and its reply by id. Nothing on it enables events. */
    private static final class Cdp implements AutoCloseable {
        private final HttpClient http = HttpClient.newHttpClient();
        private final Map<Long, CompletableFuture<Map<String, Object>>> waiting = new ConcurrentHashMap<>();
        private final AtomicLong ids = new AtomicLong(1);
        private final StringBuilder text = new StringBuilder();
        private final WebSocket socket;

        Cdp(int port, String targetId) throws Exception {
            socket = http.newWebSocketBuilder().buildAsync(URI.create("ws://127.0.0.1:" + port + "/devtools/page/" + targetId),
                    new WebSocket.Listener() {
                        @Override
                        public CompletionStage<?> onText(WebSocket webSocket, CharSequence data, boolean last) {
                            text.append(data);
                            if (last) {
                                try {
                                    Map<String, Object> message = Json.parseObject(text.toString().getBytes(StandardCharsets.UTF_8));
                                    if (message.get("id") instanceof Number id && waiting.containsKey(id.longValue())) {
                                        waiting.remove(id.longValue()).complete(message);
                                    }
                                } catch (Exception e) {
                                    // Not a reply of ours: nothing here enables events.
                                }
                                text.setLength(0);
                            }
                            webSocket.request(1);
                            return null;
                        }
                    }).get(5, TimeUnit.SECONDS);
        }

        Map<String, Object> call(String method, Map<String, Object> params) throws Exception {
            long id = ids.getAndIncrement();
            CompletableFuture<Map<String, Object>> reply = new CompletableFuture<>();
            waiting.put(id, reply);
            socket.sendText(new String(Json.bytes(Map.of("id", id, "method", method, "params", params)), StandardCharsets.UTF_8), true)
                    .get(5, TimeUnit.SECONDS);
            return reply.get(10, TimeUnit.SECONDS);
        }

        @Override
        public void close() {
            socket.abort();
            http.close();
        }
    }

    // ---- Chromium

    /** A desk's Chromium's own user agent, the major version as the binary's, never "HeadlessChrome". */
    private static final String DESK_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/"
            + System.getenv().getOrDefault("AGENT_BENCH_CHROME_MAJOR", "156") + ".0.0.0 Safari/537.36";

    private void startChromium() throws IOException {
        Path profile = Files.createTempDirectory(dir, "profile");
        List<String> command = new ArrayList<>(List.of(
                System.getenv("DESKD_CHROMIUM_BIN"),
                "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
                "--noerrdialogs", "--disable-breakpad", "--password-store=basic", "--window-size=1280,800",
                "--lang=en-US", "--mute-audio",
                // As the desk's kiosk Chromium presents itself, as MinifiedRealSites does.
                "--user-agent=" + DESK_UA, "--disable-blink-features=AutomationControlled",
                "--user-data-dir=" + profile,
                "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=" + cdpPort,
                "--host-resolver-rules=MAP a.test 127.0.0.1, MAP b.test 127.0.0.1",
                "about:blank"));
        if (System.getenv("DESKD_CHROMIUM_HEADFUL") != null) {
            // As on a desk: a kiosk window on an X display with no window manager (run under xvfb-run).
            command.set(1, "--kiosk");
            command.add(2, "--ozone-platform=x11");
        }
        chromium = new ProcessBuilder(command)
                .redirectErrorStream(true)
                .redirectOutput(ProcessBuilder.Redirect.DISCARD)
                .start();
        // Chromium's output may name pages, so it's dropped; how it ended, if it ends before the harness stops it, is kept.
        chromium.onExit().thenAccept(p -> chromiumExit = p.exitValue());
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
        try {
            return !get("/json/version").isEmpty();
        } catch (Exception e) {
            return false;
        }
    }

    private String get(String path) throws IOException, InterruptedException {
        try (HttpClient http = HttpClient.newHttpClient()) {
            HttpResponse<String> reply = http.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + cdpPort + path))
                    .timeout(Duration.ofSeconds(2)).build(), HttpResponse.BodyHandlers.ofString());
            return reply.statusCode() == 200 ? reply.body() : "";
        }
    }

    // ---- small things

    private Map<String, Object> facts() throws Exception {
        Map<String, Object> facts = new LinkedHashMap<>();
        String version = String.valueOf(Json.parseObject(get("/json/version").getBytes(StandardCharsets.UTF_8)).get("Browser"));
        facts.put("chromium", version);
        facts.put("headful", System.getenv("DESKD_CHROMIUM_HEADFUL") != null);
        facts.put("cpu", Files.readAllLines(Path.of("/proc/cpuinfo")).stream().filter(l -> l.startsWith("model name"))
                .map(l -> l.substring(l.indexOf(':') + 1).trim()).findFirst().orElse("?"));
        facts.put("cpusAvailable", Runtime.getRuntime().availableProcessors());
        facts.put("java", Runtime.version().toString());
        facts.put("loadBefore", loadAverage());
        return facts;
    }

    private static String loadAverage() throws IOException {
        String[] f = Files.readString(Path.of("/proc/loadavg")).split(" ");
        return f[0] + " " + f[1] + " " + f[2];
    }

    private static List<Map<String, Object>> sites(Path file) throws Exception {
        return (List<Map<String, Object>>) Json.parseObject(("{\"pages\":" + Files.readString(file) + "}").getBytes(StandardCharsets.UTF_8))
                .get("pages");
    }

    private static List<Double> values(List<Map<String, Object>> rows, String key, double unit) {
        return rows.stream().filter(r -> r.get(key) instanceof Number).map(r -> ((Number) r.get(key)).doubleValue() / unit).toList();
    }

    private static Map<String, Object> stats(List<Double> v) {
        Map<String, Object> s = new LinkedHashMap<>();
        s.put("n", v.size());
        s.put("p50", round(pct(v, 50)));
        s.put("p95", round(pct(v, 95)));
        s.put("max", round(v.stream().mapToDouble(Double::doubleValue).max().orElse(Double.NaN)));
        return s;
    }

    /** Nearest rank. */
    private static double pct(List<Double> v, double p) {
        if (v.isEmpty()) {
            return Double.NaN;
        }
        List<Double> sorted = new ArrayList<>(v);
        Collections.sort(sorted);
        int i = (int) Math.ceil(p / 100.0 * sorted.size()) - 1;
        return sorted.get(Math.max(0, Math.min(sorted.size() - 1, i)));
    }

    private static double round(double x) {
        return Math.round(x * 100) / 100.0;
    }

    private static double ms(long nanos) {
        return Math.round(nanos / 10_000.0) / 100.0;
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
