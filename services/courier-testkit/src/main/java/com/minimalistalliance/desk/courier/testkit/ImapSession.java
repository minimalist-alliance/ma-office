package com.minimalistalliance.desk.courier.testkit;

import com.minimalistalliance.desk.courier.testkit.FakeImapServer.Capability;
import com.minimalistalliance.desk.courier.testkit.ImapStore.Entry;
import com.minimalistalliance.desk.courier.testkit.ImapStore.Mailbox;
import com.minimalistalliance.desk.courier.testkit.ImapWire.Bad;
import com.minimalistalliance.desk.courier.testkit.ImapWire.Command;
import com.minimalistalliance.desk.courier.testkit.ImapWire.SeqSet;
import com.minimalistalliance.desk.courier.testkit.ImapWire.Tokens;
import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.FilterOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.time.LocalDate;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Predicate;

/** One IMAP connection of {@link FakeImapServer}: reads commands, answers them, and passes on changes to its folder. */
final class ImapSession implements ImapStore.Listener {

    private static final int EXISTS = 0;
    private static final int CHANGED = 1;
    private static final int EXPUNGED = 2;

    private enum State { NOT_AUTH, AUTH, SELECTED }

    private final FakeImapServer server;
    private final ImapStore store;
    private final Socket raw;
    private final Set<Capability> caps;
    private final ReentrantLock writeLock = new ReentrantLock();
    private final AtomicBoolean ending = new AtomicBoolean();
    private Socket socket;
    private ImapWire.Reader reader;
    private OutputStream out;

    private volatile State state = State.NOT_AUTH;
    private ImapStore.Account account;
    private Mailbox selected;
    private boolean readOnly;
    private final UidList view = new UidList();
    /** Changes to the selected folder not yet told: {kind, uid}. Guarded by the store's lock. */
    private final ArrayDeque<long[]> pending = new ArrayDeque<>();
    private final Semaphore wake = new Semaphore(0);
    private volatile boolean idleStop;
    private volatile boolean doomed;
    private boolean condstore;
    private boolean qresync;

    ImapSession(FakeImapServer server, Socket raw) {
        this.server = server;
        this.store = server.store;
        this.raw = raw;
        this.caps = server.options.capabilities();
    }

    // ---- the connection ----

    void run() {
        try {
            raw.setTcpNoDelay(true);
            socket = server.sslContext != null ? FakeTls.serverSide(server.sslContext, raw) : raw;
            reader = new ImapWire.Reader(new BufferedInputStream(socket.getInputStream(), 65_536), server.options.maxLineLengthValue());
            out = new BufferedOutputStream(new Counting(socket.getOutputStream()), 65_536);
            server.delay();
            send("* OK [CAPABILITY " + capabilities() + "] FakeImapServer ready.");
            flush();
            while (!ending.get()) {
                Command c;
                try {
                    c = reader.command(this::announce);
                } catch (ImapWire.Refused r) {
                    send(r.tag + " " + r.response);
                    flush();
                    continue;
                } catch (ImapWire.LineTooLong e) {
                    byeAndClose("Command line too long");
                    return;
                }
                if (c == null) {
                    return;
                }
                if (doomed) {
                    byeAndClose("Mailbox UIDVALIDITY changed");
                    return;
                }
                handle(c);
                flush();
            }
        } catch (IOException | RuntimeException e) {
            // the connection is gone, or was cut on purpose
        } finally {
            end();
        }
    }

    private String announce(String textSoFar, long size, boolean nonSync) throws IOException {
        if (size > server.options.maxLiteralValue()) {
            if (nonSync) {
                byeAndClose("[TOOBIG] Literal too large");
                throw new IOException("literal too large");
            }
            return "NO [TOOBIG] Literal too large";
        }
        if (nonSync) {
            return caps.contains(Capability.LITERAL_PLUS) ? null : "BAD";
        }
        send("+ Ready for literal data");
        flush();
        return null;
    }

    private void end() {
        ending.set(true);
        store.lock.lock();
        try {
            deselectLocked();
            if (account != null) {
                account.sessions.remove(this);
            }
        } finally {
            store.lock.unlock();
        }
        server.ended(this);
        try {
            (socket != null ? socket : raw).close();
        } catch (IOException ignored) {
            // closing anyway
        }
        try {
            raw.close();
        } catch (IOException ignored) {
            // closing anyway
        }
    }

    /** A TCP reset, no BYE. */
    void drop() {
        ending.set(true);
        try {
            raw.setSoLinger(true, 0);
        } catch (IOException ignored) {
            // closing anyway
        }
        try {
            raw.close();
        } catch (IOException ignored) {
            // closing anyway
        }
    }

    void byeAndClose(String text) {
        if (!ending.compareAndSet(false, true)) {
            return;
        }
        writeLock.lock();
        try {
            if (out != null) {
                out.write(("* BYE " + text + "\r\n").getBytes(StandardCharsets.UTF_8));
                out.flush();
            }
        } catch (IOException ignored) {
            // closing anyway
        } finally {
            writeLock.unlock();
        }
        try {
            (socket != null ? socket : raw).close();
        } catch (IOException ignored) {
            // closing anyway
        }
        try {
            raw.close();
        } catch (IOException ignored) {
            // closing anyway
        }
    }

    private void send(String line) throws IOException {
        write(line.getBytes(StandardCharsets.UTF_8), true);
    }

    private void write(byte[] bytes, boolean crlf) throws IOException {
        writeLock.lock();
        try {
            out.write(bytes);
            if (crlf) {
                out.write('\r');
                out.write('\n');
            }
        } finally {
            writeLock.unlock();
        }
    }

    private void flush() throws IOException {
        writeLock.lock();
        try {
            out.flush();
        } finally {
            writeLock.unlock();
        }
    }

    /** Counts what's served, and cuts the connection when {@link FakeImapServer#cutAfterBytes} says. */
    private final class Counting extends FilterOutputStream {
        Counting(OutputStream out) {
            super(out);
        }

        @Override
        public void write(int b) throws IOException {
            write(new byte[] {(byte) b}, 0, 1);
        }

        @Override
        public void write(byte[] b, int off, int len) throws IOException {
            long[] t = server.take(len);
            int allowed = (int) t[0];
            out.write(b, off, allowed);
            server.served(allowed);
            if (t[1] == 1) {
                out.flush();
                drop();
                throw new IOException("cut");
            }
        }
    }

    // ---- store listener (under the store's lock) ----

    @Override
    public void exists(long uid) {
        pending.add(new long[] {EXISTS, uid});
        wake.release();
    }

    @Override
    public void changed(long uid) {
        long[] last = pending.peekLast();
        if (last != null && last[0] == CHANGED && last[1] == uid) {
            return;
        }
        pending.add(new long[] {CHANGED, uid});
        wake.release();
    }

    @Override
    public void expunged(long uid) {
        pending.add(new long[] {EXPUNGED, uid});
        wake.release();
    }

    @Override
    public void reset() {
        doomed = true;
        selected = null;
        Thread.ofVirtual().start(() -> byeAndClose("Mailbox UIDVALIDITY changed"));
    }

    // ---- commands ----

    private void handle(Command c) throws IOException {
        Tokens t = new Tokens(c);
        String tag;
        try {
            tag = t.word();
        } catch (Bad e) {
            send("* BAD Empty command line");
            return;
        }
        if (tag.indexOf('+') >= 0 || tag.indexOf('*') >= 0 || tag.indexOf('%') >= 0) {
            send("* BAD Invalid tag");
            return;
        }
        String name;
        try {
            t.sp();
            name = t.word().toUpperCase(Locale.ROOT);
            if (name.equals("UID")) {
                t.sp();
                name = "UID " + t.word().toUpperCase(Locale.ROOT);
            }
        } catch (Bad e) {
            send(tag + " BAD Missing command");
            return;
        }
        server.counted(name);
        server.delay();
        if (c.nonSyncRefused()) {
            send(tag + " BAD Non-synchronizing literals aren't supported");
            return;
        }
        String failure = server.takeFailure(name);
        if (failure != null) {
            send(tag + " " + failure);
            return;
        }
        try {
            dispatch(tag, name, t);
        } catch (Bad e) {
            send(tag + " BAD " + e.getMessage());
        }
    }

