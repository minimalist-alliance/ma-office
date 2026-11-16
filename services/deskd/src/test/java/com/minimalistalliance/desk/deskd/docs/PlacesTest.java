package com.minimalistalliance.desk.deskd.docs;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import org.junit.jupiter.api.Test;

/** The place table (API.md §25 "How a place is decided"), one rule at a time, first match wins. */
class PlacesTest {

    static final long NOW = 1_763_200_000_000L;

    static Places.Facts f(String kind, String lane, boolean known, String person, String name) {
        return new Places.Facts(kind, null, lane, false, known, person, "example.com", name, false, null, false,
                "file".equals(kind) && lane == null, 0, 0, false, null, null, NOW - 1000, NOW, false, null);
    }

    static Places.Facts with(Places.Facts f, String field, Object v) {
        return new Places.Facts(f.kind(), field.equals("danger") ? (String) v : f.danger(), f.lane(),
                field.equals("bulk") ? (Boolean) v : f.bulk(), f.senderKnown(), f.personKey(), f.domain(), f.origName(),
                field.equals("letThrough") ? (Boolean) v : f.letThrough(), field.equals("todo") ? (Long) v : f.todoDueAt(),
                field.equals("newver") ? (Boolean) v : f.newVersionOfNeeds(), f.ownUpload(),
                field.equals("sign") ? (Integer) v : f.signaturesEmpty(), f.formEmpty(),
                field.equals("first") ? (Boolean) v : f.firstOfSenderKind(), f.senderEarlierPlace(),
                field.equals("reader") ? (Places.Reader) v : f.reader(), field.equals("arrived") ? (Long) v : f.arrivedAt(), f.now(),
                f.openedEver(), f.agentName());
    }

    static Places.Decision d(Places.Facts f) {
        return Places.decide(f, List.of(), List.of());
    }

    @Test
    void aDangerIsRecordsWhatever() {
        Places.Facts f = with(with(f("attachment", "people", true, "pk_1", "x.exe"), "danger", "program"), "letThrough", true);
        assertThat(d(f).place()).isEqualTo("records");
        assertThat(d(f).reason()).isEqualTo("danger");
        assertThat(d(f).basis()).isEqualTo(1);
    }

    @Test
    void theMembersRuleWinsMostSpecificFirst() {
        Places.Facts f = f("attachment", "people", true, "pk_a", "Invoice 12.pdf");
        Places.Rule byPerson = new Places.Rule("r_1", "pk_a", null, null, null, "records", "tap");
        Places.Rule byPersonKind = new Places.Rule("r_2", "pk_a", null, "invoice", null, "needs", "tap");
        Places.Decision dec = Places.decide(f, List.of(byPerson, byPersonKind), List.of());
        assertThat(dec.place()).isEqualTo("needs");
        assertThat(dec.reason()).isEqualTo("always");
        assertThat(Places.decide(f, List.of(byPerson), List.of()).place()).isEqualTo("records");
    }

    @Test
    void aWelcomeRuleReachesMaybeBeforeAReading() {
        Places.Facts f = f("attachment", "people", true, "pk_a", "Invoice 12.pdf");
        Places.Rule w = new Places.Rule("welcome:invoice", null, null, "invoice", null, "needs", "welcome");
        Places.Decision dec = Places.decide(f, List.of(), List.of(w));
        assertThat(dec.place()).isEqualTo("needs");
        assertThat(dec.maybe()).isTrue();
    }

    @Test
    void strongStructureIsNeedsYou() {
        assertThat(d(with(f("attachment", "people", true, "pk_a", "a.pdf"), "todo", NOW + 3_600_000L)).reason()).isEqualTo("due");
        assertThat(d(with(f("attachment", "people", true, "pk_a", "a.pdf"), "todo", -1L)).reason()).isEqualTo("todo");
        Places.Decision lt = d(with(f("attachment", "people", true, "pk_a", "a.pdf"), "letThrough", true));
        assertThat(lt.place()).isEqualTo("needs");
        assertThat(lt.maybe()).isFalse();
        assertThat(d(with(f("attachment", "people", true, "pk_a", "a.pdf"), "newver", true)).reason()).isEqualTo("newver");
    }

