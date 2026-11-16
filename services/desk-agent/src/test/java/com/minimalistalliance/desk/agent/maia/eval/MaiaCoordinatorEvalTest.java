package com.minimalistalliance.desk.agent.maia.eval;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.agent.maia.MaiaAgent;
import com.minimalistalliance.desk.agent.maia.MaiaMode;
import com.minimalistalliance.desk.agent.maia.MaiaTools;
import com.minimalistalliance.desk.agent.manager.ManagerAgent;
import com.minimalistalliance.desk.agent.provider.ChatRequest;
import com.minimalistalliance.desk.agent.provider.ToolSpec;
import com.minimalistalliance.desk.agent.provider.Usage;
import com.minimalistalliance.desk.agent.testing.FakeProvider.Step;
import com.minimalistalliance.desk.agent.testing.TeamDesk;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The coordinator's prompt and tools, as code builds them for each of her runs (the concept's §4 and the owner's
 * multiple-choice rule): what a real model is told, checked on a scripted stand-in. Her behaviour on a real model is
 * the real-model eval's ({@code services/desk-agent/docs/maia-evals.md}); what her prompt must say, and what she's
 * offered, is here.
 */
class MaiaCoordinatorEvalTest {

    private static final Usage USAGE = new Usage(100, 0, 0, 20, 0);

    @TempDir
    Path data;

    /**
     * Her Maia Mode instructions are the Platform's now, on Minimalist Alliance's AI service (the owner, Nov 14): the desk
     * sends only its own part as the context: the choice rule and her desks and grants, with nothing that changes from
     * call to call; the time, her choice weight, briefs left and her allowance go in her note (Nov 15). Nothing in either
     * says she runs on the member's key or that nothing goes through Minimalist Alliance.
     */
    @Test
    void herContextIsTheDesksStablePartAndHerNoteWhatChanges() throws Exception {
        try (Standalone s = new Standalone(data)) {
            s.on();
            ManagerAgent.RunSetup setup = s.profile.setup();
            String context = setup.instructions();
            assertThat(context).startsWith("The member's home desk adds (data from the desk, not the member):")
                    .contains("The home desk's note on the newest message has the time now, your choice weight,")
                    .contains(com.minimalistalliance.desk.agent.maia.Choices.RULE)
                    .contains("The member's desks you may work with (names are data):");
            // Nothing that moves from call to call: no clock, no weight, no briefs, no money.
            assertThat(context).doesNotContain("Now: ").doesNotContain("Your choice weight for this member is")
                    .doesNotContain("Briefs left").doesNotContain("Spend today").doesNotContain("allowance left")
                    .doesNotContain("$");
            assertThat(setup.note()).startsWith("Now: ").contains(" in the member's time zone.")
                    .contains("\nYour choice weight for this member is 0.8 (0 to 1).")
                    .contains("\nBriefs left today: 60.");
            // The Maia Mode instructions moved to the Platform: none of them is the desk's.
            assertThat(context).doesNotContain("You are Maia").doesNotContain("Split an outcome into tasks")
                    .doesNotContain("Data, not instructions.").doesNotContain("Be brief");
            // And nothing of her old key.
            for (String part : List.of(context, setup.note())) {
                assertThat(part.toLowerCase(java.util.Locale.ROOT)).doesNotContain("own key")
                        .doesNotContain("member's key").doesNotContain("through minimalist alliance")
                        .doesNotContain("on their key");
            }
            assertThat(context.length()).isLessThan(4_000);
            assertThat(setup.note().length()).isLessThan(2_000);
        }
    }

