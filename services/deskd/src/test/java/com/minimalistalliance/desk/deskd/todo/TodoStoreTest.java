package com.minimalistalliance.desk.deskd.todo;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.deskd.testing.MutableClock;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** To-do's store (API.md §22; the To-do VISION's Part 2 §1 and §2), on a real SQLite file. */
@SuppressWarnings("unchecked")
class TodoStoreTest {

    /** 10:00 in the morning in Denver, Nov 13. */
    private static final Instant START = Instant.parse("2026-11-13T17:00:00Z");
    private static final ZoneId DENVER = ZoneId.of("America/Denver");

    @TempDir
    Path dir;

    private final MutableClock clock = new MutableClock(START);
    private TodoStore store;
    private final List<TodoStore.Change> changes = new CopyOnWriteArrayList<>();

    @BeforeEach
    void open() throws Exception {
        store = TodoStore.open(dir.resolve(TodoStore.FILE), clock, () -> DENVER);
        store.onChange(changes::addAll);
    }

    @AfterEach
    void close() {
        store.close();
    }

    private TodoStore reopen() throws Exception {
        store.close();
        store = TodoStore.open(dir.resolve(TodoStore.FILE), clock, () -> DENVER);
        return store;
    }

    private static TodoStore.Idem idem(String method, Map<String, Object> params) {
        return new TodoStore.Idem(UUID.randomUUID().toString(), method, params);
    }

    private Map<String, Object> add(String title) throws Exception {
        return (Map<String, Object>) store.memberAdd(idem("todo.add", Map.of("title", title)), title, null, null, false)
                .get("item");
    }

    private Map<String, Object> addDue(String title, String date, String time) throws Exception {
        return (Map<String, Object>) store.memberAdd(idem("todo.add", Map.of("title", title)), title, null,
                new TodoStore.Due(date, time, "member"), false).get("item");
    }

    private static TodoStore.Source courier(String messageId, String channelId) {
        return new TodoStore.Source("courier", Map.of("messageId", messageId, "channelId", channelId),
                "Email from Dana Ortiz · Lease renewal", "courier:" + channelId);
    }

    private TodoStore.AddResult agentAdd(String agent, String run, String title, TodoStore.Source source) throws Exception {
        return store.agentAdd(new TodoStore.AgentAdd(agent, run, "ap-" + UUID.randomUUID(), title, null, null, source, true,
                null));
    }

    private List<Map<String, Object>> list(String view) throws Exception {
        return (List<Map<String, Object>>) store.list(new TodoStore.ListQuery(view, null, null, null, null, null, 100))
                .get("items");
    }

    // ---------------------------------------------------------------- the member's own

    @Test
    void aMembersToDoIsTheirsPlainTextAndDatedInTheirZone() throws Exception {
        Map<String, Object> item = addDue("Call the plumber‮​ about the leak\nnow", "2026-11-13", "16:30");
        assertThat(item).containsEntry("by", "member").containsEntry("state", "open").containsEntry("untrusted", false)
                .containsEntry("group", "today").containsEntry("seen", true);
        assertThat(item.get("title")).isEqualTo("Call the plumber about the leak now");
        assertThat((Map<String, Object>) item.get("due")).containsEntry("date", "2026-11-13").containsEntry("time", "16:30")
                .containsEntry("by", "member");
        assertThat((Map<String, Object>) item.get("source")).containsEntry("kind", "member").containsEntry("ref", null);
        // At 18:00 Denver time it's still today there, though it's tomorrow in UTC.
        clock.advance(Duration.ofHours(8));
        assertThat(list("open").get(0)).containsEntry("group", "today");
        assertThat(store.summary()).containsEntry("dueToday", 1L).containsEntry("today", "2026-11-13")
                .containsEntry("zone", "America/Denver");
        clock.advance(Duration.ofHours(8));
        assertThat(list("open").get(0)).containsEntry("group", "overdue");
        assertThat(store.summary()).containsEntry("overdue", 1L).containsEntry("badge", 1L);
    }

