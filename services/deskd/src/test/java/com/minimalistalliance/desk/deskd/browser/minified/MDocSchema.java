package com.minimalistalliance.desk.deskd.browser.minified;

import com.minimalistalliance.desk.deskd.protocol.Json;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Checks an MDoc on the wire against {@code minified/mdoc-schema.json}: every field of every head part, block and run is
 * one the schema names, of its type, with the required ones there, and every enum's value one of its own. What it
 * returns is every way the document breaks the schema, so a test shows them all at once.
 */
final class MDocSchema {

    private final Map<String, Object> schema;

    MDocSchema() throws Exception {
        try (InputStream in = MDocSchema.class.getResourceAsStream("/minified/mdoc-schema.json")) {
            schema = Json.parseObject(in.readAllBytes());
        }
    }

    List<String> check(Map<String, Object> mdoc) {
        List<String> errors = new ArrayList<>();
        fields(errors, "head", mdoc, section("head"));
        return errors;
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> section(String... path) {
        Object node = schema;
        for (String name : path) {
            node = ((Map<String, Object>) node).get(name);
        }
        return (Map<String, Object>) node;
    }

    private void fields(List<String> errors, String where, Map<?, ?> value, Map<String, Object> spec) {
        for (Map.Entry<String, Object> field : spec.entrySet()) {
            String name = field.getKey().replace("!", "");
            if (field.getKey().endsWith("!") && !value.containsKey(name)) {
                errors.add(where + ": missing " + name);
            }
        }
        for (Map.Entry<?, ?> entry : value.entrySet()) {
            String name = (String) entry.getKey();
            if ("t".equals(name) || "r".equals(name)) {
                continue;
            }
            Object type = spec.containsKey(name) ? spec.get(name) : spec.get(name + "!");
            if (type == null) {
                errors.add(where + ": unknown field " + name);
                continue;
            }
            type(errors, where + "." + name, entry.getValue(), (String) type);
            enumCheck(errors, where, name, entry.getValue());
        }
    }

    @SuppressWarnings("unchecked")
    private void enumCheck(List<String> errors, String where, String name, Object value) {
        String owner = where.contains("[") ? where.substring(where.lastIndexOf('[') + 1, where.lastIndexOf(']')) : where;
        Object allowed = section("enums").get(owner + "." + name);
        if (allowed instanceof List<?> list && !list.contains(value)) {
            errors.add(where + "." + name + ": " + value + " isn't one of " + list);
        }
    }

    @SuppressWarnings("unchecked")
    private void type(List<String> errors, String where, Object value, String type) {
        switch (type) {
            case "string" -> require(errors, where, value instanceof String, type);
            case "int" -> require(errors, where, value instanceof Integer || value instanceof Long, type);
            case "number" -> require(errors, where, value instanceof Number, type);
            case "bool" -> require(errors, where, value instanceof Boolean, type);
            case "strings" -> {
                require(errors, where, value instanceof List<?>, type);
                if (value instanceof List<?> list) {
                    list.forEach(item -> require(errors, where + "[]", item instanceof String, "string"));
                }
            }
            case "runs" -> runs(errors, where, value);
            case "run" -> runs(errors, where, List.of(value));
            case "blocks" -> {
                require(errors, where, value instanceof List<?>, type);
                if (value instanceof List<?> list) {
                    for (Object item : list) {
                        if (!(item instanceof Map<?, ?> block) || !(block.get("t") instanceof String t)) {
                            errors.add(where + ": a block without t");
                            continue;
                        }
                        Map<String, Object> spec = (Map<String, Object>) section("blocks").get(t);
                        if (spec == null) {
                            errors.add(where + ": unknown block " + t);
                        } else {
                            fields(errors, where + "[" + t + "]", block, spec);
                        }
                    }
                }
            }
            case "cells" -> list(errors, where, value, item -> {
                require(errors, where, item instanceof List<?>, "row");
                if (item instanceof List<?> row) {
                    row.forEach(cell -> part(errors, where + "[cell]", cell, "cell"));
                }
            });
            case "menus" -> list(errors, where, value, item -> part(errors, where + "[menu]", item, "menu"));
            case "cards" -> list(errors, where, value, item -> part(errors, where + "[card]", item, "card"));
            case "tracks" -> list(errors, where, value, item -> part(errors, where + "[track]", item, "track"));
            default -> {
                if (type.equals("map:any")) {
                    require(errors, where, value instanceof Map<?, ?>, type);
                } else if (type.startsWith("map:")) {
                    part(errors, where, value, type.substring(4));
                } else if (type.startsWith("list:")) {
                    String part = type.substring(5);
                    list(errors, where, value, item -> part(errors, where + "[" + part + "]", item, part));
                } else {
                    errors.add(where + ": the schema has no type " + type);
                }
            }
        }
    }

    @SuppressWarnings("unchecked")
    private void part(List<String> errors, String where, Object value, String part) {
        if (!(value instanceof Map<?, ?> map)) {
            errors.add(where + ": not an object");
            return;
        }
        fields(errors, where.endsWith("]") ? where : where + "[" + part + "]", map, (Map<String, Object>) section("parts").get(part));
    }

    private static void list(List<String> errors, String where, Object value, java.util.function.Consumer<Object> each) {
        if (!(value instanceof List<?> list)) {
            errors.add(where + ": not a list");
            return;
        }
        list.forEach(each);
    }

    @SuppressWarnings("unchecked")
    private void runs(List<String> errors, String where, Object value) {
        if (!(value instanceof List<?> list)) {
            errors.add(where + ": runs aren't a list");
            return;
        }
        for (Object run : list) {
            if (run instanceof String) {
                continue;
            }
            if (!(run instanceof Map<?, ?> map) || !(map.get("r") instanceof String r)) {
                errors.add(where + ": a run that's neither text nor a typed run");
                continue;
            }
            Map<String, Object> spec = (Map<String, Object>) section("runs").get(r);
            if (spec == null) {
                errors.add(where + ": unknown run " + r);
            } else {
                fields(errors, where + "[" + r + "]", map, spec);
            }
        }
    }

    private static void require(List<String> errors, String where, boolean ok, String type) {
        if (!ok) {
            errors.add(where + ": not a " + type);
        }
    }
}
