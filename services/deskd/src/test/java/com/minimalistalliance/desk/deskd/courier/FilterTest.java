package com.minimalistalliance.desk.deskd.courier;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.courier.testkit.SpamCorpus;
import com.minimalistalliance.desk.deskd.courier.store.Courier;
import com.minimalistalliance.desk.deskd.courier.store.ExternalIds;
import com.minimalistalliance.desk.deskd.courier.store.Invariants;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Courier's learning filter (the launch plan §2.8; draft ADR "Courier's store" §17) through the store: what teaches it,
 * when it acts, what it may judge, how its mistakes come back, what it keeps, and how well it does on the test kit's
 * generated spam corpus.
 */
class FilterTest {

    private static final String SPAMMY = "Cheap pills online pharmacy discount viagra cialis lowest price guaranteed overnight shipping order now";
    private static final String WANTED = "Are we still on for lunch on Tuesday with the kids, and could you bring the photos from the weekend";

    @SuppressWarnings("unchecked")
    private static Map<String, Object> filter(StoreRig rig) throws Exception {
        return (Map<String, Object>) rig.store.queries().counts().get("filter");
    }

    private static Mail spam(int i) {
        return Mail.from("Deals " + i + " <offers" + i + "@rx-" + i + ".example>").id("spam-" + i + "@x").subject("Discount pharmacy " + i)
                .text(SPAMMY + " " + i);
    }

    private static Mail wanted(int i) {
        return Mail.from("Friend " + i + " <friend" + i + "@mail-" + i + ".example>").id("ham-" + i + "@x").subject("Lunch " + i)
                .text(WANTED + " " + i);
    }

    /** Ten of each taught by what the member does: Spam on ten Requests, Let in on ten others. */
    private static void teach(StoreRig rig) throws Exception {
        for (int i = 0; i < 10; i++) {
            String s = rig.accept(spam(i)).messageId();
            assertThat(rig.lane(s)).isEqualTo("requests");
            rig.store.actions().move(List.of(s), null, null, "spam");
            String h = rig.accept(wanted(i)).messageId();
            rig.store.actions().decide(rig.channel(h), "let_in");
        }
    }

    @Test
    void itWaitsUntilTaughtTenOfEachAndThenJudgesOnlyStrangers(@TempDir Path dir) throws Exception {
        try (StoreRig rig = new StoreRig(dir)) {
            assertThat(filter(rig)).containsEntry("state", "learning").containsEntry("spam", 0L).containsEntry("wanted", 0L);
            // Untaught, the spammiest stranger is still a Request.
            String early = rig.accept(spam(100)).messageId();
            assertThat(rig.lane(early)).isEqualTo("requests");
            teach(rig);
            assertThat(filter(rig)).containsEntry("state", "on").containsEntry("spam", 10L).containsEntry("wanted", 10L);

            String judged = rig.accept(spam(200)).messageId();
            assertThat(rig.lane(judged)).isEqualTo("spam");
            assertThat(rig.facts(judged).get("screen")).isEqualTo("filter");
            // Through a linked mailbox, the same: Spam, not Other, and the provider isn't told (nothing owed to it).
            String linked = rig.accept(spam(201).to("me@gmail.example"), StoreRig.GMAIL).messageId();
            assertThat(rig.lane(linked)).isEqualTo("spam");
            String fine = rig.accept(wanted(300)).messageId();
            assertThat(rig.lane(fine)).isEqualTo("requests");
            assertThat(rig.facts(fine).get("screen")).isNull();

            // Never judged: a known sender's mail, however spammy, nor the member's own.
            String known = rig.accept(Mail.from("Friend 3 <friend3@mail-3.example>").id("k@x").text(SPAMMY)).messageId();
            assertThat(rig.lane(known)).isEqualTo("people");
            String mine = rig.store.accept(Mail.from("Me <me@desk.example>").to("newcomer@new.example").id("mine@x").subject("Pills?")
                    .text(SPAMMY).inbound(StoreRig.DESK).asOutgoing()).messageId();
            assertThat(rig.lane(mine)).isEqualTo("people");
            Invariants.check(rig.store);
        }
    }

    @Test
    void notSpamAndLetInBringItsMistakesBackAndTeachIt(@TempDir Path dir) throws Exception {
        try (StoreRig rig = new StoreRig(dir)) {
            teach(rig);
            String a = rig.accept(spam(500).sender("Pharma Pal <pal@pals.example>")).messageId();
            String b = rig.accept(spam(501).sender("Pharma Pal <pal@pals.example>").id("b2@x")).messageId();
            assertThat(rig.lane(a)).isEqualTo("spam");
            assertThat(rig.lane(b)).isEqualTo("spam");
            // "Not spam" on one: it goes back where it would have been (a Request), and teaches the filter it's wanted.
            rig.store.actions().move(List.of(a), null, null, "restore");
            assertThat(rig.lane(a)).isEqualTo("requests");
            assertThat(rig.facts(a).get("screen")).isNull();
            assertThat(filter(rig)).containsEntry("wanted", 11L);
            assertThat(rig.lane(b)).isEqualTo("spam");
            // Letting the sender in brings back what the filter alone had put in Spam, and teaches it that too.
            rig.store.actions().decide(rig.channel(a), "let_in");
            assertThat(rig.lane(a)).isEqualTo("people");
            assertThat(rig.lane(b)).isEqualTo("people");
            assertThat(filter(rig)).containsEntry("wanted", 12L);
            // A change of mind moves its counts across, never counts it twice.
            rig.store.actions().move(List.of(a), null, null, "spam");
            assertThat(filter(rig)).containsEntry("spam", 11L).containsEntry("wanted", 11L);
            rig.store.actions().move(List.of(a), null, null, "people");
            rig.store.actions().move(List.of(a), null, null, "spam");
            assertThat(filter(rig)).containsEntry("spam", 11L).containsEntry("wanted", 11L);
            // What the member put in Spam stays there when the sender is let in another way, even what the filter put there
            // first: "Spam" on it made it the member's word.
            String c = rig.accept(spam(600).sender("Third <third@third.example>")).messageId();
            assertThat(rig.facts(c).get("screen")).isEqualTo("filter");
            rig.store.actions().move(List.of(c), null, null, "spam");
            assertThat(rig.facts(c).get("screen")).isNull();
            String d = rig.accept(wanted(601).sender("Third <third@third.example>").id("d6@x")).messageId();
            assertThat(rig.lane(d)).isEqualTo("requests");
            rig.store.actions().move(List.of(d), null, null, "spam");
            rig.store.accept(Mail.from("Me <me@desk.example>").to("third@third.example").id("w3@x").inbound(StoreRig.DESK).asOutgoing());
            assertThat(rig.lane(c)).isEqualTo("spam");
            assertThat(rig.lane(d)).isEqualTo("spam");
            Invariants.check(rig.store);
        }
    }

