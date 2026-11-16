package com.minimalistalliance.desk.agent.measure;

import com.minimalistalliance.desk.agent.attach.AttachException;
import com.minimalistalliance.desk.agent.attach.Fixtures;
import com.minimalistalliance.desk.agent.attach.Parsers;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Not a test: how long one file takes through {@link Parsers}, which decides the way as desk-agent does (ADR 0097): the
 * sidecar where {@code <dir>/required} or {@code <dir>/sock/parse.sock} is, the in-container child where neither is.
 * Run by {@code scripts/measure-attach.sh} and the sidecar's Docker check ({@code scripts/test-parse-sidecar.sh}).
 *
 * <p>Args: {@code <dir> <rounds> [check]}. Prints, per file, the way, the answer's first words and p50 / p95 / max in
 * milliseconds from the call to the answer (the worker JVM's start included, as a member waits for it). With
 * {@code check} it also reads the hostile files (a zip bomb, a PDF past the heap) and then a text file again, and
 * prints what each answered: the sidecar must keep serving, and no child may start once the sidecar has been seen.
 */
public final class ParseTimingProbe {

    private ParseTimingProbe() {}

    public static void main(String[] args) throws Exception {
        Path dir = Path.of(args[0]);
        int rounds = Integer.parseInt(args[1]);
        boolean check = args.length > 2 && args[2].equals("check");
        Map<String, Object[]> files = new LinkedHashMap<>();
        files.put("text", new Object[] {"text", "Plain words for the reader.\n".repeat(40).getBytes(StandardCharsets.UTF_8)});
        files.put("pdf", new Object[] {"pdf", Fixtures.pdf(100, "Quarterly revenue by region and product line")});
        files.put("docx", new Object[] {"docx", Fixtures.docx("Hello world", "Second paragraph")});
        files.put("xlsx", new Object[] {"xlsx", Fixtures.xlsx()});
        try (Parsers parsers = new Parsers(30, dir)) {
            String way = parsers.mode();
            for (Map.Entry<String, Object[]> file : files.entrySet()) {
                long[] ms = new long[rounds];
                String said = "";
                for (int i = 0; i < rounds; i++) {
                    long started = System.nanoTime();
                    said = answer(parsers, (String) file.getValue()[0], (byte[]) file.getValue()[1]);
                    ms[i] = (System.nanoTime() - started) / 1_000_000;
                }
                Arrays.sort(ms);
                System.out.printf("parse-timing way=%s file=%s bytes=%d rounds=%d p50=%d p95=%d max=%d said=%s%n", way,
                        file.getKey(), ((byte[]) file.getValue()[1]).length, rounds, ms[(rounds - 1) / 2],
                        ms[Math.min(rounds - 1, (int) Math.ceil(rounds * 0.95) - 1)], ms[rounds - 1], said);
            }
            if (check) {
                List<String> lines = new ArrayList<>();
                lines.add("bomb=" + answer(parsers, "docx", Fixtures.zipBomb("word/document.xml", 150)));
                lines.add("heavy-pdf=" + answer(parsers, "pdf", heavyPdf()));
                lines.add("after=" + answer(parsers, "text", "Still serving.".getBytes(StandardCharsets.UTF_8)));
                lines.add("way=" + parsers.mode());
                Parsers.Counts c = parsers.counts();
                lines.add("counts=sidecar:" + c.sidecar() + "/" + c.sidecarFailed() + ",child:" + c.child() + "/"
                        + c.childFailed());
                System.out.println("parse-check " + String.join(" ", lines));
            }
        }
    }

    /** {@code OK <first words>} or {@code ERR <reason>}. */
    private static String answer(Parsers parsers, String kind, byte[] bytes) {
        try {
            String text = parsers.read(kind, bytes, 100_000, 100, "f").text().strip();
            String head = text.length() > 24 ? text.substring(0, 24) : text;
            return "OK:" + head.replaceAll("\\s+", "_");
        } catch (AttachException e) {
            return "ERR:" + e.reason();
        }
    }

    /** {@link Fixtures#heavyPdf()}: reading it ends the worker (out of memory, or the deadline), not the sidecar. */
    static byte[] heavyPdf() {
        return Fixtures.heavyPdf();
    }
}
