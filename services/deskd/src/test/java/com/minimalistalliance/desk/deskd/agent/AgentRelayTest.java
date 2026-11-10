package com.minimalistalliance.desk.deskd.agent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.testing.FakeAgentSocket;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The relay of {@code agent.*} (API.md section 11), from a client's frames to a fake desk-agent's socket and back, on
 * real Unix sockets.
 */
class AgentRelayTest {

    private static final String SECRET = "sk-ant-api03-fake-key-for-tests-only";

    @TempDir
    Path dir;

    private AgentRig rig;

    @AfterEach
    void tearDown() throws Exception {
        if (rig != null) {
            rig.close();
        }
    }

    private AgentRig rig() throws Exception {
        rig = new AgentRig(dir);
        return rig;
    }

    @Test
    void aReadGoesToDeskAgentAsItCameAndItsResultComesBack() throws Exception {
        AgentRig r = rig();
        r.agent.handlers.put("agent.thread.get", p -> Map.of("agentId", p.get("agentId"), "messages", List.of(), "seq", 4));
        TestClient client = r.connect("a");

        Map<String, Object> reply = r.call(client, "agent.thread.get", Map.of("agentId", "manager", "extra", List.of(1, 2)));

        assertThat(reply).containsEntry("_kind", "RES").containsEntry("agentId", "manager").containsEntry("seq", 4);
        Map<String, Object> req = r.agent.next("req");
        assertThat(req).containsEntry("m", "agent.thread.get");
        assertThat(req.get("p")).isEqualTo(Map.of("agentId", "manager", "extra", List.of(1, 2)));
    }

    @Test
    void everyMethodOfTheInterfaceIsRelayed() throws Exception {
        AgentRig r = rig();
        List<String> all = new ArrayList<>(AgentMethods.READS);
        all.addAll(AgentMethods.MUTATIONS);
        all.remove(AgentMethods.KEY_ADD);
        for (String method : all) {
            r.agent.handlers.put(method, p -> Map.of("method", method));
        }
        TestClient client = r.connect("a");
        for (String method : all) {
            assertThat(r.call(client, method, Map.of())).as(method).containsEntry("_kind", "RES").containsEntry("method", method);
        }
        assertThat(all).as("task 49 added 15 methods to the 15 before, S-118 four more").hasSize(34);
    }

    @Test
    void deskAgentsErrorComesBackWithItsCodeAndDetails() throws Exception {
        AgentRig r = rig();
        TestClient client = r.connect("a");
        long id = r.send(client, "agent.message.send", Map.of("agentId", "manager", "text", "hi"), UUID.randomUUID().toString());
        Map<String, Object> req = r.agent.requests.take();
        r.agent.error(((Number) req.get("id")).longValue(), "precondition_failed", Map.of("reason", "limit_reached", "scope", "agent_day"));

        Map<String, Object> reply = client.nextReply();

        assertThat(reply).containsEntry("_id", id).containsEntry("_kind", "ERR").containsEntry("code", "precondition_failed");
        assertThat(reply.get("details")).isEqualTo(Map.of("reason", "limit_reached", "scope", "agent_day"));
    }

    @Test
    void aCodeDeskdDoesntHaveIsInternal() throws Exception {
        AgentRig r = rig();
        TestClient client = r.connect("a");
        long id = r.send(client, "agent.list", Map.of(), null);
        Map<String, Object> req = r.agent.requests.take();
        r.agent.error(((Number) req.get("id")).longValue(), "teapot", Map.of("reason", "x"));

        Map<String, Object> reply = client.nextReply();

        assertThat(reply).containsEntry("_id", id).containsEntry("code", "internal").containsEntry("message", "Internal error");
        assertThat(reply.get("details")).isEqualTo(Map.of());
    }

