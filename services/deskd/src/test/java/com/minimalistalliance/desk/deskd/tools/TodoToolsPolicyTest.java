package com.minimalistalliance.desk.deskd.tools;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.deskd.rpc.Caller;
import com.minimalistalliance.desk.deskd.todo.TodoStore;
import com.minimalistalliance.desk.deskd.tools.TodoTools.Outcome;
import java.time.Clock;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** To-do's per-call policy (API.md §22's table) and the provenance deskd records from hosted results. */
class TodoToolsPolicyTest {

    @Test
    void anAddIsUnaskedButAfterUntrustedContentOnlyWithAThirdPartysSource() {
        for (String kind : List.of("courier", "notebook", "browser", "files", "agent_chat")) {
            assertThat(TodoTools.addOutcome(false, kind)).as(kind).isEqualTo(Outcome.AUTO);
        }
        // Security's ATA-L1, and TD-L1: a file, a page or the member's own message would lend a planted title their trust.
        assertThat(TodoTools.addOutcome(true, "courier")).isEqualTo(Outcome.AUTO);
        assertThat(TodoTools.addOutcome(true, "browser")).isEqualTo(Outcome.AUTO);
        assertThat(TodoTools.addOutcome(true, "files")).isEqualTo(Outcome.ASK);
        assertThat(TodoTools.addOutcome(true, "notebook")).isEqualTo(Outcome.ASK);
        assertThat(TodoTools.addOutcome(true, "agent_chat")).isEqualTo(Outcome.ASK);
        // A message from another of the member's desks is untrusted content here, as in its run (§14).
        assertThat(TodoTools.addOutcome(false, "desk")).isEqualTo(Outcome.AUTO);
        assertThat(TodoTools.addOutcome(true, "desk")).isEqualTo(Outcome.AUTO);
    }

    /** {@code desk}'s {@code {}} names the last message from another desk deskd gave this run; nothing else does. */
    @Test
    void aDeskSourceIsOnlyOneDeskdGaveThisRun() throws Exception {
        RunLedger ledger = new RunLedger(Clock.systemUTC(), id -> {});
        RunLedger.Run run = ledger.join("run-1", "ag-1", Caller.THE_OWNER, List.of("U"));
        assertThat(refusalOf("desk", Map.of(), run)).isEqualTo("source_unknown");
        Map<String, Object> first = Map.of("deskId", "d-aaaa", "messageId", "env-aaaaaaaaaaaaaaaaaaaaaaaaaa");
        Map<String, Object> last = Map.of("deskId", "d-aaaa", "messageId", "env-bbbbbbbbbbbbbbbbbbbbbbbbbb");
        run.gave(Provenance.key("desk", first), "desk", first, "Message from Lead on another of your desks", "desk:d-aaaa");
        run.gave(Provenance.key("desk", last), "desk", last, "Answer from Lead on another of your desks", "desk:d-aaaa");
        TodoStore.Source empty = TodoTools.source("desk", Map.of(), run);
        assertThat(empty.ref()).isEqualTo(last);
        assertThat(empty.label()).isEqualTo("Answer from Lead on another of your desks");
        assertThat(TodoTools.source("desk", Map.of("messageId", "env-aaaaaaaaaaaaaaaaaaaaaaaaaa"), run).ref())
                .isEqualTo(first);
        assertThat(refusalOf("desk", Map.of("messageId", "env-cccccccccccccccccccccccccc"), run))
                .isEqualTo("source_unknown");
        // Another run was given none.
        assertThat(refusalOf("desk", Map.of(), ledger.join("run-2", "ag-1", Caller.THE_OWNER, List.of())))
                .isEqualTo("source_unknown");
    }

    private static String refusalOf(String kind, Map<String, Object> ref, RunLedger.Run run) {
        try {
            TodoTools.source(kind, ref, run);
            return null;
        } catch (Exception e) {
            return e.getMessage();
        }
    }

    @Test
    void anUpdateIsUnaskedOnlyForItsOwnInACleanRunAndAnyoneElsesAlwaysAsks() {
        // (untrusted, attended, own)
        assertThat(TodoTools.updateOutcome(false, false, true)).isEqualTo(Outcome.AUTO);
        assertThat(TodoTools.updateOutcome(false, true, true)).isEqualTo(Outcome.AUTO);
        assertThat(TodoTools.updateOutcome(true, true, true)).isEqualTo(Outcome.ASK);
        assertThat(TodoTools.updateOutcome(true, false, true)).isEqualTo(Outcome.ASK);
        // Security's TD-L2: the switch covers the agent's own to-dos only.
        assertThat(TodoTools.updateOutcome(false, true, false)).isEqualTo(Outcome.ASK);
        assertThat(TodoTools.updateOutcome(true, true, false)).isEqualTo(Outcome.ASK);
        assertThat(TodoTools.updateOutcome(false, false, false)).isEqualTo(Outcome.NOT_YOURS);
        assertThat(TodoTools.updateOutcome(true, false, false)).isEqualTo(Outcome.NOT_YOURS);
    }