    @Test
    void weakStructureIsMaybe() {
        Places.Decision sig = d(with(f("attachment", "people", true, "pk_a", "a.pdf"), "sign", 1));
        assertThat(sig.place()).isEqualTo("needs");
        assertThat(sig.maybe()).isTrue();
        assertThat(sig.reason()).isEqualTo("fields");
        assertThat(d(f("attachment", "other", false, "pk_b", "notes.pdf")).maybe()).isTrue();
        assertThat(d(f("attachment", "people", true, "pk_a", "Contract draft.pdf")).maybe()).isTrue();
    }

    @Test
    void lowSignals() {
        assertThat(d(f("attachment", "updates", true, "pk_a", "news.pdf")).place()).isEqualTo("read");
        assertThat(d(f("download", null, false, null, "x.pdf")).place()).isEqualTo("working");
        assertThat(d(with(f("download", null, false, null, "x.pdf"), "arrived", NOW - 8L * 86_400_000L)).place()).isEqualTo("records");
    }

    @Test
    void theReadersFactsAreAppliedByCodeAndNeverLiftAnUnknownSenderPastMaybe() {
        Places.Reader pay = new Places.Reader("invoice", List.of("pay"), NOW + 86_400_000L, null);
        Places.Decision known = d(with(f("attachment", "people", true, "pk_a", "x.pdf"), "reader", pay));
        assertThat(known.place()).isEqualTo("needs");
        assertThat(known.maybe()).isFalse();
        Places.Decision unknown = d(with(f("attachment", "other", false, "pk_z", "x.pdf"), "reader", pay));
        assertThat(unknown.place()).isEqualTo("needs");
        assertThat(unknown.maybe()).isTrue();
        Places.Reader receipt = new Places.Reader("receipt", List.of(), null, null);
        assertThat(d(with(f("attachment", "people", true, "pk_a", "x.pdf"), "reader", receipt)).place()).isEqualTo("records");
        Places.Reader sign = new Places.Reader("contract", List.of("sign"), null, 4);
        Places.Decision s = d(with(f("attachment", "people", true, "pk_a", "x.pdf"), "reader", sign));
        assertThat(s.reason()).isEqualTo("sign");
        assertThat(s.reasonArg()).isEqualTo("4");
    }

    @Test
    void defaults() {
        assertThat(d(f("attachment", "people", true, "pk_a", "photo.png")).place()).isEqualTo("read");
        assertThat(d(f("file", null, false, null, "notes.txt")).place()).isEqualTo("read");
        assertThat(d(with(f("file", null, false, null, "notes.txt"), "arrived", NOW - 30L * 86_400_000L)).place()).isEqualTo("records");
        Places.Facts agent = new Places.Facts("agent_output", null, null, false, false, null, null, "summary.md", false, null, false,
                false, 0, 0, false, null, null, NOW, NOW, false, "Work Lead");
        Places.Decision a = d(agent);
        assertThat(a.place()).isEqualTo("read");
        assertThat(a.reason()).isEqualTo("made");
        assertThat(a.reasonArg()).isEqualTo("Work Lead");
    }

    @Test
    void aRuleWithNoPersonLiftsAStrangerToMaybeOnly() {
        Places.Rule byKind = new Places.Rule("r_k", null, null, "invoice", null, "needs", "tap");
        Places.Decision stranger = Places.decide(f("attachment", "other", false, "pk_s", "Invoice 9.pdf"), List.of(byKind), List.of());
        assertThat(stranger.place()).isEqualTo("needs");
        assertThat(stranger.maybe()).isTrue();
        Places.Decision known = Places.decide(f("attachment", "people", true, "pk_k", "Invoice 9.pdf"), List.of(byKind), List.of());
        assertThat(known.maybe()).isFalse();
    }

    @Test
    void theReadersLineIsCheckedOnDeskdToo() {
        assertThat(ReaderFacts.line("An invoice for 120 USD due 1 Dec")).isEqualTo("An invoice for 120 USD due 1 Dec");
        assertThat(ReaderFacts.line("Pay at pay-now.example today")).isNull();
        assertThat(ReaderFacts.line("Visit www\uFF0Eexample\uFF0Ecom")).isNull();
        assertThat(ReaderFacts.line("Pay \u202Etoday")).isNull();
        assertThat(ReaderFacts.line("javascript:alert(1)")).isNull();
        assertThat(ReaderFacts.line("Report.pdf attached")).isEqualTo("Report.pdf attached");
    }
}
