package com.minimalistalliance.desk.deskd.courier.linked;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.courier.testkit.FakeImapServer;
import com.minimalistalliance.desk.courier.testkit.FakeImapServer.Capability;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.Set;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

/**
 * The bar's row for linked mailboxes (the launch plan §7: 0 missed and 0 doubled across reconnects, UIDVALIDITY changes,
 * sleep and wake, and restarts), as a seeded random walk against the fake provider: rounds of the provider's changes (new
 * mail, flags, moves between folders, expunges) and of the member's on the desk (read, Trash, Spam, restore, delete for
 * good), with faults between and inside them (connections dropped and cut mid-message, commands refused, folders
 * renumbered, the transport asleep while the provider changes, deskd restarted). After each settled round the oracle
 * ({@link LinkedRig#check}) must find nothing wrong: each provider message once on the desk by its bytes, no second copy
 * of anything, read and lanes as the provider has them.
 *
 * <p>A round's provider changes and the member's don't touch one message at once: a conflict has no right answer to check
 * (the member's last word wins while its change is owed; a message the provider moved meanwhile keeps the member's lane).
 * {@code -Dcourier.imap.soak.rounds} sets the length (24 in a build), {@code -Dcourier.imap.soak.seed} the seed.
 */
class LinkedSoakTest {

    @TempDir
    Path dir;

    private static final List<String> FOLDERS = List.of("INBOX", "Archive", "Junk", "Trash");

    @ParameterizedTest(name = "{0}")
    @ValueSource(strings = {"qresync", "plain"})
    void zeroMissedAndZeroDoubledAcrossFaults(String kind) throws Exception {
        int rounds = Integer.getInteger("courier.imap.soak.rounds", 24);
        long seed = Long.getLong("courier.imap.soak.seed", 20261114L) + kind.hashCode();
        Random rnd = new Random(seed);
        FakeImapServer.Options opts = kind.equals("plain")
                ? FakeImapServer.Options.defaults().without(Capability.CONDSTORE, Capability.QRESYNC, Capability.ESEARCH, Capability.MOVE)
                : FakeImapServer.Options.defaults();
        Map<String, Integer> tally = new LinkedHashMap<>();
        try (LinkedRig rig = new LinkedRig(dir, opts)) {
            int next = 0;
            for (; next < 60; next++) {
                deliver(rig, rnd, next);
            }
            rig.link();
            settle(rig);
            for (int round = 0; round < rounds; round++) {
                boolean asleep = false;
                int fault = rnd.nextInt(10);
                if (fault == 0) {
                    rig.sleep();
                    asleep = true;
                    tally.merge("sleep", 1, Integer::sum);
                }
                if (round % 2 == 0) {
                    // The provider's round.
                    int n = 2 + rnd.nextInt(8);
                    for (int i = 0; i < n; i++) {
                        switch (rnd.nextInt(5)) {
                            case 0, 1 -> {
                                deliver(rig, rnd, next++);
                                tally.merge("delivered", 1, Integer::sum);
                            }
                            case 2 -> {
                                FakeImapServer.Message m = any(rig, rnd);
                                if (m != null) {
                                    rig.imap.setFlags(LinkedRig.LOGIN, folderOf(rig, m), m.uid(), rnd.nextBoolean() ? Set.of("\\Seen") : Set.of());
                                    tally.merge("flagged", 1, Integer::sum);
                                }
                            }
                            case 3 -> {
                                FakeImapServer.Message m = any(rig, rnd);
                                if (m != null) {
                                    String from = folderOf(rig, m);
                                    String to = FOLDERS.get(rnd.nextInt(FOLDERS.size()));
                                    if (!to.equals(from)) {
                                        rig.imap.move(LinkedRig.LOGIN, from, m.uid(), to);
                                        tally.merge("moved", 1, Integer::sum);
                                    }
                                }
                            }
                            default -> {
                                FakeImapServer.Message m = any(rig, rnd);
                                if (m != null && rnd.nextInt(3) == 0) {
                                    rig.imap.expunge(LinkedRig.LOGIN, folderOf(rig, m), m.uid());
                                    tally.merge("expunged", 1, Integer::sum);
                                }
                            }
                        }
                    }
                } else if (!asleep) {
                    // The member's round, on the desk, on messages the provider still has: one it deleted stays on the desk
                    // only, wherever the member then puts it, which the oracle can't tell from a sync that went wrong.
                    List<LinkedRig.DeskMessage> desk = placed(rig);
                    int n = 1 + rnd.nextInt(5);
                    for (int i = 0; i < n && !desk.isEmpty(); i++) {
                        LinkedRig.DeskMessage m = desk.get(rnd.nextInt(desk.size()));
                        switch (rnd.nextInt(5)) {
                            case 0 -> rig.store().actions().setRead(List.of(m.id()), null, null, !m.read());
                            case 1 -> rig.store().actions().delete(List.of(m.id()), false);
                            case 2 -> rig.store().actions().move(List.of(m.id()), null, null, "spam");
                            case 3 -> rig.store().actions().move(List.of(m.id()), null, null, "restore");
                            default -> {
                                if (m.lane().equals("trash")) {
                                    rig.store().actions().delete(List.of(m.id()), true);
                                    tally.merge("deletedForGood", 1, Integer::sum);
                                }
                            }
                        }
                        tally.merge("deskChanges", 1, Integer::sum);
                        desk = placed(rig);
                    }
                }
                switch (fault) {
                    case 1 -> {
                        rig.imap.dropConnections();
                        tally.merge("dropped", 1, Integer::sum);
                    }
                    case 2 -> {
                        rig.imap.cutAfterBytes(200 + rnd.nextInt(4000));
                        tally.merge("cut", 1, Integer::sum);
                    }
                    case 3 -> {
                        rig.imap.resetUidValidity(LinkedRig.LOGIN, FOLDERS.get(rnd.nextInt(FOLDERS.size())));
                        tally.merge("renumbered", 1, Integer::sum);
                    }
                    case 4 -> {
                        rig.imap.failNext("UID", 1, "NO [SERVERBUG] try again");
                        tally.merge("refused", 1, Integer::sum);
                    }
                    case 5 -> {
                        if (!asleep) {
                            rig.restartDeskd();
                            tally.merge("restarted", 1, Integer::sum);
                        }
                    }
                    default -> { }
                }
                if (asleep) {
                    rig.wake();
                }
                try {
                    settle(rig);
                } catch (AssertionError e) {
                    throw new AssertionError("round " + round + " " + tally + ": " + e.getMessage(), e);
                }
            }
            long desk = rig.count("SELECT count(*) FROM messages WHERE account_id = '" + rig.accountId + "'");
            long distinct = rig.count("SELECT count(DISTINCT blob) FROM messages WHERE account_id = '" + rig.accountId + "'");
            tally.put("deskMessages", (int) desk);
            System.out.println("COURIER-IMAP-SOAK " + kind + " seed=" + seed + " rounds=" + rounds + " " + tally);
            assertThat(desk).isEqualTo(distinct);
        }
    }

