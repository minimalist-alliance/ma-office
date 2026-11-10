package com.minimalistalliance.desk.deskd.browser;

import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.browser.minified.CdpFailure;
import com.minimalistalliance.desk.deskd.browser.minified.MinifiedModule;
import com.minimalistalliance.desk.deskd.browser.minified.MinifiedSwitch;
import com.minimalistalliance.desk.deskd.browser.minified.TabAccess;
import com.minimalistalliance.desk.deskd.browser.minified.TabEvents;
import com.minimalistalliance.desk.deskd.browser.minified.TabRef;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.rpc.RpcDispatcher;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import com.minimalistalliance.desk.deskd.rpc.RpcHandler;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.lang.management.ManagementFactory;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.RecordComponent;
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
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BooleanSupplier;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.junit.jupiter.api.io.TempDir;

/**
 * Not a test: B8's harness (task 47), deskd's own overhead per member action in the simplified view
 * ({@code services/deskd/real-sites/b8/README.md}). Its name matches neither surefire's nor failsafe's patterns, so no
 * build runs it; it runs only when asked for by name, with {@code MINIFIED_B8_OUT} and {@code DESKD_CHROMIUM_BIN} set.
 *
 * <p>A real headless Chromium on two local origins ({@code a.test} and {@code b.test}, both mapped to loopback, each on
 * its own port), deskd's Browser module and its simplified view on it with the switch on, and a client acting through
 * {@code browser.minified.act} as the Desk app does. Nothing in {@code main} changes: the view's {@link TabAccess} is
 * wrapped to time every call it makes on Chromium, and the dispatcher's handler for {@code browser.minified.act} is
 * wrapped to time the method from its arrival to its return. Each call is put in a phase of {@code ActionProxy} by its
 * CDP method and its op. A second pass profiles the page's renderer with the CDP sampling profiler, from the harness's
 * own debugging socket, to split deskd's in-page half (fingerprint, scroll, hit-test, frame check) by function.
 *
 * <p>Two pages: {@code /simple} (a short article with the controls and a long tail of prose) and {@code /heavy} (about
 * 5,000 elements, 20 frames, 4 of them from the second origin, so in a process of their own). Every action starts from
 * a fresh {@code browser.minified.get}, as a client acts on the view it has, with nobody subscribed, so no re-distill
 * runs during an action: this is the action's own cost, not a wait behind a snapshot.
 */
@EnabledIfEnvironmentVariable(named = "MINIFIED_B8_OUT", matches = ".+")
@EnabledIfEnvironmentVariable(named = "DESKD_CHROMIUM_BIN", matches = ".+")
class MinifiedB8Bench {

    private static final String PROSE = "The lamp has lit the reading rooms of the world for a long time, and it is still the best way to "
            + "read at night without waking anyone else in the house. ";
    private static final String SHORT = "A room of lamps, with brass and glass on every shelf";
    /** Exactly 20 characters each, alternated so every fill changes the field. */
    private static final String TEXT_A = "Brass lamps for two!";
    private static final String TEXT_B = "Oil lamps, in green.";
    private static final String HITS = "<script>window.hits={link:0,button:0,check:0,input:0,select:0,far:0};</script>";
    private static final String TARGETS =
            "<p>See <a id=lnk href=\"/catalogue\" onclick=\"event.preventDefault();hits.link++\">the lamp catalogue</a> for every shade.</p>"
                    + "<p><button id=btn type=button onclick=\"hits.button++\">Add to basket</button></p>"
                    + "<p><label><input type=checkbox id=chk onclick=\"hits.check++\"> Send me the newsletter</label></p>"
                    + "<p><label>Your name <input id=name oninput=\"hits.input++\"></label></p>"
                    + "<p><label>Lamp size <select id=size onchange=\"hits.select++\"><option>Small</option><option>Medium</option>"
                    + "<option>Large</option></select></label></p>";
    private static final String FAR = "<p><button id=far type=button onclick=\"hits.far++\">Back to the top</button></p>";
    static final int SECTIONS = 67;
    static final int FRAMES = 20;

    /** One kind of action. The alternate, if any, is used on every odd run, so each run really moves something. */
    record Spec(String name, String action, String r, String words, String altR, String altWords, String hit) {}

    private static final List<Spec> SPECS = List.of(
            new Spec("click link", "click", "link", "the lamp catalogue", null, null, "link"),
            new Spec("click button", "click", "button", "Add to basket", null, null, "button"),
            new Spec("click checkbox", "click", "check", "Send me the newsletter", null, null, "check"),
            new Spec("type 20 chars", "fill", "field", "Your name", null, null, "input"),
            new Spec("select", "select", "select", "Lamp size", null, null, "select"),
            new Spec("scroll far element into view", "scroll", "button", "Back to the top", "link", "the lamp catalogue", null),
            new Spec("click far button (scrolls first)", "click", "button", "Back to the top", "button", "Add to basket", null));

    @TempDir
    Path dir;

    private int portA;
    private int portB;
    private int cdpPort;
    private Process chromium;
    private HttpServer pagesA;
    private HttpServer pagesB;
    private BrowserRig rig;
    private TestClient client;
    private TimedAccess timed;
    private final HandlerClock handler = new HandlerClock();
    private List<ProcessHandle> chromiumProcesses = List.of();
    private final com.sun.management.OperatingSystemMXBean os =
            (com.sun.management.OperatingSystemMXBean) ManagementFactory.getOperatingSystemMXBean();

