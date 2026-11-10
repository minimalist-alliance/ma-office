package com.minimalistalliance.desk.agent.key;

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
import javax.crypto.Cipher;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The member's provider keys at rest, sealed on the desk's own disk in {@code /data/agent/keys}, mode 0700 (ADR 0042).
 * They survive restarts, updates and reboots, move with an export or a move, and go with the desk. No Platform key is
 * involved, so a self-hosted desk works the same. {@code agent.db}'s {@code keys} row stays the commit point:
 * {@code AgentService} decides what a file without a row or a row without a file means.
 *
 * <p>{@code master.key} is 32 random bytes, mode 0600, made once. It's in memory only while sealing or opening, in an
 * array zeroed straight after, read and written through a direct buffer of its own, since NIO would otherwise copy it
 * through a cached one nobody zeroes. {@code SecretKeySpec} and the {@code Cipher} keep their own copies, which can't
 * be zeroed, until the collector reuses the memory: best effort, as with everything on the heap (README.md, "Keys").
 *
 * <p>{@code <keyId>.sealed} is one immutable file per key, mode 0600: {@code "MAKV"}, a version byte, a random 12-byte
 * nonce, then AES-256-GCM ciphertext and tag. The AAD binds the format version, the key id and the provider, so a file
 * renamed or moved to another row won't open. Every file is written to a temporary name, fsynced, renamed atomically,
 * and then the directory is fsynced.
 *
 * <p>The limit, stated plainly: {@code master.key} sits beside what it seals. No Platform service or API can read a
 * key, but root on the machine or whoever holds the volume can, as with everything else on a desk.
 *
 * <p>Nothing here logs or prints a key, and an exception says only which kind of failure it was.
 */
public final class KeyVault {

    private static final Logger log = LoggerFactory.getLogger(KeyVault.class);

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
    private static final int MIN_SEALED = HEADER + NONCE_BYTES + KeyRing.MIN_BYTES + TAG_BYTES;
    private static final int MAX_SEALED = HEADER + NONCE_BYTES + KeyRing.MAX_BYTES + TAG_BYTES;

    private static final Set<PosixFilePermission> OWNER_DIRECTORY = PosixFilePermissions.fromString("rwx------");
    private static final Set<PosixFilePermission> OWNER_FILE = PosixFilePermissions.fromString("rw-------");
    private static final FileAttribute<Set<PosixFilePermission>> CREATE_DIRECTORY =
            PosixFilePermissions.asFileAttribute(OWNER_DIRECTORY);
    private static final FileAttribute<Set<PosixFilePermission>> CREATE_FILE =
            PosixFilePermissions.asFileAttribute(OWNER_FILE);

    private final ReentrantLock lock = new ReentrantLock();
    private final SecureRandom random = new SecureRandom();
    private final Path directory;
    private final Sync sync;

    public KeyVault(Path directory) {
        this(directory, channel -> channel.force(true));
    }

    KeyVault(Path directory, Sync sync) {
        this.directory = directory;
        this.sync = sync;
    }

    /**
     * At a start: makes or tightens the directory and its files to the modes above, as a move or a restore may have
     * changed them, removes temporary files a crash left, and makes sure there's a master key. A key may be unreadable
     * after this, but it never throws: a bad vault doesn't stop desk-agent from starting or answering health.
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
                log.warn("key vault: {} files couldn't be tightened or removed", untouched);
            }
            Arrays.fill(master(), (byte) 0);
        } catch (IOException | RuntimeException e) {
            log.error("key vault isn't usable ({}): its keys read as unavailable", e.getClass().getSimpleName());
        } finally {
            lock.unlock();
        }
    }

    /**
     * Seals a key durably, leaving nothing behind if it can't. {@code secret} isn't changed: it's the caller's to zero.
     *
     * @throws IOException if the key isn't on disk when this returns, including when the id already has a file, which
     *     is left as it was
     */
    public void seal(String keyId, String provider, byte[] secret) throws IOException {
        Path target = sealedFile(keyId);
        if (secret.length < KeyRing.MIN_BYTES || secret.length > KeyRing.MAX_BYTES) {
            throw new IllegalArgumentException("a key is 8 to 1024 characters");
        }
        lock.lock();
        try {
            ensureDirectory();
            if (Files.exists(target, LinkOption.NOFOLLOW_LINKS)) {
                throw new FileAlreadyExistsException(target.getFileName().toString());
            }
            byte[] sealed = encrypt(keyId, provider, secret);
            try {
                writeDurably(target, ByteBuffer.wrap(sealed));
            } catch (IOException | RuntimeException e) {
                try {
                    Files.deleteIfExists(target);
                } catch (IOException ignored) {
                    // No row will ever name it, so the next start removes it as an orphan.
                }
                throw e;
            }
        } finally {
            lock.unlock();
        }
    }

