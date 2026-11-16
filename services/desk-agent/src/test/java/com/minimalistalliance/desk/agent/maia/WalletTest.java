package com.minimalistalliance.desk.agent.maia;

import static com.minimalistalliance.desk.agent.testing.TeamDesk.list;
import static com.minimalistalliance.desk.agent.testing.TeamDesk.map;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.agent.json.Json;
import com.minimalistalliance.desk.agent.provider.ToolSpec;
import com.minimalistalliance.desk.agent.service.Caller;
import com.minimalistalliance.desk.agent.service.RpcError;
import com.minimalistalliance.desk.agent.store.AgentStore;
import com.minimalistalliance.desk.agent.testing.MutableClock;
import com.minimalistalliance.desk.agent.testing.TeamDesk;
import com.minimalistalliance.desk.agent.tool.RunContext;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.SQLException;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Desk Maia's wallet sense for her briefs (the owner, Nov 15): the estimate, when code asks (and that a normal day never
 * does), an agent's limits handled with options instead of a failure, "Always OK for tasks like this", and that nothing
 * she can do changes a budget or a limit.
 */
class WalletTest {

    private static final String WORK = "d-work1";
    private static final String PERSONAL = "d-pers1";
    private static final String LEAD = "ag-lead";

    @TempDir
    Path data;

    // ================================================================ the estimate

    @Test
    void aBriefsSizeComesFromWhatItAsksFor() {
        assertThat(Wallet.size("Summarise today's email from Dana.")).isEqualTo(1.0);
        assertThat(Wallet.size(null)).isEqualTo(1.0);
        // A count of things: 12 laptops is 4 times an ordinary task; 5 or fewer things is ordinary.
        assertThat(Wallet.size("Compare 12 laptops under $1,000")).isEqualTo(4.0);
        assertThat(Wallet.size("Compare 3 laptops")).isEqualTo(1.0);
        // A list of 6 items.
        assertThat(Wallet.size("Do these:\n- a\n- b\n- c\n- d\n- e\n- f")).isEqualTo(2.0);
        // Words that widen it.
        assertThat(Wallet.size("Go through all my receipts")).isEqualTo(1.5);
        assertThat(Wallet.size("Research all 20 competitors in depth")).isEqualTo(6.0);
        // A long brief grows slowly, and nothing passes the top.
        assertThat(Wallet.size("word ".repeat(320))).isEqualTo(2.0);
        assertThat(Wallet.size("Research every one of 500 companies in depth\n" + "word ".repeat(900)))
                .isEqualTo(Wallet.MAX_SIZE);
        // A year isn't a count of things.
        assertThat(Wallet.size("Find the 2026 reports")).isEqualTo(1.0);
    }

    @Test
    void theEstimateIsTheAgentsUsualTaskTimesTheBriefsSize() {
        // Her own briefs' average there wins once it has two; then its tasks'; then the default.
        Wallet.Headroom both = new Wallet.Headroom(null, null, null, null, 300_000L, 9, 120_000L, 3);
        assertThat(Wallet.estimate(both, "Check my calendar").microUsd()).isEqualTo(120_000L);
        Wallet.Headroom tasks = new Wallet.Headroom(null, null, null, null, 300_000L, 9, 120_000L, 1);
        Wallet.Estimate e = Wallet.estimate(tasks, "Compare 12 laptops");
        assertThat(e.microUsd()).isEqualTo(1_200_000L);
        assertThat(e.usualMicroUsd()).isEqualTo(300_000L);
        assertThat(e.fromHistory()).isTrue();
        Wallet.Estimate fresh = Wallet.estimate(new Wallet.Headroom(null, null, null, null, 900_000L, 1, null, 0),
                "Check my calendar");
        assertThat(fresh.microUsd()).isEqualTo(Wallet.DEFAULT_TASK);
        assertThat(fresh.fromHistory()).isFalse();
        assertThat(Wallet.estimate(null, "x").microUsd()).isEqualTo(Wallet.DEFAULT_TASK);
        // Never under a cent.
        assertThat(Wallet.estimate(new Wallet.Headroom(null, null, null, null, 10L, 5, null, 0), "x").microUsd())
                .isEqualTo(Wallet.FLOOR);
    }

    // ================================================================ the rule

    private static Wallet.Settings settings(long daily, long ask, Wallet.AlwaysOk... always) {
        return new Wallet.Settings(daily, ask, List.of(always));
    }

