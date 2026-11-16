package com.minimalistalliance.desk.agent.maia;

import static com.minimalistalliance.desk.agent.testing.TeamDesk.list;
import static com.minimalistalliance.desk.agent.testing.TeamDesk.map;
import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.agent.key.KeyRing;
import com.minimalistalliance.desk.agent.memory.MemoryStore;
import com.minimalistalliance.desk.agent.provider.ChatRequest;
import com.minimalistalliance.desk.agent.provider.ProviderId;
import com.minimalistalliance.desk.agent.provider.ToolCall;
import com.minimalistalliance.desk.agent.provider.Usage;
import com.minimalistalliance.desk.agent.service.RpcError;
import com.minimalistalliance.desk.agent.store.AgentRow;
import com.minimalistalliance.desk.agent.testing.FakeMaiaService;
import com.minimalistalliance.desk.agent.testing.FakeProvider.Step;
import com.minimalistalliance.desk.agent.testing.MutableClock;
import com.minimalistalliance.desk.agent.testing.Rig;
import com.minimalistalliance.desk.agent.testing.TeamDesk;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Desk Maia on Minimalist Alliance's service (the owner, Nov 14: "Maia ALWAYS runs on the company account"; deskd
 * {@code API.md} §23, "Her model"), on the real agent service: no key anywhere, her binding the desk's own and nobody
 * else's, the disclosure in force, deskd's offer, the allowance limit on her reply with nothing tried until it resets, her
 * spend at the service's cost, her note-taker on the {@code notes} task, and her memory's rules.
 */
class MaiaCompanyTest {

    private static final Usage USAGE = new Usage(100, 0, 0, 20, 0);

    @TempDir
    Path data;

    private final MutableClock clock = new MutableClock(Rig.START);
    private MaiaDesk maia;

    @BeforeEach
    void open() throws Exception {
        maia = new MaiaDesk(data, clock);
    }

    @AfterEach
    void close() {
        maia.close();
    }

    private FakeMaiaService service() {
        return maia.deskd.service;
    }

    @Test
    void sheAnswersWithNoKeyOnTheDeskOnHerCompanyBinding() throws Exception {
        maia.on();
        assertThat(list(maia.desk.call("agent.key.list").get("keys"))).isEmpty();
        AgentRow row = maia.desk.store.agent(MaiaAgent.ID);
        assertThat(row.keyId()).isEqualTo(KeyRing.COMPANY);
        assertThat(row.provider()).isEqualTo("ma");
        assertThat(row.model()).isEqualTo("turn");
        maia.desk.provider.then(Step.answer(USAGE, "Hello from your desk."));
        Map<String, Object> reply = maia.desk.ask(MaiaAgent.ID, "Hi Maia");
        assertThat(reply).containsEntry("state", "done").containsEntry("text", "Hello from your desk.");
        assertThat(map(reply.get("badge"))).containsEntry("provider", "ma").containsEntry("model", "maia");
        Map<String, Object> args = service().calls.get(0);
        assertThat(args).containsEntry("task", "turn").containsEntry("maxOutputTokens", 4_000);
        assertThat(String.valueOf(args)).doesNotContain(TeamDesk.KEY).doesNotContain(Rig.MODEL);
        // No key was lent to anyone: the company lease is empty.
        assertThat(maia.desk.provider.seen.peek().key()).isEmpty();
        // Her spend is in credits (contract 0.4.8), on the room's allowance; never a dollar figure on her reply, the
        // member's ledger or the room (the owner, Nov 15).
        long micro = USAGE.inputTokens() * FakeMaiaService.MICRO_PER_INPUT
                + USAGE.outputTokens() * FakeMaiaService.MICRO_PER_OUTPUT;
        assertThat(reply.get("costMicroUsd")).isNull();
        assertThat(maia.desk.ledger.agentToday(MaiaAgent.ID).microUsd()).isZero();
        Map<String, Object> room = maia.room();
        assertThat(room).doesNotContainKey("spend");
        Map<String, Object> allowance = map(room.get("allowance"));
        assertThat(((Number) allowance.get("today")).doubleValue())
                .isGreaterThanOrEqualTo(FakeMaiaService.costCredits(micro));
        assertThat(allowance).containsEntry("cap", null).containsEntry("lighter", false);
        assertThat(map(allowance.get("credits"))).containsEntry("month", 2500L).containsEntry("drawingFrom", "day");
        // Her own usage is never money (the foot's briefs line is the member's own keys, the wallet's).
        assertThat(String.valueOf(allowance)).doesNotContain("$").doesNotContain("Usd");
    }

