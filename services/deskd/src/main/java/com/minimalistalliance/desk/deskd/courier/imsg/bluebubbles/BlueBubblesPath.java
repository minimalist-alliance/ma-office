package com.minimalistalliance.desk.deskd.courier.imsg.bluebubbles;

import com.minimalistalliance.desk.deskd.courier.CourierModule;
import com.minimalistalliance.desk.deskd.courier.imsg.ImsgMessage;
import com.minimalistalliance.desk.deskd.courier.imsg.ImsgPath;
import com.minimalistalliance.desk.deskd.courier.imsg.ImsgSend;
import com.minimalistalliance.desk.deskd.courier.imsg.ImsgSink;
import com.minimalistalliance.desk.deskd.courier.linked.Net;
import com.minimalistalliance.desk.deskd.courier.store.Courier;
import com.minimalistalliance.desk.deskd.courier.vault.LinkedAccounts;
import com.minimalistalliance.desk.deskd.courier.vault.SignIn;
import com.minimalistalliance.desk.deskd.protocol.Json;
import java.io.IOException;
import java.net.ConnectException;
import java.net.NoRouteToHostException;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.sql.SQLException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.ReentrantLock;
import javax.net.ssl.X509TrustManager;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The {@code imsg} seam's BlueBubbles path (the launch plan's Wave 2.6): the member's own BlueBubbles Server on their Mac,
 * reached by the desk over HTTPS at the address they gave (their own domain or port forward, or BlueBubbles' Cloudflare,
 * ngrok or zrok tunnel); the platform is never in the path. The address and the password are sealed in the vault together
 * (plan §3.6), never in a row, an answer or a log.
 * <ul>
 *   <li><b>Catching up:</b> {@code POST message/query} for messages dated after the cursor (less 20 minutes, so an edit or
 *       an unsend of a recent one is seen too), oldest first, a page at a time, each page stored with the new cursor in one
 *       transaction. The first look brings the last 30 days. The Mac keeps everything while the desk sleeps, so a wake
 *       loses nothing.</li>
 *   <li><b>Live:</b> the socket is a doorbell ({@link MacSocket}): any event makes it look now. Without the socket it
 *       looks every minute while the Mac answers, and backs off to 10 minutes while it doesn't.</li>
 *   <li><b>Sending:</b> {@code POST message/text} by AppleScript (no Private API), the reply's guid recorded before the
 *       next page is let in, so its echo isn't a second message; a send whose answer was lost looks on the Mac first.</li>
 *   <li><b>Contacts:</b> the Mac's cards ({@code GET contact}) on connect and every 24 hours, for names and suggestions.</li>
 * </ul>
 */
public final class BlueBubblesPath implements ImsgPath {

    private static final Logger log = LoggerFactory.getLogger(BlueBubblesPath.class);
    public static final String PATH = "bluebubbles";
    static final String CURSOR = "bb:after";

    /** Timings and bounds. */
    /**
     * {@code minGap}: the least time between two looks, however often the socket rings (Security IM-L3); {@code dailyCap}:
     * the most new messages one Mac brings in a day, past which the account says so and waits for the next day.
     */
    public record Settings(Duration pollLive, Duration pollNoSocket, Duration backoffMin, Duration backoffMax, int pageSize, int pagesPerLook,
            Duration firstWindow, Duration overlap, Duration contactsEvery, Duration infoEvery, Duration socketWithin, MacLink.Settings link,
            int socketPort, Duration minGap, int dailyCap) {
        public static final Settings DEFAULT = new Settings(Duration.ofMinutes(5), Duration.ofMinutes(1), Duration.ofSeconds(15),
                Duration.ofMinutes(10), 50, 100, Duration.ofDays(30), Duration.ofMinutes(20), Duration.ofHours(24), Duration.ofHours(1),
                Duration.ofSeconds(30), MacLink.Settings.DEFAULT, 0, Duration.ofSeconds(3), 20_000);

        /**
         * For tests only: quick timings, plain {@code http://} allowed, and the kit's fake, whose socket is on a port of its
         * own ({@code socketPort}; the real server has one port, 0 here).
         */
        public static Settings forTests(int socketPort, int pageSize) {
            return new Settings(Duration.ofSeconds(2), Duration.ofMillis(500), Duration.ofMillis(200), Duration.ofSeconds(2), pageSize, 50,
                    Duration.ofDays(30), Duration.ofMinutes(20), Duration.ofHours(24), Duration.ofHours(1), Duration.ofSeconds(5),
                    new MacLink.Settings(Duration.ofSeconds(5), Duration.ofSeconds(20), 2L * 1024 * 1024, true), socketPort, Duration.ofMillis(100),
                    20_000);
        }

        /** The same with another daily cap: for the cap's own test. */
        public Settings withDailyCap(int cap) {
            return new Settings(pollLive, pollNoSocket, backoffMin, backoffMax, pageSize, pagesPerLook, firstWindow, overlap, contactsEvery,
                    infoEvery, socketWithin, link, socketPort, minGap, cap);
        }
    }

