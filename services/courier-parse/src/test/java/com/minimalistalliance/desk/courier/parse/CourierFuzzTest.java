package com.minimalistalliance.desk.courier.parse;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.courier.testkit.HostileHtml;
import com.minimalistalliance.desk.courier.testkit.MimeCorpus;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.SplittableRandom;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.Test;
import tools.jackson.jr.ob.JSON;

/**
 * The bar's fuzzing line (the launch plan §7): mutated mail through the whole Courier mode, and mutated HTML through the
 * sanitizer, checked by an oracle that doesn't trust the code under test. For every input:
 * <ul>
 * <li><b>no crash:</b> the worker answers {@code OK} with valid JSON in {@code fromWire}'s shape, or {@code ERR} with one
 *     of its words; no exception or error leaves it;</li>
 * <li><b>no escape:</b> any HTML it keeps has nothing that runs or loads ({@link HostileHtmlTest#escapes}, a separate
 *     reading of the output), passes the second pass again, and is within its cap;</li>
 * <li><b>no hang:</b> an input that takes more than the parse limit is counted and kept.</li>
 * </ul>
 * In a build it runs a few thousand of each; {@code -Dcourier.fuzz.mime=N -Dcourier.fuzz.html=N
 * -Dcourier.fuzz.threads=T -Dcourier.fuzz.out=DIR} runs the long one, and keeps every failing input in {@code DIR}.
 */
class CourierFuzzTest {

    private static final java.util.Set<String> REASONS = java.util.Set.of("too_large", "too_deep", "too_many_parts", "timeout",
            "malformed", "too_complex");

    /** Why inputs ended {@code malformed}: exception class and where it was thrown, to tell mime4j's no from a bug of ours. */
    static final Map<String, AtomicLong> CAUSES = new ConcurrentHashMap<>();

    record Tally(AtomicLong inputs, AtomicLong ok, AtomicLong refused, AtomicLong crashes, AtomicLong escapes, AtomicLong slow,
            AtomicLong maxMillis, Map<String, AtomicLong> reasons) {
        static Tally create() {
            return new Tally(new AtomicLong(), new AtomicLong(), new AtomicLong(), new AtomicLong(), new AtomicLong(),
                    new AtomicLong(), new AtomicLong(), new ConcurrentHashMap<>());
        }
    }

