package com.minimalistalliance.desk.deskd.courier.store;

import com.minimalistalliance.desk.deskd.courier.parse.ParsedMessage;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** The types transports, the methods and the agent tools use with {@link CourierStore}. */
public final class Courier {

    private Courier() {}

    /** How a message reached the sink: as it came, caught up after a wake, or brought in from a mailbox's past. */
    public enum Origin {
        LIVE("live"),
        CATCHUP("catchup"),
        BACKFILL("backfill");

        final String wire;

        Origin(String wire) {
            this.wire = wire;
        }
    }

    /**
     * The transport's own findings, which travel with the message: SES's or the provider's spam and virus verdicts, and the
     * SPF, DKIM and DMARC results ({@code pass}, {@code fail}, {@code none}, ...) that decide the sender line (plan §3.5).
     * They come only from the transport's own verifier: SES's verdict, or a linked mailbox's own
     * {@code Authentication-Results} with the provider's authserv-id, never a header the sender wrote. None means
     * unconfirmed. A DMARC pass is also what makes an email from the member's address their own (Security CS-M1).
     *
     * <p><b>A DMARC result counts only for the domain it was for</b> (Security CP-L2's second half, Wave 2.1):
     * {@code dmarcDomain} is the domain the verifier checked ({@code header.from}), and the store keeps a {@code pass} only
     * when it is the parsed From's domain ({@link #resolve}); a pass with no domain, or another one, is {@code unaligned}.
     *
     * <p>{@code authServ}, set by a linked mailbox's transport ({@link #provider}), says the results aren't known yet: the
     * store reads them from the message's own leading {@code Authentication-Results} fields whose authserv-id that provider
     * uses (the sandbox lists them, topmost first), after the parse. A provider with no known authserv-id gives none, so
     * nothing it carries is confirmed.
     */
    public record Verdicts(boolean spam, boolean virus, String spf, String dkim, String dmarc, String dmarcDomain, String authServ) {
        public static final Verdicts NONE = new Verdicts(false, false, null, null, null, null, null);

        /** Results the transport has itself, with no domain: a DMARC pass this way is never confirmed. */
        public Verdicts(boolean spam, boolean virus, String spf, String dkim, String dmarc) {
            this(spam, virus, spf, dkim, dmarc, null, null);
        }

        /**
         * A linked mailbox's: the provider's spam verdict (its Junk folder), and its results read from the message's own
         * {@code Authentication-Results} by the provider's authserv-id ({@code mx.google.com}, or {@code *.example.net} for
         * any host under a domain); null when the provider's isn't known.
         */
        public static Verdicts provider(boolean spam, String authServ) {
            return new Verdicts(spam, false, null, null, null, null, authServ);
        }

        /** Whether the verifier said DMARC passed: on a resolved verdict, for the From's own domain (plan §3.5). */
        public boolean dmarcPassed() {
            return "pass".equalsIgnoreCase(dmarc == null ? null : dmarc.strip());
        }

        /**
         * The results for a message once parsed: a provider's read from the message's topmost {@code Authentication-Results}
         * field alone, and only when it carries the provider's authserv-id. Nothing below it is read or merged in, so a field
         * the sender wrote with the provider's id, which sits below the provider's own, never fills a result the provider
         * left out (Security's CI-M2). Then a DMARC pass is kept only when its domain is the From's. Other media keep what
         * their transport said.
         */
        public static Verdicts resolve(Verdicts v, ParsedMessage m, String medium) {
            if (!"email".equals(medium) || v == null) {
                return v == null ? NONE : v;
            }
            String spf = v.spf();
            String dkim = v.dkim();
            String dmarc = v.dmarc();
            String domain = v.dmarcDomain();
            if (v.authServ() != null) {
                spf = null;
                dkim = null;
                dmarc = null;
                domain = null;
                List<ParsedMessage.AuthResult> all = m == null ? List.of() : m.authResults();
                ParsedMessage.AuthResult top = all.isEmpty() ? null : all.get(0);
                if (top != null && authServMatches(v.authServ(), top.authServ())) {
                    spf = top.spf();
                    dkim = top.dkim();
                    dmarc = top.dmarc();
                    domain = top.dmarc() == null ? null : top.dmarcFrom();
                }
            }
            String from = m == null || m.from() == null ? null : Norm.domain(Norm.email(m.from().address()));
            if ("pass".equalsIgnoreCase(dmarc == null ? null : dmarc.strip()) && !sameDomain(domain, from)) {
                dmarc = "unaligned";
            }
            return new Verdicts(v.spam(), v.virus(), spf, dkim, dmarc, domain, null);
        }

