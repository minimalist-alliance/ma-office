package com.minimalistalliance.desk.deskd.notebook;

import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.events.EventHub;
import com.minimalistalliance.desk.deskd.events.TopicRegistry;
import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.Frame;
import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.rpc.Caller;
import com.minimalistalliance.desk.deskd.rpc.RpcDispatcher;
import com.minimalistalliance.desk.deskd.rtc.RtcClient;
import com.minimalistalliance.desk.deskd.session.SessionGrant;
import com.minimalistalliance.desk.deskd.session.SessionManager;
import com.minimalistalliance.desk.deskd.status.DeskFacts;
import com.minimalistalliance.desk.deskd.testing.FakeDeskRtc;
import com.minimalistalliance.desk.deskd.testing.FakeNotebookSocket;
import com.minimalistalliance.desk.deskd.testing.StubAuthorizer;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import com.minimalistalliance.desk.deskd.testing.TestTiming;
import java.lang.management.ManagementFactory;
import java.lang.management.MemoryPoolMXBean;
import java.lang.management.MemoryType;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

/**
 * The guild load gate's memory measurement (task 48): 600 guild_member sessions (200 members, 3 each) against the
 * in-process fakes (desk-rtc, desk-notebook and Commons on real Unix sockets), each with a live collab relay and a
 * commons relay, a notebook.tree subscription, and refresh cycles that change the caller. Run as a main, not by
 * surefire: {@code java -Xmx.. -cp <test classpath> ...GuildLoadMain [members] [rounds] [messageKiB] [burstKiB]}.
 * The fakes share the heap, so the numbers are an upper bound on deskd's own.
 */
public final class GuildLoadMain {

    private static final int TABS = 3;

    private GuildLoadMain() {}

    public static void main(String[] args) throws Exception {
        int members = args.length > 0 ? Integer.parseInt(args[0]) : 200;
        int rounds = args.length > 1 ? Integer.parseInt(args[1]) : 5;
        int messageKib = args.length > 2 ? Integer.parseInt(args[2]) : 16;
        int burstKib = args.length > 3 ? Integer.parseInt(args[3]) : 512;
        int total = members * TABS;
        TestTiming.pollFast();
        Path dir = Files.createTempDirectory("guild-load");
        DeskFacts facts = new DeskFacts() {
            @Override public String deskId() { return "d-guild"; }
            @Override public String bootId() { return "boot-1"; }
            @Override public String instanceType() { return "t4g.small"; }
            @Override public String publicIpv4() { return "203.0.113.7"; }
            @Override public boolean guildDesk() { return true; }
        };
        FakeNotebookSocket notebook = new FakeNotebookSocket(dir.resolve("notebook.sock"));
        notebook.likeTheService();
        notebook.collabHandler = bytes -> bytes;
        FakeNotebookSocket commons = new FakeNotebookSocket(dir.resolve("commons.sock"));
        commons.collabHandler = bytes -> bytes;
        FakeDeskRtc fake = new FakeDeskRtc(dir.resolve("rtc.sock"));
        RtcClient rtc = new RtcClient(new RtcClient.Config(dir.resolve("rtc.sock"), () -> SessionManager.maxSessions(true),
                facts::publicIpv4, () -> true, SessionManager.MAX_MEMBER_SESSIONS));
        StubAuthorizer authorizer = new StubAuthorizer();
        RpcDispatcher dispatcher = new RpcDispatcher();
        EventHub hub = new EventHub(new TopicRegistry());
        SessionManager sessions = new SessionManager(rtc, authorizer, dispatcher, hub, facts, "1", Instant.now());
        NotebookModule module = new NotebookModule(dir.resolve("notebook.sock"), sessions, dispatcher, hub, NotebookModule.Timing.DEFAULT);
        CommonsRelay commonsRelay = new CommonsRelay(dir.resolve("commons.sock"), sessions, hub, () -> true, NotebookModule.Timing.DEFAULT);
        rtc.start(sessions);
        await().until(rtc::isConfigured);

        report("start");
        List<TestClient> clients = new ArrayList<>();
        List<String> ids = new ArrayList<>();
        List<String> fingerprints = new ArrayList<>();
        long handle = 1;
        for (int i = 0; i < total; i++) {
            String id = "cs-" + i;
            String fp = String.format("%064x", i + 1);
            String memberId = String.format("gm-m%07d", i / TABS);
            authorizer.allow("t-" + id, grant(memberId, fp, "member", List.of(), 1));
            sessions.open(id, "t-" + id);
            sessions.offer(id, TestClient.offerFor(fp));
            TestClient client = new TestClient(fake, handle++);
            client.hello();
            clients.add(client);
            ids.add(id);
            fingerprints.add(fp);
        }
        report("opened " + total);

        ExecutorService pool = Executors.newFixedThreadPool(32);
        byte[] small = new byte[messageKib * 1024];
        for (int round = 1; round <= rounds; round++) {
            final int r = round;
            // Every session: a call, a subscription (first round), a collab and a commons message each way.
            forEach(pool, total, i -> {
                TestClient c = clients.get(i);
                c.call("notebook.tree", Map.of());
                if (r == 1) {
                    c.subscribe("notebook.tree", null);
                }
                send(fake, c, Channels.COLLAB, small);
                send(fake, c, Channels.MDOC, small);
                drain(fake, c, Channels.COLLAB, small.length);
                drain(fake, c, Channels.MDOC, small.length);
            });
            // The refresh cycle: a promotion and a demotion, each told to both relays.
            final String role = round % 2 == 1 ? "officer" : "member";
            final List<String> grants = round % 2 == 1 ? List.of("moderate", "invite") : List.of();
            forEach(pool, total, i -> {
                String memberId = String.format("gm-m%07d", i / TABS);
                authorizer.allow("r-" + ids.get(i) + r, grant(memberId, fingerprints.get(i), role, grants, 2));
                sessions.refresh(ids.get(i), "r-" + ids.get(i) + r);
            });
            notebook.publish(Map.of("rev", round));
            Thread.sleep(500);
            clear(fake, clients, notebook, commons);
            report("round " + round);
        }
        // The burst: every session moves a big message each way on both relays at once.
        for (MemoryPoolMXBean pool2 : ManagementFactory.getMemoryPoolMXBeans()) {
            pool2.resetPeakUsage();
        }
        byte[] big = new byte[burstKib * 1024];
        forEach(pool, total, i -> {
            TestClient c = clients.get(i);
            send(fake, c, Channels.COLLAB, big);
            send(fake, c, Channels.MDOC, big);
            drain(fake, c, Channels.COLLAB, big.length);
            drain(fake, c, Channels.MDOC, big.length);
        });
        long peak = 0;
        for (MemoryPoolMXBean p : ManagementFactory.getMemoryPoolMXBeans()) {
            if (p.getType() == MemoryType.HEAP) {
                peak += p.getPeakUsage().getUsed();
            }
        }
        System.out.printf("burst %d KiB x2 x2 x%d sessions: sum of heap pool peaks %d MiB%n", burstKib, total, peak >> 20);
        clear(fake, clients, notebook, commons);
        report("after burst");
        System.out.printf("sessions live: %d, notebook links %d, commons links %d%n", sessions.sessionIds().size(),
                notebook.openConnections(), commons.openConnections());
        pool.shutdownNow();
        module.close();
        commonsRelay.close();
        rtc.close();
        fake.close();
        notebook.close();
        commons.close();
        System.exit(0);
    }

