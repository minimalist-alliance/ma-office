package com.minimalistalliance.desk.agent;

import static com.minimalistalliance.desk.agent.testing.AgentSocketClient.ascii;
import static com.minimalistalliance.desk.agent.testing.AgentSocketClient.map;
import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.agent.json.Json;
import com.minimalistalliance.desk.agent.limits.Pricing;
import com.minimalistalliance.desk.agent.provider.ProviderId;
import com.minimalistalliance.desk.agent.provider.Usage;
import com.minimalistalliance.desk.agent.socket.PeerCheck;
import com.minimalistalliance.desk.agent.store.AgentStore;
import com.minimalistalliance.desk.agent.testing.AgentSocketClient;
import com.minimalistalliance.desk.agent.testing.FakeLlmServer;
import com.minimalistalliance.desk.agent.testing.Health;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.stream.Stream;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.context.ConfigurableApplicationContext;

/**
 * Task 07's {@code agent.*} interface end to end, as deskd will relay it: the real application, its agent socket, and
 * the real Anthropic and OpenAI adapters against a local stand-in for both. No real key and no network.
 */
@ExtendWith(OutputCaptureExtension.class)
class DeskAgentSocketTests {

    @TempDir
    Path dir;

    private FakeLlmServer llm;
    private ConfigurableApplicationContext context;
    private AgentSocketClient desk;

    @BeforeEach
    void boot() throws Exception {
        llm = new FakeLlmServer();
        context = start(PeerCheck.ownUid());
        desk = new AgentSocketClient(dir.resolve("agent.sock"));
    }

    private ConfigurableApplicationContext start(int peerUid) throws Exception {
        Files.createDirectories(dir.resolve("data"));
        return DeskAgentApplication.application().run(
                "--desk.agent.data.dir=" + dir.resolve("data"),
                "--desk.agent.admin.socket=" + dir.resolve("admin.sock"),
                "--desk.agent.socket=" + dir.resolve("agent.sock"),
                "--desk.agent.peer.uid=" + peerUid,
                "--desk.agent.anthropic.url=" + llm.url(),
                "--desk.agent.openai.url=" + llm.url(),
                "--desk.agent.xai.url=" + llm.url());
    }

    @AfterEach
    void stop() throws Exception {
        desk.close();
        context.close();
        llm.close();
    }