    @Test
    void aNormalDayNeverAsks() {
        Wallet.Headroom h = new Wallet.Headroom(2_000_000L, 15_000_000L, 2_000_000L, 1_250_000L, 200_000L, 10, null, 0);
        Wallet.Settings s = settings(Wallet.DEFAULT_DAILY, Wallet.DEFAULT_ASK_ABOVE);
        long committed = 0;
        // Twelve ordinary briefs at its usual $0.20: none asks, inside the $3 budget.
        for (int i = 0; i < 12; i++) {
            Wallet.Decision d = Wallet.decide(Wallet.estimate(h, "Check the weather and my calendar"), h, s, null,
                    committed, false);
            assertThat(d.kind()).isEqualTo(Wallet.Kind.GO);
            committed += d.estimate().microUsd();
        }
        assertThat(committed).isEqualTo(2_400_000L);
    }

    @Test
    void itAsksOnlyForAnUnusualCostOverTheLineOrPastTheBudget() {
        Wallet.Headroom h = new Wallet.Headroom(null, null, null, null, 100_000L, 10, null, 0);
        Wallet.Settings s = settings(3_000_000L, 500_000L);
        // 6 times its usual, but only $0.60 and over the $0.50 line: asks.
        Wallet.Estimate big = Wallet.estimate(h, "Research all 20 competitors in depth");
        assertThat(big.microUsd()).isEqualTo(600_000L);
        assertThat(Wallet.decide(big, h, s, null, 0, false).kind()).isEqualTo(Wallet.Kind.UNUSUAL);
        // Over the line but usual for this agent (a pricier agent): no ask.
        Wallet.Headroom pricey = new Wallet.Headroom(null, null, null, null, 700_000L, 10, null, 0);
        assertThat(Wallet.decide(Wallet.estimate(pricey, "Draft the memo"), pricey, s, null, 0, false).kind())
                .isEqualTo(Wallet.Kind.GO);
        // Unusual but under the line: no ask.
        assertThat(Wallet.decide(big, h, settings(3_000_000L, 1_000_000L), null, 0, false).kind())
                .isEqualTo(Wallet.Kind.GO);
        // Past the day's budget: asks, whatever its size.
        Wallet.Estimate small = Wallet.estimate(h, "Check my calendar");
        assertThat(Wallet.decide(small, h, s, null, 2_950_000L, false).kind()).isEqualTo(Wallet.Kind.BUDGET);
        // "Always OK for tasks like this" covers both, up to its size.
        Wallet.AlwaysOk ok = new Wallet.AlwaysOk(WORK, LEAD, 800_000L, 0);
        assertThat(Wallet.decide(big, h, s, ok, 0, false).kind()).isEqualTo(Wallet.Kind.GO);
        assertThat(Wallet.decide(small, h, s, ok, 2_950_000L, false).kind()).isEqualTo(Wallet.Kind.GO);
        Wallet.Estimate bigger = new Wallet.Estimate(900_000L, 100_000L, true, 6);
        assertThat(Wallet.decide(bigger, h, s, ok, 0, false).kind()).isEqualTo(Wallet.Kind.UNUSUAL);
    }

    @Test
    void anAgentsOwnLimitsAreNeverWaived() {
        Wallet.Settings s = settings(3_000_000L, 500_000L);
        Wallet.Estimate e = new Wallet.Estimate(400_000L, 400_000L, true, 1);
        Wallet.Headroom day = new Wallet.Headroom(100_000L, 9_000_000L, 2_000_000L, 1_000_000L, 400_000L, 5, null, 0);
        Wallet.Decision d = Wallet.decide(e, day, s, new Wallet.AlwaysOk(WORK, LEAD, 5_000_000L, 0), 0, false);
        assertThat(d.kind()).isEqualTo(Wallet.Kind.LIMIT);
        assertThat(d.limit()).isEqualTo("day");
        assertThat(d.left()).isEqualTo(100_000L);
        Wallet.Headroom month = new Wallet.Headroom(null, 50_000L, null, null, 400_000L, 5, null, 0);
        assertThat(Wallet.decide(e, month, s, null, 0, false).limit()).isEqualTo("month");
        Wallet.Headroom brief = new Wallet.Headroom(null, null, null, 300_000L, 400_000L, 5, null, 0);
        assertThat(Wallet.decide(e, brief, s, null, 0, false).limit()).isEqualTo("brief");
        // The member's "Try anyway" lets it on while something is left (the desk stops it at its limit); never at 0.
        assertThat(Wallet.decide(e, day, s, null, 0, true).kind()).isEqualTo(Wallet.Kind.GO);
        Wallet.Headroom none = new Wallet.Headroom(0L, null, null, null, 400_000L, 5, null, 0);
        assertThat(Wallet.decide(e, none, s, null, 0, true).kind()).isEqualTo(Wallet.Kind.LIMIT);
    }

