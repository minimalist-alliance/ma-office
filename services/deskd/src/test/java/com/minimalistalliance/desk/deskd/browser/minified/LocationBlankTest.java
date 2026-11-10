package com.minimalistalliance.desk.deskd.browser.minified;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;

/** The harnesses' outputs carry no location. Places here are made up, and the rule names none. */
class LocationBlankTest {

    @Test
    void whereTheMachineIsIsBlanked() {
        assertThat(LocationBlank.blank("Delivering to Sampletown 12345 Update location")).doesNotContain("Sampletown").doesNotContain("12345");
        assertThat(LocationBlank.blank("In stock in Sample Falls, ZZ")).doesNotContain("Sample Falls");
        assertThat(LocationBlank.blank("Pick up at STORE Sampleville, CO 54321")).doesNotContain("Sampleville").doesNotContain("54321");
        assertThat(LocationBlank.blank("Out of stock in Sampleton, TX")).doesNotContain("Sampleton");
        assertThat(LocationBlank.blank("Weather for Sampleburg today")).doesNotContain("Sampleburg");
        assertThat(LocationBlank.blank("Visit Sampleport, WA soon")).doesNotContain("Sampleport");
        assertThat(LocationBlank.blank("East Sample Heights, Sampleport, WA - From your IP address")).doesNotContain("Sample Heights")
                .doesNotContain("Sampleport");
        assertThat(LocationBlank.blank("{\"r\":\"button\",\"label\":\"54321\"}")).doesNotContain("54321");
    }

    @Test
    void jsonStaysJson() throws Exception {
        String json = "{\"t\":\"Delivering to Sampletown 12345\",\"c\":[\"In stock in Sampleville, CO\"]}";
        assertThat(com.minimalistalliance.desk.deskd.protocol.Json.parseObject(LocationBlank.blank(json.getBytes(java.nio.charset.StandardCharsets.UTF_8))))
                .containsKey("t").containsKey("c");
    }

    @Test
    void ordinaryTextStays() {
        String text = "The lamp has lit the reading rooms of the world for a long time, in 2026.";
        assertThat(LocationBlank.blank(text)).isEqualTo(text);
    }
}
