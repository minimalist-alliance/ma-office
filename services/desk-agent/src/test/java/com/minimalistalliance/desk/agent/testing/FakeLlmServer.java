package com.minimalistalliance.desk.agent.testing;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

/**
 * A local stand-in for Anthropic's and OpenAI's APIs on loopback, on the JDK's HTTP server: {@code /v1/messages},
 * {@code /v1/responses} and {@code /v1/models}. Each chat request takes the next scripted {@link Reply}, or a default
 * stream; every request is recorded with its headers and body, so a test sees exactly what an adapter sent. No real
 * key and no network: this is the only provider the tests talk to.
 */
public final class FakeLlmServer implements AutoCloseable {

    public static final String KEY = "sk-ant-fake-0123456789abcdef";
    /** Keys in OpenAI's and xAI's shapes, for a test that sets {@link #acceptedKey} to one. */
    public static final String OPENAI_KEY = "sk-proj-fake-0123456789abcdef";
    public static final String XAI_KEY = "xai-fake-0123456789abcdef";

    /** What one request got: method, path, the auth headers, the body. */
    public record Request(String method, String path, String apiKey, String authorization, String version,
            String body) {}

    /**
     * One scripted answer: an HTTP status, then SSE events written {@code pauseMs} apart. {@code cutAfter} closes the
     * connection after that many events; {@code holdAfter} stops writing after that many until the latch opens.
     */
    public record Reply(int status, List<String> events, long pauseMs, int cutAfter, int holdAfter,
            CountDownLatch hold) {

        public static Reply events(String... events) {
            return new Reply(200, List.of(events), 0, -1, -1, null);
        }

        public static Reply status(int status) {
            return new Reply(status, List.of(), 0, -1, -1, null);
        }

        public Reply paced(long millis) {
            return new Reply(status, events, millis, cutAfter, holdAfter, hold);
        }

        public Reply cutAfter(int count) {
            return new Reply(status, events, pauseMs, count, holdAfter, hold);
        }

        public Reply holdAfter(int count, CountDownLatch latch) {
            return new Reply(status, events, pauseMs, cutAfter, count, latch);
        }
    }

    private final HttpServer server;
    public final ConcurrentLinkedQueue<Request> requests = new ConcurrentLinkedQueue<>();
    private final LinkedBlockingQueue<Reply> script = new LinkedBlockingQueue<>();
    public volatile String acceptedKey = KEY;
    public volatile int modelsStatus = 200;
    public final CountDownLatch streaming = new CountDownLatch(1);

