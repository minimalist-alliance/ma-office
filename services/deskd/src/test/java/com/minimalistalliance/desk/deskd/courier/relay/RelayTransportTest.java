package com.minimalistalliance.desk.deskd.courier.relay;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.courier.envelope.Envelope;
import com.minimalistalliance.desk.courier.envelope.SafetyNumber;
import com.minimalistalliance.desk.courier.envelope.Signed;
import com.minimalistalliance.desk.courier.testkit.FakeRelay;
import com.minimalistalliance.desk.courier.testkit.PeerDesk;
import com.minimalistalliance.desk.deskd.courier.store.Invariants;
import com.minimalistalliance.desk.deskd.courier.store.RelayState;
import com.minimalistalliance.desk.deskd.testing.MutableClock;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.security.SecureRandom;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The relay's transports in deskd (Wave 2.5) against the test kit's fake relay and mail door: collecting, sealing,
 * pinning, replay, forged senders, the door's mail and notes, sending through {@code courier-send}, the switches.
 */
@SuppressWarnings("unchecked")
class RelayTransportTest {

    @TempDir
    Path dir;

    FakeRelay relay;
    MutableClock clock;
    DeskRig desk;

    @BeforeEach
    void setUp() throws Exception {
        relay = FakeRelay.start();
        clock = new MutableClock(Instant.now());
        desk = new DeskRig(relay, dir.resolve("a"), "desk-a", "harbor", clock);
    }

    @AfterEach
    void tearDown() {
        desk.close();
        relay.close();
    }

    private Map<String, Object> counts() {
        return desk.transport.counts().toMap();
    }

    private long refused(String reason) {
        Object n = ((Map<String, Object>) counts().get("refused")).get(reason);
        return n == null ? 0 : ((Number) n).longValue();
    }

    // ---- collecting

    @Test
    void aMembersMessageArrivesOnceInRequestsAndPinsItsSender() throws Exception {
        PeerDesk dana = new PeerDesk(relay, "desk-d", "dana");
        dana.send(desk.address, "hello from dana", null);
        desk.drain();
        List<String[]> m = desk.messages();
        assertThat(m).hasSize(1);
        assertThat(m.get(0)[0]).isEqualTo("ma");
        assertThat(m.get(0)[1]).isEqualTo("in");
        assertThat(m.get(0)[2]).isEqualTo("requests");
        assertThat(m.get(0)[4]).isEqualTo("hello from dana");
        assertThat(relay.pending("desk-a")).isZero();
        RelayState.Pin pin = desk.store().relay().pin(dana.address());
        assertThat(pin.state()).isEqualTo(RelayState.UNVERIFIED);
        assertThat(pin.identityKey()).isEqualTo(dana.identityKey().text());
        // A second message is People once the member lets her in; lost acks and duplicated pages store nothing twice.
        relay.loseNextAcks(2);
        relay.duplicateNextFetches(2);
        dana.send(desk.address, "second", null);
        dana.send(desk.address, "third", null);
        desk.drain();
        desk.drain();
        desk.drain();
        assertThat(desk.messages()).hasSize(3);
        assertThat(relay.pending("desk-a")).isZero();
        Invariants.check(desk.store());
    }

    @Test
    void aSleepingDeskIsNeverWokenAndCatchesUpWhenItStarts() throws Exception {
        PeerDesk dana = new PeerDesk(relay, "desk-d", "dana");
        relay.setConnected("desk-a", false);
        java.util.concurrent.atomic.AtomicInteger pushes = new java.util.concurrent.atomic.AtomicInteger();
        relay.onNotify((deskId, reason) -> {
            if ("desk-a".equals(deskId)) {
                pushes.incrementAndGet();
            }
        });
        desk.close();
        for (int i = 0; i < 5; i++) {
            dana.send(desk.address, "while asleep " + i, null);
        }
        assertThat(pushes.get()).isZero();
        assertThat(relay.pending("desk-a")).isEqualTo(5);
        desk.restart();
        // The drain at start: no push, no poll, just the wake.
        await().atMost(Duration.ofSeconds(10)).until(() -> desk.messages().size() == 5);
        assertThat(relay.pending("desk-a")).isZero();
        String origin = Invariants.text(desk.store(), "SELECT group_concat(DISTINCT origin) FROM messages");
        assertThat(origin).isEqualTo("catchup");
    }

