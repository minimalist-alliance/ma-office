package com.minimalistalliance.desk.deskd.courier;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.deskd.courier.store.Actions;
import com.minimalistalliance.desk.deskd.courier.store.Courier;
import com.minimalistalliance.desk.deskd.courier.store.Invariants;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** People, Requests, Updates, Other, Spam and Trash (plan §2.4), and what the member does with them. */
class LanesTest {

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> rows(StoreRig rig, String lane) throws Exception {
        return (List<Map<String, Object>>) rig.store.queries().list(lane, null, null, 100, false).get("rows");
    }

    @SuppressWarnings("unchecked")
    private static long count(StoreRig rig, String lane, String what) throws Exception {
        Map<String, Object> lanes = (Map<String, Object>) rig.store.queries().counts().get("lanes");
        return (Long) ((Map<String, Object>) lanes.get(lane)).get(what);
    }

    @Test
    void aStrangerToThisDesksAddressIsARequestAndThroughAMailboxIsOther(@TempDir Path dir) throws Exception {
        try (StoreRig rig = new StoreRig(dir)) {
            String desk = rig.accept(Mail.from("Stranger <s@x.example>").id("1@x")).messageId();
            String gmail = rig.accept(Mail.from("Airline <noreply@air.example>").to("me@gmail.example").id("2@x"), StoreRig.GMAIL).messageId();
            assertThat(rig.lane(desk)).isEqualTo("requests");
            assertThat(rig.lane(gmail)).isEqualTo("other");
            assertThat(count(rig, "requests", "count")).isEqualTo(1);
            assertThat(count(rig, "requests", "unread")).isEqualTo(1);
            assertThat(rows(rig, "requests")).singleElement().satisfies(r -> {
                assertThat(((Map<?, ?>) r.get("last")).get("subject")).isEqualTo("Hello");
                assertThat(r.get("kind")).isEqualTo("direct");
            });
        }
    }

    @Test
    void letInMovesEverythingTheySentAndTheirLaterMailIsPeople(@TempDir Path dir) throws Exception {
        try (StoreRig rig = new StoreRig(dir)) {
            String a = rig.accept(Mail.from("Dana <dana@example.com>").id("a@x")).messageId();
            String b = rig.accept(Mail.from("Dana <dana@example.com>").id("b@x").bulk()).messageId();
            String channel = rig.channel(a);
            assertThat(rig.store.actions().decide(channel, "let_in")).isTrue();
            assertThat(rig.lane(a)).isEqualTo("people");
            assertThat(rig.lane(b)).isEqualTo("updates");
            String c = rig.accept(Mail.from("Dana <dana@example.com>").id("c@x")).messageId();
            assertThat(rig.lane(c)).isEqualTo("people");
            assertThat(rig.facts(c).get("senderKnown")).isEqualTo(true);
            assertThat(rows(rig, "requests")).isEmpty();
            Invariants.check(rig.store);
        }
    }

    @Test
    void aKnownSendersMailWhoseDmarcFailedIsARequestAndOneThatCantBeConfirmedStaysTheirs(@TempDir Path dir) throws Exception {
        try (StoreRig rig = new StoreRig(dir)) {
            String first = rig.accept(Mail.from("Dana <dana@example.com>").id("k1@x")).messageId();
            rig.store.actions().decide(rig.channel(first), "let_in");
            // DMARC failed: it only claims to be Dana (the coordinator's call, Nov 14): a Request, in her conversation.
            String failed = rig.store.accept(Mail.from("Dana <dana@example.com>").id("k2@x").subject("Wire the money").inbound(StoreRig.DESK)
                    .withVerdicts(new Courier.Verdicts(false, false, "fail", "fail", "fail"))).messageId();
            assertThat(rig.lane(failed)).isEqualTo("requests");
            assertThat(rig.channel(failed)).isEqualTo(rig.channel(first));
            // No DMARC policy for the domain, or no result: can't be confirmed, and stays in People, marked by the office.
            String none = rig.store.accept(Mail.from("Dana <dana@example.com>").id("k3@x").inbound(StoreRig.DESK)
                    .withVerdicts(new Courier.Verdicts(false, false, "pass", "none", "none"))).messageId();
            String missing = rig.accept(Mail.from("Dana <dana@example.com>").id("k4@x")).messageId();
            assertThat(rig.lane(none)).isEqualTo("people");
            assertThat(rig.lane(missing)).isEqualTo("people");
            assertThat(rig.facts(none).get("senderKnown")).isEqualTo(true);
            // A stranger's failed mail is a Request as ever, and Let in brings the failed one to People.
            assertThat(rig.store.actions().decide(rig.channel(failed), "let_in")).isTrue();
            assertThat(rig.lane(failed)).isEqualTo("people");
            Invariants.check(rig.store);
        }
    }

