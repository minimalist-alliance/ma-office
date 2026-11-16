package com.minimalistalliance.desk.deskd.agent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.session.SessionGrant;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import com.minimalistalliance.desk.deskd.tools.HostedCall;
import com.minimalistalliance.desk.deskd.tools.HostedDecls;
import com.minimalistalliance.desk.deskd.tools.HostedTool;
import com.minimalistalliance.desk.deskd.tools.RunLedger;
import com.minimalistalliance.desk.deskd.tools.ToolHost;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.junit.jupiter.api.io.TempDir;

/**
 * An agent's access and the setup gate end to end (draft ADR "the Agent's tools and approvals", section 16): deskd's
 * relay and its own record against the real desk-agent jar, on real Unix sockets, with a stand-in for Anthropic's model
 * list on loopback. The gate refuses a run before the member's save, the save goes only from a session that may act,
 * both sides keep it across a restart, deskd's hello makes desk-agent ask the member again for what deskd doesn't hold,
 * and the tools deskd runs go by deskd's record. {@code verify} skips it unless {@code DESK_AGENT_JAR} names
 * desk-agent's jar (services/CLAUDE.md, Commands).
 */
@EnabledIfEnvironmentVariable(named = "DESK_AGENT_JAR", matches = ".+")
class RealDeskAgentAccessIT {

    /** A stand-in's key, in Anthropic's shape. Nothing real. */
    private static final String KEY = "sk-ant-api03-stand-in-key-0002";

    @TempDir
    Path dir;

    private HttpServer provider;
    private Process deskAgent;
    private AgentRig rig;

