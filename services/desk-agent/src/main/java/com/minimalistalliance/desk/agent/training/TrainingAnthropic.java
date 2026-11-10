package com.minimalistalliance.desk.agent.training;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Locale;

/**
 * The training's stand-in for Anthropic's API: HTTP/1.1 by hand on a loopback port, one request per connection.
 * {@code GET /v1/models} lists one model; {@code POST /v1/messages} streams a short answer as Anthropic does. It
 * answers only the key it was made with. The training is short and alone with desk-agent, so this is only as
 * careful as that needs.
 */
final class TrainingAnthropic implements AutoCloseable {

    static final String MODEL = "claude-sonnet-5-5";

    private final ServerSocket server;
    private final String key;
    private final Thread acceptor;

    TrainingAnthropic(String key) throws IOException {
        this.key = key;
        server = new ServerSocket(0, 16, InetAddress.getLoopbackAddress());
        acceptor = Thread.ofVirtual().name("training-anthropic").start(this::acceptLoop);
    }

    String url() {
        return "http://127.0.0.1:" + server.getLocalPort();
    }

    private void acceptLoop() {
        while (!server.isClosed()) {
            try {
                Socket socket = server.accept();
                Thread.ofVirtual().start(() -> serve(socket));
            } catch (IOException e) {
                return;
            }
        }
    }

    private void serve(Socket socket) {
        try (socket) {
            InputStream in = new BufferedInputStream(socket.getInputStream());
            String head = readHead(in);
            String requestLine = head.lines().findFirst().orElse("");
            int contentLength = 0;
            String presented = null;
            for (String line : head.lines().skip(1).toList()) {
                int colon = line.indexOf(':');
                if (colon < 0) {
                    continue;
                }
                String name = line.substring(0, colon).trim().toLowerCase(Locale.ROOT);
                String value = line.substring(colon + 1).trim();
                if (name.equals("content-length")) {
                    contentLength = Integer.parseInt(value);
                } else if (name.equals("x-api-key")) {
                    presented = value;
                }
            }
            in.readNBytes(contentLength);
            OutputStream out = socket.getOutputStream();
            if (!key.equals(presented)) {
                write(out, 401, "application/json", "{\"type\":\"error\"}");
            } else if (requestLine.startsWith("GET /v1/models")) {
                write(out, 200, "application/json", "{\"data\":[{\"id\":\"" + MODEL
                        + "\",\"display_name\":\"Training model\"}],\"has_more\":false}");
            } else if (requestLine.startsWith("POST /v1/messages")) {
                write(out, 200, "text/event-stream", stream());
            } else {
                write(out, 404, "application/json", "{}");
            }
        } catch (IOException | RuntimeException e) {
            // The training's checks are on desk-agent's side.
        }
    }

    private static String stream() {
        StringBuilder sse = new StringBuilder();
        event(sse, "message_start", "{\"type\":\"message_start\",\"message\":{\"model\":\"" + MODEL
                + "\",\"usage\":{\"input_tokens\":40,\"cache_creation_input_tokens\":0,\"cache_read_input_tokens\":0,"
                + "\"output_tokens\":1}}}");
        for (String piece : new String[] {"Ready ", "when ", "you are."}) {
            event(sse, "content_block_delta", "{\"type\":\"content_block_delta\",\"index\":0,\"delta\":"
                    + "{\"type\":\"text_delta\",\"text\":\"" + piece + "\"}}");
        }
        event(sse, "message_delta", "{\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},"
                + "\"usage\":{\"output_tokens\":4}}");
        event(sse, "message_stop", "{\"type\":\"message_stop\"}");
        return sse.toString();
    }

    private static void event(StringBuilder sse, String name, String data) {
        sse.append("event: ").append(name).append("\ndata: ").append(data).append("\n\n");
    }

    private static void write(OutputStream out, int status, String type, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        String head = "HTTP/1.1 " + status + " X\r\ncontent-type: " + type + "\r\ncontent-length: " + bytes.length
                + "\r\nconnection: close\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.ISO_8859_1));
        out.write(bytes);
        out.flush();
    }

    private static String readHead(InputStream in) throws IOException {
        ByteArrayOutputStream head = new ByteArrayOutputStream();
        int matched = 0;
        while (matched < 4) {
            int b = in.read();
            if (b < 0) {
                throw new IOException("closed");
            }
            head.write(b);
            matched = (b == "\r\n\r\n".charAt(matched)) ? matched + 1 : (b == '\r' ? 1 : 0);
            if (head.size() > 16384) {
                throw new IOException("head too long");
            }
        }
        return head.toString(StandardCharsets.ISO_8859_1);
    }

    @Override
    public void close() throws IOException {
        server.close();
        acceptor.interrupt();
    }
}
