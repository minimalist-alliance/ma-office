package com.minimalistalliance.desk.deskd.courier.linked;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.courier.testkit.FakeImapServer;
import com.minimalistalliance.desk.deskd.courier.TestMime;
import com.minimalistalliance.desk.deskd.courier.parse.CourierParser;
import com.minimalistalliance.desk.deskd.courier.parse.CourierSandbox;
import com.minimalistalliance.desk.deskd.protocol.Json;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.management.ManagementFactory;
import java.lang.management.MemoryMXBean;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.channels.Channels;
import java.nio.channels.ServerSocketChannel;
import java.nio.channels.SocketChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The bar's first sync of a large mailbox (the launch plan §7, §2.12), paced as on a desk ({@link MailboxSync.Settings#DEFAULT}:
 * 2 MiB/s, chunks of 50, the last 12 months first), with its time, heap and CPU measured, and the bar's oracle at the end:
 * every message once. In a build it runs 1,500 messages; {@code -Dcourier.imap.perf.messages=50000} is the bar's run.
 *
 * <p>With {@code -Dcourier.imap.perf.worker=true} each message is parsed as the sandbox does it, by a fresh worker JVM with
 * {@code courier-parse.options}' flags (behind deskd's real {@link CourierSandbox} client on a Unix socket, a process per
 * connection as {@code desk-svc -conn-stdio} runs one), so the run measures the parse's real cost too; otherwise the
 * in-process stand-in parses, and the run measures the transport and the store. The JSON report goes to
 * {@code target/courier-imap-perf.json}.
 */
class FirstSyncPerfTest {

    static final int N = Integer.getInteger("courier.imap.perf.messages", 1_500);
    static final boolean WORKER = Boolean.getBoolean("courier.imap.perf.worker");

    @TempDir
    Path dir;

    /** A message as mail is: mostly text and HTML of a few KB, some replies, now and then an attachment. */
    static byte[] message(int i) {
        Random rnd = new Random(0x5EEDL * 31 + i);
        StringBuilder text = new StringBuilder();
        int words = 40 + rnd.nextInt(rnd.nextInt(10) == 0 ? 3000 : 600);
        for (int w = 0; w < words; w++) {
            text.append(WORDS[rnd.nextInt(WORDS.length)]).append(w % 14 == 13 ? ".\r\n" : " ");
        }
        int person = rnd.nextInt(800);
        String head = "From: Person " + person + " <p" + person + "@people.example>\r\nTo: " + LinkedRig.LOGIN + "\r\nSubject: "
                + WORDS[rnd.nextInt(WORDS.length)] + " " + WORDS[rnd.nextInt(WORDS.length)] + " " + i + "\r\nMessage-ID: <perf" + i
                + "@people.example>\r\nDate: Mon, 2 Nov 2026 10:00:00 +0000\r\nMIME-Version: 1.0\r\n";
        if (rnd.nextInt(20) == 0) {
            byte[] bin = new byte[20_000 + rnd.nextInt(400_000)];
            rnd.nextBytes(bin);
            return (head + "Content-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n" + text
                    + "\r\n--b\r\nContent-Type: application/pdf; name=\"f.pdf\"\r\nContent-Transfer-Encoding: base64\r\n\r\n"
                    + Base64.getMimeEncoder().encodeToString(bin) + "\r\n--b--\r\n").getBytes(StandardCharsets.UTF_8);
        }
        if (rnd.nextBoolean()) {
            return (head + "Content-Type: text/html; charset=utf-8\r\n\r\n<html><body><table><tr><td><p style=\"font-size:14px\">"
                    + text.toString().replace("\r\n", "</p><p>") + "</p></td></tr></table></body></html>\r\n").getBytes(StandardCharsets.UTF_8);
        }
        return (head + "Content-Type: text/plain; charset=utf-8\r\n\r\n" + text + "\r\n").getBytes(StandardCharsets.UTF_8);
    }

    private static final String[] WORDS = ("meeting invoice travel order shipped receipt dinner project report weekend flight "
            + "booking school update account payment reminder photos family garden review contract draft schedule tickets hotel "
            + "delivery question answer thanks please tomorrow monday budget plan notes summary agenda").split(" ");

