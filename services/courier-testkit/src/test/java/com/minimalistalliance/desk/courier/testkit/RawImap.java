package com.minimalistalliance.desk.courier.testkit;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.net.ssl.SSLSocket;

/**
 * A raw IMAP conversation for tests: lines out, lines in. A response line's literals are read into it, so a line holds
 * {@code {n}\r\n} and then the n bytes, as ISO-8859-1 so every byte survives ({@link #literal}).
 */
final class RawImap implements AutoCloseable {

    private static final Pattern LITERAL_AT_END = Pattern.compile("\\{(\\d+)\\}$");

    final Socket socket;
    private final BufferedInputStream in;
    private final OutputStream out;
    private int next = 1;
    final String greeting;

    private RawImap(Socket socket) throws IOException {
        this.socket = socket;
        socket.setSoTimeout(15_000);
        this.in = new BufferedInputStream(socket.getInputStream());
        this.out = socket.getOutputStream();
        this.greeting = readLine();
    }

    static RawImap connect(int port) throws IOException {
        return new RawImap(new Socket(InetAddress.getLoopbackAddress(), port));
    }

    static RawImap connectTls(int port) throws IOException {
        SSLSocket s = (SSLSocket) FakeTls.clientContext().getSocketFactory().createSocket(InetAddress.getLoopbackAddress(), port);
        s.startHandshake();
        return new RawImap(s);
    }

    static RawImap login(int port, String user, String password) throws IOException {
        RawImap c = connect(port);
        Reply r = c.cmd("LOGIN " + user + " " + password);
        if (!r.ok()) {
            throw new IllegalStateException("login failed: " + r.tagged());
        }
        return c;
    }

    /** A command's whole answer: the untagged lines and the tagged one, last. */
    record Reply(String tag, List<String> lines) {
        String tagged() {
            return lines.get(lines.size() - 1);
        }

        boolean ok() {
            return tagged().startsWith(tag + " OK");
        }

        List<String> untagged() {
            return lines.subList(0, lines.size() - 1);
        }

        boolean has(String line) {
            return lines.contains(line);
        }

        List<String> starting(String prefix) {
            return lines.stream().filter(l -> l.startsWith(prefix)).toList();
        }
    }

    String nextTag() {
        return "a" + (next++);
    }

    /** Sends {@code <tag> <command>} and reads to the tagged response. */
    Reply cmd(String command) throws IOException {
        String tag = nextTag();
        send(tag + " " + command + "\r\n");
        return readTagged(tag);
    }

    Reply readTagged(String tag) throws IOException {
        List<String> lines = new ArrayList<>();
        while (true) {
            String l = readLine();
            if (l == null) {
                throw new IOException("connection closed before " + tag + "'s response; got " + lines);
            }
            lines.add(l);
            if (l.startsWith(tag + " ")) {
                return new Reply(tag, lines);
            }
        }
    }

    void send(String text) throws IOException {
        out.write(text.getBytes(StandardCharsets.UTF_8));
        out.flush();
    }

    void send(byte[] bytes) throws IOException {
        out.write(bytes);
        out.flush();
    }

    /** One response line, its literals read in; null at the end of the stream. */
    String readLine() throws IOException {
        ByteArrayOutputStream line = new ByteArrayOutputStream();
        while (true) {
            String part = rawLine();
            if (part == null) {
                return line.size() == 0 ? null : line.toString(StandardCharsets.ISO_8859_1);
            }
            line.writeBytes(part.getBytes(StandardCharsets.ISO_8859_1));
            Matcher m = LITERAL_AT_END.matcher(part);
            if (!m.find()) {
                return line.toString(StandardCharsets.ISO_8859_1);
            }
            int n = Integer.parseInt(m.group(1));
            byte[] b = in.readNBytes(n);
            line.writeBytes("\r\n".getBytes(StandardCharsets.ISO_8859_1));
            line.writeBytes(b);
            if (b.length < n) {
                return line.toString(StandardCharsets.ISO_8859_1);
            }
        }
    }

    /** A line, or null if nothing comes within {@code millis}. */
    String readLineWithin(int millis) throws IOException {
        int old = socket.getSoTimeout();
        socket.setSoTimeout(millis);
        try {
            return readLine();
        } catch (SocketTimeoutException e) {
            return null;
        } finally {
            socket.setSoTimeout(old);
        }
    }

    private String rawLine() throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        while (true) {
            int c = in.read();
            if (c == -1) {
                return b.size() == 0 ? null : b.toString(StandardCharsets.ISO_8859_1);
            }
            if (c == '\n') {
                byte[] a = b.toByteArray();
                int n = a.length > 0 && a[a.length - 1] == '\r' ? a.length - 1 : a.length;
                return new String(a, 0, n, StandardCharsets.ISO_8859_1);
            }
            b.write(c);
        }
    }

    /** The bytes of the first literal in a line read by {@link #readLine}, after {@code name {n}}. */
    static byte[] literal(String line, String name) {
        int at = line.indexOf(name + " {");
        if (at < 0) {
            throw new AssertionError("no " + name + " in " + line);
        }
        int open = at + name.length() + 1;
        int close = line.indexOf('}', open);
        int n = Integer.parseInt(line.substring(open + 1, close));
        int start = close + 3;
        return line.substring(start, start + n).getBytes(StandardCharsets.ISO_8859_1);
    }

    /** Every byte until the server closes the connection (EOF or reset). */
    byte[] readUntilClosed() {
        ByteArrayOutputStream b = new ByteArrayOutputStream();
        try {
            int c;
            while ((c = in.read()) != -1) {
                b.write(c);
            }
        } catch (IOException e) {
            // reset: what came before it is the answer
        }
        return b.toByteArray();
    }

    /** Reads until the server closes; true if it closed (EOF or reset) within the socket timeout. */
    boolean closedByServer() {
        try {
            while (in.read() != -1) {
                // drain
            }
            return true;
        } catch (SocketTimeoutException e) {
            return false;
        } catch (IOException e) {
            return true;
        }
    }

    @Override
    public void close() throws IOException {
        socket.close();
    }
}