    @Test
    void run() throws Exception {
        Path out = Path.of(System.getenv("MINIFIED_B8_OUT"));
        Files.createDirectories(out);
        int runs = Integer.parseInt(env("MINIFIED_B8_RUNS", "60"));
        int warmup = Integer.parseInt(env("MINIFIED_B8_WARMUP", "3"));
        int profileRuns = Integer.parseInt(env("MINIFIED_B8_PROFILE_RUNS", "30"));
        long pauseMs = Long.parseLong(env("MINIFIED_B8_PAUSE_MS", "100"));
        List<String> pages = List.of(env("MINIFIED_B8_PAGES", "simple,heavy").split(","));
        Set<String> only = Set.of(env("MINIFIED_B8_ONLY", "").split(","));

        startServers();
        cdpPort = freePort();
        startChromium();
        Map<String, Object> report = new LinkedHashMap<>();
        List<Map<String, Object>> batches = new ArrayList<>();
        List<Map<String, Object>> samples = new ArrayList<>();
        List<Map<String, Object>> profiles = new ArrayList<>();
        List<Map<String, Object>> pageFacts = new ArrayList<>();
        try {
            await().atMost(Duration.ofSeconds(30)).until(this::debuggingPortAnswers);
            report.put("machine", machine());
            report.put("startedAt", Instant.now().toString());
            report.put("settings", Map.of("runs", runs, "warmup", warmup, "profileRuns", profileRuns, "pauseMs", pauseMs,
                    "timing", "MinifiedModule.Timing.DEFAULT", "subscribers", 0));
            rig = new BrowserRig(dir, cdpPort, BrowserRig.timing(Duration.ofMillis(250), Duration.ofMinutes(5)));
            installTimedModule();
            client = rig.connect("cs-a");

            for (String page : pages) {
                String tabId = open("a.test", portA, "/" + page);
                Map<String, Object> facts = pageFacts(page, tabId);
                pageFacts.add(facts);
                log("page %s: %s", page, facts);
                // The JIT, Chromium's caches and the page's own first layout, before anything is counted.
                for (Spec spec : SPECS) {
                    for (int i = 0; i < warmup; i++) {
                        once(page, tabId, spec, i, pauseMs);
                    }
                }
                for (Spec spec : SPECS) {
                    if (!only.contains("") && !only.contains(spec.name())) {
                        continue;
                    }
                    batches.add(batch(page, tabId, spec, runs, warmup, pauseMs, samples));
                }
                facts.put("hitsAfterTimedRuns", inPage(tabId, "JSON.stringify(hits)"));
                if (profileRuns > 0) {
                    for (Spec spec : SPECS) {
                        if (!only.contains("") && !only.contains(spec.name())) {
                            continue;
                        }
                        profiles.add(profile(page, tabId, spec, profileRuns, pauseMs));
                    }
                }
            }
        } finally {
            report.put("pages", pageFacts);
            report.put("batches", batches);
            report.put("profiles", profiles);
            report.put("finishedAt", Instant.now().toString());
            Files.write(out.resolve("b8-summary.json"), Json.bytes(report));
            Map<String, Object> raw = new LinkedHashMap<>(report);
            raw.put("samples", samples);
            Files.write(out.resolve("b8-samples.json"), Json.bytes(raw));
            Files.writeString(out.resolve("b8-summary.md"), markdown(report));
            log("%s", markdown(report));
            close();
        }
    }

    // ---- one batch

    private Map<String, Object> batch(String page, String tabId, Spec spec, int runs, int warmup, long pauseMs, List<Map<String, Object>> all)
            throws Exception {
        for (int i = 0; i < warmup; i++) {
            once(page, tabId, spec, i, pauseMs);
        }
        chromiumProcesses = chromiumTree();
        String loadBefore = loadavg();
        Map<String, Object> hitsBefore = hits(tabId);
        List<Map<String, Object>> mine = new ArrayList<>();
        long started = System.nanoTime();
        for (int i = 0; i < runs; i++) {
            Map<String, Object> sample = once(page, tabId, spec, i, pauseMs);
            mine.add(sample);
            all.add(sample);
        }
        double seconds = (System.nanoTime() - started) / 1e9;
        String loadAfter = loadavg();
        Map<String, Object> hitsAfter = hits(tabId);
        Map<String, Object> summary = summarize(page, spec, mine);
        summary.put("loadavgBefore", loadBefore);
        summary.put("loadavgAfter", loadAfter);
        summary.put("seconds", round(seconds));
        if (spec.hit() != null) {
            summary.put("pageCounted", ((Number) hitsAfter.get(spec.hit())).longValue() - ((Number) hitsBefore.get(spec.hit())).longValue());
        }
        log("%s / %s: %s", page, spec.name(), summary);
        return summary;
    }

