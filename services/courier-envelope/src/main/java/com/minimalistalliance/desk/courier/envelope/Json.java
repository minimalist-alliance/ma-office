package com.minimalistalliance.desk.courier.envelope;

import java.util.Map;
import tools.jackson.core.JacksonException;
import tools.jackson.core.JsonParser;
import tools.jackson.core.StreamReadConstraints;
import tools.jackson.core.json.JsonFactory;
import tools.jackson.core.util.JsonRecyclerPools;
import tools.jackson.jr.ob.JSON;

/**
 * Strict JSON for headers and bundles: one object, no repeated key, shallow, small strings, nothing after it. The bytes a
 * signature covers are read once, here, after the signature is checked against them, so two readers can't disagree on
 * what was signed.
 */
final class Json {

    static final JSON MAPPER = JSON.builder(JsonFactory.builder()
                    .recyclerPool(JsonRecyclerPools.nonRecyclingPool())
                    .streamReadConstraints(StreamReadConstraints.builder()
                            .maxNestingDepth(8)
                            .maxStringLength(64 * 1024)
                            .maxNumberLength(24)
                            .build())
                    .build())
            .disable(JSON.Feature.HANDLE_JAVA_BEANS)
            .disable(JSON.Feature.USE_DEFERRED_MAPS)
            .enable(JSON.Feature.FAIL_ON_DUPLICATE_MAP_KEYS)
            .enable(JSON.Feature.PRESERVE_FIELD_ORDERING)
            .enable(JSON.Feature.FAIL_ON_UNKNOWN_TYPE_WRITE)
            .build();

    private Json() {}

    static Map<String, Object> parseObject(byte[] bytes, int offset, int length) throws EnvelopeException {
        try (JsonParser parser = MAPPER.createParser(bytes, offset, length)) {
            Map<String, Object> object = MAPPER.mapFrom(parser);
            if (object == null || parser.nextToken() != null) {
                throw new EnvelopeException(EnvelopeException.FORMAT, "not one JSON object");
            }
            return object;
        } catch (JacksonException e) {
            throw new EnvelopeException(EnvelopeException.FORMAT, "not JSON");
        }
    }

    static byte[] bytes(Object value) {
        try {
            return MAPPER.asBytes(value);
        } catch (JacksonException e) {
            throw new IllegalArgumentException("can't be JSON", e);
        }
    }

    static boolean isInt(Object value, long expected) {
        return (value instanceof Integer || value instanceof Long) && ((Number) value).longValue() == expected;
    }

    static long longValue(Object value) throws EnvelopeException {
        if (value instanceof Integer || value instanceof Long) {
            return ((Number) value).longValue();
        }
        throw new EnvelopeException(EnvelopeException.FORMAT, "not an integer");
    }

    static String string(Object value, int max) throws EnvelopeException {
        if (value instanceof String s && !s.isEmpty() && s.length() <= max) {
            for (int i = 0; i < s.length(); i++) {
                char c = s.charAt(i);
                if (c < 0x20 || c == 0x7f || (c >= 0x80 && c < 0xa0) || c == ' ' || c == ' ') {
                    throw new EnvelopeException(EnvelopeException.FORMAT, "a control character in a string");
                }
            }
            return s;
        }
        throw new EnvelopeException(EnvelopeException.FORMAT, "not a string in range");
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> object(Object value) throws EnvelopeException {
        if (value instanceof Map<?, ?> m) {
            return (Map<String, Object>) m;
        }
        throw new EnvelopeException(EnvelopeException.FORMAT, "not an object");
    }
}