    private void dispatch(String tag, String name, Tokens t) throws IOException {
        switch (name) {
            case "CAPABILITY" -> {
                t.end();
                send("* CAPABILITY " + capabilities());
                done(tag, "OK Capability completed.", true);
            }
            case "NOOP" -> {
                t.end();
                done(tag, "OK NOOP completed.", true);
            }
            case "LOGOUT" -> {
                t.end();
                send("* BYE Logging out");
                send(tag + " OK Logout completed.");
                flush();
                ending.set(true);
            }
            case "LOGIN" -> login(tag, t);
            case "AUTHENTICATE" -> authenticate(tag, t);
            case "STARTTLS" -> throw new Bad("STARTTLS isn't supported");
            case "ENABLE" -> {
                need(caps.contains(Capability.ENABLE) || caps.contains(Capability.QRESYNC));
                enable(tag, t);
            }
            case "ID" -> {
                need(caps.contains(Capability.ID));
                id(tag, t);
            }
            case "NAMESPACE" -> {
                need(caps.contains(Capability.NAMESPACE));
                requireAuth();
                t.end();
                send("* NAMESPACE ((\"\" \"/\")) NIL NIL");
                done(tag, "OK Namespace completed.", true);
            }
            case "LIST" -> list(tag, t, false);
            case "LSUB" -> list(tag, t, true);
            case "STATUS" -> status(tag, t);
            case "SELECT" -> select(tag, t, false);
            case "EXAMINE" -> select(tag, t, true);
            case "CREATE" -> create(tag, t);
            case "DELETE" -> delete(tag, t);
            case "SUBSCRIBE", "UNSUBSCRIBE" -> {
                requireAuth();
                t.sp();
                t.astring();
                t.end();
                done(tag, "OK " + name.charAt(0) + name.substring(1).toLowerCase(Locale.ROOT) + " completed.", true);
            }
            case "APPEND" -> append(tag, t);
            case "IDLE" -> {
                need(caps.contains(Capability.IDLE));
                idle(tag, t);
            }
            case "CHECK" -> {
                requireSelected();
                t.end();
                done(tag, "OK Check completed.", true);
            }
            case "CLOSE" -> close(tag, t);
            case "UNSELECT" -> {
                requireSelected();
                t.end();
                lockedRun(this::deselectLocked);
                send(tag + " OK Unselect completed.");
            }
            case "EXPUNGE" -> expunge(tag, t, false);
            case "UID EXPUNGE" -> {
                need(caps.contains(Capability.UIDPLUS));
                expunge(tag, t, true);
            }
            case "FETCH" -> fetch(tag, t, false);
            case "UID FETCH" -> fetch(tag, t, true);
            case "STORE" -> store(tag, t, false);
            case "UID STORE" -> store(tag, t, true);
            case "SEARCH" -> search(tag, t, false);
            case "UID SEARCH" -> search(tag, t, true);
            case "COPY" -> copy(tag, t, false, false);
            case "UID COPY" -> copy(tag, t, true, false);
            case "MOVE" -> {
                need(caps.contains(Capability.MOVE));
                copy(tag, t, false, true);
            }
            case "UID MOVE" -> {
                need(caps.contains(Capability.MOVE));
                copy(tag, t, true, true);
            }
            default -> send(tag + " BAD Unknown command " + name);
        }
    }

    private static void need(boolean capability) {
        if (!capability) {
            throw new Bad("Unknown command");
        }
    }

    private void requireAuth() {
        if (state == State.NOT_AUTH) {
            throw new Bad("Not authenticated");
        }
    }

    private void requireSelected() {
        if (state != State.SELECTED || selected == null) {
            throw new Bad("No mailbox selected");
        }
    }

    /** The tagged response, after any changes to tell (EXPUNGEs only if {@code expunges}). */
    private void done(String tag, String text, boolean expunges) throws IOException {
        for (String line : drain(expunges)) {
            send(line);
        }
        send(tag + " " + text);
    }

    String capabilities() {
        List<String> c = new ArrayList<>();
        c.add("IMAP4rev1");
        boolean authed = state != State.NOT_AUTH;
        if (caps.contains(Capability.LITERAL_PLUS)) {
            c.add("LITERAL+");
        }
        if (caps.contains(Capability.SASL_IR) && !authed) {
            c.add("SASL-IR");
        }
        if (caps.contains(Capability.ID)) {
            c.add("ID");
        }
        if (caps.contains(Capability.ENABLE) || caps.contains(Capability.QRESYNC)) {
            c.add("ENABLE");
        }
        if (caps.contains(Capability.IDLE)) {
            c.add("IDLE");
        }
        if (caps.contains(Capability.NAMESPACE)) {
            c.add("NAMESPACE");
        }
        c.add("UNSELECT");
        c.add("CHILDREN");
        if (caps.contains(Capability.UIDPLUS)) {
            c.add("UIDPLUS");
        }
        if (caps.contains(Capability.MOVE)) {
            c.add("MOVE");
        }
        if (condstoreCap()) {
            c.add("CONDSTORE");
        }
        if (caps.contains(Capability.QRESYNC)) {
            c.add("QRESYNC");
        }
        if (caps.contains(Capability.ESEARCH)) {
            c.add("ESEARCH");
        }
        if (caps.contains(Capability.SPECIAL_USE)) {
            c.add("SPECIAL-USE");
        }
        if (caps.contains(Capability.X_GM_EXT_1)) {
            c.add("X-GM-EXT-1");
        }
        if (!authed) {
            if (caps.contains(Capability.AUTH_PLAIN)) {
                c.add("AUTH=PLAIN");
            }
            if (caps.contains(Capability.LOGINDISABLED)) {
                c.add("LOGINDISABLED");
            }
        }
        return String.join(" ", c);
    }

    private boolean condstoreCap() {
        return caps.contains(Capability.CONDSTORE) || caps.contains(Capability.QRESYNC);
    }

    // ---- authentication ----

    private void login(String tag, Tokens t) throws IOException {
        if (state != State.NOT_AUTH) {
            throw new Bad("Already authenticated");
        }
        t.sp();
        String user = t.astring();
        t.sp();
        String pass = t.astring();
        t.end();
        if (caps.contains(Capability.LOGINDISABLED)) {
            send(tag + " NO [PRIVACYREQUIRED] LOGIN is disabled.");
            return;
        }
        authenticated(tag, user, pass);
    }

    private void authenticate(String tag, Tokens t) throws IOException {
        if (state != State.NOT_AUTH) {
            throw new Bad("Already authenticated");
        }
        t.sp();
        String mech = t.word().toUpperCase(Locale.ROOT);
        String initial = null;
        if (!t.atEnd()) {
            t.sp();
            initial = t.word();
        }
        t.end();
        if (!mech.equals("PLAIN") || !caps.contains(Capability.AUTH_PLAIN)) {
            send(tag + " NO [CANNOT] Unsupported authentication mechanism.");
            return;
        }
        if (initial != null && !caps.contains(Capability.SASL_IR)) {
            throw new Bad("SASL-IR isn't supported");
        }
        if (initial == null) {
            send("+ ");
            flush();
            initial = reader.line();
            if (initial == null) {
                throw new IOException("gone");
            }
            if (initial.equals("*")) {
                send(tag + " BAD Authentication cancelled.");
                return;
            }
        }
        byte[] decoded;
        try {
            decoded = initial.equals("=") ? new byte[0] : Base64.getDecoder().decode(initial.trim());
        } catch (IllegalArgumentException e) {
            send(tag + " BAD Invalid base64.");
            return;
        }
        String[] parts = new String(decoded, StandardCharsets.UTF_8).split("\u0000", -1);
        if (parts.length != 3 || (!parts[0].isEmpty() && !parts[0].equals(parts[1]))) {
            send(tag + " NO [AUTHENTICATIONFAILED] Authentication failed.");
            return;
        }
        authenticated(tag, parts[1], parts[2]);
    }

    private void authenticated(String tag, String user, String pass) throws IOException {
        String failure = server.takeLoginFailure();
        if (failure != null) {
            send(tag + " " + failure);
            return;
        }
        int outcome; // 0 ok, 1 bad credentials, 2 too many
        store.lock.lock();
        try {
            ImapStore.Account a = store.account(user);
            if (a == null || !a.password.equals(pass)) {
                outcome = 1;
            } else if (server.maxPerUser() > 0 && a.sessions.size() >= server.maxPerUser()) {
                outcome = 2;
            } else {
                a.sessions.add(this);
                account = a;
                state = State.AUTH;
                outcome = 0;
            }
        } finally {
            store.lock.unlock();
        }
        if (outcome == 1) {
            send(tag + " NO [AUTHENTICATIONFAILED] Authentication failed.");
        } else if (outcome == 2) {
            byeAndClose("Too many simultaneous connections");
        } else {
            server.loggedIn();
            send(tag + " OK [CAPABILITY " + capabilities() + "] Logged in");
        }
    }