    // ================================================================ on a desk: the guard, the card, the taps

    @Test
    void anOrdinaryBriefGoesWithNoCardAndCountsTowardTheDay() throws Exception {
        try (Rig r = new Rig(data)) {
            r.on();
            r.observe(headroom(2_000_000L, 15_000_000L, 1_250_000L, 200_000L, 6), null);
            assertThat(r.refusal("r1", "Check my calendar for tomorrow")).isNull();
            r.ran("r1", "Check my calendar for tomorrow");
            assertThat(r.posted).isEmpty();
            assertThat(r.mode.wallet().committedToday()).isEqualTo(200_000L);
            // The room's day summary has it, per desk, in dollars of the member's own keys.
            Map<String, Object> briefs = map(r.mode.room().snapshot().get("briefs"));
            assertThat(briefs).containsEntry("todayMicroUsd", 200_000L).containsEntry("budgetMicroUsd", 3_000_000L);
            assertThat(map(r.mode.room().snapshot().get("foot")).get("line").toString())
                    .endsWith("Briefs today $0.20 of $3");
            // The answer comes, and the desk's own figure takes over from the estimate.
            r.mode.briefAnswered(WORK, "Work", "Lead", null);
            r.observe(headroom(1_820_000L, 14_820_000L, 1_070_000L, 190_000L, 7),
                    Map.of("todayMicroUsd", 180_000L, "monthMicroUsd", 4_180_000L, "today", 1, "month", 9));
            assertThat(r.mode.wallet().committedToday()).isEqualTo(180_000L);
            List<Map<String, Object>> desks = list(map(r.mode.room().snapshot().get("briefs")).get("desks"));
            assertThat(desks).anySatisfy(d -> assertThat(d).containsEntry("deskId", WORK)
                    .containsEntry("deskName", "Work").containsEntry("monthMicroUsd", 4_180_000L));
        }
    }

    @Test
    void anUnusualBriefIsHeldWithOneCardAndAlwaysOkKeepsItFromAskingAgain() throws Exception {
        try (Rig r = new Rig(data)) {
            r.on();
            r.observe(headroom(5_000_000L, 15_000_000L, 2_000_000L, 200_000L, 6), null);
            String big = "Research all 20 competitors in depth";
            assertThat(r.refusal("r1", big)).isEqualTo("maia_held");
            // The guard runs again as the call goes: the same answer, and still one card.
            assertThat(r.refusal("r1", big)).isEqualTo("maia_held");
            assertThat(r.posted).hasSize(1);
            Map<String, Object> card = r.posted.get(0);
            assertThat((String) card.get("text")).isEqualTo("This one's bigger than usual: about $1.20 on your Work"
                    + " Lead, about 6 times its usual task. Go ahead?");
            Map<String, Object> choices = map(map(card.get("extras")).get("choices"));
            assertThat(choices).containsEntry("kind", "budget").containsEntry("other", false)
                    .containsEntry("recommended", "go");
            assertThat(list(choices.get("options"))).extracting(o -> o.get("label"))
                    .containsExactly("Go", "Always OK for tasks like this", "Cheaper way", "Skip");
            assertThat(map(map(card.get("extras")).get("cost"))).containsEntry("line",
                    "About $1.20 · usually $0.20 · Work Lead");
            assertThat(r.audit).anyMatch(a -> a.startsWith("agent:maia maia.brief.held desk:" + WORK));
            // Her note says it's waiting, and her own question waits too.
            assertThat(r.profile.setup().note()).contains("Waiting on the member: your brief to \"Work\"");
            assertThat(r.mode.offer("m-hers", Map.of("question", "Which?", "choices", List.of("A", "B"))))
                    .startsWith("Refused: held.");
            // "Always OK for tasks like this": kept for that agent, a little over this size; the tap goes to her.
            String cardId = (String) card.get("messageId");
            r.call("agent.maia.choose", "messageId", cardId, "choiceId", "always");
            assertThat(r.sent).containsExactly("Always OK for tasks like this");
            List<Map<String, Object>> always = list(map(map(r.call("agent.maia.get").get("maia")).get("budget"))
                    .get("alwaysOk"));
            assertThat(always).singleElement().satisfies(a -> assertThat(a).containsEntry("deskId", WORK)
                    .containsEntry("agentId", LEAD).containsEntry("upToUsd", 1.5));
            assertThat(r.profile.setup().note()).contains("The member said yes to your held brief to \"Work\"")
                    .contains(new String(Json.bytes(big), StandardCharsets.UTF_8));
            // Her next run sends it: it goes, and so does the next one of its size in a later run.
            assertThat(r.refusal("r2", big)).isNull();
            r.ran("r2", big);
            assertThat(r.refusal("r3", big)).isNull();
            assertThat(r.posted).hasSize(1);
        }
    }

