package com.minimalistalliance.desk.courier.testkit;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Deque;
import java.util.EnumMap;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.LongAdder;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Consumer;
import javax.net.ssl.SSLContext;

/**
 * A scripted SMTP submission server for tests, on 127.0.0.1, JDK only: implicit TLS (as on port 465) or plain text then
 * STARTTLS (as on 587), with {@link FakeTls}'s certificate; AUTH PLAIN and LOGIN; MAIL, RCPT, DATA with dot-unstuffing,
 * RSET, NOOP, QUIT; every accepted message captured exactly; and fault injection at each stage. One virtual thread per
 * connection. The README in this module has what it does and doesn't.
 */
public final class FakeSmtpServer implements AutoCloseable {

    /** How the connection starts. */
    public enum Mode {
        /** TLS from the first byte (as port 465). */
        IMPLICIT_TLS,
        /** Plain text, STARTTLS offered, AUTH and MAIL refused until TLS (as port 587). */
        STARTTLS,
        /** Plain text throughout, no STARTTLS. */
        PLAIN
    }

    /** What EHLO advertises; each can be turned off. */
    public enum Extension {
        /** {@code AUTH PLAIN LOGIN}. */
        AUTH,
        /** {@code SIZE <max>}, and the MAIL parameter. */
        SIZE,
        EIGHTBITMIME,
        PIPELINING,
        SMTPUTF8,
        /** Only in {@link Mode#STARTTLS}, and only before TLS. */
        STARTTLS
    }

    /** Where a fault replies. */
    public enum Stage {
        MAIL,
        RCPT,
        /** The DATA command, instead of 354. */
        DATA,
        /** After the final dot, instead of 250. */
        END_OF_DATA
    }

    /** How to start a server. A fluent, mutable builder; {@link #start} copies it. */
    public static final class Options {
        private Mode mode = Mode.STARTTLS;
        private final EnumSet<Extension> extensions = EnumSet.allOf(Extension.class);
        private long maxSize = 35_882_577;
        private boolean requireAuth = true;
        private SSLContext sslContext;
        private String hostname = "smtp.fake.test";

        /** Plain text then STARTTLS, every extension, AUTH required, a 35,882,577-byte SIZE. */
        public static Options startTls() {
            return new Options();
        }

        /** As {@link #startTls()} but TLS from the start (no STARTTLS). */
        public static Options implicitTls() {
            return new Options().mode(Mode.IMPLICIT_TLS);
        }

        /** As {@link #startTls()} but no TLS at all. */
        public static Options plain() {
            return new Options().mode(Mode.PLAIN);
        }

        public Options mode(Mode m) {
            this.mode = m;
            return this;
        }

        public Options with(Extension... e) {
            extensions.addAll(List.of(e));
            return this;
        }

        public Options without(Extension... e) {
            for (Extension x : e) {
                extensions.remove(x);
            }
            return this;
        }

        /** The largest message taken, advertised with SIZE. */
        public Options maxSize(long bytes) {
            this.maxSize = bytes;
            return this;
        }

        /** Whether MAIL needs AUTH first (default yes, as on submission ports). */
        public Options requireAuth(boolean on) {
            this.requireAuth = on;
            return this;
        }

        public Options sslContext(SSLContext ctx) {
            this.sslContext = ctx;
            return this;
        }

        /** The name in the greeting and EHLO reply. */
        public Options hostname(String name) {
            this.hostname = name;
            return this;
        }

        private Options copy() {
            Options o = new Options();
            o.mode = mode;
            o.extensions.clear();
            o.extensions.addAll(extensions);
            o.maxSize = maxSize;
            o.requireAuth = requireAuth;
            o.sslContext = sslContext;
            o.hostname = hostname;
            return o;
        }
    }

    /**
     * A message the server accepted: the login used (null if none), the envelope sender, the recipients it accepted, the
     * data exactly as sent with dot-stuffing undone and the final {@code .} line removed (so it ends with the last line's
     * CRLF), MAIL's parameters, whether it came over TLS, and when.
     */
    public record Received(String login, String from, List<String> recipients, byte[] data, List<String> mailParameters, boolean tls,
                           Instant at) {
    }

