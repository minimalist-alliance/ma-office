package com.minimalistalliance.desk.deskd.courier.imsg;

import com.minimalistalliance.desk.deskd.courier.parse.CourierParser;
import com.minimalistalliance.desk.deskd.courier.parse.ParsedMessage;
import com.minimalistalliance.desk.deskd.courier.store.Courier;
import com.minimalistalliance.desk.deskd.courier.store.CourierStore;
import com.minimalistalliance.desk.deskd.courier.store.ImessageState;
import com.minimalistalliance.desk.deskd.courier.store.Norm;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.function.IntFunction;
import java.util.regex.Pattern;

/**
 * The {@code imsg} seam's shared half (the launch plan's Wave 2.6; ma-desk {@code docs/sub-status/imsg-seam.md}): a Mac's
 * messages ({@link ImsgMessage}), from whichever path read them, into Courier's store, the same way for every path.
 * <ul>
 *   <li><b>One thread per person:</b> a one-to-one chat's messages go to the person's own conversation, whatever the
 *       medium, so their iMessages, texts and email are one thread (the store's {@code direct:<contact>}); a group chat is
 *       one conversation per chat ({@link Courier.Group}), named as on the iPhone, whoever joins or leaves.</li>
 *   <li><b>iPhone texts:</b> a chat whose guid starts {@code SMS;} or {@code RCS;}, or a sender whose service is SMS or
 *       RCS, is medium {@code sms}; the rest {@code imessage}.</li>
 *   <li><b>Reactions, edits, unsends and a group's changes are words</b> (the Designer's flow 8): {@code Loved “see you at
 *       6”}, {@code Edited “…”: …}, {@code Unsent a message.}, {@code Named the conversation “Climbing”.}, each its own message
 *       from whoever did it, with its own sink key, so each is stored once.</li>
 *   <li><b>The member's own</b> (sent from their iPhone or Mac) is outgoing, so writing to someone lets them in, as a Sent
 *       folder does; a message Courier sent is known by the guid its send got ({@link ImessageState#recordSent}) and stored
 *       once.</li>
 *   <li><b>Files</b> are read by the path (at most 24 MiB each and 24 MiB a message; more stays on the Mac, said in
 *       words), wrapped in a MIME container kept as the message's raw bytes, and read by {@code desk-parse}'s Courier mode,
 *       so the parts, their {@code danger} words, Save to Files with its {@code untrusted} mark, Download and previews are
 *       exactly email's (plan §2.7, §3.3): deskd never opens a file. A sandbox that can't be reached holds the page
 *       ({@link Hold}); its cursor doesn't move.</li>
 * </ul>
 */
public final class ImsgSink {

    /** Sink keys: a message, an edit at a time, an unsend. The Mac's guid, so a change of path stores nothing twice. */
    public static final String KEY = "imsg1:";
    public static final String EDIT_KEY = "imsg1e:";
    public static final String UNSEND_KEY = "imsg1u:";

    /**
     * A guid as Messages names a message, chat or attachment ({@code p:0/<uuid>} has a slash); never {@code ..}, so on a
     * route, where it's one encoded segment, it can't name another path even to a server that decodes it.
     */
    public static final Pattern GUID = Pattern.compile("(?!.*\\.\\.)[A-Za-z0-9_.:;+@/-]{1,200}");

    /**
     * Bounds on files: each, and all of one message's together. One message's files at a time are in deskd's heap (with
     * their container, about 2.4 times the files' bytes at the peak), so 16 MiB keeps the path under 40 MiB (Security
     * IM-H1); a larger file stays on the Mac, said in words.
     */
    public record Settings(long maxFile, long maxPerMessage) {
        public static final Settings DEFAULT = new Settings(16L * 1024 * 1024, 16L * 1024 * 1024);
    }

    /** One message's files in the heap at a time, across every account and path. */
    private static final java.util.concurrent.Semaphore FILES = new java.util.concurrent.Semaphore(1);
    /** Tries a file that fails for another reason than its size gets before it's left on the Mac (Security IM-L2). */
    static final int FILE_TRIES = 3;
    private final Map<String, Integer> fileFailures = new java.util.concurrent.ConcurrentHashMap<>();
    /** For tests: transactions this sink committed. */
    final java.util.concurrent.atomic.AtomicLong commits = new java.util.concurrent.atomic.AtomicLong();

