package com.minimalistalliance.desk.deskd.agent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.platform.AccountDefaults;
import com.minimalistalliance.desk.deskd.platform.ModelPrices;
import com.minimalistalliance.desk.deskd.platform.PlatformHttp;
import com.minimalistalliance.desk.deskd.testing.FakeAgentSocket;
import com.minimalistalliance.desk.deskd.testing.FakePlatform;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;

/**
 * ADR 0043: what deskd hands desk-agent, on real Unix sockets: the price table and the account's values, on every
 * connection and on a change, and what an older desk-agent does with them.
 */
@ExtendWith(OutputCaptureExtension.class)
class AgentPushesTest {

    private static final String TABLE = "{\"version\":1,\"checked\":\"2027-01-02\",\"models\":{\"a/b\":{\"input\":\"1\",\"output\":\"2\"}}}";
    private static final String OTHER = "{\"version\":1,\"checked\":\"2027-02-03\",\"models\":{\"a/c\":{\"input\":\"3\",\"output\":\"4\"}}}";

    @TempDir
    Path dir;

    private AgentRig rig;

    @AfterEach
    void tearDown() throws Exception {
        if (rig != null) {
            rig.close();
        }
    }

    private static byte[] bytes(String text) {
        return text.getBytes(StandardCharsets.UTF_8);
    }

    private static Map<String, Object> account(Object deskDay, Object deskMonth, Object timeZone) {
        Map<String, Object> p = new LinkedHashMap<>();
        p.put("deskDay", deskDay);
        p.put("deskMonth", deskMonth);
        p.put("timeZone", timeZone);
        p.put("tier", null);
        return p;
    }

    private Map<String, Object> nextPush(String method) throws Exception {
        while (true) {
            Map<String, Object> req = rig.agent.requests.poll(10, TimeUnit.SECONDS);
            assertThat(req).as("a push of " + method).isNotNull();
            if (method.equals(req.get("m"))) {
                return req;
            }
        }
    }