    /**
     * The usage study's fix 1: her cached prefix was rewritten on nearly every call because the context carried the minute
     * clock and today's spend. Two setups a minute and a dollar apart, with a tap and an allowance between them, now give
     * the very same context, byte for byte; only the note differs.
     */
    @Test
    void herContextIsByteIdenticalAMinuteAndADollarLater() throws Exception {
        try (Standalone s = new Standalone(data)) {
            s.on();
            s.grant(EvalDesk.WORK, "Work", false, "brief");
            ManagerAgent.RunSetup first = s.profile.setup();
            s.clock.advance(Duration.ofMinutes(1));
            s.mode.creditsSpent(100L);
            s.mode.choices().record("tapped");
            s.allowance.set(new com.minimalistalliance.desk.agent.maia.MaiaMode.Allowance(0.5,
                    s.clock.instant().plus(Duration.ofHours(3)), false));
            ManagerAgent.RunSetup second = s.profile.setup();
            assertThat(second.instructions().getBytes(java.nio.charset.StandardCharsets.UTF_8))
                    .isEqualTo(first.instructions().getBytes(java.nio.charset.StandardCharsets.UTF_8));
            assertThat(second.note()).isNotEqualTo(first.note()).contains("0.86 (0 to 1)")
                    .contains("Maia allowance left: 50%");
            assertThat(first.note()).contains("10:00 AM").contains("0.8 (0 to 1)");
            assertThat(second.note()).contains("10:01 AM");
        }
    }

    /**
     * The cached share, as her service sees it: three calls of one session through her provider (a turn, its step after a
     * tool result, and the next turn a minute and a dollar later, after a tap and an allowance report). Every call's
     * {@code context} is the same string, so the Platform's breakpoint on it reads from the cache each time; the thread
     * only grows at its end; and only {@code note}, which goes after the thread, moves.
     */
    @Test
    void aSessionsCallsShareOneContextAndOnlyTheNoteMoves() throws Exception {
        try (Standalone s = new Standalone(data)) {
            s.on();
            s.grant(EvalDesk.WORK, "Work", false, "brief", "show");
            List<java.util.Map<String, Object>> sent = new java.util.concurrent.CopyOnWriteArrayList<>();
            com.minimalistalliance.desk.agent.provider.ma.MaiaServiceProvider service =
                    new com.minimalistalliance.desk.agent.provider.ma.MaiaServiceProvider(s.clock);
            service.link(new com.minimalistalliance.desk.agent.tool.DeskLink() {
                @Override
                public Set<String> offered() {
                    return Set.of();
                }

                @Override
                public boolean maiaModel() {
                    return true;
                }

                @Override
                @SuppressWarnings("unchecked")
                public Reply call(java.util.Map<String, Object> call, Duration wait) {
                    sent.add((java.util.Map<String, Object>) call.get("args"));
                    return new Reply(true, java.util.Map.of("v", 1, "text", "ok", "allowance", java.util.Map.of(
                            "fraction", 0.7, "resetsAt", "2026-11-04T17:00:00.000Z")), null, null, List.of());
                }
            });
            com.minimalistalliance.desk.agent.key.KeyLease lease = new com.minimalistalliance.desk.agent.key.KeyRing(
                    (a, t, d) -> {}).lend(com.minimalistalliance.desk.agent.key.KeyRing.COMPANY);

            // Her run: the turn, then its step after a tool result, on the one setup the run was given.
            ManagerAgent.RunSetup run = s.profile.setup();
            List<com.minimalistalliance.desk.agent.provider.ChatMessage> thread = new java.util.ArrayList<>(List.of(
                    com.minimalistalliance.desk.agent.provider.ChatMessage.user("What's waiting on my desks?")));
            service.chat(new ChatRequest("turn", run.instructions(), thread, 4_000, run.tools().specs(), run.note()),
                    lease, t -> {});
            thread.add(com.minimalistalliance.desk.agent.provider.ChatMessage.toolCalls("", List.of(
                    new com.minimalistalliance.desk.agent.provider.ToolCall("t1", "office_desks", java.util.Map.of()))));
            thread.add(com.minimalistalliance.desk.agent.provider.ChatMessage.toolResults(List.of(
                    new com.minimalistalliance.desk.agent.provider.ToolResult("t1", "{\"desks\":[]}", false))));
            service.chat(new ChatRequest("turn", run.instructions(), thread, 4_000, run.tools().specs(), run.note()),
                    lease, t -> {});
            thread.add(com.minimalistalliance.desk.agent.provider.ChatMessage.assistant("Nothing is waiting."));

            // The next turn, a minute and a dollar later, after a tap and her service's allowance report.
            s.clock.advance(Duration.ofMinutes(1));
            s.mode.creditsSpent(100L);
            s.mode.choices().record("tapped");
            com.minimalistalliance.desk.agent.provider.ma.MaiaServiceProvider.Allowance left = service.allowance();
            s.allowance.set(new com.minimalistalliance.desk.agent.maia.MaiaMode.Allowance(left.fraction(),
                    left.resetsAt(), false));
            ManagerAgent.RunSetup next = s.profile.setup();
            thread.add(com.minimalistalliance.desk.agent.provider.ChatMessage.user("Thanks. Anything on Work?"));
            service.chat(new ChatRequest("turn", next.instructions(), thread, 4_000, next.tools().specs(), next.note()),
                    lease, t -> {});

            assertThat(sent).hasSize(3);
            assertThat(sent).extracting(a -> a.get("task")).containsExactly("turn", "step", "turn");
            // One context for the whole session: byte for byte.
            assertThat(sent).extracting(a -> a.get("context")).containsOnly(sent.get(0).get("context"));
            // The thread only grows at its end, so the breakpoint on its last block finds the last call's entry.
            List<?> first = (List<?>) sent.get(0).get("messages");
            List<?> second = (List<?>) sent.get(1).get("messages");
            List<?> third = (List<?>) sent.get(2).get("messages");
            assertThat(second.subList(0, first.size())).isEqualTo(first);
            assertThat(third.subList(0, second.size())).isEqualTo(second);
            // And the note is what moved: the time, the weight, the allowance.
            assertThat(sent.get(1).get("note")).isEqualTo(sent.get(0).get("note"));
            assertThat((String) sent.get(2).get("note")).isNotEqualTo(sent.get(0).get("note")).contains("10:01 AM")
                    .contains("0.86 (0 to 1)").contains("Maia allowance left: 70% (resets 5:00 pm).");
            assertThat((String) sent.get(0).get("note")).contains("10:00 AM").doesNotContain("allowance");
        }
    }

