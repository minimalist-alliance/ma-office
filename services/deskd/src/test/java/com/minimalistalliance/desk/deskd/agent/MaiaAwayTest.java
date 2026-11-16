package com.minimalistalliance.desk.deskd.agent;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.deskd.desks.DeskMessaging;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import org.junit.jupiter.api.Test;

/**
 * deskd's part of Maia while the member is away (API.md §23, ADR 0141): the carrier only while the Platform says so and
 * never on a Guild Desk; only what the office hasn't carried in 30 s goes out, her brief asking to wake its desk and
 * nothing else; what comes in is opened, handed to desk-agent in order, stopped at a transient failure and acked with its
 * outcome; outcomes go to desk-agent's done; the heartbeat's hold and check-in; the bell once per rise.
 */
class MaiaAwayTest {

    static final Instant NOW = Instant.parse("2026-11-15T10:00:00Z");
    static final String ENV1 = "env-" + "a".repeat(25) + "b";
    static final String ENV2 = "env-" + "a".repeat(25) + "c";
    static final String ENV3 = "env-" + "a".repeat(25) + "d";

    final List<Map<String, Object>> posts = new ArrayList<>();
    final List<Object[]> agentCalls = new ArrayList<>();
    Map<String, Object> collected = Map.of();
    Function<Object[], Object> agentAnswer = c -> Map.of();
    boolean guild;

    MaiaAway make() {
        MaiaAway.Platform platform = new MaiaAway.Platform() {
            @Override
            public Map<String, Object> post(Map<String, Object> body) {
                posts.add(body);
                return Map.of();
            }

            @Override
            public Map<String, Object> collect() {
                return collected;
            }
        };
        MaiaAway.Agent agent = new MaiaAway.Agent() {
            @Override
            public Object call(String method, Map<String, Object> params) {
                Object[] c = {method, params};
                agentCalls.add(c);
                return agentAnswer.apply(c);
            }

            @Override
            public boolean connected() {
                return true;
            }
        };
        Clock clock = Clock.fixed(NOW, ZoneOffset.UTC);
        DeskMessaging messaging = new DeskMessaging(clock, () -> "d-homeaaaaaaaa", () -> "acct", () -> guild);
        MaiaAway.Opener opener = env -> {
            if (env instanceof Map<?, ?> m && "bad".equals(m.get("ct"))) {
                throw new DeskMessaging.Refused("bad_signature");
            }
            return Map.of("kind", "msg", "grantId", "dg-" + "a".repeat(20));
        };
        return new MaiaAway(platform, agent, messaging, opener, clock, () -> guild, () -> "d-homeaaaaaaaa");
    }

    static Map<String, Object> on() {
        return Map.of("away", true, "hold", "on", "pollSeconds", 60);
    }

    @Test
    void offUntilThePlatformSaysSoAndNeverOnAGuildDesk() throws Exception {
        MaiaAway a = make();
        collected = Map.of("envelopes", List.of(Map.of("id", ENV1, "envelope", Map.of("ct", "x"))));
        a.pass();
        assertThat(posts).isEmpty();
        assertThat(agentCalls).isEmpty();
        guild = true;
        a.onReply(on());
        a.pass();
        assertThat(agentCalls.stream().filter(c -> !"desk.maia.away".equals(c[0]))).isEmpty();
        guild = false;
        a.onReply(Map.of("away", false));
        a.pass();
        assertThat(agentCalls.stream().filter(c -> !"desk.maia.away".equals(c[0]))).isEmpty();
        // desk-agent hears the Platform's word (MA-M1): she may not work while the member is away.
        Thread.sleep(200);
        assertThat(agentCalls).anyMatch(c -> "desk.maia.away".equals(c[0]) && Boolean.FALSE.equals(((Map<?, ?>) c[1])
                .get("away")));
    }

