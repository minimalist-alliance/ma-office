package com.minimalistalliance.desk.deskd.courier.linked;

import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * SMTP submission to the member's own provider (RFC 6409, 5321): implicit TLS on 465, or STARTTLS on 587, which must
 * succeed before anything else is said; never plain text. AUTH PLAIN or LOGIN from bytes zeroed after. One message per
 * connection. How each step ended decides the outbound queue's next move ({@link Outcome}): a refusal fails, a 4xx or a
 * lost connection before the message's end retries, and a connection lost after the message's end is <b>unclear</b> (it may
 * have gone), which the queue marks so the next try looks in the Sent folder first.
 */
final class SmtpClient implements AutoCloseable {

    /** How a submission ended. {@code recipients}: each address's word ({@code sent}, {@code refused}). */
    record Outcome(Kind kind, String error, Map<String, String> recipients) {
        enum Kind { SENT, RETRY, UNCLEAR, FAILED, SIGN_IN }
    }

    private static final int MAX_LINE = 4096;
    private static final int MAX_LINES = 200;

    private final Net net;
    private final String host;
    private final int port;
    private Socket socket;
    private InputStream in;
    private OutputStream out;
    private final Set<String> ext = new HashSet<>();
    private long maxSize;

    private SmtpClient(Net net, String host, int port) {
        this.net = net;
        this.host = host;
        this.port = port;
    }

    /** A code and the reply's lines (the text is only matched against words, never kept or logged). */
    record Reply(int code, List<String> lines) {
        boolean ok() {
            return code >= 200 && code < 300;
        }

        boolean temporary() {
            return code >= 400 && code < 500;
        }

        boolean says(String... words) {
            for (String l : lines) {
                String t = l.toLowerCase(Locale.ROOT);
                for (String w : words) {
                    if (t.contains(w)) {
                        return true;
                    }
                }
            }
            return false;
        }
    }

    /**
     * Connects and greets: {@code tls} true is TLS from the first byte (465); false is STARTTLS (587), required. Then EHLO,
     * which names no machine of the member's ({@code [127.0.0.1]}, as privacy-minded mail apps send).
     */
    static SmtpClient open(Net net, String host, int port, boolean tls, Duration timeout) throws IOException {
        SmtpClient c = new SmtpClient(net, host, port);
        try {
            c.socket = net.connect(host, port, Net.SMTP_PORTS, tls, timeout);
            c.streams();
            Reply greeting = c.reply();
            if (greeting.code() != 220) {
                throw new SmtpException(greeting.temporary() ? "busy" : "greeting", greeting.code());
            }
            c.ehlo();
            if (!tls) {
                if (!c.ext.contains("STARTTLS")) {
                    // Never in plain text: a server that offers no STARTTLS is refused, and so is a stripped offer.
                    throw new Net.TlsFailed();
                }
                Reply r = c.command("STARTTLS");
                if (r.code() != 220) {
                    throw new Net.TlsFailed();
                }
                c.socket = net.startTls(c.socket, host, port);
                c.streams();
                c.ext.clear();
                c.ehlo();
            }
            return c;
        } catch (IOException | RuntimeException e) {
            c.close();
            throw e;
        }
    }

    private void streams() throws IOException {
        in = new java.io.BufferedInputStream(socket.getInputStream(), 8192);
        out = socket.getOutputStream();
    }

    private void ehlo() throws IOException {
        Reply r = command("EHLO [127.0.0.1]");
        if (!r.ok()) {
            throw new SmtpException("ehlo", r.code());
        }
        for (int i = 1; i < r.lines().size(); i++) {
            String l = r.lines().get(i).strip();
            String word = l.split(" ", 2)[0].toUpperCase(Locale.ROOT);
            ext.add(word);
            if (word.equals("AUTH")) {
                for (String m : l.toUpperCase(Locale.ROOT).split(" ")) {
                    ext.add("AUTH=" + m);
                }
            }
            if (word.equals("SIZE")) {
                String[] p = l.split(" ");
                maxSize = p.length > 1 ? Math.max(0, ImapReader.number(p[1])) : 0;
            }
        }
    }