    private final Options options;
    private final SSLContext sslContext;
    private final ServerSocket serverSocket;
    private volatile boolean closed;
    private final Set<Conversation> open = ConcurrentHashMap.newKeySet();
    private final Map<String, String> users = new ConcurrentHashMap<>();
    private final List<Received> received = new CopyOnWriteArrayList<>();
    private volatile Consumer<Received> hook;
    private final Map<String, LongAdder> commands = new ConcurrentHashMap<>();
    private final AtomicInteger connections = new AtomicInteger();
    private final AtomicInteger logins = new AtomicInteger();
    private final AtomicLong ids = new AtomicLong();

    private final ReentrantLock faultLock = new ReentrantLock();
    private final Map<Stage, Deque<String[]>> stageFaults = new EnumMap<>(Stage.class);
    private final Map<String, String> rcptFaults = new HashMap<>();
    private int dropsAfterData;
    private boolean dropKeeps;
    private volatile String authRefusal;
    private volatile long delayMillis;

    private FakeSmtpServer(Options options) throws IOException {
        this.options = options;
        this.sslContext = options.mode == Mode.PLAIN ? null : options.sslContext != null ? options.sslContext : FakeTls.serverContext();
        this.serverSocket = new ServerSocket();
        serverSocket.setReuseAddress(true);
        serverSocket.bind(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 128);
        Thread.ofVirtual().name("fake-smtp-accept-" + serverSocket.getLocalPort()).start(this::acceptLoop);
    }

    /** Starts a server on 127.0.0.1 on a port the system picks. */
    public static FakeSmtpServer start(Options options) {
        try {
            return new FakeSmtpServer(options.copy());
        } catch (IOException e) {
            throw new IllegalStateException("can't listen", e);
        }
    }

    public int port() {
        return serverSocket.getLocalPort();
    }

    public Mode mode() {
        return options.mode;
    }

    @Override
    public void close() {
        closed = true;
        try {
            serverSocket.close();
        } catch (IOException ignored) {
            // closing anyway
        }
        dropConnections();
    }

    private void acceptLoop() {
        while (!closed) {
            Socket s;
            try {
                s = serverSocket.accept();
            } catch (IOException e) {
                return;
            }
            connections.incrementAndGet();
            Conversation c = new Conversation(s);
            open.add(c);
            Thread.ofVirtual().name("fake-smtp-" + port() + "-" + connections.get()).start(c::run);
        }
    }

    // ---- test side ----

    /** A login AUTH PLAIN and LOGIN accept. Adding one again changes the password. */
    public void addUser(String login, String password) {
        users.put(login, password);
    }

    /** Every message accepted so far, in order. */
    public List<Received> received() {
        return List.copyOf(received);
    }

    public void clearReceived() {
        received.clear();
    }

    /**
     * Called with each accepted message before the server says 250, so whatever it does (put the message in a {@link
     * FakeImapServer} user's Sent folder, as Gmail does) has happened by the time the client hears it went. If it throws,
     * the client gets {@code 451 4.3.0} and the message isn't kept. Null for none.
     */
    public void onMessage(Consumer<Received> hook) {
        this.hook = hook;
    }

    /** Commands received by verb, e.g. {@code EHLO}, {@code AUTH}, {@code MAIL}. */
    public Map<String, Long> commands() {
        Map<String, Long> out = new TreeMap<>();
        commands.forEach((k, v) -> out.put(k, v.sum()));
        return out;
    }

    public long commandCount(String verb) {
        LongAdder a = commands.get(verb.toUpperCase(Locale.ROOT));
        return a == null ? 0 : a.sum();
    }

    public int connectionsOpened() {
        return connections.get();
    }

    /** Successful AUTHs. */
    public int logins() {
        return logins.get();
    }

    // ---- faults ----

    /**
     * The next {@code times} times the conversation reaches {@code stage}, the server replies {@code reply} (a whole
     * reply line, e.g. {@code 451 4.7.0 Try again later}) instead of going on. At {@link Stage#END_OF_DATA} the message
     * isn't kept.
     */
    public void failAt(Stage stage, int times, String reply) {
        faultLock.lock();
        try {
            stageFaults.computeIfAbsent(stage, k -> new ArrayDeque<>()).add(new String[] {reply, String.valueOf(times)});
        } finally {
            faultLock.unlock();
        }
    }

