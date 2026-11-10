package com.minimalistalliance.desk.deskd.agent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.platform.AgeBand;
import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;

/**
 * The Agent app off for teens (ma-platform age rules, section 3.2): every {@code agent.*} method and topic answers for the
 * owner's band before anything reaches desk-agent, and a refused key leaves nothing behind.
 */
@ExtendWith(OutputCaptureExtension.class)
class AgentAgeBandTest {

    private static final String MARKER = "zebra-marker";
    private static final String SECRET = "sk-ant-api03-" + MARKER + "-key-0042";
    private static final Map<String, Object> KEY_PARAMS = Map.of("provider", "anthropic", "label", "Main", "secret", SECRET);
    private static final String CONVERSATION = "agent.conversation:manager";

    @TempDir
    Path dir;

    private AgentRig rig;

    @BeforeEach
    void setUp() throws Exception {
        rig = new AgentRig(dir);
    }

    @AfterEach
    void tearDown() throws Exception {
        rig.close();
    }

    private static List<String> everyMethod() {
        List<String> all = new ArrayList<>(AgentMethods.READS);
        all.addAll(AgentMethods.MUTATIONS);
        return all;
    }

    private static Map<String, Object> paramsFor(String method) {
        return method.equals(AgentMethods.KEY_ADD) ? KEY_PARAMS : Map.of("agentId", "manager");
    }

    private void assertNothingReachedDeskAgent() {
        assertThat(rig.agent.requests).isEmpty();
        assertThat(rig.agent.keys).isEmpty();
        assertThat(rig.agent.received).noneMatch(message -> "req".equals(message.get("t")));
    }

    @Test
    void everyMethodIsForbiddenForATeenAndNothingReachesDeskAgent() throws Exception {
        rig.band = AgeBand.Band.TEEN;
        TestClient client = rig.connect("a");
        for (String method : everyMethod()) {
            assertThat(rig.call(client, method, paramsFor(method)))
                    .as(method)
                    .containsEntry("_kind", "ERR")
                    .containsEntry("code", "forbidden")
                    .containsEntry("details", Map.of("reason", "age_band"));
        }
        assertNothingReachedDeskAgent();
    }

    @Test
    void everyMethodIsUnavailableWhileUnknownAndSaysNothingWasDone() throws Exception {
        rig.band = null;
        TestClient client = rig.connect("a");
        for (String method : everyMethod()) {
            assertThat(rig.call(client, method, paramsFor(method)))
                    .as(method)
                    .containsEntry("_kind", "ERR")
                    .containsEntry("code", "unavailable")
                    .containsEntry("details", Map.of("reason", "age_band"));
        }
        assertNothingReachedDeskAgent();
    }

    @Test
    void anAdultsCallsGoThroughAsBefore() throws Exception {
        rig.agent.handlers.put("agent.list", params -> Map.of("agents", List.of()));
        rig.agent.handlers.put(AgentMethods.KEY_ADD, head -> Map.of("key", Map.of("keyId", "k1")));
        TestClient client = rig.connect("a");
        assertThat(rig.call(client, "agent.list", Map.of())).containsEntry("_kind", "RES");
        assertThat(rig.call(client, AgentMethods.KEY_ADD, KEY_PARAMS)).containsEntry("_kind", "RES");
        assertThat(new String(rig.agent.keys.take().key(), StandardCharsets.US_ASCII)).isEqualTo(SECRET);
    }

    @Test
    void theSameKeyRunsTheCallOnceTheBandIsKnown() throws Exception {
        rig.band = null;
        rig.agent.handlers.put("agent.update", params -> Map.of("agent", Map.of("id", "manager")));
        TestClient client = rig.connect("a");
        String idem = "01890f6e-1111-7000-8000-000000000001";
        assertThat(rig.call(client, "agent.update", Map.of("agentId", "manager"), idem)).containsEntry("code", "unavailable");
        rig.band = AgeBand.Band.ADULT;
        assertThat(rig.call(client, "agent.update", Map.of("agentId", "manager"), idem)).containsEntry("_kind", "RES");
    }

    @Test
    void anExportSessionStillHearsAboutItsScopeFirst() throws Exception {
        rig.band = AgeBand.Band.TEEN;
        TestClient export = rig.connect("a", "export");
        assertThat(rig.call(export, "agent.list", Map.of()))
                .containsEntry("code", "forbidden")
                .containsEntry("details", Map.of("reason", "scope"));
    }

    // ---- the key

