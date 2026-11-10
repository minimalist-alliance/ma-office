package com.minimalistalliance.desk.deskd.browser;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.platform.PlatformHttp;
import com.minimalistalliance.desk.deskd.testing.FakeCdp;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Collectors;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** The connection itself, with no model on top to clean up after it. */
class CdpClientTest {

    private static final CdpClient.Timing FAST = new CdpClient.Timing(
            Duration.ofMillis(500), Duration.ofMillis(800), Duration.ofMillis(20), Duration.ofMillis(100), Duration.ofMillis(50), Duration.ofMillis(500));

    private static final String HUNG_METHOD = "Input.insertText";
    private static final Duration LONG = Duration.ofSeconds(30);

    /** A listener can push as soon as the socket is open, which is before the second look at who it is. */
    @Test
    void nothingAListenerSaysBeforeTheSecondLookIsBelieved() throws Exception {
        List<String> heard = new CopyOnWriteArrayList<>();
        AtomicInteger looks = new AtomicInteger();
        try (FakeCdp fake = new FakeCdp();
                PlatformHttp http = new PlatformHttp();
                CdpClient client = new CdpClient(
                        http,
                        fake.port(),
                        () -> secondLook(fake, looks),
                        new CdpClient.Events() {
                            @Override
                            public void onEvent(String method, String sessionId, Map<String, Object> params) {
                                heard.add(method);
                            }

                            @Override
                            public void onConnected() {
                                heard.add("connected");
                            }

                            @Override
                            public void onDisconnected(boolean unexpected) {
                                heard.add("disconnected");
                            }

                            @Override
                            public void onAttemptFailed() {}

                            @Override
                            public void onDisplaced() {}
                        },
                        () -> true,
                        FAST)) {
            client.wake();
            await().atMost(Duration.ofSeconds(5)).until(() -> looks.get() >= 3);
            assertThat(heard).isEmpty();
            assertThat(client.refusal()).isEqualTo(new CdpListener.Verdict(CdpListener.Kind.FOREIGN, 1103));
            assertThat(client.isConnected()).isFalse();
        }
    }

    /**
     * Regression: the JDK's client keeps a connection for the next request, and a WebSocket's upgrade goes over one too.
     * So one read that landed on someone holding the port for a moment left them a connection that went on answering
     * after Chromium had the port back and every look said so. The next connect's upgrade went over it as well, so all
     * a client typed went to them, while Chromium saw no connection at all.
     *
     * <p>Everything here runs as one user, so the kernel's own table is read with the uids it would show on a desk:
     * listeners are kiosk's, which stands in for the moment a look passed the forger, and the connection it kept is
     * 1103's.
     */
    @Test
    void aConnectionKeptFromSomeoneWhoHeldThePortIsNeverUsedAgain(@TempDir Path dir) throws Exception {
        ServerSocket forgedListener = new ServerSocket(0, 5, InetAddress.getLoopbackAddress());
        int port = forgedListener.getLocalPort();
        List<String> forgerHeard = new CopyOnWriteArrayList<>();
        AtomicInteger keptPeerPort = new AtomicInteger(-1);
        try (PlatformHttp http = new PlatformHttp();
                CdpClient client = new CdpClient(
                        http,
                        port,
                        () -> lookWithDesksUids(dir, port, keptPeerPort.get()),
                        new Quiet(),
                        () -> true,
                        FAST)) {
            Socket[] kept = new Socket[1];
            Thread forger = Thread.ofVirtual().start(() -> {
                try {
                    kept[0] = forgedListener.accept();
                    keptPeerPort.set(kept[0].getPort());
                    answerAsForger(kept[0], forgerHeard);
                } catch (IOException e) {
                    // The test is over.
                }
            });
            assertThat(client.pageOrder()).containsExactly("forged");
            await().until(() -> forgerHeard.size() == 1);
            forgedListener.close();

            try (FakeCdp chromium = new FakeCdp(port)) {
                chromium.addPage("a", "https://example.com/a", "real");

                assertThatThrownBy(client::pageOrder).isInstanceOf(IOException.class);
                assertThat(client.refusal()).isEqualTo(new CdpListener.Verdict(CdpListener.Kind.FOREIGN, 1103));
                client.wake();
                Thread.sleep(300);
                assertThat(client.isConnected()).isFalse();
                assertThat(forgerHeard).hasSize(1);
                assertThat(chromium.httpRequests("/json/version")).isZero();

                // It lets go of what it kept, and all is as usual, with Chromium.
                kept[0].close();
                forger.join(Duration.ofSeconds(5));
                keptPeerPort.set(-1);
                await().atMost(Duration.ofSeconds(5)).until(client::isConnected);
                assertThat(client.pageOrder()).containsExactly("a");
                assertThat(chromium.upgrades()).isEqualTo(1);
                assertThat(forgerHeard).hasSize(1);
            }
        } finally {
            forgedListener.close();
        }
    }

