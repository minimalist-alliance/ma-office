package com.minimalistalliance.desk.agent.attach;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;
import com.minimalistalliance.desk.agent.attach.worker.ParseRequest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

/**
 * The real worker in {@code --from-stream}, as the sandbox starts it ({@code Parsers.streamCommand}, the flags of
 * {@code /app/parse.options}): the answer is today's, and a malformed line gets {@code ERR bad_request} and nothing
 * else, with a non-zero exit.
 */
class ParseWorkerStreamTest {

    record Run(int exit, String out) {}

    private static Run run(byte[] input, String... extra) throws Exception {
        List<String> command = new ArrayList<>(Parsers.streamCommand());
        command.addAll(List.of(extra));
        ProcessBuilder builder = new ProcessBuilder(command);
        builder.environment().clear();
        builder.redirectError(ProcessBuilder.Redirect.DISCARD);
        Process worker = builder.start();
        Thread writer = new Thread(() -> {
            try (OutputStream stdin = worker.getOutputStream()) {
                stdin.write(input);
            } catch (IOException e) {
                // It stopped reading: a refused line.
            }
        });
        writer.start();
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        try (InputStream stdout = worker.getInputStream()) {
            stdout.transferTo(out);
        }
        assertThat(worker.waitFor(30, TimeUnit.SECONDS)).isTrue();
        return new Run(worker.exitValue(), out.toString(StandardCharsets.UTF_8));
    }

    private static byte[] request(String line, byte[] file) {
        byte[] head = line.getBytes(StandardCharsets.US_ASCII);
        byte[] all = new byte[head.length + file.length];
        System.arraycopy(head, 0, all, 0, head.length);
        System.arraycopy(file, 0, all, head.length, file.length);
        return all;
    }

    @Test
    void aTextFileIsAnsweredAsToday() throws Exception {
        Run run = run(request("parse1 text 1000 1\n", "hello\u001b there".getBytes(StandardCharsets.UTF_8)));
        assertThat(run.exit()).isZero();
        assertThat(run.out()).isEqualTo("OK \nhello there");
    }

    @Test
    void aPdfAndAnOfficeFileAreRead() throws Exception {
        Run pdf = run(request("parse1 pdf 100000 2\n", Fixtures.pdf(3, "Stream line")));
        assertThat(pdf.exit()).isZero();
        assertThat(pdf.out()).startsWith("OK cut\n").contains("Stream line page 2").doesNotContain("page 3");
        Run docx = run(request("parse1 docx 100000 1\n", Fixtures.docx("A paragraph")));
        assertThat(docx.out()).startsWith("OK").contains("A paragraph");
    }

    @Test
    void aFileItCannotReadIsAnErrAsToday() throws Exception {
        Run bomb = run(request("parse1 docx 100000 1\n", Fixtures.zipBomb("word/document.xml", 150)));
        assertThat(bomb.out()).isIn("ERR too_complex\n", "ERR unreadable\n");
    }

    @Test
    void aMalformedLineGetsBadRequestAndNothingElse() throws Exception {
        for (String line : List.of("parse1 doc 1000 1\n", "parse1 text 2000001 1\n", "parse1 text 1000 1 x\n",
                "parse2 text 1000 1\n", "x".repeat(80) + "\n", "parse1 text 1000 1")) {
            Run run = run(request(line, "the file's words".getBytes(StandardCharsets.UTF_8)));
            assertThat(run.exit()).as(line).isEqualTo(2);
            assertThat(run.out()).as(line).isEqualTo("ERR bad_request\n");
        }
        Run empty = run(new byte[0]);
        assertThat(empty.exit()).isEqualTo(2);
        assertThat(empty.out()).isEqualTo("ERR bad_request\n");
    }

    @Test
    void anythingAfterFromStreamIsRefusedWithNoOutput() throws Exception {
        Run run = run(request("parse1 text 1000 1\n", "x".getBytes(StandardCharsets.UTF_8)), "pdf");
        assertThat(run.exit()).isEqualTo(2);
        assertThat(run.out()).isEmpty();
    }

    /**
     * A file whose parse needs more than the heap (a content stream that inflates to 200 MiB) ends the worker out of
     * memory. HotSpot's exit status is 3, and its "Terminating due to java.lang.OutOfMemoryError" goes to stderr
     * (WORKER_FLAGS), so stdout is empty: desk-agent sees a stream that ended before a line, {@code too_complex}, not a
     * line that isn't an answer.
     */
    @Test
    void aWorkerOutOfMemoryWritesNothingToStdout() throws Exception {
        Run run = run(request("parse1 pdf 1000 1\n", Fixtures.heavyPdf()));
        assertThat(run.exit()).isEqualTo(3);
        assertThat(run.out()).isEmpty();
    }

    /**
     * Every kind at the ceiling a desk owner may set, 20 MiB (ADR 0049 item 5), with {@code files_read}'s ask, reads
     * within the worker's 72 MiB heap: the file is held once, in chunks, and never copied (worker/Input). Before, every
     * kind ended out of memory from about 17 MiB, while reading its input.
     */
    @ParameterizedTest
    @ValueSource(strings = {"text", "pdf-text", "pdf-image", "docx", "xlsx", "pptx"})
    void everyKindAtTheCeilingIsRead(String name) throws Exception {
        byte[] file = ceiling(name);
        assertThat((long) file.length).isBetween(Caps.CEILING.maxFileBytes() * 98 / 100, Caps.CEILING.maxFileBytes());
        String kind = name.startsWith("pdf") ? "pdf" : name;
        Run run = run(request("parse1 " + kind + " " + ParseRequest.MAX_CHARS + " " + ParseRequest.MAX_PAGES + "\n", file));
        assertThat(run.exit()).as(name).isZero();
        assertThat(run.out()).as(name).startsWith("OK");
        assertThat(run.out().length()).as(name).isGreaterThan(200);
    }

    private static byte[] ceiling(String name) {
        int size = (int) Caps.CEILING.maxFileBytes();
        return switch (name) {
            case "text" -> SizedFixtures.text(size);
            case "pdf-text" -> SizedFixtures.textPdf(size);
            case "pdf-image" -> SizedFixtures.imagePdf(size);
            case "docx" -> SizedFixtures.docx(size);
            case "xlsx" -> SizedFixtures.xlsx(size);
            default -> SizedFixtures.pptx(size);
        };
    }

    /** Past the worker's own guard (40 MiB), a file is refused as unreadable whatever its kind, as before. */
    @ParameterizedTest
    @ValueSource(strings = {"text", "pdf", "docx"})
    void pastTheWorkersGuardIsUnreadable(String kind) throws Exception {
        byte[] big = new byte[(40 << 20) + 1];
        java.util.Arrays.fill(big, (byte) 'a');
        Run run = run(request("parse1 " + kind + " 1000 1\n", big));
        assertThat(run.exit()).as(kind).isZero();
        assertThat(run.out()).as(kind).isEqualTo("ERR unreadable\n");
    }

    /** The default cap's largest text file reads. */
    @Test
    void theDefaultCapsLargestFileIsRead() throws Exception {
        byte[] big = new byte[(int) Caps.DEFAULT.maxFileBytes()];
        java.util.Arrays.fill(big, (byte) 'a');
        Run run = run(request("parse1 text 1000 1\n", big));
        assertThat(run.exit()).isZero();
        assertThat(run.out()).startsWith("OK cut\n");
    }
}