    // ---- authenticated state ----

    private void enable(String tag, Tokens t) throws IOException {
        requireAuth();
        List<String> enabled = new ArrayList<>();
        do {
            t.sp();
            String w = t.word().toUpperCase(Locale.ROOT);
            if (w.equals("CONDSTORE") && condstoreCap() && !enabled.contains(w)) {
                condstore = true;
                enabled.add(w);
            } else if (w.equals("QRESYNC") && caps.contains(Capability.QRESYNC) && !enabled.contains(w)) {
                qresync = true;
                condstore = true;
                enabled.add(w);
            }
        } while (!t.atEnd());
        send("* ENABLED" + (enabled.isEmpty() ? "" : " " + String.join(" ", enabled)));
        done(tag, "OK Enabled.", true);
    }

    private void id(String tag, Tokens t) throws IOException {
        t.sp();
        if (t.peek() == '(') {
            t.list();
        } else if (!t.word().equalsIgnoreCase("NIL")) {
            throw new Bad("Expected a list or NIL");
        }
        t.end();
        send("* ID (\"name\" \"FakeImapServer\" \"vendor\" \"courier-testkit\")");
        done(tag, "OK ID completed.", true);
    }

    private String mailboxName(Tokens t) {
        return ImapStore.canonical(ImapWire.decodeMailbox(t.astring()));
    }

    private void list(String tag, Tokens t, boolean lsub) throws IOException {
        requireAuth();
        t.sp();
        boolean specialOnly = false;
        if (t.peek() == '(') {
            for (Object o : t.list()) {
                String opt = word(o).toUpperCase(Locale.ROOT);
                switch (opt) {
                    case "SPECIAL-USE" -> {
                        need(caps.contains(Capability.SPECIAL_USE));
                        specialOnly = true;
                    }
                    case "SUBSCRIBED", "REMOTE", "RECURSIVEMATCH" -> {
                    }
                    default -> throw new Bad("Unknown LIST selection option " + opt);
                }
            }
            t.sp();
        }
        String ref = t.astring();
        t.sp();
        if (t.peek() == '(') {
            throw new Bad("Multiple LIST patterns aren't supported");
        }
        String pattern = t.peek() == '"' || t.atLiteral() ? t.string() : t.word();
        if (!t.atEnd()) {
            t.sp();
            if (!t.word().equalsIgnoreCase("RETURN")) {
                throw new Bad("Expected RETURN");
            }
            t.sp();
            for (Object o : t.list()) {
                String opt = word(o).toUpperCase(Locale.ROOT);
                switch (opt) {
                    case "SPECIAL-USE" -> need(caps.contains(Capability.SPECIAL_USE));
                    case "CHILDREN", "SUBSCRIBED" -> {
                    }
                    default -> throw new Bad("Unknown LIST return option " + opt);
                }
            }
        }
        t.end();
        String verb = lsub ? "LSUB" : "LIST";
        if (pattern.isEmpty()) {
            send("* " + verb + " (\\Noselect) \"/\" \"\"");
            done(tag, "OK " + verb + " completed.", true);
            return;
        }
        String full = ref + pattern;
        if (full.length() >= 5 && full.substring(0, 5).equalsIgnoreCase("INBOX")) {
            full = "INBOX" + full.substring(5);
        }
        List<String> lines = new ArrayList<>();
        store.lock.lock();
        try {
            List<String> names = new ArrayList<>(account.folders.keySet());
            for (Mailbox m : account.folders.values()) {
                String wire = ImapWire.encodeMailbox(m.name);
                if (!matches(full, wire)) {
                    continue;
                }
                if (specialOnly && m.specialUse.isEmpty()) {
                    continue;
                }
                List<String> attrs = new ArrayList<>();
                boolean children = false;
                for (String n : names) {
                    if (n.startsWith(m.name + "/")) {
                        children = true;
                        break;
                    }
                }
                attrs.add(children ? "\\HasChildren" : "\\HasNoChildren");
                if (m.noselect()) {
                    attrs.add("\\Noselect");
                }
                if (caps.contains(Capability.SPECIAL_USE)) {
                    attrs.addAll(m.specialUse);
                }
                lines.add("* " + verb + " " + ImapWire.parenthesized(attrs) + " \"/\" " + ImapWire.mailbox(m.name));
            }
        } finally {
            store.lock.unlock();
        }
        for (String l : lines) {
            send(l);
        }
        done(tag, "OK " + verb + " completed.", true);
    }

    /** LIST's wildcards: {@code *} anything, {@code %} anything but the delimiter. */
    static boolean matches(String pattern, String name) {
        return matches(pattern, 0, name, 0);
    }

    private static boolean matches(String p, int pi, String n, int ni) {
        while (pi < p.length()) {
            char c = p.charAt(pi);
            if (c == '*' || c == '%') {
                for (int k = ni; k <= n.length(); k++) {
                    if (matches(p, pi + 1, n, k)) {
                        return true;
                    }
                    if (k < n.length() && c == '%' && n.charAt(k) == '/') {
                        return false;
                    }
                }
                return false;
            }
            if (ni >= n.length() || n.charAt(ni) != c) {
                return false;
            }
            pi++;
            ni++;
        }
        return ni == n.length();
    }

    private void status(String tag, Tokens t) throws IOException {
        requireAuth();
        t.sp();
        String name = mailboxName(t);
        t.sp();
        List<Object> items = t.list();
        t.end();
        if (items.isEmpty()) {
            throw new Bad("Empty status list");
        }
        String line;
        store.lock.lock();
        try {
            Mailbox m = store.mailbox(account, name);
            if (m == null || m.noselect()) {
                send(tag + " NO [NONEXISTENT] Mailbox doesn't exist: " + name);
                return;
            }
            List<String> parts = new ArrayList<>();
            for (Object o : items) {
                String item = word(o).toUpperCase(Locale.ROOT);
                switch (item) {
                    case "MESSAGES" -> parts.add("MESSAGES " + m.entries.size());
                    case "RECENT" -> parts.add("RECENT 0");
                    case "UIDNEXT" -> parts.add("UIDNEXT " + m.uidNext);
                    case "UIDVALIDITY" -> parts.add("UIDVALIDITY " + m.uidValidity);
                    case "UNSEEN" -> parts.add("UNSEEN " + m.unseen());
                    case "HIGHESTMODSEQ" -> {
                        need(condstoreCap());
                        condstore = true;
                        parts.add("HIGHESTMODSEQ " + m.highestModSeq);
                    }
                    default -> throw new Bad("Unknown status item " + item);
                }
            }
            line = "* STATUS " + ImapWire.mailbox(m.name) + " " + ImapWire.parenthesized(parts);
        } finally {
            store.lock.unlock();
        }
        send(line);
        done(tag, "OK Status completed.", true);
    }

