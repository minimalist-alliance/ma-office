package com.minimalistalliance.desk.agent.maia;

import static com.minimalistalliance.desk.agent.maia.ShieldFixture.MIN;
import static com.minimalistalliance.desk.agent.maia.ShieldFixture.ZONE;
import static com.minimalistalliance.desk.agent.maia.ShieldFixture.at;
import static com.minimalistalliance.desk.agent.maia.ShieldFixture.contact;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.agent.service.RpcError;
import java.time.LocalTime;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * The decision tray (deskd API.md §23 "The tray", the tray spec): papers from what needs the member, answers fitted to
 * each kind by code, the confirm strip for send, spend, delete and egress, Later only while the deadline allows, her
 * line and answers through the label filter, and the answer's checks.
 */
class TrayTest {

    static final String WORK = "d-work";
    static final String HOME = "d-personal";
    static final long NOW = at(10, 0);

    static Reach.Settings settings() {
        return new Reach.Settings(List.of(), false, List.of(LocalTime.of(9, 0), LocalTime.of(13, 0),
                LocalTime.of(17, 0)), List.of(), null, "hold", "paragraph", false);
    }

    static Attention.Desk desk(String id, String name, String kind, List<Attention.Approval> approvals,
            List<Attention.DueSoon> due) {
        return new Attention.Desk(id, name, kind, "running", true, List.of(new Attention.Agent("ag-writer", "Writer",
                "online", "awaiting_approval", approvals.size()), new Attention.Agent("ag-scout", "Scout", "online",
                null, 0)), approvals, List.of(), 0, due);
    }

    static Tray.Input input(List<Attention.Desk> desks, Map<String, ReachItems.Extras> extras,
            List<Tray.ReportFacts> reports, Map<String, Tray.State> states, Map<String, Tray.Note> notes, long now) {
        return new Tray.Input(now, ZONE, settings(), desks, extras, reports, List.of(), states, notes,
                new HashMap<>());
    }

    static List<Tray.Paper> build(List<Attention.Desk> desks) {
        return Tray.build(input(desks, Map.of(), List.of(), Map.of(), Map.of(), NOW));
    }

    @Test
    void eachApprovalIsItsOwnPaperAndSendHasAConfirmAndNoPick() {
        Attention.Desk work = desk(WORK, "Work", "work", List.of(
                new Attention.Approval("ap-aaaaaaaaaaaaaaaaaaaa", "ag-writer", NOW + 40 * MIN, "send", true),
                new Attention.Approval("ap-bbbbbbbbbbbbbbbbbbbb", "ag-writer", NOW + 50 * MIN, "write", false)),
                List.of());
        List<Tray.Paper> papers = build(List.of(work));
        assertThat(papers).hasSize(2);
        Tray.Paper send = papers.stream().filter(p -> "send".equals(p.risk())).findFirst().orElseThrow();
        assertThat(send.kind()).isEqualTo("approval");
        assertThat(send.asker()).containsEntry("label", "Work · Writer").containsEntry("agentId", "ag-writer");
        assertThat(send.answers()).extracting(Tray.Answer::label).containsExactly("Approve…", "Ask for changes",
                "Decline");
        assertThat(send.answers().get(0).confirm()).isEqualTo("send");
        assertThat(send.pick()).as("no first-tap recommendation to send").isNull();
        assertThat(send.dismissable()).isFalse();
        assertThat(send.untrusted()).isTrue();
        assertThat(send.freeform()).containsEntry("as", "note").containsEntry("max", 500);
        assertThat(send.reply()).containsEntry("kind", "approval").containsEntry("approvalId",
                "ap-aaaaaaaaaaaaaaaaaaaa");
        assertThat(send.materials()).extracting(Tray.Material::kind).containsExactly("payload");
        Tray.Paper write = papers.stream().filter(p -> "write".equals(p.risk())).findFirst().orElseThrow();
        assertThat(write.answers().get(0).label()).isEqualTo("Approve");
        assertThat(write.answers().get(0).confirm()).isNull();
        assertThat(write.pick()).isZero();
        // The same paper on every build.
        assertThat(build(List.of(work))).extracting(Tray.Paper::paperId).containsExactlyElementsOf(
                papers.stream().map(Tray.Paper::paperId).toList());
        assertThat(Tray.paperIdOk(send.paperId())).isTrue();
        // Spend pays, delete deletes, egress shares.
        assertThat(Tray.verb("spend")).isEqualTo("pay");
        assertThat(Tray.verb("delete")).isEqualTo("delete");
        assertThat(Tray.verb("egress")).isEqualTo("share");
        // A class the office didn't say, or doesn't know: the confirm strip too, asking to go ahead (TRAY-L3).
        Attention.Desk odd = desk(WORK, "Work", "work", List.of(
                new Attention.Approval("ap-cccccccccccccccccccc", "ag-writer", NOW + 40 * MIN, null, false),
                new Attention.Approval("ap-dddddddddddddddddddd", "ag-writer", NOW + 40 * MIN, "teleport", false)),
                List.of());
        assertThat(build(List.of(odd))).hasSize(2).allSatisfy(p -> {
            assertThat(p.answers().get(0).confirm()).isEqualTo("approve");
            assertThat(p.answers().get(0).label()).isEqualTo("Approve…");
            assertThat(p.pick()).isNull();
        });
    }

