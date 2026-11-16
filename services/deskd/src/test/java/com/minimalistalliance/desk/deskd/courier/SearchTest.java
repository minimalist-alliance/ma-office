package com.minimalistalliance.desk.deskd.courier;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.deskd.courier.store.Lanes;
import com.minimalistalliance.desk.deskd.courier.store.SearchQuery;
import java.nio.file.Path;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** FTS5 search by Notebook's rules (plan §2.5): what it finds, what it doesn't, and that typing can't break it. */
class SearchTest {

    @TempDir
    Path dir;
    StoreRig rig;
    String lunch;
    String cafe;
    String invoice;
    String trip;
    String spam;

    @BeforeEach
    void corpus() throws Exception {
        rig = new StoreRig(dir);
        lunch = rig.accept(Mail.from("Dana Smith <dana@example.com>").id("1@x").subject("Lunch on Friday").text("Shall we try the new noodle place?")
                .at("2026-10-02T12:00:00Z")).messageId();
        cafe = rig.accept(Mail.from("Renée <renee@example.com>").id("2@x").subject("Café tomorrow").text("Meet at the café near the station.")
                .at("2026-10-15T12:00:00Z")).messageId();
        invoice = rig.accept(Mail.from("Billing <billing@vendor.example>").id("3@x").subject("Invoice 1042").text("Your invoice is attached.")
                .attach("invoice-1042.pdf", "application/pdf", "%PDF-1.7").at("2026-11-01T12:00:00Z")).messageId();
        trip = rig.accept(Mail.from("Bob <bob@example.org>").to("me@desk.example").cc("dana@example.com").id("4@x").subject("Trip")
                .text("Flights to Zürich are booked. Next week works.").at("2026-11-05T12:00:00Z")).messageId();
        spam = rig.accept(Mail.from("Promo <p@spam.example>").id("5@x").subject("Noodles cheap").text("noodle deals")).messageId();
        rig.store.actions().move(List.of(spam), null, null, "spam");
    }

    @org.junit.jupiter.api.AfterEach
    void close() {
        rig.close();
    }

    private List<String> find(String q) throws Exception {
        return find(q, Lanes.DEFAULT_VISIBLE, ZoneOffset.UTC);
    }

    @SuppressWarnings("unchecked")
    private List<String> find(String q, List<String> lanes, ZoneId zone) throws Exception {
        Map<String, Object> r = rig.store.queries().search(SearchQuery.parse(q), lanes, null, null, 100, zone);
        List<String> ids = new ArrayList<>();
        for (Map<String, Object> hit : (List<Map<String, Object>>) r.get("hits")) {
            ids.add((String) hit.get("messageId"));
        }
        return ids;
    }

    @Test
    void wordsMatchByPrefixIgnoringCaseAndAccents() throws Exception {
        assertThat(find("noodle")).containsExactly(lunch);
        assertThat(find("NOOD")).containsExactly(lunch);
        assertThat(find("cafe")).containsExactly(cafe);
        assertThat(find("café")).containsExactly(cafe);
        assertThat(find("zurich")).containsExactly(trip);
        assertThat(find("renee")).containsExactly(cafe);
        assertThat(find("oodle")).isEmpty();
    }

    @Test
    void everyWordMustMatchAndPhrasesMatchInOrder() throws Exception {
        assertThat(find("noodle place")).containsExactly(lunch);
        assertThat(find("noodle invoice")).isEmpty();
        assertThat(find("\"next week\"")).containsExactly(trip);
        assertThat(find("\"week next\"")).isEmpty();
    }

    @Test
    void operatorsNarrow() throws Exception {
        assertThat(find("from:dana")).containsExactly(lunch);
        assertThat(find("from:example.com")).containsExactly(cafe, lunch);
        assertThat(find("to:dana")).containsExactly(trip);
        assertThat(find("has:attachment")).containsExactly(invoice);
        assertThat(find("1042")).containsExactly(invoice);
        assertThat(find("invoice-1042.pdf")).containsExactly(invoice);
        assertThat(find("after:2026-11-01")).containsExactly(trip, invoice);
        assertThat(find("before:2026-10-10")).containsExactly(lunch);
        assertThat(find("after:2026-10-10 before:2026-11-02")).containsExactly(invoice, cafe);
        assertThat(find("in:requests noodle")).containsExactly(lunch);
        assertThat(find("is:unread trip")).containsExactly(trip);
    }