    public FakeLlmServer() throws IOException {
        server = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 16);
        server.setExecutor(Executors.newVirtualThreadPerTaskExecutor());
        server.createContext("/", this::handle);
        server.start();
    }

    public String url() {
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    public FakeLlmServer then(Reply reply) {
        script.add(reply);
        return this;
    }

    /** An Anthropic stream: the text in pieces, then usage and a stop reason. */
    public static Reply anthropic(String model, long inputTokens, long outputTokens, String... pieces) {
        java.util.ArrayList<String> events = new java.util.ArrayList<>();
        events.add(sse("message_start", "{\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"model\":\"" + model
                + "\",\"usage\":{\"input_tokens\":" + inputTokens + ",\"cache_creation_input_tokens\":0,"
                + "\"cache_read_input_tokens\":0,\"output_tokens\":1}}}"));
        events.add(sse("content_block_start", "{\"type\":\"content_block_start\",\"index\":0,"
                + "\"content_block\":{\"type\":\"text\",\"text\":\"\"}}"));
        events.add(sse("ping", "{\"type\":\"ping\"}"));
        for (String piece : pieces) {
            events.add(sse("content_block_delta", "{\"type\":\"content_block_delta\",\"index\":0,\"delta\":"
                    + "{\"type\":\"text_delta\",\"text\":" + quote(piece) + "}}"));
        }
        events.add(sse("content_block_stop", "{\"type\":\"content_block_stop\",\"index\":0}"));
        events.add(sse("message_delta", "{\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},"
                + "\"usage\":{\"output_tokens\":" + outputTokens + "}}"));
        events.add(sse("message_stop", "{\"type\":\"message_stop\"}"));
        return new Reply(200, events, 0, -1, -1, null);
    }

    /** An OpenAI Responses stream. */
    public static Reply openai(String model, long input, long cached, long output, long reasoning, String... pieces) {
        java.util.ArrayList<String> events = new java.util.ArrayList<>();
        events.add(sse("response.created", "{\"type\":\"response.created\",\"response\":{\"model\":\"" + model
                + "\",\"status\":\"in_progress\"}}"));
        for (String piece : pieces) {
            events.add(sse("response.output_text.delta", "{\"type\":\"response.output_text.delta\",\"delta\":"
                    + quote(piece) + "}"));
        }
        events.add(sse("response.completed", "{\"type\":\"response.completed\",\"response\":{\"model\":\"" + model
                + "\",\"status\":\"completed\",\"incomplete_details\":null,\"usage\":{\"input_tokens\":" + input
                + ",\"input_tokens_details\":{\"cached_tokens\":" + cached + "},\"output_tokens\":" + output
                + ",\"output_tokens_details\":{\"reasoning_tokens\":" + reasoning + "}}}}"));
        return new Reply(200, events, 0, -1, -1, null);
    }

    /** A tool call to script: the provider's id, the tool, and the arguments' JSON text, which may be malformed. */
    public record Call(String id, String name, String arguments) {}

    /**
     * An Anthropic stream with optional text (block 0) and then tool_use blocks, each streaming its arguments as
     * {@code input_json_delta} pieces of at most {@code chunk} characters.
     */
    public static Reply anthropicTools(String model, long inputTokens, long outputTokens, String text, int chunk,
            Call... calls) {
        java.util.ArrayList<String> events = new java.util.ArrayList<>();
        events.add(sse("message_start", "{\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"model\":\"" + model
                + "\",\"usage\":{\"input_tokens\":" + inputTokens + ",\"output_tokens\":1}}}"));
        int index = 0;
        if (text != null && !text.isEmpty()) {
            events.add(sse("content_block_start", "{\"type\":\"content_block_start\",\"index\":0,"
                    + "\"content_block\":{\"type\":\"text\",\"text\":\"\"}}"));
            events.add(sse("content_block_delta", "{\"type\":\"content_block_delta\",\"index\":0,\"delta\":"
                    + "{\"type\":\"text_delta\",\"text\":" + quote(text) + "}}"));
            events.add(sse("content_block_stop", "{\"type\":\"content_block_stop\",\"index\":0}"));
            index++;
        }
        for (Call call : calls) {
            events.add(sse("content_block_start", "{\"type\":\"content_block_start\",\"index\":" + index
                    + ",\"content_block\":{\"type\":\"tool_use\",\"id\":" + quote(call.id()) + ",\"name\":"
                    + quote(call.name()) + ",\"input\":{}}}"));
            String args = call.arguments();
            for (int at = 0; at < args.length(); at += chunk) {
                events.add(sse("content_block_delta", "{\"type\":\"content_block_delta\",\"index\":" + index
                        + ",\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":"
                        + quote(args.substring(at, Math.min(args.length(), at + chunk))) + "}}"));
            }
            events.add(sse("content_block_stop", "{\"type\":\"content_block_stop\",\"index\":" + index + "}"));
            index++;
        }
        events.add(sse("message_delta", "{\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},"
                + "\"usage\":{\"output_tokens\":" + outputTokens + "}}"));
        events.add(sse("message_stop", "{\"type\":\"message_stop\"}"));
        return new Reply(200, events, 0, -1, -1, null);
    }

    /**
     * A Responses stream with optional text and then function_call items, each announced, given its arguments in
     * deltas and finished with {@code response.output_item.done}. With {@code onlyInCompleted} the done events are
     * left out and the calls come only in {@code response.completed}'s output.
     */
    public static Reply openaiTools(String model, String text, boolean onlyInCompleted, Call... calls) {
        java.util.ArrayList<String> events = new java.util.ArrayList<>();
        events.add(sse("response.created", "{\"type\":\"response.created\",\"response\":{\"model\":\"" + model
                + "\",\"status\":\"in_progress\"}}"));
        if (text != null && !text.isEmpty()) {
            events.add(sse("response.output_text.delta", "{\"type\":\"response.output_text.delta\",\"delta\":"
                    + quote(text) + "}"));
        }
        StringBuilder output = new StringBuilder();
        for (Call call : calls) {
            String item = "{\"type\":\"function_call\",\"id\":\"fc_x\",\"call_id\":" + quote(call.id())
                    + ",\"name\":" + quote(call.name()) + ",\"arguments\":" + quote(call.arguments()) + "}";
            if (!onlyInCompleted) {
                events.add(sse("response.output_item.added", "{\"type\":\"response.output_item.added\",\"item\":"
                        + item.replace(quote(call.arguments()), "\"\"") + "}"));
                events.add(sse("response.function_call_arguments.delta",
                        "{\"type\":\"response.function_call_arguments.delta\",\"delta\":"
                                + quote(call.arguments()) + "}"));
                events.add(sse("response.output_item.done", "{\"type\":\"response.output_item.done\",\"item\":"
                        + item + "}"));
            }
            output.append(output.length() == 0 ? "" : ",").append(item);
        }
        events.add(sse("response.completed", "{\"type\":\"response.completed\",\"response\":{\"model\":\"" + model
                + "\",\"status\":\"completed\",\"incomplete_details\":null,\"output\":[" + output
                + "],\"usage\":{\"input_tokens\":100,\"input_tokens_details\":{\"cached_tokens\":0},"
                + "\"output_tokens\":20,\"output_tokens_details\":{\"reasoning_tokens\":0}}}}"));
        return new Reply(200, events, 0, -1, -1, null);
    }

    public static String sse(String event, String data) {
        return "event: " + event + "\ndata: " + data + "\n\n";
    }

    private static String quote(String text) {
        return "\"" + text.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n") + "\"";
    }

    private void handle(HttpExchange exchange) throws IOException {
        String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
        String apiKey = exchange.getRequestHeaders().getFirst("x-api-key");
        String authorization = exchange.getRequestHeaders().getFirst("authorization");
        requests.add(new Request(exchange.getRequestMethod(), exchange.getRequestURI().getPath(), apiKey,
                authorization, exchange.getRequestHeaders().getFirst("anthropic-version"), body));
        String presented = apiKey != null ? apiKey
                : authorization != null && authorization.startsWith("Bearer ") ? authorization.substring(7) : null;
        String path = exchange.getRequestURI().getPath();
        if (!acceptedKey.equals(presented)) {
            respond(exchange, 401, "{\"type\":\"error\",\"error\":{\"type\":\"authentication_error\"}}");
            return;
        }
        if (path.endsWith("/v1/models")) {
            if (modelsStatus != 200) {
                respond(exchange, modelsStatus, "{}");
                return;
            }
            respond(exchange, 200, "{\"data\":[{\"id\":\"claude-sonnet-5-5\",\"display_name\":\"Claude Sonnet 5.5\"},"
                    + "{\"id\":\"gpt-5.4-mini\"},{\"id\":\"some-new-model\"}],\"has_more\":false}");
            return;
        }
        Reply reply = script.poll();
        if (reply == null) {
            reply = path.endsWith("/v1/responses")
                    ? openai("gpt-5.4-mini", 100, 0, 20, 0, "Hello", " from", " the stand-in.")
                    : anthropic("claude-sonnet-5-5", 100, 20, "Hello", " from", " the stand-in.");
        }
        if (reply.status() != 200) {
            respond(exchange, reply.status(), "{\"error\":{\"type\":\"scripted\"}}");
            return;
        }
        exchange.getResponseHeaders().add("content-type", "text/event-stream");
        exchange.sendResponseHeaders(200, 0);
        streaming.countDown();
        try (OutputStream out = exchange.getResponseBody()) {
            int sent = 0;
            for (String event : reply.events()) {
                if (sent == reply.cutAfter()) {
                    exchange.close();
                    return;
                }
                if (sent == reply.holdAfter()) {
                    out.flush();
                    reply.hold().await(30, TimeUnit.SECONDS);
                }
                out.write(event.getBytes(StandardCharsets.UTF_8));
                out.flush();
                sent++;
                if (reply.pauseMs() > 0) {
                    Thread.sleep(reply.pauseMs());
                }
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (IOException e) {
            // The client went away, as a stopped run does.
        }
    }

    private static void respond(HttpExchange exchange, int status, String body) throws IOException {
        byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().add("content-type", "application/json");
        exchange.sendResponseHeaders(status, bytes.length);
        try (OutputStream out = exchange.getResponseBody()) {
            out.write(bytes);
        }
    }

    /** The JSON body of the last chat request. */
    public Map<String, Object> lastChatBody() throws Exception {
        Request last = null;
        for (Request request : requests) {
            if (!request.path().endsWith("/v1/models")) {
                last = request;
            }
        }
        return com.minimalistalliance.desk.agent.json.Json.parseObject(last.body().getBytes(StandardCharsets.UTF_8));
    }

    @Override
    public void close() {
        server.stop(0);
    }
}
