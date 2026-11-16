package com.minimalistalliance.desk.deskd.docs;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import org.junit.jupiter.api.Test;

/** What changed between two versions, by code: pages and the lines on them (API.md §25 "Copies and versions"). */
class PageDiffTest {

    static DocText doc(String... pages) throws Exception {
        return new FakeDocsSandbox().read("pdf", FakeDocsSandbox.pdf(pages));
    }

    @Test
    void theChangedPageAndLineAreFound() throws Exception {
        DocText v1 = doc("Terms\nClause 1", "Terms\nClause 2", "Payment\nDue on 15 November 2026.", "End");
        DocText v2 = doc("Terms\nClause 1", "Terms\nClause 2", "Payment\nDue on 1 December 2026.", "End");
        PageDiff.Result r = PageDiff.diff(v1, v2);
        assertThat(r.pages()).containsExactly(3);
        assertThat(r.lines().get(3)).containsExactly(1);
    }

    @Test
    void sameTextIsNoChangeWhateverTheSpacing() throws Exception {
        assertThat(PageDiff.diff(doc("A  b\nc"), doc("a b\nC")).pages()).isEmpty();
    }

    @Test
    void anAddedPageIsChanged() throws Exception {
        assertThat(PageDiff.diff(doc("one"), doc("one", "two")).pages()).containsExactly(2);
        assertThat(PageDiff.diff(doc("one", "two"), doc("one")).pages()).containsExactly(1);
    }

    @Test
    void paragraphsForADocumentWithNoPages() {
        DocText a = new DocText("docx", 0, false, List.of(), List.of(new DocText.Section("p", "First.", null),
                new DocText.Section("p", "Second.", null)), 0, 0, 0);
        DocText b = new DocText("docx", 0, false, List.of(), List.of(new DocText.Section("p", "First.", null),
                new DocText.Section("p", "Second, changed.", null)), 0, 0, 0);
        assertThat(PageDiff.diff(a, b).sections()).containsExactly(1);
    }

    @Test
    void simhashFindsNearCopiesOnly() {
        String base = "The quarterly report covers revenue, costs and the outlook. ".repeat(20);
        Long a = SimHash.of(base);
        Long b = SimHash.of(base + " One more sentence at the end.");
        Long c = SimHash.of("An entirely different letter about a lease renewal and the keys. ".repeat(20));
        assertThat(SimHash.distance(a, b)).isLessThanOrEqualTo(SimHash.NEAR);
        assertThat(SimHash.distance(a, c)).isGreaterThan(SimHash.NEAR);
        assertThat(SimHash.of("short")).isNull();
    }
}
