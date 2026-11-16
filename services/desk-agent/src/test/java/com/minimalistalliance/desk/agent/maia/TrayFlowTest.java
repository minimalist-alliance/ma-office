package com.minimalistalliance.desk.agent.maia;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.agent.testing.MutableClock;
import com.minimalistalliance.desk.agent.testing.Rig;
import com.minimalistalliance.desk.agent.testing.TeamDesk;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The decision tray through the home desk's methods (deskd API.md §23 "The tray"): a pending approval the office saw
 * becomes a paper in {@code reach.tray}; the member's answer is queued here and the office's word on carrying it files
 * it; Later puts it off to the next catch-up; nothing she says answers it; "Delete Maia Mode history" clears it; with
 * "Show everything as it comes" there's no tray.
 */
@SuppressWarnings("unchecked")
class TrayFlowTest {

    @TempDir
    Path data;

    static Map<String, Object> focus() {
        return TeamDesk.m("surface", "desk", "deskId", MaiaDesk.WORK, "scope", "work", "app", "notebook",
                "input", TeamDesk.m("typing", false, "idle", false), "call", false, "share", false, "visible", true,
                "device", "dv-office0001");
    }

    static Map<String, Object> work(long expires, String... risks) {
        List<Map<String, Object>> approvals = new java.util.ArrayList<>();
        char c = 'a';
        for (String risk : risks) {
            approvals.add(TeamDesk.m("approvalId", "ap-" + String.valueOf(c).repeat(20), "agentId", "ag-writer",
                    "expiresAt", expires, "risk", risk, "untrusted", "send".equals(risk)));
            c++;
        }
        return MaiaDesk.deskSeen(MaiaDesk.WORK, "Work", "agents", List.of(TeamDesk.m("agentId", "ag-writer", "name",
                "Writer", "status", "online", "statusDetail", "awaiting_approval", "approvalsPending",
                approvals.size())), "approvals", approvals);
    }

    static Map<String, Object> tray(Map<String, Object> room) {
        Map<String, Object> reach = (Map<String, Object>) room.get("reach");
        return reach == null ? null : (Map<String, Object>) reach.get("tray");
    }

    static List<Map<String, Object>> papers(Map<String, Object> room) {
        Map<String, Object> t = tray(room);
        return t == null ? List.of() : (List<Map<String, Object>>) t.get("papers");
    }

    @Test
    void anApprovalBecomesAPaperItsAnswerIsQueuedAndCarriedAndLaterPutsItOff() throws Exception {
        MutableClock clock = new MutableClock(Rig.START);
        try (MaiaDesk maia = new MaiaDesk(data, clock)) {
            maia.on();
            long now = clock.millis();
            maia.call("agent.maia.observe", "desks", List.of(work(now + 6 * 3_600_000L, "send", "write")), "focus",
                    focus());
            Map<String, Object> room = maia.room();
            List<Map<String, Object>> papers = papers(room);
            assertThat(papers).hasSize(2);
            Map<String, Object> send = papers.stream().filter(p -> "send".equals(p.get("risk"))).findFirst()
                    .orElseThrow();
            assertThat(send).containsEntry("kind", "approval").containsEntry("dismissable", false)
                    .containsEntry("untrusted", true);
            assertThat((List<Map<String, Object>>) send.get("answers")).first().satisfies(a -> {
                assertThat(a).containsEntry("label", "Approve…");
                assertThat(a.get("confirm")).isEqualTo(Map.of("verb", "send"));
            });
            assertThat(send.get("pick")).isNull();
            String paperId = (String) send.get("paperId");

            // The member's answer: queued here first, then the office's word that it went.
            Map<String, Object> r = maia.call("agent.maia.tray.answer", "paperId", paperId, "answerId", "revise",
                    "text", "Keep the v2 intro.", "device", "dv-office0001");
            assertThat(r).containsEntry("deliver", "office");
            String outId = (String) r.get("outId");
            Map<String, Object> got = maia.call("agent.maia.tray.get");
            List<Map<String, Object>> out = (List<Map<String, Object>>) got.get("out");
            assertThat(out).singleElement().satisfies(o -> assertThat(o).containsEntry("text", "Keep the v2 intro.")
                    .containsEntry("replyKind", "approval"));
            maia.call("agent.maia.tray.answer", "paperId", paperId, "outId", outId, "delivered", "sent");
            got = maia.call("agent.maia.tray.get");
            assertThat((List<?>) got.get("out")).as("the member's words go once sent").isEmpty();
            room = maia.room();
            assertThat(papers(room)).extracting(p -> p.get("paperId")).doesNotContain(paperId);
            List<Map<String, Object>> filed = (List<Map<String, Object>>) tray(room).get("filed");
            assertThat(filed).first().satisfies(f -> assertThat(f).containsEntry("paperId", paperId)
                    .containsEntry("state", "sent").containsEntry("label", "Ask for changes"));
            // Answered: a second answer is a conflict.
            assertThat(maia.refused("agent.maia.tray.answer", "paperId", paperId, "answerId", "decline").code())
                    .isEqualTo("conflict");

            // Later: to the next catch-up, out of the stack, still counted.
            String other = (String) papers(room).get(0).get("paperId");
            Map<String, Object> later = maia.call("agent.maia.tray.later", "paperId", other);
            assertThat(later).containsKey("until");
            room = maia.room();
            assertThat(tray(room)).containsEntry("now", 0).containsEntry("later", 1);
            clock.advance(Duration.ofHours(4));
            maia.call("agent.maia.observe", "desks", List.of(work(now + 6 * 3_600_000L, "send", "write")), "focus",
                    focus());
            assertThat(papers(maia.room())).extracting(p -> p.get("paperId")).contains(other);

            // Approve names the payload the member saw: no hash, or not a hash, is refused (TRAY-M1).
            assertThat(maia.refused("agent.maia.tray.answer", "paperId", other, "answerId", "approve").code())
                    .isEqualTo("bad_request");
            assertThat(maia.refused("agent.maia.tray.answer", "paperId", other, "answerId", "approve", "sha256",
                    "not-a-hash").code()).isEqualTo("bad_request");
            String hash = "ab".repeat(32);
            Map<String, Object> ok = maia.call("agent.maia.tray.answer", "paperId", other, "answerId", "approve",
                    "sha256", hash);
            // Filed as said, without the confirm step's dots.
            assertThat(((Map<String, Object>) ok.get("paper")).get("answer")).satisfies(a -> assertThat(
                    (Map<String, Object>) a).containsEntry("label", "Approve"));
            List<Map<String, Object>> waiting = (List<Map<String, Object>>) maia.call("agent.maia.tray.get").get("out");
            assertThat(waiting).singleElement().satisfies(o -> {
                assertThat(o).containsEntry("sha256", hash).containsEntry("outId", ok.get("outId"));
                assertThat((Map<String, Object>) o.get("reply")).containsEntry("kind", "approval")
                        .containsKey("approvalId");
            });
            maia.call("agent.maia.tray.answer", "paperId", other, "outId", ok.get("outId"), "delivered", "changed");
            assertThat(papers(maia.room())).extracting(p -> p.get("paperId")).as("changed: back in the stack")
                    .contains(other);

            // An answer the paper doesn't offer, a bad paper id: refused.
            assertThat(maia.refused("agent.maia.tray.answer", "paperId", other, "answerId", "approve_all").code())
                    .isEqualTo("bad_request");
            assertThat(maia.refused("agent.maia.tray.get", "paperId", "pp-x").code()).isEqualTo("bad_request");

            // Answered elsewhere: the approval left the desk's list; the paper is withdrawn with its line.
            maia.call("agent.maia.observe", "desks", List.of(work(now + 6 * 3_600_000L)), "focus", focus());
            room = maia.room();
            assertThat(papers(room)).isEmpty();
            assertThat((List<Map<String, Object>>) tray(room).get("filed")).anySatisfy(f -> assertThat(f)
                    .containsEntry("state", "withdrawn"));

            // "Delete Maia Mode history" clears the tray's rows.
            maia.call("agent.maia.forget");
            assertThat(maia.desk.service.call("agent.maia.tray.get", Map.of(),
                    com.minimalistalliance.desk.agent.service.Caller.OWNER).get("out")).isEqualTo(List.of());
        }
    }

