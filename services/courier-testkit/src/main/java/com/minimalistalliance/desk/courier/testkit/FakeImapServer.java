package com.minimalistalliance.desk.courier.testkit;

import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Deque;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.LongAdder;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Supplier;
import javax.net.ssl.SSLContext;

/**
 * A scripted, in-memory IMAP4rev1 server for tests, on 127.0.0.1, JDK only: CONDSTORE, QRESYNC, ENABLE, SPECIAL-USE,
 * ESEARCH, MOVE, UIDPLUS, IDLE, LITERAL+, SASL-IR, ID, NAMESPACE and Gmail's X-GM-EXT-1, each of which can be turned off
 * to test a client's fallback, plus fault injection. One virtual thread per connection. The README in this module says
 * what it implements and what it doesn't.
 *
 * <p>Folder names are given and returned decoded (Unicode, {@code /} between levels); the wire has them in modified
 * UTF-7. Every method here is thread-safe, and a change made here reaches sessions as a change made by another client
 * would: at once to a session in IDLE, else with the next command's response.
 */
public final class FakeImapServer implements AutoCloseable {

    /** What the server advertises and does. Turn one off and its commands answer BAD, as on a server without it. */
    public enum Capability {
        IDLE("IDLE"),
        UIDPLUS("UIDPLUS"),
        MOVE("MOVE"),
        CONDSTORE("CONDSTORE"),
        /** Implies ENABLE and CONDSTORE. */
        QRESYNC("QRESYNC"),
        ENABLE("ENABLE"),
        SPECIAL_USE("SPECIAL-USE"),
        ESEARCH("ESEARCH"),
        LITERAL_PLUS("LITERAL+"),
        SASL_IR("SASL-IR"),
        /** Gmail mode: Gmail's folders and model, X-GM-MSGID, X-GM-THRID, X-GM-LABELS. */
        X_GM_EXT_1("X-GM-EXT-1"),
        ID("ID"),
        NAMESPACE("NAMESPACE"),
        AUTH_PLAIN("AUTH=PLAIN"),
        /** LOGIN refused (a negative test); off by default. */
        LOGINDISABLED("LOGINDISABLED");

        private final String token;

        Capability(String token) {
            this.token = token;
        }

        /** As it appears in a CAPABILITY response. */
        public String token() {
            return token;
        }
    }

    /** A folder a new user gets: its name (decoded, {@code /} between levels) and attributes such as {@code \Sent}. */
    public record FolderSpec(String name, Set<String> attributes) {
        public FolderSpec {
            attributes = Set.copyOf(attributes);
        }

        public static FolderSpec of(String name, String... attributes) {
            return new FolderSpec(name, Set.of(attributes));
        }
    }

    /** How to start a server. A fluent, mutable builder; {@link #start} copies it. */
    public static final class Options {
        private boolean tls;
        private final EnumSet<Capability> capabilities = EnumSet.complementOf(EnumSet.of(Capability.LOGINDISABLED, Capability.X_GM_EXT_1));
        private List<FolderSpec> defaultFolders = List.of(
            FolderSpec.of("Sent", "\\Sent"), FolderSpec.of("Drafts", "\\Drafts"), FolderSpec.of("Junk", "\\Junk"),
            FolderSpec.of("Trash", "\\Trash"), FolderSpec.of("Archive", "\\Archive"));
        private SSLContext sslContext;
        private int maxLineLength = 65_536;
        private long maxLiteral = 64L * 1024 * 1024;

        /** Every capability but LOGINDISABLED and X-GM-EXT-1, plain text, the default folders. */
        public static Options defaults() {
            return new Options();
        }

        /** Gmail mode: {@link #defaults()} plus X-GM-EXT-1. */
        public static Options gmail() {
            return new Options().with(Capability.X_GM_EXT_1);
        }

        /** Implicit TLS (IMAPS) with {@link FakeTls}'s certificate, or the context given with {@link #sslContext}. */
        public Options tls(boolean on) {
            this.tls = on;
            return this;
        }

        public Options with(Capability... caps) {
            capabilities.addAll(List.of(caps));
            return this;
        }