    @Test
    void notNowHidesTheCardUntilTheyWriteAgain(@TempDir Path dir) throws Exception {
        try (StoreRig rig = new StoreRig(dir)) {
            String a = rig.accept(Mail.from("Dana <dana@example.com>").id("a@x")).messageId();
            rig.store.actions().decide(rig.channel(a), "not_now");
            assertThat(rows(rig, "requests")).isEmpty();
            assertThat(rig.lane(a)).isEqualTo("requests");
            rig.clock.advance(java.time.Duration.ofMinutes(5));
            rig.accept(Mail.from("Dana <dana@example.com>").id("b@x").at("2026-11-12T12:04:00Z"));
            assertThat(rows(rig, "requests")).hasSize(1);
        }
    }

    @Test
    void blockingSendsTheirMailToSpamNowAndLater(@TempDir Path dir) throws Exception {
        try (StoreRig rig = new StoreRig(dir)) {
            String a = rig.accept(Mail.from("Pest <pest@spam.example>").id("a@x")).messageId();
            rig.store.actions().decide(rig.channel(a), "block");
            assertThat(rig.lane(a)).isEqualTo("spam");
            String b = rig.accept(Mail.from("Pest <pest@spam.example>").id("b@x")).messageId();
            assertThat(rig.lane(b)).isEqualTo("spam");
            assertThat(rows(rig, "requests")).isEmpty();
        }
    }

    @Test
    void aDomainBlockCoversItsSubdomainsAndUnblockEndsIt(@TempDir Path dir) throws Exception {
        try (StoreRig rig = new StoreRig(dir)) {
            String a = rig.accept(Mail.from("x@mail.bad.example").id("a@x")).messageId();
            assertThat(rig.store.actions().block("domain", "bad.example")).isEqualTo(1);
            assertThat(rig.lane(a)).isEqualTo("spam");
            String b = rig.accept(Mail.from("y@deep.mail.bad.example").id("b@x")).messageId();
            assertThat(rig.lane(b)).isEqualTo("spam");
            String c = rig.accept(Mail.from("z@notbad.example").id("c@x")).messageId();
            assertThat(rig.lane(c)).isEqualTo("requests");
            assertThat(rig.store.actions().unblock("domain", "bad.example")).isTrue();
            String d = rig.accept(Mail.from("y@deep.mail.bad.example").id("d@x")).messageId();
            assertThat(rig.lane(d)).isEqualTo("requests");
            assertThatThrownBy(() -> rig.store.actions().block("domain", "not a domain")).isInstanceOf(Actions.Refused.class);
            assertThatThrownBy(() -> rig.store.actions().block("planet", "x")).isInstanceOf(Actions.Refused.class);
        }
    }

    @Test
    void aSpamVerdictIsSpamAndNotSpamLetsTheSenderIn(@TempDir Path dir) throws Exception {
        try (StoreRig rig = new StoreRig(dir)) {
            Courier.Inbound in = Mail.from("Promo <p@shop.example>").id("s@x").inbound(StoreRig.DESK)
                    .withVerdicts(new Courier.Verdicts(true, false, "fail", "none", "fail"));
            String a = rig.store.accept(in).messageId();
            assertThat(rig.lane(a)).isEqualTo("spam");
            Map<?, ?> auth = (Map<?, ?>) rig.facts(a).get("auth");
            assertThat(auth.get("senderConfirmed")).isEqualTo(false);
            rig.store.actions().move(List.of(a), null, null, "people");
            assertThat(rig.lane(a)).isEqualTo("people");
            String b = rig.accept(Mail.from("Promo <p@shop.example>").id("s2@x")).messageId();
            assertThat(rig.lane(b)).isEqualTo("people");
        }
    }

    @Test
    void bulkFromSomeoneKnownIsUpdatesWithNoCountOnPeople(@TempDir Path dir) throws Exception {
        try (StoreRig rig = new StoreRig(dir)) {
            rig.store.accept(Mail.from("Me <me@desk.example>").to("news@shop.example").id("w@x").inbound(StoreRig.DESK).asOutgoing());
            String n = rig.accept(Mail.from("Shop <news@shop.example>").id("n@x").bulk()).messageId();
            assertThat(rig.lane(n)).isEqualTo("updates");
            assertThat(rig.facts(n).get("bulk")).isEqualTo(true);
            assertThat(count(rig, "people", "unread")).isZero();
        }
    }