    @Test
    void onlyWhatTheOfficeHasntCarriedIn30sGoesOutAndOnlyHerBriefAsksToWake() throws Exception {
        MaiaAway a = make();
        a.onReply(on());
        long now = NOW.toEpochMilli();
        agentAnswer = c -> switch ((String) c[0]) {
            case "desk.desks.outbox" -> Map.of("pending", List.of(
                    Map.of("toDeskId", "d-workaaaaaaaa", "count", 2, "oldestAt", now - 60_000),
                    Map.of("toDeskId", "d-persaaaaaaaa", "count", 1, "oldestAt", now - 5_000)));
            case "desk.desks.take" -> Map.of("envelopes", List.of(
                    Map.of("id", ENV1, "toDeskId", "d-workaaaaaaaa", "envelope", Map.of("ct", "1"), "wake", true),
                    Map.of("id", ENV2, "toDeskId", "d-workaaaaaaaa", "envelope", Map.of("ct", "2"))), "more", false);
            default -> Map.of();
        };
        a.send();
        assertThat(agentCalls.stream().filter(c -> "desk.desks.take".equals(c[0]))).hasSize(1);
        @SuppressWarnings("unchecked")
        Map<String, Object> take = (Map<String, Object>) agentCalls.stream().filter(c -> "desk.desks.take".equals(c[0]))
                .findFirst().orElseThrow()[1];
        assertThat(take).containsEntry("toDeskId", "d-workaaaaaaaa").containsEntry("olderThanMs", 30_000L);
        assertThat(posts).hasSize(1);
        assertThat(posts.getFirst()).containsEntry("action", "send").containsEntry("toDeskId", "d-workaaaaaaaa")
                .containsEntry("wake", true);
        // The same ids aren't posted again soon: the Platform has them.
        a.send();
        assertThat(posts).hasSize(1);
    }

    @Test
    void whatComesInIsHandedOverInOrderAndAckedAndATransientFailureStopsTheRest() throws Exception {
        MaiaAway a = make();
        a.onReply(on());
        collected = Map.of("envelopes", List.of(
                Map.of("id", ENV1, "envelope", Map.of("ct", "x")),
                Map.of("id", ENV2, "envelope", Map.of("ct", "bad")),
                Map.of("id", ENV3, "envelope", Map.of("ct", "busy"))), "results", List.of());
        int[] n = {0};
        agentAnswer = c -> {
            if ("desk.desks.deliver".equals(c[0])) {
                n[0]++;
                if (n[0] == 2) {
                    throw new RuntimeException(new RpcException(RpcException.UNAVAILABLE, "busy", Map.of()));
                }
                return Map.of("id", ENV1, "outcome", "delivered");
            }
            return Map.of();
        };
        a.receive();
        Map<String, Object> ack = posts.getLast();
        assertThat(ack).containsEntry("action", "ack");
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> outcomes = (List<Map<String, Object>>) ack.get("envelopes");
        assertThat(outcomes).extracting(m -> m.get("id") + ":" + m.get("outcome") + ":" + m.get("reason"))
                .containsExactly(ENV1 + ":delivered:null", ENV2 + ":refused:bad_signature");
    }

    @Test
    void outcomesOfWhatThisDeskSentGoToDeskAgentsDoneThenAreAcked() throws Exception {
        MaiaAway a = make();
        a.onReply(on());
        collected = Map.of("envelopes", List.of(), "results", List.of(Map.of("id", ENV1, "outcome", "refused",
                "reason", "stale")));
        a.receive();
        assertThat(agentCalls).anyMatch(c -> "desk.desks.done".equals(c[0]));
        assertThat(posts.getLast()).containsEntry("results", List.of(ENV1));
    }

    @Test
    void theHeartbeatHoldsWhileSheHasWorkInFlightAndNamesHerCheckIn() {
        MaiaAway a = make();
        assertThat(a.heartbeatBlock()).isNull();
        Map<String, Object> state = new LinkedHashMap<>();
        state.put("on", true);
        state.put("inFlight", true);
        state.put("wakeAt", NOW.toEpochMilli() + 3_600_000);
        a.onAgentState(Map.of("agents", List.of(), "maiaAway", state));
        Map<String, Object> block = a.heartbeatBlock();
        assertThat(block).containsEntry("holdUntil", "2026-11-15T10:10:00Z").containsEntry("wakeAt",
                "2026-11-15T11:00:00Z").containsEntry("home", true);
        state.put("inFlight", false);
        state.put("wakeAt", null);
        a.onAgentState(Map.of("agents", List.of(), "maiaAway", state));
        assertThat(a.heartbeatBlock()).doesNotContainKey("holdUntil").doesNotContainKey("wakeAt");
    }

    @Test
    void theBellRingsOnceWhenHerQuestionsHerFinishingOrApprovalsGoUp() throws Exception {
        MaiaAway a = make();
        a.onReply(on());
        agentAnswer = c -> "desk.desks.outbox".equals(c[0]) ? Map.of("pending", List.of()) : Map.of();
        a.onAgentState(Map.of("agents", List.of(Map.of("approvalsPending", 1)), "maiaAway",
                Map.of("asks", 1, "done", 0, "away", true)));
        a.pass();
        assertThat(posts).extracting(p -> p.get("kind")).containsExactly("question", "approval");
        a.pass();
        assertThat(posts).hasSize(2);
        a.onAgentState(Map.of("agents", List.of(Map.of("approvalsPending", 1)), "maiaAway",
                Map.of("asks", 1, "done", 1, "away", true)));
        a.pass();
        assertThat(posts).extracting(p -> p.get("kind")).containsExactly("question", "approval", "done");
    }

