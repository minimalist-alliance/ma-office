package com.minimalistalliance.desk.agent.workspace;

import com.minimalistalliance.desk.agent.workspace.WorkspaceException.Reason;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.ByteBuffer;
import java.nio.channels.SeekableByteChannel;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CharsetDecoder;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.LongSupplier;
import java.util.regex.Pattern;

/**
 * A folder per agent under a root ({@code <dataDir>/workspaces/<agentId>/}), with quotas and safe paths
 * (docs/multi-agent.md section 5). Text files only, UTF-8.
 *
 * <p><b>Paths</b> are relative and {@code /}-separated: no leading or trailing {@code /}, no empty, {@code .} or
 * {@code ..} component, no NUL, backslash or control character, at most 16 components, 255 bytes (UTF-8) a component
 * and 1024 bytes in all. {@code ""} means the workspace's top folder and is accepted by {@link #list} only.
 * Unicode format and bidi control characters are refused too. Anything else is {@link Reason#PATH}.
 *
 * <p><b>Links.</b> Every path is walked from the agent's folder one component at a time with
 * {@link LinkOption#NOFOLLOW_LINKS}: the agent's folder itself and every folder on the way must be a real directory,
 * not a link. A link met on the way is {@link Reason#PATH}, never followed. The last component is opened without
 * following links too (O_NOFOLLOW), a write goes to a temporary file in the same folder and is moved over the name
 * atomically (so a link at the final name is replaced, never written through), and {@link #remove} and
 * {@link #deleteAll} delete a link itself and never what it points at. {@link #list} leaves links and special files
 * out.
 *
 * <p><b>Limits that remain.</b> Java has no {@code openat}, so a path is checked component by component and then
 * used by name: a folder swapped for a link between the check and the use would be followed. Nothing here can do that:
 * desk-agent is the only writer and no tool an agent has makes links or renames folders, and the calls of one agent
 * are serialised. Hard links cannot be told from paths (a hard link to a file outside, made by something other than
 * desk-agent, would be read and written like any file). The workspaces root itself is trusted (it is desk-agent's own
 * data directory). A file with more than one hard link is refused ({@link Reason#PATH}) on read and write: a link made
 * by something other than desk-agent could otherwise lead outside the folder.
 *
 * <p><b>Quota and use.</b> {@link #used} is the sum of regular files' sizes and of the folders, each file and each
 * folder counting at least {@link #UNIT} (4 KiB, about a disk block), so empty files and folders fill the quota too.
 * It is cached per agent after the first scan and kept right after each write and delete. Files over 1 MiB of text a
 * write, 10,000 files and 2,000 folders a workspace, and a write is refused when the file store's usable space is
 * under {@code minFreeBytes}.
 *
 * <p>I/O failures other than those above (permissions, a broken disk) surface as {@link UncheckedIOException}; a full
 * disk ({@code ENOSPC}) is {@link Reason#DISK_FULL}.
 */
public final class Workspaces {

    public static final int MAX_WRITE_BYTES = 1024 * 1024;
    public static final int MAX_FILES = 10_000;
    public static final int MAX_FOLDERS = 2_000;
    /** What a file or a folder counts at least toward use. */
    public static final long UNIT = 4096;
    /** The most characters one read answers. */
    public static final int MAX_PAGE_CHARS = 128 * 1024;
    public static final int MAX_LIST = 500;
    public static final int MAX_DEPTH = 16;
    public static final int MAX_COMPONENT_BYTES = 255;
    public static final int MAX_PATH_BYTES = 1024;

    private static final Pattern AGENT_ID = Pattern.compile("[A-Za-z0-9_-]{1,64}");

    /** One file or folder in a listing. {@code path} is relative to the workspace; {@code bytes} is 0 for a folder. */
    public record Entry(String path, boolean dir, long bytes, Instant modifiedAt) {}

    /** A file read as text. {@code bytes} is the file's whole size; {@code truncated} when {@code text} is a prefix. */
    public record Read(String path, String text, long bytes, boolean truncated) {}

    /** One page of a file: {@code remaining} characters follow {@code offset + text.length()}. */
    public record Page(String path, String text, long bytes, long offset, long remaining) {
        public boolean truncated() {
            return remaining > 0;
        }
    }

    private static final class Use {
        long bytes;
        int files;
        int dirs;
    }

