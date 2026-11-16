package com.minimalistalliance.desk.deskd.courier.linked;

import com.minimalistalliance.desk.deskd.courier.store.LinkedState;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * The providers the setup screen offers (the launch plan §1.2), with what the transport needs to know of each: servers,
 * how sending saves a Sent copy, the authserv-id its own {@code Authentication-Results} carry (so a sender's forged field
 * is never believed), and how much it lets an IMAP client download a day.
 *
 * <p><b>An authserv-id is set only where it's known.</b> Gmail's ({@code mx.google.com}) is long documented. iCloud's,
 * Yahoo's and Fastmail's are left unset until the real-provider runs record them (the status doc's questions): with none,
 * a provider's mail is "Couldn't confirm", which is safe, never a forged pass taken as true. Microsoft writes its field
 * with no authserv-id, so nothing could tell it from one a sender wrote; and Outlook needs Microsoft sign-in anyway, which
 * is Wave 2.2's.
 */
final class Providers {

    private Providers() {}

    /**
     * @param smtpTls true for TLS from the first byte (465), false for STARTTLS (587)
     * @param savesSent the provider files a submitted message in Sent itself, so no copy is appended
     * @param dailyBytes about what it lets IMAP download a day; the first sync paces itself under it
     * @param oauth only Microsoft or Google sign-in works (Wave 2.2): refused until then
     */
    record Provider(String id, String label, String imapHost, int imapPort, String smtpHost, int smtpPort, boolean smtpTls,
            String authServ, boolean savesSent, long dailyBytes, boolean oauth, String appPasswordUrl) {}

    private static final long MB = 1024L * 1024;

    static final Provider GMAIL = new Provider("gmail", "Gmail", "imap.gmail.com", 993, "smtp.gmail.com", 465, true,
            "mx.google.com", true, 2000 * MB, false, "https://myaccount.google.com/apppasswords");
    static final Provider ICLOUD = new Provider("icloud", "iCloud Mail", "imap.mail.me.com", 993, "smtp.mail.me.com", 587, false,
            null, false, 4000 * MB, false, "https://account.apple.com");
    static final Provider FASTMAIL = new Provider("fastmail", "Fastmail", "imap.fastmail.com", 993, "smtp.fastmail.com", 465, true,
            null, false, 4000 * MB, false, "https://app.fastmail.com/settings/security/apppasswords");
    static final Provider YAHOO = new Provider("yahoo", "Yahoo Mail", "imap.mail.yahoo.com", 993, "smtp.mail.yahoo.com", 465, true,
            null, false, 4000 * MB, false, "https://login.yahoo.com/account/security");
    static final Provider OUTLOOK = new Provider("outlook", "Outlook", "outlook.office365.com", 993, "smtp.office365.com", 587, false,
            null, true, 4000 * MB, true, null);
    /** Any other mailbox: the member's own servers; nothing about it is assumed. */
    static final Provider OTHER = new Provider("other", "Mailbox", null, 993, null, 465, true, null, false, 4000 * MB, false, null);

    static final List<Provider> ALL = List.of(GMAIL, ICLOUD, FASTMAIL, YAHOO, OUTLOOK, OTHER);

    static Provider byId(String id) {
        for (Provider p : ALL) {
            if (p.id().equals(id)) {
                return p;
            }
        }
        return null;
    }

    /** The provider an IMAP host is, or {@link #OTHER}: a member's own settings for a known host still get its rules. */
    static Provider byHost(String imapHost) {
        String h = imapHost == null ? "" : imapHost.toLowerCase(Locale.ROOT);
        for (Provider p : ALL) {
            if (p.imapHost() != null && p.imapHost().equals(h)) {
                return p;
            }
        }
        return OTHER;
    }

    /** The consumer domains each named provider hosts itself. */
    private static final Map<String, Set<String>> DOMAINS = Map.of(
            "gmail", Set.of("gmail.com", "googlemail.com"),
            "icloud", Set.of("icloud.com", "me.com", "mac.com"),
            "fastmail", Set.of("fastmail.com", "fastmail.fm", "fastmail.net", "fastmail.org", "fastmail.us", "fastmail.to",
                    "fastmail.cn", "fastmail.de", "fastmail.es", "fastmail.in", "fastmail.jp", "fastmail.mx", "fastmail.se",
                    "fastmail.co.uk", "fastmail.com.au", "fastmail.ca", "fastmail.nl", "fastmail.no"),
            "yahoo", Set.of("yahoo.com", "ymail.com", "rocketmail.com", "yahoo.co.uk", "yahoo.ca", "yahoo.com.au", "yahoo.fr",
                    "yahoo.de", "yahoo.it", "yahoo.es", "yahoo.in", "yahoo.com.br", "yahoo.com.mx", "yahoo.co.in"),
            "outlook", Set.of("outlook.com", "hotmail.com", "live.com", "msn.com", "hotmail.co.uk", "outlook.co.uk", "hotmail.fr",
                    "outlook.fr", "live.co.uk", "live.ca", "hotmail.de", "outlook.de", "hotmail.it", "outlook.it", "hotmail.es",
                    "outlook.es", "live.com.au", "outlook.com.au"));

    /** The hosts each named provider's MX records end in: a domain of the member's own that the provider hosts. */
    private static final Map<String, List<String>> MX = Map.of(
            "gmail", List.of(".google.com", ".googlemail.com"),
            "icloud", List.of(".mail.icloud.com"),
            "fastmail", List.of(".messagingengine.com"),
            "yahoo", List.of(".yahoodns.net"),
            "outlook", List.of(".protection.outlook.com", ".olc.protection.outlook.com"));

    /**
     * Which named provider an address is at, when the office says nothing of its servers: its domain if the provider hosts
     * it, or else where its mail goes (MX), for a domain of the member's own on Google Workspace, iCloud, Fastmail and the
     * like. Null for anything else, which then needs the member's servers. Only these fixed hosts can come of it: an MX
     * points at nothing the desk connects to.
     */
    static String forAddress(String address, java.util.function.Function<String, List<String>> mx) {
        int at = address == null ? -1 : address.lastIndexOf('@');
        if (at < 0) {
            return null;
        }
        String domain;
        try {
            domain = java.net.IDN.toASCII(address.substring(at + 1), java.net.IDN.USE_STD3_ASCII_RULES).toLowerCase(Locale.ROOT);
        } catch (IllegalArgumentException e) {
            return null;
        }
        if (domain.isEmpty() || !domain.contains(".")) {
            return null;
        }
        for (Map.Entry<String, Set<String>> e : DOMAINS.entrySet()) {
            if (e.getValue().contains(domain)) {
                return e.getKey();
            }
        }
        List<String> hosts = mx == null ? List.of() : mx.apply(domain);
        String found = null;
        for (String h : hosts == null ? List.<String>of() : hosts) {
            String host = h.toLowerCase(Locale.ROOT);
            while (host.endsWith(".")) {
                host = host.substring(0, host.length() - 1);
            }
            String match = null;
            for (Map.Entry<String, List<String>> e : MX.entrySet()) {
                for (String suffix : e.getValue()) {
                    if (host.endsWith(suffix)) {
                        match = e.getKey();
                    }
                }
            }
            if (match == null || (found != null && !found.equals(match))) {
                // Mail that goes anywhere else too (a filter in front, two providers) isn't a named provider's to say.
                return null;
            }
            found = match;
        }
        return found;
    }

    /** A domain's MX hosts from the desk's resolver, 2 s at most; none on any failure. */
    static List<String> mx(String domain) {
        java.util.Hashtable<String, String> env = new java.util.Hashtable<>();
        env.put("java.naming.factory.initial", "com.sun.jndi.dns.DnsContextFactory");
        env.put("com.sun.jndi.dns.timeout.initial", "1000");
        env.put("com.sun.jndi.dns.timeout.retries", "1");
        javax.naming.directory.DirContext ctx = null;
        try {
            ctx = new javax.naming.directory.InitialDirContext(env);
            javax.naming.directory.Attribute a = ctx.getAttributes(domain, new String[] {"MX"}).get("MX");
            List<String> out = new java.util.ArrayList<>();
            for (int i = 0; a != null && i < a.size() && i < 16; i++) {
                String[] parts = String.valueOf(a.get(i)).trim().split("\\s+");
                out.add(parts[parts.length - 1]);
            }
            return out;
        } catch (javax.naming.NamingException | RuntimeException e) {
            return List.of();
        } finally {
            if (ctx != null) {
                try {
                    ctx.close();
                } catch (javax.naming.NamingException ignored) {
                    // nothing held
                }
            }
        }
    }

    /** What the office's setup screen shows: the choices, and where each makes an app password. */
    static List<Map<String, Object>> wire() {
        return ALL.stream().map(p -> {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("provider", p.id());
            m.put("label", p.label());
            m.put("imapHost", p.imapHost());
            m.put("imapPort", p.imapPort());
            m.put("smtpHost", p.smtpHost());
            m.put("smtpPort", p.smtpPort());
            m.put("security", p.smtpTls() ? "tls" : "starttls");
            m.put("signIn", p.oauth() ? "oauth" : "app_password");
            m.put("available", !p.oauth());
            m.put("appPasswordUrl", p.appPasswordUrl());
            return m;
        }).toList();
    }

    // ---- folders

    /** A folder's role from its SPECIAL-USE attribute, its name INBOX, or failing those its common names. */
    static String role(ImapClient.Listed f) {
        Set<String> a = f.attributes();
        if (a.contains("\\sent")) {
            return LinkedState.SENT;
        }
        if (a.contains("\\junk")) {
            return LinkedState.JUNK;
        }
        if (a.contains("\\trash")) {
            return LinkedState.TRASH;
        }
        if (a.contains("\\drafts")) {
            return LinkedState.DRAFTS;
        }
        if (a.contains("\\all")) {
            return LinkedState.ALL;
        }
        if (a.contains("\\archive")) {
            return LinkedState.ARCHIVE;
        }
        if (f.name().equalsIgnoreCase("INBOX")) {
            return LinkedState.INBOX;
        }
        String leaf = leaf(f).toLowerCase(Locale.ROOT);
        return switch (leaf) {
            case "sent", "sent items", "sent messages", "sent mail" -> LinkedState.SENT;
            case "junk", "spam", "junk e-mail", "junk email", "bulk mail", "bulk" -> LinkedState.JUNK;
            case "trash", "deleted items", "deleted messages", "deleted", "bin" -> LinkedState.TRASH;
            case "drafts", "draft" -> LinkedState.DRAFTS;
            case "archive", "archives" -> LinkedState.ARCHIVE;
            default -> LinkedState.OTHER;
        };
    }

    /** Folders that are views of others, or can't be opened: never synced. */
    static boolean skipped(ImapClient.Listed f, boolean gmail) {
        Set<String> a = f.attributes();
        if (a.contains("\\noselect") || a.contains("\\nonexistent")) {
            return true;
        }
        for (char c : f.name().toCharArray()) {
            if (c < 0x20 || c >= 0x7F) {
                // Not a name this client sends back (modified UTF-7 is ASCII); a server that sent raw UTF-8 keeps it to itself.
                return true;
            }
        }
        String role = role(f);
        if (gmail) {
            // Gmail: All Mail holds every message but Spam and Trash, with its labels; Sent first, for who's known.
            return !(role.equals(LinkedState.ALL) || role.equals(LinkedState.SENT) || role.equals(LinkedState.JUNK)
                    || role.equals(LinkedState.TRASH));
        }
        return role.equals(LinkedState.DRAFTS) || role.equals(LinkedState.ALL) || a.contains("\\flagged") || a.contains("\\important");
    }

    /** A folder's own name, its parents left out, decoded for showing. */
    static String leaf(ImapClient.Listed f) {
        String n = Mutf7.decode(f.name());
        String d = f.delimiter();
        if (d != null && !d.isEmpty()) {
            int i = n.lastIndexOf(d);
            if (i >= 0) {
                n = n.substring(i + d.length());
            }
        }
        return n;
    }

    /** A folder's name as a label on its messages: the path decoded, with {@code /} between parts. */
    static String label(ImapClient.Listed f) {
        String n = Mutf7.decode(f.name());
        String d = f.delimiter();
        if (d != null && !d.isEmpty() && !d.equals("/")) {
            n = n.replace(d, "/");
        }
        return n;
    }

    /** Gmail's labels as Courier shows them: the member's own and Starred; the system ones say nothing new here. */
    static String gmailLabels(List<String> labels) {
        if (labels == null) {
            return null;
        }
        StringBuilder out = new StringBuilder();
        for (String l : labels) {
            String t;
            if (l.startsWith("\\")) {
                t = l.equalsIgnoreCase("\\Starred") ? "Starred" : null;
            } else {
                t = Mutf7.decode(l);
            }
            if (t != null && !t.isBlank()) {
                if (!out.isEmpty()) {
                    out.append('\n');
                }
                out.append(t);
            }
        }
        return out.isEmpty() ? null : out.toString();
    }

    static boolean gmailHas(List<String> labels, String label) {
        return labels != null && labels.stream().anyMatch(l -> l.equalsIgnoreCase(label));
    }
}
