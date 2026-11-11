package com.minimalistalliance.desk.deskd.notebook;

import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.testing.NotebookService;
import java.io.IOException;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.channels.SocketChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;

/**
 * The real desk-notebook, run by {@code DESK_NOTEBOOK_CMD}, a shell command that runs it in the foreground. It gets
 * {@code DESK_NOTEBOOK_SOCKET} and {@code DESK_NOTEBOOK_DATA_DIR} in its environment, in a temporary directory.
 */
final class RealNotebookService implements NotebookService {

    static final String CMD = "DESK_NOTEBOOK_CMD";

    private final Path socket;
    private final Path data;
    private Process process;

    RealNotebookService(Path dir) throws Exception {
        socket = dir.resolve("notebook.sock");
        data = Files.createDirectory(dir.resolve("notebook-data"));
        begin();
    }

    private void begin() throws Exception {
        ProcessBuilder builder = new ProcessBuilder("sh", "-c", System.getenv(CMD));
        builder.environment().put("DESK_NOTEBOOK_SOCKET", socket.toString());
        builder.environment().put("DESK_NOTEBOOK_DATA_DIR", data.toString());
        process = builder.inheritIO().start();
        // A socket a killed process left refuses connections until the new one replaces it, as on a desk.
        await().atMost(Duration.ofSeconds(30)).pollInterval(Duration.ofMillis(20)).until(this::listening);
    }

    private boolean listening() {
        try (SocketChannel probe = SocketChannel.open(StandardProtocolFamily.UNIX)) {
            probe.connect(UnixDomainSocketAddress.of(socket));
            return true;
        } catch (IOException e) {
            return false;
        }
    }

    @Override
    public Path socket() {
        return socket;
    }

    @Override
    public void restart() throws Exception {
        stop();
        Files.deleteIfExists(socket);
        begin();
    }

    /**
     * SIGKILL, as {@code docker kill} does: nothing is stored on the way out, and the socket stays behind, refusing
     * connections, until the process that replaces it after {@code away} binds a new one.
     */
    void kill(Duration away) throws Exception {
        // The command execs, so this is the service itself.
        process.destroyForcibly();
        process.waitFor();
        Thread.sleep(away.toMillis());
        begin();
    }

    @Override
    public void close() throws Exception {
        stop();
    }

    /**
     * Stops it (SIGTERM), runs {@code command}, a shell command, with the data directory and {@code args} after it, starts it
     * again, and returns what the command printed. For writing to its database what a desk takes years to.
     */
    String whileStopped(String command, String... args) throws Exception {
        stop();
        Files.deleteIfExists(socket);
        List<String> argv = new ArrayList<>(List.of("sh", "-c", command + " \"$@\"", "seed", data.toString()));
        argv.addAll(List.of(args));
        Process run = new ProcessBuilder(argv).redirectError(ProcessBuilder.Redirect.INHERIT).start();
        String out = new String(run.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        if (run.waitFor() != 0) {
            throw new IllegalStateException("the command failed: " + command);
        }
        begin();
        return out;
    }

    /** SIGTERM, which stores everything: the contract's "Nothing lost across a restart". */
    private void stop() throws InterruptedException {
        process.destroy();
        process.waitFor();
    }
}