    private final ImsgPath.Context ctx;
    private final Settings settings;
    private final MacLink link;
    private final ReentrantLock mac = new ReentrantLock();
    private final ReentrantLock waitLock = new ReentrantLock();
    private final Condition wake = waitLock.newCondition();
    private final Set<String> hints = new LinkedHashSet<>();
    private volatile boolean poked;
    private volatile boolean stopped;
    private volatile boolean socketUp;
    private Thread loop;
    private Thread socketThread;
    private volatile MacSocket socket;

    // status
    private volatile String state = "connecting";
    private volatile String reason;
    private volatile long checkedAt;
    private volatile long nextTryAt;
    private volatile String mode;
    private volatile String through;
    private volatile boolean pinned;
    private volatile boolean firstDone;
    private volatile long brought;
    private volatile long cards = -1;
    private volatile long contactsAt;
    private volatile long infoAt;

    BlueBubblesPath(ImsgPath.Context ctx, Net net, X509TrustManager trust, Settings settings) {
        this.ctx = ctx;
        this.settings = settings;
        this.link = new MacLink(net, trust, settings.link());
    }

    /** The factory {@link com.minimalistalliance.desk.deskd.courier.imsg.ImsgTransport#register} takes. */
    public static ImsgPath.Factory factory(Net net, Settings settings) {
        return ctx -> new BlueBubblesPath(ctx, net, MacLink.jdkTrust(), settings);
    }

    /** For tests: a trust store of the test's (a self-signed certificate it made). */
    static ImsgPath.Factory factory(Net net, X509TrustManager trust, Settings settings) {
        return ctx -> new BlueBubblesPath(ctx, net, trust, settings);
    }

    // ---- the setup's check (courier.accounts.add, courier.accounts.signin)

    /** The prober {@link com.minimalistalliance.desk.deskd.courier.imsg.ImsgTransport#register} takes. */
    public static com.minimalistalliance.desk.deskd.courier.imsg.ImsgTransport.Prober prober(Net net, Settings settings) {
        return prober(net, MacLink.jdkTrust(), settings);
    }

    static com.minimalistalliance.desk.deskd.courier.imsg.ImsgTransport.Prober prober(Net net, X509TrustManager trust, Settings settings) {
        MacLink link = new MacLink(net, trust, settings.link());
        return (address, password, prior, accept) -> probe(link, address, password, prior, accept);
    }

    /** The bound on the whole check, inside the office's 60 seconds. */
    static final Duration PROBE_DEADLINE = Duration.ofSeconds(45);

