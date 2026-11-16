package com.minimalistalliance.desk.courier.testkit.soak;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.courier.testkit.FakeBlueBubbles;
import com.minimalistalliance.desk.courier.testkit.FakeMailServer;
import com.minimalistalliance.desk.courier.testkit.FakeRelay;
import com.minimalistalliance.desk.courier.testkit.PeerDesk;
import jakarta.mail.Folder;
import jakarta.mail.Message;
import jakarta.mail.Session;
import jakarta.mail.Store;
import jakarta.mail.UIDFolder;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import tools.jackson.jr.ob.JSON;

/**
 * The harness's own proof: every fake, every source-side fault of the launch plan's soak, and a stand-in desk made of
 * simple reference readers (IMAP by UID, the relay's collect-open-ack, BlueBubbles by time) that store each message once.
 * It must pass; and a desk that doubles, loses or invents a message must fail, with the markers named.
 */
@SuppressWarnings("unchecked")
class SoakSelfTest {

    private static final Pattern SUBJECT = Pattern.compile("(?m)^Subject: (\\S+)\r?$");

    @TempDir
    Path dir;

    /** A desk that stores each message once by its source's id: what the real store's idempotent sink does. */
    static final class ModelDesk implements Soak.Observer {
        final Map<String, String> byKey = new ConcurrentHashMap<>();
        final Map<String, Integer> markers = new ConcurrentHashMap<>();
        final boolean idempotent;

        ModelDesk(boolean idempotent) {
            this.idempotent = idempotent;
        }

        synchronized void accept(String channel, String externalKey, String marker) {
            if (byKey.putIfAbsent(channel + " " + externalKey, marker) != null && idempotent) {
                return;
            }
            markers.merge(marker, 1, Integer::sum);
        }

        @Override
        public synchronized Map<String, Integer> observed() {
            return new LinkedHashMap<>(markers);
        }
    }

    /** Runs {@code body} until stopped, waiting a little after each pass or failure, as a transport's loop does. */
    private static Thread loop(AtomicBoolean stop, ThrowingRunnable body) {
        return Thread.ofVirtual().start(() -> {
            while (!stop.get()) {
                try {
                    body.run();
                } catch (Exception e) {
                    // A fault: try again.
                }
                try {
                    Thread.sleep(100);
                } catch (InterruptedException e) {
                    return;
                }
            }
        });
    }

    interface ThrowingRunnable {
        void run() throws Exception;
    }

    @Test
    void theFullHarnessPassesThroughEveryFaultWithReferenceReaders() throws Exception {
        try (FakeMailServer mail = FakeMailServer.start(); FakeRelay relay = FakeRelay.start(); FakeBlueBubbles bb = FakeBlueBubbles.start("soak-pw")) {
            mail.addUser("me@mail.example", "me", "secret");
            // The peer sends far more than a member may in an hour; the caps aren't what this run tests.
            relay.caps().sendsPerHour = Integer.MAX_VALUE;
            relay.caps().sendsPerDay = Integer.MAX_VALUE;
            relay.caps().lookupsPerHour = Integer.MAX_VALUE;
            relay.caps().lookupsPerDay = Integer.MAX_VALUE;
            PeerDesk desk = new PeerDesk(relay, "d-under-test", "sam");
            PeerDesk peer = new PeerDesk(relay, "d-peer", "dana");
            String chat = bb.directChat("+15551230000");
            ModelDesk model = new ModelDesk(true);
            AtomicBoolean stop = new AtomicBoolean();
            List<Thread> readers = List.of(
                    loop(stop, imapReader(mail, model)),
                    loop(stop, () -> relayReader(desk, model)),
                    loop(stop, bbReader(bb, model)));
            Soak.Plan plan = new Soak.Plan(20261114L, 2000, Duration.ofSeconds(20), List.of("imap", "door", "ma", "imessage"), 0.2, List.of(
                    new Soak.Window("relay-down", Duration.ofSeconds(3), Duration.ofSeconds(2)),
                    new Soak.Window("relay-loses-acks", Duration.ofSeconds(7), Duration.ofSeconds(2)),
                    new Soak.Window("relay-duplicates", Duration.ofSeconds(10), Duration.ofSeconds(2)),
                    new Soak.Window("imessage-gone", Duration.ofSeconds(13), Duration.ofSeconds(2)),
                    new Soak.Window("imap-uidvalidity", Duration.ofSeconds(16), Duration.ofMillis(10))), Duration.ofSeconds(60));
            Map<String, Soak.Channel> channels = Map.of(
                    "imap", Channels.imap(mail, "me@mail.example"),
                    "door", Channels.door(relay, desk.address()),
                    "ma", Channels.member(peer, desk.address()),
                    "imessage", Channels.imessage(bb, chat, "+15551230000"));
            Map<String, Soak.Fault> faults = Map.of(
                    "relay-down", Faults.relayDown(relay),
                    "relay-loses-acks", Faults.relayLosesAcks(relay),
                    "relay-duplicates", Faults.relayDuplicates(relay),
                    "imessage-gone", Faults.imessageGone(bb),
                    "imap-uidvalidity", Faults.imapUidValidity(mail, "me@mail.example"));
            Soak.Report report;
            try (Ledger ledger = new Ledger(dir.resolve("ledger.txt"))) {
                report = new Runner(plan, channels, faults, model, ledger, Clock.systemUTC(), d -> Thread.sleep(d.toMillis()), null).run();
            } finally {
                stop.set(true);
                for (Thread t : readers) {
                    t.join(5000);
                }
            }
            assertThat(report.passed()).as(report.toMarkdown()).isTrue();
            assertThat(report.injected()).isEqualTo(2000);
            assertThat(report.perChannel()).containsKeys("imap", "door", "ma", "imessage");
            assertThat(report.perChannel().values()).allMatch(c -> c[0] > 300);
            assertThat(report.faultLog()).filteredOn(f -> f.contains("begin")).hasSize(5);
            // The relay's lost acks and duplicates did bring envelopes again: the model folded them.
            assertThat(model.byKey).hasSize(2000);
            assertThat(report.toMarkdown()).contains("PASSED");
            assertThat(report.toJson()).containsEntry("lost", 0).containsEntry("doubled", 0);
        }
    }

