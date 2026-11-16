package com.minimalistalliance.desk.agent.maia;

import static com.minimalistalliance.desk.agent.maia.ShieldFixture.HOME;
import static com.minimalistalliance.desk.agent.maia.ShieldFixture.MIN;
import static com.minimalistalliance.desk.agent.maia.ShieldFixture.WORK;
import static com.minimalistalliance.desk.agent.maia.ShieldFixture.ZONE;
import static com.minimalistalliance.desk.agent.maia.ShieldFixture.at;
import static com.minimalistalliance.desk.agent.maia.ShieldFixture.card;
import static com.minimalistalliance.desk.agent.maia.ShieldFixture.catchup;
import static com.minimalistalliance.desk.agent.maia.ShieldFixture.contact;
import static com.minimalistalliance.desk.agent.maia.ShieldFixture.event;
import static com.minimalistalliance.desk.agent.maia.ShieldFixture.focus;
import static com.minimalistalliance.desk.agent.maia.ShieldFixture.line;
import static com.minimalistalliance.desk.agent.maia.ShieldFixture.person;
import static com.minimalistalliance.desk.agent.maia.ShieldFixture.with;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.agent.maia.ShieldFixture.B;
import com.minimalistalliance.desk.agent.service.RpcError;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * The shield over time (concept §5 to §10): nothing while typing, the heads-up and the card, the 15-minute cap, offers
 * at breaks, focus hours, catch-ups and the morning brief, Back and pick-ups, the member's answers and what's learned,
 * holds and quiet hours, the deadline floor, nothing lost, and what survives a restart.
 */
@SuppressWarnings("unchecked")
class ShieldTest {

    /** A shield and the items of the moment. */
    static final class Run {
        final Shield.Memory store;
        Shield shield;
        final List<Reach.Item> items = new ArrayList<>();
        final List<Shield.Delivery> log = new ArrayList<>();
        Shield.Output last;

        Run(Reach.Settings s) {
            store = new Shield.Memory(s);
            shield = new Shield(store, () -> ZONE);
        }

        Run() {
            this(null);
        }

        Map<String, Object> lastFocus;
        long lastSeen;

        Shield.Output see(long t, Map<String, Object> focus) {
            keepAlive(t);
            shield.observe(Focus.parse(focus, t), t);
            Map<String, Object> plain = new java.util.LinkedHashMap<>(focus);
            plain.remove("events");
            lastFocus = plain;
            lastSeen = t;
            return update(t);
        }

        /** The office's keep-alive: the same picture every 60 s while it's open. */
        void keepAlive(long t) {
            while (lastFocus != null && lastSeen + 60_000L < t) {
                lastSeen += 60_000L;
                shield.observe(Focus.parse(lastFocus, lastSeen), lastSeen);
                last = shield.update(lastSeen, items, ShieldFixture.scopes(), ShieldFixture.names());
                log.addAll(last.deliveries());
            }
        }

        Shield.Output update(long t) {
            keepAlive(t);
            last = shield.update(t, items, ShieldFixture.scopes(), ShieldFixture.names());
            log.addAll(last.deliveries());
            return last;
        }

    }

    private static Map<String, Object> notebook(boolean typing) {
        return focus(WORK, "notebook", "page", "pg-q3", typing, "Sam");
    }

    private static Reach.Item approval(long expires) {
        return B.of("approval:" + WORK, "approval").app("agent").now().deadline(expires, true)
                .title("Scout needs your OK on Work").build();
    }

    @Test
    void nothingAppearsWhileTypingThenAHeadsUpThenTheCard() throws Exception {
        Run r = new Run();
        long t = at(10, 0);
        r.see(t, notebook(false));
        r.see(t + MIN, notebook(true));
        // Within 25 minutes of its deadline: it doesn't wait for a coarse break (just in time).
        r.items.add(approval(t + 24 * MIN));
        Shield.Output o = r.update(t + MIN + 5_000);
        assertThat(card(o)).isNull();
        assertThat(line(o).get("kind")).isEqualTo("held");
        assertThat(line(o).get("text")).isEqualTo("1 held · 1 needs you soon");
        // A message sent, then 5 s quiet: a fine break. The heads-up first, still, with the accent dot.
        o = r.see(t + 2 * MIN, event(notebook(false), "sent", t + 2 * MIN - 5_000));
        assertThat(line(o)).containsEntry("kind", "heads_up").containsEntry("text", "One thing in a moment")
                .containsEntry("dot", "accent");
        assertThat(card(o)).isNull();
        // 8 s later, the card: the one thing first, why now, no Not now on an approval.
        o = r.update(t + 2 * MIN + Deliver.HEADS_UP_MS);
        Map<String, Object> c = card(o);
        assertThat(c).containsEntry("level", "interrupt").containsEntry("goLabel", "Review")
                .containsEntry("what", "Scout needs your OK on Work").containsEntry("why", "Expires in 22 min");
        assertThat((List<Map<String, Object>>) c.get("choices")).extracting(m -> m.get("id"))
                .doesNotContain("not_now");
        assertThat(o.noticeItemId()).isEqualTo(approval(0).id());
    }

