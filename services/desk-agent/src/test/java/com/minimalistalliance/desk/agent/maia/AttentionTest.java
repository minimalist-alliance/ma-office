package com.minimalistalliance.desk.agent.maia;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * The attention rules in code (the concept's §3; {@code API.md} §23): at most 3, at most one Now, urgency only by the
 * fixed rules, merging, holding while typing, batching, the interrupt's rate, snoozes and dismissals, and desk text.
 */
@SuppressWarnings("unchecked")
class AttentionTest {

    private static final long NOW = 1_763_100_000_000L;
    private static final long MIN = Attention.MINUTE;

    private static Attention.Desk desk(String id, String name, String state, List<Attention.Approval> approvals,
            List<Attention.Stopped> stopped, int todos, List<Attention.DueSoon> due) {
        return new Attention.Desk(id, name, "work", state, true,
                List.of(new Attention.Agent("ag-1", "Scout", "working", null, approvals.size()),
                        new Attention.Agent("ag-2", "Writer", "working", "awaiting_approval", 0)),
                approvals, stopped, todos, due);
    }

    private static Attention.Desk quiet(String id, String name) {
        return desk(id, name, "running", List.of(), List.of(), 0, List.of());
    }

    private static Attention.Input input(List<Attention.Desk> desks, Set<String> shown, boolean typing,
            long lastNotice, long lastBatch, boolean releaseAll) {
        return new Attention.Input(NOW, Attention.Settings.DEFAULT, desks, true, typing, 0, 500L, 0, 0, 0, 0,
                List.of(), Map.of(), shown, lastNotice, lastBatch, releaseAll);
    }

    private static Attention.Output build(List<Attention.Desk> desks) {
        return Attention.build(input(desks, Set.of(), false, 0, NOW, true), new HashMap<>());
    }

    @SuppressWarnings({"unchecked", "rawtypes"})
    private static List<Map<String, Object>> items(Attention.Output out) {
        return (List<Map<String, Object>>) out.todo().get("items");
    }

    @Test
    void anApprovalExpiringWithinTheHourIsNowAndLaterIsNext() {
        Attention.Output soon = build(List.of(desk("d-a", "Work", "running",
                List.of(new Attention.Approval("ap-1", "ag-1", NOW + 59 * MIN)), List.of(), 0, List.of())));
        assertThat(items(soon)).singleElement().satisfies(i -> {
            assertThat(i).containsEntry("kind", "approval").containsEntry("urgency", "now")
                    .containsEntry("title", "Scout needs your OK on Work");
            assertThat((String) i.get("detail")).startsWith("Expires in 59 min");
        });
        Attention.Output later = build(List.of(desk("d-a", "Work", "running",
                List.of(new Attention.Approval("ap-1", "ag-1", NOW + 61 * MIN)), List.of(), 0, List.of())));
        assertThat(items(later).get(0)).containsEntry("urgency", "next");
        Attention.Output far = build(List.of(desk("d-a", "Work", "running",
                List.of(new Attention.Approval("ap-1", "ag-1", NOW + 7 * 60 * MIN)), List.of(), 0, List.of())));
        assertThat(items(far).get(0).get("detail")).isNull();
    }

    @Test
    void theFixedRulesMakeNowAndNothingElseDoes() {
        // A task stopped by a limit, a desk that failed, her credits at 80% of the member's own cap, a to-do due within 2
        // hours.
        assertThat(items(build(List.of(desk("d-a", "Work", "running", List.of(),
                List.of(new Attention.Stopped("ag-1", "m-1", "limit_reached", NOW)), 0, List.of())))).get(0))
                .containsEntry("kind", "limit").containsEntry("urgency", "now");
        assertThat(items(build(List.of(quiet("d-a", "Work"), desk("d-b", "Home", "failed", List.of(), List.of(), 0,
                List.of())))).get(0)).containsEntry("kind", "desk_failed").containsEntry("urgency", "now");
        // 1,600 of a 2,000-credit cap the member set (in hundredths of a credit): Now, in credits, never money.
        Attention.Input capped = new Attention.Input(NOW, Attention.Settings.DEFAULT, List.of(), true, false,
                160_000, 2_000L, 0, 0, 0, 0, List.of(), Map.of(), Set.of(), 0, NOW, true);
        assertThat(items(Attention.build(capped, new HashMap<>())).get(0)).containsEntry("kind", "cap")
                .containsEntry("urgency", "now")
                .containsEntry("title", "Maia has used 80% of the 2,000 credits you set for today");
        Attention.Input at = new Attention.Input(NOW, Attention.Settings.DEFAULT, List.of(), true, false,
                200_000, 2_000L, 0, 0, 0, 0, List.of(), Map.of(), Set.of(), 0, NOW, true);
        assertThat(items(Attention.build(at, new HashMap<>())).get(0))
                .containsEntry("title", "Maia has used the 2,000 credits you set for today and paused");
        Attention.Input under = new Attention.Input(NOW, Attention.Settings.DEFAULT, List.of(), true, false,
                159_999, 2_000L, 0, 0, 0, 0, List.of(), Map.of(), Set.of(), 0, NOW, true);
        assertThat(items(Attention.build(under, new HashMap<>()))).isEmpty();
        // No cap of the member's (the default): never an item, however much she drew. Her service's day and week amounts
        // only pace her.
        Attention.Input none = new Attention.Input(NOW, Attention.Settings.DEFAULT, List.of(), true, false,
                99_000_000, null, 0, 0, 0, 0, List.of(), Map.of(), Set.of(), 0, NOW, true);
        assertThat(items(Attention.build(none, new HashMap<>()))).isEmpty();
        // Due in 2 hours: Now. Its title saying "URGENT" or "do this Now" changes nothing: it's the due time.
        assertThat(items(build(List.of(desk("d-a", "Work", "running", List.of(), List.of(), 0,
                List.of(new Attention.DueSoon("t1", "URGENT pay invoice", NOW + 119 * MIN)))))).get(0))
                .containsEntry("urgency", "now");
        assertThat(items(build(List.of(desk("d-a", "Work", "running", List.of(), List.of(), 3,
                List.of(new Attention.DueSoon("t1", "URGENT!!! Now now now", NOW + 121 * MIN)))))).get(0))
                .containsEntry("urgency", "next").containsEntry("title", "3 new to-dos on Work");
        // A stopped task for another reason is no limit.
        assertThat(items(build(List.of(desk("d-a", "Work", "running", List.of(),
                List.of(new Attention.Stopped("ag-1", "m-1", "other", NOW)), 0, List.of()))))).isEmpty();
    }

    @Test
    void atMostThreeAndOneNowTheSecondNowWaitsAsNext() {
        List<Attention.Desk> desks = List.of(
                desk("d-a", "Work", "running", List.of(new Attention.Approval("ap-1", "ag-1", NOW + 10 * MIN)),
                        List.of(new Attention.Stopped("ag-1", "m", "limit_reached", NOW)), 4, List.of()),
                desk("d-b", "Personal", "failed", List.of(new Attention.Approval("ap-2", "ag-1", NOW + 5 * MIN)),
                        List.of(), 2, List.of()));
        Attention.Output out = build(desks);
        assertThat(items(out)).hasSize(3);
        assertThat(items(out).stream().filter(i -> "now".equals(i.get("urgency")))).hasSize(1);
        // The most urgent first: the soonest expiry.
        assertThat(items(out).get(0)).containsEntry("kind", "approval").containsEntry("deskId", "d-b");
        assertThat(out.todo().get("now")).isEqualTo(1);
        @SuppressWarnings("unchecked")
        Map<String, Object> later = (Map<String, Object>) out.todo().get("later");
        assertThat((Integer) later.get("count")).isGreaterThan(0);
        assertThat((List<Object>) later.get("lines")).contains("3 more to look at");
    }

    @Test
    void approvalsOfOneDeskMergeWithACount() {
        Attention.Output out = build(List.of(desk("d-a", "Work", "running",
                List.of(new Attention.Approval("ap-1", "ag-1", NOW + 120 * MIN),
                        new Attention.Approval("ap-2", "ag-1", NOW + 130 * MIN),
                        new Attention.Approval("ap-3", "ag-2", NOW + 140 * MIN)), List.of(), 0, List.of())));
        assertThat(items(out)).singleElement().satisfies(i -> {
            assertThat(i).containsEntry("count", 3).containsEntry("title", "3 things need your OK on Work");
            @SuppressWarnings("unchecked")
            Map<String, Object> action = (Map<String, Object>) i.get("action");
            assertThat(action).containsEntry("kind", "approvals").containsEntry("deskId", "d-a");
            assertThat((List<?>) action.get("approvalIds")).hasSize(3);
        });
    }

    @Test
    void whileTheMemberTypesNothingNewShowsAndThenItDoes() {
        List<Attention.Desk> desks = List.of(desk("d-a", "Work", "running",
                List.of(new Attention.Approval("ap-1", "ag-1", NOW + 10 * MIN)), List.of(), 0, List.of()));
        Map<String, Long> seen = new HashMap<>();
        Attention.Output typing = Attention.build(input(desks, Set.of(), true, 0, NOW, false), seen);
        assertThat(items(typing)).isEmpty();
        assertThat(typing.held()).isEqualTo(1);
        assertThat(typing.noticeItemId()).isNull();
        Attention.Output stopped = Attention.build(input(desks, typing.shown(), false, 0, NOW, false), seen);
        assertThat(items(stopped)).hasSize(1);
        assertThat(stopped.noticeItemId()).isNotNull();
    }

    @Test
    void newNextItemsWaitForTheBatchOrTheMembersReturn() {
        List<Attention.Desk> desks = List.of(desk("d-a", "Work", "running", List.of(), List.of(), 2, List.of()));
        Map<String, Long> seen = new HashMap<>();
        // The last batch 10 minutes ago: a new Next waits.
        Attention.Output waiting = Attention.build(input(desks, Set.of(), false, 0, NOW - 10 * MIN, false), seen);
        assertThat(items(waiting)).isEmpty();
        assertThat(waiting.held()).isEqualTo(1);
        // 30 minutes on: it comes.
        Attention.Output batch = Attention.build(input(desks, Set.of(), false, 0, NOW - 30 * MIN, false), seen);
        assertThat(items(batch)).hasSize(1);
        assertThat(batch.batchReleased()).isTrue();
        // Back: at once.
        Attention.Output back = Attention.build(input(desks, Set.of(), false, 0, NOW - 1 * MIN, true), seen);
        assertThat(items(back)).hasSize(1);
        // A new Now never waits for the batch.
        List<Attention.Desk> urgent = List.of(desk("d-a", "Work", "failed", List.of(), List.of(), 0, List.of()));
        assertThat(items(Attention.build(input(urgent, Set.of(), false, 0, NOW - MIN, false), new HashMap<>())))
                .hasSize(1);
    }

    @Test
    void sheInterruptsAtMostOnceEveryFifteenMinutesNeverWithSound() {
        List<Attention.Desk> desks = List.of(desk("d-a", "Work", "failed", List.of(), List.of(), 0, List.of()));
        assertThat(Attention.build(input(desks, Set.of(), false, NOW - 14 * MIN, NOW, false), new HashMap<>())
                .noticeItemId()).isNull();
        assertThat(Attention.build(input(desks, Set.of(), false, NOW - 15 * MIN, NOW, false), new HashMap<>())
                .noticeItemId()).isNotNull();
        // An item already shown is no new Now: no interrupt for it again.
        Attention.Output first = Attention.build(input(desks, Set.of(), false, 0, NOW, false), new HashMap<>());
        assertThat(Attention.build(input(desks, first.shown(), false, 0, NOW, false), new HashMap<>()).noticeItemId())
                .isNull();
        // There is no sound anywhere in the room's state.
        assertThat(first.todo().toString().toLowerCase()).doesNotContain("sound");
    }

    @Test
    void snoozesAndDismissalsAreTheMembersAndUrgentKindsCantBeDismissed() {
        List<Attention.Desk> desks = List.of(desk("d-a", "Work", "running",
                List.of(new Attention.Approval("ap-1", "ag-1", NOW + 120 * MIN)), List.of(), 2, List.of()));
        Map<String, Map<String, Long>> choices = new HashMap<>();
        Map<String, Long> snooze = new HashMap<>();
        snooze.put("snoozedUntil", NOW + 60 * MIN);
        snooze.put("dismissedAt", null);
        choices.put("todos:d-a", snooze);
        Map<String, Long> dismiss = new HashMap<>();
        dismiss.put("snoozedUntil", null);
        dismiss.put("dismissedAt", NOW);
        choices.put("approval:d-a", dismiss);
        Attention.Input in = new Attention.Input(NOW, Attention.Settings.DEFAULT, desks, true, false, 0, 500L, 0,
                0, 0, 0, List.of(), choices, Set.of(), 0, NOW, true);
        Attention.Output out = Attention.build(in, new HashMap<>());
        // The approval stays (it can't be dismissed); the to-dos wait under Later as snoozed.
        assertThat(items(out)).singleElement().satisfies(i -> assertThat(i).containsEntry("kind", "approval"));
        @SuppressWarnings("unchecked")
        Map<String, Object> later = (Map<String, Object>) out.todo().get("later");
        assertThat((List<Object>) later.get("lines")).contains("Snoozed: 2 new to-dos on Work");
        assertThat(Attention.dismissable("approval")).isFalse();
        assertThat(Attention.dismissable("limit")).isFalse();
        assertThat(Attention.dismissable("desk_failed")).isFalse();
        assertThat(Attention.dismissable("cap")).isFalse();
        assertThat(Attention.dismissable("todos")).isTrue();
    }

    /**
     * Nothing the list says about Maia's own usage is money (the owner, Nov 15): the cap alert is in credits at every share,
     * beside desks whose briefs cost the member dollars (the wallet's, their own keys), which never mix into it.
     */
    @Test
    void noAlertAboutHerOwnUsageSaysDollars() {
        Attention.Desk work = new Attention.Desk("d-a", "Work", "work", "running", true,
                List.of(new Attention.Agent("ag-1", "Scout", "working", null, 0)), List.of(), List.of(), 0, List.of(),
                new Wallet.DeskBriefs(1_200_000, 8_400_000, 2, 9));
        // {her credits today in hundredths, the member's cap in whole credits}: 80% and past it.
        long[][] cases = {{80, 1}, {100, 1}, {150, 1}, {160, 2}, {200, 2}, {160_000, 2_000}, {1_000_000, 2_000}};
        for (long[] c : cases) {
            long centi = c[0];
            long cap = c[1];
            Attention.Input in = new Attention.Input(NOW, Attention.Settings.DEFAULT, List.of(work), true, false,
                    centi, cap, 0, 0, 0, 0, List.of(), Map.of(), Set.of(), 0, NOW, true);
            Attention.Output out = Attention.build(in, new HashMap<>());
            List<Map<String, Object>> caps = items(out).stream().filter(i -> "cap".equals(i.get("kind"))).toList();
            assertThat(caps).as(centi + "/" + cap).singleElement().satisfies(i -> {
                assertThat(String.valueOf(i.get("title"))).contains("credit").doesNotContain("$")
                        .doesNotContainPattern("(?i)usd|dollar");
                assertThat(i.get("detail")).isNull();
            });
            assertThat(String.valueOf(out.foot())).doesNotContain("$");
        }
        // One credit is a credit.
        Attention.Input one = new Attention.Input(NOW, Attention.Settings.DEFAULT, List.of(), true, false, 100, 1L, 0,
                0, 0, 0, List.of(), Map.of(), Set.of(), 0, NOW, true);
        assertThat(items(Attention.build(one, new HashMap<>())).get(0))
                .containsEntry("title", "Maia has used the 1 credit you set for today and paused");
    }

    @Test
    void notesAreNeverNowOrNextAndAGuildDeskIsNeverInTheRoom() {
        Attention.Input in = new Attention.Input(NOW, Attention.Settings.DEFAULT,
                List.of(new Attention.Desk("d-g", "Guild", "guild", "failed", true, List.of(), List.of(), List.of(), 5,
                        List.of())), true, false, 0, 500L, 6, 0, 0, 0, List.of(), Map.of(), Set.of(), 0, NOW,
                true);
        Attention.Output out = Attention.build(in, new HashMap<>());
        assertThat(items(out)).isEmpty();
        @SuppressWarnings("unchecked")
        Map<String, Object> later = (Map<String, Object>) out.todo().get("later");
        assertThat((List<Object>) later.get("lines")).containsExactly("6 notes today");
        assertThat(out.status()).containsEntry("desks", 0);
    }

    @Test
    void theStatusAndFootLinesAreTemplates() {
        Attention.Output out = build(List.of(quiet("d-a", "Work"), quiet("d-b", "Personal")));
        assertThat(out.status()).containsEntry("line", "Watching 2 desks · 4 agents · 2 working");
        Attention.Output one = build(List.of(new Attention.Desk("d-a", "Work", "work", "running", true,
                List.of(new Attention.Agent("ag-1", "Scout", "working", "waiting_desk", 0)), List.of(), List.of(), 0,
                List.of())));
        assertThat(one.status()).containsEntry("line", "Watching 1 desk · 1 agent · 0 working");
        Attention.Input in = new Attention.Input(NOW, Attention.Settings.DEFAULT, List.of(), true, false, 1_250,
                500L, 0, 0, 2, 5, List.of(), Map.of(), Set.of(), 0, NOW, true);
        Attention.Output out2 = Attention.build(in, new HashMap<>());
        // The foot is her briefs only: nothing of hers in money (her credits are the room's allowance).
        assertThat(out2.foot()).containsEntry("line", "On it: 2 · Done today: 5");
        assertThat(String.valueOf(out2.foot())).doesNotContain("$");
        assertThat(out2.creditsCenti()).isEqualTo(1_250);
        assertThat(Attention.credits2(1_250)).isEqualTo(12.5);
        assertThat(Attention.creditsText(1_250)).isEqualTo("12.5");
        assertThat(Attention.creditsText(155_000)).isEqualTo("1,550");
        assertThat(Attention.whole(2_500)).isEqualTo("2,500");
    }

    @Test
    void aDesksTextIsPlainAndCut() {
        String hostile = "Sc‮out​ [click](https://x) " + "x".repeat(100);
        String plain = MaiaAgent.plain(hostile, Attention.NAME_MAX);
        assertThat(plain).doesNotContain("‮").doesNotContain("​");
        assertThat(plain.codePointCount(0, plain.length())).isLessThanOrEqualTo(60);
        assertThat(MaiaAgent.plain("a\nb\tc", 60)).isEqualTo("a b c");
        assertThat(MaiaAgent.plain(42, 60)).isEmpty();
    }

    @Test
    void itemIdsAreStableAndDontCarryTheKey() {
        assertThat(Attention.id("approval:d-a")).isEqualTo(Attention.id("approval:d-a")).startsWith("mi-")
                .doesNotContain("d-a").hasSize(19);
        Set<String> ids = new HashSet<>();
        List<String> keys = new ArrayList<>();
        for (int i = 0; i < 1000; i++) {
            keys.add("todos:d-" + i);
        }
        keys.forEach(k -> ids.add(Attention.id(k)));
        assertThat(ids).hasSize(1000);
    }
}