    @Test
    void laterOnlyWhileTheDeadlineAllowsIt() {
        // 10:00, next catch-up 1:00. An approval expiring at 10:40: no catch-up before it, but 20 minutes fit.
        Attention.Desk work = desk(WORK, "Work", "work", List.of(
                new Attention.Approval("ap-aaaaaaaaaaaaaaaaaaaa", "ag-writer", NOW + 40 * MIN, "send", false)),
                List.of());
        Tray.Paper p = build(List.of(work)).get(0);
        assertThat(p.later()).containsEntry("allowed", true).containsEntry("kind", "in_20")
                .containsEntry("until", NOW + 20 * MIN);
        // Expiring at 10:20: nothing fits, no Later.
        work = desk(WORK, "Work", "work", List.of(
                new Attention.Approval("ap-aaaaaaaaaaaaaaaaaaaa", "ag-writer", NOW + 20 * MIN, "send", false)),
                List.of());
        Tray.Paper tight = build(List.of(work)).get(0);
        assertThat(tight.later()).containsEntry("allowed", false);
        assertThatThrownBy(() -> Tray.laterOn(tight, NOW)).isInstanceOf(RpcError.class);
        // Expiring at 3:00: Later is the 1:00 catch-up.
        work = desk(WORK, "Work", "work", List.of(
                new Attention.Approval("ap-aaaaaaaaaaaaaaaaaaaa", "ag-writer", at(15, 0), "write", false)),
                List.of());
        Tray.Paper roomy = build(List.of(work)).get(0);
        assertThat(roomy.later()).containsEntry("kind", "catchup").containsEntry("until", at(13, 0));
        Tray.State later = assertDoesntThrow(() -> Tray.laterOn(roomy, NOW));
        assertThat(later.laterUntil()).isEqualTo(at(13, 0));
        assertThat(later.laterCount()).isEqualTo(1);
    }

    @Test
    void laterThreeTimesOffersTellingTheAskerNotNow() {
        Attention.Desk work = desk(WORK, "Work", "work", List.of(
                new Attention.Approval("ap-aaaaaaaaaaaaaaaaaaaa", "ag-writer", at(16, 0), "write", false)),
                List.of());
        Tray.Paper p = build(List.of(work)).get(0);
        Tray.State s = p.state();
        for (int i = 0; i < 3; i++) {
            s = s.later(NOW - 1);
        }
        Tray.Paper again = Tray.build(input(List.of(work), Map.of(), List.of(), Map.of(p.paperId(), s), Map.of(),
                NOW)).get(0);
        assertThat(again.answers()).extracting(Tray.Answer::id).contains("not_now");
        Tray.Answer nudge = again.answer("not_now");
        assertThat(nudge.does()).isEqualTo("decline");
        assertThat(nudge.label().length()).isLessThanOrEqualTo(Tray.LABEL_MAX);
    }