    @Test
    void thePushCollectsAtOnce() throws Exception {
        relay.onNotify((deskId, reason) -> {
            if ("desk-a".equals(deskId)) {
                desk.transport.notify(reason);
            }
        });
        PeerDesk dana = new PeerDesk(relay, "desk-d", "dana");
        dana.send(desk.address, "pushed", null);
        await().atMost(Duration.ofSeconds(10)).until(() -> desk.messages().size() == 1);
    }

    @Test
    void theDoorsMailArrivesWithItsVerdictsInlineAndThroughTheDrop() throws Exception {
        byte[] small = mail("pat@example.org", desk.address, "Lunch?", "See you at noon.");
        relay.deliverMail(desk.address, small, "pat@example.org",
                Map.of("spf", "PASS", "dkim", "PASS", "dmarc", "PASS", "dmarcDomain", "example.org"));
        byte[] big = mail("lee@example.net", desk.address, "Photos", "x".repeat(200_000));
        relay.deliverMail(desk.address, big, "lee@example.net", Map.of("spam", "FAIL"));
        assertThat(relay.dropCount()).isEqualTo(1);
        desk.drain();
        List<String[]> m = desk.messages();
        assertThat(m).hasSize(2);
        assertThat(m.get(0)[0]).isEqualTo("email");
        assertThat(m.get(0)[3]).isEqualTo("Lunch?");
        assertThat(m.get(0)[2]).isEqualTo("requests");
        // SES's spam verdict decides the lane.
        assertThat(m.get(1)[2]).isEqualTo("spam");
        String auth = Invariants.text(desk.store(), "SELECT auth FROM messages WHERE subject = 'Lunch?'");
        assertThat(auth).contains("\"dmarc\":\"pass\"").contains("example.org");
        assertThat(Invariants.text(desk.store(), "SELECT account_id FROM messages WHERE subject = 'Photos'")).isEqualTo("desk");
        assertThat(relay.pending("desk-a")).isZero();
        assertThat(relay.dropCount()).isZero();
        // The same message sealed again by the door (a retry there) is one message.
        relay.deliverMail(desk.address, small, "pat@example.org", Map.of());
        desk.drain();
        assertThat(desk.messages()).hasSize(2);
    }

    @Test
    void withoutTheDoorsKeyMailWaitsAndIsNeverTakenFromAnotherSigner() throws Exception {
        relay.setDoorKeysServed(false);
        desk.transport.notify("address");
        desk.drain();
        relay.deliverMail(desk.address, mail("pat@example.org", desk.address, "Wait", "body"), "pat@example.org", Map.of());
        Map<String, Object> r = desk.drain();
        assertThat(r.get("waiting")).isEqualTo(1);
        assertThat(desk.messages()).isEmpty();
        assertThat(relay.pending("desk-a")).isEqualTo(1);
        relay.setDoorKeysServed(true);
        desk.transport.notify("address");
        desk.drain();
        assertThat(desk.messages()).hasSize(1);
        assertThat(relay.pending("desk-a")).isZero();

        // A mail envelope signed by anyone but the door: refused after the desk read the door's keys again once.
        ManualPeer mallory = new ManualPeer(relay, "desk-m", "mallory");
        Map<String, Object> p = mallory.payload("mailer-daemon@" + FakeRelay.DOMAIN, desk.address, clock.millis(), "x");
        p.remove("text");
        p.put("kind", "mail");
        p.put("raw", ManualPeer.b64(mail("x@example.org", desk.address, "Forged", "f")));
        byte[] pt = Signed.wrap(mallory.identity, p);
        Envelope.Sealed sealed = Envelope.seal(Envelope.MAIL, desk.address, desk.keys().boxKey(), pt);
        mallory.inject(sealed);
        desk.drain();
        desk.drain();
        // Only the door writes mail envelopes, so a bad signature waits for the platform's lag, an hour (Security CT-L2).
        assertThat(refused("bad_signature")).isZero();
        assertThat(relay.pending("desk-a")).isEqualTo(1);
        clock.advance(Duration.ofMinutes(61));
        desk.drain();
        desk.drain();
        assertThat(desk.messages()).hasSize(1);
        assertThat(refused("bad_signature")).isEqualTo(1);
        assertThat(relay.pending("desk-a")).isZero();
    }