    /** How a path reads one file's bytes, at most {@code max}; more is an IOException (a file left on the Mac). */
    @FunctionalInterface
    public interface Files {
        byte[] read(ImsgMessage.File file, long max) throws IOException, InterruptedException;
    }

    /** A file over the limit: it stays on the Mac. */
    public static final class TooLarge extends IOException {
        private static final long serialVersionUID = 1L;

        public TooLarge() {
            super("too_large", null);
        }
    }

    /** The sandbox can't read files now: the rest of the page waits, and the cursor stays where it was. */
    public static final class Hold extends Exception {
        private static final long serialVersionUID = 1L;
        private final int stored;

        Hold(int stored) {
            super("parse", null, false, false);
            this.stored = stored;
        }

        /** How many of the page's messages were taken (stored, known or skipped) before the hold. */
        public int stored() {
            return stored;
        }
    }

    /** What one page did. */
    public record Result(int taken, int stored, int duplicates, int skipped) {}

    private final CourierStore store;
    private final CourierParser parser;
    private final Settings settings;
    private final SecureRandom random = new SecureRandom();

    public ImsgSink(CourierStore store, CourierParser parser, Settings settings) {
        this.store = store;
        this.parser = parser;
        this.settings = settings;
    }

    /**
     * Stores a page of a Mac's messages, in order, and the path's place with them. Messages without files go in one
     * transaction; a message with files goes in its own, so at most one message's files are ever in deskd's heap (Security
     * IM-H1). Messages the desk has already (a page that overlaps the last, a socket's hint) download nothing again; an edit
     * or unsend of one is its own message. {@code cursorFor(n)} is the path's place after the first {@code n} messages, or
     * null to leave it. A message dated before {@code newAfter} comes in as {@code backfill}: a first sync's month isn't new
     * to an agent's {@code courier_new} (Security IM-I5).
     *
     * @throws Hold when the sandbox can't read a message's files now: what came before it is stored, with
     *     {@code cursorFor(hold.stored())}
     * @throws IOException a file couldn't be read for another reason than its size (the Mac went away): what came before it
     *     is stored, and after {@link #FILE_TRIES} tries that file is left on the Mac
     */
    public Result store(String accountId, List<ImsgMessage> page, IntFunction<Courier.CursorUpdate> cursorFor, Files files, long newAfter)
            throws IOException, SQLException, InterruptedException, Hold {
        ImessageState state = store.imessage();
        List<String> keys = new ArrayList<>();
        for (ImsgMessage m : page) {
            if (m != null && m.guid() != null && GUID.matcher(m.guid()).matches()) {
                keys.add(KEY + m.guid());
                if (m.edited() != null) {
                    keys.add(EDIT_KEY + m.guid() + ":" + m.edited());
                }
                if (m.retracted() != null) {
                    keys.add(UNSEND_KEY + m.guid());
                }
            }
        }
        Set<String> known = new LinkedHashSet<>(state.known("imessage", keys));
        known.addAll(state.known("sms", keys));
        Map<String, String> pageText = new HashMap<>();
        // What the desk has: an edit's "before" is the text as the desk stored it, never the Mac's edited one.
        Quotes before = guid -> {
            try {
                return state.textOf(accountId, KEY + guid, guid);
            } catch (SQLException e) {
                return null;
            }
        };
        // A reaction may name a message earlier in the same page.
        Quotes quotes = guid -> {
            String t = pageText.get(guid);
            return t != null ? t : before.text(guid);
        };
        Batch b = new Batch(accountId);
        int taken = 0;
        for (ImsgMessage m : page) {
            // An unsend is words alone: the Mac has no text left for it, and the desk shows what it had with "Unsent".
            Planned change = change(accountId, m, before);
            if (change != null && !known.contains(change.externalId())
                    && (m.retracted() != null || known.contains(KEY + m.guid()) || state.sentByCourier(accountId, m.guid()))) {
                // An edit is news only for a message the desk had before it: one first seen now is stored as it reads now.
                b.add(origin(change.inbound(), m.date(), newAfter), change.chat());
            }
            Planned p = m == null || m.retracted() != null ? null : plan(accountId, m, quotes);
            if (p == null) {
                b.skipped++;
                taken++;
                continue;
            }
            boolean echo = m.fromMe() && state.sentByCourier(accountId, m.guid());
            if (known.contains(p.externalId()) || echo) {
                b.dup++;
                taken++;
                continue;
            }
            if (p.inbound().parsed() != null && p.inbound().parsed().text() != null) {
                pageText.put(p.guid(), p.inbound().parsed().text());
            }
            if (p.files().isEmpty()) {
                b.add(origin(p.inbound(), m.date(), newAfter), p.chat());
                taken++;
                continue;
            }
            // A message with files: what came before it is committed first, then it alone.
            b.flush(cursorFor.apply(taken));
            FILES.acquire();
            try {
                Courier.Inbound in;
                try {
                    in = withFiles(accountId, p, files);
                } catch (Hold h) {
                    throw new Hold(taken);
                }
                b.add(origin(in, m.date(), newAfter), p.chat());
                taken++;
                b.flush(cursorFor.apply(taken));
            } finally {
                FILES.release();
            }
        }
        b.flush(cursorFor.apply(taken));
        return new Result(taken, b.stored, b.dup, b.skipped);
    }

