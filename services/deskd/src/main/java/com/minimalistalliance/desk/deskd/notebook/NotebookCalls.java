package com.minimalistalliance.desk.deskd.notebook;

import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.JsonFormatException;
import com.minimalistalliance.desk.deskd.rpc.Caller;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import java.io.IOException;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.SocketChannel;
import java.nio.file.Path;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Supplier;

/**
 * deskd's own calls to desk-notebook, as a caller deskd names: the Agent's Notebook tools ({@code tools.NotebookTools}),
 * which run as the agent's owner, or on a guild desk as the member whose agent it is (draft ADR "the Agent's tools and
 * approvals", section 8). desk-notebook checks each one as it checks that member's own session: the same grants, the
 * same edit budget, the same rules for a page in the Trash.
 *
 * <p><b>Narrower than a session's link</b> ({@link NotebookLink}): one short connection per call, whose hello carries
 * the caller deskd names and, on a guild desk, the edit budget in force, as a session's hello does; then one {@code req},
 * its answer, and the connection closes. No {@code collab}, no subscription, and only {@link #METHODS}. No client reaches
 * any of it: the client relay ({@link NotebookMethods}) lists none of the agent methods, and this has no session.
 *
 * <p>Each call waits at most {@code wait} for its answer, on a virtual thread of its own that does the socket's I/O, so
 * an interrupt of the caller only closes the channel. Nothing here logs a param, a result or an error's details.
 */
public final class NotebookCalls {

    /** What deskd's own calls may ask desk-notebook: a search, a page as Markdown, an agent's edit, a page to the Trash. */
    public static final Set<String> METHODS = Set.of(
            "notebook.search", "notebook.page.markdown", "notebook.page.agentEdit", "notebook.page.trash");

    private final Path socket;
    private final Supplier<Map<String, Object>> settings;
    private final Duration wait;
    private final AtomicLong sessions = new AtomicLong();

    /**
     * @param socket desk-notebook's socket, or null on a desk without one
     * @param settings what a hello carries as {@code settings} ({@code {editBudget}} on a guild desk), or null for none
     * @param wait how long a call waits for its answer
     */
    public NotebookCalls(Path socket, Supplier<Map<String, Object>> settings, Duration wait) {
        this.socket = socket;
        this.settings = settings == null ? () -> null : settings;
        this.wait = Objects.requireNonNull(wait);
    }

    /** Whether this desk has desk-notebook at all. Whether it's up now is something only a call finds out. */
    public boolean configured() {
        return socket != null;
    }

    /**
     * One call, as {@code caller}.
     *
     * @param mutation whether it changes something: one whose bytes went out and that got no answer may have happened
     * @return desk-notebook's {@code r}, or an empty map if it sent none
     * @throws RpcException desk-notebook's {@code err}, as a session's link relays one; or {@code unavailable} with
     *     {@code reason: notebook} when it isn't there or doesn't answer in time, with {@code mayHaveApplied: true} for a
     *     mutation that went out
     * @throws IllegalArgumentException for a method not in {@link #METHODS}
     */
    public Object call(Caller caller, String method, Map<String, Object> params, boolean mutation)
            throws RpcException, InterruptedException {
        if (!METHODS.contains(method)) {
            throw new IllegalArgumentException("not one of deskd's own Notebook calls");
        }
        Objects.requireNonNull(caller, "caller");
        if (socket == null) {
            throw NotebookLink.unavailable();
        }
        SocketChannel channel;
        try {
            channel = SocketChannel.open(StandardProtocolFamily.UNIX);
        } catch (IOException e) {
            throw NotebookLink.unavailable();
        }
        byte[] hello = Json.bytes(hello(caller));
        Map<String, Object> req = new LinkedHashMap<>();
        req.put("t", "req");
        req.put("id", 1);
        req.put("m", method);
        req.put("p", params);
        byte[] request = Json.bytes(req);
        AtomicReference<Map<String, Object>> reply = new AtomicReference<>();
        AtomicBoolean sent = new AtomicBoolean();
        try (channel) {
            Thread io = Thread.ofVirtual().name("notebook-call").start(() -> reply.set(exchange(channel, hello, request, sent)));
            try {
                if (!io.join(wait)) {
                    closeQuietly(channel);
                    io.join(wait);
                }
            } catch (InterruptedException e) {
                closeQuietly(channel);
                throw e;
            }
        } catch (IOException e) {
            // Closing; the answer, if any, is in already.
        }
        Map<String, Object> answer = reply.get();
        if (answer == null) {
            throw mutation && sent.get() ? mayHaveApplied() : NotebookLink.unavailable();
        }
        if ("res".equals(answer.get("t"))) {
            return answer.get("r") == null ? Map.of() : answer.get("r");
        }
        throw NotebookLink.relayed(answer);
    }

