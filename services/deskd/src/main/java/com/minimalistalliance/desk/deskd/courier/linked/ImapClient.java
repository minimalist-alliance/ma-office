package com.minimalistalliance.desk.deskd.courier.linked;

import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.OutputStream;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Consumer;

/**
 * One IMAP connection to a member's provider, over TLS (RFC 3501, with IDLE, UIDPLUS, MOVE, CONDSTORE and QRESYNC, ENABLE,
 * SPECIAL-USE, ESEARCH, LITERAL+, SASL-IR and Gmail's X-GM-EXT-1 where the server has them). One thread drives it; only
 * {@link #wake} and {@link #close} may come from another. Commands carry only what the transport builds (UIDs, flags, the
 * server's own folder names); the sign-in goes as a literal or SASL PLAIN from bytes that are zeroed after, and nothing
 * the server sends is logged.
 */
final class ImapClient implements AutoCloseable {

    /**
     * Timeouts and bounds. {@code maxLine}: a line outside literals (a UID line may run to {@link ImapReader#MAX_SET_LINE});
     * {@code maxLiteral} is a message's largest (the store keeps up to 48 MiB).
     */
    record Settings(Duration read, int maxLine, int maxLiteral) {
        static final Settings DEFAULT = new Settings(Duration.ofMinutes(2), 1024 * 1024, 64 * 1024 * 1024);
    }

    /** A folder as LIST shows it: the server's own name (sent back exactly), its delimiter and attributes. */
    record Listed(String name, String delimiter, Set<String> attributes) {}

    /** What a SELECT said. {@code highestModseq} 0: no CONDSTORE for this folder. */
    record Selected(long exists, long uidValidity, long uidNext, long highestModseq, boolean readOnly, long[] vanishedEarlier,
            List<FetchData> changed) {}

    /** One FETCH response; fields the server didn't send are null or -1. */
    record FetchData(long seq, long uid, List<String> flags, long modseq, long size, Long internalDate, byte[] body, byte[] header,
            String gmMsgId, List<String> gmLabels) {
        boolean seen() {
            return flags != null && flags.stream().anyMatch(f -> f.equalsIgnoreCase("\\Seen"));
        }

        boolean deleted() {
            return flags != null && flags.stream().anyMatch(f -> f.equalsIgnoreCase("\\Deleted"));
        }

        /** No content in logs. */
        @Override
        public String toString() {
            return "FetchData[" + uid + "]";
        }
    }

    /** UIDPLUS's COPYUID: the source UIDs and where each went, in order. */
    record CopyUid(long uidValidity, long[] from, long[] to) {}

    /** The selected folder's news since it was last read: what the server pushed (EXISTS, EXPUNGE, VANISHED, FETCH). */
    static final class Mailbox {
        long exists = -1;
        long uidValidity;
        long uidNext;
        long highestModseq;
        long expunges;
        /** UIDs VANISHED named since last read, 8 bytes each and at most {@link UidSet#MAX} (Security's CI-M1). */
        final ImapReader.Longs vanished = new ImapReader.Longs();
        boolean changed;

        void reset() {
            exists = -1;
            uidValidity = 0;
            uidNext = 0;
            highestModseq = 0;
            expunges = 0;
            vanished.clear();
            changed = false;
        }
    }

    private static final DateTimeFormatter INTERNALDATE = DateTimeFormatter.ofPattern("d-MMM-yyyy HH:mm:ss Z", Locale.ROOT);
    private static final DateTimeFormatter SEARCH_DATE = DateTimeFormatter.ofPattern("d-MMM-yyyy", Locale.ROOT);

    private final Socket socket;
    private final ImapReader in;
    private final OutputStream out;
    private final Settings settings;
    private final ReentrantLock writeLock = new ReentrantLock();
    private int tags;
    private final Set<String> caps = new HashSet<>();
    private final Set<String> enabled = new HashSet<>();
    final Mailbox box = new Mailbox();
    private boolean alert;
    private String byeText;
    private CopyUid lastCopy;
    private volatile boolean idling;
    private boolean doneSent;
    private volatile boolean wakeAsked;
    private volatile boolean closed;

    private ImapClient(Socket socket, Settings settings) throws IOException {
        this.socket = socket;
        this.settings = settings;
        this.in = new ImapReader(socket.getInputStream(), settings.maxLine(), settings.maxLiteral());
        this.out = socket.getOutputStream();
    }