    private static Courier.Inbound origin(Courier.Inbound in, long date, long newAfter) {
        return date < newAfter ? in.withOrigin(Courier.Origin.BACKFILL) : in;
    }

    /** Messages waiting for one commit, and what the commits did. */
    private final class Batch {
        final String accountId;
        final List<Courier.Inbound> inbound = new ArrayList<>();
        final List<String[]> chats = new ArrayList<>();
        int stored;
        int dup;
        int skipped;

        Batch(String accountId) {
            this.accountId = accountId;
        }

        void add(Courier.Inbound in, String[] chat) {
            inbound.add(in);
            chats.add(chat);
        }

        void flush(Courier.CursorUpdate cursor) throws SQLException, IOException, InterruptedException {
            if (inbound.isEmpty() && cursor == null) {
                return;
            }
            int before = stored;
            for (Courier.Accepted a : store.imessage().accept(accountId, inbound, cursor, chats)) {
                if (a.kind() == Courier.Accepted.Kind.DUPLICATE) {
                    dup++;
                } else if (a.kept()) {
                    stored++;
                } else {
                    skipped++;
                }
            }
            commits.incrementAndGet();
            inbound.clear();
            chats.clear();
            if (stored > before) {
                store.imessage().nameFromCards();
            }
        }
    }

    // ---- planning

    /** Looks up the text of the message a reaction or an edit names, by its guid; null if the desk doesn't have it. */
    @FunctionalInterface
    interface Quotes {
        String text(String guid);
    }

    /** One message as the store takes it (files not yet read), its group chat ({@code {guid, medium}}) and its files. */
    record Planned(String externalId, String guid, Courier.Inbound inbound, String[] chat, List<ImsgMessage.File> files) {}