    @Test
    void theAgentAppsWholeFlow(CapturedOutput output) throws Exception {
        assertThat(result(desk.call("agent.providers", Map.of())).get("providers")).asList()
                .extracting(p -> map(p).get("id")).containsExactly("anthropic", "openai", "xai");
        Map<String, Object> manager = agent(result(desk.call("agent.list", Map.of())));
        assertThat(manager).containsEntry("id", "manager").containsEntry("role", "manager")
                .containsEntry("status", "no_key").containsEntry("binding", null).containsEntry("unseen", 0);

        desk.subscribe(1, "agent.state");
        assertThat(map(desk.event(1, "snapshot").get("data")).get("agents")).asList().hasSize(1);

        Map<String, Object> key = map(result(desk.addKey("anthropic", "Personal", ascii(FakeLlmServer.KEY))).get("key"));
        assertThat(key).containsEntry("provider", "anthropic").containsEntry("providerName", "Anthropic")
                .containsEntry("label", "Personal").containsEntry("last4", "cdef").containsEntry("createdByDesk", "d-test")
                .containsEntry("available", true);
        String keyId = (String) key.get("keyId");
        assertThat(dir.resolve("data/keys/" + keyId + ".sealed")).exists();
        assertThat(everyDataFile()).doesNotContain(FakeLlmServer.KEY);
        // The free model-list call checked it, with the key in Anthropic's header.
        assertThat(llm.requests).anySatisfy(r -> {
            assertThat(r.path()).isEqualTo("/v1/models");
            assertThat(r.apiKey()).isEqualTo(FakeLlmServer.KEY);
        });
        assertThat(result(desk.call("agent.key.list", Map.of())).get("keys")).asList().hasSize(1);

        List<Object> models = (List<Object>) result(desk.call("agent.key.models", Map.of("keyId", keyId))).get("models");
        assertThat(models).contains(
                Map.of("id", "claude-sonnet-5-5", "label", "Claude Sonnet 5.5",
                        "inputMicroUsdPerMTok", 2_000_000, "outputMicroUsdPerMTok", 10_000_000));
        assertThat(models).anySatisfy(m -> assertThat(map(m)).containsEntry("id", "some-new-model")
                .containsEntry("inputMicroUsdPerMTok", null));

        Map<String, Object> bound = map(result(desk.call("agent.bind",
                Map.of("agentId", "manager", "keyId", keyId, "model", "claude-sonnet-5-5"))).get("agent"));
        assertThat(bound).containsEntry("status", "online");
        assertThat(map(bound.get("binding"))).containsEntry("providerName", "Anthropic")
                .containsEntry("model", "claude-sonnet-5-5");

        desk.subscribe(2, "agent.conversation:manager");
        assertThat(map(desk.event(2, "snapshot").get("data")).get("messages")).asList().isEmpty();

        Map<String, Object> sent = result(desk.call("agent.message.send", Map.of("agentId", "manager", "text", "Hello?")));
        Map<String, Object> user = map(map(desk.event(2, "message").get("data")).get("message"));
        assertThat(user).containsEntry("id", sent.get("messageId")).containsEntry("role", "user")
                .containsEntry("text", "Hello?");
        Map<String, Object> streaming = map(map(desk.event(2, "message").get("data")).get("message"));
        assertThat(streaming).containsEntry("role", "assistant").containsEntry("state", "streaming")
                .containsEntry("runId", sent.get("runId"));
        StringBuilder streamed = new StringBuilder();
        Map<String, Object> done;
        while (true) {
            Map<String, Object> event = desk.await(m -> "evt".equals(m.get("t")) && AgentSocketClient.number(m, "sid") == 2);
            Map<String, Object> data = map(event.get("data"));
            if ("delta".equals(event.get("type"))) {
                assertThat(data).containsEntry("messageId", streaming.get("id"));
                streamed.append(data.get("text"));
            } else if ("message".equals(event.get("type"))) {
                done = map(data.get("message"));
                break;
            }
        }
        assertThat(streamed.toString()).isEqualTo("Hello from the stand-in.");
        assertThat(done).containsEntry("id", streaming.get("id")).containsEntry("state", "done")
                .containsEntry("text", "Hello from the stand-in.").containsEntry("stopReason", "end_turn")
                .containsEntry("error", null)
                // 100 tokens in at $2 a million and 20 out at $10: 200 + 200 µ$, from the bundled pricing.json.
                .containsEntry("costMicroUsd", 400);
        assertThat(map(done.get("badge"))).isEqualTo(
                Map.of("provider", "anthropic", "providerName", "Anthropic", "model", "claude-sonnet-5-5"));
        assertThat(map(done.get("usage"))).containsEntry("inputTokens", 100).containsEntry("outputTokens", 20);

        Map<String, Object> thread = result(desk.call("agent.thread.get", Map.of("agentId", "manager")));
        assertThat(thread.get("messages")).asList().hasSize(2);
        assertThat(AgentSocketClient.number(thread, "seq")).isPositive();
        await().atMost(Duration.ofSeconds(5)).until(() -> unseen() == 1);
        desk.call("agent.seen", Map.of("agentId", "manager"));
        assertThat(unseen()).isZero();

        Map<String, Object> limits = result(desk.call("agent.limits.get", Map.of("agentId", "manager")));
        assertThat(map(map(limits.get("policy")).get("agentDay"))).containsEntry("maxMicroUsd", 5_000_000);
        assertThat(limits.get("usage")).asList().anySatisfy(u -> assertThat(map(u))
                .containsEntry("scope", "agent_day").containsEntry("spentMicroUsd", 400));

        Map<String, Object> audit = result(desk.call("agent.audit.list", Map.of("limit", 2)));
        assertThat(audit.get("entries")).asList().hasSize(2);
        assertThat(map(((List<?>) audit.get("entries")).get(0))).containsEntry("action", "llm.call")
                .containsEntry("decision", "ok").containsEntry("costMicroUsd", 400);
        assertThat((String) audit.get("headHash")).hasSize(64);
        assertThat(result(desk.call("agent.audit.list", Map.of())).get("entries")).asList()
                .anySatisfy(e -> assertThat(map(e)).containsEntry("action", "key.add").containsEntry("actor", "user"));
        assertThat(audit.get("nextBeforeSeq")).isNotNull();

        desk.call("agent.key.delete", Map.of("keyId", keyId));
        assertThat(dir.resolve("data/keys/" + keyId + ".sealed")).doesNotExist();
        assertThat(agent(result(desk.call("agent.list", Map.of())))).containsEntry("status", "no_key")
                .containsEntry("binding", null);
        assertThat(Health.get(dir.resolve("admin.sock"))).contains("\"deskd\":\"connected\"", "\"keys\":0");
        assertThat(output.getAll()).doesNotContain(FakeLlmServer.KEY, "Hello?", "Hello from the stand-in.");
    }

