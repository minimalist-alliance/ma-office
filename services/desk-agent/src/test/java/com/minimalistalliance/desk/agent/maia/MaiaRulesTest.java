package com.minimalistalliance.desk.agent.maia;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.agent.service.RpcError;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * Maia Mode's rules that are pure code: the choice weight and the shape of choices, the office's picture as the room
 * takes it, the note-taker's answer as code checks it, the to-do filer's checks, and what a show may name.
 */
class MaiaRulesTest {

    // ---------------------------------------------------------------- choices

    @Test
    void theWeightFallsWhenChoicesArePassedByAndAskingPutsItBack() {
        double w = Choices.START;
        assertThat(w).isEqualTo(0.8);
        w = Choices.next(w, "ignored");
        w = Choices.next(w, "other");
        assertThat(w).isLessThan(Choices.THRESHOLD + 0.2);
        for (int i = 0; i < 20; i++) {
            w = Choices.next(w, "ignored");
        }
        assertThat(w).isEqualTo(0.0);
        assertThat(Choices.next(w, "askedMore")).isEqualTo(0.8);
        assertThat(Choices.next(0.95, "askedMore")).isEqualTo(0.95);
        assertThat(Choices.next(0.9, "askedFewer")).isEqualTo(0.3);
        assertThat(Choices.next(0.2, "askedFewer")).isEqualTo(0.2);
        double up = 0.5;
        for (int i = 0; i < 20; i++) {
            up = Choices.next(up, "tapped");
        }
        assertThat(up).isEqualTo(1.0);
    }

    @Test
    void asksForMoreOrFewerChoicesAreReadInCode() {
        assertThat(Choices.ask("give me options")).isEqualTo(Choices.Ask.MORE);
        assertThat(Choices.ask("Multiple choice please")).isEqualTo(Choices.Ask.MORE);
        assertThat(Choices.ask("can you show me some choices?")).isEqualTo(Choices.Ask.MORE);
        assertThat(Choices.ask("no more multiple choice, just ask me")).isEqualTo(Choices.Ask.FEWER);
        assertThat(Choices.ask("stop giving me options")).isEqualTo(Choices.Ask.FEWER);
        assertThat(Choices.ask("Book the 3pm option for the dentist")).isEqualTo(Choices.Ask.NONE);
        assertThat(Choices.ask("")).isEqualTo(Choices.Ask.NONE);
    }

    @Test
    void choicesAreTwoToFourShortPlainAnswers() {
        String[] why = new String[1];
        Map<String, Object> ok = Choices.shape("Which?", List.of("Yes", "No", "Later"), why);
        assertThat(ok).containsEntry("recommended", "c1").containsEntry("state", "open").containsEntry("other", true);
        assertThat(Choices.shape("Which?", List.of("Only one"), why)).isNull();
        assertThat(why[0]).isEqualTo("options");
        assertThat(Choices.shape("Which?", List.of("a", "b", "c", "d", "e"), why)).isNull();
        assertThat(Choices.shape("Which?", List.of("Yes", "yes"), why)).isNull();
        assertThat(Choices.shape("Which?", List.of("[click](https://x)", "No"), why)).isNull();
        assertThat(Choices.shape("Which?", List.of("See evil.com", "No"), why)).isNull();
        assertThat(Choices.shape("Which?", List.of("<b>Yes</b>", "No"), why)).isNull();
        assertThat(Choices.shape("Which?", List.of("**Yes**", "No"), why)).isNull();
        assertThat(Choices.shape("Which?", List.of("x".repeat(41), "No"), why)).isNull();
        assertThat(Choices.shape("", List.of("Yes", "No"), why)).isNull();
        assertThat(why[0]).isEqualTo("question");
        // Hidden characters go before the label is judged.
        Map<String, Object> cleaned = Choices.shape("Which?", List.of("Ye\u200Bs", "No"), why);
        assertThat(cleaned.toString()).doesNotContain("\u200B");
    }

    @Test
    void theRuleIsTheConceptsAndTheWeightIsALineOfItsOwn() {
        // The rule never changes, so it sits in her cached context; the weight moves with taps, so it's in her note.
        assertThat(Choices.RULE).contains("above 0.5").contains("always for a decision with clear options")
                .doesNotContainPattern("0\\.[0-46-9]");
        assertThat(Choices.weightLine(0.62)).isEqualTo("Your choice weight for this member is 0.62 (0 to 1).");
    }

    // ---------------------------------------------------------------- the office's picture

