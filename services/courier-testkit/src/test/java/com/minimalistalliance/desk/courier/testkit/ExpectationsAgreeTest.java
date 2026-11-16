package com.minimalistalliance.desk.courier.testkit;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.courier.testkit.MimeCorpus.Expect;
import com.minimalistalliance.desk.courier.testkit.MimeCorpus.Outcome;
import com.minimalistalliance.desk.courier.testkit.MimeCorpus.Sample;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;

/**
 * A second opinion on every expectation: each sample a parser should read is read by Jakarta Mail ({@link Oracle}), and
 * its subject, sender, attachment count and word must agree. The generated corpus agrees everywhere; the few
 * hand-written samples that differ are listed with why the expectation stands.
 */
class ExpectationsAgreeTest {

    /**
     * Hand-written samples on which Jakarta Mail differs from the expectation, and why. All four are
     * deskd's own rows, which show what deskd's store keeps and finds rather than the parser's raw answer.
     */
    private static final Map<String, String> EXPECTED_DIFFERENCES = Map.of(
            "bidi-subject", "deskd's row: the store strips the right-to-left override from the subject",
            "nul-and-controls", "deskd's row: the store strips the BEL from the subject",
            "long-header", "deskd's row: the store caps a subject at 998 characters",
            "eight-bit-headers", "deskd's row: 'koln' finds K\u00f6ln through deskd's search, which folds accents");

    @Test
    void jakartaMailReadsEveryReadSampleAsExpected() {
        List<String> differ = new ArrayList<>();
        int[] checked = {0};
        Stream.concat(MimeCorpus.standard(), MimeCorpusTest.limitSamples()).filter(s -> s.expect().outcome() == Outcome.READ).forEach(s -> {
            checked[0]++;
            String why = disagreement(s);
            if (why != null && !EXPECTED_DIFFERENCES.containsKey(s.name())) {
                differ.add(s.name() + ": " + why);
            }
        });
        System.out.println("oracle: " + checked[0] + " samples to read checked, " + differ.size() + " differ");
        differ.forEach(d -> System.out.println("oracle: " + d));
        assertThat(differ).isEmpty();
    }

    @Test
    void theListedExceptionsReallyDiffer() {
        for (Sample s : MimeCorpus.handWritten()) {
            if (EXPECTED_DIFFERENCES.containsKey(s.name())) {
                assertThat(disagreement(s)).as(s.name() + " still differs").isNotNull();
            }
        }
    }

    private static String disagreement(Sample s) {
        Expect e = s.expect();
        try {
            Oracle.Read r = Oracle.read(s.raw());
            List<String> out = new ArrayList<>();
            if (e.subject() != null) {
                String got = r.subject() == null ? "" : r.subject();
                if (!got.equals(e.subject())) {
                    out.add("subject [" + clip(got) + "] not [" + clip(e.subject()) + "]");
                }
            }
            if (e.from() != null && !r.from().equalsIgnoreCase(e.from())) {
                out.add("from [" + r.from() + "] not [" + e.from() + "]");
            }
            if (e.attachments() != null && r.attachments() != e.attachments()) {
                out.add("attachments " + r.attachments() + " not " + e.attachments());
            }
            if (e.word() != null && !r.text().toLowerCase(Locale.ROOT).contains(e.word())) {
                out.add("word [" + e.word() + "] not in [" + clip(r.text()) + "]");
            }
            return out.isEmpty() ? null : String.join("; ", out);
        } catch (Exception ex) {
            return "threw " + ex;
        }
    }

    private static String clip(String s) {
        String one = s.replace("\r", "\\r").replace("\n", "\\n");
        return one.length() > 120 ? one.substring(0, 120) + "..." : one;
    }
}