    /** Task 07's ask 3: send fails only for no_key, busy and limit_reached; a provider's failure ends the reply. */
    @Test
    void whatFailsTheSendAndWhatEndsTheReply() throws Exception {
        assertThat(desk.call("agent.message.send", Map.of("agentId", "manager", "text", "Hi")))
                .containsEntry("code", "precondition_failed").containsEntry("details", Map.of("reason", "no_key"));
        String keyId = keyAndBind("anthropic", "claude-sonnet-5-5");
        desk.subscribe(2, "agent.conversation:manager");
        desk.event(2, "snapshot");

        llm.then(FakeLlmServer.Reply.status(429));
        desk.call("agent.message.send", Map.of("agentId", "manager", "text", "One"));
        Map<String, Object> failed = finalReply();
        assertThat(failed).containsEntry("state", "failed").containsEntry("error", "provider_error")
                .containsEntry("errorDetail", "rate_limited");

        CountDownLatch hold = new CountDownLatch(1);
        llm.then(FakeLlmServer.anthropic("claude-sonnet-5-5", 10, 5, "Part", "ial").holdAfter(4, hold));
        Map<String, Object> run = result(desk.call("agent.message.send", Map.of("agentId", "manager", "text", "Two")));
        assertThat(llm.streaming.await(5, TimeUnit.SECONDS)).isTrue();
        assertThat(desk.call("agent.message.send", Map.of("agentId", "manager", "text", "Three")))
                .containsEntry("code", "conflict").containsEntry("details", Map.of("reason", "busy"));
        desk.call("agent.run.stop", Map.of("runId", run.get("runId")));
        Map<String, Object> stopped = finalReply();
        assertThat(stopped).containsEntry("state", "stopped").containsEntry("error", null);
        hold.countDown();

        Map<String, Object> policy = map(result(desk.call("agent.limits.get", Map.of("agentId", "manager"))).get("policy"));
        Map<String, Object> day = new java.util.HashMap<>();
        day.put("maxMicroUsd", 1);
        day.put("maxTokens", null);
        policy.put("agentDay", day);
        Map<String, Object> view = result(desk.call("agent.limits.set", Map.of("agentId", "manager", "policy", policy)));
        assertThat(map(map(view.get("policy")).get("agentDay"))).containsEntry("maxMicroUsd", 1);
        int before = ((List<?>) result(desk.call("agent.thread.get", Map.of("agentId", "manager"))).get("messages")).size();
        assertThat(desk.call("agent.message.send", Map.of("agentId", "manager", "text", "Four")))
                .containsEntry("code", "precondition_failed")
                .containsEntry("details", Map.of("reason", "limit_reached", "scope", "agent_day"));
        // Refused before anything was added to the thread.
        assertThat(result(desk.call("agent.thread.get", Map.of("agentId", "manager"))).get("messages")).asList()
                .hasSize(before);
        assertThat(agent(result(desk.call("agent.list", Map.of())))).containsEntry("status", "limit_reached")
                .containsEntry("statusDetail", "agent_day");
        assertThat(keyId).startsWith("k-");
    }

    @Test
    void keysAreCheckedBeforeTheyAreKept() throws Exception {
        assertThat(desk.addKey("anthropic", "Bad", ascii("sk-ant-not-the-right-key-00")))
                .containsEntry("code", "precondition_failed")
                .containsEntry("details", Map.of("reason", "key_refused", "detail", "auth"));
        assertThat(desk.addKey("anthropic", "Bad", ascii("sk-ant has a space")))
                .containsEntry("code", "bad_request")
                .containsEntry("details", Map.of("reason", "key_malformed", "detail", "format"));
        assertThat(desk.addKey("google", "Bad", ascii(FakeLlmServer.KEY)))
                .containsEntry("details", Map.of("reason", "key_malformed", "detail", "provider"));
        assertThat(result(desk.call("agent.key.list", Map.of())).get("keys")).asList().isEmpty();
        assertThat(desk.call("agent.create", Map.of("name", "<Writer>")))
                .containsEntry("code", "bad_request").containsEntry("details", Map.of("detail", "name"));
        assertThat(desk.call("agent.thread.get", Map.of("agentId", "nobody"))).containsEntry("code", "not_found");
    }

    /** A key entered under the wrong provider never leaves the desk: its prefix is checked before any call. */
    @Test
    void aKeyWithAnotherProvidersPrefixIsRefusedBeforeAnythingIsSent() throws Exception {
        String[][] wrong = {
                {"openai", "sk-ant-api03-fake-0123456789abcdef"},
                {"xai", "sk-ant-api03-fake-0123456789abcdef"},
                {"anthropic", "sk-proj-fake-0123456789abcdef"},
                {"xai", "sk-proj-fake-0123456789abcdef"},
                {"anthropic", "xai-fake-0123456789abcdef"},
                {"openai", "xai-fake-0123456789abcdef"}};
        for (String[] pair : wrong) {
            assertThat(desk.addKey(pair[0], "Wrong", ascii(pair[1]))).as(pair[0] + " with " + pair[1])
                    .containsEntry("code", "bad_request")
                    .containsEntry("details", Map.of("reason", "key_malformed", "detail", "provider_mismatch"));
        }
        assertThat(llm.requests).isEmpty();
        assertThat(result(desk.call("agent.key.list", Map.of())).get("keys")).asList().isEmpty();

        // Each provider's own shape, and one in nobody's, still goes to the provider's model list.
        llm.acceptedKey = FakeLlmServer.OPENAI_KEY;
        assertThat(result(desk.addKey("openai", "Mine", ascii(FakeLlmServer.OPENAI_KEY)))).containsKey("key");
        llm.acceptedKey = FakeLlmServer.XAI_KEY;
        assertThat(result(desk.addKey("xai", "Mine", ascii(FakeLlmServer.XAI_KEY)))).containsKey("key");
        assertThat(desk.addKey("anthropic", "Odd", ascii("no-known-prefix-0123456789"))).containsEntry("code", "precondition_failed");
        assertThat(llm.requests).hasSize(3);
    }

