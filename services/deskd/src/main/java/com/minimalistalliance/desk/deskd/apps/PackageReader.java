package com.minimalistalliance.desk.deskd.apps;

import java.io.EOFException;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.Map;
import java.util.Set;
import java.util.zip.GZIPInputStream;
import java.util.zip.ZipException;

/**
 * Reads a {@code .maapp} as it arrives and unpacks it into a staging directory (the desk app contract, section 1.1, as the
 * Desk Engineer's review changes it): nothing of it is held in memory but one block, and no file byte reaches the disk
 * before the signatures and the manifest have passed.
 *
 * <p><b>Layout.</b> gzip, then POSIX ustar, with pax extended headers ({@code x}) allowed for long names; only their
 * {@code path} and {@code size} are used, the rest ignored. The first two entries are {@code ma-app.json} and
 * {@code ma-app.sig}, in either order. Then only directories ({@code files} or under it) and regular files under
 * {@code files/}, each listed in the manifest once, with its exact size and SHA-256. Anything else is refused: a link of
 * either kind, a device, a FIFO, a global or GNU header, a sparse file, an absolute path, {@code ..}, a duplicate, a file the
 * manifest doesn't list or one it lists that never comes.
 *
 * <p><b>Caps.</b> The compressed bytes are exactly what the catalog says, and hash to what it says. File bytes are what the
 * manifest says, which the manifest's own check holds to the app's disk limit. Everything else (headers, pax records,
 * padding, the end) at most 16 MiB, and at most {@code 2 × files + 64} entries.
 */
final class PackageReader {

    static final String MANIFEST = "ma-app.json";
    static final String SIGNATURES = "ma-app.sig";
    static final String FILES = "files";
    private static final int BLOCK = 512;
    private static final long MAX_OVERHEAD = 16L << 20;
    private static final int MAX_PAX = 64 << 10;
    /** What may follow the tar's end inside the gzip stream: GNU tar pads to 10 KiB records. */
    private static final long MAX_TRAILER = 64 << 10;

    /** Checks the manifest and its signatures, before any file is written. */
    @FunctionalInterface
    interface Verifier {
        AppManifest verify(byte[] manifest, byte[] signatures) throws InstallException;
    }

    record Result(AppManifest manifest, byte[] manifestBytes, byte[] signatureBytes) {}

    private PackageReader() {}

    /**
     * @param compressed the package, as downloaded
     * @param expectedBytes the catalog's size for it
     * @param expectedSha256 the catalog's hash of it
     * @param staging an empty directory; on failure the caller deletes it
     * @throws InstallException {@code package} for a layout that breaks the rules, {@code hash} for bytes that aren't what
     *     the catalog or the manifest says, {@code size} for too many, or whatever the verifier throws
     */
    static Result read(InputStream compressed, long expectedBytes, String expectedSha256, Verifier verifier, Path staging)
            throws InstallException, IOException {
        Counting counting = new Counting(compressed, expectedBytes);
        Reader reader = new Reader(counting, verifier, staging);
        Result result;
        try (GZIPInputStream gzip = new GZIPInputStream(counting, 64 << 10)) {
            result = reader.read(gzip);
            // What's left in the gzip stream must be padding, and not much of it.
            long trailer = 0;
            byte[] buffer = new byte[8192];
            for (int n; (n = gzip.read(buffer)) > 0; ) {
                trailer += n;
                if (trailer > MAX_TRAILER) {
                    throw new InstallException("package");
                }
                for (int i = 0; i < n; i++) {
                    if (buffer[i] != 0) {
                        throw new InstallException("package");
                    }
                }
            }
        } catch (ZipException | EOFException e) {
            throw new InstallException("package");
        } catch (TooLong e) {
            throw new InstallException("hash");
        }
        // Anything after the gzip stream still counts towards the size and the hash.
        try {
            counting.drain();
        } catch (TooLong e) {
            throw new InstallException("hash");
        }
        if (counting.count != expectedBytes || !counting.hex().equals(expectedSha256)) {
            throw new InstallException("hash");
        }
        return result;
    }

