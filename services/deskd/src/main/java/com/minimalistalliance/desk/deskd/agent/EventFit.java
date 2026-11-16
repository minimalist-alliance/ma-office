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
 *   <li>A conversation's {@code snapshot} keeps its newest messages that fit, with their {@code approvals} (§18: each
 *       message and its approvals go together, and an approval of a message left out goes too), says how many older
 *       ones it left out in {@code omitted}, and sets {@code older: true}, as desk-agent does for a thread longer than it
 *       sent. {@code agent.thread.get}, whose RES takes 1 MiB, pages through the rest with {@code before}.</li>
 *   <li>A {@code message} too large, or a snapshot's newest message alone, keeps the start of its text that fits, with
 *       {@code truncated: true}; the newest alone's approvals first lose their payloads ({@code payloadOmitted}, as
 *       desk-agent's events do over 32 KiB: {@code agent.approval.get} has them), and go only if even then they don't
 *       fit.</li>
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
        List<?> approvals = data.get("approvals") instanceof List<?> list ? list : null;
        Map<Object, List<Object>> byMessage = new LinkedHashMap<>();
        if (approvals != null) {
            for (Object a : approvals) {
                Object messageId = a instanceof Map<?, ?> m ? m.get("messageId") : null;
                byMessage.computeIfAbsent(messageId, k -> new ArrayList<>()).add(a);
            }
        }
        Map<String, Object> envelope = new LinkedHashMap<>(data);
        envelope.put("messages", List.of());
        if (approvals != null) {
            envelope.put("approvals", List.of());
        }
        envelope.put("omitted", messages.size());
        envelope.put("older", true);
        int budget = LIMIT - size("snapshot", envelope) - 16;
        List<Object> kept = new ArrayList<>();
        List<List<Object>> keptApprovals = new ArrayList<>();
        int used = 0;
        for (int i = messages.size() - 1; i >= 0; i--) {
            Object message = messages.get(i);
            Object id = message instanceof Map<?, ?> m ? m.get("id") : null;
            List<Object> its = id == null ? List.of() : byMessage.getOrDefault(id, List.of());
            int length = Json.bytes(message).length + 1 + (its.isEmpty() ? 0 : Json.bytes(its).length + 1);
            if (used + length > budget) {
                if (kept.isEmpty() && message instanceof Map<?, ?>) {
                    @SuppressWarnings("unchecked")
                    Map<String, Object> only = new LinkedHashMap<>((Map<String, Object>) message);
                    List<Object> light = withoutPayloads(its);
                    if (only.get("approvals") instanceof List<?> own) {
                        only.put("approvals", withoutPayloads(own));
                    }
                    int lightBytes = light.isEmpty() ? 0 : Json.bytes(light).length + 1;
                    // The reply carries its own copy too (Security's RF-L1): both, with room for its text's start.
                    if (2 * lightBytes > budget - budget / 4) {
                        // Too many even without payloads: the start of the message alone, which says truncated, so
                        // the app reads the whole page with agent.thread.get.
                        only.remove("approvals");
                        light = List.of();
                        lightBytes = 0;
                    }
                    kept.add(truncated(only, budget - lightBytes));
                    keptApprovals.add(light);
                }
                break;
            }
            kept.add(message);
            keptApprovals.add(its);
            used += length;
        }
        List<Object> inOrder = new ArrayList<>(kept.size());
        List<Object> approvalsInOrder = new ArrayList<>();
        for (int i = kept.size() - 1; i >= 0; i--) {
            inOrder.add(kept.get(i));
            approvalsInOrder.addAll(keptApprovals.get(i));
        }
        Map<String, Object> copy = new LinkedHashMap<>(data);
        copy.put("messages", inOrder);
        if (approvals != null) {
            copy.put("approvals", approvalsInOrder);
        }
        copy.put("omitted", messages.size() - inOrder.size());
        copy.put("older", true);
        return copy;
    }

    /** Approvals as an event carries them over 32 KiB: {@code payload} null and {@code payloadOmitted: true}. */
    private static List<Object> withoutPayloads(List<?> approvals) {
        List<Object> out = new ArrayList<>(approvals.size());
        for (Object a : approvals) {
            if (a instanceof Map<?, ?> m && m.get("payload") != null) {
                @SuppressWarnings("unchecked")
                Map<String, Object> copy = new LinkedHashMap<>((Map<String, Object>) m);
                copy.put("payload", null);
                copy.put("payloadOmitted", true);
                out.add(copy);
            } else {
                out.add(a);
            }
        }
        return out;
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
