package com.minimalistalliance.desk.deskd.browser;

import com.minimalistalliance.desk.deskd.events.EventHub;
import com.minimalistalliance.desk.deskd.events.Topic;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import com.minimalistalliance.desk.deskd.rpc.RpcPrincipal;
import java.time.Clock;
import java.time.Duration;
import java.time.temporal.ChronoUnit;
import java.util.ArrayDeque;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.LongSupplier;
import java.util.function.Supplier;

/**
 * Links Chromium hands the desk's OS, passed to the member's own device on the topic {@value #TOPIC} as
 * {@code linkOut} (API.md section 10, "Links out"). They come from the desk's {@code xdg-open} stand-in over
 * {@link LinkSocket}, which is all Chromium does with a {@code mailto:}, {@code tel:} or meeting link it can't open itself.
 *
 * <p><b>What goes.</b> Only a link {@link LinkOut} passes, cleaned, with the text to show for it. Then at most
 * {@code Timing.burst} in any {@code Timing.window}, and never the same URL twice within {@code Timing.repeat}. Chromium
 * itself lets a page launch one external link per input from the member, so these only catch a page that turns every
 * click into one, or a double click. Anything dropped is counted by why, for /health, and nothing of it is kept.
 *
 * <p><b>Who hears it.</b> Owner sessions with video and input, read live, as for the clipboard: the device that's driving
 * the Browser is the one to offer it. It's published only while someone is subscribed, never kept, and logged nowhere.
 */
final class BrowserLinks implements Topic {

    static final String TOPIC = "browser.links";
    static final String EVENT = "linkOut";
    /** Why the link came: Chromium handed it to the OS, as it does a scheme it doesn't handle. The only one today. */
    static final String EXTERNAL_SCHEME = "externalScheme";
    static final String SENT = "ok";
    static final String DROP_REQUEST = "request";
    static final String DROP_PEER = "peer";
    static final String DROP_REPEAT = "repeat";
    static final String DROP_RATE = "rate";
    static final String DROP_NOBODY = "nobody";
    private static final String OWNER = "owner";

    /**
     * @param repeat how long the same URL, once sent, is dropped for
     * @param window and {@code burst}: at most burst links in any window
     */
    record Timing(Duration repeat, Duration window, int burst) {
        static final Timing DEFAULT = new Timing(Duration.ofSeconds(5), Duration.ofSeconds(10), 3);
    }

    private final EventHub hub;
    private final Supplier<String> tabOnScreen;
    private final Clock clock;
    private final LongSupplier nanos;
    private final Timing timing;
    private final ReentrantLock lock = new ReentrantLock();
    /** When each link in the window went, oldest first. */
    private final ArrayDeque<Long> recent = new ArrayDeque<>();
    private String lastUrl;
    private long lastNanos;
    private long sent;
    private final Map<String, Long> dropped = new TreeMap<>();

    /** @param tabOnScreen the member's tab known to be on screen, or null: never a guess, and never a call to Chromium */
    BrowserLinks(EventHub hub, Supplier<String> tabOnScreen, Clock clock, LongSupplier nanos, Timing timing) {
        this.hub = hub;
        this.tabOnScreen = tabOnScreen;
        this.clock = clock;
        this.nanos = nanos;
        this.timing = timing;
    }

    /**
     * One link as the stand-in had it from Chromium. Publishes it, or drops it. Never blocks on Chromium.
     *
     * @return {@value #SENT}, or why it was dropped
     */
    String offer(String raw) {
        LinkOut.Verdict verdict = LinkOut.check(raw);
        if (verdict.drop() != null) {
            return drop(verdict.drop());
        }
        LinkOut.Link link = verdict.link();
        if (!hub.hasSubscribers(TOPIC)) {
            return drop(DROP_NOBODY);
        }
        lock.lock();
        try {
            long now = nanos.getAsLong();
            while (!recent.isEmpty() && now - recent.peekFirst() >= timing.window().toNanos()) {
                recent.removeFirst();
            }
            if (link.url().equals(lastUrl) && now - lastNanos < timing.repeat().toNanos()) {
                return dropLocked(DROP_REPEAT);
            }
            if (recent.size() >= timing.burst()) {
                return dropLocked(DROP_RATE);
            }
            recent.addLast(now);
            lastUrl = link.url();
            lastNanos = now;
            sent++;
        } finally {
            lock.unlock();
        }
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("url", link.url());
        data.put("scheme", link.scheme());
        data.put("displayText", link.displayText());
        data.put("reason", EXTERNAL_SCHEME);
        data.put("at", clock.instant().truncatedTo(ChronoUnit.SECONDS).toString());
        String tabId = tabOnScreen.get();
        if (tabId != null) {
            data.put("tabId", tabId);
        }
        hub.publish(TOPIC, EVENT, data);
        return SENT;
    }

    /** A connection that sent no proper request, or came from someone other than Chromium's user. */
    String refused(String reason) {
        return drop(reason);
    }

    private String drop(String reason) {
        lock.lock();
        try {
            return dropLocked(reason);
        } finally {
            lock.unlock();
        }
    }

    private String dropLocked(String reason) {
        dropped.merge(reason, 1L, Long::sum);
        return reason;
    }

    /** For /health: counts only, a reason with none left out. Never a URL or a scheme. */
    Map<String, Object> health() {
        lock.lock();
        try {
            Map<String, Object> health = new LinkedHashMap<>();
            health.put("sent", sent);
            health.put("dropped", new LinkedHashMap<>(dropped));
            return health;
        } finally {
            lock.unlock();
        }
    }

    /** Every reason a link can be dropped for, as /health and the stand-in's reply name them. */
    static List<String> dropReasons() {
        return List.of(LinkOut.DROP_SCHEME, LinkOut.DROP_URL, DROP_REQUEST, DROP_PEER, DROP_REPEAT, DROP_RATE, DROP_NOBODY);
    }

    // ---- the topic

    @Override
    public boolean coalescible() {
        return true;
    }

    /** Nothing is kept, so since can't be served. */
    @Override
    public boolean publishesWithNoSubscriber() {
        return false;
    }

    /** As the clipboard: the device driving the Browser is the one to offer a link, and a link can hold what's not on screen. */
    @Override
    public void authorize(RpcPrincipal principal, String topicKey, Map<String, Object> params) throws RpcException {
        if (!OWNER.equals(principal.scope()) || !principal.video() || !principal.input()) {
            throw BrowserMethods.forbidden();
        }
    }

    /** No state, so no first event, and nothing to stand in for one that was lost. */
    @Override
    public Object snapshot(String topicKey, Map<String, Object> params) {
        return NO_SNAPSHOT;
    }
}