    /**
     * Checks a Mac's address and password: {@code GET server/info} over HTTPS, the certificate the JDK trusts or, for the
     * member's own address only, one pinned on first connect (its SHA-256), never a tunnel's. Keeps nothing.
     *
     * <p>"Sign in again" ({@code prior}, the account's sealed settings): for the same address (compared as parsed), a pin
     * there is kept, and if the Mac shows another certificate now (another self-signed one, or a CA's) the check stops at the
     * handshake, before any password is sent, with {@code certificate_changed} and the new fingerprint, unless
     * {@code accept} names exactly that fingerprint, the member's word after the office said what changed (Security IM-M1).
     *
     * @throws LinkedAccounts.Rejected {@code https}, {@code address}, {@code host}, {@code port}, {@code password},
     *     {@code messages} (Messages isn't signed in on that Mac), {@code tls}, {@code certificate_changed},
     *     {@code not_bluebubbles}
     */
    static CourierModule.ImessageTransport.Probe probe(MacLink link, String address, byte[] password, String prior, String accept)
            throws LinkedAccounts.Rejected, IOException, InterruptedException {
        MacAddress a;
        try {
            a = MacAddress.parse(address, link.settings().plainForTests());
        } catch (MacAddress.Bad b) {
            throw new LinkedAccounts.Rejected(b.reason());
        }
        if (!MacAddress.portAllowed(a.port())) {
            throw new LinkedAccounts.Rejected("port");
        }
        String oldPin = null;
        boolean sameMac = false;
        if (prior != null) {
            try {
                Map<String, Object> srv = Json.parseObject(prior.getBytes(StandardCharsets.UTF_8));
                MacAddress was = MacAddress.parse((String) srv.get("url"), link.settings().plainForTests());
                sameMac = was.url().equals(a.url());
                if (sameMac && srv.get("pin") instanceof String p) {
                    oldPin = p;
                }
            } catch (Exception e) {
                // Unreadable settings: checked as a new Mac.
            }
        }
        String pin = oldPin;
        BlueBubbles.Info info;
        try (Net.Deadline d = Net.Deadline.start(PROBE_DEADLINE)) {
            if (oldPin != null) {
                try {
                    info = new BlueBubbles(link, a, oldPin).info(password);
                } catch (MacLink.PinChanged e) {
                    String now = e.fingerprint();
                    if (now == null || accept == null || !accept.equals(now)) {
                        throw new LinkedAccounts.Rejected("certificate_changed", now);
                    }
                    pin = now;
                    info = new BlueBubbles(link, a, pin).info(password);
                }
            } else {
                try {
                    info = new BlueBubbles(link, a, null).info(password);
                } catch (MacLink.Untrusted u) {
                    if (u.fingerprint() == null || !MacAddress.OWN.equals(a.through())) {
                        // A tunnel's certificate is always a public one: anything else is someone in between.
                        throw new LinkedAccounts.Rejected("tls");
                    }
                    if (sameMac && !u.fingerprint().equals(accept)) {
                        // The same Mac was trusted through the JDK: a certificate it doesn't trust now is a change, not a
                        // first use (Security IM-L4).
                        throw new LinkedAccounts.Rejected("certificate_changed", u.fingerprint());
                    }
                    pin = u.fingerprint();
                    info = new BlueBubbles(link, a, pin).info(password);
                }
            }
        } catch (BlueBubbles.Unauthorized e) {
            throw new LinkedAccounts.Rejected("password");
        } catch (Net.Refused r) {
            throw new LinkedAccounts.Rejected(r.reason());
        } catch (MacLink.TlsFailed | MacLink.PinChanged | MacLink.Untrusted e) {
            throw new LinkedAccounts.Rejected("tls");
        } catch (BlueBubbles.Failed | MacLink.Protocol | MacLink.TooLarge e) {
            // Something answered, but not as BlueBubbles does.
            throw new LinkedAccounts.Rejected("not_bluebubbles");
        }
        String imessage = blank(info.detectedImessage());
        String icloud = blank(info.detectedIcloud());
        if (imessage == null && icloud == null) {
            throw new LinkedAccounts.Rejected("messages");
        }
        List<String[]> own = new ArrayList<>();
        for (String h : new String[] {imessage, icloud}) {
            String e = ImsgSink.endpoint(h);
            if (e != null) {
                own.add(new String[] {e.contains("@") ? "apple" : "phone", e});
            }
        }
        Map<String, Object> server = new LinkedHashMap<>();
        server.put("path", PATH);
        server.put("url", a.url());
        server.put("pin", pin);
        String json = new String(Json.bytes(server), StandardCharsets.UTF_8);
        return new CourierModule.ImessageTransport.Probe(json, PATH, own, "iMessage on your Mac");
    }

