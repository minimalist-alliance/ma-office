package com.minimalistalliance.desk.deskd.courier.imsg.bluebubbles;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.courier.testkit.FakeTls;
import com.minimalistalliance.desk.deskd.courier.linked.Net;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.function.Consumer;
import org.junit.jupiter.api.Test;

/**
 * A hostile or broken server where the member's Mac should be: the address rules, the HTTP client's limits, a server that
 * drips bytes, redirects, the websocket's limits, and the password never in a buffer of ours past its use.
 */
class HostileMacTest {

    private static final MacLink.Settings FAST = new MacLink.Settings(Duration.ofSeconds(2), Duration.ofSeconds(3), 64 * 1024, true);

    /** A one-connection-at-a-time server on loopback that answers each connection with {@code script}. */
    private static final class Evil implements AutoCloseable {
        final ServerSocket server;
        final Thread t;
        volatile String lastRequest;

        Evil(Consumer<Socket> script) throws IOException {
            this((sock, head) -> script.accept(sock));
        }

        Evil(java.util.function.BiConsumer<Socket, String> script) throws IOException {
            server = new ServerSocket(0, 50, InetAddress.getLoopbackAddress());
            t = Thread.ofVirtual().start(() -> {
                while (!server.isClosed()) {
                    try (Socket s = server.accept()) {
                        InputStream in = s.getInputStream();
                        ByteArrayOutputStream head = new ByteArrayOutputStream();
                        int prev3 = 0;
                        int c;
                        while ((c = in.read()) >= 0) {
                            head.write(c);
                            prev3 = (prev3 << 8 | c) & 0xFFFFFFFF;
                            if (prev3 == 0x0D0A0D0A) {
                                break;
                            }
                        }
                        lastRequest = head.toString(StandardCharsets.ISO_8859_1);
                        script.accept(s, lastRequest);
                    } catch (IOException e) {
                        // next
                    }
                }
            });
        }

        MacAddress address() {
            return new MacAddress("127.0.0.1", server.getLocalPort(), false);
        }

        @Override
        public void close() throws IOException {
            server.close();
        }
    }

    private static void write(Socket s, String text) {
        try {
            OutputStream out = s.getOutputStream();
            out.write(text.getBytes(StandardCharsets.ISO_8859_1));
            out.flush();
        } catch (IOException ignored) {
            // the client went away
        }
    }

    private static MacLink link() {
        return new MacLink(Net.forTests(FakeTls.clientContext()), MacLink.jdkTrust(), FAST);
    }

    @Test
    void theAddressIsHttpsAHostAndAPortAndNothingElse() throws Exception {
        assertThat(MacAddress.parse("mac.example.net", false).url()).isEqualTo("https://mac.example.net");
        assertThat(MacAddress.parse("https://Mac.Example.net:1234/", false)).isEqualTo(new MacAddress("mac.example.net", 1234, true));
        assertThat(MacAddress.parse("https://abc-def.trycloudflare.com", false).through()).isEqualTo(MacAddress.CLOUDFLARE);
        assertThat(MacAddress.parse("https://x.ngrok-free.app", false).through()).isEqualTo(MacAddress.NGROK);
        assertThat(MacAddress.parse("https://x.share.zrok.io", false).through()).isEqualTo(MacAddress.ZROK);
        assertThat(MacAddress.parse("https://evil-trycloudflare.com", false).through()).isEqualTo(MacAddress.OWN);
        assertThat(MacAddress.parse("https://203.0.113.9:1234", false).sniName()).isNull();
        for (String bad : List.of("https://u:p@mac.example.net", "https://mac.example.net/api", "https://mac.example.net?x=1",
                "https://mac.example.net#f", "ftp://mac.example.net", "https://", "https://mac .example.net", "javascript:alert(1)")) {
            assertThatThrownBy(() -> MacAddress.parse(bad, false)).as(bad).isInstanceOf(MacAddress.Bad.class);
        }
        assertThatThrownBy(() -> MacAddress.parse("http://mac.example.net", false)).isInstanceOfSatisfying(MacAddress.Bad.class,
                b -> assertThat(b.reason()).isEqualTo("https"));
        assertThat(MacAddress.portAllowed(443)).isTrue();
        assertThat(MacAddress.portAllowed(1234)).isTrue();
        for (int low : new int[] {22, 25, 80, 110, 143, 465, 587, 993}) {
            assertThat(MacAddress.portAllowed(low)).as("port " + low).isFalse();
        }
        assertThat(MacAddress.parse("https://mac.example.net:1234", false).toString()).doesNotContain("example");
    }