    /**
     * The same through the whole desk: two of her real turns a minute apart, through the agent service, her memory, the
     * desk's tool rules and the contract stand-in. Her context, everything the desk adds to it included, is the same both
     * times; the note moved; the note-taker gets none.
     */
    @Test
    void twoRealTurnsAMinuteApartSendTheSameContext() throws Exception {
        try (EvalDesk m = new EvalDesk(data)) {
            m.on();
            m.desk.provider.then(Step.answer(USAGE, "Hello.")).then(Step.answer(USAGE, "{\"notes\": []}"));
            m.desk.ask(MaiaAgent.ID, "Hi");
            m.awaitTaker(1);
            m.desk.clock.advance(Duration.ofMinutes(1));
            m.desk.provider.then(Step.answer(USAGE, "Sure.")).then(Step.answer(USAGE, "{\"notes\": []}"));
            m.desk.ask(MaiaAgent.ID, "Plan my day");
            m.awaitTaker(2);
            List<java.util.Map<String, Object>> turns = m.deskd.service.calls.stream()
                    .filter(a -> "turn".equals(a.get("task"))).toList();
            assertThat(turns).hasSize(2);
            assertThat(turns.get(1).get("context")).isEqualTo(turns.get(0).get("context"));
            assertThat((String) turns.get(0).get("context")).contains("Private things are never remembered");
            assertThat(turns.get(1).get("note")).isNotEqualTo(turns.get(0).get("note"));
            assertThat(m.deskd.service.calls.stream().filter(a -> "notes".equals(a.get("task"))))
                    .allMatch(a -> !a.containsKey("note"));
        }
    }

