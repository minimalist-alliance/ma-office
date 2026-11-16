package com.minimalistalliance.desk.deskd.courier.store;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.deskd.courier.TestMime;
import com.minimalistalliance.desk.deskd.courier.parse.CourierParser;
import com.minimalistalliance.desk.deskd.courier.parse.ParsedMessage;
import com.minimalistalliance.desk.deskd.testing.MutableClock;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The sink's idempotency as a property, over seeded random runs: a universe of messages (emails with colliding
 * Message-IDs, parents and children in any order, chat messages, spam verdicts, Sent copies), delivered with repeats, in
 * random batches, from several threads at once, across reopens of the store, with the parser going away and coming back.
 * Whatever the run, each sink key is one row, its id is stable while nothing pends, and the store's {@link Invariants}
 * hold. A failure names its seed, which replays it exactly.
 */
class SinkIdempotencyPropertyTest {

    private static final int SEEDS = Integer.getInteger("courier.property.seeds", 40);
    private static final String[] PEOPLE = {
        "Dana <dana@example.com>", "Bob <bob@example.org>", "list-bot@lists.example", "\"Shop, Inc\" <orders@shop.example>",
        "Mallory <mallory@evil.example>", "Me <me@gmail.example>"
    };

    record Item(Courier.Inbound in, String key) {}

    @Test
    void eachKeyIsOneRowWhateverTheDeliveries(@TempDir Path dir) throws Exception {
        for (int seed = 1; seed <= SEEDS; seed++) {
            try {
                run(dir.resolve("s" + seed), seed);
            } catch (AssertionError | Exception e) {
                throw new AssertionError("seed " + seed + ": " + e.getMessage(), e);
            }
        }
    }

    private void run(Path dir, long seed) throws Exception {
        Random rnd = new Random(seed);
        boolean outages = seed % 2 == 0;
        AtomicBoolean parserUp = new AtomicBoolean(true);
        CourierParser parser = raw -> {
            if (!parserUp.get()) {
                throw new CourierParser.Unavailable("down");
            }
            return TestMime.PARSER.parse(raw);
        };
        MutableClock clock = new MutableClock(Instant.parse("2026-11-12T00:00:00Z"));
        CourierStore store = CourierStore.open(dir, parser, clock, CourierStore.Settings.DEFAULT);
        try {
            store.putAccount(new Courier.Account("desk", "desk", "Desk", "me@desk.example", "ok"),
                    List.<String[]>of(new String[] {"email", "me@desk.example"}));
            store.putAccount(new Courier.Account("gmail", "imap", "Gmail", "me@gmail.example", "ok"),
                    List.<String[]>of(new String[] {"email", "me@gmail.example"}));
            store.putAccount(new Courier.Account("imsg", "imessage", "Messages", null, "ok"), List.of());

            List<Item> universe = universe(rnd, 20 + rnd.nextInt(60));
            Map<String, String> firstId = new ConcurrentHashMap<>();
            Set<String> pendedKeys = ConcurrentHashMap.newKeySet();
            List<Item> stream = new ArrayList<>();
            for (int i = 0; i < universe.size() * 3; i++) {
                stream.add(universe.get(rnd.nextInt(universe.size())));
            }
            stream.addAll(universe); // every message at least once
            Collections.shuffle(stream, rnd);

            int at = 0;
            while (at < stream.size()) {
                if (outages && rnd.nextInt(6) == 0) {
                    parserUp.set(!parserUp.get());
                }
                if (rnd.nextInt(8) == 0) {
                    store.close();
                    store = CourierStore.open(dir, parser, clock, CourierStore.Settings.DEFAULT);
                }
                clock.advance(Duration.ofMillis(rnd.nextInt(3) == 0 ? -rnd.nextInt(5000) : rnd.nextInt(2000)));
                int producers = 1 + rnd.nextInt(3);
                List<List<Item>> chunks = new ArrayList<>();
                for (int p = 0; p < producers && at < stream.size(); p++) {
                    int n = Math.min(stream.size() - at, 1 + rnd.nextInt(10));
                    chunks.add(stream.subList(at, at + n));
                    at += n;
                }
                CourierStore s = store;
                List<Thread> threads = new ArrayList<>();
                List<Throwable> failures = Collections.synchronizedList(new ArrayList<>());
                for (List<Item> chunk : chunks) {
                    threads.add(Thread.ofVirtual().start(() -> {
                        try {
                            List<Courier.Inbound> batch = new ArrayList<>();
                            for (Item it : chunk) {
                                batch.add(it.in());
                            }
                            List<Courier.Accepted> answers = s.accept(batch, null);
                            for (int k = 0; k < chunk.size(); k++) {
                                Courier.Accepted a = answers.get(k);
                                String key = chunk.get(k).key();
                                assertThat(a.kept()).as("kept " + key).isTrue();
                                if (a.kind() == Courier.Accepted.Kind.PENDING) {
                                    pendedKeys.add(key);
                                }
                                if (!pendedKeys.contains(key) && !key.startsWith("echo")) {
                                    String prev = firstId.putIfAbsent(key, a.messageId());
                                    if (prev != null) {
                                        assertThat(a.messageId()).as("stable id for " + key).isEqualTo(prev);
                                    }
                                }
                            }
                        } catch (Throwable t) {
                            failures.add(t);
                        }
                    }));
                }
                for (Thread t : threads) {
                    t.join();
                }
                if (!failures.isEmpty()) {
                    Throwable f = failures.get(0);
                    if (f instanceof Exception e) {
                        throw e;
                    }
                    throw new AssertionError(f);
                }
            }
            parserUp.set(true);
            while (store.reparsePending(1000) > 0) {
                // until none waits
            }
            Invariants.check(store);
            // Every distinct key delivered is exactly one row (Sent copies of the same Message-ID fold into one).
            long distinct = universe.stream().map(Item::key).filter(k -> !k.startsWith("echo")).distinct().count();
            long rows = Invariants.messages(store);
            assertThat(rows).as("rows").isEqualTo(distinct);
            for (Item it : universe) {
                if (!it.key().startsWith("echo")) {
                    assertThat(Invariants.idOf(store, it.in().medium(), it.in().externalId())).as("row for " + it.key()).isNotNull();
                }
            }
            for (Map.Entry<String, String> e : firstId.entrySet()) {
                if (pendedKeys.contains(e.getKey())) {
                    continue;
                }
                Item it = universe.stream().filter(x -> x.key().equals(e.getKey())).findFirst().orElseThrow();
                assertThat(Invariants.idOf(store, it.in().medium(), it.in().externalId())).as("id kept for " + e.getKey()).isEqualTo(e.getValue());
            }
        } finally {
            store.close();
        }
    }