    private static final class Reader {
        private final Counting counting;
        private final Verifier verifier;
        private final Path staging;
        private final byte[] block = new byte[BLOCK];
        private long overhead;
        private int entries;
        private AppManifest manifest;
        private byte[] manifestBytes;
        private byte[] signatureBytes;
        private final Set<String> written = new HashSet<>();

        Reader(Counting counting, Verifier verifier, Path staging) {
            this.counting = counting;
            this.verifier = verifier;
            this.staging = staging;
        }

        Result read(InputStream in) throws InstallException, IOException {
            String paxPath = null;
            Long paxSize = null;
            while (true) {
                readBlock(in);
                if (allZero(block)) {
                    // The end: a second zero block, or the stream's end, which some writers stop at.
                    break;
                }
                if (++entries > maxEntries()) {
                    throw new InstallException("package");
                }
                checkSum();
                if (!"ustar".equals(text(257, 5))) {
                    throw new InstallException("package");
                }
                byte type = block[156];
                long size = octal(124, 12);
                if (type == 'x') {
                    if (size > MAX_PAX) {
                        throw new InstallException("package");
                    }
                    byte[] records = readData(in, (int) size);
                    Map.Entry<String, Long> pax = pax(records);
                    paxPath = pax.getKey();
                    paxSize = pax.getValue();
                    continue;
                }
                String name = paxPath != null ? paxPath : name();
                if (paxSize != null) {
                    size = paxSize;
                }
                paxPath = null;
                paxSize = null;
                if (type == '5') {
                    directory(name);
                    skip(in, size);
                } else if (type == '0' || type == 0) {
                    file(in, name, size);
                } else {
                    throw new InstallException("package");
                }
            }
            if (manifest == null) {
                throw new InstallException("package");
            }
            for (String path : manifest.files().keySet()) {
                if (!written.contains(path)) {
                    throw new InstallException("package");
                }
            }
            write(staging.resolve(MANIFEST), manifestBytes, "rw-r--r--");
            write(staging.resolve(SIGNATURES), signatureBytes, "rw-r--r--");
            return new Result(manifest, manifestBytes, signatureBytes);
        }

        private int maxEntries() {
            return manifest == null ? 8 : 2 * manifest.files().size() + 64;
        }

        private void directory(String name) throws InstallException, IOException {
            String clean = name.endsWith("/") ? name.substring(0, name.length() - 1) : name;
            if (manifest == null) {
                throw new InstallException("package");
            }
            if (clean.equals(FILES)) {
                Files.createDirectories(staging.resolve(FILES));
                return;
            }
            if (!clean.startsWith(FILES + "/") || !AppManifest.cleanPath(clean.substring(FILES.length() + 1))) {
                throw new InstallException("package");
            }
            mkdirs(staging.resolve(clean));
        }