    private static void settle(LinkedRig rig) throws Exception {
        rig.awaitLive(Duration.ofSeconds(90));
        try {
            await().atMost(Duration.ofSeconds(30)).pollInterval(Duration.ofMillis(250)).until(() -> rig.check().isEmpty());
        } catch (org.awaitility.core.ConditionTimeoutException e) {
            throw new AssertionError("not settled: " + rig.check() + " status " + rig.status() + " places "
                    + rig.count("SELECT count(*) FROM linked_locations") + " orphans " + rig.count("SELECT count(*) FROM linked_orphans")
                    + " ops " + rig.count("SELECT count(*) FROM linked_ops"));
        }
    }

    private static List<LinkedRig.DeskMessage> placed(LinkedRig rig) throws Exception {
        List<LinkedRig.DeskMessage> out = new ArrayList<>();
        for (LinkedRig.DeskMessage m : rig.deskMessages()) {
            if (rig.count("SELECT count(*) FROM linked_locations WHERE message_id = '" + m.id() + "'") > 0) {
                out.add(m);
            }
        }
        return out;
    }

    private static void deliver(LinkedRig rig, Random rnd, int n) {
        String folder = rnd.nextInt(5) == 0 ? FOLDERS.get(rnd.nextInt(FOLDERS.size())) : "INBOX";
        rig.imap.deliver(LinkedRig.LOGIN, folder, LinkedSyncTest.mail(n), rnd.nextBoolean() ? Set.of("\\Seen") : Set.of(),
                Instant.parse("2026-10-01T00:00:00Z").plusSeconds(n * 37L));
    }

    private static FakeImapServer.Message any(LinkedRig rig, Random rnd) {
        List<FakeImapServer.Message> all = new ArrayList<>();
        for (String f : FOLDERS) {
            all.addAll(rig.imap.messages(LinkedRig.LOGIN, f));
        }
        return all.isEmpty() ? null : all.get(rnd.nextInt(all.size()));
    }

    private static String folderOf(LinkedRig rig, FakeImapServer.Message m) {
        for (String f : FOLDERS) {
            for (FakeImapServer.Message x : rig.imap.messages(LinkedRig.LOGIN, f)) {
                if (x.uid() == m.uid() && java.util.Arrays.equals(x.bytes(), m.bytes())) {
                    return f;
                }
            }
        }
        throw new IllegalStateException("gone");
    }
}
