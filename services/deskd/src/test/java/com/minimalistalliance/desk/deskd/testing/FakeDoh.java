package com.minimalistalliance.desk.deskd.testing;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * Stands in for the family resolver's DoH endpoint on loopback: RFC 8484 POSTs of the wire format, answered as the real one
 * answered on 2026-11-07, {@code 0.0.0.0} and {@code ::} for a filtered name. A test says what each name gets, and can make
 * it hang, fail or send too much.
 */
public final class FakeDoh implements AutoCloseable {

    /** One question it was asked, with the headers it came with. */
    public record Question(String name, int type, String contentType, String accept, String method, int bytes) {}

    public static final int A = 1;
    public static final int AAAA = 28;
    public static final int CNAME = 5;

    /** One record of an answer. */
    public record Record(int type, byte[] data) {
        public static Record a(int... octets) {
            byte[] data = new byte[4];
            for (int i = 0; i < 4; i++) {
                data[i] = (byte) octets[i];
            }
            return new Record(A, data);
        }

        public static Record aaaa(boolean unspecified) {
            byte[] data = new byte[16];
            if (!unspecified) {
                data[0] = 0x26;
                data[15] = 1;
            }
            return new Record(AAAA, data);
        }

        /** A CNAME to a name under the same zone, written out in full. */
        public static Record cname(String target) {
            return new Record(CNAME, labels(target));
        }
    }

    /** What every name not given otherwise gets: no record, as a name with no address of that type would. */
    private static final List<Record> NOTHING = List.of();

    private final HttpServer server;
    private final List<Question> questions = new CopyOnWriteArrayList<>();
    private final Map<String, List<Record>> answersA = new ConcurrentHashMap<>();
    private final Map<String, List<Record>> answersAaaa = new ConcurrentHashMap<>();
    private volatile int status = 200;
    private volatile int rcode;
    private volatile int oversize;
    private volatile CountDownLatch hold;

    public FakeDoh() throws IOException {
        server = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
        server.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
        server.createContext("/dns-query", this::serve);
        server.start();
    }

    public URI endpoint() {
        return URI.create("http://127.0.0.1:" + server.getAddress().getPort() + "/dns-query");
    }

    /** As the resolver answers a name it filters: {@code 0.0.0.0} and {@code ::}. */
    public void filter(String name) {
        answer(name, List.of(Record.a(0, 0, 0, 0)), List.of(Record.aaaa(true)));
    }

    /** As it answers a name it lets through. */
    public void allow(String name) {
        answer(name, List.of(Record.a(93, 184, 215, 14)), List.of(Record.aaaa(false)));
    }

    public void answer(String name, List<Record> a, List<Record> aaaa) {
        answersA.put(name, a);
        answersAaaa.put(name, aaaa);
    }

    /** Answers with this status and no body from now on. */
    public void status(int code) {
        status = code;
    }

    /** Answers with this rcode, and no records, from now on. */
    public void rcode(int code) {
        rcode = code;
    }

    /** Sends this many bytes of nothing after the message from now on. */
    public void oversize(int bytes) {
        oversize = bytes;
    }

    /** Questions wait until {@link #release}, or for a minute. */
    public void hold() {
        hold = new CountDownLatch(1);
    }

    public void release() {
        CountDownLatch held = hold;
        hold = null;
        if (held != null) {
            held.countDown();
        }
    }

    public List<Question> questions() {
        return List.copyOf(questions);
    }

    @Override
    public void close() {
        release();
        server.stop(0);
    }

    private void serve(HttpExchange exchange) throws IOException {
        try (exchange) {
            byte[] query = exchange.getRequestBody().readAllBytes();
            int nameEnd = nameEnd(query, 12);
            String name = name(query, 12);
            int type = ((query[nameEnd] & 0xFF) << 8) | (query[nameEnd + 1] & 0xFF);
            questions.add(new Question(
                    name,
                    type,
                    exchange.getRequestHeaders().getFirst("Content-Type"),
                    exchange.getRequestHeaders().getFirst("Accept"),
                    exchange.getRequestMethod(),
                    query.length));
            CountDownLatch held = hold;
            if (held != null) {
                try {
                    held.await(1, TimeUnit.MINUTES);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return;
                }
            }
            if (status != 200) {
                exchange.sendResponseHeaders(status, -1);
                return;
            }
            List<Record> records = rcode != 0 ? NOTHING
                    : (type == A ? answersA : answersAaaa).getOrDefault(name, NOTHING);
            byte[] response = response(Arrays.copyOfRange(query, 12, nameEnd + 4), rcode, records);
            exchange.getResponseHeaders().set("Content-Type", "application/dns-message");
            exchange.sendResponseHeaders(200, response.length + oversize);
            try (OutputStream out = exchange.getResponseBody()) {
                out.write(response);
                out.write(new byte[oversize]);
            }
        }
    }

    /** A response to one question, each record named by a pointer to it. */
    public static byte[] response(byte[] question, int rcode, List<Record> records) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        writeShort(out, 0);
        writeShort(out, 0x8180 | rcode);
        writeShort(out, 1);
        writeShort(out, records.size());
        writeShort(out, 0);
        writeShort(out, 0);
        out.writeBytes(question);
        for (Record record : records) {
            writeShort(out, 0xC00C);
            writeShort(out, record.type());
            writeShort(out, 1);
            writeShort(out, 0);
            writeShort(out, 60);
            writeShort(out, record.data().length);
            out.writeBytes(record.data());
        }
        return out.toByteArray();
    }

    /** The question section of a query for this name. */
    public static byte[] question(String name, int type) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.writeBytes(labels(name));
        writeShort(out, type);
        writeShort(out, 1);
        return out.toByteArray();
    }

    private static byte[] labels(String name) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        for (String label : name.split("\\.")) {
            byte[] bytes = label.getBytes(StandardCharsets.US_ASCII);
            out.write(bytes.length);
            out.writeBytes(bytes);
        }
        out.write(0);
        return out.toByteArray();
    }

    private static int nameEnd(byte[] message, int at) {
        while (message[at] != 0) {
            at += 1 + (message[at] & 0xFF);
        }
        return at + 1;
    }

    private static String name(byte[] message, int at) {
        List<String> labels = new ArrayList<>();
        while (message[at] != 0) {
            int length = message[at] & 0xFF;
            labels.add(new String(message, at + 1, length, StandardCharsets.US_ASCII));
            at += 1 + length;
        }
        return String.join(".", labels);
    }

    private static void writeShort(ByteArrayOutputStream out, int value) {
        out.write((value >> 8) & 0xFF);
        out.write(value & 0xFF);
    }
}
