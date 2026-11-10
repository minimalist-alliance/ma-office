package com.minimalistalliance.desk.deskd.browser;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.deskd.protocol.Json;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import org.junit.jupiter.api.Test;

class BoundedJsonTextTest {

    private static Map<String, Object> through(int maxString, int maxChars, String json) throws Exception {
        BoundedJsonText text = new BoundedJsonText(maxString, maxChars);
        // Split it, so nothing depends on where the pieces fall.
        for (int i = 0; i < json.length(); i += 7) {
            text.append(json.substring(i, Math.min(json.length(), i + 7)));
        }
        assertThat(text.overflowed()).isFalse();
        return Json.parseObject(text.text().getBytes(StandardCharsets.UTF_8));
    }

    @Test
    void shortStringsPassUnchanged() throws Exception {
        Map<String, Object> out = through(100, 10_000, "{\"a\":\"b\",\"n\":[1,2,{\"c\":\"d\\n\\\"e\"}],\"t\":true}");
        assertThat(out).containsEntry("a", "b").containsEntry("t", true);
        assertThat(out.toString()).contains("d\n\"e");
    }

    @Test
    void aLongStringIsCutAndTheJsonStaysValid() throws Exception {
        String json = "{\"url\":\"" + "x".repeat(1000) + "\",\"after\":\"kept\"}";
        Map<String, Object> out = through(10, 200, json);
        assertThat(out).containsEntry("url", "x".repeat(10)).containsEntry("after", "kept");
    }

    @Test
    void aCutNeverFallsInsideAnEscape() throws Exception {
        for (String tail : new String[] {"\\n", "\\\"", "\\\\", "\\u00e9", "\\ud83d\\ude00"}) {
            for (int pad = 0; pad < 12; pad++) {
                String json = "{\"s\":\"" + "a".repeat(pad) + tail.repeat(20) + "\",\"after\":1}";
                Map<String, Object> out = through(10, 10_000, json);
                assertThat(out).as("%s with %s before it", tail, pad).containsEntry("after", 1);
            }
        }
    }

    @Test
    void aQuoteInAnEscapeDoesntEndTheString() throws Exception {
        Map<String, Object> out = through(4, 1000, "{\"s\":\"\\\"\\\"\\\"\\\"\\\"\\\"\\\"\\\"\",\"a\":\"x\"}");
        assertThat(out).containsEntry("s", "\"\"\"\"").containsEntry("a", "x");
    }

    @Test
    void pastTheWholeLimitTheMessageIsDroppedAndItsMemoryWithIt() {
        BoundedJsonText text = new BoundedJsonText(10, 100);
        for (int i = 0; i < 1000; i++) {
            text.append("{\"a\":\"b\"},");
        }
        assertThat(text.overflowed()).isTrue();
        assertThat(text.text()).isEmpty();
    }
}