    @BeforeEach
    void setUp() throws Exception {
        provider = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
        provider.createContext("/", exchange -> {
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
        Files.createDirectories(dir.resolve("desk-data"));
        startJar(false);
        rig = new AgentRig(dir, false);
        rig.module.keepAccessIn(dir.resolve("desk-data"));
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

    private static Map<String, Object> m(Object... pairs) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (int i = 0; i < pairs.length; i += 2) {
            map.put((String) pairs[i], pairs[i + 1]);
        }
        return map;
    }

    private static Map<String, Object> save(boolean files) {
        return m("agentId", "manager", "apps", m("notebook", true, "files", files, "browser", true, "courier", false,
                "todos", true), "auto", m("notebook", null, "files", null, "todos", false));
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> agent(TestClient client) throws Exception {
        Map<String, Object> got = rig.call(client, "agent.get", Map.of("agentId", "manager"));
        assertThat(got).containsEntry("_kind", "RES");
        return (Map<String, Object>) got.get("agent");
    }

    @Test
    void theGateTheSaveAndDeskdsOwnRecordWithTheRealDeskAgent() throws Exception {
        TestClient owner = rig.connect("a");
        Map<String, Object> added = rig.call(owner, "agent.key.add", Map.of("provider", "anthropic", "label", "Main",
                "secret", KEY));
        String keyId = (String) ((Map<?, ?>) added.get("key")).get("keyId");
        assertThat(rig.call(owner, "agent.bind", Map.of("agentId", "manager", "keyId", keyId, "model",
                "claude-sonnet-5-5"))).containsEntry("_kind", "RES");

        // A new desk's lead waits for its screen: the real desk-agent refuses the run, before any model call.
        assertThat(agent(owner)).containsEntry("setup", "new");
        Map<String, Object> early = rig.call(owner, "agent.message.send", Map.of("agentId", "manager", "text", "Hi"));
        assertThat(early).containsEntry("code", "precondition_failed");
        assertThat(early.get("details")).isEqualTo(Map.of("reason", "setup"));

        // A session without input can't save it, and the real desk-agent never hears.
        String fingerprint = String.format("%02x", 2 + 16).repeat(32);
        TestClient viewer = rig.connect("v", new SessionGrant("user-1", "sid-v", "owner", fingerprint, true, false,
                Instant.now(), Instant.now().plus(Duration.ofHours(1))));
        assertThat(rig.call(viewer, "agent.access.set", save(true))).containsEntry("code", "forbidden");
        assertThat(agent(owner)).containsEntry("setup", "new");

        // The owner's save: chosen in desk-agent, recorded by deskd, Files off in both.
        Map<String, Object> saved = rig.call(owner, "agent.access.set", save(false));
        assertThat(saved).containsEntry("_kind", "RES");
        assertThat(((Map<?, ?>) saved.get("access")).get("chosen")).isEqualTo(true);
        assertThat(agent(owner)).containsEntry("setup", null);
        AccessRecord record = rig.module.accessRecord();
        assertThat(record.refusal("manager", HostedDecls.NOTEBOOK)).isNull();
        assertThat(record.refusal("manager", HostedDecls.FILES)).isEqualTo("scope");
        // desk-agent's own validation, through the relay: a switch for an app that's off.
        Map<String, Object> wrong = rig.call(owner, "agent.access.set", m("agentId", "manager", "auto",
                m("files", m("folder", "Lead"))));
        assertThat(wrong).containsEntry("code", "bad_request");
        assertThat(record.entry("manager").filesFolder()).isNull();

        // The run goes now: past the gate, to the stand-in, which answers no chat, so the reply fails there.
        assertThat(rig.call(owner, "agent.message.send", Map.of("agentId", "manager", "text", "Hi")))
                .containsEntry("_kind", "RES");

        // deskd's tools, wired as DataPlaneConfiguration does: from the next connection its hello names what it holds.
        ToolHost host = new ToolHost(Clock.systemUTC(), ToolHost.ownerOnly(), () -> false, () -> true);
        host.agentApps(record);
        host.area(HostedDecls.FILES, new Plain()).area(HostedDecls.NOTEBOOK, new Plain());
        rig.module.hostTools(host);

        // deskd loses its record (a restore without its file): at desk-agent's next connection the hello says it holds
        // nothing, and the real desk-agent has the member confirm the screen again.
        record.forget("manager");
        deskAgent.destroy();
        deskAgent.waitFor();
        await().until(() -> !rig.module.link().isConnected());
        startJar(true);
        await().atMost(Duration.ofSeconds(15)).until(() -> "confirm".equals(agent(owner).get("setup")));
        Map<String, Object> waiting = rig.call(owner, "agent.message.send", Map.of("agentId", "manager", "text", "Hi"));
        assertThat(waiting.get("details")).isEqualTo(Map.of("reason", "setup"));
        // What the member chose is kept for the screen, never more.
        @SuppressWarnings("unchecked")
        Map<String, Object> kept = (Map<String, Object>) ((Map<String, Object>) rig.call(owner, "agent.access.get",
                Map.of("agentId", "manager")).get("access")).get("apps");
        assertThat(kept).containsEntry("files", false).containsEntry("notebook", true);
        assertThat(rig.call(owner, "agent.access.set", save(false))).containsEntry("_kind", "RES");
        assertThat(agent(owner)).containsEntry("setup", null);
        assertThat(record.recorded()).containsExactly("manager");

        // Both sides keep it across a restart of each.
        AccessRecord reread = new AccessRecord(Clock.systemUTC());
        reread.keepIn(dir.resolve("desk-data"));
        assertThat(reread.recorded()).containsExactly("manager");
        deskAgent.destroyForcibly();
        deskAgent.waitFor();
        await().until(() -> !rig.module.link().isConnected());
        startJar(true);
        assertThat(agent(owner)).containsEntry("setup", null);
        assertThat(Files.readString(dir.resolve("desk-agent.log"))).doesNotContain(KEY);
    }

    /** An area that answers every call plainly. */
    private static final class Plain implements HostedTool {
        @Override
        public Look look(HostedCall call, RunLedger.Run run) {
            return Look.plain(call.args(), Map.of("kind", "test"));
        }

        @Override
        public Result run(HostedCall call, RunLedger.Run run) {
            return Result.of(Map.of("ok", true));
        }
    }

    private List<String> providerUrls() {
        String url = "http://127.0.0.1:" + provider.getAddress().getPort();
        return List.of("--desk.agent.anthropic.url=" + url, "--desk.agent.openai.url=" + url,
                "--desk.agent.xai.url=" + url);
    }

    /** Starts the real desk-agent, on the same sockets and data each time. */
    private void startJar(boolean waitForLink) throws IOException {
        int uid = (Integer) Files.getAttribute(Path.of("/proc/self"), "unix:uid");
        List<String> command = new ArrayList<>(List.of(
                Path.of(System.getProperty("java.home"), "bin", "java").toString(),
                "-jar", System.getenv("DESK_AGENT_JAR"),
                "--desk.agent.socket=" + dir.resolve("agent.sock"),
                "--desk.agent.admin.socket=" + dir.resolve("agent-admin.sock"),
                "--desk.agent.data.dir=" + dir.resolve("agent-data"),
                "--desk.agent.peer.uid=" + uid));
        command.addAll(providerUrls());
        deskAgent = new ProcessBuilder(command).redirectErrorStream(true)
                .redirectOutput(ProcessBuilder.Redirect.appendTo(dir.resolve("desk-agent.log").toFile())).start();
        if (waitForLink) {
            await().atMost(Duration.ofSeconds(60)).until(() -> rig.module.link().isConnected());
        } else {
            await().atMost(Duration.ofSeconds(60)).until(() -> Files.exists(dir.resolve("agent.sock"))
                    || !deskAgent.isAlive());
            assertThat(deskAgent.isAlive()).as("desk-agent started").isTrue();
        }
    }
}