        private void file(InputStream in, String name, long size) throws InstallException, IOException {
            if (manifest == null) {
                if (name.equals(MANIFEST) && manifestBytes == null && size <= AppManifest.MAX_BYTES) {
                    manifestBytes = readData(in, (int) size);
                } else if (name.equals(SIGNATURES) && signatureBytes == null && size <= AppKeys.MAX_SIG_FILE_BYTES) {
                    signatureBytes = readData(in, (int) size);
                } else {
                    throw new InstallException("package");
                }
                if (manifestBytes != null && signatureBytes != null) {
                    manifest = verifier.verify(manifestBytes, signatureBytes);
                    Files.createDirectories(staging.resolve(FILES));
                }
                return;
            }
            if (!name.startsWith(FILES + "/")) {
                throw new InstallException("package");
            }
            String path = name.substring(FILES.length() + 1);
            AppManifest.FileEntry entry = manifest.files().get(path);
            if (!AppManifest.cleanPath(path) || entry == null || !written.add(path)) {
                throw new InstallException("package");
            }
            if (entry.size() != size) {
                throw new InstallException("hash");
            }
            Path target = staging.resolve(FILES).resolve(path);
            mkdirs(target.getParent());
            MessageDigest digest = sha256();
            try (FileChannel out = FileChannel.open(target, Set.of(StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE),
                    PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")))) {
                byte[] buffer = new byte[64 << 10];
                long left = size;
                while (left > 0) {
                    int n = in.read(buffer, 0, (int) Math.min(buffer.length, left));
                    if (n < 0) {
                        throw new InstallException("package");
                    }
                    digest.update(buffer, 0, n);
                    ByteBuffer bytes = ByteBuffer.wrap(buffer, 0, n);
                    while (bytes.hasRemaining()) {
                        out.write(bytes);
                    }
                    left -= n;
                }
                out.force(true);
            }
            if (!HexFormat.of().formatHex(digest.digest()).equals(entry.sha256())) {
                throw new InstallException("hash");
            }
            Files.setPosixFilePermissions(target, PosixFilePermissions.fromString(entry.executable() ? "rwxr-xr-x" : "rw-r--r--"));
            skipPadding(in, size);
        }

        private void mkdirs(Path directory) throws IOException {
            if (!directory.startsWith(staging)) {
                throw new IOException("outside staging");
            }
            Files.createDirectories(directory, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwxr-xr-x")));
        }

        private byte[] readData(InputStream in, int size) throws InstallException, IOException {
            overhead(size);
            byte[] data = in.readNBytes(size);
            if (data.length != size) {
                throw new InstallException("package");
            }
            skipPadding(in, size);
            return data;
        }

        private void skip(InputStream in, long size) throws InstallException, IOException {
            if (size != 0) {
                // A directory with a body is nothing a packer writes.
                throw new InstallException("package");
            }
        }

        private void skipPadding(InputStream in, long size) throws InstallException, IOException {
            int pad = (int) ((BLOCK - (size % BLOCK)) % BLOCK);
            overhead(pad);
            in.skipNBytes(pad);
        }

        private void readBlock(InputStream in) throws InstallException, IOException {
            overhead(BLOCK);
            int n = in.readNBytes(block, 0, BLOCK);
            if (n == 0) {
                // The stream ended where an entry would start: as the end.
                java.util.Arrays.fill(block, (byte) 0);
                return;
            }
            if (n != BLOCK) {
                throw new InstallException("package");
            }
        }

        private void overhead(long bytes) throws InstallException {
            overhead += bytes;
            if (overhead > MAX_OVERHEAD) {
                throw new InstallException("size");
            }
        }

        private void checkSum() throws InstallException {
            long stored = octal(148, 8);
            long sum = 0;
            for (int i = 0; i < BLOCK; i++) {
                sum += (i >= 148 && i < 156) ? ' ' : (block[i] & 0xff);
            }
            if (sum != stored) {
                throw new InstallException("package");
            }
        }

        private String name() throws InstallException {
            String name = text(0, 100);
            String prefix = text(345, 155);
            return prefix.isEmpty() ? name : prefix + "/" + name;
        }

        private String text(int offset, int length) throws InstallException {
            int end = offset;
            while (end < offset + length && block[end] != 0) {
                end++;
            }
            return utf8(block, offset, end - offset);
        }

        /** An octal field, NUL- or space-terminated. A base-256 one (high bit set) is refused: no file here is that big. */
        private long octal(int offset, int length) throws InstallException {
            if ((block[offset] & 0x80) != 0) {
                throw new InstallException("package");
            }
            long value = 0;
            int i = offset;
            int end = offset + length;
            while (i < end && block[i] == ' ') {
                i++;
            }
            boolean any = false;
            for (; i < end && block[i] >= '0' && block[i] <= '7'; i++) {
                value = value * 8 + (block[i] - '0');
                any = true;
                if (value > (1L << 40)) {
                    throw new InstallException("package");
                }
            }
            for (; i < end; i++) {
                if (block[i] != 0 && block[i] != ' ') {
                    throw new InstallException("package");
                }
            }
            if (!any) {
                throw new InstallException("package");
            }
            return value;
        }

        /** The {@code path} and {@code size} of one {@code x} header's records; anything else they say is ignored. */
        private Map.Entry<String, Long> pax(byte[] records) throws InstallException {
            String path = null;
            Long size = null;
            int i = 0;
            while (i < records.length) {
                int space = i;
                while (space < records.length && records[space] != ' ') {
                    space++;
                }
                if (space == i || space >= records.length || space - i > 6) {
                    throw new InstallException("package");
                }
                int length;
                try {
                    length = Integer.parseInt(new String(records, i, space - i, StandardCharsets.US_ASCII));
                } catch (NumberFormatException e) {
                    throw new InstallException("package");
                }
                if (length <= space - i + 1 || i + length > records.length || records[i + length - 1] != '\n') {
                    throw new InstallException("package");
                }
                String record = utf8(records, space + 1, i + length - space - 2);
                int equals = record.indexOf('=');
                if (equals <= 0) {
                    throw new InstallException("package");
                }
                String key = record.substring(0, equals);
                String value = record.substring(equals + 1);
                if (key.equals("path")) {
                    path = value;
                } else if (key.equals("size")) {
                    try {
                        size = Long.parseLong(value);
                    } catch (NumberFormatException e) {
                        throw new InstallException("package");
                    }
                    if (size < 0 || size > (1L << 40)) {
                        throw new InstallException("package");
                    }
                } else if (key.startsWith("GNU.sparse") || key.equals("linkpath")) {
                    throw new InstallException("package");
                }
                i += length;
            }
            return new java.util.AbstractMap.SimpleImmutableEntry<>(path, size);
        }
    }

    private static boolean allZero(byte[] block) {
        for (byte b : block) {
            if (b != 0) {
                return false;
            }
        }
        return true;
    }

    private static String utf8(byte[] bytes, int offset, int length) throws InstallException {
        try {
            return StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes, offset, length))
                    .toString();
        } catch (CharacterCodingException e) {
            throw new InstallException("package");
        }
    }