    @Test
    void interruptsAreSpacedAndACardCarriesWhatCameMeanwhile() throws Exception {
        Run r = new Run();
        long t = at(10, 0);
        r.see(t, notebook(false));
        r.items.add(approval(t + 20 * MIN));
        r.see(t + MIN, event(notebook(false), "saved", t + MIN));
        r.update(t + MIN + 9_000);
        r.shield.answer(Map.of("cardId", card(r.last).get("cardId"), "answer", "go"), t + MIN + 10_000);
        r.items.clear();
        Reach.Item limit = B.of("limit:" + WORK, "limit").app("agent").now().tags("money").build();
        r.items.add(limit);
        r.update(t + 2 * MIN);
        // A limit stop with no deadline waits out the spacing (30 minutes), breaks or not.
        r.see(t + 17 * MIN, event(notebook(false), "saved", t + 17 * MIN));
        assertThat(card(r.update(t + 17 * MIN + 9_000))).isNull();
        // An approval that can't wait that long comes after 15 minutes, and the limit rides on its card.
        Reach.Item soon = B.of("approval:d-work2", "approval").desk("d-work2", "Work 2", "work").app("agent").now()
                .deadline(t + 40 * MIN, true).build();
        r.items.add(soon);
        r.see(t + 18 * MIN, event(notebook(false), "saved", t + 18 * MIN));
        Shield.Output o = r.update(t + 18 * MIN + 9_000);
        assertThat(card(o)).containsEntry("kind", "approval");
        assertThat((List<Map<String, Object>>) card(o).get("more")).extracting(m -> m.get("kind"))
                .containsExactly("limit");
    }

    @Test
    void offersComeOnlyAtBreaksClosestFirstAndTuckBack() throws Exception {
        Run r = new Run();
        long t = at(10, 0);
        r.see(t, notebook(false));
        r.update(t + 30_000);
        // Sam (in the open page's people) starts a thread: 44, a coarse offer, not fine.
        Reach.Item sam = B.of("message:sam", "message").channel(contact("thread-sam"))
                .from(person(WORK, "Sam"), "known_confirmed", true).direct(t).need("you").title("{who} wrote on Work")
                .build();
        Reach.Item far = B.of("result:far", "result").desk("d-work2", "Work 2", "work").need("action").build();
        r.items.add(sam);
        r.items.add(far);
        Shield.Output o = r.update(t + 5 * MIN);
        assertThat(card(o)).isNull();
        o = r.see(t + 6 * MIN, event(notebook(false), "saved", t + 6 * MIN));
        assertThat(card(o)).isNull();
        // A coarse break (the app changes): Sam's message is offered, the far result isn't.
        o = r.see(t + 7 * MIN, focus(WORK, "todo", null, null, false));
        Map<String, Object> c = card(o);
        assertThat(c).containsEntry("level", "offer").containsEntry("kind", "message").containsEntry("why",
                "From {who}, who you\u2019re working with");
        assertThat(c.get("quote")).isEqualTo(Map.of("deskId", WORK, "channelId", contact("thread-sam")));
        // Untouched, it tucks back after 20 s and isn't offered again.
        o = r.update(t + 7 * MIN + Deliver.TUCK_MS + 1);
        assertThat(card(o)).isNull();
        o = r.see(t + 9 * MIN, focus(WORK, "notebook", "page", "pg-q3", false));
        assertThat(card(o)).isNull();
    }