    @Test
    void pastTheBudgetItAsksAndGoLetsOneThrough() throws Exception {
        try (Rig r = new Rig(data)) {
            r.on();
            r.call("agent.maia.set", "budget", Map.of("dailyUsd", 0.5));
            r.observe(headroom(5_000_000L, 15_000_000L, 2_000_000L, 200_000L, 6),
                    Map.of("todayMicroUsd", 400_000L, "monthMicroUsd", 400_000L, "today", 2, "month", 2));
            assertThat(r.refusal("r1", "Check my calendar")).isEqualTo("maia_held");
            Map<String, Object> card = r.posted.get(0);
            assertThat((String) card.get("text")).isEqualTo("About $0.20 on your Work Lead would take my briefs past"
                    + " today's $0.50 budget ($0.40 used). Go ahead?");
            assertThat(list(map(map(card.get("extras")).get("choices")).get("options"))).extracting(o -> o.get("id"))
                    .containsExactly("cheaper", "go", "always", "skip");
            r.call("agent.maia.choose", "messageId", card.get("messageId"), "choiceId", "go");
            assertThat(r.sent).containsExactly("Go");
            assertThat(r.refusal("r2", "Check my calendar")).isNull();
            r.ran("r2", "Check my calendar");
            // One brief: the next asks again.
            assertThat(r.refusal("r3", "Check my email")).isEqualTo("maia_held");
        }
    }

    @Test
    void nearAnAgentsLimitSheSaysSoPlainlyAndOffersOptionsInsteadOfFailing() throws Exception {
        try (Rig r = new Rig(data)) {
            r.on();
            r.observe(headroom(100_000L, 15_000_000L, 2_000_000L, 400_000L, 6), null);
            assertThat(r.refusal("r1", "Draft the memo")).isEqualTo("maia_limit");
            Map<String, Object> card = r.posted.get(0);
            assertThat((String) card.get("text")).isEqualTo("Your Work Lead has $0.10 left today, and this is about"
                    + " $0.40. It would stop at its limit.");
            assertThat(list(map(map(card.get("extras")).get("choices")).get("options"))).extracting(o -> o.get("label"))
                    .containsExactly("Cheaper way", "Try anyway", "Skip");
            // Skip starts nothing and lets it go.
            Map<String, Object> skipped = r.call("agent.maia.choose", "messageId", card.get("messageId"), "choiceId",
                    "skip");
            assertThat(skipped).containsOnlyKeys("messageId");
            assertThat(r.sent).isEmpty();
            assertThat(r.profile.setup().note()).doesNotContain("Waiting on the member");
            // With nothing left, "Go" isn't offered at all: the desk would refuse it anyway.
            r.observe(headroom(0L, 15_000_000L, 2_000_000L, 400_000L, 6), null);
            assertThat(r.refusal("r2", "Draft the memo")).isEqualTo("maia_limit");
            Map<String, Object> none = r.posted.get(1);
            assertThat((String) none.get("text")).startsWith("Your Work Lead has $0 left today");
            assertThat(list(map(map(none.get("extras")).get("choices")).get("options"))).extracting(o -> o.get("id"))
                    .containsExactly("another", "skip");
            // "Another way" goes to her with what to look for, and she can't send it there.
            r.call("agent.maia.choose", "messageId", none.get("messageId"), "choiceId", "another");
            assertThat(r.sent).containsExactly("Another way");
            assertThat(r.profile.setup().note()).contains("The member asked for another way for your held brief");
            assertThat(r.refusal("r3", "Draft the memo")).isEqualTo("maia_limit");
        }
    }

