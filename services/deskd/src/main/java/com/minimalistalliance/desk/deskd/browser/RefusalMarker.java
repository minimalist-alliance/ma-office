package com.minimalistalliance.desk.deskd.browser;

import java.io.IOException;
import java.nio.file.FileAlreadyExistsException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * A refused start of Chromium, kept across a restart of deskd ({@link BrowserStream#chromiumRefused}). Platform clears
 * its flag on any heartbeat without the check, so a deskd that forgot would read as a desk that had been fixed. It's a
 * file beside units.sock, so in /run/desk on a desk, which is a tmpfs: a reboot clears it, and then only a start can
 * say again.
 *
 * <p>Presence only, and empty. rtc owns that directory, so it can add or remove this, and all it gains is the one bit.
 * Nothing here follows a link: creating fails at any name that's there already, the look doesn't follow one, and removing
 * takes away the link and not what it names. These are calls on a file, so never make them under a lock. A failure is
 * one log line, and the state in memory stands.
 */
final class RefusalMarker {

    static final String NAME = "chromium-refused";

    private static final Logger log = LoggerFactory.getLogger(RefusalMarker.class);

    private final Path file;

    RefusalMarker(Path file) {
        this.file = file;
    }

    /** Whether an earlier deskd of this boot saw a refusal, and no start that worked after it. */
    boolean present() {
        return Files.exists(file, LinkOption.NOFOLLOW_LINKS);
    }

    /** Never throws. */
    void write(boolean refused) {
        try {
            if (refused) {
                Files.createFile(file);
            } else {
                Files.deleteIfExists(file);
            }
        } catch (FileAlreadyExistsException e) {
            // Something's there already, and presence is all it says.
        } catch (IOException | RuntimeException e) {
            // The class only: a message can carry the path, and that's all it would add.
            log.warn("couldn't {} {}, so a restart of deskd would {}: {}",
                    refused ? "write" : "remove",
                    NAME,
                    refused ? "forget the refusal" : "still take Chromium as refused",
                    e.getClass().getSimpleName());
        }
    }
}