    @Test
    void aReportsPaperTakesHerLineAndAnswersOrTheAgentsAskAndNeverHerBadLabels() {
        Attention.Desk work = desk(WORK, "Work", "work", List.of(), List.of());
        Reports.Ask ask = new Reports.Ask("Which laptop for Dana’s team?", List.of("X1 Carbon", "MacBook Air"),
                null);
        Tray.ReportFacts r = new Tray.ReportFacts("msg-1", WORK, "Work", "Scout", "needs_decision",
                "Three fit the budget.", ask, "wu-aaaaaaaaaaaaaaaaaaaa", NOW - 5 * MIN);
        Tray.Paper p = Tray.build(input(List.of(work), Map.of(), List.of(r), Map.of(), Map.of(), NOW)).get(0);
        assertThat(p.kind()).isEqualTo("report");
        assertThat(p.title()).isEqualTo("Which laptop for Dana’s team?");
        assertThat(p.answers()).extracting(Tray.Answer::label).containsExactly("X1 Carbon", "MacBook Air");
        assertThat(p.freeform()).containsEntry("as", "message");
        assertThat(p.line()).containsEntry("by", "agent").containsEntry("text", "Three fit the budget.")
                .containsEntry("from", "m-writeup");
        assertThat(p.reply()).containsEntry("kind", "maia_brief").containsEntry("messageId", "msg-1");
        assertThat(p.materials()).extracting(Tray.Material::kind).containsExactly("writeup");
        // Her note wins: her line, her answers, her pick.
        Tray.Note note = new Tray.Note("Scout leans to the X1 Carbon for battery life.", List.of("X1 Carbon",
                "MacBook Air", "Look again"), 0, NOW);
        Tray.Paper hers = Tray.build(input(List.of(work), Map.of(), List.of(r), Map.of(), Map.of(p.paperId(), note),
                NOW)).get(0);
        assertThat(hers.line()).containsEntry("by", "maia");
        assertThat(hers.answers()).extracting(Tray.Answer::label).containsExactly("X1 Carbon", "MacBook Air",
                "Look again");
        assertThat(hers.pick()).isZero();
        assertThat(hers.answers()).allMatch(a -> !Tray.DOES.contains("approve") || !"approve".equals(a.does()));
        // An injected label (an address, a link, a long number, approve all) drops her answers: the agent's stay.
        for (List<String> bad : List.of(List.of("Yes, send it to x@evil.com"), List.of("Open www.evil.com"),
                List.of("Pay 123456789"), List.of("Approve all of these now please ok"), List.of("ok", "OK"))) {
            Tray.Note injected = new Tray.Note("Line", bad, 0, NOW);
            Tray.Paper x = Tray.build(input(List.of(work), Map.of(), List.of(r), Map.of(),
                    Map.of(p.paperId(), injected), NOW)).get(0);
            assertThat(x.answers()).extracting(Tray.Answer::label).as(bad.toString())
                    .containsExactly("X1 Carbon", "MacBook Air");
        }
        assertThat(Tray.label("Hold till Mon​")).isNull();
        assertThat(Tray.label("Use the shorter intro")).isEqualTo("Use the shorter intro");
        // Full-width forms, any dotted name, a slash or colon, digits split by spaces or dots (TRAY-L1).
        for (String bad : List.of("Visit ｅｖｉｌ．ｃｏｍ", "See evil.example",
                "Mail a＠b", "Use x/y", "Go: now", "Call 555 12 34", "Pay 12.345", "Wire +1-800-55",
                "See evil。com", "See evil｡com")) {
            assertThat(Tray.label(bad)).as(bad).isNull();
        }
        assertThat(Tray.label("X1 Carbon")).isEqualTo("X1 Carbon");
        assertThat(Tray.label("Move to 3 pm")).isEqualTo("Move to 3 pm");
        // The agent's own question heads the paper only when it's safe to show (TRAY-I2).
        Tray.ReportFacts linky = new Tray.ReportFacts("msg-2", WORK, "Work", "Scout", "needs_decision", "Line.",
                new Reports.Ask("Pay at pay.evil.example?", List.of(), null), null, NOW - 5 * MIN);
        assertThat(Tray.build(input(List.of(work), Map.of(), List.of(linky), Map.of(), Map.of(), NOW)).get(0).title())
                .isEqualTo("Scout needs your decision");
    }