    @Test
    void herNoteHasEachDesksAgentWhatsLeftAndTheBudgetAndNothingWithoutADesk() throws Exception {
        try (Rig r = new Rig(data, false)) {
            r.on();
            assertThat(r.mode.wallet().noteLines()).isEmpty();
            r.grant();
            r.observe(headroom(1_050_000L, 12_300_000L, 500_000L, 200_000L, 6), null);
            String note = r.profile.setup().note();
            assertThat(note).contains("Briefs today: $0 of the member's $3 daily budget for your briefs; this month $0.")
                    .contains("\"Work\" (" + WORK + "): \"Lead\", usual task about $0.20, $1.05 left today, $12.30 left"
                            + " this month, one brief may spend up to $0.50.");
            // The rules are in her stable context, the figures only in her note.
            assertThat(r.profile.setup().instructions()).contains(MaiaProfile.MONEY).doesNotContain("$");
            // office_desks has the figures as data too.
            assertThat(r.profile.desksJson()).contains("\"usualTaskUsd\":0.2").contains("\"leftTodayUsd\":1.05");
        }
    }

    /** Security's MB-M1: a brief that went is judged again when the same text is sent again in the run. */
    @Test
    void theSameBriefSentAgainInARunIsJudgedAgain() throws Exception {
        try (Rig r = new Rig(data)) {
            r.on();
            r.call("agent.maia.set", "budget", Map.of("dailyUsd", 0.5));
            r.observe(headroom(5_000_000L, 15_000_000L, 2_000_000L, 200_000L, 6), null);
            String b = "Check my calendar";
            for (int i = 0; i < 2; i++) {
                assertThat(r.refusal("r1", b)).isNull();
                assertThat(r.refusal("r1", b)).isNull();
                r.ran("r1", b);
            }
            // $0.40 out: a third $0.20 passes the $0.50 budget, same run, same words.
            assertThat(r.refusal("r1", b)).isEqualTo("maia_held");
            // One that didn't go (deskd refused it) is judged again too.
            r.observe(headroom(5_000_000L, 15_000_000L, 2_000_000L, 100_000L, 6), null);
            r.call("agent.maia.set", "budget", Map.of("dailyUsd", 100));
            assertThat(r.refusal("r2", b)).isNull();
            r.profile.ran(Rig.run("r2"), "desk_message", Map.of("desk", WORK, "text", b), false);
            r.observe(headroom(0L, 15_000_000L, 2_000_000L, 100_000L, 6), null);
            assertThat(r.refusal("r2", b)).isEqualTo("maia_limit");
        }
    }

    /** Security's MB-L1: decided is decided; a card that can't be made still holds the brief. */
    @Test
    void aBriefStaysHeldWhenItsCardCantBeMade() throws Exception {
        try (Rig r = new Rig(data)) {
            r.on();
            r.observe(headroom(5_000_000L, 15_000_000L, 2_000_000L, 200_000L, 6), null);
            r.failAudit.set(true);
            assertThat(r.refusal("r1", "Research all 20 competitors in depth")).isEqualTo("maia_held");
        }
    }

    /** Security's MB-I2: the member wrote something else instead of tapping: nothing waits on the card any more. */
    @Test
    void aCardPassedByLeavesNothingWaiting() throws Exception {
        try (Rig r = new Rig(data)) {
            r.on();
            r.observe(headroom(5_000_000L, 15_000_000L, 2_000_000L, 200_000L, 6), null);
            assertThat(r.refusal("r1", "Research all 20 competitors in depth")).isEqualTo("maia_held");
            assertThat(r.profile.setup().note()).contains("Waiting on the member");
            r.mode.beforeSend("Actually, never mind that", null);
            assertThat(r.profile.setup().note()).doesNotContain("Waiting on the member");
            assertThat(r.mode.wallet().cardOpen()).isFalse();
        }
    }

    // ================================================================ nothing she does changes a limit