    /** Emails in threads with shared and colliding ids, strangers, lists, Sent copies, and texts. */
    private static List<Item> universe(Random rnd, int n) {
        List<Item> out = new ArrayList<>();
        List<String> ids = new ArrayList<>();
        for (int i = 0; i < n; i++) {
            int kind = rnd.nextInt(10);
            if (kind == 0) {
                String from = "+1555" + (1000000 + rnd.nextInt(5));
                ParsedMessage chat = ParsedMessage.chat(new ParsedMessage.Address(null, from),
                        List.of(new ParsedMessage.Address(null, "+15550000000")), "text " + i, 1_762_000_000_000L + i, List.of());
                out.add(new Item(Courier.Inbound.chat("imsg", "imessage", "bb:" + i, chat, null), "chat" + i));
                continue;
            }
            String from = PEOPLE[rnd.nextInt(PEOPLE.length)];
            boolean mine = from.contains("me@gmail");
            // A few Message-IDs collide on purpose: different messages, one id.
            String id = rnd.nextInt(12) == 0 && !ids.isEmpty() ? ids.get(rnd.nextInt(ids.size())) : "m" + i + "@x.example";
            ids.add(id);
            StringBuilder h = new StringBuilder();
            h.append("From: ").append(from).append("\r\n");
            h.append("To: ").append(mine ? PEOPLE[rnd.nextInt(3)] : (rnd.nextBoolean() ? "me@desk.example" : "me@gmail.example"));
            if (rnd.nextInt(3) == 0) {
                h.append(", ").append(PEOPLE[rnd.nextInt(3)]);
            }
            h.append("\r\n");
            String subject = (rnd.nextInt(3) == 0 ? "Re: " : "") + "Topic " + rnd.nextInt(6);
            h.append("Subject: ").append(subject).append("\r\n");
            h.append("Date: Thu, ").append(1 + rnd.nextInt(28)).append(" Oct 2026 10:00:00 +0000\r\n");
            h.append("Message-ID: <").append(id).append(">\r\n");
            if (rnd.nextBoolean() && i > 0) {
                String parent = "m" + rnd.nextInt(i + 3) + "@x.example"; // sometimes a parent that never comes
                h.append("In-Reply-To: <").append(parent).append(">\r\n");
                h.append("References: <m0@x.example> <").append(parent).append(">\r\n");
            }
            if (rnd.nextInt(5) == 0) {
                h.append("List-Unsubscribe: <mailto:u@x.example>\r\n");
            }
            if (rnd.nextInt(7) == 0) {
                h.append("List-Id: Team <team.lists.example>\r\n");
            }
            h.append("\r\nBody ").append(i).append(" ").append(Long.toHexString(rnd.nextLong())).append("\r\n");
            if (rnd.nextInt(8) == 0) {
                // Large and incompressible: its blob is a file, not a row.
                h.append(com.minimalistalliance.desk.deskd.courier.CourierCrashChild.noise(i, 100_000)).append("\r\n");
            }
            byte[] raw = h.toString().getBytes(StandardCharsets.UTF_8);
            String account = from.contains("me@gmail") || rnd.nextBoolean() ? "gmail" : "desk";
            Courier.Inbound in = Courier.Inbound.email(account, ExternalIds.email(account, "<" + id + ">", raw), raw,
                    rnd.nextBoolean() ? Courier.Origin.LIVE : Courier.Origin.CATCHUP);
            if (rnd.nextInt(9) == 0) {
                in = in.withVerdicts(new Courier.Verdicts(true, false, "fail", "none", "fail"));
            }
            if (rnd.nextInt(4) == 0) {
                in = in.asSeen();
            }
            if (mine) {
                in = in.asOutgoing();
            }
            out.add(new Item(in, "email" + i + ":" + in.externalId()));
        }
        return out;
    }

    /** For a test of this test's own generator: deterministic per seed. */
    @Test
    void theGeneratorIsDeterministic() {
        List<Item> a = universe(new Random(7), 30);
        List<Item> b = universe(new Random(7), 30);
        Map<String, String> ka = new LinkedHashMap<>();
        Map<String, String> kb = new HashMap<>();
        a.forEach(i -> ka.put(i.key(), i.in().externalId()));
        b.forEach(i -> kb.put(i.key(), i.in().externalId()));
        assertThat(ka).isEqualTo(kb);
    }
}
