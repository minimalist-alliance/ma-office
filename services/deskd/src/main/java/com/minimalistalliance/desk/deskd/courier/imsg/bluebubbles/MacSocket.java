package com.minimalistalliance.desk.deskd.courier.imsg.bluebubbles;

import com.minimalistalliance.desk.deskd.protocol.Json;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.Duration;
import java.util.Arrays;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.BiConsumer;

/**
 * BlueBubbles' socket, only as a doorbell (the launch plan's Wave 2.6): Socket.IO v4 over Engine.IO 4, websocket transport
 * only, the password as {@code guid}. Every event it brings ({@code new-message}, {@code updated-message} and the rest) is
 * taken as "something changed on the Mac": the transport then asks the REST API, from its cursor, so there is one way in for
 * messages, idempotent and bounded, and a server that "encrypts coms" (BlueBubbles' option) needs nothing more. The only
 * thing read from an event is an {@code updated-message}'s guid, as a hint of which message to ask for again.
 *
 * <p>Held to limits: a frame or message at most 1 MiB (the server's own {@code maxPayload}), no binary or compressed
 * frames, the server's ping answered, and a socket that's quiet past the ping interval and timeout closed.
 */
final class MacSocket implements AutoCloseable {

    static final int MAX_MESSAGE = 1 << 20;
    private static final String WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

    private final Socket socket;
    private final InputStream in;
    private final OutputStream out;
    private final SecureRandom random = new SecureRandom();
    private volatile boolean closed;

    private MacSocket(Socket socket) throws IOException {
        this.socket = socket;
        this.in = socket.getInputStream();
        this.out = socket.getOutputStream();
    }

    /** Thrown when the server refused the password on the socket. */
    static final class Unauthorized extends IOException {
        private static final long serialVersionUID = 1L;

        Unauthorized() {
            super("unauthorized", null);
        }
    }

    /**
     * Connects and joins the default namespace: the websocket upgrade, Engine.IO's open packet, then Socket.IO's
     * {@code 40} and its answer. Within {@code within}, else closed.
     */
    static MacSocket connect(MacLink link, MacAddress a, String pin, byte[] password, Duration within) throws IOException {
        // The whole connect and handshake within the bound, so a server that drips bytes can't hold it (as MacLink's exchanges).
        try (com.minimalistalliance.desk.deskd.courier.linked.Net.Deadline d =
                com.minimalistalliance.desk.deskd.courier.linked.Net.Deadline.start(within)) {
            Socket s = link.open(a, pin, within);
            MacSocket m = null;
            try {
                m = new MacSocket(s);
                m.handshake(a, password);
                return m;
            } catch (IOException | RuntimeException e) {
                if (m != null) {
                    m.close();
                } else {
                    s.close();
                }
                if (d.fired()) {
                    throw new java.net.SocketTimeoutException("deadline");
                }
                throw e;
            }
        }
    }

    private Duration pingEvery = Duration.ofSeconds(25);
    private Duration pingWait = Duration.ofSeconds(20);

    private void handshake(MacAddress a, byte[] password) throws IOException {
        byte[] keyBytes = new byte[16];
        random.nextBytes(keyBytes);
        String key = Base64.getEncoder().encodeToString(keyBytes);
        out.write("GET /socket.io/?EIO=4&transport=websocket&guid=".getBytes(StandardCharsets.US_ASCII));
        byte[] secret = MacLink.percent(password);
        try {
            out.write(secret);
        } finally {
            Arrays.fill(secret, (byte) 0);
        }
        String rest = " HTTP/1.1\r\nHost: " + a.hostHeader() + "\r\nUser-Agent: MA-Courier/1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                + "Sec-WebSocket-Key: " + key + "\r\nSec-WebSocket-Version: 13\r\n\r\n";
        out.write(rest.getBytes(StandardCharsets.US_ASCII));
        out.flush();
        Map<String, String> headers = new LinkedHashMap<>();
        int status = MacLink.readHead(in, headers);
        if (status == 401 || status == 403) {
            throw new Unauthorized();
        }
        if (status != 101 || !"websocket".equalsIgnoreCase(String.valueOf(headers.get("upgrade")).strip())) {
            throw new MacLink.Protocol("upgrade");
        }
        String accept = headers.get("sec-websocket-accept");
        if (accept == null || !accept.strip().equals(acceptFor(key))) {
            throw new MacLink.Protocol("accept");
        }
        if (headers.containsKey("sec-websocket-extensions")) {
            throw new MacLink.Protocol("extensions");
        }
        // Engine.IO's open packet: 0{"sid":..,"pingInterval":..,"pingTimeout":..}
        String open = readText();
        if (open == null || !open.startsWith("0")) {
            throw new MacLink.Protocol("open");
        }
        try {
            Map<String, Object> o = Json.parseObject(open.substring(1).getBytes(StandardCharsets.UTF_8));
            pingEvery = Duration.ofMillis(clamp(o.get("pingInterval"), 25_000));
            pingWait = Duration.ofMillis(clamp(o.get("pingTimeout"), 20_000));
        } catch (Exception e) {
            throw new MacLink.Protocol("open");
        }
        sendText("40");
        while (true) {
            String m = readText();
            if (m == null) {
                throw new MacLink.Protocol("closed");
            }
            if (m.startsWith("40")) {
                return;
            }
            if (m.startsWith("44")) {
                throw new Unauthorized();
            }
            if (m.equals("2")) {
                sendText("3");
            }
        }
    }

