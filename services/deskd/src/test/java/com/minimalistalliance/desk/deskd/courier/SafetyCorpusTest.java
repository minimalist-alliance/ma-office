package com.minimalistalliance.desk.deskd.courier;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.courier.testkit.MimeCorpus;
import com.minimalistalliance.desk.courier.testkit.SpamCorpus;
import com.minimalistalliance.desk.deskd.courier.store.Courier;
import com.minimalistalliance.desk.deskd.courier.store.ExternalIds;
import com.minimalistalliance.desk.deskd.courier.store.Invariants;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The corpus runs for Waves 3.1 and 3.2: the test kit's MIME corpus through the real Courier mode into a store whose
 * learning filter the member has taught (from the generated spam corpus) and whose sender warnings run on every message,
 * then every attachment of every message saved to Files and every archive listed, over the wire. Each must end in a file
 * or a clean refusal: never an internal error, never a file that isn't the attachment's bytes.
 *
 * <p>{@code -Dcourier.corpus.count} sets how many generated samples follow the 155 hand-written ones: 1,000 by default,
 * 5,000 for the whole standard set.
 */
class SafetyCorpusTest {

    @Test
    void theCorpusIsReadJudgedAndEveryAttachmentSavedOrCleanlyRefused(@TempDir Path dir) throws Exception {
        int generated = Integer.getInteger("courier.corpus.count", 1000);
        List<MimeCorpus.Sample> corpus = new ArrayList<>(MimeCorpus.handWritten());
        corpus.addAll(MimeCorpus.generated(MimeCorpus.DEFAULT_SEED, generated).toList());
        try (AttachmentsRig rig = new AttachmentsRig(dir)) {
            TestClient owner = rig.owner("s-1");
            // The member teaches the filter first: Spam or Let in on 200 strangers' mail.
            int taught = 0;
            for (SpamCorpus.Sample s : SpamCorpus.generate(SpamCorpus.DEFAULT_SEED + 1, 400)) {
                if (taught == 200) {
                    break;
                }
                String id = rig.deliver(s.raw(), s.name());
                if (!"requests".equals(rig.store().queries().message(id, 0).get("lane"))) {
                    continue;
                }
                taught++;
                if (s.spam()) {
                    rig.store().actions().move(List.of(id), null, null, "spam");
                } else {
                    rig.store().actions().decide((String) rig.store().queries().message(id, 0).get("channelId"), "let_in");
                }
            }
            @SuppressWarnings("unchecked")
            Map<String, Object> filter = (Map<String, Object>) rig.store().queries().counts().get("filter");
            assertThat(filter).containsEntry("state", "on");

            Map<String, Integer> lanes = new TreeMap<>();
            Map<String, Integer> warnings = new TreeMap<>();
            Map<String, Integer> outcomes = new TreeMap<>();
            int read = 0;
            int refused = 0;
            int attachments = 0;
            long start = System.nanoTime();
            for (MimeCorpus.Sample s : corpus) {
                Courier.Accepted a = rig.store().accept(new Courier.Inbound("desk", "email", ExternalIds.email("desk", s.name() + "@corpus", s.raw()),
                        Courier.Origin.LIVE, s.raw(), null, Courier.Verdicts.NONE, false, false, List.of(), null));
                assertThat(a.kept()).as(s.name()).isTrue();
                Map<String, Object> m = rig.store().queries().message(a.messageId(), 0);
                if (m == null) {
                    continue;
                }
                lanes.merge((String) m.get("lane"), 1, Integer::sum);
                if (m.get("parse") != null) {
                    refused++;
                    continue;
                }
                read++;
                @SuppressWarnings("unchecked")
                List<Map<String, Object>> ws = (List<Map<String, Object>>) m.get("warnings");
                for (Map<String, Object> w : ws) {
                    warnings.merge((String) w.get("kind"), 1, Integer::sum);
                }
                @SuppressWarnings("unchecked")
                List<Map<String, Object>> parts = (List<Map<String, Object>>) m.get("attachments");
                for (Map<String, Object> part : parts) {
                    attachments++;
                    Map<String, Object> reply = rig.call(owner, "courier.attachment.save", "messageId", a.messageId(), "part", part.get("part"),
                            "allowDanger", true);
                    String outcome;
                    if ("RES".equals(reply.get("_kind"))) {
                        Path saved = rig.filesRoot.resolve((String) reply.get("path"));
                        assertThat(CourierAttachments.sha256(Files.readAllBytes(saved))).as(s.name()).isEqualTo(reply.get("sha256"));
                        outcome = Boolean.TRUE.equals(reply.get("already")) ? "already" : "saved";
                    } else {
                        Object reason = ((Map<?, ?>) reply.get("details")).get("reason");
                        outcome = reply.get("code") + ":" + reason;
                        assertThat(outcome).as(s.name() + " " + part).isIn("too_large:too_large", "not_found:null", "conflict:exists",
                                "unavailable:refused", "bad_request:unsupported");
                    }
                    outcomes.merge(outcome, 1, Integer::sum);
                    Object danger = part.get("danger");
                    if ("archive_programs".equals(danger) || "archive_unread".equals(danger)) {
                        Map<String, Object> listing = rig.call(owner, "courier.attachment.archive", "messageId", a.messageId(), "part", part.get("part"));
                        String l = "RES".equals(listing.get("_kind")) ? "listed" : "list:" + listing.get("code") + ":" + ((Map<?, ?>) listing.get("details")).get("reason");
                        assertThat(l).as(s.name()).isIn("listed", "list:bad_request:unsupported", "list:too_large:too_large", "list:unavailable:refused");
                        outcomes.merge(l, 1, Integer::sum);
                    }
                }
            }
            double seconds = (System.nanoTime() - start) / 1e9;
            System.out.printf("courier safety corpus: %d messages (%d read, %d refused) in %.1f s; lanes %s; warnings %s; %d attachments: %s%n",
                    corpus.size(), read, refused, seconds, lanes, warnings, attachments, outcomes);
            assertThat(read + refused).isEqualTo(corpus.size());
            assertThat(outcomes.getOrDefault("saved", 0)).isPositive();
            Invariants.check(rig.store());
            // Nothing staged for a download outlives it, and the Files tree holds only what was saved, under Courier/.
            try (var staged = Files.list(rig.store().partsDir())) {
                assertThat(staged).isEmpty();
            } catch (java.nio.file.NoSuchFileException e) {
                // Never made: nothing was downloaded.
            }
            try (var top = Files.list(rig.filesRoot)) {
                assertThat(top.map(p -> p.getFileName().toString()).filter(n -> !n.startsWith("."))).containsOnly("Courier");
            }
        }
    }
}
