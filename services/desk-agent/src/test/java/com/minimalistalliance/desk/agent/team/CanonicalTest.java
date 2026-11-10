package com.minimalistalliance.desk.agent.team;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * A proposal's hash is what the member's yes echoes, so these bytes are fixed: the vectors below were made by
 * {@code JSON.stringify} in Node (keys sorted, no spaces), as the Agent app's {@code canonicalJson} writes them.
 */
class CanonicalTest {

    @Test
    void keysAreSortedByUtf16CodeUnitAtEveryDepth() {
        Map<String, Object> inner = new LinkedHashMap<>();
        inner.put("b", null);
        inner.put("a", true);
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("z", List.of(1, List.of(2, 3), inner));
        value.put("B", "x");
        value.put("\uff5a", 0);
        value.put("\ud83d\ude00", -5);
        value.put("\u00e9", "e");
        value.put("a", List.of());
        value.put("o", Map.of());

        assertThat(Canonical.json(value)).isEqualTo(
                "{\"B\":\"x\",\"a\":[],\"o\":{},\"z\":[1,[2,3],{\"a\":true,\"b\":null}],\"\u00e9\":\"e\","
                        + "\"\ud83d\ude00\":-5,\"\uff5a\":0}");
    }

    @Test
    void stringsEscapeAsJsonStringifyDoes() {
        assertThat(Canonical.json("line\nbreak\ttab\r\b\f")).isEqualTo("\"line\\nbreak\\ttab\\r\\b\\f\"");
        assertThat(Canonical.json("\u0001\u001f")).isEqualTo("\"\\u0001\\u001f\"");
        assertThat(Canonical.json("say \"hi\" \\ there")).isEqualTo("\"say \\\"hi\\\" \\\\ there\"");
        assertThat(Canonical.json("\u007f\u2028")).as("DEL and the line separator stay raw").isEqualTo("\"\u007f\u2028\"");
    }

    @Test
    void nonAsciiStaysRawAndPairsStayWhole() {
        assertThat(Canonical.json("\u00e9\u65e5\u672c\ud83d\ude00")).isEqualTo("\"\u00e9\u65e5\u672c\ud83d\ude00\"");
    }

    @Test
    void aLoneSurrogateIsEscapedInLowerCase() {
        assertThat(Canonical.json("x\ud800y\udc00")).isEqualTo("\"x\\ud800y\\udc00\"");
        assertThat(Canonical.json("\ud83d")).as("a high surrogate at the end").isEqualTo("\"\\ud83d\"");
        assertThat(Canonical.json("\ud83d\u0041")).as("a high surrogate before a letter").isEqualTo("\"\\ud83dA\"");
    }

    @Test
    void theWholeVectorAndItsHashMatchNode() {
        Map<String, Object> inner = new LinkedHashMap<>();
        inner.put("b", null);
        inner.put("a", true);
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("z", List.of(1, List.of(2, 3), inner));
        value.put("B", "Quote\" back\\ nl\n tab\t");
        value.put("\u00e9", "\u65e5\u672c\ud83d\ude00");
        value.put("\u0001", "ctl\u0001\u001f");
        value.put("lone", "x\ud800y\udc00");
        value.put("\ud83d\ude00", -5);
        value.put("\uff5a", 0);
        value.put("big", 9007199254740991L);

        String expected = "{\"\\u0001\":\"ctl\\u0001\\u001f\",\"B\":\"Quote\\\" back\\\\ nl\\n tab\\t\","
                + "\"big\":9007199254740991,\"lone\":\"x\\ud800y\\udc00\",\"z\":[1,[2,3],{\"a\":true,\"b\":null}],"
                + "\"\u00e9\":\"\u65e5\u672c\ud83d\ude00\",\"\ud83d\ude00\":-5,\"\uff5a\":0}";
        assertThat(Canonical.json(value)).isEqualTo(expected);
        assertThat(Canonical.sha256(value)).isEqualTo("bc4cc2413659927a077b8ed011dea94810804d7645f7f1e295f72a3cde5d418c");
    }

    @Test
    void knownDigests() {
        assertThat(Canonical.sha256(Map.of())).isEqualTo("44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a");
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("b", 2);
        value.put("a", 1);
        assertThat(Canonical.sha256(value)).isEqualTo("43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777");
    }

    @Test
    void numbersThatAreNotWholeAreNotAProposalsToCarry() {
        assertThatThrownBy(() -> Canonical.json(1.5)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> Canonical.json(Map.of("a", new Object()))).isInstanceOf(IllegalArgumentException.class);
    }
}
