package com.minimalistalliance.desk.courier.parse;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Date;
import java.util.Deque;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.apache.james.mime4j.MimeException;
import org.apache.james.mime4j.codec.DecodeMonitor;
import org.apache.james.mime4j.codec.DecoderUtil;
import org.apache.james.mime4j.dom.address.Address;
import org.apache.james.mime4j.dom.address.AddressList;
import org.apache.james.mime4j.dom.address.Group;
import org.apache.james.mime4j.dom.address.Mailbox;
import org.apache.james.mime4j.dom.field.DateTimeField;
import org.apache.james.mime4j.field.DateTimeFieldLenientImpl;
import org.apache.james.mime4j.field.address.LenientAddressParser;
import org.apache.james.mime4j.io.MaxNestingDepthLimitException;
import org.apache.james.mime4j.io.MaxPartCountLimitException;
import org.apache.james.mime4j.message.DefaultBodyDescriptorBuilder;
import org.apache.james.mime4j.message.MaximalBodyDescriptor;
import org.apache.james.mime4j.parser.ContentHandler;
import org.apache.james.mime4j.parser.MimeStreamParser;
import org.apache.james.mime4j.stream.BodyDescriptor;
import org.apache.james.mime4j.stream.Field;
import org.apache.james.mime4j.stream.MimeConfig;
import org.apache.james.mime4j.stream.RawField;
import org.apache.james.mime4j.util.ByteArrayBuffer;
import org.apache.james.mime4j.stream.ParserCursor;

/**
 * An email's raw bytes walked once, as they stream in, with Apache James mime4j's streaming parser: lenient as mail
 * clients are, and within the plan's limits by its own count ({@link Limits}), so a message over one is refused, never
 * half read. Nested messages ({@code message/rfc822}) are attachments, not walked into.
 *
 * <p>Part ids are IMAP's section numbers: a message that isn't multipart has one part, {@code 1}; a multipart's children
 * are {@code 1}, {@code 2} and so on, and theirs {@code 2.1}, {@code 2.2}. The same bytes always give the same ids, and a
 * mail transport can fetch a part by its id.
 */
final class Mime {

    private Mime() {}

    /** The time a parse may take, checked as the bytes come and at each part. */
    static final class Deadline {
        private final long end;

        Deadline(long millis) {
            this.end = System.nanoTime() + millis * 1_000_000L;
        }

        static Deadline none() {
            return new Deadline(365L * 24 * 3600 * 1000);
        }

        void check() {
            if (System.nanoTime() > end) {
                throw new Refusal(Refusal.TIMEOUT);
            }
        }

        /** Milliseconds left, at least 1. */
        long left() {
            return Math.max(1, (end - System.nanoTime()) / 1_000_000L);
        }
    }

    /** The raw message, counted against {@link Limits#MAX_BYTES} and the deadline as it's read. */
    static final class Counted extends InputStream {
        private final InputStream in;
        private final Deadline deadline;
        private long count;

        Counted(InputStream in, Deadline deadline) {
            this.in = in;
            this.deadline = deadline;
        }

        @Override
        public int read() throws IOException {
            byte[] one = new byte[1];
            return read(one, 0, 1) < 0 ? -1 : one[0] & 0xFF;
        }

        @Override
        public int read(byte[] b, int off, int len) throws IOException {
            deadline.check();
            int n = in.read(b, off, len);
            if (n > 0) {
                count += n;
                if (count > Limits.MAX_BYTES) {
                    throw new Refusal(Refusal.TOO_LARGE);
                }
            }
            return n;
        }

        long count() {
            return count;
        }
    }

    private static MimeConfig config() {
        return new MimeConfig.Builder()
                .setStrictParsing(false)
                .setMalformedHeaderStartsBody(false)
                .setMaxLineLen(-1)
                .setMaxHeaderCount(2000)
                .setMaxHeaderLen(1 << 20)
                .setMaxTotalHeaderCount(Limits.MAX_PARTS * 30)
                .setMaxTotalHeaderLen(16L << 20)
                .setMaxContentLen(-1)
                .setMaxPartCount(Limits.MAX_PARTS + 10)
                .setMaxNestingDepth(Limits.MAX_DEPTH + 5)
                .build();
    }