    @Test
    void itsKillSwitchStopsItJudgingButNotLearning(@TempDir Path dir) throws Exception {
        try (StoreRig rig = new StoreRig(dir)) {
            rig.store.filterSwitch(() -> false);
            teach(rig);
            assertThat(filter(rig)).containsEntry("state", "off").containsEntry("spam", 10L);
            assertThat(rig.lane(rig.accept(spam(700)).messageId())).isEqualTo("requests");
            rig.store.filterSwitch(() -> true);
            assertThat(rig.lane(rig.accept(spam(701)).messageId())).isEqualTo("spam");
        }
    }

    @Test
    void itKeepsNoWordOfTheMailItLearnedFrom(@TempDir Path dir) throws Exception {
        String canary = "zqxjcanaryvortpleb";
        try (StoreRig rig = new StoreRig(dir)) {
            teach(rig);
            String s = rig.accept(spam(900).text(SPAMMY + " " + canary).subject("Offer " + canary)).messageId();
            rig.store.actions().move(List.of(s), null, null, "spam");
            rig.store.actions().delete(List.of(s), true);
            byte[] needle = canary.getBytes(StandardCharsets.UTF_8);
            try (Stream<Path> files = Files.walk(rig.dir)) {
                for (Path f : files.filter(Files::isRegularFile).toList()) {
                    assertThat(indexOf(Files.readAllBytes(f), needle)).as(f.toString()).isEqualTo(-1);
                }
            }
            // The counts stay (as in any such filter), and the record of what that message taught went with it.
            assertThat(filter(rig)).containsEntry("spam", 11L);
        }
    }

    private static int indexOf(byte[] hay, byte[] needle) {
        outer:
        for (int i = 0; i + needle.length <= hay.length; i++) {
            for (int j = 0; j < needle.length; j++) {
                if (hay[i + j] != needle[j]) {
                    continue outer;
                }
            }
            return i;
        }
        return -1;
    }

    /**
     * The test kit's generated corpus: the member marks the first 200 strangers' mail as it is (Spam, or Let in), and the
     * filter judges the next 1,200 as they come. Nothing wanted may go to Spam; most spam should.
     */
    @Test
    void onTheGeneratedCorpusNothingWantedGoesToSpamAndMostSpamDoes(@TempDir Path dir) throws Exception {
        List<SpamCorpus.Sample> corpus = SpamCorpus.generate(SpamCorpus.DEFAULT_SEED, Integer.getInteger("courier.spamcorpus.count", 1400));
        try (StoreRig rig = new StoreRig(dir)) {
            int taught = 0;
            int spamToSpam = 0;
            int spamMissed = 0;
            int wantedToSpam = 0;
            int wantedKept = 0;
            for (SpamCorpus.Sample s : corpus) {
                String id = rig.store.accept(new Courier.Inbound(StoreRig.DESK, "email", ExternalIds.email(StoreRig.DESK, s.name() + "@x", s.raw()),
                        Courier.Origin.LIVE, s.raw(), null, Courier.Verdicts.NONE, false, false, List.of(), null)).messageId();
                String lane = rig.lane(id);
                if (taught < 200) {
                    if (!"requests".equals(lane)) {
                        continue;
                    }
                    taught++;
                    if (s.spam()) {
                        rig.store.actions().move(List.of(id), null, null, "spam");
                    } else {
                        rig.store.actions().decide(rig.channel(id), "let_in");
                    }
                    continue;
                }
                if (!"requests".equals(lane) && !"spam".equals(lane)) {
                    continue; // a sender let in during the teaching: never judged
                }
                boolean inSpam = "spam".equals(lane);
                if (s.spam()) {
                    if (inSpam) {
                        spamToSpam++;
                    } else {
                        spamMissed++;
                    }
                } else if (inSpam) {
                    wantedToSpam++;
                } else {
                    wantedKept++;
                }
            }
            double recall = (double) spamToSpam / Math.max(1, spamToSpam + spamMissed);
            System.out.printf("courier filter corpus: spam %d to Spam, %d missed (recall %.3f); wanted %d kept, %d to Spam%n",
                    spamToSpam, spamMissed, recall, wantedKept, wantedToSpam);
            assertThat(wantedToSpam).isZero();
            assertThat(recall).isGreaterThan(0.9);
            Invariants.check(rig.store);
        }
    }
}
