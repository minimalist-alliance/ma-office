package com.minimalistalliance.desk.deskd.browser;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.util.Locale;
import java.util.Set;
import java.util.function.Supplier;

/**
 * Who holds Chromium's debugging port, by the kernel's own table. nftables limits who may connect to
 * 127.0.0.1:9222, not who may bind it, so while Chromium is down any local user could listen there, show false
 * tabs and hear what a client types. So nothing connects until the listener's uid is the one that's expected
 * (desk-runtime.md section 1: desk-browser runs as kiosk, 1102). deskd's container uses host networking, so
 * /proc/net is the host's.
 *
 * <p>A socket can answer a connection to 127.0.0.1 if it's bound to that address or to a wildcard, in either
 * table: on tcp6, {@code ::} unless it's IPV6_V6ONLY, which the table doesn't say, and the v4-mapped forms. So
 * those all count. {@code ::1} and other 127.x addresses can't answer deskd, so they don't.
 *
 * <p><b>Chromium on {@code ::1}.</b> Chromium binds 127.0.0.1 as told, and falls back to ::1 if that's taken, by a
 * listener or by a socket that's only bound, which is in no table. It stays there once that's free. deskd doesn't
 * follow it, as nftables' rule for the port is for 127.0.0.1. So the expected uid on ::1, with nothing that could
 * answer deskd, is {@link Kind#DISPLACED}, which is how deskd knows to restart it.
 *
 * <p><b>Connections count as well as listeners.</b> The JDK's HTTP client keeps a connection for the next request, and
 * a WebSocket's upgrade goes over one too (seen on JDK 21). So one request that landed on someone holding the port for
 * a moment would leave them a connection that goes on answering, WebSocket included, after Chromium has the port back
 * and is the only listener. What they accepted stays in the table, established on this port, under their uid, so it
 * reads as them for as long as they keep it. There's no way to pass it to another uid short of being root. The kernel
 * shows root for a connection nobody has accepted yet, which deskd's own to Chromium can be for a moment, and those
 * can't answer anything yet, so root isn't counted here.
 *
 * <p>Addresses are in the kernel's byte order, which is little-endian on both x86_64 and arm64. On anything else
 * nothing would match, nobody would seem to be listening, and nothing would connect: it fails closed.
 *
 * <p><b>Cost.</b> One read of each table, only on a connection attempt or a read of /json/list, so about once a
 * second while someone is viewing, and never on an idle desk. The kernel walks its TCP hash table, which is sized by
 * the machine's memory, so each read is small on a desk: 2 to 5 ms even on a 64 GB build machine.
 *
 * <p><b>What it can't see.</b> It knows a uid, not a program, and the kernel's walk isn't atomic. A listener missed by
 * that walk reads as nobody listening, which connects to nothing. services/CLAUDE.md, Known gaps, has the rest.
 */
final class CdpListener implements Supplier<CdpListener.Verdict> {

    static final Path PROC_TCP = Path.of("/proc/net/tcp");
    static final Path PROC_TCP6 = Path.of("/proc/net/tcp6");

    /** In the order that one overrides another, as any listener that isn't the expected one decides it. */
    enum Kind {
        /** Nothing could answer. A connection would be refused, so there's no need to try one. */
        NONE,
        /** Nothing could answer, and the expected uid is listening on {@code ::1}, which nothing else will move it from. */
        DISPLACED,
        /** Everything that could answer belongs to the expected uid. */
        TRUSTED,
        /** Something else could answer, on a listener or a connection it accepted: this is {@link Verdict#uid}. */
        FOREIGN,
        /** The table couldn't be read or understood, so nobody can be trusted. */
        UNREADABLE
    }

    /** @param uid the listener's, or -1 if that isn't known */
    record Verdict(Kind kind, int uid) {
        static final Verdict NONE = new Verdict(Kind.NONE, -1);
        static final Verdict UNREADABLE = new Verdict(Kind.UNREADABLE, -1);
    }

