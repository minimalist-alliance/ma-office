package com.minimalistalliance.desk.deskd.boot;

import com.minimalistalliance.desk.deskd.platform.DataVolume;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.protocol.JsonFormatException;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.channels.SeekableByteChannel;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The DTLS identity desk-rtc last reported, kept in {@code /data/desk/rtc-identity.json} (audit D4). desk-rtc keeps its
 * identity on the volume ({@code /data/rtc}), so on a later boot it's almost always the same one. When desk-rtc doesn't
 * come up, boot says hello with this rather than wait for ever, so the Platform hears the desk and its heartbeat says
 * {@code rtc: failing}. Sessions stay refused until desk-rtc is configured, and if it then reports another identity,
 * hello goes again with {@code cert_rotated}. On a desk's first boot there's none, and boot waits for desk-rtc as before:
 * hello needs one or two real fingerprints (agent.md), and there is nothing else honest to send.
 *
 * <p>It's kept with the volume's record ({@code volume.json}, ADR 0035), and used only on the same volume: {@code /data/desk}
 * goes with an export to another desk, whose desk-rtc has an identity of its own, and a self-hosted desk's hello with
 * another's fingerprints would be refused as an identity change. A volume restored from a snapshot keeps its record and
 * its {@code /data/rtc}, so it keeps this too.
 *
 * <p>Believes nothing of the file: only a regular file, reached with no symlink followed, at most 4 KiB, one or two
 * fingerprints of 64 lowercase hex characters. Anything else is none. Only the boot thread uses this.
 */
final class KnownRtcIdentity {

    private static final Logger log = LoggerFactory.getLogger(KnownRtcIdentity.class);

    static final String FILE = "rtc-identity.json";
    private static final int MAX_BYTES = 4096;
    private static final Pattern FINGERPRINT = Pattern.compile("[0-9a-f]{64}");

    /** @param notAfter RFC 3339, or null if desk-rtc didn't say */
    record Identity(List<String> fingerprints, String notAfter) {}

    private final Path file;
    private final java.util.function.Supplier<DataVolume.VolumeRecord> volume;
    private Identity known;
    private boolean read;

    /** @param volume the volume's record now, or null if it has none */
    KnownRtcIdentity(Path directory, java.util.function.Supplier<DataVolume.VolumeRecord> volume) {
        this.file = directory.resolve(FILE);
        this.volume = volume;
    }

    /** @return what an earlier configured said, or null if nothing usable is kept */
    Identity read() {
        if (!read) {
            known = load(file, volumeOf(volume.get()));
            read = true;
        }
        return known;
    }

    /** Keeps what desk-rtc said in configured, if it's usable and differs from what's kept. A failed write logs one line. */
    void remember(List<String> fingerprints, String notAfter) {
        Identity next = new Identity(List.copyOf(fingerprints), notAfter);
        if (!valid(next.fingerprints()) || next.equals(read())) {
            return;
        }
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("fingerprintsSha256", next.fingerprints());
        body.put("notAfter", notAfter);
        body.put("volume", volumeOf(volume.get()));
        try {
            write(file, Json.bytes(body));
            known = next;
        } catch (IOException | RuntimeException e) {
            log.warn("can't keep desk-rtc's identity for a later boot: {}", e.getClass().getSimpleName());
        }
    }

    private static boolean valid(List<String> fingerprints) {
        return !fingerprints.isEmpty() && fingerprints.size() <= 2 && fingerprints.stream().allMatch(f -> FINGERPRINT.matcher(f).matches());
    }

    /** The record's two fields, or null for none, as the file holds them. */
    private static Map<String, Object> volumeOf(DataVolume.VolumeRecord record) {
        if (record == null) {
            return null;
        }
        Map<String, Object> fields = new LinkedHashMap<>();
        fields.put("volumeId", record.volumeId());
        fields.put("formattedAt", record.formattedAt());
        return fields;
    }

    private static Identity load(Path file, Map<String, Object> volumeNow) {
        try {
            BasicFileAttributes attributes = Files.readAttributes(file, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
            if (!attributes.isRegularFile() || attributes.size() > MAX_BYTES) {
                return ignored();
            }
            ByteBuffer bytes = ByteBuffer.allocate(MAX_BYTES + 1);
            try (SeekableByteChannel channel = Files.newByteChannel(file, Set.of(StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS))) {
                while (bytes.hasRemaining() && channel.read(bytes) >= 0) {
                    // Until the end, or one byte past what's allowed.
                }
            }
            if (!bytes.hasRemaining()) {
                return ignored();
            }
            Map<String, Object> fields = Json.parseObject(java.util.Arrays.copyOf(bytes.array(), bytes.position()));
            List<String> fingerprints = new ArrayList<>();
            if (fields.get("fingerprintsSha256") instanceof List<?> list) {
                for (Object value : list) {
                    if (!(value instanceof String fingerprint)) {
                        return ignored();
                    }
                    fingerprints.add(fingerprint);
                }
            }
            Object notAfter = fields.get("notAfter");
            if (!valid(fingerprints) || (notAfter != null && !(notAfter instanceof String))) {
                return ignored();
            }
            if (!java.util.Objects.equals(fields.get("volume"), volumeNow)) {
                log.warn("kept desk-rtc identity ignored: it was kept on another volume");
                return null;
            }
            return new Identity(List.copyOf(fingerprints), (String) notAfter);
        } catch (NoSuchFileException e) {
            return null;
        } catch (IOException | JsonFormatException | RuntimeException e) {
            return ignored();
        }
    }

    private static Identity ignored() {
        log.warn("kept desk-rtc identity ignored: not what deskd writes");
        return null;
    }

    /** Whole or not at all: a temporary file, an fsync, a rename. */
    private static void write(Path file, byte[] bytes) throws IOException {
        Path temporary = file.resolveSibling(file.getFileName() + ".tmp");
        Files.deleteIfExists(temporary);
        try {
            try (FileChannel channel = FileChannel.open(temporary, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)) {
                ByteBuffer buffer = ByteBuffer.wrap(bytes);
                while (buffer.hasRemaining()) {
                    channel.write(buffer);
                }
                channel.force(true);
            }
            Files.move(temporary, file, StandardCopyOption.ATOMIC_MOVE);
        } finally {
            Files.deleteIfExists(temporary);
        }
    }
}
