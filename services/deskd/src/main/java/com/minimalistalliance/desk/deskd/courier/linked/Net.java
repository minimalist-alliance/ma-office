package com.minimalistalliance.desk.deskd.courier.linked;

import java.io.IOException;
import java.net.Inet4Address;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.Socket;
import java.net.SocketException;
import java.net.UnknownHostException;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;
import javax.net.ssl.SNIHostName;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSocket;

/**
 * Where a linked mailbox's transport may connect, and how (the launch plan §3.6; Security's condition on the vault's
 * question 4). The member names the hosts, and deskd runs on the desk's host network, so a host name is a way to reach
 * whatever the desk can reach. So every connect, and every reconnect, resolves the name and refuses it if <b>any</b> of
 * its addresses is loopback, link-local (IMDS's {@code 169.254.169.254} and {@code fd00:ec2::254} included), private,
 * shared (CGNAT), multicast, reserved or one of the desk's own; then connects to an address it checked, never the name
 * again, so a DNS answer that changes between the check and the connect can't redirect it. Only the ports desk egress
 * allows (ADR 0014): IMAP over TLS on 993, SMTP on 465 (TLS) and 587 (STARTTLS, required). TLS 1.2 or 1.3, with the
 * host name checked against the certificate; never plain text.
 *
 * <p>{@link #forTests} is the only way to loopback, another port or another trust store: a constructor argument, never a
 * setting, so nothing on a desk can turn it on.
 */
public final class Net {

    /**
     * A wall-clock bound on a whole exchange with a provider, on this thread (Security's CI-L2): a read timeout alone lets a
     * server that sends a byte a minute hold a sign-in check or the outbound queue for as long as it likes. Every socket
     * {@link #connect} makes while one is open on the thread is closed when its time runs out, which ends any read or write
     * on it with an {@link IOException}.
     */
    public static final class Deadline implements AutoCloseable {
        static final ThreadLocal<Deadline> CURRENT = new ThreadLocal<>();
        private static final java.util.concurrent.ScheduledExecutorService TIMER = java.util.concurrent.Executors
                .newSingleThreadScheduledExecutor(Thread.ofPlatform().daemon().name("courier-deadline").factory());
        private final List<Socket> sockets = new ArrayList<>();
        private final Deadline outer;
        private final java.util.concurrent.ScheduledFuture<?> task;
        private boolean fired;

        private Deadline(Duration after) {
            this.outer = CURRENT.get();
            this.task = TIMER.schedule(this::fire, Math.max(1, after.toMillis()), java.util.concurrent.TimeUnit.MILLISECONDS);
        }

        /** Opens one on this thread; close it when the exchange is done. */
        public static Deadline start(Duration after) {
            Deadline d = new Deadline(after);
            CURRENT.set(d);
            return d;
        }

        synchronized void watch(Socket s) throws IOException {
            if (fired) {
                s.close();
                throw new java.net.SocketTimeoutException("deadline");
            }
            sockets.add(s);
        }

        public synchronized boolean fired() {
            return fired;
        }

        private synchronized void fire() {
            fired = true;
            for (Socket s : sockets) {
                try {
                    s.close();
                } catch (IOException ignored) {
                    // closing is all that's wanted
                }
            }
        }

        @Override
        public void close() {
            task.cancel(false);
            if (CURRENT.get() == this) {
                if (outer != null) {
                    CURRENT.set(outer);
                } else {
                    CURRENT.remove();
                }
            }
            synchronized (this) {
                sockets.clear();
            }
        }
    }

    /** The IMAP and SMTP ports desk egress lets out. */
    public static final Set<Integer> IMAP_PORTS = Set.of(993);
    public static final Set<Integer> SMTP_PORTS = Set.of(465, 587);
    private static final Pattern HOST = Pattern.compile("[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?");

    /** Why a connect was refused before anything went out: a word for the office ({@code host}, {@code port}, {@code address}). */
    public static final class Refused extends IOException {
        private static final long serialVersionUID = 1L;
        private final String reason;

        public Refused(String reason) {
            super(reason, null);
            this.reason = reason;
        }

        public String reason() {
            return reason;
        }
    }

