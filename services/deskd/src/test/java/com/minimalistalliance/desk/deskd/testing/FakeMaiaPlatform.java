package com.minimalistalliance.desk.deskd.testing;

import com.minimalistalliance.desk.deskd.aws.AwsCredentials;
import com.minimalistalliance.desk.deskd.platform.DeskMaiaClient;
import com.minimalistalliance.desk.deskd.platform.PlatformHttp;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.JsonFormatException;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Function;

/**
 * Desk Maia's service on Minimalist Alliance's AI account, as a stand-in on loopback for the real-socket ITs (ma-platform
 * {@code docs/contracts/desk-maia.md}): {@code POST /v1/desk-maia/call}, the proof checked as the service checks it (its
 * audience, the body's hash, the STS request's shape: a call without them is {@code 401 desk_auth}), the request's fields
 * checked, and a script that answers each request as the contract's 200 or a refusal. It records every body.
 */
public final class FakeMaiaPlatform implements AutoCloseable {

    public static final String MAIA_ID = "maia.test.minimalistalliance.com";

    /** What the script answers: a status and a JSON body. */
    public record Reply(int status, Map<String, Object> body) {}

    /** Every request's body, as sent, in order. */
    public final ConcurrentLinkedQueue<String> bodies = new ConcurrentLinkedQueue<>();
    /** Requests refused for their proof. */
    public final ConcurrentLinkedQueue<String> refusedProofs = new ConcurrentLinkedQueue<>();
    public final AtomicReference<Function<Map<String, Object>, Reply>> script = new AtomicReference<>();
    private final HttpServer server;
    private final PlatformHttp http = new PlatformHttp();

    public FakeMaiaPlatform() throws IOException {
        server = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
        server.createContext("/", this::answer);
        server.setExecutor(java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor());
        server.start();
    }

    public String url() {
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    /** deskd's client of this stand-in, signing as a fixed desk role. */
    public DeskMaiaClient client(Clock clock) {
        DeskMaiaClient.RoleKeys keys = new DeskMaiaClient.RoleKeys() {
            @Override
            public AwsCredentials current() {
                return new AwsCredentials("ASIATESTDESKROLE", "test-secret-not-logged", "test-session-token",
                        Instant.now().plus(Duration.ofHours(1)));
            }

            @Override
            public void invalidate() {}
        };
        return new DeskMaiaClient(http, keys, () -> new DeskMaiaClient.Endpoint(url(), MAIA_ID), clock);
    }

    /** A 200 with her text. */
    public static Reply text(String words) {
        return ok(words, List.of(), "end_turn");
    }

    /** A 200 with one tool call. */
    public static Reply call(String tool, Map<String, Object> input) {
        Map<String, Object> c = new LinkedHashMap<>();
        c.put("id", "toolu_" + System.nanoTime());
        c.put("name", tool);
        c.put("input", input);
        c.put("malformed", false);
        c.put("reasoning", List.of());
        return ok("", List.of(c), "tool_use");
    }

    private static Reply ok(String text, List<Object> calls, String stop) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("v", 1);
        body.put("text", text);
        body.put("toolCalls", calls);
        body.put("stopReason", stop);
        body.put("usage", Map.of("inputTokens", 1200, "cachedInputTokens", 4000, "cacheWriteTokens", 0, "outputTokens",
                60, "reasoningTokens", 0));
        // Contract 0.4.8: costMicroUsd stays for older desks; what the call drew in credits, and the member's credits (a
        // tier with Maia Mode credits, within this month's share). The month renews 20 days from now.
        body.put("costMicroUsd", 4200);
        body.put("costCredits", 1.84);
        body.put("allowance", Map.of("fraction", 0.62, "resetsAt", java.time.Instant.now().plus(java.time.Duration
                .ofDays(20)).truncatedTo(java.time.temporal.ChronoUnit.SECONDS).toString(), "credits", Map.ofEntries(
                Map.entry("left", 1760), Map.entry("month", 2500), Map.entry("monthLeft", 1550), Map.entry("week", 800),
                Map.entry("weekUsed", 120), Map.entry("day", 200), Map.entry("dayUsed", 90), Map.entry("starting", 210),
                Map.entry("topUpLeft", 0), Map.entry("drawingFrom", "month")), "lighter", false));
        return new Reply(200, body);
    }

    /** A refusal in the error envelope. */
    public static Reply refused(int status, String code, Map<String, Object> details) {
        return new Reply(status, Map.of("error", Map.of("code", code, "message", "refused", "details", details)));
    }