        /** {@code id} is {@code pattern}, or with {@code *.d}, a host under {@code d}; case and a trailing dot aside. */
        public static boolean authServMatches(String pattern, String id) {
            if (pattern == null || id == null) {
                return false;
            }
            String p = trimDot(pattern.strip().toLowerCase(java.util.Locale.ROOT));
            String i = trimDot(id.strip().toLowerCase(java.util.Locale.ROOT));
            if (i.isEmpty()) {
                return false;
            }
            if (p.startsWith("*.")) {
                String base = p.substring(2);
                return !base.isEmpty() && i.endsWith("." + base) && i.length() > base.length() + 1;
            }
            return p.equals(i);
        }

        /** Two domains are the same, compared in ASCII (punycode) and without case or a trailing dot. */
        static boolean sameDomain(String a, String b) {
            String x = ascii(a);
            String y = ascii(b);
            return x != null && y != null && x.equals(y);
        }

        private static String ascii(String d) {
            if (d == null || d.isBlank()) {
                return null;
            }
            String t = trimDot(d.strip());
            try {
                return java.net.IDN.toASCII(t, java.net.IDN.ALLOW_UNASSIGNED).toLowerCase(java.util.Locale.ROOT);
            } catch (IllegalArgumentException e) {
                return null;
            }
        }

        private static String trimDot(String s) {
            String t = s;
            while (t.endsWith(".")) {
                t = t.substring(0, t.length() - 1);
            }
            return t;
        }

        Map<String, Object> wire() {
            java.util.LinkedHashMap<String, Object> m = new java.util.LinkedHashMap<>();
            m.put("spam", spam);
            m.put("virus", virus);
            m.put("spf", Norm.line(spf, 16));
            m.put("dkim", Norm.line(dkim, 16));
            m.put("dmarc", Norm.line(dmarc, 16));
            if (dmarcDomain != null) {
                m.put("dmarcDomain", Norm.line(dmarcDomain, 253));
            }
            if (authServ != null) {
                m.put("authServ", Norm.line(authServ, 255));
            }
            return m;
        }

        /** From {@link #wire}'s map, as a message waiting for the parser kept it; NONE if it isn't one. */
        static Verdicts fromWire(Map<String, Object> a) {
            if (a == null) {
                return NONE;
            }
            return new Verdicts(Boolean.TRUE.equals(a.get("spam")), Boolean.TRUE.equals(a.get("virus")), str(a.get("spf")),
                    str(a.get("dkim")), str(a.get("dmarc")), str(a.get("dmarcDomain")), str(a.get("authServ")));
        }

        private static String str(Object o) {
            return o instanceof String s ? s : null;
        }
    }

    /**
     * One message for the sink. The sink is idempotent on {@code (medium, externalId)} (design §8.4): the same pair twice,
     * after a retry, a re-sync or a wake, is stored once, and the second answer says {@code DUPLICATE} with the first's id.
     *
     * @param accountId an account the store knows ({@link CourierStore#putAccount})
     * @param medium {@code email}, {@code ma}, {@code imessage} or {@code sms}
     * @param externalId the transport's stable id; for email, {@link ExternalIds#email}, which survives a UIDVALIDITY reset
     * @param raw an email's exact bytes, kept as its blob and handed to the parser; null for other media
     * @param parsed for other media, the message; for email, null (the sink asks the parser), or the parser's answer
     * @param seen already read at the source (a linked mailbox's {@code \Seen})
     * @param outgoing the member's own mail, as a Sent folder holds it
     * @param labels the source's folders or labels, shown and searchable
     * @param sentAt when the source says it was sent, for media with no Date header; null to use the message's own
     * @param group a chat medium's group conversation as its source names it (an iMessage group chat), or null: the store
     *     keeps one conversation per group key, whoever joins or leaves it, instead of one per set of members
     */
    public record Inbound(
            String accountId,
            String medium,
            String externalId,
            Origin origin,
            byte[] raw,
            ParsedMessage parsed,
            Verdicts verdicts,
            boolean seen,
            boolean outgoing,
            List<String> labels,
            Long sentAt,
            Group group) {

        public Inbound {
            origin = origin == null ? Origin.LIVE : origin;
            verdicts = verdicts == null ? Verdicts.NONE : verdicts;
            labels = labels == null ? List.of() : List.copyOf(labels);
        }

        /** Without a group: every medium but a chat's group conversation. */
        public Inbound(String accountId, String medium, String externalId, Origin origin, byte[] raw, ParsedMessage parsed,
                Verdicts verdicts, boolean seen, boolean outgoing, List<String> labels, Long sentAt) {
            this(accountId, medium, externalId, origin, raw, parsed, verdicts, seen, outgoing, labels, sentAt, null);
        }

        public static Inbound email(String accountId, String externalId, byte[] raw, Origin origin) {
            return new Inbound(accountId, "email", externalId, origin, raw, null, null, false, false, List.of(), null);
        }

        public static Inbound chat(String accountId, String medium, String externalId, ParsedMessage message, Long sentAt) {
            return new Inbound(accountId, medium, externalId, Origin.LIVE, null, message, null, false, false, List.of(), sentAt);
        }

        public Inbound withParsed(ParsedMessage m) {
            return new Inbound(accountId, medium, externalId, origin, raw, m, verdicts, seen, outgoing, labels, sentAt, group);
        }

        public Inbound withVerdicts(Verdicts v) {
            return new Inbound(accountId, medium, externalId, origin, raw, parsed, v, seen, outgoing, labels, sentAt, group);
        }

        public Inbound asOutgoing() {
            return new Inbound(accountId, medium, externalId, origin, raw, parsed, verdicts, true, true, labels, sentAt, group);
        }

        public Inbound asSeen() {
            return new Inbound(accountId, medium, externalId, origin, raw, parsed, verdicts, true, outgoing, labels, sentAt, group);
        }

        public Inbound withGroup(Group g) {
            return new Inbound(accountId, medium, externalId, origin, raw, parsed, verdicts, seen, outgoing, labels, sentAt, g);
        }

        public Inbound withOrigin(Origin o) {
            return new Inbound(accountId, medium, externalId, o, raw, parsed, verdicts, seen, outgoing, labels, sentAt, group);
        }

        /** With the raw bytes a chat message's files came in (kept as its blob, read by the sandbox when saved). */
        public Inbound withRaw(byte[] bytes) {
            return new Inbound(accountId, medium, externalId, origin, bytes, parsed, verdicts, seen, outgoing, labels, sentAt, group);
        }

        /** No content in logs. */
        @Override
        public String toString() {
            return "Inbound[" + medium + ", " + (raw == null ? 0 : raw.length) + " bytes]";
        }
    }