    /** Connects over TLS and reads the greeting. */
    static ImapClient open(Net net, String host, int port, Settings settings) throws IOException {
        Socket s = net.connect(host, port, Net.IMAP_PORTS, true, settings.read());
        ImapClient c = new ImapClient(s, settings);
        try {
            c.in.allow(1024 * 1024);
            ImapReader.Response g = c.in.read();
            if (!g.untagged() || "BYE".equals(g.status())) {
                throw new ImapException.Closed(true, g.text());
            }
            if (!"OK".equals(g.status()) && !"PREAUTH".equals(g.status())) {
                throw new ImapException.Protocol("greeting");
            }
            if ("CAPABILITY".equals(g.code())) {
                c.capabilities(g.codeArgs());
            }
            if (c.caps.isEmpty()) {
                c.capability();
            }
            return c;
        } catch (IOException | RuntimeException e) {
            c.close();
            throw e;
        }
    }

    boolean has(String cap) {
        return caps.contains(cap.toUpperCase(Locale.ROOT));
    }

    boolean enabled(String ext) {
        return enabled.contains(ext.toUpperCase(Locale.ROOT));
    }

    /** Whether a response since this was last asked carried {@code [ALERT]}, which providers use for "app password needed". */
    boolean alerted() {
        boolean a = alert;
        alert = false;
        return a;
    }

    long bytesRead() {
        return in.bytesRead();
    }

    // ---- commands

    void capability() throws IOException {
        caps.clear();
        run("CAPABILITY", null, 1024 * 1024);
    }

    /**
     * Signs in: SASL PLAIN when offered (with the initial response when SASL-IR is there), else LOGIN with both values as
     * literals. {@code secret} is the caller's: read, never kept; every array made from it here is zeroed.
     */
    void login(String user, byte[] secret) throws IOException {
        byte[] u = user.getBytes(StandardCharsets.UTF_8);
        if (has("AUTH=PLAIN")) {
            byte[] plain = new byte[1 + u.length + 1 + secret.length];
            System.arraycopy(u, 0, plain, 1, u.length);
            System.arraycopy(secret, 0, plain, 2 + u.length, secret.length);
            byte[] b64 = Base64.getEncoder().encode(plain);
            Arrays.fill(plain, (byte) 0);
            try {
                if (has("SASL-IR")) {
                    runParts(List.of("AUTHENTICATE PLAIN ".getBytes(StandardCharsets.US_ASCII), b64), true, 64 * 1024, null);
                } else {
                    String tag = nextTag();
                    in.allow(64 * 1024);
                    write((tag + " AUTHENTICATE PLAIN\r\n").getBytes(StandardCharsets.US_ASCII));
                    awaitContinuation(tag);
                    writeSecret(b64, "\r\n".getBytes(StandardCharsets.US_ASCII));
                    finish(tag, null);
                }
            } finally {
                Arrays.fill(b64, (byte) 0);
            }
        } else if (has("LOGINDISABLED")) {
            throw new ImapException.Refused("NO", "AUTH_MECHANISM", null);
        } else {
            runLiterals("LOGIN", List.of(u, secret), 64 * 1024);
        }
        // A server may change its capabilities once signed in, and says so with a code or not at all.
        capability();
    }

    /** ENABLE (RFC 5161), for what the server has; the ones it enabled. */
    Set<String> enable(String... exts) throws IOException {
        List<String> want = new ArrayList<>();
        for (String e : exts) {
            if (has(e)) {
                want.add(e);
            }
        }
        if (want.isEmpty() || !has("ENABLE")) {
            return Set.copyOf(enabled);
        }
        run("ENABLE " + String.join(" ", want), null, 64 * 1024);
        return Set.copyOf(enabled);
    }

    /** Every folder, with its SPECIAL-USE attributes where the server shows them. */
    List<Listed> list() throws IOException {
        List<Listed> out = new ArrayList<>();
        Consumer<ImapReader.Response> each = r -> {
            if (!"LIST".equals(r.kind()) || r.items().size() < 4 || !(r.items().get(1) instanceof List<?> attrs)) {
                return;
            }
            Set<String> a = new HashSet<>();
            for (Object o : attrs) {
                String t = ImapReader.text(o);
                if (t != null) {
                    a.add(t.toLowerCase(Locale.ROOT));
                }
            }
            String delim = ImapReader.text(r.items().get(2));
            String name = ImapReader.text(r.items().get(3));
            if (name != null && !name.isEmpty() && out.size() < 2000) {
                out.add(new Listed(name, delim, Set.copyOf(a)));
            }
        };
        run(has("SPECIAL-USE") && has("LIST-EXTENDED") ? "LIST \"\" \"*\" RETURN (SPECIAL-USE)" : "LIST \"\" \"*\"", each, 8L * 1024 * 1024);
        return out;
    }

