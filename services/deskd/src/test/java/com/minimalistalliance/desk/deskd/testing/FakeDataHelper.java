package com.minimalistalliance.desk.deskd.testing;

import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.JsonFormatException;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.ServerSocketChannel;
import java.nio.channels.SocketChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Stands in for desk-data on a real Unix socket, speaking the Appendix of task 32's draft ADR byte for byte: one JSON
 * request line per connection, a JSON reply line, and for a read the body in u32be-length chunks, a u32be 0 and the
 * trailer, SHA-256 of the whole file and its u64be size. Files live in memory, per part. It counts the connections it
 * has open, so a test can see deskd close one, and it can refuse, cut a body short, or answer with a line of its own.
 */
public final class FakeDataHelper implements AutoCloseable {

    private final Path socket;
    private final ServerSocketChannel server;
    private final Map<String, TreeMap<String, byte[]>> parts = new ConcurrentHashMap<>();
    private final Map<String, String> labels = new ConcurrentHashMap<>();
    private final Map<String, String> refusals = new ConcurrentHashMap<>();
    private final List<Map<String, Object>> requests = new CopyOnWriteArrayList<>();
    private final AtomicInteger open = new AtomicInteger();
    private final AtomicInteger accepted = new AtomicInteger();
    private volatile int chunkBytes = 65_536;
    private volatile long cutAfter = -1;
    private volatile String rawManifestEntryPadding = "";
    private volatile boolean closed;

    public FakeDataHelper(Path socket) throws IOException {
        this.socket = socket;
        Files.deleteIfExists(socket);
        server = ServerSocketChannel.open(StandardProtocolFamily.UNIX);
        server.bind(UnixDomainSocketAddress.of(socket));
        Thread.ofVirtual().name("fake-data-accept").start(this::acceptLoop);
    }

    public void part(String part, String label) {
        parts.computeIfAbsent(part, p -> new TreeMap<>(FakeDataHelper::byBytes));
        labels.put(part, label);
    }

    public void file(String part, String path, byte[] bytes) {
        parts.computeIfAbsent(part, p -> new TreeMap<>(FakeDataHelper::byBytes)).put(path, bytes);
    }

    /** From now on, this op gets {@code ok: false} with this code. Null to answer again. */
    public void refuse(String op, String code) {
        if (code == null) {
            refusals.remove(op);
        } else {
            refusals.put(op, code);
        }
    }

    /** The size of a read's chunks, at most 65,536 as the Appendix says. */
    public void chunkBytes(int bytes) {
        chunkBytes = bytes;
    }

    /** A read's body stops after this many bytes and the connection drops, as a helper that died would. -1 for never. */
    public void cutAfter(long bytes) {
        cutAfter = bytes;
    }

    /** Characters added to each manifest entry's JSON, so a page can be made as large as a test needs. */
    public void padManifestEntries(int chars) {
        rawManifestEntryPadding = "x".repeat(chars);
    }

    /** Every request, parsed, in the order they came. */
    public List<Map<String, Object>> requests() {
        return List.copyOf(requests);
    }

    /** Connections taken and not yet over, from either side. */
    public int openConnections() {
        return open.get();
    }

    public int connectionsAccepted() {
        return accepted.get();
    }