    /** Every RCPT for this address (any case) gets {@code reply}, e.g. {@code 550 5.1.1 No such user}, until {@link #clearFaults}. */
    public void failRcpt(String address, String reply) {
        faultLock.lock();
        try {
            rcptFaults.put(address.toLowerCase(Locale.ROOT), reply);
        } finally {
            faultLock.unlock();
        }
    }

    /**
     * The next {@code times} messages: after the final dot the server closes the connection without a reply (the client
     * can't know whether it went). With {@code keep} the message counts as accepted ({@link #received}, the hook), as when
     * the server took it and the reply was lost; without, it doesn't.
     */
    public void dropAfterData(int times, boolean keep) {
        faultLock.lock();
        try {
            dropsAfterData = times;
            dropKeeps = keep;
        } finally {
            faultLock.unlock();
        }
    }

    /** Waits this long before each reply (the greeting too); null or zero for none. */
    public void delayReplies(Duration delay) {
        delayMillis = delay == null ? 0 : delay.toMillis();
    }

    /** Every AUTH, right or wrong, gets {@code reply} (e.g. {@code 535 5.7.8 ...} or {@code 454 4.7.0 ...}); null to stop. */
    public void refuseAuth(String reply) {
        authRefusal = reply;
    }

    /** Closes every connection now, with a TCP reset. */
    public void dropConnections() {
        for (Conversation c : open) {
            c.drop();
        }
    }

    /** Every fault off. */
    public void clearFaults() {
        faultLock.lock();
        try {
            stageFaults.clear();
            rcptFaults.clear();
            dropsAfterData = 0;
        } finally {
            faultLock.unlock();
        }
        authRefusal = null;
        delayMillis = 0;
    }