    @Test
    void herBindingIsTheDesksOwnAndNobodyCanChangeItOrUseIt() throws Exception {
        maia.on();
        String key = maia.desk.key();
        RpcError refused = maia.refused("agent.bind", "agentId", MaiaAgent.ID, "keyId", key, "model", Rig.MODEL);
        assertThat(refused.code()).isEqualTo("forbidden");
        assertThat(refused.details()).containsEntry("reason", "company");
        assertThat(maia.desk.store.agent(MaiaAgent.ID).keyId()).isEqualTo(KeyRing.COMPANY);
        // No other agent can bind the company "key": it's in no key list.
        String scout = maia.desk.agent("Scout");
        assertThat(maia.desk.refused("agent.bind", "agentId", scout, "keyId", KeyRing.COMPANY, "model", "turn")
                .code()).isEqualTo("not_found");
        // Her service is in no provider list and takes no key.
        assertThat(list(maia.desk.call("agent.providers").get("providers"))).extracting(p -> p.get("id"))
                .doesNotContain("ma").contains(com.minimalistalliance.desk.agent.testing.FakeProvider.ID.id());
        byte[] bytes = "sk-company-key-0123456789".getBytes(java.nio.charset.StandardCharsets.US_ASCII);
        try {
            maia.desk.service.keyAdd(TeamDesk.m("provider", "ma", "label", "x"),
                    java.nio.ByteBuffer.allocateDirect(bytes.length).put(bytes).flip());
            throw new AssertionError("a key for ma was taken");
        } catch (RpcError e) {
            assertThat(e.details()).containsEntry("detail", "provider");
        }
    }

    @Test
    void aDeskThatBoundHerToAMembersKeyRebindsHerAtStart() throws Exception {
        maia.on();
        String key = maia.desk.key();
        // As a desk from before Nov 14 left her row.
        maia.desk.store.setBinding(MaiaAgent.ID, key, com.minimalistalliance.desk.agent.testing.FakeProvider.ID.id(),
                Rig.MODEL);
        maia.close();
        maia = new MaiaDesk(data, clock);
        AgentRow row = maia.desk.store.agent(MaiaAgent.ID);
        assertThat(row.keyId()).isEqualTo(KeyRing.COMPANY);
        assertThat(row.provider()).isEqualTo(ProviderId.MA.id());
        maia.desk.provider.then(Step.answer(USAGE, "Still here."));
        assertThat(maia.desk.ask(MaiaAgent.ID, "Hi")).containsEntry("state", "done");
        assertThat(maia.desk.provider.seen.peek().key()).as("never the member's key").isEmpty();
    }

    @Test
    void withoutDeskdsOfferHerSendsAreRefusedNoService() throws Exception {
        maia.on();
        maia.deskd.service = null;
        RpcError refused = maia.refused("agent.message.send", "agentId", MaiaAgent.ID, "text", "hi");
        assertThat(refused.code()).isEqualTo("unavailable");
        assertThat(refused.details()).containsEntry("reason", "no_service");
        assertThat(maia.desk.thread(MaiaAgent.ID)).isEmpty();
    }

    @Test
    void anOlderDisclosureNoLongerCounts() throws Exception {
        maia.list();
        assertThat(maia.refused("agent.maia.set", "on", true, "disclosure", "maia-mode-v1").details())
                .containsEntry("reason", "disclosure");
        maia.on();
        // A desk that holds only v1, as one turned on before Nov 14 does.
        Map<String, Object> mode = MaiaStore.parse(maia.desk.store.setting(MaiaStore.MODE));
        mode.put("disclosure", "maia-mode-v1");
        maia.desk.store.setSetting(MaiaStore.MODE, new String(com.minimalistalliance.desk.agent.json.Json.bytes(mode),
                java.nio.charset.StandardCharsets.UTF_8));
        RpcError refused = maia.refused("agent.message.send", "agentId", MaiaAgent.ID, "text", "hi");
        assertThat(refused.code()).isEqualTo("precondition_failed");
        assertThat(refused.details()).containsEntry("reason", "disclosure");
        assertThat(maia.refused("agent.maia.set", "on", true).details()).containsEntry("reason", "disclosure");
        assertThat(service().calls).isEmpty();
        // The member accepts v2: she works again.
        Map<String, Object> on = map(maia.call("agent.maia.set", "on", true, "disclosure", "maia-mode-v2").get("maia"));
        assertThat(on).containsEntry("disclosure", "maia-mode-v2").containsEntry("on", true);
        maia.desk.provider.then(Step.answer(USAGE, "Hello."));
        assertThat(maia.desk.ask(MaiaAgent.ID, "hi")).containsEntry("state", "done");
        assertThat(MaiaMode.DISCLOSURE).isEqualTo("maia-mode-v2");
    }

