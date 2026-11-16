package com.minimalistalliance.desk.deskd.courier.relay;

import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * The signed payloads the relay's transports write and read (draft ADR "Courier's transports" §3; contract 0.4.0 §2.2
 * gives the envelope and the required fields {@code v, kind, id, from, to, at}, the rest is the Desk side's).
 *
 * <p><b>A member's message</b>, kind {@code message}, in an {@code ma} envelope: {@code text} (or the text in a drop,
 * {@code drop}), and optionally {@code subject}, {@code members} (a group: every address it went to, this recipient
 * included), and an email's place in its conversation ({@code rfcMessageId}, {@code inReplyTo}, {@code references}), so a
 * desk-address email to a member's address threads as mail would.
 *
 * <p><b>The mail door's</b>, kind {@code mail}, in a {@code mail} envelope, from {@code mailer-daemon@<courier domain>}
 * (proposed for 0.4.1, draft ADR "Courier's envelopes" §9, with this draft's additions): {@code mailFrom},
 * {@code verdicts} ({@code spf}, {@code dkim}, {@code dmarc}, {@code dmarcDomain}, {@code spam}, {@code virus}) and exactly
 * one of {@code raw} (the message, base64url), {@code drop} (the message in the drop) or {@code note} (a delivery note on
 * a message the desk sent, or a message the door removed).
 *
 * <p>Everything here is read after the signature verified, and read strictly all the same: a field of the wrong type or
 * out of range refuses the payload ({@link Bad}); a field it doesn't know is ignored, so a later sender can add one.
 */
final class Payloads {

    private Payloads() {}

    static final String MESSAGE = "message";
    static final String MAIL = "mail";
    /** A member's text inline up to this many characters; longer goes in the drop. */
    static final int INLINE_TEXT = 48 * 1024;
    /** The longest text a member's message carries in all (the store keeps 2 MiB). */
    static final int MAX_TEXT = 2 * 1024 * 1024;
    static final int MAX_SUBJECT = 998;
    static final int MAX_MEMBERS = 50;
    static final int MAX_REFS = 100;
    static final int MAX_ID = 255;
    static final Set<String> NOTE_STATUSES = Set.of("delivered", "bounced", "complained", "deferred", "suppressed");
    private static final Pattern VERDICT = Pattern.compile("[a-z_]{1,16}");
    private static final Pattern DOMAIN = Pattern.compile("(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z0-9-]{2,63}");

    /** A payload that verified but doesn't read: refused for good. */
    static final class Bad extends Exception {
        private static final long serialVersionUID = 1L;

        Bad(String what) {
            super(what, null, false, false);
        }
    }

    /** RFC 3339 with milliseconds in UTC, as the contract's {@code at}. */
    static String at(long millis) {
        Instant i = Instant.ofEpochMilli(millis).truncatedTo(ChronoUnit.MILLIS);
        String s = i.toString();
        // Instant.toString drops a zero millisecond part: the contract wants three digits always.
        if (s.length() == 20) {
            s = s.substring(0, 19) + ".000Z";
        }
        return s;
    }

    /** The contract's {@code at} as epoch ms (Signed already checked its shape). */
    static long millis(String at) throws Bad {
        try {
            return OffsetDateTime.parse(at).toInstant().toEpochMilli();
        } catch (DateTimeParseException | NullPointerException e) {
            throw new Bad("at");
        }
    }

    // ---- a member's message

    /** What a desk sends: the payload's fields beyond the required ones. */
    record Message(String text, String subject, List<String> members, String rfcMessageId, String inReplyTo, List<String> references,
            Map<String, Object> drop) {
        /** No text in logs. */
        @Override
        public String toString() {
            return "Message[" + (members == null ? 0 : members.size()) + " members]";
        }
    }

    /** The payload map for {@code Signed.wrap}, in the contract's order. */
    static Map<String, Object> message(String id, String from, String to, long at, Message m) {
        Map<String, Object> p = new LinkedHashMap<>();
        p.put("v", 1);
        p.put("kind", MESSAGE);
        p.put("id", id);
        p.put("from", from);
        p.put("to", to);
        p.put("at", at(at));
        if (m.drop() != null) {
            p.put("drop", m.drop());
        } else {
            p.put("text", m.text() == null ? "" : m.text());
        }
        if (m.subject() != null && !m.subject().isBlank()) {
            p.put("subject", m.subject());
        }
        if (m.members() != null && m.members().size() > 1) {
            p.put("members", m.members());
        }
        if (m.rfcMessageId() != null) {
            p.put("rfcMessageId", m.rfcMessageId());
        }
        if (m.inReplyTo() != null) {
            p.put("inReplyTo", m.inReplyTo());
        }
        if (m.references() != null && !m.references().isEmpty()) {
            p.put("references", m.references());
        }
        return p;
    }

    /** Reads a verified {@code message} payload; the text, if it's in a drop, comes separately. */
    static Message readMessage(Map<String, Object> p) throws Bad {
        Object drop = p.get("drop");
        String text = optional(p, "text", INLINE_TEXT + 1024, true);
        if (drop != null && text != null) {
            throw new Bad("text");
        }
        if (drop == null && text == null) {
            throw new Bad("text");
        }
        if (drop != null && !(drop instanceof Map<?, ?>)) {
            throw new Bad("drop");
        }
        String subject = optional(p, "subject", MAX_SUBJECT, false);
        List<String> members = list(p, "members", MAX_MEMBERS);
        if (members != null) {
            for (String a : members) {
                if (Invite.canonical(a) == null || !Invite.canonical(a).equals(a)) {
                    throw new Bad("members");
                }
            }
            if (!members.contains((String) p.get("to"))) {
                throw new Bad("members");
            }
        }
        String rfc = optional(p, "rfcMessageId", MAX_ID, false);
        String inReplyTo = optional(p, "inReplyTo", MAX_ID, false);
        List<String> refs = list(p, "references", MAX_REFS);
        if (refs != null) {
            for (String r : refs) {
                if (r.length() > MAX_ID) {
                    throw new Bad("references");
                }
            }
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> d = (Map<String, Object>) drop;
        return new Message(text, subject, members, rfc, inReplyTo, refs, d);
    }

    // ---- the mail door's

    /** A verified {@code mail} payload. Exactly one of {@code raw}, {@code drop} and {@code note} is set. */
    record Mail(String mailFrom, Map<String, Object> verdicts, byte[] raw, Map<String, Object> drop, Note note) {
        @Override
        public String toString() {
            return "Mail[" + (note != null ? "note" : drop != null ? "drop" : "raw") + "]";
        }
    }

    /**
     * A note from the door: {@code type} {@code delivery} (a message the desk sent: {@code rfcMessageId}, {@code recipient},
     * {@code status}) or {@code removed} (a message to the desk the door took out, with {@code reason}).
     */
    record Note(String type, String rfcMessageId, String recipient, String status, String reason) {}

    static Mail readMail(Map<String, Object> p) throws Bad {
        String mailFrom = p.get("mailFrom") instanceof String s && s.length() <= 320 ? s : null;
        if (p.containsKey("mailFrom") && mailFrom == null && p.get("mailFrom") != null) {
            throw new Bad("mailFrom");
        }
        Map<String, Object> verdicts = p.get("verdicts") instanceof Map<?, ?> v ? verdicts(v) : Map.of();
        int forms = (p.containsKey("raw") ? 1 : 0) + (p.containsKey("drop") ? 1 : 0) + (p.containsKey("note") ? 1 : 0);
        if (forms != 1) {
            throw new Bad("form");
        }
        if (p.containsKey("raw")) {
            if (!(p.get("raw") instanceof String r) || r.isEmpty()) {
                throw new Bad("raw");
            }
            try {
                return new Mail(mailFrom, verdicts, Base64.getUrlDecoder().decode(r), null, null);
            } catch (IllegalArgumentException e) {
                throw new Bad("raw");
            }
        }
        if (p.containsKey("drop")) {
            if (!(p.get("drop") instanceof Map<?, ?> d)) {
                throw new Bad("drop");
            }
            @SuppressWarnings("unchecked")
            Map<String, Object> dm = (Map<String, Object>) d;
            return new Mail(mailFrom, verdicts, null, dm, null);
        }
        if (!(p.get("note") instanceof Map<?, ?> n)) {
            throw new Bad("note");
        }
        String type = n.get("type") instanceof String t ? t : null;
        if ("delivery".equals(type)) {
            String rfc = n.get("rfcMessageId") instanceof String r && !r.isEmpty() && r.length() <= MAX_ID ? r : null;
            String rcpt = n.get("recipient") instanceof String r && !r.isEmpty() && r.length() <= 320 ? r : null;
            String status = n.get("status") instanceof String s && NOTE_STATUSES.contains(s) ? s : null;
            if (rfc == null || rcpt == null || status == null) {
                throw new Bad("note");
            }
            return new Mail(mailFrom, verdicts, null, null, new Note(type, rfc, rcpt, status, null));
        }
        if ("removed".equals(type)) {
            String reason = n.get("reason") instanceof String r && VERDICT.matcher(r).matches() ? r : "removed";
            return new Mail(mailFrom, verdicts, null, null, new Note(type, null, null, null, reason));
        }
        throw new Bad("note");
    }

    /**
     * The door's verdicts, each kept only when it's the expected type: results as lower-case words, {@code spam} and
     * {@code virus} as booleans (or the words SES uses), {@code dmarcDomain} as a domain.
     */
    private static Map<String, Object> verdicts(Map<?, ?> v) {
        Map<String, Object> out = new LinkedHashMap<>();
        for (String k : List.of("spf", "dkim", "dmarc")) {
            if (v.get(k) instanceof String s) {
                String w = s.strip().toLowerCase(Locale.ROOT);
                if (VERDICT.matcher(w).matches()) {
                    out.put(k, w);
                }
            }
        }
        for (String k : List.of("spam", "virus")) {
            Object o = v.get(k);
            if (o instanceof Boolean b) {
                out.put(k, b);
            } else if (o instanceof String s) {
                // SES's words: FAIL means it found spam or a virus.
                out.put(k, "fail".equalsIgnoreCase(s.strip()));
            }
        }
        if (v.get("dmarcDomain") instanceof String d) {
            String w = d.strip().toLowerCase(Locale.ROOT);
            while (w.endsWith(".")) {
                w = w.substring(0, w.length() - 1);
            }
            if (w.length() <= 253 && DOMAIN.matcher(w).matches()) {
                out.put("dmarcDomain", w);
            }
        }
        return out;
    }

    // ---- helpers

    private static String optional(Map<String, Object> p, String key, int max, boolean emptyOk) throws Bad {
        Object o = p.get(key);
        if (o == null) {
            return null;
        }
        if (!(o instanceof String s) || s.length() > max || (!emptyOk && s.isEmpty())) {
            throw new Bad(key);
        }
        return s;
    }

    private static List<String> list(Map<String, Object> p, String key, int max) throws Bad {
        Object o = p.get(key);
        if (o == null) {
            return null;
        }
        if (!(o instanceof List<?> l) || l.isEmpty() || l.size() > max) {
            throw new Bad(key);
        }
        List<String> out = new ArrayList<>(l.size());
        for (Object e : l) {
            if (!(e instanceof String s) || s.isEmpty() || s.length() > 320) {
                throw new Bad(key);
            }
            out.add(s);
        }
        return out;
    }
}
