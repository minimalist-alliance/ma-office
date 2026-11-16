package com.minimalistalliance.desk.courier.testkit.soak;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * The run's record of what it sent, synced to disk at every line, so a run that stops (the harness's box restarts during a
 * 7-day soak) resumes where it was and still reconciles everything. Two kinds of line:
 * {@code + seq channel marker at} before a message goes, and {@code = seq} once its source took it. A planned line with
 * no confirmation (a crash in between) may or may not have gone, so {@link Soak#reconcile} accepts it either way.
 */
public final class Ledger implements AutoCloseable {

    private final Path file;
    private final FileChannel channel;
    private final List<Soak.Item> planned = new ArrayList<>();
    private final Set<Long> confirmed = new HashSet<>();

    public Ledger(Path file) throws IOException {
        this.file = file;
        if (Files.exists(file)) {
            for (String line : Files.readAllLines(file, StandardCharsets.UTF_8)) {
                String[] f = line.split(" ");
                if (f.length == 5 && f[0].equals("+")) {
                    planned.add(new Soak.Item(Long.parseLong(f[1]), f[2], f[3], Instant.parse(f[4])));
                } else if (f.length == 2 && f[0].equals("=")) {
                    confirmed.add(Long.parseLong(f[1]));
                }
                // A torn last line (a crash mid-append) is skipped: its message is planned again, or counted unconfirmed.
            }
        }
        this.channel = FileChannel.open(file, StandardOpenOption.CREATE, StandardOpenOption.WRITE, StandardOpenOption.APPEND);
    }

    public List<Soak.Item> planned() {
        return List.copyOf(planned);
    }

    public boolean confirmed(long seq) {
        return confirmed.contains(seq);
    }

    /** The next sequence number: one past the last planned. */
    public long next() {
        return planned.isEmpty() ? 0 : planned.get(planned.size() - 1).seq() + 1;
    }

    public void plan(Soak.Item item) throws IOException {
        write("+ " + item.seq() + " " + item.channel() + " " + item.marker() + " " + item.at() + "\n");
        planned.add(item);
    }

    public void confirm(long seq) throws IOException {
        write("= " + seq + "\n");
        confirmed.add(seq);
    }

    private void write(String line) throws IOException {
        channel.write(ByteBuffer.wrap(line.getBytes(StandardCharsets.UTF_8)));
        channel.force(false);
    }

    public Path file() {
        return file;
    }

    @Override
    public void close() throws IOException {
        channel.close();
    }
}