    private static SessionGrant grant(String memberId, String fp, String role, List<String> grants, int hours) {
        Caller caller = new Caller(Caller.GUILD_MEMBER, memberId, role, Caller.effectiveGrants(role, grants), "Name " + memberId, null, false);
        return new SessionGrant(memberId, "sid-" + memberId, "guild_member", fp, false, false, Instant.now(),
                Instant.now().plus(Duration.ofHours(hours)), caller, "gu-testguild01");
    }

    private static void send(FakeDeskRtc fake, TestClient c, int channel, byte[] message) {
        for (byte[] frame : Frame.fragment(FrameKind.DATA, Frame.BIN, 9, 0, message)) {
            fake.sendData(c.handle(), channel, frame);
        }
    }

    /** Reads the echo of one message, so the client's queue stays empty. */
    private static void drain(FakeDeskRtc fake, TestClient c, int channel, int expected) {
        try {
            int got = 0;
            while (got < expected) {
                Frame f = fake.pollFrame(c.handle(), channel, 20_000);
                if (f == null) {
                    throw new IllegalStateException("no echo on " + channel + " after " + got + " of " + expected);
                }
                got += f.payload().length;
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    private static void clear(FakeDeskRtc fake, List<TestClient> clients, FakeNotebookSocket notebook, FakeNotebookSocket commons)
            throws Exception {
        for (TestClient c : clients) {
            for (int ch = 0; ch < 8; ch++) {
                while (fake.pollFrame(c.handle(), ch, 0) != null) {
                    // events, caller changes, pongs: not what is being measured
                }
            }
        }
        for (FakeNotebookSocket s : List.of(notebook, commons)) {
            s.collabReceived.clear();
            for (FakeNotebookSocket.Connection connection : s.connections) {
                connection.received.clear();
                connection.collab.clear();
            }
        }
    }

    private interface Work {
        void run(int i) throws Exception;
    }

    private static void forEach(ExecutorService pool, int n, Work work) throws Exception {
        List<Future<?>> futures = new ArrayList<>();
        for (int i = 0; i < n; i++) {
            final int k = i;
            futures.add(pool.submit(() -> {
                work.run(k);
                return null;
            }));
        }
        for (Future<?> f : futures) {
            f.get();
        }
    }

    private static void report(String label) throws Exception {
        for (int i = 0; i < 3; i++) {
            System.gc();
            Thread.sleep(200);
        }
        Runtime rt = Runtime.getRuntime();
        long used = rt.totalMemory() - rt.freeMemory();
        String rss = "?";
        String hwm = "?";
        for (String line : Files.readAllLines(Path.of("/proc/self/status"))) {
            if (line.startsWith("VmRSS:")) {
                rss = line.substring(6).trim();
            } else if (line.startsWith("VmHWM:")) {
                hwm = line.substring(6).trim();
            }
        }
        System.out.printf("%-14s heap after GC %4d MiB (committed %d), RSS %s, peak RSS %s, threads %d%n", label, used >> 20,
                rt.totalMemory() >> 20, rss, hwm, Thread.activeCount());
    }
}