    @Test
    void aTeensKeyNeverGetsAsFarAsACopyAndIsntLogged(CapturedOutput output) throws Exception {
        rig.band = AgeBand.Band.TEEN;
        TestClient client = rig.connect("a");
        assertThat(rig.call(client, AgentMethods.KEY_ADD, KEY_PARAMS))
                .containsEntry("code", "forbidden")
                .containsEntry("details", Map.of("reason", "age_band"));
        // Malformed says nothing different: the band comes first.
        assertThat(rig.call(client, AgentMethods.KEY_ADD, Map.of("provider", "anthropic", "label", "Main", "secret", "short")))
                .containsEntry("code", "forbidden");
        assertThat(rig.agent.keys).isEmpty();
        assertThat(output.getAll()).doesNotContain(MARKER);
    }

    @Test
    void aKeyAlreadyReadWhenTheBandChangesIsZeroedAndNotSent() {
        rig.band = AgeBand.Band.TEEN;
        byte[] secret = SECRET.getBytes(StandardCharsets.US_ASCII);
        // No context: the band refuses it before anything would use one.
        assertThatThrownBy(() -> rig.module.methods().sendKey(null, KEY_PARAMS, secret))
                .isInstanceOfSatisfying(RpcException.class, e -> {
                    assertThat(e.code()).isEqualTo(RpcException.FORBIDDEN);
                    assertThat(e.details()).containsEntry("reason", "age_band");
                });
        assertThat(secret).containsOnly((byte) 0);
        assertThat(rig.agent.keys).isEmpty();
    }

    @Test
    void aKeyAlreadyReadWhenTheBandIsUnknownIsZeroedToo() {
        rig.band = null;
        byte[] secret = SECRET.getBytes(StandardCharsets.US_ASCII);
        assertThatThrownBy(() -> rig.module.methods().sendKey(null, KEY_PARAMS, secret))
                .isInstanceOfSatisfying(RpcException.class, e -> assertThat(e.code()).isEqualTo(RpcException.UNAVAILABLE));
        assertThat(secret).containsOnly((byte) 0);
    }

    // ---- topics

    @Test
    void aSubIsRefusedForATeenAndNothingReachesDeskAgent() throws Exception {
        rig.band = AgeBand.Band.TEEN;
        TestClient client = rig.connect("a");
        for (String topic : List.of(AgentModule.STATE_TOPIC, CONVERSATION)) {
            assertThat(client.subscribe(topic, null))
                    .as(topic)
                    .containsEntry("code", "forbidden")
                    .containsEntry("details", Map.of("reason", "age_band"));
        }
        // deskd's own agent.state for the heartbeat is the only one that goes to desk-agent's socket.
        assertThat(rig.agent.received)
                .noneMatch(message -> "req".equals(message.get("t"))
                        || "sub".equals(message.get("t")) && !AgentModule.STATE_TOPIC.equals(message.get("topic")));
        assertThat(rig.agent.received.stream().filter(message -> "sub".equals(message.get("t")))).hasSizeLessThanOrEqualTo(1);
    }

    @Test
    void aSubIsUnavailableWhileUnknown() throws Exception {
        rig.band = null;
        TestClient client = rig.connect("a");
        assertThat(client.subscribe(CONVERSATION, null))
                .containsEntry("code", "unavailable")
                .containsEntry("details", Map.of("reason", "age_band"));
        assertThat(rig.agent.subscribers(CONVERSATION)).isZero();
    }

    @Test
    void becomingTeenEndsWhatsSubscribedAndLetsGoOfDeskAgentsSide() throws Exception {
        rig.agent.snapshots.put(CONVERSATION, () -> Map.of("messages", List.of()));
        TestClient client = rig.connect("a");
        assertThat(client.subscribe(CONVERSATION, null)).containsEntry("_kind", "RES");
        assertThat(client.nextJson(Channels.EVENTS, FrameKind.EVT)).containsEntry("type", "snapshot");
        await().until(() -> rig.agent.subscribers(CONVERSATION) == 1);

        rig.band = AgeBand.Band.TEEN;
        rig.module.topics().endForTeen();

        assertThat(client.nextJson(Channels.EVENTS, FrameKind.EVT))
                .containsEntry("type", "error")
                .containsEntry("data", Map.of("code", "forbidden"));
        await().until(() -> rig.agent.subscribers(CONVERSATION) == 0);
        assertThat(rig.module.relayedForTest()).isEmpty();
        // And it can't come straight back.
        assertThat(client.subscribe(CONVERSATION, null)).containsEntry("code", "forbidden");
    }
}