    @Test
    void trashAndRestoreGoBackWhereItWas(@TempDir Path dir) throws Exception {
        try (StoreRig rig = new StoreRig(dir)) {
            String a = rig.accept(Mail.from("x@gmail-friend.example").to("me@gmail.example").id("a@x"), StoreRig.GMAIL).messageId();
            assertThat(rig.lane(a)).isEqualTo("other");
            rig.store.actions().delete(List.of(a), false);
            assertThat(rig.lane(a)).isEqualTo("trash");
            rig.store.actions().move(List.of(a), null, null, "spam");
            rig.store.actions().move(List.of(a), null, null, "restore");
            assertThat(rig.lane(a)).isEqualTo("other");
            // For good only from Trash or Spam.
            assertThat(rig.store.actions().delete(List.of(a), true)).isZero();
            rig.store.actions().delete(List.of(a), false);
            assertThat(rig.store.actions().delete(List.of(a), true)).isEqualTo(1);
            assertThat(rig.store.queries().message(a, 0)).isNull();
            Invariants.check(rig.store);
        }
    }

    @Test
    void readUnreadAndDoneKeepTheCountsTrue(@TempDir Path dir) throws Exception {
        try (StoreRig rig = new StoreRig(dir)) {
            rig.store.accept(Mail.from("Me <me@desk.example>").to("dana@example.com").id("w@x").inbound(StoreRig.DESK).asOutgoing());
            String a = rig.accept(Mail.from("Dana <dana@example.com>").id("a@x")).messageId();
            rig.accept(Mail.from("Dana <dana@example.com>").id("b@x"));
            assertThat(count(rig, "people", "unread")).isEqualTo(2);
            String channel = rig.channel(a);
            assertThat(rig.store.actions().setRead(null, channel, "people", true)).isEqualTo(2);
            assertThat(count(rig, "people", "unread")).isZero();
            rig.store.actions().setRead(List.of(a), null, null, false);
            assertThat(count(rig, "people", "unread")).isEqualTo(1);
            assertThat(rig.store.actions().done(channel, "people", true)).isTrue();
            assertThat(rows(rig, "people")).isEmpty();
            assertThat(count(rig, "people", "count")).isZero();
            rig.clock.advance(java.time.Duration.ofMinutes(1));
            rig.accept(Mail.from("Dana <dana@example.com>").id("c@x").at("2026-11-12T12:00:30Z"));
            assertThat(rows(rig, "people")).hasSize(1);
            Invariants.check(rig.store);
        }
    }

    @Test
    void aDisplayNameNeverPassesForAnAddress(@TempDir Path dir) throws Exception {
        try (StoreRig rig = new StoreRig(dir)) {
            String a = rig.accept(Mail.from("\"ceo@bank.example\" <fraud@evil.example>").id("a@x")).messageId();
            Map<?, ?> from = (Map<?, ?>) rig.facts(a).get("from");
            assertThat(from.get("name")).isNull();
            assertThat(((Map<?, ?>) from.get("endpoint")).get("value")).isEqualTo("fraud@evil.example");
        }
    }

    @Test
    void mergingContactsMakesOneThreadPerPerson(@TempDir Path dir) throws Exception {
        try (StoreRig rig = new StoreRig(dir)) {
            String mail = rig.accept(Mail.from("Dana <dana@example.com>").id("a@x")).messageId();
            com.minimalistalliance.desk.deskd.courier.parse.ParsedMessage text = com.minimalistalliance.desk.deskd.courier.parse.ParsedMessage.chat(
                    new com.minimalistalliance.desk.deskd.courier.parse.ParsedMessage.Address(null, "+15550102030"),
                    List.of(), "on my way", null, List.of());
            String sms = rig.store.accept(Courier.Inbound.chat(StoreRig.IMSG, "sms", "sms:1", text, 1_762_948_000_000L)).messageId();
            assertThat(rig.channel(sms)).isNotEqualTo(rig.channel(mail));
            String danaContact = (String) ((Map<?, ?>) rig.facts(mail).get("from")).get("contactId");
            String phoneContact = (String) ((Map<?, ?>) rig.facts(sms).get("from")).get("contactId");
            rig.store.actions().renameContact(danaContact, "Dana S.");
            assertThat(rig.store.actions().mergeContacts(danaContact, phoneContact)).isTrue();
            assertThat(rig.channel(sms)).isEqualTo(rig.channel(mail));
            Map<String, Object> thread = rig.store.queries().thread(rig.channel(mail), null, null, 50);
            assertThat((List<?>) thread.get("messages")).hasSize(2);
            assertThat(rig.store.queries().contactById(danaContact).get("name")).isEqualTo("Dana S.");
            assertThat((List<?>) rig.store.queries().contactById(danaContact).get("endpoints")).hasSize(2);
            Invariants.check(rig.store);
        }
    }

