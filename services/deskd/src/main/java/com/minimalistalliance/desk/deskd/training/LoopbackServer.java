package com.minimalistalliance.desk.deskd.training;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Base64;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.locks.ReentrantLock;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLServerSocket;

/**
 * HTTP and WebSocket by hand on a loopback port, with or without TLS, for the training's stand-ins. It lets
 * connections live as deskd's client expects, so that client's pool and its WebSocket run as they do on a desk.
 * The training is short and alone with deskd, so this is only as careful as that needs.
 */
final class LoopbackServer implements AutoCloseable {

    private static final String WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

    record Request(String method, String path, Map<String, String> headers, byte[] body) {}

    record Response(int status, String body) {}

    interface Handler {
        Response http(Request request) throws Exception;

        /** One WebSocket, for as long as this runs. */
        default void webSocket(Request request, Peer peer) throws Exception {
            throw new IllegalStateException("no WebSocket here");
        }
    }

    /** The server's end of one WebSocket. */
    static final class Peer {
        private final DataInputStream in;
        private final OutputStream out;
        private final ReentrantLock writing = new ReentrantLock();

        Peer(InputStream in, OutputStream out) {
            this.in = new DataInputStream(in);
            this.out = out;
        }

        /** @return the next text message, or null once the other side has closed */
        String read() throws IOException {
            ByteArrayOutputStream message = new ByteArrayOutputStream();
            while (true) {
                int first = in.read();
                if (first < 0) {
                    return null;
                }
                int second = in.readUnsignedByte();
                long length = second & 0x7F;
                if (length == 126) {
                    length = in.readUnsignedShort();
                } else if (length == 127) {
                    length = in.readLong();
                }
                byte[] mask = new byte[4];
                in.readFully(mask);
                byte[] payload = new byte[(int) length];
                in.readFully(payload);
                for (int i = 0; i < payload.length; i++) {
                    payload[i] ^= mask[i % 4];
                }
                int opcode = first & 0x0F;
                if (opcode == 8) {
                    return null;
                }
                if (opcode <= 1) {
                    message.write(payload);
                    if ((first & 0x80) != 0) {
                        return message.toString(StandardCharsets.UTF_8);
                    }
                }
            }
        }

        void send(String text) throws IOException {
            byte[] payload = text.getBytes(StandardCharsets.UTF_8);
            byte[] head = payload.length < 126
                    ? new byte[] {(byte) 0x81, (byte) payload.length}
                    : new byte[] {(byte) 0x81, 126, (byte) (payload.length >> 8), (byte) payload.length};
            writing.lock();
            try {
                out.write(head);
                out.write(payload);
                out.flush();
            } finally {
                writing.unlock();
            }
        }
    }

    private final Handler handler;
    private final ServerSocket server;
    private volatile boolean closed;

    /** @param tls null for plain HTTP, or the context with the one protocol version to allow */
    LoopbackServer(Handler handler, SSLContext tls, String protocol) throws IOException {
        this.handler = handler;
        if (tls == null) {
            server = new ServerSocket(0, 16, InetAddress.getLoopbackAddress());
        } else {
            SSLServerSocket secure = (SSLServerSocket)
                    tls.getServerSocketFactory().createServerSocket(0, 16, InetAddress.getLoopbackAddress());
            secure.setEnabledProtocols(new String[] {protocol});
            server = secure;
        }
        Thread.ofVirtual().name("training-accept").start(this::acceptLoop);
    }

    int port() {
        return server.getLocalPort();
    }

    @Override
    public void close() throws IOException {
        closed = true;
        server.close();
    }

    private void acceptLoop() {
        while (!closed) {
            try {
                Socket socket = server.accept();
                Thread.ofVirtual().name("training-conn").start(() -> serve(socket));
            } catch (IOException e) {
                return;
            }
        }
    }

    private void serve(Socket socket) {
        try (socket) {
            InputStream in = new BufferedInputStream(socket.getInputStream());
            OutputStream out = socket.getOutputStream();
            while (!closed) {
                Request request = readRequest(in);
                if (request == null) {
                    return;
                }
                if ("websocket".equalsIgnoreCase(request.headers().get("upgrade"))) {
                    accept(request, out);
                    handler.webSocket(request, new Peer(in, out));
                    return;
                }
                Response response = handler.http(request);
                byte[] body = response.body().getBytes(StandardCharsets.UTF_8);
                out.write(("HTTP/1.1 " + response.status() + " X\r\nContent-Type: application/json\r\nContent-Length: "
                                + body.length + "\r\n\r\n")
                        .getBytes(StandardCharsets.US_ASCII));
                out.write(body);
                out.flush();
            }
        } catch (IOException e) {
            // The other side went, as it does: deskd aborts what it no longer wants.
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (Exception e) {
            // A stand-in that can't answer stalls deskd, and the training fails on its time limit.
            System.err.println("training stand-in failed: " + e.getClass().getName());
        }
    }

    private static void accept(Request request, OutputStream out) throws IOException {
        String accept;
        try {
            accept = Base64.getEncoder().encodeToString(MessageDigest.getInstance("SHA-1").digest(
                    (request.headers().get("sec-websocket-key") + WEBSOCKET_GUID).getBytes(StandardCharsets.US_ASCII)));
        } catch (NoSuchAlgorithmException e) {
            throw new IOException(e);
        }
        String protocol = request.headers().get("sec-websocket-protocol");
        out.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept
                        + (protocol == null ? "" : "\r\nSec-WebSocket-Protocol: " + protocol) + "\r\n\r\n")
                .getBytes(StandardCharsets.US_ASCII));
        out.flush();
    }

    /** @return null at the end of the connection */
    private static Request readRequest(InputStream in) throws IOException {
        ByteArrayOutputStream head = new ByteArrayOutputStream();
        int run = 0;
        while (run < 4) {
            int b = in.read();
            if (b < 0) {
                return null;
            }
            head.write(b);
            run = b == (run % 2 == 0 ? '\r' : '\n') ? run + 1 : (b == '\r' ? 1 : 0);
        }
        String[] lines = head.toString(StandardCharsets.ISO_8859_1).split("\r\n");
        String[] start = lines[0].split(" ");
        Map<String, String> headers = new HashMap<>();
        for (int i = 1; i < lines.length; i++) {
            int colon = lines[i].indexOf(':');
            if (colon > 0) {
                headers.put(lines[i].substring(0, colon).toLowerCase(Locale.ROOT), lines[i].substring(colon + 1).trim());
            }
        }
        String length = headers.get("content-length");
        byte[] body = length == null ? new byte[0] : in.readNBytes(Integer.parseInt(length));
        return new Request(start[0], start[1], headers, body);
    }
}
