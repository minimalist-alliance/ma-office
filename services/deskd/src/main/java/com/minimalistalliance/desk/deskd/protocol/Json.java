package com.minimalistalliance.desk.deskd.protocol;

import java.util.Map;
import tools.jackson.core.JacksonException;
import tools.jackson.core.JsonParser;
import tools.jackson.core.StreamReadConstraints;
import tools.jackson.core.json.JsonFactory;
import tools.jackson.core.util.BufferRecycler;
import tools.jackson.core.util.JsonRecyclerPools;
import tools.jackson.core.util.RecyclerPool;
import tools.jackson.jr.ob.JSON;

/**
 * JSON to and from Map, List, String, Number, Boolean and null, through jackson-jr: about a sixth of
 * databind's bytes on disk and no reflection, because bean handling is off.
 */
public final class Json {

    private static final JSON MAPPER = mapper(JsonRecyclerPools.defaultPool());

    /**
     * The same, with parsers that keep no buffer once closed, for a client's RPC requests, whose params can hold a
     * secret such as {@code agent.key.add}'s key. The shared pool keeps each parser's character buffers reachable for
     * deskd's life, and a string's characters stay in one until a longer string happens to cover them: a key stayed
     * through thousands of later requests (ISS-20). These become garbage with their parser, as the strings it makes do.
     * About half a KiB more per small request.
     */
    private static final JSON UNPOOLED = mapper(JsonRecyclerPools.nonRecyclingPool());

    static JSON mapper(RecyclerPool<BufferRecycler> pool) {
        return JSON.builder(JsonFactory.builder()
                        .recyclerPool(pool)
                        .streamReadConstraints(StreamReadConstraints.builder()
                                .maxNestingDepth(64)
                                .build())
                        .build())
                .disable(JSON.Feature.HANDLE_JAVA_BEANS)
                .disable(JSON.Feature.USE_DEFERRED_MAPS)
                .enable(JSON.Feature.WRITE_NULL_PROPERTIES)
                .enable(JSON.Feature.FAIL_ON_UNKNOWN_TYPE_WRITE)
                .build();
    }

    private Json() {}

    /**
     * jackson-jr gives null for the literal null and stops reading after the first value, so both of
     * those are checked here.
     *
     * @throws JsonFormatException if the bytes aren't one JSON object, or repeat a key
     */
    public static Map<String, Object> parseObject(byte[] bytes) throws JsonFormatException {
        return parseObject(MAPPER, bytes);
    }

    /**
     * {@link #parseObject(byte[])} for a client's request, through parsers whose buffers aren't pooled ({@link
     * #UNPOOLED}), so nothing of its params stays reachable once it's parsed.
     *
     * @throws JsonFormatException if the bytes aren't one JSON object, or repeat a key
     */
    public static Map<String, Object> parseRequest(byte[] bytes) throws JsonFormatException {
        return parseObject(UNPOOLED, bytes);
    }

    static Map<String, Object> parseObject(JSON mapper, byte[] bytes) throws JsonFormatException {
        try (JsonParser parser = mapper.createParser(bytes)) {
            Map<String, Object> object = mapper.mapFrom(parser);
            if (object == null || parser.nextToken() != null) {
                throw new JsonFormatException();
            }
            return object;
        } catch (JacksonException e) {
            throw new JsonFormatException();
        }
    }

    /** @throws IllegalArgumentException if the value holds a type JSON can't carry */
    public static byte[] bytes(Object value) {
        try {
            return MAPPER.asBytes(value);
        } catch (JacksonException e) {
            throw new IllegalArgumentException("value isn't JSON", null);
        }
    }

    /** The string under the key, or null if it's absent or not a string. */
    public static String string(Map<String, Object> object, String key) {
        return object.get(key) instanceof String value ? value : null;
    }

    /** The object under the key, or null if it's absent or not an object. */
    @SuppressWarnings("unchecked")
    public static Map<String, Object> object(Map<String, Object> object, String key) {
        return object.get(key) instanceof Map<?, ?> value ? (Map<String, Object>) value : null;
    }
}