    /** The first frame, as a session's link sends it: who, and the settings desk-notebook checks this caller with. */
    private Map<String, Object> hello(Caller caller) {
        Map<String, Object> hello = new LinkedHashMap<>();
        hello.put("t", "hello");
        hello.put("sessionId", "deskd-tools-" + sessions.incrementAndGet());
        hello.put("sub", caller.isGuildMember() ? caller.memberId() : Caller.OWNER);
        hello.put("caller", caller.toJson());
        Map<String, Object> now = settings.get();
        if (now != null) {
            hello.put("settings", now);
        }
        return hello;
    }

    /** On its own thread: the hello and the request, then frames until this call's answer. Null if none came. */
    private Map<String, Object> exchange(SocketChannel channel, byte[] hello, byte[] request, AtomicBoolean sent) {
        try {
            channel.connect(UnixDomainSocketAddress.of(socket));
            write(channel, hello);
            // From here the request may have reached desk-notebook, whatever happens next.
            sent.set(true);
            write(channel, request);
            ByteBuffer header = ByteBuffer.allocate(5);
            while (true) {
                header.clear();
                if (!fill(channel, header)) {
                    return null;
                }
                int length = header.getInt(0);
                byte type = header.get(4);
                if (length < 1 || length > NotebookLink.MAX_FRAME) {
                    return null;
                }
                int size = length - 1;
                if (type != NotebookLink.JSON) {
                    // Nothing here asks for collab, so nothing should come: it's read past and dropped.
                    skip(channel, size);
                    continue;
                }
                if (size > NotebookLink.MAX_JSON) {
                    return null;
                }
                ByteBuffer body = ByteBuffer.allocate(size);
                if (!fill(channel, body)) {
                    return null;
                }
                Map<String, Object> message = Json.parseObject(body.array());
                Object t = message.get("t");
                if (("res".equals(t) || "err".equals(t)) && message.get("id") instanceof Number id && id.longValue() == 1) {
                    return message;
                }
            }
        } catch (IOException | JsonFormatException | RuntimeException e) {
            return null;
        }
    }

    private static void write(SocketChannel channel, byte[] body) throws IOException {
        ByteBuffer frame = ByteBuffer.allocate(5 + body.length);
        frame.putInt(1 + body.length).put(NotebookLink.JSON).put(body).flip();
        while (frame.hasRemaining()) {
            channel.write(frame);
        }
    }

    private static void skip(SocketChannel channel, int size) throws IOException {
        ByteBuffer scratch = ByteBuffer.allocate(Math.min(size, 64 << 10));
        int left = size;
        while (left > 0) {
            scratch.clear().limit(Math.min(left, scratch.capacity()));
            if (!fill(channel, scratch)) {
                throw new IOException("closed in a frame");
            }
            left -= scratch.limit();
        }
    }

    private static boolean fill(SocketChannel channel, ByteBuffer buffer) throws IOException {
        while (buffer.hasRemaining()) {
            if (channel.read(buffer) < 0) {
                return false;
            }
        }
        return true;
    }

    private static RpcException mayHaveApplied() {
        return new RpcException(RpcException.UNAVAILABLE, "desk-notebook didn't answer",
                Map.of("reason", "notebook", "mayHaveApplied", true));
    }

    private static void closeQuietly(SocketChannel channel) {
        try {
            channel.close();
        } catch (IOException e) {
            // Closing.
        }
    }
}