    @Test
    void aMutationNeedsIdemAndARepeatIsntSentTwice() throws Exception {
        AgentRig r = rig();
        r.agent.handlers.put("agent.seen", p -> Map.of());
        r.agent.handlers.put("agent.update", p -> Map.of("agent", Map.of("id", "manager")));
        TestClient client = r.connect("a");

        assertThat(r.call(client, "agent.update", Map.of("agentId", "manager"), null)).containsEntry("code", "bad_request");
        String idem = UUID.randomUUID().toString();
        Map<String, Object> first = r.call(client, "agent.update", Map.of("agentId", "manager", "name", "M"), idem);
        Map<String, Object> again = r.call(client, "agent.update", Map.of("agentId", "manager", "name", "M"), idem);
        r.call(client, "agent.seen", Map.of("agentId", "manager"));

        assertThat(first).containsEntry("_kind", "RES");
        assertThat(again.get("agent")).isEqualTo(first.get("agent"));
        List<Object> methods = new ArrayList<>();
        r.agent.received.stream().filter(m -> "req".equals(m.get("t"))).forEach(m -> methods.add(m.get("m")));
        assertThat(methods).containsExactly("agent.update", "agent.seen");
    }

    @Test
    void aKeyGoesInAKeyFrameWithTheDesksIdAndNeverInJson() throws Exception {
        AgentRig r = rig();
        r.agent.handlers.put("agent.key.add", head -> Map.of("key", Map.of("keyId", "k1", "last4", "only")));
        TestClient client = r.connect("a");

        Map<String, Object> reply = r.call(client, "agent.key.add", Map.of("provider", "anthropic", "label", "Main", "secret", SECRET));

        assertThat(reply).containsEntry("_kind", "RES");
        FakeAgentSocket.KeyFrame frame = r.agent.keys.take();
        assertThat(new String(frame.key(), StandardCharsets.US_ASCII)).isEqualTo(SECRET);
        assertThat(frame.head()).containsEntry("m", "agent.key.add");
        assertThat(frame.head().get("p")).isEqualTo(Map.of("provider", "anthropic", "label", "Main", "deskId", "d-test"));
        assertThat(r.agent.received).noneMatch(m -> m.toString().contains(SECRET));
    }

    @Test
    void aKeyThatIsntAKeysShapeIsRefusedHere() throws Exception {
        AgentRig r = rig();
        TestClient client = r.connect("a");
        Map<String, Object> malformed = Map.of("reason", "key_malformed", "detail", "format");
        for (Object secret : new Object[] {"short", "sk-ant has a space", "sk-ant-tab\there", "sk-ant-é-accent-x", "x".repeat(1025), 42}) {
            Map<String, Object> params = new LinkedHashMap<>();
            params.put("provider", "anthropic");
            params.put("label", "Main");
            params.put("secret", secret);
            Map<String, Object> reply = r.call(client, "agent.key.add", params);
            assertThat(reply).containsEntry("code", "bad_request");
            assertThat(reply.get("details")).isEqualTo(malformed);
        }
        assertThat(r.agent.keys).isEmpty();
        assertThat(r.agent.received).noneMatch(m -> "req".equals(m.get("t")));
    }

    @Test
    void withNoDeskAgentACallIsUnavailable() throws Exception {
        rig = new AgentRig(dir, false);
        TestClient client = rig.connect("a");

        Map<String, Object> reply = rig.call(client, "agent.list", Map.of());

        assertThat(reply).containsEntry("code", "unavailable");
        assertThat(reply.get("details")).isEqualTo(Map.of("reason", "unavailable"));
        assertThat(rig.module.health()).containsEntry("agent", "waiting");
    }