    private static long charge(long size) {
        return Math.max(size, UNIT);
    }

    private final Path root;
    private final long minFreeBytes;
    private final LongSupplier freeBytes;
    private final LongSupplier totalBytes;
    private final Map<String, ReentrantLock> locks = new ConcurrentHashMap<>();
    private final Map<String, Use> uses = new ConcurrentHashMap<>();

    public Workspaces(Path root, long minFreeBytes) {
        this(root, minFreeBytes, null, null);
    }

    /**
     * {@code freeBytes} is the usable space of the file store; null for the root's real one. A test that sets only the
     * free space has no budget to hit: the volume then counts as unlimited.
     */
    public Workspaces(Path root, long minFreeBytes, LongSupplier freeBytes) {
        this(root, minFreeBytes, freeBytes, freeBytes != null ? () -> Long.MAX_VALUE / 4 : null);
    }

    /** {@code totalBytes} is the file store's size; null for the root's real one. */
    public Workspaces(Path root, long minFreeBytes, LongSupplier freeBytes, LongSupplier totalBytes) {
        this.root = root;
        this.minFreeBytes = minFreeBytes;
        this.freeBytes = freeBytes != null ? freeBytes : () -> store(root, false);
        this.totalBytes = totalBytes != null ? totalBytes : () -> store(root, true);
    }

    /** The size of the volume the workspaces live on. */
    public long volumeBytes() {
        return totalBytes.getAsLong();
    }

    /** The volume's usable space now. */
    public long volumeFreeBytes() {
        return freeBytes.getAsLong();
    }

