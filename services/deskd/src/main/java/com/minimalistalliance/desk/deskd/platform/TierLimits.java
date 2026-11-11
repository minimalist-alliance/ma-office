package com.minimalistalliance.desk.deskd.platform;

import com.minimalistalliance.desk.deskd.protocol.Json;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Consumer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The free tier's limits on this desk (ma-platform contract agent.md {@code tierLimits}, tiers.md section 11, ADR 0090):
 * Browser time a day, the Files app's cap and the idle stop. On a free member's desk only; absent means no tier limits,
 * and after an upgrade in place the field is gone at a new {@code configVersion}, so the limits lift there and then.
 *
 * <p><b>What a config means.</b> A complete config with the field is those limits; with none, no limits. A read that
 * fails never reaches this class, so a {@code 503} changes nothing (Security's {@code TD-2} lesson: a failed read is
 * never "no limits" and never "new limits"). Hello's copy with {@code configVersion: 0}, the Platform's mark for a config
 * it couldn't finish (agent.md), changes nothing either, unless nothing is held yet. A field that's there but isn't an
 * object keeps what's held, none included, or with nothing held, the tier's built-in values, as its being there says the
 * desk is a free one. A field that's bad inside a good object keeps that field's held value, or its built-in one.
 *
 * <p><b>On disk.</b> {@code /data/desk/tier-limits.json}: {@code {"limits": {...}}} or {@code {"limits": null}}, the
 * last explicit word, so a desk's limits stand from the first moment after a restart. No file is "never told", which is
 * no limits. A file that's junk holds the built-in values until a config says, failing closed as the age band does.
 *
 * <p><b>Threads.</b> Only the boot thread calls {@link #fromConfig}. The state is one immutable value, so reads never
 * block. Listeners run on the boot thread with nothing held, and must not block.
 */
public final class TierLimits {

    public static final String FILE = "tier-limits.json";
    public static final String FIELD = "tierLimits";

    /**
     * @param tier the tier's id as the Platform said it, {@code free} today, for display
     * @param browserMinutesPerDay Browser time a day, in whole minutes
     * @param filesGb the Files app's cap, in GiB
     * @param idleStopMinutes the idle stop the Platform applies, carried for the office to show and to rest sooner
     */
    public record Limits(String tier, int browserMinutesPerDay, int filesGb, int idleStopMinutes) {

        public long filesCapBytes() {
            return (long) filesGb << 30;
        }

        public long browserMillisPerDay() {
            return browserMinutesPerDay * 60_000L;
        }

        Map<String, Object> toJson() {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("tier", tier);
            out.put("browserMinutesPerDay", browserMinutesPerDay);
            out.put("filesGb", filesGb);
            out.put("idleStopMinutes", idleStopMinutes);
            return out;
        }
    }

    /** The tier's own values (tiers.md section 11.1), for a desk the Platform says is free but doesn't say how. */
    public static final Limits FREE_DEFAULTS = new Limits("free", 45, 2, 30);

    private static final Logger log = LoggerFactory.getLogger(TierLimits.class);
    private static final int MAX_MINUTES_PER_DAY = 1440;
    private static final int MAX_FILES_GB = 1024;
    private static final int MAX_IDLE_MINUTES = 10080;
    private static final int MAX_TIER_CHARS = 32;

    /** @param limits null for none @param known whether anything has said: the Platform, or a file */
    private record State(Limits limits, boolean known) {}

    private final List<Consumer<Limits>> listeners = new CopyOnWriteArrayList<>();
    private volatile State state = new State(null, false);
    private Path file;
    /** Only the boot thread touches these. */
    private boolean malformedLogged;
    private boolean saveFailureLogged;
    /** The file says what's held, as far as this process knows. */
    private boolean fileCurrent;

    /**
     * Keeps the last word in this file and loads it now, to stand until a config says. Before boot starts. A file that's
     * missing is nothing said; one that isn't a good record is the tier's built-in values, with one log line.
     */
    public void keepIn(Path path) {
        file = path;
        try {
            Map<String, Object> saved = Json.parseObject(Files.readAllBytes(path));
            if (!saved.containsKey("limits")) {
                throw new IllegalArgumentException("no limits key");
            }
            Object limits = saved.get("limits");
            if (limits == null) {
                state = new State(null, true);
                fileCurrent = true;
                return;
            }
            if (!(limits instanceof Map<?, ?>)) {
                throw new IllegalArgumentException("limits isn't an object");
            }
            @SuppressWarnings("unchecked")
            Limits read = strict((Map<String, Object>) limits);
            if (read == null) {
                throw new IllegalArgumentException("limits are out of bounds");
            }
            state = new State(read, true);
            fileCurrent = true;
        } catch (NoSuchFileException e) {
            log.debug("tier limits: none kept yet");
        } catch (Exception e) {
            // Fails closed: a free desk whose file broke is still a free desk until the Platform says otherwise.
            log.warn("tier limits: the kept file can't be read ({}), so the free tier's own values stand until the next config",
                    e.getClass().getSimpleName());
            state = new State(FREE_DEFAULTS, true);
        }
    }

    /** The limits now, or null for none. Never blocks. */
    public Limits current() {
        return state.limits();
    }

    /** Runs with the new limits, null for none, each time they change. Set before boot starts. Must not block. */
    public void onChange(Consumer<Limits> listener) {
        listeners.add(listener);
    }

    /** The whole config, from {@code GET /v1/agent/config} or hello's copy, already known to be a config. */
    public void fromConfig(Map<String, Object> config) {
        State before = state;
        boolean incomplete = config.get("configVersion") instanceof Number version && version.longValue() == 0;
        if (incomplete && before.known()) {
            return;
        }
        Limits next;
        boolean explicit;
        if (!config.containsKey(FIELD)) {
            next = null;
            explicit = true;
        } else if (config.get(FIELD) instanceof Map<?, ?> object) {
            @SuppressWarnings("unchecked")
            Map<String, Object> fields = (Map<String, Object>) object;
            next = lenient(fields, before.limits() != null ? before.limits() : FREE_DEFAULTS);
            explicit = true;
        } else {
            if (!malformedLogged) {
                malformedLogged = true;
                log.warn("the config's {} isn't an object, so what's held stands", FIELD);
            }
            // What's held stands, none included; only a desk that holds no word takes the field's being there as free.
            next = before.known() ? before.limits() : FREE_DEFAULTS;
            explicit = false;
        }
        // A config that couldn't be finished is only taken by a desk that holds no word at all, and isn't kept.
        boolean keep = explicit && !incomplete;
        boolean changed = !Objects.equals(next, before.limits());
        state = new State(next, true);
        if (changed) {
            log.info("tier limits: {} to {}", describe(before.limits()), describe(next));
        }
        if (keep && (changed || !fileCurrent)) {
            save(next);
        }
        if (changed) {
            for (Consumer<Limits> listener : listeners) {
                listener.accept(next);
            }
        }
    }

    private static String describe(Limits limits) {
        if (limits == null) {
            return "none";
        }
        return limits.tier() + " (Browser " + limits.browserMinutesPerDay() + " min a day, Files " + limits.filesGb() + " GiB, idle stop "
                + limits.idleStopMinutes() + " min)";
    }

    /** Field by field: a bad one keeps its value in {@code fallback}. */
    private Limits lenient(Map<String, Object> fields, Limits fallback) {
        String tier = tier(fields.get("tier"));
        Integer minutes = whole(fields.get("browserMinutesPerDay"), MAX_MINUTES_PER_DAY);
        Integer gb = whole(fields.get("filesGb"), MAX_FILES_GB);
        Integer idle = whole(fields.get("idleStopMinutes"), MAX_IDLE_MINUTES);
        if ((tier == null || minutes == null || gb == null || idle == null) && !malformedLogged) {
            malformedLogged = true;
            log.warn("the config's {} has a field deskd can't use, so that field keeps its held value", FIELD);
        }
        return new Limits(
                tier != null ? tier : fallback.tier(),
                minutes != null ? minutes : fallback.browserMinutesPerDay(),
                gb != null ? gb : fallback.filesGb(),
                idle != null ? idle : fallback.idleStopMinutes());
    }

    /** Every field good, or null: for the file, which deskd wrote itself. */
    private static Limits strict(Map<String, Object> fields) {
        String tier = tier(fields.get("tier"));
        Integer minutes = whole(fields.get("browserMinutesPerDay"), MAX_MINUTES_PER_DAY);
        Integer gb = whole(fields.get("filesGb"), MAX_FILES_GB);
        Integer idle = whole(fields.get("idleStopMinutes"), MAX_IDLE_MINUTES);
        if (tier == null || minutes == null || gb == null || idle == null) {
            return null;
        }
        return new Limits(tier, minutes, gb, idle);
    }

    private static String tier(Object value) {
        if (value instanceof String s && !s.isEmpty() && s.length() <= MAX_TIER_CHARS && s.chars().allMatch(c -> c >= 'a' && c <= 'z' || c == '_')) {
            return s;
        }
        return null;
    }

    /** A whole number from 1 to {@code max}, in whatever type the parser gave it, or null. */
    private static Integer whole(Object value, int max) {
        long n;
        if (value instanceof Integer i) {
            n = i;
        } else if (value instanceof Long l) {
            n = l;
        } else if (value instanceof Double d && d == Math.rint(d) && !d.isInfinite()) {
            n = d.longValue();
        } else if (value instanceof java.math.BigDecimal b) {
            try {
                n = b.longValueExact();
            } catch (ArithmeticException e) {
                return null;
            }
        } else {
            return null;
        }
        return n >= 1 && n <= max ? (int) n : null;
    }

    /** Temporary file, fsynced, renamed over the real one. A failure costs only the limits standing through a restart. */
    private void save(Limits limits) {
        if (file == null) {
            return;
        }
        Map<String, Object> record = new LinkedHashMap<>();
        record.put("limits", limits == null ? null : limits.toJson());
        Path temporary = file.resolveSibling(FILE + ".tmp");
        try {
            Files.deleteIfExists(temporary);
            try (FileChannel channel = FileChannel.open(temporary, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)) {
                ByteBuffer buffer = ByteBuffer.wrap(Json.bytes(record));
                while (buffer.hasRemaining()) {
                    channel.write(buffer);
                }
                channel.force(true);
            }
            Files.move(temporary, file, StandardCopyOption.ATOMIC_MOVE);
            saveFailureLogged = false;
            fileCurrent = true;
        } catch (IOException | RuntimeException e) {
            fileCurrent = false;
            if (!saveFailureLogged) {
                saveFailureLogged = true;
                log.warn("tier limits: can't keep them ({})", e.getClass().getSimpleName());
            }
            try {
                Files.deleteIfExists(temporary);
            } catch (IOException | RuntimeException again) {
                log.debug("tier limits: the temporary file stays until the next save");
            }
        }
    }
}
