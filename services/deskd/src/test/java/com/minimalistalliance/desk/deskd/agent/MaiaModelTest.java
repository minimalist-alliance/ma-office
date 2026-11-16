package com.minimalistalliance.desk.deskd.agent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import ch.qos.logback.classic.Level;
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
import java.util.ArrayList;
import java.util.Base64;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.CountDownLatch;
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
 * Desk Maia's model through deskd (API.md §23, "Her model"), with a fake desk-agent on a real socket and a stand-in for her
 * service on loopback: a {@code maia_model} {@code tcall} reaches the service, never the tool host, with deskd's proof over
 * the exact body; each of deskd's own refusals comes before anything goes out; the service's refusals come back with their
 * code and details; the size and concurrency caps; the tools' hello offers her model while the service is configured, and
 * again when it first appears; nothing of a call reaches a log.
 */
@SuppressWarnings("unchecked")
class MaiaModelTest {

    private static final String MAIA_ID = "maia.staging.minimalistalliance.com";
    private static final String SECRET = "words from the member's desk that must never be logged";

    @TempDir
    Path dir;

    private AgentRig rig;
    private HttpServer server;
    private PlatformHttp http;
    private final ConcurrentLinkedQueue<byte[]> bodies = new ConcurrentLinkedQueue<>();
    private final ConcurrentLinkedQueue<String> proofs = new ConcurrentLinkedQueue<>();
    private final AtomicReference<Function<byte[], String[]>> script = new AtomicReference<>();
    private final AtomicBoolean configured = new AtomicBoolean(true);
    private volatile boolean guild;
    private volatile boolean free;
    private volatile CountDownLatch hold;

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
        rig.module.maiaModel(new MaiaModel(client, () -> guild, () -> rig.band
                == com.minimalistalliance.desk.deskd.platform.AgeBand.Band.ADULT, () -> free));
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
        proofs.add(exchange.getRequestHeaders().getFirst("x-ma-desk-auth"));
        CountDownLatch wait = hold;
        if (wait != null) {
            try {
                wait.await(10, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
        Function<byte[], String[]> step = script.get();
        String[] reply = step == null ? new String[] {"200", "{\"v\":1,\"text\":\"On it.\",\"stopReason\":\"end_turn\","
                + "\"usage\":{\"inputTokens\":12,\"outputTokens\":3},\"costMicroUsd\":900,\"costCredits\":1.84,"
                + "\"allowance\":{\"fraction\":0.62,\"resetsAt\":\"2026-12-01T07:00:00Z\",\"credits\":{\"month\":2500,"
                + "\"monthLeft\":1550,\"week\":800,\"weekUsed\":120,\"day\":200,\"dayUsed\":90,\"topUpLeft\":0,"
                + "\"drawingFrom\":\"month\"},\"lighter\":false}}"} : step.apply(body);
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
        return m("task", "turn", "callId", "0192f1c4-7a1e-7b3c-9d2e-5f6a7b8c9d0e", "context", "Now: Saturday.",
                "messages", List.of(m("role", "user", "text", text)), "tools", List.of(), "maxOutputTokens", 4000);
    }

    private void tcall(long id, String agentId, Object args) {
        Map<String, Object> call = m("t", "tcall", "id", id, "runId", "r-1", "agentId", agentId, "tool",
                MaiaModel.TOOL, "taint", List.of());
        if (args != null) {
            call.put("args", args);
        }
        rig.agent.sendJson(call);
    }

    /** Answers that came before the one a test waited for. */
    private final Map<Long, Map<String, Object>> early = new java.util.HashMap<>();

    /** The tres or terr for this call, in whatever order they come. */
    private Map<String, Object> answerFor(long id) throws InterruptedException {
        Map<String, Object> kept = early.remove(id);
        if (kept != null) {
            return kept;
        }
        while (true) {
            Map<String, Object> m = rig.agent.received.poll(15, TimeUnit.SECONDS);
            assertThat(m).as("an answer to " + id).isNotNull();
            if ("tres".equals(m.get("t")) || "terr".equals(m.get("t"))) {
                long got = ((Number) m.get("id")).longValue();
                if (got == id) {
                    return m;
                }
                early.put(got, m);
            }
        }
    }

    private static Map<String, Object> details(Map<String, Object> terr) {
        return (Map<String, Object>) terr.get("details");
    }

    @Test
    void herCallGoesToHerServiceWithAProofOverTheExactBodyAndItsAnswerComesBack() throws Exception {
        tcall(1, "maia", args("Compare three laptops"));
        Map<String, Object> tres = answerFor(1);
        assertThat(tres.get("t")).as(String.valueOf(tres)).isEqualTo("tres");
        Map<String, Object> r = (Map<String, Object>) tres.get("r");
        assertThat(r).containsEntry("text", "On it.").containsEntry("stopReason", "end_turn");
        // Contract 0.4.8's fields come through as they came: deskd reads none of them.
        assertThat(r).containsEntry("costCredits", 1.84);
        assertThat((Map<String, Object>) r.get("allowance")).containsEntry("lighter", false)
                .extractingByKey("credits").asInstanceOf(org.assertj.core.api.InstanceOfAssertFactories.MAP)
                .containsEntry("drawingFrom", "month");
        byte[] body = bodies.poll();
        Map<String, Object> sent = Json.parseObject(body);
        // "v": 1 first, then her request as she made it: nothing added, nothing taken.
        assertThat(new String(body, StandardCharsets.UTF_8)).startsWith("{\"v\":1,");
        assertThat(sent.keySet()).containsExactly("v", "task", "callId", "context", "messages", "tools", "maxOutputTokens");
        assertThat(sent).containsEntry("task", "turn").containsEntry("context", "Now: Saturday.");
        Map<String, Object> proof = Json.parseObject(Base64.getUrlDecoder().decode(proofs.poll()));
        Map<String, Object> headers = (Map<String, Object>) proof.get("headers");
        assertThat(headers).containsEntry("x-ma-maia-id", MAIA_ID).containsEntry("x-ma-body-sha256",
                HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(body)));
        // Never the tool host: none is set, and the call was answered anyway.
        assertThat(rig.agent.requests).isEmpty();
        // Contract 0.4.6: her note (the lines that change on every call) goes as she made it, after the other fields.
        Map<String, Object> noted = args("Compare three laptops");
        noted.put("note", "Now: Saturday 1:05 PM.\nBriefs left today: 3.");
        tcall(2, "maia", noted);
        assertThat(answerFor(2).get("t")).isEqualTo("tres");
        Map<String, Object> withNote = Json.parseObject(bodies.poll());
        assertThat(withNote.keySet()).containsExactly("v", "task", "callId", "context", "messages", "tools",
                "maxOutputTokens", "note");
        assertThat(withNote).containsEntry("note", "Now: Saturday 1:05 PM.\nBriefs left today: 3.");
        // Contract 0.4.8: her request asks for credits (`units`), relayed as she made it.
        Map<String, Object> units = args("Compare three laptops");
        units.put("units", "credits");
        tcall(3, "maia", units);
        assertThat(answerFor(3).get("t")).isEqualTo("tres");
        Map<String, Object> withUnits = Json.parseObject(bodies.poll());
        assertThat(withUnits.keySet()).containsExactly("v", "task", "callId", "context", "messages", "tools",
                "maxOutputTokens", "units");
        assertThat(withUnits).containsEntry("units", "credits");
    }

    @Test
    void deskdsOwnFactsRefuseBeforeAnythingGoesOut() throws Exception {
        tcall(1, "manager", args("hi"));
        assertThat(details(answerFor(1))).containsEntry("reason", "not_maia");
        guild = true;
        tcall(2, "maia", args("hi"));
        Map<String, Object> g = answerFor(2);
        assertThat(g).containsEntry("code", "forbidden");
        assertThat(details(g)).containsEntry("reason", "guild_desk");
        guild = false;
        rig.band = com.minimalistalliance.desk.deskd.platform.AgeBand.Band.TEEN;
        tcall(3, "maia", args("hi"));
        assertThat(details(answerFor(3))).containsEntry("reason", "teen");
        rig.band = null;
        tcall(4, "maia", args("hi"));
        assertThat(details(answerFor(4))).as("an unknown band isn't an adult's").containsEntry("reason", "teen");
        rig.band = com.minimalistalliance.desk.deskd.platform.AgeBand.Band.ADULT;
        free = true;
        tcall(5, "maia", args("hi"));
        assertThat(details(answerFor(5))).containsEntry("reason", "free");
        free = false;
        configured.set(false);
        tcall(6, "maia", args("hi"));
        Map<String, Object> none = answerFor(6);
        assertThat(none).containsEntry("code", "unavailable");
        assertThat(details(none)).containsEntry("reason", "no_service");
        configured.set(true);
        tcall(7, "maia", null);
        assertThat(answerFor(7)).containsEntry("code", "bad_request");
        tcall(8, "maia", List.of("not", "an", "object"));
        assertThat(answerFor(8)).containsEntry("code", "bad_request");
        Map<String, Object> extra = args("hi");
        extra.put("model", "claude-opus-5");
        tcall(9, "maia", extra);
        Map<String, Object> field = answerFor(9);
        assertThat(field).containsEntry("code", "bad_request");
        assertThat(details(field)).containsEntry("reason", "field");
        Map<String, Object> v = args("hi");
        v.put("v", 2);
        tcall(10, "maia", v);
        assertThat(answerFor(10)).containsEntry("code", "bad_request");
        assertThat(bodies).as("nothing went out").isEmpty();
        // With no relay wired at all, deskd says so.
        rig.module.maiaModel(null);
        tcall(11, "maia", args("hi"));
        assertThat(details(answerFor(11))).containsEntry("reason", "no_service");
    }

    @Test
    void theServicesRefusalsComeBackWithTheirCodeAndOnlyTheirKnownDetails() throws Exception {
        script.set(body -> new String[] {"429", "{\"error\":{\"code\":\"limit\",\"message\":\"x\",\"details\":"
                + "{\"reason\":\"limit_personal\",\"resetsAt\":\"2026-11-15T07:00:00.000Z\",\"window\":\"day\","
                + "\"spentMicroUsd\":1234,\"model\":\"secret-model\"}}}"});
        tcall(1, "maia", args("hi"));
        Map<String, Object> limit = answerFor(1);
        assertThat(limit).containsEntry("t", "terr").containsEntry("code", "limit");
        assertThat(details(limit)).containsOnlyKeys("reason", "resetsAt", "window")
                .containsEntry("reason", "limit_personal").containsEntry("window", "day")
                .containsEntry("resetsAt", "2026-11-15T07:00:00.000Z");
        script.set(body -> new String[] {"429", "{\"error\":{\"code\":\"rate_limited\",\"details\":{\"retryAfterSec\":12.2}}}"});
        tcall(2, "maia", args("hi"));
        Map<String, Object> rate = answerFor(2);
        assertThat(rate).containsEntry("code", "rate_limited");
        assertThat(((Number) details(rate).get("retryAfterSec")).longValue()).isEqualTo(13L);
        script.set(body -> new String[] {"503", "{\"error\":{\"code\":\"unavailable\",\"details\":{\"reason\":\"provider\"}}}"});
        tcall(3, "maia", args("hi"));
        assertThat(details(answerFor(3))).containsEntry("reason", "provider");
        script.set(body -> new String[] {"413", "{\"error\":{\"code\":\"too_large\",\"details\":{\"reason\":\"input\"}}}"});
        tcall(4, "maia", args("hi"));
        assertThat(answerFor(4)).containsEntry("code", "too_large");
        // Details out of shape are dropped, not passed on.
        script.set(body -> new String[] {"429", "{\"error\":{\"code\":\"limit\",\"details\":{\"reason\":\"Limit Personal!\","
                + "\"resetsAt\":\"tomorrow\",\"window\":\"year\",\"retryAfterSec\":-1}}}"});
        tcall(5, "maia", args("hi"));
        assertThat(details(answerFor(5))).isEmpty();
        script.set(body -> new String[] {"502", "<html>bad gateway</html>"});
        tcall(6, "maia", args("hi"));
        Map<String, Object> gone = answerFor(6);
        assertThat(gone).containsEntry("code", "unavailable");
        assertThat(details(gone)).containsEntry("reason", "unreachable");
    }

    @Test
    void aBodyOverThreeMiBIsRefusedAndAtMostFourCallsGoAtOnce() throws Exception {
        tcall(1, "maia", args("x".repeat(MaiaModel.MAX_ARGS_BYTES)));
        Map<String, Object> big = answerFor(1);
        assertThat(big).containsEntry("code", "too_large");
        assertThat(details(big)).containsEntry("reason", "body");
        assertThat(bodies).isEmpty();

        hold = new CountDownLatch(1);
        for (long id = 10; id < 10 + MaiaModel.AT_ONCE; id++) {
            tcall(id, "maia", args("hi " + id));
        }
        await().atMost(Duration.ofSeconds(10)).until(() -> bodies.size() == MaiaModel.AT_ONCE);
        tcall(20, "maia", args("one too many"));
        Map<String, Object> fifth = answerFor(20);
        assertThat(fifth).containsEntry("code", "rate_limited");
        hold.countDown();
        List<Map<String, Object>> done = new ArrayList<>();
        for (long id = 10; id < 10 + MaiaModel.AT_ONCE; id++) {
            done.add(answerFor(id));
        }
        assertThat(done).allSatisfy(a -> assertThat(a).containsEntry("t", "tres"));
        hold = null;
        // A slot freed: the next one goes.
        tcall(21, "maia", args("again"));
        assertThat(answerFor(21)).containsEntry("t", "tres");
    }

    @Test
    void theToolsHelloOffersHerModelWhileTheServiceIsConfiguredAndAgainWhenItAppears() throws Exception {
        ToolHost host = new ToolHost(rig.clock, agentId -> Caller.THE_OWNER, () -> false, () -> true);
        rig.module.hostTools(host);
        configured.set(false);
        rig.agent.drop();
        Map<String, Object> first = helloAfter();
        assertThat((Map<String, Object>) first.get("p")).doesNotContainKey("maia");
        // The config names the service: the hello goes again on the same connection.
        configured.set(true);
        rig.module.maiaServiceChanged();
        Map<String, Object> second = helloAfter();
        assertThat((Map<String, Object>) second.get("p")).containsEntry("maia", Map.of("model", true))
                .containsKey("tools");
        // Nothing changed: no third hello.
        rig.module.maiaServiceChanged();
        long until = System.nanoTime() + Duration.ofMillis(500).toNanos();
        while (System.nanoTime() < until) {
            Map<String, Object> req = rig.agent.requests.poll(50, TimeUnit.MILLISECONDS);
            assertThat(req == null ? null : req.get("m")).isNotEqualTo(ToolHost.HELLO);
        }
        // A new connection says it from the start.
        rig.agent.drop();
        assertThat((Map<String, Object>) helloAfter().get("p")).containsEntry("maia", Map.of("model", true));
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
        Level was = root.getLevel();
        ListAppender<ILoggingEvent> logs = new ListAppender<>();
        logs.start();
        root.addAppender(logs);
        root.setLevel(Level.TRACE);
        try {
            script.set(body -> new String[] {"200", "{\"v\":1,\"text\":\"" + SECRET + "\"}"});
            tcall(1, "maia", args(SECRET));
            answerFor(1);
            script.set(body -> new String[] {"429", "{\"error\":{\"code\":\"limit\",\"message\":\"" + SECRET + "\"}}"});
            tcall(2, "maia", args(SECRET));
            answerFor(2);
            tcall(3, "manager", args(SECRET));
            answerFor(3);
        } finally {
            root.detachAppender(logs);
            root.setLevel(was);
        }
        String all = logs.list.stream().map(ILoggingEvent::getFormattedMessage).reduce("", String::concat);
        assertThat(all).doesNotContain(SECRET).doesNotContain("secret-key-that-must-not-be-logged")
                .doesNotContain("session-token-x").doesNotContain("AWS4-HMAC");
    }
}
