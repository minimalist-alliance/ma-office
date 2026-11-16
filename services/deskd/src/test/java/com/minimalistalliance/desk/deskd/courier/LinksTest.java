package com.minimalistalliance.desk.deskd.courier;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.deskd.courier.parse.ParsedMessage;
import com.minimalistalliance.desk.deskd.courier.store.Actions;
import com.minimalistalliance.desk.deskd.courier.store.Courier;
import com.minimalistalliance.desk.deskd.courier.store.Invariants;
import com.minimalistalliance.desk.deskd.courier.store.Links;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * One person across channels (flow 11; {@code courier.links.*}): a link moves an endpoint and its messages onto a person,
 * an unlink moves it back, Undo reverses a link exactly, "not them" is remembered, and suggestions only ask. Nothing links
 * or merges without the member's call: a suggestion, a matching name or a signature changes nothing by itself.
 */
@SuppressWarnings("unchecked")
class LinksTest {

    private static final Courier.Verdicts PASS = new Courier.Verdicts(false, false, "pass", "pass", "pass", "example.com", null);
    private static final String PHONE = "+15550102030";

    /** Dana, let in: an email in People. */
    private static String dana(StoreRig rig, String text) throws Exception {
        String id = rig.store.accept(Mail.from("Dana Smith <dana@example.com>").id("d1@example.com").subject("Plans").text(text)
                .inbound(StoreRig.DESK).withVerdicts(PASS)).messageId();
        rig.store.actions().decide(rig.channel(id), "let_in");
        assertThat(rig.lane(id)).isEqualTo("people");
        return id;
    }

    /** A text from a number this desk doesn't know. */
    private static String text(StoreRig rig, String externalId, String words) throws Exception {
        ParsedMessage m = ParsedMessage.chat(new ParsedMessage.Address(null, PHONE), List.of(), words, null, List.of());
        return rig.store.accept(Courier.Inbound.chat(StoreRig.IMSG, "sms", externalId, m, 1_762_948_000_000L)).messageId();
    }

    private static String contactOf(StoreRig rig, String messageId) throws Exception {
        return (String) ((Map<?, ?>) rig.facts(messageId).get("from")).get("contactId");
    }

    private static Map<String, Object> standing(StoreRig rig, String contactId, String value) throws Exception {
        for (Object e : (List<?>) rig.store.queries().contactById(contactId).get("endpoints")) {
            if (value.equals(((Map<?, ?>) e).get("value"))) {
                return (Map<String, Object>) e;
            }
        }
        return null;
    }

    @Test
    void aLinkJoinsTheConversationsLetsTheNumberInAndUndoPutsItAllBack(@TempDir Path dir) throws Exception {
        try (StoreRig rig = new StoreRig(dir)) {
            String mail = dana(rig, "See you Friday.");
            String danaId = contactOf(rig, mail);
            String danaChannel = rig.channel(mail);
            String sms = text(rig, "sms:1", "on my way");
            String phoneContact = contactOf(rig, sms);
            String phoneChannel = rig.channel(sms);
            String laneBefore = rig.lane(sms);
            assertThat(laneBefore).isNotEqualTo("people");
            assertThat(phoneChannel).isNotEqualTo(danaChannel);

            Links.Linked l = rig.store.links().link(danaId, null, "phone", PHONE);
            assertThat(l.channelId()).isEqualTo(danaChannel);
            assertThat(rig.channel(sms)).isEqualTo(danaChannel);
            assertThat(rig.lane(sms)).as("linking onto a known person lets the number in").isEqualTo("people");
            assertThat(contactOf(rig, sms)).isEqualTo(danaId);
            assertThat(rig.store.queries().contactById(phoneContact)).as("the number's own person went").isNull();
            assertThat((List<?>) rig.store.queries().thread(danaChannel, null, null, 50).get("messages")).hasSize(2);
            assertThat(standing(rig, danaId, PHONE).get("standing")).isEqualTo("known");
            assertThat(rig.store.links().lookup("phone", PHONE)).containsEntry("contactId", danaId).containsEntry("endpoints", 2)
                    .containsEntry("messages", 1L);
            Invariants.check(rig.store);

            rig.store.links().undo(l.linkId());
            assertThat(rig.channel(sms)).as("the same conversation as before").isEqualTo(phoneChannel);
            assertThat(contactOf(rig, sms)).as("the same person as before").isEqualTo(phoneContact);
            assertThat(rig.lane(sms)).isEqualTo(laneBefore);
            assertThat(rig.facts(sms).get("senderKnown")).isEqualTo(false);
            assertThat(standing(rig, phoneContact, PHONE).get("standing")).isEqualTo("unknown");
            assertThat((List<?>) rig.store.queries().thread(danaChannel, null, null, 50).get("messages")).hasSize(1);
            assertThat((List<?>) rig.store.queries().contactById(danaId).get("endpoints")).hasSize(1);
            Invariants.check(rig.store);

            // Undone once is undone: a second Undo finds nothing.
            assertThatThrownBy(() -> rig.store.links().undo(l.linkId())).isInstanceOfSatisfying(Actions.Refused.class,
                    r -> assertThat(r.reason()).isEqualTo("link"));
        }
    }