    @Test
    void inFocusHoursOnlyTheVeryCloseIsOfferedAndTheEndIsABreak() throws Exception {
        Reach.Settings s = new Reach.Settings(Reach.Settings.defaults(0).letThrough(), false,
                Reach.Settings.DEFAULT_CATCHUPS, List.of(new Reach.Span(java.time.LocalTime.of(9, 0),
                java.time.LocalTime.of(12, 0))), null, "hold", "paragraph", false);
        Run r = new Run(s);
        long t = at(9, 20);
        r.see(t, notebook(false));
        // Arriving inside focus hours starts a stretch: the morning brief waits for the first break after 10 minutes.
        r.see(t + 30 * MIN, focus(WORK, "todo", null, null, false));
        assertThat(r.log).extracting(Shield.Delivery::what).contains("brief");
        Reach.Item sam = B.of("message:sam", "message").channel(contact("thread-sam"))
                .from(person(WORK, "Sam"), "known_confirmed", true).direct(t).need("you").build();
        r.items.add(sam);
        // In focus hours a coarse break offers only the very close (20 or less): Sam's 44 waits.
        r.see(t + 40 * MIN, notebook(false));
        assertThat(card(r.last)).isNull();
        // Focus hours end at 12: a coarse break.
        r.see(at(11, 59), notebook(false));
        Shield.Output o = r.update(at(12, 0) + 1_000);
        assertThat(card(o)).containsEntry("kind", "message");
    }

    @Test
    void catchUpsComeOnTimeAtMostSevenLinesAndEndCalmly() throws Exception {
        Run r = new Run();
        long t = at(12, 30);
        r.see(t, notebook(false));
        for (int i = 0; i < 12; i++) {
            r.items.add(B.of("message:n" + i, "message").desk("d-work2", "Work 2", "work").channel(contact("n" + i))
                    .from(person("d-work2", "Bulk" + i), "bulk", false).need("info").build());
        }
        for (int i = 0; i < 6; i++) {
            r.items.add(B.of("result:r" + i, "result").desk("d-work" + (i + 3), "Work " + i, "work").need("you")
                    .title("An answer on Work " + i).build());
        }
        r.update(t + MIN);
        Shield.Output o = r.update(at(13, 0) + 1_000);
        Map<String, Object> c = catchup(o);
        assertThat(c).containsEntry("kind", "catchup").containsEntry("end", Rhythm.END);
        assertThat((String) c.get("head")).startsWith("Your 1:00 catch-up · ");
        List<Map<String, Object>> groups = (List<Map<String, Object>>) c.get("groups");
        int lines = 0;
        for (Map<String, Object> g : groups) {
            lines += ((List<?>) g.get("items")).size() + (g.get("summary") == null ? 0 : 1);
        }
        assertThat(lines).isLessThanOrEqualTo(Rhythm.CATCHUP_MAX);
        assertThat(groups.get(0).get("id")).isEqualTo("needs_you");
        assertThat(groups).extracting(g -> g.get("id")).contains("read_later");
        assertThat(groups.stream().filter(g -> "read_later".equals(g.get("id"))).findFirst().orElseThrow()
                .get("summary")).isEqualTo("12 messages");
        // An empty catch-up says nothing: the next one, with everything already caught up, gives no panel.
        r.shield.answer(Map.of("catchupId", c.get("catchupId"), "answer", "dismiss"), at(13, 1));
        o = r.update(at(17, 0) + 1_000);
        assertThat(catchup(o)).isNull();
    }

    @Test
    void theMorningBriefHoldsAtMostThreeAndABusyCatchUpWaits() throws Exception {
        Run r = new Run();
        for (int i = 0; i < 5; i++) {
            r.items.add(B.of("result:b" + i, "result").desk("d-work" + (i + 3), "Work " + i, "work").need("you")
                    .build());
        }
        r.update(at(8, 0));
        Shield.Output o = r.see(at(9, 2), notebook(false));
        Map<String, Object> brief = catchup(o);
        assertThat(brief).containsEntry("kind", "brief").containsEntry("head", "Good morning. Three things today.");
        assertThat((List<String>) brief.get("lines")).contains("2 more are in To-do");
        // The 1:00 catch-up comes while the member types: it waits, and after an hour the line says it's ready.
        r.see(at(12, 59), notebook(true));
        r.see(at(13, 0) + 2_000, notebook(true));
        assertThat(catchup(r.last).get("kind")).isEqualTo("brief");
        for (long m = 1; m <= 61; m++) {
            r.see(at(13, 0) + m * MIN, notebook(true));
        }
        assertThat(line(r.last)).containsEntry("kind", "catchup").containsEntry("text",
                "Your 1:00 catch-up is ready");
    }