    @Test
    void forgedSendersWrongRecipientsAndMismatchedKindsAreRefusedAndAcked() throws Exception {
        PeerDesk dana = new PeerDesk(relay, "desk-d", "dana");
        ManualPeer mallory = new ManualPeer(relay, "desk-m", "mallory");
        // Before dana is pinned: signed by mallory, claiming dana.
        mallory.inject(ManualPeer.seal(mallory.identity, desk.keys(), mallory.payload(dana.address(), desk.address, clock.millis(), "I am dana")));
        desk.drain();
        assertThat(desk.messages()).isEmpty();
        assertThat(refused("forged")).isEqualTo(1);
        // After dana is pinned (her real message): the same forgery again.
        dana.send(desk.address, "real dana", null);
        desk.drain();
        mallory.inject(ManualPeer.seal(mallory.identity, desk.keys(), mallory.payload(dana.address(), desk.address, clock.millis(), "dana again")));
        desk.drain();
        assertThat(desk.messages()).extracting(x -> x[4]).containsExactly("real dana");
        assertThat(refused("forged")).isEqualTo(2);
        // Signed for someone else, sealed again to this desk.
        byte[] notYours = Signed.wrap(mallory.identity, mallory.payload(mallory.address, "someone@" + FakeRelay.DOMAIN, clock.millis(), "not yours"));
        mallory.inject(Envelope.seal(Envelope.MA, desk.address, desk.keys().boxKey(), notYours));
        // A "mail" payload in a member's envelope (Security CK-L1), and an address nobody has.
        Map<String, Object> fakeMail = mallory.payload("mailer-daemon@" + FakeRelay.DOMAIN, desk.address, clock.millis(), "x");
        fakeMail.put("kind", "mail");
        mallory.inject(ManualPeer.seal(mallory.identity, desk.keys(), fakeMail));
        mallory.inject(ManualPeer.seal(mallory.identity, desk.keys(), mallory.payload("ghost@" + FakeRelay.DOMAIN, desk.address, clock.millis(), "boo")));
        // Garbage.
        relay.inject(desk.address, "ma", new byte[32], new byte[256 + 16]);
        desk.drain();
        assertThat(desk.messages()).hasSize(1);
        assertThat(refused("not_for_me") + refused("format") + refused("unverifiable") + refused("cannot_open")).isEqualTo(4);
        assertThat(relay.pending("desk-a")).isZero();
    }

    @Test
    void aReplayAfterTheMemberDeletedItAndAnOldMessageAreRefused() throws Exception {
        ManualPeer dana = new ManualPeer(relay, "desk-d", "dana");
        Map<String, Object> p = dana.payload(dana.address, desk.address, clock.millis(), "once");
        Envelope.Sealed s = ManualPeer.seal(dana.identity, desk.keys(), p);
        dana.inject(s);
        desk.drain();
        assertThat(desk.messages()).hasSize(1);
        String id = desk.messages().get(0)[5];
        String messageId = Invariants.idOf(desk.store(), "ma", id);
        desk.store().actions().delete(List.of(messageId), false);
        desk.store().actions().delete(List.of(messageId), true);
        assertThat(desk.messages()).isEmpty();
        // The relay hands the same ciphertext back.
        dana.inject(s);
        desk.drain();
        assertThat(desk.messages()).isEmpty();
        // A message 32 days old: past the relay's wait, so only a replay could bring it.
        dana.inject(ManualPeer.seal(dana.identity, desk.keys(), dana.payload(dana.address, desk.address,
                clock.millis() - Duration.ofDays(32).toMillis(), "old")));
        desk.drain();
        assertThat(desk.messages()).isEmpty();
        assertThat(refused("stale")).isEqualTo(1);
        assertThat(relay.pending("desk-a")).isZero();
    }

