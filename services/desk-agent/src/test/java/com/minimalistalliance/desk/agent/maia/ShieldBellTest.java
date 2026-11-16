package com.minimalistalliance.desk.agent.maia;

import static com.minimalistalliance.desk.agent.maia.ShieldFixture.MIN;
import static com.minimalistalliance.desk.agent.maia.ShieldFixture.MONDAY;
import static com.minimalistalliance.desk.agent.maia.ShieldFixture.WORK;
import static com.minimalistalliance.desk.agent.maia.ShieldFixture.at;
import static com.minimalistalliance.desk.agent.maia.ShieldFixture.card;
import static com.minimalistalliance.desk.agent.maia.ShieldFixture.contact;
import static com.minimalistalliance.desk.agent.maia.ShieldFixture.focus;
import static com.minimalistalliance.desk.agent.maia.ShieldFixture.line;
import static com.minimalistalliance.desk.agent.maia.ShieldFixture.person;
import static com.minimalistalliance.desk.agent.maia.ShieldFixture.with;
import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.agent.maia.ShieldFixture.B;
import com.minimalistalliance.desk.agent.maia.ShieldTest.Run;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;

/**
 * The shield's finish (API.md §23): the away bell wired to Phase 2's ({@code maiaAway.ring}: her questions and finishing
 * through the shield's quiet hours and day's bells, its own interrupt-level items, never an approval, which each desk's
 * deskd rings), the tiles' accent, and calls and screen shares as "do not disturb".
 */
@SuppressWarnings("unchecked")
class ShieldBellTest {

    static Reach.Settings list(Map<String, Object>... rules) throws Exception {
        AtomicInteger n = new AtomicInteger();
        return Reach.set(Map.of("letThrough", List.of(rules)), Reach.Settings.defaults(0), 0,
                () -> "mr-" + n.incrementAndGet());
    }

    static Map<String, Object> personRule(String name, boolean anyTime) {
        return Map.of("kind", "person", "person", Map.of("deskId", WORK, "contactId", contact(name)), "anyTime", anyTime);
    }

    static Reach.Item message(String name, String channel) {
        return B.of("message:" + WORK + ":" + contact(channel), "message").channel(contact(channel))
                .from(person(WORK, name), "known_confirmed", true).direct(null).need("you")
                .title("{who} wrote on Work").build();
    }

    static void leave(Run r) {
        r.lastFocus = null;
    }

    static long bells(Run r) {
        return r.log.stream().filter(d -> d.what().equals("bell")).count();
    }

    @Test
    void awayItRingsOncePerItemOnlyAnyTimeInQuietHoursAndNeverCountsAnApproval() throws Exception {
        Run r = new Run(list(personRule("Rosa", false), personRule("Ana", true)));
        long t = at(10, 0);
        r.see(t, focus(WORK, "notebook", "page", "pg-q3", false));
        leave(r);
        r.update(t + 3 * MIN);
        // Rosa (on the list, confirmed) writes while the member is away: one ring, once.
        r.items.add(message("Rosa", "rosa-1"));
        r.update(t + 4 * MIN);
        assertThat(r.shield.ringReach()).isEqualTo(1);
        r.update(t + 5 * MIN);
        r.update(t + 9 * MIN);
        assertThat(r.shield.ringReach()).isEqualTo(1);
        assertThat(r.shield.awayInterrupts()).isEqualTo(1);
        // An approval about to expire: Phase 2's deskd rings it on its own desk, so it's never counted here (no double ring).
        r.items.add(B.of("approval:" + WORK, "approval").app("agent").now().deadline(t + 40 * MIN, true).build());
        r.update(t + 10 * MIN);
        assertThat(r.shield.ringReach()).isEqualTo(1);
        assertThat(r.log).anyMatch(d -> d.what().equals("bell") && d.kind().equals("approval"));

        // Quiet hours (from 7 pm by default): Rosa isn't "any time", so she waits for the morning; Ana is.
        long night = at(21, 0);
        r.items.clear();
        r.items.add(message("Rosa", "rosa-2"));
        r.update(night);
        assertThat(r.shield.ringReach()).isEqualTo(1);
        r.items.add(message("Ana", "ana-1"));
        r.update(night + MIN);
        assertThat(r.shield.ringReach()).isEqualTo(2);
        assertThat(r.store.sum(Shield.date(night, ShieldFixture.ZONE), Shield.date(night, ShieldFixture.ZONE), "bell"))
                .isEqualTo(2);
    }

    @Test
    void herQuestionsAndHerFinishingRingThroughTheShieldsQuietHoursAndDaysCapAndOffItSaysNothing() throws Exception {
        Run r = new Run();
        long t = at(10, 0);
        Map<String, Object> ring = r.shield.ring(0, 0, t);
        assertThat(ring).containsEntry("question", 0).containsEntry("done", 0).containsEntry("reach", 0);
        // Phase 2's asks rises while away: once.
        assertThat(r.shield.ring(1, 0, t + MIN)).containsEntry("question", 1);
        assertThat(r.shield.ring(1, 0, t + 2 * MIN)).containsEntry("question", 1);
        assertThat(r.shield.ring(1, 1, t + 3 * MIN)).containsEntry("done", 1);
        // In quiet hours her question isn't "any time": it waits for the return catch-up, no bell.
        long night = at(22, 30);
        assertThat(r.shield.ring(2, 1, night)).containsEntry("question", 1);
        // Back (Phase 2's counts go to 0), then away again the next morning: it rings again.
        r.shield.ring(0, 0, night + MIN);
        long morning = at(MONDAY.plusDays(1), 10, 0);
        assertThat(r.shield.ring(1, 0, morning)).containsEntry("question", 2);
        // At most BELLS_PER_DAY a day from the shield (the Platform's own cap), whatever rises.
        Run busy = new Run();
        for (int k = 1; k <= Shield.BELLS_PER_DAY + 5; k++) {
            busy.shield.ring(k, 0, t + k * MIN);
        }
        assertThat(busy.shield.ring(Shield.BELLS_PER_DAY + 5, 0, t + 30 * MIN)).containsEntry("question",
                Shield.BELLS_PER_DAY);
        // "Show everything as it comes": the shield says nothing and deskd rings as Phase 2 did.
        Run off = new Run(Reach.set(Map.of("showAll", true), Reach.Settings.defaults(0), 0, () -> "mr-x"));
        assertThat(off.shield.ring(1, 0, t)).isNull();
    }