    /** One action: a fresh view, a short pause, then the act, timed three ways. */
    private Map<String, Object> once(String page, String tabId, Spec spec, int i, long pauseMs) throws Exception {
        // The get re-distills the view the last action left dirty: its in-page snapshot is timed too, since an action that
        // arrives while a subscriber's re-distill runs waits for it (both hold the tab's work lock).
        timed.calls.clear();
        long g0 = System.nanoTime();
        Map<String, Object> mdoc = mdoc(tabId);
        long g1 = System.nanoTime();
        long snapshotNanos = union(timed.calls.stream().filter(c -> "snapshot".equals(c.op) && c.t1 != 0)
                .map(c -> new long[] {c.t0, c.t1}).toList());
        boolean alt = spec.altR() != null && i % 2 == 1;
        Map<String, Object> run = find(mdoc, alt ? spec.altR() : spec.r(), alt ? spec.altWords() : spec.words());
        if (run == null) {
            Files.write(Path.of(System.getenv("MINIFIED_B8_OUT")).resolve("missing-" + page + ".mdoc.json"), Json.bytes(mdoc));
            throw new IllegalStateException("no " + spec.r() + " with '" + spec.words() + "' in the view of " + page);
        }
        Object value = switch (spec.action()) {
            case "fill" -> i % 2 == 0 ? TEXT_A : TEXT_B;
            case "select" -> {
                List<?> options = (List<?>) run.get("options");
                int index = 1 + i % 2;
                yield Map.of("index", index, "label", options.get(index));
            }
            case "scroll" -> "start";
            default -> null;
        };
        Thread.sleep(pauseMs);
        timed.calls.clear();
        handler.reset();
        long chromium0 = chromiumTicks();
        long jvm0 = os.getProcessCpuTime();
        long c0 = System.nanoTime();
        Map<String, Object> reply = act(tabId, run, spec.action(), value);
        long c1 = System.nanoTime();
        long jvm1 = os.getProcessCpuTime();
        long chromium1 = chromiumTicks();
        List<Call> calls = new ArrayList<>(timed.calls);

        Map<String, Object> sample = new LinkedHashMap<>();
        sample.put("page", page);
        sample.put("action", spec.name());
        sample.put("run", i);
        boolean done = Boolean.TRUE.equals(reply.get("done"));
        sample.put("done", done);
        sample.put("outcome", "RES".equals(reply.get("_kind"))
                ? (done ? "done" : "not done: " + reply.get("reason"))
                : "ERR " + reply.get("code") + " " + (reply.get("details") instanceof Map<?, ?> d ? d.get("reason") : ""));
        sample.put("clientMs", ms(c1 - c0));
        long h0 = handler.start;
        long h1 = handler.end;
        sample.put("handlerMs", ms(h1 - h0));
        sample.put("phases", phases(calls, h0, h1, handler.thread));
        sample.put("cdpCalls", calls.stream().filter(c -> c.t0 >= h0 && c.t0 <= h1 && !c.method.startsWith("deskd.")).count());
        sample.put("chromiumCpuMs", (chromium1 - chromium0) * 10.0);
        sample.put("jvmCpuMs", ms(jvm1 - jvm0));
        sample.put("getMs", ms(g1 - g0));
        sample.put("snapshotMs", ms(snapshotNanos));
        return sample;
    }

    // ---- phases

    /**
     * Each call in the handler's window, put in a phase of {@code ActionProxy} by its method and op, and each phase's time
     * as the union of its calls (frames are armed at once, so their calls overlap). What's left of the window is deskd's
     * own work between calls: locks, maps, JSON, and the virtual threads it starts.
     */
    static Map<String, Object> phases(List<Call> calls, long h0, long h1, Thread handlerThread) {
        List<Call> in = calls.stream().filter(c -> c.t0 >= h0 && c.t0 <= h1 && c.t1 != 0).sorted(Comparator.comparingLong(c -> c.t0)).toList();
        Map<String, List<long[]>> spans = new LinkedHashMap<>();
        boolean prepared = false;
        boolean resulted = false;
        for (Call c : in) {
            String phase;
            switch (c.method) {
                case "deskd.thaw", "deskd.release", "deskd.resolve" -> phase = "thaw+resolve";
                case "Page.getFrameTree" -> phase = prepared ? "frames recheck" : "frames list";
                case "Runtime.callFunctionOn" -> {
                    String op = c.op == null ? "?" : c.op;
                    phase = switch (op) {
                        case "arm" -> "arm frames";
                        case "disarm" -> "disarm frames";
                        case "prepare" -> "prepare";
                        case "result" -> "result";
                        case "select" -> Boolean.TRUE.equals(c.check) ? "select check" : "select set";
                        case "scroll" -> "scroll";
                        default -> "op " + op;
                    };
                    prepared |= "prepare".equals(op);
                    resulted |= "result".equals(op);
                }
                case "Page.createIsolatedWorld" -> phase = c.thread != handlerThread ? (resulted ? "disarm frames" : "arm frames") : "context";
                case "Runtime.evaluate" -> phase = "inject";
                default -> phase = c.method.startsWith("Input.") ? "dispatch" : "other " + c.method;
            }
            spans.computeIfAbsent(phase, k -> new ArrayList<>()).add(new long[] {c.t0, c.t1});
        }
        Map<String, Object> out = new LinkedHashMap<>();
        List<long[]> everything = new ArrayList<>();
        spans.forEach((phase, list) -> {
            out.put(phase, ms(union(list)));
            everything.addAll(list);
        });
        out.put("deskd own", ms(Math.max(0, (h1 - h0) - union(everything))));
        return out;
    }