        public Options without(Capability... caps) {
            for (Capability c : caps) {
                capabilities.remove(c);
            }
            return this;
        }

        /** Exactly these capabilities. */
        public Options only(Capability... caps) {
            capabilities.clear();
            capabilities.addAll(List.of(caps));
            return this;
        }

        /** The folders a new user gets besides INBOX (ignored in Gmail mode, which has Gmail's). */
        public Options defaultFolders(List<FolderSpec> folders) {
            this.defaultFolders = List.copyOf(folders);
            return this;
        }

        /** Serve TLS with this context instead of GreenMail's certificate. */
        public Options sslContext(SSLContext ctx) {
            this.sslContext = ctx;
            return this;
        }

        /** The longest command line, literals apart (default 64 KiB); longer ends the connection with BYE. */
        public Options maxLineLength(int bytes) {
            this.maxLineLength = bytes;
            return this;
        }

        /** The largest literal taken (default 64 MiB). */
        public Options maxLiteral(long bytes) {
            this.maxLiteral = bytes;
            return this;
        }

        public Set<Capability> capabilities() {
            return Set.copyOf(capabilities);
        }

        public boolean tls() {
            return tls;
        }

        int maxLineLengthValue() {
            return maxLineLength;
        }

        long maxLiteralValue() {
            return maxLiteral;
        }

        private Options copy() {
            Options o = new Options();
            o.tls = tls;
            o.capabilities.clear();
            o.capabilities.addAll(capabilities);
            o.defaultFolders = defaultFolders;
            o.sslContext = sslContext;
            o.maxLineLength = maxLineLength;
            o.maxLiteral = maxLiteral;
            return o;
        }
    }

    /** A message as a folder shows it now. {@link #bytes()} reads a lazy message's source. */
    public record Message(long uid, Set<String> flags, Set<String> labels, long gmMsgId, long gmThrId, long modSeq, long size,
                          Instant internalDate, Supplier<byte[]> source) {
        public byte[] bytes() {
            return source.get();
        }
    }

    /** A folder now: its decoded name, attributes ({@code \Noselect}, special use), UIDVALIDITY, UIDNEXT, HIGHESTMODSEQ, count. */
    public record Folder(String name, Set<String> attributes, long uidValidity, long uidNext, long highestModSeq, int messages) {
    }

    /** One APPEND the server took: where, the UID it got there, flags, INTERNALDATE and the bytes. */
    public record Appended(String folder, long uid, Set<String> flags, Instant internalDate, byte[] bytes) {
    }

    // ---- state ----

    final Options options;
    final ImapStore store;
    final SSLContext sslContext;
    private final int port;
    private final ReentrantLock acceptLock = new ReentrantLock();
    private ServerSocket serverSocket;
    private int generation;
    private volatile boolean closed;
    final Set<ImapSession> sessions = ConcurrentHashMap.newKeySet();

    private final Map<String, LongAdder> commands = new ConcurrentHashMap<>();
    private final AtomicLong bytesServed = new AtomicLong();
    private final AtomicInteger connections = new AtomicInteger();
    private final AtomicInteger logins = new AtomicInteger();

    private final ReentrantLock faultLock = new ReentrantLock();
    private final Map<String, Deque<String[]>> failNext = new HashMap<>();
    private String loginFailure;
    private int loginFailures;
    private volatile long delayMillis;
    private final AtomicLong cutBudget = new AtomicLong(-1);
    private volatile long idleByeMillis;
    private volatile int maxPerUser;

    private FakeImapServer(Options options) throws IOException {
        this.options = options;
        this.store = new ImapStore(options.capabilities.contains(Capability.X_GM_EXT_1), options.defaultFolders);
        this.sslContext = options.tls ? (options.sslContext != null ? options.sslContext : FakeTls.serverContext()) : null;
        ServerSocket ss = new ServerSocket();
        ss.setReuseAddress(true);
        ss.bind(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 128);
        this.port = ss.getLocalPort();
        listen(ss);
    }

    /** Starts a server on 127.0.0.1 on a port the system picks. */
    public static FakeImapServer start(Options options) {
        try {
            return new FakeImapServer(options.copy());
        } catch (IOException e) {
            throw new IllegalStateException("can't listen", e);
        }
    }

