package com.minimalistalliance.desk.deskd.courier.linked;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.courier.testkit.FakeTls;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.function.IntFunction;
import org.junit.jupiter.api.Test;

/**
 * A provider that answers inside every byte limit with lines that would cost far more on deskd's heap than on the wire
 * (Security's CI-M1b): the client keeps what a command may keep, and the connection goes past it.
 */
class HostileServerTest {

    /** A TLS IMAP server on loopback that greets, then answers every command with {@code lines} untagged lines and OK. */
    private static final class Server implements AutoCloseable {
        final ServerSocket socket;
        final Thread thread;

        Server(int lines, IntFunction<String> line) throws Exception {
            socket = FakeTls.serverContext().getServerSocketFactory().createServerSocket(0, 1, InetAddress.getLoopbackAddress());
            thread = Thread.ofVirtual().start(() -> {
                try (Socket s = socket.accept()) {
                    OutputStream out = s.getOutputStream();
                    BufferedReader in = new BufferedReader(new InputStreamReader(s.getInputStream(), StandardCharsets.US_ASCII));
                    out.write("* OK [CAPABILITY IMAP4rev1] ready\r\n".getBytes(StandardCharsets.US_ASCII));
                    out.flush();
                    String cmd;
                    while ((cmd = in.readLine()) != null) {
                        String tag = cmd.substring(0, cmd.indexOf(' '));
                        StringBuilder b = new StringBuilder();
                        for (int i = 1; i <= lines; i++) {
                            b.append(line.apply(i));
                            if (b.length() > 1 << 16) {
                                out.write(b.toString().getBytes(StandardCharsets.US_ASCII));
                                b.setLength(0);
                            }
                        }
                        b.append(tag).append(" OK done\r\n");
                        out.write(b.toString().getBytes(StandardCharsets.US_ASCII));
                        out.flush();
                    }
                } catch (Exception e) {
                    // the client went: the test is over
                }
            });
        }

        int port() {
            return socket.getLocalPort();
        }

        @Override
        public void close() throws Exception {
            socket.close();
            thread.join(5_000);
        }
    }

    private static ImapClient connect(Server s) throws Exception {
        return ImapClient.open(Net.forTests(FakeTls.clientContext()), "127.0.0.1", s.port(),
                new ImapClient.Settings(Duration.ofSeconds(20), 1024 * 1024, 64 * 1024 * 1024));
    }

    @Test
    void thirtyThousandFetchesOfTwoHundredFlagsEndTheConnectionWithinWhatACommandMayKeep() throws Exception {
        String flags = "x ".repeat(199) + "x";
        try (Server s = new Server(30_000, i -> "* " + i + " FETCH (UID " + i + " FLAGS (" + flags + "))\r\n");
                ImapClient c = connect(s)) {
            List<ImapClient.FetchData> kept = new ArrayList<>();
            assertThatThrownBy(() -> c.fetch("1:*", "UID FLAGS", null, 64L * 1024 * 1024, kept::add))
                    .isInstanceOf(ImapException.TooLarge.class);
            // Each keeps 32 flags at most, and all of them together stay inside the command's 16 MiB estimate.
            assertThat(kept).isNotEmpty().allSatisfy(f -> assertThat(f.flags()).hasSizeLessThanOrEqualTo(ImapClient.MAX_FLAGS));
            assertThat(kept.stream().mapToLong(ImapClient::kept).sum()).isLessThanOrEqualTo(ImapReader.MAX_KEPT_BYTES);
            assertThat(kept.size()).isLessThan(10_000);
        }
    }

    @Test
    void anOrdinaryBigAnswerIsKeptWhole() throws Exception {
        try (Server s = new Server(20_000, i -> "* " + i + " FETCH (UID " + i + " FLAGS (\\Seen) MODSEQ (" + (1000 + i) + "))\r\n");
                ImapClient c = connect(s)) {
            List<ImapClient.FetchData> kept = new ArrayList<>();
            c.fetch("1:*", "UID FLAGS", null, 64L * 1024 * 1024, kept::add);
            assertThat(kept).hasSize(20_000);
            // The common flag is one string for every message.
            assertThat(kept.get(0).flags().get(0)).isSameAs(kept.get(19_999).flags().get(0));
        }
    }
}