    @Test
    void theDeskNeverConnectsToItselfItsNetworkOrTheMetadataService() {
        Net strict = Net.strict();
        for (String host : List.of("127.0.0.1", "10.1.2.3", "192.168.0.10", "169.254.169.254", "100.64.0.1", "[::1]", "[fd00:ec2::254]",
                "[::ffff:10.0.0.1]", "0.0.0.0")) {
            assertThatThrownBy(() -> strict.openTcp(host, 1234, MacAddress::portAllowed, Duration.ofSeconds(1))).as(host)
                    .isInstanceOfSatisfying(Net.Refused.class, r -> assertThat(r.reason()).isIn("address", "host"));
        }
        assertThatThrownBy(() -> strict.openTcp("203.0.113.9", 25, MacAddress::portAllowed, Duration.ofSeconds(1)))
                .isInstanceOfSatisfying(Net.Refused.class, r -> assertThat(r.reason()).isEqualTo("port"));
        assertThatThrownBy(() -> strict.openTcp("localhost", 1234, MacAddress::portAllowed, Duration.ofSeconds(1)))
                .isInstanceOf(Net.Refused.class);
    }

    @Test
    void answersAreHeldToTheirLimits() throws Exception {
        // Headers that never end: too many, or too long.
        String endless = "HTTP/1.1 200 OK\r\n" + "X-Junk: aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\r\n".repeat(3000);
        assertThatThrownBy(() -> MacLink.readResponse(new ByteArrayInputStream(endless.getBytes(StandardCharsets.ISO_8859_1)), 1024))
                .isInstanceOf(MacLink.Protocol.class).hasMessage("headers");
        String longOne = "HTTP/1.1 200 OK\r\nX-Junk: " + "a".repeat(70 * 1024) + "\r\n\r\n";
        assertThatThrownBy(() -> MacLink.readResponse(stream(longOne), 1024)).isInstanceOf(MacLink.TooLarge.class);
        // A Content-Length past the limit is refused before reading.
        assertThatThrownBy(() -> MacLink.readResponse(stream("HTTP/1.1 200 OK\r\nContent-Length: 999999999999\r\n\r\n"), 1024))
                .isInstanceOf(MacLink.TooLarge.class);
        // Chunks that add up past it.
        StringBuilder chunked = new StringBuilder("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n");
        for (int i = 0; i < 10; i++) {
            chunked.append("200\r\n").append("x".repeat(512)).append("\r\n");
        }
        assertThatThrownBy(() -> MacLink.readResponse(stream(chunked.toString()), 1024)).isInstanceOf(MacLink.TooLarge.class);
        // No compression, no other transfer coding, a body until close only within the limit.
        assertThatThrownBy(() -> MacLink.readResponse(stream("HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\nContent-Length: 1\r\n\r\nx"), 1024))
                .isInstanceOf(MacLink.Protocol.class);
        assertThatThrownBy(() -> MacLink.readResponse(stream("HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip, chunked\r\n\r\n"), 1024))
                .isInstanceOf(MacLink.Protocol.class);
        assertThatThrownBy(() -> MacLink.readResponse(stream("HTTP/1.1 200 OK\r\n\r\n" + "y".repeat(2000)), 1024))
                .isInstanceOf(MacLink.TooLarge.class);
        assertThatThrownBy(() -> MacLink.readResponse(stream("SSH-2.0-OpenSSH\r\n\r\n"), 1024)).isInstanceOf(MacLink.Protocol.class);
        MacLink.Response ok = MacLink.readResponse(stream("HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}"), 1024);
        assertThat(ok.status()).isEqualTo(200);
        assertThat(new String(ok.body(), StandardCharsets.UTF_8)).isEqualTo("{}");
    }

    private static InputStream stream(String s) {
        return new ByteArrayInputStream(s.getBytes(StandardCharsets.ISO_8859_1));
    }

    @Test
    void aServerThatDripsBytesIsCutOffAtTheExchangesBound() throws Exception {
        try (Evil evil = new Evil(s -> {
            write(s, "HTTP/1.1 200 OK\r\n");
            for (int i = 0; i < 100; i++) {
                write(s, "X-Slow: " + i + "\r\n");
                try {
                    Thread.sleep(500);
                } catch (InterruptedException e) {
                    return;
                }
            }
        })) {
            long t0 = System.nanoTime();
            assertThatThrownBy(() -> new BlueBubbles(link(), evil.address(), null).info("pw".getBytes(StandardCharsets.UTF_8)))
                    .isInstanceOf(IOException.class);
            assertThat(Duration.ofNanos(System.nanoTime() - t0)).isLessThan(Duration.ofSeconds(8));
        }
    }

