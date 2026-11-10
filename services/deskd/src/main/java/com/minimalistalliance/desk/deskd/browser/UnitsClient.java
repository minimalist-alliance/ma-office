package com.minimalistalliance.desk.deskd.browser;

import java.io.IOException;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.ClosedByInterruptException;
import java.nio.channels.SocketChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * deskd's side of /run/desk/units.sock (desk-runtime.md 8.3): one request per connection, and the reply
 * comes when systemd's job is done. So a call can take most of a minute, and it belongs on a thread that
 * nothing else waits for. {@link BrowserStream} has one.
 */
public final class UnitsClient {

    public static final String START = "start";
    public static final String STOP = "stop";
    /** Freezes desk-browser's cgroup, every process at once (ADR 0045). An image before ADR 0045 answers bad_request. */
    public static final String FREEZE = "freeze";
    /** Thaws it. A unit that isn't frozen, running or not, answers ok. */
    public static final String THAW = "thaw";
    public static final String DESK_BROWSER = "desk-browser";
    public static final String DESK_STREAM = "desk-stream";

    /**
     * desk-units allows systemctl 34 s, since desk-browser stops gracefully, and before a start of desk-browser it allows
     * the profile's check another 10 s. So 44 s, and a second to spare.
     */
    public static final Duration TIMEOUT = Duration.ofSeconds(45);
    /**
     * A stop of desk-browser first runs a quit from desk-browser-thaw (up to about 80 s when Chromium doesn't answer: 50 for
     * the quit, then 30 for SIGTERM), and desk-units waits 90 s for it (ADR 0045). So 95 s. Only this verb and unit; every
     * other request keeps {@link #TIMEOUT}.
     */
    public static final Duration STOP_BROWSER_TIMEOUT = Duration.ofSeconds(95);

    static final int MAX_REQUEST_BYTES = 64;
    /** desk-units cuts its text at 200 chars. Anything much longer isn't desk-units. */
    private static final int MAX_REPLY_BYTES = 1024;
    private static final int MAX_TEXT_CHARS = 200;

    private final Path socket;
    private final Duration timeout;
    private final Duration stopBrowserTimeout;

    public UnitsClient(Path socket) {
        this(socket, TIMEOUT, STOP_BROWSER_TIMEOUT);
    }

    UnitsClient(Path socket, Duration timeout) {
        this(socket, timeout, STOP_BROWSER_TIMEOUT);
    }

    UnitsClient(Path socket, Duration timeout, Duration stopBrowserTimeout) {
        this.socket = socket;
        this.timeout = timeout;
        this.stopBrowserTimeout = stopBrowserTimeout;
    }

    /**
     * Sends one request and parks until the reply or the timeout.
     *
     * @throws UnitException if the unit control refused it, failed, or couldn't be reached
     */
    public void run(String verb, String unit) throws UnitException, InterruptedException {
        byte[] request = (verb + " " + unit + "\n").getBytes(StandardCharsets.US_ASCII);
        if (request.length > MAX_REQUEST_BYTES) {
            throw new IllegalArgumentException("unit request over 64 bytes");
        }
        SocketChannel channel;
        try {
            channel = SocketChannel.open(StandardProtocolFamily.UNIX);
        } catch (IOException e) {
            throw new UnitException(unit, UnitException.UNREACHABLE, null);
        }
        Duration wait = STOP.equals(verb) && DESK_BROWSER.equals(unit) ? stopBrowserTimeout : timeout;
        AtomicBoolean timedOut = new AtomicBoolean();
        // Closing the channel is what ends a read or a connect that's taking too long.
        Thread watchdog = Thread.ofVirtual().name("units-timeout").start(() -> {
            try {
                Thread.sleep(wait);
                timedOut.set(true);
                closeQuietly(channel);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        });
        try (channel) {
            try {
                channel.connect(UnixDomainSocketAddress.of(socket));
            } catch (ClosedByInterruptException e) {
                throw e;
            } catch (IOException | RuntimeException e) {
                throw new UnitException(unit, timedOut.get() ? UnitException.TIMEOUT : UnitException.UNREACHABLE, null);
            }
            ByteBuffer out = ByteBuffer.wrap(request);
            while (out.hasRemaining()) {
                channel.write(out);
            }
            parseReply(unit, readReply(channel));
        } catch (ClosedByInterruptException e) {
            Thread.interrupted();
            throw new InterruptedException();
        } catch (IOException e) {
            throw new UnitException(unit, timedOut.get() ? UnitException.TIMEOUT : UnitException.BAD_REPLY, null);
        } finally {
            watchdog.interrupt();
        }
    }

    /** @return the bytes up to the first newline, or null if the reply never had one */
    private static String readReply(SocketChannel channel) throws IOException {
        ByteBuffer in = ByteBuffer.allocate(MAX_REPLY_BYTES);
        while (in.hasRemaining()) {
            if (channel.read(in) < 0) {
                break;
            }
            String sofar = new String(in.array(), 0, in.position(), StandardCharsets.UTF_8);
            int newline = sofar.indexOf('\n');
            if (newline >= 0) {
                return sofar.substring(0, newline);
            }
        }
        return null;
    }

    private static void parseReply(String unit, String reply) throws UnitException {
        if ("ok".equals(reply)) {
            return;
        }
        if (reply == null || !reply.startsWith("err ")) {
            throw new UnitException(unit, UnitException.BAD_REPLY, null);
        }
        String rest = reply.substring(4);
        int space = rest.indexOf(' ');
        String code = space < 0 ? rest : rest.substring(0, space);
        if (!code.matches("[a-z_]{1,32}")) {
            throw new UnitException(unit, UnitException.BAD_REPLY, null);
        }
        throw new UnitException(unit, code, space < 0 ? "" : printable(rest.substring(space + 1)));
    }

    private static String printable(String text) {
        String cleaned = text.replaceAll("[^\\x20-\\x7e]", "?");
        return cleaned.length() > MAX_TEXT_CHARS ? cleaned.substring(0, MAX_TEXT_CHARS) : cleaned;
    }

    private static void closeQuietly(SocketChannel channel) {
        try {
            channel.close();
        } catch (IOException e) {
            // It's being abandoned.
        }
    }
}