    /** What the walk does with each leaf. */
    private interface Leaf {
        void body(String id, MaximalBodyDescriptor d, boolean inRelated, InputStream in) throws IOException;
    }

    /** The walk: counts, depth, ids, the message's own header, and each leaf handed to {@code leaf}. */
    private static final class Walker implements ContentHandler {
        private record Frame(String prefix, boolean related, int[] children) {}

        final Map<String, String> header = new HashMap<>();
        final Map<String, Integer> headerCount = new HashMap<>();
        /** The message's own Authentication-Results fields, topmost first, up to {@link AuthResults#MAX}. */
        final List<String> authResults = new ArrayList<>();
        private final Deque<Frame> frames = new ArrayDeque<>();
        private final Leaf leaf;
        private final Deadline deadline;
        private String current;
        private boolean rootHeader;
        private int entities;
        boolean stopped;
        MimeStreamParser parser;

        Walker(Leaf leaf, Deadline deadline) {
            this.leaf = leaf;
            this.deadline = deadline;
        }

        @Override
        public void startMessage() {
            if (entities == 0) {
                entities = 1;
                rootHeader = true;
            }
        }

        @Override
        public void endMessage() {}

        @Override
        public void startBodyPart() {
            deadline.check();
            if (++entities > Limits.MAX_PARTS) {
                throw new Refusal(Refusal.TOO_MANY_PARTS);
            }
            rootHeader = false;
            Frame top = frames.peek();
            int n = ++top.children()[0];
            current = top.prefix().isEmpty() ? Integer.toString(n) : top.prefix() + "." + n;
        }

        @Override
        public void endBodyPart() {}

        @Override
        public void startHeader() {}

        @Override
        public void field(Field field) {
            if (!rootHeader) {
                return;
            }
            String name = field.getName() == null ? "" : field.getName().strip().toLowerCase(Locale.ROOT);
            if (name.equals(AuthResults.FIELD)) {
                if (authResults.size() < AuthResults.MAX) {
                    authResults.add(Headers.text(field));
                }
                return;
            }
            if (!WANTED.contains(name)) {
                return;
            }
            headerCount.merge(name, 1, Integer::sum);
            // The first of a name wins, as most clients show it.
            header.putIfAbsent(name, Headers.text(field));
        }

        @Override
        public void endHeader() {
            rootHeader = false;
        }

        @Override
        public void preamble(InputStream is) throws IOException {
            drain(is);
        }

        @Override
        public void epilogue(InputStream is) throws IOException {
            drain(is);
        }

        @Override
        public void startMultipart(BodyDescriptor bd) {
            deadline.check();
            if (frames.size() + 1 > Limits.MAX_DEPTH) {
                throw new Refusal(Refusal.TOO_DEEP);
            }
            String sub = bd.getMimeType() == null ? "" : bd.getMimeType().toLowerCase(Locale.ROOT);
            frames.push(new Frame(current == null ? "" : current, sub.equals("multipart/related"), new int[1]));
        }

        @Override
        public void endMultipart() {
            frames.pop();
        }

        @Override
        public void body(BodyDescriptor bd, InputStream is) throws IOException {
            deadline.check();
            if (stopped) {
                drain(is);
                return;
            }
            String id = current == null ? "1" : current;
            boolean related = !frames.isEmpty() && frames.peek().related();
            leaf.body(id, (MaximalBodyDescriptor) bd, related, is);
            drain(is);
        }

        @Override
        public void raw(InputStream is) throws IOException {
            drain(is);
        }

        void stop() {
            stopped = true;
        }

        private void drain(InputStream is) throws IOException {
            byte[] skip = new byte[8192];
            while (is.read(skip) >= 0) {
                deadline.check();
            }
        }
    }

