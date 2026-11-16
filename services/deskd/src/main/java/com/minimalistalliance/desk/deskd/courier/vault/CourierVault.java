package com.minimalistalliance.desk.deskd.courier.vault;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.DirectoryStream;
import java.nio.file.FileAlreadyExistsException;
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
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.Set;
import java.util.concurrent.locks.ReentrantLock;
import java.util.regex.Pattern;
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Linked mailboxes' sign-ins at rest, sealed on the desk's own disk in {@code /data/courier/keys} (the launch plan §3.6),
 * in ADR 0042's format: the same design as desk-agent's {@code KeyVault} for LLM keys, in its own place, with its own
 * master key. No platform key is involved, so a self-hosted desk works the same; no platform service or API can read a
 * sign-in. {@code courier.db}'s {@code accounts} row is the commit point: {@link LinkedAccounts} seals first, then writes
 * the row, and decides what a file without a row or a row without a file means.
 *
 * <p>{@code keys/} is mode 0700. {@code master.key} is 32 random bytes, mode 0600, made once, in memory only while sealing
 * or opening, in an array zeroed straight after and read and written through a direct buffer of its own.
 * {@code <accountId>.sealed} is one file per account, mode 0600: {@code "MAKV"}, a version byte (1), a random 12-byte
 * nonce, then AES-256-GCM ciphertext and tag. The AAD binds the format, the account id and the account's kind
 * ({@code imap}, {@code jmap}), each after its {@code u16be} length, so a file renamed or moved to another row won't
 * open. Every write is a temporary file, fsynced, renamed atomically, then the directory fsynced. Unlike an LLM key, a
 * sign-in can change in place (an OAuth refresh): {@link #replace} is the same write over the old file.
 *
 * <p>Fails closed: a file that's changed by a byte, cut, swapped with another account's, or sealed under another master
 * key doesn't open, and says only which kind of failure it was. Nothing here logs or prints a sign-in.
 *
 * <p>The honest limit (ADR 0042, ADR 0074): {@code master.key} sits beside what it seals. Root on the running desk, or
 * whoever holds the volume or a snapshot, can open it, as with everything else on a desk.
 */
public final class CourierVault {

    private static final Logger log = LoggerFactory.getLogger(CourierVault.class);

    /** How a write reaches the disk. A test's can fail, to see what a failed write leaves behind. */
    @FunctionalInterface
    interface Sync {
        void force(FileChannel channel) throws IOException;
    }

    static final String MASTER = "master.key";
    static final String SEALED = ".sealed";
    private static final String ASIDE = MASTER + ".bad-";
    private static final String TEMPORARY = ".tmp";
    static final int MASTER_BYTES = 32;

    private static final byte[] MAGIC = {'M', 'A', 'K', 'V'};
    private static final byte VERSION = 1;
    private static final int HEADER = MAGIC.length + 1;
    private static final int NONCE_BYTES = 12;
    private static final int TAG_BYTES = 16;
    private static final int MIN_SEALED = HEADER + NONCE_BYTES + 1 + TAG_BYTES;
    private static final int MAX_SEALED = HEADER + NONCE_BYTES + SignIn.MAX_ENCODED + TAG_BYTES;

    /** An account id that is safe as a file name: no dots alone, no separators, nothing hidden. */
    private static final Pattern ID = Pattern.compile("[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}");
    private static final Pattern KIND = Pattern.compile("[a-z0-9_-]{1,32}");

    private static final Set<PosixFilePermission> OWNER_DIRECTORY = PosixFilePermissions.fromString("rwx------");
    private static final Set<PosixFilePermission> OWNER_FILE = PosixFilePermissions.fromString("rw-------");
    private static final FileAttribute<Set<PosixFilePermission>> CREATE_DIRECTORY = PosixFilePermissions.asFileAttribute(OWNER_DIRECTORY);
    private static final FileAttribute<Set<PosixFilePermission>> CREATE_FILE = PosixFilePermissions.asFileAttribute(OWNER_FILE);

    private final ReentrantLock lock = new ReentrantLock();
    private final SecureRandom random = new SecureRandom();
    private final Path directory;
    private final Sync sync;

    public CourierVault(Path directory) {
        this(directory, channel -> channel.force(true));
    }

    CourierVault(Path directory, Sync sync) {
        this.directory = directory;
        this.sync = sync;
    }

    /** Whether {@code id} can name a sealed file. */
    public static boolean validId(String id) {
        return id != null && ID.matcher(id).matches() && !id.endsWith(TEMPORARY) && !id.equals(MASTER) && !id.startsWith(MASTER);
    }

    /**
     * At a start: makes or tightens the directory and its files to the modes above, removes temporary files a crash left,
     * and makes sure there's a master key. Never throws: a bad vault doesn't stop deskd, it leaves sign-ins unavailable.
     */
    public void prepare() {
        lock.lock();
        try {
            ensureDirectory();
            tighten(directory, OWNER_DIRECTORY);
            int untouched = 0;
            try (DirectoryStream<Path> entries = Files.newDirectoryStream(directory)) {
                for (Path entry : entries) {
                    try {
                        if (entry.getFileName().toString().endsWith(TEMPORARY)) {
                            Files.deleteIfExists(entry);
                        } else if (Files.isRegularFile(entry, LinkOption.NOFOLLOW_LINKS)) {
                            tighten(entry, OWNER_FILE);
                        }
                    } catch (IOException e) {
                        untouched++;
                    }
                }
            }
            if (untouched > 0) {
                log.warn("courier vault: {} files couldn't be tightened or removed", untouched);
            }
            Arrays.fill(master(), (byte) 0);
        } catch (IOException | RuntimeException e) {
            log.error("courier vault isn't usable ({}): linked mailboxes read as signed out", e.getClass().getSimpleName());
        } finally {
            lock.unlock();
        }
    }

    /**
     * Seals a sign-in durably for a new account, leaving nothing behind if it can't. The sign-in isn't closed: it's the
     * caller's.
     *
     * @throws IOException if it isn't on disk when this returns, including when the id already has a file, which is left
     *     as it was
     */
    public void seal(String accountId, String kind, SignIn signIn) throws IOException {
        write(accountId, kind, signIn, false);
    }

    /** Seals a sign-in over an account's existing one, atomically: the old one or the new one is there, never neither. */
    public void replace(String accountId, String kind, SignIn signIn) throws IOException {
        write(accountId, kind, signIn, true);
    }

    private void write(String accountId, String kind, SignIn signIn, boolean over) throws IOException {
        Path target = sealedFile(accountId);
        checkKind(kind);
        lock.lock();
        byte[] plain = signIn.encode();
        try {
            ensureDirectory();
            if (!over && Files.exists(target, LinkOption.NOFOLLOW_LINKS)) {
                throw new FileAlreadyExistsException(target.getFileName().toString());
            }
            byte[] sealed = encrypt(accountId, kind, plain);
            try {
                writeDurably(target, ByteBuffer.wrap(sealed));
            } catch (IOException | RuntimeException e) {
                if (!over) {
                    try {
                        Files.deleteIfExists(target);
                    } catch (IOException ignored) {
                        // No row will name it, so the next start removes it as an orphan.
                    }
                }
                throw e;
            }
        } finally {
            Arrays.fill(plain, (byte) 0);
            lock.unlock();
        }
    }

    /**
     * Opens an account's sign-in, which the caller closes.
     *
     * @throws IOException if the file is missing or isn't one, or doesn't open under this master key, id and kind
     */
    public SignIn open(String accountId, String kind) throws IOException {
        Path file = sealedFile(accountId);
        checkKind(kind);
        lock.lock();
        try {
            byte[] sealed = readSealed(file);
            byte[] master = master();
            byte[] plain = new byte[sealed.length - HEADER - NONCE_BYTES - TAG_BYTES];
            try {
                cipher(Cipher.DECRYPT_MODE, master, sealed, accountId, kind)
                        .doFinal(sealed, HEADER + NONCE_BYTES, sealed.length - HEADER - NONCE_BYTES, plain);
                return SignIn.decode(plain);
            } catch (GeneralSecurityException e) {
                throw new IOException("a sealed sign-in doesn't open: " + e.getClass().getSimpleName());
            } catch (IllegalArgumentException e) {
                throw new IOException("a sealed sign-in isn't in a format this deskd knows");
            } finally {
                Arrays.fill(plain, (byte) 0);
                Arrays.fill(master, (byte) 0);
            }
        } finally {
            lock.unlock();
        }
    }

    /** Unlinks an account's file, if there is one, and fsyncs the directory, so it's gone from the disk's view on return. */
    public void delete(String accountId) throws IOException {
        if (!validId(accountId)) {
            return;
        }
        lock.lock();
        try {
            if (Files.deleteIfExists(sealedFile(accountId))) {
                syncDirectory(directory);
            }
        } finally {
            lock.unlock();
        }
    }

    /** Whether a file is sealed under this id. */
    public boolean holds(String accountId) {
        if (!validId(accountId)) {
            return false;
        }
        lock.lock();
        try {
            return Files.exists(sealedFile(accountId), LinkOption.NOFOLLOW_LINKS);
        } catch (IOException e) {
            return false;
        } finally {
            lock.unlock();
        }
    }

    /**
     * Deletes every sealed file not in {@code keep}: orphans of a crash between sealing and the row. Pass the rows only
     * after they were read, never instead of them.
     *
     * @return how many were deleted; one that can't be is logged as a count and left for the next start
     */
    public int removeOrphans(Set<String> keep) {
        lock.lock();
        try (DirectoryStream<Path> entries = Files.newDirectoryStream(directory, "*" + SEALED)) {
            int removed = 0;
            int left = 0;
            for (Path entry : entries) {
                String name = entry.getFileName().toString();
                if (!keep.contains(name.substring(0, name.length() - SEALED.length()))) {
                    try {
                        Files.delete(entry);
                        removed++;
                    } catch (IOException e) {
                        left++;
                    }
                }
            }
            if (removed > 0) {
                syncDirectory(directory);
            }
            if (left > 0) {
                log.warn("courier vault: {} orphaned files couldn't be removed", left);
            }
            return removed;
        } catch (NoSuchFileException e) {
            return 0;
        } catch (IOException | RuntimeException e) {
            log.warn("courier vault: orphans weren't checked ({})", e.getClass().getSimpleName());
            return 0;
        } finally {
            lock.unlock();
        }
    }

    private void ensureDirectory() throws IOException {
        try {
            Files.createDirectory(directory, CREATE_DIRECTORY);
            syncDirectory(directory.getParent());
        } catch (FileAlreadyExistsException e) {
            if (!Files.isDirectory(directory, LinkOption.NOFOLLOW_LINKS)) {
                throw new IOException("the courier vault's path isn't a directory");
            }
        }
    }

    private static void tighten(Path path, Set<PosixFilePermission> wanted) throws IOException {
        if (!Files.getPosixFilePermissions(path, LinkOption.NOFOLLOW_LINKS).equals(wanted)) {
            Files.setPosixFilePermissions(path, wanted);
        }
    }

    private Path sealedFile(String accountId) throws IOException {
        if (!validId(accountId)) {
            throw new IOException("bad account id");
        }
        return directory.resolve(accountId + SEALED);
    }

    private static void checkKind(String kind) throws IOException {
        if (kind == null || !KIND.matcher(kind).matches()) {
            throw new IOException("bad account kind");
        }
    }

    /**
     * The master key, which the caller zeroes. Made if it's missing; if what's there isn't 32 bytes in a regular file,
     * that's renamed aside first, never overwritten, and sign-ins sealed under it read as signed out. One that's there
     * but can't be read throws and stays as it is: fixing its owner brings every sign-in back.
     */
    private byte[] master() throws IOException {
        Path file = directory.resolve(MASTER);
        BasicFileAttributes found;
        try {
            found = Files.readAttributes(file, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
        } catch (NoSuchFileException e) {
            byte[] made = makeMaster(file);
            if (anySealed()) {
                log.warn("courier vault: no master key, so a new one is made; sign-ins sealed under an earlier one stay unavailable");
            } else {
                log.info("courier vault: made its master key");
            }
            return made;
        }
        if (found.isRegularFile() && found.size() == MASTER_BYTES) {
            return readMaster(file);
        }
        Path aside = freeAsideName();
        Files.move(file, aside);
        byte[] made = makeMaster(file);
        log.warn("courier vault: the master key isn't 32 bytes, so it's now {} and a new one is made; sign-ins sealed under"
                + " an earlier one stay unavailable", aside.getFileName());
        return made;
    }

    private boolean anySealed() throws IOException {
        try (DirectoryStream<Path> entries = Files.newDirectoryStream(directory, "*" + SEALED)) {
            return entries.iterator().hasNext();
        }
    }

    private Path freeAsideName() {
        for (int i = 1; ; i++) {
            Path aside = directory.resolve(ASIDE + i);
            if (!Files.exists(aside, LinkOption.NOFOLLOW_LINKS)) {
                return aside;
            }
        }
    }

    private static byte[] readMaster(Path file) throws IOException {
        ByteBuffer direct = ByteBuffer.allocateDirect(MASTER_BYTES);
        try (FileChannel channel = FileChannel.open(file, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS)) {
            while (direct.hasRemaining() && channel.read(direct) >= 0) {
                // Until it's full or the file ends.
            }
            if (direct.hasRemaining()) {
                throw new IOException("the master key came up short");
            }
            byte[] master = new byte[MASTER_BYTES];
            direct.get(0, master);
            return master;
        } finally {
            zero(direct);
        }
    }

    private byte[] makeMaster(Path file) throws IOException {
        byte[] master = new byte[MASTER_BYTES];
        ByteBuffer direct = ByteBuffer.allocateDirect(MASTER_BYTES);
        try {
            random.nextBytes(master);
            direct.put(0, master);
            writeDurably(file, direct);
            return master;
        } catch (IOException | RuntimeException e) {
            Arrays.fill(master, (byte) 0);
            throw e;
        } finally {
            zero(direct);
        }
    }

    private byte[] readSealed(Path file) throws IOException {
        BasicFileAttributes found = Files.readAttributes(file, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
        // Before it's opened, so a FIFO can't hang a start or a link point anywhere.
        if (!found.isRegularFile() || found.size() < MIN_SEALED || found.size() > MAX_SEALED) {
            throw new IOException("a sealed sign-in's file isn't one");
        }
        byte[] sealed = Files.readAllBytes(file);
        if (sealed.length < MIN_SEALED || sealed.length > MAX_SEALED
                || !Arrays.equals(sealed, 0, MAGIC.length, MAGIC, 0, MAGIC.length) || sealed[MAGIC.length] != VERSION) {
            throw new IOException("a sealed sign-in's file isn't in a format this deskd knows");
        }
        return sealed;
    }

    private byte[] encrypt(String accountId, String kind, byte[] plain) throws IOException {
        byte[] master = master();
        try {
            byte[] sealed = new byte[HEADER + NONCE_BYTES + plain.length + TAG_BYTES];
            System.arraycopy(MAGIC, 0, sealed, 0, MAGIC.length);
            sealed[MAGIC.length] = VERSION;
            byte[] nonce = new byte[NONCE_BYTES];
            random.nextBytes(nonce);
            System.arraycopy(nonce, 0, sealed, HEADER, NONCE_BYTES);
            cipher(Cipher.ENCRYPT_MODE, master, sealed, accountId, kind).doFinal(plain, 0, plain.length, sealed, HEADER + NONCE_BYTES);
            return sealed;
        } catch (GeneralSecurityException e) {
            throw new IOException("a sign-in couldn't be sealed: " + e.getClass().getSimpleName());
        } finally {
            Arrays.fill(master, (byte) 0);
        }
    }

    private static Cipher cipher(int mode, byte[] master, byte[] sealed, String accountId, String kind) throws GeneralSecurityException {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(mode, new SecretKeySpec(master, "AES"), new GCMParameterSpec(TAG_BYTES * 8, sealed, HEADER, NONCE_BYTES));
        cipher.updateAAD(aad(accountId, kind));
        return cipher;
    }

    /** The format's magic and version, then the account id and its kind, each after its u16be length. */
    static byte[] aad(String accountId, String kind) {
        byte[] id = accountId.getBytes(StandardCharsets.UTF_8);
        byte[] name = kind.getBytes(StandardCharsets.UTF_8);
        return ByteBuffer.allocate(HEADER + 2 + id.length + 2 + name.length)
                .put(MAGIC).put(VERSION).putShort((short) id.length).put(id).putShort((short) name.length).put(name).array();
    }

    /** Temporary file, fsync, atomic rename, fsync the directory. A failure before the rename leaves no temporary. */
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
                // The next start removes it.
            }
            throw e;
        }
        syncDirectory(directory);
    }

    private void syncDirectory(Path path) throws IOException {
        try (FileChannel channel = FileChannel.open(path, StandardOpenOption.READ)) {
            sync.force(channel);
        }
    }

    private static void zero(ByteBuffer buffer) {
        for (int i = 0; i < buffer.capacity(); i++) {
            buffer.put(i, (byte) 0);
        }
    }

    @Override
    public String toString() {
        return "CourierVault[" + directory + "]";
    }
}
