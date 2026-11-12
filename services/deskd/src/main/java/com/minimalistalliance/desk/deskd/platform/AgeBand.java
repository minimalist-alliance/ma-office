package com.minimalistalliance.desk.deskd.platform;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.channels.SeekableByteChannel;
import java.nio.charset.StandardCharsets;
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
import java.util.Arrays;
import java.util.EnumSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArrayList;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The band of this desk's owner, {@code adult} or {@code teen} (ma-platform contract age.md, section 8), and the one file
 * deskd writes for it: {@code /data/desk/age-band}, exactly {@code teen\n} or {@code adult\n}. deskd runs read-only as uid
 * 1100 and can't write {@code /etc}, so a root {@code ExecStartPre=+} on {@code desk-browser} in the image reads this file
 * and installs or removes the teen policy, and takes anything else, or no file, as locked. So the bytes here are a contract
 * with the image, and a teen's desk is only as safe as this file: that's why the Browser asks {@link #browserMayStart}.
 *
 * <p><b>What the Platform's answer means.</b> An explicit {@code teen} or {@code adult}, on the GET or in hello's copy, is
 * the band, and is written if the file differs: {@code teen} raises it at once, and only {@code adult} brings it down.
 * <b>A config with no field never lowers the band and never writes</b> (the Security Analyst's {@code TD-2}): one Platform
 * slip, a rollback or its env var missing, mustn't unlock a teen's desk for good. So with no field on
 * {@code GET /v1/agent/config} the band is the Platform's last explicit word in this process, or else what the file says,
 * a teen's file staying {@code teen} and untouched; only a desk with neither, which has never been known as a teen's, is {@code adult},
 * as a Platform without the field has no teens, and then {@code adult} is written, as before. No field in hello's copy says nothing at all, and the boot sequence asks with a GET ({@link #fromHello}).
 * Any other value, a null included, is ignored and logged once, and what's on disk stands. A failed read never reaches
 * this class, so a {@code 503} leaves everything as it was.
 *
 * <p><b>Unknown, and a file that's junk.</b> Until the Platform has said, the band is what the file says. No file is
 * unknown. A file that's there and isn't exactly one of the two lines, or that can't be read, is {@code teen}, failing
 * closed as the image does, until an explicit answer. It can't go back to unknown once it's known. While it's unknown,
 * Chromium doesn't start, and {@code agent.*} is {@code unavailable}. With a band on disk nothing here waits on the
 * Platform, so a slow Platform can't hold up an adult's Browser.
 *
 * <p><b>The one bad case</b> is the band {@code teen} while the file says {@code adult}, as the image would then remove the
 * policy. That's so for the moment of a write, and for as long as a write keeps failing, and Chromium doesn't start for all
 * of it. Every other mismatch is safe: no file, or junk, is locked by the image, and {@code teen} on disk is stricter than
 * an adult needs, until the next start.
 *
 * <p><b>Threads.</b> Only the boot thread calls {@code from*}. The state is one immutable record, so the reads never block,
 * and {@code BrowserStream} can ask under its lock. Listeners run on the boot thread with nothing held.
 *
 * <p>The log gets the band and whether it changed, and nothing else about it: no account id, and never a value the
 * Platform sent.
 */
public final class AgeBand {

    /** @see AgeBand */
    public enum Band {
        ADULT("adult"),
        TEEN("teen");

        private final String wire;
        private final byte[] line;

        Band(String wire) {
            this.wire = wire;
            this.line = (wire + "\n").getBytes(StandardCharsets.US_ASCII);
        }

        public String wire() {
            return wire;
        }
    }

    /** The file's name, in deskd's data directory. */
    public static final String FILE = "age-band";
    /** The field on the desk config. */
    public static final String FIELD = "ageBand";

    private static final Logger log = LoggerFactory.getLogger(AgeBand.class);
    private static final String TEMP = ".age-band.tmp";
    private static final FileAttribute<Set<PosixFilePermission>> OWNER_ONLY =
            PosixFilePermissions.asFileAttribute(EnumSet.of(PosixFilePermission.OWNER_READ, PosixFilePermission.OWNER_WRITE));
    /** The longer line, and a byte more to tell that from a longer file. */
    private static final int MAX_BYTES = Band.ADULT.line.length + 1;

    /** What the file holds, as the image would read it. */
    private enum OnDisk {
        /** No file: unknown here, and locked by the image. */
        NONE(null),
        ADULT(Band.ADULT),
        TEEN(Band.TEEN),
        /** A file that isn't exactly one of the two lines, or can't be read: {@code teen} here, and locked by the image. */
        JUNK(Band.TEEN);

        /** What deskd takes it as, or null for nothing. */
        private final Band band;

        OnDisk(Band band) {
            this.band = band;
        }

        static OnDisk holding(Band band) {
            return band == Band.TEEN ? TEEN : ADULT;
        }
    }

    /**
     * @param told the Platform's last explicit word in this process, or null if it hasn't given one
     * @param onDisk what the file held when last looked at or written
     * @param unsaid whether a config with no field has come in this process, which on a desk with no file is an adult
     */
    private record State(Band told, OnDisk onDisk, boolean unsaid) {
        Band band() {
            if (told != null) {
                return told;
            }
            if (onDisk.band != null) {
                return onDisk.band;
            }
            return unsaid ? Band.ADULT : null;
        }
    }

    private final Path file;
    private final List<Runnable> lockBegins = new CopyOnWriteArrayList<>();
    private final List<Runnable> unlocked = new CopyOnWriteArrayList<>();
    private final List<Runnable> settled = new CopyOnWriteArrayList<>();
    private volatile State state;
    /** Only the boot thread touches these three. */
    private boolean oddValueLogged;
    private boolean writeFailureLogged;
    /** Whether a config with no field has been logged since the last explicit word, so a run of them is one line. */
    private boolean unsaidLogged;

    /** Reads the file, once, here. */
    public AgeBand(Path file) {
        this.file = file;
        this.state = new State(null, read(file), false);
    }

    /** deskd's data directory, where the file is: deskd's alone. */
    public Path directory() {
        return file.toAbsolutePath().getParent();
    }

    /** The band as far as deskd knows, or null while that's unknown. Never blocks. */
    public Band band() {
        return state.band();
    }

    /** Whether a start of Chromium would come up under the right policy, as far as deskd can tell. Never blocks. */
    public boolean browserMayStart() {
        State now = state;
        Band band = now.band();
        return band != null && !(band == Band.TEEN && now.onDisk() == OnDisk.ADULT);
    }

    /**
     * True if another read of the config is worth having: the band is still unknown, or the file doesn't say what the
     * Platform said. The boot sequence reads again, with backoff, so a teen's desk isn't left gated by one failed write.
     */
    public boolean wantsAnotherRead() {
        State now = state;
        return now.band() == null || (now.told() != null && OnDisk.holding(now.told()) != now.onDisk());
    }

    /**
     * Runs on the boot thread as a desk becomes {@code teen} from anything else, before the file is written, so Chromium's
     * stop goes out at once and whether or not the write works. The band already reads {@code teen}. Must not block.
     */
    public void onLockBegins(Runnable listener) {
        lockBegins.add(listener);
    }

    /**
     * Runs on the boot thread as the file comes to say {@code adult} where it said anything else, no file included, with the
     * band {@code adult}: a Chromium that started before still has the teen lock, as the image sets the lock or the
     * allowlist only as Chromium starts. After the write, so a start from here reads {@code adult}, and before
     * {@link #onSettled}. Must not block.
     */
    public void onUnlocked(Runnable listener) {
        unlocked.add(listener);
    }

    /** Runs on the boot thread each time the Platform's word has been dealt with, the write's outcome included. Must not block. */
    public void onSettled(Runnable listener) {
        settled.add(listener);
    }

    /**
     * The whole answer to {@code GET /v1/agent/config}, already known to be a config. No field never lowers the band and
     * never writes: see {@link AgeBand}.
     */
    public void fromConfig(Map<String, Object> config) {
        if (!config.containsKey(FIELD)) {
            keep();
        } else {
            applyValue(config.get(FIELD));
        }
    }

    /**
     * The config hello's reply carries, already known to be a config.
     *
     * @return false if it says nothing about the band, so {@code GET /v1/agent/config} has to
     */
    public boolean fromHello(Map<String, Object> config) {
        if (!config.containsKey(FIELD)) {
            return false;
        }
        applyValue(config.get(FIELD));
        return true;
    }

    private void applyValue(Object value) {
        if (Band.TEEN.wire().equals(value)) {
            apply(Band.TEEN);
        } else if (Band.ADULT.wire().equals(value)) {
            apply(Band.ADULT);
        } else if (!oddValueLogged) {
            oddValueLogged = true;
            log.warn("the config's {} isn't one deskd knows, so it's ignored and what's on disk stands", FIELD);
        }
    }

    /** An explicit answer: the band, written if the file differs. */
    private void apply(Band next) {
        State before = state;
        Band previous = before.band();
        unsaidLogged = false;
        // First, so from here a start of Chromium is refused if the file still says adult.
        state = new State(next, before.onDisk(), before.unsaid());
        if (previous != next) {
            log.info("age band: {} to {}", wire(previous), next.wire());
        }
        if (next == Band.TEEN && previous != Band.TEEN) {
            lockBegins.forEach(Runnable::run);
        }
        // Looked at again each time: a restore, or something else on the volume, can have changed it.
        OnDisk onDisk = read(file);
        if (onDisk != OnDisk.holding(next)) {
            onDisk = write(next) ? OnDisk.holding(next) : read(file);
        }
        state = new State(next, onDisk, before.unsaid());
        if (next == Band.ADULT && onDisk == OnDisk.ADULT && before.onDisk() != OnDisk.ADULT) {
            unlocked.forEach(Runnable::run);
        }
        settled.forEach(Runnable::run);
    }

    /**
     * A config with no field: the Platform's explicit word in this process stands, or else the file's, junk being
     * {@code teen}, or else, with neither, {@code adult}. Nothing is written except {@code adult} on a desk with neither a word nor a file, which lowers nothing.
     */
    private void keep() {
        State before = state;
        Band previous = before.band();
        // Looked at again, as in apply: a file that turned teen behind deskd's back is a teen's, and one that turned adult
        // under a teen said in this process gates Chromium.
        State after = new State(before.told(), read(file), true);
        boolean fromDefault = before.told() == null && after.onDisk() == OnDisk.NONE;
        if (fromDefault) {
            // No word and no file: the desk has never been known as a teen's, so it's an adult as on a Platform without the
            // field, and the file says so, as it always has. A failed write leaves no file, and the next config tries again.
            after = new State(null, write(Band.ADULT) ? OnDisk.ADULT : read(file), true);
        }
        Band next = after.band();
        state = after;
        if (fromDefault) {
            if (!unsaidLogged) {
                log.info("age band: {}, from the default, as the config has no {} and there is no file", next.wire(), FIELD);
            }
        } else if (previous != next) {
            log.info("age band: {} to {}, as the config has no {}, and nothing is written", wire(previous), next.wire(), FIELD);
        } else if (!unsaidLogged) {
            String line = "age band: {}, kept, as the config has no {}, and nothing is written";
            if (next == Band.TEEN) {
                log.warn(line, next.wire(), FIELD);
            } else {
                log.info(line, next.wire(), FIELD);
            }
        }
        unsaidLogged = true;
        if (next == Band.TEEN && previous != Band.TEEN) {
            lockBegins.forEach(Runnable::run);
        }
        if (next == Band.ADULT && after.onDisk() == OnDisk.ADULT && before.onDisk() != OnDisk.ADULT) {
            unlocked.forEach(Runnable::run);
        }
        settled.forEach(Runnable::run);
    }

    private static String wire(Band band) {
        return band == null ? "unknown" : band.wire();
    }

    /**
     * Temp file in the same directory, fsync, rename, fsync the directory, so what's there at any moment is the old line or
     * the new one, and a crash can't leave half of one. A failure leaves the old file and is one log line until a write
     * works, with the class only, as a message can carry the path.
     *
     * @return whether the file now says this
     */
    private boolean write(Band band) {
        Path temp = file.resolveSibling(TEMP);
        try {
            // One a crash left behind. Removing it takes away a link, and not what it names.
            Files.deleteIfExists(temp);
            try (FileChannel channel = FileChannel.open(
                    temp,
                    Set.of(StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE, LinkOption.NOFOLLOW_LINKS),
                    OWNER_ONLY)) {
                ByteBuffer bytes = ByteBuffer.wrap(band.line);
                while (bytes.hasRemaining()) {
                    channel.write(bytes);
                }
                channel.force(true);
            }
            Files.move(temp, file, StandardCopyOption.ATOMIC_MOVE);
        } catch (IOException | RuntimeException e) {
            if (!writeFailureLogged) {
                writeFailureLogged = true;
                log.warn("couldn't write {}, so the old file stands: {}", FILE, e.getClass().getSimpleName());
            }
            deleteQuietly(temp);
            return false;
        }
        writeFailureLogged = false;
        syncDirectory();
        return true;
    }

    /** The rename has happened, and a reader sees the new line. Only a crash could undo it, and the next config read would mend that. */
    private void syncDirectory() {
        try (FileChannel directory = FileChannel.open(file.getParent(), StandardOpenOption.READ)) {
            directory.force(true);
        } catch (IOException | RuntimeException e) {
            log.warn("wrote {}, but couldn't sync its directory: {}", FILE, e.getClass().getSimpleName());
        }
    }

    private static void deleteQuietly(Path path) {
        try {
            Files.deleteIfExists(path);
        } catch (IOException | RuntimeException e) {
            // The next write removes it first.
        }
    }

    /**
     * Believes nothing of it: only a regular file, reached with no symlink followed, holding exactly one of the two lines.
     *
     * @return {@link OnDisk#NONE} only when there's no file, and {@link OnDisk#JUNK} for anything else that isn't a line
     */
    private static OnDisk read(Path file) {
        try {
            BasicFileAttributes attributes = Files.readAttributes(file, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
            if (!attributes.isRegularFile() || attributes.size() >= MAX_BYTES) {
                return OnDisk.JUNK;
            }
            ByteBuffer bytes = ByteBuffer.allocate(MAX_BYTES);
            try (SeekableByteChannel channel = Files.newByteChannel(file, Set.of(StandardOpenOption.READ, LinkOption.NOFOLLOW_LINKS))) {
                while (bytes.hasRemaining() && channel.read(bytes) >= 0) {
                    // Until the end of the file, or one byte past what either line takes.
                }
            }
            byte[] line = Arrays.copyOf(bytes.array(), bytes.position());
            for (Band band : Band.values()) {
                if (Arrays.equals(band.line, line)) {
                    return OnDisk.holding(band);
                }
            }
            return OnDisk.JUNK;
        } catch (NoSuchFileException e) {
            // Gone between the two looks, too.
            return OnDisk.NONE;
        } catch (IOException | RuntimeException e) {
            // Fails closed, as the image does.
            return OnDisk.JUNK;
        }
    }
}
