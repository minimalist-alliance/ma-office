package com.minimalistalliance.desk.deskd.protocol;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class JsonTest {

    private static byte[] utf8(String text) {
        return text.getBytes(StandardCharsets.UTF_8);
    }

    @Test
    void readsNestedObjectsAndArrays() throws JsonFormatException {
        Map<String, Object> value = Json.parseObject(utf8("{\"a\":1,\"b\":{\"c\":[true,null,\"x\"]},\"big\":4294967295}"));
        assertThat(value.get("a")).isEqualTo(1);
        assertThat(Json.object(value, "b")).containsKey("c");
        assertThat(Json.object(value, "b").get("c")).isEqualTo(Arrays.asList(true, null, "x"));
        assertThat(((Number) value.get("big")).longValue()).isEqualTo(4294967295L);
    }

    @Test
    void writesNullsSoEveryFieldIsPresent() {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("deskId", null);
        value.put("list", List.of(1, "two"));
        assertThat(new String(Json.bytes(value), StandardCharsets.UTF_8))
                .isEqualTo("{\"deskId\":null,\"list\":[1,\"two\"]}");
    }

    @Test
    void refusesAnythingButOneObject() {
        for (String bad : List.of(
                "", "[]", "1", "not json", "{\"a\":", "{\"a\":1,\"a\":2}", "null", "{\"a\":1}x", "{\"a\":1}{\"b\":2}", "{} 1")) {
            assertThatThrownBy(() -> Json.parseObject(utf8(bad))).as(bad).isInstanceOf(JsonFormatException.class);
        }
    }

    @Test
    void spaceAfterTheObjectIsFine() throws JsonFormatException {
        assertThat(Json.parseObject(utf8("{\"a\":1} \r\n"))).containsEntry("a", 1);
    }

    @Test
    void refusesDeepNesting() {
        String deep = "{\"a\":".repeat(100) + "1" + "}".repeat(100);
        assertThatThrownBy(() -> Json.parseObject(utf8(deep))).isInstanceOf(JsonFormatException.class);
    }

    @Test
    void theExceptionNeverQuotesTheInput() {
        assertThatThrownBy(() -> Json.parseObject(utf8("{\"secret\":\"hunter2\"")))
                .isInstanceOf(JsonFormatException.class)
                .hasMessage("invalid JSON");
    }

    @Test
    void refusesTypesThatArentJson() {
        assertThatThrownBy(() -> Json.bytes(Map.of("thing", new Object())))
                .isInstanceOf(IllegalArgumentException.class);
    }
}