    @Test
    void aBlockedReportWithNoAnswersOffersOpenAndStop() {
        Attention.Desk work = desk(WORK, "Work", "work", List.of(), List.of());
        Tray.ReportFacts r = new Tray.ReportFacts("msg-2", WORK, "Work", "Writer", "blocked", "", null, null,
                NOW - MIN);
        Tray.Paper p = Tray.build(input(List.of(work), Map.of(), List.of(r), Map.of(), Map.of(), NOW)).get(0);
        assertThat(p.title()).isEqualTo("Writer is stuck");
        assertThat(p.answers()).extracting(Tray.Answer::does).containsExactly("open", "custom");
        assertThat(p.line()).containsEntry("by", "code");
    }

    @Test
    void documentsPeopleWaitingAndToDosFromSomeone() {
        String rosa = contact("Rosa");
        ReachItems.Doc doc = new ReachItems.Doc("d_01doc", "needs_you", List.of(new Focus.Person(HOME, rosa)),
                null, rosa, null, null, null, true, NOW - 60 * MIN);
        ReachItems.Thread thread = new ReachItems.Thread(rosa, "direct", List.of(new Focus.Person(HOME, rosa)), true,
                true, false, NOW - 26 * 60 * MIN, 1, 1, NOW - 26 * 60 * MIN);
        ReachItems.Thread fresh = new ReachItems.Thread(contact("Sam"), "direct",
                List.of(new Focus.Person(HOME, contact("Sam"))), true, true, false, NOW - 2 * 60 * MIN, 1, 1,
                NOW - 2 * 60 * MIN);
        Attention.Desk home = desk(HOME, "Personal", "personal", List.of(), List.of(
                new Attention.DueSoon("td-1", "Call the venue", at(15, 0), false, "courier"),
                new Attention.DueSoon("td-2", "My own thing", at(15, 0), true, null)));
        List<Tray.Paper> papers = Tray.build(input(List.of(home), Map.of(HOME, new ReachItems.Extras(
                List.of(thread, fresh), List.of(doc))), List.of(), Map.of(), Map.of(), NOW));
        assertThat(papers).extracting(Tray.Paper::kind).containsExactlyInAnyOrder("doc", "reply", "todo");
        Tray.Paper d = papers.stream().filter(p -> "doc".equals(p.kind())).findFirst().orElseThrow();
        assertThat(d.title()).isEqualTo("A document from {who} needs you");
        assertThat(d.answers()).extracting(Tray.Answer::label).containsExactly("Open", "Done", "Remind me tomorrow");
        assertThat(d.freeform()).containsEntry("as", "reply");
        Tray.Paper reply = papers.stream().filter(p -> "reply".equals(p.kind())).findFirst().orElseThrow();
        assertThat(reply.answers()).extracting(Tray.Answer::label).containsExactly("Reply", "Remind me tomorrow",
                "No reply needed");
        assertThat(reply.reply()).containsEntry("kind", "courier").containsEntry("channelId", rosa);
        assertThat(reply.asker()).containsKey("who");
        Tray.Paper todo = papers.stream().filter(p -> "todo".equals(p.kind())).findFirst().orElseThrow();
        assertThat(todo.title()).isEqualTo("Due 3:00: Call the venue");
        assertThat(todo.answers()).extracting(Tray.Answer::does).containsExactly("done", "move");
        assertThat(todo.freeform()).containsEntry("as", "none");
    }