    @Test
    void aWholePersonLinkedAndUndoneComesBackWithTheirOwnIds(@TempDir Path dir) throws Exception {
        try (StoreRig rig = new StoreRig(dir)) {
            String mail = dana(rig, "Hi.");
            String danaId = contactOf(rig, mail);
            String other = rig.accept(Mail.from("D. Smith <d.smith@work.example>").id("w1@work.example").subject("Work")).messageId();
            String otherId = contactOf(rig, other);
            String otherChannel = rig.channel(other);
            rig.store.actions().renameContact(otherId, "Dana at work");

            Links.Linked l = rig.store.links().link(danaId, otherId, null, null);
            assertThat(rig.channel(other)).isEqualTo(rig.channel(mail));
            assertThat(rig.lane(other)).isEqualTo("people");
            Invariants.check(rig.store);

            rig.store.links().undo(l.linkId());
            assertThat(rig.channel(other)).isEqualTo(otherChannel);
            assertThat(rig.store.queries().contactById(otherId)).containsEntry("name", "Dana at work").containsEntry("named", true);
            assertThat(rig.lane(other)).isEqualTo("requests");
            Invariants.check(rig.store);
        }
    }

    @Test
    void unlinkGivesTheEndpointItsOwnConversationAndNeverTheLastOne(@TempDir Path dir) throws Exception {
        try (StoreRig rig = new StoreRig(dir)) {
            String mail = dana(rig, "Hi.");
            String danaId = contactOf(rig, mail);
            String sms = text(rig, "sms:1", "on my way");
            rig.store.links().link(danaId, null, "phone", PHONE);

            Links.Unlinked u = rig.store.links().unlink("phone", PHONE);
            assertThat(u.contactId()).isNotEqualTo(danaId);
            assertThat(rig.channel(sms)).isEqualTo(u.channelId()).isNotEqualTo(rig.channel(mail));
            assertThat(contactOf(rig, sms)).isEqualTo(u.contactId());
            assertThat(rig.lane(sms)).as("unlinking deletes nothing and keeps its standing").isEqualTo("people");
            Invariants.check(rig.store);

            assertThatThrownBy(() -> rig.store.links().unlink("email", "dana@example.com")).isInstanceOfSatisfying(Actions.Refused.class,
                    r -> assertThat(r.code() + " " + r.reason()).isEqualTo("conflict only"));
            assertThatThrownBy(() -> rig.store.links().unlink("phone", "+15559999999")).isInstanceOfSatisfying(Actions.Refused.class,
                    r -> assertThat(r.reason()).isEqualTo("endpoint"));
        }
    }

    @Test
    void undoIsRefusedOnceSomethingElseMovedThoseEndpoints(@TempDir Path dir) throws Exception {
        try (StoreRig rig = new StoreRig(dir)) {
            String danaId = contactOf(rig, dana(rig, "Hi."));
            text(rig, "sms:1", "on my way");
            Links.Linked l = rig.store.links().link(danaId, null, "phone", PHONE);
            rig.store.links().unlink("phone", PHONE);
            assertThatThrownBy(() -> rig.store.links().undo(l.linkId())).isInstanceOfSatisfying(Actions.Refused.class,
                    r -> assertThat(r.code() + " " + r.reason()).isEqualTo("not_found link"));
            Invariants.check(rig.store);
        }
    }

    @Test
    void aNewNumberStartsOnThePersonAndUndoTakesItAway(@TempDir Path dir) throws Exception {
        try (StoreRig rig = new StoreRig(dir)) {
            String danaId = contactOf(rig, dana(rig, "Hi."));
            assertThat(rig.store.links().lookup("phone", PHONE)).containsEntry("contactId", null).containsEntry("messages", 0);
            Links.Linked l = rig.store.links().link(danaId, null, "phone", PHONE);
            assertThat(standing(rig, danaId, PHONE)).containsEntry("source", "added").containsEntry("standing", "known");
            assertThat(standing(rig, danaId, "dana@example.com")).containsEntry("source", "message");
            // A text from it now is Dana's, in her conversation.
            String sms = text(rig, "sms:1", "it's me");
            assertThat(contactOf(rig, sms)).isEqualTo(danaId);
            assertThat(rig.lane(sms)).isEqualTo("people");
            // With a message through it, Undo would lose that message's person: refused.
            assertThatThrownBy(() -> rig.store.links().undo(l.linkId())).isInstanceOf(Actions.Refused.class);
            Invariants.check(rig.store);
        }
    }

