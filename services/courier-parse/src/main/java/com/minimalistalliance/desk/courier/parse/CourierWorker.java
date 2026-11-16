package com.minimalistalliance.desk.courier.parse;

import java.io.FileDescriptor;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * desk-parse's Courier mode: one worker JVM per message, in the parse sandbox (ADR 0097: uid 1113, no network, no
 * {@code /data}, no capabilities, a read-only root, 160 MiB), started as {@code java @/app/courier-parse.options} with the
 * connection from deskd as its stdin and stdout. It reads one line ({@link CourierRequest}), then the bytes, and answers
 * one line, then a body:
 * <ul>
 * <li>{@code OK} then {@code parse-courier 1} JSON, for {@code message};</li>
 * <li>{@code OK <n>} then the part's {@code n} decoded bytes, for {@code part};</li>
 * <li>{@code OK <png|jpeg> <width> <height>} then the image, drawn again, for {@code image};</li>
 * <li>{@code OK} then the archive's listing as JSON, for {@code archive};</li>
 * <li>{@code ERR <reason>} and nothing more, for anything it won't read ({@link Refusal}'s words).</li>
 * </ul>
 * Nothing but the answer is written anywhere: standard error goes nowhere (the sandbox's {@code -conn-stdio}), and this
 * class never prints a message's content. Its own deadline ends it {@link Limits#PARSE_MILLIS} after it starts, with
 * {@code ERR timeout} if it hadn't begun to answer; the sandbox's {@code desk-svc} kills it a few seconds later whatever
 * happens. It reads all of what deskd sends before answering, so neither side waits on the other.
 */
public final class CourierWorker {

    public static final String FROM_STREAM = "--from-stream";
    static final int MALFORMED = 2;
    static final int DEADLINE = 124;
    /** What a worker reads past a refusal, at most, so deskd's write ends; then it answers and goes. */
    private static final long DRAIN_MAX = Limits.MAX_BYTES + (1L << 20);

    private CourierWorker() {}

    public static void main(String[] args) {
        if (args.length != 1 || !args[0].equals(FROM_STREAM)) {
            System.exit(MALFORMED);
            return;
        }
        long start = System.nanoTime();
        OutputStream out = new FileOutputStream(FileDescriptor.out);
        // Anything a library prints goes to standard error, which nobody keeps; only the answer reaches stdout.
        System.setOut(System.err);
        Answer answer = new Answer(out);
        watchdog(answer, start);
        // Read before the security manager is installed, which allows no file but the JDK's and the jars.
        Trackers.use(Trackers.load(System.getProperty("ma.courier.trackers")));
        warmUp();
        Sandbox.install();
        long left = Limits.PARSE_MILLIS - (System.nanoTime() - start) / 1_000_000L - 300;
        int status = serve(System.in, answer, new Mime.Deadline(Math.max(1, left)));
        System.exit(status);
    }

    /**
     * Runs every reader once on a fixed message of its own, before the security manager is installed: the libraries' static
     * set-up (the default time zone, ImageIO's plugins, jsoup's entity tables, charsets) reads files and properties the
     * manager then refuses. Nothing of the real message has been read yet.
     */
    static void warmUp() {
        java.util.TimeZone.getDefault();
        loadModes();
        java.util.Locale.getDefault();
        Images.init();
        String warm = "From: Warm <warm@example.com>\r\nTo: a@example.com, B <b@example.com>\r\n"
                + "Subject: =?utf-8?q?w=C3=A4rm?=\r\nDate: Thu, 12 Nov 2026 10:00:00 +0000\r\nMessage-ID: <w@example.com>\r\n"
                + "Content-Type: multipart/mixed; boundary=a\r\n\r\n--a\r\nContent-Type: multipart/alternative; boundary=b\r\n\r\n"
                + "--b\r\nContent-Type: text/plain; charset=iso-8859-1; format=flowed\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n"
                + "w=E4rm https://example.com/?utm_source=x\r\n--b\r\nContent-Type: text/html; charset=utf-8\r\n"
                + "Content-Transfer-Encoding: base64\r\n\r\n"
                + java.util.Base64.getEncoder().encodeToString(("<p style=\"color: red\">w&auml;rm <a href=\"https://example.com/\">x</a>"
                        + "<img src=\"https://example.com/x.png\" alt=\"x\"></p>").getBytes(StandardCharsets.UTF_8))
                + "\r\n--b--\r\n--a\r\nContent-Type: application/zip; name=\"w.zip\"\r\nContent-Transfer-Encoding: base64\r\n\r\n"
                + java.util.Base64.getEncoder().encodeToString(warmZip()) + "\r\n--a--\r\n";
        Mime.message(new java.io.ByteArrayInputStream(warm.getBytes(StandardCharsets.ISO_8859_1)), Mime.Deadline.none());
        for (String type : new String[] {"png", "jpeg", "gif", "bmp"}) {
            try {
                java.awt.image.BufferedImage img = new java.awt.image.BufferedImage(2, 2,
                        type.equals("png") ? java.awt.image.BufferedImage.TYPE_INT_ARGB : java.awt.image.BufferedImage.TYPE_INT_RGB);
                java.io.ByteArrayOutputStream b = new java.io.ByteArrayOutputStream();
                javax.imageio.ImageIO.write(img, type, b);
                byte[] bytes = b.toByteArray();
                Images.reencode(bytes, new java.io.ByteArrayInputStream(bytes), 2);
            } catch (IOException | RuntimeException e) {
                // A format that can't be written here is read all the same, or refused as unsupported.
            }
        }
    }

    /** The other request families (desk-agent's documents mode), by their first word: found once, at warm-up. */
    private static volatile Map<String, WorkerMode> modes = Map.of();

    /** Finds and warms the modes on the classpath; one that fails to warm is left out, and its requests are refused. */
    static void loadModes() {
        Map<String, WorkerMode> found = new LinkedHashMap<>();
        try {
            for (WorkerMode mode : java.util.ServiceLoader.load(WorkerMode.class, CourierWorker.class.getClassLoader())) {
                String word = mode.word();
                if (word == null || !word.matches("[a-z][a-z0-9]{1,15}") || word.equals(CourierRequest.WORD)
                        || found.containsKey(word)) {
                    continue;
                }
                try {
                    mode.warmUp();
                    found.put(word, mode);
                } catch (RuntimeException | LinkageError e) {
                    // Left out: its requests are bad_request, as an image older than the mode would answer.
                }
            }
        } catch (java.util.ServiceConfigurationError e) {
            // No modes: courier1 alone.
        }
        modes = Map.copyOf(found);
    }

    /** The modes found, for tests. */
    static Map<String, WorkerMode> modes() {
        return modes;
    }

    private static byte[] warmZip() {
        try {
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            try (java.util.zip.ZipOutputStream z = new java.util.zip.ZipOutputStream(out)) {
                z.putNextEntry(new java.util.zip.ZipEntry("w.txt"));
                z.write(1);
                z.closeEntry();
            }
            return out.toByteArray();
        } catch (IOException e) {
            return new byte[0];
        }
    }

    /** {@link Limits#PARSE_MILLIS} after the start: {@code ERR timeout} if nothing was answered, and the JVM halts. */
    private static void watchdog(Answer answer, long start) {
        Thread t = new Thread(() -> {
            try {
                long wait = Limits.PARSE_MILLIS - (System.nanoTime() - start) / 1_000_000L;
                if (wait > 0) {
                    Thread.sleep(wait);
                }
                if (answer.claim()) {
                    answer.line("ERR " + Refusal.TIMEOUT);
                } else {
                    // An answer is being written: one second more for it, then the end either way.
                    Thread.sleep(1000);
                }
            } catch (InterruptedException | IOException e) {
                // Halting is the point either way.
            }
            Runtime.getRuntime().halt(DEADLINE);
        }, "courier-deadline");
        t.setDaemon(true);
        t.start();
    }

    /** In-process, for tests and the fuzzer: one request on {@code in}, its answer on {@code out}. */
    public static int serve(InputStream in, OutputStream out, long millis) {
        return serve(in, new Answer(out), new Mime.Deadline(millis));
    }

    static int serve(InputStream in, Answer answer, Mime.Deadline deadline) {
        CourierRequest request;
        try {
            CourierRequest.Line line = CourierRequest.readLine(in);
            WorkerMode mode = modes.get(line.word());
            if (mode != null) {
                return serveMode(mode, line.text(), in, answer, deadline);
            }
            request = line.request();
        } catch (CourierRequest.Malformed | IOException e) {
            refuse(answer, Refusal.BAD_REQUEST);
            return MALFORMED;
        }
        try {
            switch (request.op()) {
                case MESSAGE -> {
                    Map<String, Object> m = Mime.message(in, deadline);
                    byte[] json = Wire.json(m);
                    drain(in);
                    answer.ok("", json);
                }
                case PART -> {
                    Chunks bytes = new Chunks(Limits.MAX_PART_BYTES);
                    Mime.part(in, request.part(), body -> copy(body, bytes, deadline), deadline);
                    if (bytes.over()) {
                        throw new Refusal(Refusal.TOO_LARGE);
                    }
                    drain(in);
                    answer.ok(Long.toString(bytes.size()), bytes);
                }
                case IMAGE -> {
                    Chunks bytes = new Chunks(Limits.MAX_IMAGE_BYTES);
                    if (CourierRequest.SELF.equals(request.part())) {
                        copy(new Mime.Counted(in, deadline), bytes, deadline);
                    } else {
                        Mime.part(in, request.part(), body -> copy(body, bytes, deadline), deadline);
                    }
                    if (bytes.over()) {
                        throw new Refusal(Refusal.TOO_LARGE);
                    }
                    Images.Encoded image = Images.reencode(bytes.head(64 * 1024), bytes.inputStream(), Limits.PREVIEW_SIDE);
                    drain(in);
                    answer.ok(image.type() + " " + image.width() + " " + image.height(), image.bytes());
                }
                case ARCHIVE -> {
                    Danger.Sniffer sniffer = new Danger.Sniffer(true);
                    Mime.Found found = Mime.part(in, request.part(), body -> sniff(body, sniffer, deadline), deadline);
                    Archives.Listing listing = sniffer.listing();
                    if (listing == null) {
                        throw new Refusal(Refusal.UNSUPPORTED);
                    }
                    drain(in);
                    answer.ok("", Wire.json(listing(listing, found.name())));
                }
                default -> throw new Refusal(Refusal.BAD_REQUEST);
            }
            return 0;
        } catch (Refusal r) {
            drain(in);
            refuse(answer, r.reason());
            return 0;
        } catch (IOException | RuntimeException e) {
            if (Boolean.getBoolean("ma.courier.debug")) {
                e.printStackTrace();
            }
            drain(in);
            refuse(answer, Refusal.MALFORMED);
            return 0;
        } catch (StackOverflowError e) {
            // Nothing here recurses on the input, but a library could: past the worker's stack it's too complex.
            drain(in);
            refuse(answer, Refusal.TOO_COMPLEX);
            return 0;
        }
    }

    /** A mode's request: its answer through the same one-answer rule as the deadline's. */
    private static int serveMode(WorkerMode mode, String line, InputStream in, Answer answer, Mime.Deadline deadline) {
        WorkerMode.Reply reply = new WorkerMode.Reply() {
            @Override
            public boolean ok(String note, byte[] body) throws IOException {
                if (note == null || !note.matches("[ -~]{0,100}") || note.startsWith(" ")) {
                    throw new IllegalArgumentException("note");
                }
                if (!answer.claim()) {
                    return false;
                }
                answer.raw(("OK" + (note.isEmpty() ? "" : " " + note) + "\n").getBytes(StandardCharsets.US_ASCII), body);
                return true;
            }

            @Override
            public void refuse(String reason) {
                CourierWorker.refuse(answer, reason != null && reason.matches("[a-z_]{1,32}") ? reason : Refusal.MALFORMED);
            }

            @Override
            public void drain() {
                CourierWorker.drain(in);
            }
        };
        try {
            mode.serve(line, in, reply, deadline.left());
            return 0;
        } catch (IOException | RuntimeException e) {
            if (Boolean.getBoolean("ma.courier.debug")) {
                e.printStackTrace();
            }
            drain(in);
            refuse(answer, Refusal.MALFORMED);
            return 0;
        } catch (StackOverflowError e) {
            drain(in);
            refuse(answer, Refusal.TOO_COMPLEX);
            return 0;
        }
    }

    static Map<String, Object> listing(Archives.Listing listing, String archiveName) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("v", 1);
        m.put("format", listing.format());
        List<Map<String, Object>> entries = new ArrayList<>();
        for (Archives.Entry e : listing.entries()) {
            Map<String, Object> x = new LinkedHashMap<>();
            String name = TextClean.clean(e.name(), false);
            x.put("name", name.length() > 1024 ? name.substring(0, 1024) : name);
            x.put("bytes", Math.max(-1, e.bytes()));
            x.put("packed", Math.max(-1, e.packed()));
            x.put("encrypted", e.encrypted());
            x.put("dir", e.dir());
            x.put("danger", e.dir() ? null : Danger.byName(e.name()));
            entries.add(x);
        }
        m.put("entries", entries);
        m.put("total", listing.total());
        m.put("truncated", listing.truncated());
        m.put("danger", Danger.byListing(listing, archiveName));
        return m;
    }

    private static void refuse(Answer answer, String reason) {
        try {
            if (answer.claim()) {
                answer.line("ERR " + reason);
            }
        } catch (IOException e) {
            // The connection is gone; deskd sees that.
        }
    }

    private static void copy(InputStream from, Chunks to, Mime.Deadline deadline) {
        byte[] buf = new byte[16384];
        try {
            int n;
            while ((n = from.read(buf)) >= 0) {
                deadline.check();
                to.write(buf, 0, n);
            }
        } catch (IOException e) {
            throw new Refusal(Refusal.MALFORMED);
        }
    }

    private static void sniff(InputStream from, Danger.Sniffer to, Mime.Deadline deadline) {
        byte[] buf = new byte[16384];
        try {
            int n;
            while ((n = from.read(buf)) >= 0) {
                deadline.check();
                to.write(buf, 0, n);
            }
        } catch (IOException e) {
            throw new Refusal(Refusal.MALFORMED);
        }
    }

    /** Reads what's left of the request, up to a bound and for at most two seconds, so deskd's write can end. */
    private static void drain(InputStream in) {
        byte[] buf = new byte[65536];
        long end = System.nanoTime() + 2_000_000_000L;
        long total = 0;
        try {
            int n;
            while (total < DRAIN_MAX && System.nanoTime() < end && (n = in.read(buf)) >= 0) {
                total += n;
            }
        } catch (IOException | RuntimeException e) {
            // Nothing more to read.
        }
    }

    /** The one answer: whoever claims it first writes it, the work or the deadline. */
    static final class Answer {
        private final OutputStream out;
        private boolean claimed;

        Answer(OutputStream out) {
            this.out = out;
        }

        synchronized boolean claim() {
            if (claimed) {
                return false;
            }
            claimed = true;
            return true;
        }

        void line(String line) throws IOException {
            out.write((line + "\n").getBytes(StandardCharsets.US_ASCII));
            out.flush();
        }

        void ok(String note, byte[] body) throws IOException {
            if (!claim()) {
                return;
            }
            out.write(("OK" + (note.isEmpty() ? "" : " " + note) + "\n").getBytes(StandardCharsets.US_ASCII));
            out.write(body);
            out.flush();
        }

        /** A line and a body already claimed: a mode's answer. */
        void raw(byte[] line, byte[] body) throws IOException {
            out.write(line);
            out.write(body);
            out.flush();
        }

        void ok(String note, Chunks body) throws IOException {
            if (!claim()) {
                return;
            }
            out.write(("OK" + (note.isEmpty() ? "" : " " + note) + "\n").getBytes(StandardCharsets.US_ASCII));
            body.writeTo(out);
            out.flush();
        }
    }
}
