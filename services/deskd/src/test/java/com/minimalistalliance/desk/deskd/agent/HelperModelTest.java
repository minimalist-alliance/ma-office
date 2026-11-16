package com.minimalistalliance.desk.deskd.agent;

import static org.assertj.core.api.Assertions.assertThat;

import ch.qos.logback.classic.Logger;
import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import com.minimalistalliance.desk.deskd.aws.AwsCredentials;
import com.minimalistalliance.desk.deskd.platform.DeskMaiaClient;
import com.minimalistalliance.desk.deskd.platform.PlatformHttp;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.rpc.Caller;
import com.minimalistalliance.desk.deskd.tools.ToolHost;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.Function;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.slf4j.LoggerFactory;

/**
 * Helpers on MA's credits through deskd (API.md §24): a {@code helpers_model} {@code tcall} reaches the service's helpers route,
 * never the tool host, with deskd's proof over the exact body; {@code helpers_credits} reads the member's credits; Desk Maia,
 * a Guild Desk and a teen's desk are refused before anything goes out; only the contract's fields pass; the service's refusals
 * come back with their code and known details; the hello says {@code helpers: {model: true}} while the service is configured;
 * nothing of a call reaches a log.
 */
@SuppressWarnings("unchecked")
class HelperModelTest {

    private static final String MAIA_ID = "maia.staging.minimalistalliance.com";
    private static final String SECRET = "a helper's words from the member's desk that must never be logged";

    @TempDir
    Path dir;

    private AgentRig rig;
    private HttpServer server;
    private PlatformHttp http;
    private final ConcurrentLinkedQueue<byte[]> bodies = new ConcurrentLinkedQueue<>();
    private final ConcurrentLinkedQueue<String> paths = new ConcurrentLinkedQueue<>();
    private final ConcurrentLinkedQueue<String> proofs = new ConcurrentLinkedQueue<>();
    private final AtomicReference<Function<byte[], String[]>> script = new AtomicReference<>();
    private final AtomicBoolean configured = new AtomicBoolean(true);
    private volatile boolean guild;

    private final DeskMaiaClient.RoleKeys keys = new DeskMaiaClient.RoleKeys() {
        @Override
        public AwsCredentials current() {
            return new AwsCredentials("ASIAEXAMPLE", "secret-key-that-must-not-be-logged", "session-token-x",
                    Instant.now().plus(Duration.ofHours(1)));
        }

        @Override
        public void invalidate() {}
    };

    @BeforeEach
    void setUp() throws Exception {
        server = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
        server.createContext("/", this::answer);
        server.setExecutor(java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor());
        server.start();
        http = new PlatformHttp();
        rig = new AgentRig(dir);
        rig.agent.snapshots.put("agent.state", () -> Map.of("agents", List.of()));
        String url = "http://127.0.0.1:" + server.getAddress().getPort();
        DeskMaiaClient client = new DeskMaiaClient(http, keys,
                () -> configured.get() ? new DeskMaiaClient.Endpoint(url, MAIA_ID) : null, Clock.systemUTC());
        rig.module.helperModel(new HelperModel(client, () -> guild,
                () -> rig.band == com.minimalistalliance.desk.deskd.platform.AgeBand.Band.ADULT));
    }

    @AfterEach
    void tearDown() throws Exception {
        rig.close();
        http.close();
        server.stop(0);
    }

    private void answer(HttpExchange exchange) throws IOException {
        byte[] body = exchange.getRequestBody().readAllBytes();
        bodies.add(body);
        paths.add(exchange.getRequestURI().getPath());
        proofs.add(exchange.getRequestHeaders().getFirst("x-ma-desk-auth"));
        Function<byte[], String[]> step = script.get();
        String[] reply = step == null ? new String[] {"200", "{\"v\":1,\"text\":\"Opening it.\",\"stopReason\":\"end_turn\","
                + "\"usage\":{\"inputTokens\":12,\"outputTokens\":3},\"costCredits\":0.45,"
                + "\"credits\":{\"left\":261,\"month\":0,\"monthLeft\":0,\"starting\":261,\"topUp\":0,"
                + "\"topUpLeft\":0,\"day\":200,\"dayUsed\":10,\"week\":800,\"weekUsed\":40,\"drawingFrom\":\"starting\","
                + "\"lighter\":false,\"renewsAt\":null}}"} : step.apply(body);
        byte[] out = reply[1].getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().add("content-type", "application/json");
        exchange.sendResponseHeaders(Integer.parseInt(reply[0]), out.length);
        try (OutputStream o = exchange.getResponseBody()) {
            o.write(out);
        }
        exchange.close();
    }