    @Test
    void theOfficesPictureIsCheckedAndBounded() throws Exception {
        List<Attention.Desk> desks = Room.parse(Map.of("desks", List.of(
                Map.of("deskId", "d-work1", "name", "Work\u202E", "kind", "work", "state", "nonsense", "link", "open",
                        "agents", List.of(Map.of("agentId", "ag-1", "name", "Scout", "status", "working",
                                "statusDetail", "weird", "approvalsPending", -5))),
                Map.of("deskId", "d-guild1", "name", "Guild", "guild", true))));
        assertThat(desks).singleElement().satisfies(d -> {
            assertThat(d.name()).isEqualTo("Work");
            assertThat(d.state()).isEqualTo("running");
            assertThat(d.agents().get(0).statusDetail()).isNull();
            assertThat(d.agents().get(0).approvalsPending()).isZero();
        });
        assertThatThrownBy(() -> Room.parse(Map.of("desks", List.of(Map.of("deskId", "https://x")))))
                .isInstanceOf(RpcError.class);
        assertThatThrownBy(() -> Room.parse(Map.of("desks", List.of(Map.of("deskId", "d-a"), Map.of("deskId",
                "d-a"))))).isInstanceOf(RpcError.class);
        List<Map<String, Object>> many = new java.util.ArrayList<>();
        for (int i = 0; i < 21; i++) {
            many.add(Map.of("deskId", "d-x" + i));
        }
        assertThatThrownBy(() -> Room.parse(Map.of("desks", many))).isInstanceOfSatisfying(RpcError.class,
                e -> assertThat(e.code()).isEqualTo("too_large"));
        assertThatThrownBy(() -> Room.parse(Map.of())).isInstanceOf(RpcError.class);
    }

    // ---------------------------------------------------------------- notes

    @Test
    void theTakersAnswerIsCheckedInCode() {
        String answer = "Here you go: {\"notes\": [" + "{\"text\": \"Prefers window seats\", \"area\": \"personal\","
                + " \"kind\": \"fact\"}, " + "{\"text\": \"My password is hunter2\", \"area\": \"work\"},"
                + " {\"text\": \"Card 4111 1111 1111 1111\", \"area\": \"work\"},"
                + " {\"text\": \"Q3 budget approved\", \"area\": \"weird\", \"kind\": \"odd\", \"due\": \"2026-11-20\"},"
                + " {\"text\": \"" + "x".repeat(300) + "\", \"area\": \"work\"},"
                + " {\"text\": \"a\", \"area\": \"work\"}, {\"text\": \"b\", \"area\": \"work\"},"
                + " {\"text\": \"c\", \"area\": \"work\"}, {\"text\": \"d\", \"area\": \"work\"}]}";
        List<Notes.Taken> notes = Notes.parse(answer, "2026-11-14");
        assertThat(notes).hasSize(Notes.MAX_NOTES);
        assertThat(notes).extracting(Notes.Taken::text).doesNotContain("My password is hunter2")
                .noneMatch(t -> t.contains("4111"));
        assertThat(notes.get(0)).isEqualTo(new Notes.Taken("Prefers window seats", "personal", "fact", null));
        assertThat(notes.get(1)).isEqualTo(new Notes.Taken("Q3 budget approved", "unsure", "fact", "2026-11-20"));
        assertThat(Notes.parse("not json", "2026-11-14")).isEmpty();
        assertThat(Notes.parse("{\"notes\": \"x\"}", "2026-11-14")).isEmpty();
    }

    @Test
    void aNoteIsOnePlainMarkdownLine() {
        assertThat(Notes.markdownSafe("# heading [link](x) **b** `c`\nnext")).isEqualTo(
                "\\# heading \\[link\\](x) \\*\\*b\\*\\* \\`c\\` next");
        assertThat(Notes.title("work", "2026-11-14")).isEqualTo("Work · Sat Nov 14");
        assertThat(Notes.title("personal", "2026-11-13")).isEqualTo("Personal · Fri Nov 13");
    }

    // ---------------------------------------------------------------- to-dos

