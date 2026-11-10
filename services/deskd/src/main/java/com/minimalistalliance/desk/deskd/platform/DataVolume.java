package com.minimalistalliance.desk.deskd.platform;

import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.JsonFormatException;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.SeekableByteChannel;
import java.nio.file.FileStore;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.time.Instant;
import java.util.Arrays;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.locks.ReentrantLock;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/** deskd's directory on the data volume, usually /data/desk. Directories are firstboot's job. */
public final class DataVolume {

    private static final Logger log = LoggerFactory.getLogger(DataVolume.class);

    /** desk-datadirs writes this from image 0.2.3 on, at every boot and before deskd starts (desk-runtime.md section 2). */
    private static final String RECORD_FILE = "volume.json";
    /** The real one is about 100 bytes. */
    static final int MAX_RECORD_BYTES = 4096;
    private static final Pattern VOLUME_ID = Pattern.compile("vol-[0-9a-f]{1,32}");
    /** What desk-datadirs and desk-firstboot write when the device doesn't say. */
    private static final String VOLUME_ID_UNKNOWN = "unknown";

    /** @param usedBytes everything not free on the volume, not only deskd's share */
    public record Usage(long totalBytes, long usedBytes) {}

    /**
     * What the volume's record says of it (ADR 0035), checked, and with nothing else the file holds.
     *
     * @param volumeId {@code vol-...}, or {@code unknown} if the device didn't say
     * @param formattedAt when firstboot formatted it, or null for a volume older than the record
     */
    public record VolumeRecord(String volumeId, String formattedAt) {}

    private final Path directory;
    private final ReentrantLock recordLock = new ReentrantLock();
    private boolean recordRead;
    private VolumeRecord record;

    public DataVolume(Path directory) {
        this.directory = directory;
    }

    public Path directory() {
        return directory;
    }

    /** Actually writes a file, which also finds a full or read-only volume. For /health. */
    public boolean isWritable() {
        if (!Files.isDirectory(directory)) {
            return false;
        }
        try {
            Files.delete(Files.createTempFile(directory, ".deskd-health-", null));
            return true;
        } catch (IOException | RuntimeException e) {
            return false;
        }
    }

    /** Just the permission check, cheap enough for every heartbeat. */
    public boolean looksWritable() {
        return Files.isDirectory(directory) && Files.isWritable(directory);
    }

    /** @return null if the directory isn't there */
    public Usage usage() {
        try {
            FileStore store = Files.getFileStore(directory);
            long total = store.getTotalSpace();
            return new Usage(total, total - store.getUnallocatedSpace());
        } catch (IOException | RuntimeException e) {
            return null;
        }
    }

    /**
     * The volume's record, read on first use and kept, as it's only rewritten at boot. So none of it is on the way to
     * deskd starting, and a heartbeat that asks can't fail on it.
     *
     * @return null if there's none, as on images before 0.2.3, or if it isn't what it should be, which logs one line
     */
    public VolumeRecord volumeRecord() {
        recordLock.lock();
        try {
            if (!recordRead) {
                record = readRecord(directory.resolve(RECORD_FILE));
                recordRead = true;
            }
            return record;
        } finally {
            recordLock.unlock();
        }
    }

    /**
     * Believes nothing of it: uid desk owns the file, so the file can be anything. Only a regular file, reached with no
     * symlink followed, and only so much of it. No line says what was in it. What's left is the gap between the look and
     * the open, where a FIFO would park this thread, and only something running as desk can put one there, which is
     * deskd itself.
     */
    private static VolumeRecord readRecord(Path file) {
        try {
            BasicFileAttributes attributes = Files.readAttributes(file, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
            if (!attributes.isRegularFile()) {
                return ignored("not a regular file");
            }
            if (attributes.size() > MAX_RECORD_BYTES) {
                return ignored("too large");
            }
            ByteBuffer bytes = ByteBuffer.allocate(MAX_RECORD_BYTES + 1);
            try (SeekableByteChannel channel = Files.newByteChannel(file, Set.of(StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS))) {
                while (bytes.hasRemaining() && channel.read(bytes) >= 0) {
                    // Until the end of the file, or one byte past what's allowed.
                }
            }
            if (!bytes.hasRemaining()) {
                return ignored("too large");
            }
            return parseRecord(Arrays.copyOf(bytes.array(), bytes.position()));
        } catch (NoSuchFileException e) {
            return null;
        } catch (IOException | RuntimeException e) {
            return ignored("unreadable, " + e.getClass().getSimpleName());
        }
    }

    private static VolumeRecord parseRecord(byte[] bytes) {
        Map<String, Object> fields;
        try {
            fields = Json.parseObject(bytes);
        } catch (JsonFormatException e) {
            return ignored("not a JSON object");
        }
        String volumeId = Json.string(fields, "volumeId");
        if (volumeId == null || !(VOLUME_ID_UNKNOWN.equals(volumeId) || VOLUME_ID.matcher(volumeId).matches())) {
            return ignored("bad volumeId");
        }
        if (!fields.containsKey("formattedAt")) {
            return ignored("no formattedAt");
        }
        Object formattedAt = fields.get("formattedAt");
        if (formattedAt == null) {
            return new VolumeRecord(volumeId, null);
        }
        if (!(formattedAt instanceof String text)) {
            return ignored("bad formattedAt");
        }
        try {
            // Instant's own text, so what goes out is what was checked.
            return new VolumeRecord(volumeId, Instant.parse(text).toString());
        } catch (RuntimeException e) {
            return ignored("bad formattedAt");
        }
    }

    private static VolumeRecord ignored(String why) {
        log.warn("volume record ignored: {}", why);
        return null;
    }
}
