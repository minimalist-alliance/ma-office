package com.minimalistalliance.desk.deskd.courier.linked;

import com.minimalistalliance.desk.deskd.courier.store.Courier;
import com.minimalistalliance.desk.deskd.courier.store.CourierStore;
import com.minimalistalliance.desk.deskd.courier.store.ExternalIds;
import com.minimalistalliance.desk.deskd.courier.store.LinkedState;
import com.minimalistalliance.desk.deskd.courier.store.Norm;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.sql.SQLException;
import java.time.Clock;
import java.time.Duration;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.Condition;
import java.util.concurrent.locks.ReentrantLock;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * One linked mailbox's IMAP sync (the launch plan §2.2, Wave 2.1), on a virtual thread of its own, over one connection:
 * <ul>
 * <li><b>Folders</b> from LIST, by SPECIAL-USE or their names; on Gmail only All Mail (every label, as X-GM-LABELS), Sent,
 *     Spam and Trash. Drafts and views of other folders are never synced.</li>
 * <li><b>The first sync, newest first and paced:</b> each folder from its newest UID down, the last 12 months of every
 *     folder before anything older, Sent first so the people the member writes to are known before their mail arrives. It
 *     works in slices, so new mail and the member's changes go between them, and it keeps under the provider's daily
 *     download (Gmail's) and a bandwidth cap; a provider that says it's throttling gets backed off.</li>
 * <li><b>Live:</b> IDLE on INBOX (Gmail: All Mail) in windows of 5 minutes, and every 5 minutes STATUS on the others, so
 *     only a folder that changed is opened. With QRESYNC a folder's SELECT says what vanished and changed since; with
 *     CONDSTORE flags come by CHANGEDSINCE; with neither, flags are compared every 30 minutes and expunges by the UID list.</li>
 * <li><b>UIDVALIDITY:</b> a folder renumbered voids its places; each message is matched again by its Gmail id or its
 *     Message-ID, size and date, so nothing is fetched or stored twice.</li>
 * <li><b>Both ways:</b> the member's read, Trash, Spam, restore and delete ({@link LinkedState} ops) go to the provider as
 *     STORE and MOVE (COPY, \Deleted and UID EXPUNGE without MOVE); the provider's flags, moves and deletes come back.</li>
 * <li><b>Sleep and wake:</b> nothing here is in memory that matters; a new deskd reads where every folder was and catches
 *     up from there, mail that arrived meanwhile marked {@code catchup}.</li>
 * </ul>
 * Every message goes to the sink as its raw bytes; the sandbox parses it there. Nothing logged names an address, a folder
 * or a subject.
 */
final class MailboxSync {

    private static final Logger log = LoggerFactory.getLogger(MailboxSync.class);

    /** The engine's timings and sizes. {@link #DEFAULT} is a desk's. */
    record Settings(Duration idleWindow, Duration pollEvery, Duration flagScanEvery, Duration slice, int chunk, long batchBytes,
            long bytesPerSecond, Duration recent, Duration newWindow, Duration listEvery, ImapClient.Settings imap) {
        static final Settings DEFAULT = new Settings(Duration.ofMinutes(5), Duration.ofMinutes(5), Duration.ofMinutes(30),
                Duration.ofSeconds(30), 50, 4L * 1024 * 1024, 2L * 1024 * 1024, Duration.ofDays(365), Duration.ofHours(24),
                Duration.ofMinutes(30), ImapClient.Settings.DEFAULT);
    }

    /** What the office shows for the account ({@code courier.accounts.list}'s {@code sync}). */
    record Status(String state, String reason, long checkedAt, long nextTryAt, boolean firstSyncDone, long messages, Long oldestAt,
            long opsOwed) {}

    /** The sign-in or the account refused: wait for the member. */
    static final class NeedsYou extends IOException {
        private static final long serialVersionUID = 1L;
        final String reason;

        NeedsYou(String reason) {
            super(reason, null);
            this.reason = reason;
        }
    }

    /** The provider asked us to slow down. */
    static final class Throttled extends IOException {
        private static final long serialVersionUID = 1L;
        final Duration wait;
        final String reason;

        Throttled(Duration wait) {
            this(wait, "throttled");
        }

        Throttled(Duration wait, String reason) {
            super(reason, null);
            this.wait = wait;
            this.reason = reason;
        }
    }

    interface Context {
        CourierStore store();

        /** The account's sign-in, closed by the caller. */
        com.minimalistalliance.desk.deskd.courier.vault.SignIn signIn(String accountId) throws IOException;

        Net net();

        Clock clock();

        /** Whether this transport may run now (Courier on, {@code imap-off} and {@code email-off} not said). */
        boolean on();

        FetchBudget budget();

        /** Told when the sync's state changes, for {@code courier.changed}'s accounts flag. */
        void changed(String accountId);
    }

    private final String accountId;
    private final Context ctx;
    private final Settings settings;
    private final LinkedState linked;
    private final ReentrantLock lock = new ReentrantLock();
    private final Condition poked = lock.newCondition();
    private volatile boolean pokedFlag;
    private volatile boolean stopped;
    private volatile ImapClient client;
    private Thread thread;

    private volatile String state = "connecting";
    private volatile String reason;
    private volatile long checkedAt;
    private volatile long nextTryAt;

    // per session
    /** Which named provider the sealed servers are (from its IMAP host at each sign-in), or Other: set before the login. */
    private volatile Providers.Provider provider = Providers.OTHER;
    private boolean gmail;
    private boolean qresync;
    private final Map<Long, Long> lastMessages = new HashMap<>();
    private final Map<Long, Long> lastFlagScan = new HashMap<>();
    /**
     * Folders whose changes came back as more than one answer may hold ({@link ImapClient}'s bounds, Security's CI-M1): the
     * next look at each is a plain select and a windowed flag scan, which no number of changes can outgrow. Kept across
     * reconnects, as the connection goes with the refusal.
     */
    private final java.util.Set<Long> slowOnce = java.util.concurrent.ConcurrentHashMap.newKeySet();
    /** New mail is asked for this many messages at a time, so one answer never holds more than a command may keep. */
    static final long WINDOW = 20_000;
    private long lastList;
    private long passStartedAt;
    private boolean caughtUp;
    /** The folder being backfilled now: its server UIDs below its low mark, ascending. */
    private long backfillFolder = -1;
    private long[] backfillPending;
    private Pacer pacer;

    MailboxSync(String accountId, Context ctx, Settings settings) {
        this.accountId = accountId;
        this.ctx = ctx;
        this.settings = settings;
        this.linked = ctx.store().linked();
    }

    String accountId() {
        return accountId;
    }

    void start() {
        lock.lock();
        try {
            if (thread == null && !stopped) {
                thread = Thread.ofVirtual().name("courier-imap-" + accountId).start(this::run);
            }
        } finally {
            lock.unlock();
        }
    }

    /** Something to do now: the member's change, a new sign-in, the switch. Ends an IDLE. */
    void poke() {
        lock.lock();
        try {
            pokedFlag = true;
            poked.signalAll();
        } finally {
            lock.unlock();
        }
        ImapClient c = client;
        if (c != null) {
            c.wake();
        }
    }

    /** Stops and waits a moment for the thread; the connection is closed under it. */
    void stop() {
        stopped = true;
        poke();
        ImapClient c = client;
        if (c != null) {
            c.close();
        }
        Thread t;
        lock.lock();
        try {
            t = thread;
        } finally {
            lock.unlock();
        }
        if (t != null) {
            t.interrupt();
            try {
                t.join(5_000);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
    }

    /** The provider's id for the office's "Sign in again" (its tile), as of the last sign-in tried. */
    String providerId() {
        return provider.id();
    }

    Status status() {
        try {
            LinkedState.Progress p = linked.progress(accountId);
            return new Status(state, reason, checkedAt, nextTryAt, p.backfilled(), p.messages(), p.oldestAt(), p.opsOwed());
        } catch (SQLException e) {
            return new Status(state, reason, checkedAt, nextTryAt, false, 0, null, 0);
        }
    }

    private void state(String s, String r) {
        boolean changed = !s.equals(state) || !java.util.Objects.equals(r, reason);
        state = s;
        reason = r;
        if (changed) {
            ctx.changed(accountId);
        }
    }

    // ---- the loop

    private void run() {
        long backoff = 0;
        while (!stopped) {
            if (!ctx.on()) {
                state("off", "switched_off");
                await(60_000);
                continue;
            }
            try {
                session();
                backoff = 0;
            } catch (NeedsYou e) {
                state("needs_you", e.reason);
                log.info("courier imap {}: the provider refused the sign-in ({})", accountId, e.reason);
                // A revoked password doesn't come back by itself: wait for "Sign in again", and look again every 6 hours.
                nextTryAt = now() + Duration.ofHours(6).toMillis();
                await(Duration.ofHours(6).toMillis());
            } catch (Throttled e) {
                long wait = "daily_limit".equals(e.reason) ? e.wait.toMillis()
                        : Math.max(e.wait.toMillis(), Math.min(Duration.ofHours(1).toMillis(), backoff == 0 ? 60_000 : backoff * 2));
                backoff = "daily_limit".equals(e.reason) ? 0 : wait;
                state("waiting", e.reason);
                nextTryAt = now() + wait;
                await(wait);
            } catch (InterruptedException e) {
                return;
            } catch (Net.Refused e) {
                state("needs_you", e.reason());
                nextTryAt = now() + Duration.ofHours(6).toMillis();
                await(Duration.ofHours(6).toMillis());
            } catch (Net.TlsFailed e) {
                backoff = next(backoff);
                state("waiting", "tls");
                nextTryAt = now() + backoff;
                await(backoff);
            } catch (IOException | SQLException | RuntimeException e) {
                if (stopped) {
                    return;
                }
                backoff = next(backoff);
                state("waiting", e instanceof SQLException ? "storage" : "unreachable");
                log.info("courier imap {}: connection ended ({}), again in {} s", accountId, e.getClass().getSimpleName(), backoff / 1000);
                nextTryAt = now() + backoff;
                await(backoff);
            } finally {
                ImapClient c = client;
                client = null;
                if (c != null) {
                    c.close();
                }
            }
        }
    }

    /** 2 s doubling to 5 minutes, each with up to a fifth more at random. */
    private static long next(long backoff) {
        long base = backoff == 0 ? 2_000 : Math.min(300_000, backoff * 2);
        return base + ThreadLocalRandom.current().nextLong(base / 5 + 1);
    }

    /** Waits for a poke, the time, or a stop. */
    private void await(long millis) {
        lock.lock();
        try {
            long left = TimeUnit.MILLISECONDS.toNanos(millis);
            while (!pokedFlag && !stopped && left > 0) {
                left = poked.awaitNanos(left);
            }
            pokedFlag = false;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            stopped = true;
        } finally {
            lock.unlock();
        }
    }

    private long now() {
        return ctx.clock().millis();
    }

    private void session() throws IOException, SQLException, InterruptedException {
        state("connecting", null);
        nextTryAt = 0;
        ImapClient c;
        try (var signIn = ctx.signIn(accountId)) {
            Server s = Server.of(signIn.server());
            provider = Providers.byHost(s.imapHost());
            c = ImapClient.open(ctx.net(), s.imapHost(), s.imapPort(), settings.imap());
            client = c;
            login(c, signIn.username(), signIn.secret());
        }
        if (stopped) {
            return;
        }
        qresync = c.enable("QRESYNC").contains("QRESYNC");
        gmail = c.has("X-GM-EXT-1");
        pacer = new Pacer(ctx.store(), accountId, provider.dailyBytes(), settings.bytesPerSecond(), ctx.clock());
        lastMessages.clear();
        lastFlagScan.clear();
        backfillFolder = -1;
        backfillPending = null;
        caughtUp = false;
        lastList = 0;
        state("syncing", null);
        checkedAt = now();
        while (!stopped && ctx.on()) {
            passStartedAt = now();
            if (now() - lastList >= settings.listEvery().toMillis()) {
                discover(c);
                lastList = now();
            }
            applyOps(c);
            List<LinkedState.Folder> folders = order(linked.folders(accountId));
            for (LinkedState.Folder f : folders) {
                if (stopped) {
                    return;
                }
                syncIfChanged(c, f);
                applyOps(c);
            }
            caughtUp = true;
            checkedAt = now();
            folders = order(linked.folders(accountId));
            boolean backfilling = folders.stream().anyMatch(f -> !f.backfilled());
            if (!backfilling && linked.orphans(accountId) > 0) {
                linked.settle(accountId, passStartedAt);
            }
            if (backfilling) {
                state("syncing", null);
                backfill(c, folders);
                continue;
            }
            state("live", null);
            LinkedState.Folder home = home(folders);
            if (home == null) {
                await(settings.pollEvery().toMillis());
                continue;
            }
            idle(c, home);
        }
    }

    private void login(ImapClient c, String user, byte[] secret) throws IOException {
        try {
            c.login(user, secret);
        } catch (ImapException.Refused e) {
            boolean alert = c.alerted();
            if ("THROTTLED".equals(e.code) || e.says("throttl", "too many", "try again later", "bandwidth")) {
                throw new Throttled(Duration.ofMinutes(5));
            }
            if (alert && e.says("application-specific", "app password", "apppassword")) {
                throw new NeedsYou("app_password");
            }
            if (e.says("web login", "webloginrequired", "please log in via your web browser")) {
                throw new NeedsYou("web_login");
            }
            if (e.says("not enabled for imap", "imap access", "imap is disabled")) {
                throw new NeedsYou("imap_off");
            }
            if ("AUTH_MECHANISM".equals(e.code)) {
                throw new NeedsYou("auth_mechanism");
            }
            throw new NeedsYou("auth");
        }
    }

    // ---- folders

    /** LIST: new folders added with their numbering, gone ones removed (their messages become orphans), roles updated. */
    private void discover(ImapClient c) throws IOException, SQLException {
        List<ImapClient.Listed> listed = c.list();
        Map<String, ImapClient.Listed> wanted = new LinkedHashMap<>();
        for (ImapClient.Listed l : listed) {
            if (!Providers.skipped(l, gmail)) {
                wanted.put(l.name(), l);
            }
        }
        labels.clear();
        for (ImapClient.Listed l : wanted.values()) {
            labels.put(l.name(), LinkedState.OTHER.equals(Providers.role(l)) ? Providers.label(l) : null);
        }
        Map<String, LinkedState.Folder> have = new HashMap<>();
        for (LinkedState.Folder f : linked.folders(accountId)) {
            have.put(f.name(), f);
        }
        for (LinkedState.Folder f : have.values()) {
            if (!wanted.containsKey(f.name())) {
                linked.removeFolder(f);
            } else {
                String role = Providers.role(wanted.get(f.name()));
                if (!role.equals(f.role())) {
                    linked.putFolder(f.withRole(role));
                }
            }
        }
        for (ImapClient.Listed l : wanted.values()) {
            if (have.containsKey(l.name())) {
                continue;
            }
            Map<String, Long> st = c.status(l.name(), "UIDVALIDITY UIDNEXT MESSAGES");
            Long validity = st.get("UIDVALIDITY");
            Long next = st.get("UIDNEXT");
            if (validity == null || next == null) {
                continue;
            }
            linked.addFolder(accountId, l.name(), Providers.role(l), validity, next);
        }
    }

    /** User folders' names as labels, by folder name; null for INBOX, Archive and the special ones. */
    private final Map<String, String> labels = new HashMap<>();

    /** Sent first (who the member writes to is known), then INBOX or All Mail, archives and others, then Junk and Trash. */
    private static List<LinkedState.Folder> order(List<LinkedState.Folder> folders) {
        List<LinkedState.Folder> out = new ArrayList<>(folders);
        out.sort(Comparator.comparingInt((LinkedState.Folder f) -> switch (f.role()) {
            case LinkedState.SENT -> 0;
            case LinkedState.INBOX, LinkedState.ALL -> 1;
            case LinkedState.ARCHIVE -> 2;
            case LinkedState.OTHER -> 3;
            case LinkedState.JUNK -> 4;
            case LinkedState.TRASH -> 5;
            default -> 6;
        }).thenComparingLong(LinkedState.Folder::id));
        return out;
    }

    private LinkedState.Folder home(List<LinkedState.Folder> folders) {
        for (LinkedState.Folder f : folders) {
            if (gmail ? LinkedState.ALL.equals(f.role()) : LinkedState.INBOX.equals(f.role())) {
                return f;
            }
        }
        return folders.isEmpty() ? null : folders.get(0);
    }

    /** STATUS first, so only a folder that changed is opened; every folder is opened once each session. */
    private void syncIfChanged(ImapClient c, LinkedState.Folder f) throws IOException, SQLException, InterruptedException {
        Long last = lastMessages.get(f.id());
        boolean scanDue = !qresync && now() - lastFlagScan.getOrDefault(f.id(), 0L) >= settings.flagScanEvery().toMillis();
        if (last != null && !scanDue) {
            String items = c.has("CONDSTORE") ? "UIDVALIDITY UIDNEXT MESSAGES HIGHESTMODSEQ" : "UIDVALIDITY UIDNEXT MESSAGES";
            Map<String, Long> st = c.status(f.name(), items);
            boolean same = st.getOrDefault("UIDVALIDITY", -1L) == f.uidValidity() && st.getOrDefault("UIDNEXT", -1L) == f.uidNext()
                    && st.getOrDefault("MESSAGES", -1L).equals(last)
                    && (!st.containsKey("HIGHESTMODSEQ") || st.get("HIGHESTMODSEQ") == f.modseq());
            if (same) {
                return;
            }
        }
        syncFolder(c, f, scanDue);
    }

    /**
     * Opens a folder and brings the desk level with it: a renumbering, what vanished, flags and labels that changed, then
     * new mail above what the desk has.
     */
    private LinkedState.Folder syncFolder(ImapClient c, LinkedState.Folder f, boolean flagScan) throws IOException, SQLException,
            InterruptedException {
        boolean slow = slowOnce.remove(f.id());
        boolean useQresync = qresync && f.modseq() > 0 && !slow;
        ImapClient.Selected sel;
        try {
            sel = c.select(f.name(), useQresync ? f.uidValidity() : 0, useQresync ? f.modseq() : 0, null);
        } catch (ImapException.TooLarge e) {
            if (useQresync) {
                slowOnce.add(f.id());
            }
            throw e;
        }
        if (sel.uidValidity() <= 0) {
            throw new ImapException.Protocol("uidvalidity");
        }
        if (sel.uidValidity() != f.uidValidity()) {
            log.info("courier imap {}: a folder was renumbered (UIDVALIDITY); its messages are matched again", accountId);
            f = linked.resetFolder(f, sel.uidValidity(), Math.max(1, sel.uidNext()));
            if (backfillFolder == f.id()) {
                backfillPending = null;
            }
            lastMessages.put(f.id(), sel.exists());
            return f;
        }
        long modseq = sel.highestModseq();
        // What vanished and changed since the desk last looked.
        if (useQresync) {
            if (sel.vanishedEarlier().length > 0) {
                f = vanish(f, sel.vanishedEarlier());
            }
            if (!sel.changed().isEmpty()) {
                if (gmail) {
                    // QRESYNC's own FETCHes carry flags only; Gmail's labels come asked for.
                    List<ImapClient.FetchData> withLabels = new ArrayList<>();
                    c.fetch(UidSet.of(sel.changed().stream().mapToLong(ImapClient.FetchData::uid).toArray()), flagItems(), null,
                            16L * 1024 * 1024, withLabels::add);
                    f = changes(f, withLabels);
                } else {
                    f = changes(f, sel.changed());
                }
            }
        } else if (!slow && modseq > 0 && f.modseq() > 0 && modseq != f.modseq() && f.topUid() > 0) {
            List<ImapClient.FetchData> changed = new ArrayList<>();
            try {
                c.fetch(UidSet.range(1, f.topUid()), flagItems(), "CHANGEDSINCE " + f.modseq(), 64L * 1024 * 1024, changed::add);
            } catch (ImapException.TooLarge e) {
                slowOnce.add(f.id());
                throw e;
            }
            f = changes(f, changed);
        } else if ((slow || modseq == 0 && flagScan) && f.topUid() > 0) {
            f = flagScan(c, f);
        }
        // New mail above what the desk has.
        long next = sel.uidNext();
        if (next == 0 || next > f.topUid() + 1) {
            f = fetchNew(c, f, next);
        }
        // Expunges a server without QRESYNC told only as a count: the UID list settles it.
        if (!useQresync) {
            long expected = linked.count(f.id()) + (f.backfilled() ? 0 : below(c, f));
            if (c.box.exists >= 0 && expected != c.box.exists || c.box.expunges > 0) {
                f = reconcile(c, f);
            }
        } else if (!c.box.vanished.isEmpty()) {
            long[] v = c.box.vanished.toArray();
            c.box.vanished.clear();
            f = vanish(f, v);
        }
        f = f.withSelected(Math.max(next, f.topUid() + 1), modseq > 0 ? Math.max(modseq, f.modseq()) : 0).synced(now());
        linked.putFolder(f);
        lastMessages.put(f.id(), Math.max(0, c.box.exists));
        if (flagScan || !qresync) {
            lastFlagScan.put(f.id(), now());
        }
        return f;
    }

    private String flagItems() {
        return "UID FLAGS" + (gmail ? " X-GM-LABELS" : "");
    }

    private LinkedState.Folder vanish(LinkedState.Folder f, long[] uids) throws SQLException {
        // Only what the desk had; the rest it never fetched.
        LinkedState.Folder after = f;
        linked.vanished(after, uids);
        if (backfillFolder == f.id() && backfillPending != null) {
            long[] gone = uids.clone();
            Arrays.sort(gone);
            backfillPending = Arrays.stream(backfillPending).filter(u -> Arrays.binarySearch(gone, u) < 0).toArray();
        }
        return after;
    }

    private LinkedState.Folder changes(LinkedState.Folder f, List<ImapClient.FetchData> list) throws SQLException {
        List<LinkedState.Change> out = new ArrayList<>();
        for (ImapClient.FetchData d : list) {
            if (d.flags() == null && d.gmLabels() == null) {
                continue;
            }
            out.add(new LinkedState.Change(d.uid(), d.seen(), gmail ? Providers.gmailLabels(d.gmLabels()) : null));
        }
        if (!out.isEmpty()) {
            linked.changed(f, out);
        }
        return f;
    }

    /** No CONDSTORE: every UID's flags, compared with the desk's, a few thousand at a time. */
    private LinkedState.Folder flagScan(ImapClient c, LinkedState.Folder f) throws IOException, SQLException {
        long from = f.backfilled() ? 1 : f.lowUid();
        for (long lo = from; lo <= f.topUid(); lo += 5000) {
            long hi = Math.min(f.topUid(), lo + 4999);
            List<ImapClient.FetchData> got = new ArrayList<>();
            c.fetch(UidSet.range(lo, hi), flagItems(), null, 16L * 1024 * 1024, got::add);
            long[] uids = got.stream().mapToLong(ImapClient.FetchData::uid).toArray();
            Map<Long, LinkedState.Place> places = linked.places(f.id(), uids);
            List<ImapClient.FetchData> differ = new ArrayList<>();
            for (ImapClient.FetchData d : got) {
                LinkedState.Place p = places.get(d.uid());
                if (p != null && d.flags() != null && (p.seen() != d.seen()
                        || gmail && !java.util.Objects.equals(p.labels(), Providers.gmailLabels(d.gmLabels())))) {
                    differ.add(d);
                }
            }
            changes(f, differ);
        }
        return f;
    }

    /** How many of the server's UIDs are below the folder's low mark, while its first sync goes on. */
    private long below(ImapClient c, LinkedState.Folder f) throws IOException {
        if (backfillFolder == f.id() && backfillPending != null) {
            return backfillPending.length;
        }
        if (f.lowUid() <= 1) {
            return 0;
        }
        return c.search("UID 1:" + (f.lowUid() - 1)).length;
    }

    /** The UID list against the desk's places within the range the desk covers: what's gone goes. */
    private LinkedState.Folder reconcile(ImapClient c, LinkedState.Folder f) throws IOException, SQLException {
        c.box.expunges = 0;
        long from = f.backfilled() ? 1 : f.lowUid();
        if (f.topUid() < from) {
            return f;
        }
        long[] server = c.search("UID " + UidSet.range(from, f.topUid()));
        long[] ours = linked.uids(f.id(), from, f.topUid());
        List<Long> gone = new ArrayList<>();
        for (long u : ours) {
            if (Arrays.binarySearch(server, u) < 0) {
                gone.add(u);
            }
        }
        if (!gone.isEmpty()) {
            f = vanish(f, gone.stream().mapToLong(Long::longValue).toArray());
        }
        if (backfillFolder == f.id()) {
            // The list below the low mark may have changed too.
            backfillPending = null;
        }
        return f;
    }

    // ---- bringing messages in

    /**
     * Mail above the folder's top: fetched and stored in batches, the top moving with each commit. One FETCH of everything
     * above the top when UIDNEXT says that's at most {@link #WINDOW} UIDs; otherwise the UIDs that are there are asked for
     * once (counted against the command's UIDs) and fetched {@link #WINDOW} at a time, so a UIDNEXT far past them costs
     * nothing more (Security's CI-I6), and no one answer holds more than a command may keep (CI-M1b).
     */
    private LinkedState.Folder fetchNew(ImapClient c, final LinkedState.Folder f, long next) throws IOException, SQLException,
            InterruptedException {
        Courier.Origin origin = caughtUp ? Courier.Origin.LIVE : Courier.Origin.CATCHUP;
        final long lo = f.topUid() + 1;
        List<String> sets = new ArrayList<>();
        if (next > 0 && next - lo <= WINDOW) {
            sets.add(UidSet.range(lo, 0));
        } else {
            long[] there = Arrays.stream(c.search("UID " + UidSet.range(lo, 0))).filter(u -> u >= lo).toArray();
            for (int i = 0; i < there.length; i += (int) WINDOW) {
                sets.add(UidSet.of(Arrays.copyOfRange(there, i, (int) Math.min(there.length, i + WINDOW))));
            }
        }
        LinkedState.Folder cur = f;
        for (String set : sets) {
            if (stopped) {
                break;
            }
            final long floor = cur.topUid();
            List<ImapClient.FetchData> meta = new ArrayList<>();
            c.fetch(set, metaItems(), null, 64L * 1024 * 1024, meta::add);
            // "n:*" past the highest UID names the highest one: only what's above the top is new.
            meta.removeIf(m -> m.uid() < lo || m.uid() <= floor);
            meta.sort(Comparator.comparingLong(ImapClient.FetchData::uid));
            for (int i = 0; i < meta.size(); i += settings.chunk()) {
                List<ImapClient.FetchData> part = meta.subList(i, Math.min(meta.size(), i + settings.chunk()));
                long top = part.get(part.size() - 1).uid();
                cur = store(c, cur, part, origin, false, cur.withTop(top));
            }
        }
        return cur;
    }

    private String metaItems() {
        return "UID FLAGS RFC822.SIZE INTERNALDATE BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)]" + (gmail ? " X-GM-MSGID X-GM-LABELS" : "");
    }

    /**
     * The first sync, for one slice of time: the folder with the newest work left (the recent pass of every folder before
     * the older one), from its low mark down, a chunk at a time.
     */
    private void backfill(ImapClient c, List<LinkedState.Folder> folders) throws IOException, SQLException, InterruptedException {
        long until = now() + settings.slice().toMillis();
        LinkedState.Folder f = pick(c, folders);
        if (f == null) {
            return;
        }
        ImapClient.Selected sel = c.select(f.name(), 0, 0, null);
        if (sel.uidValidity() != f.uidValidity()) {
            // Renumbered since: the next pass's sync starts it over.
            lastMessages.remove(f.id());
            return;
        }
        if (backfillFolder != f.id() || backfillPending == null) {
            backfillFolder = f.id();
            backfillPending = f.lowUid() <= 1 ? new long[0] : c.search("UID 1:" + (f.lowUid() - 1));
        }
        while (!stopped && now() < until) {
            if (backfillPending.length == 0) {
                f = f.withLow(f.lowUid(), true, null);
                linked.putFolder(f);
                backfillPending = null;
                backfillFolder = -1;
                return;
            }
            long floor = recentPhase(order(linked.folders(accountId))) && f.recentUid() != null ? f.recentUid() : 0;
            int end = backfillPending.length;
            if (backfillPending[end - 1] < floor) {
                // This folder's recent mail is in (its first recent UID may be gone): another folder's comes next.
                linked.putFolder(f.withRecent(f.lowUid()));
                return;
            }
            int start = Math.max(0, end - settings.chunk());
            while (start < end - 1 && backfillPending[start] < floor) {
                start++;
            }
            long[] chunk = Arrays.copyOfRange(backfillPending, start, end);
            List<ImapClient.FetchData> meta = new ArrayList<>();
            c.fetch(UidSet.of(chunk), metaItems(), null, 16L * 1024 * 1024, meta::add);
            boolean last = start == 0;
            Long oldest = meta.stream().map(ImapClient.FetchData::internalDate).filter(java.util.Objects::nonNull).min(Long::compare).orElse(null);
            LinkedState.Folder after = f.withLow(chunk[0], last, oldest);
            f = store(c, f, meta, null, true, after);
            backfillPending = Arrays.copyOf(backfillPending, start);
            if (last) {
                backfillPending = null;
                backfillFolder = -1;
                return;
            }
            // New mail and the member's changes don't wait for the whole slice.
            if (pokedFlag || c.box.changed) {
                return;
            }
        }
    }

    /** Whether any folder still has mail of the last 12 months to bring in. */
    private boolean recentPhase(List<LinkedState.Folder> folders) {
        for (LinkedState.Folder f : folders) {
            if (!f.backfilled() && (f.recentUid() == null || f.lowUid() > f.recentUid())) {
                return true;
            }
        }
        return false;
    }

    /** The folder whose first sync goes next: in the recent pass, the first in order with recent mail left; then any. */
    private LinkedState.Folder pick(ImapClient c, List<LinkedState.Folder> folders) throws IOException, SQLException {
        for (LinkedState.Folder f : folders) {
            if (!f.backfilled() && f.recentUid() == null) {
                // Where its last 12 months begin, asked once.
                long[] recent = new long[0];
                if (f.lowUid() > 1) {
                    c.select(f.name(), 0, 0, null);
                    LocalDate since = java.time.Instant.ofEpochMilli(now()).minus(settings.recent()).atZone(ZoneOffset.UTC).toLocalDate();
                    recent = c.search("UID 1:" + (f.lowUid() - 1) + " " + ImapClient.since(since));
                }
                LinkedState.Folder g = f.withRecent(recent.length == 0 ? f.lowUid() : recent[0]);
                linked.putFolder(g);
            }
        }
        List<LinkedState.Folder> now = order(linked.folders(accountId));
        boolean recent = recentPhase(now);
        for (LinkedState.Folder f : now) {
            if (f.backfilled()) {
                continue;
            }
            if (!recent || f.recentUid() == null || f.lowUid() > f.recentUid()) {
                return f;
            }
        }
        return null;
    }

    /**
     * Stores what {@code meta} names: each UID matched to a message the desk has (no fetch), skipped (a Gmail draft), or
     * fetched whole within the byte budget and handed to the sink; then the places and the folder's new state commit with
     * them. {@code origin} null: backfill (mail of the last day "catchup", so it counts as new to agents).
     */
    private LinkedState.Folder store(ImapClient c, LinkedState.Folder f, List<ImapClient.FetchData> meta, Courier.Origin origin,
            boolean backfill, LinkedState.Folder after) throws IOException, SQLException, InterruptedException {
        long[] uids = meta.stream().mapToLong(ImapClient.FetchData::uid).toArray();
        Map<Long, LinkedState.Place> known = linked.places(f.id(), uids);
        List<LinkedState.Arrival> arrivals = new ArrayList<>();
        List<ImapClient.FetchData> fetch = new ArrayList<>();
        for (ImapClient.FetchData m : meta) {
            if (known.containsKey(m.uid())) {
                continue;
            }
            String msgid = Norm.msgid(headerValue(m.header()));
            String labelText = labelsFor(f, m);
            if (gmail && Providers.gmailHas(m.gmLabels(), "\\Draft")) {
                arrivals.add(new LinkedState.Arrival(m.uid(), m.seen(), labelText, Math.max(0, m.size()), m.internalDate(), msgid, m.gmMsgId(),
                        null, null, true));
                continue;
            }
            String matched = linked.match(accountId, m.gmMsgId(), msgid, Math.max(0, m.size()), m.internalDate());
            if (matched != null) {
                arrivals.add(new LinkedState.Arrival(m.uid(), m.seen(), labelText, Math.max(0, m.size()), m.internalDate(), msgid, m.gmMsgId(),
                        null, matched, false));
                continue;
            }
            fetch.add(m);
        }
        // Bodies, within the shared byte budget, a few MiB at a time.
        FetchBudget budget = ctx.budget();
        int i = 0;
        LinkedState.Folder cur = f;
        while (i < fetch.size() || !arrivals.isEmpty()) {
            List<ImapClient.FetchData> part = new ArrayList<>();
            long bytes = 0;
            while (i < fetch.size() && (part.isEmpty() || bytes + Math.max(0, fetch.get(i).size()) <= settings.batchBytes())) {
                bytes += Math.max(0, fetch.get(i).size());
                part.add(fetch.get(i++));
            }
            boolean huge = part.size() == 1 && part.get(0).size() > com.minimalistalliance.desk.deskd.courier.store.BlobStore.MAX_RAW;
            if (huge) {
                bytes = 1024 * 1024;
            }
            long held = budget.take(bytes);
            try {
                if (backfill && bytes > 0) {
                    pacer.before(bytes, () -> stopped || pokedFlag);
                }
                Map<Long, byte[]> bodies = new HashMap<>();
                if (!part.isEmpty()) {
                    long[] set = part.stream().mapToLong(ImapClient.FetchData::uid).toArray();
                    // A message past what the store keeps comes as its header only: it's shown, and the rest stays at the provider.
                    long allowance = bytes + 1024L * 1024 * part.size();
                    c.fetch(UidSet.of(set), huge ? "UID BODY.PEEK[HEADER]" : "UID BODY.PEEK[]", null, allowance, allowance, d -> {
                        byte[] b = d.body() != null ? d.body() : d.header();
                        if (b != null) {
                            bodies.put(d.uid(), b);
                        }
                    });
                }
                for (ImapClient.FetchData m : part) {
                    byte[] raw = bodies.get(m.uid());
                    if (raw == null) {
                        // Gone since the metadata: nothing to keep, and a later pass won't see it either.
                        continue;
                    }
                    String header = headerValue(m.header());
                    String msgid = Norm.msgid(header);
                    Courier.Origin o = origin != null ? origin
                            : m.internalDate() != null && now() - m.internalDate() <= settings.newWindow().toMillis() ? Courier.Origin.CATCHUP
                            : Courier.Origin.BACKFILL;
                    arrivals.add(new LinkedState.Arrival(m.uid(), m.seen(), labelsFor(f, m), Math.max(0, m.size()), m.internalDate(), msgid,
                            m.gmMsgId(), inbound(f, m, header, raw, o), null, false));
                }
                // The folder's state moves only with the last part, so a crash between parts leaves it where it was.
                LinkedState.Folder state = i >= fetch.size() ? after : cur;
                if (bytes > 0) {
                    pacer.spent(bytes);
                }
                linked.arrive(state, arrivals, pacer.cursor());
                cur = state;
                arrivals.clear();
            } finally {
                budget.give(held);
            }
            if (i >= fetch.size()) {
                break;
            }
        }
        if (fetch.isEmpty() && arrivals.isEmpty() && cur == f) {
            linked.putFolder(after);
            return after;
        }
        return cur;
    }

    private Courier.Inbound inbound(LinkedState.Folder f, ImapClient.FetchData m, String msgidHeader, byte[] raw, Courier.Origin origin) {
        boolean junk = LinkedState.JUNK.equals(f.role());
        boolean sent = LinkedState.SENT.equals(f.role()) || gmail && Providers.gmailHas(m.gmLabels(), "\\Sent");
        Courier.Verdicts v = Courier.Verdicts.provider(junk, provider.authServ());
        List<String> labels = new ArrayList<>();
        String l = labelsFor(f, m);
        if (l != null) {
            labels.addAll(List.of(l.split("\n")));
        }
        Courier.Inbound in = new Courier.Inbound(accountId, "email", ExternalIds.email(accountId, msgidHeader, raw), origin, raw, null, v,
                m.seen(), false, labels, null);
        return sent ? in.asOutgoing() : in;
    }

    private String labelsFor(LinkedState.Folder f, ImapClient.FetchData m) {
        if (gmail) {
            return Providers.gmailLabels(m.gmLabels());
        }
        return labels.get(f.name());
    }

    /**
     * The Message-ID field's value from {@code BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)]}: the first such field, unfolded, at
     * most 998 bytes. Only the sink's key uses it ({@link ExternalIds#email}, after {@link Norm#msgid}), so a wrong one
     * stores nothing wrongly: the key also has the bytes' hash.
     */
    static String headerValue(byte[] header) {
        if (header == null || header.length == 0) {
            return null;
        }
        String h = new String(header, 0, Math.min(header.length, 4096), StandardCharsets.ISO_8859_1);
        int colon = h.indexOf(':');
        if (colon < 0 || !h.substring(0, colon).strip().equalsIgnoreCase("Message-ID")) {
            return null;
        }
        StringBuilder v = new StringBuilder();
        String[] lines = h.substring(colon + 1).split("\r?\n", -1);
        v.append(lines[0]);
        for (int i = 1; i < lines.length; i++) {
            if (lines[i].startsWith(" ") || lines[i].startsWith("\t")) {
                v.append(lines[i]);
            } else {
                break;
            }
        }
        String s = v.toString().strip();
        return s.isEmpty() || s.length() > 998 ? null : s;
    }

    // ---- live

    /** IDLE on the home folder until it changes, a poke, or the poll's time; then that folder's sync. */
    private void idle(ImapClient c, LinkedState.Folder home) throws IOException, SQLException, InterruptedException {
        LinkedState.Folder f = syncFolder(c, home, false);
        if (!c.has("IDLE")) {
            await(Math.min(settings.pollEvery().toMillis(), 120_000));
            return;
        }
        long until = now() + settings.pollEvery().toMillis();
        while (!stopped && ctx.on() && now() < until) {
            if (pokedFlag) {
                pokedFlag = false;
                return;
            }
            boolean changed = c.idle(Math.min(settings.idleWindow().toMillis(), Math.max(1, until - now())));
            if (stopped) {
                return;
            }
            if (pokedFlag) {
                pokedFlag = false;
                return;
            }
            if (changed || c.box.changed) {
                c.box.changed = false;
                f = syncFolder(c, f, false);
                checkedAt = now();
            }
        }
    }

    // ---- the member's changes, to the provider

    /**
     * The member's changes owed to the provider, oldest first. One whose message has no place yet (lost in a move or a
     * renumbering, and not yet found again) waits; one the provider keeps refusing is dropped after its tries. Stops once a
     * round gets nothing done.
     */
    private void applyOps(ImapClient c) throws IOException, SQLException {
        for (int round = 0; round < 50; round++) {
            List<LinkedState.Op> ops = linked.ops(accountId, 200);
            if (ops.isEmpty()) {
                return;
            }
            List<LinkedState.Folder> folders = linked.folders(accountId);
            boolean backfilling = folders.stream().anyMatch(f -> !f.backfilled());
            int done = 0;
            for (LinkedState.Op op : ops) {
                if (stopped) {
                    return;
                }
                if (op.where().isEmpty() && (backfilling || linked.orphan(accountId, op.messageId()))) {
                    continue;
                }
                try {
                    apply(c, op, folders);
                    linked.opDone(op.seq());
                    done++;
                } catch (Renumbered e) {
                    // A folder renumbered since the desk last looked: its UIDs mean other messages now. The sync starts it
                    // over first, and the op waits for the places it finds.
                    return;
                } catch (ImapException.Refused e) {
                    if (!linked.opFailed(op.seq())) {
                        log.info("courier imap {}: a change the provider kept refusing was dropped ({})", accountId,
                                e.status.toLowerCase(java.util.Locale.ROOT));
                    }
                }
            }
            if (done == 0) {
                return;
            }
        }
    }

    private void apply(ImapClient c, LinkedState.Op op, List<LinkedState.Folder> folders) throws IOException, SQLException {
        List<LinkedState.Where> where = op.where();
        if (gmail) {
            // Gmail's flags and moves are the message's, wherever it's shown: act on All Mail, Spam or Trash, not a view.
            List<LinkedState.Where> real = where.stream().filter(w -> !LinkedState.SENT.equals(w.role())).toList();
            where = real.isEmpty() ? where : real;
        }
        if (where.isEmpty()) {
            return;
        }
        switch (op.op()) {
            case LinkedState.OP_READ, LinkedState.OP_UNREAD -> {
                boolean seen = LinkedState.OP_READ.equals(op.op());
                for (LinkedState.Where w : gmail ? where.subList(0, 1) : where) {
                    if (w.seen() == seen) {
                        continue;
                    }
                    select(c, w);
                    c.store(Long.toString(w.uid()), seen ? "+FLAGS.SILENT" : "-FLAGS.SILENT", "\\Seen");
                    linked.seen(w.folderId(), w.uid(), seen);
                }
            }
            case LinkedState.OP_TRASH -> moveAll(c, where, folder(folders, LinkedState.TRASH), LinkedState.TRASH);
            case LinkedState.OP_SPAM -> moveAll(c, where, folder(folders, LinkedState.JUNK), LinkedState.JUNK);
            case LinkedState.OP_RESTORE -> {
                LinkedState.Folder inbox = folder(folders, gmail ? LinkedState.ALL : LinkedState.INBOX);
                String dest = gmail ? "INBOX" : inbox == null ? null : inbox.name();
                if (dest == null) {
                    return;
                }
                for (LinkedState.Where w : where) {
                    if (LinkedState.TRASH.equals(w.role()) || LinkedState.JUNK.equals(w.role())) {
                        select(c, w);
                        ImapClient.CopyUid cu = c.move(Long.toString(w.uid()), dest);
                        moved(w, gmail ? null : inbox, gmail ? null : cu);
                    }
                }
            }
            case LinkedState.OP_DELETE -> {
                LinkedState.Folder trash = folder(folders, LinkedState.TRASH);
                for (LinkedState.Where w : where) {
                    select(c, w);
                    if (LinkedState.TRASH.equals(w.role()) || trash == null) {
                        c.store(Long.toString(w.uid()), "+FLAGS.SILENT", "\\Deleted");
                        if (c.has("UIDPLUS")) {
                            c.expunge(Long.toString(w.uid()));
                            linked.expunged(w.folderId(), w.uid());
                        }
                    } else {
                        ImapClient.CopyUid cu = c.move(Long.toString(w.uid()), trash.name());
                        moved(w, trash, cu);
                    }
                }
            }
            default -> { }
        }
    }

    private void moveAll(ImapClient c, List<LinkedState.Where> where, LinkedState.Folder to, String role) throws IOException, SQLException {
        if (to == null) {
            return;
        }
        for (LinkedState.Where w : where) {
            if (role.equals(w.role())) {
                continue;
            }
            select(c, w);
            ImapClient.CopyUid cu = c.move(Long.toString(w.uid()), to.name());
            moved(w, to, cu);
        }
    }

    /** Opens the folder a place is in, refusing it if the folder's numbering isn't the one the place has. */
    private void select(ImapClient c, LinkedState.Where w) throws IOException {
        ImapClient.Selected sel = c.select(w.folder(), 0, 0, null);
        lastMessages.remove(w.folderId());
        if (sel.uidValidity() != w.uidValidity()) {
            throw new Renumbered();
        }
    }

    /** The folder's UIDVALIDITY isn't the desk's: an op must not act on its UIDs. */
    static final class Renumbered extends IOException {
        private static final long serialVersionUID = 1L;

        Renumbered() {
            super("renumbered", null);
        }
    }

    /** Where a COPYUID says a message went, recorded only under the numbering the desk has for that folder. */
    private void moved(LinkedState.Where w, LinkedState.Folder to, ImapClient.CopyUid cu) throws SQLException {
        if (cu == null || to == null) {
            linked.moved(w.folderId(), w.uid(), to, 0);
        } else {
            linked.moved(w.folderId(), w.uid(), to, cu.to()[0], cu.uidValidity());
        }
    }

    private static LinkedState.Folder folder(List<LinkedState.Folder> folders, String role) {
        for (LinkedState.Folder f : folders) {
            if (role.equals(f.role())) {
                return f;
            }
        }
        return null;
    }

    /** The connection settings sealed with the sign-in ({@code SignIn.server()}): hosts, ports, security. */
    record Server(String imapHost, int imapPort, String smtpHost, int smtpPort, boolean smtpTls) {
        static Server of(String json) throws IOException {
            if (json == null) {
                throw new NeedsYou("server");
            }
            try {
                Map<String, Object> m = com.minimalistalliance.desk.deskd.protocol.Json.parseObject(json.getBytes(StandardCharsets.UTF_8));
                String imap = (String) m.get("imapHost");
                String smtp = (String) m.get("smtpHost");
                int imapPort = m.get("imapPort") instanceof Number n ? n.intValue() : 993;
                int smtpPort = m.get("smtpPort") instanceof Number n ? n.intValue() : 465;
                boolean tls = !"starttls".equals(m.get("security")) && smtpPort != 587;
                if (imap == null) {
                    throw new NeedsYou("server");
                }
                return new Server(imap, imapPort, smtp, smtpPort, tls);
            } catch (com.minimalistalliance.desk.deskd.protocol.JsonFormatException | ClassCastException e) {
                throw new NeedsYou("server");
            }
        }
    }
}
