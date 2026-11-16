package com.minimalistalliance.desk.agent.maia.eval;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.agent.maia.MaiaMode;
import com.minimalistalliance.desk.agent.provider.ToolCall;
import com.minimalistalliance.desk.agent.service.Caller;
import com.minimalistalliance.desk.agent.tool.Risk;
import com.minimalistalliance.desk.agent.tool.RunContext;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The stand-in Security read's fixes (DMA-L1, DMA-L2, DMA-I2, DMA-I4) and the Platform read's condition MMP-L1, on
 * Maia Mode's own classes over a real {@code agent.db}.
 */
class MaiaSecurityFixesTest {

    @TempDir
    Path data;

    private Standalone s;

    @BeforeEach
    void open() throws Exception {
        s = new Standalone(data);
    }

    @AfterEach
    void close() {
        s.close();
    }

    private RunContext run(String runId, String replyId) {
        return RunContext.of(runId, "maia", Caller.OWNER, Map.of("kind", "member"), replyId);
    }

    /** MMP-L1: a desk not listed (no switch saying on) refuses Desk Maia; the kill switch still wins over on. */
    @Test
    void aDeskNotListedRefusesDeskMaia() throws Exception {
        assertThat(s.mode.listed()).isFalse();
        try {
            s.call("agent.maia.set", "on", true, "disclosure", MaiaMode.DISCLOSURE);
            throw new AssertionError("not refused");
        } catch (com.minimalistalliance.desk.agent.service.RpcError e) {
            assertThat(e.details()).containsEntry("reason", "not_listed");
        }
        s.on();
        assertThat(s.mode.active()).isTrue();
        Files.delete(data.resolve(MaiaMode.SWITCH_FILE));
        assertThat(s.mode.active()).isFalse();
        Files.writeString(data.resolve(MaiaMode.SWITCH_FILE), "off\n");
        assertThat(s.mode.killed()).isTrue();
        assertThat(s.mode.listed()).isFalse();
        // Anything but a plain file saying on or off is off (DMA-I4).
        Files.delete(data.resolve(MaiaMode.SWITCH_FILE));
        Files.createSymbolicLink(data.resolve(MaiaMode.SWITCH_FILE), data.resolve("elsewhere"));
        assertThat(s.mode.killed()).isTrue();
    }

    /** DMA-L1: a private answer taken in her run's wait is kept on her reply, so a later run still asks. */
    @Test
    void keepsToItselfOutlivesTheRunThatReadTheAnswer() throws Exception {
        s.on();
        s.grant(EvalDesk.WORK, "Work", true, "brief");
        s.grant(EvalDesk.PERSONAL, "Personal", false, "brief");
        RunContext first = run("r-1", "m-1");
        s.profile.answeredInRun("r-1", EvalDesk.WORK, true);
        s.mode.originOnReply("m-1", EvalDesk.WORK);
        s.profile.runEnded("r-1");
        RunContext later = run("r-2", "m-2");
        assertThat(s.profile.floor(later, "desk_message", Map.of("desk", EvalDesk.PERSONAL, "text", "x")))
                .isEqualTo(Risk.SEND);
        assertThat(s.profile.flags(later)).contains("D:" + EvalDesk.WORK);
        // Briefing Work itself stays within the desk.
        assertThat(s.profile.floor(later, "desk_message", Map.of("desk", EvalDesk.WORK, "text", "x")))
                .isEqualTo(Risk.READ);
        assertThat(first.runId()).isEqualTo("r-1");
    }

    /** DMA-L2: off, the to-do runs read nothing, and the member can still take the switch away. */
    @Test
    void offStopsToDoRunsAndTheirSwitchCanStillBeTakenAway() throws Exception {
        s.on();
        s.todos().set(Map.of("agentId", "ag-inbox", "on", true));
        s.call("agent.maia.set", "on", false);
        int before = s.calls.tools.size();
        s.todos().runAll();
        assertThat(s.calls.tools.size()).isEqualTo(before);
        s.mode.todos(s.todos());
        Map<String, Object> off = s.call("agent.maia.todos.set", "agentId", "ag-inbox", "on", false);
        assertThat(off.toString()).contains("on=false");
    }

    /** DMA-I2: "show" or "open" in passing isn't an ask to see, and a tap never is. */
    @Test
    void anAskToSeeIsTheMembersOwnWords() {
        for (String said : List.of("show me the lease", "Let me see it", "open the notes page", "pull it up")) {
            assertThat(com.minimalistalliance.desk.agent.maia.MaiaProfileAccess.asks(said)).as(said).isTrue();
        }
        for (String said : List.of("is the store open today?", "the show was great", "where is my order")) {
            assertThat(com.minimalistalliance.desk.agent.maia.MaiaProfileAccess.asks(said)).as(said).isFalse();
        }
    }

    /** The 90-day line: her replies' extras older than it go, with their desk origins. */
    @Test
    void herOldRepliesExtrasGoAtNinetyDays() throws Exception {
        s.on();
        s.mode.originOnReply("m-old", EvalDesk.WORK);
        s.clock.advance(java.time.Duration.ofDays(91));
        s.mode.upkeep();
        assertThat(s.mode.store().extrasOf("m-old")).isNull();
        ToolCall unused = new ToolCall("c", "x", Map.of());
        assertThat(unused.name()).isEqualTo("x");
    }
}
