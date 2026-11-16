package com.minimalistalliance.desk.deskd.courier.imsg.bluebubbles;

import com.minimalistalliance.desk.deskd.courier.imsg.ImsgMessage;
import com.minimalistalliance.desk.deskd.courier.store.ImessageState;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * BlueBubbles Server's JSON as the {@code imsg} seam's {@link ImsgMessage} and the store's contact cards. Untrusted: a
 * field of the wrong type is a missing one, and everything is checked again by {@code ImsgSink} and the store.
 */
final class BlueBubblesJson {

    private BlueBubblesJson() {}

    /** A message as the REST API and the socket give it (with {@code chat}, {@code chat.participants}, {@code attachment}, {@code handle}). */
    static ImsgMessage message(Map<String, Object> m) {
        String guid = str(m.get("guid"));
        Long date = num(m.get("dateCreated"));
        if (guid == null || date == null) {
            return null;
        }
        boolean fromMe = Boolean.TRUE.equals(m.get("isFromMe"));
        Map<String, Object> handle = map(m.get("handle"));
        ImsgMessage.Chat chat = null;
        if (m.get("chats") instanceof List<?> cs && !cs.isEmpty() && map(cs.get(0)) != null) {
            Map<String, Object> c = map(cs.get(0));
            List<String> people = new ArrayList<>();
            if (c.get("participants") instanceof List<?> ps) {
                for (Object p : ps) {
                    Map<String, Object> pm = map(p);
                    String a = pm == null ? null : str(pm.get("address"));
                    if (a != null && people.size() < 500) {
                        people.add(a);
                    }
                }
            }
            String cg = str(c.get("guid"));
            chat = new ImsgMessage.Chat(cg, Long.valueOf(43).equals(num(c.get("style"))) || (cg != null && cg.contains(";+;")),
                    str(c.get("displayName")), people);
        }
        List<ImsgMessage.File> files = new ArrayList<>();
        if (m.get("attachments") instanceof List<?> atts) {
            for (Object o : atts) {
                Map<String, Object> a = map(o);
                if (a == null || Boolean.TRUE.equals(a.get("hideAttachment"))) {
                    continue;
                }
                Long bytes = num(a.get("totalBytes"));
                files.add(new ImsgMessage.File(str(a.get("guid")), str(a.get("transferName")), str(a.get("mimeType")),
                        bytes == null ? -1 : bytes));
                if (files.size() >= 50) {
                    break;
                }
            }
        }
        ImsgMessage.Reaction reaction = null;
        String assoc = str(m.get("associatedMessageGuid"));
        Object assocType = m.get("associatedMessageType");
        String type = reactionType(assocType);
        if (assoc != null && type != null) {
            reaction = new ImsgMessage.Reaction(type, assoc, str(m.get("associatedMessageEmoji")));
        } else if ("sticker-message".equals(type)) {
            reaction = new ImsgMessage.Reaction(type, null, null);
        }
        ImsgMessage.Event event = null;
        Long itemType = num(m.get("itemType"));
        if (itemType != null && itemType != 0) {
            Long action = num(m.get("groupActionType"));
            String kind = switch (itemType.intValue()) {
                case 1 -> action != null && action == 1 ? "removed" : "added";
                case 2 -> "named";
                case 3 -> "left";
                default -> "other";
            };
            event = new ImsgMessage.Event(kind, str(m.get("groupTitle")));
        }
        Long error = num(m.get("error"));
        String text = str(m.get("text"));
        boolean app = str(m.get("balloonBundleId")) != null && (text == null || text.isBlank());
        return new ImsgMessage(guid, date, fromMe, fromMe || handle == null ? null : str(handle.get("address")),
                handle == null ? null : str(handle.get("service")), chat, text, str(m.get("subject")), files, reaction, event,
                positive(num(m.get("dateEdited"))), positive(num(m.get("dateRetracted"))), fromMe && error != null && error != 0, app);
    }

    /**
     * A tapback's type in the seam's words: Messages' numbers (2000 to 2007, their removals 3000 to 3007, a sticker on its own
     * 1000) or BlueBubbles' own names ({@code love}, {@code -love}); null for none.
     */
    static String reactionType(Object t) {
        if (t == null) {
            return null;
        }
        String s = t instanceof Number n ? Long.toString(n.longValue()) : t instanceof String w ? w.strip().toLowerCase(Locale.ROOT) : "";
        if (s.isEmpty() || s.equals("0")) {
            return null;
        }
        if (s.matches("[0-9]{1,6}")) {
            int code = Integer.parseInt(s);
            String[] names = {"love", "like", "dislike", "laugh", "emphasize", "question", "emoji", "sticker"};
            if (code == 1000) {
                return "sticker-message";
            }
            if (code >= 2000 && code <= 2007) {
                return names[code - 2000];
            }
            if (code >= 3000 && code <= 3007) {
                return "-" + names[code - 3000];
            }
            return "other";
        }
        return s.length() > 32 ? "other" : s;
    }

    /** The Mac's contact cards, as {@code GET /api/v1/contact} lists them. */
    static List<ImessageState.Card> cards(List<Map<String, Object>> contacts) {
        List<ImessageState.Card> out = new ArrayList<>();
        for (Map<String, Object> c : contacts) {
            if (out.size() >= ImessageState.MAX_CARDS) {
                break;
            }
            String name = str(c.get("displayName"));
            if (name == null || name.isBlank()) {
                String first = str(c.get("firstName"));
                String last = str(c.get("lastName"));
                name = ((first == null ? "" : first) + " " + (last == null ? "" : last)).strip();
                if (name.isEmpty()) {
                    name = str(c.get("nickname"));
                }
            }
            out.add(new ImessageState.Card(name, addresses(c.get("phoneNumbers")), addresses(c.get("emails"))));
        }
        return out;
    }

    private static List<String> addresses(Object o) {
        List<String> out = new ArrayList<>();
        if (o instanceof List<?> l) {
            for (Object x : l) {
                String a = x instanceof String s ? s : map(x) == null ? null : str(map(x).get("address"));
                if (a != null && out.size() < ImessageState.MAX_CARD_ENDPOINTS) {
                    out.add(a);
                }
            }
        }
        return out;
    }

    private static Long positive(Long v) {
        return v == null || v <= 0 ? null : v;
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> map(Object o) {
        return o instanceof Map<?, ?> m ? (Map<String, Object>) m : null;
    }

    static String str(Object o) {
        return o instanceof String s ? s : null;
    }

    static Long num(Object o) {
        return o instanceof Number n ? n.longValue() : null;
    }
}
