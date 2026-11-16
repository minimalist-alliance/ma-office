package com.minimalistalliance.desk.deskd.courier.store;

import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.function.BooleanSupplier;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Courier's learning filter (the launch plan §2.8; draft ADR "Courier's store" §17): naive Bayes over a message's tokens,
 * per desk, trained only by what the member does, and kept in {@code courier.db}. Nothing of it leaves the desk: no shared
 * model, no list from anywhere, no verdict sent to a provider.
 *
 * <p><b>What it learns from.</b> A message the member puts in Spam (Spam, Report, a Request's Block, a block) is spam; one
 * they take out of Spam, or whose sender they let in (Let in, writing to them, moving a stranger's mail to People), is
 * wanted. {@code filter_trained} keeps what each message taught, so a change of mind moves its counts across and nothing is
 * counted twice. At most {@value #TRAIN_PER_ACTION} messages are learned from per action.
 *
 * <p><b>What it judges.</b> Only a stranger's mail that would otherwise be a Request or Other: never the member's own, a
 * known sender's (let in, a contact, someone they wrote to), a reply in a thread they started, or anything a block or a
 * provider's or the door's verdict already decided. The member's word outranks a guess. It acts once it has learned from
 * {@value #MIN_EACH} spam and {@value #MIN_EACH} wanted messages, and only on a score of {@value #SPAM_CUTOFF} or more; what
 * it puts in Spam is marked {@code screen: filter}, so "Not spam" and a later Let in bring it back and teach it.
 *
 * <p><b>The scoring</b> is Robinson's and SpamBayes': each token's spam probability from how often it was in spam and in
 * wanted mail, pulled toward 0.5 when seen little ({@code s} = {@value #UNKNOWN_STRENGTH}), the {@value #MAX_CLUES} tokens
 * furthest from 0.5 combined by Fisher's chi-square.
 *
 * <p><b>Privacy.</b> A token is kept only as a 64-bit SipHash-2-4 under this desk's own random salt
 * ({@code filter_state.salt}), so the store holds no word of anyone's mail in the filter's tables. Counts aren't text, and
 * a message deleted for good leaves its counts (as every such filter does) but not its words.
 */
public final class SpamFilter {

    /** How many spam and how many wanted messages it must have learned from before it acts. */
    public static final int MIN_EACH = 10;
    /** The score at or above which a stranger's message goes to Spam. */
    public static final double SPAM_CUTOFF = 0.95;
    static final double UNKNOWN_STRENGTH = 0.45;
    static final double UNKNOWN_PROB = 0.5;
    static final double MIN_STRENGTH = 0.1;
    static final int MAX_CLUES = 150;
    /** The most of a message's text it reads, in characters, and the most distinct tokens it keeps. */
    static final int TEXT_CHARS = 32 * 1024;
    static final int MAX_TOKENS = 1500;
    /** The most messages one action of the member's teaches it. */
    public static final int TRAIN_PER_ACTION = 100;
    /** Past this many tokens, the sweep drops those seen once. */
    static final long MAX_ROWS = 300_000;

    public static final String SPAM = "spam";
    public static final String HAM = "ham";

    private final BooleanSupplier on;
    private volatile long[] key;

    SpamFilter(BooleanSupplier on) {
        this.on = on;
    }

    // ---- features

    private static final Pattern URL = Pattern.compile("(?i)\\b(?:https?|ftp)://([^/\\s<>\"'?#:]{1,253})");
    private static final Pattern EMAIL = Pattern.compile("[^\\s<>@\"']{1,64}@([^\\s<>@\"'/]{1,253})");

    /**
     * A message's features, the same from an arriving message and from a stored one: words of its subject, sender, text
     * and attachments, each field marked, plus a few facts about it. Distinct, at most {@value #MAX_TOKENS}.
     */
    static Set<String> features(String subject, String fromAddress, String fromName, String text, List<String[]> attachments,
            boolean bulk, String dmarc) {
        Set<String> out = new LinkedHashSet<>();
        if (fromAddress != null) {
            out.add("from:" + fromAddress);
            String d = Norm.domain(fromAddress);
            if (d != null) {
                out.add("fromd:" + d);
                out.add("fromr:" + Senders.registrable(d));
            }
        } else {
            out.add("x:nofrom");
        }
        words(fromName, "fn:", out, 200);
        if (fromName == null || fromName.isBlank()) {
            out.add("x:noname");
        }
        if (subject == null || subject.isBlank()) {
            out.add("x:nosubject");
        } else {
            words(subject, "s:", out, 1000);
            int upper = 0;
            int letters = 0;
            for (int i = 0; i < subject.length(); i++) {
                char ch = subject.charAt(i);
                if (Character.isLetter(ch)) {
                    letters++;
                    if (Character.isUpperCase(ch)) {
                        upper++;
                    }
                }
            }
            if (letters >= 8 && upper * 10 >= letters * 7) {
                out.add("x:shouting");
            }
        }
        String body = text == null ? "" : text.length() > TEXT_CHARS ? text.substring(0, TEXT_CHARS) : text;
        Matcher u = URL.matcher(body);
        int urls = 0;
        while (u.find() && urls < 50) {
            urls++;
            String host = u.group(1).toLowerCase(Locale.ROOT);
            out.add("url:" + host);
            out.add("urlr:" + Senders.registrable(host));
        }
        if (urls > 0) {
            out.add("x:urls:" + Math.min(urls, 10));
        }
        Matcher e = EMAIL.matcher(body);
        int emails = 0;
        while (e.find() && emails < 20) {
            emails++;
            out.add("email:" + e.group(1).toLowerCase(Locale.ROOT));
        }
        words(body, "", out, MAX_TOKENS);
        if (body.isBlank()) {
            out.add("x:notext");
        }
        if (attachments != null) {
            for (String[] a : attachments) {
                String name = a[0];
                if (name != null) {
                    int dot = name.lastIndexOf('.');
                    if (dot >= 0 && dot < name.length() - 1 && name.length() - dot <= 12) {
                        out.add("att:ext:" + name.substring(dot + 1).toLowerCase(Locale.ROOT));
                    }
                }
                if (a[1] != null) {
                    out.add("att:type:" + a[1].toLowerCase(Locale.ROOT));
                }
                if (a[2] != null) {
                    out.add("att:danger:" + a[2]);
                }
            }
        }
        if (bulk) {
            out.add("x:bulk");
        }
        out.add("x:dmarc:" + (dmarc == null ? "none" : dmarc.toLowerCase(Locale.ROOT)));
        if (out.size() > MAX_TOKENS) {
            Set<String> cut = new LinkedHashSet<>();
            for (String t : out) {
                if (cut.size() == MAX_TOKENS) {
                    break;
                }
                cut.add(t);
            }
            return cut;
        }
        return out;
    }

    /**
     * Words of a text, folded (case, accents, compatibility forms): runs of letters and digits from 3 to 24 characters, a
     * longer one as its first letters and length, and the scripts written without spaces (Chinese, Japanese, Korean, Thai)
     * as pairs of characters.
     */
    private static void words(String s, String prefix, Set<String> out, int max) {
        if (s == null || s.isEmpty()) {
            return;
        }
        String f = Norm.fold(Normalizer.normalize(s, Normalizer.Form.NFKC));
        StringBuilder w = new StringBuilder();
        int prevSpaceless = -1;
        int added = 0;
        for (int i = 0; i <= f.length() && out.size() < MAX_TOKENS * 2 && added < max; ) {
            int cp = i < f.length() ? f.codePointAt(i) : ' ';
            i += i < f.length() ? Character.charCount(cp) : 1;
            if (spaceless(cp)) {
                if (prevSpaceless >= 0) {
                    out.add(prefix + "c:" + new String(Character.toChars(prevSpaceless)) + new String(Character.toChars(cp)));
                    added++;
                }
                prevSpaceless = cp;
                flush(w, prefix, out);
                continue;
            }
            prevSpaceless = -1;
            if (Character.isLetterOrDigit(cp)) {
                w.appendCodePoint(cp);
            } else {
                if (flush(w, prefix, out)) {
                    added++;
                }
            }
        }
        flush(w, prefix, out);
    }

    private static boolean flush(StringBuilder w, String prefix, Set<String> out) {
        int n = w.length();
        if (n == 0) {
            return false;
        }
        String word = w.toString();
        w.setLength(0);
        if (n < 3) {
            return false;
        }
        out.add(n <= 24 ? prefix + word : prefix + "long:" + word.codePointAt(0) + ":" + (n / 10));
        return true;
    }

    private static boolean spaceless(int cp) {
        Character.UnicodeScript s = Character.UnicodeScript.of(cp);
        return s == Character.UnicodeScript.HAN || s == Character.UnicodeScript.HIRAGANA || s == Character.UnicodeScript.KATAKANA
                || s == Character.UnicodeScript.THAI || (s == Character.UnicodeScript.HANGUL && Character.isLetter(cp));
    }

    /** A stored message's features, read from its row: the same words an arriving one gives. */
    static Set<String> stored(Connection c, long seq) throws SQLException {
        Object[] row = Sql.one(c, """
                SELECT m.subject, e.value, m.search_from, m.body_text, m.bulk, m.auth FROM messages m
                LEFT JOIN endpoints e ON e.id = m.from_endpoint WHERE m.seq = ?""",
                r -> new Object[] {r.getString(1), r.getString(2), r.getString(3),
                        r.getString(4) == null ? null : r.getString(4).substring(0, Math.min(r.getString(4).length(), TEXT_CHARS)),
                        r.getInt(5) == 1, r.getString(6)}, seq);
        if (row == null) {
            return null;
        }
        String address = (String) row[1];
        String searchFrom = (String) row[2];
        // search_from is the name as the message had it, a space, then the address (which holds no space).
        String name = null;
        int space = searchFrom == null ? -1 : searchFrom.lastIndexOf(' ');
        if (space > 0) {
            name = searchFrom.substring(0, space).strip();
        }
        String dmarc = null;
        Map<String, Object> auth = Queries.auth((String) row[5]);
        if (auth != null && auth.get("dmarc") instanceof String d) {
            dmarc = d;
        }
        List<String[]> attachments = Sql.list(c, "SELECT name, type, danger FROM attachments WHERE message_seq = ? LIMIT 50",
                r -> new String[] {r.getString(1), r.getString(2), r.getString(3)}, seq);
        return features((String) row[0], address, name == null || name.isEmpty() ? null : name, (String) row[3], attachments,
                (Boolean) row[4], dmarc);
    }

    // ---- scoring

    /** Whether the kill switch allows it ({@code filter-off}). */
    boolean switchedOn() {
        return on.getAsBoolean();
    }

    /**
     * The message's spam score, from 0 (wanted) to 1 (spam), or null when the filter doesn't act: switched off, or not yet
     * taught {@value #MIN_EACH} of each.
     */
    Double score(Connection c, Set<String> features) throws SQLException {
        if (!switchedOn() || features == null || features.isEmpty()) {
            return null;
        }
        long[] totals = totals(c);
        if (totals[0] < MIN_EACH || totals[1] < MIN_EACH) {
            return null;
        }
        Map<Long, long[]> counts = counts(c, hashes(c, features));
        return combine(counts.values(), totals[0], totals[1]);
    }

    static double combine(Iterable<long[]> counts, long nspam, long nham) {
        List<Double> clues = new ArrayList<>();
        for (long[] sh : counts) {
            double spamRatio = (double) sh[0] / Math.max(1, nspam);
            double hamRatio = (double) sh[1] / Math.max(1, nham);
            if (spamRatio + hamRatio == 0) {
                continue;
            }
            double p = spamRatio / (spamRatio + hamRatio);
            double n = sh[0] + sh[1];
            p = (UNKNOWN_STRENGTH * UNKNOWN_PROB + n * p) / (UNKNOWN_STRENGTH + n);
            if (Math.abs(p - 0.5) >= MIN_STRENGTH) {
                clues.add(p);
            }
        }
        if (clues.isEmpty()) {
            return 0.5;
        }
        clues.sort((a, b) -> Double.compare(Math.abs(b - 0.5), Math.abs(a - 0.5)));
        List<Double> used = clues.size() > MAX_CLUES ? clues.subList(0, MAX_CLUES) : clues;
        double lnS = 0;
        double lnH = 0;
        for (double p : used) {
            double q = Math.min(1 - 1e-9, Math.max(1e-9, p));
            lnS += Math.log(1 - q);
            lnH += Math.log(q);
        }
        int n = used.size();
        double s = 1 - chi2Q(-2 * lnS, 2 * n);
        double h = 1 - chi2Q(-2 * lnH, 2 * n);
        return (s - h + 1) / 2;
    }

    /** The chi-square survival function for an even number of degrees of freedom. */
    static double chi2Q(double x2, int v) {
        double m = x2 / 2;
        double term = Math.exp(-m);
        double sum = term;
        for (int i = 1; i < v / 2; i++) {
            term *= m / i;
            sum += term;
        }
        return Math.min(sum, 1.0);
    }

    // ---- training

    /**
     * Teaches it one class for some messages (the first {@value #TRAIN_PER_ACTION}): each one's counts move across if it
     * taught the other class before, and nothing happens if it already taught this one. Pending messages teach nothing.
     */
    void train(Connection c, List<Long> seqs, String cls, long now) throws SQLException {
        if (seqs == null || seqs.isEmpty()) {
            return;
        }
        int n = 0;
        for (Long seq : seqs) {
            if (n++ >= TRAIN_PER_ACTION) {
                break;
            }
            String[] m = Sql.one(c, "SELECT id, lane FROM messages WHERE seq = ?", r -> new String[] {r.getString(1), r.getString(2)}, seq);
            if (m == null || Lanes.PENDING.equals(m[1])) {
                continue;
            }
            String before = Sql.stringOne(c, "SELECT class FROM filter_trained WHERE message_id = ?", m[0]);
            if (cls.equals(before)) {
                continue;
            }
            Set<String> features = stored(c, seq);
            if (features == null) {
                continue;
            }
            long[] hashes = hashes(c, features);
            if (before != null) {
                add(c, hashes, before, -1);
            }
            add(c, hashes, cls, +1);
            Sql.update(c, "INSERT INTO filter_trained (message_id, class, at) VALUES (?, ?, ?) "
                    + "ON CONFLICT (message_id) DO UPDATE SET class = excluded.class, at = excluded.at", m[0], cls, now);
            Sql.update(c, "UPDATE filter_state SET spam = max(0, spam + ?), ham = max(0, ham + ?), updated_at = ? WHERE id = 1",
                    (SPAM.equals(cls) ? 1 : 0) - (SPAM.equals(before) ? 1 : 0), (HAM.equals(cls) ? 1 : 0) - (HAM.equals(before) ? 1 : 0), now);
        }
    }

    private static void add(Connection c, long[] hashes, String cls, int delta) throws SQLException {
        boolean spam = SPAM.equals(cls);
        if (delta > 0) {
            try (PreparedStatement ps = c.prepareStatement("INSERT INTO filter_tokens (h, spam, ham) VALUES (?, ?, ?) "
                    + "ON CONFLICT (h) DO UPDATE SET spam = spam + excluded.spam, ham = ham + excluded.ham")) {
                for (long h : hashes) {
                    ps.setLong(1, h);
                    ps.setInt(2, spam ? 1 : 0);
                    ps.setInt(3, spam ? 0 : 1);
                    ps.addBatch();
                }
                ps.executeBatch();
            }
        } else {
            try (PreparedStatement ps = c.prepareStatement(spam
                    ? "UPDATE filter_tokens SET spam = max(0, spam - 1) WHERE h = ?"
                    : "UPDATE filter_tokens SET ham = max(0, ham - 1) WHERE h = ?");
                    PreparedStatement gone = c.prepareStatement("DELETE FROM filter_tokens WHERE h = ? AND spam = 0 AND ham = 0")) {
                for (long h : hashes) {
                    ps.setLong(1, h);
                    ps.addBatch();
                    gone.setLong(1, h);
                    gone.addBatch();
                }
                ps.executeBatch();
                gone.executeBatch();
            }
        }
    }

    /** What the member's own decisions have taught it: {spam, ham}. */
    static long[] totals(Connection c) throws SQLException {
        long[] t = Sql.one(c, "SELECT spam, ham FROM filter_state WHERE id = 1", r -> new long[] {r.getLong(1), r.getLong(2)});
        return t == null ? new long[] {0, 0} : t;
    }

    /** For {@code courier.status}: whether it acts, and what it has learned from. */
    Map<String, Object> status(Connection c) throws SQLException {
        long[] t = totals(c);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("state", !switchedOn() ? "off" : t[0] >= MIN_EACH && t[1] >= MIN_EACH ? "on" : "learning");
        out.put("spam", t[0]);
        out.put("wanted", t[1]);
        return out;
    }

    /** Keeps the table bounded: past {@value #MAX_ROWS} tokens, those seen only once go. @return how many went */
    int prune(Connection c) throws SQLException {
        Long rows = Sql.longOne(c, "SELECT count(*) FROM filter_tokens");
        if (rows == null || rows <= MAX_ROWS) {
            return 0;
        }
        return Sql.update(c, "DELETE FROM filter_tokens WHERE spam + ham <= 1");
    }

    private static Map<Long, long[]> counts(Connection c, long[] hashes) throws SQLException {
        Map<Long, long[]> out = new HashMap<>();
        int chunk = 400;
        for (int from = 0; from < hashes.length; from += chunk) {
            int to = Math.min(hashes.length, from + chunk);
            StringBuilder sql = new StringBuilder("SELECT h, spam, ham FROM filter_tokens WHERE h IN (");
            sql.append(Sql.marks(to - from)).append(')');
            try (PreparedStatement ps = c.prepareStatement(sql.toString())) {
                for (int i = from; i < to; i++) {
                    ps.setLong(i - from + 1, hashes[i]);
                }
                try (ResultSet r = ps.executeQuery()) {
                    while (r.next()) {
                        out.put(r.getLong(1), new long[] {r.getLong(2), r.getLong(3)});
                    }
                }
            }
        }
        return out;
    }

    // ---- hashing

    long[] hashes(Connection c, Set<String> features) throws SQLException {
        long[] k = key(c);
        long[] out = new long[features.size()];
        int i = 0;
        for (String f : features) {
            out[i++] = sipHash24(k[0], k[1], f.getBytes(StandardCharsets.UTF_8));
        }
        Arrays.sort(out);
        int n = 0;
        for (int j = 0; j < out.length; j++) {
            if (j == 0 || out[j] != out[j - 1]) {
                out[n++] = out[j];
            }
        }
        return n == out.length ? out : Arrays.copyOf(out, n);
    }

    private long[] key(Connection c) throws SQLException {
        long[] k = key;
        if (k != null) {
            return k;
        }
        byte[] salt = Sql.one(c, "SELECT salt FROM filter_state WHERE id = 1", r -> r.getBytes(1));
        if (salt == null || salt.length < 16) {
            throw new SQLException("filter salt");
        }
        k = new long[] {le(salt, 0), le(salt, 8)};
        key = k;
        return k;
    }

    private static long le(byte[] b, int off) {
        long v = 0;
        for (int i = 7; i >= 0; i--) {
            v = (v << 8) | (b[off + i] & 0xFF);
        }
        return v;
    }

    /** SipHash-2-4 (Aumasson and Bernstein), 64-bit output. */
    static long sipHash24(long k0, long k1, byte[] m) {
        long v0 = 0x736f6d6570736575L ^ k0;
        long v1 = 0x646f72616e646f6dL ^ k1;
        long v2 = 0x6c7967656e657261L ^ k0;
        long v3 = 0x7465646279746573L ^ k1;
        int len = m.length;
        int end = len - (len % 8);
        for (int i = 0; i < end; i += 8) {
            long mi = le(m, i);
            v3 ^= mi;
            for (int r = 0; r < 2; r++) {
                v0 += v1; v1 = Long.rotateLeft(v1, 13); v1 ^= v0; v0 = Long.rotateLeft(v0, 32);
                v2 += v3; v3 = Long.rotateLeft(v3, 16); v3 ^= v2;
                v0 += v3; v3 = Long.rotateLeft(v3, 21); v3 ^= v0;
                v2 += v1; v1 = Long.rotateLeft(v1, 17); v1 ^= v2; v2 = Long.rotateLeft(v2, 32);
            }
            v0 ^= mi;
        }
        long b = ((long) len) << 56;
        for (int i = len - 1; i >= end; i--) {
            b |= ((long) (m[i] & 0xFF)) << (8 * (i - end));
        }
        v3 ^= b;
        for (int r = 0; r < 2; r++) {
            v0 += v1; v1 = Long.rotateLeft(v1, 13); v1 ^= v0; v0 = Long.rotateLeft(v0, 32);
            v2 += v3; v3 = Long.rotateLeft(v3, 16); v3 ^= v2;
            v0 += v3; v3 = Long.rotateLeft(v3, 21); v3 ^= v0;
            v2 += v1; v1 = Long.rotateLeft(v1, 17); v1 ^= v2; v2 = Long.rotateLeft(v2, 32);
        }
        v0 ^= b;
        v2 ^= 0xff;
        for (int r = 0; r < 4; r++) {
            v0 += v1; v1 = Long.rotateLeft(v1, 13); v1 ^= v0; v0 = Long.rotateLeft(v0, 32);
            v2 += v3; v3 = Long.rotateLeft(v3, 16); v3 ^= v2;
            v0 += v3; v3 = Long.rotateLeft(v3, 21); v3 ^= v0;
            v2 += v1; v1 = Long.rotateLeft(v1, 17); v1 ^= v2; v2 = Long.rotateLeft(v2, 32);
        }
        return v0 ^ v1 ^ v2 ^ v3;
    }
}