    /** The file store of the root, or of its nearest folder that exists (the root is made at the first agent). */
    private static long store(Path root, boolean total) {
        Path p = root.toAbsolutePath();
        while (p != null && !Files.exists(p)) {
            p = p.getParent();
        }
        try {
            var fs = Files.getFileStore(p == null ? root.getRoot() : p);
            return total ? fs.getTotalSpace() : fs.getUsableSpace();
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    // ------------------------------------------------------------ lifecycle

    /** Makes the agent's folder (and the root). Does nothing if it is there. */
    public void create(String agentId) throws WorkspaceException {
        checkId(agentId);
        lock(agentId).lock();
        try {
            Files.createDirectories(root);
            Path dir = root.resolve(agentId);
            BasicFileAttributes a = attrs(dir);
            if (a == null) {
                Files.createDirectory(dir);
            } else if (!a.isDirectory()) {
                throw new WorkspaceException(Reason.PATH);
            }
            uses.remove(agentId);
        } catch (IOException e) {
            throw io(e);
        } finally {
            lock(agentId).unlock();
        }
    }

    /** Deletes the agent's folder and all in it. Links are deleted, never followed. Does nothing if it is gone. */
    public void deleteAll(String agentId) throws WorkspaceException {
        checkId(agentId);
        lock(agentId).lock();
        try {
            Path dir = root.resolve(agentId);
            if (attrs(dir) != null) {
                deleteTree(dir, null);
            }
        } catch (IOException e) {
            throw io(e);
        } finally {
            uses.remove(agentId);
            lock(agentId).unlock();
        }
    }

    // ------------------------------------------------------------ reads

    /** What the agent's files and folders count toward the quota (each at least 4 KiB). */
    public long used(String agentId) throws WorkspaceException {
        checkId(agentId);
        lock(agentId).lock();
        try {
            return use(agentId, agentDir(agentId)).bytes;
        } finally {
            lock(agentId).unlock();
        }
    }

    /** One folder's files and folders, sorted by path, at most 500. {@code ""} is the top folder. */
    public List<Entry> list(String agentId, String dir) throws WorkspaceException {
        return listing(agentId, dir).entries();
    }

    /** A folder's entries (at most 500) and whether there are more. */
    public record Listing(List<Entry> entries, boolean more) {}

    /** Like {@link #list}, and says when the folder has more than 500 entries. */
    public Listing listing(String agentId, String dir) throws WorkspaceException {
        checkId(agentId);
        String[] c = parse(dir, true);
        Path cur = agentDir(agentId);
        for (String part : c) {
            cur = cur.resolve(part);
            BasicFileAttributes a = attrs(cur);
            if (a == null) {
                throw new WorkspaceException(Reason.NOT_FOUND);
            }
            if (!a.isDirectory()) {
                throw new WorkspaceException(Reason.PATH);
            }
        }
        String prefix = c.length == 0 ? "" : String.join("/", c) + "/";
        List<Entry> out = new ArrayList<>();
        try (var ds = Files.newDirectoryStream(cur)) {
            for (Path p : ds) {
                BasicFileAttributes a = attrs(p);
                if (a == null || !(a.isRegularFile() || a.isDirectory()) || (a.isRegularFile() && linked(p))) {
                    continue; // links, special files and files with several hard links are not shown
                }
                out.add(new Entry(prefix + p.getFileName(), a.isDirectory(), a.isDirectory() ? 0 : a.size(),
                        a.lastModifiedTime().toInstant()));
            }
        } catch (IOException e) {
            throw io(e);
        }
        out.sort(Comparator.comparing(Entry::path));
        boolean more = out.size() > MAX_LIST;
        return new Listing(more ? new ArrayList<>(out.subList(0, MAX_LIST)) : out, more);
    }

    /** A file as text, at most {@code maxBytes} bytes of it (cut at a character boundary). */
    public Read read(String agentId, String path, int maxBytes) throws WorkspaceException {
        checkId(agentId);
        String[] c = parse(path, false);
        Path file = walkParents(agentDir(agentId), c);
        BasicFileAttributes a = attrs(file);
        if (a == null) {
            throw new WorkspaceException(Reason.NOT_FOUND);
        }
        if (!a.isRegularFile() || linked(file)) {
            throw new WorkspaceException(Reason.PATH);
        }
        long size = a.size();
        int want = (int) Math.min(Math.max(maxBytes, 0), size);
        ByteBuffer buf = ByteBuffer.allocate(want);
        try (SeekableByteChannel ch = Files.newByteChannel(file, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS)) {
            while (buf.hasRemaining() && ch.read(buf) > 0) {
                // fill
            }
        } catch (NoSuchFileException e) {
            throw new WorkspaceException(Reason.NOT_FOUND);
        } catch (IOException e) {
            throw new WorkspaceException(Reason.PATH); // includes a link swapped in (ELOOP)
        }
        buf.flip();
        boolean truncated = size > buf.limit();
        for (int i = 0; i < buf.limit(); i++) {
            if (buf.get(i) == 0) {
                throw new WorkspaceException(Reason.NOT_TEXT);
            }
        }
        CharsetDecoder dec = StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT);
        // When cut short, an incomplete last character is left undecoded (endOfInput false).
        java.nio.CharBuffer cb = java.nio.CharBuffer.allocate(buf.limit());
        if (dec.decode(buf, cb, !truncated).isError()) {
            throw new WorkspaceException(Reason.NOT_TEXT);
        }
        cb.flip();
        return new Read(String.join("/", c), cb.toString(), size, truncated);
    }

    /**
     * One page of a file as text: {@code length} characters (at most {@link #MAX_PAGE_CHARS}) from character
     * {@code offset}, and how many characters follow. A page never ends inside a surrogate pair.
     */
    public Page page(String agentId, String path, long offset, int length) throws WorkspaceException {
        checkId(agentId);
        String[] c = parse(path, false);
        Path file = walkParents(agentDir(agentId), c);
        BasicFileAttributes a = attrs(file);
        if (a == null) {
            throw new WorkspaceException(Reason.NOT_FOUND);
        }
        if (!a.isRegularFile() || linked(file)) {
            throw new WorkspaceException(Reason.PATH);
        }
        int want = Math.min(Math.max(length, 0), MAX_PAGE_CHARS);
        long skip = Math.max(offset, 0);
        StringBuilder page = new StringBuilder(Math.min(want, 8192));
        long seen = 0;
        CharsetDecoder dec = StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT);
        try (java.io.Reader in = new java.io.InputStreamReader(
                Files.newInputStream(file, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS), dec)) {
            char[] buf = new char[8192];
            int n;
            while ((n = in.read(buf)) > 0) {
                for (int i = 0; i < n; i++) {
                    if (buf[i] == 0) {
                        throw new WorkspaceException(Reason.NOT_TEXT);
                    }
                    if (seen >= skip && page.length() < want) {
                        page.append(buf[i]);
                    }
                    seen++;
                }
            }
        } catch (NoSuchFileException e) {
            throw new WorkspaceException(Reason.NOT_FOUND);
        } catch (CharacterCodingException e) {
            throw new WorkspaceException(Reason.NOT_TEXT);
        } catch (IOException e) {
            throw new WorkspaceException(Reason.PATH); // includes a link swapped in (ELOOP)
        }
        if (page.length() > 1 && Character.isHighSurrogate(page.charAt(page.length() - 1))
                && skip + page.length() < seen) {
            page.setLength(page.length() - 1); // the pair goes whole on the next page
        }
        long end = Math.min(seen, skip + page.length());
        return new Page(String.join("/", c), page.toString(), a.size(), Math.min(skip, seen), seen - end);
    }

