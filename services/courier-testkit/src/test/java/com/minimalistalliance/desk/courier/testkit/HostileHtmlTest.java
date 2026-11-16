package com.minimalistalliance.desk.courier.testkit;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.courier.testkit.HostileHtml.Vector;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

/** The hostile HTML vectors: enough of them, unique, and each one detectable by a real browser once filled. */
class HostileHtmlTest {

    @Test
    void thereAreAtLeast200UniqueVectorsEachDetectable() {
        List<Vector> vectors = HostileHtml.vectors();
        assertThat(vectors).hasSizeGreaterThanOrEqualTo(200);
        Set<String> names = new HashSet<>();
        int fetch = 0;
        int run = 0;
        for (Vector v : vectors) {
            assertThat(names.add(v.name())).as("unique " + v.name()).isTrue();
            assertThat(v.name()).matches("[a-z0-9-]+");
            assertThat(v.html()).as(v.name()).isNotBlank();
            assertThat(v.html().contains("alert(") || v.html().contains("{{HIT")).as(v.name() + " runs alert( or loads {{HIT}}").isTrue();
            assertThat(v.html()).as(v.name()).doesNotContain("{{U+");
            fetch += v.html().contains("{{HIT") ? 1 : 0;
            run += v.html().contains("alert(") ? 1 : 0;
        }
        System.out.println("vectors: " + vectors.size() + ", " + run + " call alert(, " + fetch + " load the hit URL");
    }

    @Test
    void fillingPointsEachVectorAtItsOwnUrl() {
        String base = "http://127.0.0.1:41234/hit";
        List<Vector> raw = HostileHtml.vectors();
        List<Vector> filled = HostileHtml.vectors(base + "/");
        assertThat(filled).hasSameSizeAs(raw);
        for (int i = 0; i < raw.size(); i++) {
            Vector v = filled.get(i);
            assertThat(v.name()).isEqualTo(raw.get(i).name());
            assertThat(v.html()).as(v.name()).doesNotContain("{{");
            if (raw.get(i).html().contains("{{HIT}}")) {
                assertThat(v.html()).contains(base + "/" + v.name());
            }
            if (raw.get(i).html().contains("{{HIT//}}")) {
                assertThat(v.html()).contains("//127.0.0.1:41234/hit/" + v.name());
            }
        }
    }

    @Test
    void theResourceHoldsNoControlBytes() {
        byte[] file = MimeCorpus.bytes("/courier-testkit/html/vectors.txt");
        for (byte b : file) {
            assertThat(b == '\n' || (b & 0xff) >= 0x20).as("byte " + (b & 0xff)).isTrue();
        }
        // Code points the file spells out arrive as themselves.
        assertThat(HostileHtml.vectors().stream().anyMatch(v -> v.html().indexOf('\u0000') >= 0)).isTrue();
    }
}