    @Test
    void herContextCarriesTheRuleAndHerNoteTheWeightWhichFollowsTheMember() throws Exception {
        try (Standalone s = new Standalone(data)) {
            s.on();
            assertThat(s.profile.setup().instructions()).contains("Offer choices when your choice weight for this"
                    + " member (in the home desk's note) is above 0.5, and always for a decision with clear options or"
                    + " anything that needs the member's OK, however low the weight.");
            assertThat(s.profile.setup().note()).contains("Your choice weight for this member is 0.8 (0 to 1).");
            // The member keeps passing her choices by: the weight falls, and her next note says so.
            for (int i = 0; i < 4; i++) {
                s.mode.choices().record("ignored");
            }
            assertThat(s.profile.setup().note()).contains("Your choice weight for this member is 0.4 ");
            // Asking for options puts it straight back.
            s.mode.choices().record("askedMore");
            assertThat(s.profile.setup().note()).contains("Your choice weight for this member is 0.8 ");
        }
    }

    @Test
    void herPromptListsOnlyLiveGrantsWithWhatEachAllows() throws Exception {
        try (Standalone s = new Standalone(data)) {
            s.on();
            // No desks: nothing she must raise, no setting she could send the member to (the owner, Nov 15).
            assertThat(s.profile.setup().instructions()).contains("- none yet, so you can't hand work to a desk's agent.")
                    .doesNotContain("Maia Mode's settings").doesNotContain("switches desks on");
            s.grant(EvalDesk.WORK, "Work", true, "brief", "show");
            s.grant(EvalDesk.PERSONAL, "Personal", false, "show");
            String prompt = s.profile.setup().instructions();
            assertThat(prompt).contains("\"Work\" (" + EvalDesk.WORK + "): brief allowed, show allowed, keeps to"
                    + " itself").contains("\"Personal\" (" + EvalDesk.PERSONAL + "): no briefs, show allowed")
                    .doesNotContain("none yet");
            // Expired grants aren't hers any more.
            s.clock.advance(Duration.ofDays(8));
            assertThat(s.profile.setup().instructions()).contains("- none yet, so").doesNotContain("\"Work\"");
        }
    }

    /**
     * Without credits (a tier that shares its Maia allowance, or a Platform before 0.4.8) her note's allowance line is the
     * share left and when it resets in the member's zone, and a plain stop when it's used up. Before any answer it says
     * nothing of it. Never a dollar figure.
     */
    @Test
    void withoutCreditsHerNoteCarriesTheShareLeftAsBefore() throws Exception {
        try (Standalone s = new Standalone(data)) {
            s.on();
            String note = s.profile.setup().note();
            // No allowance known yet and no cap of the member's own: nothing of it at all.
            assertThat(note).contains("Briefs left today: 60.").doesNotContain("allowance").doesNotContain("credits")
                    .doesNotContain("$").doesNotContain("used");
            // As her service reported it, in the member's zone (UTC here; the clock is 10:00 am).
            s.allowance.set(new MaiaMode.Allowance(0.645, java.time.Instant.parse("2026-11-04T17:00:00Z"), false));
            assertThat(s.profile.setup().note()).contains("\nMaia allowance left: 64% (resets 5:00 pm).")
                    .doesNotContain("You've").doesNotContain("$");
            s.allowance.set(new MaiaMode.Allowance(0.29, java.time.Instant.parse("2026-11-05T07:00:00Z"), false));
            assertThat(s.profile.setup().note()).contains("Maia allowance left: 29% (resets tomorrow 7:00 am).");
            s.allowance.set(new MaiaMode.Allowance(0.9, java.time.Instant.parse("2026-11-09T00:00:00Z"), false));
            assertThat(s.profile.setup().note()).contains("Maia allowance left: 90% (resets Monday 12:00 am).");
            s.allowance.set(new MaiaMode.Allowance(0.9, java.time.Instant.parse("2026-12-01T00:00:00Z"), false));
            assertThat(s.profile.setup().note()).contains("Maia allowance left: 90% (resets 1 December).");
            // Used up (her service said limit): she says so plainly and briefs no one until it resets.
            s.allowance.set(new MaiaMode.Allowance(0, java.time.Instant.parse("2026-11-04T17:00:00Z"), true));
            assertThat(s.profile.setup().note()).contains("Maia allowance left: 0% (resets 5:00 pm).")
                    .contains("You've used the member's Maia allowance for now: say so plainly and don't brief anyone"
                            + " until it resets.")
                    .doesNotContain("$");
        }
    }

