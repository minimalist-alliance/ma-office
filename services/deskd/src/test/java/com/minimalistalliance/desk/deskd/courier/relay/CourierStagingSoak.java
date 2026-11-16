package com.minimalistalliance.desk.deskd.courier.relay;

import com.minimalistalliance.desk.courier.testkit.soak.Ledger;
import com.minimalistalliance.desk.courier.testkit.soak.Runner;
import com.minimalistalliance.desk.courier.testkit.soak.Soak;
import com.minimalistalliance.desk.deskd.aws.RoleCredentials;
import com.minimalistalliance.desk.deskd.courier.CourierModule;
import com.minimalistalliance.desk.deskd.courier.CourierSwitch;
import com.minimalistalliance.desk.deskd.courier.TestMime;
import com.minimalistalliance.desk.deskd.courier.keys.DeskKeys;
import com.minimalistalliance.desk.deskd.courier.keys.PlatformKeyPublisher;
import com.minimalistalliance.desk.deskd.courier.store.CourierStore;
import com.minimalistalliance.desk.deskd.courier.store.Invariants;
import com.minimalistalliance.desk.deskd.events.EventHub;
import com.minimalistalliance.desk.deskd.events.TopicRegistry;
import com.minimalistalliance.desk.deskd.imds.ImdsClient;
import com.minimalistalliance.desk.deskd.platform.AgeBand;
import com.minimalistalliance.desk.deskd.platform.AgentClient;
import com.minimalistalliance.desk.deskd.platform.PlatformHttp;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.rpc.RpcDispatcher;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.SecureRandom;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Courier's 7-day staging soak (the launch plan §7 and CR-4.1), run unattended on this machine: two staging test desks,
 * each deskd's own Courier module, store, keys and relay transport, signing as a self-hosted test desk on a staging test
 * account (sessions renewed by {@link SessionImds}), against the REAL staging relay and mail door. On a steady schedule
 * (the test kit's {@link Runner}, anchored at the run's first start so restarts keep its clock):
 *
 * <ul>
 *   <li>{@code ma-ab}, {@code ma-ba}: a member's sealed message, written and sent by one desk's outbox to the other;
 *   <li>{@code door-a}, {@code door-b}: mail from outside (SES, from {@code courier-soak@mail.<suffix>}, over public SMTP to
 *       the Courier MX) to each desk's address, through the door's seal and the relay;
 *   <li>{@code out-a}, {@code out-b}: mail written on a desk and sent from its address through {@code courier-send} to our
 *       own test inbox {@code courier-soak@mail.<suffix>} (stored at the door bucket's {@code tests/}).
 * </ul>
 *
 * Faults (made on the desk's side, {@link FaultyLinks}, so staging stays up for everyone else): the relay down for an hour
 * and for a day, acks lost, pages duplicated, send answers lost, courier-send down, desk A stopped for 6 hours, deskd
 * restarted, and the whole process killed outright (resumed from the ledger by the watchdog). Bar: 0 lost, 0 doubled.
 *
 * <p>{@code java -cp <deskd test classpath> ...CourierStagingSoak <run dir>}: the run dir holds {@code session.json} (0600,
 * written by {@code services/deskd/e2e/courier-soak.mjs setup}), the desks' data, the ledger, {@code status.json} (every
 * 10 minutes), {@code progress.log}, and at the end {@code report.json}, {@code report.md} and {@code finished}. Never
 * prints a credential, a key or a message body.
 */
@SuppressWarnings("unchecked")
public final class CourierStagingSoak {

    static final long SEED = 20261115L;
    static final int TOTAL = 21_000;
    static final Duration DURATION = Duration.ofDays(7);
    static final Pattern MARKER = Pattern.compile("soak[0-9a-f]+x[0-9]+");

    /** The staging run's plan: weights by repeating a channel (the runner picks evenly from the list). */
    static Soak.Plan plan() {
        Duration d = Duration.ofDays(1);
        List<String> channels = new ArrayList<>();
        for (int i = 0; i < 6; i++) {
            channels.add("ma-ab");
            channels.add("ma-ba");
        }
        for (int i = 0; i < 3; i++) {
            channels.add("door-a");
            channels.add("door-b");
        }
        channels.add("out-a");
        channels.add("out-b");
        return new Soak.Plan(SEED, TOTAL, DURATION, channels, 0.2, List.of(
                new Soak.Window("relay-loses-acks", Duration.ofHours(6), Duration.ofHours(2)),
                new Soak.Window("relay-down", d, Duration.ofHours(1)),
                new Soak.Window("answers-lost", d.plusHours(12), Duration.ofHours(2)),
                new Soak.Window("relay-down", d.multipliedBy(2), d),
                new Soak.Window("relay-duplicates", d.multipliedBy(3).plusHours(6), Duration.ofHours(2)),
                new Soak.Window("door-down", d.multipliedBy(3).plusHours(12), Duration.ofHours(1)),
                new Soak.Window("desk-stop", d.multipliedBy(4), Duration.ofHours(6)),
                new Soak.Window("deskd-kill", d.multipliedBy(4).plusHours(12), Duration.ofMinutes(1)),
                new Soak.Window("process-kill", d.multipliedBy(5), Duration.ofMinutes(2)),
                new Soak.Window("relay-down", d.multipliedBy(5).plusHours(12), Duration.ofHours(1)),
                new Soak.Window("deskd-kill", d.multipliedBy(6), Duration.ofMinutes(1))), Duration.ofHours(6));
    }

    private final Path run;
    private final Map<String, Object> session;
    private final String api;
    private final String inbox;
    private final FaultyLinks links = new FaultyLinks();
    private final Map<String, Integer> lastSeenA = new ConcurrentHashMap<>();
    private final Map<String, Integer> lastSeenB = new ConcurrentHashMap<>();
    private final SecureRandom random = new SecureRandom();
    private final Set<String> faultsOn = ConcurrentHashMap.newKeySet();
    private Desk a;
    private Desk b;
    private Instant origin;

    private CourierStagingSoak(Path run) throws Exception {
        this.run = run;
        this.session = Json.parseObject(Files.readAllBytes(run.resolve("session.json")));
        this.api = (String) session.get("api");
        this.inbox = (String) session.get("inbox");
    }

    // ---------- one desk ----------

    /** One staging test desk: deskd's Courier, its relay transport and courier-send, on a self-hosted desk's renewed session. */
    final class Desk implements AutoCloseable {
        final String name;
        final String address;
        final Path dir;
        final SessionImds imds;
        final PlatformHttp http = new PlatformHttp();
        final AgentClient client;
        final PlatformRelayApi realApi;
        final RelayApi api;
        final CourierSend send;
        volatile CourierModule module;
        volatile RelayTransport transport;
        volatile boolean stopped = true;

        Desk(String name, Map<String, Object> s, Path dir) throws Exception {
            this.name = name;
            this.address = (String) s.get("address");
            this.dir = dir;
            imds = new SessionImds(CourierStagingSoak.this.api, (String) session.get("env"), (String) s.get("publicKey"),
                    Base64.getDecoder().decode((String) s.get("pkcs8")));
            client = new AgentClient(http, new RoleCredentials(new ImdsClient(http, imds.url()), Clock.systemUTC()), () -> CourierStagingSoak.this.api,
                    Clock.systemUTC());
            realApi = new PlatformRelayApi(client, http);
            api = links.relay(realApi);
            send = links.door(new PlatformCourierSend(client, realApi::upload, () -> true));
            Files.createDirectories(dir.resolve("desk"));
            if (!Files.exists(dir.resolve("keys"))) {
                Files.createDirectory(dir.resolve("keys"), PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
            }
        }

        synchronized void open() throws Exception {
            CourierModule.Settings settings = new CourierModule.Settings(dir.resolve("courier"), dir.resolve("desk"), true, Duration.ofDays(3650),
                    CourierStore.Settings.DEFAULT);
            RpcDispatcher dispatcher = new RpcDispatcher();
            module = new CourierModule(dispatcher, new EventHub(new TopicRegistry()), settings, TestMime.PARSER,
                    new CourierSwitch(settings.switchDirectory()), () -> false, () -> AgeBand.Band.ADULT, Clock.systemUTC(),
                    DeskKeys.Settings.defaults(dir.resolve("keys")), new PlatformKeyPublisher(client));
            module.keys().maintain();
            transport = new RelayTransport(module, api, send, Clock.systemUTC(),
                    new RelayTransport.Settings(Duration.ofMinutes(2), Duration.ofSeconds(15), Duration.ofMinutes(10))).start(dispatcher);
            long until = System.nanoTime() + Duration.ofMinutes(2).toNanos();
            while (System.nanoTime() < until && !(module.store().outbox().canSend("ma", RelayTransport.MA_ACCOUNT)
                    && module.store().outbox().canSend("email", RelayTransport.DESK_ACCOUNT))) {
                Thread.sleep(500);
            }
            stopped = false;
            log("desk " + name + " open: ma " + module.store().outbox().canSend("ma", RelayTransport.MA_ACCOUNT) + ", email "
                    + module.store().outbox().canSend("email", RelayTransport.DESK_ACCOUNT));
        }

        synchronized void stop() {
            if (!stopped) {
                stopped = true;
                module.close();
                log("desk " + name + " stopped");
            }
        }

        CourierStore store() throws IOException {
            CourierModule m = module;
            if (stopped || m == null) {
                throw new IOException("desk " + name + " is stopped");
            }
            return m.store();
        }

        /** Writes and sends one message through this desk's own outbox. */
        void write(String medium, String account, String to, String subject, String text) throws Exception {
            synchronized (this) {
                CourierStore st = store();
                Object[] draft = st.actions().saveDraft(null, null, medium, account, List.of(to), subject, text, null, null);
                st.outbox().send((String) draft[0]);
            }
        }

        /** Every soak marker in a message this desk received, and how many received messages carry it. */
        Map<String, Integer> received() throws Exception {
            return Invariants.read(store(), c -> {
                Map<String, Integer> out = new HashMap<>();
                try (var ps = c.prepareStatement("SELECT coalesce(subject, ''), coalesce(body_text, '') FROM messages WHERE direction = 'in'");
                     var r = ps.executeQuery()) {
                    while (r.next()) {
                        Set<String> found = new java.util.HashSet<>();
                        for (String f : new String[] {r.getString(1), r.getString(2)}) {
                            Matcher m = MARKER.matcher(f);
                            while (m.find()) {
                                found.add(m.group());
                            }
                        }
                        found.forEach(k -> out.merge(k, 1, Integer::sum));
                    }
                }
                return out;
            });
        }

        /** The desk's queue by state, and what the relay holds for it. */
        Map<String, Object> health() {
            Map<String, Object> h = new LinkedHashMap<>();
            h.put("stopped", stopped);
            try {
                Map<String, Integer> states = new TreeMap<>();
                for (Map<String, Object> r : store().queries().outbound()) {
                    states.merge(String.valueOf(r.get("state")), 1, Integer::sum);
                }
                h.put("outbound", states);
            } catch (Exception e) {
                h.put("outbound", e.getClass().getSimpleName());
            }
            try {
                h.put("relayPending", realApi.pending().get("pending"));
            } catch (Exception e) {
                h.put("relayPending", e.getClass().getSimpleName());
            }
            h.put("sessionProblem", imds.lastProblem());
            return h;
        }

        @Override
        public void close() {
            stop();
            imds.close();
            http.close();
        }
    }

    // ---------- the channels ----------

    private String filler(long seq) {
        // Mostly short notes; one in fifty long enough for the relay's drop (over the inline 48 KiB).
        int words = seq % 50 == 7 ? 14_000 : 8 + (int) (seq % 40);
        StringBuilder s = new StringBuilder();
        String[] w = {"plan", "lunch", "meeting", "garden", "notes", "draft", "travel", "invoice", "photos", "weekend", "review", "ticket"};
        for (int i = 0; i < words; i++) {
            s.append(w[(int) ((seq * 31 + i * 7) % w.length)]).append(i % 12 == 11 ? ".\n" : " ");
        }
        return s.toString();
    }

    private Soak.Channel member(String name, java.util.function.Supplier<Desk> from, java.util.function.Supplier<Desk> to) {
        return new Soak.Channel() {
            @Override
            public String name() {
                return name;
            }

            @Override
            public void inject(Soak.Item item) throws Exception {
                from.get().write("ma", RelayTransport.MA_ACCOUNT, to.get().address, null,
                        "Courier soak " + item.marker() + "\n" + filler(item.seq()));
            }
        };
    }

    private Soak.Channel out(String name, java.util.function.Supplier<Desk> from) {
        return new Soak.Channel() {
            @Override
            public String name() {
                return name;
            }

            @Override
            public void inject(Soak.Item item) throws Exception {
                from.get().write("email", RelayTransport.DESK_ACCOUNT, inbox, "Courier soak " + item.marker(), filler(item.seq()));
            }
        };
    }

    private Soak.Channel door(String name, java.util.function.Supplier<Desk> to) {
        return new Soak.Channel() {
            @Override
            public String name() {
                return name;
            }

            @Override
            public void inject(Soak.Item item) throws Exception {
                outside(to.get().address, item);
            }
        };
    }

    /** Mail from outside: SES from our own sender on mail.<suffix>, to a desk's address, over public SMTP to the Courier MX. */
    private void outside(String rcpt, Soak.Item item) throws Exception {
        String domain = (String) session.get("mailDomain");
        StringBuilder m = new StringBuilder();
        m.append("From: Courier soak <").append(inbox).append(">\r\n");
        m.append("To: <").append(rcpt).append(">\r\n");
        m.append("Subject: Courier soak ").append(item.marker()).append("\r\n");
        m.append("Message-ID: <").append(item.marker()).append('.').append(Long.toHexString(random.nextLong())).append('@').append(domain).append(">\r\n");
        m.append("Date: ").append(DateTimeFormatter.RFC_1123_DATE_TIME.format(Instant.now().atOffset(ZoneOffset.UTC))).append("\r\n");
        m.append("MIME-Version: 1.0\r\n");
        if (item.seq() % 40 == 3) {
            // One in forty past 128 KiB, so the door seals it into a drop.
            String boundary = "soak" + Long.toHexString(random.nextLong());
            m.append("Content-Type: multipart/mixed; boundary=\"").append(boundary).append("\"\r\n\r\n");
            m.append("--").append(boundary).append("\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n").append(filler(item.seq())).append("\r\n");
            byte[] blob = new byte[200 * 1024];
            random.nextBytes(blob);
            m.append("--").append(boundary).append("\r\nContent-Type: application/octet-stream; name=\"notes.bin\"\r\n")
                    .append("Content-Disposition: attachment; filename=\"notes.bin\"\r\nContent-Transfer-Encoding: base64\r\n\r\n")
                    .append(Base64.getMimeEncoder().encodeToString(blob)).append("\r\n--").append(boundary).append("--\r\n");
        } else {
            m.append("Content-Type: text/plain; charset=utf-8\r\n\r\n").append(filler(item.seq()).replace("\n", "\r\n")).append("\r\n");
        }
        Path tmp = Files.createTempFile(run.resolve("tmp"), "door-", ".json");
        try {
            Files.writeString(tmp, "{\"Raw\":{\"Data\":\"" + Base64.getEncoder().encodeToString(m.toString().getBytes(StandardCharsets.UTF_8)) + "\"}}");
            Process p = new ProcessBuilder("aws", "sesv2", "send-email", "--region", "us-east-1", "--from-email-address", inbox,
                    "--destination", "{\"ToAddresses\":[\"" + rcpt + "\"]}", "--content", "file://" + tmp, "--output", "text", "--query", "MessageId")
                    .redirectErrorStream(true).start();
            String outText = new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8).trim();
            if (!p.waitFor(60, java.util.concurrent.TimeUnit.SECONDS) || p.exitValue() != 0) {
                p.destroyForcibly();
                throw new IOException("ses send failed: " + outText.replaceAll("\\s+", " ").substring(0, Math.min(160, outText.length())));
            }
        } finally {
            Files.deleteIfExists(tmp);
        }
    }

    // ---------- what arrived ----------

    private long inboxSyncedAt;
    private final Map<String, Integer> inboxCounts = new HashMap<>();
    private final Set<String> inboxRead = new java.util.HashSet<>();

    /** Our test inbox at the door bucket's tests/: synced at most once a minute, each new file read once. */
    private synchronized Map<String, Integer> inbox() {
        if (System.currentTimeMillis() - inboxSyncedAt > 60_000) {
            inboxSyncedAt = System.currentTimeMillis();
            Path local = run.resolve("inbox");
            try {
                Files.createDirectories(local);
                Process p = new ProcessBuilder("aws", "s3", "sync", "--only-show-errors", "--region", "us-east-1",
                        "s3://" + session.get("bucket") + "/" + session.get("prefix"), local.toString())
                        .redirectErrorStream(true).redirectOutput(run.resolve("sync.log").toFile()).start();
                p.waitFor(5, java.util.concurrent.TimeUnit.MINUTES);
                try (var files = Files.list(local)) {
                    for (Path f : (Iterable<Path>) files::iterator) {
                        String n = f.getFileName().toString();
                        if (!inboxRead.add(n)) {
                            continue;
                        }
                        String head = new String(Files.readAllBytes(f), StandardCharsets.ISO_8859_1);
                        int end = head.indexOf("\r\n\r\n");
                        String headers = end > 0 ? head.substring(0, end) : head;
                        Matcher subj = Pattern.compile("(?mi)^Subject: Courier soak (soak[0-9a-f]+x[0-9]+)").matcher(headers);
                        if (subj.find()) {
                            inboxCounts.merge(subj.group(1), 1, Integer::sum);
                        }
                    }
                }
            } catch (Exception e) {
                log("inbox sync: " + e.getClass().getSimpleName());
            }
        }
        return new HashMap<>(inboxCounts);
    }

    /** Everything the run's receivers hold: each desk's received messages and our inbox. A stopped desk counts as last seen. */
    synchronized Map<String, Integer> observed() {
        Map<String, Integer> all = new HashMap<>();
        for (Object[] d : new Object[][] {{a, lastSeenA}, {b, lastSeenB}}) {
            Desk desk = (Desk) d[0];
            Map<String, Integer> last = (Map<String, Integer>) d[1];
            try {
                Map<String, Integer> now = desk.received();
                last.clear();
                last.putAll(now);
            } catch (Exception e) {
                // stopped: what it held when it stopped is still on its disk
            }
            last.forEach((k, v) -> all.merge(k, v, Integer::sum));
        }
        inbox().forEach((k, v) -> all.merge(k, v, Integer::sum));
        return all;
    }

    // ---------- faults ----------

    private Soak.Fault fault(String name, ThrowingRunnable on, ThrowingRunnable off) {
        return new Soak.Fault() {
            @Override
            public String name() {
                return name;
            }

            @Override
            public void begin() {
                faultsOn.add(name);
                log("fault on: " + name);
                try {
                    on.run();
                } catch (Exception e) {
                    log("fault " + name + " begin: " + e.getClass().getSimpleName());
                }
            }

            @Override
            public void end() {
                try {
                    off.run();
                } catch (Exception e) {
                    log("fault " + name + " end: " + e.getClass().getSimpleName());
                }
                faultsOn.remove(name);
                log("fault off: " + name);
            }
        };
    }

    @FunctionalInterface
    interface ThrowingRunnable {
        void run() throws Exception;
    }

    private Map<String, Soak.Fault> faults() {
        Map<String, Soak.Fault> f = new LinkedHashMap<>();
        f.put("relay-down", fault("relay-down", () -> links.relayDown = true, () -> links.relayDown = false));
        f.put("relay-loses-acks", fault("relay-loses-acks", () -> links.loseAcks = true, () -> links.loseAcks = false));
        f.put("relay-duplicates", fault("relay-duplicates", () -> links.duplicatePages = true, () -> links.duplicatePages = false));
        f.put("answers-lost", fault("answers-lost", () -> links.loseSendAnswers = true, () -> links.loseSendAnswers = false));
        f.put("door-down", fault("door-down", () -> links.doorDown = true, () -> links.doorDown = false));
        f.put("desk-stop", fault("desk-stop", () -> a.stop(), () -> a.open()));
        f.put("deskd-kill", fault("deskd-kill", () -> {
            b.stop();
            b.open();
        }, () -> { }));
        f.put("process-kill", fault("process-kill", () -> {
            Path mark = run.resolve("process-killed");
            if (!Files.exists(mark)) {
                Files.writeString(mark, Instant.now().toString());
                log("process-kill: halting now; the watchdog resumes from the ledger");
                Runtime.getRuntime().halt(137);
            }
        }, () -> { }));
        return f;
    }

    // ---------- status ----------

    private synchronized void log(String line) {
        try {
            Files.writeString(run.resolve("progress.log"), Instant.now() + " " + line + "\n", StandardCharsets.UTF_8, StandardOpenOption.CREATE,
                    StandardOpenOption.APPEND);
        } catch (IOException e) {
            System.err.println("progress log: " + e.getClass().getSimpleName());
        }
    }

    /** status.json: what's gone, what's arrived, what's late, what's doubled, per channel; the desks' queues; the faults. */
    private void writeStatus(Path ledgerPath) {
        try {
            // The ledger's own lines (Ledger's format), read beside the runner's appends; a torn last line is skipped.
            List<Soak.Item> planned = new ArrayList<>();
            Set<Long> confirmed = new java.util.HashSet<>();
            for (String line : Files.readAllLines(ledgerPath, StandardCharsets.UTF_8)) {
                String[] f = line.split(" ");
                try {
                    if (f.length == 5 && f[0].equals("+")) {
                        planned.add(new Soak.Item(Long.parseLong(f[1]), f[2], f[3], Instant.parse(f[4])));
                    } else if (f.length == 2 && f[0].equals("=")) {
                        confirmed.add(Long.parseLong(f[1]));
                    }
                } catch (RuntimeException torn) {
                    // skipped
                }
            }
            Map<String, Integer> seen = observed();
            Instant late = Instant.now().minus(Duration.ofHours(3));
            Map<String, int[]> per = new TreeMap<>();
            List<String> doubled = new ArrayList<>();
            List<String> overdue = new ArrayList<>();
            for (Soak.Item i : planned) {
                int[] c = per.computeIfAbsent(i.channel(), k -> new int[5]);
                c[0]++;
                if (confirmed.contains(i.seq())) {
                    c[1]++;
                }
                int n = seen.getOrDefault(i.marker(), 0);
                if (n >= 1) {
                    c[2]++;
                }
                if (n > 1) {
                    c[3]++;
                    doubled.add(i.marker());
                }
                if (n == 0 && confirmed.contains(i.seq()) && i.at().isBefore(late)) {
                    c[4]++;
                    overdue.add(i.marker());
                }
            }
            Map<String, Object> s = new LinkedHashMap<>();
            s.put("updated", Instant.now().toString());
            s.put("origin", origin.toString());
            s.put("day", Duration.between(origin, Instant.now()).toHours() / 24.0);
            s.put("planned", planned.size());
            s.put("total", TOTAL);
            Map<String, Object> pc = new LinkedHashMap<>();
            int[] all = new int[5];
            per.forEach((k, v) -> {
                pc.put(k, Map.of("planned", v[0], "sent", v[1], "arrived", v[2], "doubled", v[3], "overdue3h", v[4]));
                for (int x = 0; x < 5; x++) {
                    all[x] += v[x];
                }
            });
            s.put("all", Map.of("planned", all[0], "sent", all[1], "arrived", all[2], "doubled", all[3], "overdue3h", all[4]));
            s.put("perChannel", pc);
            s.put("doubledMarkers", doubled.subList(0, Math.min(20, doubled.size())));
            s.put("overdueMarkers", overdue.subList(0, Math.min(20, overdue.size())));
            s.put("faultsOn", new ArrayList<>(faultsOn));
            s.put("faultsInjected", links.injected.get());
            s.put("desks", Map.of("a", a.health(), "b", b.health()));
            Path tmp = run.resolve("status.json.tmp");
            Files.write(tmp, Json.bytes(s));
            Files.move(tmp, run.resolve("status.json"), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (Exception e) {
            log("status: " + e.getClass().getSimpleName() + " " + e.getMessage());
        }
    }

    // ---------- the run ----------

    private void runSoak() throws Exception {
        Files.createDirectories(run.resolve("tmp"));
        Path originFile = run.resolve("origin");
        if (!Files.exists(originFile)) {
            Files.writeString(originFile, Instant.now().toString());
        }
        origin = Instant.parse(Files.readString(originFile).trim());
        log("start (origin " + origin + ")");
        a = new Desk("a", (Map<String, Object>) session.get("a"), run.resolve("a"));
        b = new Desk("b", (Map<String, Object>) session.get("b"), run.resolve("b"));
        a.open();
        b.open();
        // A desk-stop window still open when the process restarted: Runner begins it again, which stops desk A again.
        Map<String, Soak.Channel> channels = new LinkedHashMap<>();
        channels.put("ma-ab", member("ma-ab", () -> a, () -> b));
        channels.put("ma-ba", member("ma-ba", () -> b, () -> a));
        channels.put("door-a", door("door-a", () -> a));
        channels.put("door-b", door("door-b", () -> b));
        channels.put("out-a", out("out-a", () -> a));
        channels.put("out-b", out("out-b", () -> b));
        Path ledgerPath = run.resolve("ledger.tsv");
        Thread status = Thread.ofVirtual().name("soak-status").start(() -> {
            boolean first = true;
            while (!Thread.currentThread().isInterrupted()) {
                try {
                    Thread.sleep(first ? Duration.ofMinutes(2) : Duration.ofMinutes(10));
                    first = false;
                } catch (InterruptedException e) {
                    return;
                }
                writeStatus(ledgerPath);
            }
        });
        Soak.Report report;
        try (Ledger ledger = new Ledger(ledgerPath)) {
            report = new Runner(plan(), channels, faults(), this::observed, ledger, Clock.systemUTC(), d -> Thread.sleep(d.toMillis()), this::log)
                    .anchoredAt(origin).run();
        }
        status.interrupt();
        Files.write(run.resolve("report.json"), Json.bytes(report.toJson()));
        Files.writeString(run.resolve("report.md"), report.toMarkdown());
        writeStatus(ledgerPath);
        Files.writeString(run.resolve("finished"), Instant.now() + " " + (report.passed() ? "PASSED" : "FAILED") + "\n");
        log("finished: " + (report.passed() ? "PASSED" : "FAILED") + " lost " + report.lost().size() + " doubled " + report.doubled().size());
        a.close();
        b.close();
    }

    public static void main(String[] args) throws Exception {
        Path run = Path.of(args.length > 0 ? args[0] : System.getProperty("user.home") + "/work/maia-mode/courier-soak/run");
        if (Files.exists(run.resolve("finished"))) {
            System.out.println("already finished: " + Files.readString(run.resolve("finished")).trim());
            return;
        }
        new CourierStagingSoak(run).runSoak();
        System.exit(0);
    }
}
