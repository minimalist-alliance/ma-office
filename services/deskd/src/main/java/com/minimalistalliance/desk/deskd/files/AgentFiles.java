package com.minimalistalliance.desk.deskd.files;

import com.minimalistalliance.desk.deskd.rpc.RpcException;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CharsetDecoder;
import java.nio.charset.CharsetEncoder;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.CharBuffer;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;

/**
 * What the Agent's Files tools may do with the member's Files (draft ADR "the Agent's tools and approvals", section 2),
 * through the same tree, trash, quota and change feed as the Files app, and nothing else: a path goes through
 * {@link PathRules} and {@link SafeTree} (links never followed), never names {@code .trash} or {@code .uploads} at any
 * depth, and no call permanently deletes or empties anything. The tools themselves (arguments, approvals, results) are
 * {@code tools.FilesTools}; this is the narrow door into the package's internals. Files' own behaviour is unchanged.
 *
 * <p>Nothing here puts a path, a name or content in an exception message: a {@link Refusal} is one word.
 */
public final class AgentFiles {

    /** Entries one {@link #list} returns, at most. */
    public static final int LIST_MAX = 500;
    /** Hits one {@link #search} returns, at most. */
    public static final int SEARCH_MAX = 100;
    /** Characters one {@link #read} page holds, at most. */
    public static final int PAGE_CHARS = 128 * 1024;
    /** The biggest document (PDF, docx, xlsx, pptx) {@link #read} passes through. */
    public static final long DOCUMENT_MAX_BYTES = 3L * 1024 * 1024;
    /** The most characters of text {@link #write} takes. */
    public static final int WRITE_MAX_CHARS = 256 * 1024;

    private static final int MAX_UTF8_PER_CHAR = 3;
    private static final int CENTRAL_DIRECTORY_MAX = 2 * 1024 * 1024;

    /**
     * Why a call was refused: a word ({@code path}, {@code not_found}, {@code exists}, {@code changed}, {@code not_text},
     * {@code too_large}, {@code no_space}, {@code is_folder}, {@code not_folder}, {@code internal}, {@code cancelled}) and,
     * for {@code no_space}, {@code cap} or {@code floor} in {@code extra}. Never content.
     */
    public static final class Refusal extends Exception {
        private static final long serialVersionUID = 1L;
        private final String word;
        private final transient Map<String, Object> extra;

        Refusal(String word) {
            this(word, Map.of());
        }

        Refusal(String word, Map<String, Object> extra) {
            super(word, null, false, false);
            this.word = word;
            this.extra = Map.copyOf(extra);
        }

        public String word() {
            return word;
        }

        public Map<String, Object> extra() {
            return extra;
        }
    }

    public record Entry(String name, boolean dir, long size, long mtimeMs) {}

    public record Listing(List<Entry> entries, boolean more) {}

    public record Hit(String path, boolean dir) {}

    public record Found(List<Hit> hits, boolean truncated) {}

    /** A file as it is now, for a write's {@code before}. */
    public record Before(String sha256, long bytes) {}

    /** What trashing takes: bytes (a folder's total) and whether it is a folder. */
    public record Taking(long bytes, boolean dir) {}

    /** What a replace was approved against: the SHA-256 of the file then, or null for no file. */
    public record Expect(String sha256) {}

    /**
     * One {@link #read}.
     *
     * @param text a page of text, or null for a document
     * @param offset where the page starts, in bytes of the file
     * @param next where the next page starts, or null at the end
     * @param documentType {@code pdf}, {@code docx}, {@code xlsx} or {@code pptx}, or null for text
     * @param document the whole document, or null for text
     */
    public record Read(String text, long offset, Long next, String documentType, byte[] document) {}

    private final SafeTree tree;
    private final Trash trash;
    private final Quota quota;
    private final ChangeFeed feed;
    private final FilesMethods methods;

    AgentFiles(SafeTree tree, Trash trash, Quota quota, ChangeFeed feed, FilesMethods methods) {
        this.tree = tree;
        this.trash = trash;
        this.quota = quota;
        this.feed = feed;
        this.methods = methods;
    }

