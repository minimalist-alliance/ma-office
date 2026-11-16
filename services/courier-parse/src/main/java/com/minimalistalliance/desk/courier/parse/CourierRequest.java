package com.minimalistalliance.desk.courier.parse;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.regex.Pattern;

/**
 * The one line deskd writes before a message's bytes on the Courier sandbox's socket: {@code courier1 <op>[ <part>]\n},
 * printable ASCII, at most {@link #MAX_LINE} bytes with the newline. The sandbox's command line is fixed, so this line is
 * all deskd tells it, and it is read strictly: anything else is {@code ERR bad_request}, and nothing more is read.
 * <ul>
 * <li>{@code courier1 message}: the raw message; the answer is {@code parse-courier 1}.</li>
 * <li>{@code courier1 part <id>}: the raw message; the answer is that part's decoded bytes.</li>
 * <li>{@code courier1 image <id>}: the raw message; the answer is that part re-encoded as an image.
 *     {@code courier1 image -}: the bytes are the image itself (one the desk fetched when the member pressed "Show
 *     images").</li>
 * <li>{@code courier1 archive <id>}: the raw message; the answer lists that part's files without unpacking them.</li>
 * </ul>
 * A part id is IMAP's section number ({@code 1}, {@code 2.1.3}): the same raw bytes always give the same ids.
 */
public record CourierRequest(Op op, String part) {

    public enum Op {
        MESSAGE("message"), PART("part"), IMAGE("image"), ARCHIVE("archive");

        final String word;

        Op(String word) {
            this.word = word;
        }

        static Op of(String word) {
            for (Op op : values()) {
                if (op.word.equals(word)) {
                    return op;
                }
            }
            return null;
        }
    }

    public static final int MAX_LINE = 128;
    static final String WORD = "courier1";
    /** The image is the input itself. */
    public static final String SELF = "-";
    private static final Pattern PART = Pattern.compile("[1-9][0-9]{0,3}(\\.[1-9][0-9]{0,3}){0,21}");

    public CourierRequest {
        if (op == null || (op == Op.MESSAGE) != (part == null)
                || part != null && !PART.matcher(part).matches() && !(op == Op.IMAGE && SELF.equals(part))) {
            throw new IllegalArgumentException("request");
        }
    }

    /** The line, newline included, as deskd writes it. */
    public byte[] header() {
        String line = WORD + " " + op.word + (part == null ? "" : " " + part) + "\n";
        if (line.length() > MAX_LINE) {
            throw new IllegalArgumentException("request");
        }
        return line.getBytes(StandardCharsets.US_ASCII);
    }

    /** Anything but a well-formed line. */
    public static final class Malformed extends Exception {
        private static final long serialVersionUID = 1L;

        Malformed() {
            super("malformed", null, false, false);
        }
    }

    /**
     * The line as read, before it's known to be {@code courier1}'s: printable ASCII and spaces only, at most
     * {@link #MAX_LINE} bytes with its newline. {@link #word()} picks a {@link WorkerMode}; {@link #request()} reads it as
     * {@code courier1}'s, strictly as {@link #read} does.
     */
    public record Line(byte[] bytes, int length) {
        public String text() {
            return new String(bytes, 0, length, StandardCharsets.US_ASCII);
        }

        /** The first word, or the whole line when it has no space. */
        public String word() {
            String t = text();
            int sp = t.indexOf(' ');
            return sp < 0 ? t : t.substring(0, sp);
        }

        public CourierRequest request() throws Malformed {
            return parse(bytes, length);
        }
    }

    /** Reads the line a byte at a time, so nothing after its newline is consumed; printable ASCII or {@link Malformed}. */
    public static Line readLine(InputStream in) throws IOException, Malformed {
        byte[] line = new byte[MAX_LINE];
        for (int n = 0; n < MAX_LINE; n++) {
            int b = in.read();
            if (b < 0) {
                throw new Malformed();
            }
            if (b == '\n') {
                for (int i = 0; i < n; i++) {
                    if (line[i] < 0x21 && line[i] != ' ' || line[i] > 0x7E) {
                        throw new Malformed();
                    }
                }
                return new Line(line, n);
            }
            line[n] = (byte) b;
        }
        throw new Malformed();
    }

    /** Reads the line a byte at a time, so nothing after its newline is consumed. */
    public static CourierRequest read(InputStream in) throws IOException, Malformed {
        byte[] line = new byte[MAX_LINE];
        for (int n = 0; n < MAX_LINE; n++) {
            int b = in.read();
            if (b < 0) {
                throw new Malformed();
            }
            if (b == '\n') {
                return parse(line, n);
            }
            line[n] = (byte) b;
        }
        throw new Malformed();
    }

    static CourierRequest parse(byte[] line, int length) throws Malformed {
        for (int i = 0; i < length; i++) {
            if (line[i] < 0x21 && line[i] != ' ' || line[i] > 0x7E) {
                throw new Malformed();
            }
        }
        String[] f = new String(line, 0, length, StandardCharsets.US_ASCII).split(" ", -1);
        if (f.length < 2 || f.length > 3 || !f[0].equals(WORD)) {
            throw new Malformed();
        }
        Op op = Op.of(f[1]);
        if (op == null) {
            throw new Malformed();
        }
        try {
            return new CourierRequest(op, f.length == 3 ? f[2] : null);
        } catch (IllegalArgumentException e) {
            throw new Malformed();
        }
    }
}
