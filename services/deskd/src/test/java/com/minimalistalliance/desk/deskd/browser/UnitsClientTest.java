package com.minimalistalliance.desk.deskd.browser;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.deskd.testing.StubUnitsSocket;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.ServerSocketChannel;
import java.nio.channels.SocketChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class UnitsClientTest {

    @TempDir
    Path dir;

    private static String codeOf(Throwable thrown) {
        return ((UnitException) thrown).code();
    }

    @Test
    void sendsOneRequestPerConnectionAndOkReturns() throws Exception {
        Path socket = dir.resolve("units.sock");
        try (StubUnitsSocket stub = new StubUnitsSocket(socket)) {
            UnitsClient client = new UnitsClient(socket);
            client.run(UnitsClient.START, UnitsClient.DESK_BROWSER);
            client.run(UnitsClient.STOP, UnitsClient.DESK_STREAM);
            assertThat(stub.requests()).containsExactly("start desk-browser", "stop desk-stream");
        }
    }

    @Test
    void anErrReplyGivesItsCodeAndKeepsItsTextForTheLog() throws Exception {
        Path socket = dir.resolve("units.sock");
        try (StubUnitsSocket stub = new StubUnitsSocket(socket)) {
            stub.reply("start desk-stream", "err failed start desk-stream: Job failed");
            assertThatThrownBy(() -> new UnitsClient(socket).run(UnitsClient.START, UnitsClient.DESK_STREAM))
                    .isInstanceOfSatisfying(UnitException.class, e -> {
                        assertThat(e.unit()).isEqualTo("desk-stream");
                        assertThat(e.code()).isEqualTo("failed");
                        assertThat(e.text()).isEqualTo("start desk-stream: Job failed");
                    });
            stub.reply("start desk-stream", "err denied");
            assertThatThrownBy(() -> new UnitsClient(socket).run(UnitsClient.START, UnitsClient.DESK_STREAM))
                    .satisfies(e -> assertThat(codeOf(e)).isEqualTo("denied"));
        }
    }

    @Test
    void noSocketIsUnreachableAtOnce() {
        long start = System.nanoTime();
        assertThatThrownBy(() -> new UnitsClient(dir.resolve("absent.sock")).run(UnitsClient.START, UnitsClient.DESK_STREAM))
                .satisfies(e -> assertThat(codeOf(e)).isEqualTo(UnitException.UNREACHABLE));
        assertThat(Duration.ofNanos(System.nanoTime() - start)).isLessThan(Duration.ofSeconds(5));
    }

    @Test
    void aRequestPastItsBudgetEndsInTimeout() throws Exception {
        Path socket = dir.resolve("units.sock");
        try (StubUnitsSocket stub = new StubUnitsSocket(socket)) {
            stub.hold("start desk-stream");
            UnitsClient client = new UnitsClient(socket, Duration.ofMillis(100));
            assertThatThrownBy(() -> client.run(UnitsClient.START, UnitsClient.DESK_STREAM))
                    .satisfies(e -> assertThat(codeOf(e)).isEqualTo(UnitException.TIMEOUT));
            stub.release("start desk-stream");
        }
    }

    @Test
    void aStopOfDeskBrowserGetsItsLongerBudgetAndNoOtherVerbDoes() throws Exception {
        // Budgets scaled down from 45 s and 95 s: a stop answering after 600 ms is "the 60 s stop", past the 300 ms
        // everything else gets and inside the 1500 ms a stop of desk-browser gets.
        Path socket = dir.resolve("units.sock");
        try (StubUnitsSocket stub = new StubUnitsSocket(socket)) {
            UnitsClient client = new UnitsClient(socket, Duration.ofMillis(300), Duration.ofMillis(1500));
            stub.onRequest(request -> {
                try {
                    Thread.sleep(600);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            });
            client.run(UnitsClient.STOP, UnitsClient.DESK_BROWSER);
            for (String[] other : new String[][] {
                {UnitsClient.STOP, UnitsClient.DESK_STREAM},
                {UnitsClient.START, UnitsClient.DESK_BROWSER},
                {UnitsClient.FREEZE, UnitsClient.DESK_BROWSER},
                {UnitsClient.THAW, UnitsClient.DESK_BROWSER}}) {
                assertThatThrownBy(() -> client.run(other[0], other[1]))
                        .satisfies(e -> assertThat(codeOf(e)).isEqualTo(UnitException.TIMEOUT));
            }
        }
    }

    @Test
    void aStopOfDeskBrowserPastItsBudgetStillEndsInTimeout() throws Exception {
        Path socket = dir.resolve("units.sock");
        try (StubUnitsSocket stub = new StubUnitsSocket(socket)) {
            stub.hold("stop desk-browser");
            UnitsClient client = new UnitsClient(socket, Duration.ofMillis(100), Duration.ofMillis(400));
            assertThatThrownBy(() -> client.run(UnitsClient.STOP, UnitsClient.DESK_BROWSER))
                    .satisfies(e -> assertThat(codeOf(e)).isEqualTo(UnitException.TIMEOUT));
            stub.release("stop desk-browser");
        }
    }

    @Test
    void theDefaultBudgetsAre45sAnd95sForAStopOfDeskBrowser() {
        assertThat(UnitsClient.TIMEOUT).isEqualTo(Duration.ofSeconds(45));
        assertThat(UnitsClient.STOP_BROWSER_TIMEOUT).isEqualTo(Duration.ofSeconds(95));
    }

    @Test
    void anInterruptEndsTheWait() throws Exception {
        Path socket = dir.resolve("units.sock");
        try (StubUnitsSocket stub = new StubUnitsSocket(socket)) {
            stub.hold("start desk-stream");
            UnitsClient client = new UnitsClient(socket);
            Throwable[] thrown = new Throwable[1];
            Thread thread = Thread.ofVirtual().start(() -> {
                try {
                    client.run(UnitsClient.START, UnitsClient.DESK_STREAM);
                } catch (Exception e) {
                    thrown[0] = e;
                }
            });
            stub.awaitHeld("start desk-stream");
            thread.interrupt();
            thread.join(Duration.ofSeconds(5));
            assertThat(thrown[0]).isInstanceOf(InterruptedException.class);
            stub.release("start desk-stream");
        }
    }

    @Test
    void repliesThatArentTheProtocolAreBadReplies() throws Exception {
        for (String reply : new String[] {"", "okay\n", "err \n", "err BAD CODE\n", "ok", "x".repeat(5000)}) {
            Path socket = dir.resolve("raw-" + reply.hashCode() + ".sock");
            try (ServerSocketChannel server = ServerSocketChannel.open(StandardProtocolFamily.UNIX)) {
                server.bind(UnixDomainSocketAddress.of(socket));
                Thread.ofVirtual().start(() -> {
                    try (SocketChannel client = server.accept()) {
                        client.read(ByteBuffer.allocate(128));
                        client.write(ByteBuffer.wrap(reply.getBytes(StandardCharsets.US_ASCII)));
                    } catch (Exception e) {
                        // The client may have gone: it's only reading so much.
                    }
                });
                assertThatThrownBy(() -> new UnitsClient(socket).run(UnitsClient.START, UnitsClient.DESK_STREAM))
                        .as("reply %s", reply.length() > 20 ? reply.length() + " chars" : reply)
                        .satisfies(e -> assertThat(codeOf(e)).isEqualTo(UnitException.BAD_REPLY));
            }
        }
    }

    @Test
    void aControlCharacterInTheTextCantReachTheLog() throws Exception {
        Path socket = dir.resolve("units.sock");
        try (ServerSocketChannel server = ServerSocketChannel.open(StandardProtocolFamily.UNIX)) {
            server.bind(UnixDomainSocketAddress.of(socket));
            Thread.ofVirtual().start(() -> {
                try (SocketChannel client = server.accept()) {
                    client.read(ByteBuffer.allocate(128));
                    client.write(ByteBuffer.wrap("err failed a\u0007b\n".getBytes(StandardCharsets.UTF_8)));
                } catch (Exception e) {
                    // Not what's being tested.
                }
            });
            assertThatThrownBy(() -> new UnitsClient(socket).run(UnitsClient.START, UnitsClient.DESK_STREAM))
                    .isInstanceOfSatisfying(UnitException.class, e -> assertThat(e.text()).isEqualTo("a?b"));
        }
    }
}