    @Test
    void withNoDeskAgentAWriteSaysNothingChangedAndTheSameKeyRunsOnceItsBack() throws Exception {
        rig = new AgentRig(dir, false);
        TestClient client = rig.connect("a");
        String update = UUID.randomUUID().toString();
        String key = UUID.randomUUID().toString();
        Map<String, Object> keyParams = Map.of("provider", "anthropic", "label", "Main", "secret", SECRET);

        // Nothing reached a desk-agent, so it's unavailable with no mayHaveApplied: the Agent isn't there, and nothing changed.
        for (Map<String, Object> reply : List.of(
                rig.call(client, "agent.update", Map.of("agentId", "manager", "name", "M"), update),
                rig.call(client, "agent.key.add", keyParams, key),
                rig.call(client, "agent.create", Map.of("name", "x")))) {
            assertThat(reply).containsEntry("_kind", "ERR").containsEntry("code", "unavailable");
            assertThat(reply.get("details")).isEqualTo(Map.of("reason", "unavailable"));
        }

        // So the same key isn't kept on that answer: once desk-agent is up, it runs.
        try (FakeAgentSocket agent = new FakeAgentSocket(rig.agentSocket)) {
            agent.handlers.put("agent.update", p -> Map.of("agent", Map.of("id", "manager", "name", "M")));
            agent.handlers.put("agent.key.add", head -> Map.of("key", Map.of("keyId", "k1", "last4", "only")));
            await().until(() -> rig.module.link().isConnected());
            assertThat(rig.call(client, "agent.update", Map.of("agentId", "manager", "name", "M"), update)).containsEntry("_kind", "RES");
            assertThat(rig.call(client, "agent.key.add", keyParams, key)).containsEntry("_kind", "RES");
            assertThat(agent.keys).hasSize(1);
        }
    }

    @Test
    void onlyOwnerTokensMayCallOrSubscribe() throws Exception {
        AgentRig r = rig();
        r.agent.handlers.put("agent.list", p -> Map.of("agents", List.of()));
        TestClient support = r.connect("s", "support");

        assertThat(r.call(support, "agent.list", Map.of())).containsEntry("code", "forbidden");
        assertThat(support.subscribe(AgentModule.STATE_TOPIC, null)).containsEntry("code", "forbidden");
        assertThat(r.agent.received).noneMatch(m -> "req".equals(m.get("t")));
        assertThat(r.module.relayedForTest()).isEmpty();
    }

    /** Task 32's export scope takes the owner's data away, and never reaches their agents. */
    @Test
    void anExportSessionIsRefusedEveryAgentMethodAndTopic() throws Exception {
        AgentRig r = rig();
        for (String method : AgentMethods.READS) {
            r.agent.handlers.put(method, p -> Map.of());
        }
        TestClient export = r.connect("e", "export");
        List<String> methods = new ArrayList<>(AgentMethods.READS);
        methods.addAll(AgentMethods.MUTATIONS);
        for (String method : methods) {
            Map<String, Object> reply = r.call(export, method, Map.of("agentId", "a1", "secret", "sk-test-0123456789"));
            assertThat(reply).as(method).containsEntry("_kind", "ERR").containsEntry("code", "forbidden");
            assertThat(reply.get("details")).as(method).isEqualTo(Map.of("reason", "scope"));
        }
        for (String topic : List.of(AgentModule.STATE_TOPIC, AgentModule.CONVERSATION_TOPIC + "a1")) {
            Map<String, Object> reply = export.subscribe(topic, null);
            assertThat(reply).as(topic).containsEntry("code", "forbidden");
            assertThat(reply.get("details")).as(topic).isEqualTo(Map.of("reason", "scope"));
        }
        // deskd's own subscription to agent.state, for the heartbeat, is there whoever connects.
        assertThat(r.agent.received).noneMatch(m -> "req".equals(m.get("t"))
                || "sub".equals(m.get("t")) && !AgentModule.STATE_TOPIC.equals(m.get("topic")));
        assertThat(r.agent.keys).isEmpty();
        assertThat(r.module.relayedForTest()).isEmpty();
    }

    @Test
    void aCancelReachesDeskAgent() throws Exception {
        AgentRig r = rig();
        TestClient client = r.connect("a");
        long id = r.send(client, "agent.key.models", Map.of("keyId", "k1"), null);
        long relayed = ((Number) r.agent.requests.take().get("id")).longValue();

        client.send(Channels.RPC, FrameKind.CANCEL, id, 0, new byte[0]);

        assertThat(client.nextReply()).containsEntry("code", "cancelled");
        assertThat(((Number) r.agent.next("cancel").get("id")).longValue()).isEqualTo(relayed);
    }