    /**
     * Opens a sealed key. The caller zeroes the array that comes back.
     *
     * @throws IOException if the file is missing or isn't one, or doesn't open under this master key, id and provider
     */
    public byte[] unseal(String keyId, String provider) throws IOException {
        Path file = sealedFile(keyId);
        lock.lock();
        try {
            byte[] sealed = readSealed(file);
            byte[] master = master();
            byte[] secret = new byte[sealed.length - HEADER - NONCE_BYTES - TAG_BYTES];
            try {
                cipher(Cipher.DECRYPT_MODE, master, sealed, keyId, provider)
                        .doFinal(sealed, HEADER + NONCE_BYTES, sealed.length - HEADER - NONCE_BYTES, secret);
                return secret;
            } catch (GeneralSecurityException e) {
                Arrays.fill(secret, (byte) 0);
                throw new IOException("a sealed key doesn't open: " + e.getClass().getSimpleName());
            } finally {
                Arrays.fill(master, (byte) 0);
            }
        } finally {
            lock.unlock();
        }
    }

    /** Unlinks a key's file, if there is one, and fsyncs the directory, so it's gone from the disk's view on return. */
    public void delete(String keyId) throws IOException {
        if (!KeyRing.validKeyId(keyId)) {
            return;
        }
        lock.lock();
        try {
            if (Files.deleteIfExists(sealedFile(keyId))) {
                syncDirectory(directory);
            }
        } finally {
            lock.unlock();
        }
    }

    /** @return whether a file is sealed under this id. A malformed id has none */
    public boolean holds(String keyId) {
        if (!KeyRing.validKeyId(keyId)) {
            return false;
        }
        lock.lock();
        try {
            return Files.exists(sealedFile(keyId), LinkOption.NOFOLLOW_LINKS);
        } catch (IOException e) {
            return false;
        } finally {
            lock.unlock();
        }
    }