    @Test
    void aQuickReplyFilesAPersonsMessageWithNoBackAndHeldRowsSayWho() throws Exception {
        MutableClock clock = new MutableClock(Rig.START);
        try (MaiaDesk maia = new MaiaDesk(data, clock)) {
            maia.on();
            long now = clock.millis();
            String rosa = ShieldFixture.contact("Rosa");
            Map<String, Object> courier = TeamDesk.m("threads", List.of(TeamDesk.m("channelId", rosa, "kind", "direct",
                    "contactIds", List.of(rosa), "known", true, "confirmed", true, "bulk", false, "theyWroteLastAt",
                    now - 26 * 3_600_000L, "replyBand", 1, "unread", 1, "newestAt", now - 26 * 3_600_000L)));
            Map<String, Object> desk = work(now + 6 * 3_600_000L);
            desk.put("courier", courier);
            maia.call("agent.maia.observe", "desks", List.of(desk), "focus", focus());
            List<Map<String, Object>> held = (List<Map<String, Object>>) maia.call("agent.maia.reach.held").get("items");
            Map<String, Object> row = held.stream().filter(i -> "message".equals(i.get("kind"))).findFirst()
                    .orElseThrow();
            assertThat(row.get("who")).isEqualTo(Map.of("deskId", MaiaDesk.WORK, "contactId", rosa));
            maia.call("agent.maia.reach.answer", "itemId", row.get("itemId"), "answer", "replied");
            held = (List<Map<String, Object>>) maia.call("agent.maia.reach.held").get("items");
            assertThat(held).noneMatch(i -> row.get("itemId").equals(i.get("itemId")));
            // Only a message or a document can be "replied" to.
            Map<String, Object> approvalRow = TeamDesk.m("itemId", Attention.id("approval:" + MaiaDesk.WORK));
            maia.call("agent.maia.observe", "desks", List.of(work(now + 6 * 3_600_000L, "send")), "focus", focus());
            assertThat(maia.refused("agent.maia.reach.answer", "itemId", approvalRow.get("itemId"), "answer",
                    "replied").code()).isEqualTo("bad_request");
        }
    }

    @Test
    void showEverythingAsItComesHasNoTray() throws Exception {
        MutableClock clock = new MutableClock(Rig.START);
        try (MaiaDesk maia = new MaiaDesk(data, clock)) {
            maia.on();
            long now = clock.millis();
            maia.call("agent.maia.reach.set", "showAll", true);
            maia.call("agent.maia.observe", "desks", List.of(work(now + 3_600_000L, "send")), "focus", focus());
            assertThat(tray(maia.room())).isNull();
        }
    }
}