    @Test
    void herAllowanceLimitEndsTheRunWithOneLineAndNothingIsTriedUntilItResets() throws Exception {
        maia.on();
        service().refuseNext = Map.of("code", "limit", "details", Map.of("reason", "limit_personal", "window", "day",
                "resetsAt", "2026-11-05T07:00:00.000Z"));
        Map<String, Object> reply = maia.desk.ask(MaiaAgent.ID, "Plan my week");
        assertThat(reply).containsEntry("state", "failed").containsEntry("error", "provider_error")
                .containsEntry("errorDetail", "limit");
        assertThat(map(reply.get("limit"))).containsEntry("reason", "limit_personal").containsEntry("window", "day")
                .containsEntry("resetsAt", "2026-11-05T07:00:00.000Z");
        assertThat(maia.desk.ledger.agentToday(MaiaAgent.ID).microUsd()).as("not billed, not counted").isZero();
        int sent = service().calls.size();
        // Again before it resets: refused on the desk, nothing sent.
        Map<String, Object> again = maia.desk.ask(MaiaAgent.ID, "Please?");
        assertThat(again).containsEntry("errorDetail", "limit");
        assertThat(map(again.get("limit"))).containsEntry("window", "day");
        assertThat(service().calls).hasSize(sent);
        // Once it resets, she answers.
        clock.set(java.time.Instant.parse("2026-11-05T07:00:01Z"));
        maia.desk.provider.then(Step.answer(USAGE, "Here's your week."));
        assertThat(maia.desk.ask(MaiaAgent.ID, "Now?")).containsEntry("state", "done");
        // The service down is its own word.
        service().refuseNext = Map.of("code", "unavailable", "details", Map.of("reason", "provider"));
        assertThat(maia.desk.ask(MaiaAgent.ID, "And now?")).containsEntry("errorDetail", "unavailable");
    }

    /**
     * The member's own day cap on her, in credits (the owner, Nov 15): her calls' costCredits add up on the desk, her note
     * says where she stands, and once reached her next turn ends with one line ({@code limit_cap}, the desk's next
     * midnight) and nothing is sent. No dollar figure anywhere.
     */
    @Test
    void theMembersOwnCapInCreditsStopsHerTurnsWithOneLine() throws Exception {
        maia.on();
        long micro = USAGE.inputTokens() * FakeMaiaService.MICRO_PER_INPUT
                + USAGE.outputTokens() * FakeMaiaService.MICRO_PER_OUTPUT;
        double perCall = FakeMaiaService.costCredits(micro);
        assertThat(perCall).isPositive();
        maia.call("agent.maia.set", "caps", Map.of("coordinatorDailyCredits", 1));
        maia.desk.provider.then(Step.answer(USAGE, "First."));
        assertThat(maia.desk.ask(MaiaAgent.ID, "One")).containsEntry("state", "done");
        // Each answer's credits are counted on the desk, whatever its dollars were: past the 1-credit cap now.
        Map<String, Object> allowance = map(maia.room().get("allowance"));
        assertThat(((Number) allowance.get("today")).doubleValue()).isGreaterThanOrEqualTo(perCall);
        assertThat(((Number) allowance.get("cap")).longValue()).isEqualTo(1L);
        long turns = service().calls.stream().filter(a -> "turn".equals(a.get("task"))).count();
        Map<String, Object> capped = maia.desk.ask(MaiaAgent.ID, "Two");
        assertThat(capped).containsEntry("state", "failed").containsEntry("errorDetail", "limit");
        assertThat(map(capped.get("limit"))).containsEntry("reason", "limit_cap").containsEntry("window", "day")
                .containsEntry("resetsAt", "2026-11-05T00:00:00Z");
        assertThat(capped.get("costMicroUsd")).isNull();
        // Nothing of that turn was sent.
        assertThat(service().calls.stream().filter(a -> "turn".equals(a.get("task"))).count()).isEqualTo(turns);
        // The To-do's alert about it is in credits, never money (the owner, Nov 15).
        Map<String, Object> capItem = MaiaDesk.items(maia.room()).stream().filter(i -> "cap".equals(i.get("kind")))
                .findFirst().orElseThrow();
        assertThat(capItem).containsEntry("urgency", "now")
                .containsEntry("title", "Maia has used the 1 credit you set for today and paused");
        assertThat(String.valueOf(capItem)).doesNotContain("$").doesNotContainPattern("(?i)usd");
        // The team view's row for her: credits, and no dollars of hers.
        Map<String, Object> summary = maia.call("agent.usage.summary", "days", 7);
        Map<String, Object> hers = list(summary.get("agents")).stream()
                .filter(a -> MaiaAgent.ID.equals(a.get("agentId"))).findFirst().orElseThrow();
        Map<String, Object> todayRow = list(hers.get("days")).getLast();
        assertThat(((Number) todayRow.get("spendMicroUsd")).longValue()).isZero();
        assertThat(((Number) todayRow.get("spendCredits")).doubleValue()).isGreaterThanOrEqualTo(perCall);
        // Lifted: she answers, and her note says where she stands against a cap the member set.
        maia.call("agent.maia.set", "caps", Map.of("coordinatorDailyCredits", 100_000));
        maia.desk.provider.then(Step.answer(USAGE, "Again."));
        assertThat(maia.desk.ask(MaiaAgent.ID, "Three")).containsEntry("state", "done");
        Map<String, Object> last = service().calls.stream().filter(a -> "turn".equals(a.get("task")))
                .reduce((a, b) -> b).orElseThrow();
        assertThat((String) last.get("note")).contains("of the member's own day cap of 100,000.")
                .contains("Credits: 2,460 left (2,250 of this month's 2,500, 210 starting), shared with the member's agents;"
                        + " this month's renew 1 December.");
        assertThat(((String) last.get("note")).lines()
                .filter(l -> l.toLowerCase(java.util.Locale.ROOT).contains("credit") || l.contains("allowance")))
                .isNotEmpty().noneMatch(l -> l.contains("$"));
    }