    @Test
    void aBlockedSenderJoinsNoOneByALink(@TempDir Path dir) throws Exception {
        try (StoreRig rig = new StoreRig(dir)) {
            String danaId = contactOf(rig, dana(rig, "Hi."));
            String spam = rig.accept(Mail.from("Pest <pest@spam.example>").id("p1@spam.example")).messageId();
            rig.store.actions().decide(rig.channel(spam), "block");
            assertThatThrownBy(() -> rig.store.links().link(danaId, null, "email", "pest@spam.example")).isInstanceOfSatisfying(Actions.Refused.class,
                    r -> assertThat(r.code() + " " + r.reason()).isEqualTo("conflict blocked"));
            assertThatThrownBy(() -> rig.store.links().link(danaId, null, "email", "dana@example.com")).isInstanceOfSatisfying(Actions.Refused.class,
                    r -> assertThat(r.code() + " " + r.reason()).isEqualTo("conflict already"));
            assertThatThrownBy(() -> rig.store.links().link(danaId, danaId, null, null)).isInstanceOfSatisfying(Actions.Refused.class,
                    r -> assertThat(r.reason()).isEqualTo("from"));
        }
    }

    @Test
    void aConfirmedSignatureSuggestsTheNumberAndNothingJoinsUntilTheMemberSays(@TempDir Path dir) throws Exception {
        try (StoreRig rig = new StoreRig(dir)) {
            String mail = dana(rig, "See you Friday.\n\nDana Smith\nGarden Club\n(555) 010-2030\n\n> earlier words (555) 010-9999");
            String danaId = contactOf(rig, mail);
            String sms = text(rig, "sms:1", "on my way");
            String phoneContact = contactOf(rig, sms);

            List<Map<String, Object>> all = rig.store.links().suggest(null, null);
            assertThat(all).singleElement().satisfies(s -> {
                assertThat(s.get("endpoint")).isEqualTo(Map.of("kind", "phone", "value", PHONE));
                assertThat(s.get("into")).isEqualTo(Map.of("contactId", danaId, "name", "Dana Smith"));
                assertThat(s).containsEntry("source", "signature").containsEntry("strength", "hint").containsEntry("fromContactId", phoneContact)
                        .containsEntry("channelId", rig.channel(sms));
            });
            assertThat(rig.store.links().suggest("phone", PHONE)).hasSize(1);
            assertThat(rig.store.links().suggest("email", "dana@example.com")).isEmpty();
            // A suggestion only asks: the number is still its own person.
            assertThat(contactOf(rig, sms)).isEqualTo(phoneContact);
            assertThat(rig.channel(sms)).isNotEqualTo(rig.channel(mail));

            rig.store.links().dismiss("phone", PHONE, danaId);
            assertThat(rig.store.links().suggest(null, null)).as("not them, never asked again").isEmpty();
            Invariants.check(rig.store);
        }
    }

    @Test
    void suggestionsNeverComeFromRequestsAnUnconfirmedSenderOrQuotedMail(@TempDir Path dir) throws Exception {
        try (StoreRig rig = new StoreRig(dir)) {
            // Dana is known, but this email of hers didn't pass DMARC: anyone could have written its signature.
            String mail = dana(rig, "Hi.");
            rig.store.accept(Mail.from("Dana Smith <dana@example.com>").id("d2@example.com").text("New number:\n(555) 010-2030")
                    .inbound(StoreRig.DESK).withVerdicts(new Courier.Verdicts(false, false, "fail", "fail", "fail", "example.com", null)));
            // A stranger in Requests names it too.
            rig.accept(Mail.from("Stranger <s@x.example>").id("s1@x.example").text("Call Dana:\n(555) 010-2030"));
            // And a confirmed email names it only inside quoted mail.
            rig.store.accept(Mail.from("Dana Smith <dana@example.com>").id("d3@example.com").text("Yes.\n\nOn Friday, Rowan wrote:\n(555) 010-2030")
                    .inbound(StoreRig.DESK).withVerdicts(PASS));
            text(rig, "sms:1", "on my way");
            assertThat(rig.store.links().suggest(null, null)).isEmpty();
            assertThat(contactOf(rig, mail)).isNotNull();
        }
    }