    /** Whether the tree opened. Without it nothing works. */
    public boolean available() {
        return tree != null;
    }

    // ---- paths

    /**
     * A path as Files reads it, inside the Files root only.
     *
     * @param rootOk true where {@code ""} and {@code "/"} mean the root
     */
    public String[] path(String value, boolean rootOk) throws Refusal {
        if (value == null) {
            throw new Refusal("path");
        }
        String text = rootOk && value.equals("/") ? "" : value;
        String[] comps;
        try {
            comps = PathRules.parse(text, rootOk, "path");
        } catch (RpcException e) {
            throw new Refusal("path");
        }
        for (String part : comps) {
            if (PathRules.isReserved(part)) {
                throw new Refusal("path");
            }
        }
        return comps;
    }

    private static boolean reservedAnywhere(String path) {
        for (String part : path.split("/", -1)) {
            if (PathRules.isReserved(part)) {
                return true;
            }
        }
        return false;
    }

    // ---- reads

    /** One folder's entries, folders first as Files lists them, at most {@link #LIST_MAX}. */
    public Listing list(String path) throws Refusal {
        String[] comps = path(path, true);
        try {
            SafeTree.Page page = tree.list(comps, null, LIST_MAX, true);
            List<Entry> out = new ArrayList<>();
            for (SafeTree.Entry e : page.entries()) {
                if (!PathRules.isReserved(e.name())) {
                    out.add(new Entry(e.name(), e.dir(), e.size(), e.mtimeMs()));
                }
            }
            return new Listing(out, page.next() != null);
        } catch (SafeTree.TreeException e) {
            throw refusal(e, "not_folder");
        }
    }

    /** Names and paths of at most {@link #SEARCH_MAX} entries whose name holds {@code q}, by Files' own search. */
    public Found search(String q, String under) throws Refusal, InterruptedException {
        String[] from = path(under == null ? "" : under, true);
        if (q == null || q.isEmpty() || q.getBytes(StandardCharsets.UTF_8).length > 255
                || !java.text.Normalizer.isNormalized(q, java.text.Normalizer.Form.NFC)) {
            throw new Refusal("path");
        }
        Map<String, Object> found;
        try {
            found = methods.agentSearch(q, from, SEARCH_MAX);
        } catch (RpcException e) {
            if (RpcException.NOT_FOUND.equals(e.code())) {
                throw new Refusal("not_found");
            }
            if (RpcException.CANCELLED.equals(e.code())) {
                throw new InterruptedException();
            }
            if (PathRules.INVALID.equals(e.code())) {
                throw new Refusal("not_folder");
            }
            throw new Refusal("internal");
        } catch (InterruptedException e) {
            throw e;
        } catch (Exception e) {
            throw new Refusal("internal");
        }
        List<Hit> hits = new ArrayList<>();
        Object entries = found.get("entries");
        if (entries instanceof List<?> list) {
            for (Object o : list) {
                if (o instanceof Map<?, ?> m && m.get("path") instanceof String p && !reservedAnywhere(p)) {
                    hits.add(new Hit(p, "dir".equals(m.get("type"))));
                }
            }
        }
        return new Found(hits, Boolean.TRUE.equals(found.get("truncated")));
    }

