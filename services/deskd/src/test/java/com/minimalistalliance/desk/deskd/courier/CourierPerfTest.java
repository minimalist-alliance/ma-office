package com.minimalistalliance.desk.deskd.courier;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import com.minimalistalliance.desk.deskd.courier.parse.ParsedMessage;
import com.minimalistalliance.desk.deskd.courier.store.AgentView;
import com.minimalistalliance.desk.deskd.courier.store.Courier;
import com.minimalistalliance.desk.deskd.courier.store.CourierStore;
import com.minimalistalliance.desk.deskd.courier.store.Invariants;
import com.minimalistalliance.desk.deskd.courier.store.Lanes;
import com.minimalistalliance.desk.deskd.courier.store.SearchQuery;
import com.minimalistalliance.desk.deskd.testing.MutableClock;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Performance at 100,000 messages (the plan's bar, §7: search p95 300 ms over 50,000, a thread 150 ms, 100 new for
 * {@code courier_new} 500 ms). Not part of a normal build: {@code -Dcourier.perf=true} runs it, and {@code
 * -Dcourier.perf.messages} sets the size. The messages are realistic in shape: 2,000 correspondents with a few very
 * frequent, Zipf-distributed words, replies with References, bulk mail, attachments. They come already parsed, as from
 * the sandbox, so the numbers are the store's own: the blob written and synced, the rows, the index, the commit.
 */
class CourierPerfTest {

    private static final int MESSAGES = Integer.getInteger("courier.perf.messages", 100_000);
    static final String[] VOCAB = vocabulary(6000);