    @Test
    void oneHostileEnvelopeNeverStopsTheDrainForTheOthers() throws Exception {
        ManualPeer mallory = new ManualPeer(relay, "desk-m", "mallory");
        PeerDesk dana = new PeerDesk(relay, "desk-d", "dana");
        // A drop whose signed length is -1 (Security CT-H1), ahead of a good message in the same page.
        Map<String, Object> reserved = mallory.api.reserveDrop(desk.address, 65536);
        Map<String, String> signed = new java.util.LinkedHashMap<>();
        ((Map<String, Object>) reserved.get("headers")).forEach((k, v) -> signed.put(k, (String) v));
        mallory.api.upload((String) reserved.get("url"), signed, new byte[65536]);
        Map<String, Object> p = mallory.payload(mallory.address, desk.address, clock.millis(), "x");
        p.remove("text");
        Map<String, Object> ref = new java.util.LinkedHashMap<>();
        ref.put("id", reserved.get("dropId"));
        ref.put("key", ManualPeer.b64(new byte[44]));
        ref.put("len", -1);
        ref.put("sha256", ManualPeer.b64(new byte[32]));
        ref.put("bytes", 65536);
        p.put("drop", ref);
        Map<String, Object> env = new java.util.LinkedHashMap<>(ManualPeer.seal(mallory.identity, desk.keys(), p).toJson());
        env.put("drops", List.of(reserved.get("dropId")));
        mallory.api.send(env, "mp-bad-drop-0000001");
        dana.send(desk.address, "still arrives", null);
        desk.drain();
        assertThat(desk.messages()).extracting(x -> x[4]).containsExactly("still arrives");
        assertThat(refused("format")).isEqualTo(1);
        assertThat(relay.pending("desk-a")).isZero();
    }

    @Test
    void aSenderOffTheCourierDomainIsRefusedWithoutALookupAndTheFutureIsRefused() throws Exception {
        ManualPeer mallory = new ManualPeer(relay, "desk-m", "mallory");
        for (int i = 0; i < 20; i++) {
            mallory.inject(ManualPeer.seal(mallory.identity, desk.keys(), mallory.payload("someone" + i + "@elsewhere.example", desk.address,
                    clock.millis(), "x")));
        }
        mallory.inject(ManualPeer.seal(mallory.identity, desk.keys(), mallory.payload(mallory.address, desk.address,
                clock.millis() + Duration.ofDays(3).toMillis(), "from tomorrow and then some")));
        desk.drain();
        assertThat(desk.messages()).isEmpty();
        assertThat(refused("foreign_from")).isEqualTo(20);
        assertThat(refused("future")).isEqualTo(1);
        // Not one directory lookup spent on them (Security CT-M1).
        assertThat(relay.seen()).noneMatch(x -> x.path().equals("/v1/agent/keys/lookup") && "desk-a".equals(x.desk()));
        assertThat(relay.pending("desk-a")).isZero();
    }