    /**
     * A thread longer than one frame or one RES keeps its topic, and pages through {@code agent.thread.get}. A control
     * character is 6 bytes of JSON, so 8 messages of them are past desk-agent's 4 MiB frame.
     */
    @Test
    void aLongThreadKeepsItsTopicAndComesInPages() throws Exception {
        keyAndBind("anthropic", "claude-sonnet-5-5");
        desk.subscribe(2, "agent.conversation:manager");
        desk.event(2, "snapshot");
        // With the digit in front, the 100,000 characters a message may have.
        String heavy = "\u0001".repeat(99_999);
        for (int i = 0; i < 8; i++) {
            result(desk.call("agent.message.send", Map.of("agentId", "manager", "text", i + heavy)));
            finalReply();
        }

        desk.subscribe(3, "agent.conversation:manager");
        Map<String, Object> first = desk.await(m -> "evt".equals(m.get("t")) && AgentSocketClient.number(m, "sid") == 3);
        assertThat(first).containsEntry("type", "snapshot");
        Map<String, Object> snapshot = map(first.get("data"));
        assertThat(snapshot).containsEntry("older", true);
        List<?> newest = (List<?>) snapshot.get("messages");
        assertThat(map(newest.get(newest.size() - 1))).containsEntry("role", "assistant").containsEntry("state", "done");
        assertThat(Json.bytes(snapshot).length).isLessThanOrEqualTo(1 << 20);

        List<Object> all = new ArrayList<>();
        Map<String, Object> page = result(desk.call("agent.thread.get", Map.of("agentId", "manager")));
        int pages = 1;
        while (true) {
            assertThat(Json.bytes(page).length).isLessThanOrEqualTo(1 << 20);
            List<?> messages = (List<?>) page.get("messages");
            assertThat(messages).isNotEmpty();
            all.addAll(0, messages);
            if (!Boolean.TRUE.equals(page.get("older"))) {
                break;
            }
            page = result(desk.call("agent.thread.get",
                    Map.of("agentId", "manager", "before", map(messages.get(0)).get("id"))));
            pages++;
        }
        assertThat(pages).isGreaterThan(2);
        assertThat(all).hasSize(16);
        for (int i = 0; i < 8; i++) {
            assertThat(map(all.get(2 * i))).containsEntry("role", "user").containsEntry("text", i + heavy);
            assertThat(map(all.get(2 * i + 1))).containsEntry("role", "assistant");
        }
        assertThat(desk.call("agent.thread.get", Map.of("agentId", "manager", "before", "no-such-message")))
                .containsEntry("code", "not_found");
    }

    /** OpenAI's adapter through the same path, and a key and its binding that come back after a restart. */
    @Test
    void openAiAnswersAndARestartKeepsTheKeyAndTheBinding(CapturedOutput output) throws Exception {
        String keyId = keyAndBind("openai", "gpt-5.4-mini");
        desk.subscribe(2, "agent.conversation:manager");
        desk.event(2, "snapshot");
        desk.call("agent.message.send", Map.of("agentId", "manager", "text", "Hi"));
        Map<String, Object> done = finalReply();
        assertThat(done).containsEntry("state", "done").containsEntry("text", "Hello from the stand-in.");
        // gpt-5.4-mini: 100 in at $0.75 a million, 20 out at $4.50: 75 + 90 µ$.
        assertThat(done).containsEntry("costMicroUsd", 165);
        assertThat(map(done.get("badge"))).containsEntry("providerName", "OpenAI");
        assertThat(llm.lastChatBody()).containsEntry("store", false);

        desk.close();
        context.close();
        context = start(PeerCheck.ownUid());
        desk = new AgentSocketClient(dir.resolve("agent.sock"));
        Map<String, Object> manager = agent(result(desk.call("agent.list", Map.of())));
        assertThat(manager).containsEntry("status", "online");
        assertThat(map(manager.get("binding"))).containsEntry("model", "gpt-5.4-mini");
        assertThat(result(desk.call("agent.thread.get", Map.of("agentId", "manager"))).get("messages")).asList()
                .hasSize(2);
        assertThat(map(((List<?>) result(desk.call("agent.key.list", Map.of())).get("keys")).get(0)))
                .containsEntry("keyId", keyId).containsEntry("available", true);
        assertThat(Health.get(dir.resolve("admin.sock"))).contains("\"keys\":1");

        // The stand-in refuses any other key, so an answer says these are the bytes that were added.
        desk.subscribe(2, "agent.conversation:manager");
        desk.event(2, "snapshot");
        desk.call("agent.message.send", Map.of("agentId", "manager", "text", "Still there?"));
        assertThat(finalReply()).containsEntry("state", "done");
        assertThat(llm.requests).filteredOn(r -> r.path().equals("/v1/responses")).last()
                .satisfies(r -> assertThat(r.authorization()).isEqualTo("Bearer " + FakeLlmServer.OPENAI_KEY));
        assertThat(result(desk.call("agent.audit.list", Map.of())).get("entries")).asList()
                .anySatisfy(e -> assertThat(map(e)).containsEntry("action", "key.restore")
                        .containsEntry("actor", "system").containsEntry("target", "keys:all")
                        .containsEntry("decision", "restored:1:unreadable:0"));
        assertThat(everyDataFile()).doesNotContain(FakeLlmServer.OPENAI_KEY);
        assertThat(output.getAll()).doesNotContain(FakeLlmServer.OPENAI_KEY);
    }