    @Test
    void anUpdateNamesTheRevItSawAndTheMembersEditEndsTheUntrustedMark() throws Exception {
        TodoStore.AddResult made = agentAdd("ag-1", "run-1", "Sign the lease", courier("01M1", "01C1"));
        Map<String, Object> item = (Map<String, Object>) store.get(made.id(), 5).get("item");
        assertThat(item).containsEntry("untrusted", true);
        long rev = ((Number) item.get("rev")).longValue();
        assertThatThrownBy(() -> store.memberUpdate(idem("todo.update", Map.of()), made.id(), rev - 1,
                Map.of("note", "x"))).isInstanceOfSatisfying(TodoStore.Refused.class, r -> {
                    assertThat(r.reason()).isEqualTo("rev");
                    assertThat(r.details()).containsEntry("rev", rev);
                });
        Map<String, Object> due = new LinkedHashMap<>(Map.of("date", "2026-11-20", "by", "member"));
        due.put("time", null);
        Map<String, Object> dated = (Map<String, Object>) store.memberUpdate(idem("todo.update", Map.of()), made.id(), rev,
                Map.of("due", due)).get("item");
        assertThat(dated).containsEntry("untrusted", true);
        Map<String, Object> edited = (Map<String, Object>) store.memberUpdate(idem("todo.update", Map.of()), made.id(),
                ((Number) dated.get("rev")).longValue(), Map.of("title", "Sign the lease renewal")).get("item");
        assertThat(edited).containsEntry("untrusted", false).containsEntry("title", "Sign the lease renewal");
    }

    @Test
    void aMutationIsAppliedOnceUnderItsIdemEvenAfterARestart() throws Exception {
        TodoStore.Idem key = new TodoStore.Idem("01JCIDEMKEY0000000000000001", "todo.add", Map.of("title", "Buy milk"));
        Map<String, Object> first = store.memberAdd(key, "Buy milk", null, null, false);
        reopen();
        Map<String, Object> again = store.memberAdd(key, "Buy milk", null, null, false);
        assertThat(TodoStore.canonical(again)).isEqualTo(TodoStore.canonical(first));
        assertThat(list("open")).hasSize(1);
        TodoStore.Idem other = new TodoStore.Idem("01JCIDEMKEY0000000000000001", "todo.add", Map.of("title", "Buy eggs"));
        assertThatThrownBy(() -> store.memberAdd(other, "Buy eggs", null, null, false))
                .isInstanceOfSatisfying(TodoStore.Refused.class, r -> assertThat(r.reason()).isEqualTo("idem"));
        // A queued close of an item already closed changes nothing.
        String id = (String) ((Map<String, Object>) first.get("item")).get("id");
        Map<String, Object> closed = (Map<String, Object>) store.memberClose(idem("todo.close", Map.of()), id, "done")
                .get("item");
        Map<String, Object> closedAgain = (Map<String, Object>) store.memberClose(idem("todo.close", Map.of()), id,
                "not_needed").get("item");
        assertThat(closedAgain).containsEntry("state", "done").containsEntry("rev", closed.get("rev"));
    }

    @Test
    void nothingIsLostAcrossARestart() throws Exception {
        List<String> ids = new ArrayList<>();
        for (int i = 0; i < 200; i++) {
            ids.add((String) add("Item " + i).get("id"));
        }
        for (int i = 0; i < 50; i++) {
            store.memberClose(idem("todo.close", Map.of()), ids.get(i), "done");
        }
        long rev = store.rev();
        reopen();
        assertThat(store.summary()).containsEntry("open", 150L);
        assertThat(store.list(new TodoStore.ListQuery("done", null, null, null, null, null, 100)).get("items"))
                .asList().hasSize(50);
        assertThat(store.rev()).isEqualTo(rev);
        assertThat((List<?>) store.get(ids.get(0), 50).get("events")).hasSize(2);
    }