    @Test
    void mutatedMailIsReadOrRefusedAndKeepsNothingThatRunsOrLoads() throws Exception {
        long mime = Long.getLong("courier.fuzz.mime", 3_000);
        long html = Long.getLong("courier.fuzz.html", 6_000);
        int threads = Integer.getInteger("courier.fuzz.threads", 2);
        long seed = Long.getLong("courier.fuzz.seed", 20261114L);
        String outDir = System.getProperty("courier.fuzz.out");
        Path out = outDir == null ? null : Path.of(outDir);
        if (out != null) {
            Files.createDirectories(out);
        }
        List<byte[]> seeds = new ArrayList<>();
        MimeCorpus.standard().forEach(s -> seeds.add(s.raw()));
        List<String> htmlSeeds = new ArrayList<>();
        for (HostileHtml.Vector v : HostileHtml.vectors(HostileHtml.CORPUS_HIT_BASE)) {
            htmlSeeds.add(v.html());
            seeds.add(("From: f@example.com\r\nSubject: v\r\nContent-Type: text/html; charset=utf-8\r\n\r\n" + v.html())
                    .getBytes(StandardCharsets.UTF_8));
        }
        Tally t = Tally.create();
        Tally h = Tally.create();
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        long started = System.nanoTime();
        for (int w = 0; w < threads; w++) {
            long workerSeed = seed + w * 7919L;
            long mimeShare = mime / threads + (w < mime % threads ? 1 : 0);
            long htmlShare = html / threads + (w < html % threads ? 1 : 0);
            pool.submit(() -> {
                SplittableRandom r = new SplittableRandom(workerSeed);
                for (long i = 0; i < mimeShare; i++) {
                    byte[] input = Mutate.mime(seeds.get(r.nextInt(seeds.size())), seeds.get(r.nextInt(seeds.size())), r);
                    checkMime(input, t, out);
                }
                for (long i = 0; i < htmlShare; i++) {
                    String input = Mutate.html(htmlSeeds.get(r.nextInt(htmlSeeds.size())), htmlSeeds.get(r.nextInt(htmlSeeds.size())), r);
                    checkHtml(input, h, out);
                }
                return null;
            });
        }
        pool.shutdown();
        assertThat(pool.awaitTermination(7, TimeUnit.DAYS)).isTrue();
        long secs = Math.max(1, (System.nanoTime() - started) / 1_000_000_000L);
        System.out.printf("fuzz mime: %d inputs, %d read, %d refused %s, %d crashes, %d escapes, %d over %d ms (slowest %d ms)%n",
                t.inputs.get(), t.ok.get(), t.refused.get(), t.reasons, t.crashes.get(), t.escapes.get(), t.slow.get(),
                Limits.PARSE_MILLIS, t.maxMillis.get());
        System.out.printf("fuzz html: %d inputs, %d kept html, %d crashes, %d escapes, %d over %d ms (slowest %d ms); %d s, %d threads%n",
                h.inputs.get(), h.ok.get(), h.crashes.get(), h.escapes.get(), h.slow.get(), Limits.PARSE_MILLIS, h.maxMillis.get(),
                secs, threads);
        System.out.println("fuzz malformed causes: " + CAUSES);
        assertThat(t.crashes.get() + h.crashes.get()).isZero();
        assertThat(t.escapes.get() + h.escapes.get()).isZero();
        assertThat(t.slow.get() + h.slow.get()).isZero();
    }

    private static void keep(Path out, String kind, byte[] input) {
        if (out == null) {
            return;
        }
        try {
            Files.write(out.resolve(kind + "-" + Integer.toHexString(java.util.Arrays.hashCode(input)) + ".bin"), input);
        } catch (Exception e) {
            // Best effort: the count still says it.
        }
    }

    static void checkMime(byte[] raw, Tally t, Path out) {
        t.inputs.incrementAndGet();
        ByteArrayOutputStream answer = new ByteArrayOutputStream();
        byte[] request = new byte[raw.length + 17];
        System.arraycopy("courier1 message\n".getBytes(StandardCharsets.US_ASCII), 0, request, 0, 17);
        System.arraycopy(raw, 0, request, 17, raw.length);
        long start = System.nanoTime();
        try {
            CourierWorker.serve(new ByteArrayInputStream(request), answer, Limits.PARSE_MILLIS);
        } catch (Throwable e) {
            t.crashes.incrementAndGet();
            keep(out, "crash-" + e.getClass().getSimpleName(), raw);
            return;
        }
        long ms = (System.nanoTime() - start) / 1_000_000;
        t.maxMillis.accumulateAndGet(ms, Math::max);
        if (ms > Limits.PARSE_MILLIS) {
            t.slow.incrementAndGet();
            keep(out, "slow", raw);
        }
        byte[] a = answer.toByteArray();
        int nl = 0;
        while (nl < a.length && a[nl] != '\n') {
            nl++;
        }
        String line = new String(a, 0, nl, StandardCharsets.US_ASCII);
        if (line.startsWith("ERR ") && REASONS.contains(line.substring(4)) && nl == a.length - 1) {
            t.refused.incrementAndGet();
            t.reasons.computeIfAbsent(line.substring(4), k -> new AtomicLong()).incrementAndGet();
            if (line.equals("ERR malformed")) {
                Throwable why = Mime.LAST_FAILURE.get();
                String where = why == null ? "none" : why.getClass().getSimpleName() + "(" + why.getMessage() + ")@" + (why.getStackTrace().length == 0 ? "?"
                        : why.getStackTrace()[0].getClassName().replaceAll(".*\\.", "") + "." + why.getStackTrace()[0].getMethodName());
                CAUSES.computeIfAbsent(where, k -> new AtomicLong()).incrementAndGet();
                Mime.LAST_FAILURE.remove();
            }
            if (line.equals("ERR timeout")) {
                // A refusal, but the bar wants none under 10 s of work: count it as slow too.
                t.slow.incrementAndGet();
                keep(out, "timeout", raw);
            }
            return;
        }
        if (!line.equals("OK")) {
            t.crashes.incrementAndGet();
            keep(out, "badline", raw);
            return;
        }
        try {
            Map<String, Object> m = JSON.std.mapFrom(new String(a, nl + 1, a.length - nl - 1, StandardCharsets.UTF_8));
            Object html = m.get("html");
            Object text = m.get("text");
            if (!Integer.valueOf(1).equals(m.get("v")) || !(text instanceof String s) || s.length() > Limits.MAX_TEXT_CHARS) {
                t.crashes.incrementAndGet();
                keep(out, "shape", raw);
                return;
            }
            if (html != null && (!(html instanceof String hs) || hs.length() > Limits.MAX_HTML_OUT_CHARS
                    || !HostileHtmlTest.escapes(hs).isEmpty() || !Html.verify(hs))) {
                t.escapes.incrementAndGet();
                keep(out, "escape", raw);
                return;
            }
            t.ok.incrementAndGet();
        } catch (Exception e) {
            t.crashes.incrementAndGet();
            keep(out, "json", raw);
        }
    }