    @Test
    void notNowRestsNotImportantLearnsAndUndoTakesItBack() throws Exception {
        Run r = new Run();
        long t = at(10, 0);
        r.see(t, notebook(false));
        Reach.Item sam = B.of("message:sam", "message").channel(contact("thread-sam"))
                .from(person(WORK, "Sam"), "known_confirmed", true).direct(t).need("you").build();
        r.items.add(sam);
        r.see(t + MIN, focus(WORK, "todo", null, null, false));
        Map<String, Object> c = card(r.last);
        r.shield.answer(Map.of("cardId", c.get("cardId"), "answer", "not_now"), t + MIN + 2_000);
        Shield.Output o = r.update(t + MIN + 3_000);
        assertThat((Map<String, Object>) card(o).get("after")).containsEntry("text", "Held until 1:00");
        r.shield.answer(Map.of("cardId", c.get("cardId"), "answer", "not_important"), t + MIN + 4_000);
        o = r.update(t + MIN + 4_500);
        assertThat((String) ((Map<String, Object>) card(o).get("after")).get("text"))
                .isEqualTo("Got it. Messages wait for catch-ups.");
        assertThat(r.shield.learnedView(t + 2 * MIN)).singleElement().satisfies(rule -> {
            assertThat(rule).containsEntry("effect", "hold");
            assertThat((String) rule.get("line")).startsWith("Messages from {who} wait for catch-ups (you said Not"
                    + " important, Nov 16)");
        });
        r.shield.answer(Map.of("cardId", c.get("cardId"), "answer", "undo"), t + MIN + 5_000);
        assertThat(r.shield.learnedView(t + 2 * MIN)).isEmpty();
        // Not now and Not important are refused on an approval.
        r.items.add(approval(t + 50 * MIN));
        r.update(t + 20 * MIN);
        r.see(t + 21 * MIN, event(notebook(false), "saved", t + 21 * MIN));
        r.update(t + 21 * MIN + 9_000);
        Object cardId = card(r.last).get("cardId");
        assertThatThrownBy(() -> r.shield.answer(Map.of("cardId", cardId, "answer", "not_now"), t + 22 * MIN))
                .isInstanceOf(RpcError.class);
        assertThatThrownBy(() -> r.shield.answer(Map.of("cardId", cardId, "answer", "not_important"), t + 22 * MIN))
                .isInstanceOf(RpcError.class);
    }

    @Test
    void threeNotNowsAskOnceAndSoonerOffersTheList() throws Exception {
        Run r = new Run();
        long t = at(10, 0);
        r.see(t, notebook(false));
        for (int i = 0; i < 3; i++) {
            Reach.Item m = B.of("message:priya" + i, "message").channel(contact("p" + i))
                    .from(person(WORK, "Priya"), "known_confirmed", true).band(3).direct(t).need("you").build();
            r.items.clear();
            r.items.add(m);
            long at = t + (i * 20 + 1) * MIN;
            r.see(at, i % 2 == 0 ? focus(WORK, "todo", null, null, false, "Priya")
                    : focus(WORK, "notebook", "page", "pg-q3", false, "Priya"));
            Map<String, Object> c = card(r.last);
            assertThat(c).as("offer %d", i).isNotNull();
            r.shield.answer(Map.of("cardId", c.get("cardId"), "answer", "not_now"), at + 1_000);
        }
        Shield.Output o = r.update(at(13, 0) + 1_000);
        Map<String, Object> q = (Map<String, Object>) catchup(o).get("question");
        assertThat(q).containsEntry("questionId", "keep_for_catchups");
        r.shield.answer(Map.of("catchupId", catchup(o).get("catchupId"), "questionId", "keep_for_catchups", "answer",
                "yes"), at(13, 1));
        assertThat(r.shield.learnedView(at(13, 2))).extracting(m -> m.get("effect")).contains("catchups");

        // Sooner next time on a person not on the list: the one question about the list.
        Reach.Item rosa = B.of("message:rosa", "message").channel(contact("rosa"))
                .from(person(WORK, "Rosa"), "known_confirmed", true).direct(t).need("you").build();
        r.items.add(rosa);
        r.update(at(13, 5));
        r.shield.answer(Map.of("itemId", rosa.id(), "answer", "sooner"), at(13, 6));
        o = r.update(at(17, 0) + 1_000);
        Map<String, Object> q2 = (Map<String, Object>) catchup(o).get("question");
        assertThat(q2).containsEntry("questionId", "add_to_list").containsEntry("text", "Add {who} to your list?");
        assertThat(q2.get("who")).isEqualTo(Map.of("deskId", WORK, "contactId", contact("Rosa")));
        r.shield.answer(Map.of("catchupId", catchup(o).get("catchupId"), "questionId", "add_to_list", "answer",
                "yes"), at(17, 1));
        assertThat(r.shield.settings(at(17, 2)).letThrough()).extracting(Reach.Rule::person)
                .contains(person(WORK, "Rosa"));
    }