    private void answer(HttpExchange exchange) throws IOException {
        byte[] raw = exchange.getRequestBody().readAllBytes();
        String proof = exchange.getRequestHeaders().getFirst("x-ma-desk-auth");
        Reply reply;
        Map<String, Object> request = null;
        if (!"/v1/desk-maia/call".equals(exchange.getRequestURI().getPath()) || !proofHolds(proof, raw)) {
            refusedProofs.add(exchange.getRequestURI().getPath());
            reply = refused(401, "unauthenticated", Map.of("reason", "desk_auth"));
        } else {
            try {
                request = Json.parseObject(raw);
            } catch (JsonFormatException e) {
                request = null;
            }
            String bad = request == null ? "body" : badField(request);
            if (bad != null) {
                reply = refused(400, "bad_request", Map.of("reason", bad));
            } else {
                bodies.add(new String(raw, StandardCharsets.UTF_8));
                Function<Map<String, Object>, Reply> step = script.get();
                reply = step == null ? text("Hello.") : step.apply(request);
                if ("credits".equals(request.get("units")) && reply.status() == 200) {
                    // Asked in credits (0.4.8): no costMicroUsd, so the desk can't work out the credit's rate.
                    Map<String, Object> body = new LinkedHashMap<>(reply.body());
                    body.remove("costMicroUsd");
                    reply = new Reply(200, body);
                }
            }
        }
        byte[] out = Json.bytes(reply.body());
        exchange.getResponseHeaders().add("content-type", "application/json");
        exchange.sendResponseHeaders(reply.status(), out.length);
        try (OutputStream o = exchange.getResponseBody()) {
            o.write(out);
        }
        exchange.close();
    }

    /** The proof as the service reads it: its STS request, signed over this audience and this body's hash. */
    @SuppressWarnings("unchecked")
    private static boolean proofHolds(String proof, byte[] body) {
        if (proof == null) {
            return false;
        }
        try {
            Map<String, Object> sts = Json.parseObject(Base64.getUrlDecoder().decode(proof));
            Map<String, Object> headers = (Map<String, Object>) sts.get("headers");
            String hash = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(body));
            String authorization = String.valueOf(headers.get("authorization"));
            return "POST".equals(sts.get("method")) && "https://sts.us-east-1.amazonaws.com/".equals(sts.get("url"))
                    && "Action=GetCallerIdentity&Version=2011-06-15".equals(sts.get("body"))
                    && MAIA_ID.equals(headers.get("x-ma-maia-id")) && hash.equals(headers.get("x-ma-body-sha256"))
                    && authorization.contains("x-ma-body-sha256;x-ma-maia-id") && headers.get("x-amz-date") != null;
        } catch (Exception e) {
            return false;
        }
    }

    /** The first field out of the contract's shape, or null. */
    @SuppressWarnings("unchecked")
    private static String badField(Map<String, Object> request) {
        for (String key : request.keySet()) {
            if (!List.of("v", "task", "callId", "context", "messages", "tools", "maxOutputTokens", "units", "note")
                    .contains(key)) {
                return key;
            }
        }
        if (request.containsKey("units") && !"credits".equals(request.get("units"))) {
            return "units";
        }
        if (!Integer.valueOf(1).equals(request.get("v")) && !Long.valueOf(1).equals(request.get("v"))) {
            return "v";
        }
        if (!List.of("turn", "step", "notes").contains(request.get("task"))) {
            return "task";
        }
        if (!(request.get("messages") instanceof List<?> messages) || messages.isEmpty() || messages.size() > 400) {
            return "messages";
        }
        Object first = ((Map<String, Object>) messages.getFirst()).get("role");
        Object last = ((Map<String, Object>) messages.getLast()).get("role");
        if (!"user".equals(first) || !"user".equals(last)) {
            return "messages";
        }
        if (request.get("context") instanceof String context && context.length() > 32_000) {
            return "context";
        }
        if ("notes".equals(request.get("task")) && request.get("tools") instanceof List<?> tools && !tools.isEmpty()) {
            return "tools";
        }
        // 0.4.6: at most 2,000 characters, line breaks allowed, no other control character.
        if (request.containsKey("note") && (!(request.get("note") instanceof String note) || note.length() > 2_000
                || note.chars().anyMatch(c -> c != '\n' && (c < 0x20 || c == 0x7f)))) {
            return "note";
        }
        return null;
    }

    @Override
    public void close() {
        server.stop(0);
        http.close();
    }
}
