package com.minimalistalliance.desk.deskd.courier.imsg.bluebubbles;

import com.minimalistalliance.desk.deskd.courier.linked.Net;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.security.cert.CertificateException;
import java.security.cert.X509Certificate;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import javax.net.ssl.SNIHostName;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.TrustManager;
import javax.net.ssl.TrustManagerFactory;
import javax.net.ssl.X509TrustManager;

/**
 * How the desk reaches the member's Mac (the launch plan's Wave 2.6): one TCP connection per exchange to an address
 * {@link Net} checked (never loopback, private, link-local or the desk's own, and never the name again after the check),
 * TLS 1.2 or 1.3 with the host's certificate checked against the JDK's trust store, or, for a Mac whose own certificate
 * the member's setup made (a port forward with BlueBubbles' own HTTPS), exactly the certificate pinned when it was added.
 * Then a small HTTP/1.1 client that does only what BlueBubbles' REST API needs, and holds a hostile server to its limits:
 * <ul>
 *   <li>no redirect is followed, no proxy, no cookie, no compression;</li>
 *   <li>headers at most 64 KiB, a body at most what the call allows (counted as it arrives, never trusted from
 *       {@code Content-Length}), and the whole exchange within a wall-clock bound ({@link Net.Deadline}), so a server that
 *       sends a byte a minute can't hold a sync;</li>
 *   <li>the password goes as BlueBubbles' {@code guid} query parameter, written straight from the sealed bytes and zeroed
 *       after; no request line, header or body is ever logged.</li>
 * </ul>
 */
final class MacLink {

    /** Bounds. {@code exchange}: one request and its whole answer. */
    /**
     * {@code maxJson}: the most a JSON answer may be. jackson-jr makes a string for each value, so a broad answer costs many
     * times its bytes in deskd's heap: 2 MiB (4 for the Mac's contacts) is the bound (Security IM-M2).
     */
    record Settings(Duration readTimeout, Duration exchange, long maxJson, boolean plainForTests) {
        static final Settings DEFAULT = new Settings(Duration.ofSeconds(30), Duration.ofSeconds(90), 2L * 1024 * 1024, false);
    }

    static final int MAX_HEADERS = 64 * 1024;

    /** The answer: a status, its headers (names lowercased), its body. */
    record Response(int status, Map<String, String> headers, byte[] body) {}

    /** More than the call allows: the exchange is dropped, never truncated and used. */
    static final class TooLarge extends IOException {
        private static final long serialVersionUID = 1L;

        TooLarge() {
            super("too_large", null);
        }
    }

    /** The server didn't speak HTTP as it should. */
    static final class Protocol extends IOException {
        private static final long serialVersionUID = 1L;

        Protocol(String what) {
            super(what, null);
        }
    }

    /**
     * The certificate isn't one the JDK trusts, or isn't for this host: {@code fingerprint} is its leaf's SHA-256, which the
     * setup pins for the member's own address and nothing else.
     */
    static final class Untrusted extends IOException {
        private static final long serialVersionUID = 1L;
        private final String fingerprint;

        Untrusted(String fingerprint) {
            super("tls", null);
            this.fingerprint = fingerprint;
        }

        String fingerprint() {
            return fingerprint;
        }
    }

    /** The pinned certificate was replaced: a changed Mac, or someone in between. Never accepted without the member. */
    static final class PinChanged extends IOException {
        private static final long serialVersionUID = 1L;
        private final String fingerprint;

        PinChanged(String fingerprint) {
            super("pin", null);
            this.fingerprint = fingerprint;
        }

        /** The certificate the Mac shows now: its leaf's SHA-256. */
        String fingerprint() {
            return fingerprint;
        }
    }

    /** TLS failed for another reason. */
    static final class TlsFailed extends IOException {
        private static final long serialVersionUID = 1L;

        TlsFailed() {
            super("tls", null);
        }
    }

    private final Net net;
    private final X509TrustManager trusted;
    private final Settings settings;
    private final SecureRandom random = new SecureRandom();

    /** @param trusted the publicly trusted roots (the JDK's), or a test's */
    MacLink(Net net, X509TrustManager trusted, Settings settings) {
        this.net = net;
        this.trusted = trusted;
        this.settings = settings;
    }