    /** {@link Options#defaults()}. */
    public static FakeImapServer start() {
        return start(Options.defaults());
    }

    public int port() {
        return port;
    }

    public boolean tls() {
        return options.tls;
    }

    /** Whether this server is in Gmail mode. */
    public boolean gmail() {
        return store.gmail;
    }

    public boolean has(Capability c) {
        return options.capabilities.contains(c);
    }

    /** Stops listening and drops every connection. */
    @Override
    public void close() {
        closed = true;
        acceptLock.lock();
        try {
            generation++;
            closeQuietly(serverSocket);
            serverSocket = null;
        } finally {
            acceptLock.unlock();
        }
        for (ImapSession s : sessions) {
            s.drop();
        }
    }

    private void listen(ServerSocket ss) {
        acceptLock.lock();
        try {
            serverSocket = ss;
            int gen = ++generation;
            Thread.ofVirtual().name("fake-imap-accept-" + port).start(() -> acceptLoop(ss, gen));
        } finally {
            acceptLock.unlock();
        }
    }

    private void acceptLoop(ServerSocket ss, int gen) {
        while (!closed) {
            Socket s;
            try {
                s = ss.accept();
            } catch (IOException e) {
                return;
            }
            if (closed || gen != generation) {
                closeQuietly(s);
                return;
            }
            connections.incrementAndGet();
            ImapSession session = new ImapSession(this, s);
            sessions.add(session);
            Thread.ofVirtual().name("fake-imap-" + port + "-" + connections.get()).start(session::run);
        }
    }

    // ---- users and folders ----

    /** A user with INBOX and the default folders (or Gmail's). Adding one again changes the password. */
    public void addUser(String login, String password) {
        locked(() -> store.addUser(login, password));
    }

    /** A folder (and its parents, as {@code \Noselect}), with attributes such as {@code \Archive} or {@code \Noselect}. */
    public void addFolder(String login, String name, String... attributes) {
        locked(() -> store.create(store.requireAccount(login), name, List.of(attributes)));
    }

    /** Every folder of the user, INBOX first, then by name. */
    public List<Folder> folders(String login) {
        return locked(() -> {
            List<Folder> out = new ArrayList<>();
            for (ImapStore.Mailbox m : store.requireAccount(login).folders.values()) {
                out.add(store.snapshot(m));
            }
            return out;
        });
    }

    /** One folder now, or null. */
    public Folder folder(String login, String name) {
        return locked(() -> {
            ImapStore.Mailbox m = store.mailbox(store.requireAccount(login), name);
            return m == null ? null : store.snapshot(m);
        });
    }

    // ---- messages ----

    /**
     * A new message in {@code folder}, which is made if it isn't there; returns its UID there. In Gmail mode, INBOX and
     * All Mail both mean All Mail with {@code \Inbox}, a label folder adds its label, Spam and Trash put it there.
     * {@code internalDate} null is now.
     */
    public long deliver(String login, String folder, byte[] raw, Set<String> flags, Instant internalDate) {
        byte[] copy = raw.clone();
        return deliver(login, folder, copy, null, copy.length, flags, internalDate);
    }

    /** {@code raw} into INBOX, no flags, now. */
    public long deliver(String login, byte[] raw) {
        return deliver(login, ImapStore.INBOX, raw, Set.of(), null);
    }

    /**
     * A lazy message: {@code bytes} is called each time its content is needed (it must give exactly {@code size} bytes,
     * the same each time), so a large mailbox costs no memory for its content. Otherwise as {@link #deliver(String,
     * String, byte[], Set, Instant)}.
     */
    public long deliver(String login, String folder, long size, Supplier<byte[]> bytes, Set<String> flags, Instant internalDate) {
        return deliver(login, folder, null, bytes, size, flags, internalDate);
    }