    private static final java.util.Set<String> WANTED = java.util.Set.of("from", "reply-to", "to", "cc", "bcc", "subject",
            "date", "message-id", "in-reply-to", "references", "list-id", "list-unsubscribe", "precedence", "auto-submitted");

    /** What the last walk on this thread that ended {@code malformed} failed on, for the fuzzer's triage; never logged. */
    static final ThreadLocal<Throwable> LAST_FAILURE = new ThreadLocal<>();

    /** Runs the walk over {@code in}, mapping mime4j's own refusals onto ours. */
    private static Walker walk(InputStream in, Leaf leaf, Deadline deadline) {
        Walker walker = new Walker(leaf, deadline);
        MimeStreamParser parser = new MimeStreamParser(config(), DecodeMonitor.SILENT, new DefaultBodyDescriptorBuilder());
        parser.setContentDecoding(true);
        // A forwarded message is an attachment of this one, not walked into.
        parser.setNoRecurse();
        parser.setContentHandler(walker);
        walker.parser = parser;
        try {
            parser.parse(in);
        } catch (Refusal r) {
            throw r;
        } catch (MaxNestingDepthLimitException e) {
            throw new Refusal(Refusal.TOO_DEEP);
        } catch (MaxPartCountLimitException e) {
            throw new Refusal(Refusal.TOO_MANY_PARTS);
        } catch (MimeException | IOException | RuntimeException e) {
            LAST_FAILURE.set(e);
            Throwable cause = e.getCause();
            if (cause instanceof Refusal r) {
                throw r;
            }
            if (cause instanceof MaxNestingDepthLimitException) {
                throw new Refusal(Refusal.TOO_DEEP);
            }
            if (cause instanceof MaxPartCountLimitException) {
                throw new Refusal(Refusal.TOO_MANY_PARTS);
            }
            throw new Refusal(Refusal.MALFORMED);
        }
        return walker;
    }

    // ---- the message

    /** The message as the store takes it: {@code parse-courier 1}, exactly {@code ParsedMessage.fromWire}'s shape. */
    static Map<String, Object> message(InputStream raw, Deadline deadline) {
        Counted in = new Counted(raw, deadline);
        Bodies bodies = new Bodies(deadline);
        Walker w = walk(in, bodies, deadline);
        deadline.check();
        // One From, with one mailbox (RFC 5322 3.6.2's own rule for mail with no Sender, and RFC 7489 6.6.1's allowance):
        // with more, which From a sender authentication checked can't be told, so a "confirmed" line or the member's own
        // mail could rest on an address nothing checked (Security CP-L2). Refused, as Gmail and others refuse it.
        if (w.headerCount.getOrDefault("from", 0) > 1 || Headers.addresses(w.header.get("from"), 2).size() > 1) {
            throw new Refusal(Refusal.MALFORMED);
        }
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("v", 1);
        List<Map<String, Object>> from = Headers.addresses(w.header.get("from"), 1);
        m.put("from", from.isEmpty() ? null : from.get(0));
        m.put("replyTo", Headers.addresses(w.header.get("reply-to"), Limits.MAX_ADDRESSES));
        m.put("to", Headers.addresses(w.header.get("to"), Limits.MAX_ADDRESSES));
        m.put("cc", Headers.addresses(w.header.get("cc"), Limits.MAX_ADDRESSES));
        m.put("bcc", Headers.addresses(w.header.get("bcc"), Limits.MAX_ADDRESSES));
        m.put("subject", Headers.subject(w.header.get("subject")));
        m.put("date", Headers.date(w.header.get("date")));
        m.put("messageId", Headers.line(w.header.get("message-id")));
        m.put("inReplyTo", Headers.line(w.header.get("in-reply-to")));
        m.put("references", Headers.line(w.header.get("references")));
        m.put("listId", Headers.line(w.header.get("list-id")));
        m.put("listUnsubscribe", w.header.containsKey("list-unsubscribe"));
        m.put("precedence", Headers.line(w.header.get("precedence")));
        m.put("autoSubmitted", Headers.line(w.header.get("auto-submitted")));
        m.put("authResults", AuthResults.read(w.authResults));

        String plain = bodies.plain.isEmpty() ? null : String.join("\n\n", bodies.plain);
        boolean truncated = bodies.truncated;
        String html = null;
        String text = plain;
        if (!bodies.html.isEmpty()) {
            Html.Result r = Html.sanitize(String.join("\n", bodies.html), new Html.Budget());
            html = r.html();
            if (text == null) {
                text = r.text();
                truncated |= r.textTruncated();
            }
        }
        if (bodies.htmlTooLarge && html == null && text == null) {
            truncated = true;
        }
        text = text == null ? "" : TextClean.clean(Links.cleanText(text), true);
        if (text.length() > Limits.MAX_TEXT_CHARS) {
            text = text.substring(0, Limits.MAX_TEXT_CHARS);
            truncated = true;
        }
        m.put("text", text);
        m.put("textTruncated", truncated);
        m.put("html", html);
        m.put("attachments", bodies.attachments);
        return m;
    }