    private static String blank(String s) {
        return s == null || s.isBlank() ? null : s.strip();
    }

    // ---- the path

    @Override
    public void start() {
        loop = Thread.ofVirtual().name("courier-bb-sync").start(this::run);
        socketThread = Thread.ofVirtual().name("courier-bb-socket").start(this::listen);
    }

    @Override
    public void stop() {
        stopped = true;
        MacSocket s = socket;
        if (s != null) {
            s.close();
        }
        if (loop != null) {
            loop.interrupt();
        }
        if (socketThread != null) {
            socketThread.interrupt();
        }
    }

    @Override
    public void poke() {
        waitLock.lock();
        try {
            poked = true;
            wake.signalAll();
        } finally {
            waitLock.unlock();
        }
    }

    @Override
    public Map<String, Object> status() {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("state", state);
        m.put("reason", reason);
        m.put("path", PATH);
        m.put("mode", mode);
        m.put("through", through);
        m.put("certificate", through == null ? null : pinned ? "pinned" : "trusted");
        m.put("socket", socketUp);
        m.put("checkedAt", checkedAt == 0 ? null : checkedAt);
        m.put("nextTryAt", nextTryAt == 0 ? null : nextTryAt);
        Map<String, Object> first = new LinkedHashMap<>();
        first.put("done", firstDone);
        first.put("messages", brought);
        m.put("firstSync", first);
        m.put("cards", cards < 0 ? null : cards);
        return m;
    }

    /** What the sealed sign-in says: the Mac's address and pin. */
    private record Where(MacAddress address, String pin) {}

    private Where where(SignIn s) throws IOException {
        try {
            Map<String, Object> srv = Json.parseObject(s.server().getBytes(StandardCharsets.UTF_8));
            MacAddress a = MacAddress.parse((String) srv.get("url"), settings.link().plainForTests());
            Object pin = srv.get("pin");
            return new Where(a, pin instanceof String p ? p : null);
        } catch (Exception e) {
            throw new IOException("sealed sign-in unreadable");
        }
    }

    private void set(String s, String r) {
        boolean changed = !s.equals(state) || !java.util.Objects.equals(r, reason);
        state = s;
        reason = r;
        if (changed) {
            ctx.changed();
        }
    }

    private void run() {
        long backoff = settings.backoffMin().toMillis();
        while (!stopped) {
            long waitMs;
            if (!ctx.receiving()) {
                set("off", "switched_off");
                waitMs = 30_000;
            } else {
                try (SignIn s = ctx.signIn()) {
                    Where w = where(s);
                    through = w.address().through();
                    pinned = w.pin() != null;
                    if (!firstDone) {
                        set("syncing", null);
                    }
                    if (capped()) {
                        set("waiting", "daily_cap");
                        waitMs = settings.backoffMax().toMillis();
                    } else {
                        look(w, s.secret());
                        checkedAt = ctx.clock().millis();
                        set(capped() ? "waiting" : "live", capped() ? "daily_cap" : null);
                        backoff = settings.backoffMin().toMillis();
                        waitMs = (socketUp ? settings.pollLive() : settings.pollNoSocket()).toMillis();
                    }
                } catch (InterruptedException e) {
                    return;
                } catch (BlueBubbles.Unauthorized e) {
                    set("needs_you", "password");
                    waitMs = settings.backoffMax().toMillis();
                } catch (MacLink.PinChanged e) {
                    set("needs_you", "certificate");
                    waitMs = settings.backoffMax().toMillis();
                } catch (ImsgSink.Hold e) {
                    set("syncing", "parse");
                    waitMs = 60_000;
                } catch (SQLException e) {
                    log.warn("courier bluebubbles: the store couldn't take a page ({})", e.getClass().getSimpleName());
                    set("syncing", "storage");
                    waitMs = 60_000;
                } catch (IOException e) {
                    if (e.getMessage() != null && e.getMessage().equals("sealed sign-in unreadable") || isSignedOut(e)) {
                        set("needs_you", "signed_out");
                        waitMs = settings.backoffMax().toMillis();
                    } else {
                        set("away", reasonOf(e));
                        waitMs = backoff;
                        backoff = Math.min(settings.backoffMax().toMillis(), backoff * 2);
                    }
                } catch (RuntimeException e) {
                    log.warn("courier bluebubbles: a look failed ({})", e.getClass().getSimpleName());
                    set("away", "error");
                    waitMs = backoff;
                    backoff = Math.min(settings.backoffMax().toMillis(), backoff * 2);
                }
            }
            nextTryAt = ctx.clock().millis() + waitMs;
            if (!pause(waitMs)) {
                return;
            }
            // However often the socket rings, looks are at least minGap apart (Security IM-L3).
            if (!sleep(settings.minGap().toMillis())) {
                return;
            }
        }
    }

