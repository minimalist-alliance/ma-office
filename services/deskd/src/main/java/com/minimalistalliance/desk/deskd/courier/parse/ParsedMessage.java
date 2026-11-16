package com.minimalistalliance.desk.deskd.courier.parse;

import com.minimalistalliance.desk.deskd.courier.store.Norm;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * A message as the store takes it: what {@code desk-parse}'s Courier mode makes of an email's raw bytes (draft ADR
 * "Courier's store", section 4; the sandbox is ADR 0097's), or what a transport that speaks structured messages (the
 * {@code ma} relay, iMessage) hands over directly. deskd never parses MIME itself, and validates this too:
 * {@link #fromWire} is the one way in from the sandbox, and caps and cleans every field, so a sandbox that went wrong
 * can't hand the store anything larger or stranger than these limits.
 *
 * <p>{@code text} is the plain text to show and index; {@code html} is the sanitized HTML, already through the sandbox's
 * allow-list (shown later in a scriptless frame, section 3.1 of the plan), or null.
 *
 * <p>The constructors clean and cap every field, whichever way a message comes (the sandbox's answer, a structured
 * transport, a parser's result), so no path reaches the store with controls, hidden or bidi characters, or more than the
 * limits (Security CS-L2). Cleaning twice changes nothing.
 */
public record ParsedMessage(
        Address from,
        List<Address> replyTo,
        List<Address> to,
        List<Address> cc,
        List<Address> bcc,
        String subject,
        Long date,
        String messageId,
        List<String> inReplyTo,
        List<String> references,
        String listId,
        boolean listUnsubscribe,
        String precedence,
        String autoSubmitted,
        String text,
        boolean textTruncated,
        String html,
        List<Part> attachments,
        List<AuthResult> authResults) {

    public static final int MAX_TEXT = 2 * 1024 * 1024;
    public static final int MAX_HTML = 4 * 1024 * 1024;
    public static final int MAX_ADDRESSES = 500;
    public static final int MAX_PARTS = 2000;
    /** References and In-Reply-To ids kept: the root and the newest, far past what threading reads. */
    public static final int MAX_IDS = 1000;
    /** {@code Authentication-Results} fields kept, topmost first. */
    public static final int MAX_AUTH_RESULTS = 8;

    /**
     * An address and the name beside it. The name is shown, never trusted (draft ADR §3.5). An address holding a hidden
     * character is refused, as {@link #fromWire} refuses it (Security CS-I5), and one that's nothing once cleaned is null;
     * a list leaves either out.
     */
    public record Address(String name, String address) {
        public Address {
            name = Norm.line(name, Norm.MAX_NAME);
            address = Norm.hasHidden(address) ? null : Norm.line(address, Norm.MAX_ADDRESS);
        }
    }

    /**
     * An attachment or inline part: never opened or run on the desk. {@code danger} is the sandbox's name for a type that
     * can't be previewed (program, script, shortcut, disk image, html, macro document, archive with programs), or null.
     */
    public record Part(String part, String name, String type, long bytes, String contentId, boolean inline, String danger) {
        public Part {
            part = Norm.line(part, 64);
            name = Norm.line(name, 255);
            type = Norm.line(type, 127);
            bytes = Math.max(0, bytes);
            contentId = Norm.line(contentId, Norm.MAX_MSGID);
            danger = Norm.line(danger, 32);
        }
    }

    /**
     * One {@code Authentication-Results} field of the message's own header (RFC 8601), as the sandbox read it, in the
     * header's order, topmost first: its authserv-id and the first result of each method, and the domain DMARC was checked
     * for ({@code header.from}). Anyone can write one of these; the store believes only a provider's own, by its authserv-id
     * ({@code Courier.Verdicts.resolve}). Lowercase; a value that isn't a short word is null.
     */
    public record AuthResult(String authServ, String spf, String dkim, String dmarc, String dmarcFrom) {
        private static final java.util.regex.Pattern WORD = java.util.regex.Pattern.compile("[a-z][a-z0-9_-]{0,15}");
        private static final java.util.regex.Pattern HOST = java.util.regex.Pattern.compile("[a-z0-9_](?:[a-z0-9_.-]{0,251}[a-z0-9])?");

        public AuthResult {
            authServ = host(authServ);
            spf = word(spf);
            dkim = word(dkim);
            dmarc = word(dmarc);
            dmarcFrom = host(dmarcFrom);
        }

        private static String word(String s) {
            String t = s == null ? null : s.strip().toLowerCase(java.util.Locale.ROOT);
            return t != null && WORD.matcher(t).matches() ? t : null;
        }

        private static String host(String s) {
            String t = s == null ? null : s.strip().toLowerCase(java.util.Locale.ROOT);
            if (t == null || t.isEmpty() || t.length() > 253 || Norm.hasHidden(t)) {
                return null;
            }
            if (!HOST.matcher(t).matches()) {
                // An internationalized name is compared in punycode.
                try {
                    t = java.net.IDN.toASCII(t, java.net.IDN.ALLOW_UNASSIGNED).toLowerCase(java.util.Locale.ROOT);
                } catch (IllegalArgumentException e) {
                    return null;
                }
                return HOST.matcher(t).matches() ? t : null;
            }
            return t;
        }
    }

    /** Without {@code Authentication-Results}: a structured transport's message, or a parser that reads none. */
    public ParsedMessage(Address from, List<Address> replyTo, List<Address> to, List<Address> cc, List<Address> bcc, String subject,
            Long date, String messageId, List<String> inReplyTo, List<String> references, String listId, boolean listUnsubscribe,
            String precedence, String autoSubmitted, String text, boolean textTruncated, String html, List<Part> attachments) {
        this(from, replyTo, to, cc, bcc, subject, date, messageId, inReplyTo, references, listId, listUnsubscribe, precedence,
                autoSubmitted, text, textTruncated, html, attachments, List.of());
    }

    public ParsedMessage {
        from = from == null || from.address() == null ? null : from;
        replyTo = addresses(replyTo);
        to = addresses(to);
        cc = addresses(cc);
        bcc = addresses(bcc);
        subject = Norm.line(subject, Norm.MAX_SUBJECT);
        messageId = Norm.line(messageId, Norm.MAX_MSGID);
        inReplyTo = ids(inReplyTo);
        references = ids(references);
        listId = Norm.line(listId, 255);
        precedence = Norm.line(precedence, 32);
        autoSubmitted = Norm.line(autoSubmitted, 64);
        textTruncated = textTruncated || (text != null && text.length() > MAX_TEXT);
        text = Norm.clean(text, MAX_TEXT, true);
        html = html != null && html.length() <= MAX_HTML ? html : null;
        attachments = attachments == null ? List.of() : List.copyOf(attachments.subList(0, Math.min(attachments.size(), MAX_PARTS)));
        authResults = authResults == null ? List.of()
                : List.copyOf(authResults.subList(0, Math.min(authResults.size(), MAX_AUTH_RESULTS)).stream()
                        .filter(java.util.Objects::nonNull).toList());
    }

    private static List<Address> addresses(List<Address> list) {
        if (list == null) {
            return List.of();
        }
        List<Address> out = new ArrayList<>(Math.min(list.size(), MAX_ADDRESSES));
        for (Address a : list) {
            if (out.size() >= MAX_ADDRESSES) {
                break;
            }
            if (a != null && a.address() != null) {
                out.add(a);
            }
        }
        return List.copyOf(out);
    }

    private static List<String> ids(List<String> list) {
        if (list == null) {
            return List.of();
        }
        List<String> out = new ArrayList<>();
        for (String id : list) {
            String clean = Norm.line(id, Norm.MAX_MSGID);
            if (clean != null) {
                out.add(clean);
            }
        }
        // Capped as threading reads them (Norm.parents): the root and the newest, which are the ones that count.
        if (out.size() > MAX_IDS) {
            List<String> kept = new ArrayList<>(MAX_IDS);
            kept.add(out.get(0));
            kept.addAll(out.subList(out.size() - (MAX_IDS - 1), out.size()));
            out = kept;
        }
        return List.copyOf(out);
    }

    /** A chat-like message, as {@code ma} and iMessage carry: a sender, recipients and text. */
    public static ParsedMessage chat(Address from, List<Address> to, String text, Long date, List<Part> attachments) {
        return new ParsedMessage(from, List.of(), to, List.of(), List.of(), null, date, null, List.of(), List.of(), null,
                false, null, null, text, false, null, attachments);
    }

    /** No text in logs. */
    @Override
    public String toString() {
        return "ParsedMessage[" + to.size() + " to, " + attachments.size() + " parts]";
    }

    /**
     * The sandbox's answer, as the wire map {@code parse-courier 1} (draft ADR §4): checked and capped field by field.
     * Strings are cleaned of controls, addresses normalized (one that isn't an address is dropped), ids parsed from the
     * headers' own text, and lists cut to their caps.
     *
     * @throws IllegalArgumentException if it isn't an object of that shape, which the store takes as a refusal
     */
    public static ParsedMessage fromWire(Map<String, Object> m) {
        if (m == null || !(m.get("v") instanceof Number v) || v.intValue() != 1) {
            throw new IllegalArgumentException("version");
        }
        Address from = address(m.get("from"));
        String text = m.get("text") instanceof String t ? t : "";
        boolean truncated = Boolean.TRUE.equals(m.get("textTruncated")) || text.length() > MAX_TEXT;
        String cleanText = Norm.clean(text, MAX_TEXT, true);
        String html = m.get("html") instanceof String h && h.length() <= MAX_HTML ? h : null;
        Long date = m.get("date") instanceof Number d && d.longValue() > 0 && d.longValue() < 32_503_680_000_000L ? d.longValue() : null;
        return new ParsedMessage(
                from,
                addresses(m.get("replyTo")),
                addresses(m.get("to")),
                addresses(m.get("cc")),
                addresses(m.get("bcc")),
                Norm.line(str(m.get("subject")), Norm.MAX_SUBJECT),
                date,
                Norm.msgid(str(m.get("messageId"))),
                Norm.msgids(str(m.get("inReplyTo"))),
                Norm.msgids(str(m.get("references"))),
                Norm.line(str(m.get("listId")), 255),
                Boolean.TRUE.equals(m.get("listUnsubscribe")),
                Norm.line(str(m.get("precedence")), 32),
                Norm.line(str(m.get("autoSubmitted")), 64),
                cleanText,
                truncated,
                html,
                parts(m.get("attachments")),
                authResults(m.get("authResults")));
    }

    /** The sandbox's {@code authResults}: up to {@value #MAX_AUTH_RESULTS}, in its order; anything not a map is skipped. */
    private static List<AuthResult> authResults(Object o) {
        List<AuthResult> out = new ArrayList<>();
        if (o instanceof List<?> list) {
            for (Object item : list) {
                if (out.size() >= MAX_AUTH_RESULTS) {
                    break;
                }
                if (item instanceof Map<?, ?> a) {
                    out.add(new AuthResult(str(a.get("authServ")), str(a.get("spf")), str(a.get("dkim")), str(a.get("dmarc")),
                            str(a.get("dmarcFrom"))));
                }
            }
        }
        return out;
    }

    private static String str(Object o) {
        return o instanceof String s ? s : null;
    }

    private static Address address(Object o) {
        if (!(o instanceof Map<?, ?> a)) {
            return null;
        }
        String address = Norm.email(str(a.get("address")));
        if (address == null) {
            return null;
        }
        return new Address(Norm.line(str(a.get("name")), Norm.MAX_NAME), address);
    }

    private static List<Address> addresses(Object o) {
        List<Address> out = new ArrayList<>();
        if (o instanceof List<?> list) {
            for (Object item : list) {
                if (out.size() >= MAX_ADDRESSES) {
                    break;
                }
                Address a = address(item);
                if (a != null) {
                    out.add(a);
                }
            }
        }
        return out;
    }

    private static List<Part> parts(Object o) {
        List<Part> out = new ArrayList<>();
        java.util.Set<String> seen = new java.util.HashSet<>();
        if (o instanceof List<?> list) {
            int n = 0;
            for (Object item : list) {
                if (out.size() >= MAX_PARTS) {
                    break;
                }
                n++;
                if (!(item instanceof Map<?, ?> p)) {
                    continue;
                }
                String part = Norm.line(str(p.get("part")), 64);
                long bytes = p.get("bytes") instanceof Number b && b.longValue() >= 0 ? b.longValue() : 0;
                String id = part == null ? Integer.toString(n) : part;
                if (!seen.add(id)) {
                    // A part id twice is the sandbox's bug: the first stands.
                    continue;
                }
                out.add(new Part(
                        id,
                        Norm.line(str(p.get("name")), 255),
                        Norm.line(str(p.get("type")), 127),
                        bytes,
                        Norm.line(str(p.get("contentId")), Norm.MAX_MSGID),
                        Boolean.TRUE.equals(p.get("inline")),
                        Norm.line(str(p.get("danger")), 32)));
            }
        }
        return out;
    }
}