    /**
     * With credits (contract 0.4.8, the owner's decisions of Nov 15): what's left of the month's and when they renew (a
     * date, never a countdown), one pace line when today's or this week's share is used (never a stop), top-up credits,
     * and the lighter model when everything is used (she says so once and keeps helping). No dollar figure in any case,
     * and no stop line but a real {@code limit}.
     */
    @Test
    void withCreditsHerNoteSaysWhatsLeftWhereItDrawsFromAndTheLighterModel() throws Exception {
        try (Standalone s = new Standalone(data)) {
            s.on();
            java.time.Instant renews = java.time.Instant.parse("2026-12-01T07:00:00Z");
            java.util.Map<String, String> notes = new java.util.LinkedHashMap<>();
            for (String from : new String[] {"day", "week", "month", "topUp", "lighter", "something_new"}) {
                boolean lighter = "lighter".equals(from);
                MaiaMode.Credits credits = new MaiaMode.Credits(2500, lighter ? 0 : 1550, 800, 120, 200, 90,
                        "topUp".equals(from) ? 300 : 0, "something_new".equals(from) ? null : from);
                s.allowance.set(new MaiaMode.Allowance(lighter ? 0 : 0.62, renews, false, credits, lighter));
                notes.put(from, s.profile.setup().note());
            }
            for (java.util.Map.Entry<String, String> e : notes.entrySet()) {
                assertThat(e.getValue()).as(e.getKey()).doesNotContain("$").doesNotContain("allowance left")
                        .doesNotContain("don't brief").doesNotContain("You've used")
                        .doesNotContainPattern("\\bin \\d|\\d+ ?(h|hours?|min|minutes?)\\b")
                        .contains(" left this month (renews 1 December).");
            }
            assertThat(notes.get("day")).contains("\nMaia credits: 1,550 of 2,500 left this month (renews 1 December).")
                    .doesNotContain("coming from").doesNotContain("lighter");
            assertThat(notes.get("week")).contains("\nToday's share of the member's credits is used, so this is coming"
                    + " from this week's.").doesNotContain("lighter");
            assertThat(notes.get("month")).contains("\nToday's and this week's shares are used, so this is coming from"
                    + " this month's.");
            assertThat(notes.get("topUp")).contains("\nThe month's credits are used; this is coming from top-up"
                    + " credits: 300 left.");
            assertThat(notes.get("lighter")).contains("Maia credits: 0 of 2,500 left this month (renews 1 December).")
                    .contains("\nThe member's Maia credits for this month are used up, so you're on a lighter model"
                            + " until they renew (1 December) or the member tops up: say so plainly once, keep helping,"
                            + " and never stop because of it.")
                    .doesNotContain("coming from");
            assertThat(notes.get("something_new")).doesNotContain("coming from").doesNotContain("lighter");
            // A real limit (even the lighter model's share used up): the one stop line, still no money.
            s.allowance.set(new MaiaMode.Allowance(0, renews, true, new MaiaMode.Credits(2500, 0, 800, 800, 200, 200,
                    0, "lighter"), true));
            assertThat(s.profile.setup().note()).contains("You've used the member's Maia allowance for now")
                    .doesNotContain("keep helping").doesNotContain("$");
        }
    }