    @Test
    void noToolOfHersChangesABudgetALimitOrAGrant() {
        for (ToolSpec spec : MaiaTools.specs()) {
            String n = spec.name().toLowerCase(java.util.Locale.ROOT);
            assertThat(n).doesNotContain("limit").doesNotContain("budget").doesNotContain("grant")
                    .doesNotContain("cap").doesNotContain("set");
        }
        assertThat(MaiaTools.NAMES).containsExactlyInAnyOrder("office_desks", "office_desk_status", "office_show",
                "ask_member", "maia_check_in", "maia_read", "working_on", "paper_note");
        // Her deskd areas: To-do, briefs and Documents' index (read only: no place, rule or budget of hers changes).
        assertThat(MaiaProfile.AREAS).allMatch(a -> a.startsWith("todo_") || a.equals("desk_message")
                || com.minimalistalliance.desk.agent.tool.ToolRegistry.DOCS.contains(a));
        com.minimalistalliance.desk.agent.tool.ToolRegistry registry = new com.minimalistalliance.desk.agent.tool.ToolRegistry();
        for (String docs : com.minimalistalliance.desk.agent.tool.ToolRegistry.DOCS) {
            assertThat(registry.decl(docs).risk()).as(docs).isEqualTo(com.minimalistalliance.desk.agent.tool.Risk.READ);
            assertThat(docs).doesNotContain("limit").doesNotContain("budget").doesNotContain("grant")
                    .doesNotContain("cap").doesNotContain("set");
        }
    }

    @Test
    void herOwnChoicesCantMakeAnAlwaysOkAndTheMemberCanOnlyNarrowIt() throws Exception {
        try (Rig r = new Rig(data)) {
            r.on();
            // She words her own question as code's card: tapping it is only the member's words to her.
            r.mode.offer("m-hers", Map.of("question", "About $5 on your Work Lead. Go ahead?", "choices",
                    List.of("Always OK for tasks like this", "Skip")));
            r.call("agent.maia.choose", "messageId", "m-hers", "choiceId", "c1");
            assertThat(r.sent).containsExactly("Always OK for tasks like this");
            assertThat(map(map(r.call("agent.maia.get").get("maia")).get("budget")).get("alwaysOk"))
                    .asList().isEmpty();
            // And the member's own settings only ever narrow "Always OK": a new one comes from code's card.
            RpcError e = r.refused("agent.maia.set", "budget", Map.of("alwaysOk", List.of(Map.of("deskId", WORK,
                    "agentId", LEAD))));
            assertThat(e.details()).containsEntry("reason", "narrow_only");
            assertThat(r.refused("agent.maia.set", "budget", Map.of("dailyUsd", 5000)).details())
                    .containsEntry("reason", "range");
            assertThat(r.refused("agent.maia.set", "budget", Map.of("perRunUsd", 1)).details())
                    .containsEntry("detail", "budget.perRunUsd");
            // Nobody but the member's own session sets it.
            assertThatThrownBy(() -> r.mode.call("agent.maia.set", Map.of("budget", Map.of("dailyUsd", 50)),
                    Caller.SYSTEM, d -> "active")).isInstanceOf(RpcError.class);
        }
    }

    // ================================================================ the rig

    private static Map<String, Object> headroom(long dayLeft, long monthLeft, long briefMax, long perTask, int tasks) {
        Map<String, Object> h = new LinkedHashMap<>();
        h.put("dayLeftMicroUsd", dayLeft);
        h.put("monthLeftMicroUsd", monthLeft);
        h.put("runMaxMicroUsd", 2_000_000L);
        h.put("briefMaxMicroUsd", briefMax);
        h.put("perTaskMicroUsd", perTask);
        h.put("tasks", tasks);
        h.put("perBriefMicroUsd", null);
        h.put("briefs", 0);
        return h;
    }

    /** Maia Mode on a real {@code agent.db}, the service's side faked: who answers, the card's poster, the taps. */
    private static final class Rig implements AutoCloseable {
        final MutableClock clock = new MutableClock(com.minimalistalliance.desk.agent.testing.Rig.START);
        final AgentStore store;
        final MaiaMode mode;
        final MaiaProfile profile;
        final List<Map<String, Object>> posted = new CopyOnWriteArrayList<>();
        final List<String> sent = new CopyOnWriteArrayList<>();
        final List<String> audit = new CopyOnWriteArrayList<>();
        final AtomicInteger ids = new AtomicInteger();
        final java.util.concurrent.atomic.AtomicBoolean failAudit = new java.util.concurrent.atomic.AtomicBoolean();
        private final Path data;
        private final boolean granted;

