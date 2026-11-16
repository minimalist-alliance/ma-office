package com.minimalistalliance.desk.courier.testkit;

import jakarta.mail.BodyPart;
import jakarta.mail.MessagingException;
import jakarta.mail.Multipart;
import jakarta.mail.Part;
import jakarta.mail.Session;
import jakarta.mail.internet.InternetAddress;
import jakarta.mail.internet.MimeMessage;
import jakarta.mail.internet.MimeBodyPart;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Properties;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * An independent reader for checking the corpus's expectations: Jakarta Mail (the Angus implementation GreenMail
 * brings), with the corpus's rules for which part is the body and what counts as an attachment written out here again.
 * It isn't the parser under test; it's a second opinion on the {@link MimeCorpus.Expect}s.
 */
final class Oracle {

    static final Session SESSION;

    static {
        Properties p = new Properties();
        p.setProperty("mail.mime.allowutf8", "true");
        p.setProperty("mail.mime.address.strict", "false");
        p.setProperty("mail.mime.parameters.strict", "false");
        p.setProperty("mail.mime.multipart.ignoremissingendboundary", "true");
        SESSION = Session.getInstance(p);
    }

    private Oracle() {
    }

    static MimeMessage parse(byte[] raw) throws MessagingException {
        return new MimeMessage(SESSION, new ByteArrayInputStream(raw));
    }

    /** What the oracle reads: subject, sender, attachments by the corpus's rule, and the body's text. */
    record Read(String subject, String from, int attachments, String text) {
    }

    static Read read(byte[] raw) throws MessagingException, IOException {
        MimeMessage m = parse(raw);
        String fromHeader = m.getHeader("From", ",");
        String from = "nobody@invalid";
        if (fromHeader != null) {
            InternetAddress[] a = InternetAddress.parseHeader(fromHeader, false);
            if (a.length > 0 && a[0].isGroup()) {
                // A group's first mailbox is the sender.
                a = a[0].getGroup(false);
            }
            if (a != null && a.length > 0 && a[0].getAddress() != null) {
                from = a[0].getAddress().toLowerCase(Locale.ROOT);
            }
        }
        List<Part> leaves = new ArrayList<>();
        leaves(m, leaves);
        Part plain = null;
        Part html = null;
        for (Part p : leaves) {
            if (body(p, "text/plain") && plain == null) {
                plain = p;
            }
            if (body(p, "text/html") && html == null) {
                html = p;
            }
        }
        int attachments = 0;
        for (Part p : leaves) {
            if (p != plain && p != html && !Part.INLINE.equalsIgnoreCase(disposition(p))) {
                attachments++;
            }
        }
        String text = plain != null ? text(plain) : html != null ? visible(text(html)) : "";
        return new Read(m.getSubject(), from, attachments, text);
    }

    /**
     * A text part's text. A charset Java doesn't have, or a transfer encoding nobody knows, falls back to the bytes as
     * Latin-1, as a parser should rather than lose the part: its ASCII words still read.
     */
    private static String text(Part p) throws MessagingException, IOException {
        try {
            return (String) p.getContent();
        } catch (IOException e) {
            byte[] bytes;
            try (InputStream in = p.getInputStream()) {
                bytes = in.readAllBytes();
            } catch (IOException | MessagingException unknownEncoding) {
                try (InputStream in = p instanceof MimeBodyPart b ? b.getRawInputStream() : ((MimeMessage) p).getRawInputStream()) {
                    bytes = in.readAllBytes();
                }
            }
            return new String(bytes, StandardCharsets.ISO_8859_1);
        }
    }

    /** The leaves in document order; a message/rfc822 part is a leaf. */
    static void leaves(Part p, List<Part> out) throws MessagingException, IOException {
        if (p.isMimeType("multipart/*")) {
            Multipart mp = (Multipart) p.getContent();
            for (int i = 0; i < mp.getCount(); i++) {
                leaves(mp.getBodyPart(i), out);
            }
        } else {
            out.add(p);
        }
    }

    private static boolean body(Part p, String type) throws MessagingException {
        return p.isMimeType(type) && p.getFileName() == null && !Part.ATTACHMENT.equalsIgnoreCase(disposition(p));
    }

    private static String disposition(Part p) throws MessagingException {
        try {
            return p.getDisposition();
        } catch (MessagingException e) {
            return null;
        }
    }

    private static final Map<String, String> ENTITIES = Map.ofEntries(Map.entry("nbsp", " "), Map.entry("lt", "<"), Map.entry("gt", ">"),
            Map.entry("quot", "\""), Map.entry("apos", "'"), Map.entry("amp", "&"), Map.entry("eacute", "\u00e9"), Map.entry("egrave", "\u00e8"),
            Map.entry("ecirc", "\u00ea"), Map.entry("agrave", "\u00e0"), Map.entry("acirc", "\u00e2"), Map.entry("ucirc", "\u00fb"),
            Map.entry("uuml", "\u00fc"), Map.entry("ouml", "\u00f6"), Map.entry("auml", "\u00e4"), Map.entry("ccedil", "\u00e7"),
            Map.entry("szlig", "\u00df"), Map.entry("mdash", "\u2014"), Map.entry("ndash", "\u2013"), Map.entry("hellip", "\u2026"),
            Map.entry("euro", "\u20ac"), Map.entry("copy", "\u00a9"), Map.entry("reg", "\u00ae"));
    private static final Pattern ENTITY = Pattern.compile("&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);");

    /** HTML to its visible text, roughly: comments, scripts and styles out, tags to spaces, entities decoded. */
    static String visible(String html) {
        String text = html.replaceAll("(?s)<!--.*?-->", " ").replaceAll("(?is)<(script|style)\\b.*?</\\1\\s*>", " ").replaceAll("(?s)<[^>]*>", " ");
        Matcher m = ENTITY.matcher(text);
        StringBuilder out = new StringBuilder();
        while (m.find()) {
            String e = m.group(1);
            String r = e.startsWith("#x") || e.startsWith("#X") ? Character.toString(Integer.parseInt(e.substring(2), 16))
                    : e.startsWith("#") ? Character.toString(Integer.parseInt(e.substring(1))) : ENTITIES.getOrDefault(e, m.group());
            m.appendReplacement(out, Matcher.quoteReplacement(r));
        }
        m.appendTail(out);
        return out.toString();
    }

    /** Multiparts nested inside one another along the deepest path, the message's own counted. */
    static int multipartDepth(Part p) throws MessagingException, IOException {
        if (!p.isMimeType("multipart/*")) {
            return 0;
        }
        Multipart mp = (Multipart) p.getContent();
        int deepest = 0;
        for (int i = 0; i < mp.getCount(); i++) {
            deepest = Math.max(deepest, multipartDepth(mp.getBodyPart(i)));
        }
        return 1 + deepest;
    }

    /** Every MIME entity: the message, each multipart and each leaf. */
    static int entities(Part p) throws MessagingException, IOException {
        if (!p.isMimeType("multipart/*")) {
            return 1;
        }
        Multipart mp = (Multipart) p.getContent();
        int n = 1;
        for (int i = 0; i < mp.getCount(); i++) {
            BodyPart b = mp.getBodyPart(i);
            n += entities(b);
        }
        return n;
    }
}