    @Test
    void aCloseClosesOnlyItsOwnUnaskedAsksWhenTheMemberIsThereAndOtherwiseSuggests() {
        // (untrusted, attended, own, fromThisRun)
        assertThat(TodoTools.closeOutcome(false, false, true, true)).isEqualTo(Outcome.AUTO);
        assertThat(TodoTools.closeOutcome(false, true, true, false)).isEqualTo(Outcome.AUTO);
        assertThat(TodoTools.closeOutcome(false, false, true, false)).isEqualTo(Outcome.SUGGEST);
        assertThat(TodoTools.closeOutcome(false, false, false, false)).isEqualTo(Outcome.SUGGEST);
        // Anyone else's asks even when the member started a clean run (TD-L2).
        assertThat(TodoTools.closeOutcome(false, true, false, false)).isEqualTo(Outcome.ASK);
        assertThat(TodoTools.closeOutcome(true, true, true, true)).isEqualTo(Outcome.ASK);
        assertThat(TodoTools.closeOutcome(true, true, false, false)).isEqualTo(Outcome.ASK);
        // An injected "it's paid" in an unattended run never closes, not even what this run added.
        assertThat(TodoTools.closeOutcome(true, false, true, true)).isEqualTo(Outcome.SUGGEST);
        assertThat(TodoTools.closeOutcome(true, false, false, false)).isEqualTo(Outcome.SUGGEST);
    }

    @Test
    void theSourcesARunWasGivenAreKeyedByWhatIdentifiesThem() throws Exception {
        RunLedger ledger = new RunLedger(Clock.systemUTC(), id -> {});
        RunLedger.Run run = ledger.join("run-1", "ag-1", Caller.THE_OWNER, List.of());
        Provenance.record("browser_read", Map.of("url", "HTTPS://Example.com/a/b?x=1#frag", "title", "A‮ page"), run);
        Provenance.record("notebook_read", Map.of("pageId", "pg-1", "title", "Plans", "markdown", "..."), run);
        // A search hit or a listed page isn't read (Security's TD-L1).
        Provenance.record("notebook_search", Map.of("hits", List.of(Map.of("pageId", "pg-2", "title", "Other"))), run);
        Provenance.record("files_search", Map.of("hits", List.of(Map.of("path", "Other.pdf", "kind", "file"))), run);
        Provenance.record("files_read", Map.of("path", "/Bills/water.pdf/", "text", "..."), run);
        Provenance.record("courier_read", Map.of("messageId", "01M1", "channelId", "01C1", "medium", "email", "from",
                Map.of("contactId", "ct-1", "name", "Dana Ortiz"), "subject", "Lease renewal for 2027"), run);
        Provenance.record("courier_new", Map.of("messages", List.of(Map.of("messageId", "01M2", "channelId", "01C2"))), run);
        Provenance.record("browser_open", Map.of("url", "file:///etc/passwd", "title", "x"), run);

        RunLedger.Given page = run.given(Provenance.key("browser", Map.of("url", "https://example.com/a/b?x=1")));
        assertThat(page).isNotNull();
        assertThat(page.label()).isEqualTo("example.com · A‮ page");
        assertThat(page.threadKey()).isEqualTo("browser:example.com/a/b");
        assertThat(run.given(Provenance.key("notebook", Map.of("pageId", "pg-1"))).label()).isEqualTo("Notebook page · Plans");
        assertThat(run.given(Provenance.key("files", Map.of("path", "Bills/water.pdf"))).label()).isEqualTo("File · water.pdf");
        assertThat(run.given(Provenance.key("notebook", Map.of("pageId", "pg-2")))).isNull();
        assertThat(run.given(Provenance.key("files", Map.of("path", "Other.pdf")))).isNull();
        RunLedger.Given mail = run.given(Provenance.key("courier", Map.of("messageId", "01M1")));
        assertThat(mail.label()).isEqualTo("Email from Dana Ortiz · Lease renewal for 2027");
        assertThat(mail.ref()).containsEntry("channelId", "01C1");
        assertThat(mail.threadKey()).isEqualTo("courier:01C1");
        assertThat(run.given(Provenance.key("courier", Map.of("messageId", "01M2")))).isNotNull();
        // Never a file: URL, never a source another run read.
        assertThat(Provenance.key("browser", Map.of("url", "file:///etc/passwd"))).isNull();
        RunLedger.Run other = ledger.join("run-2", "ag-1", Caller.THE_OWNER, List.of());
        assertThat(other.given(Provenance.key("notebook", Map.of("pageId", "pg-1")))).isNull();
        // The member's message that started the run, by deskd's record of the relayed send.
        ledger.memberStarted("run-2", "ag-1", "msg-9");
        assertThat(other.attended()).isTrue();
        assertThat(other.startedBy()).isEqualTo("msg-9");
        assertThat(run.attended()).isFalse();
        ledger.memberStarted("run-3", "ag-other", "msg-1");
        assertThat(ledger.join("run-3", "ag-1", Caller.THE_OWNER, List.of()).attended()).as("another agent's run").isFalse();
    }
}