    private long deliver(String login, String folder, byte[] raw, Supplier<byte[]> source, long size, Set<String> flags, Instant date) {
        return locked(() -> {
            ImapStore.Account a = store.requireAccount(login);
            ImapStore.Mailbox m = store.mailbox(a, folder);
            if (m == null) {
                m = store.create(a, folder, Set.of());
            }
            List<String> labels = new ArrayList<>();
            if (store.gmail && (m.kind == ImapStore.Kind.ALL_MAIL || m.name.equals(ImapStore.INBOX))) {
                labels.add("\\Inbox");
                ImapStore.Mailbox all = store.mailbox(a, ImapStore.ALL_MAIL);
                ImapStore.Entry e = store.append(all, raw, source, size, date, flags, labels);
                return m == all ? e.uid : e.core.placed.get(m).uid;
            }
            return store.append(m, raw, source, size, date, flags, labels).uid;
        });
    }

    /** Replaces a message's flags (a change bumps its MODSEQ and is pushed to sessions). */
    public void setFlags(String login, String folder, long uid, Set<String> flags) {
        locked(() -> {
            ImapStore.Mailbox m = mailbox(login, folder);
            store.setFlags(m, entry(m, uid), flags, null);
        });
    }

    /** Gmail mode: replaces the labels of the message with this UID in All Mail. */
    public void labels(String login, long allMailUid, String... labels) {
        labels(login, ImapStore.ALL_MAIL, allMailUid, Set.of(labels));
    }

    /** Gmail mode: replaces the labels of a message, by its UID in {@code folder}. */
    public void labels(String login, String folder, long uid, Set<String> labels) {
        requireGmail();
        locked(() -> {
            ImapStore.Mailbox m = mailbox(login, folder);
            store.setLabels(m, entry(m, uid), labels, null);
        });
    }

    /** Gmail mode: puts a message in a thread (X-GM-THRID); by default each message is its own, its X-GM-MSGID. */
    public void gmailThread(String login, String folder, long uid, long thrId) {
        requireGmail();
        locked(() -> {
            ImapStore.Mailbox m = mailbox(login, folder);
            entry(m, uid).core.gmThrId = thrId;
        });
    }

    /**
     * Takes a message out of a folder, as if another client deleted it (sessions see EXPUNGE or VANISHED). In Gmail mode,
     * from All Mail, Spam or Trash it's deleted for good; from a label folder its label goes.
     */
    public void expunge(String login, String folder, long uid) {
        locked(() -> {
            ImapStore.Mailbox m = mailbox(login, folder);
            store.expunge(m, entry(m, uid));
        });
    }

    /** Moves a message as IMAP's MOVE would; returns its UID in {@code toFolder}. Gmail mode keeps its X-GM-MSGID. */
    public long move(String login, String folder, long uid, String toFolder) {
        return locked(() -> {
            ImapStore.Mailbox m = mailbox(login, folder);
            ImapStore.Mailbox to = mailbox(login, toFolder);
            List<long[]> pairs = store.move(m, List.of(entry(m, uid)), to, null);
            if (pairs.isEmpty()) {
                throw new IllegalStateException("the move left nothing in " + toFolder);
            }
            return pairs.get(0)[1];
        });
    }

    /**
     * Gives a folder a new UIDVALIDITY and renumbers its messages from UID 1, keeping their bytes, flags, labels and dates,
     * as a server does when it rebuilds an index. Sessions with it selected get {@code * BYE} and are closed, as Dovecot
     * does. Returns the new UIDVALIDITY.
     */
    public long resetUidValidity(String login, String folder) {
        return locked(() -> store.resetUidValidity(mailbox(login, folder)));
    }

    /** The folder's messages now, in UID order. */
    public List<Message> messages(String login, String folder) {
        return locked(() -> {
            List<Message> out = new ArrayList<>();
            for (ImapStore.Entry e : mailbox(login, folder).entries) {
                out.add(store.snapshot(e));
            }
            return out;
        });
    }

    /** Every APPEND this user's sessions made, in order. */
    public List<Appended> appended(String login) {
        return locked(() -> List.copyOf(store.requireAccount(login).appended));
    }

    // ---- counters ----

    /** How many commands of each name were received, e.g. {@code UID FETCH}, {@code SELECT}, {@code IDLE}. */
    public Map<String, Long> commands() {
        Map<String, Long> out = new TreeMap<>();
        commands.forEach((k, v) -> out.put(k, v.sum()));
        return out;
    }