    /**
     * Deletes every sealed file not in {@code keep}: orphans of a crash between sealing and the row, or of a delete on
     * an older desk-agent. Pass the rows only after they were read, never instead of them.
     *
     * @return how many were deleted. One that can't be is logged and left for the next start
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
                log.warn("key vault: {} orphaned files couldn't be removed", left);
            }
            return removed;
        } catch (IOException | RuntimeException e) {
            log.warn("key vault: orphans weren't checked ({})", e.getClass().getSimpleName());
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
                throw new IOException("the key vault's path isn't a directory");
            }
        }
    }

    private static void tighten(Path path, Set<PosixFilePermission> wanted) throws IOException {
        if (!Files.getPosixFilePermissions(path, LinkOption.NOFOLLOW_LINKS).equals(wanted)) {
            Files.setPosixFilePermissions(path, wanted);
        }
    }

    private Path sealedFile(String keyId) throws IOException {
        if (!KeyRing.validKeyId(keyId)) {
            throw new IOException("bad key id");
        }
        return directory.resolve(keyId + SEALED);
    }

    /**
     * The master key, which the caller zeroes. It's made if it's missing, and if what's there isn't 32 bytes in a
     * regular file, that's renamed aside first, never overwritten. Keys sealed under an earlier one then fail their
     * tag. One that's there but can't be read throws and stays as it is: fixing its owner brings every key back.
     */
    private byte[] master() throws IOException {
        Path file = directory.resolve(MASTER);
        BasicFileAttributes found;
        try {
            found = Files.readAttributes(file, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
        } catch (NoSuchFileException e) {
            byte[] made = makeMaster(file);
            if (anySealed()) {
                log.warn("key vault: no master key, so a new one is made; keys sealed under an earlier one stay"
                        + " unavailable");
            } else {
                log.info("key vault: made its master key");
            }
            return made;
        }
        if (found.isRegularFile() && found.size() == MASTER_BYTES) {
            return readMaster(file);
        }
        Path aside = freeAsideName();
        Files.move(file, aside);
        byte[] made = makeMaster(file);
        log.warn("key vault: the master key isn't 32 bytes, so it's now {} and a new one is made; keys sealed under"
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
        try (FileChannel channel =
                FileChannel.open(file, StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS)) {
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
            throw new IOException("a sealed key's file isn't one");
        }
        byte[] sealed = Files.readAllBytes(file);
        if (sealed.length < MIN_SEALED || sealed.length > MAX_SEALED
                || !Arrays.equals(sealed, 0, MAGIC.length, MAGIC, 0, MAGIC.length)
                || sealed[MAGIC.length] != VERSION) {
            throw new IOException("a sealed key's file isn't in a format this desk-agent knows");
        }
        return sealed;
    }

    private byte[] encrypt(String keyId, String provider, byte[] secret) throws IOException {
        byte[] master = master();
        try {
            byte[] sealed = new byte[HEADER + NONCE_BYTES + secret.length + TAG_BYTES];
            System.arraycopy(MAGIC, 0, sealed, 0, MAGIC.length);
            sealed[MAGIC.length] = VERSION;
            byte[] nonce = new byte[NONCE_BYTES];
            random.nextBytes(nonce);
            System.arraycopy(nonce, 0, sealed, HEADER, NONCE_BYTES);
            cipher(Cipher.ENCRYPT_MODE, master, sealed, keyId, provider)
                    .doFinal(secret, 0, secret.length, sealed, HEADER + NONCE_BYTES);
            return sealed;
        } catch (GeneralSecurityException e) {
            throw new IOException("a key couldn't be sealed: " + e.getClass().getSimpleName());
        } finally {
            Arrays.fill(master, (byte) 0);
        }
    }

    /** A cipher of its own, with the nonce that's in {@code sealed}. */
    private static Cipher cipher(int mode, byte[] master, byte[] sealed, String keyId, String provider)
            throws GeneralSecurityException {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(mode, new SecretKeySpec(master, "AES"),
                new GCMParameterSpec(TAG_BYTES * 8, sealed, HEADER, NONCE_BYTES));
        cipher.updateAAD(aad(keyId, provider));
        return cipher;
    }

    /** The format's magic and version, then the key id and the provider, each after its u16be length. */
    private static byte[] aad(String keyId, String provider) {
        byte[] id = keyId.getBytes(StandardCharsets.UTF_8);
        byte[] name = provider.getBytes(StandardCharsets.UTF_8);
        return ByteBuffer.allocate(HEADER + 2 + id.length + 2 + name.length)
                .put(MAGIC)
                .put(VERSION)
                .putShort((short) id.length)
                .put(id)
                .putShort((short) name.length)
                .put(name)
                .array();
    }

    /** Temporary file, fsync, atomic rename, fsync the directory. A failure before the rename leaves no temporary. */
    private void writeDurably(Path target, ByteBuffer content) throws IOException {
        byte[] suffix = new byte[8];
        random.nextBytes(suffix);
        Path temporary = directory.resolve(
                target.getFileName() + "." + HexFormat.of().formatHex(suffix) + TEMPORARY);
        try {
            try (FileChannel channel = FileChannel.open(temporary,
                    Set.of(StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE), CREATE_FILE)) {
                while (content.hasRemaining()) {
                    channel.write(content);
                }
                sync.force(channel);
            }
            Files.move(temporary, target, StandardCopyOption.ATOMIC_MOVE);
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
        return "KeyVault[" + directory + "]";
    }
}
