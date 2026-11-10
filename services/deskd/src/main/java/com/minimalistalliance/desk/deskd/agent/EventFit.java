package com.minimalistalliance.desk.deskd.agent;

import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.protocol.Json;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Makes desk-agent's events fit one EVT, which is at most 64 KiB (API.md section 2), while its socket takes up to
 * 4 MiB. A thread's snapshot holds up to 1000 messages, about 1 MiB of JSON at most, and one message up to 100,000
 * characters.
 * <ul>
 *   <li>A {@code delta} too large is split into deltas of at most {@link #DELTA_CHARS} characters, in order, which
 *       append to the same text.</li>
 *   <li>A conversation's {@code snapshot} keeps its newest messages that fit, says how many older ones it left out in
 *       {@code omitted}, and sets {@code older: true}, as desk-agent does for a thread longer than it sent.
 *       {@code agent.thread.get}, whose RES takes 1 MiB, pages through the rest with {@code before}.</li>
 *   <li>A {@code message} too large, or a snapshot's newest message alone, keeps the start of its text that fits, with
 *       {@code truncated: true}.</li>
 * </ul>
 * Anything else too large is dropped, and the caller logs it. Nothing here reads content beyond lengths.
 */
final class EventFit {

    /** An EVT's payload, with room for the frame's own changes to come. */
    static final int LIMIT = FrameKind.EVT.maxMessageBytes() - 256;
    /** Six bytes a character at worst, as JSON escapes a control character: under the limit with room. */
    static final int DELTA_CHARS = 8 * 1024;

    record Event(String type, Map<String, Object> data) {}

    private EventFit() {}

    static int size(String type, Object data) {
        Map<String, Object> event = new LinkedHashMap<>();
        event.put("type", type);
        event.put("data", data);
        return Json.bytes(event).length;
    }

    /** @return the events to publish in place of this one: itself if it fits, none if it can't be made to */
    static List<Event> fit(String type, Map<String, Object> data) {
        if (size(type, data) <= LIMIT) {
            return List.of(new Event(type, data));
        }
        return switch (type) {
            case "delta" -> split(data);
            case "message" -> {
                Map<String, Object> message = Json.object(data, "message");
                if (message == null) {
                    yield List.of();
                }
                Map<String, Object> copy = new LinkedHashMap<>(data);
                copy.put("message", truncated(message, LIMIT - (size(type, Map.of("message", Map.of())))));
                yield List.of(new Event(type, copy));
            }
            case "snapshot" -> data.get("messages") instanceof List<?> ? List.of(new Event(type, snapshot(data))) : List.of();
            default -> List.of();
        };
    }

    /** A conversation snapshot that fits, or the same one if it does already. */
    static Map<String, Object> snapshot(Map<String, Object> data) {
        if (!(data.get("messages") instanceof List<?> messages) || size("snapshot", data) <= LIMIT) {
            return data;
        }
        Map<String, Object> envelope = new LinkedHashMap<>(data);
        envelope.put("messages", List.of());
        envelope.put("omitted", messages.size());
        envelope.put("older", true);
        int budget = LIMIT - size("snapshot", envelope) - 16;
        List<Object> kept = new ArrayList<>();
        int used = 0;
        for (int i = messages.size() - 1; i >= 0; i--) {
            Object message = messages.get(i);
            int length = Json.bytes(message).length + 1;
            if (used + length > budget) {
                if (kept.isEmpty() && message instanceof Map<?, ?>) {
                    @SuppressWarnings("unchecked")
                    Map<String, Object> only = (Map<String, Object>) message;
                    kept.add(truncated(only, budget));
                }
                break;
            }
            kept.add(message);
            used += length;
        }
        List<Object> inOrder = new ArrayList<>(kept.size());
        for (int i = kept.size() - 1; i >= 0; i--) {
            inOrder.add(kept.get(i));
        }
        Map<String, Object> copy = new LinkedHashMap<>(data);
        copy.put("messages", inOrder);
        copy.put("omitted", messages.size() - inOrder.size());
        copy.put("older", true);
        return copy;
    }

    /** The message with as much of the start of its text as fits in {@code budget} bytes of JSON. */
    static Map<String, Object> truncated(Map<String, Object> message, int budget) {
        String text = Json.string(message, "text");
        Map<String, Object> copy = new LinkedHashMap<>(message);
        copy.put("truncated", true);
        if (text == null) {
            copy.remove("text");
            return copy;
        }
        int low = 0;
        int high = text.length();
        while (low < high) {
            int mid = (low + high + 1) >>> 1;
            copy.put("text", cut(text, mid));
            if (Json.bytes(copy).length <= budget) {
                low = mid;
            } else {
                high = mid - 1;
            }
        }
        copy.put("text", cut(text, low));
        return copy;
    }

    private static List<Event> split(Map<String, Object> data) {
        String text = Json.string(data, "text");
        if (text == null) {
            return List.of();
        }
        List<Event> parts = new ArrayList<>();
        int from = 0;
        while (from < text.length()) {
            String piece = cut(text.substring(from), DELTA_CHARS);
            Map<String, Object> copy = new LinkedHashMap<>(data);
            copy.put("text", piece);
            parts.add(new Event("delta", copy));
            from += piece.length();
        }
        return parts;
    }

    /** The first {@code chars} characters, one fewer if that would split a surrogate pair. */
    private static String cut(String text, int chars) {
        if (chars >= text.length()) {
            return text;
        }
        int end = chars > 0 && Character.isHighSurrogate(text.charAt(chars - 1)) ? chars - 1 : chars;
        return text.substring(0, end);
    }
}
