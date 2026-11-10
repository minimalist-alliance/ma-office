package com.minimalistalliance.desk.agent.attach;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * Reads a file to text in a child JVM (ADR 0049). What this isolates, exactly:
 * <ul>
 * <li><b>Memory and time:</b> a 72 MiB heap that exits when it fills, a deadline, one child at a time. A zip bomb or a
 * huge PDF ends that process and not desk-agent.</li>
 * <li><b>Secrets in memory:</b> the child has an empty environment and shares nothing with desk-agent's heap, where the
 * provider keys are.</li>
 * <li><b>A Java security manager inside the child</b> ({@code worker/Sandbox}, AGENT-PARSE-1): it may read its own jars
 * and the JDK, and nothing else. It cannot write a file, open a socket, start a process, load native code or replace
 * the manager. Its working directory is a new empty directory removed afterwards.</li>
 * </ul>
 * What it does not do: the child has desk-agent's user id, mounts and network namespace, so it is not a kernel
 * sandbox. A bug in the JVM itself, or native code reached some other way, is outside the security manager. Closing
 * that is a container-level step (no network, no {@code /data}, dropped capabilities for a sidecar).
 */
public final class Parsers implements AutoCloseable {

    /** A file read to text, with {@code cut} when the character cap stopped it. */
    public record Text(String text, boolean cut) {}

    /** Only for a developer chasing a parser bug: lets the child's stack traces through. Never set on a desk. */
    private static final boolean DEBUG = Boolean.getBoolean("ma.attach.debug");
    static final String WORKER = "com.minimalistalliance.desk.agent.attach.worker.ParseWorker";

    private final long timeoutSeconds;
    /** One reader child at a time: a second JVM beside desk-agent's would take the container past its limit (ADR 0049). */
    private final Semaphore slots = new Semaphore(1);
    private final ExecutorService readers = Executors.newCachedThreadPool(runnable -> {
        Thread thread = new Thread(runnable, "attach-parse-reader");
        thread.setDaemon(true);
        return thread;
    });

    public Parsers(long timeoutSeconds) {
        this.timeoutSeconds = timeoutSeconds;
    }

    /**
     * @param kind {@code text}, {@code pdf}, {@code docx}, {@code xlsx} or {@code pptx}
     * @throws AttachException {@code empty}, {@code binary}, {@code encrypted}, {@code no_text}, {@code unreadable},
     *     {@code too_complex}, {@code timeout} or {@code busy}
     */
    public Text read(String kind, byte[] bytes, int maxChars, int maxPages, String name) throws AttachException {
        try {
            if (!slots.tryAcquire(15, TimeUnit.SECONDS)) {
                throw new AttachException("busy", name);
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new AttachException("busy", name);
        }
        Process process = null;
        Path home = null;
        try {
            ProcessBuilder builder = new ProcessBuilder(command(kind, maxChars, maxPages));
            builder.environment().clear();
            home = Files.createTempDirectory("attach-parse-");
            builder.directory(home.toFile());
            builder.redirectError(DEBUG ? ProcessBuilder.Redirect.INHERIT : ProcessBuilder.Redirect.DISCARD);
            process = builder.start();
            Process started = process;
            Thread writer = new Thread(() -> {
                try (OutputStream stdin = started.getOutputStream()) {
                    stdin.write(bytes);
                } catch (IOException e) {
                    // The child ended first; its answer says why.
                }
            }, "attach-parse-writer");
            writer.setDaemon(true);
            writer.start();
            int limit = maxChars * 4 + 1024;
            Future<byte[]> answer = readers.submit(() -> readBounded(started.getInputStream(), limit));
            byte[] out;
            try {
                out = answer.get(timeoutSeconds, TimeUnit.SECONDS);
            } catch (TimeoutException e) {
                throw new AttachException("timeout", name);
            } catch (ExecutionException e) {
                throw new AttachException("unreadable", name);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new AttachException("timeout", name);
            }
            return parse(out, name);
        } catch (IOException e) {
            throw new AttachException("unreadable", name);
        } finally {
            if (process != null) {
                process.destroyForcibly();
            }
            if (home != null) {
                try {
                    Files.deleteIfExists(home);
                } catch (IOException e) {
                    // The child can't write there; if the directory is somehow not empty it stays in tmpfs.
                }
            }
            slots.release();
        }
    }

    private static Text parse(byte[] out, String name) throws AttachException {
        int newline = -1;
        for (int i = 0; i < out.length && i < 64; i++) {
            if (out[i] == '\n') {
                newline = i;
                break;
            }
        }
        if (newline < 0) {
            // The child died before answering: out of memory, or killed.
            throw new AttachException("too_complex", name);
        }
        String head = new String(out, 0, newline, StandardCharsets.UTF_8);
        if (head.startsWith("ERR ")) {
            throw new AttachException(head.substring(4).strip(), name);
        }
        if (!head.startsWith("OK")) {
            throw new AttachException("unreadable", name);
        }
        String text = new String(out, newline + 1, out.length - newline - 1, StandardCharsets.UTF_8);
        return new Text(text, head.contains("cut"));
    }

    private static byte[] readBounded(InputStream in, int limit) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream(1 << 14);
        byte[] chunk = new byte[1 << 14];
        int read;
        while ((read = in.read(chunk)) >= 0) {
            if (buffer.size() + read > limit) {
                throw new IOException("output");
            }
            buffer.write(chunk, 0, read);
        }
        return buffer.toByteArray();
    }

    static List<String> command(String kind, int maxChars, int maxPages) {
        List<String> command = new ArrayList<>(List.of(
                Path.of(System.getProperty("java.home"), "bin", "java").toString(),
                "-Xmx72m", "-Xms8m", "-Xss512k", "-XX:+UseSerialGC", "-XX:TieredStopAtLevel=1",
                "-XX:MaxMetaspaceSize=96m", "-XX:+ExitOnOutOfMemoryError", "-XX:-HeapDumpOnOutOfMemoryError",
                "-XX:-CreateCoredumpOnCrash", "-XX:ErrorFile=/dev/null", "-XX:-UsePerfData",
                "-XX:+DisableAttachMechanism", "-Xshare:auto", "-Djava.awt.headless=true",
                "-Djava.security.manager=allow", "-Dma.attach.debug=" + DEBUG,
                "-cp", System.getProperty("java.class.path"), WORKER, kind, Integer.toString(maxChars),
                Integer.toString(maxPages)));
        return command;
    }

    @Override
    public void close() {
        readers.shutdownNow();
    }
}
