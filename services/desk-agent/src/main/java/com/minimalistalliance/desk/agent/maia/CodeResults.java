package com.minimalistalliance.desk.agent.maia;

import com.minimalistalliance.desk.agent.json.Json;
import com.minimalistalliance.desk.agent.json.JsonFormatException;
import java.nio.charset.StandardCharsets;
import java.util.Map;

/**
 * A deskd tool's result as Maia's code reads it back: the model's text form is the JSON, or, for untrusted content,
 * a labelled fence around {@code {source, content}} whose {@code content} is the JSON ({@code AgentTools.fenced}).
 */
final class CodeResults {

    private CodeResults() {}

    /** The result's JSON object, unwrapped from a fence if it has one, or null. */
    @SuppressWarnings("unchecked")
    static Map<String, Object> object(Object content) {
        if (content instanceof Map<?, ?> m) {
            return (Map<String, Object>) m;
        }
        if (!(content instanceof String text)) {
            return null;
        }
        String json = text;
        if (text.startsWith("Untrusted content from ")) {
            int nl = text.indexOf('\n');
            if (nl < 0) {
                return null;
            }
            Map<String, Object> fence = parse(text.substring(nl + 1));
            if (fence == null || !(fence.get("content") instanceof String inner)) {
                return null;
            }
            json = inner;
        }
        return parse(json);
    }

    static Map<String, Object> parse(String json) {
        try {
            return Json.parseObject(json.getBytes(StandardCharsets.UTF_8));
        } catch (JsonFormatException | RuntimeException e) {
            return null;
        }
    }
}
