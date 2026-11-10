package com.minimalistalliance.desk.agent.attach.worker;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * The child process that reads an attached file to text (ADR 0049). desk-agent starts one per file with a small
 * heap, no environment and a deadline, so a zip bomb or a huge PDF costs only that process: it holds no key, and a
 * kill or an out-of-memory exit ends it without touching desk-agent. {@link Sandbox} also limits what code running in
 * it can do through Java (read its jars and the JDK only; no write, socket, process or native library). That is not a
 * kernel sandbox: it has desk-agent's uid, mounts and network, so a JVM or native-code bug is outside it.
 *
 * <p>Arguments: {@code kind maxChars maxPages}. The file's bytes arrive on standard input and nothing is written
 * anywhere. The answer on standard output is {@code OK <note>}, or {@code ERR <reason>}, then a newline and the
 * text. Standard error is discarded by the parent and this class never prints the file's content to it.
 */
public final class ParseWorker {

    /** The most bytes read from standard input; the parent sends no more than its cap, so this is a second guard. */
    static final int MAX_INPUT = 40 << 20;

    private ParseWorker() {}

    public static void main(String[] args) throws IOException {
        int status = 0;
        // Anything a library logs goes to standard error, which the parent throws away; only the answer reaches stdout.
        OutputStream out = new java.io.FileOutputStream(java.io.FileDescriptor.out);
        System.setOut(System.err);
        // From here on the child can read its jars and the JDK and nothing else (AGENT-PARSE-1). A JVM started without
        // -Djava.security.manager=allow refuses to go on rather than read a file unconfined.
        Sandbox.install();
        String answer;
        String text = "";
        try {
            String kind = args[0];
            int maxChars = Integer.parseInt(args[1]);
            int maxPages = Integer.parseInt(args[2]);
            byte[] bytes = readInput(System.in);
            Result result = switch (kind) {
                case "text" -> PlainText.read(bytes, maxChars);
                case "pdf" -> PdfText.read(bytes, maxChars, maxPages);
                case "docx", "xlsx", "pptx" -> OfficeText.read(kind, bytes, maxChars);
                default -> Result.error("unsupported_type");
            };
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

    private static byte[] readInput(InputStream in) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream(1 << 16);
        byte[] chunk = new byte[1 << 16];
        int read;
        while ((read = in.read(chunk)) > 0) {
            if (buffer.size() + read > MAX_INPUT) {
                throw new IOException("input");
            }
            buffer.write(chunk, 0, read);
        }
        return buffer.toByteArray();
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