    /** The JDK's own trust store, as a trust manager. */
    static X509TrustManager jdkTrust() {
        try {
            TrustManagerFactory f = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm());
            f.init((KeyStore) null);
            for (TrustManager t : f.getTrustManagers()) {
                if (t instanceof X509TrustManager x) {
                    return x;
                }
            }
        } catch (NoSuchAlgorithmException | java.security.KeyStoreException e) {
            throw new IllegalStateException("no trust store", e);
        }
        throw new IllegalStateException("no X509 trust manager");
    }

    Settings settings() {
        return settings;
    }

    /**
     * A connection to the Mac: TCP to a checked address, then TLS. {@code pin} ({@code sha256:<hex>}) accepts exactly that
     * certificate and nothing else; null accepts what the JDK trusts for this host.
     */
    Socket open(MacAddress a, String pin, Duration readTimeout) throws IOException {
        Socket plain = net.openTcp(a.host(), a.port(), MacAddress::portAllowed, readTimeout);
        if (!a.tls()) {
            if (!settings.plainForTests()) {
                plain.close();
                throw new Protocol("plain");
            }
            return plain;
        }
        String[] seen = new String[1];
        X509TrustManager trust = pin != null ? new Pinned(pin, seen) : new Capturing(trusted, seen);
        SSLSocket s;
        try {
            SSLContext ctx = SSLContext.getInstance("TLS");
            ctx.init(null, new TrustManager[] {trust}, random);
            String name = a.sniName();
            s = (SSLSocket) ctx.getSocketFactory().createSocket(plain, name != null ? name : a.host(), a.port(), true);
            SSLParameters p = s.getSSLParameters();
            List<String> protocols = new ArrayList<>();
            for (String v : s.getSupportedProtocols()) {
                if (v.equals("TLSv1.3") || v.equals("TLSv1.2")) {
                    protocols.add(v);
                }
            }
            p.setProtocols(protocols.toArray(String[]::new));
            if (name != null) {
                p.setServerNames(List.of(new SNIHostName(name)));
            }
            if (pin == null) {
                // The host's name (or IP) checked against the certificate: a pinned one is the member's own, by its hash.
                p.setEndpointIdentificationAlgorithm("HTTPS");
            }
            s.setSSLParameters(p);
        } catch (java.security.GeneralSecurityException | IllegalArgumentException e) {
            plain.close();
            throw new TlsFailed();
        }
        try {
            s.startHandshake();
        } catch (IOException e) {
            try {
                s.close();
            } catch (IOException ignored) {
                // the handshake failed
            }
            if (pin != null) {
                throw seen[0] != null && !seen[0].equals(pin) ? new PinChanged(seen[0]) : new TlsFailed();
            }
            throw seen[0] != null ? new Untrusted(seen[0]) : new TlsFailed();
        }
        return s;
    }

    /** {@code sha256:<hex>} of a certificate's DER bytes. */
    static String fingerprint(X509Certificate cert) {
        try {
            return "sha256:" + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(cert.getEncoded()));
        } catch (NoSuchAlgorithmException | java.security.cert.CertificateEncodingException e) {
            return null;
        }
    }

    /** Accepts exactly the pinned certificate (its leaf's SHA-256), whatever else it says. */
    private static final class Pinned implements X509TrustManager {
        private final String pin;
        private final String[] seen;

        Pinned(String pin, String[] seen) {
            this.pin = pin;
            this.seen = seen;
        }

        @Override
        public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
            if (chain == null || chain.length == 0) {
                throw new CertificateException("no certificate");
            }
            String fp = fingerprint(chain[0]);
            seen[0] = fp;
            if (fp == null || !MessageDigest.isEqual(fp.getBytes(StandardCharsets.US_ASCII), pin.getBytes(StandardCharsets.US_ASCII))) {
                throw new CertificateException("not the pinned certificate");
            }
            // The pin is the trust: a member's own self-signed certificate is accepted by its exact bytes, dates aside.
        }

        @Override
        public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
            throw new CertificateException("not a server");
        }

        @Override
        public X509Certificate[] getAcceptedIssuers() {
            return new X509Certificate[0];
        }
    }

    /** The JDK's check, noting the leaf's fingerprint when it says no, so the setup can offer to pin the member's own. */
    private static final class Capturing implements X509TrustManager {
        private final X509TrustManager base;
        private final String[] seen;

        Capturing(X509TrustManager base, String[] seen) {
            this.base = base;
            this.seen = seen;
        }

        @Override
        public void checkServerTrusted(X509Certificate[] chain, String authType) throws CertificateException {
            try {
                base.checkServerTrusted(chain, authType);
            } catch (CertificateException e) {
                if (chain != null && chain.length > 0) {
                    seen[0] = fingerprint(chain[0]);
                }
                throw e;
            }
        }

        @Override
        public void checkClientTrusted(X509Certificate[] chain, String authType) throws CertificateException {
            throw new CertificateException("not a server");
        }

        @Override
        public X509Certificate[] getAcceptedIssuers() {
            return base.getAcceptedIssuers();
        }
    }

    // ---- HTTP/1.1

    /**
     * One request and its whole answer, within {@link Settings#exchange}. {@code path} is everything after the host but the
     * password: the password, when given, is added as {@code guid}, written from the bytes and zeroed after.
     *
     * @param route the path from {@code /api/v1/}, which must be plain ASCII with no {@code ?}
     * @param query more query parameters, already encoded, or null
     * @param maxBody the most body bytes this answer may have
     */
    Response exchange(MacAddress a, String pin, byte[] password, String method, String route, String query, byte[] body, long maxBody)
            throws IOException {
        return exchange(a, pin, password, method, route, query, body, maxBody, settings.exchange(), 0);
    }

    /**
     * As above, with this exchange's own wall-clock bound (a file's grows with its size, Security IM-L2) and a size hint, so
     * a chunked body is read into one buffer of about its size, not one doubled as it grows.
     */
    Response exchange(MacAddress a, String pin, byte[] password, String method, String route, String query, byte[] body, long maxBody,
            Duration bound, long sizeHint) throws IOException {
        try (Net.Deadline d = Net.Deadline.start(bound)) {
            try (Socket s = open(a, pin, settings.readTimeout())) {
                OutputStream out = s.getOutputStream();
                writeRequest(out, a, password, method, route, query, body);
                return readResponse(s.getInputStream(), maxBody, sizeHint);
            } catch (IOException e) {
                if (d.fired()) {
                    throw new java.net.SocketTimeoutException("deadline");
                }
                throw e;
            }
        }
    }

    void writeRequest(OutputStream out, MacAddress a, byte[] password, String method, String route, String query, byte[] body)
            throws IOException {
        if (!route.matches("[A-Za-z0-9/._:;%+-]{1,600}") || (query != null && !query.matches("[A-Za-z0-9=&._%+,-]{0,600}"))) {
            throw new IllegalArgumentException("route");
        }
        StringBuilder h = new StringBuilder(" HTTP/1.1\r\n");
        h.append("Host: ").append(a.hostHeader()).append("\r\n");
        h.append("User-Agent: MA-Courier/1\r\n");
        h.append("Accept: application/json, */*\r\n");
        h.append("Accept-Encoding: identity\r\n");
        h.append("Connection: close\r\n");
        if (body != null) {
            h.append("Content-Type: application/json\r\n");
            h.append("Content-Length: ").append(body.length).append("\r\n");
        }
        h.append("\r\n");
        // Written in pieces straight to the socket, so the password is in no buffer of ours but its own, zeroed after.
        out.write((method + " /api/v1/" + route + "?").getBytes(StandardCharsets.US_ASCII));
        byte[] secret = password == null ? null : percent(password);
        try {
            if (secret != null) {
                out.write(GUID);
                out.write(secret);
            }
        } finally {
            if (secret != null) {
                Arrays.fill(secret, (byte) 0);
            }
        }
        if (query != null && !query.isEmpty()) {
            out.write(((secret != null ? "&" : "") + query).getBytes(StandardCharsets.US_ASCII));
        }
        out.write(h.toString().getBytes(StandardCharsets.US_ASCII));
        if (body != null) {
            out.write(body);
        }
        out.flush();
    }

    private static final byte[] GUID = "guid=".getBytes(StandardCharsets.US_ASCII);

    /** The bytes percent-encoded as a query value (unreserved characters kept), in a new array the caller zeroes. */
    static byte[] percent(byte[] raw) {
        byte[] out = new byte[raw.length * 3];
        int n = 0;
        for (byte b : raw) {
            int c = b & 0xFF;
            if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '.' || c == '_' || c == '~') {
                out[n++] = (byte) c;
            } else {
                out[n++] = '%';
                out[n++] = (byte) Character.toUpperCase(Character.forDigit(c >> 4, 16));
                out[n++] = (byte) Character.toUpperCase(Character.forDigit(c & 0xF, 16));
            }
        }
        byte[] exact = Arrays.copyOf(out, n);
        Arrays.fill(out, (byte) 0);
        return exact;
    }

    /** Reads an answer: 1xx skipped, headers bounded, the body by length, chunks or close, never past {@code maxBody}. */
    static Response readResponse(InputStream in, long maxBody) throws IOException {
        return readResponse(in, maxBody, 0);
    }

    static Response readResponse(InputStream in, long maxBody, long sizeHint) throws IOException {
        int start = (int) Math.max(16 * 1024, Math.min(Math.max(0, sizeHint) + 1024, maxBody));
        while (true) {
            Map<String, String> headers = new LinkedHashMap<>();
            int status = readHead(in, headers);
            if (status >= 100 && status < 200 && status != 101) {
                continue;
            }
            if (status == 101) {
                return new Response(status, headers, new byte[0]);
            }
            String encoding = headers.get("content-encoding");
            if (encoding != null && !encoding.equalsIgnoreCase("identity")) {
                throw new Protocol("encoding");
            }
            byte[] body;
            String te = headers.get("transfer-encoding");
            if (te != null) {
                if (!te.toLowerCase(Locale.ROOT).strip().equals("chunked")) {
                    throw new Protocol("transfer-encoding");
                }
                body = readChunked(in, maxBody, start);
            } else if (headers.containsKey("content-length")) {
                long len;
                try {
                    len = Long.parseLong(headers.get("content-length").strip());
                } catch (NumberFormatException e) {
                    throw new Protocol("content-length");
                }
                if (len < 0) {
                    throw new Protocol("content-length");
                }
                if (len > maxBody) {
                    throw new TooLarge();
                }
                body = in.readNBytes((int) len);
                if (body.length != len) {
                    throw new Protocol("short");
                }
            } else {
                body = readAtMost(in, maxBody, start);
            }
            return new Response(status, headers, body);
        }
    }

    /** The status line and headers, up to {@link #MAX_HEADERS} bytes; names lowercased, a repeated one joined. */
    static int readHead(InputStream in, Map<String, String> headers) throws IOException {
        int total = 0;
        String status = readLine(in, MAX_HEADERS);
        total += status.length();
        if (!status.startsWith("HTTP/1.")) {
            throw new Protocol("status");
        }
        String[] parts = status.split(" ", 3);
        int code;
        try {
            code = parts.length < 2 ? -1 : Integer.parseInt(parts[1]);
        } catch (NumberFormatException e) {
            throw new Protocol("status");
        }
        if (code < 100 || code > 599) {
            throw new Protocol("status");
        }
        int count = 0;
        while (true) {
            String line = readLine(in, MAX_HEADERS - total);
            total += line.length() + 2;
            if (line.isEmpty()) {
                return code;
            }
            if (++count > 100) {
                throw new Protocol("headers");
            }
            int colon = line.indexOf(':');
            if (colon <= 0) {
                throw new Protocol("header");
            }
            String name = line.substring(0, colon).strip().toLowerCase(Locale.ROOT);
            String value = line.substring(colon + 1).strip();
            headers.merge(name, value, (x, y) -> x + ", " + y);
        }
    }

    /** One CRLF line (a bare LF ends one too), as ISO-8859-1, at most {@code max} bytes. */
    static String readLine(InputStream in, int max) throws IOException {
        StringBuilder b = new StringBuilder();
        while (true) {
            int c = in.read();
            if (c < 0) {
                throw new Protocol("eof");
            }
            if (c == '\n') {
                int len = b.length();
                if (len > 0 && b.charAt(len - 1) == '\r') {
                    b.setLength(len - 1);
                }
                return b.toString();
            }
            if (b.length() >= max) {
                throw new TooLarge();
            }
            b.append((char) c);
        }
    }

    private static byte[] readChunked(InputStream in, long maxBody, int start) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream(start);
        while (true) {
            String line = readLine(in, 1024);
            int semi = line.indexOf(';');
            String hex = (semi >= 0 ? line.substring(0, semi) : line).strip();
            long size;
            try {
                size = Long.parseLong(hex, 16);
            } catch (NumberFormatException e) {
                throw new Protocol("chunk");
            }
            if (size < 0) {
                throw new Protocol("chunk");
            }
            if (size == 0) {
                // Trailers, then the blank line.
                int trailers = 0;
                while (!readLine(in, 8192).isEmpty()) {
                    if (++trailers > 50) {
                        throw new Protocol("trailers");
                    }
                }
                return out.toByteArray();
            }
            if (size > maxBody - out.size()) {
                throw new TooLarge();
            }
            byte[] chunk = in.readNBytes((int) size);
            if (chunk.length != size) {
                throw new Protocol("short");
            }
            out.writeBytes(chunk);
            if (!readLine(in, 2).isEmpty()) {
                throw new Protocol("chunk");
            }
        }
    }

    private static byte[] readAtMost(InputStream in, long maxBody, int start) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream(start);
        byte[] buf = new byte[16 * 1024];
        int n;
        while ((n = in.read(buf)) > 0) {
            if (out.size() + n > maxBody) {
                throw new TooLarge();
            }
            out.write(buf, 0, n);
        }
        return out.toByteArray();
    }
}
