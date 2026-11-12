package com.minimalistalliance.desk.deskd.protocol;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.lang.reflect.Field;
import java.lang.reflect.Modifier;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Collection;
import java.util.IdentityHashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReferenceArray;
import org.junit.jupiter.api.Test;
import tools.jackson.core.util.JsonRecyclerPools;
import tools.jackson.jr.ob.JSON;

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

    /** A fake key, built at run time so no class file or source holds the marker. */
    private static final String MARKER = new StringBuilder("rekram-arbez").reverse().toString();
    private static final byte[] KEY_REQUEST = utf8("{\"m\":\"agent.key.add\",\"idem\":\"i1\",\"p\":{\"provider\":\"anthropic\","
            + "\"secret\":\"sk-ant-api03-FAKE-" + MARKER + "-0042\"}}");

    @Test
    void aRequestReadsAsAnyObjectDoes() throws JsonFormatException {
        assertThat(Json.parseRequest(KEY_REQUEST)).isEqualTo(Json.parseObject(KEY_REQUEST));
        for (String bad : List.of("", "[]", "null", "{\"a\":1,\"a\":2}", "{\"a\":1}x", "[".repeat(100))) {
            assertThatThrownBy(() -> Json.parseRequest(utf8(bad))).isInstanceOf(JsonFormatException.class);
        }
    }

    @Test
    void aRequestLeavesNoCopyOfItsParamsInAPooledBuffer() throws Exception {
        // The control: a pooled mapper, as every other parse uses, keeps the key's characters reachable.
        JSON pooled = Json.mapper(JsonRecyclerPools.newConcurrentDequePool());
        Json.parseObject(pooled, KEY_REQUEST);
        for (int i = 0; i < 100; i++) {
            Json.parseObject(pooled, utf8("{\"m\":\"browser.tab.list\",\"idem\":\"i2\",\"p\":{}}"));
        }
        assertThat(reachableCopies(pooled)).isPositive();

        JSON unpooled = Json.mapper(JsonRecyclerPools.nonRecyclingPool());
        assertThat(Json.parseObject(unpooled, KEY_REQUEST)).isEqualTo(Json.parseObject(pooled, KEY_REQUEST));
        assertThat(reachableCopies(unpooled)).isZero();

        Json.parseRequest(KEY_REQUEST);
        Field field = Json.class.getDeclaredField("UNPOOLED");
        field.setAccessible(true);
        assertThat(reachableCopies(field.get(null))).isZero();
    }

    /** How many {@code char[]} reachable from {@code root} through Jackson's own objects hold the marker. */
    private static int reachableCopies(Object root) throws IllegalAccessException {
        return walk(root, new IdentityHashMap<>(), 0);
    }

    private static int walk(Object o, IdentityHashMap<Object, Boolean> seen, int depth) throws IllegalAccessException {
        if (o == null || depth > 10 || seen.put(o, true) != null) {
            return 0;
        }
        if (o instanceof char[] chars) {
            return new String(chars).contains(MARKER) ? 1 : 0;
        }
        int n = 0;
        if (o instanceof Object[] array) {
            for (Object e : array) {
                n += walk(e, seen, depth + 1);
            }
            return n;
        }
        if (o instanceof AtomicReferenceArray<?> array) {
            for (int i = 0; i < array.length(); i++) {
                n += walk(array.get(i), seen, depth + 1);
            }
            return n;
        }
        if (o instanceof Collection<?> all) {
            for (Object e : all) {
                n += walk(e, seen, depth + 1);
            }
            return n;
        }
        if (!o.getClass().getName().startsWith("tools.jackson.")) {
            return 0;
        }
        for (Class<?> c = o.getClass(); c != null; c = c.getSuperclass()) {
            for (Field f : c.getDeclaredFields()) {
                if (!Modifier.isStatic(f.getModifiers()) && !f.getType().isPrimitive()) {
                    f.setAccessible(true);
                    n += walk(f.get(o), seen, depth + 1);
                }
            }
        }
        return n;
    }
}
