package com.minimalistalliance.desk.deskd.courier;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.deskd.courier.store.Actions;
import com.minimalistalliance.desk.deskd.courier.store.Courier;
import com.minimalistalliance.desk.deskd.courier.store.CourierStore;
import com.minimalistalliance.desk.deskd.courier.store.Invariants;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Spam and safety (Wave 3.2) beyond the filter: the linked-mailbox rules, the sender warnings, Report spam, and blocks
 * that Unblock ends exactly (Security CS-I2).
 */
class SafetyTest {

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> warnings(StoreRig rig, String id) throws Exception {
        return (List<Map<String, Object>>) rig.facts(id).get("warnings");
    }

    private static Courier.Inbound junk(Mail m) {
        return m.inbound(StoreRig.GMAIL).withVerdicts(Courier.Verdicts.provider(true, null));
    }

    // ---- linked mailboxes

    @Test
    void aLinkedMailboxsJunkIsSpamEvenFromSomeoneKnown(@TempDir Path dir) throws Exception {
        try (StoreRig rig = new StoreRig(dir)) {
            rig.store.accept(Mail.from("Me <me@gmail.example>").to("dana@example.com").id("w@x").inbound(StoreRig.GMAIL).asOutgoing());
            String known = rig.store.accept(junk(Mail.from("Dana <dana@example.com>").to("me@gmail.example").id("j1@x"))).messageId();
            String stranger = rig.store.accept(junk(Mail.from("Promo <p@promo.example>").to("me@gmail.example").id("j2@x"))).messageId();
            assertThat(rig.lane(known)).isEqualTo("spam");
            assertThat(rig.lane(stranger)).isEqualTo("spam");
            // It's the provider's verdict, not the desk filter's.
            assertThat(rig.facts(stranger).get("screen")).isNull();
        }
    }

    @Test
    void aLinkedMailboxsSentCorrespondentsAreKnownAndOtherStrangersAreOtherNotRequests(@TempDir Path dir) throws Exception {
        try (StoreRig rig = new StoreRig(dir)) {
            // A first sync: Sent first (the member wrote to these people), then the inbox.
            rig.store.accept(Mail.from("Me <me@gmail.example>").to("sam@family.example", "office@work.example").id("s1@x")
                    .inbound(StoreRig.GMAIL).asOutgoing());
            String fromSam = rig.accept(Mail.from("Sam <sam@family.example>").to("me@gmail.example").id("i1@x"), StoreRig.GMAIL).messageId();
            String fromAirline = rig.accept(Mail.from("Airline <noreply@air.example>").to("me@gmail.example").id("i2@x"), StoreRig.GMAIL)
                    .messageId();
            assertThat(rig.lane(fromSam)).isEqualTo("people");
            assertThat(rig.lane(fromAirline)).isEqualTo("other");
            // Older Sent mail synced later lets in someone whose mail was already in Other.
            String fromBob = rig.accept(Mail.from("Bob <bob@old.example>").to("me@gmail.example").id("i3@x"), StoreRig.GMAIL).messageId();
            assertThat(rig.lane(fromBob)).isEqualTo("other");
            rig.store.accept(Mail.from("Me <me@gmail.example>").to("bob@old.example").id("s0@x").at("2019-01-01T10:00:00Z")
                    .inbound(StoreRig.GMAIL).asOutgoing());
            assertThat(rig.lane(fromBob)).isEqualTo("people");
            // Nothing from a linked mailbox is ever a Request.
            assertThat(rig.store.queries().counts().get("lanes")).satisfies(l ->
                    assertThat(((Map<?, ?>) ((Map<?, ?>) l).get("requests")).get("count")).isEqualTo(0L));
            Invariants.check(rig.store);
        }
    }

    // ---- sender warnings

    @Test
    void aKnownContactsNameOnAnotherAddressIsNotTheirUsualAddress(@TempDir Path dir) throws Exception {
        try (StoreRig rig = new StoreRig(dir)) {
            String first = rig.accept(Mail.from("Dana Smith <dana@example.com>").id("d1@x")).messageId();
            rig.store.actions().decide(rig.channel(first), "let_in");
            String impostor = rig.accept(Mail.from("dana SMITH <dana.smith.payments@freemail.example>").id("d2@x")).messageId();
            assertThat(rig.lane(impostor)).isEqualTo("requests");
            assertThat(warnings(rig, impostor)).singleElement().satisfies(w -> {
                assertThat(w).containsEntry("kind", "not_usual_address").containsEntry("name", "Dana Smith");
                assertThat(w.get("contactId")).isEqualTo(((Map<?, ?>) rig.facts(first).get("from")).get("contactId"));
            });
            // Her own mail has none; a stranger's mail with no name match has none.
            assertThat(warnings(rig, rig.accept(Mail.from("Dana Smith <dana@example.com>").id("d3@x")).messageId())).isEmpty();
            assertThat(warnings(rig, rig.accept(Mail.from("Pat Jones <pat@elsewhere.example>").id("p1@x")).messageId())).isEmpty();
            // A mailbox's role isn't a name: a known "Support" doesn't make every other "Support" a warning.
            String support = rig.accept(Mail.from("Support <help@vendor.example>").id("s1@x")).messageId();
            rig.store.actions().decide(rig.channel(support), "let_in");
            assertThat(warnings(rig, rig.accept(Mail.from("Support <help@other.example>").id("s2@x")).messageId())).isEmpty();
        }
    }

