package com.minimalistalliance.desk.deskd.browser;

import com.minimalistalliance.desk.deskd.rpc.RpcException;
import java.io.ByteArrayOutputStream;
import java.net.IDN;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.Semaphore;
import java.util.concurrent.atomic.AtomicLong;
import java.util.function.Supplier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The office's easter egg (the owner's, 2026-11-12): a member who opens their office inside their own desk's Browser lands on
 * the portal page, {@value #PROD_PORTAL} ({@value #STAGING_PORTAL} on staging), instead of Chromium's "This page is blocked".
 * Only {@code office.} and {@code desk.} go there; {@code api.}, {@code auth.} and {@code gw.} stay Chromium's blocked page.
 *
 * <p><b>It fails closed.</b> The image's managed policy (its URLBlocklist) blocks the office hosts, and nothing here unblocks
 * anything: deskd only ever sends a tab to the portal. If deskd is down, switched off ({@value #PROPERTY}), busy, or anything
 * here fails, the member sees Chromium's blocked page as before, and the office never opens inside itself.
 *
 * <p><b>Two ways there.</b> deskd's own navigations for the member (the Desk app's address bar, links it opens, new tabs it
 * makes) go straight to the portal, with no blocked page and no history entry for the office: {@link #direct}. Anything else,
 * such as a link, a redirect or a {@code window.open}, Chromium blocks, and when a member tab's main frame commits that blocked
 * page for an office host, {@link #errorPageCommitted} sends it on with a {@code location.replace} from deskd's isolated world
 * in that very document. The replace takes the office's entry out of the tab's history, so Back from the portal goes straight
 * to the page before: it can never land on a page that sends it forward again.
 *
 * <p><b>Only that error, only the main frame, only once.</b> The error is read from the page first ({@link ErrorPage}), and only
 * {@value #BLOCKED} goes on. {@link BrowserTabs} hands over only a member tab's main frame, and each commit once. A blocked
 * office page that comes right after the portal, as a portal that sent the tab back to the office would make, stays as it is,
 * so there's never a loop.
 *
 * <p><b>Not the Agent's.</b> The Agent's tabs are hidden targets of its own ({@link AgentBrowsing}), whose events never reach
 * the member's tab model, so none is ever handed over: the Agent's tools report a blocked page exactly as before.
 *
 * <p><b>Never in the way.</b> Nothing here runs on a navigation's path: Chromium has already shown its page, and that stays if
 * anything fails, times out or is busy. At most {@link #MAX_REDIRECTS} run at once, each on its own thread.
 *
 * <p><b>Privacy.</b> No URL, host or path is logged, kept or sent anywhere: the log gets counts, at debug.
 */
final class PortalRedirect {

    private static final Logger log = LoggerFactory.getLogger(PortalRedirect.class);

    /** The setting, {@code DESKD_PORTAL_URL} in deskd.env: unset follows the Env tag, {@value #OFF} turns it off, or a URL. */
    static final String PROPERTY = "deskd.portal.url";
    static final String OFF = "off";
    static final String PROD_PORTAL = "https://portal.minimalistalliance.com/";
    static final String STAGING_PORTAL = "https://portal.staging.minimalistalliance.com/";
    /** The net error of the policy's blocked page, without {@code net::}. */
    static final String BLOCKED = "ERR_BLOCKED_BY_ADMINISTRATOR";
    /** Error pages looked at once. Each holds a thread for at most three CDP calls. */
    static final int MAX_REDIRECTS = 4;
    /** The office, and every name under it. Lower case and ASCII. */
    static final List<String> OFFICE_HOSTS = List.of(
            "office.minimalistalliance.com",
            "desk.minimalistalliance.com",
            "office.staging.minimalistalliance.com",
            "desk.staging.minimalistalliance.com");

    private static final int MAX_URL_CHARS = 16 * 1024;
    private static final int MAX_HOST_CHARS = 253;

    /** One commit of Chromium's error page in a member tab's main frame. */
    interface ErrorPage {
        /** @return its net error, such as {@value #BLOCKED}, or null if it's gone or doesn't say */
        String errorCode() throws CdpException, InterruptedException;

        /** Replaces it with {@code url}, if it's still that very page and still the policy's. @return whether it did */
        boolean leaveFor(String url) throws CdpException, InterruptedException;
    }

    private final Semaphore slots = new Semaphore(MAX_REDIRECTS);
    private final AtomicLong redirected = new AtomicLong();
    private final AtomicLong direct = new AtomicLong();
    private final AtomicLong held = new AtomicLong();
    private final AtomicLong busy = new AtomicLong();
    private final AtomicLong finished = new AtomicLong();
    private volatile Supplier<String> portal = () -> null;

    /** Where the portal is. Until this is called, nothing here ever acts. */
    void portalFrom(Supplier<String> portal) {
        this.portal = portal;
    }

    /** @return the portal's URL, or null while it's off. Never blocks. */
    String portalUrl() {
        return portal.get();
    }

    boolean on() {
        return portalUrl() != null;
    }

    /**
     * Whether a commit of Chromium's error page for {@code unreachableUrl} is this one's to look at: on, and an office host.
     * Runs on the read path, so never blocks.
     */
    boolean wants(String unreachableUrl) {
        return on() && isOffice(unreachableUrl);
    }

    /** Whether {@code url} is a page of the portal, as Chromium committed it. */
    boolean isPortalPage(String url) {
        String at = portalUrl();
        return at != null && url != null && url.startsWith(at);
    }

    /**
     * Where deskd's own navigation for the member goes: the portal for an office URL while it's on, and {@code url}
     * otherwise.
     *
     * @param url already through {@link BrowserUrl}
     */
    String direct(String url) {
        String at = portalUrl();
        if (at == null || !isOffice(url)) {
            return url;
        }
        direct.incrementAndGet();
        log.debug("portal: {} sent straight there", direct.get());
        return at;
    }

    /**
     * A member tab's main frame has committed Chromium's error page for an office host ({@link #wants}). Runs on the read path,
     * perhaps with BrowserTabs' lock held, so it never blocks: the rest is on a thread of its own.
     *
     * @param afterPortal the tab was sent to the portal, or showed it, just before this commit: it's left as it is
     */
    void errorPageCommitted(ErrorPage page, boolean afterPortal) {
        if (!on()) {
            return;
        }
        if (afterPortal) {
            held.incrementAndGet();
            log.debug("portal: a blocked page right after the portal stays ({} so far)", held.get());
            return;
        }
        if (!slots.tryAcquire()) {
            busy.incrementAndGet();
            log.debug("portal busy, Chromium's page stays ({} so far)", busy.get());
            return;
        }
        try {
            Thread.ofVirtual().name("portal").start(() -> send(page));
        } catch (RuntimeException e) {
            slots.release();
            log.error("portal couldn't start: {}", e.getClass().getName());
        }
    }

    private void send(ErrorPage page) {
        try {
            String code = page.errorCode();
            String at = portalUrl();
            if (!BLOCKED.equals(code) || at == null) {
                return;
            }
            if (page.leaveFor(at)) {
                redirected.incrementAndGet();
            }
        } catch (CdpException e) {
            log.debug("portal: the page didn't answer: {}", e.kind());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (RuntimeException e) {
            log.error("portal failed: {}", e.getClass().getName());
        } finally {
            slots.release();
            finished.incrementAndGet();
            log.debug("portal: {} sent there of {} looked at", redirected.get(), finished.get());
        }
    }

    /**
     * Since this process started.
     *
     * @param redirected blocked pages replaced by the portal
     * @param direct deskd's own navigations and new tabs sent straight there
     * @param held blocked pages left as they were, as they came right after the portal
     * @param busy blocked pages left as they were, as {@link #MAX_REDIRECTS} were under way
     * @param finished error pages looked at, whatever came of it
     */
    record Counts(long redirected, long direct, long held, long busy, long finished) {}

    Counts counts() {
        return new Counts(redirected.get(), direct.get(), held.get(), busy.get(), finished.get());
    }

    // ---- the setting

    /**
     * Where the portal is on this desk.
     *
     * @param setting {@value #PROPERTY}: unset or blank follows the Env tag, {@value #OFF} is off, and anything else must be
     *     an {@code http} or {@code https} URL that isn't the office's, or it's off
     * @param env the desk's Env tag, or null until IMDS has said: {@code prod} and {@code staging} have a portal, nothing else
     */
    static Supplier<String> portalFor(String setting, Supplier<String> env) {
        String value = setting == null ? "" : setting.strip();
        if (value.isEmpty()) {
            return () -> byEnv(env.get());
        }
        if (value.equalsIgnoreCase(OFF)) {
            log.info("the office's portal is off: the office stays Chromium's blocked page");
            return () -> null;
        }
        String url = usable(value);
        if (url == null) {
            // Not the value: a desk's own setting, but there's nothing in it for the journal.
            log.warn("the office's portal is off: DESKD_PORTAL_URL isn't an http or https URL deskd can send a tab to");
            return () -> null;
        }
        return () -> url;
    }

    static String byEnv(String env) {
        if (env == null) {
            return null;
        }
        return switch (env) {
            case "prod" -> PROD_PORTAL;
            case "staging" -> STAGING_PORTAL;
            default -> null;
        };
    }

    private static String usable(String value) {
        try {
            String url = BrowserUrl.parse(value);
            String host = hostOf(url);
            return host == null || isOfficeHost(host) ? null : url;
        } catch (RpcException e) {
            return null;
        }
    }

    // ---- the match

    /** Whether {@code url} is an {@code http} or {@code https} URL on the office or any name under it. */
    static boolean isOffice(String url) {
        String host = hostOf(url);
        return host != null && isOfficeHost(host);
    }

    static boolean isOfficeHost(String host) {
        for (String office : OFFICE_HOSTS) {
            if (host.equals(office) || host.endsWith("." + office)) {
                return true;
            }
        }
        return false;
    }

    /**
     * The host of an {@code http} or {@code https} URL as a browser reads it: past any userinfo (the last {@code @}), before
     * any port, percent-decoded, through IDNA, lower case, and with one trailing dot dropped.
     *
     * @return null for another scheme, an IPv6 literal, or a host that isn't one
     */
    static String hostOf(String url) {
        if (url == null || url.length() > MAX_URL_CHARS) {
            return null;
        }
        int start;
        if (startsWithAscii(url, "https://")) {
            start = 8;
        } else if (startsWithAscii(url, "http://")) {
            start = 7;
        } else {
            return null;
        }
        int end = start;
        while (end < url.length() && "/?#\\".indexOf(url.charAt(end)) < 0) {
            end++;
        }
        String authority = url.substring(start, end);
        String host = authority.substring(authority.lastIndexOf('@') + 1);
        if (host.startsWith("[")) {
            return null;
        }
        int colon = host.indexOf(':');
        if (colon >= 0) {
            host = host.substring(0, colon);
        }
        host = percentDecoded(host);
        if (host == null) {
            return null;
        }
        try {
            host = IDN.toASCII(host, IDN.USE_STD3_ASCII_RULES);
        } catch (IllegalArgumentException e) {
            return null;
        }
        host = lowerAscii(host);
        if (host.endsWith(".")) {
            host = host.substring(0, host.length() - 1);
        }
        return host.isEmpty() || host.length() > MAX_HOST_CHARS ? null : host;
    }

    /** ASCII only, so nothing like U+017F can pass for an s. */
    private static boolean startsWithAscii(String text, String lowerPrefix) {
        if (text.length() < lowerPrefix.length()) {
            return false;
        }
        for (int i = 0; i < lowerPrefix.length(); i++) {
            char c = text.charAt(i);
            char lower = c >= 'A' && c <= 'Z' ? (char) (c + 32) : c;
            if (lower != lowerPrefix.charAt(i)) {
                return false;
            }
        }
        return true;
    }

    private static String lowerAscii(String text) {
        StringBuilder lower = new StringBuilder(text.length());
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            lower.append(c >= 'A' && c <= 'Z' ? (char) (c + 32) : c);
        }
        return lower.toString();
    }

    /** As the URL standard does to a host first. @return null if an escape is broken or the bytes aren't UTF-8 */
    private static String percentDecoded(String host) {
        if (host.indexOf('%') < 0) {
            return host;
        }
        ByteArrayOutputStream bytes = new ByteArrayOutputStream(host.length());
        int i = 0;
        while (i < host.length()) {
            int c = host.codePointAt(i);
            if (c == '%') {
                if (i + 2 >= host.length() || host.charAt(i + 1) >= 0x80 || host.charAt(i + 2) >= 0x80) {
                    return null;
                }
                int high = Character.digit(host.charAt(i + 1), 16);
                int low = Character.digit(host.charAt(i + 2), 16);
                if (high < 0 || low < 0) {
                    return null;
                }
                bytes.write(high * 16 + low);
                i += 3;
            } else if (Character.isSurrogate(host.charAt(i)) && Character.charCount(c) == 1) {
                // Half a pair can't be a name.
                return null;
            } else {
                byte[] encoded = new String(Character.toChars(c)).getBytes(StandardCharsets.UTF_8);
                bytes.write(encoded, 0, encoded.length);
                i += Character.charCount(c);
            }
        }
        try {
            return StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes.toByteArray()))
                    .toString();
        } catch (CharacterCodingException e) {
            return null;
        }
    }
}