    /**
     * The member's one wallet (contract 0.4.10, the coordinator's decision of Nov 15), shared by her and their agents on MA's
     * credits: one line of what's left and its parts, one pace line (month first, then starting, then top-ups), the lighter
     * model with today's share, and a plain line when the plan has none. Never money, never a countdown, no lockout line.
     */
    @Test
    void withTheOneWalletHerNoteSaysWhatsLeftItsPartsAndWhatsInUse() throws Exception {
        try (Standalone s = new Standalone(data)) {
            s.on();
            java.time.Instant renews = java.time.Instant.parse("2026-12-01T07:00:00Z");
            java.util.function.BiFunction<String, long[], String> note = (from, n) -> {
                // n: left, monthLeft, starting, topUp, month
                s.allowance.set(new MaiaMode.Allowance(0.62, n[4] > 0 ? renews : null, false, new MaiaMode.Credits(n[4],
                        n[1], 800, 120, 200, 90, n[3], from, n[0], n[2], "lighter".equals(from) ? 12L : null),
                        "lighter".equals(from)));
                return s.profile.setup().note();
            };
            assertThat(note.apply("day", new long[] {2060, 1550, 210, 300, 2500})).contains("\nCredits: 2,060 left (1,550"
                    + " of this month's 2,500, 210 starting, 300 top-up), shared with the member's agents; this month's renew"
                    + " 1 December.").doesNotContain("coming from").doesNotContain("Maia credits");
            assertThat(note.apply("week", new long[] {2060, 1550, 210, 300, 2500})).contains("\nToday's share of the"
                    + " member's credits is used, so this is coming from this week's.");
            assertThat(note.apply("starting", new long[] {510, 0, 210, 300, 2500})).contains("\nThis month's credits are"
                    + " used; this is coming from the starting credits: 210 left.");
            assertThat(note.apply("topUp", new long[] {300, 0, 0, 300, 2500})).contains("\nThis month's and the starting"
                    + " credits are used; this is coming from top-up credits: 300 left.");
            // A plan with no monthly part: no month and no renewal.
            assertThat(note.apply("starting", new long[] {210, 0, 210, 0, 0})).contains("\nCredits: 210 left (210"
                    + " starting), shared with the member's agents.").doesNotContain("renew");
            String lighter = note.apply("lighter", new long[] {0, 0, 0, 0, 2500});
            assertThat(lighter).contains("\nThe member's credits are used up, so you're on a lighter model (today's"
                    + " lighter share: 12 left) until this month's renew (1 December) or the member tops up: say so plainly"
                    + " once, keep helping, and never stop because of it.");
            assertThat(note.apply("lighter", new long[] {0, 0, 0, 0, 0})).contains("on a lighter model (today's lighter"
                    + " share: 12 left) until the member tops up:");
            String none = note.apply("none", new long[] {0, 0, 0, 0, 0});
            assertThat(none).contains("\nThe member's credits are used up, and their plan has no lighter model: say so"
                    + " plainly, once; a top-up keeps you and their agents going.").doesNotContain("lighter model (");
            for (String from : new String[] {"day", "week", "month", "starting", "topUp", "lighter", "none"}) {
                assertThat(note.apply(from, new long[] {100, 50, 30, 20, 2500})).as(from).doesNotContain("$")
                        .doesNotContain("don't brief").doesNotContainPattern("\\bin \\d|\\d+ ?(h|hours?|min|minutes?)\\b");
            }
        }
    }