    @Test
    void theFilersChecksTurnAwayWhatEmailCouldUse() {
        Set<String> batch = Set.of("m1");
        String today = "2026-11-14";
        assertThat(TodoFiler.check(new TodoFiler.Extracted("m1", "Sign the lease", "2026-11-20", 0.9), batch, today))
                .isNull();
        assertThat(TodoFiler.check(new TodoFiler.Extracted("m1", "Read report.pdf before Friday", null, 0.9), batch,
                today)).isNull();
        assertThat(TodoFiler.check(new TodoFiler.Extracted("m9", "Sign the lease", null, 0.9), batch, today))
                .isEqualTo("not_in_batch");
        assertThat(TodoFiler.check(new TodoFiler.Extracted("m1", "Sign the lease", null, 0.3), batch, today))
                .isEqualTo("unsure");
        for (String linky : List.of("Pay at https://evil.example", "Visit www.evil.com", "Go to evil.shop now",
                "Email boss@evil.co", "Open javascript:alert(1)", "See a.b.example.org")) {
            assertThat(TodoFiler.check(new TodoFiler.Extracted("m1", linky, null, 0.9), batch, today))
                    .as(linky).isEqualTo("link");
        }
        assertThat(TodoFiler.check(new TodoFiler.Extracted("m1", "**Pay** now", null, 0.9), batch, today))
                .isEqualTo("markdown");
        assertThat(TodoFiler.check(new TodoFiler.Extracted("m1", "x".repeat(121), null, 0.9), batch, today))
                .isEqualTo("length");
        assertThat(TodoFiler.check(new TodoFiler.Extracted("m1", "Pay\u202E now", null, 0.9), batch, today))
                .isEqualTo("hidden");
        assertThat(TodoFiler.check(new TodoFiler.Extracted("m1", "Pay", "2099-01-01", 0.9), batch, today))
                .isEqualTo("due");
        assertThat(TodoFiler.check(new TodoFiler.Extracted("m1", "Pay", "tomorrow", 0.9), batch, today))
                .isEqualTo("due");
    }

    @Test
    void theExtractorsAnswerIsReadForItsFieldsOnly() {
        List<TodoFiler.Extracted> got = TodoFiler.parse("{\"todos\": [{\"messageId\": \"m1\", \"action\": \"Pay\","
                + " \"confidence\": 0.9, \"send\": \"reply now\"}, {\"action\": \"no id\"}], \"tool\": \"send\"}");
        assertThat(got).containsExactly(new TodoFiler.Extracted("m1", "Pay", null, 0.9));
        assertThat(TodoFiler.parse("nothing")).isEmpty();
        // Bulk mail and what the member sent never reach the extractor.
        assertThat(TodoFiler.messages(Map.of("messages", List.of(Map.of("messageId", "a", "bulk", true),
                Map.of("messageId", "b", "direction", "outbound"), Map.of("messageId", "c")))))
                .extracting(m -> m.get("messageId")).containsExactly("c");
    }

    // ---------------------------------------------------------------- shows

    @Test
    void aShowNamesAnIdNeverAnAddress() {
        assertThat(MaiaProfile.refOk("pg-123")).isTrue();
        assertThat(MaiaProfile.refOk("Research/notes.md")).isTrue();
        assertThat(MaiaProfile.refOk("")).isTrue();
        for (String bad : List.of("https://evil.example", "http://x", "//evil", "javascript:alert(1)",
                "data:text/html,x", "www.evil.com", "a\nb", "x".repeat(201), "C:\\x")) {
            assertThat(MaiaProfile.refOk(bad)).as(bad).isFalse();
        }
        // Each app's own shape of id (DMA-I1).
        assertThat(MaiaProfile.refFits("notebook", "pg-123")).isTrue();
        assertThat(MaiaProfile.refFits("notebook", "evil.example/p?d=secret")).isFalse();
        assertThat(MaiaProfile.refFits("browser", "evil.example")).isFalse();
        assertThat(MaiaProfile.refFits("courier", "evil.xyz")).isFalse();
        assertThat(MaiaProfile.refFits("agent", "10.0.0.1")).isFalse();
        assertThat(MaiaProfile.refFits("files", "Research/notes.md")).isTrue();
        assertThat(MaiaProfile.refFits("files", "../etc/passwd")).isFalse();
        assertThat(MaiaProfile.refFits("files", "/abs")).isFalse();
        assertThat(MaiaProfile.refFits("todo", "needs_you")).isTrue();
        assertThat(MaiaProfile.refFits("todo", "anything")).isFalse();
        assertThat(MaiaProfile.refFits("approvals", "ap-abcdefghijklmnopqrst")).isTrue();
        assertThat(MaiaProfile.refFits("approvals", "ap-1")).isFalse();
        assertThat(MaiaProfile.refFits("agent", "")).isTrue();
        assertThat(MaiaTools.APPS).containsExactly("notebook", "files", "agent", "browser", "todo", "courier",
                "approvals", "documents");
    }

    @Test
    void herToolsAreDeclaredWithTheirClassesAndNoneActsForTheMember() {
        assertThat(MaiaTools.declarations()).extracting(d -> d.name() + ":" + d.risk().wireName())
                .containsExactlyInAnyOrder("office_desks:read", "office_desk_status:read", "office_show:own",
                        "ask_member:own", "maia_check_in:own", "maia_read:read", "working_on:own", "paper_note:own");
        assertThat(MaiaProfile.AREAS).containsExactlyInAnyOrder("todo_list", "todo_get", "todo_add", "todo_update",
                "todo_close", "desk_message", "docs_find", "docs_handover", "docs_ask", "docs_offer_rule");
    }
}
