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
 * A local stand-in for OpenRouter on loopback: {@code /api/v1/key} (the key check), {@code /api/v1/models} (the public
 * catalog, no key) and {@code /api/v1/chat/completions} (Chat Completions, streamed). Each chat request takes the next
 * scripted {@link Reply}, or a default stream; every request is recorded with its auth header and body. Its key is a
 * made-up one in OpenRouter's shape: no real key and no network.
 */
public final class FakeOpenRouter implements AutoCloseable {

    public static final String KEY = "sk-or-v1-fake-0123456789abcdef0123456789abcdef";

    /** What one request got. */
    public record Request(String method, String path, String query, String authorization, String body) {}

    /** One scripted answer: a status, headers, and either a JSON body or SSE data lines. */
    public record Reply(int status, Map<String, String> headers, String body, List<String> events, int cutAfter) {

        /** A stream of chunks, each a {@code data:} event, without {@code [DONE]} unless it's among them. */
        public static Reply events(String... events) {
            return new Reply(200, Map.of(), null, List.of(events), -1);
        }

        /** A refusal before streaming: a status and OpenRouter's error object. */
        public static Reply error(int status, String message, Map<String, String> headers) {
            return new Reply(status, headers, "{\"error\":{\"code\":" + status + ",\"message\":" + quote(message)
                    + ",\"metadata\":{\"error_type\":\"scripted\"}}}", List.of(), -1);
        }

        public Reply cutAfter(int count) {
            return new Reply(status, headers, body, events, count);
        }
    }

    private final HttpServer server;
    public final ConcurrentLinkedQueue<Request> requests = new ConcurrentLinkedQueue<>();
    private final LinkedBlockingQueue<Reply> script = new LinkedBlockingQueue<>();
    public volatile String acceptedKey = KEY;
    /** What {@code /api/v1/key} says under {@code data}. */
    public volatile String keyData = "{\"label\":\"fake\",\"is_free_tier\":true,\"is_management_key\":false,"
            + "\"is_provisioning_key\":false,\"free_model_daily_requests\":{\"used\":0,\"limit\":50,\"remaining\":50}}";
    /** The catalog's pages, by the {@code offset} query; page 0 is the plain {@code /api/v1/models}. */
    public final List<String> catalog = new ArrayList<>(List.of(catalog(null,
            model("nvidia/nemotron-3.5-super-vl:free", "NVIDIA: Nemotron 3.5 Super VL (free)", true),
            model("acme/paid-model", "Acme: Paid", true),
            model("cohere/north-mini-code:free", "Cohere: North Mini Code (free)", true),
            model("acme/chatty:free", "Acme: Chatty (free)", false),
            model("openrouter/free", "Free Models Router", true),
            model("acme/tooly:free", "Acme: Tooly (free)", true),
            "{\"id\":\"acme/painter:free\",\"name\":\"Acme: Painter\",\"architecture\":{\"output_modalities\":"
                    + "[\"image\"]},\"supported_parameters\":[]}")));
    public volatile int catalogStatus = 200;