    /**
     * The member's own day cap on her is in credits, against what her calls drew on this desk today (her service's
     * {@code costCredits}): her note says where she stands, her briefs stop at it, and her next turn is refused
     * {@code limit} {@code limit_cap} until the desk's next midnight. None by default.
     */
    @Test
    void theMembersOwnCapIsInCreditsAndRefusesHerTurnsOnceReached() throws Exception {
        try (Standalone s = new Standalone(data)) {
            s.on();
            assertThat(s.mode.capCredits()).isNull();
            s.mode.creditsSpent(1_250L);
            assertThat(s.mode.creditsTodayCenti()).isEqualTo(1_250L);
            assertThat(s.mode.capRefusal()).isNull();
            assertThat(s.profile.setup().note()).doesNotContain("cap").doesNotContain("$");
            s.call("agent.maia.set", "caps", java.util.Map.of("coordinatorDailyCredits", 20));
            assertThat(s.mode.capCredits()).isEqualTo(20L);
            assertThat(s.profile.setup().note()).contains("\nCredits today on this desk: 12.5 of the member's own day"
                    + " cap of 20.").doesNotContain("$");
            assertThat(s.mode.capRefusal()).isNull();
            s.mode.creditsSpent(750L);
            com.minimalistalliance.desk.agent.provider.ProviderException.Details refused = s.mode.capRefusal();
            assertThat(refused).isNotNull();
            assertThat(refused.reason()).isEqualTo("limit_cap");
            assertThat(refused.window()).isEqualTo("day");
            // The desk's next midnight (UTC here): a date for the room's line, never a countdown.
            assertThat(refused.resetsAt()).isEqualTo("2026-11-05T00:00:00Z");
            // A new day in the desk's zone starts from nothing.
            s.clock.advance(Duration.ofHours(15));
            assertThat(s.mode.creditsTodayCenti()).isZero();
            assertThat(s.mode.capRefusal()).isNull();
            // Cleared with null.
            s.call("agent.maia.set", "caps", java.util.Collections.singletonMap("coordinatorDailyCredits", null));
            assertThat(s.mode.capCredits()).isNull();
            assertThat(TeamDesk.map(TeamDesk.map(s.call("agent.maia.get").get("maia")).get("caps")))
                    .containsEntry("coordinatorDailyCredits", null);
        }
    }

    /**
     * No top of the desk's own on her spend: her service's allowance, in credits, is the limit, and its day and week amounts
     * only pace her (the owner, Nov 15). A dollar cap is retired: one stored before is ignored and dropped at the next change
     * of caps, sending one is refused, and the Platform's tier value in dollars is ignored. The other caps keep their
     * defaults and tops.
     */
    @Test
    void herSpendHasNoCapOfTheDesksOwnAndADollarCapIsRetired() throws Exception {
        try (Standalone s = new Standalone(data)) {
            s.on();
            java.util.Map<String, Object> caps = TeamDesk.map(TeamDesk.map(s.call("agent.maia.get").get("maia"))
                    .get("caps"));
            assertThat(caps).containsEntry("coordinatorDailyCredits", null).containsEntry("startedRunsDailyUsd", 2.0)
                    .containsEntry("briefsPerDay", 60).containsEntry("notesPerDay", 50)
                    .containsEntry("todosPerDeskPerDay", 20).doesNotContainKey("coordinatorDailyUsd");
            org.assertj.core.api.Assertions.assertThatThrownBy(
                    () -> s.call("agent.maia.set", "caps", java.util.Map.of("coordinatorDailyUsd", 2)))
                    .isInstanceOfSatisfying(com.minimalistalliance.desk.agent.service.RpcError.class,
                            e -> assertThat(e.details()).containsEntry("detail", "caps.coordinatorDailyUsd"));
            org.assertj.core.api.Assertions.assertThatThrownBy(
                    () -> s.call("agent.maia.set", "caps", java.util.Map.of("coordinatorDailyCredits", 2.5)))
                    .isInstanceOf(com.minimalistalliance.desk.agent.service.RpcError.class);
            org.assertj.core.api.Assertions.assertThatThrownBy(
                    () -> s.call("agent.maia.set", "caps", java.util.Map.of("coordinatorDailyCredits", 2_000_000)))
                    .isInstanceOf(com.minimalistalliance.desk.agent.service.RpcError.class);
            // A dollar cap stored before this (a test's or an RPC's: no screen ever set one) binds nothing, and goes at
            // the next change of caps.
            s.store.setSetting("maia.mode", s.store.setting("maia.mode").replace("\"updatedAt\"",
                    "\"caps\":{\"coordinatorDailyUsd\":2},\"updatedAt\""));
            assertThat(s.mode.capCredits()).isNull();
            s.mode.creditsSpent(1_000_000L);
            assertThat(s.mode.capRefusal()).isNull();
            s.call("agent.maia.set", "caps", java.util.Map.of("briefsPerDay", 40));
            assertThat(s.store.setting("maia.mode")).doesNotContain("coordinatorDailyUsd");
            // The Platform's dollar value is ignored; its other tier values are tops as before.
            s.tier.set("{\"maiaMode\":{\"coordinatorDailyUsd\":5,\"briefsPerDay\":120}}");
            assertThat(s.mode.capCredits()).isNull();
            assertThat(s.mode.briefsPerDay()).isEqualTo(40);
            org.assertj.core.api.Assertions.assertThatThrownBy(
                    () -> s.call("agent.maia.set", "caps", java.util.Map.of("briefsPerDay", 150)))
                    .isInstanceOfSatisfying(com.minimalistalliance.desk.agent.service.RpcError.class,
                            e -> assertThat(e.details()).containsEntry("reason", "above_tier"));
        }
    }