        Rig(Path data) throws SQLException {
            this(data, true);
        }

        Rig(Path data, boolean granted) throws SQLException {
            this.data = data;
            this.granted = granted;
            store = new AgentStore(data.resolve("agent.db"), clock);
            store.open();
            mode = new MaiaMode(new MaiaStore(store, clock), clock, data, new Host(),
                    (actor, action, target, decision) -> {
                        if (failAudit.get()) {
                            throw new IllegalStateException("audit");
                        }
                        audit.add(actor + " " + action + " " + target + " " + decision);
                    }, room -> {}, null);
            profile = new MaiaProfile(mode, n -> List.of());
            mode.poster((text, extras) -> {
                String id = "m-card-" + ids.incrementAndGet();
                mode.store().putExtras(id, extras);
                Map<String, Object> p = new LinkedHashMap<>();
                p.put("messageId", id);
                p.put("text", text);
                p.put("extras", extras);
                posted.add(p);
                return id;
            });
        }

        void on() throws Exception {
            Files.writeString(data.resolve(MaiaMode.SWITCH_FILE), "on\n");
            call("agent.maia.set", "on", true, "disclosure", MaiaMode.DISCLOSURE, "homeDeskId", "d-home1");
            if (granted) {
                grant();
            }
        }

        void grant() throws Exception {
            call("agent.maia.grant.set", "deskId", WORK, "deskName", "Work", "scopes", List.of("brief"));
        }

        void observe(Map<String, Object> leadBudget, Map<String, Object> briefs) throws Exception {
            clock.advance(java.time.Duration.ofSeconds(2));
            Map<String, Object> lead = new LinkedHashMap<>();
            lead.put("agentId", LEAD);
            lead.put("name", "Lead");
            lead.put("status", "online");
            lead.put("budget", leadBudget);
            Map<String, Object> work = new LinkedHashMap<>();
            work.put("deskId", WORK);
            work.put("name", "Work");
            work.put("kind", "work");
            work.put("state", "running");
            work.put("link", "open");
            work.put("agents", List.of(lead, Map.of("agentId", "ag-scout", "name", "Scout", "status", "online")));
            if (briefs != null) {
                work.put("briefs", briefs);
            }
            call("agent.maia.observe", "desks", List.of(work, Map.of("deskId", PERSONAL, "name", "Personal",
                    "kind", "personal", "state", "running", "link", "open")));
        }

        String refusal(String runId, String text) {
            return profile.refusal(run(runId), "desk_message", Map.of("desk", WORK, "text", text));
        }

        void ran(String runId, String text) {
            profile.ran(run(runId), "desk_message", Map.of("desk", WORK, "text", text), true);
        }

        private static RunContext run(String runId) {
            return RunContext.of(runId, MaiaAgent.ID, Caller.OWNER, Map.of("kind", "member"), "m-" + runId);
        }

        Map<String, Object> call(String method, Object... pairs) throws RpcError, SQLException {
            return mode.call(method, TeamDesk.m(pairs), Caller.OWNER, d -> "active");
        }

        RpcError refused(String method, Object... pairs) {
            try {
                call(method, pairs);
            } catch (RpcError e) {
                return e;
            } catch (SQLException e) {
                throw new AssertionError(e);
            }
            throw new AssertionError(method + " wasn't refused");
        }

        @Override
        public void close() {
            mode.close();
            store.close();
        }

        private final class Host implements MaiaMode.Host {
            @Override
            public Map<String, Object> sendAsMember(String text) {
                sent.add(text);
                return Map.of("messageId", "m-sent-" + sent.size(), "runId", "r-sent-" + sent.size());
            }

            @Override
            public void stopRuns() {}

            @Override
            public ZoneId zone() {
                return ZoneOffset.UTC;
            }

            @Override
            public void clearMemory() {}

            @Override
            public void republish(String messageId) {}

            @Override
            public String tier() {
                return null;
            }

            @Override
            public boolean guildDesk() {
                return false;
            }

            @Override
            public boolean adult() {
                return true;
            }

            @Override
            public String[] answeringAgent(String deskId) {
                return WORK.equals(deskId) ? new String[] {LEAD, "Lead"} : null;
            }
        }
    }
}