    // ------------------------------------------------------------ writes

    /**
     * Writes or appends text. Missing folders are made, one at a time and re-checked. Answers the new use.
     *
     * @param quotaBytes the agent's quota; a write that shrinks the use is allowed even when already over it
     */
    public long write(String agentId, String path, String text, boolean append, long quotaBytes)
            throws WorkspaceException {
        checkId(agentId);
        String[] c = parse(path, false);
        if (text == null) {
            throw new WorkspaceException(Reason.NOT_TEXT);
        }
        byte[] bytes = encode(text);
        if (bytes.length > MAX_WRITE_BYTES) {
            throw new WorkspaceException(Reason.TOO_LARGE);
        }
        lock(agentId).lock();
        List<Path> made = new ArrayList<>();
        boolean ok = false;
        try {
            Path dir = agentDir(agentId);
            Use use = use(agentId, dir);

            // Walk the folders that exist; the first missing one ends the walk.
            Path cur = dir;
            int i = 0;
            for (; i < c.length - 1; i++) {
                Path next = cur.resolve(c[i]);
                BasicFileAttributes a = attrs(next);
                if (a == null) {
                    break;
                }
                if (!a.isDirectory()) {
                    throw new WorkspaceException(Reason.PATH);
                }
                cur = next;
            }
            boolean parentsExist = i == c.length - 1;
            Path target = null;
            long old = 0;
            boolean oldIsFile = false;
            if (parentsExist) {
                target = cur.resolve(c[c.length - 1]);
                BasicFileAttributes a = attrs(target);
                if (a != null) {
                    if (a.isRegularFile()) {
                        if (linked(target)) {
                            throw new WorkspaceException(Reason.PATH);
                        }
                        old = a.size();
                        oldIsFile = true;
                    } else if (a.isSymbolicLink()) {
                        // a link: replaced below, never followed
                    } else {
                        throw new WorkspaceException(Reason.PATH);
                    }
                }
            }
            long size = append ? old + bytes.length : bytes.length;
            int missing = c.length - 1 - i;
            if (!oldIsFile && use.files >= MAX_FILES) {
                throw new WorkspaceException(Reason.TOO_MANY_FILES);
            }
            if (missing > 0 && use.dirs + missing > MAX_FOLDERS) {
                throw new WorkspaceException(Reason.TOO_MANY_FOLDERS);
            }
            long delta = charge(size) - (oldIsFile ? charge(old) : 0) + missing * UNIT;
            if (delta > 0 && use.bytes + delta > quotaBytes) {
                throw new WorkspaceException(Reason.QUOTA);
            }
            if (freeBytes.getAsLong() < minFreeBytes) {
                throw new WorkspaceException(Reason.DISK_FULL);
            }

            for (; i < c.length - 1; i++) {
                Path next = cur.resolve(c[i]);
                try {
                    Files.createDirectory(next);
                    made.add(next);
                } catch (FileAlreadyExistsException e) {
                    // fall through to the re-check
                }
                BasicFileAttributes a = attrs(next);
                if (a == null || !a.isDirectory()) {
                    throw new WorkspaceException(Reason.PATH);
                }
                cur = next;
            }
            if (target == null) {
                target = cur.resolve(c[c.length - 1]);
            }

            if (append && oldIsFile) {
                try (SeekableByteChannel ch = Files.newByteChannel(target, StandardOpenOption.WRITE,
                        StandardOpenOption.APPEND, LinkOption.NOFOLLOW_LINKS)) {
                    writeFully(ch, bytes);
                }
            } else {
                Path tmp = cur.resolve(".ws-" + UUID.randomUUID() + ".tmp");
                try {
                    try (SeekableByteChannel ch = Files.newByteChannel(tmp, StandardOpenOption.CREATE_NEW,
                            StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS)) {
                        writeFully(ch, bytes);
                    }
                    try {
                        Files.move(tmp, target, StandardCopyOption.ATOMIC_MOVE);
                    } catch (AtomicMoveNotSupportedException e) {
                        Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING);
                    }
                } finally {
                    Files.deleteIfExists(tmp);
                }
            }
            use.bytes += delta;
            use.dirs += missing;
            if (!oldIsFile) {
                use.files++;
            }
            ok = true;
            return use.bytes;
        } catch (IOException e) {
            throw io(e);
        } finally {
            if (!ok) {
                for (int k = made.size() - 1; k >= 0; k--) {
                    try {
                        Files.deleteIfExists(made.get(k));
                    } catch (IOException ignored) {
                        // an empty folder left behind is harmless
                    }
                }
                uses.remove(agentId); // rescan next time, whatever got half done
            }
            lock(agentId).unlock();
        }
    }

    /**
     * Deletes a file, or a folder and all in it. A link at the name (or inside the folder) is deleted itself and what
     * it points at is left. Answers the new use.
     */
    public long remove(String agentId, String path) throws WorkspaceException {
        checkId(agentId);
        String[] c = parse(path, false);
        lock(agentId).lock();
        boolean ok = false;
        try {
            Path dir = agentDir(agentId);
            Use use = use(agentId, dir);
            Path target = walkParents(dir, c);
            BasicFileAttributes a = attrs(target);
            if (a == null) {
                throw new WorkspaceException(Reason.NOT_FOUND);
            }
            deleteTree(target, use);
            ok = true;
            return use.bytes;
        } catch (IOException e) {
            throw io(e);
        } finally {
            if (!ok) {
                uses.remove(agentId);
            }
            lock(agentId).unlock();
        }
    }

    // ------------------------------------------------------------ internals

    private static void writeFully(SeekableByteChannel ch, byte[] bytes) throws IOException {
        ByteBuffer b = ByteBuffer.wrap(bytes);
        while (b.hasRemaining()) {
            ch.write(b);
        }
    }

    /** UTF-8 of the text; NUL and lone surrogates are not text. */
    private static byte[] encode(String text) throws WorkspaceException {
        if (text.indexOf('\0') >= 0) {
            throw new WorkspaceException(Reason.NOT_TEXT);
        }
        try {
            ByteBuffer b = StandardCharsets.UTF_8.newEncoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .encode(java.nio.CharBuffer.wrap(text));
            byte[] out = new byte[b.remaining()];
            b.get(out);
            return out;
        } catch (CharacterCodingException e) {
            throw new WorkspaceException(Reason.NOT_TEXT);
        }
    }

    private ReentrantLock lock(String agentId) {
        return locks.computeIfAbsent(agentId, k -> new ReentrantLock());
    }

    private static void checkId(String agentId) throws WorkspaceException {
        if (agentId == null || !AGENT_ID.matcher(agentId).matches()) {
            throw new WorkspaceException(Reason.PATH);
        }
    }

    /** Whether a regular file has more than one hard link. Where the file system can't say, it counts as one. */
    private static boolean linked(Path p) throws WorkspaceException {
        try {
            return Files.getAttribute(p, "unix:nlink", LinkOption.NOFOLLOW_LINKS) instanceof Number n
                    && n.intValue() > 1;
        } catch (UnsupportedOperationException | IllegalArgumentException | NoSuchFileException e) {
            return false;
        } catch (IOException e) {
            throw io(e);
        }
    }

    /** Attributes without following a link; null when nothing is there. */
    private static BasicFileAttributes attrs(Path p) throws WorkspaceException {
        try {
            return Files.readAttributes(p, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
        } catch (NoSuchFileException e) {
            return null;
        } catch (IOException e) {
            throw io(e);
        }
    }

    /** The agent's folder, which must be a real directory (not a link). */
    private Path agentDir(String agentId) throws WorkspaceException {
        Path dir = root.resolve(agentId);
        BasicFileAttributes a = attrs(dir);
        if (a == null) {
            throw new WorkspaceException(Reason.NOT_FOUND);
        }
        if (!a.isDirectory()) {
            throw new WorkspaceException(Reason.PATH);
        }
        return dir;
    }

    /** Walks every component but the last, each a real directory; answers the last component's path. */
    private static Path walkParents(Path dir, String[] c) throws WorkspaceException {
        Path cur = dir;
        for (int i = 0; i < c.length - 1; i++) {
            cur = cur.resolve(c[i]);
            BasicFileAttributes a = attrs(cur);
            if (a == null) {
                throw new WorkspaceException(Reason.NOT_FOUND);
            }
            if (!a.isDirectory()) {
                throw new WorkspaceException(Reason.PATH);
            }
        }
        return cur.resolve(c[c.length - 1]);
    }

    /** The cached use, scanned on first need. Call with the agent's lock held. */
    private Use use(String agentId, Path dir) throws WorkspaceException {
        Use u = uses.get(agentId);
        if (u != null) {
            return u;
        }
        Use fresh = new Use();
        try {
            Files.walkFileTree(dir, new SimpleFileVisitor<>() {
                @Override
                public FileVisitResult preVisitDirectory(Path d, BasicFileAttributes a) {
                    if (!d.equals(dir)) {
                        fresh.bytes += UNIT;
                        fresh.dirs++;
                    }
                    return FileVisitResult.CONTINUE;
                }

                @Override
                public FileVisitResult visitFile(Path f, BasicFileAttributes a) {
                    if (a.isRegularFile()) {
                        fresh.bytes += charge(a.size());
                        fresh.files++;
                    }
                    return FileVisitResult.CONTINUE;
                }
            });
        } catch (IOException e) {
            throw io(e);
        }
        uses.put(agentId, fresh);
        return fresh;
    }

    /** Deletes {@code start} and what is under it, links as links; takes regular files off {@code use}. */
    private static void deleteTree(Path start, Use use) throws IOException {
        Files.walkFileTree(start, new SimpleFileVisitor<>() {
            @Override
            public FileVisitResult visitFile(Path f, BasicFileAttributes a) throws IOException {
                Files.delete(f);
                if (use != null && a.isRegularFile()) {
                    use.bytes -= charge(a.size());
                    use.files--;
                }
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult postVisitDirectory(Path d, IOException e) throws IOException {
                if (e != null) {
                    throw e;
                }
                Files.delete(d);
                if (use != null) {
                    use.bytes -= UNIT;
                    use.dirs--;
                }
                return FileVisitResult.CONTINUE;
            }
        });
    }

    /** The checks that need no disk: shape of a path. */
    private static String[] parse(String path, boolean allowEmpty) throws WorkspaceException {
        if (path == null) {
            throw new WorkspaceException(Reason.PATH);
        }
        if (path.isEmpty()) {
            if (allowEmpty) {
                return new String[0];
            }
            throw new WorkspaceException(Reason.PATH);
        }
        String[] c = path.split("/", -1);
        if (c.length > MAX_DEPTH) {
            throw new WorkspaceException(Reason.PATH);
        }
        long total = 0;
        for (String part : c) {
            if (part.isEmpty() || part.equals(".") || part.equals("..")) {
                throw new WorkspaceException(Reason.PATH);
            }
            int bytes = 0;
            for (int i = 0; i < part.length(); ) {
                int cp = part.codePointAt(i);
                i += Character.charCount(cp);
                if (cp < 0x20 || cp == 0x7f || cp == '\\' || (cp >= 0xD800 && cp <= 0xDFFF)
                        || Character.getType(cp) == Character.FORMAT) { // includes the bidi controls
                    throw new WorkspaceException(Reason.PATH);
                }
                bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
            }
            if (bytes > MAX_COMPONENT_BYTES) {
                throw new WorkspaceException(Reason.PATH);
            }
            total += bytes;
        }
        total += c.length - 1;
        if (total > MAX_PATH_BYTES) {
            throw new WorkspaceException(Reason.PATH);
        }
        return c;
    }

    private static UncheckedIOException ioUnchecked(IOException e) {
        return new UncheckedIOException(e);
    }

    /** A full disk is a reason; any other I/O failure is not ours to name. */
    private static WorkspaceException io(IOException e) {
        String m = e.getMessage();
        if (m != null && m.contains("No space left")) {
            return new WorkspaceException(Reason.DISK_FULL);
        }
        if (e instanceof java.nio.file.FileSystemException fe && fe.getReason() != null
                && fe.getReason().contains("Too many levels of symbolic links")) {
            return new WorkspaceException(Reason.PATH);
        }
        throw ioUnchecked(e);
    }
}