    @Test
    void heldMessagesPastTheCapWaitInTheRelay() throws Exception {
        ManualPeer dana = new ManualPeer(relay, "desk-d", "dana");
        dana.send(desk.keys(), dana.payload(dana.address, desk.address, clock.millis(), "before"));
        desk.drain();
        dana.resetIdentity();
        for (int i = 0; i < RelayState.HELD_PER_ADDRESS + 3; i++) {
            dana.inject(ManualPeer.seal(dana.identity, desk.keys(), dana.payload(dana.address, desk.address, clock.millis(), "held " + i)));
        }
        desk.drain();
        assertThat(desk.store().relay().heldCount(dana.address)).isEqualTo(RelayState.HELD_PER_ADDRESS);
        assertThat(relay.pending("desk-a")).isEqualTo(3);
        // Checked: the held ones go in, and the rest come at the next drain.
        verify(dana.address, SafetyNumber.between(desk.keys().identityKey(), dana.identity.publicKey()));
        desk.drain();
        assertThat(desk.messages()).hasSize(RelayState.HELD_PER_ADDRESS + 4);
        assertThat(relay.pending("desk-a")).isZero();
    }

    @Test
    void anInviteIsCheckedAgainstThePin() throws Exception {
        ManualPeer dana = new ManualPeer(relay, "desk-d", "dana");
        String oldLink = Invite.link(dana.address, dana.keys().fingerprint());
        dana.send(desk.keys(), dana.payload(dana.address, desk.address, clock.millis(), "hi"));
        desk.drain();
        // Her box key rotates; the desk seals to the new one, and keeps the old one's fingerprint as hers.
        dana.rotateBox();
        clock.advance(Duration.ofHours(7));
        send("ma", RelayTransport.MA_ACCOUNT, List.of(dana.address), "after the rotation");
        runQueue();
        assertThat(invite(oldLink)).containsEntry("outcome", "rotated");
        // A link for any other key, with her pinned: a mismatch, never a rotation (Security CT-M2).
        ManualPeer mallory = new ManualPeer(relay, "desk-m", "mallory");
        Throwable mismatch = org.assertj.core.api.Assertions.catchThrowable(() -> invite(Invite.link(dana.address, mallory.keys().fingerprint())));
        assertThat(rpc(mismatch).details()).containsEntry("reason", "invite_mismatch").containsEntry("pinned", true);
        // Verified by her number; then the directory serves another key and a link for it arrives: the change shows instead.
        verify(dana.address, SafetyNumber.between(desk.keys().identityKey(), dana.identity.publicKey()));
        relay.swapKeys(dana.address, mallory.keys());
        Throwable changed = org.assertj.core.api.Assertions.catchThrowable(() -> invite(Invite.link(dana.address, mallory.keys().fingerprint())));
        assertThat(rpc(changed).details()).containsEntry("reason", "key_changed");
        RelayState.Pin pin = desk.store().relay().pin(dana.address);
        assertThat(pin.state()).isEqualTo(RelayState.CHANGED);
        assertThat(pin.identityKey()).isEqualTo(dana.identity.publicKey().text());
        assertThat(pin.newIdentityKey()).isEqualTo(mallory.identity.publicKey().text());
    }

    // ---- pins