    /**
     * Selects a folder: with QRESYNC's known state when given (the server answers what vanished and changed since), else
     * with CONDSTORE when the server has it. A known state for another UIDVALIDITY is just a plain select.
     */
    Selected select(String name, long knownValidity, long knownModseq, String knownUids) throws IOException {
        box.reset();
        ImapReader.Longs vanishedEarlier = new ImapReader.Longs();
        List<FetchData> changed = new ArrayList<>();
        boolean[] readOnly = {false};
        String params = "";
        if (enabled("QRESYNC") && knownValidity > 0 && knownModseq > 0) {
            params = " (QRESYNC (" + knownValidity + " " + knownModseq + (knownUids == null ? "" : " " + knownUids) + "))";
        } else if (has("CONDSTORE")) {
            params = " (CONDSTORE)";
        }
        ImapReader.Response done = runParts(List.of(("SELECT ").getBytes(StandardCharsets.US_ASCII), mailbox(name),
                params.getBytes(StandardCharsets.US_ASCII)), List.of(), 32L * 1024 * 1024, r -> {
            if ("FETCH".equals(r.kind())) {
                FetchData f = fetchData(r);
                if (f != null) {
                    changed.add(f);
                }
            } else if ("VANISHED".equals(r.kind())) {
                vanishedEarlier.addAll(box.vanished.toArray());
                box.vanished.clear();
            }
        });
        if ("READ-ONLY".equals(done.code())) {
            readOnly[0] = true;
        }
        long[] v = vanishedEarlier.toArray();
        Arrays.sort(v);
        box.changed = false;
        return new Selected(Math.max(0, box.exists), box.uidValidity, box.uidNext, box.highestModseq, readOnly[0], v, changed);
    }

    /** STATUS of a folder not selected: the items asked, by name. */
    Map<String, Long> status(String name, String items) throws IOException {
        Map<String, Long> out = new LinkedHashMap<>();
        runParts(List.of("STATUS ".getBytes(StandardCharsets.US_ASCII), mailbox(name), (" (" + items + ")").getBytes(StandardCharsets.US_ASCII)),
                List.of(), 64 * 1024, r -> {
                    if (!"STATUS".equals(r.kind()) || r.items().size() < 3 || !(r.items().get(2) instanceof List<?> l)) {
                        return;
                    }
                    for (int i = 0; i + 1 < l.size(); i += 2) {
                        String k = ImapReader.text(l.get(i));
                        long v = ImapReader.number(ImapReader.text(l.get(i + 1)));
                        if (k != null && v >= 0) {
                            out.put(k.toUpperCase(Locale.ROOT), v);
                        }
                    }
                });
        return out;
    }

    /**
     * UID FETCH {@code set} {@code (items)} with {@code modifiers} (CHANGEDSINCE), each FETCH response to {@code each} as it
     * comes. {@code allowance} bounds what the whole answer may bring.
     */
    void fetch(String set, String items, String modifiers, long allowance, Consumer<FetchData> each) throws IOException {
        fetch(set, items, modifiers, allowance, ImapReader.LITERAL_DEFAULT, each);
    }

    /** As {@link #fetch(String, String, String, long, Consumer)}, with literals up to {@code literals} each (a body fetch). */
    void fetch(String set, String items, String modifiers, long allowance, long literals, Consumer<FetchData> each) throws IOException {
        nextLiterals = literals;
        run("UID FETCH " + set + " (" + items + ")" + (modifiers == null ? "" : " (" + modifiers + ")"), r -> {
            if ("FETCH".equals(r.kind())) {
                FetchData f = fetchData(r);
                if (f != null) {
                    each.accept(f);
                }
            }
        }, allowance);
    }