    @Test
    void aMessageNoSourceTakesFailsTheRun() throws Exception {
        Map<String, Integer> desk = new ConcurrentHashMap<>();
        Soak.Channel refusing = new Soak.Channel() {
            @Override
            public String name() {
                return "x";
            }

            @Override
            public void inject(Soak.Item item) throws Exception {
                if (item.seq() == 3) {
                    throw new java.io.IOException("rate_limited");
                }
                desk.put(item.marker(), 1);
            }
        };
        Soak.Plan plan = new Soak.Plan(3, 10, Duration.ofMillis(100), List.of("x"), 0, List.of(), Duration.ofMillis(500));
        try (Ledger ledger = new Ledger(dir.resolve("refused.txt"))) {
            Soak.Report r = new Runner(plan, Map.of("x", refusing), Map.of(), () -> new LinkedHashMap<>(desk), ledger, Clock.systemUTC(),
                    d -> Thread.sleep(d.toMillis()), null).run();
            assertThat(r.passed()).isFalse();
            assertThat(r.notSent()).hasSize(1);
            assertThat(r.injectRetries()).isPositive();
        }
    }

    @Test
    void aDeskThatDoublesLosesOrInventsFails() throws Exception {
        Map<String, Integer> fakeDesk = new ConcurrentHashMap<>();
        List<String> sentOrder = new ArrayList<>();
        Soak.Channel direct = new Soak.Channel() {
            @Override
            public String name() {
                return "x";
            }

            @Override
            public void inject(Soak.Item item) {
                sentOrder.add(item.marker());
                int n = item.seq() == 7 ? 2 : item.seq() == 9 ? 0 : 1;
                if (n > 0) {
                    fakeDesk.put(item.marker(), n);
                }
            }
        };
        fakeDesk.put("never-sent", 1);
        Soak.Plan plan = new Soak.Plan(1, 50, Duration.ofMillis(200), List.of("x"), 0, List.of(), Duration.ofMillis(300));
        try (Ledger ledger = new Ledger(dir.resolve("bad.txt"))) {
            Soak.Report r = new Runner(plan, Map.of("x", direct), Map.of(), () -> new LinkedHashMap<>(fakeDesk), ledger, Clock.systemUTC(),
                    d -> Thread.sleep(d.toMillis()), null).run();
            assertThat(r.passed()).isFalse();
            assertThat(r.doubled()).containsExactly(sentOrder.get(7));
            assertThat(r.lost()).containsExactly(sentOrder.get(9));
            assertThat(r.unexpected()).containsExactly("never-sent");
            assertThat(r.toMarkdown()).contains("FAILED");
        }
    }