    @Test
    void lookalikeDomainsAreNamedForWhatTheyImitate(@TempDir Path dir) throws Exception {
        try (StoreRig rig = new StoreRig(dir)) {
            String colleague = rig.accept(Mail.from("Lee <lee@acme-corp.example>").id("c1@x")).messageId();
            rig.store.actions().decide(rig.channel(colleague), "let_in");
            Object[][] cases = {
                {"Lee <lee@acrne-corp.example>", "acme-corp.example"},
                {"PayPal <service@paypa1.com>", "paypal.com"},
                {"Microsoft <account@rnicrosoft.com>", "microsoft.com"},
                {"Billing <billing@paypal.com.account-check.example>", "paypal.com"},
                {"Amazon <orders@amazom.com>", "amazon.com"},
                {"MA <hello@minimalist-alliance.com>", "minimalistalliance.com"},
                {"Desk <me@desk-example.example>", null},
            };
            int n = 0;
            for (Object[] c : cases) {
                String id = rig.accept(Mail.from((String) c[0]).id("l" + n++ + "@x")).messageId();
                List<Map<String, Object>> w = warnings(rig, id);
                if (c[1] == null) {
                    assertThat(w).as((String) c[0]).noneMatch(x -> "lookalike".equals(x.get("kind")));
                } else {
                    assertThat(w).as((String) c[0]).anySatisfy(x -> assertThat(x).containsEntry("kind", "lookalike").containsEntry("like", c[1]));
                }
            }
            // The real ones, and their subdomains, have none.
            assertThat(warnings(rig, rig.accept(Mail.from("PayPal <service@mail.paypal.com>").id("r1@x")).messageId())).isEmpty();
            assertThat(warnings(rig, rig.accept(Mail.from("Lee2 <lee2@acme-corp.example>").id("r2@x")).messageId())).isEmpty();
        }
    }

    @Test
    void aDeceptiveInternationalDomainIsShownInAsciiAndANameHoldingAnAddressIsSaid(@TempDir Path dir) throws Exception {
        try (StoreRig rig = new StoreRig(dir)) {
            String idn = rig.accept(Mail.from("Apple <id@\u0430pple.com>").id("i1@x")).messageId();
            assertThat(warnings(rig, idn)).anySatisfy(w -> assertThat(w).containsEntry("kind", "punycode")
                    .satisfies(x -> assertThat((String) x.get("domain")).startsWith("xn--")));
            assertThat(warnings(rig, idn)).anySatisfy(w -> assertThat(w).containsEntry("kind", "lookalike").containsEntry("like", "apple.com"));
            String named = rig.accept(Mail.from("\"service@paypal.com\" <evil@bad.example>").id("n1@x")).messageId();
            assertThat(warnings(rig, named)).anySatisfy(w -> assertThat(w).containsEntry("kind", "name_held_address"));
            // A list row says there's something to see, without saying what.
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> rows = (List<Map<String, Object>>) rig.store.queries().list("requests", null, null, 50, false).get("rows");
            assertThat(rows).anySatisfy(r -> assertThat(((Map<?, ?>) r.get("last")).get("warned")).isEqualTo(true));
        }
    }

    // ---- report

    @Test
    void reportSpamOwesTheDoorTheSenderForMailToThisDesksAddressAndMovesALinkedOneToJunk(@TempDir Path dir) throws Exception {
        try (StoreRig rig = new StoreRig(dir)) {
            // The door's DMARC confirmed this sender; only a confirmed sender is ever reported (Security CR3-L1).
            String desk = rig.store.accept(Mail.from("Spammer <s@spam.example>").id("r1@x").inbound(StoreRig.DESK)
                    .withVerdicts(new Courier.Verdicts(false, false, "pass", "pass", "pass", "spam.example", null))).messageId();
            String forged = rig.accept(Mail.from("Somebody <victim@innocent.example>").id("r3@x")).messageId();
            String linked = rig.accept(Mail.from("Spammer <s2@spam.example>").to("me@gmail.example").id("r2@x"), StoreRig.GMAIL).messageId();
            assertThat(rig.store.actions().report(List.of(desk, linked, forged), false)).isEqualTo(3);
            assertThat(rig.lane(desk)).isEqualTo("spam");
            assertThat(rig.lane(linked)).isEqualTo("spam");
            assertThat(rig.lane(forged)).isEqualTo("spam");
            List<CourierStore.Report> owed = rig.store.owedReports(10);
            assertThat(owed).singleElement().satisfies(r -> {
                assertThat(r.address()).isEqualTo("s@spam.example");
                assertThat(r.accountId()).isEqualTo(StoreRig.DESK);
            });
            // Reported twice is one report; the door marks it sent.
            rig.store.actions().report(List.of(desk), false);
            assertThat(rig.store.owedReports(10)).hasSize(1);
            rig.store.reportDelivered(owed.get(0).id());
            assertThat(rig.store.owedReports(10)).isEmpty();
            // The linked one owes its provider a move to Junk.
            assertThat(rig.store.linked().ops(StoreRig.GMAIL, 10)).anySatisfy(op -> assertThat(op.op()).isEqualTo("spam"));
            // The filter learned from both.
            @SuppressWarnings("unchecked")
            Map<String, Object> filter = (Map<String, Object>) rig.store.queries().counts().get("filter");
            assertThat(filter).containsEntry("spam", 3L);
            assertThatThrownBy(() -> rig.store.actions().report(List.of(), false)).isInstanceOf(Actions.Refused.class);
        }
    }