    private volatile long capDay = -1;
    private volatile int capCount;

    /** Whether today's new messages reached the daily cap; a new day starts the count again. */
    private boolean capped() {
        long day = Math.floorDiv(ctx.clock().millis(), 86_400_000L);
        if (day != capDay) {
            capDay = day;
            capCount = 0;
        }
        return capCount >= settings.dailyCap();
    }

    private void counted(int stored) {
        capped();
        capCount += stored;
        brought += stored;
    }

    private static boolean isSignedOut(IOException e) {
        return e.getMessage() != null && e.getMessage().equals("no such linked account");
    }

    private static String reasonOf(IOException e) {
        if (e instanceof Net.Refused r) {
            return r.reason();
        }
        if (e instanceof MacLink.TlsFailed || e instanceof MacLink.Untrusted) {
            return "tls";
        }
        if (e instanceof BlueBubbles.Failed f && f.status() == 503) {
            return "asleep";
        }
        return "unreachable";
    }

    /** Waits up to {@code ms}, or until poked; false when stopped or interrupted. */
    private boolean pause(long ms) {
        waitLock.lock();
        try {
            long left = TimeUnit.MILLISECONDS.toNanos(Math.max(1, ms));
            while (!poked && !stopped && left > 0) {
                left = wake.awaitNanos(left);
            }
            poked = false;
            return !stopped;
        } catch (InterruptedException e) {
            return false;
        } finally {
            waitLock.unlock();
        }
    }

    /** One look at the Mac: its info now and then, the messages the socket named, the catch-up, the cards when due. */
    private void look(Where w, byte[] password) throws IOException, SQLException, InterruptedException, ImsgSink.Hold {
        BlueBubbles api = new BlueBubbles(link, w.address(), w.pin());
        long now = ctx.clock().millis();
        if (infoAt == 0 || now - infoAt >= settings.infoEvery().toMillis()) {
            BlueBubbles.Info info = api.info(password);
            mode = info.privateApi() ? "private_api" : "basic";
            infoAt = now;
        }
        List<String> named;
        synchronized (hints) {
            named = new ArrayList<>(hints);
            hints.clear();
        }
        for (String guid : named) {
            mac.lockInterruptibly();
            try {
                Map<String, Object> m = api.message(password, guid);
                ImsgMessage im = m == null ? null : BlueBubblesJson.message(m);
                if (im != null) {
                    counted(ctx.sink().store(ctx.accountId(), List.of(im), n -> null, files(api, password), newAfter()).stored());
                }
            } finally {
                mac.unlock();
            }
        }
        catchUp(api, password);
        if (contactsAt == 0 || now - contactsAt >= settings.contactsEvery().toMillis()) {
            contactsAt = now;
            try {
                List<Map<String, Object>> contacts = api.contacts(password);
                ctx.store().imessage().putCards("mac:" + ctx.accountId(), BlueBubblesJson.cards(contacts));
                cards = ctx.store().imessage().cards("mac:" + ctx.accountId());
            } catch (BlueBubbles.Failed e) {
                // No Contacts access on that Mac (or an older server): names and suggestions wait.
                cards = 0;
            }
        }
    }