    boolean has(String extension) {
        return ext.contains(extension.toUpperCase(Locale.ROOT));
    }

    /**
     * Signs in. {@code secret} is the caller's; the arrays made from it here are zeroed. A refusal is
     * {@link SmtpException} with {@code sign_in}, or {@code app_password} when the provider says one is needed.
     */
    void auth(String user, byte[] secret) throws IOException {
        byte[] u = user.getBytes(StandardCharsets.UTF_8);
        Reply r;
        if (has("AUTH=PLAIN") || !has("AUTH=LOGIN")) {
            byte[] plain = new byte[1 + u.length + 1 + secret.length];
            System.arraycopy(u, 0, plain, 1, u.length);
            System.arraycopy(secret, 0, plain, 2 + u.length, secret.length);
            byte[] b64 = Base64.getEncoder().encode(plain);
            Arrays.fill(plain, (byte) 0);
            try {
                write("AUTH PLAIN ".getBytes(StandardCharsets.US_ASCII));
                write(b64);
                write("\r\n".getBytes(StandardCharsets.US_ASCII));
                out.flush();
            } finally {
                Arrays.fill(b64, (byte) 0);
            }
            r = reply();
        } else {
            r = command("AUTH LOGIN");
            if (r.code() == 334) {
                r = command(Base64.getEncoder().encodeToString(u));
                if (r.code() == 334) {
                    byte[] b64 = Base64.getEncoder().encode(secret);
                    try {
                        write(b64);
                        write("\r\n".getBytes(StandardCharsets.US_ASCII));
                        out.flush();
                    } finally {
                        Arrays.fill(b64, (byte) 0);
                    }
                    r = reply();
                }
            }
        }
        if (r.code() != 235) {
            if (r.says("application-specific", "app password", "apppassword")) {
                throw new SmtpException("app_password", r.code());
            }
            throw new SmtpException(r.temporary() ? "busy" : "sign_in", r.code());
        }
    }

    /**
     * Submits one message from {@code from} to {@code to}. Every recipient refused permanently is {@code refused}; one
     * deferred (4xx) with none refused retries the whole message later, so nobody gets it twice.
     */
    Outcome send(String from, List<String> to, byte[] message) {
        Map<String, String> status = new LinkedHashMap<>();
        boolean utf8 = !ascii(from) || to.stream().anyMatch(a -> !ascii(a));
        try {
            if (utf8 && !has("SMTPUTF8")) {
                return new Outcome(Outcome.Kind.FAILED, "address", status);
            }
            if (maxSize > 0 && message.length > maxSize) {
                return new Outcome(Outcome.Kind.FAILED, "too_large", status);
            }
            String params = (has("SIZE") ? " SIZE=" + message.length : "") + (utf8 ? " SMTPUTF8" : "") + (has("8BITMIME") ? " BODY=8BITMIME" : "");
            Reply r = command("MAIL FROM:<" + from + ">" + params);
            if (!r.ok()) {
                return r.temporary() ? new Outcome(Outcome.Kind.RETRY, "deferred", status) : new Outcome(Outcome.Kind.FAILED, "refused", status);
            }
            List<String> accepted = new ArrayList<>();
            boolean deferred = false;
            for (String rcpt : to) {
                Reply rr = command("RCPT TO:<" + rcpt + ">");
                if (rr.ok()) {
                    accepted.add(rcpt);
                    status.put(rcpt, "sent");
                } else if (rr.temporary()) {
                    deferred = true;
                } else {
                    status.put(rcpt, "refused");
                }
            }
            if (accepted.isEmpty()) {
                command("RSET");
                return deferred ? new Outcome(Outcome.Kind.RETRY, "deferred", Map.of())
                        : new Outcome(Outcome.Kind.FAILED, "recipients", status);
            }
            if (deferred) {
                // Someone can't take it yet: all of it waits, so nobody already accepted gets it twice.
                command("RSET");
                return new Outcome(Outcome.Kind.RETRY, "deferred", Map.of());
            }
            r = command("DATA");
            if (r.code() != 354) {
                return r.temporary() ? new Outcome(Outcome.Kind.RETRY, "deferred", Map.of()) : new Outcome(Outcome.Kind.FAILED, "refused", status);
            }
        } catch (IOException e) {
            // Nothing of the message has gone: clearly not sent.
            return new Outcome(Outcome.Kind.RETRY, e instanceof SmtpException se ? se.getMessage() : "connection", Map.of());
        }
        try {
            writeDotStuffed(message);
            write(".\r\n".getBytes(StandardCharsets.US_ASCII));
            out.flush();
        } catch (IOException e) {
            // The server may have the whole message and not have said: unclear.
            return new Outcome(Outcome.Kind.UNCLEAR, "connection", status);
        }
        Reply end;
        try {
            socket.setSoTimeout((int) Duration.ofMinutes(10).toMillis());
            end = reply();
        } catch (IOException e) {
            return new Outcome(Outcome.Kind.UNCLEAR, e instanceof SocketTimeoutException ? "timeout" : "connection", status);
        }
        if (end.ok()) {
            return new Outcome(Outcome.Kind.SENT, null, status);
        }
        return end.temporary() ? new Outcome(Outcome.Kind.RETRY, "deferred", Map.of()) : new Outcome(Outcome.Kind.FAILED, "refused", status);
    }