    static void checkHtml(String input, Tally t, Path out) {
        t.inputs.incrementAndGet();
        long start = System.nanoTime();
        Html.Result r;
        try {
            r = Html.sanitize(input.length() > Limits.MAX_HTML_IN_CHARS ? input.substring(0, Limits.MAX_HTML_IN_CHARS) : input,
                    new Html.Budget());
        } catch (Throwable e) {
            t.crashes.incrementAndGet();
            keep(out, "html-crash-" + e.getClass().getSimpleName(), input.getBytes(StandardCharsets.UTF_8));
            return;
        }
        long ms = (System.nanoTime() - start) / 1_000_000;
        t.maxMillis.accumulateAndGet(ms, Math::max);
        if (ms > Limits.PARSE_MILLIS) {
            t.slow.incrementAndGet();
        }
        if (r.html() != null) {
            t.ok.incrementAndGet();
            if (!HostileHtmlTest.escapes(r.html()).isEmpty() || !Html.verify(r.html())) {
                t.escapes.incrementAndGet();
                keep(out, "html-escape", input.getBytes(StandardCharsets.UTF_8));
            }
        }
    }

    /** Mutations: bytes, MIME structure, and HTML that's tag soup on purpose. */
    static final class Mutate {
        private Mutate() {}

        private static final String[] TOKENS = {"\r\n", "\n", "\r", "--", "boundary=", "Content-Type: multipart/mixed; boundary=\"x\"\r\n",
            "Content-Transfer-Encoding: base64\r\n", "Content-Transfer-Encoding: quoted-printable\r\n", "=?utf-8?B?", "?=", "=?", "=\r\n",
            "charset=utf-7", "charset=\"x-unknown\"", "\u0000", "<", ">", "\"", "'", "<script>", "</", "<!--", "-->", "<![CDATA[", "]]>",
            "<svg><style>", "</style>", "<math><mi>", "<table><tr><td>", "<noscript>", "<template>", "<a href=", "javascript:",
            "&#x6A;", "&lt;", "<img src=x onerror=alert(1)>", "\r\n--x\r\n", "\r\n--x--\r\n", "Content-Disposition: attachment; filename*=utf-8''%E2%80%AE.exe\r\n",
            "begin 644 x\r\n", "PK\u0003\u0004", "MZ", "ÿþ", "\u001b$B", "=?iso-2022-jp?B?GyRCJDMbKEI=?=", "From: <a@b>\r\n",
            "References: <" + "a".repeat(200) + ">\r\n"};