    @Test
    void onlyDeskdsUidMayConnect() throws Exception {
        desk.close();
        context.close();
        context = start(PeerCheck.ownUid() + 1);
        AgentSocketClient stranger = new AgentSocketClient(dir.resolve("agent.sock"));
        await().atMost(Duration.ofSeconds(5)).until(() -> stranger.closedByPeer);
        stranger.close();
        desk = new AgentSocketClient(dir.resolve("agent.sock"));
        assertThat(Files.getPosixFilePermissions(dir.resolve("agent.sock")))
                .extracting(Object::toString).containsExactlyInAnyOrder("OWNER_READ", "OWNER_WRITE", "GROUP_READ",
                        "GROUP_WRITE");
    }

    private String everyDataFile() throws IOException {
        StringBuilder all = new StringBuilder();
        try (Stream<Path> walk = Files.walk(dir.resolve("data"))) {
            for (Path file : walk.filter(Files::isRegularFile).toList()) {
                all.append(new String(Files.readAllBytes(file), StandardCharsets.ISO_8859_1));
            }
        }
        return all.toString();
    }

    // ---- ADR 0043: spending limits, local time, the Platform's prices

    private Map<String, Object> limits() throws Exception {
        return result(desk.call("agent.limits.get", Map.of("agentId", "manager")));
    }

    /** {@code agent.limits.set} with fields that can be null, as a client's JSON has them. */
    private Map<String, Object> set(Object... pairs) throws Exception {
        Map<String, Object> p = new LinkedHashMap<>();
        p.put("agentId", "manager");
        for (int i = 0; i < pairs.length; i += 2) {
            p.put((String) pairs[i], pairs[i + 1]);
        }
        return desk.call("agent.limits.set", p);
    }

    private static Map<String, Object> cap(Integer microUsd, Integer tokens) {
        Map<String, Object> limit = new LinkedHashMap<>();
        limit.put("maxMicroUsd", microUsd);
        limit.put("maxTokens", tokens);
        return limit;
    }

    /** A whole policy, as a client sends it, without the two that layer, with these replaced. A null goes as JSON null. */
    private Map<String, Object> policyWith(Object... pairs) throws Exception {
        Map<String, Object> policy = new LinkedHashMap<>(map(limits().get("policy")));
        policy.remove("deskDay");
        policy.remove("deskMonth");
        for (int i = 0; i < pairs.length; i += 2) {
            policy.put((String) pairs[i], pairs[i + 1]);
        }
        return policy;
    }

    private static Map<String, Object> account(Object deskDay, Object deskMonth, Object timeZone) {
        Map<String, Object> p = new LinkedHashMap<>();
        p.put("deskDay", deskDay);
        p.put("deskMonth", deskMonth);
        p.put("timeZone", timeZone);
        return p;
    }

    private static Map<String, Object> nothingSet() {
        return account(null, null, null);
    }

    @Test
    void theLimitsViewHasEveryLayer() throws Exception {
        Map<String, Object> view = limits();
        assertThat(view).containsEntry("agentId", "manager").containsEntry("timeZone", null)
                .containsEntry("pricesAsOf", "2026-11-06")
                .containsEntry("desk", nothingSet()).containsEntry("account", nothingSet());
        Map<String, Object> policy = map(view.get("policy"));
        assertThat(policy).containsEntry("deskDay", cap(null, null)).containsEntry("deskMonth", cap(20_000_000, null));
        assertThat(map(policy.get("agentDay"))).containsEntry("maxMicroUsd", 5_000_000);
        List<?> usage = (List<?>) view.get("usage");
        assertThat(usage).extracting(u -> map(u).get("scope")).contains("desk_day", "desk_month");
        assertThat(usage).filteredOn(u -> "desk_day".equals(map(u).get("scope"))).singleElement()
                .satisfies(u -> assertThat(map(u).get("resetsAt")).isInstanceOf(Number.class));
    }