    /** UID SEARCH: the UIDs, ascending; with ESEARCH, asked as a compact set. */
    long[] search(String criteria) throws IOException {
        List<long[]> parts = new ArrayList<>();
        boolean esearch = has("ESEARCH");
        run("UID SEARCH " + (esearch ? "RETURN (ALL) " : "") + criteria, r -> {
            // The reader gives a UID line's numbers and sets as long[]s, counted against the command's UIDs.
            if ("SEARCH".equals(r.kind())) {
                if (r.items().size() > 1 && r.items().get(1) instanceof long[] u) {
                    parts.add(u);
                }
            } else if ("ESEARCH".equals(r.kind())) {
                List<Object> it = r.items();
                for (int i = 1; i + 1 < it.size(); i++) {
                    if ("ALL".equalsIgnoreCase(ImapReader.text(it.get(i))) && it.get(i + 1) instanceof long[] u) {
                        parts.add(u);
                    }
                }
            }
        }, 64L * 1024 * 1024);
        if (parts.size() == 1) {
            long[] one = parts.get(0);
            Arrays.sort(one);
            return dedupe(one);
        }
        return dedupe(parts.stream().flatMapToLong(Arrays::stream).sorted().toArray());
    }

    /** A sorted array without repeats, in place where it can be. */
    private static long[] dedupe(long[] sorted) {
        int n = 0;
        for (int i = 0; i < sorted.length; i++) {
            if (n == 0 || sorted[i] != sorted[n - 1]) {
                sorted[n++] = sorted[i];
            }
        }
        return n == sorted.length ? sorted : Arrays.copyOf(sorted, n);
    }

    /** {@code SINCE} criteria for a date. */
    static String since(java.time.LocalDate day) {
        return "SINCE " + SEARCH_DATE.format(day);
    }

    /** UID STORE {@code set} {@code what} {@code (flags)}, {@code what} such as {@code +FLAGS.SILENT}. */
    void store(String set, String what, String flags) throws IOException {
        run("UID STORE " + set + " " + what + " (" + flags + ")", null, 8L * 1024 * 1024);
    }

    /** UID MOVE (RFC 6851), or COPY, \Deleted and UID EXPUNGE where there's no MOVE; COPYUID when UIDPLUS gives it. */
    CopyUid move(String set, String dest) throws IOException {
        lastCopy = null;
        if (has("MOVE")) {
            runParts(List.of("UID MOVE ".getBytes(StandardCharsets.US_ASCII), (set + " ").getBytes(StandardCharsets.US_ASCII), mailbox(dest)),
                    List.of(), 8L * 1024 * 1024, null);
            return lastCopy;
        }
        if (!has("UIDPLUS")) {
            // Without UID EXPUNGE an EXPUNGE would take every \Deleted message of the folder, the member's own too.
            throw new ImapException.Refused("NO", "CANNOT", null);
        }
        CopyUid copied = copy(set, dest);
        store(set, "+FLAGS.SILENT", "\\Deleted");
        run("UID EXPUNGE " + set, null, 8L * 1024 * 1024);
        return copied;
    }

    CopyUid copy(String set, String dest) throws IOException {
        lastCopy = null;
        runParts(List.of("UID COPY ".getBytes(StandardCharsets.US_ASCII), (set + " ").getBytes(StandardCharsets.US_ASCII), mailbox(dest)),
                List.of(), 1024 * 1024, null);
        return lastCopy;
    }

    /** UID EXPUNGE (UIDPLUS) of UIDs already \Deleted; refused without UIDPLUS, for the reason {@link #move} gives. */
    void expunge(String set) throws IOException {
        if (!has("UIDPLUS")) {
            throw new ImapException.Refused("NO", "CANNOT", null);
        }
        run("UID EXPUNGE " + set, null, 8L * 1024 * 1024);
    }

    /** APPEND a message to a folder with flags; its new UID with UIDPLUS, else 0. */
    long append(String folder, String flags, byte[] message) throws IOException {
        lastAppendUid = 0;
        runLiterals(List.of("APPEND ".getBytes(StandardCharsets.US_ASCII), mailbox(folder), (" (" + flags + ") ").getBytes(StandardCharsets.US_ASCII)),
                message, 1024 * 1024);
        return lastAppendUid;
    }

    private long lastAppendUid;
    /** The next command's literal cap, when it isn't the default (a body fetch). */
    private long nextLiterals;

    void noop() throws IOException {
        run("NOOP", null, 32L * 1024 * 1024);
    }

