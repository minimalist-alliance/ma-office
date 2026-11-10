package com.minimalistalliance.desk.deskd.agent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.platform.AccountDefaults;
import com.minimalistalliance.desk.deskd.platform.ModelPrices;
import com.minimalistalliance.desk.deskd.platform.PlatformHttp;
import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.testing.FakePlatform;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.stream.Stream;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.junit.jupiter.api.io.TempDir;

/**
 * deskd's relay against the real desk-agent jar, on real Unix sockets, with a stand-in for Anthropic's model list on
 * loopback: methods, the topic, and a key through the KEY frame to desk-agent's key check and back. No real key or
 * provider. {@code verify} skips it unless {@code DESK_AGENT_JAR} names desk-agent's jar (services/CLAUDE.md, Commands).
 */
@EnabledIfEnvironmentVariable(named = "DESK_AGENT_JAR", matches = ".+")
class RealDeskAgentIT {

    /** A stand-in's key, in Anthropic's shape. Nothing real. */
    private static final String KEY = "sk-ant-api03-stand-in-key-0001";

    @TempDir
    Path dir;

    private HttpServer provider;
    /** Every request the stand-in had: each provider's URL points at it, so nothing here reaches a real one. */
    private final AtomicInteger providerRequests = new AtomicInteger();
    private Process deskAgent;
    private AgentRig rig;