    /** Absent, null and a both-caps-null Limit are three different things, all the way through the socket's JSON. */
    @Test
    void absentNullAndNoLimitAreThreeDifferentThings() throws Exception {
        result(desk.call("desk.account.set", account(cap(1_000_000, null), cap(50_000_000, null), "America/Denver")));

        // A Limit with both caps null: no limit, set on this desk, and the account doesn't show through.
        Map<String, Object> view = result(set("policy", policyWith("deskDay", cap(null, null), "deskMonth", cap(null, null))));
        assertThat(map(view.get("desk"))).containsEntry("deskDay", cap(null, null)).containsEntry("deskMonth", cap(null, null));
        assertThat(map(view.get("policy"))).containsEntry("deskDay", cap(null, null)).containsEntry("deskMonth", cap(null, null));

        // Absent: changes nothing.
        view = result(set("policy", policyWith()));
        assertThat(map(view.get("desk"))).containsEntry("deskDay", cap(null, null)).containsEntry("deskMonth", cap(null, null));
        view = result(set("timeZone", "Pacific/Auckland"));
        assertThat(map(view.get("desk"))).containsEntry("deskMonth", cap(null, null)).containsEntry("timeZone", "Pacific/Auckland");
        view = result(set("policy", policyWith()));
        assertThat(map(view.get("desk"))).containsEntry("timeZone", "Pacific/Auckland");

        // Null: clears this desk's, one field at a time, so it follows the account.
        view = result(set("policy", policyWith("deskDay", null)));
        assertThat(map(view.get("desk"))).containsEntry("deskDay", null).containsEntry("deskMonth", cap(null, null));
        assertThat(map(view.get("policy"))).containsEntry("deskDay", cap(1_000_000, null)).containsEntry("deskMonth", cap(null, null));

        view = result(set("policy", policyWith("deskMonth", null)));
        assertThat(map(view.get("desk"))).containsEntry("deskDay", null).containsEntry("deskMonth", null);
        assertThat(map(view.get("policy"))).containsEntry("deskMonth", cap(50_000_000, null));

        view = result(set("timeZone", null));
        assertThat(view).containsEntry("desk", nothingSet()).containsEntry("timeZone", "America/Denver");
    }

    @Test
    void theAccountAppliesWhereTheDeskHasNothingAndTheDeskOverridesIt() throws Exception {
        Map<String, Object> account = account(cap(1_000_000, null), cap(50_000_000, 9), "America/Denver");
        assertThat(desk.call("desk.account.set", account)).containsEntry("t", "res");
        Map<String, Object> view = limits();
        assertThat(view).containsEntry("account", account).containsEntry("desk", nothingSet())
                .containsEntry("timeZone", "America/Denver");
        assertThat(map(view.get("policy"))).containsEntry("deskDay", cap(1_000_000, null)).containsEntry("deskMonth", cap(50_000_000, 9));

        view = result(set("timeZone", "Pacific/Auckland", "policy", policyWith("deskMonth", cap(7, null))));
        assertThat(view).containsEntry("timeZone", "Pacific/Auckland").containsEntry("account", account);
        assertThat(map(view.get("desk"))).containsEntry("deskMonth", cap(7, null)).containsEntry("deskDay", null);
        assertThat(map(view.get("policy"))).containsEntry("deskDay", cap(1_000_000, null)).containsEntry("deskMonth", cap(7, null));

        // The account's values go; what the desk set stays.
        result(desk.call("desk.account.set", nothingSet()));
        view = limits();
        assertThat(view).containsEntry("account", nothingSet()).containsEntry("timeZone", "Pacific/Auckland");
        assertThat(map(view.get("policy"))).containsEntry("deskDay", cap(null, null)).containsEntry("deskMonth", cap(7, null));
    }

    /** A zone alone is the app's own, so its audit row has its own action; anything with a policy stays {@code limits.set}. */
    @Test
    void aZoneAloneIsAuditedAsLimitsTimezone() throws Exception {
        result(set("timeZone", "America/Denver"));
        result(set("policy", policyWith("deskMonth", cap(7, null))));
        result(set("timeZone", "Pacific/Auckland", "policy", policyWith("deskMonth", cap(8, null))));
        List<?> entries = (List<?>) result(desk.call("agent.audit.list", Map.of())).get("entries");
        List<Object> actions = entries.stream().map(e -> map(e).get("action")).filter(a -> String.valueOf(a).startsWith("limits.")).toList();
        // Newest first.
        assertThat(actions).containsExactly("limits.set", "limits.set", "limits.timezone");
        assertThat(entries).filteredOn(e -> "limits.timezone".equals(map(e).get("action")))
                .singleElement().satisfies(e -> assertThat(map(e)).containsEntry("actor", "user")
                        .containsEntry("target", "agent:manager").containsEntry("decision", "ok"));
    }

    @Test
    void anAccountValueThatCantBeUsedCountsAsNotSet(CapturedOutput output) throws Exception {
        assertThat(desk.call("desk.account.set", account(Map.of("maxMicroUsd", -1), 7, "sentinel/zone")))
                .containsEntry("t", "res");
        assertThat(limits()).containsEntry("account", nothingSet()).containsEntry("timeZone", null);
        assertThat(output.getAll()).doesNotContain("sentinel/zone");
    }

    @Test
    void aZoneThatIsntARegionIsRefusedAndNothingChanges() throws Exception {
        result(set("timeZone", "America/Denver"));
        for (Object bad : new Object[] {"+05:00", "UTC+5", "Etc/GMT+5", "GMT", "Mars/Olympus", "america/denver", "", 42, List.of("UTC")}) {
            assertThat(set("timeZone", bad)).as(String.valueOf(bad)).containsEntry("code", "bad_request")
                    .containsEntry("details", Map.of("reason", "time_zone"));
        }
        assertThat(set("timeZone", "Mars/Olympus", "policy", policyWith("deskDay", cap(1, null))))
                .containsEntry("code", "bad_request");
        Map<String, Object> view = limits();
        assertThat(view).containsEntry("timeZone", "America/Denver");
        assertThat(map(view.get("desk"))).containsEntry("deskDay", null);
        assertThat(map(result(set("timeZone", "UTC")).get("desk"))).containsEntry("timeZone", "UTC");
    }

