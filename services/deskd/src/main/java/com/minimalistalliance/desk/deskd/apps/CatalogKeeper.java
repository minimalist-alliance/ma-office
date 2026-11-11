package com.minimalistalliance.desk.deskd.apps;

import java.io.IOException;
import java.io.InputStream;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Supplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The catalog this desk believes: the last envelope that verified, in memory, fetched again when a caller wants one fresher
 * than it has. Fetched only when something asks: the picker's {@code apps.catalog.get}, an install, and the daily check
 * while any app is installed. A desk with no apps and nobody looking never asks the Platform for it. Only its {@code seq} is
 * kept on the volume, in the registry, so a replayed older catalog is refused across restarts too, and nothing of the
 * catalog lands in the member's export.
 */
final class CatalogKeeper {

    private static final Logger log = LoggerFactory.getLogger(CatalogKeeper.class);

    /** Where the catalog and packages come from: the Platform's public routes, or a test's bytes. */
    interface Source {
        /** @return the envelope, or null if the Platform has no catalog yet (404) */
        byte[] fetchCatalog() throws IOException, InterruptedException;

        /** The package with this hash, as a stream the caller closes. */
        InputStream openPackage(String packageSha256) throws IOException, InterruptedException;
    }

    private final AppStore store;
    private final Supplier<List<AppKeys.TrustedKey>> reviewKeys;
    private final Source source;
    private final Clock clock;
    private final ReentrantLock lock = new ReentrantLock();
    private AppCatalog current;
    private Instant fetchedAt;

    CatalogKeeper(AppStore store, Supplier<List<AppKeys.TrustedKey>> reviewKeys, Source source, Clock clock) {
        this.store = store;
        this.reviewKeys = reviewKeys;
        this.source = source;
        this.clock = clock;
    }

    Source source() {
        return source;
    }

    /** The catalog in memory, or null before the first that verified since deskd started. */
    AppCatalog current() {
        lock.lock();
        try {
            return current;
        } finally {
            lock.unlock();
        }
    }

    /**
     * A catalog fetched within {@code maxAge}, fetching one if not; the kept one if the fetch fails or the Platform's is
     * older; null if there's neither.
     */
    AppCatalog fresh(Duration maxAge) throws InterruptedException {
        lock.lockInterruptibly();
        try {
            Instant now = clock.instant();
            if (fetchedAt != null && Duration.between(fetchedAt, now).compareTo(maxAge) < 0) {
                return current;
            }
            try {
                byte[] envelope = source.fetchCatalog();
                fetchedAt = now;
                if (envelope != null) {
                    accept(envelope);
                }
            } catch (IOException e) {
                log.info("apps: the catalog couldn't be fetched; the kept one stands");
            }
            return current;
        } finally {
            lock.unlock();
        }
    }

    /** Takes an envelope if it verifies and isn't older than the newest taken. @return whether it's now the current one */
    boolean accept(byte[] envelope) {
        lock.lock();
        try {
            AppCatalog next;
            try {
                next = AppCatalog.verify(envelope, reviewKeys.get());
            } catch (AppCatalog.CatalogException e) {
                log.warn("apps: a catalog was refused: {}", e.getMessage());
                return false;
            }
            long floor;
            try {
                floor = store.catalogSeq();
            } catch (IOException e) {
                floor = current == null ? 0 : current.seq();
            }
            if (current != null && next.seq() == current.seq()) {
                if (!java.util.Arrays.equals(next.envelope(), current.envelope())) {
                    log.warn("apps: a catalog with the current one's seq and other bytes was refused");
                }
                return false;
            }
            if (next.seq() < floor || (current != null && next.seq() < current.seq())) {
                log.warn("apps: a catalog older than the newest taken was refused");
                return false;
            }
            try {
                store.catalogSeq(next.seq());
            } catch (IOException e) {
                log.warn("apps: the catalog's seq couldn't be kept on the volume");
            }
            current = next;
            log.info("apps: catalog seq {} taken", next.seq());
            return true;
        } finally {
            lock.unlock();
        }
    }
}