    static void write(Path file, byte[] bytes, String permissions) throws IOException {
        try (FileChannel out = FileChannel.open(file, Set.of(StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE),
                PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString(permissions)))) {
            ByteBuffer buffer = ByteBuffer.wrap(bytes);
            while (buffer.hasRemaining()) {
                out.write(buffer);
            }
            out.force(true);
        }
        Files.setPosixFilePermissions(file, PosixFilePermissions.fromString(permissions));
    }

    static MessageDigest sha256() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /** Counts and hashes the compressed bytes, and refuses one past the catalog's size. */
    private static final class Counting extends FilterInputStream {
        private final long max;
        private final MessageDigest digest = sha256();
        long count;

        Counting(InputStream in, long max) {
            super(in);
            this.max = max;
        }

        @Override
        public int read() throws IOException {
            byte[] one = new byte[1];
            int n = read(one, 0, 1);
            return n < 0 ? -1 : one[0] & 0xff;
        }

        @Override
        public int read(byte[] b, int off, int len) throws IOException {
            int n = super.read(b, off, (int) Math.min(len, max - count + 1));
            if (n > 0) {
                count += n;
                if (count > max) {
                    throw new TooLong();
                }
                digest.update(b, off, n);
            }
            return n;
        }

        @Override
        public long skip(long n) throws IOException {
            byte[] buffer = new byte[(int) Math.min(n, 8192)];
            int read = read(buffer, 0, buffer.length);
            return Math.max(read, 0);
        }

        void drain() throws IOException {
            byte[] buffer = new byte[8192];
            while (read(buffer, 0, buffer.length) > 0) {
                // Counted and hashed as it goes.
            }
        }

        String hex() {
            return HexFormat.of().formatHex(digest.digest());
        }
    }

    /** More bytes than the catalog said: the package isn't the one it named. */
    static final class TooLong extends IOException {
        private static final long serialVersionUID = 1L;

        TooLong() {
            super("package longer than the catalog says", null);
        }
    }
}