    private static Map<String, Object> m(Object... pairs) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (int i = 0; i < pairs.length; i += 2) {
            map.put((String) pairs[i], pairs[i + 1]);
        }
        return map;
    }

    private static Map<String, Object> args(String text) {
        return m("task", "agent", "callId", "0192f1c4-7a1e-7b3c-9d2e-5f6a7b8c9d0e", "context", "You are Research.",
                "messages", List.of(m("role", "user", "text", text)), "tools", List.of(), "maxOutputTokens", 4000);
    }

    private void tcall(long id, String agentId, String tool, Object args) {
        Map<String, Object> call = m("t", "tcall", "id", id, "runId", "r-1", "agentId", agentId, "tool", tool,
                "taint", List.of());
        if (args != null) {
            call.put("args", args);
        }
        rig.agent.sendJson(call);
    }

    private final Map<Long, Map<String, Object>> early = new java.util.HashMap<>();

    private Map<String, Object> answerFor(long id) throws InterruptedException {
        Map<String, Object> kept = early.remove(id);
        if (kept != null) {
            return kept;
        }
        while (true) {
            Map<String, Object> msg = rig.agent.received.poll(15, TimeUnit.SECONDS);
            assertThat(msg).as("an answer to " + id).isNotNull();
            if ("tres".equals(msg.get("t")) || "terr".equals(msg.get("t"))) {
                long got = ((Number) msg.get("id")).longValue();
                if (got == id) {
                    return msg;
                }
                early.put(got, msg);
            }
        }
    }

    private static Map<String, Object> details(Map<String, Object> terr) {
        return (Map<String, Object>) terr.get("details");
    }

    @Test
    void aHelpersCallGoesToTheHelpersRouteWithAProofOverTheExactBodyAndItsAnswerComesBack() throws Exception {
        tcall(1, "research", HelperModel.TOOL, args("Find three flights"));
        Map<String, Object> tres = answerFor(1);
        assertThat(tres.get("t")).as(String.valueOf(tres)).isEqualTo("tres");
        assertThat((Map<String, Object>) tres.get("r")).containsEntry("costCredits", 0.45).containsKey("credits");
        // The one wallet's fields (desk-helpers.md with desk-maia.md 0.4.10) come through as they came: deskd reads none.
        assertThat((Map<String, Object>) ((Map<String, Object>) tres.get("r")).get("credits"))
                .containsEntry("drawingFrom", "starting").containsKey("monthLeft").containsKey("weekUsed");
        assertThat(paths.poll()).isEqualTo(DeskMaiaClient.HELPERS_CALL);
        byte[] body = bodies.poll();
        assertThat(new String(body, StandardCharsets.UTF_8)).startsWith("{\"v\":1,");
        assertThat(Json.parseObject(body).keySet()).containsExactly("v", "task", "callId", "context", "messages", "tools",
                "maxOutputTokens");
        Map<String, Object> proof = Json.parseObject(Base64.getUrlDecoder().decode(proofs.poll()));
        Map<String, Object> headers = (Map<String, Object>) proof.get("headers");
        assertThat(headers).containsEntry("x-ma-maia-id", MAIA_ID).containsEntry("x-ma-body-sha256",
                HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(body)));
        assertThat(rig.agent.requests).isEmpty();
        // The credits read: its own route, a fresh id and nothing else.
        tcall(2, "research", HelperModel.CREDITS, m("callId", "0192f1c4-7a1e-7b3c-9d2e-000000000002"));
        assertThat(answerFor(2).get("t")).isEqualTo("tres");
        assertThat(paths.poll()).isEqualTo(DeskMaiaClient.HELPERS_CREDITS);
        assertThat(Json.parseObject(bodies.poll()).keySet()).containsExactly("v", "callId");
        tcall(3, "research", HelperModel.CREDITS, null);
        assertThat(answerFor(3).get("t")).isEqualTo("tres");
        assertThat(Json.parseObject(bodies.poll()).keySet()).containsExactly("v");
    }

    @Test
    void deskdsOwnFactsRefuseBeforeAnythingGoesOut() throws Exception {
        tcall(1, "maia", HelperModel.TOOL, args("hi"));
        Map<String, Object> maia = answerFor(1);
        assertThat(maia).containsEntry("code", "forbidden");
        assertThat(details(maia)).containsEntry("reason", "maia");
        guild = true;
        tcall(2, "research", HelperModel.TOOL, args("hi"));
        assertThat(details(answerFor(2))).containsEntry("reason", "guild_desk");
        guild = false;
        rig.band = com.minimalistalliance.desk.deskd.platform.AgeBand.Band.TEEN;
        tcall(3, "research", HelperModel.CREDITS, null);
        assertThat(details(answerFor(3))).containsEntry("reason", "teen");
        rig.band = com.minimalistalliance.desk.deskd.platform.AgeBand.Band.ADULT;
        configured.set(false);
        tcall(4, "research", HelperModel.TOOL, args("hi"));
        assertThat(details(answerFor(4))).containsEntry("reason", "no_service");
        configured.set(true);
        Map<String, Object> extra = args("hi");
        extra.put("model", "claude-opus-5-5");
        tcall(5, "research", HelperModel.TOOL, extra);
        assertThat(details(answerFor(5))).containsEntry("reason", "field");
        tcall(6, "research", HelperModel.CREDITS, m("note", "x"));
        assertThat(details(answerFor(6))).containsEntry("reason", "field");
        tcall(7, "research", HelperModel.TOOL, null);
        assertThat(answerFor(7)).containsEntry("code", "bad_request");
        tcall(8, "", HelperModel.TOOL, args("hi"));
        assertThat(details(answerFor(8))).containsEntry("reason", "agentId");
        assertThat(bodies).isEmpty();
    }

    @Test
    void theServicesRefusalsComeBackWithTheirCodeAndOnlyTheirKnownDetails() throws Exception {
        script.set(body -> new String[] {"429", "{\"error\":{\"code\":\"limit\",\"message\":\"The credits are used up for now.\","
                + "\"details\":{\"reason\":\"limit_lighter\",\"resetsAt\":\"2026-11-16T00:00:00.000Z\",\"window\":\"day\","
                + "\"model\":\"claude-haiku-5-5\"}}}"});
        tcall(1, "research", HelperModel.TOOL, args("hi"));
        Map<String, Object> terr = answerFor(1);
        assertThat(terr).containsEntry("code", "limit");
        assertThat(details(terr)).containsEntry("reason", "limit_lighter").containsEntry("window", "day")
                .containsEntry("resetsAt", "2026-11-16T00:00:00.000Z").doesNotContainKey("model");
    }

    @Test
    void theToolsHelloSaysHelpersWhileTheServiceIsConfigured() throws Exception {
        ToolHost host = new ToolHost(rig.clock, agentId -> Caller.THE_OWNER, () -> false, () -> true);
        rig.module.hostTools(host);
        rig.agent.drop();
        assertThat((Map<String, Object>) helloAfter().get("p")).containsEntry("helpers", Map.of("model", true));
        configured.set(false);
        rig.agent.drop();
        assertThat((Map<String, Object>) helloAfter().get("p")).doesNotContainKey("helpers");
    }

    private Map<String, Object> helloAfter() throws InterruptedException {
        while (true) {
            Map<String, Object> req = rig.agent.requests.poll(10, TimeUnit.SECONDS);
            assertThat(req).as("a tools hello").isNotNull();
            if (ToolHost.HELLO.equals(req.get("m"))) {
                rig.agent.reply(((Number) req.get("id")).longValue(), Map.of());
                return req;
            }
        }
    }

    @Test
    void nothingOfACallOrItsAnswerIsLogged() throws Exception {
        Logger root = (Logger) LoggerFactory.getLogger(org.slf4j.Logger.ROOT_LOGGER_NAME);
        ListAppender<ILoggingEvent> appender = new ListAppender<>();
        appender.start();
        root.addAppender(appender);
        try {
            script.set(body -> new String[] {"200", "{\"v\":1,\"text\":\"" + SECRET + "\",\"stopReason\":\"end_turn\"}"});
            tcall(1, "research", HelperModel.TOOL, args(SECRET));
            assertThat(answerFor(1).get("t")).isEqualTo("tres");
        } finally {
            root.detachAppender(appender);
        }
        for (ILoggingEvent e : appender.list) {
            assertThat(e.getFormattedMessage()).doesNotContain(SECRET).doesNotContain("secret-key-that-must-not-be-logged");
        }
    }
}