    @Test
    void withTheShieldOnItsRingCountsDecideAndItsOwnKindWaitsForThePlatform() throws Exception {
        MaiaAway a = make();
        a.onReply(on());
        agentAnswer = c -> "desk.desks.outbox".equals(c[0]) ? Map.of("pending", List.of()) : Map.of();
        // deskd's first look at the shield's counts takes them as seen: they run for desk-agent's life.
        a.onAgentState(Map.of("agents", List.of(), "maiaAway", Map.of("asks", 2, "done", 1, "away", true, "ring",
                Map.of("question", 4, "done", 2, "reach", 3))));
        a.pass();
        assertThat(posts).isEmpty();
        // Phase 2's asks rose, but the shield held it (quiet hours): nothing rings.
        a.onAgentState(Map.of("agents", List.of(), "maiaAway", Map.of("asks", 3, "done", 1, "away", true, "ring",
                Map.of("question", 4, "done", 2, "reach", 3))));
        a.pass();
        assertThat(posts).isEmpty();
        // The shield's question and its own item rise: the question rings; its own kind waits for the Platform.
        a.onAgentState(Map.of("agents", List.of(), "maiaAway", Map.of("asks", 3, "done", 1, "away", true, "ring",
                Map.of("question", 5, "done", 2, "reach", 4))));
        a.pass();
        assertThat(posts).extracting(p -> p.get("kind")).containsExactly("question");
        // Once the Platform takes "reach", the next rise rings it, once.
        a.onReply(Map.of("away", true, "hold", "on", "pollSeconds", 60, "notifyKinds",
                List.of("question", "approval", "done", "reach")));
        a.onAgentState(Map.of("agents", List.of(), "maiaAway", Map.of("asks", 3, "done", 1, "away", true, "ring",
                Map.of("question", 5, "done", 2, "reach", 5))));
        a.pass();
        a.pass();
        assertThat(posts).extracting(p -> p.get("kind")).containsExactly("question", "reach");
        // The member turns on "Show everything as it comes": Phase 2's counts again, from where they are.
        a.onAgentState(Map.of("agents", List.of(), "maiaAway", Map.of("asks", 3, "done", 1, "away", true)));
        a.pass();
        assertThat(posts).hasSize(2);
        a.onAgentState(Map.of("agents", List.of(), "maiaAway", Map.of("asks", 4, "done", 1, "away", true)));
        a.pass();
        assertThat(posts).extracting(p -> p.get("kind")).containsExactly("question", "reach", "question");
    }

    @Test
    void whatTheShieldCountedWhileTheMemberWasStillAtTheOfficeIsntRungWhenTheyLeave() throws Exception {
        MaiaAway a = make();
        agentAnswer = c -> "desk.desks.outbox".equals(c[0]) ? Map.of("pending", List.of()) : Map.of();
        Map<String, Object> kinds = Map.of("away", true, "hold", "on", "pollSeconds", 60, "notifyKinds",
                List.of("question", "approval", "done", "reach"));
        a.onReply(kinds);
        a.onAgentState(Map.of("agents", List.of(), "maiaAway", Map.of("asks", 0, "done", 0, "away", true, "ring",
                Map.of("question", 0, "done", 0, "reach", 1))));
        a.pass();
        // Back at the office (idle there a while: the shield counted two more), then away again.
        a.onReply(Map.of("away", false));
        a.onAgentState(Map.of("agents", List.of(), "maiaAway", Map.of("asks", 0, "done", 0, "away", false, "ring",
                Map.of("question", 0, "done", 0, "reach", 3))));
        a.onReply(kinds);
        a.pass();
        assertThat(posts).isEmpty();
        a.onAgentState(Map.of("agents", List.of(), "maiaAway", Map.of("asks", 0, "done", 0, "away", true, "ring",
                Map.of("question", 0, "done", 0, "reach", 4))));
        a.pass();
        assertThat(posts).extracting(p -> p.get("kind")).containsExactly("reach");
        // A reply that doesn't list the kinds is Phase 2's three again: the shield's own waits.
        a.onReply(on());
        a.onAgentState(Map.of("agents", List.of(), "maiaAway", Map.of("asks", 0, "done", 0, "away", true, "ring",
                Map.of("question", 0, "done", 0, "reach", 5))));
        a.pass();
        assertThat(posts).hasSize(1);
    }
}