    @Test
    void herNoteTakerIsTheNotesTaskWithTheTakersRulesAsContext() throws Exception {
        maia.on();
        maia.desk.provider.then(Step.answer(USAGE, "Noted."))
                .then(Step.answer(USAGE, "{\"notes\": []}"));
        maia.desk.ask(MaiaAgent.ID, "Remember the Acme renewal is due Friday");
        await().atMost(Duration.ofSeconds(15)).until(() -> service().calls.size() >= 2);
        Map<String, Object> notes = service().calls.stream().filter(a -> "notes".equals(a.get("task"))).findFirst()
                .orElseThrow();
        assertThat((String) notes.get("context")).startsWith("You take notes");
        assertThat(notes.get("tools")).isEqualTo(List.of());
        assertThat(String.valueOf(notes.get("messages"))).contains("Acme renewal").doesNotContain("Noted.");
    }

    @Test
    void herMemoryKeepsOnlyHowTheMemberLikesHelpAndNeverAnythingPrivate() throws Exception {
        maia.on();
        maia.desk.provider.then(Step.calls(USAGE, List.of(
                        new ToolCall("m1", "memory_save", Map.of("text", "Prefers short answers")),
                        new ToolCall("m2", "memory_save", Map.of("text", "My wife's birthday is March 3")),
                        new ToolCall("m3", "memory_save", Map.of("text", "Is seeing a therapist on Mondays")))))
                .then(Step.answer(USAGE, "Got it."))
                .then(Step.answer(USAGE, "{\"notes\": []}"));
        maia.desk.ask(MaiaAgent.ID, "Remember I like short answers, and that stuff about my wife and my therapist");
        MemoryStore memory = new MemoryStore(maia.desk.store);
        assertThat(memory.list(MaiaAgent.ID)).extracting(MemoryStore.Item::text)
                .containsExactly("Prefers short answers");
        ChatRequest second = maia.desk.provider.requests().stream()
                .filter(r -> r.messages().getLast().toolResults().size() == 3).findFirst().orElseThrow();
        assertThat(second.messages().getLast().toolResults().get(1).content()).contains("looks private");
        // Her memory rules are hers, not every agent's.
        assertThat(second.system()).contains("Private things are never remembered")
                .doesNotContain("something about their life or work they told you");

        // A line she saved before her rules that holds something private is never pinned into her runs.
        memory.add(MaiaAgent.ID, "mem-oldprivateline01", "Her partner Sam works at the hospital", clock.millis(), "r",
                50, false);
        maia.desk.provider.then(Step.answer(USAGE, "Hi.")).then(Step.answer(USAGE, "{\"notes\": []}"));
        maia.desk.ask(MaiaAgent.ID, "Hello again");
        ChatRequest run = service().calls.stream().filter(a -> "turn".equals(a.get("task")))
                .map(FakeMaiaService::request).reduce((a, b) -> b).orElseThrow();
        assertThat(run.system()).contains("Prefers short answers").doesNotContain("Sam").doesNotContain("hospital");

        // Another agent's memory is unchanged: a desk agent may remember private things on the member's desk.
        String scout = maia.desk.agent("Scout");
        maia.desk.provider.then(Step.calls(USAGE, List.of(new ToolCall("s1", "memory_save",
                Map.of("text", "Is seeing a therapist on Mondays"))))).then(Step.answer(USAGE, "Saved."));
        maia.desk.ask(scout, "Remember my Monday therapist");
        assertThat(memory.list(scout)).extracting(MemoryStore.Item::text).contains("Is seeing a therapist on Mondays");
    }
}