    public static byte[] trailer(byte[] file) {
        try {
            byte[] hash = MessageDigest.getInstance("SHA-256").digest(file);
            return ByteBuffer.allocate(40).put(hash).putLong(file.length).array();
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    @Override
    public void close() throws IOException {
        closed = true;
        server.close();
        Files.deleteIfExists(socket);
    }

    private static int byBytes(String a, String b) {
        return Arrays.compareUnsigned(a.getBytes(StandardCharsets.UTF_8), b.getBytes(StandardCharsets.UTF_8));
    }

    private void acceptLoop() {
        while (!closed) {
            try {
                SocketChannel client = server.accept();
                accepted.incrementAndGet();
                open.incrementAndGet();
                Thread.ofVirtual().name("fake-data-conn").start(() -> serve(client));
            } catch (IOException e) {
                return;
            }
        }
    }

    private void serve(SocketChannel client) {
        try (client) {
            byte[] line = readLine(client);
            if (line == null) {
                return;
            }
            Map<String, Object> request;
            try {
                request = Json.parseObject(line);
            } catch (JsonFormatException e) {
                refuseWith(client, "bad_request");
                return;
            }
            requests.add(request);
            String op = Json.string(request, "op");
            String refusal = op == null ? null : refusals.get(op);
            if (!Integer.valueOf(1).equals(request.get("v")) || op == null) {
                refuseWith(client, "bad_request");
            } else if (refusal != null) {
                refuseWith(client, refusal);
            } else {
                switch (op) {
                    case "parts" -> parts(client);
                    case "manifest" -> manifest(client, request);
                    case "read" -> read(client, request);
                    default -> refuseWith(client, "bad_request");
                }
            }
        } catch (IOException e) {
            // deskd closed it, as it does to stop a read.
        } finally {
            open.decrementAndGet();
        }
    }

    private static byte[] readLine(SocketChannel client) throws IOException {
        ByteArrayOutputStream line = new ByteArrayOutputStream();
        ByteBuffer one = ByteBuffer.allocate(1);
        while (line.size() <= 16 * 1024) {
            one.clear();
            if (client.read(one) < 0) {
                return null;
            }
            if (one.get(0) == '\n') {
                return line.toByteArray();
            }
            line.write(one.get(0));
        }
        return null;
    }

    private static void refuseWith(SocketChannel client, String code) throws IOException {
        writeLine(client, Map.of("ok", false, "code", code, "message", "refused by the fake"));
    }

    private static void writeLine(SocketChannel client, Map<String, Object> reply) throws IOException {
        writeRaw(client, (new String(Json.bytes(reply), StandardCharsets.UTF_8) + "\n").getBytes(StandardCharsets.UTF_8));
    }

    private static void writeRaw(SocketChannel client, byte[] bytes) throws IOException {
        ByteBuffer out = ByteBuffer.wrap(bytes);
        while (out.hasRemaining()) {
            client.write(out);
        }
    }

    private void parts(SocketChannel client) throws IOException {
        List<Map<String, Object>> list = new ArrayList<>();
        for (Map.Entry<String, TreeMap<String, byte[]>> part : new TreeMap<>(parts).entrySet()) {
            long bytes = part.getValue().values().stream().mapToLong(file -> file.length).sum();
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("part", part.getKey());
            item.put("label", labels.getOrDefault(part.getKey(), part.getKey()));
            item.put("files", part.getValue().size());
            item.put("bytes", bytes);
            list.add(item);
        }
        Map<String, Object> reply = new LinkedHashMap<>();
        reply.put("ok", true);
        reply.put("helperVersion", "fake-1");
        reply.put("parts", list);
        writeLine(client, reply);
    }

    private void manifest(SocketChannel client, Map<String, Object> request) throws IOException {
        TreeMap<String, byte[]> files = parts.get(Json.string(request, "part"));
        if (files == null) {
            refuseWith(client, "not_found");
            return;
        }
        String cursor = Json.string(request, "cursor");
        int limit = ((Number) request.get("limit")).intValue();
        Map<String, byte[]> after = cursor == null ? files : files.tailMap(cursor, false);
        List<Map<String, Object>> entries = new ArrayList<>();
        String last = null;
        for (Map.Entry<String, byte[]> file : after.entrySet()) {
            if (entries.size() == limit) {
                break;
            }
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("path", file.getKey());
            entry.put("type", "file");
            entry.put("size", file.getValue().length);
            entry.put("mtimeMs", 1_762_400_000_000L);
            entry.put("mode", 0600);
            if (!rawManifestEntryPadding.isEmpty()) {
                entry.put("pad", rawManifestEntryPadding);
            }
            entries.add(entry);
            last = file.getKey();
        }
        boolean more = last != null && !files.tailMap(last, false).isEmpty();
        Map<String, Object> reply = new LinkedHashMap<>();
        reply.put("ok", true);
        reply.put("entries", entries);
        reply.put("next", more ? last : null);
        writeLine(client, reply);
    }

    private void read(SocketChannel client, Map<String, Object> request) throws IOException {
        TreeMap<String, byte[]> files = parts.get(Json.string(request, "part"));
        String path = Json.string(request, "path");
        if (path == null || path.startsWith("/") || path.contains("..")) {
            refuseWith(client, "invalid");
            return;
        }
        byte[] file = files == null ? null : files.get(path);
        if (file == null) {
            refuseWith(client, "not_found");
            return;
        }
        long offset = ((Number) request.get("offset")).longValue();
        Map<String, Object> header = new LinkedHashMap<>();
        header.put("ok", true);
        header.put("size", file.length);
        header.put("mtimeMs", 1_762_400_000_000L);
        writeLine(client, header);
        int from = (int) Math.min(offset, file.length);
        long sent = 0;
        while (from < file.length) {
            int length = Math.min(chunkBytes, file.length - from);
            long cut = cutAfter;
            if (cut >= 0 && sent + length > cut) {
                length = (int) (cut - sent);
                writeRaw(client, ByteBuffer.allocate(4 + length).putInt(length).put(file, from, length).array());
                return;
            }
            writeRaw(client, ByteBuffer.allocate(4 + length).putInt(length).put(file, from, length).array());
            from += length;
            sent += length;
        }
        writeRaw(client, ByteBuffer.allocate(4 + 40).putInt(0).put(trailer(file)).array());
    }
}