    /**
     * IDLE (RFC 2177) for up to {@code millis}: returns as soon as the folder changes (EXISTS, EXPUNGE, VANISHED, FETCH), at
     * the time, or on {@link #wake}; then DONE and the tagged end. True if it changed or was woken.
     */
    boolean idle(long millis) throws IOException {
        if (wakeAsked) {
            wakeAsked = false;
            return true;
        }
        String tag = nextTag();
        in.allow(32L * 1024 * 1024);
        writeLock.lock();
        try {
            doneSent = false;
            write((tag + " IDLE\r\n").getBytes(StandardCharsets.US_ASCII));
        } finally {
            writeLock.unlock();
        }
        awaitContinuation(tag);
        idling = true;
        boolean changed = false;
        long deadline = System.nanoTime() + millis * 1_000_000L;
        try {
            while (!wakeAsked) {
                long left = (deadline - System.nanoTime()) / 1_000_000L;
                if (left <= 0) {
                    break;
                }
                socket.setSoTimeout((int) Math.min(Integer.MAX_VALUE, Math.max(1, left)));
                ImapReader.Response r;
                try {
                    r = in.read();
                } catch (SocketTimeoutException e) {
                    if (in.atStart()) {
                        break;
                    }
                    // Timed out inside a response: what's left of it can't be read in step any more.
                    throw new ImapException.Protocol("idle");
                }
                if (r.untagged()) {
                    untagged(r, null);
                    if (box.changed) {
                        changed = true;
                        break;
                    }
                    continue;
                }
                if (tag.equals(r.tag())) {
                    // Ended by the server, or by wake()'s DONE.
                    idling = false;
                    end(r);
                    return true;
                }
                throw new ImapException.Protocol("idle");
            }
        } finally {
            socket.setSoTimeout((int) settings.read().toMillis());
        }
        writeLock.lock();
        try {
            if (!doneSent) {
                write("DONE\r\n".getBytes(StandardCharsets.US_ASCII));
                doneSent = true;
            }
        } finally {
            writeLock.unlock();
        }
        idling = false;
        finish(tag, null);
        boolean woken = wakeAsked;
        wakeAsked = false;
        return changed || woken;
    }

    /** From any thread: ends an IDLE now (or the next one at once), so the owner can do something else. */
    void wake() {
        wakeAsked = true;
        if (!idling) {
            return;
        }
        writeLock.lock();
        try {
            if (idling && !doneSent && !closed) {
                write("DONE\r\n".getBytes(StandardCharsets.US_ASCII));
                doneSent = true;
            }
        } catch (IOException e) {
            close();
        } finally {
            writeLock.unlock();
        }
    }

    void logout() {
        try {
            run("LOGOUT", null, 64 * 1024);
        } catch (IOException e) {
            // closing anyway
        }
        close();
    }

    @Override
    public void close() {
        closed = true;
        try {
            socket.close();
        } catch (IOException ignored) {
            // closed
        }
    }

    // ---- the exchange

    private String nextTag() {
        return "C" + (++tags);
    }

    private ImapReader.Response run(String command, Consumer<ImapReader.Response> each, long allowance) throws IOException {
        return runParts(List.of(command.getBytes(StandardCharsets.UTF_8)), false, allowance, each);
    }

    private ImapReader.Response runParts(List<byte[]> parts, List<byte[]> unused, long allowance, Consumer<ImapReader.Response> each)
            throws IOException {
        return runParts(parts, false, allowance, each);
    }

    private ImapReader.Response runParts(List<byte[]> parts, List<byte[]> unused, long allowance) throws IOException {
        return runParts(parts, false, allowance, null);
    }

    /**
     * One command line. {@code secret}: a part holds the sign-in, so the parts are written as they are, with no copy made
     * here to zero.
     */
    private ImapReader.Response runParts(List<byte[]> parts, boolean secret, long allowance, Consumer<ImapReader.Response> each)
            throws IOException {
        String tag = nextTag();
        in.allow(allowance);
        if (nextLiterals > 0) {
            in.allowLiterals(nextLiterals);
            nextLiterals = 0;
        }
        writeLock.lock();
        try {
            if (secret) {
                write((tag + " ").getBytes(StandardCharsets.US_ASCII));
                for (byte[] p : parts) {
                    write(p);
                }
                write("\r\n".getBytes(StandardCharsets.US_ASCII));
            } else {
                ByteArrayOutputStream b = new ByteArrayOutputStream();
                b.writeBytes((tag + " ").getBytes(StandardCharsets.US_ASCII));
                for (byte[] p : parts) {
                    b.writeBytes(p);
                }
                b.writeBytes("\r\n".getBytes(StandardCharsets.US_ASCII));
                write(b.toByteArray());
            }
        } finally {
            writeLock.unlock();
        }
        return finish(tag, each);
    }