    private void answer(Map<String, Object> req) {
        rig.agent.reply(((Number) req.get("id")).longValue(), Map.of());
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> params(Map<String, Object> req) {
        return (Map<String, Object>) req.get("p");
    }

    /** Task 49 (Security T49K-2): the owner's band goes with the account's values, and alone before there are any. */
    @Test
    void theBandGoesWithTheAccountAndChangesAreSentAgain() throws Exception {
        rig = new AgentRig(dir);
        rig.module.pushes().band("unknown");
        Map<String, Object> first = nextPush(AgentPushes.ACCOUNT);
        assertThat(params(first)).isEqualTo(Map.of("band", "unknown"));
        answer(first);
        rig.module.pushes().account(account(null, null, "America/Denver"));
        Map<String, Object> second = nextPush(AgentPushes.ACCOUNT);
        assertThat(params(second)).containsEntry("band", "unknown").containsEntry("timeZone", "America/Denver");
        answer(second);
        rig.module.pushes().band("adult");
        Map<String, Object> third = nextPush(AgentPushes.ACCOUNT);
        assertThat(params(third)).containsEntry("band", "adult").containsEntry("timeZone", "America/Denver");
        answer(third);
    }

    /** One at a time, each after the last's answer, so a test answers as it goes. */
    @Test
    void bothGoOnConnectAndAgainOnAReconnect() throws Exception {
        rig = new AgentRig(dir);
        rig.module.pushes().prices(bytes(TABLE));
        rig.module.pushes().account(account(Map.of("maxMicroUsd", 1), null, "America/Denver"));
        Map<String, Map<String, Object>> byMethod = new HashMap<>();
        while (byMethod.size() < 2) {
            Map<String, Object> push = rig.agent.requests.poll(10, TimeUnit.SECONDS);
            assertThat(push).as("both pushes").isNotNull();
            byMethod.put((String) push.get("m"), push);
            answer(push);
        }
        // The null stays a null: it's what clears the account's value.
        assertThat(params(byMethod.get(AgentPushes.ACCOUNT))).containsEntry("deskMonth", null)
                .containsEntry("timeZone", "America/Denver").containsEntry("deskDay", Map.of("maxMicroUsd", 1));
        assertThat(params(byMethod.get(AgentPushes.PRICES))).containsEntry("table", TABLE);

        // On a reconnect both are owed, and the account's goes first: it can change what a call may spend.
        rig.agent.drop();
        Map<String, Object> first = rig.agent.requests.poll(10, TimeUnit.SECONDS);
        assertThat(first).containsEntry("m", AgentPushes.ACCOUNT);
        assertThat(rig.agent.requests.poll(100, TimeUnit.MILLISECONDS)).as("waits for the answer").isNull();
        answer(first);
        Map<String, Object> second = rig.agent.requests.poll(10, TimeUnit.SECONDS);
        assertThat(second).containsEntry("m", AgentPushes.PRICES);
        assertThat(params(second)).containsEntry("table", TABLE);
        answer(second);
        assertThat(rig.agent.connections()).isEqualTo(2);
        assertThat(rig.agent.requests.poll(100, TimeUnit.MILLISECONDS)).isNull();
    }

    @Test
    void aChangeGoesAtOnceAndOnlyTheLatest() throws Exception {
        rig = new AgentRig(dir);
        rig.module.pushes().prices(bytes(TABLE));
        Map<String, Object> first = nextPush(AgentPushes.PRICES);
        // While the first waits for its answer, two more come: only the last goes.
        rig.module.pushes().prices(bytes(OTHER));
        rig.module.pushes().prices(bytes(TABLE + " "));
        answer(first);
        Map<String, Object> second = nextPush(AgentPushes.PRICES);
        assertThat(params(second)).containsEntry("table", TABLE + " ");
        answer(second);
        assertThat(rig.agent.requests.poll(100, TimeUnit.MILLISECONDS)).isNull();
    }

    /**
     * A new deskd and an older desk-agent, in a rollout. The older one answers {@code not_found} to any method it doesn't
     * know, where a new {@code t} would close the link, and the reconnect would then send it again for ever.
     */
    @Test
    void anOlderDeskAgentAnswersNotFoundAndTheLinkStays(CapturedOutput output) throws Exception {
        rig = new AgentRig(dir);
        rig.agent.handlers.put("agent.list", p -> Map.of("agents", List.of()));
        TestClient client = rig.connect("a");
        rig.module.pushes().prices(bytes(TABLE));
        rig.module.pushes().account(account(null, null, null));

        Map<String, Object> first = rig.agent.requests.poll(10, TimeUnit.SECONDS);
        rig.agent.error(((Number) first.get("id")).longValue(), "not_found", Map.of("detail", "method"));

        // Nothing more goes out on this connection, not even a change.
        await().until(() -> output.getAll().contains("takes no prices or account values yet"));
        rig.module.pushes().prices(bytes(OTHER));
        assertThat(rig.agent.requests.poll(200, TimeUnit.MILLISECONDS)).isNull();

        // And the link never dropped: a client's call still goes through.
        assertThat(rig.agent.connections()).isEqualTo(1);
        assertThat(rig.module.link().isConnected()).isTrue();
        assertThat(rig.call(client, "agent.list", Map.of())).containsEntry("_kind", "RES");

        // A later connection may be a newer desk-agent, so it's tried once more, with the latest.
        rig.agent.drop();
        answer(nextPush(AgentPushes.ACCOUNT));
        Map<String, Object> table = nextPush(AgentPushes.PRICES);
        assertThat(params(table)).containsEntry("table", OTHER);
        answer(table);
    }

    @Test
    void anyOtherRefusalIsNotRepeatedUntilSomethingChanges(CapturedOutput output) throws Exception {
        rig = new AgentRig(dir);
        rig.module.pushes().prices(bytes(TABLE));
        Map<String, Object> first = nextPush(AgentPushes.PRICES);
        rig.agent.error(((Number) first.get("id")).longValue(), "bad_request", Map.of("reason", "x"));
        assertThat(rig.agent.requests.poll(200, TimeUnit.MILLISECONDS)).isNull();
        rig.module.pushes().prices(bytes(OTHER));
        answer(nextPush(AgentPushes.PRICES));
        assertThat(output.getAll()).contains("desk-agent refused desk.prices.set: bad_request").doesNotContain("2027-01-02");
    }

    /** A push isn't a client's to send: deskd's method table has only agent.*, so it never reaches desk-agent. */
    @Test
    void noClientCanSendAPush() throws Exception {
        rig = new AgentRig(dir);
        TestClient client = rig.connect("a");
        assertThat(rig.call(client, AgentPushes.PRICES, Map.of("table", TABLE), "idem-1")).containsEntry("code", "not_found");
        assertThat(rig.call(client, AgentPushes.ACCOUNT, Map.of(), "idem-2")).containsEntry("code", "not_found");
        assertThat(rig.call(client, AgentPushes.PRICES, Map.of("table", TABLE), null)).containsEntry("code", "not_found");
        assertThat(rig.agent.requests.poll(100, TimeUnit.MILLISECONDS)).isNull();
    }

    /** No answer on a link that stays up: it's cancelled and goes again, and a new connection doesn't wait for that. */
    @Test
    void noAnswerGoesAgainAndANewConnectionDoesntWait() throws Exception {
        Path socket = dir.resolve("agent.sock");
        try (FakeAgentSocket agent = new FakeAgentSocket(socket)) {
            AgentLink link = new AgentLink(socket, AgentRig.FAST);
            AgentPushes pushes = new AgentPushes(link, Duration.ofMillis(100), Duration.ofHours(1));
            link.start(new AgentLink.Listener() {
                @Override
                public void connected() {
                    pushes.connected();
                }

                @Override
                public void disconnected() {
                    pushes.disconnected();
                }

                @Override
                public void event(long sid, String topic, String type, Map<String, Object> data) {}
            });
            pushes.start();
            try {
                pushes.prices(bytes(TABLE));
                Map<String, Object> first = agent.requests.poll(10, TimeUnit.SECONDS);
                assertThat(first).containsEntry("m", AgentPushes.PRICES);
                assertThat(agent.next("cancel")).containsEntry("id", first.get("id"));
                // Held for an hour after no answer, so nothing more on this connection.
                assertThat(agent.requests.poll(200, TimeUnit.MILLISECONDS)).isNull();

                agent.drop();
                Map<String, Object> again = agent.requests.poll(10, TimeUnit.SECONDS);
                assertThat(again).containsEntry("m", AgentPushes.PRICES);
            } finally {
                pushes.close();
                link.close();
            }
        }
    }

    /** From the fetch and the config to desk-agent's socket, as the configuration wires them. */
    @Test
    void theFetchAndTheConfigReachTheSocket() throws Exception {
        rig = new AgentRig(dir);
        AccountDefaults defaults = new AccountDefaults();
        try (FakePlatform platform = new FakePlatform(); PlatformHttp http = new PlatformHttp()) {
            platform.modelPricesReplies.add(FakePlatform.Reply.of(200, TABLE, "\"v1\""));
            Files.createDirectories(dir.resolve("data"));
            ModelPrices prices = new ModelPrices(http, platform::url, dir.resolve("data"), new ModelPrices.Timing(
                    Duration.ZERO, Duration.ofHours(1), Duration.ZERO, Duration.ofHours(1), Duration.ofHours(1), Duration.ofSeconds(5)));
            rig.module.followPlatform(prices, defaults);
            defaults.apply(null);
            Map<String, Object> none = nextPush(AgentPushes.ACCOUNT);
            assertThat(params(none)).isEqualTo(account(null, null, null));
            answer(none);

            prices.start();
            Map<String, Object> table = nextPush(AgentPushes.PRICES);
            assertThat(params(table)).containsEntry("table", TABLE);
            answer(table);

            // The same again is no change, and a different one goes.
            defaults.apply(Map.of());
            assertThat(rig.agent.requests.poll(100, TimeUnit.MILLISECONDS)).isNull();
            defaults.apply(Map.of("timeZone", "Pacific/Auckland", "somethingElse", 1));
            Map<String, Object> changed = nextPush(AgentPushes.ACCOUNT);
            assertThat(params(changed)).isEqualTo(account(null, null, "Pacific/Auckland"));
            answer(changed);
            prices.close();
        }
    }

    /** The last account values kept on disk go to desk-agent when a boot's config has none. */
    @Test
    void theKeptAccountValuesAreHandedOnWhenTheConfigHasNone() throws Exception {
        rig = new AgentRig(dir);
        Path kept = Files.createDirectories(dir.resolve("data")).resolve(AccountDefaults.FILE);
        Files.writeString(kept, "{\"deskDay\":null,\"deskMonth\":{\"maxMicroUsd\":9},\"timeZone\":\"America/Denver\"}");
        AccountDefaults defaults = new AccountDefaults();
        defaults.keepIn(kept);
        try (FakePlatform platform = new FakePlatform(); PlatformHttp http = new PlatformHttp()) {
            ModelPrices prices = new ModelPrices(http, platform::url, dir.resolve("data"), new ModelPrices.Timing(
                    Duration.ZERO, Duration.ofHours(1), Duration.ZERO, Duration.ofHours(1), Duration.ofHours(1), Duration.ofSeconds(5)));
            rig.module.followPlatform(prices, defaults);
            defaults.apply(null);
            Map<String, Object> pushed = nextPush(AgentPushes.ACCOUNT);
            assertThat(params(pushed)).isEqualTo(account(null, Map.of("maxMicroUsd", 9), "America/Denver"));
            answer(pushed);
            prices.close();
        }
    }

    /** absent, null and a Limit with both caps null are three things to desk-agent, so the relay keeps them apart. */
    @Test
    void theRelayKeepsNullsAndAbsentApartInALimitsSet() throws Exception {
        rig = new AgentRig(dir);
        rig.agent.handlers.put("agent.limits.set", p -> Map.of("seen", true));
        TestClient client = rig.connect("a");
        Map<String, Object> cap = new LinkedHashMap<>();
        cap.put("maxMicroUsd", null);
        cap.put("maxTokens", null);
        Map<String, Object> policy = new LinkedHashMap<>();
        policy.put("deskDay", null);
        policy.put("deskMonth", cap);
        Map<String, Object> params = new LinkedHashMap<>();
        params.put("agentId", "manager");
        params.put("policy", policy);
        params.put("timeZone", null);

        assertThat(rig.call(client, "agent.limits.set", params)).containsEntry("_kind", "RES");

        Map<String, Object> relayed = params(rig.agent.next("req"));
        assertThat(relayed).containsKey("timeZone").containsEntry("timeZone", null);
        @SuppressWarnings("unchecked")
        Map<String, Object> sent = (Map<String, Object>) relayed.get("policy");
        assertThat(sent).containsKey("deskDay").containsEntry("deskDay", null).containsEntry("deskMonth", cap);
        assertThat(sent).doesNotContainKey("keyMonth");
    }
}