    static long union(List<long[]> spans) {
        List<long[]> sorted = new ArrayList<>(spans);
        sorted.sort(Comparator.comparingLong(s -> s[0]));
        long total = 0;
        long start = Long.MIN_VALUE;
        long end = Long.MIN_VALUE;
        for (long[] s : sorted) {
            if (s[0] > end) {
                if (end > start) {
                    total += end - start;
                }
                start = s[0];
                end = s[1];
            } else {
                end = Math.max(end, s[1]);
            }
        }
        if (end > start) {
            total += end - start;
        }
        return total;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> summarize(String page, Spec spec, List<Map<String, Object>> samples) {
        Map<String, Object> s = new LinkedHashMap<>();
        s.put("page", page);
        s.put("action", spec.name());
        s.put("n", samples.size());
        Map<String, Integer> outcomes = new TreeMap<>();
        samples.forEach(x -> outcomes.merge((String) x.get("outcome"), 1, Integer::sum));
        s.put("outcomes", outcomes);
        s.put("handlerMs", stats(samples.stream().map(x -> (Double) x.get("handlerMs")).toList()));
        s.put("clientMs", stats(samples.stream().map(x -> (Double) x.get("clientMs")).toList()));
        s.put("cdpCalls", stats(samples.stream().map(x -> ((Number) x.get("cdpCalls")).doubleValue()).toList()));
        Map<String, Object> phases = new LinkedHashMap<>();
        List<String> names = new ArrayList<>();
        for (Map<String, Object> x : samples) {
            for (String name : ((Map<String, Object>) x.get("phases")).keySet()) {
                if (!names.contains(name)) {
                    names.add(name);
                }
            }
        }
        for (String name : names) {
            phases.put(name, stats(samples.stream().map(x -> {
                Object v = ((Map<String, Object>) x.get("phases")).get(name);
                return v == null ? 0.0 : (Double) v;
            }).toList()));
        }
        s.put("phases", phases);
        s.put("snapshotBeforeMs", stats(samples.stream().map(x -> (Double) x.get("snapshotMs")).toList()));
        s.put("chromiumCpuMsPerAction", round(samples.stream().mapToDouble(x -> (Double) x.get("chromiumCpuMs")).average().orElse(0)));
        s.put("jvmCpuMsPerAction", round(samples.stream().mapToDouble(x -> (Double) x.get("jvmCpuMs")).average().orElse(0)));
        return s;
    }

    static Map<String, Object> stats(List<Double> values) {
        List<Double> sorted = new ArrayList<>(values);
        sorted.sort(Double::compare);
        Map<String, Object> s = new LinkedHashMap<>();
        if (sorted.isEmpty()) {
            return s;
        }
        s.put("p50", round(rank(sorted, 0.50)));
        s.put("p95", round(rank(sorted, 0.95)));
        s.put("max", round(sorted.get(sorted.size() - 1)));
        s.put("mean", round(sorted.stream().mapToDouble(Double::doubleValue).average().orElse(0)));
        return s;
    }

    /** Nearest rank. */
    private static double rank(List<Double> sorted, double q) {
        int index = (int) Math.ceil(q * sorted.size()) - 1;
        return sorted.get(Math.max(0, Math.min(sorted.size() - 1, index)));
    }

    // ---- the profile of deskd's in-page half

    private static final Set<String> OPS = Set.of("prepare", "result", "select", "scroll", "arm", "disarm", "snapshot", "changed");

    /**
     * The CDP sampling profiler on the tab's renderer, 100 us apart, over a batch of one action: the time under each of
     * deskd's ops in the page, split by the function the op called. Native calls (scrollIntoView, layout,
     * elementFromPoint, querySelectorAll) are the self time of the function that made them.
     */
    @SuppressWarnings("unchecked")
    private Map<String, Object> profile(String page, String tabId, Spec spec, int runs, long pauseMs) throws Exception {
        Map<String, Object> result;
        try (PageCdp cdp = new PageCdp(cdpPort, tabId)) {
            cdp.call("Profiler.enable", Map.of());
            cdp.call("Profiler.setSamplingInterval", Map.of("interval", 100));
            cdp.call("Profiler.start", Map.of());
            for (int i = 0; i < runs; i++) {
                once(page, tabId, spec, i, pauseMs);
            }
            result = cdp.call("Profiler.stop", Map.of());
            cdp.call("Profiler.disable", Map.of());
        }
        Map<String, Object> profile = (Map<String, Object>) result.get("profile");
        Map<Long, String> names = new ConcurrentHashMap<>();
        Map<Long, Long> parents = new ConcurrentHashMap<>();
        for (Object o : (List<?>) profile.get("nodes")) {
            Map<String, Object> node = (Map<String, Object>) o;
            long id = ((Number) node.get("id")).longValue();
            Map<String, Object> frame = (Map<String, Object>) node.get("callFrame");
            String name = frame == null ? "" : String.valueOf(frame.get("functionName"));
            names.put(id, name.isEmpty() ? "(anonymous)" : name);
            if (node.get("children") instanceof List<?> children) {
                for (Object child : children) {
                    parents.put(((Number) child).longValue(), id);
                }
            }
        }
        List<?> sampled = (List<?>) profile.get("samples");
        List<?> deltas = (List<?>) profile.get("timeDeltas");
        Map<String, Map<String, Double>> byOp = new TreeMap<>();
        for (int i = 0; i < sampled.size(); i++) {
            double us = i + 1 < deltas.size() ? ((Number) deltas.get(i + 1)).doubleValue() : 0;
            long at = ((Number) sampled.get(i)).longValue();
            long below = -1;
            while (true) {
                String name = names.get(at);
                if (OPS.contains(name)) {
                    String sub = below < 0 ? "(self)" : names.get(below);
                    byOp.computeIfAbsent(name, k -> new TreeMap<>()).merge(sub, us / 1000.0 / runs, Double::sum);
                    break;
                }
                Long up = parents.get(at);
                if (up == null) {
                    break;
                }
                below = at;
                at = up;
            }
        }
        Map<String, Object> rounded = new LinkedHashMap<>();
        byOp.forEach((op, subs) -> {
            Map<String, Object> r = new LinkedHashMap<>();
            r.put("total", round(subs.values().stream().mapToDouble(Double::doubleValue).sum()));
            subs.entrySet().stream().sorted(Map.Entry.<String, Double>comparingByValue().reversed())
                    .forEach(e -> r.put(e.getKey(), round(e.getValue())));
            rounded.put(op, r);
        });
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("page", page);
        out.put("action", spec.name());
        out.put("runs", runs);
        out.put("msPerActionByOp", rounded);
        log("profile %s / %s: %s", page, spec.name(), rounded);
        return out;
    }

    // ---- the view's calls, timed

    /** One call deskd's view made through {@link TabAccess}, or deskd's own step there (resolve, thaw). */
    static final class Call {
        final String method;
        final String op;
        final Boolean check;
        final Thread thread;
        final long t0;
        volatile long t1;

        Call(String method, Map<String, Object> params) {
            this.method = method;
            Map<String, Object> args = argsOf(params);
            this.op = args != null && args.get("op") instanceof String s ? s : null;
            this.check = args != null && args.get("check") instanceof Boolean b ? b : null;
            this.thread = Thread.currentThread();
            this.t0 = System.nanoTime();
        }

        @SuppressWarnings("unchecked")
        private static Map<String, Object> argsOf(Map<String, Object> params) {
            if (params != null && params.get("arguments") instanceof List<?> list && !list.isEmpty()
                    && list.get(0) instanceof Map<?, ?> first && first.get("value") instanceof Map<?, ?> value) {
                return (Map<String, Object>) value;
            }
            return null;
        }
    }

    /** The Browser's {@link TabAccess} as it is, with each call's start and end kept. */
    static final class TimedAccess implements TabAccess {
        private final TabAccess inner;
        final ConcurrentLinkedQueue<Call> calls = new ConcurrentLinkedQueue<>();

        TimedAccess(TabAccess inner) {
            this.inner = inner;
        }

        private Call start(String method, Map<String, Object> params) {
            Call call = new Call(method, params);
            calls.add(call);
            return call;
        }

        @Override
        public TabRef resolve(String tabId) throws RpcException, InterruptedException {
            Call call = start("deskd.resolve", null);
            try {
                return inner.resolve(tabId);
            } finally {
                call.t1 = System.nanoTime();
            }
        }

        @Override
        public Map<String, Object> call(TabRef tab, String method, Map<String, Object> params, Duration timeout)
                throws CdpFailure, InterruptedException {
            Call call = start(method, params);
            try {
                return inner.call(tab, method, params, timeout);
            } finally {
                call.t1 = System.nanoTime();
            }
        }

        @Override
        public Map<String, Object> callLong(TabRef tab, String method, Map<String, Object> params, Duration timeout)
                throws CdpFailure, InterruptedException {
            Call call = start(method, params);
            try {
                return inner.callLong(tab, method, params, timeout);
            } finally {
                call.t1 = System.nanoTime();
            }
        }

        @Override
        public Map<String, Object> callSession(String sessionId, String method, Map<String, Object> params, Duration timeout)
                throws CdpFailure, InterruptedException {
            Call call = start(method, params);
            try {
                return inner.callSession(sessionId, method, params, timeout);
            } finally {
                call.t1 = System.nanoTime();
            }
        }

        @Override
        public boolean isActive(String tabId) {
            return inner.isActive(tabId);
        }

        @Override
        public void listen(TabEvents events, BooleanSupplier wanted) {
            inner.listen(events, wanted);
        }

        @Override
        public void wake() {
            inner.wake();
        }

        @Override
        public AutoCloseable use() throws InterruptedException {
            Call call = start("deskd.thaw", null);
            AutoCloseable held;
            try {
                held = inner.use();
            } finally {
                call.t1 = System.nanoTime();
            }
            return () -> {
                Call release = start("deskd.release", null);
                try {
                    held.close();
                } finally {
                    release.t1 = System.nanoTime();
                }
            };
        }

        @Override
        public boolean frozen() {
            return inner.frozen();
        }
    }

    /** When {@code browser.minified.act}'s handler last began and ended, and on which thread. */
    static final class HandlerClock {
        volatile long start;
        volatile long end;
        volatile Thread thread;

        void reset() {
            start = 0;
            end = 0;
            thread = null;
        }
    }

    /**
     * The view as {@code enableMinified} makes it, but on the timed access, and the act handler wrapped in the dispatcher.
     * Reflection, so nothing in {@code main} changes for a harness.
     */
    private void installTimedModule() throws Exception {
        Field tabsField = BrowserModule.class.getDeclaredField("tabs");
        tabsField.setAccessible(true);
        BrowserTabs tabs = (BrowserTabs) tabsField.get(rig.module);
        timed = new TimedAccess(tabs.minifiedAccess());
        MinifiedModule module = new MinifiedModule(timed, rig.dispatcher, rig.hub, dir, Clock.systemUTC(), MinifiedModule.Timing.DEFAULT,
                MinifiedSwitch.fixed(true, false, false));
        Field minifiedField = BrowserModule.class.getDeclaredField("minified");
        minifiedField.setAccessible(true);
        minifiedField.set(rig.module, module);

        Field methodsField = RpcDispatcher.class.getDeclaredField("methods");
        methodsField.setAccessible(true);
        @SuppressWarnings("unchecked")
        Map<String, Object> methods = (Map<String, Object>) methodsField.get(rig.dispatcher);
        Object method = methods.get("browser.minified.act");
        RecordComponent[] parts = method.getClass().getRecordComponents();
        Object[] values = new Object[parts.length];
        Class<?>[] types = new Class<?>[parts.length];
        for (int i = 0; i < parts.length; i++) {
            java.lang.reflect.Method accessor = parts[i].getAccessor();
            accessor.setAccessible(true);
            values[i] = accessor.invoke(method);
            types[i] = parts[i].getType();
            if (values[i] instanceof RpcHandler original) {
                values[i] = (RpcHandler) (context, params) -> {
                    handler.thread = Thread.currentThread();
                    handler.start = System.nanoTime();
                    try {
                        return original.handle(context, params);
                    } finally {
                        handler.end = System.nanoTime();
                    }
                };
            }
        }
        Constructor<?> make = method.getClass().getDeclaredConstructor(types);
        make.setAccessible(true);
        methods.put("browser.minified.act", make.newInstance(values));
    }

    // ---- pages

    private void startServers() throws IOException {
        pagesA = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
        portA = pagesA.getAddress().getPort();
        pagesB = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
        portB = pagesB.getAddress().getPort();
        for (HttpServer server : List.of(pagesA, pagesB)) {
            server.createContext("/", exchange -> {
                String path = exchange.getRequestURI().getPath();
                String query = exchange.getRequestURI().getRawQuery();
                byte[] body = html(path, query).getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().set("Content-Type", "text/html; charset=utf-8");
                exchange.sendResponseHeaders(200, body.length);
                exchange.getResponseBody().write(body);
                exchange.close();
            });
            server.start();
        }
    }

    private String html(String path, String query) {
        return switch (path) {
            case "/simple" -> "<!doctype html><html><head><title>Simple</title></head><body>" + HITS + "<main><h1>The lamp shop</h1><p>"
                    + PROSE + "</p>" + TARGETS + ("<p>" + PROSE + PROSE + "</p>").repeat(30) + FAR + "</main></body></html>";
            case "/heavy" -> heavy();
            case "/frame" -> "<!doctype html><html><head><title>Frame</title></head><body style=\"margin:0\"><p>Frame " + query
                    + "</p><button type=button>Inside</button></body></html>";
            default -> "<!doctype html><title>Other</title><p>" + PROSE + "</p>";
        };
    }

    /** About 5,000 elements: a menu, the controls, 67 rooms of text, lists and tables, 20 frames, a footer of links. */
    private String heavy() {
        StringBuilder h = new StringBuilder(400_000);
        h.append("<!doctype html><html><head><title>Heavy</title><style>iframe{display:block;border:0;margin:24px 0}</style></head><body>");
        h.append(HITS).append("<header><nav><ul>");
        for (int i = 0; i < 80; i++) {
            h.append("<li><a href=\"/shelf/").append(i).append("\">Shelf ").append(i).append("</a></li>");
        }
        h.append("</ul></nav></header><main><h1>The lamp shop</h1><p>").append(PROSE).append("</p>").append(TARGETS);
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
            h.append("</ul><table><tbody>");
            for (int r = 0; r < 6; r++) {
                h.append("<tr>");
                for (int c = 0; c < 4; c++) {
                    h.append("<td>").append(r * 4 + c).append("</td>");
                }
                h.append("</tr>");
            }
            h.append("</tbody></table></section>");
            if (s % 3 == 2 && frame < FRAMES) {
                // Every fifth frame is from the other origin, so another site, in a renderer of its own.
                String origin = frame % 5 == 4 ? "http://b.test:" + portB : "http://a.test:" + portA;
                h.append("<iframe src=\"").append(origin).append("/frame?n=").append(frame).append("\" width=\"320\" height=\"160\" title=\"Frame ")
                        .append(frame).append("\"></iframe>");
                frame++;
            }
        }
        h.append(FAR).append("</main><footer>");
        for (int i = 0; i < 100; i++) {
            h.append("<div><a href=\"/about/").append(i).append("\">About ").append(i).append("</a></div>");
        }
        return h.append("</footer></body></html>").toString();
    }