    /**
     * A file as text, a page at a time, or a document whole. Text is read from the byte {@code offset} and ends at a
     * character boundary; a PDF, docx, xlsx or pptx (by its first bytes, never its name) up to
     * {@link #DOCUMENT_MAX_BYTES} comes whole. Anything else is {@code not_text} or {@code too_large}.
     */
    public Read read(String path, long offset) throws Refusal {
        String[] comps = path(path, false);
        if (offset < 0) {
            throw new Refusal("path");
        }
        SafeTree.Opened opened;
        try {
            opened = tree.openRead(comps);
        } catch (SafeTree.TreeException e) {
            throw refusal(e, "is_folder");
        }
        try (FileChannel ch = opened.channel()) {
            long size = opened.size();
            ByteBuffer head = ByteBuffer.allocate((int) Math.min(size, ImageSniff.HEAD_BYTES));
            fill(ch, 0, head);
            String type = documentType(ch, size, head.array());
            if (type != null) {
                if (size > DOCUMENT_MAX_BYTES) {
                    throw new Refusal("too_large");
                }
                ByteBuffer all = ByteBuffer.allocate((int) size);
                fill(ch, 0, all);
                return new Read(null, 0, null, type, all.array());
            }
            if (ImageSniff.format(head.array(), head.limit()) != null) {
                throw new Refusal("not_text");
            }
            if (offset > size) {
                throw new Refusal("path");
            }
            return textPage(ch, size, offset);
        } catch (IOException e) {
            throw new Refusal("internal");
        }
    }

