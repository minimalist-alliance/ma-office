package com.minimalistalliance.desk.agent.team;

import static com.minimalistalliance.desk.agent.testing.FakeProvider.Step.call;
import static com.minimalistalliance.desk.agent.testing.TeamDesk.m;
import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.agent.provider.ToolResult;
import com.minimalistalliance.desk.agent.provider.Usage;
import com.minimalistalliance.desk.agent.service.RpcError;
import com.minimalistalliance.desk.agent.store.AgentStore;
import com.minimalistalliance.desk.agent.testing.FakeProvider.Step;
import com.minimalistalliance.desk.agent.testing.TeamDesk;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Text a card shows as one thing while the model reads another (AI M15, CC-M3, ISO-L9): Unicode format characters and
 * bidi controls are refused in names, purposes, rules, timer labels and prompts, as {@code bad_request} with the field
 * and {@code reason: "hidden_chars"}.
 */
class HiddenCharsTest {

    @TempDir
    Path data;

    @Test
    void formatAndBidiCharactersAndFillersAreHidden() {
        for (String text : new String[] {"a​b", "x‌", "‍y", "rtl ‮ txt", "⁦iso⁩", "﻿bom",
                "soft­hyphen", "tag 󠁁", "filler ㅤ", "؜", "lrm‎", "a‍b"}) {
            assertThat(TextChecks.hidden(text)).as(text.codePoints().mapToObj(Integer::toHexString).toList()
                    .toString()).isTrue();
        }
        for (String text : new String[] {"Plain text.", "café", "日本語のメモ", "مرحبا", "שלום", "👍🏽",
                "family 👨‍👩‍👧 ok", "heart ❤️‍🔥", "tabs\tand\nlines", ""}) {
            assertThat(TextChecks.hidden(text)).as(text).isFalse();
        }
    }

    @Test
    void namesThatReadAlikeHaveOneKey() {
        assertThat(List.of("Notes", "NOTES", "  notes ", "Nоtes", "Ｎotes", "No​tes", "Νotes"))
                .allMatch(name -> TextChecks.nameKey(name).equals("notes"));
        assertThat(TextChecks.nameKey("Morning   brief")).isEqualTo("morning brief");
        assertThat(TextChecks.nameKey("Straße")).isEqualTo(TextChecks.nameKey("STRASSE"));
        assertThat(TextChecks.nameKey("Notes 2")).isNotEqualTo(TextChecks.nameKey("Notes"));
    }

    private static void assertHidden(RpcError e, String field) {
        assertThat(e.code()).isEqualTo("bad_request");
        assertThat(e.details()).containsEntry("detail", field).containsEntry("reason", "hidden_chars");
    }

    @Test
    void everyFieldTheMemberOrALeadWritesRefusesThem() throws Exception {
        try (TeamDesk desk = new TeamDesk(data)) {
            desk.bindLead();
            String a = desk.agent("Alpha");
            String b = desk.agent("Beta");

            assertHidden(desk.refused("agent.create", "name", "No​tes"), "name");
            assertHidden(desk.refused("agent.create", "name", "Ok", "purpose", "Summaries only.‮"), "purpose");
            assertHidden(desk.refused("agent.update", "agentId", a, "name", "Al⁦pha"), "name");
            assertHidden(desk.refused("agent.update", "agentId", a, "purpose", "x󠁁"), "purpose");
            assertHidden(desk.refused("agent.links.set", "agentId", a, "solo", false, "links",
                    List.of(m("to", b, "rules", "Ask only for summaries.​"))), "links");
            assertHidden(desk.refused("agent.timer.set", "agentId", a, "timer", m("label", "Daily‮", "kind",
                    "once", "inMinutes", 5, "prompt", "Go.")), "label");
            assertHidden(desk.refused("agent.timer.set", "agentId", a, "timer", m("label", "Daily", "kind", "once",
                    "inMinutes", 5, "prompt", "Go.⁧")), "prompt");

            Usage usage = new Usage(100, 0, 0, 20, 0);
            desk.provider.then(Step.calls(usage, List.of(
                    call("t1", "propose_agent", "name", "Scout", "purpose", "Watch.​", "icon", "nodes", "tone",
                            "teal"),
                    call("t2", "propose_links", "agent", a, "links", List.of(m("to", b, "rules", "‮Hi."))))))
                    .then(Step.answer(usage, "None."));
            desk.ask(AgentStore.MANAGER, "Set up.");
            assertThat(TeamDesk.toolResults(desk.lastRequest())).allSatisfy(result -> {
                assertThat(result.error()).isTrue();
                assertThat(result.content()).contains("hidden_chars").contains("Take out the invisible");
            });
            assertThat(desk.team.teamStore().hasProposals()).isFalse();
            assertThat(TeamDesk.toolResults(desk.lastRequest())).extracting(ToolResult::content).hasSize(2);
        }
    }
}
