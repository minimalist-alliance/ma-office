package com.minimalistalliance.desk.agent.tool;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.agent.provider.ToolCall;
import com.minimalistalliance.desk.agent.provider.ToolResult;
import org.junit.jupiter.api.Test;

/** What a restart does to a call in flight ({@link Restart}): the rules, a call's rule, and an interrupted result. */
class RestartTest {

    @Test
    void aCallThatRoseToAClassThatAsksIsNeverSafe() {
        assertThat(Restart.SAFE.forCall(Risk.READ, ToolDecl.Host.DESKD)).isEqualTo(Restart.SAFE);
        assertThat(Restart.SAFE.forCall(Risk.OWN, ToolDecl.Host.DESK_AGENT)).isEqualTo(Restart.SAFE);
        for (Risk risk : new Risk[] {Risk.WRITE, Risk.DELETE, Risk.SEND, Risk.SPEND, Risk.EGRESS}) {
            assertThat(Restart.SAFE.forCall(risk, ToolDecl.Host.DESKD)).as("%s", risk).isEqualTo(Restart.RETRY_BY_KEY);
            assertThat(Restart.SAFE.forCall(risk, ToolDecl.Host.DESK_AGENT)).as("%s", risk)
                    .isEqualTo(Restart.INTERRUPT);
        }
        assertThat(Restart.RETRY_BY_KEY.forCall(Risk.READ, ToolDecl.Host.DESKD)).isEqualTo(Restart.RETRY_BY_KEY);
        assertThat(Restart.INTERRUPT.forCall(Risk.SEND, ToolDecl.Host.DESK_AGENT)).isEqualTo(Restart.INTERRUPT);
        assertThat(Restart.defaultFor(ToolDecl.Host.DESKD)).isEqualTo(Restart.RETRY_BY_KEY);
        assertThat(Restart.defaultFor(ToolDecl.Host.DESK_AGENT)).isEqualTo(Restart.INTERRUPT);
        assertThat(Restart.RETRY_BY_KEY.wireName()).isEqualTo("retry_by_key");
    }

    @Test
    void anInterruptedResultSaysSoAndCarriesOneWord() {
        ToolResult lost = AgentTools.interrupted(new ToolCall("c1", "files_write", java.util.Map.of()), "lost");
        assertThat(lost.error()).isTrue();
        assertThat(lost.content()).startsWith("Interrupted: lost. It may or may not have happened");
        assertThat(Restart.interrupted(lost)).isTrue();
        assertThat(Restart.word(lost)).isEqualTo("lost");
        assertThat(Restart.interrupted(new ToolResult("c1", "Interrupted: lost.", false))).as("not an error").isFalse();
        assertThat(Restart.interrupted(new ToolResult("c1", "Failed: unavailable.", true))).isFalse();
        assertThat(Restart.word(new ToolResult("c1", "Refused: changed.", true))).isEqualTo("changed");
        assertThat(Restart.word(new ToolResult("c1", "It broke.", true))).isEqualTo("failed");
    }

    @Test
    void aCallWithNoAnswerIsUnansweredAndOneNeverSentIsNot() {
        assertThat(AgentTools.unanswered(DeskLink.Reply.noAnswer())).isTrue();
        assertThat(AgentTools.unanswered(DeskLink.Reply.unavailable())).isFalse();
        assertThat(AgentTools.unanswered(new DeskLink.Reply(false, null, "unavailable", "stopping", null))).isTrue();
        assertThat(AgentTools.unanswered(new DeskLink.Reply(false, null, "unavailable", "files", null))).isFalse();
    }
}