    @Test
    void reportWithBlockBlocksEachSenderAndTheMembersOwnMailIsNeverReported(@TempDir Path dir) throws Exception {
        try (StoreRig rig = new StoreRig(dir)) {
            Courier.Verdicts confirmed = new Courier.Verdicts(false, false, "pass", "pass", "pass", "pests.example", null);
            String a = rig.store.accept(Mail.from("Pest <pest@pests.example>").id("a@x").inbound(StoreRig.DESK).withVerdicts(confirmed)).messageId();
            String older = rig.accept(Mail.from("Pest <pest@pests.example>").id("b@x")).messageId();
            rig.store.actions().decide(rig.channel(a), "let_in");
            String mine = rig.store.accept(Mail.from("Me <me@desk.example>").to("pest@pests.example").id("m@x").inbound(StoreRig.DESK)
                    .asOutgoing()).messageId();
            assertThat(rig.store.actions().report(List.of(a, mine), true)).isEqualTo(1);
            assertThat(rig.lane(a)).isEqualTo("spam");
            assertThat(rig.lane(older)).isEqualTo("spam");
            assertThat(rig.lane(mine)).isEqualTo("people");
            assertThat(rig.store.actions().blocks()).anySatisfy(b -> assertThat(b).containsExactly("address", "pest@pests.example"));
            assertThat(rig.lane(rig.accept(Mail.from("Pest <pest@pests.example>").id("c@x")).messageId())).isEqualTo("spam");
            // Mail that only claims a known contact's address (DMARC didn't confirm it) is reported, but its "sender" isn't
            // blocked: that would block the real person (Security CR3-I2).
            String friend = rig.accept(Mail.from("Dana <dana@example.com>").id("f1@x")).messageId();
            rig.store.actions().decide(rig.channel(friend), "let_in");
            String claimed = rig.accept(Mail.from("Dana <dana@example.com>").id("f2@x").text("Wire me money")).messageId();
            assertThat(rig.store.actions().report(List.of(claimed), true)).isEqualTo(1);
            assertThat(rig.lane(claimed)).isEqualTo("spam");
            assertThat(rig.store.actions().blocks()).noneSatisfy(b -> assertThat(b).containsExactly("address", "dana@example.com"));
            assertThat(rig.lane(rig.accept(Mail.from("Dana <dana@example.com>").id("f3@x")).messageId())).isEqualTo("people");
        }
    }

    // ---- blocks (Security CS-I2)

    @Test
    void aRequestsBlockIsListedAndUnblockEndsExactlyWhatItCovered(@TempDir Path dir) throws Exception {
        try (StoreRig rig = new StoreRig(dir)) {
            String a = rig.accept(Mail.from("Pest <pest@bad.example>").id("a@x")).messageId();
            rig.store.actions().decide(rig.channel(a), "block");
            assertThat(rig.store.actions().blocks()).anySatisfy(b -> assertThat(b).containsExactly("address", "pest@bad.example"));
            // A domain block over it, then the domain unblocked: the address's own block still holds.
            rig.store.actions().block("domain", "bad.example");
            assertThat(rig.store.actions().unblock("domain", "bad.example")).isTrue();
            assertThat(rig.lane(rig.accept(Mail.from("Pest <pest@bad.example>").id("b@x")).messageId())).isEqualTo("spam");
            // Unblocking what has no row changes nothing and says so.
            assertThat(rig.store.actions().unblock("domain", "bad.example")).isFalse();
            assertThat(rig.store.actions().unblock("address", "nobody@nowhere.example")).isFalse();
            assertThat(rig.lane(rig.accept(Mail.from("Pest <pest@bad.example>").id("c@x")).messageId())).isEqualTo("spam");
            // Unblocking the address itself: a stranger again.
            assertThat(rig.store.actions().unblock("address", "pest@bad.example")).isTrue();
            assertThat(rig.lane(rig.accept(Mail.from("Pest <pest@bad.example>").id("d@x")).messageId())).isEqualTo("requests");
        }
    }
}