    @Test
    void spamAndTrashAreOutUnlessAskedFor() throws Exception {
        assertThat(find("noodle")).doesNotContain(spam);
        assertThat(find("in:spam noodle", Lanes.ALL, ZoneOffset.UTC)).containsExactly(spam);
    }

    @Test
    void daysAreTheMembersDays() throws Exception {
        // 2026-10-02T12:00Z is the 2nd's early morning in Honolulu, and already the 3rd on Kiritimati (UTC+14).
        assertThat(find("after:2026-10-02 before:2026-10-03", Lanes.DEFAULT_VISIBLE, ZoneId.of("Pacific/Honolulu"))).containsExactly(lunch);
        assertThat(find("after:2026-10-03 before:2026-10-04", Lanes.DEFAULT_VISIBLE, ZoneOffset.UTC)).doesNotContain(lunch);
        assertThat(find("after:2026-10-03 before:2026-10-04", Lanes.DEFAULT_VISIBLE, ZoneId.of("Pacific/Kiritimati"))).containsExactly(lunch);
    }

    @Test
    void whatAMemberTypesNeverBreaksTheQuery() throws Exception {
        for (String q : List.of("\"", "\"\"\"", "NEAR(", "a OR", "-", "*", "^x", "x:y", "{search_from}:a", "AND AND", "(((", "'", "\\",
                "\u0000", "🙂", "\"unclosed phrase", "from:", "from:\"\"", "a\"b", "noodle\" OR \"invoice")) {
            assertThat(find(q)).as(q).doesNotContain(spam);
        }
        assertThat(find("noodle\" OR \"invoice")).isEmpty();
    }

    @Test
    void aSnippetSaysWhereTheWordsAre() throws Exception {
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> hits = (List<Map<String, Object>>) rig.store.queries()
                .search(SearchQuery.parse("noodle"), Lanes.DEFAULT_VISIBLE, null, null, 10, ZoneOffset.UTC).get("hits");
        String snippet = (String) hits.get(0).get("snippet");
        assertThat(snippet).contains("noodle").hasSizeLessThanOrEqualTo(200);
        List<?> matches = (List<?>) hits.get(0).get("matches");
        assertThat(matches).isNotEmpty();
        List<?> first = (List<?>) matches.get(0);
        assertThat(snippet.substring((Integer) first.get(0), (Integer) first.get(1)).toLowerCase()).isEqualTo("noodle");
    }

    @Test
    void deletedMailLeavesTheIndexAndPagesAreStable() throws Exception {
        rig.store.actions().delete(List.of(lunch), false);
        assertThat(find("noodle")).isEmpty();
        rig.store.actions().move(List.of(lunch), null, null, "restore");
        assertThat(find("noodle")).containsExactly(lunch);
        rig.store.actions().delete(List.of(lunch), false);
        rig.store.actions().delete(List.of(lunch), true);
        assertThat(find("noodle")).isEmpty();
        assertThat(find("noodle", Lanes.ALL, ZoneOffset.UTC)).containsExactly(spam);
        // Paging: two pages of one each cover the same as one of two.
        Map<String, Object> p1 = rig.store.queries().search(SearchQuery.parse("from:example"), Lanes.DEFAULT_VISIBLE, null, null, 1, ZoneOffset.UTC);
        Map<String, Object> p2 = rig.store.queries().search(SearchQuery.parse("from:example"), Lanes.DEFAULT_VISIBLE, null, p1.get("next"), 1, ZoneOffset.UTC);
        assertThat(p1.get("next")).isNotNull();
        assertThat(((List<?>) p1.get("hits"))).hasSize(1);
        assertThat(((List<?>) p2.get("hits"))).hasSize(1);
        assertThat(((Map<?, ?>) ((List<?>) p1.get("hits")).get(0)).get("messageId"))
                .isNotEqualTo(((Map<?, ?>) ((List<?>) p2.get("hits")).get(0)).get("messageId"));
    }