    @Test
    void aTopicIsRelayedOnceForEverySessionAndLetGoWhenNobodyWantsIt() throws Exception {
        AgentRig r = rig();
        List<Map<String, Object>> messages = new ArrayList<>(List.of(Map.of("id", "m1", "text", "hello")));
        r.agent.snapshots.put("agent.conversation:manager", () -> Map.of("messages", List.copyOf(messages)));
        TestClient a = r.connect("a");
        TestClient b = r.connect("b");

        Map<String, Object> subA = a.subscribe("agent.conversation:manager", null);
        assertThat(a.nextJson(Channels.EVENTS, FrameKind.EVT)).containsEntry("type", "snapshot")
                .extracting("data").isEqualTo(Map.of("messages", List.of(Map.of("id", "m1", "text", "hello"))));
        messages.add(Map.of("id", "m2", "text", "again"));
        Map<String, Object> subB = b.subscribe("agent.conversation:manager", null);
        assertThat(b.nextJson(Channels.EVENTS, FrameKind.EVT)).containsEntry("type", "snapshot")
                .extracting("data").extracting("messages").asList().hasSize(2);
        await().until(() -> r.agent.subscribers("agent.conversation:manager") == 1);

        r.agent.publish("agent.conversation:manager", "delta", Map.of("messageId", "m3", "runId", "r", "text", "Hi"));
        assertThat(a.nextJson(Channels.EVENTS, FrameKind.EVT)).containsEntry("type", "delta")
                .extracting("data").isEqualTo(Map.of("messageId", "m3", "runId", "r", "text", "Hi"));
        assertThat(b.nextJson(Channels.EVENTS, FrameKind.EVT)).containsEntry("type", "delta");

        unsubscribe(a, subA);
        await().during(Duration.ofMillis(200)).until(() -> r.agent.subscribers("agent.conversation:manager") == 1);
        unsubscribe(b, subB);
        await().until(() -> r.agent.subscribers("agent.conversation:manager") == 0);
        await().until(() -> r.module.relayedForTest().isEmpty());
    }

    @Test
    void anUnknownTopicEndsTheSubscription() throws Exception {
        AgentRig r = rig();
        TestClient client = r.connect("a");

        client.subscribe("agent.conversation:nobody", null);

        Map<String, Object> event = client.nextJson(Channels.EVENTS, FrameKind.EVT);
        assertThat(event).containsEntry("type", "error");
        assertThat(client.subscribe("agent.conversation:bad id", null)).containsEntry("code", "not_found");
        assertThat(client.subscribe("agent.state:x", null)).containsEntry("code", "not_found");
    }

    /**
     * A desk-agent from before snapshots were cut sends {@code too_large} in place of a long thread's snapshot, and keeps
     * the subscription. That isn't an agent that doesn't exist: the topic starts empty, says older messages exist, and
     * carries on.
     */
    @Test
    void aSnapshotTooLargeForDeskAgentToSendStillStartsTheTopic() throws Exception {
        AgentRig r = rig();
        r.agent.snapshotErrors.put("agent.conversation:manager", "too_large");
        TestClient client = r.connect("a");

        assertThat(client.subscribe("agent.conversation:manager", null)).containsEntry("_kind", "RES");
        Map<String, Object> first = client.nextJson(Channels.EVENTS, FrameKind.EVT);
        assertThat(first).containsEntry("type", "snapshot");
        assertThat(first.get("data")).isEqualTo(Map.of("messages", List.of(), "older", true));

        r.agent.publish("agent.conversation:manager", "message", Map.of("message", Map.of("id", "m9", "text", "next")));
        assertThat(client.nextJson(Channels.EVENTS, FrameKind.EVT)).containsEntry("type", "message");
        assertThat(r.module.relayedForTest()).containsExactly("agent.conversation:manager");
    }

