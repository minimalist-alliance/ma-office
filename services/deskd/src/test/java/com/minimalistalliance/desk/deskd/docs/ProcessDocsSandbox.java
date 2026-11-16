package com.minimalistalliance.desk.deskd.docs;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * The real worker, a JVM per request with {@code courier-parse.options}' flags and security manager, as the sandbox runs
 * it (without the kernel's wall): for the corpus run. {@code cp} is desk-agent's runtime classpath with its classes.
 */
final class ProcessDocsSandbox implements DocsSandbox {

    private final Path options;
    private final String cp;
    private final Path trackers;
    final List<long[]> timings = new ArrayList<>();

    ProcessDocsSandbox(Path options, String cp, Path trackers) {
        this.options = options;
        this.cp = cp;
        this.trackers = trackers;
    }

    record Answer(String line, byte[] body, long ms) {}

    Answer run(String request, byte[] input) throws Unavailable {
        try {
            List<String> cmd = new ArrayList<>();
            cmd.add(Path.of(System.getProperty("java.home"), "bin", "java").toString());
            List<String> lines = new ArrayList<>();
            for (String l : Files.readAllLines(options)) {
                if (!l.isBlank() && !l.startsWith("#")) {
                    lines.add(l.strip());
                }
            }
            for (int i = 0; i < lines.size(); i++) {
                String l = lines.get(i);
                if (l.equals("-cp")) {
                    cmd.add("-cp");
                    cmd.add(cp);
                    i++;
                } else if (l.startsWith("-Dma.courier.trackers=")) {
                    cmd.add("-Dma.courier.trackers=" + trackers);
                } else {
                    cmd.add(l);
                }
            }
            ProcessBuilder pb = new ProcessBuilder(cmd);
            pb.environment().clear();
            pb.redirectError(ProcessBuilder.Redirect.DISCARD);
            long t = System.nanoTime();
            Process p = pb.start();
            Thread w = new Thread(() -> {
                try (OutputStream o = p.getOutputStream()) {
                    o.write((request + "\n").getBytes(StandardCharsets.US_ASCII));
                    o.write(input);
                } catch (IOException e) {
                    // It stopped reading.
                }
            });
            w.start();
            ByteArrayOutputStream all = new ByteArrayOutputStream();
            try (InputStream in = p.getInputStream()) {
                in.transferTo(all);
            }
            if (!p.waitFor(30, TimeUnit.SECONDS)) {
                p.destroyForcibly();
                throw new Unavailable("timeout");
            }
            byte[] b = all.toByteArray();
            int nl = 0;
            while (nl < b.length && b[nl] != '\n') {
                nl++;
            }
            String line = new String(b, 0, Math.min(nl, b.length), StandardCharsets.US_ASCII);
            byte[] body = nl + 1 <= b.length ? Arrays.copyOfRange(b, nl + 1, b.length) : new byte[0];
            return new Answer(line, body, (System.nanoTime() - t) / 1_000_000L);
        } catch (IOException | InterruptedException e) {
            throw new Unavailable("process");
        }
    }

    @Override
    public DocText read(String kind, byte[] file) throws Unavailable, Refused {
        Answer a = run("docs1 read " + kind + " " + READ_CHARS + " " + READ_PAGES, file);
        timings.add(new long[] {0, a.ms(), file.length});
        if (a.line().startsWith("ERR ")) {
            throw new Refused(a.line().substring(4));
        }
        if (!a.line().equals("OK")) {
            throw new Refused("too_complex");
        }
        return DocText.from(Answers.object(a.body()));
    }

    @Override
    public Image render(byte[] pdf, int page, int width) throws Unavailable, Refused {
        Answer a = run("docs1 render " + page + " " + width, pdf);
        timings.add(new long[] {1, a.ms(), a.body().length});
        if (!a.line().startsWith("OK jpeg ")) {
            throw new Refused(a.line().startsWith("ERR ") ? a.line().substring(4) : "too_complex");
        }
        String[] f = a.line().split(" ");
        return new Image("jpeg", Integer.parseInt(f[2]), Integer.parseInt(f[3]), a.body());
    }

    @Override
    public Image image(byte[] bytes) throws Unavailable, Refused {
        Answer a = run("courier1 image -", bytes);
        if (!a.line().startsWith("OK ")) {
            throw new Refused(a.line().startsWith("ERR ") ? a.line().substring(4) : "too_complex");
        }
        String[] f = a.line().split(" ");
        return new Image(f[1], Integer.parseInt(f[2]), Integer.parseInt(f[3]), a.body());
    }
}