    // ---------------------------------------------------------------- Needs you

    @Test
    void needsYouIsDatesAndPinsInCodesOrderFiveAtMostWithItsFooter() throws Exception {
        addDue("Due next week", "2026-11-20", null);
        String pinned = (String) add("Kept here").get("id");
        store.memberPin(idem("todo.pin", Map.of()), pinned, true);
        addDue("Today, no time", "2026-11-13", null);
        addDue("Today at 9", "2026-11-13", "09:00");
        addDue("Overdue two days", "2026-11-11", null);
        addDue("Overdue one day", "2026-11-12", null);
        String snoozed = (String) addDue("Overdue but snoozed", "2026-11-10", null).get("id");
        store.memberSnooze(idem("todo.snooze", Map.of()), snoozed, START.plus(Duration.ofHours(3)).toEpochMilli());
        addDue("Today at 8", "2026-11-13", "08:00");
        agentAdd("ag-1", "run-1", "From an agent, unseen", courier("01M2", "01C2"));
        store.agentSuggest("ag-1", "run-2", pinned, "done", "Looks handled", true);
        Map<String, Object> needs = store.list(new TodoStore.ListQuery("needs_you", null, null, null, null, null, 50));
        List<String> titles = ((List<Map<String, Object>>) needs.get("items")).stream()
                .map(i -> (String) i.get("title")).toList();
        assertThat(titles).containsExactly("Overdue two days", "Overdue one day", "Today at 8", "Today at 9",
                "Today, no time");
        assertThat(needs).containsEntry("more", 1);
        assertThat((Map<String, Object>) needs.get("footer")).containsEntry("newFromAgents", 1L).containsEntry("toConfirm", 1L);
        // The snoozed one comes back when its time comes.
        clock.advance(Duration.ofHours(4));
        assertThat(((List<Map<String, Object>>) store.list(new TodoStore.ListQuery("needs_you", null, null, null, null,
                null, 50)).get("items")).get(0)).containsEntry("title", "Overdue but snoozed");
        // An agent's date that isn't today can't bring an item in; the open view groups by deskd's own day.
        assertThat(list("open").stream().map(i -> (String) i.get("group")).toList())
                .startsWith("overdue", "overdue", "overdue", "today").contains("upcoming", "no_date");
    }

    // ---------------------------------------------------------------- dedupe and merges

    @Test
    void theSameMessageAndToDoAgainIsNeverASecondRowInAnyStateForThirtyDays() throws Exception {
        TodoStore.AddResult first = agentAdd("ag-1", "run-1", "Sign and return the lease renewal", courier("01M1", "01C1"));
        assertThat(first.created()).isTrue();
        // Again, in other words that normalise the same; then from another agent; then after the member dismissed it.
        assertThat(agentAdd("ag-1", "run-2", "Sign and return the LEASE renewal!", courier("01M1", "01C1")).created())
                .isFalse();
        assertThat(agentAdd("ag-2", "run-3", "Please sign and return the lease renewal", courier("01M1", "01C1")).id())
                .isEqualTo(first.id());
        store.memberClose(idem("todo.close", Map.of()), first.id(), "not_needed");
        assertThat(agentAdd("ag-1", "run-4", "Sign and return the lease renewal", courier("01M1", "01C1")).created())
                .isFalse();
        // A second task in the same message is its own row.
        assertThat(agentAdd("ag-1", "run-4", "Pay the security deposit", courier("01M1", "01C1")).created()).isTrue();
        // Past 30 days the same words from the same source are a new to-do (a monthly page, say).
        clock.advance(Duration.ofDays(31));
        assertThat(agentAdd("ag-1", "run-5", "Sign and return the lease renewal", courier("01M1", "01C1")).created())
                .isTrue();
    }

