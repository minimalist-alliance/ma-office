package com.minimalistalliance.desk.deskd.docs;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.ZoneId;
import java.util.List;
import org.junit.jupiter.api.Test;

/** Titles (code's template, at most 60 characters, the same every time) and the reasons' words. */
class TitlesAndWordsTest {

    static final ZoneId Z = ZoneId.of("America/Denver");
    static final long NOV12 = java.time.ZonedDateTime.of(2026, 11, 12, 10, 0, 0, 0, Z).toInstant().toEpochMilli();

    @Test
    void theStemLosesNoiseAndHiddenCharacters() {
        assertThat(Titles.stem("Contract v3 final (1).pdf")).isEqualTo("Contract");
        assertThat(Titles.stem("copy of invoice_4471.pdf")).isEqualTo("Invoice 4471");
        assertThat(Titles.stem("Re​port‮.docx")).isEqualTo("Report");
        assertThat(Titles.stem(".pdf")).isEqualTo("Document");
        assertThat(Titles.stem(null)).isEqualTo("Document");
    }

    @Test
    void theTitleIsTheTemplateWithinSixty() {
        String t = Titles.title(NOV12, Z, "Northwind", "Invoice 4471");
        assertThat(t).isEqualTo("12 Nov · Northwind · Invoice 4471");
        String long1 = Titles.title(NOV12, Z, "A sender with a very long name indeed and more", "A very long description of what this is about");
        assertThat(long1.length()).isLessThanOrEqualTo(60);
        assertThat(Titles.title(NOV12, Z, "Northwind", "Invoice 4471")).isEqualTo(t);
    }

    @Test
    void aRenameIsComputedNeverAppended() {
        String a = Titles.fileName("12 Nov · Rosa · Contract", "Contract v3.pdf");
        assertThat(a).isEqualTo("12 Nov - Rosa - Contract.pdf");
        assertThat(Titles.fileName("12 Nov · Rosa · Contract", a)).isEqualTo(a);
        assertThat(Titles.fileName("a/b:c", "x.txt")).doesNotContain("/").doesNotContain(":");
    }

    @Test
    void reasonsAreAtMostSixWords() {
        long now = NOV12;
        for (String code : List.of("due", "todo", "changed", "newver", "from", "thread", "made", "always", "rule", "again",
                "new_sender", "first_kind", "fields", "sign", "pay", "reply", "approve", "decide", "receipt", "updates", "own",
                "default")) {
            String arg = switch (code) {
                case "changed", "sign" -> "3";
                case "pay" -> "1 Dec";
                default -> "Rosa Ortiz";
            };
            String w = Words.reason(code, arg, now + 86_400_000L, Z, now);
            long words = java.util.Arrays.stream(w.split(" ")).filter(t -> t.matches(".*\\p{L}{2,}.*")).count();
            assertThat(words).as(code + ": " + w).isLessThanOrEqualTo(6);
        }
        assertThat(Words.reason("changed", "3,7", null, Z, now)).isEqualTo("Pages 3 and 7 changed");
        assertThat(Words.pages("2,4,9")).isEqualTo("Pages 2, 4 and 9 changed");
        assertThat(Words.reason("danger", "program", null, Z, now)).isEqualTo("Program. Maia won\u2019t open this.");
        assertThat(Words.due(now + 3 * 3_600_000L, Z, now)).isEqualTo("Due in 3 hours");
        assertThat(Words.due(now + 86_400_000L, Z, now)).isEqualTo("Due tomorrow");
    }

    @Test
    void bytesSayTheType() {
        assertThat(Bytes.type("%PDF-1.7".getBytes(), "x.txt")).isEqualTo("pdf");
        assertThat(Bytes.type("hello\nthere".getBytes(), "x.pdf")).isEqualTo("text");
        assertThat(Bytes.type("<html><script>x</script>".getBytes(), "x.txt")).isEqualTo("other");
        assertThat(Bytes.type(new byte[] {0x7F, 'E', 'L', 'F', 1, 2}, "x.pdf")).isEqualTo("other");
        assertThat(Bytes.danger(new byte[] {'M', 'Z', 0, 0}, "invoice.pdf")).isEqualTo("program");
        assertThat(Bytes.danger("#!/bin/sh".getBytes(), "x.txt")).isEqualTo("script");
        assertThat(Bytes.danger("plain".getBytes(), "report.docm")).isEqualTo("macros");
        assertThat(Bytes.danger("plain".getBytes(), "page.html")).isEqualTo("html");
        assertThat(Bytes.danger("plain".getBytes(), "notes.txt")).isNull();
    }
}
