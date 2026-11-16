package com.minimalistalliance.desk.deskd.courier;

import com.minimalistalliance.desk.deskd.courier.store.Courier;
import com.minimalistalliance.desk.deskd.courier.store.CourierStore;
import com.minimalistalliance.desk.deskd.courier.store.ExternalIds;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.util.ArrayList;
import java.util.List;
import java.util.Random;

/**
 * The crash test's writer, in a JVM of its own that the test kills with SIGKILL at random moments. It opens the store
 * (finishing whatever the last kill left), then delivers the whole stream from the start, as a transport re-syncing after a
 * crash does, in batches with a cursor, deletes some messages for good as it goes, and says on stdout what it knows is
 * committed: {@code ACK <key> <id>} after a batch's commit returns, {@code PURGING <key>} before a delete for good and
 * {@code PURGED <key>} after.
 */
public final class CourierCrashChild {

    private CourierCrashChild() {}

    public static void main(String[] args) throws Exception {
        Path dir = Path.of(args[0]);
        int total = Integer.parseInt(args[1]);
        PrintStream out = new PrintStream(System.out, true, StandardCharsets.UTF_8);
        Files.createDirectories(dir);
        CourierStore store = CourierStore.open(dir, TestMime.PARSER, Clock.systemUTC(), CourierStore.Settings.DEFAULT);
        store.putAccount(new Courier.Account("gmail", "imap", "Gmail", "me@gmail.example", "ok"),
                List.<String[]>of(new String[] {"email", "me@gmail.example"}));
        out.println("OPEN");
        Random rnd = new Random(42);
        int at = 0;
        List<String> stored = new ArrayList<>();
        while (at < total) {
            int n = 1 + rnd.nextInt(20);
            List<Courier.Inbound> batch = new ArrayList<>();
            List<String> keys = new ArrayList<>();
            for (int i = 0; i < n && at < total; i++, at++) {
                // Every seventh is large and doesn't compress, so its blob is a file and the kill can land while it's staged.
                String body = "Message " + at + " " + (at % 7 == 0 ? noise(at, 120_000) : "lorem ipsum ".repeat(at % 50));
                Mail m = Mail.from("P" + (at % 37) + " <p" + (at % 37) + "@example.com>").to("me@gmail.example").id("c" + at + "@x")
                        .subject((at % 3 == 0 ? "Re: " : "") + "Topic " + (at % 11)).text(body);
                if (at % 4 == 0 && at > 0) {
                    m.replyTo("c" + (at - 1) + "@x", "<c0@x> <c" + (at - 1) + "@x>");
                }
                byte[] raw = m.bytes();
                String key = ExternalIds.email("gmail", "<c" + at + "@x>", raw);
                batch.add(Courier.Inbound.email("gmail", key, raw, Courier.Origin.CATCHUP));
                keys.add("c" + at);
            }
            List<Courier.Accepted> answers = store.accept(batch, new Courier.CursorUpdate("gmail", "INBOX", Integer.toString(at)));
            for (int i = 0; i < answers.size(); i++) {
                out.println("ACK " + keys.get(i) + " " + answers.get(i).messageId());
                if (answers.get(i).kind() == Courier.Accepted.Kind.STORED) {
                    stored.add(answers.get(i).messageId() + " " + keys.get(i));
                }
            }
            if (stored.size() > 30 && rnd.nextInt(4) == 0) {
                String[] victim = stored.remove(rnd.nextInt(stored.size())).split(" ");
                out.println("PURGING " + victim[1]);
                store.actions().delete(List.of(victim[0]), false);
                store.actions().delete(List.of(victim[0]), true);
                out.println("PURGED " + victim[1]);
            }
        }
        out.println("DONE");
        store.close();
    }

    /** Text that gzip can't shrink much: the same for the same message every run. */
    public static String noise(int seed, int chars) {
        Random r = new Random(seed);
        StringBuilder b = new StringBuilder(chars);
        String alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
        for (int i = 0; i < chars; i++) {
            b.append(i % 76 == 75 ? '\n' : alphabet.charAt(r.nextInt(alphabet.length())));
        }
        return b.toString();
    }
}
