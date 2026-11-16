package com.minimalistalliance.desk.deskd.courier.imsg.connector;

import com.minimalistalliance.desk.deskd.courier.imsg.ImsgMessage;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * What MA Connector for Mac sends up, read into the {@code imsg} seam's types (the draft ADR "Courier's Mac connector"
 * §B.2). Every field came from the member's Mac, signed by its key, but its content came from whoever wrote the message: the
 * seam's sink checks and cleans each field again, and nothing here is trusted beyond its shape.
 */
final class DevicePayloads {

    /** At most this many messages in a page, and files in a message (the seam's own limit is 50). */
    static final int MAX_MESSAGES = 500;
    static final int MAX_FILES = 50;

    private DevicePayloads() {}

    /** A message of a page, with its place in Messages and each file's drop reference (null when it stayed on the Mac). */
    record Item(long seq, ImsgMessage message, Map<String, Map<String, Object>> drops) {}

    static List<Item> messages(Object list) {
        List<Item> out = new ArrayList<>();
        if (!(list instanceof List<?> l)) {
            return out;
        }
        for (Object o : l) {
            if (out.size() >= MAX_MESSAGES) {
                break;
            }
            if (o instanceof Map<?, ?> m) {
                Item it = item(m);
                if (it != null) {
                    out.add(it);
                }
            }
        }
        return out;
    }

    @SuppressWarnings("unchecked")
    private static Item item(Map<?, ?> m) {
        long seq = m.get("seq") instanceof Number n ? n.longValue() : -1;
        String guid = str(m.get("guid"), 200);
        if (guid == null) {
            return seq >= 0 ? new Item(seq, null, Map.of()) : null;
        }
        long date = m.get("date") instanceof Number n ? n.longValue() : 0;
        boolean fromMe = Boolean.TRUE.equals(m.get("fromMe"));
        ImsgMessage.Chat chat = null;
        if (m.get("chat") instanceof Map<?, ?> c) {
            List<String> people = new ArrayList<>();
            if (c.get("participants") instanceof List<?> ps) {
                for (Object p : ps) {
                    String h = str(p, 320);
                    if (h != null && people.size() < 100) {
                        people.add(h);
                    }
                }
            }
            chat = new ImsgMessage.Chat(str(c.get("guid"), 200), Boolean.TRUE.equals(c.get("group")), str(c.get("name"), 200), people);
        }
        List<ImsgMessage.File> files = new ArrayList<>();
        Map<String, Map<String, Object>> drops = new java.util.HashMap<>();
        if (m.get("files") instanceof List<?> fs) {
            for (Object f : fs) {
                if (files.size() >= MAX_FILES || !(f instanceof Map<?, ?> fm)) {
                    continue;
                }
                String g = str(fm.get("guid"), 200);
                if (g == null) {
                    continue;
                }
                long bytes = fm.get("bytes") instanceof Number n ? n.longValue() : -1;
                files.add(new ImsgMessage.File(g, str(fm.get("name"), 255), str(fm.get("mime"), 100), bytes));
                if (fm.get("drop") instanceof Map<?, ?> d) {
                    drops.put(g, (Map<String, Object>) d);
                }
            }
        }
        ImsgMessage.Reaction reaction = null;
        if (m.get("reaction") instanceof Map<?, ?> r) {
            reaction = new ImsgMessage.Reaction(str(r.get("type"), 32), str(r.get("target"), 210), str(r.get("emoji"), 16));
        }
        ImsgMessage.Event event = null;
        if (m.get("event") instanceof Map<?, ?> e) {
            event = new ImsgMessage.Event(str(e.get("kind"), 16), str(e.get("title"), 200));
        }
        Long edited = m.get("edited") instanceof Number n && n.longValue() > 0 ? n.longValue() : null;
        Long retracted = m.get("retracted") instanceof Number n && n.longValue() > 0 ? n.longValue() : null;
        ImsgMessage im = new ImsgMessage(guid, date, fromMe, fromMe ? null : str(m.get("sender"), 320), str(m.get("senderService"), 16), chat,
                str(m.get("text"), ImsgMessageLimits.TEXT), str(m.get("subject"), 500), files, reaction, event, edited, retracted,
                Boolean.TRUE.equals(m.get("failed")), Boolean.TRUE.equals(m.get("appOnly")));
        return new Item(seq, im, drops);
    }

    static String str(Object o, int max) {
        if (!(o instanceof String s) || s.isEmpty()) {
            return null;
        }
        return s.length() <= max ? s : s.substring(0, max);
    }

    /** The seam's text limit (ImsgSend.MAX_TEXT), the most a message's text may carry in. */
    static final class ImsgMessageLimits {
        static final int TEXT = 20_000;

        private ImsgMessageLimits() {}
    }
}