    /** How many commands of that name (upper case, {@code UID FETCH} apart from {@code FETCH}). */
    public long commandCount(String name) {
        LongAdder a = commands.get(name.toUpperCase(Locale.ROOT));
        return a == null ? 0 : a.sum();
    }

    /** Bytes written to clients (before TLS). */
    public long bytesServed() {
        return bytesServed.get();
    }

    public int connectionsOpened() {
        return connections.get();
    }

    /** Successful LOGINs and AUTHENTICATEs. */
    public int logins() {
        return logins.get();
    }

    /** Connections open now. */
    public int connectionsOpen() {
        return sessions.size();
    }

    // ---- faults ----

    /** Closes every connection now, abruptly (a TCP reset, no BYE). */
    public void dropConnections() {
        for (ImapSession s : sessions) {
            s.drop();
        }
    }

    /** Sends {@code * BYE <text>} on every connection and closes it. */
    public void byeConnections(String text) {
        for (ImapSession s : sessions) {
            s.byeAndClose(text);
        }
    }

    /**
     * The next {@code times} commands named {@code command} (e.g. {@code UID FETCH}, {@code SELECT}) get {@code <tag>
     * <response>} instead of running, e.g. {@code NO [THROTTLED] slow down}, {@code NO [LIMIT] too many}, {@code BAD}.
     */
    public void failNext(String command, int times, String response) {
        faultLock.lock();
        try {
            failNext.computeIfAbsent(command.toUpperCase(Locale.ROOT), k -> new ArrayDeque<>()).add(new String[] {response, String.valueOf(times)});
        } finally {
            faultLock.unlock();
        }
    }

    /**
     * Every LOGIN and AUTHENTICATE with any credentials gets {@code <tag> <response>}, e.g. {@code NO
     * [AUTHENTICATIONFAILED] Invalid credentials} or {@code NO [ALERT] Application-specific password required}, until
     * {@code failLogin(null)}.
     */
    public void failLogin(String response) {
        failLogin(response, Integer.MAX_VALUE);
    }

    /** As {@link #failLogin(String)}, for the next {@code times} attempts only. */
    public void failLogin(String response, int times) {
        faultLock.lock();
        try {
            loginFailure = response;
            loginFailures = response == null ? 0 : times;
        } finally {
            faultLock.unlock();
        }
    }

    /** Waits this long before answering each command (and before the greeting); zero or null for none. */
    public void delayResponses(Duration delay) {
        delayMillis = delay == null ? 0 : delay.toMillis();
    }

    /**
     * Once the server has written {@code bytes} more bytes (across all connections, counted from now), it cuts the
     * connection writing at that moment, mid-literal or wherever, with a TCP reset. One shot.
     */
    public void cutAfterBytes(long bytes) {
        cutBudget.set(bytes);
    }

    /** Each IDLE from now on ends with {@code * BYE} and a close after this long; null or zero for never. */
    public void idleByeAfter(Duration after) {
        idleByeMillis = after == null ? 0 : after.toMillis();
    }

    /**
     * Stops listening for this long, so a connect gets "connection refused" as on a closed port, then listens on the same
     * port again. Connections already open stay.
     */
    public void refuseConnections(Duration duration) {
        int gen;
        acceptLock.lock();
        try {
            gen = ++generation;
            closeQuietly(serverSocket);
            serverSocket = null;
        } finally {
            acceptLock.unlock();
        }
        Thread.ofVirtual().name("fake-imap-reopen-" + port).start(() -> {
            try {
                Thread.sleep(duration.toMillis());
            } catch (InterruptedException e) {
                return;
            }
            reopen(gen);
        });
    }

    /** Listens again now, after {@link #refuseConnections}. */
    public void acceptConnections() {
        reopen(-1);
    }