    private Map<String, Object> pageFacts(String page, String tabId) throws Exception {
        Map<String, Object> facts = new LinkedHashMap<>();
        facts.put("page", page);
        facts.put("elements", Double.valueOf(inPage(tabId, "String(document.querySelectorAll('*').length)")).intValue());
        facts.put("iframes", Double.valueOf(inPage(tabId, "String(document.querySelectorAll('iframe').length)")).intValue());
        facts.put("crossSiteIframes", Double.valueOf(inPage(tabId,
                "String([...document.querySelectorAll('iframe')].filter(f => f.src.includes('b.test')).length)")).intValue());
        facts.put("scrollHeight", Double.valueOf(inPage(tabId, "String(document.documentElement.scrollHeight)")).intValue());
        Map<String, Object> mdoc = mdoc(tabId);
        facts.put("mdocBytes", Json.bytes(mdoc).length);
        facts.put("mdocBlocks", ((List<?>) mdoc.get("blocks")).size());
        facts.put("viewHealth", rig.module.minified().health());
        return facts;
    }

    // ---- the client's side

    private String open(String host, int port, String path) throws Exception {
        Map<String, Object> reply = rig.call(client, "browser.tab.navigate", Map.of("url", "http://" + host + ":" + port + path));
        if (!"RES".equals(reply.get("_kind"))) {
            throw new IllegalStateException("navigate: " + reply);
        }
        String tabId = (String) reply.get("tabId");
        await().atMost(Duration.ofSeconds(30)).until(() -> !Boolean.TRUE.equals(tab(tabId).get("loading")));
        mdoc(tabId);
        return tabId;
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> tab(String tabId) throws Exception {
        Map<String, Object> reply = rig.call(client, "browser.tab.list", Map.of(), null);
        return ((List<Map<String, Object>>) reply.get("tabs")).stream().filter(t -> tabId.equals(t.get("tabId"))).findFirst().orElseThrow();
    }

    /** The view, once it's simplified: a get refreshes a view that an action left dirty, before it answers. */
    @SuppressWarnings("unchecked")
    private Map<String, Object> mdoc(String tabId) throws Exception {
        Map<String, Object>[] last = new Map[1];
        await().atMost(Duration.ofSeconds(30)).pollInterval(Duration.ofMillis(50)).until(() -> {
            last[0] = rig.call(client, "browser.minified.get", Map.of("tabId", tabId), null);
            return "simplified".equals(last[0].get("view"));
        });
        return (Map<String, Object>) last[0].get("mdoc");
    }

    private Map<String, Object> act(String tabId, Map<String, Object> run, String action, Object value) throws Exception {
        Map<String, Object> params = new LinkedHashMap<>();
        params.put("tabId", tabId);
        params.put("nodeId", run.get("node"));
        params.put("action", action);
        if (value != null) {
            params.put("value", value);
        }
        params.put("fp", run.get("fp"));
        params.put("block", run.get("_block"));
        params.put("rev", run.get("_rev"));
        return rig.call(client, "browser.minified.act", params);
    }

    /** The first run of this kind whose JSON holds the words, with its block and the view's rev. */
    @SuppressWarnings("unchecked")
    private static Map<String, Object> find(Map<String, Object> mdoc, String r, String words) {
        for (Map<String, Object> block : (List<Map<String, Object>>) mdoc.get("blocks")) {
            for (Map<String, Object> run : all(block)) {
                if (r.equals(run.get("r")) && new String(Json.bytes(run), StandardCharsets.UTF_8).contains(words)) {
                    Map<String, Object> found = new LinkedHashMap<>(run);
                    found.put("_block", block.get("key"));
                    found.put("_rev", mdoc.get("rev"));
                    return found;
                }
            }
        }
        return null;
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> all(Object tree) {
        List<Map<String, Object>> found = new ArrayList<>();
        if (tree instanceof Map<?, ?> map) {
            found.add((Map<String, Object>) map);
            map.values().forEach(v -> found.addAll(all(v)));
        } else if (tree instanceof List<?> list) {
            list.forEach(v -> found.addAll(all(v)));
        }
        return found;
    }

    private Map<String, Object> hits(String tabId) throws Exception {
        return Json.parseObject(inPage(tabId, "JSON.stringify(hits)").getBytes(StandardCharsets.UTF_8));
    }

    /** A script in the page's own world, from the harness's own debugging socket: never deskd's session. */
    @SuppressWarnings("unchecked")
    private String inPage(String tabId, String expression) throws Exception {
        try (PageCdp cdp = new PageCdp(cdpPort, tabId)) {
            Map<String, Object> result = cdp.call("Runtime.evaluate", Map.of("expression", expression, "returnByValue", true));
            return String.valueOf(((Map<String, Object>) result.get("result")).get("value"));
        }
    }

    /** The harness's own debugging socket on a page: one connection, many commands, events ignored. */
    static final class PageCdp implements AutoCloseable {
        private final HttpClient http = HttpClient.newHttpClient();
        private final WebSocket socket;
        private final AtomicInteger ids = new AtomicInteger();
        private final Map<Integer, CompletableFuture<Map<String, Object>>> waiting = new ConcurrentHashMap<>();

        PageCdp(int port, String targetId) throws Exception {
            StringBuilder text = new StringBuilder();
            socket = http.newWebSocketBuilder()
                    .buildAsync(URI.create("ws://127.0.0.1:" + port + "/devtools/page/" + targetId), new WebSocket.Listener() {
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
                    })
                    .get(5, TimeUnit.SECONDS);
        }

        Map<String, Object> call(String method, Map<String, Object> params) throws Exception {
            int id = ids.incrementAndGet();
            CompletableFuture<Map<String, Object>> reply = new CompletableFuture<>();
            waiting.put(id, reply);
            socket.sendText(new String(Json.bytes(Map.of("id", id, "method", method, "params", params)), StandardCharsets.UTF_8), true)
                    .get(5, TimeUnit.SECONDS);
            Map<String, Object> answer = reply.get(120, TimeUnit.SECONDS);
            if (answer.get("error") != null) {
                throw new IllegalStateException(method + ": " + answer.get("error"));
            }
            return Json.object(answer, "result");
        }

        @Override
        public void close() {
            socket.abort();
            http.close();
        }
    }

    // ---- Chromium, the machine

    private void startChromium() throws IOException {
        chromium = new ProcessBuilder(
                        System.getenv("DESKD_CHROMIUM_BIN"),
                        "--headless=new", "--no-sandbox", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
                        "--noerrdialogs", "--disable-breakpad", "--password-store=basic", "--window-size=1280,800",
                        "--user-data-dir=" + dir.resolve("profile"),
                        "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=" + cdpPort,
                        "--host-resolver-rules=MAP a.test 127.0.0.1, MAP b.test 127.0.0.1",
                        "about:blank")
                .redirectErrorStream(true)
                .redirectOutput(ProcessBuilder.Redirect.appendTo(dir.resolve("chromium.log").toFile()))
                .start();
    }

    private List<ProcessHandle> chromiumTree() {
        List<ProcessHandle> all = new ArrayList<>();
        all.add(chromium.toHandle());
        chromium.toHandle().descendants().forEach(all::add);
        return all;
    }

    /** Chromium's CPU, every process of it, in clock ticks (10 ms). */
    private long chromiumTicks() {
        long sum = 0;
        for (ProcessHandle p : chromiumProcesses) {
            try {
                String stat = Files.readString(Path.of("/proc/" + p.pid() + "/stat"));
                String[] f = stat.substring(stat.lastIndexOf(')') + 2).split(" ");
                sum += Long.parseLong(f[11]) + Long.parseLong(f[12]);
            } catch (IOException | RuntimeException e) {
                // Gone: its CPU goes with it.
            }
        }
        return sum;
    }

    private Map<String, Object> machine() throws Exception {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("cpus", Runtime.getRuntime().availableProcessors());
        m.put("cpu", Files.readAllLines(Path.of("/proc/cpuinfo")).stream().filter(l -> l.startsWith("model name")).findFirst()
                .map(l -> l.substring(l.indexOf(':') + 1).trim()).orElse("?"));
        m.put("arch", System.getProperty("os.arch"));
        m.put("java", System.getProperty("java.version"));
        try (HttpClient http = HttpClient.newHttpClient()) {
            String version = http.send(HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + cdpPort + "/json/version")).build(),
                    HttpResponse.BodyHandlers.ofString()).body();
            m.put("chromium", Json.string(Json.parseObject(version.getBytes(StandardCharsets.UTF_8)), "Browser"));
        }
        m.put("chromiumFlags", "--headless=new --disable-gpu --window-size=1280,800");
        m.put("loadavgAtStart", loadavg());
        return m;
    }