    private void select(String tag, Tokens t, boolean examine) throws IOException {
        requireAuth();
        t.sp();
        String name = mailboxName(t);
        boolean condParam = false;
        long qrValidity = -1;
        long qrModSeq = -1;
        SeqSet known = null;
        if (!t.atEnd()) {
            t.sp();
            List<Object> params = t.list();
            for (int i = 0; i < params.size(); i++) {
                String p = word(params.get(i)).toUpperCase(Locale.ROOT);
                if (p.equals("CONDSTORE")) {
                    need(condstoreCap());
                    condParam = true;
                } else if (p.equals("QRESYNC")) {
                    if (!qresync) {
                        throw new Bad("QRESYNC isn't enabled");
                    }
                    if (i + 1 >= params.size() || !(params.get(i + 1) instanceof List<?> q) || q.size() < 2) {
                        throw new Bad("Invalid QRESYNC parameter");
                    }
                    i++;
                    qrValidity = number(q.get(0));
                    qrModSeq = number(q.get(1));
                    if (q.size() > 2) {
                        known = SeqSet.parse(word(q.get(2)));
                    }
                } else {
                    throw new Bad("Unknown SELECT parameter " + p);
                }
            }
        }
        t.end();
        if (condParam) {
            condstore = true;
        }
        List<String> lines = new ArrayList<>();
        String ok;
        store.lock.lock();
        try {
            if (selected != null) {
                deselectLocked();
                if (caps.contains(Capability.QRESYNC)) {
                    lines.add("* OK [CLOSED] Previous mailbox closed.");
                }
            }
            state = State.AUTH;
            Mailbox m = store.mailbox(account, name);
            if (m == null || m.noselect()) {
                ok = "NO [NONEXISTENT] Mailbox doesn't exist: " + name;
            } else {
                selected = m;
                readOnly = examine;
                m.selectedBy.add(this);
                view.clear();
                for (Entry e : m.entries) {
                    view.add(e.uid);
                }
                pending.clear();
                state = State.SELECTED;
                Set<String> flags = new LinkedHashSet<>(ImapStore.SYSTEM_FLAGS);
                long firstUnseen = 0;
                for (int i = 0; i < m.entries.size(); i++) {
                    Entry e = m.entries.get(i);
                    flags.addAll(e.core.flags);
                    if (firstUnseen == 0 && !e.core.flags.contains("\\Seen")) {
                        firstUnseen = i + 1;
                    }
                }
                lines.add("* FLAGS " + ImapWire.parenthesized(flags));
                lines.add(examine ? "* OK [PERMANENTFLAGS ()] Read-only mailbox."
                    : "* OK [PERMANENTFLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft \\*)] Flags permitted.");
                lines.add("* " + view.size() + " EXISTS");
                lines.add("* 0 RECENT");
                if (firstUnseen > 0) {
                    lines.add("* OK [UNSEEN " + firstUnseen + "] First unseen.");
                }
                lines.add("* OK [UIDVALIDITY " + m.uidValidity + "] UIDs valid");
                lines.add("* OK [UIDNEXT " + m.uidNext + "] Predicted next UID");
                if (condstoreCap()) {
                    lines.add("* OK [HIGHESTMODSEQ " + m.highestModSeq + "] Highest");
                }
                if (qrValidity >= 0 && qrValidity == m.uidValidity) {
                    long star = m.uidNext - 1;
                    List<Long> gone = new ArrayList<>();
                    for (var ts : m.tombstones.entrySet()) {
                        if (ts.getValue() > qrModSeq && (known == null || known.contains(ts.getKey(), star))) {
                            gone.add(ts.getKey());
                        }
                    }
                    if (!gone.isEmpty()) {
                        lines.add("* VANISHED (EARLIER) " + ImapWire.set(gone));
                    }
                    for (int i = 0; i < m.entries.size(); i++) {
                        Entry e = m.entries.get(i);
                        if (e.modSeq > qrModSeq) {
                            lines.add("* " + (i + 1) + " FETCH (UID " + e.uid + " FLAGS " + ImapWire.parenthesized(e.core.flags)
                                + " MODSEQ (" + e.modSeq + "))");
                        }
                    }
                }
                ok = "OK [" + (examine ? "READ-ONLY" : "READ-WRITE") + "] " + (examine ? "EXAMINE" : "SELECT") + " completed.";
            }
        } finally {
            store.lock.unlock();
        }
        for (String l : lines) {
            send(l);
        }
        send(tag + " " + ok);
    }

    private void deselectLocked() {
        if (selected != null) {
            selected.selectedBy.remove(this);
        }
        selected = null;
        view.clear();
        pending.clear();
        if (state == State.SELECTED) {
            state = State.AUTH;
        }
    }

    private void create(String tag, Tokens t) throws IOException {
        requireAuth();
        t.sp();
        String name = mailboxName(t);
        t.end();
        while (name.endsWith("/")) {
            name = name.substring(0, name.length() - 1);
        }
        String result;
        store.lock.lock();
        try {
            Mailbox m = store.mailbox(account, name);
            if (m != null && !m.noselect()) {
                result = "NO [ALREADYEXISTS] Mailbox already exists.";
            } else if (name.isEmpty() || name.contains("//")) {
                result = "NO [CANNOT] Invalid mailbox name.";
            } else {
                store.create(account, name, Set.of());
                result = "OK Create completed.";
            }
        } finally {
            store.lock.unlock();
        }
        done(tag, result, true);
    }

    private void delete(String tag, Tokens t) throws IOException {
        requireAuth();
        t.sp();
        String name = mailboxName(t);
        t.end();
        String result;
        store.lock.lock();
        try {
            Mailbox m = store.mailbox(account, name);
            if (m == null) {
                result = "NO [NONEXISTENT] Mailbox doesn't exist.";
            } else if (m.name.equals(ImapStore.INBOX)
                || (store.gmail && (m.kind != ImapStore.Kind.VIEW || ImapStore.SYSTEM_LABELS.contains(m.label)))) {
                result = "NO [CANNOT] Can't delete that mailbox.";
            } else {
                if (m == selected) {
                    deselectLocked();
                }
                store.delete(m);
                result = "OK Delete completed.";
            }
        } finally {
            store.lock.unlock();
        }
        done(tag, result, true);
    }

    private void append(String tag, Tokens t) throws IOException {
        requireAuth();
        t.sp();
        String name = mailboxName(t);
        t.sp();
        List<String> flags = new ArrayList<>();
        OffsetDateTime date = null;
        if (t.peek() == '(') {
            for (Object o : t.list()) {
                flags.add(word(o));
            }
            t.sp();
        }
        if (t.peek() == '"') {
            date = ImapWire.parseDateTime(t.quoted());
            t.sp();
        }
        if (!t.atLiteral()) {
            throw new Bad("Expected a literal");
        }
        byte[] msg = t.literalBytes();
        t.end();
        String result;
        store.lock.lock();
        try {
            Mailbox m = store.mailbox(account, name);
            if (m == null) {
                result = "NO [TRYCREATE] Mailbox doesn't exist: " + name;
            } else if (m.noselect()) {
                result = "NO [CANNOT] Mailbox can't hold messages: " + name;
            } else {
                OffsetDateTime when = date != null ? date : OffsetDateTime.now(ZoneOffset.UTC);
                Entry e = store.append(m, msg, null, msg.length, when, flags, List.of());
                account.appended.add(new FakeImapServer.Appended(m.name, e.uid, e.core.flags, e.core.internalDate.toInstant(), msg));
                result = "OK " + (caps.contains(Capability.UIDPLUS) ? "[APPENDUID " + m.uidValidity + " " + e.uid + "] " : "") + "Append completed.";
            }
        } finally {
            store.lock.unlock();
        }
        done(tag, result, true);
    }