    @Test
    void afterDeskAgentRestartsSubscribersGetAFreshSnapshot() throws Exception {
        AgentRig r = rig();
        List<String> names = new ArrayList<>(List.of("before"));
        r.agent.snapshots.put("agent.state", () -> Map.of("agents", List.of(Map.of("id", "manager", "name", names.getLast()))));
        TestClient client = r.connect("a");
        client.subscribe("agent.state", null);
        assertThat(client.nextJson(Channels.EVENTS, FrameKind.EVT)).containsEntry("type", "snapshot");

        names.add("after");
        int before = r.agent.connections();
        r.agent.drop();
        await().until(() -> r.agent.connections() > before && r.module.link().isConnected());

        Map<String, Object> event = client.nextJson(Channels.EVENTS, FrameKind.EVT);
        assertThat(event).containsEntry("type", "snapshot");
        assertThat(event.toString()).contains("after");
    }

    @Test
    void theHeartbeatSaysBusyWhileAnAgentWorksAndOfflineWithoutDeskAgent() throws Exception {
        AgentRig r = rig();
        r.agent.snapshots.put("agent.state", () -> Map.of("agents", List.of(Map.of("id", "manager", "status", "online"))));
        r.agent.drop();
        await().until(() -> r.agent.subscribers("agent.state") == 1);
        await().until(() -> "online".equals(r.module.heartbeatFields().get("status")));

        r.agent.publish("agent.state", "snapshot", Map.of("agents", List.of(Map.of("id", "manager", "status", "working"))));
        await().until(() -> "busy".equals(r.module.heartbeatFields().get("status")));
        Map<String, Object> busy = r.module.heartbeatFields();
        assertThat(busy).containsEntry("activeTasks", 1).containsEntry("busyUntil", "2026-11-06T10:10:00Z")
                .containsEntry("lastActivityAt", "2026-11-06T10:00:00Z").containsEntry("lastLlmCallAt", null);

        r.clock.advance(Duration.ofSeconds(30));
        r.agent.publish("agent.state", "snapshot", Map.of("agents", List.of(Map.of("id", "manager", "status", "online"))));
        await().until(() -> "online".equals(r.module.heartbeatFields().get("status")));
        assertThat(r.module.heartbeatFields()).containsEntry("activeTasks", 0).containsEntry("busyUntil", null)
                .containsEntry("lastLlmCallAt", "2026-11-06T10:00:30Z");

        r.agent.close();
        await().until(() -> "offline".equals(r.module.heartbeatFields().get("status")));
    }

    @Test
    void aDeltaTooLargeForAnEventArrivesInPieces() throws Exception {
        AgentRig r = rig();
        r.agent.snapshots.put("agent.conversation:manager", () -> Map.of("messages", List.of()));
        TestClient client = r.connect("a");
        client.subscribe("agent.conversation:manager", null);
        client.nextJson(Channels.EVENTS, FrameKind.EVT);
        String text = "x".repeat(100_000);

        r.agent.publish("agent.conversation:manager", "delta", Map.of("messageId", "m", "runId", "r", "text", text));

        StringBuilder joined = new StringBuilder();
        while (joined.length() < text.length()) {
            Map<String, Object> event = client.nextJson(Channels.EVENTS, FrameKind.EVT);
            @SuppressWarnings("unchecked")
            Map<String, Object> data = (Map<String, Object>) event.get("data");
            joined.append(data.get("text"));
        }
        assertThat(joined.toString()).isEqualTo(text);
    }

    private static void unsubscribe(TestClient client, Map<String, Object> sub) throws Exception {
        client.sendJson(Channels.RPC, FrameKind.UNSUB, 900 + ((Number) sub.get("subId")).longValue(), Map.of("subId", sub.get("subId")));
        assertThat(client.nextReply()).containsEntry("_kind", "RES");
    }
}