    private void catchUp(BlueBubbles api, byte[] password) throws IOException, SQLException, InterruptedException, ImsgSink.Hold {
        String stored = ctx.store().cursor(ctx.accountId(), CURSOR);
        long now = ctx.clock().millis();
        long cursor;
        try {
            cursor = stored == null ? -1 : Long.parseLong(stored);
        } catch (NumberFormatException e) {
            cursor = -1;
        }
        long after = cursor < 0 ? now - settings.firstWindow().toMillis() : Math.max(0, cursor - settings.overlap().toMillis());
        int offset = 0;
        int size = settings.pageSize();
        for (int page = 0; page < settings.pagesPerLook() && !stopped && !capped(); page++) {
            mac.lockInterruptibly();
            int got;
            try {
                BlueBubbles.Page p;
                try {
                    p = api.after(password, after, offset, size);
                } catch (MacLink.TooLarge e) {
                    // A page past the JSON bound (a big group's people on every message): smaller pages, down to one; one
                    // message past it alone is skipped, as it can't be read safely.
                    if (size > 1) {
                        size = Math.max(1, size / 2);
                        page--;
                        continue;
                    }
                    offset++;
                    continue;
                }
                got = p.messages().size();
                List<ImsgMessage> msgs = new ArrayList<>(got);
                for (Map<String, Object> m : p.messages()) {
                    msgs.add(BlueBubblesJson.message(m));
                }
                final long base = cursor;
                // The place after the first n: the newest date among them, never past a minute from now (a Mac's clock or a
                // hostile server can't move it far ahead), never back.
                ImsgSink.Result r = ctx.sink().store(ctx.accountId(), msgs, n -> {
                    long max = base;
                    for (int i = 0; i < n; i++) {
                        ImsgMessage m = msgs.get(i);
                        if (m != null && m.date() <= now + 60_000) {
                            max = Math.max(max, m.date());
                        }
                    }
                    if (max == base && base >= 0) {
                        return null;
                    }
                    return new Courier.CursorUpdate(ctx.accountId(), CURSOR, Long.toString(Math.max(max, base < 0 ? after : max)));
                }, files(api, password), newAfter());
                counted(r.stored());
                for (int i = 0; i < got; i++) {
                    ImsgMessage m = msgs.get(i);
                    if (m != null && m.date() <= now + 60_000) {
                        cursor = Math.max(cursor, m.date());
                    }
                }
                if (cursor < 0) {
                    cursor = after;
                }
            } finally {
                mac.unlock();
            }
            offset += got;
            if (got < size) {
                firstDone = true;
                return;
            }
        }
    }

    /** What's older than a day comes in as backfill: not new to an agent (Security IM-I5). */
    private long newAfter() {
        return ctx.clock().millis() - Duration.ofDays(1).toMillis();
    }

    private ImsgSink.Files files(BlueBubbles api, byte[] password) {
        return (file, max) -> {
            try {
                return api.download(password, file.guid(), max, file.bytes());
            } catch (MacLink.TooLarge e) {
                throw new ImsgSink.TooLarge();
            } catch (BlueBubbles.Failed e) {
                if (e.status() == 404 || e.status() == 400) {
                    // Gone from the Mac (deleted, or never downloaded from iCloud): said in words, as one too large is.
                    throw new ImsgSink.TooLarge();
                }
                throw e;
            }
        };
    }

    // ---- the socket: a doorbell

    private void listen() {
        long backoff = 5_000;
        while (!stopped) {
            if (!ctx.receiving() || "needs_you".equals(state)) {
                if (!sleep(15_000)) {
                    return;
                }
                continue;
            }
            try (SignIn s = ctx.signIn()) {
                Where w = where(s);
                MacAddress at = settings.socketPort() > 0 ? new MacAddress(w.address().host(), settings.socketPort(), w.address().tls()) : w.address();
                MacSocket ms = MacSocket.connect(link, at, w.pin(), s.secret(), settings.socketWithin());
                socket = ms;
                socketUp = true;
                backoff = 5_000;
                poke();
                try {
                    ms.listen((event, data) -> {
                        if ("updated-message".equals(event) && data instanceof Map<?, ?> d && d.get("guid") instanceof String g
                                && ImsgSink.GUID.matcher(g).matches()) {
                            synchronized (hints) {
                                if (hints.size() < 200) {
                                    hints.add(g);
                                }
                            }
                        }
                        poke();
                    });
                } finally {
                    socketUp = false;
                    socket = null;
                    ms.close();
                }
            } catch (IOException e) {
                socketUp = false;
                if (!sleep(backoff)) {
                    return;
                }
                backoff = Math.min(300_000, backoff * 2);
            } catch (RuntimeException e) {
                socketUp = false;
                if (!sleep(backoff)) {
                    return;
                }
                backoff = Math.min(300_000, backoff * 2);
            }
        }
    }