    @Test
    void aReminderInTheSameThreadIsMergedAndTheLaterAgentDateWinsButNeverOverTheMembers() throws Exception {
        TodoStore.AddResult first = store.agentAdd(new TodoStore.AgentAdd("ag-1", "run-1", "ap-a", "Sign the lease renewal",
                null, new TodoStore.Due("2026-11-14", null, null), courier("01M1", "01C1"), true, null));
        TodoStore.AddResult reminder = store.agentAdd(new TodoStore.AgentAdd("ag-1", "run-2", "ap-b",
                "Reminder: sign the lease renewal", null, new TodoStore.Due("2026-11-17", null, null),
                courier("01M2", "01C1"), true, null));
        assertThat(reminder.merged()).isTrue();
        assertThat(reminder.id()).isEqualTo(first.id());
        Map<String, Object> item = (Map<String, Object>) store.get(first.id(), 10).get("item");
        assertThat(item).containsEntry("mergeCount", 1L);
        assertThat((Map<String, Object>) item.get("due")).containsEntry("date", "2026-11-17");
        assertThat((List<Map<String, Object>>) item.get("alsoFrom")).hasSize(1).first()
                .satisfies(s -> assertThat((Map<String, Object>) s.get("ref")).containsEntry("messageId", "01M2"));
        // The member sets the date: a later reminder doesn't move it.
        Map<String, Object> due = new LinkedHashMap<>(Map.of("date", "2026-11-15", "by", "member"));
        due.put("time", null);
        store.memberUpdate(idem("todo.update", Map.of()), first.id(), ((Number) item.get("rev")).longValue(),
                Map.of("due", due));
        store.agentAdd(new TodoStore.AgentAdd("ag-1", "run-3", "ap-c", "Sign the lease renewal", null,
                new TodoStore.Due("2026-11-30", null, null), courier("01M3", "01C1"), true, null));
        assertThat((Map<String, Object>) ((Map<String, Object>) store.get(first.id(), 1).get("item")).get("due"))
                .containsEntry("date", "2026-11-15").containsEntry("by", "member");
        // A different task in the same thread isn't merged; nor is a near title with another number.
        assertThat(agentAdd("ag-1", "run-4", "Pay invoice 1044", courier("01M4", "01C1")).created()).isTrue();
        assertThat(agentAdd("ag-1", "run-4", "Pay invoice 1043", courier("01M5", "01C1")).created()).isTrue();
        // The merge's undo takes its source out again.
        String mergeEvent = ((List<Map<String, Object>>) store.get(first.id(), 50).get("events")).stream()
                .filter(e -> "merge".equals(e.get("op"))).findFirst().orElseThrow().get("id").toString();
        Map<String, Object> undone = (Map<String, Object>) store.memberUndo(idem("todo.undo", Map.of()), mergeEvent)
                .get("item");
        assertThat((List<?>) undone.get("alsoFrom")).hasSize(1);
    }

    @Test
    void somethingClosedInTheLastThirtyDaysIsntAddedAgainUnlessItsDateMoved() throws Exception {
        TodoStore.AddResult first = store.agentAdd(new TodoStore.AgentAdd("ag-1", "run-1", "ap-a", "Pay the water bill",
                null, new TodoStore.Due("2026-11-20", null, null), courier("01M1", "01C9"), true, null));
        store.memberClose(idem("todo.close", Map.of()), first.id(), "done");
        assertThat(store.agentAdd(new TodoStore.AgentAdd("ag-1", "run-2", "ap-b", "Pay the water bill", null,
                new TodoStore.Due("2026-11-20", null, null), courier("01M2", "01C9"), true, null)).created()).isFalse();
        assertThat(store.agentAdd(new TodoStore.AgentAdd("ag-1", "run-3", "ap-c", "Pay the water bill", null,
                new TodoStore.Due("2026-12-20", null, null), courier("01M3", "01C9"), true, null)).created()).isTrue();
    }