    /** The message's leaves: text and HTML bodies kept, every other leaf named, typed, sized and checked for danger. */
    private static final class Bodies implements Leaf {
        final List<String> plain = new ArrayList<>();
        final List<String> html = new ArrayList<>();
        final List<Map<String, Object>> attachments = new ArrayList<>();
        final Deadline deadline;
        boolean truncated;
        boolean htmlTooLarge;
        long plainBytes;
        long htmlChars;

        Bodies(Deadline deadline) {
            this.deadline = deadline;
        }

        @Override
        public void body(String id, MaximalBodyDescriptor d, boolean related, InputStream in) throws IOException {
            String type = type(d);
            String disposition = d.getContentDispositionType() == null ? null : d.getContentDispositionType().toLowerCase(Locale.ROOT);
            String name = name(d);
            boolean textType = type.equals("text/plain") || type.equals("text/html");
            if (textType && name == null && !"attachment".equals(disposition)) {
                String charset = d.getContentTypeParameters().get("charset");
                if (type.equals("text/plain")) {
                    long budget = Limits.MAX_TEXT_BYTES - plainBytes;
                    Read r = read(in, budget, deadline);
                    plainBytes += r.length;
                    truncated |= r.over;
                    String t = Charsets.decode(r.bytes, r.length, charset);
                    if (t.length() > Limits.MAX_TEXT_CHARS) {
                        t = t.substring(0, Limits.MAX_TEXT_CHARS);
                        truncated = true;
                    }
                    String format = d.getContentTypeParameters().get("format");
                    if (format != null && format.trim().equalsIgnoreCase("flowed")) {
                        String delsp = d.getContentTypeParameters().get("delsp");
                        t = Flowed.unwrap(t, delsp != null && delsp.trim().equalsIgnoreCase("yes"));
                    }
                    plain.add(t);
                } else {
                    long budget = (long) Limits.MAX_HTML_IN_CHARS * 2 - htmlChars;
                    Read r = read(in, Math.max(0, budget), deadline);
                    String label = charset != null ? charset : Charsets.htmlMeta(r.bytes, r.length);
                    String h = Charsets.decode(r.bytes, r.length, label);
                    htmlChars += h.length();
                    if (r.over || htmlChars > Limits.MAX_HTML_IN_CHARS) {
                        // Too large to read into a tree: the HTML is left out, and its text taken from what fits.
                        htmlTooLarge = true;
                        truncated = true;
                        int room = (int) Math.max(0, Limits.MAX_HTML_IN_CHARS - (htmlChars - h.length()));
                        h = h.substring(0, Math.min(h.length(), room));
                    }
                    html.add(h);
                }
                return;
            }
            Danger.Sniffer sniffer = new Danger.Sniffer(false);
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) >= 0) {
                deadline.check();
                sniffer.write(buf, 0, n);
            }
            Map<String, Object> a = new LinkedHashMap<>();
            String contentId = Headers.contentId(d.getContentId());
            a.put("part", id);
            a.put("name", name);
            a.put("type", type);
            a.put("bytes", sniffer.size());
            a.put("contentId", contentId);
            a.put("inline", "inline".equals(disposition) || disposition == null && related && contentId != null);
            a.put("danger", type.equals("message/rfc822") ? null : sniffer.danger(name, type));
            attachments.add(a);
        }
    }

    private static String type(MaximalBodyDescriptor d) {
        String t = d.getMimeType();
        if (t == null || t.isBlank() || t.length() > 127 || !t.contains("/")) {
            return "application/octet-stream";
        }
        return t.strip().toLowerCase(Locale.ROOT);
    }

    /** A part's file name: Content-Disposition's {@code filename} (RFC 2231 included), else Content-Type's {@code name}. */
    static String name(MaximalBodyDescriptor d) {
        String n = null;
        try {
            n = d.getContentDispositionFilename();
        } catch (RuntimeException e) {
            // A parameter mime4j can't read leaves no name.
        }
        if (n == null || n.isBlank()) {
            n = d.getContentTypeParameters().get("name");
        }
        if (n == null || n.isBlank()) {
            return null;
        }
        n = Headers.decodeWords(n);
        n = TextClean.clean(n, false).strip();
        if (n.length() > 255) {
            n = n.substring(0, 255);
        }
        return n.isEmpty() ? null : n;
    }

    record Read(byte[] bytes, int length, boolean over) {}

    /** A body's bytes up to {@code budget}; the rest is read and dropped, and {@code over} says so. */
    static Read read(InputStream in, long budget, Deadline deadline) throws IOException {
        Chunks kept = new Chunks(Math.max(0, budget));
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) >= 0) {
            deadline.check();
            kept.write(buf, 0, n);
        }
        byte[] all = kept.head((int) kept.size());
        return new Read(all, all.length, kept.over());
    }

    // ---- one part

    /** What a request for one part found. */
    record Found(MaximalBodyDescriptor descriptor, String type, String name) {}

    /**
     * The decoded bytes of part {@code id} into {@code sink}, the rest of the message read past. A part that isn't a leaf
     * (a multipart) or isn't there is {@code not_found}.
     */
    static Found part(InputStream raw, String id, java.util.function.Consumer<InputStream> sink, Deadline deadline) {
        Counted in = new Counted(raw, deadline);
        Found[] found = new Found[1];
        walk(in, (leafId, d, related, body) -> {
            if (found[0] == null && leafId.equals(id)) {
                found[0] = new Found(d, type(d), name(d));
                sink.accept(body);
            }
        }, deadline);
        if (found[0] == null) {
            throw new Refusal(Refusal.NOT_FOUND);
        }
        return found[0];
    }

    // ---- headers

    /** A header's text: its raw bytes as UTF-8 (or windows-1252 when they aren't UTF-8), unfolded. */
    static final class Headers {
        private Headers() {}

        static String text(Field field) {
            byte[] raw = field.getRaw() == null ? null : field.getRaw().toByteArray();
            String value;
            if (raw == null) {
                value = field.getBody() == null ? "" : field.getBody();
            } else {
                int colon = 0;
                while (colon < raw.length && raw[colon] != ':') {
                    colon++;
                }
                int from = Math.min(raw.length, colon + 1);
                int len = Math.min(raw.length - from, Limits.MAX_HEADER_CHARS * 4);
                value = Charsets.validUtf8(raw, from, len)
                        ? new String(raw, from, len, StandardCharsets.UTF_8)
                        : new String(raw, from, len, Charsets.WINDOWS_1252);
            }
            String unfolded = value.replace("\r\n", "").replace("\n", "").replace("\r", "");
            unfolded = unfolded.strip();
            return unfolded.length() > Limits.MAX_HEADER_CHARS ? unfolded.substring(0, Limits.MAX_HEADER_CHARS) : unfolded;
        }

        /** RFC 2231's language in an encoded word ({@code =?utf-8*en?B?...?=}), which mime4j doesn't take. */
        private static final java.util.regex.Pattern LANGUAGE = java.util.regex.Pattern.compile("=\\?([^?*\\s]{1,40})\\*[A-Za-z0-9-]{0,20}\\?");

        static String decodeWords(String s) {
            if (s == null || !s.contains("=?")) {
                return s;
            }
            try {
                return DecoderUtil.decodeEncodedWords(LANGUAGE.matcher(s).replaceAll("=?$1?"), DecodeMonitor.SILENT);
            } catch (RuntimeException e) {
                return s;
            }
        }

        static String subject(String text) {
            if (text == null) {
                return null;
            }
            String s = TextClean.clean(decodeWords(text), false).strip();
            return s.isEmpty() ? null : s;
        }

        static String line(String text) {
            if (text == null) {
                return null;
            }
            String s = TextClean.clean(text, false).strip();
            return s.isEmpty() ? null : s;
        }

        static Long date(String text) {
            if (text == null || text.isBlank()) {
                return null;
            }
            try {
                DateTimeField f = DateTimeFieldLenientImpl.PARSER.parse(new RawField("Date", text), DecodeMonitor.SILENT);
                Date d = f.getDate();
                if (d == null) {
                    return null;
                }
                long ms = d.getTime();
                return ms > 0 && ms < 32_503_680_000_000L ? ms : null;
            } catch (RuntimeException e) {
                return null;
            }
        }

        static String contentId(String raw) {
            if (raw == null) {
                return null;
            }
            String s = TextClean.clean(raw, false).strip();
            if (s.startsWith("<") && s.endsWith(">")) {
                s = s.substring(1, s.length() - 1).strip();
            }
            return s.isEmpty() || s.length() > 250 ? null : s;
        }

        /** An address list, groups flattened, at most {@code max}: each {@code {name, address}}. */
        static List<Map<String, Object>> addresses(String text, int max) {
            List<Map<String, Object>> out = new ArrayList<>();
            if (text == null || text.isBlank()) {
                return out;
            }
            AddressList list;
            try {
                byte[] utf8 = text.getBytes(StandardCharsets.UTF_8);
                ByteArrayBuffer buf = new ByteArrayBuffer(utf8, utf8.length, false);
                list = LenientAddressParser.DEFAULT.parseAddressList(buf, new ParserCursor(0, utf8.length));
            } catch (RuntimeException e) {
                return out;
            }
            for (Address a : list) {
                if (out.size() >= max) {
                    break;
                }
                if (a instanceof Mailbox mb) {
                    add(out, mb);
                } else if (a instanceof Group g) {
                    for (Mailbox mb : g.getMailboxes()) {
                        if (out.size() >= max) {
                            break;
                        }
                        add(out, mb);
                    }
                }
            }
            return out;
        }

        private static void add(List<Map<String, Object>> out, Mailbox mb) {
            String address = utf8(mb.getAddress());
            if (address == null || address.isBlank() || address.length() > 320) {
                return;
            }
            String name = mb.getName() == null ? null : TextClean.clean(decodeWords(utf8(mb.getName())), false).strip();
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("name", name == null || name.isEmpty() ? null : name.length() > 256 ? name.substring(0, 256) : name);
            m.put("address", address.strip());
            out.add(m);
        }

        /** mime4j reads a header's bytes one char a byte: UTF-8 in it comes back as Latin-1, and is read again here. */
        private static String utf8(String s) {
            if (s == null) {
                return null;
            }
            boolean high = false;
            for (int i = 0; i < s.length(); i++) {
                char c = s.charAt(i);
                if (c > 0xFF) {
                    return s;
                }
                high |= c > 0x7F;
            }
            if (!high) {
                return s;
            }
            byte[] b = s.getBytes(StandardCharsets.ISO_8859_1);
            return Charsets.validUtf8(b, 0, b.length) ? new String(b, StandardCharsets.UTF_8) : s;
        }
    }
}