    /**
     * Security CS-M1: a From header with the member's address is anyone's to write. Without the transport's word or a DMARC
     * pass it's a stranger's mail: it joins no contact's thread by id, isn't People or read, lets no one in, and attaches no
     * bytes to the member's sent message. With a DMARC pass it's the member's own.
     */
    @Test
    void mailThatOnlyClaimsTheMembersAddressIsAStrangers(@TempDir Path dir) throws Exception {
        try (StoreRig rig = new StoreRig(dir)) {
            rig.store.outbox().register("email", null, item -> new com.minimalistalliance.desk.deskd.courier.store.Outbox.Sent(Map.of()));
            rig.store.accept(Mail.from("Me <me@desk.example>").to("dana@example.com").id("w@x").inbound(StoreRig.DESK).asOutgoing());
            String dana = rig.accept(Mail.from("Dana <dana@example.com>").id("d1@example.com").subject("Keys")).messageId();
            assertThat(rig.lane(dana)).isEqualTo("people");

            Mail forged = Mail.from("Me <me@desk.example>").cc("mallory@evil.example").id("f1@evil.example").subject("Re: Keys")
                    .replyTo("d1@example.com", "<d1@example.com>");
            String spoof = rig.accept(forged).messageId();
            Map<String, Object> f = rig.facts(spoof);
            assertThat(f.get("direction")).isEqualTo("in");
            assertThat(f.get("lane")).isEqualTo("requests");
            assertThat(f.get("read")).isEqualTo(false);
            assertThat(rig.thread(spoof)).isNotEqualTo(rig.thread(dana));
            assertThat(rig.channel(spoof)).isNotEqualTo(rig.channel(dana));
            // Nobody it copied is let in.
            String mallory = rig.accept(Mail.from("Mallory <mallory@evil.example>").id("m1@evil.example")).messageId();
            assertThat(rig.lane(mallory)).isEqualTo("requests");
            assertThat(rig.facts(mallory).get("senderKnown")).isEqualTo(false);

            // A spam verdict still counts for it.
            String spam = rig.store.accept(Mail.from("Me <me@desk.example>").id("f2@evil.example").inbound(StoreRig.DESK)
                    .withVerdicts(new Courier.Verdicts(true, false, null, null, null))).messageId();
            assertThat(rig.lane(spam)).isEqualTo("spam");

            // It can't hang its own bytes on the member's sent message by naming its Message-ID.
            Object[] draft = rig.store.actions().saveDraft(null, null, "email", StoreRig.GMAIL, List.of("dana@example.com"), "Plans", "See you", null, null);
            String sent = (String) rig.store.outbox().send((String) draft[0])[0];
            String msgid = (String) rig.store.queries().message(sent, 0).get("rfcMessageId");
            Courier.Accepted echo = rig.accept(Mail.from("Me <me@gmail.example>").to("dana@example.com").id(msgid).text("not what you sent"),
                    StoreRig.GMAIL);
            assertThat(echo.kind()).isEqualTo(Courier.Accepted.Kind.STORED);
            assertThat(echo.messageId()).isNotEqualTo(sent);
            assertThat(rig.store.raw(sent)).isNull();

            // With the transport's DMARC pass, the same From is the member's own: it threads with Dana and is People.
            String own = rig.store.accept(Mail.from("Me <me@desk.example>").to("dana@example.com").id("o1@desk.example").subject("Re: Keys")
                    .replyTo("d1@example.com", "<d1@example.com>").inbound(StoreRig.DESK)
                    .withVerdicts(new Courier.Verdicts(false, false, "pass", "pass", "pass", "desk.example", null))).messageId();
            assertThat(rig.facts(own).get("direction")).isEqualTo("out");
            assertThat(rig.lane(own)).isEqualTo("people");
            assertThat(rig.thread(own)).isEqualTo(rig.thread(dana));
            Invariants.check(rig.store);
        }
    }
}