    @Test
    void theAgentCanSayItsTheSameTaskAsAnOpenItem() throws Exception {
        TodoStore.AddResult first = agentAdd("ag-1", "run-1", "Choose your 2027 benefit plans", courier("01M1", "01C1"));
        TodoStore.AddResult same = store.agentAdd(new TodoStore.AgentAdd("ag-1", "run-2", "ap-x",
                "Complete open enrollment by Nov 25", null, null, courier("01M7", "01C7"), true, first.id()));
        assertThat(same.merged()).isTrue();
        assertThat(same.id()).isEqualTo(first.id());
        store.memberClose(idem("todo.close", Map.of()), first.id(), "done");
        assertThatThrownBy(() -> store.agentAdd(new TodoStore.AgentAdd("ag-1", "run-3", "ap-y", "Something else", null,
                null, courier("01M8", "01C8"), true, first.id())))
                .isInstanceOfSatisfying(TodoStore.Refused.class, r -> assertThat(r.reason()).isEqualTo("closed"));
    }

    @Test
    void anAgentNamedMergeAfterUntrustedContentNeverMovesTheDateAndMergesCountTowardTheRunsCap() throws Exception {
        TodoStore.AddResult bill = store.agentAdd(new TodoStore.AgentAdd("ag-1", "run-1", "ap-1", "Pay City Water $84",
                null, new TodoStore.Due("2026-11-20", null, null), courier("01W1", "01CW"), false, null));
        for (int i = 0; i < TodoStore.ADDS_PER_RUN; i++) {
            try {
                store.agentAdd(new TodoStore.AgentAdd("ag-1", "run-evil", "ap-e" + i, "Totally unrelated " + i, null,
                        new TodoStore.Due("2027-12-01", null, null), courier("01E" + i, "01CE"), true, bill.id()));
            } catch (TodoStore.Refused r) {
                throw new AssertionError("merge " + i + " " + r.reason());
            }
        }
        Map<String, Object> item = (Map<String, Object>) store.get(bill.id(), 1).get("item");
        assertThat((Map<String, Object>) item.get("due")).containsEntry("date", "2026-11-20");
        assertThat(item).containsEntry("mergeCount", 10L).containsEntry("untrusted", true);
        assertThatThrownBy(() -> store.agentAdd(new TodoStore.AgentAdd("ag-1", "run-evil", "ap-e11", "One more", null,
                null, courier("01E11", "01CE"), true, bill.id())))
                .isInstanceOfSatisfying(TodoStore.Refused.class, r -> assertThat(r.details()).containsEntry("which", "run"));
        // From a clean run, an agent-named merge may move an agent's date later, as a code merge may.
        store.agentAdd(new TodoStore.AgentAdd("ag-1", "run-clean", "ap-c", "Water bill", null,
                new TodoStore.Due("2026-11-25", null, null), courier("01W2", "01CW"), false, bill.id()));
        assertThat((Map<String, Object>) ((Map<String, Object>) store.get(bill.id(), 1).get("item")).get("due"))
                .containsEntry("date", "2026-11-25");
    }

    @Test
    void aMembersNoteAloneDoesntEndTheUntrustedMark() throws Exception {
        TodoStore.AddResult made = agentAdd("ag-1", "run-1", "Wire the deposit", courier("01M1", "01C1"));
        long rev = (Long) ((Map<String, Object>) store.get(made.id(), 1).get("item")).get("rev");
        Map<String, Object> noted = (Map<String, Object>) store.memberUpdate(idem("todo.update", Map.of()), made.id(), rev,
                Map.of("note", "Check with the bank")).get("item");
        assertThat(noted).containsEntry("untrusted", true);
        Map<String, Object> same = (Map<String, Object>) store.memberUpdate(idem("todo.update", Map.of()), made.id(),
                (Long) noted.get("rev"), Map.of("title", "Wire the deposit")).get("item");
        assertThat(same).containsEntry("untrusted", true);
        Map<String, Object> retitled = (Map<String, Object>) store.memberUpdate(idem("todo.update", Map.of()), made.id(),
                (Long) same.get("rev"), Map.of("title", "Call the bank about the deposit", "note", "Mine now")).get("item");
        assertThat(retitled).containsEntry("untrusted", false);
    }