    @Test
    void theFirstSyncOfALargeMailbox() throws Exception {
        Map<String, Object> report = new LinkedHashMap<>();
        report.put("messages", N);
        report.put("parser", WORKER ? "worker JVM per message (courier-parse.options)" : "in-process stand-in");
        ProcessSandbox sandbox = WORKER ? new ProcessSandbox(dir.resolve("parse")) : null;
        CourierParser parser = WORKER ? new CourierSandbox(CourierSandbox.Settings.defaults(sandbox.socket)) : TestMime.PARSER;
        try (LinkedRig rig = new LinkedRig(dir, FakeImapServer.Options.defaults(), parser)) {
            rig.settings = MailboxSync.Settings.DEFAULT;
            long bytes = 0;
            Instant now = Instant.now();
            for (int i = 0; i < N; i++) {
                byte[] b = message(i);
                bytes += b.length;
                final int k = i;
                String folder = i % 20 == 0 ? "Sent" : i % 7 == 0 ? "Archive" : "INBOX";
                // Five years of mail, oldest first, so UIDs rise with time as a real mailbox's do.
                Instant at = now.minus(Duration.ofMinutes((long) (N - i) * 5L * 365 * 24 * 60 / N));
                rig.imap.deliver(LinkedRig.LOGIN, folder, b.length, () -> message(k), i % 3 == 0 ? Set.of() : Set.of("\\Seen"), at);
            }
            report.put("rawMiB", bytes / (1024 * 1024));
            MemoryMXBean mem = ManagementFactory.getMemoryMXBean();
            System.gc();
            long baseline = mem.getHeapMemoryUsage().getUsed();
            AtomicLong peakUsed = new AtomicLong();
            AtomicLong peakLive = new AtomicLong();
            AtomicBoolean sampling = new AtomicBoolean(true);
            com.sun.management.OperatingSystemMXBean os = (com.sun.management.OperatingSystemMXBean) ManagementFactory.getOperatingSystemMXBean();
            Thread sampler = Thread.ofPlatform().daemon().start(() -> {
                int n = 0;
                while (sampling.get()) {
                    peakUsed.accumulateAndGet(mem.getHeapMemoryUsage().getUsed(), Math::max);
                    if (++n % 50 == 0) {
                        System.gc();
                        peakLive.accumulateAndGet(mem.getHeapMemoryUsage().getUsed(), Math::max);
                    }
                    try {
                        Thread.sleep(200);
                    } catch (InterruptedException e) {
                        return;
                    }
                }
            });
            long cpu0 = os.getProcessCpuTime();
            long children0 = childrenCpuMillis();
            long served0 = rig.imap.bytesServed();
            long t0 = System.nanoTime();
            rig.link();
            List<long[]> progress = new ArrayList<>();
            long firstHundred = -1;
            long lastReport = 0;
            while (true) {
                long n = rig.count("SELECT count(*) FROM messages");
                long ms = (System.nanoTime() - t0) / 1_000_000;
                if (firstHundred < 0 && n >= 100) {
                    firstHundred = ms;
                }
                if (ms - lastReport >= 30_000) {
                    progress.add(new long[] {ms / 1000, n});
                    lastReport = ms;
                }
                MailboxSync.Status st = rig.status();
                if (st != null && st.firstSyncDone() && "live".equals(st.state()) && n >= N) {
                    break;
                }
                assertThat(ms).as("first sync within 6 hours").isLessThan(Duration.ofHours(6).toMillis());
                Thread.sleep(500);
            }
            long wall = (System.nanoTime() - t0) / 1_000_000;
            long cpu = (os.getProcessCpuTime() - cpu0) / 1_000_000;
            long children = childrenCpuMillis() - children0;
            sampling.set(false);
            sampler.join(2_000);
            System.gc();
            long after = mem.getHeapMemoryUsage().getUsed();
            report.put("wallSeconds", wall / 1000.0);
            report.put("messagesPerSecond", Math.round(N * 1000.0 / wall * 10) / 10.0);
            report.put("firstHundredMs", firstHundred);
            report.put("cpuSeconds", cpu / 1000.0);
            report.put("workerCpuSeconds", children / 1000.0);
            report.put("workerCpuMsPerMessage", WORKER ? Math.round(children * 10.0 / N) / 10.0 : null);
            report.put("servedMiB", (rig.imap.bytesServed() - served0) / (1024 * 1024));
            report.put("heapBaselineMiB", baseline / (1024 * 1024));
            report.put("heapPeakUsedAboveBaselineMiB", (peakUsed.get() - baseline) / (1024 * 1024));
            report.put("heapPeakLiveAboveBaselineMiB", (peakLive.get() - baseline) / (1024 * 1024));
            report.put("heapAfterAboveBaselineMiB", (after - baseline) / (1024 * 1024));
            report.put("heapMaxMiB", Runtime.getRuntime().maxMemory() / (1024 * 1024));
            report.put("storeMiB", Files.walk(dir.resolve("courier")).filter(Files::isRegularFile).mapToLong(p -> p.toFile().length()).sum()
                    / (1024 * 1024));
            report.put("progress", progress.stream().map(p -> p[0] + "s:" + p[1]).toList());
            long count = rig.count("SELECT count(*) FROM messages");
            long distinct = rig.count("SELECT count(DISTINCT blob) FROM messages");
            long pending = rig.count("SELECT count(*) FROM messages WHERE lane = 'pending'");
            report.put("stored", count);
            report.put("pending", pending);
            String json = new String(Json.bytes(report), StandardCharsets.UTF_8);
            System.out.println("COURIER-IMAP-PERF " + json);
            Files.createDirectories(Path.of("target"));
            Files.writeString(Path.of("target", "courier-imap-perf" + (WORKER ? "-worker" : "") + ".json"), json);
            assertThat(count).isEqualTo(N);
            assertThat(distinct).isEqualTo(N);
            assertThat(pending).isZero();
            assertThat(rig.check()).isEmpty();
        } finally {
            if (sandbox != null) {
                sandbox.close();
            }
        }
    }