    /**
     * A chat's group conversation, as its source names it: {@code key} is the transport's own stable name for it (an
     * iMessage chat's guid, hashed with its account), {@code title} the group's name, if it has one. A title given again
     * renames the conversation (a group renamed on the iPhone).
     */
    public record Group(String key, String title) {
        public Group {
            if (key == null || key.isEmpty() || key.length() > 128 || !key.chars().allMatch(ch -> ch > 0x20 && ch < 0x7F)) {
                throw new IllegalArgumentException("group");
            }
            title = Norm.line(title, 120);
        }
    }

    /** A transport's place in its source, committed in the same transaction as the messages it brought. */
    public record CursorUpdate(String accountId, String stream, String value) {}

    /** What the sink did with one message. */
    public record Accepted(Kind kind, String messageId, String reason) {
        public enum Kind {
            /** Stored now. */
            STORED,
            /** Already there: {@code messageId} is the first copy's. */
            DUPLICATE,
            /** Stored with its raw bytes, waiting for the parser. */
            PENDING,
            /** Not stored: {@code reason} says why. The transport may retry later; nothing was kept. */
            REFUSED
        }

        static Accepted stored(String id) {
            return new Accepted(Kind.STORED, id, null);
        }

        static Accepted duplicate(String id) {
            return new Accepted(Kind.DUPLICATE, id, null);
        }

        static Accepted pending(String id) {
            return new Accepted(Kind.PENDING, id, null);
        }

        static Accepted refused(String reason) {
            return new Accepted(Kind.REFUSED, null, reason);
        }

        public boolean kept() {
            return kind != Kind.REFUSED;
        }
    }

    /** An account: never a secret. {@code address} is the member's own and never goes to an agent. */
    public record Account(String id, String kind, String label, String address, String state) {}

    /** What changed in one commit, for {@code courier.changed}. */
    public record Change(Set<String> channels, Set<String> lanes, boolean counts, boolean drafts, boolean outbound,
            boolean accounts) {
        public boolean empty() {
            return channels.isEmpty() && lanes.isEmpty() && !counts && !drafts && !outbound && !accounts;
        }
    }

    /** Collects a commit's changes. Used on the writer's thread only. */
    static final class ChangeSet {
        final Set<String> channels = new LinkedHashSet<>();
        final Set<String> lanes = new LinkedHashSet<>();
        boolean counts;
        boolean drafts;
        boolean outbound;
        boolean accounts;
        /** Messages moved from a lane agents can't see into one they can: they get a new receive time (AgentView). */
        final java.util.List<Long> surfaced = new java.util.ArrayList<>();

        void lane(String channelId, String lane) {
            if (channelId != null) {
                channels.add(channelId);
            }
            if (lane != null) {
                lanes.add(lane);
            }
            counts = true;
        }

        Change done() {
            return new Change(Set.copyOf(channels), Set.copyOf(lanes), counts, drafts, outbound, accounts);
        }
    }

    /** Hears each commit's changes, after the commit, on the writer's thread: it must only queue work. */
    @FunctionalInterface
    public interface ChangeListener {
        void changed(Change change);
    }
}