    private void reopen(int expected) {
        acceptLock.lock();
        try {
            if (closed || serverSocket != null || (expected >= 0 && generation != expected)) {
                return;
            }
            IOException last = null;
            for (int i = 0; i < 50; i++) {
                try {
                    ServerSocket ss = new ServerSocket();
                    ss.setReuseAddress(true);
                    ss.bind(new InetSocketAddress(InetAddress.getLoopbackAddress(), port), 128);
                    listen(ss);
                    return;
                } catch (IOException e) {
                    last = e;
                    try {
                        Thread.sleep(20);
                    } catch (InterruptedException ie) {
                        return;
                    }
                }
            }
            throw new IllegalStateException("can't listen on " + port + " again", last);
        } finally {
            acceptLock.unlock();
        }
    }

    /** At most this many authenticated connections per user; one more gets {@code * BYE Too many simultaneous connections} at login. Zero for no limit. */
    public void maxConnectionsPerUser(int max) {
        maxPerUser = max;
    }

    /** Every fault off: failures, login failure, delay, cut, IDLE's BYE, the connection limit; listening again. */
    public void clearFaults() {
        faultLock.lock();
        try {
            failNext.clear();
            loginFailure = null;
            loginFailures = 0;
        } finally {
            faultLock.unlock();
        }
        delayMillis = 0;
        cutBudget.set(-1);
        idleByeMillis = 0;
        maxPerUser = 0;
        acceptConnections();
    }

    // ---- for sessions ----

    void counted(String command) {
        commands.computeIfAbsent(command, k -> new LongAdder()).increment();
    }

    void delay() {
        long d = delayMillis;
        if (d > 0) {
            try {
                Thread.sleep(d);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
    }

    String takeFailure(String command) {
        faultLock.lock();
        try {
            Deque<String[]> q = failNext.get(command);
            if (q == null || q.isEmpty()) {
                return null;
            }
            String[] f = q.peek();
            int left = Integer.parseInt(f[1]);
            if (left <= 1) {
                q.poll();
            } else {
                f[1] = String.valueOf(left - 1);
            }
            return left >= 1 ? f[0] : null;
        } finally {
            faultLock.unlock();
        }
    }

    String takeLoginFailure() {
        faultLock.lock();
        try {
            if (loginFailure == null || loginFailures <= 0) {
                return null;
            }
            if (loginFailures != Integer.MAX_VALUE) {
                loginFailures--;
            }
            return loginFailure;
        } finally {
            faultLock.unlock();
        }
    }

    void loggedIn() {
        logins.incrementAndGet();
    }

    int maxPerUser() {
        return maxPerUser;
    }

    long idleByeMillis() {
        return idleByeMillis;
    }

    /** How many of {@code len} bytes may go now, and whether to cut after them: {allowed, cut ? 1 : 0}. */
    long[] take(int len) {
        while (true) {
            long b = cutBudget.get();
            if (b < 0) {
                return new long[] {len, 0};
            }
            long allowed = Math.min(b, len);
            long rest = b - allowed;
            if (cutBudget.compareAndSet(b, rest == 0 ? -1 : rest)) {
                return new long[] {allowed, rest == 0 ? 1 : 0};
            }
        }
    }

    void served(long n) {
        bytesServed.addAndGet(n);
    }

    void ended(ImapSession s) {
        sessions.remove(s);
    }

    // ---- helpers ----

    private ImapStore.Mailbox mailbox(String login, String folder) {
        return store.requireMailbox(store.requireAccount(login), folder);
    }

    private static ImapStore.Entry entry(ImapStore.Mailbox m, long uid) {
        ImapStore.Entry e = m.get(uid);
        if (e == null) {
            throw new IllegalArgumentException("no UID " + uid + " in " + m.name);
        }
        return e;
    }

    private void requireGmail() {
        if (!store.gmail) {
            throw new IllegalStateException("not in Gmail mode (X-GM-EXT-1)");
        }
    }

    private <T> T locked(Supplier<T> body) {
        store.lock.lock();
        try {
            return body.get();
        } finally {
            store.lock.unlock();
        }
    }

    private void locked(Runnable body) {
        store.lock.lock();
        try {
            body.run();
        } finally {
            store.lock.unlock();
        }
    }

    static Set<String> set(Collection<String> c) {
        return new LinkedHashSet<>(c);
    }

    private static void closeQuietly(AutoCloseable c) {
        if (c != null) {
            try {
                c.close();
            } catch (Exception ignored) {
                // closing anyway
            }
        }
    }
}