    /**
     * The message as Courier stores it, or null when it isn't one to store: no guid or date, a send of the member's that
     * failed, a kind of group change Courier doesn't show, someone else's message with no sender.
     */
    static Planned plan(String accountId, ImsgMessage m, Quotes quotes) {
        if (m == null || m.guid() == null || !GUID.matcher(m.guid()).matches() || m.date() <= 0 || m.failed()) {
            return null;
        }
        ImsgMessage.Chat chat = m.chat();
        String chatGuid = chat == null ? null : chat.guid();
        if (chatGuid != null && !GUID.matcher(chatGuid).matches()) {
            return null;
        }
        boolean group = chat != null && (chat.group() || (chatGuid != null && chatGuid.contains(";+;")));
        String medium = medium(chatGuid, m.senderService());
        List<String> participants = new ArrayList<>(chat == null ? List.of() : chat.participants());
        String sender = m.sender();
        if (!m.fromMe() && sender == null && !group && participants.size() == 1) {
            sender = participants.get(0);
        }
        if (!m.fromMe() && endpoint(sender) == null) {
            return null;
        }
        if (m.fromMe() && participants.isEmpty() && chatGuid != null && !group) {
            // A one-to-one chat's guid names the other person: iMessage;-;+15551230001.
            participants.add(chatGuid.substring(chatGuid.lastIndexOf(';') + 1));
        }

        String text = clean(m.text());
        boolean words = false;
        if (m.reaction() != null) {
            String target = target(m.reaction().target());
            String quoted = target == null ? null : quotes.text(target);
            text = reaction(m.reaction().type(), m.reaction().emoji(), quoted);
            if (text == null) {
                return null;
            }
            words = true;
        } else if (m.event() != null) {
            text = event(m.event().kind(), clean(m.event().title()));
            if (text == null) {
                return null;
            }
            words = true;
        }
        List<ImsgMessage.File> files = new ArrayList<>();
        if (!words) {
            for (ImsgMessage.File f : m.files()) {
                if (f != null && f.guid() != null && GUID.matcher(f.guid()).matches() && files.size() < 50) {
                    files.add(f);
                }
            }
        }
        if ((text == null || text.isBlank()) && files.isEmpty()) {
            text = m.appOnly() || !words ? "Sent something only Messages can show." : text;
        }

        String from = m.fromMe() ? null : endpoint(sender);
        List<ParsedMessage.Address> to = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();
        for (String p : participants) {
            String e = endpoint(p);
            if (e != null && (m.fromMe() || group) && !e.equals(from) && seen.add(e) && to.size() < ParsedMessage.MAX_ADDRESSES) {
                to.add(new ParsedMessage.Address(null, e));
            }
        }
        ParsedMessage parsed = new ParsedMessage(from == null ? null : new ParsedMessage.Address(null, from), List.of(), to, List.of(),
                List.of(), clean(m.subject()), m.date(), null, List.of(), List.of(), null, false, null, null, text == null ? "" : text, false,
                null, List.of(), List.of());
        Courier.Inbound in = new Courier.Inbound(accountId, medium, KEY + m.guid(), Courier.Origin.LIVE, null, parsed, null, m.fromMe(),
                m.fromMe(), List.of(), m.date());
        if (group) {
            in = in.withGroup(new Courier.Group(groupKey(accountId, chatGuid), clean(chat.name())));
        }
        return new Planned(KEY + m.guid(), m.guid(), in, group ? new String[] {chatGuid, medium} : null, files);
    }

    /**
     * An edit or an unsend of a message, as words from whoever made it, with its own sink key so each edit is stored once.
     * Null when it's neither.
     */
    static Planned change(String accountId, ImsgMessage m, Quotes quotes) {
        boolean edited = m != null && m.edited() != null && m.edited() > 0;
        boolean retracted = m != null && m.retracted() != null && m.retracted() > 0;
        if (!edited && !retracted) {
            return null;
        }
        Planned base = plan(accountId, m, g -> null);
        if (base == null) {
            return null;
        }
        String old = quotes.text(m.guid());
        String words;
        String key;
        long at;
        if (retracted) {
            words = "Unsent a message.";
            key = UNSEND_KEY + m.guid();
            at = m.retracted();
        } else {
            String now = clean(m.text());
            words = (old != null ? "Edited “" + quote(old) + "”: " : "Edited a message: ") + (now == null ? "" : now);
            key = EDIT_KEY + m.guid() + ":" + m.edited();
            at = m.edited();
        }
        ParsedMessage p = base.inbound().parsed();
        ParsedMessage parsed = new ParsedMessage(p.from(), List.of(), p.to(), List.of(), List.of(), null, at, null, List.of(), List.of(),
                null, false, null, null, words, false, null, List.of(), List.of());
        Courier.Inbound b = base.inbound();
        Courier.Inbound in = new Courier.Inbound(accountId, b.medium(), key, Courier.Origin.LIVE, null, parsed, null, b.seen(), b.outgoing(),
                List.of(), at, b.group());
        return new Planned(key, m.guid(), in, base.chat(), List.of());
    }

    /** {@code imessage}, or {@code sms} for an iPhone's text (SMS, or RCS from iOS 18). */
    static String medium(String chatGuid, String service) {
        String prefix = chatGuid == null || chatGuid.indexOf(';') < 0 ? "" : chatGuid.substring(0, chatGuid.indexOf(';'));
        String p = prefix.toLowerCase(Locale.ROOT);
        if (p.equals("sms") || p.equals("rcs")) {
            return "sms";
        }
        if (p.equals("imessage")) {
            return "imessage";
        }
        String s = service == null ? "" : service.toLowerCase(Locale.ROOT);
        return s.equals("sms") || s.equals("rcs") ? "sms" : "imessage";
    }

