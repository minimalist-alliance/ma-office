package com.minimalistalliance.desk.deskd.browser;

import java.io.IOException;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Chromium may be frozen, kept across a restart of deskd ({@link BrowserFreeze}). It's written before a freeze goes to
 * units.sock and removed once a thaw has worked, so a deskd that starts and finds it thaws Chromium before anything
 * touches it. It's beside units.sock, so in /run/desk on a desk, a tmpfs, and a reboot clears it along with the freeze.
 *
 * <p>Presence only, and empty, like {@link RefusalMarker}, and for the same reasons nothing here follows a link. rtc owns
 * that directory, so it can add or remove this: adding it costs one thaw at deskd's next start, and removing it while
 * Chromium is frozen leaves it frozen only until the next thing that thaws it, which anything wanting the Browser does.
 * A failure is one log line, and the state in memory stands.
 */
final class FreezeMarker {

    static final String NAME = "browser-frozen";

    private static final Logger log = LoggerFactory.getLogger(FreezeMarker.class);

    private final Path file;

    FreezeMarker(Path file) {
        this.file = file;
    }

    /** Whether an earlier deskd of this boot may have left Chromium frozen. */
    boolean present() {
        return Files.exists(file, LinkOption.NOFOLLOW_LINKS);
    }

    /** Never throws. Calls on a file, so never under a lock. */
    void write(boolean frozen) {
        try {
            if (frozen) {
                Files.createFile(file);
            } else {
                Files.deleteIfExists(file);
            }
        } catch (FileAlreadyExistsException e) {
            // Something's there already, and presence is all it says.
        } catch (IOException | RuntimeException e) {
            log.warn("couldn't {} {}, so a restart of deskd would {}: {}",
                    frozen ? "write" : "remove",
                    NAME,
                    frozen ? "not know to thaw Chromium first" : "thaw Chromium once more than it needs to",
                    e.getClass().getSimpleName());
        }
    }
}
