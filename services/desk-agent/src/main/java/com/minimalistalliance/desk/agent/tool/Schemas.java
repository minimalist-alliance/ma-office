package com.minimalistalliance.desk.agent.tool;

import java.util.List;
import java.util.Map;

/**
 * The part of JSON Schema the registry's declarations use, checked before a call is classified: an object, its
 * {@code required} properties, no others when {@code additionalProperties} is false, and each property's {@code type}
 * ({@code string}, {@code integer}, {@code boolean}, {@code array}, {@code object}), {@code enum}, {@code minimum},
 * {@code maximum} and {@code maxItems}, one level into arrays' {@code items}. A declaration with no schema takes any
 * object: its tool checks its own input, as the workspace and team tools do.
 */
final class Schemas {

    private Schemas() {}

    /** @return the first property that doesn't fit, as a word, or null when the input fits */
    static String check(Map<String, Object> schema, Map<String, Object> input) {
        if (schema == null || schema.isEmpty()) {
            return null;
        }
        return object(schema, input, "input");
    }

    private static String object(Map<String, Object> schema, Object value, String where) {
        if (!(value instanceof Map<?, ?> map)) {
            return where;
        }
        Map<?, ?> properties = schema.get("properties") instanceof Map<?, ?> p ? p : Map.of();
        if (schema.get("required") instanceof List<?> required) {
            for (Object name : required) {
                if (map.get(name) == null) {
                    return String.valueOf(name);
                }
            }
        }
        for (Map.Entry<?, ?> entry : map.entrySet()) {
            Object property = properties.get(entry.getKey());
            if (property == null) {
                if (Boolean.FALSE.equals(schema.get("additionalProperties"))) {
                    return String.valueOf(entry.getKey());
                }
                continue;
            }
            if (entry.getValue() == null) {
                continue;
            }
            @SuppressWarnings("unchecked")
            String bad = value((Map<String, Object>) property, entry.getValue(), String.valueOf(entry.getKey()));
            if (bad != null) {
                return bad;
            }
        }
        return null;
    }

    private static String value(Map<String, Object> schema, Object value, String where) {
        Object type = schema.get("type");
        boolean fits = switch (type instanceof String t ? t : "") {
            case "string" -> value instanceof String;
            case "integer" -> value instanceof Number n && n.doubleValue() == Math.rint(n.doubleValue())
                    && !Double.isInfinite(n.doubleValue());
            case "boolean" -> value instanceof Boolean;
            case "array" -> value instanceof List<?>;
            case "object" -> value instanceof Map<?, ?>;
            default -> true;
        };
        if (!fits) {
            return where;
        }
        if (schema.get("enum") instanceof List<?> values && !values.contains(value)) {
            return where;
        }
        if (value instanceof Number n) {
            if (schema.get("minimum") instanceof Number min && n.doubleValue() < min.doubleValue()) {
                return where;
            }
            if (schema.get("maximum") instanceof Number max && n.doubleValue() > max.doubleValue()) {
                return where;
            }
        }
        if (value instanceof List<?> list) {
            if (schema.get("maxItems") instanceof Number max && list.size() > max.intValue()) {
                return where;
            }
            if (schema.get("items") instanceof Map<?, ?> items) {
                for (Object item : list) {
                    @SuppressWarnings("unchecked")
                    String bad = value((Map<String, Object>) items, item, where);
                    if (bad != null) {
                        return bad;
                    }
                }
            }
        }
        if (value instanceof Map<?, ?> && "object".equals(type) && schema.get("properties") != null) {
            return object(schema, value, where);
        }
        return null;
    }
}
