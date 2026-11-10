package com.minimalistalliance.desk.deskd.browser;

import java.io.IOException;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.Semaphore;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.BooleanSupplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Our own page in place of Chromium's, for a site the family filter stopped, on a teen's desk only. A teen's Chromium
 * resolves names through the family resolver ({@link FamilyDns}), which answers {@code 0.0.0.0} for a filtered site, so the
 * page fails with {@code ERR_CONNECTION_REFUSED} (checked on Chrome 156, with the real resolver and its test names), which
 * tells a teen nothing. So when a tab's main frame commits Chromium's error page for a connection error, the resolver is
 * asked about that host, and if it filters it, {@link FilteredPage} goes in its place.
 *
 * <p><b>Only a teen's.</b> Every step asks {@link #active}, which is the age band as deskd knows it right now. An adult's
 * desk never gets past that first look, on the read path, so it makes no thread, call or request.
 *
 * <p><b>Privacy.</b> The resolver hears only the host, and only one a teen's Chromium has just asked it about: the error
 * code is read first, and each of {@link #CONNECTION_ERRORS} comes after a name was resolved. Names Chromium answers
 * without it never go: IP literals, {@code localhost} and the rest of {@link #hostOf}'s list. Neither the host nor the URL
 * is ever logged or kept: the log gets counts, and a failing resolver's exception class.
 *
 * <p><b>Never in the way.</b> Nothing here runs on a navigation's path: Chromium has already shown its own page, and that
 * stays if anything fails, times out or is busy. At most {@link #MAX_LOOKUPS} run at once, each on its own thread, and
 * past that a page is left as Chromium made it. No lock is held across any of it.
 */
final class FilteredSites {

    private static final Logger log = LoggerFactory.getLogger(FilteredSites.class);

    /** Whether the resolver filters a host. */
    interface Lookup {
        /**
         * @param host lower case and ASCII, from {@link #hostOf}
         * @throws IOException if that can't be told, in time or at all
         */
        boolean filtered(String host) throws IOException, InterruptedException;
    }

    /** One commit of Chromium's error page in a tab's main frame. */
    interface ErrorPage {
        /** @return its net error, such as {@code ERR_CONNECTION_REFUSED}, or null if it's gone or doesn't say */
        String errorCode() throws CdpException, InterruptedException;

        /** Puts {@code html} in its place, if it's still that very page. @return whether it did */
        boolean replace(String html) throws CdpException, InterruptedException;
    }

    /** Looks at once. Each holds a thread for at most a few CDP calls and {@link FamilyDns#TIMEOUT}. */
    static final int MAX_LOOKUPS = 4;

    /**
     * What a filtered name can end in, and none can happen before a name has been resolved. On a desk it's
     * {@code ERR_CONNECTION_REFUSED}: Linux takes {@code 0.0.0.0} and {@code ::} for this host, and nothing listens on its
     * loopback at 80 or 443 (desk-rtc binds the instance's own address). The rest are what a connect to those can give
     * elsewhere: an address the system won't use, a host without IPv6, or something local that answered and hung up.
     */
    static final Set<String> CONNECTION_ERRORS = Set.of(
            "ERR_CONNECTION_REFUSED",
            "ERR_CONNECTION_FAILED",
            "ERR_CONNECTION_RESET",
            "ERR_CONNECTION_CLOSED",
            "ERR_EMPTY_RESPONSE",
            "ERR_ADDRESS_INVALID",
            "ERR_ADDRESS_UNREACHABLE");

    private static final int MAX_HOST_CHARS = 253;
    private static final Set<String> LOCAL_SUFFIXES = Set.of(".localhost", ".local", ".internal", ".arpa");

    private final Lookup lookup;
    private final Semaphore slots = new Semaphore(MAX_LOOKUPS);
    private final AtomicLong lookups = new AtomicLong();
    private final AtomicLong shown = new AtomicLong();
    private final AtomicLong failed = new AtomicLong();
    private final AtomicLong busy = new AtomicLong();
    private final AtomicLong finished = new AtomicLong();
    private final AtomicBoolean failingLogged = new AtomicBoolean();
    private volatile BooleanSupplier teen = () -> false;

    FilteredSites(Lookup lookup) {
        this.lookup = lookup;
    }

    /** Where the band comes from. Until this is called, nothing here ever acts. */
    void teenFrom(BooleanSupplier teen) {
        this.teen = teen;
    }

    /** True while the desk is a teen's. Never blocks. */
    boolean active() {
        return teen.getAsBoolean();
    }

    /**
     * A tab's main frame has committed Chromium's error page. Runs on the read path, perhaps with BrowserTabs' lock held,
     * so it never blocks: the rest is on a thread of its own.
     *
     * @param unreachableUrl the URL that failed, as Chromium gave it, which goes no further than this method
     */
    void errorPageCommitted(String unreachableUrl, ErrorPage page) {
        if (!active()) {
            return;
        }
        String host = hostOf(unreachableUrl);
        if (host == null) {
            return;
        }
        if (!slots.tryAcquire()) {
            busy.incrementAndGet();
            log.debug("teen filter busy, Chromium's page stays ({} so far)", busy.get());
            return;
        }
        try {
            Thread.ofVirtual().name("teen-filter").start(() -> check(host, page));
        } catch (RuntimeException e) {
            slots.release();
            log.error("teen filter couldn't start a look: {}", e.getClass().getName());
        }
    }

    private void check(String host, ErrorPage page) {
        try {
            String code = page.errorCode();
            if (code == null || !CONNECTION_ERRORS.contains(code) || !active()) {
                return;
            }
            lookups.incrementAndGet();
            boolean filtered;
            try {
                filtered = lookup.filtered(host);
            } catch (IOException e) {
                failed.incrementAndGet();
                if (failingLogged.compareAndSet(false, true)) {
                    // The class only: a message can say what was asked.
                    log.warn("teen filter can't reach the family resolver, so Chromium's own pages stay: {}", e.getClass().getSimpleName());
                }
                return;
            }
            if (failingLogged.compareAndSet(true, false)) {
                log.info("teen filter reaches the family resolver again");
            }
            if (filtered && active() && page.replace(FilteredPage.HTML)) {
                shown.incrementAndGet();
            }
            log.debug("teen filter: {} shown of {} looked up, {} failed", shown.get(), lookups.get(), failed.get());
        } catch (CdpException e) {
            log.debug("teen filter: the page didn't answer: {}", e.kind());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (RuntimeException e) {
            log.error("teen filter failed: {}", e.getClass().getName());
        } finally {
            slots.release();
            finished.incrementAndGet();
        }
    }

    /**
     * Since this process started.
     *
     * @param lookups questions to the resolver
     * @param shown pages put in place of Chromium's
     * @param failed questions with no answer in time, or at all
     * @param busy error pages left as they were, as {@link #MAX_LOOKUPS} were under way
     * @param finished error pages looked at, whatever came of it
     */
    record Counts(long lookups, long shown, long failed, long busy, long finished) {}

    Counts counts() {
        return new Counts(lookups.get(), shown.get(), failed.get(), busy.get(), finished.get());
    }

    /**
     * The host of an {@code http} or {@code https} URL, in the ASCII form Chromium resolves it in, if it's one Chromium
     * would have asked the resolver about.
     *
     * @return null for anything else: another scheme, an IP literal, a name with no dot, {@code localhost} and names
     *     under it, {@code .local}, {@code .internal} and {@code .arpa}, or anything that isn't plain letters, digits,
     *     hyphens and underscores in labels of 1 to 63
     */
    static String hostOf(String url) {
        if (url == null) {
            return null;
        }
        String lower = url.toLowerCase(Locale.ROOT);
        int start;
        if (lower.startsWith("https://")) {
            start = 8;
        } else if (lower.startsWith("http://")) {
            start = 7;
        } else {
            return null;
        }
        int end = start;
        while (end < lower.length() && "/?#\\".indexOf(lower.charAt(end)) < 0) {
            end++;
        }
        String authority = lower.substring(start, end);
        String host = authority.substring(authority.lastIndexOf('@') + 1);
        if (host.startsWith("[")) {
            return null;
        }
        int colon = host.indexOf(':');
        if (colon >= 0) {
            host = host.substring(0, colon);
        }
        if (host.endsWith(".")) {
            host = host.substring(0, host.length() - 1);
        }
        return isResolvedName(host) ? host : null;
    }

    private static boolean isResolvedName(String host) {
        if (host.isEmpty() || host.length() > MAX_HOST_CHARS || host.indexOf('.') < 0 || host.equals("localhost")) {
            return false;
        }
        for (String suffix : LOCAL_SUFFIXES) {
            if (host.endsWith(suffix)) {
                return false;
            }
        }
        boolean allDigits = true;
        for (String label : host.split("\\.", -1)) {
            if (label.isEmpty() || label.length() > 63) {
                return false;
            }
            for (int i = 0; i < label.length(); i++) {
                char c = label.charAt(i);
                if (!(c >= 'a' && c <= 'z') && !(c >= '0' && c <= '9') && c != '-' && c != '_') {
                    return false;
                }
                allDigits &= c >= '0' && c <= '9';
            }
        }
        // Chromium reads a name of digits and dots as an IPv4 address, and won't resolve one whose last label is a number.
        String last = host.substring(host.lastIndexOf('.') + 1);
        return !allDigits && !last.chars().allMatch(Character::isDigit);
    }
}