    @Test
    void oneHundredThousandMessages(@TempDir Path dir) throws Exception {
        assumeTrue(Boolean.getBoolean("courier.perf"), "set -Dcourier.perf=true");
        MutableClock clock = new MutableClock(Instant.parse("2026-11-12T12:00:00Z"));
        Map<String, Object> report = new LinkedHashMap<>();
        Random rnd = new Random(2026);
        try (CourierStore store = CourierStore.open(dir.resolve("courier"), TestMime.PARSER, clock, CourierStore.Settings.DEFAULT)) {
            store.putAccount(new Courier.Account("gmail", "imap", "Gmail", "me@gmail.example", "ok"),
                    List.<String[]>of(new String[] {"email", "me@gmail.example"}));
            store.putAccount(new Courier.Account("desk", "desk", "Desk", "me@desk.example", "ok"),
                    List.<String[]>of(new String[] {"email", "me@desk.example"}));

            // ---- insert: a first sync in batches of 100, then live mail one at a time.
            int live = 1000;
            long t0 = System.nanoTime();
            long[] batchMs = new long[(MESSAGES - live) / 100 + 1];
            int b = 0;
            for (int at = 0; at < MESSAGES - live; at += 100) {
                List<Courier.Inbound> batch = new ArrayList<>(100);
                for (int i = at; i < Math.min(MESSAGES - live, at + 100); i++) {
                    batch.add(message(rnd, i));
                }
                long s = System.nanoTime();
                store.accept(batch, new Courier.CursorUpdate("gmail", "INBOX", Integer.toString(at)));
                batchMs[b++] = (System.nanoTime() - s) / 1_000_000;
                clock.advance(Duration.ofMillis(5));
            }
            double bulkSeconds = (System.nanoTime() - t0) / 1e9;
            report.put("bulkMessages", MESSAGES - live);
            report.put("bulkSeconds", round(bulkSeconds));
            report.put("bulkPerMessageMs", round(bulkSeconds * 1000 / (MESSAGES - live)));
            report.put("batch100", stats(Arrays.copyOf(batchMs, b)));
            long[] singleUs = new long[live];
            for (int i = 0; i < live; i++) {
                Courier.Inbound in = message(rnd, MESSAGES - live + i);
                long s = System.nanoTime();
                store.accept(in);
                singleUs[i] = (System.nanoTime() - s) / 1000;
                clock.advance(Duration.ofMillis(50));
            }
            report.put("singleInsertMs", statsUs(singleUs));
            assertThat(Invariants.messages(store)).isEqualTo(MESSAGES);

            // ---- search
            Map<String, Object> search = new LinkedHashMap<>();
            String[][] kinds = {
                {"common", VOCAB[3]}, {"mid", VOCAB[200]}, {"rare", VOCAB[5000]}, {"two-words", VOCAB[10] + " " + VOCAB[40]},
                {"prefix-3", VOCAB[7].substring(0, Math.min(3, VOCAB[7].length()))}, {"phrase", "\"" + VOCAB[1] + " " + VOCAB[2] + "\""},
                {"from", "from:p12"}, {"has-attachment", "has:attachment " + VOCAB[30]}, {"date-range", VOCAB[5] + " after:2026-06-01 before:2026-09-01"},
                {"filter-only", "has:attachment"},
                // The hard ones: a common word in a lane that has none of it (every match read and passed over), in one
                // mid-sized channel, and the third page of a common word.
                {"common-empty-lane", "in:spam " + VOCAB[3]}, {"common-one-channel", VOCAB[3]}, {"common-page-3", VOCAB[3]},
            };
            List<String> channels = channels(store);
            String midChannel = channels.get(Math.min(channels.size() - 1, 200));
            long[] all = new long[kinds.length * 30];
            int k = 0;
            for (String[] kind : kinds) {
                long[] us = new long[30];
                SearchQuery q = SearchQuery.parse(kind[1]);
                List<String> lanes = kind[0].equals("common-empty-lane") ? Lanes.ALL : Lanes.DEFAULT_VISIBLE;
                String channel = kind[0].equals("common-one-channel") ? midChannel : null;
                Object next = null;
                if (kind[0].equals("common-page-3")) {
                    next = store.queries().search(q, lanes, null, null, 50, ZoneOffset.UTC).get("next");
                    next = store.queries().search(q, lanes, null, next, 50, ZoneOffset.UTC).get("next");
                }
                for (int i = 0; i < 30; i++) {
                    long s = System.nanoTime();
                    store.queries().search(q, lanes, channel, next, 50, ZoneOffset.UTC);
                    us[i] = (System.nanoTime() - s) / 1000;
                    all[k++] = us[i];
                }
                search.put(kind[0], statsUs(us));
            }
            search.put("all", statsUs(all));
            report.put("searchMs", search);

            // ---- a thread, a list, the agent tools
            long[] threadUs = new long[500];
            for (int i = 0; i < threadUs.length; i++) {
                String ch = channels.get(rnd.nextInt(Math.min(channels.size(), i % 2 == 0 ? 50 : channels.size())));
                long s = System.nanoTime();
                store.queries().thread(ch, null, null, 50);
                threadUs[i] = (System.nanoTime() - s) / 1000;
            }
            report.put("threadLoadMs", statsUs(threadUs));
            long[] listUs = new long[200];
            for (int i = 0; i < listUs.length; i++) {
                long s = System.nanoTime();
                store.queries().list(i % 2 == 0 ? "people" : "other", null, null, 50, false);
                listUs[i] = (System.nanoTime() - s) / 1000;
            }
            report.put("listMs", statsUs(listUs));
            AgentView agents = new AgentView(store, () -> true, () -> true);
            com.minimalistalliance.desk.deskd.courier.CourierRead.Cursor end = agents.now();
            long[] newUs = new long[100];
            for (int i = 0; i < newUs.length; i++) {
                long back = 1 + rnd.nextInt(2000);
                com.minimalistalliance.desk.deskd.courier.CourierRead.Cursor c =
                        new com.minimalistalliance.desk.deskd.courier.CourierRead.Cursor(end.receivedAt() - back * 5, "");
                long s = System.nanoTime();
                agents.newSince(c, 100);
                newUs[i] = (System.nanoTime() - s) / 1000;
            }
            report.put("agentNew100Ms", statsUs(newUs));
            long[] agentSearchUs = new long[100];
            for (int i = 0; i < agentSearchUs.length; i++) {
                long s = System.nanoTime();
                agents.search(VOCAB[rnd.nextInt(500)], null, null, null, null, null);
                agentSearchUs[i] = (System.nanoTime() - s) / 1000;
            }
            report.put("agentSearchMs", statsUs(agentSearchUs));
            long[] countsUs = new long[50];
            for (int i = 0; i < countsUs.length; i++) {
                long s = System.nanoTime();
                store.queries().counts();
                store.bytes();
                countsUs[i] = (System.nanoTime() - s) / 1000;
            }
            report.put("statusMs", statsUs(countsUs));
            long dbBytes = Files.size(dir.resolve("courier/courier.db"));
            Path wal = dir.resolve("courier/courier.db-wal");
            long walBytes = Files.exists(wal) ? Files.size(wal) : 0;
            report.put("dbMiB", round(dbBytes / 1048576.0));
            report.put("walMiB", round(walBytes / 1048576.0));
            report.put("blobRows", Invariants.scalar(store, "SELECT count(*) FROM blob_data"));
            report.put("blobRowMiB", round(Invariants.scalar(store, "SELECT coalesce(sum(length(data)), 0) FROM blob_data") / 1048576.0));
            report.put("blobFiles", Invariants.scalar(store,
                    "SELECT count(DISTINCT blob) FROM messages WHERE blob IS NOT NULL AND blob NOT IN (SELECT sha FROM blob_data)"));
            report.put("blobFileMiB", round((store.bytesOnDisk() - dbBytes - walBytes) / 1048576.0));
            report.put("storeMiB", round(store.bytesOnDisk() / 1048576.0));
            report.put("storeAllocatedMiB", allocatedMiB(dir.resolve("courier")));
            report.put("rawMiB", round(store.bytes() / 1048576.0));
            report.put("integrity", store.integrity());
        }
        // The heap a store holds open at rest, with its 100,000 messages: none of them is kept in memory.
        Runtime rt = Runtime.getRuntime();
        System.gc();
        long before = rt.totalMemory() - rt.freeMemory();
        try (CourierStore held = CourierStore.open(dir.resolve("courier"), TestMime.PARSER, clock, CourierStore.Settings.DEFAULT)) {
            held.queries().counts();
            held.queries().list("people", null, null, 50, false);
            System.gc();
            long after = rt.totalMemory() - rt.freeMemory();
            report.put("heapAtRestMiB", round(Math.max(0, after - before) / 1048576.0));
        }
        // Opening the store at boot, on deskd's start path: five times, after the first.
        long[] openUs = new long[5];
        for (int i = 0; i < openUs.length; i++) {
            long s = System.nanoTime();
            try (CourierStore again = CourierStore.open(dir.resolve("courier"), TestMime.PARSER, clock, CourierStore.Settings.DEFAULT)) {
                openUs[i] = (System.nanoTime() - s) / 1000;
                assertThat(again.queries().counts()).isNotNull();
            }
        }
        report.put("openMs", statsUs(openUs));
        long rawTotal = 0;
        Random again = new Random(2026);
        for (int i = 0; i < 2000; i++) {
            rawTotal += message(again, i).raw().length;
        }
        report.put("rawBytesPerMessageSample", rawTotal / 2000);
        String json = new String(com.minimalistalliance.desk.deskd.protocol.Json.bytes(report), StandardCharsets.UTF_8);
        System.out.println("COURIER-PERF " + json);
        Files.writeString(Path.of("target", "courier-perf.json"), json);
    }

