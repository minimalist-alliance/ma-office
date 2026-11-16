package com.minimalistalliance.desk.courier.parse;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.courier.testkit.MimeCorpus;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.junit.jupiter.api.Test;
import tools.jackson.jr.ob.JSON;

/**
 * The bar's corpus line (the launch plan §7): every message of the test kit's standard corpus, hand-written and
 * generated, is read or cleanly refused, through the worker's own wire, and what's read is what the sample says it is.
 * Every answer is valid JSON in {@code ParsedMessage.fromWire}'s shape, and every HTML in it passes the second pass again.
 */
class CorpusTest {

    static final JSON JSON_READER = JSON.std;
    /** deskd's rows that show what its store keeps (the subject cut to 998), not the parser's raw answer (the kit's README). */
    static final java.util.Set<String> STORE_ROWS = java.util.Set.of("bidi-subject", "nul-and-controls", "long-header", "eight-bit-headers");

    /** One request through the worker, in process, as deskd sends it. */
    static String[] answer(String line, byte[] raw) {
        ByteArrayOutputStream request = new ByteArrayOutputStream();
        request.writeBytes((line + "\n").getBytes(StandardCharsets.US_ASCII));
        request.writeBytes(raw);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        CourierWorker.serve(new ByteArrayInputStream(request.toByteArray()), out, 60_000);
        byte[] bytes = out.toByteArray();
        int nl = 0;
        while (nl < bytes.length && bytes[nl] != '\n') {
            nl++;
        }
        String first = new String(bytes, 0, nl, StandardCharsets.US_ASCII);
        String body = nl + 1 <= bytes.length ? new String(bytes, nl + 1, bytes.length - nl - 1, StandardCharsets.UTF_8) : "";
        return new String[] {first, body};
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> message(byte[] raw) throws Exception {
        String[] a = answer("courier1 message", raw);
        if (!a[0].equals("OK")) {
            return Map.of("refused", a[0]);
        }
        return JSON_READER.mapFrom(a[1]);
    }

    @Test
    @SuppressWarnings("unchecked")
    void everyMessageIsReadOrCleanlyRefused() throws Exception {
        List<String> wrong = new ArrayList<>();
        int read = 0;
        int refused = 0;
        int withHtml = 0;
        int htmlDropped = 0;
        for (MimeCorpus.Sample s : MimeCorpus.standard().toList()) {
            Map<String, Object> m = message(s.raw());
            MimeCorpus.Expect e = s.expect();
            if (m.containsKey("refused")) {
                refused++;
                String reason = ((String) m.get("refused")).substring(4);
                if (e.outcome() == MimeCorpus.Outcome.READ) {
                    wrong.add(s.name() + ": refused " + reason);
                } else if (e.outcome() == MimeCorpus.Outcome.REFUSED && !e.reason().equals(reason)) {
                    wrong.add(s.name() + ": refused " + reason + ", not " + e.reason());
                }
                continue;
            }
            read++;
            if (e.outcome() == MimeCorpus.Outcome.REFUSED) {
                wrong.add(s.name() + ": read, not refused " + e.reason());
                continue;
            }
            assertThat(m.get("v")).as(s.name()).isEqualTo(1);
            String html = (String) m.get("html");
            if (html != null) {
                withHtml++;
                assertThat(Html.verify(html)).as(s.name() + " html").isTrue();
            }
            if (e.outcome() != MimeCorpus.Outcome.READ) {
                continue;
            }
            Map<String, Object> from = (Map<String, Object>) m.get("from");
            String address = from == null ? "nobody@invalid" : (String) from.get("address");
            if (e.from() != null && !e.from().equalsIgnoreCase(address)) {
                wrong.add(s.name() + ": from " + address + ", not " + e.from());
            }
            String subject = m.get("subject") == null ? "" : (String) m.get("subject");
            String expected = e.subject() == null ? null : TextClean.clean(e.subject(), false).strip();
            // deskd's own rows show a subject as the store keeps it: cut to its length.
            if (expected != null && !expected.equals(subject) && !(STORE_ROWS.contains(s.name()) && subject.startsWith(expected))) {
                wrong.add(s.name() + ": subject [" + subject + "], not [" + e.subject() + "]");
            }
            List<Map<String, Object>> parts = (List<Map<String, Object>>) m.get("attachments");
            long shown = parts.stream().filter(p -> !Boolean.TRUE.equals(p.get("inline"))).count();
            if (e.attachments() != null && shown != e.attachments()) {
                wrong.add(s.name() + ": " + shown + " attachments, not " + e.attachments());
            }
            String text = ((String) m.get("text")).toLowerCase(Locale.ROOT);
            if (e.word() != null && !text.contains(e.word()) && !fold(text).contains(fold(e.word()))) {
                wrong.add(s.name() + ": no word " + e.word());
            }
            if (html == null && s.family().equals("html")) {
                htmlDropped++;
            }
        }
        System.out.printf("corpus: %d read, %d refused, %d with html, %d html dropped, %d wrong%n", read, refused, withHtml,
                htmlDropped, wrong.size());
        wrong.stream().limit(80).forEach(System.out::println);
        assertThat(wrong).isEmpty();
    }

    private static String fold(String s) {
        return java.text.Normalizer.normalize(s, java.text.Normalizer.Form.NFD).replaceAll("\\p{M}", "");
    }

    @Test
    void aMessageWithMoreThanOneFromIsRefused() throws Exception {
        String body = "To: a@example.com\r\nSubject: s\r\n\r\nhello\r\n";
        assertThat(message(("From: a@example.com\r\nFrom: b@evil.example\r\n" + body).getBytes(StandardCharsets.US_ASCII)))
                .containsEntry("refused", "ERR malformed");
        assertThat(message(("From: a@example.com, b@evil.example\r\n" + body).getBytes(StandardCharsets.US_ASCII)))
                .containsEntry("refused", "ERR malformed");
        assertThat(message(("From: A <a@example.com>\r\n" + body).getBytes(StandardCharsets.US_ASCII))).doesNotContainKey("refused");
    }

    @Test
    void theLimitsAreRefusalsAndJustUnderThemIsRead() throws Exception {
        assertThat(message(MimeCorpus.tooDeep(20).raw())).doesNotContainKey("refused");
        assertThat(message(MimeCorpus.tooDeep(21).raw())).containsEntry("refused", "ERR too_deep");
        assertThat(message(MimeCorpus.tooManyParts(2000).raw())).doesNotContainKey("refused");
        assertThat(message(MimeCorpus.tooManyParts(2001).raw())).containsEntry("refused", "ERR too_many_parts");
        assertThat(message(MimeCorpus.overLimit().raw())).containsEntry("refused", "ERR too_large");
        assertThat(message(MimeCorpus.large(30 << 20).raw())).doesNotContainKey("refused");
    }
}