    @BeforeEach
    void setUp() throws Exception {
        provider = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
        provider.createContext("/", exchange -> {
            providerRequests.incrementAndGet();
            boolean ok = KEY.equals(exchange.getRequestHeaders().getFirst("x-api-key"))
                    && exchange.getRequestURI().getPath().endsWith("/v1/models");
            byte[] body = (ok
                    ? "{\"data\":[{\"id\":\"claude-sonnet-5-5\",\"display_name\":\"Claude Sonnet 5.5\"}],\"has_more\":false}"
                    : "{\"type\":\"error\",\"error\":{\"type\":\"authentication_error\"}}").getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("content-type", "application/json");
            exchange.sendResponseHeaders(ok ? 200 : 401, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        provider.start();
        Files.createDirectories(dir.resolve("agent-data"));
        int uid = (Integer) Files.getAttribute(Path.of("/proc/self"), "unix:uid");
        List<String> command = new ArrayList<>(List.of(
                Path.of(System.getProperty("java.home"), "bin", "java").toString(),
                "-jar", System.getenv("DESK_AGENT_JAR"),
                "--desk.agent.socket=" + dir.resolve("agent.sock"),
                "--desk.agent.admin.socket=" + dir.resolve("agent-admin.sock"),
                "--desk.agent.data.dir=" + dir.resolve("agent-data"),
                "--desk.agent.peer.uid=" + uid));
        command.addAll(providerUrls());
        deskAgent = new ProcessBuilder(command).redirectErrorStream(true).redirectOutput(dir.resolve("desk-agent.log").toFile()).start();
        await().atMost(Duration.ofSeconds(60)).until(() -> Files.exists(dir.resolve("agent.sock")) || !deskAgent.isAlive());
        assertThat(deskAgent.isAlive()).as("desk-agent started").isTrue();
        rig = new AgentRig(dir, false);
        await().atMost(Duration.ofSeconds(10)).until(() -> rig.module.link().isConnected());
    }

    @AfterEach
    void tearDown() throws Exception {
        if (rig != null) {
            rig.close();
        }
        if (deskAgent != null) {
            deskAgent.destroy();
            deskAgent.waitFor();
        }
        if (provider != null) {
            provider.stop(0);
        }
    }

    @Test
    void theRealDeskAgentAnswersThroughTheRelay() throws Exception {
        TestClient client = rig.connect("a");

        assertThat(rig.call(client, "agent.providers", Map.of()).toString()).contains("anthropic");
        assertThat(rig.call(client, "agent.list", Map.of()).toString()).contains("manager").contains("no_key");

        client.subscribe(AgentModule.STATE_TOPIC, null);
        Map<String, Object> snapshot = client.nextJson(Channels.EVENTS, FrameKind.EVT);
        assertThat(snapshot).containsEntry("type", "snapshot");
        assertThat(snapshot.toString()).contains("manager");

        // An Anthropic key picked as OpenAI's is refused on its prefix, and goes to no provider.
        Map<String, Object> mismatch = rig.call(client, "agent.key.add", Map.of("provider", "openai", "label", "Wrong", "secret", KEY));
        assertThat(mismatch).containsEntry("code", "bad_request");
        assertThat(mismatch.get("details")).isEqualTo(Map.of("reason", "key_malformed", "detail", "provider_mismatch"));
        assertThat(providerRequests.get()).isZero();

        Map<String, Object> refused = rig.call(client, "agent.key.add",
                Map.of("provider", "anthropic", "label", "Wrong", "secret", "sk-ant-api03-not-the-stand-in-key"));
        assertThat(refused).containsEntry("code", "precondition_failed");
        assertThat(refused.toString()).contains("key_refused");

        Map<String, Object> added = rig.call(client, "agent.key.add", Map.of("provider", "anthropic", "label", "Main", "secret", KEY));
        assertThat(added).containsEntry("_kind", "RES");
        assertThat(added.toString()).contains("keyId").doesNotContain(KEY);
        assertThat(rig.call(client, "agent.key.list", Map.of()).toString()).contains("Main").doesNotContain(KEY);
        assertThat(Files.readString(dir.resolve("desk-agent.log"))).doesNotContain(KEY);
    }

    @Test
    void aDeskAgentRestartIsSurvived() throws Exception {
        TestClient client = rig.connect("a");
        client.subscribe(AgentModule.STATE_TOPIC, null);
        assertThat(client.nextJson(Channels.EVENTS, FrameKind.EVT)).containsEntry("type", "snapshot");

        deskAgent.destroy();
        deskAgent.waitFor();
        await().until(() -> !rig.module.link().isConnected());
        assertThat(rig.call(client, "agent.list", Map.of())).containsEntry("code", "unavailable");
        startJar(System.getenv("DESK_AGENT_JAR"));

        Map<String, Object> again = client.nextJson(Channels.EVENTS, FrameKind.EVT);
        assertThat(again).containsEntry("type", "snapshot");
        assertThat(rig.call(client, "agent.list", Map.of())).containsEntry("_kind", "RES");
    }

    /** ADR 0042. Killed, not stopped, as a crash or a pulled plug gives no SIGTERM to clean up after. */
    @Test
    void aKeyAddedThroughTheRelaySurvivesARealRestart() throws Exception {
        TestClient client = rig.connect("a");
        Map<String, Object> added = rig.call(client, "agent.key.add", Map.of("provider", "anthropic", "label", "Main", "secret", KEY));
        assertThat(added).containsEntry("_kind", "RES");
        String keyId = (String) ((Map<?, ?>) added.get("key")).get("keyId");
        assertThat(rig.call(client, "agent.bind", Map.of("agentId", "manager", "keyId", keyId, "model", "claude-sonnet-5-5")))
                .containsEntry("_kind", "RES");
        assertThat(dir.resolve("agent-data/keys/" + keyId + ".sealed")).exists();

        deskAgent.destroyForcibly();
        deskAgent.waitFor();
        await().until(() -> !rig.module.link().isConnected());
        startJar(System.getenv("DESK_AGENT_JAR"));

        assertThat(rig.call(client, "agent.key.list", Map.of()).toString()).contains(keyId).contains("available=true");
        assertThat(rig.call(client, "agent.list", Map.of()).toString()).contains("status=online");
        // Nothing is cached after a restart, and the stand-in answers only this key.
        Map<String, Object> models = rig.call(client, "agent.key.models", Map.of("keyId", keyId));
        assertThat(models).containsEntry("_kind", "RES");
        assertThat(models.toString()).contains("claude-sonnet-5-5");

        try (Stream<Path> files = Files.walk(dir)) {
            for (Path file : files.filter(Files::isRegularFile).toList()) {
                assertThat(new String(Files.readAllBytes(file), StandardCharsets.ISO_8859_1)).as(file.toString()).doesNotContain(KEY);
            }
        }
    }

    /** ADR 0043 end to end: the fetch and the config, through the real socket, to what the real desk-agent says. */
    @Test
    void thePricesAndTheAccountsValuesReachTheRealDeskAgent() throws Exception {
        TestClient client = rig.connect("a");
        Map<String, Object> before = rig.call(client, "agent.limits.get", Map.of("agentId", "manager"));
        assertThat(before).containsEntry("_kind", "RES").containsEntry("pricesAsOf", "2026-11-06").containsEntry("timeZone", null);

        Files.createDirectories(dir.resolve("data"));
        AccountDefaults defaults = new AccountDefaults();
        try (FakePlatform platform = new FakePlatform(); PlatformHttp http = new PlatformHttp()) {
            platform.modelPricesReplies.add(FakePlatform.Reply.of(200,
                    "{\"version\":1,\"checked\":\"2027-01-02\",\"models\":{\"anthropic/claude-sonnet-5-5\":{\"input\":\"1\",\"output\":\"2\"}}}", "\"v1\""));
            ModelPrices prices = new ModelPrices(http, platform::url, dir.resolve("data"), new ModelPrices.Timing(
                    Duration.ZERO, Duration.ofHours(1), Duration.ZERO, Duration.ofHours(1), Duration.ofHours(1), Duration.ofSeconds(5)));
            rig.module.followPlatform(prices, defaults);
            prices.start();
            defaults.apply(Map.of("deskDay", Map.of("maxMicroUsd", 1_000_000), "timeZone", "America/Denver"));
            await().atMost(Duration.ofSeconds(10)).until(() -> {
                Map<String, Object> view = rig.call(client, "agent.limits.get", Map.of("agentId", "manager"));
                return "2027-01-02".equals(view.get("pricesAsOf")) && "America/Denver".equals(view.get("timeZone"));
            });
            prices.close();
        }
        assertThat(rig.module.link().isConnected()).isTrue();

        // An explicit null, through the client's frames, the relay and the real desk-agent: this desk's zone goes.
        Map<String, Object> set = new LinkedHashMap<>();
        set.put("agentId", "manager");
        set.put("timeZone", "Pacific/Auckland");
        assertThat(rig.call(client, "agent.limits.set", set)).containsEntry("timeZone", "Pacific/Auckland");
        set.put("timeZone", null);
        assertThat(rig.call(client, "agent.limits.set", set)).containsEntry("timeZone", "America/Denver");
        set.put("timeZone", "+05:00");
        assertThat(rig.call(client, "agent.limits.set", set)).containsEntry("code", "bad_request");
        assertThat(Files.readString(dir.resolve("desk-agent.log"))).doesNotContain("claude-sonnet-5-5");
    }

    /**
     * A rollout: a new deskd and an older desk-agent, real both. Its answer to a method it doesn't know is {@code not_found},
     * so the pushes are refused, and the link stays. Only with {@code DESK_AGENT_OLDER_JAR}.
     */
    @Test
    @EnabledIfEnvironmentVariable(named = "DESK_AGENT_OLDER_JAR", matches = ".+")
    void anOlderDeskAgentTakesThePushesWithoutDroppingTheLink() throws Exception {
        TestClient client = rig.connect("a");
        restartOn(System.getenv("DESK_AGENT_OLDER_JAR"));
        assertThat(rig.call(client, "agent.limits.get", Map.of("agentId", "manager"))).as("it's really an older one")
                .containsEntry("_kind", "RES").doesNotContainKey("pricesAsOf");

        rig.module.pushes().account(Map.of("timeZone", "America/Denver"));
        rig.module.pushes().prices(("{\"version\":1,\"models\":{\"a/b\":{\"input\":\"1\",\"output\":\"2\"}}}").getBytes(StandardCharsets.UTF_8));
        Thread.sleep(1000);

        assertThat(rig.module.link().isConnected()).isTrue();
        assertThat(rig.call(client, "agent.list", Map.of())).containsEntry("_kind", "RES");
        assertThat(Files.readString(dir.resolve("desk-agent.log"))).doesNotContain("connection dropped");
    }

    /**
     * A rollback, real both: an older desk-agent starts on what this one saved and enforces what was in force, and what it
     * saves counts as this desk's own when this one comes back. Only with {@code DESK_AGENT_OLDER_JAR}.
     */
    @Test
    @EnabledIfEnvironmentVariable(named = "DESK_AGENT_OLDER_JAR", matches = ".+")
    void aRollbackToAnOlderDeskAgentAndBackKeepsItsFooting() throws Exception {
        TestClient client = rig.connect("a");
        Map<String, Object> view = rig.call(client, "agent.limits.get", Map.of("agentId", "manager"));
        Map<String, Object> policy = wholePolicy(view);
        policy.put("deskDay", Map.of("maxMicroUsd", 5));
        policy.put("deskMonth", null);
        Map<String, Object> set = new LinkedHashMap<>();
        set.put("agentId", "manager");
        set.put("policy", policy);
        set.put("timeZone", "America/Denver");
        view = rig.call(client, "agent.limits.set", set);
        assertThat(view).containsEntry("timeZone", "America/Denver");

        restartOn(System.getenv("DESK_AGENT_OLDER_JAR"));
        view = rig.call(client, "agent.limits.get", Map.of("agentId", "manager"));
        assertThat(view).containsEntry("_kind", "RES").doesNotContainKey("timeZone");
        Map<String, Object> older = wholePolicy(view);
        assertThat(older.get("deskMonth").toString()).as("the default that was in force").contains("20000000");
        older.put("deskMonth", Map.of("maxMicroUsd", 7_000_000));
        Map<String, Object> onOlder = new LinkedHashMap<>();
        onOlder.put("agentId", "manager");
        onOlder.put("policy", older);
        assertThat(rig.call(client, "agent.limits.set", onOlder)).containsEntry("_kind", "RES");

        restartOn(System.getenv("DESK_AGENT_JAR"));
        view = rig.call(client, "agent.limits.get", Map.of("agentId", "manager"));
        assertThat(view).containsEntry("_kind", "RES");
        assertThat(view.get("desk").toString()).contains("deskMonth={maxMicroUsd=7000000").contains("deskDay=null");
    }

    /** The view's policy, as a client sends one back. */
    @SuppressWarnings("unchecked")
    private static Map<String, Object> wholePolicy(Map<String, Object> view) {
        return new LinkedHashMap<>((Map<String, Object>) view.get("policy"));
    }

    private void restartOn(String jar) throws Exception {
        deskAgent.destroy();
        deskAgent.waitFor();
        await().atMost(Duration.ofSeconds(10)).until(() -> !rig.module.link().isConnected());
        startJar(jar);
    }

    private List<String> providerUrls() {
        String url = "http://127.0.0.1:" + provider.getAddress().getPort();
        return List.of("--desk.agent.anthropic.url=" + url, "--desk.agent.openai.url=" + url, "--desk.agent.xai.url=" + url);
    }

    /** Starts desk-agent again on the same sockets and data. */
    private void startJar(String jar) throws IOException {
        int uid = (Integer) Files.getAttribute(Path.of("/proc/self"), "unix:uid");
        List<String> command = new ArrayList<>(List.of(
                Path.of(System.getProperty("java.home"), "bin", "java").toString(),
                "-jar", jar,
                "--desk.agent.socket=" + dir.resolve("agent.sock"),
                "--desk.agent.admin.socket=" + dir.resolve("agent-admin.sock"),
                "--desk.agent.data.dir=" + dir.resolve("agent-data"),
                "--desk.agent.peer.uid=" + uid));
        command.addAll(providerUrls());
        deskAgent = new ProcessBuilder(command).redirectErrorStream(true)
                .redirectOutput(ProcessBuilder.Redirect.appendTo(dir.resolve("desk-agent.log").toFile())).start();
        await().atMost(Duration.ofSeconds(60)).until(() -> rig.module.link().isConnected());
    }
}