    private static boolean ascii(String s) {
        return s.chars().allMatch(c -> c < 0x80);
    }

    void quit() {
        try {
            command("QUIT");
        } catch (IOException ignored) {
            // closing anyway
        }
        close();
    }

    @Override
    public void close() {
        try {
            if (socket != null) {
                socket.close();
            }
        } catch (IOException ignored) {
            // closed
        }
    }

    /** A command line built by this class only (addresses checked by the caller), and its reply. */
    private Reply command(String line) throws IOException {
        if (line.indexOf('\r') >= 0 || line.indexOf('\n') >= 0) {
            throw new IllegalArgumentException("line");
        }
        write((line + "\r\n").getBytes(StandardCharsets.UTF_8));
        out.flush();
        return reply();
    }

    private void write(byte[] b) throws IOException {
        out.write(b);
    }

    /** The message with each line starting {@code .} doubled; it ends in CRLF (the writer makes it so). */
    private void writeDotStuffed(byte[] m) throws IOException {
        java.io.BufferedOutputStream b = new java.io.BufferedOutputStream(out, 16 * 1024);
        boolean lineStart = true;
        for (byte x : m) {
            if (lineStart && x == '.') {
                b.write('.');
            }
            b.write(x);
            lineStart = x == '\n';
        }
        if (!lineStart) {
            b.write('\r');
            b.write('\n');
        }
        b.flush();
    }

    private Reply reply() throws IOException {
        List<String> lines = new ArrayList<>();
        int code = -1;
        while (true) {
            String l = line();
            if (l.length() < 3) {
                throw new SmtpException("protocol", 0);
            }
            int c = (int) ImapReader.number(l.substring(0, 3));
            if (c < 200 || c > 599 || code >= 0 && c != code) {
                throw new SmtpException("protocol", 0);
            }
            code = c;
            if (lines.size() < MAX_LINES) {
                lines.add(l.length() > 4 ? l.substring(4) : "");
            } else {
                throw new SmtpException("protocol", 0);
            }
            if (l.length() == 3 || l.charAt(3) == ' ') {
                return new Reply(code, lines);
            }
            if (l.charAt(3) != '-') {
                throw new SmtpException("protocol", 0);
            }
        }
    }

    private String line() throws IOException {
        StringBuilder b = new StringBuilder();
        while (true) {
            int c = in.read();
            if (c < 0) {
                throw new EOFException();
            }
            if (c == '\n') {
                int n = b.length();
                if (n > 0 && b.charAt(n - 1) == '\r') {
                    b.setLength(n - 1);
                }
                return b.toString();
            }
            if (b.length() >= MAX_LINE) {
                throw new SmtpException("protocol", 0);
            }
            b.append((char) c);
        }
    }

    /** An SMTP step refused: a word, and the code. Never the server's text. */
    static final class SmtpException extends IOException {
        private static final long serialVersionUID = 1L;
        final int code;

        SmtpException(String word, int code) {
            super(word, null);
            this.code = code;
        }
    }
}