    private static String loadavg() {
        try {
            String[] f = Files.readString(Path.of("/proc/loadavg")).split(" ");
            return f[0] + " " + f[1] + " " + f[2];
        } catch (IOException e) {
            return "?";
        }
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

    private static int freePort() throws IOException {
        try (ServerSocket socket = new ServerSocket(0)) {
            return socket.getLocalPort();
        }
    }

    private void close() throws Exception {
        if (rig != null) {
            rig.close();
        }
        for (HttpServer server : new HttpServer[] {pagesA, pagesB}) {
            if (server != null) {
                server.stop(0);
            }
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

    // ---- the report

    @SuppressWarnings("unchecked")
    private static String markdown(Map<String, Object> report) {
        StringBuilder md = new StringBuilder();
        md.append("Machine: ").append(report.get("machine")).append("\n\n");
        md.append("| Page | Action | n | Outcomes | deskd's method p50 / p95 / max (ms) | Through the RPC p50 / p95 / max (ms) | CDP calls p50"
                + " | Re-distill p50 (ms) | Chromium CPU / action (ms) | Load before, after |\n|---|---|---|---|---|---|---|---|---|---|\n");
        for (Map<String, Object> b : (List<Map<String, Object>>) report.get("batches")) {
            md.append("| ").append(b.get("page")).append(" | ").append(b.get("action")).append(" | ").append(b.get("n")).append(" | ")
                    .append(b.get("outcomes")).append(" | ").append(triple((Map<String, Object>) b.get("handlerMs"))).append(" | ")
                    .append(triple((Map<String, Object>) b.get("clientMs"))).append(" | ")
                    .append(((Map<String, Object>) b.get("cdpCalls")).get("p50")).append(" | ")
                    .append(((Map<String, Object>) b.get("snapshotBeforeMs")).get("p50")).append(" | ").append(b.get("chromiumCpuMsPerAction"))
                    .append(" | ").append(b.get("loadavgBefore")).append(", ").append(b.get("loadavgAfter")).append(" |\n");
        }
        md.append("\nPhases, p50 / p95 (ms):\n\n");
        for (Map<String, Object> b : (List<Map<String, Object>>) report.get("batches")) {
            md.append("- ").append(b.get("page")).append(" / ").append(b.get("action")).append(": ");
            List<String> parts = new ArrayList<>();
            ((Map<String, Object>) b.get("phases")).forEach((phase, s) -> parts.add(phase + " "
                    + ((Map<String, Object>) s).get("p50") + " / " + ((Map<String, Object>) s).get("p95")));
            md.append(String.join(", ", parts)).append("\n");
        }
        md.append("\nIn the page (profiler, ms per action, by op and the function it called):\n\n");
        for (Map<String, Object> p : (List<Map<String, Object>>) report.get("profiles")) {
            md.append("- ").append(p.get("page")).append(" / ").append(p.get("action")).append(": ").append(p.get("msPerActionByOp")).append("\n");
        }
        return md.toString();
    }

    private static String triple(Map<String, Object> s) {
        return s.get("p50") + " / " + s.get("p95") + " / " + s.get("max");
    }

    private static double ms(long nanos) {
        return round(nanos / 1e6);
    }

    private static double round(double v) {
        return Math.round(v * 100) / 100.0;
    }

    private static String env(String name, String otherwise) {
        String value = System.getenv(name);
        return value == null || value.isBlank() ? otherwise : value;
    }

    private static void log(String format, Object... args) {
        System.out.println("[b8] " + String.format(Locale.ROOT, format, args));
    }
}