    /** A name resolver, so tests can say what a name resolves to. */
    @FunctionalInterface
    public interface Resolver {
        InetAddress[] resolve(String host) throws UnknownHostException;
    }

    private final SSLContext tls;
    private final boolean checkHost;
    private final boolean anyAddress;
    private final Resolver resolver;
    private final Duration connectTimeout;

    private Net(SSLContext tls, boolean checkHost, boolean anyAddress, Resolver resolver, Duration connectTimeout) {
        this.tls = tls;
        this.checkHost = checkHost;
        this.anyAddress = anyAddress;
        this.resolver = resolver;
        this.connectTimeout = connectTimeout;
    }

    /** The desk's: the JDK's trust store, the host checked, public addresses and egress's ports only. */
    public static Net strict() {
        try {
            return new Net(SSLContext.getDefault(), true, false, InetAddress::getAllByName, Duration.ofSeconds(20));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("no TLS", e);
        }
    }

    /** Strict, with a resolver of the test's: what the address check refuses, without a real DNS name. */
    static Net strict(Resolver resolver) {
        Net s = strict();
        return new Net(s.tls, true, false, resolver, s.connectTimeout);
    }

    /** For tests only: loopback and any port, trusting {@code tls}'s certificates without a host check. */
    public static Net forTests(SSLContext tls) {
        return new Net(tls, false, true, InetAddress::getAllByName, Duration.ofSeconds(5));
    }

    /**
     * A host name as the member gave it: lowercase letters, digits, dots and hyphens, as a DNS name; an IP literal is
     * refused (a provider is reached by its name, which its certificate names).
     */
    static String host(String host) throws Refused {
        String h = host == null ? null : host.strip().toLowerCase(Locale.ROOT);
        if (h == null || !HOST.matcher(h).matches() || h.contains("..") || h.matches("[0-9.]+") || !h.contains(".")) {
            throw new Refused("host");
        }
        return h;
    }

    /** The addresses of {@code host} the desk may connect to, in the resolver's order; a refusal if any isn't one. */
    List<InetAddress> addresses(String host, int port, Set<Integer> ports) throws Refused, UnknownHostException {
        String h = anyAddress ? host : host(host);
        if (!anyAddress && !ports.contains(port)) {
            throw new Refused("port");
        }
        InetAddress[] all = resolver.resolve(h);
        if (all == null || all.length == 0) {
            throw new UnknownHostException("no address");
        }
        if (!anyAddress) {
            Set<InetAddress> own = own();
            for (InetAddress a : all) {
                if (forbidden(a) || own.contains(a)) {
                    throw new Refused("address");
                }
            }
        }
        List<InetAddress> out = new ArrayList<>();
        Collections.addAll(out, all);
        return out;
    }

    /**
     * A TCP connection to {@code host}, through an address checked by {@link #addresses}, each tried in turn. {@code tls}
     * true does the handshake at once (IMAP on 993, SMTP on 465); false leaves it plain for SMTP's STARTTLS, which
     * {@link #startTls} upgrades.
     */
    Socket connect(String host, int port, Set<Integer> ports, boolean tls, Duration readTimeout) throws IOException {
        List<InetAddress> addrs = addresses(host, port, ports);
        IOException last = null;
        Deadline deadline = Deadline.CURRENT.get();
        for (InetAddress a : addrs) {
            Socket s = new Socket();
            try {
                if (deadline != null) {
                    deadline.watch(s);
                }
                s.setTcpNoDelay(true);
                s.setKeepAlive(true);
                s.connect(new InetSocketAddress(a, port), (int) connectTimeout.toMillis());
                s.setSoTimeout((int) readTimeout.toMillis());
                return tls ? startTls(s, host, port) : s;
            } catch (IOException e) {
                last = e;
                try {
                    s.close();
                } catch (IOException ignored) {
                    // closing a socket that failed
                }
            }
        }
        throw last == null ? new IOException("unreachable") : last;
    }