    @Test
    void anAgentsCallIsDoneOnceUnderItsApprovalId() throws Exception {
        TodoStore.AgentAdd add = new TodoStore.AgentAdd("ag-1", "run-1", "ap-same", "Book the movers", null, null,
                courier("01M1", "01C1"), false, null);
        TodoStore.AddResult first = store.agentAdd(add);
        TodoStore.AddResult again = store.agentAdd(add);
        assertThat(first.created()).isTrue();
        assertThat(again.id()).isEqualTo(first.id());
        assertThat(again.created()).isFalse();
        assertThat(list("open")).hasSize(1);
    }

    /**
     * Auto-approve's Read 6: an undo by approval id always names the agent, and takes back only that agent's events under
     * the key. Two agents' changes under one key (which a wrong desk-agent could try) stay apart; there's no form without
     * the agent, here or in the tool host.
     */
    @Test
    void anUndoByApprovalIdTakesBackOnlyTheNamedAgentsEvents() throws Exception {
        String key = "auto:ap-sharedsharedsharedsh";
        TodoStore.AddResult mine = store.agentAdd(new TodoStore.AgentAdd("ag-1", "run-1", key, "Book the movers", null, null,
                courier("01M1", "01C1"), false, null));
        String members = (String) add("Pay the water bill").get("id");
        store.agentClose("ag-2", "run-2", key, members, "done");
        assertThat((Map<String, Object>) store.get(members, 5).get("item")).containsEntry("state", "done");

        // Another agent, or none of them: nothing is taken back.
        assertThat(store.undoByApproval(key, "agent:ag-3")).isNull();
        assertThat((Map<String, Object>) store.get(mine.id(), 5).get("item")).containsEntry("state", "open");
        // ag-2's close only: the member's item reopens, and ag-1's add stays open (not closed as not needed).
        assertThat((Map<String, Object>) store.undoByApproval(key, "agent:ag-2").get("item")).containsEntry("id", members)
                .containsEntry("state", "open");
        assertThat((Map<String, Object>) store.get(mine.id(), 5).get("item")).containsEntry("state", "open");
        // Then ag-1's add: closed as not needed, as an add's undo is.
        assertThat((Map<String, Object>) store.undoByApproval(key, "agent:ag-1").get("item")).containsEntry("id", mine.id())
                .containsEntry("state", "not_needed");
        // The agent is never optional.
        for (String actor : new String[] {null, "", "member", "agent:"}) {
            assertThatThrownBy(() -> store.undoByApproval(key, actor)).as(String.valueOf(actor))
                    .isInstanceOf(IllegalArgumentException.class);
        }
        assertThat(java.util.Arrays.stream(TodoStore.class.getMethods())
                .filter(m -> m.getName().startsWith("undo") && m.getParameterCount() == 1)).isEmpty();
        assertThat(java.util.Arrays.stream(com.minimalistalliance.desk.deskd.tools.TodoTools.class.getMethods())
                .filter(m -> m.getName().equals("undo"))).isEmpty();
    }

    // ---------------------------------------------------------------- caps