    public FakeOpenRouter() throws IOException {
        server = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 16);
        server.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
        server.createContext("/", this::handle);
        server.start();
    }

    public String url() {
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    public FakeOpenRouter then(Reply reply) {
        script.add(reply);
        return this;
    }

    /** One catalog entry, as OpenRouter's {@code /api/v1/models} has it, priced $0 when its id says free. */
    public static String model(String id, String name, boolean tools) {
        String price = id.endsWith(":free") || id.equals("openrouter/free") ? "\"0\"" : "\"0.000003\"";
        return "{\"id\":" + quote(id) + ",\"name\":" + quote(name) + ",\"context_length\":131072,"
                + "\"architecture\":{\"input_modalities\":[\"text\"],\"output_modalities\":[\"text\"]},"
                + "\"pricing\":{\"prompt\":" + price + ",\"completion\":" + price + "},"
                + "\"supported_parameters\":[\"max_tokens\",\"temperature\"" + (tools ? ",\"tools\",\"tool_choice\"" : "")
                + "]}";
    }

    /** A catalog page: the entries, and a {@code links.next} when one is given. */
    public static String catalog(String next, String... models) {
        return "{\"data\":[" + String.join(",", models) + "],\"total_count\":" + models.length + ",\"links\":{\"next\":"
                + (next == null ? "null" : quote(next)) + "}}";
    }

    /** A stream: the model named, the text in pieces, then the finish and a usage chunk with a cost, then [DONE]. */
    public static Reply answer(String model, long prompt, long cached, long completion, String cost, String... pieces) {
        List<String> events = new ArrayList<>();
        events.add(": OPENROUTER PROCESSING\n\n");
        for (String piece : pieces) {
            events.add(chunk(model, "{\"content\":" + quote(piece) + "}", null));
        }
        events.add(chunk(model, "{}", "stop"));
        events.add(usage(model, prompt, cached, completion, cost, "stop"));
        events.add(done());
        return new Reply(200, Map.of(), null, events, -1);
    }

    public static String chunk(String model, String delta, String finish) {
        return data("{\"id\":\"gen-1\",\"object\":\"chat.completion.chunk\",\"model\":" + quote(model)
                + ",\"choices\":[{\"index\":0,\"delta\":" + delta + ",\"finish_reason\":"
                + (finish == null ? "null" : quote(finish)) + "}]}");
    }

    public static String usage(String model, long prompt, long cached, long completion, String cost, String finish) {
        return data("{\"id\":\"gen-1\",\"object\":\"chat.completion.chunk\",\"model\":" + quote(model)
                + ",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":" + quote(finish) + "}],"
                + "\"usage\":{\"prompt_tokens\":" + prompt + ",\"completion_tokens\":" + completion
                + ",\"total_tokens\":" + (prompt + completion) + (cost == null ? "" : ",\"cost\":" + cost)
                + ",\"prompt_tokens_details\":{\"cached_tokens\":" + cached + "},"
                + "\"completion_tokens_details\":{\"reasoning_tokens\":0}}}");
    }

    public static String data(String json) {
        return "data: " + json + "\n\n";
    }

    public static String done() {
        return "data: [DONE]\n\n";
    }

    public static String quote(String text) {
        return "\"" + text.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n") + "\"";
    }

    private void handle(HttpExchange exchange) throws IOException {
        String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
        String authorization = exchange.getRequestHeaders().getFirst("authorization");
        String path = exchange.getRequestURI().getPath();
        String query = exchange.getRequestURI().getRawQuery();
        requests.add(new Request(exchange.getRequestMethod(), path, query, authorization, body));
        if (path.equals("/api/v1/models")) {
            if (catalogStatus != 200) {
                respond(exchange, catalogStatus, Map.of(), "{}");
                return;
            }
            int page = query != null && query.startsWith("offset=") ? Integer.parseInt(query.substring(7)) : 0;
            respond(exchange, 200, Map.of(), catalog.get(page));
            return;
        }
        String presented = authorization != null && authorization.startsWith("Bearer ") ? authorization.substring(7)
                : null;
        if (!acceptedKey.equals(presented)) {
            respond(exchange, 401, Map.of(), "{\"error\":{\"code\":401,\"message\":\"No auth credentials found\"}}");
            return;
        }
        if (path.equals("/api/v1/key")) {
            respond(exchange, 200, Map.of(), "{\"data\":" + keyData + "}");
            return;
        }
        if (!path.equals("/api/v1/chat/completions")) {
            respond(exchange, 404, Map.of(), "{\"error\":{\"code\":404,\"message\":\"Not Found\"}}");
            return;
        }
        Reply reply = script.poll();
        if (reply == null) {
            reply = answer("nvidia/nemotron-3.5-super-vl:free", 100, 0, 20, "0", "Hello", " from", " the stand-in.");
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
        for (Request request : requests) {
            if (request.path().equals("/api/v1/chat/completions")) {
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
