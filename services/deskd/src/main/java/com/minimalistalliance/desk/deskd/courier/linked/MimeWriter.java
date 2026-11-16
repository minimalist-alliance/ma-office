package com.minimalistalliance.desk.deskd.courier.linked;

import com.minimalistalliance.desk.deskd.courier.store.Norm;
import com.minimalistalliance.desk.deskd.courier.store.Outbox;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Locale;

/**
 * The member's message as RFC 5322 bytes, for SMTP and the Sent copy: plain text in UTF-8, quoted-printable. Every header
 * is built here from cleaned values: no CR, LF or control character from a subject or a name reaches a header line, a
 * name with anything past ASCII or a special is an encoded word or a quoted string, and every address is checked. No
 * {@code User-Agent} or machine name. The {@code Message-ID} is the one the queue gave the message, the same on every try.
 */
public final class MimeWriter {

    private MimeWriter() {}

    private static final DateTimeFormatter DATE = DateTimeFormatter.ofPattern("EEE, d MMM yyyy HH:mm:ss Z", Locale.ROOT);

    /** A recipient's address as SMTP and the To header take it, or null if it isn't a sendable one. */
    public static String address(String value) {
        String a = Norm.email(value);
        if (a == null) {
            return null;
        }
        int at = a.lastIndexOf('@');
        String local = a.substring(0, at);
        String domain = a.substring(at + 1);
        try {
            domain = java.net.IDN.toASCII(domain, java.net.IDN.ALLOW_UNASSIGNED);
        } catch (IllegalArgumentException e) {
            return null;
        }
        for (int i = 0; i < local.length(); i++) {
            char c = local.charAt(i);
            if (c < 0x21 || c == '"' || c == '\\' || c == '(' || c == ')' || c == '<' || c == '>' || c == '[' || c == ']' || c == ','
                    || c == ';' || c == ':') {
                return null;
            }
        }
        return local + "@" + domain;
    }

