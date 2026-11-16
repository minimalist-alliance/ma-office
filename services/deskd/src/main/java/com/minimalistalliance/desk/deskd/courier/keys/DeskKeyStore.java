package com.minimalistalliance.desk.deskd.courier.keys;

import com.minimalistalliance.desk.courier.envelope.BoxKeyPair;
import com.minimalistalliance.desk.courier.envelope.IdentityKeyPair;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.file.DirectoryStream;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.FileAttribute;
import java.nio.file.attribute.PosixFilePermission;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.List;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The desk's Courier keys on its own disk, in {@code /data/keys} (design §10.4's reserved place for the relay's identity
 * keys; the launch plan §2.3): one Ed25519 identity key and the X25519 box keys, the current one and the retired ones still
 * kept to open envelopes sealed to them. Only the public halves ever leave the desk ({@link DeskKeys} publishes them).
 *
 * <pre>
 * /data/keys/                 0700, uid 1100 (deskd); desk-datadirs makes it, deskd never does
 *   identity.key              0600  "MAIK" || 0x01 || i64be createdAt || seed (32) || SHA-256 of the 45 bytes before
 *   box-&lt;id hex&gt;.key         0600  "MABK" || 0x01 || i64be createdAt || secret (32) || SHA-256 of the 45 bytes before
 * </pre>
 *
 * The digest only catches a file that's cut or changed by accident: whoever can write here can write a key. The newest
 * box key is the current one; each other was retired when the next one was made, and is deleted {@link #RETAIN} after
 * that, past the relay's longest wait (90 days for mail). Every write is a temporary file, fsynced, renamed, then the
 * directory fsynced. Files are read without following links, as regular files of exactly their size.
 *
 * <p><b>Fails safe, never quietly.</b> A file that's provably not a key (cut, changed, the wrong size or type) is renamed
 * aside ({@code .bad-N}), never overwritten; one that can't be read for any other reason (not ours, an I/O error) leaves the
 * keys unavailable and the file as it is. A damaged identity means a new identity: contacts then see a key change, which is
 * the truth, and {@code replacedAt} says so. No directory (an image before this one) means no keys: Courier's member messages and
 * the mail door are unavailable, nothing else changes.
 *
 * <p>The honest limit (ADR 0042, ADR 0074): the keys sit on the desk's volume in the clear. Root on the running desk, or
 * whoever holds the volume or a snapshot, can read them, as everything else on a desk.
 */
final class DeskKeyStore {

    private static final Logger log = LoggerFactory.getLogger(DeskKeyStore.class);

    static final String IDENTITY = "identity.key";
    static final String BOX_PREFIX = "box-";
    static final String SUFFIX = ".key";
    private static final String TEMPORARY = ".tmp";
    private static final byte[] IDENTITY_MAGIC = {'M', 'A', 'I', 'K'};
    private static final byte[] BOX_MAGIC = {'M', 'A', 'B', 'K'};
    private static final byte VERSION = 1;
    static final int FILE_BYTES = 4 + 1 + 8 + 32 + 32;

    /** How long a retired box key is kept: the relay's 90-day mail wait, plus a week. */
    static final long RETAIN = 97L * 86_400_000L;

    private static final Set<PosixFilePermission> OWNER_DIRECTORY = PosixFilePermissions.fromString("rwx------");
    private static final Set<PosixFilePermission> OWNER_FILE = PosixFilePermissions.fromString("rw-------");
    private static final FileAttribute<Set<PosixFilePermission>> CREATE_FILE = PosixFilePermissions.asFileAttribute(OWNER_FILE);

    /** How a write reaches the disk. A test's can fail, to see what a failed write leaves behind. */
    @FunctionalInterface
    interface Sync {
        void force(FileChannel channel) throws IOException;
    }

    /** A key file that's there but isn't one: cut, changed, the wrong size, not a regular file. Set aside, never trusted. */
    static final class Damaged extends IOException {
        Damaged(String why) {
            super(why);
        }
    }

    /** What's on disk, loaded. Box keys newest first. */
    record Loaded(IdentityKeyPair identity, long identityCreatedAt, List<BoxKeyPair> boxes, long replacedAt) {}

    private final Path directory;
    private final SecureRandom random;
    private final Sync sync;

    DeskKeyStore(Path directory, SecureRandom random) {
        this(directory, random, channel -> channel.force(true));
    }

    DeskKeyStore(Path directory, SecureRandom random, Sync sync) {
        this.directory = directory;
        this.random = random;
        this.sync = sync;
    }

    Path directory() {
        return directory;
    }

    /**
     * Loads the keys, making what's missing: an identity, and a box key if there's none. Tightens modes, removes a crash's
     * temporary files, renames unreadable files aside.
     *
     * @throws IOException if the directory isn't there or isn't usable, or a key can't be written
     */
    Loaded load(long now) throws IOException {
        BasicFileAttributes dir;
        try {
            dir = Files.readAttributes(directory, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
        } catch (NoSuchFileException e) {
            throw new IOException("no keys directory");
        }
        if (!dir.isDirectory()) {
            throw new IOException("the keys path isn't a directory");
        }
        tighten(directory, OWNER_DIRECTORY);
        List<Path> boxFiles = new ArrayList<>();
        try (DirectoryStream<Path> entries = Files.newDirectoryStream(directory)) {
            for (Path entry : entries) {
                String name = entry.getFileName().toString();
                if (name.endsWith(TEMPORARY)) {
                    Files.deleteIfExists(entry);
                } else if (Files.isRegularFile(entry, LinkOption.NOFOLLOW_LINKS)) {
                    tighten(entry, OWNER_FILE);
                    if (name.startsWith(BOX_PREFIX) && name.endsWith(SUFFIX)) {
                        boxFiles.add(entry);
                    }
                }
            }
        }
        long replacedAt = -1;
        IdentityKeyPair identity;
        long identityCreatedAt;
        Path identityFile = directory.resolve(IDENTITY);
        byte[] seed = null;
        try {
            Record r = read(identityFile, IDENTITY_MAGIC);
            seed = r.secret();
            identity = IdentityKeyPair.fromSeed(seed);
            identityCreatedAt = r.createdAt();
        } catch (NoSuchFileException e) {
            identityCreatedAt = now;
            identity = writeIdentity(now);
            if (boxFiles.isEmpty()) {
                log.info("courier keys: made this desk's identity key");
            } else {
                // Box keys without an identity: not a first start, so the identity was lost (Security CK-I2).
                replacedAt = now;
                log.warn("courier keys: the identity key was missing, so a new one is made; contacts will see a key change");
            }
        } catch (Damaged e) {
            // Only a file that's provably not a key is replaced. Anything else (not ours to read, an I/O error) leaves it as
            // it is and the keys unavailable, so fixing the cause brings the same identity back.
            Path aside = aside(identityFile);
            identityCreatedAt = now;
            identity = writeIdentity(now);
            replacedAt = now;
            log.warn("courier keys: the identity key didn't read ({}), so it's now {} and a new identity is made; contacts will see a"
                    + " key change", e.getMessage(), aside.getFileName());
        } finally {
            zero(seed);
        }
        List<BoxKeyPair> boxes = new ArrayList<>();
        for (Path f : boxFiles) {
            byte[] secret = null;
            try {
                Record r = read(f, BOX_MAGIC);
                secret = r.secret();
                BoxKeyPair b = BoxKeyPair.fromSecret(secret, r.createdAt());
                if (!f.getFileName().toString().equals(boxName(b))) {
                    throw new Damaged("named for another key");
                }
                boxes.add(b);
            } catch (Damaged | IllegalArgumentException e) {
                Path aside = aside(f);
                log.warn("courier keys: a box key didn't read ({}), so it's now {}", e.getMessage(), aside.getFileName());
            } finally {
                zero(secret);
            }
        }
        if (replacedAt >= 0 && !boxes.isEmpty()) {
            // The old box keys belonged to the old identity: keep them to open what's waiting, but sealed new mail must go
            // to a box key the new identity binds.
            boxes.add(writeBox(Math.max(now, boxes.stream().mapToLong(BoxKeyPair::createdAt).max().orElse(now) + 1)));
        }
        if (boxes.isEmpty()) {
            boxes.add(writeBox(now));
        }
        boxes.sort(Comparator.comparingLong(BoxKeyPair::createdAt).reversed());
        return new Loaded(identity, identityCreatedAt, List.copyOf(boxes), replacedAt);
    }

    /** Makes and writes a new box key, which becomes the current one. Its time is at least a millisecond past {@code after}. */
    BoxKeyPair rotate(long now, long after) throws IOException {
        return writeBox(Math.max(now, after + 1));
    }

    /** A new identity over the old one, atomically, and a box key it binds. The old box keys stay until they expire. */
    Loaded resetIdentity(long now, List<BoxKeyPair> keep) throws IOException {
        IdentityKeyPair identity = writeIdentity(now);
        long after = keep.stream().mapToLong(BoxKeyPair::createdAt).max().orElse(now - 1);
        List<BoxKeyPair> boxes = new ArrayList<>(keep);
        boxes.add(writeBox(Math.max(now, after + 1)));
        boxes.sort(Comparator.comparingLong(BoxKeyPair::createdAt).reversed());
        return new Loaded(identity, now, List.copyOf(boxes), now);
    }

    /**
     * Deletes retired box keys kept past {@link #RETAIN}: each was retired when the next newer one was made. Never the
     * current one.
     *
     * @return the box keys left, newest first
     */
    List<BoxKeyPair> expire(List<BoxKeyPair> boxes, long now) {
        List<BoxKeyPair> kept = new ArrayList<>();
        int removed = 0;
        for (int i = 0; i < boxes.size(); i++) {
            BoxKeyPair b = boxes.get(i);
            long retiredAt = i == 0 ? Long.MAX_VALUE : boxes.get(i - 1).createdAt();
            if (i > 0 && retiredAt + RETAIN <= now) {
                try {
                    Files.deleteIfExists(directory.resolve(boxName(b)));
                    removed++;
                    continue;
                } catch (IOException e) {
                    log.warn("courier keys: an expired box key couldn't be deleted ({})", e.getClass().getSimpleName());
                }
            }
            kept.add(b);
        }
        if (removed > 0) {
            try {
                syncDirectory();
            } catch (IOException e) {
                log.warn("courier keys: the directory didn't sync after deleting ({})", e.getClass().getSimpleName());
            }
        }
        return List.copyOf(kept);
    }

    static String boxName(BoxKeyPair b) {
        return BOX_PREFIX + HexFormat.of().formatHex(b.publicKey().id()) + SUFFIX;
    }

    private IdentityKeyPair writeIdentity(long createdAt) throws IOException {
        IdentityKeyPair made = IdentityKeyPair.generate(random);
        byte[] seed = made.seed();
        try {
            writeDurably(directory.resolve(IDENTITY), encode(IDENTITY_MAGIC, createdAt, seed));
        } finally {
            zero(seed);
        }
        return made;
    }

    private BoxKeyPair writeBox(long createdAt) throws IOException {
        BoxKeyPair made = BoxKeyPair.generate(random, createdAt);
        byte[] secret = made.secret();
        try {
            writeDurably(directory.resolve(boxName(made)), encode(BOX_MAGIC, createdAt, secret));
        } finally {
            zero(secret);
        }
        return made;
    }

    private record Record(long createdAt, byte[] secret) {}

    private static ByteBuffer encode(byte[] magic, long createdAt, byte[] secret) {
        ByteBuffer b = ByteBuffer.allocateDirect(FILE_BYTES);
        b.put(magic).put(VERSION).putLong(createdAt).put(secret);
        byte[] head = new byte[FILE_BYTES - 32];
        b.get(0, head);
        b.put(sha256(head));
        zero(head);
        return b.flip();
    }

    private static Record read(Path file, byte[] magic) throws IOException {
        BasicFileAttributes found = Files.readAttributes(file, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
        if (!found.isRegularFile()) {
            throw new Damaged("not a key file");
        }
        if (found.size() != FILE_BYTES) {
            newerFormat(file, magic);
            throw new Damaged("not a key file's size");
        }
        ByteBuffer direct = ByteBuffer.allocateDirect(FILE_BYTES);
        byte[] bytes = new byte[FILE_BYTES];
        try (FileChannel channel = FileChannel.open(file, Set.of(StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS))) {
            while (direct.hasRemaining() && channel.read(direct) >= 0) {
                // Until it's full or the file ends.
            }
            if (direct.hasRemaining()) {
                throw new Damaged("a key file came up short");
            }
            direct.get(0, bytes);
            if (!Arrays.equals(bytes, 0, 4, magic, 0, 4)) {
                throw new Damaged("not in a format this deskd knows");
            }
            if (bytes[4] != VERSION) {
                // A later release's format (Security CK-I1): after a rollback, the keys wait for that release again.
                throw new IOException("a key file from another release's format");
            }
            byte[] check = sha256(Arrays.copyOf(bytes, FILE_BYTES - 32));
            if (!MessageDigest.isEqual(check, Arrays.copyOfRange(bytes, FILE_BYTES - 32, FILE_BYTES))) {
                throw new Damaged("its digest doesn't match");
            }
            long createdAt = ByteBuffer.wrap(bytes, 5, 8).getLong();
            return new Record(createdAt, Arrays.copyOfRange(bytes, 13, 45));
        } finally {
            zero(bytes);
            for (int i = 0; i < FILE_BYTES; i++) {
                direct.put(i, (byte) 0);
            }
        }
    }

    /** Throws (keys unavailable, nothing set aside) if a file of the wrong size starts with this kind's magic and another version. */
    private static void newerFormat(Path file, byte[] magic) throws IOException {
        byte[] head;
        try (java.io.InputStream in = Files.newInputStream(file, LinkOption.NOFOLLOW_LINKS)) {
            head = in.readNBytes(5);
        }
        if (head.length == 5 && Arrays.equals(head, 0, 4, magic, 0, 4) && head[4] != VERSION) {
            throw new IOException("a key file from another release's format");
        }
    }

    private Path aside(Path file) throws IOException {
        for (int i = 1; ; i++) {
            Path aside = directory.resolve(file.getFileName() + ".bad-" + i);
            if (!Files.exists(aside, LinkOption.NOFOLLOW_LINKS)) {
                Files.move(file, aside);
                return aside;
            }
        }
    }

    private void writeDurably(Path target, ByteBuffer content) throws IOException {
        byte[] suffix = new byte[8];
        random.nextBytes(suffix);
        Path temporary = directory.resolve(target.getFileName() + "." + HexFormat.of().formatHex(suffix) + TEMPORARY);
        try {
            try (FileChannel channel = FileChannel.open(temporary, Set.of(StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE), CREATE_FILE)) {
                while (content.hasRemaining()) {
                    channel.write(content);
                }
                sync.force(channel);
            }
            Files.move(temporary, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } catch (IOException | RuntimeException e) {
            try {
                Files.deleteIfExists(temporary);
            } catch (IOException ignored) {
                // The next load removes it.
            }
            throw e;
        } finally {
            for (int i = 0; i < content.capacity(); i++) {
                content.put(i, (byte) 0);
            }
        }
        syncDirectory();
    }

    private void syncDirectory() throws IOException {
        try (FileChannel channel = FileChannel.open(directory, StandardOpenOption.READ)) {
            sync.force(channel);
        }
    }

    private static void tighten(Path path, Set<PosixFilePermission> wanted) throws IOException {
        if (!Files.getPosixFilePermissions(path, LinkOption.NOFOLLOW_LINKS).equals(wanted)) {
            Files.setPosixFilePermissions(path, wanted);
        }
    }

    private static byte[] sha256(byte[] bytes) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(bytes);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    static void zero(byte[] bytes) {
        if (bytes != null) {
            Arrays.fill(bytes, (byte) 0);
        }
    }

    @Override
    public String toString() {
        return "DeskKeyStore[" + directory + "]";
    }
}