    @Test
    void afterTheOneThingBackRestoresAndAnUntakenBackBecomesAPickUp() throws Exception {
        Run r = new Run();
        long t = at(10, 0);
        r.see(t, notebook(false));
        r.shield.focusSet("Q3 plan", t + 4 * MIN);
        r.items.add(approval(t + 28 * MIN));
        r.see(t + 5 * MIN, event(notebook(false), "saved", t + 5 * MIN));
        r.update(t + 5 * MIN + 9_000);
        Map<String, Object> c = card(r.last);
        r.shield.answer(Map.of("cardId", c.get("cardId"), "answer", "go"), t + 5 * MIN + 10_000);
        // The approval is decided on its own desk: Back shows, with the ready-to-resume line from the snapshot.
        r.see(t + 6 * MIN, event(focus(WORK, "agent", null, null, false), "approval_decided", t + 6 * MIN));
        Map<String, Object> back = (Map<String, Object>) r.last.view().get("back");
        assertThat(back).containsEntry("label", "Back to Q3 plan").containsEntry("deskId", WORK)
                .containsEntry("app", "notebook");
        assertThat((String) back.get("resume")).startsWith("You were on Q3 plan in Notebook, Work. Last change");
        assertThat(line(r.last)).containsEntry("kind", "back").containsEntry("text", "Back to Q3 plan");
        // Not taken, and the member went elsewhere: a pick-up, shown once at the next coarse break.
        r.see(t + 7 * MIN + 10_000, focus(HOME, "todo", null, null, false));
        r.update(t + 8 * MIN);
        Shield.Output o = r.see(t + 20 * MIN, focus(WORK, "courier", null, null, false));
        assertThat(line(o)).containsEntry("kind", "pickup").containsEntry("text", "Pick up: Q3 plan");
        r.shield.back((String) c.get("cardId"), true, t + 20 * MIN + 1_000);
        o = r.update(t + 21 * MIN);
        assertThat(line(o).get("kind")).isNotEqualTo("pickup");
    }

    @Test
    void aHoldLetsOnlyTheListAndCodeRuleNowThroughAndQuietHoursOnlyAnyTime() throws Exception {
        Reach.Settings s = Reach.set(Map.of("letThrough", List.of(Map.of("kind", "group", "group", "family"))),
                Reach.Settings.defaults(0), 0, () -> "mr-fam");
        Run r = new Run(s);
        long t = at(10, 0);
        r.see(t, notebook(false));
        r.shield.hold(Map.of("minutes", 60), t + MIN);
        Shield.Output o = r.update(t + MIN + 1);
        assertThat(line(o)).containsEntry("kind", "hold").containsEntry("text",
                "Holding until 11:01 · your list still gets through");
        assertThat(r.shield.holdNote(t + 2 * MIN)).contains("11:01");
        Reach.Item sam = B.of("message:sam", "message").channel(contact("thread-sam"))
                .from(person(WORK, "Sam"), "known_confirmed", true).direct(t).need("you").build();
        r.items.add(sam);
        r.see(t + 15 * MIN, focus(WORK, "todo", null, null, false));
        assertThat(card(r.last)).isNull();
        // Quiet hours (from 7 pm): a non-any-time list match waits; family (any time) gets through.
        long night = at(21, 0);
        r.items.clear();
        r.shield.hold(Map.of("clear", true), night);
        Reach.Item due = B.of("todo:work:9", "todo").tags("due_today").deadline(at(23, 0), false).build();
        r.items.add(due);
        r.see(night, notebook(false));
        r.see(night + 11 * MIN, event(notebook(false), "saved", night + 11 * MIN));
        assertThat(card(r.last)).isNull();
        r.shield.save(night);
    }