    @Test
    void theTilesKeepTheAccentOnlyWhereSomethingMayBreakThrough() throws Exception {
        Run r = new Run(list(personRule("Rosa", false)));
        long t = at(10, 0);
        r.see(t, focus(WORK, "notebook", "page", "pg-q3", true));
        r.items.add(message("Rosa", "rosa-1"));
        r.items.add(B.of("result:" + WORK, "result").app("maia").need("info").build());
        Shield.Output o = r.update(t + 10_000);
        List<Map<String, Object>> accent = (List<Map<String, Object>>) o.view().get("accent");
        assertThat(accent).singleElement().satisfies(a -> {
            assertThat(a).containsEntry("deskId", WORK).containsEntry("app", "courier");
            assertThat(a.get("agentId")).isNull();
        });
        // Off ("Show everything as it comes"): no accent at all, the tiles are as they were.
        r.shield.set(Map.of("showAll", true), t + MIN);
        o = r.update(t + MIN + 1);
        assertThat((List<?>) o.view().get("accent")).isEmpty();
    }

    @Test
    void aCallOrAScreenShareHoldsEveryCardAndCatchUpAndItsEndIsTheBreak() throws Exception {
        for (String signal : List.of("call", "share")) {
            Run r = new Run();
            long t = at(10, 0);
            Map<String, Object> busy = with(focus(WORK, "commons", null, null, false), signal, true);
            r.see(t, busy);
            Reach.Item approval = B.of("approval:" + WORK, "approval").app("agent").now().deadline(t + 50 * MIN, true)
                    .title("Scout needs your OK on Work").build();
            r.items.add(approval);
            for (int m = 1; m <= 20; m++) {
                r.see(t + m * MIN, busy);
                assertThat(card(r.last)).as(signal).isNull();
                assertThat(line(r.last).get("kind")).as(signal).isNotEqualTo("heads_up");
            }
            // Nothing was put in front of the member while it was on: no card, no heads-up, not even the morning brief.
            assertThat(r.log).as(signal).noneMatch(d -> List.of("heads_up", "interrupt", "offer", "brief", "catchup",
                    "catchup_item").contains(d.what()));
            // It ends: a coarse break, and the one thing comes (here in the day's first catch-up, the morning brief).
            r.see(t + 21 * MIN, with(busy, signal, false));
            r.update(t + 21 * MIN + 10_000);
            assertThat(r.log).as(signal).anyMatch(d -> approval.key().equals(d.itemKey()) && List.of("heads_up",
                    "interrupt", "catchup_item").contains(d.what()));
        }
    }

    @Test
    void anAgentsToDoDueSoonOrAGroupsSenderNeverOpensTheGate() {
        long now = at(10, 0);
        Attention.Desk desk = new Attention.Desk(WORK, "Work", "work", "running", true, List.of(), List.of(), List.of(),
                0, List.of(new Attention.DueSoon("td-agent", "Pay the invoice", now + 60 * MIN, false)));
        Attention.Input in = new Attention.Input(now, Attention.Settings.DEFAULT, List.of(desk), true, false, 0, null,
                0, 0, 0, 0, List.of(), Map.of(), java.util.Set.of(), 0, 0, true);
        List<Attention.Item> list = Attention.items(in, new java.util.HashMap<>());
        Attention.Item todos = list.stream().filter(i -> "todos".equals(i.kind())).findFirst().orElseThrow();
        assertThat(todos.urgency()).isEqualTo("now");
        // The list's own Now, but an agent made it: not a code-rule Now for the shield (no card, no bell) (SF2-M1).
        assertThat(ReachItems.fromList(todos, desk, Map.of(), now, ShieldFixture.ZONE).codeNow()).isFalse();
        Attention.Desk mine = new Attention.Desk(WORK, "Work", "work", "running", true, List.of(), List.of(), List.of(),
                0, List.of(new Attention.DueSoon("td-mine", "Pay the invoice", now + 60 * MIN, true)));
        Attention.Item own = Attention.items(new Attention.Input(now, Attention.Settings.DEFAULT, List.of(mine), true,
                false, 0, null, 0, 0, 0, 0, List.of(), Map.of(), java.util.Set.of(), 0, 0, true), new java.util.HashMap<>())
                .stream().filter(i -> "todos".equals(i.kind())).findFirst().orElseThrow();
        assertThat(ReachItems.fromList(own, mine, Map.of(), now, ShieldFixture.ZONE).codeNow()).isTrue();
        // A group thread: no person stands for it, so the list's person never matches another member's message (SF2-L1).
        ReachItems.Extras x = ReachItems.parse(WORK, Map.of("threads", List.of(Map.of("channelId", contact("grp"),
                "kind", "group", "contactIds", List.of(contact("Rosa"), contact("Eve")), "known", true, "confirmed", true,
                "unread", 1, "newestAt", now))), null);
        Reach.Item group = ReachItems.fromThread(x.threads().get(0), desk);
        assertThat(group.sender().person()).isNull();
        assertThat(group.refs().people()).hasSize(2);
    }
}
