package com.minimalistalliance.desk.deskd.courier;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.deskd.courier.store.Courier;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * {@code courier.attention} (API.md §21 and §23): the People lane's unread threads as structure only, for the focus shield.
 * Never a subject, a snippet, a name or an address; Requests never; who wrote last and since when; the reply band.
 */
class CourierAttentionTest {

    static final long NOW = Instant.parse("2026-11-12T12:00:00Z").toEpochMilli();

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> threads(StoreRig rig) throws Exception {
        return (List<Map<String, Object>>) rig.store.queries().attention(NOW).get("threads");
    }

    private static int sent;

    /** The member writes to them (the transport says it's the member's own), at {@code iso}. */
    private static void reply(StoreRig rig, String to, String iso) throws Exception {
        rig.store.accept(Mail.from("Me <me@desk.example>").to(to).id("out" + (++sent) + "@desk.example").subject("Re: Contract terms")
                .text("See you").at(iso).inbound(StoreRig.DESK).asOutgoing());
    }

    @Test
    void aPersonWaitingOnTheMemberIsStructureOnlyAndRequestsNeverShow(@TempDir Path dir) throws Exception {
        try (StoreRig rig = new StoreRig(dir)) {
            String first = rig.accept(Mail.from("Dana Smith <dana@example.com>").id("d1@example.com").subject("Contract terms")
                    .at("2026-11-10T09:00:00Z")).messageId();
            String channel = rig.channel(first);
            rig.store.actions().decide(channel, "let_in");
            // The member wrote back twice, then Dana wrote again: she's been waiting since then.
            reply(rig, "dana@example.com", "2026-11-12T11:00:00Z");
            reply(rig, "dana@example.com", "2026-11-12T12:00:00Z");
            rig.clock.advance(Duration.ofHours(1));
            String again = rig.accept(Mail.from("Dana Smith <dana@example.com>").id("d2@example.com").subject("Re: Contract terms")
                    .at("2026-11-12T13:00:00Z")).messageId();
            rig.clock.advance(Duration.ofHours(1));
            rig.accept(Mail.from("Dana Smith <dana@example.com>").id("d3@example.com").subject("Any news?").at("2026-11-12T14:00:00Z"));
            // A stranger: a Request, never here.
            rig.accept(Mail.from("Stranger <s@x.example>").id("s1@x.example").subject("URGENT: pay now").at("2026-11-12T14:00:00Z"));

            assertThat(rig.facts(again).get("lane")).isEqualTo("people");
            assertThat(rig.facts(again).get("channelId")).isEqualTo(channel);
            List<Map<String, Object>> ts = threads(rig);
            assertThat(ts).singleElement().satisfies(t -> {
                assertThat(t).containsOnlyKeys("channelId", "kind", "contactIds", "known", "confirmed", "bulk", "theyWroteLastAt",
                        "replyBand", "unread", "newestAt");
                assertThat(t.get("channelId")).isEqualTo(channel);
                assertThat(t.get("kind")).isEqualTo("direct");
                assertThat((List<?>) t.get("contactIds")).singleElement().asString().hasSize(26);
                assertThat(t.get("known")).isEqualTo(true);
                assertThat(t.get("bulk")).isEqualTo(false);
                // DMARC wasn't given by the transport here: can't be confirmed.
                assertThat(t.get("confirmed")).isEqualTo(false);
                assertThat(t.get("replyBand")).isEqualTo(1);
                assertThat((Long) t.get("theyWroteLastAt")).isEqualTo(Instant.parse("2026-11-12T13:00:00Z").toEpochMilli());
                assertThat((Long) t.get("unread")).isGreaterThanOrEqualTo(2L);
            });
            // Nothing of the words travels: no subject, name or address anywhere in it.
            String all = String.valueOf(rig.store.queries().attention(NOW));
            assertThat(all).doesNotContain("Contract", "Dana", "dana@", "example", "URGENT", "Any news", "See you");

            // The member reads it: nothing left to bring.
            rig.store.actions().setRead(null, channel, "people", true);
            assertThat(threads(rig)).isEmpty();
        }
    }

    @Test
    void whenTheMemberWroteLastNobodyIsWaitingAndAConfirmedSenderSaysSo(@TempDir Path dir) throws Exception {
        try (StoreRig rig = new StoreRig(dir)) {
            String first = rig.store.accept(Mail.from("Rosa <rosa@example.org>").id("r1@example.org").at("2026-11-12T09:00:00Z")
                    .inbound(StoreRig.DESK).withVerdicts(new Courier.Verdicts(false, false, "pass", "pass", "pass", "example.org", null)))
                    .messageId();
            String channel = rig.channel(first);
            rig.store.actions().decide(channel, "let_in");
            reply(rig, "rosa@example.org", "2026-11-12T10:00:00Z");
            List<Map<String, Object>> ts = threads(rig);
            assertThat(ts).singleElement().satisfies(t -> {
                assertThat(t.get("theyWroteLastAt")).isNull();
                assertThat(t.get("confirmed")).isEqualTo(true);
                assertThat(t.get("replyBand")).isEqualTo(1);
            });
        }
    }
}