    /** A handle as an endpoint value: a number or an Apple ID's address, normalized; null if it's neither. */
    public static String endpoint(String handle) {
        if (handle == null) {
            return null;
        }
        String h = handle.strip();
        if (h.startsWith("mailto:")) {
            h = h.substring(7);
        } else if (h.startsWith("tel:")) {
            h = h.substring(4);
        }
        return h.contains("@") ? Norm.email(h) : Norm.phone(h);
    }

    /** The guid a reaction names: {@code p:0/<guid>} and {@code bp:<guid>} both name {@code <guid>}. */
    static String target(String assoc) {
        if (assoc == null) {
            return null;
        }
        String g = assoc;
        int slash = g.indexOf('/');
        if (g.startsWith("p:") && slash > 0) {
            g = g.substring(slash + 1);
        } else if (g.startsWith("bp:")) {
            g = g.substring(3);
        }
        return GUID.matcher(g).matches() ? g : null;
    }

    /** A tapback in Apple's own words for it ("Loved", "Removed a heart from"); null for what isn't a reaction. */
    static String reaction(String type, String emoji, String quoted) {
        String t = type == null ? "" : type.strip().toLowerCase(Locale.ROOT);
        String q = quoted == null ? "a message" : "“" + quote(quoted) + "”";
        String e = emoji == null ? null : Norm.line(emoji, 16);
        return switch (t) {
            case "love" -> "Loved " + q;
            case "like" -> "Liked " + q;
            case "dislike" -> "Disliked " + q;
            case "laugh" -> "Laughed at " + q;
            case "emphasize" -> "Emphasized " + q;
            case "question" -> "Questioned " + q;
            case "emoji" -> e == null ? "Reacted to " + q : "Reacted " + e + " to " + q;
            case "sticker" -> "Reacted with a sticker to " + q;
            case "sticker-message" -> "Sent a sticker.";
            case "-love" -> "Removed a heart from " + q;
            case "-like" -> "Removed a like from " + q;
            case "-dislike" -> "Removed a dislike from " + q;
            case "-laugh" -> "Removed a laugh from " + q;
            case "-emphasize" -> "Removed an exclamation from " + q;
            case "-question" -> "Removed a question mark from " + q;
            case "-emoji" -> e == null ? "Removed a reaction from " + q : "Removed " + e + " from " + q;
            case "-sticker" -> "Removed a sticker from " + q;
            case "" -> null;
            default -> "Reacted to " + q;
        };
    }

    /** A group's change in words; null for one Courier doesn't show. */
    static String event(String kind, String title) {
        return switch (kind == null ? "" : kind) {
            case "added" -> "Added someone to the conversation.";
            case "removed" -> "Removed someone from the conversation.";
            case "named" -> title == null ? "Removed the conversation's name." : "Named the conversation “" + quote(title) + "”.";
            case "left" -> "Left the conversation.";
            default -> null;
        };
    }

    /** The first 60 characters of a message, on one line, for a quote. */
    static String quote(String text) {
        String t = Norm.line(text == null ? "" : text.replace('\n', ' '), 200);
        if (t == null) {
            return "";
        }
        return t.length() > 60 ? t.substring(0, 59).strip() + "…" : t;
    }