    @Test
    void aRedirectIsNeverFollowedAndAWrongPasswordIsUnauthorized() throws Exception {
        try (Evil evil = new Evil(s -> write(s, "HTTP/1.1 302 Found\r\nLocation: http://169.254.169.254/latest/meta-data/\r\nContent-Length: 0\r\n\r\n"))) {
            assertThatThrownBy(() -> new BlueBubbles(link(), evil.address(), null).info("pw".getBytes(StandardCharsets.UTF_8)))
                    .isInstanceOfSatisfying(BlueBubbles.Failed.class, f -> assertThat(f.status()).isEqualTo(302));
        }
        try (Evil evil = new Evil(s -> write(s, "HTTP/1.1 401 Unauthorized\r\nContent-Length: 2\r\n\r\n{}"))) {
            assertThatThrownBy(() -> new BlueBubbles(link(), evil.address(), null).info("pw".getBytes(StandardCharsets.UTF_8)))
                    .isInstanceOf(BlueBubbles.Unauthorized.class);
        }
    }

    @Test
    void thePasswordGoesAsTheGuidParameterEncodedAndIsNotMadeAPath() throws Exception {
        try (Evil evil = new Evil(s -> write(s, "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}"))) {
            byte[] pw = "p&w=d /?#x".getBytes(StandardCharsets.UTF_8);
            new BlueBubbles(link(), evil.address(), null).message(pw, "../../server/info");
            // A guid that isn't one never reaches the wire.
            assertThat(evil.lastRequest).isNull();
            assertThatThrownBy(() -> new BlueBubbles(link(), evil.address(), null).info(pw)).isInstanceOf(MacLink.Protocol.class);
            assertThat(evil.lastRequest).startsWith("GET /api/v1/server/info?guid=p%26w%3Dd%20%2F%3F%23x HTTP/1.1\r\n");
            assertThat(new String(pw, StandardCharsets.UTF_8)).isEqualTo("p&w=d /?#x");
        }
    }

    @Test
    void aJsonBombOrADeepNestIsRefusedNotParsedForever() throws Exception {
        String deep = "{\"data\":" + "[".repeat(200) + "]".repeat(200) + "}";
        try (Evil evil = new Evil(s -> write(s, "HTTP/1.1 200 OK\r\nContent-Length: " + deep.length() + "\r\n\r\n" + deep))) {
            assertThatThrownBy(() -> new BlueBubbles(link(), evil.address(), null).info("pw".getBytes(StandardCharsets.UTF_8)))
                    .isInstanceOf(MacLink.Protocol.class);
        }
        String big = "{\"data\":\"" + "z".repeat(70 * 1024) + "\"}";
        try (Evil evil = new Evil(s -> write(s, "HTTP/1.1 200 OK\r\nContent-Length: " + big.length() + "\r\n\r\n" + big))) {
            assertThatThrownBy(() -> new BlueBubbles(link(), evil.address(), null).info("pw".getBytes(StandardCharsets.UTF_8)))
                    .isInstanceOf(MacLink.TooLarge.class);
        }
    }

    @Test
    void theSocketRefusesAFalseUpgradeAndOversizedFrames() throws Exception {
        try (Evil evil = new Evil(s -> write(s, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                + "Sec-WebSocket-Accept: bm90IHRoZSByaWdodCBrZXk=\r\n\r\n"))) {
            assertThatThrownBy(() -> MacSocket.connect(link(), evil.address(), null, "pw".getBytes(StandardCharsets.UTF_8), Duration.ofSeconds(3)))
                    .isInstanceOf(MacLink.Protocol.class);
        }
        try (Evil evil = new Evil((s, head) -> {
            String key = head.lines().filter(l -> l.startsWith("Sec-WebSocket-Key:")).map(l -> l.substring(18).strip()).findFirst().orElse("");
            write(s, "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: "
                    + MacSocket.acceptFor(key) + "\r\n\r\n");
            try {
                OutputStream out = s.getOutputStream();
                // A text frame claiming 2^40 bytes.
                out.write(new byte[] {(byte) 0x81, 127, 0, 0, 1, 0, 0, 0, 0, 0});
                out.flush();
                Thread.sleep(500);
            } catch (IOException | InterruptedException ignored) {
                // done
            }
        })) {
            assertThatThrownBy(() -> MacSocket.connect(link(), evil.address(), null, "pw".getBytes(StandardCharsets.UTF_8), Duration.ofSeconds(3)))
                    .isInstanceOf(MacLink.TooLarge.class);
        }
    }

}