    @Test
    void aChangedKeyHoldsMessagesAndBlocksSendingUntilTheMemberChecksTheNewNumber() throws Exception {
        ManualPeer dana = new ManualPeer(relay, "desk-d", "dana");
        dana.send(desk.keys(), dana.payload(dana.address, desk.address, clock.millis(), "before"));
        desk.drain();
        desk.store().relay().contact(dana.address);
        dana.resetIdentity();
        dana.send(desk.keys(), dana.payload(dana.address, desk.address, clock.millis(), "after the change"));
        desk.drain();
        assertThat(desk.messages()).extracting(x -> x[4]).containsExactly("before");
        RelayState.Pin pin = desk.store().relay().pin(dana.address);
        assertThat(pin.state()).isEqualTo(RelayState.CHANGED);
        assertThat(desk.store().relay().heldCount(dana.address)).isEqualTo(1);
        assertThat(relay.pending("desk-a")).isZero();

        // Sending to her waits.
        String outbound = send("ma", RelayTransport.MA_ACCOUNT, List.of(dana.address), "reply");
        runQueue();
        assertThat(outboundRow(outbound)).containsEntry("state", "retry").containsEntry("error", "key_changed");
        assertThat(relay.pending("desk-d")).isZero();

        // The member checks the number on a call: the held message goes in, and the reply goes.
        String number = SafetyNumber.between(desk.keys().identityKey(), dana.identity.publicKey());
        Map<String, Object> v = verify(dana.address, number);
        assertThat(v).containsEntry("state", "verified").containsEntry("released", 1);
        assertThat(desk.messages()).extracting(x -> x[4]).contains("before", "after the change");
        clock.advance(Duration.ofMinutes(10));
        runQueue();
        assertThat(outboundRow(outbound)).containsEntry("state", "sent");
        assertThat(relay.pending("desk-d")).isEqualTo(1);
        // A wrong number changes nothing.
        assertThat(desk.store().relay().pin(dana.address).state()).isEqualTo(RelayState.VERIFIED);
    }

    @Test
    void aDirectoryThatSwapsKeysIsCaughtByThePin() throws Exception {
        PeerDesk dana = new PeerDesk(relay, "desk-d", "dana");
        dana.send(desk.address, "hi", null);
        desk.drain();
        // The platform hands out another desk's keys for dana's address.
        ManualPeer mallory = new ManualPeer(relay, "desk-m", "mallory");
        relay.swapKeys(dana.address(), mallory.keys());
        clock.advance(Duration.ofHours(7));
        String outbound = send("ma", RelayTransport.MA_ACCOUNT, List.of(dana.address()), "secret");
        runQueue();
        assertThat(outboundRow(outbound)).containsEntry("state", "retry").containsEntry("error", "key_changed");
        assertThat(relay.pending("desk-d")).isZero();
        assertThat(desk.store().relay().pin(dana.address()).state()).isEqualTo(RelayState.CHANGED);
    }

    // ---- sending

    @Test
    void aMessageToAMemberIsSealedSignedAndStoredOnceThere() throws Exception {
        PeerDesk dana = new PeerDesk(relay, "desk-d", "dana");
        relay.failNextSends(1);
        String outbound = send("ma", RelayTransport.MA_ACCOUNT, List.of(dana.address()), "hello dana");
        runQueue();
        assertThat(outboundRow(outbound)).containsEntry("state", "retry");
        clock.advance(Duration.ofMinutes(2));
        runQueue();
        assertThat(outboundRow(outbound)).containsEntry("state", "sent");
        List<PeerDesk.Received> got = dana.collect();
        assertThat(got).hasSize(1);
        assertThat(got.get(0).from()).isEqualTo(desk.address);
        assertThat(got.get(0).payload()).containsEntry("text", "hello dana").containsEntry("kind", "message");
        assertThat(relay.seen().stream().map(x -> new String(x.body() == null ? new byte[0] : x.body(), StandardCharsets.UTF_8)))
                .noneMatch(b -> b.contains("hello dana"));

        // A long one goes in the drop.
        String longText = "word ".repeat(30_000);
        send("ma", RelayTransport.MA_ACCOUNT, List.of(dana.address()), longText);
        runQueue();
        got = dana.collect();
        assertThat(got).hasSize(1);
        assertThat(new String(got.get(0).dropBody(), StandardCharsets.UTF_8)).isEqualTo(longText);
    }

    @Test
    void aGroupMessageGoesToEachAndAClosedAddressIsRefused() throws Exception {
        PeerDesk dana = new PeerDesk(relay, "desk-d", "dana");
        PeerDesk lee = new PeerDesk(relay, "desk-l", "lee");
        String outbound = send("ma", RelayTransport.MA_ACCOUNT, List.of(dana.address(), lee.address()), "to you both");
        runQueue();
        assertThat(outboundRow(outbound)).containsEntry("state", "sent");
        PeerDesk.Received d = dana.collect().get(0);
        assertThat((List<String>) d.payload().get("members")).containsExactlyInAnyOrder(dana.address(), lee.address());
        assertThat(lee.collect()).hasSize(1);
        relay.closeAddress("desk-l");
        String gone = send("ma", RelayTransport.MA_ACCOUNT, List.of(lee.address()), "anyone there?");
        runQueue();
        assertThat(outboundRow(gone)).containsEntry("state", "failed").containsEntry("error", "address_closed");
    }