    private String takeFault(Stage stage) {
        faultLock.lock();
        try {
            Deque<String[]> q = stageFaults.get(stage);
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

    private String rcptFault(String address) {
        faultLock.lock();
        try {
            return rcptFaults.get(address.toLowerCase(Locale.ROOT));
        } finally {
            faultLock.unlock();
        }
    }

    /** 0: no drop; 1: drop, keep; 2: drop, don't keep. */
    private int takeDrop() {
        faultLock.lock();
        try {
            if (dropsAfterData <= 0) {
                return 0;
            }
            dropsAfterData--;
            return dropKeeps ? 1 : 2;
        } finally {
            faultLock.unlock();
        }
    }

    // ---- one connection ----

    private final class Conversation {
        private final Socket raw;
        private Socket socket;
        private InputStream in;
        private OutputStream out;
        private boolean tls;
        private boolean greeted;
        private String login;
        private String from;
        private List<String> params = List.of();
        private final List<String> rcpts = new ArrayList<>();
        private volatile boolean ending;

        Conversation(Socket raw) {
            this.raw = raw;
        }

        void run() {
            try {
                raw.setTcpNoDelay(true);
                socket = raw;
                if (options.mode == Mode.IMPLICIT_TLS) {
                    socket = FakeTls.serverSide(sslContext, raw);
                    tls = true;
                }
                streams();
                reply("220 " + options.hostname + " ESMTP FakeSmtpServer ready");
                while (!ending) {
                    String line = line();
                    if (line == null) {
                        return;
                    }
                    int sp = line.indexOf(' ');
                    String verb = (sp < 0 ? line : line.substring(0, sp)).toUpperCase(Locale.ROOT);
                    String arg = sp < 0 ? "" : line.substring(sp + 1).trim();
                    commands.computeIfAbsent(verb, k -> new LongAdder()).increment();
                    command(verb, arg);
                }
            } catch (IOException | RuntimeException e) {
                // the connection is gone
            } finally {
                open.remove(this);
                try {
                    socket.close();
                } catch (IOException | RuntimeException ignored) {
                    // closing anyway
                }
                try {
                    raw.close();
                } catch (IOException ignored) {
                    // closing anyway
                }
            }
        }

        private void streams() throws IOException {
            in = new BufferedInputStream(socket.getInputStream(), 65_536);
            out = new BufferedOutputStream(socket.getOutputStream(), 65_536);
        }

        void drop() {
            ending = true;
            try {
                raw.setSoLinger(true, 0);
                raw.close();
            } catch (IOException ignored) {
                // closing anyway
            }
        }

        private void command(String verb, String arg) throws IOException {
            switch (verb) {
                case "EHLO", "HELO" -> {
                    if (arg.isEmpty()) {
                        reply("501 5.5.4 Syntax: " + verb + " hostname");
                        return;
                    }
                    greeted = true;
                    resetTransaction();
                    if (verb.equals("HELO")) {
                        reply("250 " + options.hostname + " at your service");
                        return;
                    }
                    List<String> lines = new ArrayList<>();
                    lines.add(options.hostname + " at your service, [127.0.0.1]");
                    if (has(Extension.SIZE)) {
                        lines.add("SIZE " + options.maxSize);
                    }
                    if (has(Extension.EIGHTBITMIME)) {
                        lines.add("8BITMIME");
                    }
                    if (options.mode == Mode.STARTTLS && !tls && has(Extension.STARTTLS)) {
                        lines.add("STARTTLS");
                    }
                    if (has(Extension.AUTH) && (tls || options.mode == Mode.PLAIN)) {
                        lines.add("AUTH PLAIN LOGIN");
                    }
                    if (has(Extension.PIPELINING)) {
                        lines.add("PIPELINING");
                    }
                    if (has(Extension.SMTPUTF8)) {
                        lines.add("SMTPUTF8");
                    }
                    StringBuilder b = new StringBuilder();
                    for (int i = 0; i < lines.size(); i++) {
                        b.append("250").append(i == lines.size() - 1 ? ' ' : '-').append(lines.get(i));
                        if (i < lines.size() - 1) {
                            b.append("\r\n");
                        }
                    }
                    reply(b.toString());
                }
                case "STARTTLS" -> {
                    if (tls) {
                        reply("503 5.5.1 TLS already active");
                    } else if (options.mode != Mode.STARTTLS || !has(Extension.STARTTLS)) {
                        reply("502 5.5.1 Unrecognized command");
                    } else if (!arg.isEmpty()) {
                        reply("501 5.5.4 Syntax: STARTTLS");
                    } else {
                        reply("220 2.0.0 Ready to start TLS");
                        // Anything the client sent after STARTTLS in plain text is dropped with the old streams.
                        socket = FakeTls.serverSide(sslContext, raw);
                        tls = true;
                        streams();
                        greeted = false;
                        login = null;
                        resetTransaction();
                    }
                }
                case "AUTH" -> auth(arg);
                case "MAIL" -> mail(arg);
                case "RCPT" -> rcpt(arg);
                case "DATA" -> data(arg);
                case "RSET" -> {
                    resetTransaction();
                    reply("250 2.0.0 OK");
                }
                case "NOOP" -> reply("250 2.0.0 OK");
                case "QUIT" -> {
                    reply("221 2.0.0 closing connection");
                    ending = true;
                }
                case "VRFY" -> reply("252 2.1.5 Cannot VRFY user, but will accept message");
                default -> reply("502 5.5.1 Unrecognized command");
            }
        }

        private boolean has(Extension e) {
            return options.extensions.contains(e);
        }

        private void resetTransaction() {
            from = null;
            params = List.of();
            rcpts.clear();
        }

        private void auth(String arg) throws IOException {
            if (!greeted) {
                reply("503 5.5.1 EHLO/HELO first.");
                return;
            }
            if (options.mode == Mode.STARTTLS && !tls) {
                reply("530 5.7.0 Must issue a STARTTLS command first");
                return;
            }
            if (!has(Extension.AUTH)) {
                reply("502 5.5.1 Unrecognized command");
                return;
            }
            if (login != null) {
                reply("503 5.5.1 Already authenticated.");
                return;
            }
            if (from != null) {
                reply("503 5.5.1 AUTH not allowed during a mail transaction.");
                return;
            }
            String[] parts = arg.split(" ", 2);
            String mech = parts[0].toUpperCase(Locale.ROOT);
            String initial = parts.length > 1 ? parts[1].trim() : null;
            String user;
            String pass;
            if (mech.equals("PLAIN")) {
                if (initial == null) {
                    reply("334 ");
                    initial = line();
                    if (initial == null) {
                        throw new IOException("gone");
                    }
                }
                if (initial.equals("*")) {
                    reply("501 5.0.0 Authentication cancelled.");
                    return;
                }
                String[] plain = decode(initial);
                if (plain == null) {
                    return;
                }
                String[] fields = String.join("", plain).split("\u0000", -1);
                if (fields.length != 3) {
                    reply("501 5.5.2 Cannot decode response.");
                    return;
                }
                user = fields[1];
                pass = fields[2];
            } else if (mech.equals("LOGIN")) {
                String u = initial;
                if (u == null) {
                    reply("334 VXNlcm5hbWU6");
                    u = line();
                }
                if (u == null) {
                    throw new IOException("gone");
                }
                if (u.equals("*")) {
                    reply("501 5.0.0 Authentication cancelled.");
                    return;
                }
                String[] du = decode(u);
                if (du == null) {
                    return;
                }
                reply("334 UGFzc3dvcmQ6");
                String p = line();
                if (p == null) {
                    throw new IOException("gone");
                }
                if (p.equals("*")) {
                    reply("501 5.0.0 Authentication cancelled.");
                    return;
                }
                String[] dp = decode(p);
                if (dp == null) {
                    return;
                }
                user = du[0];
                pass = dp[0];
            } else {
                reply("504 5.5.4 Unrecognized authentication type.");
                return;
            }
            String refusal = authRefusal;
            if (refusal != null) {
                reply(refusal);
                return;
            }
            String expected = users.get(user);
            if (expected == null || !expected.equals(pass)) {
                reply("535 5.7.8 Username and Password not accepted.");
                return;
            }
            login = user;
            logins.incrementAndGet();
            reply("235 2.7.0 Accepted");
        }

        /** Base64 to text, or null after replying 501. */
        private String[] decode(String b64) throws IOException {
            try {
                return new String[] {new String(Base64.getDecoder().decode(b64.trim()), StandardCharsets.UTF_8)};
            } catch (IllegalArgumentException e) {
                reply("501 5.5.2 Cannot decode response.");
                return null;
            }
        }

        private void mail(String arg) throws IOException {
            if (!greeted) {
                reply("503 5.5.1 EHLO/HELO first.");
                return;
            }
            if (options.mode == Mode.STARTTLS && !tls) {
                reply("530 5.7.0 Must issue a STARTTLS command first");
                return;
            }
            if (options.requireAuth && login == null) {
                reply("530 5.7.0 Authentication Required.");
                return;
            }
            if (from != null) {
                reply("503 5.5.1 Nested MAIL command.");
                return;
            }
            if (!arg.toUpperCase(Locale.ROOT).startsWith("FROM:")) {
                reply("501 5.5.4 Syntax: MAIL FROM:<address>");
                return;
            }
            String rest = arg.substring(5).trim();
            String address = path(rest);
            if (address == null) {
                reply("501 5.1.7 Bad sender address syntax.");
                return;
            }
            List<String> ps = new ArrayList<>();
            String tail = rest.substring(rest.indexOf('>') + 1).trim();
            for (String p : tail.isEmpty() ? new String[0] : tail.split("\\s+")) {
                String u = p.toUpperCase(Locale.ROOT);
                if (u.startsWith("SIZE=") && has(Extension.SIZE)) {
                    long n;
                    try {
                        n = Long.parseLong(p.substring(5));
                    } catch (NumberFormatException e) {
                        reply("501 5.5.4 Bad SIZE parameter.");
                        return;
                    }
                    if (n > options.maxSize) {
                        reply("552 5.3.4 Message size exceeds fixed limit.");
                        return;
                    }
                } else if (u.equals("SMTPUTF8") && has(Extension.SMTPUTF8)) {
                    // fine
                } else if ((u.equals("BODY=8BITMIME") && has(Extension.EIGHTBITMIME)) || u.equals("BODY=7BIT")) {
                    // fine
                } else {
                    reply("555 5.5.4 Unsupported option: " + p);
                    return;
                }
                ps.add(p);
            }
            String fault = takeFault(Stage.MAIL);
            if (fault != null) {
                reply(fault);
                return;
            }
            from = address;
            params = List.copyOf(ps);
            reply("250 2.1.0 OK");
        }

        private void rcpt(String arg) throws IOException {
            if (from == null) {
                reply("503 5.5.1 need MAIL before RCPT.");
                return;
            }
            if (!arg.toUpperCase(Locale.ROOT).startsWith("TO:")) {
                reply("501 5.5.4 Syntax: RCPT TO:<address>");
                return;
            }
            String address = path(arg.substring(3).trim());
            if (address == null || address.isEmpty()) {
                reply("553 5.1.3 Bad recipient address syntax.");
                return;
            }
            String fault = rcptFault(address);
            if (fault == null) {
                fault = takeFault(Stage.RCPT);
            }
            if (fault != null) {
                reply(fault);
                return;
            }
            rcpts.add(address);
            reply("250 2.1.5 OK");
        }

        private void data(String arg) throws IOException {
            if (from == null) {
                reply("503 5.5.1 need MAIL command.");
                return;
            }
            if (rcpts.isEmpty()) {
                reply("503 5.5.1 RCPT first.");
                return;
            }
            if (!arg.isEmpty()) {
                reply("501 5.5.4 Syntax: DATA");
                return;
            }
            String fault = takeFault(Stage.DATA);
            if (fault != null) {
                reply(fault);
                return;
            }
            reply("354 Go ahead");
            long cap = has(Extension.SIZE) ? options.maxSize : 64L * 1024 * 1024;
            ByteArrayOutputStream data = new ByteArrayOutputStream();
            boolean tooBig = false;
            boolean lineStart = true;
            while (true) {
                byte[] line = rawLine();
                if (line == null) {
                    throw new IOException("gone during DATA");
                }
                int n = line.length;
                boolean ended = line[n - 1] == '\n';
                if (lineStart && ended && line[0] == '.' && (n == 2 || (n == 3 && line[1] == '\r'))) {
                    break;
                }
                int skip = lineStart && line[0] == '.' ? 1 : 0;
                lineStart = ended;
                if (!tooBig) {
                    data.write(line, skip, n - skip);
                    if (data.size() > cap) {
                        tooBig = true;
                        data = new ByteArrayOutputStream();
                    }
                }
            }
            int drop = takeDrop();
            if (drop != 0) {
                if (drop == 1 && !tooBig) {
                    keep(data.toByteArray());
                }
                resetTransaction();
                drop();
                return;
            }
            if (tooBig) {
                resetTransaction();
                reply("552 5.3.4 Message size exceeds fixed limit.");
                return;
            }
            String end = takeFault(Stage.END_OF_DATA);
            if (end != null) {
                resetTransaction();
                reply(end);
                return;
            }
            try {
                keep(data.toByteArray());
            } catch (RuntimeException e) {
                resetTransaction();
                reply("451 4.3.0 Message not kept: the test's hook failed.");
                return;
            }
            resetTransaction();
            reply("250 2.0.0 OK " + ids.incrementAndGet() + " - FakeSmtpServer");
        }

        private void keep(byte[] data) {
            Received r = new Received(login, from, List.copyOf(rcpts), data, params, tls, Instant.now());
            Consumer<Received> h = hook;
            if (h != null) {
                h.accept(r);
            }
            received.add(r);
        }

        /** The address in {@code <...>}, or null. {@code <>} is the empty string. */
        private String path(String s) {
            if (!s.startsWith("<")) {
                return null;
            }
            int close = s.indexOf('>');
            if (close < 0) {
                return null;
            }
            return s.substring(1, close);
        }

        private void reply(String text) throws IOException {
            long d = delayMillis;
            if (d > 0) {
                try {
                    Thread.sleep(d);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }
            out.write((text + "\r\n").getBytes(StandardCharsets.UTF_8));
            out.flush();
        }

        /** A command line without its line end, or null at the end of the stream. */
        private String line() throws IOException {
            byte[] b = rawLine();
            if (b == null) {
                return null;
            }
            int n = b.length;
            if (n > 0 && b[n - 1] == '\n') {
                n--;
            }
            if (n > 0 && b[n - 1] == '\r') {
                n--;
            }
            return new String(b, 0, n, StandardCharsets.UTF_8);
        }

        /** A line with its line end, or null at the end of the stream. Lines over 1 MiB are split. */
        private byte[] rawLine() throws IOException {
            ByteArrayOutputStream b = new ByteArrayOutputStream(128);
            while (true) {
                int c = in.read();
                if (c == -1) {
                    return b.size() == 0 ? null : b.toByteArray();
                }
                b.write(c);
                if (c == '\n' || b.size() >= 1 << 20) {
                    return b.toByteArray();
                }
            }
        }
    }
}
