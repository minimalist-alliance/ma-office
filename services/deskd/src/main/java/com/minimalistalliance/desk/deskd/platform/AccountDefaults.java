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
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The account's values for the desk's spending limits (ADR 0043): {@code agentDefaults} in {@code GET /v1/agent/config},
 * which hello's reply carries too. So they're learned when the config is, with no poll of their own, and Platform bumps
 * {@code configVersion} when they change. The object absent, as a Platform without it sends, is an account with none
 * set. When a read of them fails the field is left out, and deskd then keeps the last it read, in
 * {@code /data/desk/account-defaults.json}, so an account's lower caps still apply after a boot whose read failed. A
 * fresh value, nulls included, replaces it. deskd only carries them: desk-agent decides what they mean, and checks them.
 */
public final class AccountDefaults {

    public static final String FILE = "account-defaults.json";
    /** The account's three, then {@code tier}: the owner's tier's settings for agents (task 49, ADR 0047), passed through. */
    private static final String[] NAMES = {"deskDay", "deskMonth", "timeZone", "tier"};
    private static final Logger log = LoggerFactory.getLogger(AccountDefaults.class);

    private volatile Map<String, Object> current;
    private Path file;
    private boolean onDisk;
    private volatile Runnable onChange = () -> {};

    /**
     * Keeps the last values in this file and loads them now, to stand until a fresh value comes. Before boot starts. A
     * file that is missing is nothing; one that isn't a good object is ignored, with one log line.
     */
    public void keepIn(Path path) {
        file = path;
        try {
            Map<String, Object> saved = Json.parseObject(Files.readAllBytes(path));
            Map<String, Object> loaded = new LinkedHashMap<>();
            for (String name : NAMES) {
                loaded.put(name, saved.get(name));
            }
            current = Collections.unmodifiableMap(loaded);
            onDisk = true;
        } catch (NoSuchFileException e) {
            log.debug("account defaults: none kept yet");
        } catch (Exception e) {
            log.warn("account defaults: ignoring the kept file ({})", e.getClass().getSimpleName());
        }
    }

    /**
     * From the boot thread, for each config.
     *
     * @param agentDefaults the config's {@code agentDefaults}. Null is a read that failed, or a Platform without it: the
     *     last values stand, and with none yet the account has none set.
     */
    public void apply(Map<String, Object> agentDefaults) {
        Map<String, Object> next = new LinkedHashMap<>();
        for (String name : NAMES) {
            next.put(name, agentDefaults == null ? null : agentDefaults.get(name));
        }
        // A config with no tier (the Platform couldn't read it) keeps the last, never an absent one, so a lower tier's
        // caps don't give way to a default (task 49).
        if (!(next.get("tier") instanceof Map<?, ?>) && current != null && current.get("tier") instanceof Map<?, ?>) {
            next.put("tier", current.get("tier"));
        }
        if (agentDefaults == null && current != null) {
            return;
        }
        boolean changed = !next.equals(current);
        if (changed) {
            current = Collections.unmodifiableMap(next);
        }
        if (agentDefaults != null && (changed || !onDisk)) {
            save(next);
        }
        if (changed) {
            onChange.run();
        }
    }

    /** Temporary file, flushed, renamed over the real one. A failure costs only the values surviving a restart. */
    private void save(Map<String, Object> values) {
        if (file == null) {
            return;
        }
        Path temporary = file.resolveSibling(FILE + ".tmp");
        try {
            Files.deleteIfExists(temporary);
            try (FileChannel channel = FileChannel.open(temporary, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)) {
                ByteBuffer buffer = ByteBuffer.wrap(Json.bytes(values));
                while (buffer.hasRemaining()) {
                    channel.write(buffer);
                }
                channel.force(true);
            }
            Files.move(temporary, file, StandardCopyOption.ATOMIC_MOVE);
            onDisk = true;
        } catch (IOException | RuntimeException e) {
            log.warn("account defaults: can't keep them ({})", e.getClass().getSimpleName());
            try {
                Files.deleteIfExists(temporary);
            } catch (IOException | RuntimeException again) {
                log.debug("account defaults: the temporary file stays until the next save");
            }
        }
    }

    /** @return {@code {deskDay, deskMonth, timeZone, tier}}, each possibly null, or null before the first config */
    public Map<String, Object> current() {
        return current;
    }

    /** Runs when they change, the first config included. Set before boot starts. Must not block. */
    public void onChange(Runnable listener) {
        onChange = listener;
    }
}