    @Test
    void aStoppedRunResumesFromItsLedgerAndReconcilesEverything() throws Exception {
        Map<String, Integer> desk = new ConcurrentHashMap<>();
        AtomicInteger calls = new AtomicInteger();
        AtomicBoolean crash = new AtomicBoolean(true);
        Soak.Channel channel = new Soak.Channel() {
            @Override
            public String name() {
                return "x";
            }

            @Override
            public void inject(Soak.Item item) throws Exception {
                if (crash.get() && calls.incrementAndGet() == 41) {
                    throw new InterruptedException("the harness's box restarted");
                }
                desk.merge(item.marker(), 1, Integer::sum);
            }
        };
        Soak.Plan plan = new Soak.Plan(2, 100, Duration.ofMillis(500), List.of("x"), 0.3, List.of(), Duration.ofSeconds(2));
        Path file = dir.resolve("resume.txt");
        try (Ledger ledger = new Ledger(file)) {
            try {
                new Runner(plan, Map.of("x", channel), Map.of(), () -> new LinkedHashMap<>(desk), ledger, Clock.systemUTC(),
                        d -> Thread.sleep(d.toMillis()), null).run();
            } catch (InterruptedException expected) {
                // The run stopped at its 41st message, planned but not sent.
            }
        }
        crash.set(false);
        try (Ledger ledger = new Ledger(file)) {
            assertThat(ledger.next()).isEqualTo(41);
            Soak.Report r = new Runner(plan, Map.of("x", channel), Map.of(), () -> new LinkedHashMap<>(desk), ledger, Clock.systemUTC(),
                    d -> Thread.sleep(d.toMillis()), null).run();
            assertThat(r.passed()).as(r.toMarkdown()).isTrue();
            assertThat(r.injected()).isEqualTo(100);
            assertThat(desk).hasSize(100).allSatisfy((k, v) -> assertThat(v).isEqualTo(1));
        }
    }

    @Test
    void anAnchoredRunResumesOnItsOwnClockAndNeverRepeatsAClosedFault() throws Exception {
        Map<String, Integer> desk = new ConcurrentHashMap<>();
        AtomicInteger calls = new AtomicInteger();
        AtomicBoolean crash = new AtomicBoolean(true);
        Soak.Channel channel = new Soak.Channel() {
            @Override
            public String name() {
                return "x";
            }

            @Override
            public void inject(Soak.Item item) throws Exception {
                if (crash.get() && calls.incrementAndGet() == 31) {
                    throw new InterruptedException("the soak's process was killed");
                }
                desk.merge(item.marker(), 1, Integer::sum);
            }
        };
        List<String> faultEvents = java.util.Collections.synchronizedList(new java.util.ArrayList<>());
        Soak.Fault early = new Soak.Fault() {
            public String name() { return "early"; }
            public void begin() { faultEvents.add("early on"); }
            public void end() { faultEvents.add("early off"); }
        };
        Soak.Fault late = new Soak.Fault() {
            public String name() { return "late"; }
            public void begin() { faultEvents.add("late on"); }
            public void end() { faultEvents.add("late off"); }
        };
        Soak.Plan plan = new Soak.Plan(3, 60, Duration.ofMillis(1200), List.of("x"), 0.0, List.of(
                new Soak.Window("early", Duration.ofMillis(50), Duration.ofMillis(100)),
                new Soak.Window("late", Duration.ofMillis(1000), Duration.ofMillis(100))), Duration.ofSeconds(2));
        Path file = dir.resolve("anchored.txt");
        java.time.Instant origin = Clock.systemUTC().instant();
        try (Ledger ledger = new Ledger(file)) {
            try {
                new Runner(plan, Map.of("x", channel), Map.of("early", early, "late", late), () -> new LinkedHashMap<>(desk), ledger,
                        Clock.systemUTC(), d -> Thread.sleep(d.toMillis()), null).anchoredAt(origin).run();
            } catch (InterruptedException expected) {
                // Killed at the 31st message, after "early" ran and before "late".
            }
        }
        assertThat(faultEvents).containsExactly("early on", "early off");
        Thread.sleep(200); // down for a while: what fell due meanwhile goes at once
        crash.set(false);
        long resumed = System.nanoTime();
        try (Ledger ledger = new Ledger(file)) {
            Soak.Report r = new Runner(plan, Map.of("x", channel), Map.of("early", early, "late", late), () -> new LinkedHashMap<>(desk), ledger,
                    Clock.systemUTC(), d -> Thread.sleep(d.toMillis()), null).anchoredAt(origin).run();
            assertThat(r.passed()).as(r.toMarkdown()).isTrue();
            assertThat(desk).hasSize(60).allSatisfy((k, v) -> assertThat(v).isEqualTo(1));
        }
        // "early" isn't repeated; "late" runs once, on the original clock (the whole run stays near its 1.2 s, not 1.2 s more).
        assertThat(faultEvents).containsExactly("early on", "early off", "late on", "late off");
        assertThat(Duration.ofNanos(System.nanoTime() - resumed)).isLessThan(Duration.ofMillis(1200 + 2000));
    }