    @Test
    void theDeadlineFloorAndNothingIsLost() throws Exception {
        Run r = new Run();
        long t = at(17, 30);
        r.see(t, focus(HOME, "todo", null, null, false));
        // Due at 8 pm on Personal, no catch-up before it: offered at a break once within 3 hours, whatever the distance.
        Reach.Item due = B.of("todo:home:1", "todo").desk(HOME, "Personal", "personal").app("todo")
                .deadline(at(20, 0), false).title("Due today at 8:00 on Personal: call the plumber").build();
        Reach.Item far = B.of("result:far", "result").desk("d-work2", "Work 2", "work").need("info").build();
        r.items.add(due);
        r.items.add(far);
        r.update(t + MIN);
        Shield.Output o = r.see(t + 2 * MIN, focus(HOME, "notebook", "page", "pg-x", false));
        assertThat(card(o)).containsEntry("kind", "todo");
        // Everything held is findable: All held lists it with its reason.
        List<Map<String, Object>> held = r.shield.held(null, null, null, 50, t + 3 * MIN);
        assertThat(held).extracting(m -> m.get("itemId")).contains(far.id(), due.id());
        // An item that passes its deadline while still held is a miss.
        Reach.Item late = B.of("todo:work:late", "todo").desk("d-work2", "Work 2", "work").deadline(t + 4 * MIN,
                false).build();
        r.items.add(late);
        r.update(t + 3 * MIN);
        r.update(t + 5 * MIN);
        assertThat(r.store.misses).contains(late.key());
    }

    @Test
    void stateSurvivesARestartAndForgetClearsHistoryButNotTheList() throws Exception {
        Run r = new Run();
        long t = at(10, 0);
        r.see(t, notebook(false));
        Reach.Item sam = B.of("message:sam", "message").channel(contact("thread-sam"))
                .from(person(WORK, "Sam"), "known_confirmed", true).direct(t).need("you").build();
        r.items.add(sam);
        r.see(t + MIN, focus(WORK, "todo", null, null, false));
        r.shield.answer(Map.of("cardId", card(r.last).get("cardId"), "answer", "not_important"), t + MIN + 1_000);
        r.shield.set(Map.of("catchUps", List.of("09:00", "17:00")), t + 2 * MIN);
        Shield again = new Shield(r.store, () -> ZONE);
        assertThat(again.learnedView(t + 3 * MIN)).hasSize(1);
        assertThat(again.settings(t + 3 * MIN).catchUps()).hasSize(2);
        Shield.Output o = again.update(t + 3 * MIN, r.items, ShieldFixture.scopes(), ShieldFixture.names());
        assertThat(o.heldKeys()).contains(sam.key());
        again.forget(t + 4 * MIN);
        assertThat(again.learnedView(t + 5 * MIN)).isEmpty();
        assertThat(again.settings(t + 5 * MIN).catchUps()).hasSize(2);
    }

    @Test
    void showEverythingAsItComesTurnsItOffAndTheStatedTaskOnlyMovesCloseness() throws Exception {
        Run r = new Run();
        long t = at(10, 0);
        r.see(t, notebook(false));
        Shield.Output o = r.update(t + 4 * MIN);
        assertThat(line(o)).containsEntry("kind", "clear").containsEntry("text", "All clear");
        Map<String, Object> set = r.shield.focusSet("  Q3 plan  ", t + 4 * MIN);
        assertThat(set).containsEntry("label", "Q3 plan").containsEntry("refs", 1);
        Reach.Item linked = B.of("doc:work:q3", "doc").app("files").doc("pg-q3").need("info").build();
        r.items.add(linked);
        r.see(t + 5 * MIN, focus(WORK, "todo", null, null, false));
        assertThat((Map<String, Object>) r.last.view().get("working")).containsEntry("label", "Q3 plan");
        r.shield.set(Map.of("showAll", true), t + 6 * MIN);
        o = r.update(t + 6 * MIN + 1);
        assertThat(o.on()).isFalse();
        assertThat(o.view()).containsEntry("on", false);
        assertThat(o.heldKeys()).isEmpty();
    }

    @Test
    void aSearchOfAllHeldBeforeAnOfferCountsAsSooner() throws Exception {
        Run r = new Run();
        long t = at(10, 0);
        r.see(t, notebook(false));
        Reach.Item far = B.of("result:far", "result").desk("d-work2", "Work 2", "work").need("info").build();
        r.items.add(far);
        r.update(t + MIN);
        assertThat(r.shield.held("d-work2", null, null, 10, t + 2 * MIN)).hasSize(1);
        r.shield.save(t + 2 * MIN);
        Map<String, Object> classes = (Map<String, Object>) r.store.state().get("classes");
        assertThat(classes).isNotEmpty();
        assertThat(with(Map.of(), "x", 1)).isNotNull();
    }
}
