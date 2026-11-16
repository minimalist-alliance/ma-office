package com.minimalistalliance.desk.agent.testing;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.Executors;
import java.util.concurrent.LinkedBlockingQueue;

/**
 * A local stand-in on loopback for a provider's own OpenAI-compatible Chat Completions API under a base path: Gemini's
 * {@code /v1beta/openai} or Moonshot's {@code /v1}. {@code {base}/models} needs the key, as the key check, and answers
 * {@link #models}; {@code {base}/chat/completions} takes the next scripted {@link FakeOpenRouter.Reply}, or a default
 * stream. Every request is recorded with its auth header and body. Its keys are made up: no real key and no network.
 */
public final class FakeChatServer implements AutoCloseable {

    /** Made-up keys in each provider's shape. */
    public static final String GOOGLE_KEY = "AIzaSyFAKE-0123456789abcdef0123456789ab";
    public static final String MOONSHOT_KEY = "sk-fakemoonshot0123456789abcdef0123456789abcdef";

    private final HttpServer server;
    private final String base;
    public final ConcurrentLinkedQueue<FakeOpenRouter.Request> requests = new ConcurrentLinkedQueue<>();
    private final LinkedBlockingQueue<FakeOpenRouter.Reply> script = new LinkedBlockingQueue<>();
    public volatile String acceptedKey;
    /** What {@code {base}/models} answers a good key. */
    public volatile String models = "{\"object\":\"list\",\"data\":[]}";
    /** A refusal of a bad key: its status and body, Moonshot's 401 by default. */
    public volatile int refusedStatus = 401;
    public volatile String refusedBody = "{\"error\":{\"message\":\"Invalid Authentication\","
            + "\"type\":\"invalid_authentication_error\"}}";

    public FakeChatServer(String base, String acceptedKey) throws IOException {
        this.base = base;
        this.acceptedKey = acceptedKey;
        server = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 16);
        server.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
        server.createContext("/", this::handle);
        server.start();
    }

    /** The base URL desk-agent is given. */
    public String url() {
        return "http://127.0.0.1:" + server.getAddress().getPort() + base;
    }

    public FakeChatServer then(FakeOpenRouter.Reply reply) {
        script.add(reply);
        return this;
    }

    /** A model list in the OpenAI shape, the ids as given. */
    public static String list(String... ids) {
        List<String> data = new ArrayList<>();
        for (String id : ids) {
            data.add("{\"id\":" + FakeOpenRouter.quote(id) + ",\"object\":\"model\",\"owned_by\":\"fake\"}");
        }
        return "{\"object\":\"list\",\"data\":[" + String.join(",", data) + "]}";
    }

    /** A plain answer: the text in pieces, the finish, then a usage chunk with no choices, then [DONE]. */
    public static FakeOpenRouter.Reply answer(String model, long prompt, long completion, String... pieces) {
        List<String> events = new ArrayList<>();
        for (String piece : pieces) {
            events.add(FakeOpenRouter.chunk(model, "{\"content\":" + FakeOpenRouter.quote(piece) + "}", null));
        }
        events.add(FakeOpenRouter.chunk(model, "{}", "stop"));
        events.add(usage(model, "\"prompt_tokens\":" + prompt + ",\"completion_tokens\":" + completion
                + ",\"total_tokens\":" + (prompt + completion)));
        events.add(FakeOpenRouter.done());
        return new FakeOpenRouter.Reply(200, Map.of(), null, events, -1);
    }

    /** The last chunk with {@code include_usage}: no choices, the usage fields given. */
    public static String usage(String model, String fields) {
        return FakeOpenRouter.data("{\"id\":\"c-1\",\"object\":\"chat.completion.chunk\",\"model\":"
                + FakeOpenRouter.quote(model) + ",\"choices\":[],\"usage\":{" + fields + "}}");
    }

    private void handle(HttpExchange exchange) throws IOException {
        String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
        String authorization = exchange.getRequestHeaders().getFirst("authorization");
        String path = exchange.getRequestURI().getPath();
        requests.add(new FakeOpenRouter.Request(exchange.getRequestMethod(), path, exchange.getRequestURI().getRawQuery(),
                authorization, body));
        String presented = authorization != null && authorization.startsWith("Bearer ") ? authorization.substring(7)
                : null;
        if (!acceptedKey.equals(presented)) {
            respond(exchange, refusedStatus, Map.of(), refusedBody);
            return;
        }
        if (path.equals(base + "/models")) {
            respond(exchange, 200, Map.of(), models);
            return;
        }
        if (!path.equals(base + "/chat/completions")) {
            respond(exchange, 404, Map.of(), "{\"error\":{\"message\":\"Not Found\"}}");
            return;
        }
        FakeOpenRouter.Reply reply = script.poll();
        if (reply == null) {
            reply = answer("fake-model", 100, 20, "Hello", " from", " the stand-in.");
        }
        if (reply.status() != 200) {
            respond(exchange, reply.status(), reply.headers(), reply.body());
            return;
        }
        exchange.getResponseHeaders().add("content-type", "text/event-stream");
        exchange.sendResponseHeaders(200, 0);
        try (OutputStream out = exchange.getResponseBody()) {
            int sent = 0;
            for (String event : reply.events()) {
                if (sent == reply.cutAfter()) {
                    exchange.close();
                    return;
                }
                out.write(event.getBytes(StandardCharsets.UTF_8));
                out.flush();
                sent++;
            }
        } catch (IOException e) {
            // The client went away, as a stopped run does.
        }
    }

    private static void respond(HttpExchange exchange, int status, Map<String, String> headers, String body)
            throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().add("content-type", "application/json");
        headers.forEach((name, value) -> exchange.getResponseHeaders().add(name, value));
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream out = exchange.getResponseBody()) {
            out.write(bytes);
        }
    }

    /** The chat requests' JSON bodies, in order. */
    public List<Map<String, Object>> chatBodies() throws Exception {
        List<Map<String, Object>> bodies = new ArrayList<>();
        for (FakeOpenRouter.Request request : requests) {
            if (request.path().equals(base + "/chat/completions")) {
                bodies.add(com.minimalistalliance.desk.agent.json.Json.parseObject(
                        request.body().getBytes(StandardCharsets.UTF_8)));
            }
        }
        return bodies;
    }

    @Override
    public void close() {
        server.stop(0);
    }
}
