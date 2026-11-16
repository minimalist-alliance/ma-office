package com.minimalistalliance.desk.agent.attach.worker;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * The child process that reads an attached file to text (ADR 0049). desk-agent starts one per file with a small
 * heap, no environment and a deadline, so a zip bomb or a huge PDF costs only that process: it holds no key, and a
 * kill or an out-of-memory exit ends it without touching desk-agent. {@link Sandbox} also limits what code running in
 * it can do through Java (read its jars and the JDK only; no write, socket, process or native library). As the
 * in-container child that is not a kernel sandbox: it has desk-agent's uid, mounts and network, so a JVM or native-code
 * bug is outside it. In the parse sidecar the container is the kernel's fence (its own uid, no network, no mounts), and
 * the manager stays inside it as a second layer while desk-agent is on Java 21.
 *
 * <p>Two ways to start it, with the same answer:
 * <ul>
 * <li><b>{@code kind maxChars maxPages}</b>, the in-container child {@code Parsers} starts on an image without the parse
 * sidecar. The file's bytes arrive on standard input.</li>
 * <li><b>{@code --from-stream}</b> and nothing else, the parse sidecar's (ADR 0097), started as
 * {@code java @/app/parse.options} once per connection, the connection its stdin and stdout. Standard input carries
 * one line first ({@link ParseRequest}: {@code parse1 <kind> <maxChars> <maxPages>}), then the file's bytes to the
 * end. A line that doesn't fit is answered {@code ERR bad_request} and nothing more is read. The process also ends
 * itself {@link #STREAM_DEADLINE_MS} after it starts, a second after desk-agent's own deadline, whatever the connection
 * does (the sandbox's {@code desk-svc} kills it at 35 s as well).</li>
 * </ul>
 * Nothing is written anywhere but the answer on standard output: {@code OK <note>}, or {@code ERR <reason>}, then a
 * newline and the text. Standard error is discarded by the parent (and by the sidecar's unit) and this class never
 * prints the file's content to it.
 */
public final class ParseWorker {

    /**
     * The most bytes read from standard input; the parent sends no more than its cap, so this is a second guard. The
     * file is held at most once ({@link Input}), so up to the 20 MiB ceiling it fits the 72 MiB heap with room to parse.
     */
    static final int MAX_INPUT = 40 << 20;
    /** The sidecar's one argument: the request line and the file come on standard input. */
    public static final String FROM_STREAM = "--from-stream";
    /**
     * How long a sidecar's worker may live: desk-agent's deadline of 30 s plus one, so desk-agent's {@code timeout} is
     * what the member sees, and the worker is gone a second later even if nothing else stops it.
     */
    static final long STREAM_DEADLINE_MS = 31_000;
    /** The exit status after {@code ERR bad_request}, or of {@code --from-stream} with anything after it. */
    static final int MALFORMED = 2;
    /** The exit status when the sidecar's own deadline ends it (3 is HotSpot's for ExitOnOutOfMemoryError). */
    static final int DEADLINE = 124;

    private ParseWorker() {}

    public static void main(String[] args) throws IOException {
        int status = 0;
        boolean stream = args.length > 0 && args[0].equals(FROM_STREAM);
        if (stream && args.length != 1) {
            System.exit(MALFORMED);
            return;
        }
        if (stream) {
            deadline();
        }
        // Anything a library logs goes to standard error, which the parent throws away; only the answer reaches stdout.
        OutputStream out = new java.io.FileOutputStream(java.io.FileDescriptor.out);
        System.setOut(System.err);
        // From here on the child can read its jars and the JDK and nothing else (AGENT-PARSE-1). A JVM started without
        // -Djava.security.manager=allow refuses to go on rather than read a file unconfined.
        Sandbox.install();
        ParseRequest request = null;
        if (stream) {
            try {
                request = ParseRequest.read(System.in);
            } catch (ParseRequest.Malformed | IOException e) {
                // ADR 0097's contract: a line that doesn't fit gets ERR bad_request, and the file isn't read.
                out.write("ERR bad_request\n".getBytes(StandardCharsets.UTF_8));
                out.flush();
                System.exit(MALFORMED);
                return;
            }
        }
        String answer;
        String text = "";
        try {
            String kind;
            int maxChars;
            int maxPages;
            if (stream) {
                kind = request.kind();
                maxChars = request.maxChars();
                maxPages = request.maxPages();
            } else {
                kind = args[0];
                maxChars = Integer.parseInt(args[1]);
                maxPages = Integer.parseInt(args[2]);
            }
            Result result = read(kind, System.in, maxChars, maxPages);
            if (result.reason() != null) {
                answer = "ERR " + result.reason();
            } else {
                answer = "OK " + (result.note() == null ? "" : result.note());
                text = clean(result.text());
            }
        } catch (Bomb e) {
            answer = "ERR too_complex";
        } catch (RuntimeException | IOException e) {
            if (Boolean.getBoolean("ma.attach.debug")) {
                e.printStackTrace();
            }
            answer = "ERR unreadable";
        }
        out.write((answer + "\n").getBytes(StandardCharsets.UTF_8));
        out.write(text.getBytes(StandardCharsets.UTF_8));
        out.flush();
        System.exit(status);
    }

    /** The sidecar's own end: a daemon thread that halts the JVM {@link #STREAM_DEADLINE_MS} after it starts. */
    private static void deadline() {
        Thread watchdog = new Thread(() -> {
            try {
                Thread.sleep(STREAM_DEADLINE_MS);
            } catch (InterruptedException e) {
                // Never interrupted; halting is the point either way.
            }
            Runtime.getRuntime().halt(DEADLINE);
        }, "parse-deadline");
        watchdog.setDaemon(true);
        watchdog.start();
    }

    /** Drops control characters but the newline and tab: nothing from a file reaches the model as an escape code. */
    static String clean(String text) {
        StringBuilder out = new StringBuilder(text.length());
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if ((c < 0x20 && c != '\n' && c != '\t') || c == 0x7F || (c >= 0x80 && c < 0xA0)) {
                continue;
            }
            out.append(c);
        }
        return out.toString();
    }

    /**
     * The file on {@code in}, read to its end and refused past {@link #MAX_INPUT} bytes whatever the kind, as one
     * answer. Nothing holds the file twice ({@link Input}): text is decoded as it streams and the rest only counted; a
     * PDF or a zip is held once, in chunks, and let go of when this returns, before the answer is written.
     */
    static Result read(String kind, InputStream in, int maxChars, int maxPages) throws IOException {
        switch (kind) {
            case "text" -> {
                Input.Limited limited = new Input.Limited(in, MAX_INPUT);
                Result result = PlainText.read(limited, maxChars);
                limited.drain();
                return result;
            }
            case "pdf" -> {
                return PdfText.read(Input.read(in, MAX_INPUT), maxChars, maxPages);
            }
            case "docx", "xlsx", "pptx" -> {
                return OfficeText.read(kind, Input.read(in, MAX_INPUT), maxChars);
            }
            default -> {
                new Input.Limited(in, MAX_INPUT).drain();
                return Result.error("unsupported_type");
            }
        }
    }

    /** What a reader found: the text and a note for the member, or the reason it couldn't read the file. */
    record Result(String text, String note, String reason) {
        static Result ok(String text, String note) {
            return new Result(text, note, null);
        }

        static Result error(String reason) {
            return new Result("", null, reason);
        }
    }

    /** A file that inflates or nests past what the readers allow. */
    static final class Bomb extends RuntimeException {
        private static final long serialVersionUID = 1L;

        Bomb() {
            super("limit", null, false, false);
        }
    }

    /** A writer that takes up to {@code max} chars and says when it was full. */
    static final class Capped {
        private final StringBuilder text = new StringBuilder();
        private final int max;
        private boolean full;

        Capped(int max) {
            this.max = max;
        }

        boolean append(CharSequence piece) {
            if (full) {
                return false;
            }
            int room = max - text.length();
            if (piece.length() > room) {
                text.append(piece, 0, Math.max(0, room));
                full = true;
                return false;
            }
            text.append(piece);
            return true;
        }

        boolean append(char c) {
            return append(String.valueOf(c));
        }

        boolean full() {
            return full;
        }

        int length() {
            return text.length();
        }

        @Override
        public String toString() {
            return text.toString();
        }
    }
}