    private void idle(String tag, Tokens t) throws IOException {
        requireAuth();
        t.end();
        send("+ idling");
        flush();
        idleStop = false;
        wake.drainPermits();
        long byeAfter = server.idleByeMillis();
        Thread pusher = Thread.ofVirtual().name("fake-imap-idle").start(() -> pushWhileIdle(byeAfter));
        String line;
        try {
            line = reader.line();
        } finally {
            idleStop = true;
            wake.release();
            try {
                pusher.join();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
        if (line == null) {
            throw new IOException("gone");
        }
        if (!line.trim().equalsIgnoreCase("DONE")) {
            send(tag + " BAD Expected DONE");
            return;
        }
        done(tag, "OK Idle completed.", true);
    }

    private void pushWhileIdle(long byeAfter) {
        long deadline = byeAfter > 0 ? System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(byeAfter) : Long.MAX_VALUE;
        try {
            while (!idleStop && !ending.get()) {
                List<String> lines = drain(true);
                if (!lines.isEmpty()) {
                    for (String l : lines) {
                        send(l);
                    }
                    flush();
                }
                long wait = deadline - System.nanoTime();
                if (byeAfter > 0 && wait <= 0) {
                    byeAndClose("IDLE timed out");
                    return;
                }
                wake.tryAcquire(Math.min(wait, TimeUnit.SECONDS.toNanos(3600)), TimeUnit.NANOSECONDS);
                wake.drainPermits();
            }
        } catch (IOException | InterruptedException e) {
            drop();
        }
    }

    // ---- selected state ----

    private void close(String tag, Tokens t) throws IOException {
        requireSelected();
        t.end();
        store.lock.lock();
        try {
            if (!readOnly) {
                store.expungeDeleted(selected, null, this);
            }
            deselectLocked();
        } finally {
            store.lock.unlock();
        }
        send(tag + " OK Close completed.");
    }

    private void expunge(String tag, Tokens t, boolean uid) throws IOException {
        requireSelected();
        SeqSet set = null;
        if (uid) {
            t.sp();
            set = SeqSet.parse(t.word());
        }
        t.end();
        if (readOnly) {
            done(tag, "NO [READ-ONLY] Mailbox is read-only.", true);
            return;
        }
        long highest;
        store.lock.lock();
        try {
            Set<Long> only = null;
            if (set != null) {
                only = new java.util.HashSet<>();
                for (int i : resolve(set, true)) {
                    only.add(view.get(i));
                }
            }
            store.expungeDeleted(selected, only, this);
            highest = selected.highestModSeq;
        } finally {
            store.lock.unlock();
        }
        done(tag, "OK " + (qresync ? "[HIGHESTMODSEQ " + highest + "] " : "") + "Expunge completed.", true);
    }

    /** Indexes into the view named by a sequence set (message numbers, or UIDs). */
    private List<Integer> resolve(SeqSet set, boolean uid) {
        List<Integer> out = new ArrayList<>();
        int n = view.size();
        if (!uid) {
            if (n == 0 || set.max(n) > n) {
                throw new Bad("Invalid messageset");
            }
            for (int i = 0; i < n; i++) {
                if (set.contains(i + 1, n)) {
                    out.add(i);
                }
            }
            return out;
        }
        if (n == 0) {
            return out;
        }
        long star = view.get(n - 1);
        for (int i = 0; i < n; i++) {
            if (set.contains(view.get(i), star)) {
                out.add(i);
            }
        }
        return out;
    }

    /** A FETCH item. Body items carry their section ("" for all, HEADER, TEXT, HEADER.FIELDS[.NOT]) and partial. */
    private record Att(String name, String section, List<String> fields, boolean not, boolean peek, long start, long length, String response) {
        boolean body() {
            return section != null;
        }
    }

    private List<Att> attributes(List<String> words) {
        List<Att> out = new ArrayList<>();
        for (String w : words) {
            String u = w.toUpperCase(Locale.ROOT);
            switch (u) {
                case "FAST" -> {
                    out.add(simple("FLAGS"));
                    out.add(simple("INTERNALDATE"));
                    out.add(simple("RFC822.SIZE"));
                }
                case "UID", "FLAGS", "RFC822.SIZE", "INTERNALDATE", "MODSEQ" -> out.add(simple(u));
                case "X-GM-MSGID", "X-GM-THRID", "X-GM-LABELS" -> {
                    if (!store.gmail) {
                        throw new Bad("Unknown fetch attribute " + w);
                    }
                    out.add(simple(u));
                }
                case "RFC822" -> out.add(new Att("BODY", "", List.of(), false, false, -1, -1, "RFC822"));
                case "RFC822.HEADER" -> out.add(new Att("BODY", "HEADER", List.of(), false, true, -1, -1, "RFC822.HEADER"));
                case "RFC822.TEXT" -> out.add(new Att("BODY", "TEXT", List.of(), false, false, -1, -1, "RFC822.TEXT"));
                case "ALL", "FULL", "ENVELOPE", "BODY", "BODYSTRUCTURE" ->
                    throw new Bad(u + " isn't supported by FakeImapServer");
                default -> {
                    boolean peek;
                    int open;
                    if (u.startsWith("BODY.PEEK[")) {
                        peek = true;
                        open = 9;
                    } else if (u.startsWith("BODY[")) {
                        peek = false;
                        open = 4;
                    } else {
                        throw new Bad("Unknown fetch attribute " + w);
                    }
                    int close = w.lastIndexOf(']');
                    if (close < open) {
                        throw new Bad("Invalid section in " + w);
                    }
                    String section = w.substring(open + 1, close);
                    String rest = w.substring(close + 1);
                    long start = -1;
                    long length = -1;
                    if (!rest.isEmpty()) {
                        if (!rest.startsWith("<") || !rest.endsWith(">") || rest.indexOf('.') < 0) {
                            throw new Bad("Invalid partial in " + w);
                        }
                        String[] p = rest.substring(1, rest.length() - 1).split("\\.");
                        try {
                            start = Long.parseLong(p[0]);
                            length = Long.parseLong(p[1]);
                        } catch (NumberFormatException | ArrayIndexOutOfBoundsException e) {
                            throw new Bad("Invalid partial in " + w);
                        }
                    }
                    String us = section.toUpperCase(Locale.ROOT);
                    List<String> fields = List.of();
                    boolean not = false;
                    String kind;
                    if (us.isEmpty() || us.equals("HEADER") || us.equals("TEXT")) {
                        kind = us;
                    } else if (us.startsWith("HEADER.FIELDS.NOT ") || us.startsWith("HEADER.FIELDS ")) {
                        not = us.startsWith("HEADER.FIELDS.NOT ");
                        kind = "FIELDS";
                        String list = section.substring(section.indexOf(' ') + 1).trim();
                        if (!list.startsWith("(") || !list.endsWith(")")) {
                            throw new Bad("Invalid header list in " + w);
                        }
                        fields = new ArrayList<>();
                        for (String f : list.substring(1, list.length() - 1).trim().split("\\s+")) {
                            if (!f.isEmpty()) {
                                fields.add(f.replace("\"", ""));
                            }
                        }
                        if (fields.isEmpty()) {
                            throw new Bad("Empty header list in " + w);
                        }
                    } else {
                        throw new Bad("Section " + section + " isn't supported by FakeImapServer");
                    }
                    String response = "BODY[" + section + "]" + (start >= 0 ? "<" + start + ">" : "");
                    out.add(new Att("BODY", kind, fields, not, peek, start, length, response));
                }
            }
        }
        return out;
    }

    private static Att simple(String name) {
        return new Att(name, null, List.of(), false, false, -1, -1, name);
    }

    /** What phase one of a FETCH keeps of a message, under the lock, for phase two to write without it. */
    private record Row(int seq, long uid, long modSeq, Set<String> flags, Set<String> labels, ImapStore.Core core, boolean seenNow) {
    }

    private void fetch(String tag, Tokens t, boolean uid) throws IOException {
        requireSelected();
        t.sp();
        SeqSet set = SeqSet.parse(t.word());
        t.sp();
        List<String> words = new ArrayList<>();
        if (t.peek() == '(') {
            for (Object o : t.list()) {
                words.add(word(o));
            }
        } else {
            words.add(t.word());
        }
        Long changedSince = null;
        boolean vanishedMod = false;
        if (!t.atEnd()) {
            t.sp();
            List<Object> mods = t.list();
            for (int i = 0; i < mods.size(); i++) {
                String m = word(mods.get(i)).toUpperCase(Locale.ROOT);
                if (m.equals("CHANGEDSINCE") && i + 1 < mods.size()) {
                    need(condstoreCap());
                    changedSince = number(mods.get(++i));
                } else if (m.equals("VANISHED")) {
                    vanishedMod = true;
                } else {
                    throw new Bad("Unknown FETCH modifier " + m);
                }
            }
        }
        t.end();
        if (vanishedMod && (!uid || !qresync || changedSince == null)) {
            throw new Bad("VANISHED needs UID FETCH, CHANGEDSINCE and QRESYNC enabled");
        }
        List<Att> atts = attributes(words);
        boolean wantsModSeq = changedSince != null;
        for (Att a : atts) {
            if (a.name().equals("MODSEQ")) {
                need(condstoreCap());
                wantsModSeq = true;
            }
        }
        if (wantsModSeq) {
            condstore = true;
        }
        boolean markSeen = !readOnly && atts.stream().anyMatch(a -> a.body() && !a.peek());
        List<Row> rows = new ArrayList<>();
        String vanishedLine = null;
        store.lock.lock();
        try {
            for (int i : resolve(set, uid)) {
                Entry e = selected.get(view.get(i));
                if (e == null) {
                    continue;
                }
                if (changedSince != null && e.modSeq <= changedSince) {
                    continue;
                }
                boolean seenNow = false;
                if (markSeen && !e.core.flags.contains("\\Seen")) {
                    List<String> f = new ArrayList<>(e.core.flags);
                    f.add("\\Seen");
                    store.setFlags(selected, e, f, this);
                    seenNow = true;
                }
                rows.add(new Row(i + 1, e.uid, e.modSeq, e.core.flags, e.core.labels, e.core, seenNow));
            }
            if (vanishedMod) {
                long star = selected.uidNext - 1;
                List<Long> gone = new ArrayList<>();
                for (var ts : selected.tombstones.entrySet()) {
                    if (ts.getValue() > changedSince && set.contains(ts.getKey(), star)) {
                        gone.add(ts.getKey());
                    }
                }
                if (!gone.isEmpty()) {
                    vanishedLine = "* VANISHED (EARLIER) " + ImapWire.set(gone);
                }
            }
        } finally {
            store.lock.unlock();
        }
        if (vanishedLine != null) {
            send(vanishedLine);
        }
        for (Row r : rows) {
            writeFetch(r, atts, uid, changedSince != null);
        }
        done(tag, "OK Fetch completed.", uid);
    }

    private void writeFetch(Row r, List<Att> atts, boolean uid, boolean changedSince) throws IOException {
        FetchLine line = new FetchLine(r.seq());
        Set<String> done = new java.util.HashSet<>();
        boolean flags = false;
        boolean modseq = false;
        if (uid || atts.stream().anyMatch(a -> a.name().equals("UID"))) {
            line.item("UID " + r.uid());
            done.add("UID");
        }
        byte[] content = null;
        for (Att a : atts) {
            if (!done.add(a.body() ? a.response() : a.name())) {
                continue;
            }
            switch (a.name()) {
                case "FLAGS" -> {
                    line.item("FLAGS " + ImapWire.parenthesized(r.flags()));
                    flags = true;
                }
                case "RFC822.SIZE" -> line.item("RFC822.SIZE " + r.core().size);
                case "INTERNALDATE" -> line.item("INTERNALDATE \"" + ImapWire.INTERNALDATE.format(r.core().internalDate) + "\"");
                case "MODSEQ" -> {
                    line.item("MODSEQ (" + r.modSeq() + ")");
                    modseq = true;
                }
                case "X-GM-MSGID" -> line.item("X-GM-MSGID " + r.core().gmMsgId);
                case "X-GM-THRID" -> line.item("X-GM-THRID " + r.core().gmThrId);
                case "X-GM-LABELS" -> line.item("X-GM-LABELS " + labels(r.labels()));
                case "BODY" -> {
                    if (content == null) {
                        content = r.core().bytes();
                    }
                    byte[] part = section(content, a);
                    if (a.start() >= 0) {
                        int from = (int) Math.min(a.start(), part.length);
                        int to = (int) Math.min((long) from + a.length(), part.length);
                        part = Arrays.copyOfRange(part, from, to);
                    }
                    line.literal(a.response(), part);
                }
                default -> {
                }
            }
        }
        if (r.seenNow() && !flags) {
            line.item("FLAGS " + ImapWire.parenthesized(r.flags()));
            flags = true;
        }
        if (condstore && (flags || changedSince) && !modseq) {
            line.item("MODSEQ (" + r.modSeq() + ")");
        }
        write(line.finish(), true);
    }

    /** One FETCH response being built: its items, each body a literal of its exact bytes. */
    private static final class FetchLine {
        private final ByteArrayOutputStream buf = new ByteArrayOutputStream();
        private boolean first = true;

        FetchLine(int seq) {
            buf.writeBytes(("* " + seq + " FETCH (").getBytes(StandardCharsets.US_ASCII));
        }

        void item(String text) {
            if (!first) {
                buf.write(' ');
            }
            first = false;
            buf.writeBytes(text.getBytes(StandardCharsets.UTF_8));
        }

        void literal(String name, byte[] bytes) {
            item(name + " {" + bytes.length + "}\r\n");
            buf.writeBytes(bytes);
        }

        byte[] finish() {
            buf.write(')');
            return buf.toByteArray();
        }
    }

    private static String labels(Set<String> labels) {
        List<String> out = new ArrayList<>();
        for (String l : labels) {
            String wire = ImapWire.encodeMailbox(l);
            out.add(l.startsWith("\\") ? ImapWire.quote(wire) : ImapWire.astring(wire));
        }
        return ImapWire.parenthesized(out);
    }

    /** A body section's bytes: all, the header (with its blank line), the text, or some header fields and a blank line. */
    static byte[] section(byte[] msg, Att a) {
        int split = headerEnd(msg);
        return switch (a.section()) {
            case "" -> msg;
            case "HEADER" -> Arrays.copyOfRange(msg, 0, split);
            case "TEXT" -> Arrays.copyOfRange(msg, split, msg.length);
            default -> headerFields(msg, split, a.fields(), a.not());
        };
    }

    /** Where the body starts: after the first empty line, or the end if there's none. */
    static int headerEnd(byte[] m) {
        int i = 0;
        while (i < m.length) {
            int eol = indexOf(m, (byte) '\n', i);
            if (eol < 0) {
                return m.length;
            }
            int lineLen = eol - i;
            if (lineLen == 0 || (lineLen == 1 && m[i] == '\r')) {
                return eol + 1;
            }
            i = eol + 1;
        }
        return m.length;
    }

    private static int indexOf(byte[] b, byte v, int from) {
        for (int i = from; i < b.length; i++) {
            if (b[i] == v) {
                return i;
            }
        }
        return -1;
    }

    /** The header's fields (each with its continuation lines) whose names are (or, with {@code not}, aren't) listed, then CRLF. */
    static byte[] headerFields(byte[] m, int split, List<String> names, boolean not) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        int i = 0;
        boolean keep = false;
        while (i < split) {
            int eol = indexOf(m, (byte) '\n', i);
            int end = eol < 0 || eol >= split ? split : eol + 1;
            int lineLen = end - i;
            boolean blank = lineLen == 0 || (m[i] == '\n') || (m[i] == '\r' && lineLen <= 2);
            if (blank) {
                break;
            }
            if (m[i] == ' ' || m[i] == '\t') {
                if (keep) {
                    out.write(m, i, lineLen);
                }
            } else {
                int colon = indexOf(m, (byte) ':', i);
                String name = colon < 0 || colon >= end ? "" : new String(m, i, colon - i, StandardCharsets.ISO_8859_1).trim();
                boolean listed = false;
                for (String n : names) {
                    if (n.equalsIgnoreCase(name)) {
                        listed = true;
                        break;
                    }
                }
                keep = !name.isEmpty() && (listed != not);
                if (keep) {
                    out.write(m, i, lineLen);
                }
            }
            i = end;
        }
        out.write('\r');
        out.write('\n');
        return out.toByteArray();
    }

    /** A header field's values, unfolded, for SEARCH. */
    static List<String> headerValues(byte[] m, String name) {
        int split = headerEnd(m);
        String header = new String(m, 0, split, StandardCharsets.ISO_8859_1).replaceAll("\r?\n[ \t]", " ");
        List<String> out = new ArrayList<>();
        for (String line : header.split("\r?\n")) {
            int colon = line.indexOf(':');
            if (colon > 0 && line.substring(0, colon).trim().equalsIgnoreCase(name)) {
                out.add(utf8(line.substring(colon + 1).trim()));
            }
        }
        return out;
    }

    private static String utf8(String latin1) {
        return new String(latin1.getBytes(StandardCharsets.ISO_8859_1), StandardCharsets.UTF_8);
    }

    private void store(String tag, Tokens t, boolean uid) throws IOException {
        requireSelected();
        t.sp();
        SeqSet set = SeqSet.parse(t.word());
        t.sp();
        Long unchangedSince = null;
        if (t.peek() == '(') {
            List<Object> mods = t.list();
            if (mods.size() != 2 || !word(mods.get(0)).equalsIgnoreCase("UNCHANGEDSINCE")) {
                throw new Bad("Unknown STORE modifier");
            }
            need(condstoreCap());
            unchangedSince = number(mods.get(1));
            condstore = true;
            t.sp();
        }
        String item = t.word().toUpperCase(Locale.ROOT);
        t.sp();
        boolean silent = item.endsWith(".SILENT");
        String base = silent ? item.substring(0, item.length() - 7) : item;
        char op = base.startsWith("+") ? '+' : base.startsWith("-") ? '-' : '=';
        String what = op == '=' ? base : base.substring(1);
        boolean labelsOp;
        if (what.equals("FLAGS")) {
            labelsOp = false;
        } else if (what.equals("X-GM-LABELS") && store.gmail) {
            labelsOp = true;
        } else {
            throw new Bad("Unknown STORE item " + item);
        }
        List<String> values = new ArrayList<>();
        if (t.peek() == '(') {
            for (Object o : t.list()) {
                values.add(word(o));
            }
        } else {
            values.add(labelsOp ? t.astring() : t.word());
            while (t.skip(' ')) {
                values.add(labelsOp ? t.astring() : t.word());
            }
        }
        t.end();
        if (labelsOp) {
            values.replaceAll(ImapWire::decodeMailbox);
        }
        if (readOnly) {
            done(tag, "NO [READ-ONLY] Mailbox is read-only.", uid);
            return;
        }
        List<String> lines = new ArrayList<>();
        TreeSet<Long> modified = new TreeSet<>();
        store.lock.lock();
        try {
            for (int i : resolve(set, uid)) {
                Entry e = selected.get(view.get(i));
                if (e == null) {
                    continue;
                }
                if (unchangedSince != null && e.modSeq > unchangedSince) {
                    modified.add(uid ? e.uid : i + 1);
                    continue;
                }
                Set<String> current = labelsOp ? e.core.labels : e.core.flags;
                List<String> next = new ArrayList<>();
                switch (op) {
                    case '+' -> {
                        next.addAll(current);
                        next.addAll(values);
                    }
                    case '-' -> {
                        for (String c : current) {
                            boolean drop = false;
                            for (String v : values) {
                                if (v.equalsIgnoreCase(c) || (labelsOp && ImapStore.labels(List.of(v)).contains(c))) {
                                    drop = true;
                                    break;
                                }
                            }
                            if (!drop) {
                                next.add(c);
                            }
                        }
                    }
                    default -> next.addAll(values);
                }
                boolean changed = labelsOp ? store.setLabels(selected, e, next, this) : store.setFlags(selected, e, next, this);
                StringBuilder b = new StringBuilder("* ").append(i + 1).append(" FETCH (");
                List<String> items = new ArrayList<>();
                if (uid) {
                    items.add("UID " + e.uid);
                }
                if (!silent) {
                    if (labelsOp) {
                        items.add("X-GM-LABELS " + labels(e.core.labels));
                    } else {
                        items.add("FLAGS " + ImapWire.parenthesized(e.core.flags));
                    }
                }
                if (condstore && (!silent || changed)) {
                    items.add("MODSEQ (" + e.modSeq + ")");
                }
                if (!silent || (condstore && changed)) {
                    if (!uid && silent) {
                        items.add(0, "UID " + e.uid);
                    }
                    lines.add(b.append(String.join(" ", items)).append(")").toString());
                }
            }
        } finally {
            store.lock.unlock();
        }
        for (String l : lines) {
            send(l);
        }
        done(tag, modified.isEmpty() ? "OK Store completed." : "OK [MODIFIED " + ImapWire.set(modified) + "] Conditional STORE failed.", uid);
    }

    private void copy(String tag, Tokens t, boolean uid, boolean move) throws IOException {
        requireSelected();
        t.sp();
        SeqSet set = SeqSet.parse(t.word());
        t.sp();
        String name = mailboxName(t);
        t.end();
        if (move && readOnly) {
            done(tag, "NO [READ-ONLY] Mailbox is read-only.", uid);
            return;
        }
        List<long[]> pairs;
        long validity;
        long highest;
        store.lock.lock();
        try {
            Mailbox dst = store.mailbox(account, name);
            if (dst == null || dst.noselect()) {
                pairs = null;
                validity = 0;
                highest = 0;
            } else {
                List<Entry> entries = new ArrayList<>();
                for (int i : resolve(set, uid)) {
                    Entry e = selected.get(view.get(i));
                    if (e != null) {
                        entries.add(e);
                    }
                }
                pairs = move ? store.move(selected, entries, dst, this) : store.copy(selected, entries, dst, this);
                validity = dst.uidValidity;
                highest = selected.highestModSeq;
            }
        } finally {
            store.lock.unlock();
        }
        if (pairs == null) {
            done(tag, "NO [TRYCREATE] Mailbox doesn't exist: " + name, uid || move);
            return;
        }
        String copyuid = "";
        if (caps.contains(Capability.UIDPLUS) && !pairs.isEmpty()) {
            List<Long> src = new ArrayList<>();
            List<Long> dst = new ArrayList<>();
            for (long[] p : pairs) {
                src.add(p[0]);
                dst.add(p[1]);
            }
            copyuid = "[COPYUID " + validity + " " + ImapWire.set(src) + " " + ImapWire.set(dst) + "] ";
        }
        if (!move) {
            done(tag, "OK " + copyuid + "Copy completed.", uid);
            return;
        }
        if (!copyuid.isEmpty()) {
            send("* OK " + copyuid + "Moved UIDs.");
        }
        done(tag, "OK " + (qresync ? "[HIGHESTMODSEQ " + highest + "] " : "") + "Move completed.", true);
    }

    // ---- SEARCH ----

    private interface Key {
        boolean test(int seq, Entry e);
    }

    private final class SearchContext {
        boolean modseq;
    }

    private void search(String tag, Tokens t, boolean uid) throws IOException {
        requireSelected();
        t.sp();
        List<String> ret = null;
        if (t.peekWord().equalsIgnoreCase("RETURN")) {
            need(caps.contains(Capability.ESEARCH));
            t.word();
            t.sp();
            ret = new ArrayList<>();
            for (Object o : t.list()) {
                String r = word(o).toUpperCase(Locale.ROOT);
                if (!List.of("MIN", "MAX", "COUNT", "ALL").contains(r)) {
                    throw new Bad("Unknown RETURN option " + r);
                }
                if (!ret.contains(r)) {
                    ret.add(r);
                }
            }
            if (ret.isEmpty()) {
                ret.add("ALL");
            }
            t.sp();
        }
        if (t.peekWord().equalsIgnoreCase("CHARSET")) {
            t.word();
            t.sp();
            String cs = t.astring();
            if (!cs.equalsIgnoreCase("UTF-8") && !cs.equalsIgnoreCase("US-ASCII")) {
                done(tag, "NO [BADCHARSET (UTF-8 US-ASCII)] Unsupported charset.", uid);
                return;
            }
            t.sp();
        }
        SearchContext ctx = new SearchContext();
        List<Key> keys = new ArrayList<>();
        do {
            keys.add(key(t, ctx));
        } while (t.skip(' '));
        t.end();
        Key all = and(keys);
        if (ctx.modseq) {
            condstore = true;
        }
        List<Long> results = new ArrayList<>();
        long maxModSeq = 0;
        store.lock.lock();
        try {
            for (int i = 0; i < view.size(); i++) {
                Entry e = selected.get(view.get(i));
                if (e != null && all.test(i + 1, e)) {
                    results.add(uid ? e.uid : i + 1);
                    maxModSeq = Math.max(maxModSeq, e.modSeq);
                }
            }
        } finally {
            store.lock.unlock();
        }
        if (ret == null) {
            StringBuilder b = new StringBuilder("* SEARCH");
            for (long r : results) {
                b.append(' ').append(r);
            }
            if (ctx.modseq && !results.isEmpty()) {
                b.append(" (MODSEQ ").append(maxModSeq).append(')');
            }
            send(b.toString());
        } else {
            StringBuilder b = new StringBuilder("* ESEARCH (TAG \"").append(tag).append("\")");
            if (uid) {
                b.append(" UID");
            }
            for (String r : ret) {
                switch (r) {
                    case "MIN" -> {
                        if (!results.isEmpty()) {
                            b.append(" MIN ").append(results.get(0));
                        }
                    }
                    case "MAX" -> {
                        if (!results.isEmpty()) {
                            b.append(" MAX ").append(results.get(results.size() - 1));
                        }
                    }
                    case "COUNT" -> b.append(" COUNT ").append(results.size());
                    default -> {
                        if (!results.isEmpty()) {
                            b.append(" ALL ").append(ImapWire.set(results));
                        }
                    }
                }
            }
            if (ctx.modseq && !results.isEmpty()) {
                b.append(" MODSEQ ").append(maxModSeq);
            }
            send(b.toString());
        }
        done(tag, "OK Search completed.", uid);
    }

    private static Key and(List<Key> keys) {
        return (seq, e) -> {
            for (Key k : keys) {
                if (!k.test(seq, e)) {
                    return false;
                }
            }
            return true;
        };
    }

    private static Key flag(String f, boolean set) {
        return (seq, e) -> ImapStore.hasFlag(e.core.flags, f) == set;
    }

    private Key key(Tokens t, SearchContext ctx) {
        if (t.skip('(')) {
            List<Key> inner = new ArrayList<>();
            do {
                inner.add(key(t, ctx));
            } while (t.skip(' '));
            t.expect(')');
            return and(inner);
        }
        String w = t.word();
        String u = w.toUpperCase(Locale.ROOT);
        switch (u) {
            case "ALL", "OLD" -> {
                return (seq, e) -> true;
            }
            case "NEW", "RECENT" -> {
                return (seq, e) -> false;
            }
            case "ANSWERED", "DELETED", "DRAFT", "FLAGGED", "SEEN" -> {
                return flag("\\" + u.charAt(0) + u.substring(1).toLowerCase(Locale.ROOT), true);
            }
            case "UNANSWERED", "UNDELETED", "UNDRAFT", "UNFLAGGED", "UNSEEN" -> {
                return flag("\\" + u.charAt(2) + u.substring(3).toLowerCase(Locale.ROOT), false);
            }
            case "KEYWORD", "UNKEYWORD" -> {
                t.sp();
                return flag(t.word(), u.equals("KEYWORD"));
            }
            case "BEFORE", "ON", "SINCE" -> {
                t.sp();
                LocalDate d = ImapWire.parseDate(t.astring());
                return (seq, e) -> {
                    LocalDate m = e.core.internalDate.toLocalDate();
                    return u.equals("BEFORE") ? m.isBefore(d) : u.equals("ON") ? m.isEqual(d) : !m.isBefore(d);
                };
            }
            case "LARGER", "SMALLER" -> {
                t.sp();
                long n = t.number();
                return (seq, e) -> u.equals("LARGER") ? e.core.size > n : e.core.size < n;
            }
            case "UID" -> {
                t.sp();
                SeqSet s = SeqSet.parse(t.word());
                long star = view.size() == 0 ? 0 : view.get(view.size() - 1);
                return (seq, e) -> s.contains(e.uid, star);
            }
            case "NOT" -> {
                t.sp();
                Key k = key(t, ctx);
                return (seq, e) -> !k.test(seq, e);
            }
            case "OR" -> {
                t.sp();
                Key a = key(t, ctx);
                t.sp();
                Key b = key(t, ctx);
                return (seq, e) -> a.test(seq, e) || b.test(seq, e);
            }
            case "HEADER" -> {
                t.sp();
                String field = t.astring();
                t.sp();
                return header(field, t.astring());
            }
            case "FROM", "TO", "CC", "BCC", "SUBJECT" -> {
                t.sp();
                return header(u, t.astring());
            }
            case "BODY", "TEXT" -> {
                t.sp();
                String needle = t.astring().toLowerCase(Locale.ROOT);
                return (seq, e) -> {
                    byte[] m = e.core.bytes();
                    int from = u.equals("BODY") ? headerEnd(m) : 0;
                    return new String(m, from, m.length - from, StandardCharsets.UTF_8).toLowerCase(Locale.ROOT).contains(needle);
                };
            }
            case "MODSEQ" -> {
                need(condstoreCap());
                t.sp();
                if (t.peek() == '"') {
                    t.quoted();
                    t.sp();
                    t.word();
                    t.sp();
                }
                long n = t.number();
                ctx.modseq = true;
                return (seq, e) -> e.modSeq >= n;
            }
            case "X-GM-MSGID", "X-GM-THRID" -> {
                if (!store.gmail) {
                    throw new Bad("Unknown search key " + w);
                }
                t.sp();
                long n = t.number();
                return (seq, e) -> (u.equals("X-GM-MSGID") ? e.core.gmMsgId : e.core.gmThrId) == n;
            }
            case "X-GM-LABELS" -> {
                if (!store.gmail) {
                    throw new Bad("Unknown search key " + w);
                }
                t.sp();
                Set<String> want = ImapStore.labels(List.of(ImapWire.decodeMailbox(t.astring())));
                return (seq, e) -> e.core.labels.containsAll(want);
            }
            default -> {
                if (SeqSet.looksLike(w)) {
                    SeqSet s = SeqSet.parse(w);
                    int n = view.size();
                    return (seq, e) -> s.contains(seq, n);
                }
                throw new Bad("Unknown search key " + w);
            }
        }
    }

    private static Key header(String field, String value) {
        String needle = value.toLowerCase(Locale.ROOT);
        Predicate<String> match = v -> v.toLowerCase(Locale.ROOT).contains(needle);
        return (seq, e) -> headerValues(e.core.bytes(), field).stream().anyMatch(match);
    }

    // ---- pushed changes ----

    private List<String> drain(boolean expunges) {
        store.lock.lock();
        try {
            return drainLocked(expunges);
        } finally {
            store.lock.unlock();
        }
    }

    /**
     * What to tell of changes to the selected folder, in order. Without {@code expunges} (during FETCH, STORE and SEARCH
     * by message number, as RFC 3501 section 7.4.1 requires) expunges wait in the queue, and message numbers stay as the
     * client knows them, the expunged messages still counted.
     */
    private List<String> drainLocked(boolean expunges) {
        List<String> lines = new ArrayList<>();
        if (selected == null) {
            pending.clear();
            return lines;
        }
        boolean exists = false;
        List<Long> vanished = new ArrayList<>();
        ArrayDeque<long[]> kept = new ArrayDeque<>();
        while (!pending.isEmpty()) {
            long[] ev = pending.poll();
            if (ev[0] == EXPUNGED) {
                if (!expunges) {
                    kept.add(ev);
                    continue;
                }
                if (exists) {
                    lines.add("* " + view.size() + " EXISTS");
                    exists = false;
                }
                int i = view.indexOf(ev[1]);
                if (i >= 0) {
                    view.removeAt(i);
                    if (qresync) {
                        vanished.add(ev[1]);
                    } else {
                        lines.add("* " + (i + 1) + " EXPUNGE");
                    }
                }
                continue;
            }
            if (!vanished.isEmpty()) {
                lines.add("* VANISHED " + ImapWire.set(vanished));
                vanished.clear();
            }
            if (ev[0] == EXISTS) {
                view.add(ev[1]);
                exists = true;
                continue;
            }
            int i = view.indexOf(ev[1]);
            Entry e = selected.get(ev[1]);
            if (i >= 0 && e != null) {
                if (exists) {
                    lines.add("* " + view.size() + " EXISTS");
                    exists = false;
                }
                StringBuilder b = new StringBuilder("* ").append(i + 1).append(" FETCH (UID ").append(e.uid)
                    .append(" FLAGS ").append(ImapWire.parenthesized(e.core.flags));
                if (condstore) {
                    b.append(" MODSEQ (").append(e.modSeq).append(')');
                }
                if (store.gmail) {
                    b.append(" X-GM-LABELS ").append(labels(e.core.labels));
                }
                lines.add(b.append(')').toString());
            }
        }
        pending.addAll(kept);
        if (!vanished.isEmpty()) {
            lines.add("* VANISHED " + ImapWire.set(vanished));
        }
        if (exists) {
            lines.add("* " + view.size() + " EXISTS");
        }
        return lines;
    }

    // ---- helpers ----

    private void lockedRun(Runnable r) {
        store.lock.lock();
        try {
            r.run();
        } finally {
            store.lock.unlock();
        }
    }

    private static String word(Object o) {
        if (o instanceof String s) {
            return s;
        }
        throw new Bad("Unexpected list");
    }

    private static long number(Object o) {
        String s = word(o);
        try {
            long v = Long.parseLong(s);
            if (v < 0) {
                throw new Bad("Not a number: " + s);
            }
            return v;
        } catch (NumberFormatException e) {
            throw new Bad("Not a number: " + s);
        }
    }

    /** A session's message numbers: the UIDs it knows, ascending. */
    private static final class UidList {
        private long[] a = new long[16];
        private int n;

        int size() {
            return n;
        }

        long get(int i) {
            return a[i];
        }

        void clear() {
            n = 0;
            if (a.length > 1024) {
                a = new long[16];
            }
        }

        void add(long uid) {
            if (n == a.length) {
                a = Arrays.copyOf(a, n * 2);
            }
            a[n++] = uid;
        }

        int indexOf(long uid) {
            int i = Arrays.binarySearch(a, 0, n, uid);
            return i < 0 ? -1 : i;
        }

        void removeAt(int i) {
            System.arraycopy(a, i + 1, a, i, n - i - 1);
            n--;
        }
    }
}