    /** A command whose arguments go as literals: {@code head}, then each value as a literal, space-separated. */
    private void runLiterals(String head, List<byte[]> values, long allowance) throws IOException {
        String tag = nextTag();
        in.allow(allowance);
        boolean plus = has("LITERAL+");
        writeLock.lock();
        try {
            write((tag + " " + head).getBytes(StandardCharsets.US_ASCII));
        } finally {
            writeLock.unlock();
        }
        for (byte[] v : values) {
            writeLock.lock();
            try {
                write((" {" + v.length + (plus ? "+" : "") + "}\r\n").getBytes(StandardCharsets.US_ASCII));
            } finally {
                writeLock.unlock();
            }
            if (!plus) {
                awaitContinuation(tag);
            }
            writeSecret(v, null);
        }
        writeLock.lock();
        try {
            write("\r\n".getBytes(StandardCharsets.US_ASCII));
        } finally {
            writeLock.unlock();
        }
        finish(tag, null);
    }

    /** APPEND's shape: the head's parts, then one literal (the message), then the end. */
    private void runLiterals(List<byte[]> head, byte[] literal, long allowance) throws IOException {
        String tag = nextTag();
        in.allow(allowance);
        boolean plus = has("LITERAL+") && literal.length <= 4096 * 1024;
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        b.writeBytes((tag + " ").getBytes(StandardCharsets.US_ASCII));
        for (byte[] p : head) {
            b.writeBytes(p);
        }
        b.writeBytes(("{" + literal.length + (plus ? "+" : "") + "}\r\n").getBytes(StandardCharsets.US_ASCII));
        writeLock.lock();
        try {
            write(b.toByteArray());
        } finally {
            writeLock.unlock();
        }
        if (!plus) {
            awaitContinuation(tag);
        }
        writeLock.lock();
        try {
            write(literal);
            write("\r\n".getBytes(StandardCharsets.US_ASCII));
        } finally {
            writeLock.unlock();
        }
        finish(tag, null);
    }

    private void writeSecret(byte[] value, byte[] after) throws IOException {
        writeLock.lock();
        try {
            write(value);
            if (after != null) {
                write(after);
            }
        } finally {
            writeLock.unlock();
        }
    }

    /** Reads until the server's {@code +}; untagged responses on the way are taken; the tagged end means it refused. */
    private void awaitContinuation(String tag) throws IOException {
        while (true) {
            ImapReader.Response r = readOne();
            if (r.continuation()) {
                return;
            }
            if (r.untagged()) {
                untagged(r, null);
                continue;
            }
            if (tag.equals(r.tag())) {
                end(r);
                throw new ImapException.Protocol("continuation");
            }
            throw new ImapException.Protocol("tag");
        }
    }

    /** Reads to the command's tagged end; untagged responses go to {@code each} as well as the folder's state. */
    private ImapReader.Response finish(String tag, Consumer<ImapReader.Response> each) throws IOException {
        while (true) {
            ImapReader.Response r = readOne();
            if (r.untagged()) {
                untagged(r, each);
                continue;
            }
            if (r.continuation()) {
                throw new ImapException.Protocol("continuation");
            }
            if (!tag.equals(r.tag())) {
                throw new ImapException.Protocol("tag");
            }
            end(r);
            return r;
        }
    }

    private ImapReader.Response readOne() throws IOException {
        try {
            return in.read();
        } catch (EOFException e) {
            throw new ImapException.Closed(byeText != null, byeText);
        } catch (java.net.SocketException e) {
            if (closed) {
                throw new ImapException.Closed(false, null);
            }
            throw e;
        }
    }

    private void end(ImapReader.Response r) throws IOException {
        code(r);
        if (!"OK".equals(r.status())) {
            if ("BYE".equals(r.status())) {
                throw new ImapException.Closed(true, r.text());
            }
            throw new ImapException.Refused(r.status() == null ? "BAD" : r.status(), r.code(), r.text());
        }
    }