    @Test
    void aGuildDeskNeverHasAPaper() {
        Attention.Desk guild = new Attention.Desk("d-guild", "Guild", "guild", "running", true, List.of(),
                List.of(new Attention.Approval("ap-aaaaaaaaaaaaaaaaaaaa", "ag-x", NOW + 40 * MIN, "send", false)),
                List.of(), 0, List.of());
        assertThat(build(List.of(guild))).isEmpty();
    }

    @Test
    void theStackPutsADeadlineWithinThreeHoursFirstAndKeepsAnAskersPapersTogether() {
        Attention.Desk work = desk(WORK, "Work", "work", List.of(
                new Attention.Approval("ap-later0000000000000000".substring(0, 23), "ag-writer", at(20, 0), "write",
                        false),
                new Attention.Approval("ap-soonaaaaaaaaaaaaaaaa", "ag-scout", NOW + 30 * MIN, "write", false)),
                List.of());
        List<Tray.Paper> papers = build(List.of(work));
        assertThat(papers.get(0).expiresAt()).isEqualTo(NOW + 30 * MIN);
    }

    @Test
    void anAnswerIsCheckedAndFreeFormStaysWithinItsLimit() throws Exception {
        Attention.Desk work = desk(WORK, "Work", "work", List.of(
                new Attention.Approval("ap-aaaaaaaaaaaaaaaaaaaa", "ag-writer", NOW + 40 * MIN, "send", false)),
                List.of());
        Tray.Paper p = build(List.of(work)).get(0);
        Tray.Answered approve = Tray.answer(p, "approve", null, "dv-office0001", NOW);
        assertThat(approve.deliver()).isEqualTo("office");
        assertThat(approve.state().state()).isEqualTo("sending");
        assertThat(approve.state().answerId()).isEqualTo("approve");
        // Ask for changes needs the note; a note over 500 or with hidden characters is refused.
        assertThatThrownBy(() -> Tray.answer(p, "revise", null, null, NOW)).isInstanceOf(RpcError.class);
        assertThatThrownBy(() -> Tray.answer(p, "revise", "x".repeat(501), null, NOW)).isInstanceOf(RpcError.class);
        assertThatThrownBy(() -> Tray.answer(p, "revise", "fine‮", null, NOW)).isInstanceOf(RpcError.class);
        assertThat(Tray.answer(p, "revise", "Keep the v2 intro.", null, NOW).deliver()).isEqualTo("office");
        // Custom on an approval is a decline with the note; an answer it doesn't offer is refused; open isn't an answer.
        assertThat(Tray.answer(p, "custom", "Not like this.", null, NOW).state().answerId()).isEqualTo("custom");
        assertThatThrownBy(() -> Tray.answer(p, "approve_all", null, null, NOW)).isInstanceOf(RpcError.class);
        // Answered once: a second answer is a conflict.
        Tray.Paper answered = new Tray.Paper(p.paperId(), p.itemKey(), p.itemId(), p.kind(), p.asker(), p.title(),
                p.line(), p.answers(), p.pick(), p.freeform(), p.later(), p.dismissable(), p.materials(), p.reply(),
                p.dueAt(), p.expiresAt(), p.untrusted(), p.risk(), approve.state(), p.at());
        assertThatThrownBy(() -> Tray.answer(answered, "decline", null, null, NOW))
                .isInstanceOfSatisfying(RpcError.class, e -> assertThat(e.code()).isEqualTo("conflict"));
    }