    @Test
    void emailFromTheDesksAddressGoesThroughCourierSendAndToMembersSealed() throws Exception {
        PeerDesk dana = new PeerDesk(relay, "desk-d", "dana");
        desk.drain();
        relay.loseNextCourierSendAnswers(1);
        String outbound = send("email", RelayTransport.DESK_ACCOUNT, List.of("pat@example.org", dana.address()), "the plan", "Plan");
        runQueue();
        // The answer was lost: it may have gone, so the row waits, marked, and the next try carries the same key.
        assertThat(outboundRow(outbound)).containsEntry("state", "retry").containsEntry("error", "unreachable");
        clock.advance(Duration.ofMinutes(2));
        runQueue();
        assertThat(outboundRow(outbound)).containsEntry("state", "sent");
        assertThat(relay.mailSent()).hasSize(1);
        FakeRelay.MailSent sent = relay.mailSent().get(0);
        assertThat(sent.to()).containsExactly("pat@example.org");
        assertThat(sent.from()).isEqualTo(desk.address);
        String raw = new String(sent.raw(), StandardCharsets.UTF_8);
        assertThat(raw).contains("Subject: Plan").contains("From: " + desk.address).contains(dana.address());
        // The member's copy went sealed, never through courier-send, with the email's subject and Message-ID.
        PeerDesk.Received d = dana.collect().get(0);
        assertThat(d.payload()).containsEntry("subject", "Plan").containsEntry("rfcMessageId", sent.rfcMessageId());

        // A bounce comes back as a delivery note.
        relay.deliveryNote(desk.address, sent.rfcMessageId(), "pat@example.org", "bounced");
        desk.drain();
        String status = Invariants.text(desk.store(), """
                SELECT r.status FROM recipients r JOIN endpoints e ON e.id = r.endpoint_id WHERE e.value = 'pat@example.org'""");
        assertThat(status).isEqualTo("bounced");
        assertThat(counts().get("notes")).isEqualTo(1L);
        relay.removedNote(desk.address, "virus");
        desk.drain();
        assertThat(((Map<String, Object>) counts().get("removedByDoor")).get("virus")).isEqualTo(1L);
    }

    @Test
    void withNoProviderTheDesksAddressDoesntOfferSending() throws Exception {
        relay.setCourierSend(false);
        desk.transport.notify("address");
        desk.drain();
        assertThat(desk.store().outbox().canSend("email", RelayTransport.DESK_ACCOUNT)).isFalse();
        assertThat(desk.store().outbox().canSend("ma", RelayTransport.MA_ACCOUNT)).isTrue();
        relay.setCourierSend(true);
        desk.transport.notify("address");
        desk.drain();
        assertThat(desk.store().outbox().canSend("email", RelayTransport.DESK_ACCOUNT)).isTrue();
    }

    // ---- switches

    @Test
    void maOffLeavesMembersMessagesWaitingAndTheDoorStillCollects() throws Exception {
        PeerDesk dana = new PeerDesk(relay, "desk-d", "dana");
        desk.switchTo("ma-off");
        dana.send(desk.address, "later", null);
        relay.deliverMail(desk.address, mail("pat@example.org", desk.address, "Now", "b"), "pat@example.org", Map.of());
        desk.drain();
        assertThat(desk.messages()).extracting(x -> x[0]).containsExactly("email");
        assertThat(relay.pending("desk-a")).isEqualTo(1);
        String outbound = send("ma", RelayTransport.MA_ACCOUNT, List.of(dana.address()), "x");
        runQueue();
        assertThat(outboundRow(outbound)).containsEntry("state", "retry").containsEntry("error", "switched_off");
        desk.switchTo(null);
        desk.drain();
        assertThat(desk.messages()).filteredOn(x -> "in".equals(x[1])).hasSize(2);
        assertThat(relay.pending("desk-a")).isZero();
    }