    @Test
    void theSameNameAloneIsAWeakSuggestionOnlyForAConfirmedSenderNeverAStrangerInRequests(@TempDir Path dir) throws Exception {
        try (StoreRig rig = new StoreRig(dir)) {
            String danaId = contactOf(rig, dana(rig, "Hi."));
            rig.clock.advance(java.time.Duration.ofMinutes(1));
            // Security's CF2-M1: a stranger asking to be let in under a known person's name is never "Is this also Dana?".
            String stranger = rig.accept(Mail.from("Dana Smith <dana.s@elsewhere.example>").id("e1@elsewhere.example")).messageId();
            assertThat(rig.lane(stranger)).isEqualTo("requests");
            assertThat(rig.store.links().suggest(null, null)).isEmpty();
            // Let in, with every message of theirs confirmed: now a weak suggestion into the Dana already here.
            rig.store.actions().decide(rig.channel(stranger), "let_in");
            assertThat(rig.store.links().suggest(null, null)).as("its mail never passed DMARC").isEmpty();
            rig.store.accept(Mail.from("Dana Smith <dana.s@elsewhere.example>").id("e2@elsewhere.example")
                    .inbound(StoreRig.DESK).withVerdicts(new Courier.Verdicts(false, false, "pass", "pass", "pass", "elsewhere.example", null)));
            assertThat(rig.store.links().suggest(null, null)).as("one unconfirmed message still counts against it").isEmpty();
            String other = rig.accept(Mail.from("Dana Smith <dana@other.example>").id("o1@other.example")).messageId();
            rig.store.actions().decide(rig.channel(other), "let_in");
            rig.store.accept(Mail.from("Dana Smith <dana@other.example>").id("o2@other.example").inbound(StoreRig.DESK)
                    .withVerdicts(new Courier.Verdicts(false, false, "pass", "pass", "pass", "other.example", null)));
            Invariants.check(rig.store);
            // A stranger through a linked mailbox (Other), confirmed or not, isn't suggested either (Security's CF2-L4).
            String viaGmail = rig.store.accept(Mail.from("Dana Smith <dana@mailbox.example>").to("me@gmail.example").id("g1@mailbox.example")
                    .inbound(StoreRig.GMAIL).withVerdicts(new Courier.Verdicts(false, false, "pass", "pass", "pass", "mailbox.example", null))).messageId();
            assertThat(rig.lane(viaGmail)).isEqualTo("other");
            assertThat(rig.store.links().suggest(null, null)).isEmpty();
            // dana@other.example's first message (before the let in) had no DMARC either; a fresh sender, every message confirmed,
            // let in by the member: now a weak suggestion into the Dana already here.
            String fresh = rig.store.accept(Mail.from("Dana Smith <dana@fresh.example>").id("f1@fresh.example").inbound(StoreRig.DESK)
                    .withVerdicts(new Courier.Verdicts(false, false, "pass", "pass", "pass", "fresh.example", null))).messageId();
            assertThat(rig.store.links().suggest(null, null)).as("still a Request").isEmpty();
            rig.store.actions().decide(rig.channel(fresh), "let_in");
            assertThat(rig.lane(fresh)).isEqualTo("people");
            List<Map<String, Object>> s = rig.store.links().suggest(null, null);
            assertThat(s).singleElement().satisfies(x -> {
                assertThat(x).containsEntry("source", "name").containsEntry("strength", "name");
                assertThat(x.get("endpoint")).isEqualTo(Map.of("kind", "email", "value", "dana@fresh.example"));
                assertThat(((Map<?, ?>) x.get("into")).get("contactId")).isEqualTo(danaId);
            });
        }
    }

    @Test
    void aRefusedLinkWritesNothingAndABlockedAddressIsRefused(@TempDir Path dir) throws Exception {
        try (StoreRig rig = new StoreRig(dir)) {
            String danaId = contactOf(rig, dana(rig, "Hi."));
            // Security's CF2-L1: the member address's other half is made beside dana@example.com, then the link is refused
            // (it's Dana's already): the made endpoint goes with the refusal.
            assertThatThrownBy(() -> rig.store.links().link(danaId, null, "ma", "dana@example.com")).isInstanceOfSatisfying(Actions.Refused.class,
                    r -> assertThat(r.code() + " " + r.reason()).isEqualTo("conflict already"));
            assertThat(rig.store.links().lookup("ma", "dana@example.com")).containsEntry("contactId", null);
            assertThat((List<?>) rig.store.queries().contactById(danaId).get("endpoints")).hasSize(1);
            // CF2-L2: a typed address under a blocked domain is refused, never attached as blocked.
            rig.store.actions().block("domain", "spam.example");
            assertThatThrownBy(() -> rig.store.links().link(danaId, null, "email", "x@spam.example")).isInstanceOfSatisfying(Actions.Refused.class,
                    r -> assertThat(r.code() + " " + r.reason()).isEqualTo("conflict blocked"));
            assertThat(rig.store.links().lookup("email", "x@spam.example")).containsEntry("contactId", null);
            Invariants.check(rig.store);
        }
    }
}