    /** As it always was: every other field of a policy is required, and one bad one changes nothing. */
    @Test
    void aPartialPolicyIsStillRefusedForTheOtherFields() throws Exception {
        for (String field : List.of("agentDay", "agentWeek", "agentMonth", "keyMonth", "run", "runMaxSteps")) {
            Map<String, Object> policy = policyWith("deskDay", cap(1, null));
            policy.remove(field);
            assertThat(set("policy", policy)).as(field).containsEntry("code", "bad_request")
                    .containsEntry("details", Map.of("detail", field));
        }
        assertThat(map(limits().get("desk"))).containsEntry("deskDay", null);
        assertThat(set("policy", null)).containsEntry("code", "bad_request").containsEntry("details", Map.of("detail", "policy"));
        assertThat(set("policy", policyWith("deskDay", 3))).containsEntry("details", Map.of("detail", "deskDay"));
        assertThat(set("policy", policyWith("deskMonth", cap(-1, null)))).containsEntry("details", Map.of("detail", "deskMonth"));
        // Nothing given, nothing changes, and no row says it did.
        int rows = ((List<?>) result(desk.call("agent.audit.list", Map.of())).get("entries")).size();
        assertThat(result(set())).containsEntry("desk", nothingSet());
        assertThat(((List<?>) result(desk.call("agent.audit.list", Map.of())).get("entries")).size()).isEqualTo(rows);
    }

    @Test
    void theDesksDayRefusesASend() throws Exception {
        keyAndBind("anthropic", "claude-sonnet-5-5");
        result(set("policy", policyWith("deskDay", cap(1, null))));
        assertThat(desk.call("agent.message.send", Map.of("agentId", "manager", "text", "Hi")))
                .containsEntry("code", "precondition_failed")
                .containsEntry("details", Map.of("reason", "limit_reached", "scope", "desk_day"));
        assertThat(agent(result(desk.call("agent.list", Map.of())))).containsEntry("status", "limit_reached")
                .containsEntry("statusDetail", "desk_day");
    }

    /** ADR 0043: the Platform's table changes the next call's cost and pricesAsOf; a bad one changes neither. */
    @Test
    void aPushedTablePricesTheNextCallAndABadOneIsIgnored(CapturedOutput output) throws Exception {
        keyAndBind("anthropic", "claude-sonnet-5-5");
        desk.subscribe(2, "agent.conversation:manager");
        desk.event(2, "snapshot");
        desk.call("agent.message.send", Map.of("agentId", "manager", "text", "Hi"));
        assertThat(finalReply()).containsEntry("costMicroUsd", 400);

        Map<String, Object> pushed = result(desk.call("desk.prices.set", Map.of("table", """
                {"version": 1, "checked": "2027-01-02", "models": {
                  "anthropic/claude-sonnet-5-5": {"input": "20", "output": "100"}}}""")));
        assertThat(pushed).containsEntry("applied", true).containsEntry("pricesAsOf", "2027-01-02");
        assertThat(limits()).containsEntry("pricesAsOf", "2027-01-02");
        desk.call("agent.message.send", Map.of("agentId", "manager", "text", "Again"));
        assertThat(finalReply()).containsEntry("costMicroUsd", 4000);
        // What's settled stays as it was charged.
        List<?> messages = (List<?>) result(desk.call("agent.thread.get", Map.of("agentId", "manager"))).get("messages");
        assertThat(messages).extracting(m -> map(m).get("costMicroUsd")).contains(400, 4000);

        for (Object bad : new Object[] {"not json sentinel-table", "{\"version\": 2}", "{\"version\": 1, \"models\": {}}", 7}) {
            assertThat(result(desk.call("desk.prices.set", Map.of("table", bad)))).containsEntry("applied", false)
                    .containsEntry("pricesAsOf", "2027-01-02");
        }
        desk.call("agent.message.send", Map.of("agentId", "manager", "text", "Once more"));
        assertThat(finalReply()).containsEntry("state", "done").containsEntry("costMicroUsd", 4000);
        assertThat(output.getAll()).doesNotContain("sentinel-table");
    }

    /** ADR 0043: no listed price for the client to show, and the call still counts at the provider's highest. */
    @Test
    void anUnlistedModelHasNoListedPriceAndStillCounts() throws Exception {
        String keyId = keyAndBind("anthropic", "some-new-model");
        List<?> models = (List<?>) result(desk.call("agent.key.models", Map.of("keyId", keyId))).get("models");
        assertThat(models).filteredOn(m -> "some-new-model".equals(map(m).get("id"))).singleElement()
                .satisfies(m -> assertThat(map(m)).containsEntry("inputMicroUsdPerMTok", null)
                        .containsEntry("outputMicroUsdPerMTok", null));
        desk.subscribe(2, "agent.conversation:manager");
        desk.event(2, "snapshot");
        desk.call("agent.message.send", Map.of("agentId", "manager", "text", "Hi"));
        // 100 tokens in and 20 out, at Anthropic's dearest in the bundled table.
        Pricing.Price dearest = Pricing.bundled().chargedPrice(ProviderId.ANTHROPIC, "some-new-model");
        long expected = Pricing.costMicroUsd(dearest, new Usage(100, 0, 0, 20, 0));
        assertThat(expected).isPositive();
        assertThat(((Number) finalReply().get("costMicroUsd")).longValue()).isEqualTo(expected);
    }