    private void untagged(ImapReader.Response r, Consumer<ImapReader.Response> each) throws IOException {
        if (r.status() != null) {
            code(r);
            if ("BYE".equals(r.status())) {
                byeText = r.text() == null ? "" : r.text();
            }
            if (each != null) {
                each.accept(r);
            }
            return;
        }
        String kind = r.kind();
        long n = r.number();
        switch (kind == null ? "" : kind) {
            case "CAPABILITY" -> capabilities(r.items().subList(1, r.items().size()));
            case "ENABLED" -> {
                for (Object o : r.items().subList(1, r.items().size())) {
                    String t = ImapReader.text(o);
                    if (t != null) {
                        enabled.add(t.toUpperCase(Locale.ROOT));
                    }
                }
            }
            case "EXISTS" -> {
                if (box.exists >= 0 && n != box.exists) {
                    box.changed = true;
                }
                box.exists = n;
            }
            case "EXPUNGE" -> {
                box.expunges++;
                box.exists = Math.max(0, box.exists - 1);
                box.changed = true;
            }
            case "VANISHED" -> {
                List<Object> it = r.items();
                boolean earlier = it.size() > 2 && it.get(1) instanceof List<?> l && !l.isEmpty()
                        && "EARLIER".equalsIgnoreCase(ImapReader.text(l.get(0)));
                if (!(it.get(it.size() - 1) instanceof long[] set)) {
                    throw new ImapException.Protocol("set");
                }
                if ((long) box.vanished.size() + set.length > UidSet.MAX) {
                    throw new ImapException.TooLarge();
                }
                box.vanished.addAll(set);
                if (!earlier) {
                    box.exists = Math.max(0, box.exists - set.length);
                }
                box.changed = true;
            }
            case "FETCH" -> {
                if (each == null) {
                    // Pushed while idle: the folder changed, and the sync reads it again; nothing of it is kept here.
                    box.changed = true;
                } else {
                    FetchData f = fetchData(r);
                    in.chargeFetch(f == null ? 64 : kept(f));
                }
            }
            default -> { }
        }
        if (each != null) {
            try {
                each.accept(r);
            } catch (IllegalStateException e) {
                if (e.getCause() instanceof ImapException ie) {
                    throw ie;
                }
                throw e;
            }
        }
    }

    /** A status response's code: the folder's numbers, CAPABILITY, COPYUID, APPENDUID, ALERT. */
    private void code(ImapReader.Response r) throws ImapException {
        String code = r.code();
        if (code == null) {
            return;
        }
        List<Object> a = r.codeArgs();
        switch (code) {
            case "UIDVALIDITY" -> box.uidValidity = a.isEmpty() ? 0 : Math.max(0, ImapReader.number(ImapReader.text(a.get(0))));
            case "UIDNEXT" -> box.uidNext = a.isEmpty() ? 0 : Math.max(0, ImapReader.number(ImapReader.text(a.get(0))));
            case "HIGHESTMODSEQ" -> box.highestModseq = a.isEmpty() ? 0 : Math.max(0, ImapReader.number(ImapReader.text(a.get(0))));
            case "NOMODSEQ" -> box.highestModseq = 0;
            case "CAPABILITY" -> capabilities(a);
            case "ALERT" -> alert = true;
            case "COPYUID" -> {
                if (a.size() >= 3) {
                    long[] from = UidSet.parseOrdered(ImapReader.text(a.get(1)), in.uidsLeft());
                    in.charge(from.length);
                    long[] to = UidSet.parseOrdered(ImapReader.text(a.get(2)), in.uidsLeft());
                    in.charge(to.length);
                    if (from.length == to.length) {
                        lastCopy = new CopyUid(ImapReader.number(ImapReader.text(a.get(0))), from, to);
                    }
                }
            }
            case "APPENDUID" -> {
                if (a.size() >= 2) {
                    lastAppendUid = Math.max(0, ImapReader.number(ImapReader.text(a.get(1))));
                }
            }
            default -> { }
        }
    }

    private void capabilities(List<Object> items) {
        caps.clear();
        for (Object o : items) {
            String t = ImapReader.text(o);
            if (t != null) {
                caps.add(t.toUpperCase(Locale.ROOT));
            }
        }
    }