    /**
     * A plain TCP connection to a member's own server (the iMessage transport's Mac, Wave 2.6), through an address checked
     * as {@link #addresses} checks one: any address of the name that's loopback, private, link-local and the rest refuses
     * the connect, and the connect goes to the checked address, never the name again. Unlike a mailbox, a Mac reached through
     * a port forward may be named by a public IP literal ({@code 203.0.113.9} or {@code [2001:db8::9]}), and its port is
     * the caller's to allow ({@code portOk}). TLS is the caller's too (a pinned certificate needs its own trust).
     */
    public Socket openTcp(String host, int port, java.util.function.IntPredicate portOk, Duration readTimeout) throws IOException {
        InetAddress literal = anyAddress ? null : literal(host);
        List<InetAddress> addrs;
        if (literal != null) {
            if (!portOk.test(port)) {
                throw new Refused("port");
            }
            if (forbidden(literal) || own().contains(literal)) {
                throw new Refused("address");
            }
            addrs = List.of(literal);
        } else if (anyAddress) {
            addrs = addresses(host, port, Set.of());
        } else {
            String h = host(host);
            if (!portOk.test(port)) {
                throw new Refused("port");
            }
            addrs = addresses(h, port, Set.of(port));
        }
        IOException last = null;
        Deadline deadline = Deadline.CURRENT.get();
        for (InetAddress a : addrs) {
            Socket s = new Socket();
            try {
                if (deadline != null) {
                    deadline.watch(s);
                }
                s.setTcpNoDelay(true);
                s.setKeepAlive(true);
                s.connect(new InetSocketAddress(a, port), (int) connectTimeout.toMillis());
                s.setSoTimeout((int) readTimeout.toMillis());
                return s;
            } catch (IOException e) {
                last = e;
                try {
                    s.close();
                } catch (IOException ignored) {
                    // closing a socket that failed
                }
            }
        }
        throw last == null ? new IOException("unreachable") : last;
    }

    private static final Pattern IPV4 = Pattern.compile("(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(\\.(25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}");
    private static final Pattern IPV6 = Pattern.compile("\\[[0-9A-Fa-f:.]{2,45}]");

    /** A public IP literal as a URL's host gives it ({@code 203.0.113.9}, {@code [2001:db8::9]}), or null for a name. */
    static InetAddress literal(String host) throws Refused {
        if (host == null) {
            throw new Refused("host");
        }
        String h = host.strip();
        try {
            if (IPV4.matcher(h).matches()) {
                return InetAddress.getByName(h);
            }
            if (IPV6.matcher(h).matches()) {
                InetAddress a = InetAddress.getByName(h.substring(1, h.length() - 1));
                if (!(a instanceof Inet6Address) && !(a instanceof Inet4Address)) {
                    throw new Refused("host");
                }
                return a;
            }
        } catch (UnknownHostException e) {
            throw new Refused("host");
        }
        if (h.matches("[0-9.]+") || h.contains(":") || h.contains("[")) {
            throw new Refused("host");
        }
        return null;
    }

    /** TLS over {@code plain}, the host's name sent and checked against its certificate; 1.2 or 1.3 only. */
    SSLSocket startTls(Socket plain, String host, int port) throws IOException {
        SSLSocket s = (SSLSocket) tls.getSocketFactory().createSocket(plain, host, port, true);
        SSLParameters p = s.getSSLParameters();
        List<String> protocols = new ArrayList<>();
        for (String v : s.getSupportedProtocols()) {
            if (v.equals("TLSv1.3") || v.equals("TLSv1.2")) {
                protocols.add(v);
            }
        }
        p.setProtocols(protocols.toArray(String[]::new));
        if (checkHost) {
            p.setEndpointIdentificationAlgorithm("HTTPS");
            p.setServerNames(List.of(new SNIHostName(host)));
        }
        s.setSSLParameters(p);
        try {
            s.startHandshake();
        } catch (IOException e) {
            try {
                s.close();
            } catch (IOException ignored) {
                // the handshake failed
            }
            throw new TlsFailed();
        }
        return s;
    }

    /** The provider's certificate or TLS failed: never retried in plain text. */
    public static final class TlsFailed extends IOException {
        private static final long serialVersionUID = 1L;

        TlsFailed() {
            super("tls", null);
        }
    }

