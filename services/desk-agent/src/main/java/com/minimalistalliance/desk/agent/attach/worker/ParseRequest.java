package com.minimalistalliance.desk.agent.attach.worker;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Set;

/**
 * The one line desk-agent writes before a file's bytes on the parse sidecar's socket (ADR 0097 section 2, the
 * contract): {@code parse1 <kind> <maxChars> <maxPages>\n}, ASCII, at most {@link #MAX_LINE} bytes with the newline.
 * The sidecar's command line is fixed, so this line is all desk-agent tells it, and it is read strictly: exactly four
 * fields split by single spaces, the word {@code parse1}, a kind from {@link #KINDS}, and two decimal numbers with no
 * sign or leading zero, from 1 to {@link #MAX_CHARS} and {@link #MAX_PAGES} (ADR 0097 section 2; attachments stay under {@code attach/Caps}, which is lower).
 * Anything else is malformed, and the worker answers {@code ERR bad_request}.
 */
public record ParseRequest(String kind, int maxChars, int maxPages) {

    /** The longest line, its newline included. */
    public static final int MAX_LINE = 64;
    /** The kinds desk-agent reads, as {@code Preparer} and {@code files_read} name them. */
    public static final Set<String> KINDS = Set.of("text", "pdf", "docx", "xlsx", "pptx");
    /** The most characters a file may be read to: ADR 0097 section 2, what {@code files_read} asks for. */
    public static final int MAX_CHARS = 2_000_000;
    /** The most PDF pages read: ADR 0097 section 2, what {@code files_read} asks for. */
    public static final int MAX_PAGES = 500;
    /**
     * The most bytes desk-agent sends after the line: the per-file ceiling, {@code Caps.CEILING.maxFileBytes()}. The
     * worker keeps its own, larger guard ({@code ParseWorker.MAX_INPUT}).
     */
    public static final int MAX_BYTES = 20 << 20;

    private static final String WORD = "parse1";

    /** Anything but a well-formed line; it carries no part of what was read. */
    public static final class Malformed extends Exception {
        private static final long serialVersionUID = 1L;

        Malformed() {
            super("malformed", null, false, false);
        }
    }

    public ParseRequest {
        if (!KINDS.contains(kind) || maxChars < 1 || maxChars > MAX_CHARS || maxPages < 1 || maxPages > MAX_PAGES) {
            throw new IllegalArgumentException("out of range");
        }
    }

    /** The line, newline included, as desk-agent writes it. */
    public byte[] header() {
        return (WORD + " " + kind + " " + maxChars + " " + maxPages + "\n").getBytes(StandardCharsets.US_ASCII);
    }

    /**
     * Reads the line from {@code in} one byte at a time, so nothing after its newline is consumed.
     *
     * @throws Malformed for no newline in the first {@link #MAX_LINE} bytes, an end of input before one, or a line
     *     {@link #parse} refuses
     */
    public static ParseRequest read(InputStream in) throws IOException, Malformed {
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

    /** The request from the first {@code length} bytes of {@code line}, which hold no newline. */
    static ParseRequest parse(byte[] line, int length) throws Malformed {
        for (int i = 0; i < length; i++) {
            byte b = line[i];
            // Printable ASCII only: no tab, CR, NUL or byte above 0x7E, so no field can hide a second separator.
            if (b < 0x20 || b > 0x7E) {
                throw new Malformed();
            }
        }
        String text = new String(line, 0, length, StandardCharsets.US_ASCII);
        // A limit of -1 keeps empty fields, so a doubled, leading or trailing space makes one and is refused.
        String[] fields = text.split(" ", -1);
        if (fields.length != 4 || !fields[0].equals(WORD) || !KINDS.contains(fields[1])) {
            throw new Malformed();
        }
        int maxChars = number(fields[2], MAX_CHARS);
        int maxPages = number(fields[3], MAX_PAGES);
        return new ParseRequest(fields[1], maxChars, maxPages);
    }

    /** A decimal from 1 to {@code max}: digits only, no sign, no leading zero, at most 7 of them. */
    private static int number(String field, int max) throws Malformed {
        if (field.isEmpty() || field.length() > 7 || field.charAt(0) == '0') {
            throw new Malformed();
        }
        int value = 0;
        for (int i = 0; i < field.length(); i++) {
            char c = field.charAt(i);
            if (c < '0' || c > '9') {
                throw new Malformed();
            }
            value = value * 10 + (c - '0');
        }
        if (value > max) {
            throw new Malformed();
        }
        return value;
    }
}