    /** What the drive gives the store, blocks included ({@code du -sk}), or -1 where there's no {@code du}. */
    private static double allocatedMiB(Path dir) {
        try {
            Process p = new ProcessBuilder("du", "-sk", dir.toString()).redirectErrorStream(true).start();
            String out = new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8).trim();
            return p.waitFor() == 0 ? round(Long.parseLong(out.split("\\s+")[0]) / 1024.0) : -1;
        } catch (Exception e) {
            return -1;
        }
    }

    private static List<String> channels(CourierStore store) throws Exception {
        return Invariants.read(store, c -> {
            List<String> out = new ArrayList<>();
            try (var ps = c.prepareStatement("SELECT channel_id FROM channel_lanes GROUP BY channel_id ORDER BY sum(count) DESC");
                    var r = ps.executeQuery()) {
                while (r.next()) {
                    out.add(r.getString(1));
                }
            }
            return out;
        });
    }

    /** One message of the corpus: parsed already (the sandbox's work), with its raw bytes for the blob. */
    static Courier.Inbound message(Random rnd, int i) {
        int person = zipf(rnd, 2000);
        boolean bulk = rnd.nextInt(100) < 15;
        String from = "p" + person + "@" + (bulk ? "news" + (person % 40) + ".example" : "example.com");
        StringBuilder text = new StringBuilder();
        int words = 30 + rnd.nextInt(rnd.nextInt(10) == 0 ? 2000 : 400);
        for (int w = 0; w < words; w++) {
            text.append(VOCAB[zipf(rnd, VOCAB.length)]).append(w % 15 == 14 ? ".\n" : " ");
        }
        String subject = (rnd.nextInt(3) == 0 ? "Re: " : "") + VOCAB[zipf(rnd, 800)] + " " + VOCAB[zipf(rnd, 3000)];
        long date = Instant.parse("2025-11-12T00:00:00Z").toEpochMilli() + (long) i * (365L * 86_400_000L / MESSAGES);
        String msgid = "m" + i + "@perf.example";
        List<String> refs = new ArrayList<>();
        if (i > 10 && rnd.nextInt(10) < 3) {
            int parent = i - 1 - rnd.nextInt(Math.min(i - 1, 500));
            refs.add("m" + parent + "@perf.example");
        }
        List<ParsedMessage.Part> parts = new ArrayList<>();
        String attachment = "";
        if (rnd.nextInt(20) == 0) {
            int size = 20_000 + rnd.nextInt(2_000_000);
            parts.add(new ParsedMessage.Part("2", VOCAB[zipf(rnd, 2000)] + ".pdf", "application/pdf", size, null, false, null));
            // Its bytes in the raw message as base64, which gzip barely shrinks, up to 256 KiB of them (to keep the run's
            // disk small): so the store holds the mix it will, most blobs in the database and these as files.
            byte[] bin = new byte[Math.min(size, 256 * 1024)];
            rnd.nextBytes(bin);
            attachment = "\r\n--b\r\nContent-Type: application/pdf\r\nContent-Transfer-Encoding: base64\r\n\r\n"
                    + Base64.getMimeEncoder().encodeToString(bin) + "\r\n--b--\r\n";
        }
        ParsedMessage p = new ParsedMessage(new ParsedMessage.Address("P" + person, from), List.of(),
                List.of(new ParsedMessage.Address(null, "me@gmail.example")), List.of(), List.of(), subject, date, msgid, refs, refs,
                null, bulk, bulk ? "bulk" : null, null, text.toString(), false, null, parts);
        byte[] raw = ("From: " + from + "\r\nSubject: " + subject + "\r\nMessage-ID: <" + msgid + ">\r\n\r\n" + text + attachment)
                .getBytes(StandardCharsets.UTF_8);
        // Mail as it comes live: courier_new reads it (a first sync's backfill it never gives).
        return Courier.Inbound.email("gmail", "perf:" + i, raw, Courier.Origin.LIVE).withParsed(p);
    }

    private static int zipf(Random rnd, int n) {
        // Inverse-transform of a rough Zipf(1): small ranks dominate.
        double u = rnd.nextDouble();
        int r = (int) Math.floor(Math.pow(n + 1, u)) - 1;
        return Math.max(0, Math.min(n - 1, r));
    }

    private static String[] vocabulary(int n) {
        Random rnd = new Random(11);
        String letters = "etaoinshrdlcumwfgypbvkjxqzéü";
        String[] out = new String[n];
        for (int i = 0; i < n; i++) {
            StringBuilder w = new StringBuilder();
            int len = 3 + rnd.nextInt(8);
            for (int c = 0; c < len; c++) {
                w.append(letters.charAt(Math.min(letters.length() - 1, (int) Math.abs(rnd.nextGaussian() * 7))));
            }
            out[i] = w + Integer.toString(i, 36);
        }
        return out;
    }

    private static Map<String, Object> stats(long[] ms) {
        long[] s = ms.clone();
        Arrays.sort(s);
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("p50", s[s.length / 2]);
        m.put("p95", s[(int) Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)]);
        m.put("max", s[s.length - 1]);
        return m;
    }

    static Map<String, Object> statsUs(long[] us) {
        long[] s = us.clone();
        Arrays.sort(s);
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("p50", round(s[s.length / 2] / 1000.0));
        m.put("p95", round(s[(int) Math.min(s.length - 1, Math.ceil(s.length * 0.95) - 1)] / 1000.0));
        m.put("max", round(s[s.length - 1] / 1000.0));
        return m;
    }

    private static double round(double v) {
        return Math.round(v * 100) / 100.0;
    }
}