    /** CPU of this JVM's finished children (the worker JVMs), from /proc: cutime and cstime, in ms; 0 off Linux. */
    static long childrenCpuMillis() {
        try {
            String stat = Files.readString(Path.of("/proc/self/stat"));
            String[] f = stat.substring(stat.lastIndexOf(')') + 2).split(" ");
            // Fields 16 and 17 of stat (1-based), counted from after the command's closing parenthesis (field 3 on).
            long ticks = Long.parseLong(f[13]) + Long.parseLong(f[14]);
            return ticks * 10;
        } catch (IOException | RuntimeException e) {
            return 0;
        }
    }

    /**
     * The sandbox's dispatcher in miniature: a Unix socket, one connection at a time, each a fresh worker JVM with
     * {@code courier-parse.options}' flags whose stdin and stdout are the connection, as {@code desk-svc -conn-stdio} runs
     * it (no container here: this measures the JVM per message, not Docker's start).
     */
    static final class ProcessSandbox implements AutoCloseable {
        final Path socket;
        private final ServerSocketChannel server;
        private final Thread acceptor;

        ProcessSandbox(Path dir) throws IOException {
            Files.createDirectories(dir);
            socket = dir.resolve("parse.sock");
            server = ServerSocketChannel.open(StandardProtocolFamily.UNIX);
            server.bind(UnixDomainSocketAddress.of(socket));
            Path trackers = dir.resolve("trackers.txt");
            Files.writeString(trackers, "# none\n");
            List<String> command = command(trackers);
            acceptor = Thread.ofPlatform().daemon().start(() -> {
                while (server.isOpen()) {
                    try (SocketChannel c = server.accept()) {
                        ProcessBuilder pb = new ProcessBuilder(command);
                        pb.environment().clear();
                        pb.redirectError(ProcessBuilder.Redirect.DISCARD);
                        Process p = pb.start();
                        InputStream in = Channels.newInputStream(c);
                        OutputStream out = Channels.newOutputStream(c);
                        Thread pump = Thread.ofVirtual().start(() -> {
                            try (OutputStream stdin = p.getOutputStream()) {
                                in.transferTo(stdin);
                            } catch (IOException e) {
                                // the worker stopped reading
                            }
                        });
                        try (InputStream stdout = p.getInputStream()) {
                            stdout.transferTo(out);
                        }
                        p.waitFor();
                        pump.join(5_000);
                    } catch (IOException | InterruptedException e) {
                        if (!server.isOpen()) {
                            return;
                        }
                    }
                }
            });
        }

        static List<String> command(Path trackers) throws IOException {
            List<String> cmd = new ArrayList<>();
            cmd.add(Path.of(System.getProperty("java.home"), "bin", "java").toString());
            List<String> lines = new ArrayList<>();
            for (String line : Files.readAllLines(Path.of("../desk-agent/docker/courier-parse.options"))) {
                if (!line.isBlank() && !line.startsWith("#")) {
                    lines.add(line.strip());
                }
            }
            for (int i = 0; i < lines.size(); i++) {
                String l = lines.get(i);
                if (l.equals("-cp")) {
                    cmd.add("-cp");
                    cmd.add(System.getProperty("java.class.path"));
                    i++;
                } else if (l.startsWith("-Dma.courier.trackers=")) {
                    cmd.add("-Dma.courier.trackers=" + trackers);
                } else {
                    cmd.add(l);
                }
            }
            return cmd;
        }

        @Override
        public void close() throws IOException {
            server.close();
            acceptor.interrupt();
            Files.deleteIfExists(socket);
        }
    }
}