    @Test
    void theLaunchBarPlanIsTheLaunchPlans() {
        Soak.Plan p = Soak.Plan.launchBar(7);
        assertThat(p.total()).isEqualTo(100_000);
        assertThat(p.duration()).isEqualTo(Duration.ofDays(7));
        assertThat(p.channels()).containsExactly("imap", "door", "ma", "imessage");
        long[] at = Runner.schedule(p);
        assertThat(at[0]).isZero();
        assertThat(at[at.length - 1]).isLessThan(Duration.ofDays(7).toMillis());
        for (int i = 1; i < at.length; i++) {
            assertThat(at[i]).isGreaterThanOrEqualTo(at[i - 1]);
        }
        assertThat(Runner.schedule(p)).isEqualTo(at);
    }

    // ---- reference readers: what a transport does, done simply

    private static ThrowingRunnable imapReader(FakeMailServer mail, ModelDesk model) {
        long[] state = {-1, 0};   // uidvalidity, last uid
        return () -> {
            Properties props = new Properties();
            Store store = Session.getInstance(props).getStore("imap");
            store.connect("127.0.0.1", mail.imapPort(), "me", "secret");
            try {
                Folder inbox = store.getFolder("INBOX");
                inbox.open(Folder.READ_ONLY);
                UIDFolder uids = (UIDFolder) inbox;
                long validity = uids.getUIDValidity();
                if (validity != state[0]) {
                    state[0] = validity;
                    state[1] = 0;
                }
                for (Message m : uids.getMessagesByUID(state[1] + 1, UIDFolder.MAXUID)) {
                    long uid = uids.getUID(m);
                    if (uid <= state[1]) {
                        continue;
                    }
                    model.accept("imap", m.getHeader("Message-ID")[0], m.getSubject());
                    state[1] = uid;
                }
                inbox.close(false);
            } finally {
                store.close();
            }
        };
    }

    private static void relayReader(PeerDesk desk, ModelDesk model) throws Exception {
        for (PeerDesk.Received r : desk.collect()) {
            if ("mail".equals(r.payload().get("kind"))) {
                String raw = new String(Base64.getUrlDecoder().decode((String) r.payload().get("raw")), StandardCharsets.UTF_8);
                Matcher m = SUBJECT.matcher(raw);
                model.accept("door", (String) r.payload().get("id"), m.find() ? m.group(1) : "?");
            } else {
                model.accept("ma", (String) r.payload().get("id"), (String) r.payload().get("text"));
            }
        }
    }

    private static ThrowingRunnable bbReader(FakeBlueBubbles bb, ModelDesk model) {
        HttpClient http = HttpClient.newHttpClient();
        long[] after = {0};
        return () -> {
            while (true) {
                Map<String, Object> q = Map.of("sort", "ASC", "limit", 1000, "after", after[0] - 1, "with", List.of("chat"));
                HttpResponse<byte[]> r = http.send(HttpRequest.newBuilder(URI.create(bb.baseUrl() + "/api/v1/message/query?guid=" + bb.password()))
                        .header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofByteArray(JSON.std.asBytes(q))).build(),
                        HttpResponse.BodyHandlers.ofByteArray());
                if (r.statusCode() != 200) {
                    throw new IllegalStateException("BlueBubbles answered " + r.statusCode());
                }
                List<Object> data = (List<Object>) JSON.std.mapFrom(r.body()).get("data");
                long newest = after[0];
                for (Object o : data) {
                    Map<String, Object> m = (Map<String, Object>) o;
                    if (Boolean.TRUE.equals(m.get("isFromMe"))) {
                        continue;
                    }
                    model.accept("imessage", (String) m.get("guid"), (String) m.get("text"));
                    newest = Math.max(newest, ((Number) m.get("dateCreated")).longValue());
                }
                if (data.size() < 1000 || newest == after[0]) {
                    after[0] = newest;
                    return;
                }
                after[0] = newest;
            }
        };
    }
}