        static byte[] mime(byte[] a, byte[] b, SplittableRandom r) {
            byte[] x = a.length > 300_000 ? java.util.Arrays.copyOf(a, 300_000) : a.clone();
            int rounds = 1 + r.nextInt(8);
            for (int k = 0; k < rounds; k++) {
                x = switch (r.nextInt(9)) {
                    case 0 -> flip(x, r);
                    case 1 -> insert(x, TOKENS[r.nextInt(TOKENS.length)].getBytes(StandardCharsets.ISO_8859_1), r);
                    case 2 -> delete(x, r);
                    case 3 -> duplicate(x, r);
                    case 4 -> splice(x, b, r);
                    case 5 -> insert(x, randomBytes(r, 1 + r.nextInt(64)), r);
                    case 6 -> java.util.Arrays.copyOf(x, r.nextInt(x.length + 1));
                    case 7 -> nest(x, r);
                    default -> replaceLineEnds(x, r);
                };
                if (x.length > 1_000_000) {
                    x = java.util.Arrays.copyOf(x, 1_000_000);
                }
            }
            return x;
        }

        static String html(String a, String b, SplittableRandom r) {
            StringBuilder x = new StringBuilder(r.nextInt(4) == 0 ? soup(r) : a);
            int rounds = 1 + r.nextInt(8);
            for (int k = 0; k < rounds; k++) {
                int at = x.isEmpty() ? 0 : r.nextInt(x.length() + 1);
                switch (r.nextInt(6)) {
                    case 0 -> x.insert(at, TOKENS[r.nextInt(TOKENS.length)]);
                    case 1 -> x.insert(at, b.substring(r.nextInt(Math.max(1, b.length()))));
                    case 2 -> {
                        if (!x.isEmpty()) {
                            int end = Math.min(x.length(), at + r.nextInt(32));
                            x.delete(Math.min(at, x.length()), end);
                        }
                    }
                    case 3 -> x.insert(at, (char) r.nextInt(0x3000));
                    case 4 -> x.insert(at, soup(r));
                    default -> {
                        if (!x.isEmpty() && at < x.length()) {
                            x.setCharAt(at, Character.toUpperCase(x.charAt(at)));
                        }
                    }
                }
            }
            return x.length() > 200_000 ? x.substring(0, 200_000) : x.toString();
        }

        private static final String[] TAGS = {"a", "img", "svg", "math", "style", "script", "table", "tr", "td", "p", "div", "font",
            "noscript", "template", "iframe", "form", "input", "button", "select", "option", "textarea", "xmp", "plaintext", "title",
            "base", "meta", "link", "object", "embed", "video", "source", "picture", "mi", "mglyph", "foreignobject", "desc", "annotation-xml"};
        private static final String[] ATTRS = {"href", "src", "srcset", "style", "onerror", "onload", "onclick", "action", "formaction",
            "background", "poster", "xlink:href", "data", "srcdoc", "width", "height", "title", "alt", "id", "class", "is", "ping"};
        private static final String[] VALUES = {"javascript:alert(1)", "http://hit.invalid/hit/soup", "//hit.invalid/hit/soup",
            "data:text/html,<script>alert(1)</script>", "x", "1", "0", "expression(alert(1))", "url(http://hit.invalid/hit/soup)",
            "alert(1)", "&#106;avascript:alert(1)", "java\tscript:alert(1)", "cid:x@y", "data:image/png;base64,iVBORw0KGgo="};

        static String soup(SplittableRandom r) {
            StringBuilder s = new StringBuilder();
            int n = 1 + r.nextInt(12);
            for (int i = 0; i < n; i++) {
                String tag = TAGS[r.nextInt(TAGS.length)];
                s.append('<').append(r.nextBoolean() ? tag : tag.toUpperCase());
                int attrs = r.nextInt(3);
                for (int k = 0; k < attrs; k++) {
                    s.append(' ').append(ATTRS[r.nextInt(ATTRS.length)]).append("=\"").append(VALUES[r.nextInt(VALUES.length)]).append('"');
                }
                s.append('>');
                if (r.nextBoolean()) {
                    s.append("text").append(i);
                }
                if (r.nextInt(3) > 0) {
                    s.append("</").append(TAGS[r.nextInt(TAGS.length)]).append('>');
                }
            }
            return s.toString();
        }