    /** The kernel's tables, with uids as they'd be on a desk: every listener kiosk's, and the kept connection 1103's. */
    private static CdpListener.Verdict lookWithDesksUids(Path dir, int port, int keptPeerPort) {
        try {
            String portHex = String.format(Locale.ROOT, "%04X", port);
            String keptHex = String.format(Locale.ROOT, "%04X", keptPeerPort);
            Path tcp = dir.resolve("tcp");
            Path tcp6 = dir.resolve("tcp6");
            for (Path[] tables : new Path[][] {{CdpListener.PROC_TCP, tcp}, {CdpListener.PROC_TCP6, tcp6}}) {
                Files.writeString(tables[1], Files.readString(tables[0]).lines().map(line -> {
                    String[] fields = line.trim().split("\\s+");
                    if (fields.length > 7 && fields[1].endsWith(":" + portHex)) {
                        boolean kept = "01".equals(fields[3]) && fields[2].endsWith(":" + keptHex);
                        fields[7] = kept ? "1103" : "1102";
                        return String.join(" ", fields);
                    }
                    return line;
                }).collect(Collectors.joining("\n", "", "\n")));
            }
            return new CdpListener(tcp, tcp6, port, 1102).get();
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }

    /** HTTP/1.1 with keep-alive, as Chromium's server does, and an upgrade if it's asked for one. */
    private static void answerAsForger(Socket socket, List<String> heard) throws IOException {
        InputStream in = socket.getInputStream();
        OutputStream out = socket.getOutputStream();
        while (true) {
            String head = readHead(in);
            if (head == null) {
                return;
            }
            heard.add(head.lines().findFirst().orElse(""));
            if (head.toLowerCase(Locale.ROOT).contains("upgrade: websocket")) {
                // A test that gets this far has failed already, and needs only to see this line.
                return;
            }
            byte[] body = (head.startsWith("GET /json/version")
                            ? "{\"webSocketDebuggerUrl\":\"ws://127.0.0.1/devtools/browser/forged\"}"
                            : "[{\"id\":\"forged\",\"type\":\"page\",\"url\":\"https://forged/\",\"title\":\"forged\"}]")
                    .getBytes(StandardCharsets.UTF_8);
            out.write(("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: " + body.length + "\r\n\r\n")
                    .getBytes(StandardCharsets.US_ASCII));
            out.write(body);
            out.flush();
        }
    }

    private static String readHead(InputStream in) throws IOException {
        ByteArrayOutputStream head = new ByteArrayOutputStream();
        int previous = 0;
        int run = 0;
        while (true) {
            int b = in.read();
            if (b < 0) {
                return null;
            }
            head.write(b);
            run = (b == '\n' && previous == '\r') ? run + 1 : (b == '\r' ? run : 0);
            previous = b;
            if (run == 2) {
                return head.toString(StandardCharsets.ISO_8859_1);
            }
        }
    }

    /** Trusted for the first request, and then not, having just pushed something at the open socket. */
    private static CdpListener.Verdict secondLook(FakeCdp fake, AtomicInteger looks) {
        if (looks.incrementAndGet() == 1) {
            return new CdpListener.Verdict(CdpListener.Kind.TRUSTED, 1102);
        }
        await().until(fake::isConnected);
        fake.event("Target.targetCreated", Map.of("targetInfo", Map.of("targetId", "false", "type", "page")), null);
        try {
            Thread.sleep(50);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        return new CdpListener.Verdict(CdpListener.Kind.FOREIGN, 1103);
    }

    private static final class Quiet implements CdpClient.Events {
        @Override
        public void onEvent(String method, String sessionId, Map<String, Object> params) {
            // Nothing here looks at events.
        }

        @Override
        public void onConnected() {
            // Nothing to set up.
        }

        @Override
        public void onDisconnected(boolean unexpected) {
            // The test ends the connection itself.
        }

        @Override
        public void onAttemptFailed() {
            // The test waits for the connection.
        }

        @Override
        public void onDisplaced() {
            // Nothing here reads as off the port.
        }
    }

    /**
     * Regression. A command turned away for there being too many out was TIMEOUT, which is what a command
     * that went out and got no reply is, and browser.tab.navigate takes that to mean it's still going.
     */
    @Test
    void aCommandTurnedAwayWithTooManyOutSaysItWasntSent() throws Exception {
        CdpListener.Verdict trusted = new CdpListener.Verdict(CdpListener.Kind.TRUSTED, 1102);
        try (FakeCdp cdp = new FakeCdp();
                PlatformHttp http = new PlatformHttp();
                CdpClient client = new CdpClient(http, cdp.port(), () -> trusted, new Quiet(), () -> true, CdpClient.Timing.DEFAULT)) {
            cdp.hold(HUNG_METHOD);
            client.wake();
            await().until(client::isConnected);

            List<Thread> out = new ArrayList<>();
            for (int i = 0; i < CdpClient.MAX_IN_FLIGHT; i++) {
                out.add(Thread.ofVirtual().start(() -> {
                    try {
                        client.call("Sa", HUNG_METHOD, Map.of(), LONG);
                    } catch (CdpException e) {
                        // The client closing is what ends these.
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                    }
                }));
            }
            await().until(() -> cdp.commands(HUNG_METHOD).size() == CdpClient.MAX_IN_FLIGHT);

            assertThatThrownBy(() -> client.call("Sa", HUNG_METHOD, Map.of(), LONG))
                    .isInstanceOfSatisfying(CdpException.class, e -> assertThat(e.kind()).isEqualTo(CdpException.Kind.NOT_SENT));
            assertThat(cdp.commands(HUNG_METHOD)).hasSize(CdpClient.MAX_IN_FLIGHT);

            client.close();
            for (Thread thread : out) {
                thread.join();
            }
        }
    }
}