    private boolean sleep(long ms) {
        try {
            Thread.sleep(ms);
            return !stopped;
        } catch (InterruptedException e) {
            return false;
        }
    }

    // ---- sending

    @Override
    public ImsgSend.Result send(ImsgSend send) throws InterruptedException {
        if (!ctx.sending()) {
            return new ImsgSend.Retry("switched_off", false);
        }
        try (SignIn s = ctx.signIn()) {
            Where w = where(s);
            BlueBubbles api = new BlueBubbles(link, w.address(), w.pin());
            mac.lockInterruptibly();
            try {
                if (send.maybeSentBefore()) {
                    String guid = findEcho(api, s.secret(), send);
                    if (guid != null) {
                        ctx.recordSent(guid, send.messageId());
                        return new ImsgSend.Sent(guid);
                    }
                }
                Map<String, Object> m;
                try {
                    m = api.sendText(s.secret(), send.chatGuid(), send.text(), "ma-" + send.outboundId() + "-" + send.attempt());
                } catch (BlueBubbles.Unauthorized e) {
                    set("needs_you", "password");
                    return new ImsgSend.Retry("sign_in", false);
                } catch (BlueBubbles.Failed e) {
                    if (e.status() == 400 && (e.says("chat does not exist") || e.says("chat not found") || e.says("does not exist"))) {
                        return new ImsgSend.Failed("chat");
                    }
                    if (e.status() == 400) {
                        return new ImsgSend.Failed("refused");
                    }
                    return new ImsgSend.Retry(e.status() == 503 ? "asleep" : "mac", false);
                } catch (Net.Refused | MacLink.TlsFailed | MacLink.Untrusted | MacLink.PinChanged | ConnectException
                        | NoRouteToHostException | UnknownHostException e) {
                    return new ImsgSend.Retry("unreachable", false);
                } catch (IOException e) {
                    // The request may have reached the Mac: the next try looks there first.
                    return new ImsgSend.Retry("unreachable", true);
                }
                String guid = m.get("guid") instanceof String g && ImsgSink.GUID.matcher(g).matches() ? g : null;
                if (guid != null) {
                    ctx.recordSent(guid, send.messageId());
                }
                return new ImsgSend.Sent(guid);
            } finally {
                mac.unlock();
            }
        } catch (SQLException e) {
            return new ImsgSend.Retry("storage", true);
        } catch (IOException e) {
            return new ImsgSend.Retry("signed_out", false);
        }
    }

    /**
     * After a try whose answer was lost: the member's own message in that chat, with that text, from the last 30 minutes,
     * that isn't one Courier already knows; its guid, or null.
     */
    private String findEcho(BlueBubbles api, byte[] password, ImsgSend send) throws IOException, SQLException {
        long since = ctx.clock().millis() - Duration.ofMinutes(30).toMillis();
        BlueBubbles.Page p = api.after(password, since, 0, settings.pageSize());
        for (Map<String, Object> raw : p.messages()) {
            ImsgMessage m = BlueBubblesJson.message(raw);
            if (m != null && m.fromMe() && m.chat() != null && send.chatGuid().equalsIgnoreCase(m.chat().guid())
                    && send.text().strip().equals(m.text() == null ? null : m.text().strip())
                    && !ctx.store().imessage().sentByCourier(ctx.accountId(), m.guid())) {
                return m.guid();
            }
        }
        return null;
    }
}