    @Test
    void herOwnToolsAreExactlySevenAndHerReaderNeedsAGrant() throws Exception {
        try (Standalone s = new Standalone(data)) {
            s.on();
            ManagerAgent.RunSetup setup = s.profile.setup();
            // Decision 12: her check-in always; her reader (maia_read) only with a live grant to another desk.
            assertThat(setup.tools().specs()).extracting(ToolSpec::name)
                    .containsExactly("office_desks", "office_desk_status", "office_show", "ask_member", "maia_check_in",
                            "working_on");
            // paper_note (the decision tray) joins only while a report's paper waits.
            assertThat(MaiaTools.NAMES).hasSize(8);
        }
    }

    @Test
    void whatSheIsOfferedInARunIsExactlyHerSet() throws Exception {
        try (EvalDesk m = new EvalDesk(data)) {
            m.on();
            m.desk.provider.then(Step.answer(USAGE, "Hello."))
                    .then(Step.answer(USAGE, "{\"notes\": []}"));
            m.desk.ask(MaiaAgent.ID, "Hi");
            ChatRequest request = m.herRequests().get(0);
            // Without a grant to another desk she has no brief tool at all; with one, desk_message joins these.
            assertThat(Set.copyOf(TeamDesk.toolNames(request))).isEqualTo(Set.of("office_desks", "office_desk_status",
                    "office_show", "ask_member", "maia_check_in", "working_on", "plan_update", "memory_save",
                    "memory_forget",
                    "todo_list", "todo_get", "todo_add", "todo_update", "todo_close"));
            assertThat(request.note()).contains("Now: ");
            assertThat(request.system()).doesNotContain("Now: ");
        }
    }

    @Test
    void oneQuestionAtATimeIsTheCodesToo() throws Exception {
        // Her last ask_member in a reply wins: one set of choices per reply, whatever the model calls.
        try (EvalDesk m = new EvalDesk(data)) {
            m.on();
            m.desk.provider.then(Step.calls(USAGE, List.of(
                            Step.call("c1", "ask_member", "question", "First?", "choices", List.of("A", "B")),
                            Step.call("c2", "ask_member", "question", "Second?", "choices", List.of("C", "D")))))
                    .then(Step.answer(USAGE, "Second?"))
                    .then(Step.answer(USAGE, "{\"notes\": []}"));
            var reply = m.desk.ask(MaiaAgent.ID, "Help");
            var choices = TeamDesk.map(reply.get("choices"));
            assertThat(choices).containsEntry("question", "Second?");
            assertThat(TeamDesk.list(choices.get("options"))).extracting(o -> o.get("label")).containsExactly("C",
                    "D");
            // Offered counts once per reply.
            assertThat(TeamDesk.map(m.call("agent.maia.choices.get").get("choices"))).containsEntry("offered", 1L);
        }
    }
}