    /** A FETCH response's attributes; null if it isn't one with a UID. */
    static FetchData fetchData(ImapReader.Response r) {
        if (r.items().size() < 3 || !(r.items().get(2) instanceof List<?> l)) {
            return null;
        }
        long seq = r.number();
        long uid = -1;
        List<String> flags = null;
        long modseq = -1;
        long size = -1;
        Long internal = null;
        byte[] body = null;
        byte[] header = null;
        String gmId = null;
        List<String> labels = null;
        for (int i = 0; i + 1 < l.size(); i += 2) {
            String key = ImapReader.text(l.get(i));
            Object v = l.get(i + 1);
            if (key == null) {
                continue;
            }
            String k = key.toUpperCase(Locale.ROOT);
            switch (k) {
                case "UID" -> uid = ImapReader.number(ImapReader.text(v));
                case "FLAGS" -> flags = strings(v, MAX_FLAGS);
                case "MODSEQ" -> {
                    if (v instanceof List<?> m && !m.isEmpty()) {
                        modseq = ImapReader.number(ImapReader.text(m.get(0)));
                    }
                }
                case "RFC822.SIZE" -> size = ImapReader.number(ImapReader.text(v));
                case "INTERNALDATE" -> internal = internalDate(ImapReader.text(v));
                case "X-GM-MSGID" -> gmId = ImapReader.number(ImapReader.text(v)) >= 0 ? ImapReader.text(v) : null;
                case "X-GM-LABELS" -> labels = strings(v, MAX_LABELS);
                default -> {
                    if ((k.equals("BODY[]") || k.equals("RFC822")) && v instanceof byte[] bytes) {
                        body = bytes;
                    } else if (k.startsWith("BODY[HEADER") && v instanceof byte[] bytes) {
                        header = bytes;
                    }
                }
            }
        }
        if (uid <= 0) {
            return null;
        }
        return new FetchData(seq, uid, flags, modseq, size, internal, body, header, gmId, labels);
    }

    /** Flags kept for a message: mail has a handful; past this, the rest are a server's noise (Security's CI-M1b). */
    static final int MAX_FLAGS = 32;
    /** Gmail labels kept for a message. */
    static final int MAX_LABELS = 64;

    /** The flags and labels nearly every message carries, kept once rather than once per message. */
    private static final Map<String, String> COMMON = new java.util.HashMap<>();

    static {
        for (String f : new String[] {"\\Seen", "\\Answered", "\\Flagged", "\\Deleted", "\\Draft", "\\Recent", "$Forwarded", "$Junk",
                "$NotJunk", "$MDNSent", "$Phishing", "NonJunk", "Junk", "\\Inbox", "\\Sent", "\\Important", "\\Starred",
                "\\Trash", "\\Spam", "\\All"}) {
            COMMON.put(f, f);
        }
    }

    private static List<String> strings(Object v, int max) {
        if (!(v instanceof List<?> list)) {
            return v == ImapReader.NIL ? List.of() : null;
        }
        List<String> out = new ArrayList<>(Math.min(list.size(), max));
        for (Object o : list) {
            String t = ImapReader.text(o);
            if (t != null && out.size() < max) {
                out.add(COMMON.getOrDefault(t, t));
            }
        }
        return out;
    }

    /**
     * About the heap one kept FETCH holds: the record, its lists and strings (a common flag counts as a reference), its
     * header and Gmail id. A message's body isn't counted: a body fetch is bounded by its own allowance and the sync's
     * shared byte budget.
     */
    static long kept(FetchData f) {
        long n = 128;
        for (List<String> l : java.util.Arrays.asList(f.flags(), f.gmLabels())) {
            if (l != null) {
                n += 40 + 8L * l.size();
                for (String s : l) {
                    n += COMMON.get(s) == s ? 0 : 48 + s.length();
                }
            }
        }
        if (f.header() != null) {
            n += 16 + f.header().length;
        }
        if (f.gmMsgId() != null) {
            n += 48 + f.gmMsgId().length();
        }
        return n;
    }

    static Long internalDate(String s) {
        if (s == null) {
            return null;
        }
        try {
            return ZonedDateTime.parse(s.strip(), INTERNALDATE).toInstant().toEpochMilli();
        } catch (DateTimeParseException e) {
            return null;
        }
    }

    /** A folder name as the server gave it: a quoted string if it's plain, else a literal. */
    private byte[] mailbox(String name) {
        byte[] bytes = name.getBytes(StandardCharsets.UTF_8);
        boolean plain = true;
        for (byte b : bytes) {
            if (b < 0x20 || b == 0x7F || (b & 0x80) != 0) {
                plain = false;
                break;
            }
        }
        if (!plain) {
            // Names are ASCII (modified UTF-7) unless the server enabled UTF-8, which this client doesn't ask for.
            throw new IllegalArgumentException("mailbox");
        }
        StringBuilder q = new StringBuilder("\"");
        for (byte b : bytes) {
            if (b == '"' || b == '\\') {
                q.append('\\');
            }
            q.append((char) b);
        }
        return q.append('"').toString().getBytes(StandardCharsets.US_ASCII);
    }

    private void write(byte[] bytes) throws IOException {
        out.write(bytes);
        out.flush();
    }
}