        private static byte[] flip(byte[] x, SplittableRandom r) {
            if (x.length == 0) {
                return x;
            }
            byte[] y = x.clone();
            int n = 1 + r.nextInt(16);
            for (int i = 0; i < n; i++) {
                y[r.nextInt(y.length)] ^= (byte) (1 << r.nextInt(8));
            }
            return y;
        }

        private static byte[] insert(byte[] x, byte[] what, SplittableRandom r) {
            int at = r.nextInt(x.length + 1);
            byte[] y = new byte[x.length + what.length];
            System.arraycopy(x, 0, y, 0, at);
            System.arraycopy(what, 0, y, at, what.length);
            System.arraycopy(x, at, y, at + what.length, x.length - at);
            return y;
        }

        private static byte[] delete(byte[] x, SplittableRandom r) {
            if (x.length == 0) {
                return x;
            }
            int at = r.nextInt(x.length);
            int len = Math.min(x.length - at, 1 + r.nextInt(256));
            byte[] y = new byte[x.length - len];
            System.arraycopy(x, 0, y, 0, at);
            System.arraycopy(x, at + len, y, at, x.length - at - len);
            return y;
        }

        private static byte[] duplicate(byte[] x, SplittableRandom r) {
            if (x.length == 0) {
                return x;
            }
            int at = r.nextInt(x.length);
            int len = Math.min(x.length - at, 1 + r.nextInt(512));
            byte[] piece = java.util.Arrays.copyOfRange(x, at, at + len);
            byte[] y = x;
            int times = 1 + r.nextInt(r.nextInt(10) == 0 ? 200 : 4);
            for (int i = 0; i < times && y.length < 1_000_000; i++) {
                y = insert(y, piece, r);
            }
            return y;
        }

        private static byte[] splice(byte[] x, byte[] other, SplittableRandom r) {
            if (other.length == 0) {
                return x;
            }
            int from = r.nextInt(other.length);
            int len = Math.min(other.length - from, 1 + r.nextInt(4096));
            return insert(x, java.util.Arrays.copyOfRange(other, from, from + len), r);
        }

        private static byte[] nest(byte[] x, SplittableRandom r) {
            int depth = 1 + r.nextInt(r.nextInt(5) == 0 ? 30 : 5);
            StringBuilder head = new StringBuilder();
            StringBuilder tail = new StringBuilder();
            for (int i = 0; i < depth; i++) {
                head.append("Content-Type: multipart/mixed; boundary=\"n").append(i).append("\"\r\n\r\n--n").append(i).append("\r\n");
                tail.insert(0, "\r\n--n" + i + "--\r\n");
            }
            byte[] h = head.toString().getBytes(StandardCharsets.US_ASCII);
            byte[] t = tail.toString().getBytes(StandardCharsets.US_ASCII);
            byte[] y = new byte[h.length + x.length + t.length];
            System.arraycopy(h, 0, y, 0, h.length);
            System.arraycopy(x, 0, y, h.length, x.length);
            System.arraycopy(t, 0, y, h.length + x.length, t.length);
            return y;
        }

        private static byte[] replaceLineEnds(byte[] x, SplittableRandom r) {
            String s = new String(x, StandardCharsets.ISO_8859_1);
            String to = new String[] {"\n", "\r", "\r\n", "\n\r"}[r.nextInt(4)];
            return s.replace("\r\n", to).getBytes(StandardCharsets.ISO_8859_1);
        }

        private static byte[] randomBytes(SplittableRandom r, int n) {
            byte[] b = new byte[n];
            r.nextBytes(b);
            return b;
        }
    }
}