    private static Read textPage(FileChannel ch, long size, long offset) throws IOException, Refusal {
        int want = (int) Math.min(size - offset, (long) PAGE_CHARS * MAX_UTF8_PER_CHAR + 4);
        ByteBuffer bytes = ByteBuffer.allocate(want);
        fill(ch, offset, bytes);
        bytes.flip();
        if (offset > 0 && want > 0 && (bytes.get(0) & 0xC0) == 0x80) {
            throw new Refusal("path");
        }
        CharsetDecoder decoder = StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT);
        CharBuffer chars = CharBuffer.allocate(PAGE_CHARS);
        boolean reachedEnd = offset + want >= size;
        java.nio.charset.CoderResult result = decoder.decode(bytes, chars, reachedEnd);
        if (result.isError()) {
            throw new Refusal("not_text");
        }
        if (reachedEnd && result.isUnderflow()) {
            java.nio.charset.CoderResult flushed = decoder.flush(chars);
            if (flushed.isError()) {
                throw new Refusal("not_text");
            }
        }
        chars.flip();
        for (int i = 0; i < chars.length(); i++) {
            if (chars.charAt(i) == 0) {
                throw new Refusal("not_text");
            }
        }
        long consumed = bytes.position();
        long next = offset + consumed;
        return new Read(chars.toString(), offset, next >= size ? null : next, null, null);
    }

    private static void fill(FileChannel ch, long position, ByteBuffer into) throws IOException {
        long at = position;
        while (into.hasRemaining()) {
            int n = ch.read(into, at);
            if (n < 0) {
                break;
            }
            at += n;
        }
    }

    /** {@code pdf}, {@code docx}, {@code xlsx} or {@code pptx} by the file's own bytes, else null. */
    private static String documentType(FileChannel ch, long size, byte[] head) throws IOException {
        if (head.length >= 5 && head[0] == '%' && head[1] == 'P' && head[2] == 'D' && head[3] == 'F' && head[4] == '-') {
            return "pdf";
        }
        if (head.length >= 4 && head[0] == 'P' && head[1] == 'K' && head[2] == 3 && head[3] == 4) {
            return officeType(ch, size);
        }
        return null;
    }

    /** Which Office format a zip is, from the names in its central directory; null for any other zip. */
    private static String officeType(FileChannel ch, long size) throws IOException {
        int tailLength = (int) Math.min(size, 65_557);
        ByteBuffer tail = ByteBuffer.allocate(tailLength);
        fill(ch, size - tailLength, tail);
        byte[] t = tail.array();
        int eocd = -1;
        for (int i = tailLength - 22; i >= 0; i--) {
            if (t[i] == 'P' && t[i + 1] == 'K' && t[i + 2] == 5 && t[i + 3] == 6) {
                eocd = i;
                break;
            }
        }
        if (eocd < 0) {
            return null;
        }
        int entries = u16(t, eocd + 10);
        long cdSize = u32(t, eocd + 12);
        long cdOffset = u32(t, eocd + 16);
        if (cdSize > CENTRAL_DIRECTORY_MAX || cdOffset + cdSize > size) {
            return null;
        }
        ByteBuffer cd = ByteBuffer.allocate((int) cdSize);
        fill(ch, cdOffset, cd);
        byte[] c = cd.array();
        int p = 0;
        for (int n = 0; n < entries && p + 46 <= c.length; n++) {
            if (c[p] != 'P' || c[p + 1] != 'K' || c[p + 2] != 1 || c[p + 3] != 2) {
                return null;
            }
            int nameLength = u16(c, p + 28);
            int extra = u16(c, p + 30);
            int comment = u16(c, p + 32);
            if (p + 46 + nameLength > c.length) {
                return null;
            }
            String name = new String(c, p + 46, nameLength, StandardCharsets.UTF_8);
            if (name.startsWith("word/")) {
                return "docx";
            }
            if (name.startsWith("xl/")) {
                return "xlsx";
            }
            if (name.startsWith("ppt/")) {
                return "pptx";
            }
            p += 46 + nameLength + extra + comment;
        }
        return null;
    }

    private static int u16(byte[] b, int at) {
        return (b[at] & 0xFF) | (b[at + 1] & 0xFF) << 8;
    }

    private static long u32(byte[] b, int at) {
        return (u16(b, at) & 0xFFFFL) | (long) u16(b, at + 2) << 16;
    }

    /** A file's SHA-256 and size now, or null if there is no file there. A folder is {@code is_folder}. */
    public Before fileBefore(String path) throws Refusal {
        String[] comps = path(path, false);
        try {
            return beforeOf(comps);
        } catch (SafeTree.TreeException e) {
            throw refusal(e, "is_folder");
        }
    }

    private Before beforeOf(String[] comps) throws SafeTree.TreeException, Refusal {
        SafeTree.Entry entry = tree.stat(comps);
        if (entry == null) {
            return null;
        }
        if (entry.dir()) {
            throw new Refusal("is_folder");
        }
        SafeTree.Opened opened = tree.openRead(comps);
        try (FileChannel ch = opened.channel()) {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            ByteBuffer buf = ByteBuffer.allocate(64 * 1024);
            long at = 0;
            while (true) {
                buf.clear();
                int n = ch.read(buf, at);
                if (n < 0) {
                    break;
                }
                digest.update(buf.array(), 0, n);
                at += n;
            }
            return new Before(HexFormat.of().formatHex(digest.digest()), at);
        } catch (IOException | NoSuchAlgorithmException e) {
            throw new Refusal("internal");
        }
    }

    // ---- write

    /** Encodes text as UTF-8 for {@link #write}: at most {@link #WRITE_MAX_CHARS} characters, and real text. */
    public static byte[] encode(String text) throws Refusal {
        if (text.length() > WRITE_MAX_CHARS) {
            throw new Refusal("too_large");
        }
        if (text.indexOf('\0') >= 0) {
            throw new Refusal("not_text");
        }
        CharsetEncoder encoder = StandardCharsets.UTF_8.newEncoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT);
        try {
            ByteBuffer out = encoder.encode(CharBuffer.wrap(text));
            byte[] bytes = new byte[out.remaining()];
            out.get(bytes);
            return bytes;
        } catch (CharacterCodingException e) {
            throw new Refusal("not_text");
        }
    }

    /**
     * What a write would meet now, with nothing done: the file there ({@code exists} unless {@code replace}), the parent
     * folder, the free tier's cap and the floor. @return the file there now, or null for none
     */
    public Before checkWrite(String path, long bytes, boolean replace) throws Refusal {
        String[] comps = path(path, false);
        tree.lock.lock();
        try {
            return planWrite(comps, bytes, replace);
        } catch (SafeTree.TreeException e) {
            throw refusal(e, "not_folder");
        } finally {
            tree.lock.unlock();
        }
    }

    private Before planWrite(String[] comps, long bytes, boolean replace) throws SafeTree.TreeException, Refusal {
        requireParent(comps);
        Before current = beforeOf(comps);
        if (current == null) {
            requireFree(comps);
        }
        if (current != null && !replace) {
            throw new Refusal("exists");
        }
        checkRoom(bytes);
        return current;
    }

    private void checkRoom(long bytes) throws Refusal {
        try {
            long cap = quota.cap();
            if (cap >= 0 && quota.capUsed() + bytes > cap) {
                throw new Refusal("no_space", Map.of("cap", true));
            }
            if (bytes > quota.uploadable()) {
                throw new Refusal("no_space", Map.of("floor", true));
            }
        } catch (IOException e) {
            throw new Refusal("internal");
        }
    }

    /**
     * Writes {@code data} as the file at {@code path}. A new file must not exist. A replace is refused {@code changed}
     * unless the file's SHA-256 now is the one expected (null: no file); the old file goes to the trash first, then the
     * new content lands by one rename of a synced temp file beside it. Tells {@code files.changes} subscribers.
     *
     * <p>Holds the last bytes' lock ({@link Quota#room}) that an upload's begin holds, from the check of the room until the
     * file is in place and counted, so a write and an upload can't both take the same last bytes.
     */
    public void write(String path, byte[] data, boolean replace, Expect expect) throws Refusal {
        String[] comps = path(path, false);
        String[] parent = Arrays.copyOf(comps, comps.length - 1);
        String[] temp = SafeTree.append(parent, ".agent-" + HexFormat.of().formatHex(randomBytes()) + ".tmp");
        quota.room.lock();
        try {
            writeHoldingRoom(comps, parent, temp, data, replace, expect);
        } finally {
            quota.room.unlock();
        }
    }

    private void writeHoldingRoom(String[] comps, String[] parent, String[] temp, byte[] data, boolean replace, Expect expect)
            throws Refusal {
        tree.lock.lock();
        boolean tempMade = false;
        try {
            Before current = planWrite(comps, data.length, replace);
            if (replace) {
                String now = current == null ? null : current.sha256();
                if (expect == null || !java.util.Objects.equals(now, expect.sha256())) {
                    throw new Refusal("changed");
                }
            }
            try (FileChannel ch = tree.createNew(temp)) {
                tempMade = true;
                ByteBuffer buf = ByteBuffer.wrap(data);
                while (buf.hasRemaining()) {
                    ch.write(buf);
                }
                ch.force(true);
            }
            String trashId = null;
            if (current != null) {
                trashId = trash.put(comps, PathRules.join(comps), false);
            }
            try {
                tree.move(temp, comps);
                tempMade = false;
            } catch (SafeTree.TreeException e) {
                if (trashId != null) {
                    try {
                        tree.move(trash.itemPath(trashId), comps);
                        trash.forget(trashId);
                    } catch (SafeTree.TreeException ignored) {
                        // The old file is still in the trash, which is where the member can find it.
                    }
                }
                throw e;
            }
            tree.syncDir(parent);
            feed.dir(PathRules.join(parent));
            if (trashId != null) {
                feed.trash();
                quota.forget();
            } else {
                quota.placed(data.length);
            }
        } catch (SafeTree.TreeException e) {
            throw refusal(e, "not_folder");
        } catch (IOException e) {
            throw new Refusal("internal");
        } finally {
            if (tempMade) {
                try {
                    tree.deleteTree(temp);
                } catch (SafeTree.TreeException ignored) {
                    // Left for the next sweep of a folder the member can see; nothing else to do.
                }
            }
            tree.lock.unlock();
        }
    }

    private static byte[] randomBytes() {
        byte[] b = new byte[8];
        new java.security.SecureRandom().nextBytes(b);
        return b;
    }

    // ---- folders, moves, trash

    /** Whether a new folder could be made at {@code path}, with nothing done. */
    public void checkMkdir(String path) throws Refusal {
        mkdir(path, false);
    }

    /** One folder; the parent must exist; {@code exists} if the name is taken. */
    public void mkdir(String path) throws Refusal {
        mkdir(path, true);
    }

    private void mkdir(String path, boolean doIt) throws Refusal {
        String[] comps = path(path, false);
        tree.lock.lock();
        try {
            requireParent(comps);
            if (tree.stat(comps) != null) {
                throw new Refusal("exists");
            }
            requireFree(comps);
            if (doIt) {
                tree.mkdir(comps);
                feed.dir(PathRules.join(Arrays.copyOf(comps, comps.length - 1)));
            }
        } catch (SafeTree.TreeException e) {
            throw refusal(e, "not_folder");
        } finally {
            tree.lock.unlock();
        }
    }

    /** Whether {@code from} could move to {@code to} (which never replaces), with nothing done. */
    public void checkMove(String from, String to) throws Refusal {
        move(from, to, false);
    }

    /** Moves or renames without replacing: {@code exists} if the target is taken, whatever it is. */
    public void move(String from, String to) throws Refusal {
        move(from, to, true);
    }

    private void move(String from, String to, boolean doIt) throws Refusal {
        String[] source = path(from, false);
        String[] target = path(to, false);
        if (PathRules.startsWith(target, source)) {
            throw new Refusal("path");
        }
        tree.lock.lock();
        try {
            if (tree.stat(source) == null) {
                throw new Refusal("not_found");
            }
            requireParent(target);
            if (tree.stat(target) != null) {
                throw new Refusal("exists");
            }
            requireFree(target);
            if (doIt) {
                tree.move(source, target);
                feed.dir(PathRules.join(Arrays.copyOf(source, source.length - 1)));
                feed.dir(PathRules.join(Arrays.copyOf(target, target.length - 1)));
            }
        } catch (SafeTree.TreeException e) {
            throw refusal(e, "not_folder");
        } finally {
            tree.lock.unlock();
        }
    }

    /** What trashing {@code path} would take: a file's size, or a folder's total (counted up to a million entries). */
    public Taking trashBefore(String path) throws Refusal {
        String[] comps = path(path, false);
        tree.lock.lock();
        try {
            SafeTree.Entry entry = tree.stat(comps);
            if (entry == null) {
                throw new Refusal("not_found");
            }
            if (!entry.dir()) {
                return new Taking(entry.size(), false);
            }
            return new Taking(tree.tally(comps, Trash.ENTRY_CAP, () -> Thread.currentThread().isInterrupted(), false).bytes(), true);
        } catch (SafeTree.TreeException e) {
            throw refusal(e, "not_folder");
        } finally {
            tree.lock.unlock();
        }
    }

    /** Moves a file or folder to Files' trash, where the member can restore it. Nothing is deleted for good. */
    public void trash(String path) throws Refusal {
        String[] comps = path(path, false);
        tree.lock.lock();
        try {
            SafeTree.Entry entry = tree.stat(comps);
            if (entry == null) {
                throw new Refusal("not_found");
            }
            trash.put(comps, PathRules.join(comps), entry.dir());
            feed.dir(PathRules.join(Arrays.copyOf(comps, comps.length - 1)));
            feed.trash();
        } catch (SafeTree.TreeException e) {
            throw refusal(e, "not_folder");
        } finally {
            tree.lock.unlock();
        }
        quota.forget();
    }

    // ---- internals

    /** A name Files doesn't list (a link, a device) is still a name that's taken: nothing is made or moved over it. */
    private void requireFree(String[] comps) throws Refusal {
        if (tree.rawAttrs(comps) != null) {
            throw new Refusal("exists");
        }
    }

    /** The folder a path sits in must exist, as a folder. */
    private void requireParent(String[] comps) throws Refusal, SafeTree.TreeException {
        if (comps.length <= 1) {
            return;
        }
        SafeTree.Entry parent = tree.stat(Arrays.copyOf(comps, comps.length - 1));
        if (parent == null) {
            throw new Refusal("not_found");
        }
        if (!parent.dir()) {
            throw new Refusal("not_folder");
        }
    }

    private static Refusal refusal(SafeTree.TreeException e, String notADir) {
        return switch (e.kind()) {
            case NOT_FOUND -> new Refusal("not_found");
            case NOT_A_DIR -> new Refusal(notADir);
            case EXISTS, NOT_EMPTY -> new Refusal("exists");
            case IO -> new Refusal("internal");
        };
    }
}