    // ---- load

    @Test
    void tenThousandSealedMessagesDrainInUnderTwoMinutes() throws Exception {
        relay.caps().maxPendingEnvelopes = 20_000;
        ManualPeer dana = new ManualPeer(relay, "desk-d", "dana");
        for (int i = 0; i < 10_000; i++) {
            dana.inject(ManualPeer.seal(dana.identity, desk.keys(), dana.payload(dana.address, desk.address, clock.millis(), "load " + i)));
        }
        long t0 = System.nanoTime();
        desk.drain();
        long ms = (System.nanoTime() - t0) / 1_000_000;
        System.out.println("COURIER-LOAD drained 10000 sealed messages in " + ms + " ms");
        assertThat(Invariants.messages(desk.store())).isEqualTo(10_000);
        assertThat(relay.pending("desk-a")).isZero();
        assertThat(ms).isLessThan(120_000);
    }

    // ---- helpers

    private String send(String medium, String account, List<String> to, String text) throws Exception {
        return send(medium, account, to, text, null);
    }

    private String send(String medium, String account, List<String> to, String text, String subject) throws Exception {
        Object[] draft = desk.store().actions().saveDraft(null, null, medium, account, to, subject, text, null, null);
        Object[] sent = desk.store().outbox().send((String) draft[0]);
        clock.advance(Duration.ofSeconds(11));
        return (String) sent[1];
    }

    private void runQueue() throws Exception {
        desk.store().outbox().runDue();
        // The queue's own runner may have taken a row at the same moment: wait for it to finish.
        await().atMost(Duration.ofSeconds(10)).until(() -> desk.store().queries().outbound().stream().noneMatch(r -> "sending".equals(r.get("state"))));
    }

    private Map<String, Object> outboundRow(String outboundId) throws Exception {
        for (Map<String, Object> row : desk.store().queries().outbound()) {
            if (outboundId.equals(row.get("outboundId"))) {
                return row;
            }
        }
        return Map.of();
    }

    private Map<String, Object> verify(String address, String number) throws Exception {
        return method("contactVerify", Map.of("address", address, "safetyNumber", number));
    }

    private Map<String, Object> invite(String link) throws Exception {
        return method("inviteOpen", Map.of("link", link));
    }

    private Map<String, Object> method(String name, Map<String, Object> params) throws Exception {
        java.lang.reflect.Method m = RelayTransport.class.getDeclaredMethod(name, com.minimalistalliance.desk.deskd.rpc.RpcContext.class, Map.class);
        m.setAccessible(true);
        try {
            return (Map<String, Object>) m.invoke(desk.transport, null, params);
        } catch (java.lang.reflect.InvocationTargetException e) {
            throw (Exception) e.getCause();
        }
    }

    private static com.minimalistalliance.desk.deskd.rpc.RpcException rpc(Throwable t) {
        assertThat(t).isInstanceOf(com.minimalistalliance.desk.deskd.rpc.RpcException.class);
        return (com.minimalistalliance.desk.deskd.rpc.RpcException) t;
    }

    static byte[] mail(String from, String to, String subject, String body) {
        return ("From: " + from + "\r\nTo: " + to + "\r\nSubject: " + subject + "\r\nMessage-ID: <" + Math.abs(new SecureRandom().nextLong())
                + "@example.invalid>\r\nDate: Sat, 14 Nov 2026 10:00:00 +0000\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n" + body + "\r\n")
                .getBytes(StandardCharsets.UTF_8);
    }

}