    /** A group chat's key in the store: its guid and account, hashed, so no guid of the Mac's is a key here. */
    static String groupKey(String accountId, String chatGuid) {
        try {
            byte[] h = MessageDigest.getInstance("SHA-256").digest((accountId + "\n" + chatGuid).getBytes(StandardCharsets.UTF_8));
            return "im1:" + HexFormat.of().formatHex(h, 0, 16);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /** iMessage's object-replacement marks (where an attachment sat in the text) removed, and the ends trimmed. */
    static String clean(String s) {
        if (s == null) {
            return null;
        }
        String t = s.replace("￼", "").replace("�", "").strip();
        return t.isEmpty() ? null : t;
    }

    // ---- files

    /**
     * The message with its files: each read by the path within the limits, all wrapped in one MIME container that the
     * sandbox reads for the parts and their danger words; the container is kept as the message's raw bytes. Files over the
     * limits, or that the sandbox refused, stay on the Mac, said in words at the end of the text.
     */
    Courier.Inbound withFiles(String accountId, Planned p, Files files) throws IOException, InterruptedException, Hold {
        if (p.files().isEmpty()) {
            return p.inbound();
        }
        List<ImsgMessage.File> kept = new ArrayList<>();
        List<byte[]> bytes = new ArrayList<>();
        List<String> left = new ArrayList<>();
        long total = 0;
        for (ImsgMessage.File f : p.files()) {
            long room = Math.min(settings.maxFile(), settings.maxPerMessage() - total);
            if (room <= 0 || f.bytes() > room) {
                left.add(leftWords(f));
                continue;
            }
            String failKey = accountId + "\n" + f.guid();
            byte[] b;
            try {
                b = files.read(f, room);
                fileFailures.remove(failKey);
            } catch (TooLarge e) {
                left.add(leftWords(f));
                continue;
            } catch (IOException e) {
                // A file the Mac can't serve now: tried again on later looks, then left there so it can't stall the rest.
                int n = fileFailures.merge(failKey, 1, Integer::sum);
                if (fileFailures.size() > 10_000) {
                    fileFailures.clear();
                }
                if (n < FILE_TRIES) {
                    throw e;
                }
                fileFailures.remove(failKey);
                left.add(leftWords(f));
                continue;
            }
            if (b == null || b.length > room) {
                left.add(leftWords(f));
                continue;
            }
            kept.add(f);
            bytes.add(b);
            total += b.length;
        }
        ParsedMessage base = p.inbound().parsed();
        List<ParsedMessage.Part> parts = List.of();
        byte[] container = null;
        if (!kept.isEmpty()) {
            container = container(base.text(), kept, bytes);
            bytes.clear();
            CourierParser.Result r;
            try {
                r = parser.parse(container);
            } catch (CourierParser.Unavailable e) {
                throw new Hold(0);
            }
            if (r instanceof CourierParser.Parsed ok) {
                parts = ok.message().attachments();
            } else {
                container = null;
                for (ImsgMessage.File f : kept) {
                    left.add(leftWords(f));
                }
            }
        }
        String text = base.text();
        if (!left.isEmpty()) {
            StringBuilder sb = new StringBuilder(text == null ? "" : text);
            for (String l : left) {
                if (sb.length() > 0) {
                    sb.append('\n');
                }
                sb.append(l);
            }
            text = sb.toString();
        }
        ParsedMessage parsed = new ParsedMessage(base.from(), base.replyTo(), base.to(), base.cc(), base.bcc(), base.subject(), base.date(),
                null, List.of(), List.of(), null, false, null, null, text == null ? "" : text, false, null, parts, List.of());
        Courier.Inbound in = p.inbound().withParsed(parsed);
        return container == null ? in : in.withRaw(container);
    }

    private static String leftWords(ImsgMessage.File f) {
        String name = f.name() == null || f.name().isBlank() ? "A file" : Norm.line(f.name(), 120);
        return "[" + name + (f.bytes() > 0 ? ", " + size(f.bytes()) : "") + ": it stays in Messages on your Mac.]";
    }

    static String size(long bytes) {
        if (bytes >= 1024L * 1024 * 1024) {
            return String.format(Locale.ROOT, "%.1f GB", bytes / (1024.0 * 1024 * 1024));
        }
        if (bytes >= 1024L * 1024) {
            return String.format(Locale.ROOT, "%.1f MB", bytes / (1024.0 * 1024));
        }
        return Math.max(1, bytes / 1024) + " KB";
    }

    private static final Pattern TYPE = Pattern.compile("[a-z0-9][a-z0-9!#$&^_.+-]{0,63}/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}");

    /**
     * The text and the files as one {@code multipart/mixed} message, every part base64, every header built here. Written into
     * one array of the exact size, each file encoded straight into it and dropped from {@code bytes} once it is, so the peak
     * is the files and the container once each (Security IM-H1).
     */
    byte[] container(String text, List<ImsgMessage.File> files, List<byte[]> bytes) {
        byte[] r = new byte[12];
        random.nextBytes(r);
        String boundary = "=_imsg_" + HexFormat.of().formatHex(r);
        byte[] textBytes = (text == null ? "" : text).getBytes(StandardCharsets.UTF_8);
        List<byte[]> heads = new ArrayList<>();
        StringBuilder top = new StringBuilder();
        top.append("MIME-Version: 1.0\r\n");
        top.append("Content-Type: multipart/mixed; boundary=\"").append(boundary).append("\"\r\n\r\n");
        top.append("--").append(boundary).append("\r\n");
        top.append("Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n");
        heads.add(top.toString().getBytes(StandardCharsets.US_ASCII));
        for (int i = 0; i < files.size(); i++) {
            ImsgMessage.File f = files.get(i);
            String type = f.mime() == null ? null : f.mime().strip().toLowerCase(Locale.ROOT);
            // One file is one part: a type that would make the sandbox read it as more parts is plain bytes (IM-I4).
            if (type == null || !TYPE.matcher(type).matches() || type.startsWith("message/") || type.startsWith("multipart/")) {
                type = "application/octet-stream";
            }
            String head = "--" + boundary + "\r\nContent-Type: " + type + "\r\nContent-Disposition: attachment; "
                    + dispositionName(fileName(f.name(), i + 1)) + "\r\nContent-Transfer-Encoding: base64\r\n\r\n";
            heads.add(head.getBytes(StandardCharsets.US_ASCII));
        }
        byte[] tail = ("--" + boundary + "--\r\n").getBytes(StandardCharsets.US_ASCII);
        long size = heads.get(0).length + base64Size(textBytes.length) + tail.length;
        for (int i = 0; i < files.size(); i++) {
            size += heads.get(i + 1).length + base64Size(bytes.get(i).length);
        }
        if (size > Integer.MAX_VALUE - 16) {
            throw new IllegalArgumentException("too_large");
        }
        ArrayOut out = new ArrayOut((int) size);
        out.put(heads.get(0));
        base64(out, textBytes);
        for (int i = 0; i < files.size(); i++) {
            out.put(heads.get(i + 1));
            base64(out, bytes.get(i));
            bytes.set(i, null);
        }
        out.put(tail);
        return out.done();
    }

    /** What {@link #base64} writes for {@code n} bytes: 76-character lines joined by CRLF, then a CRLF. */
    static long base64Size(long n) {
        long enc = 4 * ((n + 2) / 3);
        long lines = (enc + 75) / 76;
        return enc + 2 * Math.max(0, lines - 1) + 2;
    }

    private static void base64(ArrayOut out, byte[] bytes) {
        try (java.io.OutputStream w = Base64.getMimeEncoder(76, new byte[] {'\r', '\n'}).wrap(out)) {
            w.write(bytes);
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
        out.put(new byte[] {'\r', '\n'});
    }

    /** An output stream over one array of a known size; closing it does nothing (the encoder closes what it wraps). */
    private static final class ArrayOut extends java.io.OutputStream {
        private final byte[] buf;
        private int pos;

        ArrayOut(int size) {
            buf = new byte[size];
        }

        void put(byte[] b) {
            write(b, 0, b.length);
        }

        @Override
        public void write(int b) {
            buf[pos++] = (byte) b;
        }

        @Override
        public void write(byte[] b, int off, int len) {
            System.arraycopy(b, off, buf, pos, len);
            pos += len;
        }

        @Override
        public void close() {}

        byte[] done() {
            return pos == buf.length ? buf : java.util.Arrays.copyOf(buf, pos);
        }
    }

    /** A file's name as a header carries it: cleaned, no path, no quotes, at most 200 characters; {@code file-<n>} for none. */
    static String fileName(String name, int n) {
        String t = Norm.line(name, 255);
        if (t != null) {
            t = t.replace('/', '_').replace('\\', '_').replace('"', '\'');
            while (t.startsWith(".")) {
                t = t.substring(1);
            }
            t = t.strip();
            if (t.length() > 200) {
                t = t.substring(0, 200);
            }
        }
        return t == null || t.isEmpty() ? "file-" + n : t;
    }

    private static String dispositionName(String name) {
        boolean ascii = name.chars().allMatch(c -> c >= 0x20 && c < 0x7F && c != '"' && c != '\\');
        if (ascii) {
            return "filename=\"" + name + "\"";
        }
        StringBuilder b = new StringBuilder("filename*=utf-8''");
        for (byte x : name.getBytes(StandardCharsets.UTF_8)) {
            int c = x & 0xFF;
            if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '.' || c == '_') {
                b.append((char) c);
            } else {
                b.append('%').append(Character.toUpperCase(Character.forDigit(c >> 4, 16))).append(Character.toUpperCase(Character.forDigit(c & 0xF, 16)));
            }
        }
        return b.toString();
    }
}