    @Test
    void theCapsHoldPerRunPerAgentADayPerDeskADayAndForOpenItems() throws Exception {
        for (int i = 0; i < TodoStore.ADDS_PER_RUN; i++) {
            agentAdd("ag-1", "run-1", "Run task " + i + " " + (char) ('a' + i), courier("01R" + i, "01C" + i));
        }
        assertThatThrownBy(() -> agentAdd("ag-1", "run-1", "One more", courier("01RX", "01CX")))
                .isInstanceOfSatisfying(TodoStore.Refused.class, r -> assertThat(r.details()).containsEntry("which", "run"));
        for (int i = 0; i < TodoStore.ADDS_PER_AGENT_DAY - TodoStore.ADDS_PER_RUN; i++) {
            agentAdd("ag-1", "run-x" + i, "Day task " + i + " " + (char) ('a' + i), courier("01D" + i, "01E" + i));
        }
        assertThatThrownBy(() -> agentAdd("ag-1", "run-y", "One more today", courier("01DX", "01EX")))
                .isInstanceOfSatisfying(TodoStore.Refused.class,
                        r -> assertThat(r.details()).containsEntry("which", "agent_day"));
        // A dedupe hit at the cap isn't refused: it adds nothing.
        assertThat(agentAdd("ag-1", "run-y", "Run task 0 a", courier("01R0", "01C0")).created()).isFalse();
        for (int a = 2; a <= 4; a++) {
            for (int i = 0; i < 30 && store.capFor("ag-" + a, "r") == null; i++) {
                if (a == 4 && i >= 10) {
                    break;
                }
                agentAdd("ag-" + a, "run-" + a + "-" + i, "Agent " + a + " task " + i + " " + (char) ('a' + i),
                        courier("01A" + a + "x" + i, "01B" + a + "x" + i));
            }
        }
        assertThat(store.capFor("ag-5", "run-z")).isEqualTo("desk_day");
        // The next day, the day's caps start again.
        clock.advance(Duration.ofDays(1));
        assertThat(store.capFor("ag-1", "run-new")).isNull();
        assertThat(agentAdd("ag-1", "run-new", "Tomorrow's task", courier("01T1", "01T1")).created()).isTrue();
    }

    @Test
    void twoThousandOpenIsTheDesksCap() throws Exception {
        store.db().transaction(c -> {
            for (int i = 0; i < TodoStore.OPEN_PER_DESK; i++) {
                TodoSql.update(c, """
                        INSERT INTO items (id, rev, title, title_words, state, by, source_kind, source_label, dedupe_key,
                          created_at, updated_at) VALUES (?, 0, 't', 't', 'open', 'member', 'member', '', ?, 0, 0)""",
                        "00000000-0000-7000-8000-" + String.format("%012d", i), "k" + i);
            }
            return null;
        });
        assertThatThrownBy(() -> add("One too many"))
                .isInstanceOfSatisfying(TodoStore.Refused.class, r -> assertThat(r.details()).containsEntry("which", "open"));
    }

    @Test
    void suggestionsAreOneAnItemAndTwentyAnAgentADay() throws Exception {
        String id = (String) add("Pay the gas bill").get("id");
        store.agentSuggest("ag-1", "run-1", id, "done", "Receipt from the gas company", true);
        store.agentSuggest("ag-2", "run-2", id, "not_needed", "Paid by autopay", true);
        Map<String, Object> item = (Map<String, Object>) store.get(id, 1).get("item");
        // The reason is the model's words from a run that read untrusted content: the item is marked (Security's TD-M1).
        assertThat((Map<String, Object>) item.get("suggestion")).containsEntry("by", "agent:ag-2").containsEntry("untrusted",
                true);
        assertThat(item).containsEntry("state", "open").containsEntry("untrusted", true);
        for (int i = 2; i < TodoStore.SUGGESTIONS_PER_AGENT_DAY + 1; i++) {
            store.agentSuggest("ag-1", "run-1", id, "done", "again " + i, true);
        }
        assertThatThrownBy(() -> store.agentSuggest("ag-1", "run-1", id, "done", "once more", true))
                .isInstanceOfSatisfying(TodoStore.Refused.class,
                        r -> assertThat(r.details()).containsEntry("which", "suggest_day"));
        assertThatThrownBy(() -> store.memberAnswer(idem("todo.answer", Map.of()), (String) add("x").get("id"), true))
                .isInstanceOfSatisfying(TodoStore.Refused.class, r -> assertThat(r.reason()).isEqualTo("no_suggestion"));
    }

    // ---------------------------------------------------------------- undo, trash, the tidy, changes