    /** What the rollout rests on: a method this version doesn't know is an answer, not a dropped link (ADR 0043). */
    @Test
    void aMethodNobodyKnowsGetsAnAnswerAndTheLinkStays() throws Exception {
        assertThat(desk.call("desk.not.yet", Map.of("x", 1))).containsEntry("code", "not_found")
                .containsEntry("details", Map.of("detail", "method"));
        assertThat(desk.call("agent.list", Map.of())).containsEntry("t", "res");
        assertThat(desk.closedByPeer).isFalse();
    }

    /** Only what the member set is kept, so a desk that set something else still follows its account. */
    @Test
    void onlyWhatTheMemberSetIsKeptAndItSurvivesARestart() throws Exception {
        result(set("timeZone", "America/Denver"));
        restart();
        Map<String, Object> view = limits();
        assertThat(view).containsEntry("timeZone", "America/Denver");
        assertThat(map(view.get("desk"))).containsEntry("deskDay", null).containsEntry("deskMonth", null);
        // deskd says the account's again on each connection: until then, there's none.
        assertThat(view).containsEntry("account", nothingSet());
        result(desk.call("desk.account.set", account(cap(1, null), cap(2, null), "Pacific/Auckland")));
        view = limits();
        assertThat(map(view.get("policy"))).containsEntry("deskDay", cap(1, null)).containsEntry("deskMonth", cap(2, null));
        assertThat(view).containsEntry("timeZone", "America/Denver");

        result(set("policy", policyWith("deskDay", cap(9, null), "deskMonth", cap(null, null))));
        restart();
        view = limits();
        assertThat(map(view.get("desk"))).containsEntry("deskDay", cap(9, null)).containsEntry("deskMonth", cap(null, null))
                .containsEntry("timeZone", "America/Denver");
    }

    /** A desk today: its row has only deskMonth and keyMonth. It starts, and that deskMonth is the desk's own. */
    @Test
    void aDeskFromBeforeThisKeepsWhatItHad() throws Exception {
        desk.close();
        context.close();
        try (AgentStore store = new AgentStore(dir.resolve("data").resolve("agent.db"), Clock.systemUTC())) {
            store.open();
            store.setSetting("limits.desk", "{\"deskMonth\":{\"maxMicroUsd\":20000000,\"maxTokens\":null},"
                    + "\"keyMonth\":{\"maxMicroUsd\":null,\"maxTokens\":7}}");
        }
        context = start(PeerCheck.ownUid());
        desk = new AgentSocketClient(dir.resolve("agent.sock"));
        result(desk.call("desk.account.set", account(cap(1, null), cap(2, null), null)));
        Map<String, Object> view = limits();
        assertThat(map(view.get("desk"))).containsEntry("deskDay", null).containsEntry("deskMonth", cap(20_000_000, null))
                .containsEntry("timeZone", null);
        assertThat(map(view.get("policy"))).containsEntry("deskDay", cap(1, null)).containsEntry("deskMonth", cap(20_000_000, null))
                .containsEntry("keyMonth", cap(null, 7));
    }

    private void restart() throws Exception {
        desk.close();
        context.close();
        context = start(PeerCheck.ownUid());
        desk = new AgentSocketClient(dir.resolve("agent.sock"));
    }

    private String keyAndBind(String provider, String model) throws Exception {
        String key = keyFor(provider);
        llm.acceptedKey = key;
        String keyId = (String) map(result(desk.addKey(provider, "Test", ascii(key))).get("key")).get("keyId");
        result(desk.call("agent.bind", Map.of("agentId", "manager", "keyId", keyId, "model", model)));
        return keyId;
    }

    /** A stand-in key in the provider's own shape, as one in another's never gets as far as the stand-in. */
    private static String keyFor(String provider) {
        return switch (provider) {
            case "openai" -> FakeLlmServer.OPENAI_KEY;
            case "xai" -> FakeLlmServer.XAI_KEY;
            default -> FakeLlmServer.KEY;
        };
    }

    private Map<String, Object> finalReply() throws Exception {
        while (true) {
            Map<String, Object> event = desk.event(2, "message");
            Map<String, Object> message = map(map(event.get("data")).get("message"));
            if ("assistant".equals(message.get("role")) && !"streaming".equals(message.get("state"))) {
                return message;
            }
        }
    }

    private int unseen() throws Exception {
        return ((Number) agent(result(desk.call("agent.list", Map.of()))).get("unseen")).intValue();
    }

    private static Map<String, Object> agent(Map<String, Object> list) {
        return map(((List<?>) list.get("agents")).get(0));
    }

    private static Map<String, Object> result(Map<String, Object> reply) {
        assertThat(reply).as("reply").containsEntry("t", "res");
        return map(reply.get("r"));
    }
}