    @Test
    @SuppressWarnings("unchecked")
    void pagesWalkEveryHitNewestFirstWhateverOrderTheMailCameIn() throws Exception {
        java.util.Random rnd = new java.util.Random(7);
        List<Integer> order = new ArrayList<>();
        for (int i = 0; i < 130; i++) {
            order.add(i);
        }
        java.util.Collections.shuffle(order, rnd);
        String[] ids = new String[130];
        for (int i : order) {
            // A third share one instant, so the order within a millisecond is tested too; the rest are spread over a year.
            String at = i % 3 == 0 ? "2026-06-01T09:00:00Z" : java.time.Instant.parse("2025-11-01T00:00:00Z").plusSeconds(i * 240_000L).toString();
            ids[i] = rig.accept(Mail.from("Q" + (i % 9) + " <q" + (i % 9) + "@quartz.example>").id("q" + i + "@x").subject("Quartz " + i)
                    .text("quartz sample " + i).at(at)).messageId();
        }
        for (String q : new String[] {"quartz", "is:unread", "from:quartz.example after:2026-01-01"}) {
            SearchQuery query = SearchQuery.parse(q);
            Map<String, Object> whole = rig.store.queries().search(query, Lanes.DEFAULT_VISIBLE, null, null, 100, ZoneOffset.UTC);
            List<String> once = new ArrayList<>();
            ((List<Map<String, Object>>) whole.get("hits")).forEach(h -> once.add((String) h.get("messageId")));
            Object next = whole.get("next");
            while (next != null) {
                Map<String, Object> more = rig.store.queries().search(query, Lanes.DEFAULT_VISIBLE, null, next, 100, ZoneOffset.UTC);
                ((List<Map<String, Object>>) more.get("hits")).forEach(h -> once.add((String) h.get("messageId")));
                next = more.get("next");
            }
            // Pages of 7, with a hit of the next page deleted for good between two of them: nothing else skipped or repeated.
            List<String> paged = new ArrayList<>();
            List<Long> ats = new ArrayList<>();
            String gone = null;
            next = null;
            do {
                Map<String, Object> page = rig.store.queries().search(query, Lanes.DEFAULT_VISIBLE, null, next, 7, ZoneOffset.UTC);
                for (Map<String, Object> h : (List<Map<String, Object>>) page.get("hits")) {
                    paged.add((String) h.get("messageId"));
                    ats.add((Long) h.get("at"));
                }
                next = page.get("next");
                if (gone == null && paged.size() == 21 && once.size() > 25) {
                    gone = once.get(23);
                    rig.store.actions().delete(List.of(gone), false);
                    rig.store.actions().delete(List.of(gone), true);
                }
            } while (next != null);
            List<String> expected = new ArrayList<>(once);
            expected.remove(gone);
            assertThat(paged).as(q).containsExactlyElementsOf(expected);
            assertThat(paged).as(q).doesNotHaveDuplicates();
            for (int i = 1; i < ats.size(); i++) {
                assertThat(ats.get(i)).as(q + " newest first").isLessThanOrEqualTo(ats.get(i - 1));
            }
            if (q.equals("quartz")) {
                assertThat(once).hasSize(130);
                // Within the shared instant, the one that came last is first.
                List<String> shared = new ArrayList<>();
                for (int i : order) {
                    if (i % 3 == 0) {
                        shared.add(0, ids[i]);
                    }
                }
                shared.remove(gone);
                List<String> inOnce = new ArrayList<>(once);
                inOnce.retainAll(shared);
                assertThat(inOnce).containsExactlyElementsOf(shared);
            }
        }
    }
}
