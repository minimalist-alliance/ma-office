package com.minimalistalliance.desk.agent.limits;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.agent.provider.ProviderId;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;

/** ADR 0043: the Platform's table replaces the bundled one; one that can't be used changes nothing and says nothing of itself. */
@ExtendWith(OutputCaptureExtension.class)
class PriceTableTest {

    private static final String GOOD = """
            {"version": 1, "checked": "2027-01-02", "models": {"anthropic/some-model": {"input": "3", "output": "15"}}}""";

    private static byte[] bytes(String text) {
        return text.getBytes(StandardCharsets.UTF_8);
    }

    @Test
    void aGoodTableIsInUseAtOnceWithItsDate() {
        PriceTable table = new PriceTable(Pricing.bundled());
        assertThat(table.current().checked()).isEqualTo("2026-11-06");

        assertThat(table.apply(bytes(GOOD))).isTrue();
        assertThat(table.current().checked()).isEqualTo("2027-01-02");
        assertThat(table.current().price(ProviderId.ANTHROPIC, "some-model").input()).isEqualTo(3_000_000);
    }

    @Test
    void aBadTableIsIgnoredWithOneLineAndNoneOfIt(CapturedOutput output) {
        PriceTable table = new PriceTable(Pricing.bundled());
        Pricing before = table.current();
        String sentinel = "sentinel-model-name";
        for (String bad : new String[] {
            "not json " + sentinel,
            "{\"version\": 2, \"models\": {\"a/" + sentinel + "\": {\"input\": \"1\", \"output\": \"1\"}}}",
            "{\"version\": 1, \"note\": \"" + sentinel + "\"}",
            "{\"version\": 1, \"models\": {}}",
            "{\"version\": 1, \"models\": {\"a/" + sentinel + "\": {\"input\": \"oops\", \"output\": \"1\"}}}",
            "{\"version\": 1, \"models\": {\"a/" + sentinel + "\": 3}}",
            "{\"version\": 1, \"models\": {\"a/" + sentinel + "\": {\"input\": \"1000000\", \"output\": \"1\"}}}",
            // Nothing priced: every model at 0 in and 0 out.
            "{\"version\": 1, \"models\": {\"a/" + sentinel + "\": {\"input\": \"0\", \"output\": \"0\"}}}",
        }) {
            assertThat(table.apply(bytes(bad))).as(bad).isFalse();
            assertThat(table.current()).isSameAs(before);
        }
        assertThat(table.apply(new byte[PriceTable.MAX_BYTES + 1])).isFalse();
        assertThat(table.current()).isSameAs(before);
        assertThat(output.getAll()).doesNotContain(sentinel);
        assertThat(output.getAll().lines().filter(line -> line.contains("a price table was ignored"))).hasSize(9);
    }

    @Test
    void aTableWithNoDateIsUsableAndItsDateIsUnknown() {
        PriceTable table = new PriceTable(Pricing.bundled());
        assertThat(table.apply(bytes("{\"version\": 1, \"models\": {\"a/b\": {\"input\": \"1\", \"output\": \"1\"}}}"))).isTrue();
        assertThat(table.current().checked()).isNull();
        assertThat(table.apply(bytes(
                "{\"version\": 1, \"checked\": \"soon\", \"models\": {\"a/b\": {\"input\": \"1\", \"output\": \"1\"}}}"))).isTrue();
        assertThat(table.current().checked()).isNull();
    }
}