    @Test
    void remindMeAndNoReplyNeededStayHereAndAReportGoesFromHome() throws Exception {
        String rosa = contact("Rosa");
        ReachItems.Thread thread = new ReachItems.Thread(rosa, "direct", List.of(new Focus.Person(HOME, rosa)), true,
                true, false, NOW - 26 * 60 * MIN, 1, 1, NOW - 26 * 60 * MIN);
        Attention.Desk home = desk(HOME, "Personal", "personal", List.of(), List.of());
        Tray.Paper reply = Tray.build(input(List.of(home), Map.of(HOME, new ReachItems.Extras(List.of(thread),
                List.of())), List.of(), Map.of(), Map.of(), NOW)).get(0);
        Tray.Answered remind = Tray.answer(reply, "remind", null, null, NOW);
        assertThat(remind.deliver()).isEqualTo("none");
        assertThat(remind.state().open()).isTrue();
        assertThat(remind.state().laterUntil()).isGreaterThan(NOW);
        assertThat(Tray.answer(reply, "none", null, null, NOW).deliver()).isEqualTo("none");
        Tray.Answered sent = Tray.answer(reply, "reply", "On my way.", null, NOW);
        assertThat(sent.deliver()).isEqualTo("office");
        Attention.Desk work = desk(WORK, "Work", "work", List.of(), List.of());
        Tray.ReportFacts r = new Tray.ReportFacts("msg-1", WORK, "Work", "Scout", "needs_decision", "s",
                new Reports.Ask("Which?", List.of("A", "B"), null), null, NOW);
        Tray.Paper report = Tray.build(input(List.of(work), Map.of(), List.of(r), Map.of(), Map.of(), NOW)).get(0);
        assertThat(Tray.answer(report, "a1", null, null, NOW).deliver()).isEqualTo("home");
    }

    @Test
    void theSnapshotHoldsOpenPapersNotPutOffAndCountsTheRest() {
        Attention.Desk work = desk(WORK, "Work", "work", List.of(
                new Attention.Approval("ap-aaaaaaaaaaaaaaaaaaaa", "ag-writer", at(16, 0), "write", false),
                new Attention.Approval("ap-bbbbbbbbbbbbbbbbbbbb", "ag-writer", at(16, 0), "write", false)),
                List.of());
        List<Tray.Paper> papers = build(List.of(work));
        Tray.State later = papers.get(1).state().later(at(13, 0));
        List<Tray.Paper> again = Tray.build(input(List.of(work), Map.of(), List.of(), Map.of(later.paperId(), later),
                Map.of(), NOW));
        Map<String, Object> view = Tray.view(again, NOW);
        assertThat(view).containsEntry("count", 2).containsEntry("now", 1).containsEntry("later", 1);
        assertThat(Tray.view(again, at(13, 1))).containsEntry("now", 2);
    }

    @Test
    void theReportLineCarriesTheAgentsAskOnlyWhenItNeedsTheMember() {
        String reply = "Here is my comparison.\nREPORT {\"status\":\"needs_decision\",\"urgency\":\"soon\","
                + "\"importance\":\"normal\",\"summary\":\"Three fit.\",\"ask\":{\"question\":\"Which laptop?\","
                + "\"options\":[\"X1 Carbon\",\"MacBook Air\"]}}";
        Reports.Report r = Reports.parseReply(reply);
        assertThat(r.ask()).isNotNull();
        assertThat(r.ask().options()).containsExactly("X1 Carbon", "MacBook Air");
        Reports.Report back = Reports.parseCompact(Reports.compact(r, "wu-aaaaaaaaaaaaaaaaaaaa"));
        assertThat(back.ask().question()).isEqualTo("Which laptop?");
        assertThat(back.ask().options()).containsExactly("X1 Carbon", "MacBook Air");
        // A label with an address drops the options; a done report carries no ask.
        Reports.Report bad = Reports.parseReply("x\nREPORT {\"status\":\"needs_decision\",\"ask\":{\"question\":\"Q?\","
                + "\"options\":[\"Mail a@b.co\"]}}");
        assertThat(bad.ask().options()).isEmpty();
        Reports.Report done = Reports.parseReply("x\nREPORT {\"status\":\"done\",\"ask\":{\"question\":\"Q?\"}}");
        assertThat(done.ask()).isNull();
    }