    public static byte[] write(String from, Outbox.Outgoing m, Instant now) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        header(out, "Date", DATE.format(now.atOffset(ZoneOffset.UTC)));
        header(out, "From", from);
        List<String> to = new ArrayList<>();
        for (Outbox.Recipient r : m.to()) {
            String a = address(r.value());
            if (a != null) {
                to.add(mailbox(r.name(), a));
            }
        }
        header(out, "To", String.join(", ", to));
        String subject = Norm.line(m.subject(), Norm.MAX_SUBJECT);
        if (subject != null && !subject.isEmpty()) {
            header(out, "Subject", words(subject));
        }
        if (m.rfcMessageId() != null) {
            header(out, "Message-ID", "<" + id(m.rfcMessageId()) + ">");
        }
        if (m.inReplyTo() != null && id(m.inReplyTo()) != null) {
            header(out, "In-Reply-To", "<" + id(m.inReplyTo()) + ">");
        }
        if (!m.references().isEmpty()) {
            List<String> refs = new ArrayList<>();
            List<String> all = m.references();
            // The root and the newest, as mail clients keep them, within one folded header.
            for (int i = 0; i < all.size(); i++) {
                if (i == 0 || i >= all.size() - 20) {
                    String id = id(all.get(i));
                    if (id != null) {
                        refs.add("<" + id + ">");
                    }
                }
            }
            if (!refs.isEmpty()) {
                header(out, "References", String.join(" ", refs));
            }
        }
        header(out, "MIME-Version", "1.0");
        header(out, "Content-Type", "text/plain; charset=UTF-8");
        header(out, "Content-Transfer-Encoding", "quoted-printable");
        out.writeBytes("\r\n".getBytes(StandardCharsets.US_ASCII));
        out.writeBytes(quotedPrintable(m.text() == null ? "" : m.text()));
        return out.toByteArray();
    }

    /** A Message-ID's inside as kept by the store, or null if it holds anything a header can't. */
    private static String id(String s) {
        if (s == null) {
            return null;
        }
        String t = s.strip();
        if (t.startsWith("<") && t.endsWith(">")) {
            t = t.substring(1, t.length() - 1);
        }
        if (t.isEmpty() || t.length() > 250) {
            return null;
        }
        for (int i = 0; i < t.length(); i++) {
            char c = t.charAt(i);
            if (c <= ' ' || c >= 0x7F || c == '<' || c == '>') {
                return null;
            }
        }
        return t;
    }

    private static String mailbox(String name, String address) {
        String n = Norm.line(name, 120);
        if (n == null || n.isBlank()) {
            return address;
        }
        return phrase(n) + " <" + address + ">";
    }

    /** A display name: an atom run as it is, a quoted string for ASCII with specials, an encoded word past ASCII. */
    private static String phrase(String n) {
        boolean ascii = n.chars().allMatch(c -> c >= 0x20 && c < 0x7F);
        if (!ascii) {
            return words(n);
        }
        if (n.chars().allMatch(c -> Character.isLetterOrDigit(c) || c == ' ' || "!#$%&'*+-/=?^_`{|}~".indexOf(c) >= 0)) {
            return n;
        }
        return "\"" + n.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
    }

    /** RFC 2047 B words, each at most 75 characters, never splitting a character. Plain ASCII stays as it is. */
    static String words(String s) {
        if (s.chars().allMatch(c -> c >= 0x20 && c < 0x7F) && !s.contains("=?")) {
            return s;
        }
        List<String> out = new ArrayList<>();
        StringBuilder chunk = new StringBuilder();
        int i = 0;
        while (i < s.length()) {
            int cp = s.codePointAt(i);
            String next = chunk + new String(Character.toChars(cp));
            if (encodedLength(next) > 75 - 12) {
                out.add(word(chunk.toString()));
                chunk.setLength(0);
            }
            chunk.appendCodePoint(cp);
            i += Character.charCount(cp);
        }
        if (!chunk.isEmpty()) {
            out.add(word(chunk.toString()));
        }
        return String.join(" ", out);
    }

    private static int encodedLength(String s) {
        int bytes = s.getBytes(StandardCharsets.UTF_8).length;
        return (bytes + 2) / 3 * 4;
    }

    private static String word(String s) {
        return "=?UTF-8?B?" + Base64.getEncoder().encodeToString(s.getBytes(StandardCharsets.UTF_8)) + "?=";
    }

    /** A header line folded at spaces to stay near 78 characters; no line past 998. */
    private static void header(ByteArrayOutputStream out, String name, String value) {
        String v = value == null ? "" : value.replace("\r", "").replace("\n", " ");
        StringBuilder line = new StringBuilder(name).append(':');
        int col = line.length();
        for (String token : v.split(" ")) {
            if (token.isEmpty()) {
                continue;
            }
            if (col + 1 + token.length() > 78 && col > name.length() + 1) {
                line.append("\r\n");
                col = 0;
            }
            line.append(' ').append(token);
            col += 1 + token.length();
        }
        line.append("\r\n");
        out.writeBytes(line.toString().getBytes(StandardCharsets.UTF_8));
    }

    /** Quoted-printable (RFC 2045 §6.7) of the text's UTF-8, line ends made CRLF, lines at most 76. */
    static byte[] quotedPrintable(String text) {
        String t = text.replace("\r\n", "\n").replace('\r', '\n');
        ByteArrayOutputStream out = new ByteArrayOutputStream(t.length() + 64);
        String[] lines = t.split("\n", -1);
        for (int li = 0; li < lines.length; li++) {
            byte[] b = lines[li].getBytes(StandardCharsets.UTF_8);
            int col = 0;
            for (int i = 0; i < b.length; i++) {
                int c = b[i] & 0xFF;
                boolean last = i == b.length - 1;
                String enc;
                if ((c >= 33 && c <= 126 && c != '=') || (c == ' ' || c == '\t') && !last) {
                    enc = Character.toString((char) c);
                } else {
                    enc = String.format(Locale.ROOT, "=%02X", c);
                }
                if (col + enc.length() > 75) {
                    out.writeBytes("=\r\n".getBytes(StandardCharsets.US_ASCII));
                    col = 0;
                }
                // A line starting with a dot or "From " is safe either way: SMTP stuffs dots, and QP keeps the rest.
                out.writeBytes(enc.getBytes(StandardCharsets.US_ASCII));
                col += enc.length();
            }
            if (li < lines.length - 1 || lines[li].length() > 0) {
                out.writeBytes("\r\n".getBytes(StandardCharsets.US_ASCII));
            }
        }
        return out.toByteArray();
    }
}