    private static final String HEADER_START = "  sl  local_address";
    /** Tens of thousands of sockets, where a desk has hundreds. Any local user can make sockets, and this is the heap. */
    static final int MAX_TABLE_BYTES = 8 * 1024 * 1024;
    private static final String ESTABLISHED = "01";
    private static final String LISTEN = "0A";
    /** What the kernel says of a connection nobody has accepted yet, whoever's listener it came to. */
    private static final int NOBODY_YET = 0;
    private static final String IPV6_LOOPBACK = "00000000000000000000000001000000";
    private static final Set<String> REACHES_IPV4_LOOPBACK = Set.of("0100007F", "00000000");
    private static final Set<String> REACHES_IPV4_LOOPBACK_6 = Set.of(
            "00000000000000000000000000000000", "0000000000000000FFFF00000100007F", "0000000000000000FFFF000000000000");
    private static final int LOCAL_ADDRESS = 1;
    private static final int STATE = 3;
    private static final int UID = 7;

    private final Path tcp;
    private final Path tcp6;
    private final String portHex;
    private final String portField;
    private final int expectedUid;

    /** @param tcp and tcp6 are other than {@link #PROC_TCP} and {@link #PROC_TCP6} only for tests */
    CdpListener(Path tcp, Path tcp6, int port, int expectedUid) {
        this.tcp = tcp;
        this.tcp6 = tcp6;
        this.portHex = String.format(Locale.ROOT, "%04X", port);
        this.portField = ":" + portHex + " ";
        this.expectedUid = expectedUid;
    }

    /**
     * What's listening right now. Fails closed: anything unexpected is {@link Kind#UNREADABLE}. A cancelled call's
     * interrupt doesn't stop this, as the JDK's {@code Files.newInputStream} is uninterruptible, so that can't look
     * like an unreadable table.
     */
    @Override
    public Verdict get() {
        try {
            Verdict verdict = scan(tcp, REACHES_IPV4_LOOPBACK);
            try {
                return worse(verdict, scan(tcp6, REACHES_IPV4_LOOPBACK_6));
            } catch (NoSuchFileException e) {
                // A kernel without IPv6 has no such table, and no such socket.
                return verdict;
            }
        } catch (IOException | RuntimeException e) {
            return Verdict.UNREADABLE;
        }
    }

    /** Whole, and only the lines naming this port are looked at, as this runs on a thread other calls may need. */
    private Verdict scan(Path table, Set<String> reachable) throws IOException {
        byte[] bytes;
        try (InputStream in = Files.newInputStream(table)) {
            bytes = in.readNBytes(MAX_TABLE_BYTES + 1);
        }
        if (bytes.length > MAX_TABLE_BYTES) {
            throw new IOException("too many sockets to look through");
        }
        String text = new String(bytes, StandardCharsets.ISO_8859_1);
        if (!text.startsWith(HEADER_START)) {
            throw new IOException("not the table");
        }
        Verdict verdict = Verdict.NONE;
        for (int at = text.indexOf(portField); at >= 0; at = text.indexOf(portField, at + portField.length())) {
            int end = text.indexOf('\n', at);
            String line = text.substring(text.lastIndexOf('\n', at) + 1, end < 0 ? text.length() : end);
            verdict = worse(verdict, listener(line, reachable));
        }
        return verdict;
    }

    private Verdict listener(String line, Set<String> reachable) throws IOException {
        String[] fields = line.trim().split("\\s+");
        if (fields.length <= UID) {
            throw new IOException("a short line");
        }
        int colon = fields[LOCAL_ADDRESS].indexOf(':');
        if (colon < 0) {
            throw new IOException("no port");
        }
        String state = fields[STATE];
        String address = fields[LOCAL_ADDRESS].substring(0, colon);
        if ((!LISTEN.equals(state) && !ESTABLISHED.equals(state))
                || !portHex.equals(fields[LOCAL_ADDRESS].substring(colon + 1))) {
            return Verdict.NONE;
        }
        if (LISTEN.equals(state) && IPV6_LOOPBACK.equals(address)) {
            int uid = Integer.parseInt(fields[UID]);
            return uid == expectedUid ? new Verdict(Kind.DISPLACED, uid) : Verdict.NONE;
        }
        if (!reachable.contains(address)) {
            return Verdict.NONE;
        }
        int uid = Integer.parseInt(fields[UID]);
        if (LISTEN.equals(state)) {
            return uid == expectedUid ? new Verdict(Kind.TRUSTED, uid) : new Verdict(Kind.FOREIGN, uid);
        }
        return uid == expectedUid || uid == NOBODY_YET ? Verdict.NONE : new Verdict(Kind.FOREIGN, uid);
    }

    private static Verdict worse(Verdict a, Verdict b) {
        return b.kind().compareTo(a.kind()) > 0 ? b : a;
    }
}