    @Test
    void theStoreKeepsStatesNotesAndWaitingAnswersAndWipesWordsOnceSent() {
        TrayStore store = TrayStore.memory();
        Tray.State s = Tray.State.fresh("pp-aaaaaaaaaaaaaaaaaaaa", "approval:d-work:ap-1", "approval", WORK, NOW);
        store.put(s.later(at(13, 0)), NOW);
        assertThat(store.state(s.paperId()).laterCount()).isEqualTo(1);
        store.note(s, new Tray.Note("Line", List.of("A"), 0, NOW), NOW);
        assertThat(store.notes(NOW)).containsKey(s.paperId());
        assertThat(store.notes(NOW + 8 * 24 * 60 * MIN)).isEmpty();
        TrayStore.Out o = new TrayStore.Out("po-aaaaaaaaaaaaaaaaaaaa", s.paperId(), WORK, "approval", "revise",
                "revise", null, "Keep the intro.", NOW, NOW + 40 * MIN, "waiting", Map.of("kind", "approval",
                "deskId", WORK, "approvalId", "ap-1"), null);
        store.queue(o);
        assertThat(store.out()).extracting(TrayStore.Out::text).containsExactly("Keep the intro.");
        assertThat(store.out().get(0).view()).containsEntry("reply", Map.of("kind", "approval", "deskId", WORK,
                "approvalId", "ap-1")).doesNotContainKey("sha256");
        store.sent(o.outId());
        assertThat(store.out()).isEmpty();
        // A report's paper still open after 7 days goes with its source; her notes go then too (TRAY-L2).
        Tray.State rep = Tray.State.fresh("pp-bbbbbbbbbbbbbbbbbbbb", "report:d-work:msg-1", "report", WORK, NOW);
        store.put(rep, NOW);
        store.note(rep, new Tray.Note("Line", List.of("A"), 0, NOW), NOW);
        store.prune(NOW + 8 * 24 * 60 * MIN);
        assertThat(store.states()).doesNotContainKey(rep.paperId()).containsKey(s.paperId());
        assertThat(store.notes(NOW)).isEmpty();
        store.forget();
        assertThat(store.states()).isEmpty();
    }

    @Test
    void herBatchNamesTheReportsPapersAndHerNoteHoldsIdsAndKindsOnly() {
        AwayStore.Row needs = new AwayStore.Row("rp-1", "env-1", WORK, "Scout", "needs_decision", "soon", "normal", false,
                null, "msg-1", "waiting", null, NOW, NOW);
        AwayStore.Row done = new AwayStore.Row("rp-2", "env-2", WORK, "Writer", "done", "later", "normal", false, null,
                "msg-2", "waiting", null, NOW, NOW);
        String text = Away.paperText(List.of(needs, done));
        assertThat(text).contains(Tray.paperId("report:" + WORK + ":msg-1")).contains("paper_note")
                .contains("Don't decide for them").doesNotContain(Tray.paperId("report:" + WORK + ":msg-2"));
        assertThat(Away.papersOf(List.of(needs, done))).containsExactly(Tray.paperId("report:" + WORK + ":msg-1"));
        assertThat(Away.paperText(List.of(done))).isEmpty();
        Attention.Desk work = desk(WORK, "Work", "work", List.of(
                new Attention.Approval("ap-aaaaaaaaaaaaaaaaaaaa", "ag-writer", NOW + 40 * MIN, "send", false)),
                List.of());
        String line = MaiaProfile.paperLine(build(List.of(work)));
        assertThat(line).contains("[paper:pp-").contains("an approval").contains("never answer or approve")
                .doesNotContain("Writer needs your OK");
        assertThat(MaiaProfile.paperLine(List.of())).isEmpty();
    }

    private static <T> T assertDoesntThrow(ThrowingSupplier<T> s) {
        try {
            return s.get();
        } catch (Exception e) {
            throw new AssertionError(e);
        }
    }

    @FunctionalInterface
    interface ThrowingSupplier<T> {
        T get() throws Exception;
    }
}