    @Test
    void trashRestoreAndTheTidysRetention() throws Exception {
        String trashed = (String) add("Old idea").get("id");
        String closed = (String) add("Done long ago").get("id");
        String kept = (String) add("Still open").get("id");
        store.memberTrash(idem("todo.trash", Map.of()), trashed);
        assertThat(list("trash")).hasSize(1);
        assertThatThrownBy(() -> store.memberSnooze(idem("todo.snooze", Map.of()), trashed, null))
                .isInstanceOfSatisfying(TodoStore.Refused.class, r -> assertThat(r.reason()).isEqualTo("trashed"));
        store.memberRestore(idem("todo.restore", Map.of()), trashed);
        store.memberTrash(idem("todo.trash", Map.of()), trashed);
        store.memberClose(idem("todo.close", Map.of()), closed, "done");
        clock.advance(Duration.ofDays(31));
        assertThat(store.tidy()).isEqualTo(1);
        assertThat(store.get(trashed, 1)).isNull();
        clock.advance(Duration.ofDays(335));
        assertThat(store.tidy()).isEqualTo(1);
        assertThat(store.get(closed, 1)).isNull();
        assertThat(store.get(kept, 1)).isNotNull();
        assertThat(changes).extracting(TodoStore.Change::op).contains("remove");
    }

    @Test
    void theChangeLogPagesAndSaysResetWhenItCantServe() throws Exception {
        long start = store.rev();
        String id = (String) add("A").get("id");
        store.memberPin(idem("todo.pin", Map.of()), id, true);
        Map<String, Object> since = store.changes(start);
        assertThat((List<Map<String, Object>>) since.get("changes")).extracting(m -> m.get("op"))
                .containsExactly("add", "pin");
        assertThat(since).containsEntry("reset", false);
        assertThat(changes).extracting(TodoStore.Change::id).containsOnly(id);
        clock.advance(Duration.ofDays(31));
        store.tidy();
        assertThat(store.changes(start)).containsEntry("reset", true);
    }

    @Test
    void theMarkdownExportIsAChecklistOfPlainText() throws Exception {
        add("Read [this](https://evil.example) <b>now</b>");
        String id = (String) addDue("# Not a heading", "2026-11-20", "09:30").get("id");
        store.memberClose(idem("todo.close", Map.of()), id, "done");
        String md = new String(TodoExport.render(store, "md", clock), StandardCharsets.UTF_8);
        assertThat(md).startsWith("# To-do\n\n## Open\n\n- [ ] Read \\[this\\]\\(https://evil\\.example\\) \\<b\\>now\\</b\\>")
                .contains("## Done\n\n- [x] \\# Not a heading (due 2026-11-20 09:30)");
        String json = new String(TodoExport.render(store, "json", clock), StandardCharsets.UTF_8);
        assertThat(json).contains("\"app\":\"todo\"").contains("\"events\"");
    }

    @Test
    void searchFindsEveryWordByPrefix() throws Exception {
        add("Renew the passport");
        add("Renew the car insurance");
        Map<String, Object> hits = store.list(new TodoStore.ListQuery("open", null, null, "ren insur", null, null, 50));
        assertThat((List<Map<String, Object>>) hits.get("items")).extracting(m -> m.get("title"))
                .containsExactly("Renew the car insurance");
    }

    @Test
    void concurrentMemberAddsAllLand() throws Exception {
        int n = 40;
        CountDownLatch go = new CountDownLatch(1);
        List<Thread> threads = new ArrayList<>();
        for (int i = 0; i < n; i++) {
            int k = i;
            threads.add(Thread.ofVirtual().start(() -> {
                try {
                    go.await();
                    add("Concurrent " + k);
                } catch (Exception e) {
                    throw new AssertionError(e);
                }
            }));
        }
        go.countDown();
        for (Thread t : threads) {
            t.join();
        }
        assertThat(list("open")).hasSize(n);
    }
}