    /**
     * An address a linked mailbox may never be: unspecified, loopback, link-local, private (RFC 1918, ULA), shared (RFC 6598),
     * multicast, documentation, benchmarking or reserved; IPv6 forms that carry an IPv4 address (mapped, NAT64, 6to4) by the
     * address they carry.
     */
    static boolean forbidden(InetAddress a) {
        if (a.isAnyLocalAddress() || a.isLoopbackAddress() || a.isLinkLocalAddress() || a.isSiteLocalAddress() || a.isMulticastAddress()) {
            return true;
        }
        byte[] b = a.getAddress();
        if (a instanceof Inet4Address) {
            return forbidden4(b);
        }
        if (a instanceof Inet6Address) {
            int first = b[0] & 0xFF;
            // fc00::/7, unique local (fd00:ec2::254, IMDS, among them)
            if ((first & 0xFE) == 0xFC) {
                return true;
            }
            // ::/96 and ::ffff:0:0/96 (compatible and mapped), 64:ff9b::/96 (NAT64): the IPv4 address inside
            boolean zeros = true;
            for (int i = 0; i < 10; i++) {
                zeros &= b[i] == 0;
            }
            if (zeros && ((b[10] == 0 && b[11] == 0) || ((b[10] & 0xFF) == 0xFF && (b[11] & 0xFF) == 0xFF))) {
                return forbidden4(new byte[] {b[12], b[13], b[14], b[15]});
            }
            if (b[0] == 0 && (b[1] & 0xFF) == 0x64 && (b[2] & 0xFF) == 0xFF && (b[3] & 0xFF) == 0x9B) {
                return forbidden4(new byte[] {b[12], b[13], b[14], b[15]});
            }
            // 2002::/16 (6to4): the IPv4 address in bytes 2 to 5
            if ((b[0] & 0xFF) == 0x20 && (b[1] & 0xFF) == 0x02) {
                return forbidden4(new byte[] {b[2], b[3], b[4], b[5]});
            }
            // 2001:db8::/32 documentation, 100::/64 discard
            if ((b[0] & 0xFF) == 0x20 && (b[1] & 0xFF) == 0x01 && (b[2] & 0xFF) == 0x0D && (b[3] & 0xFF) == 0xB8) {
                return true;
            }
            return (b[0] & 0xFF) == 0x01 && b[1] == 0 && b[2] == 0 && b[3] == 0 && b[4] == 0 && b[5] == 0 && b[6] == 0 && b[7] == 0;
        }
        return true;
    }

    private static boolean forbidden4(byte[] b) {
        int a0 = b[0] & 0xFF;
        int a1 = b[1] & 0xFF;
        int a2 = b[2] & 0xFF;
        return a0 == 0 // this network
                || a0 == 10 // private
                || a0 == 127 // loopback
                || (a0 == 100 && a1 >= 64 && a1 <= 127) // shared, CGNAT
                || (a0 == 169 && a1 == 254) // link-local, IMDS
                || (a0 == 172 && a1 >= 16 && a1 <= 31) // private
                || (a0 == 192 && a1 == 0 && a2 == 0) // IETF protocol assignments
                || (a0 == 192 && a1 == 0 && a2 == 2) // documentation
                || (a0 == 192 && a1 == 88 && a2 == 99) // 6to4 relay anycast
                || (a0 == 192 && a1 == 168) // private
                || (a0 == 198 && (a1 == 18 || a1 == 19)) // benchmarking
                || (a0 == 198 && a1 == 51 && a2 == 100) // documentation
                || (a0 == 203 && a1 == 0 && a2 == 113) // documentation
                || a0 >= 224; // multicast, reserved, broadcast
    }

    /** The desk's own addresses, on every interface: never a provider. */
    private static Set<InetAddress> own() {
        Set<InetAddress> out = new java.util.HashSet<>();
        try {
            var ifaces = NetworkInterface.getNetworkInterfaces();
            while (ifaces != null && ifaces.hasMoreElements()) {
                var addrs = ifaces.nextElement().getInetAddresses();
                while (addrs.hasMoreElements()) {
                    out.add(addrs.nextElement());
                }
            }
        } catch (SocketException e) {
            // Can't list them: the address checks above still hold.
        }
        return out;
    }
}