    private static long clamp(Object v, long dflt) {
        long n = v instanceof Number x ? x.longValue() : dflt;
        return Math.max(1_000, Math.min(120_000, n));
    }

    /** How long the socket may be quiet: the server's ping interval and timeout, and a little. */
    Duration quietLimit() {
        return pingEvery.plus(pingWait).plusSeconds(5);
    }

    /**
     * Reads until the socket closes or fails, calling {@code onEvent} with each event's name and data (a map, a string, or
     * null). Pings are answered here.
     */
    void listen(BiConsumer<String, Object> onEvent) throws IOException {
        socket.setSoTimeout((int) Math.min(Integer.MAX_VALUE, quietLimit().toMillis()));
        while (!closed) {
            String m = readText();
            if (m == null) {
                return;
            }
            if (m.equals("2")) {
                sendText("3");
            } else if (m.startsWith("42")) {
                String body = m.substring(2);
                // An ack id may sit between "42" and the array.
                int bracket = body.indexOf('[');
                if (bracket < 0) {
                    continue;
                }
                Object parsed;
                try {
                    parsed = Json.parseObject(("{\"e\":" + body.substring(bracket) + "}").getBytes(StandardCharsets.UTF_8)).get("e");
                } catch (Exception e) {
                    continue;
                }
                if (parsed instanceof List<?> l && !l.isEmpty() && l.get(0) instanceof String name && name.length() <= 64) {
                    onEvent.accept(name, l.size() > 1 ? l.get(1) : null);
                }
            } else if (m.startsWith("41") || m.equals("1")) {
                return;
            } else if (m.startsWith("44")) {
                throw new Unauthorized();
            }
        }
    }

    // ---- websocket frames (RFC 6455), client side

    private String readText() throws IOException {
        ByteArrayOutputStream message = new ByteArrayOutputStream();
        boolean inText = false;
        while (true) {
            int b0 = in.read();
            if (b0 < 0) {
                return null;
            }
            int b1 = in.read();
            if (b1 < 0) {
                return null;
            }
            boolean fin = (b0 & 0x80) != 0;
            if ((b0 & 0x70) != 0) {
                throw new MacLink.Protocol("rsv");
            }
            int opcode = b0 & 0x0F;
            if ((b1 & 0x80) != 0) {
                throw new MacLink.Protocol("masked");
            }
            long len = b1 & 0x7F;
            if (len == 126) {
                len = ((long) readByte() << 8) | readByte();
            } else if (len == 127) {
                len = 0;
                for (int i = 0; i < 8; i++) {
                    len = (len << 8) | readByte();
                }
            }
            if (len < 0 || len > MAX_MESSAGE || message.size() + len > MAX_MESSAGE) {
                throw new MacLink.TooLarge();
            }
            byte[] payload = in.readNBytes((int) len);
            if (payload.length != len) {
                return null;
            }
            switch (opcode) {
                case 0x1 -> {
                    if (inText) {
                        throw new MacLink.Protocol("frame");
                    }
                    message.writeBytes(payload);
                    if (fin) {
                        return message.toString(StandardCharsets.UTF_8);
                    }
                    inText = true;
                }
                case 0x0 -> {
                    if (!inText) {
                        throw new MacLink.Protocol("frame");
                    }
                    message.writeBytes(payload);
                    if (fin) {
                        return message.toString(StandardCharsets.UTF_8);
                    }
                }
                case 0x8 -> {
                    try {
                        sendFrame(0x8, new byte[0]);
                    } catch (IOException ignored) {
                        // closing anyway
                    }
                    return null;
                }
                case 0x9 -> {
                    if (len > 125) {
                        throw new MacLink.Protocol("ping");
                    }
                    sendFrame(0xA, payload);
                }
                case 0xA -> {
                    // a pong: nothing to do
                }
                default -> throw new MacLink.Protocol("opcode");
            }
        }
    }

    private int readByte() throws IOException {
        int b = in.read();
        if (b < 0) {
            throw new MacLink.Protocol("eof");
        }
        return b;
    }

    private void sendText(String text) throws IOException {
        sendFrame(0x1, text.getBytes(StandardCharsets.UTF_8));
    }

    private synchronized void sendFrame(int opcode, byte[] payload) throws IOException {
        ByteArrayOutputStream f = new ByteArrayOutputStream(payload.length + 14);
        f.write(0x80 | opcode);
        int len = payload.length;
        if (len < 126) {
            f.write(0x80 | len);
        } else if (len < 65536) {
            f.write(0x80 | 126);
            f.write(len >> 8);
            f.write(len & 0xFF);
        } else {
            f.write(0x80 | 127);
            for (int i = 7; i >= 0; i--) {
                f.write((int) ((long) len >> (8 * i)) & 0xFF);
            }
        }
        byte[] mask = new byte[4];
        random.nextBytes(mask);
        f.writeBytes(mask);
        for (int i = 0; i < len; i++) {
            f.write(payload[i] ^ mask[i & 3]);
        }
        out.write(f.toByteArray());
        out.flush();
    }

    static String acceptFor(String key) {
        try {
            byte[] sha = MessageDigest.getInstance("SHA-1").digest((key + WS_GUID).getBytes(StandardCharsets.US_ASCII));
            return Base64.getEncoder().encodeToString(sha);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    @Override
    public void close() {
        closed = true;
        try {
            socket.close();
        } catch (IOException ignored) {
            // closing
        }
    }
}
