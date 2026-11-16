package com.minimalistalliance.desk.deskd.courier;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.deskd.courier.parse.CourierParser;
import com.minimalistalliance.desk.deskd.courier.parse.ParsedMessage;
import com.minimalistalliance.desk.deskd.courier.store.Courier;
import com.minimalistalliance.desk.deskd.courier.store.ExternalIds;
import com.minimalistalliance.desk.deskd.courier.store.Invariants;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * A DMARC result counts only for the domain it was checked for, the From's own (Security CP-L2's second half, the parse
 * read's open item), and a linked provider's result only from its own leading Authentication-Results fields.
 */
class DmarcAlignmentTest {

    private static ParsedMessage from(String address, ParsedMessage.AuthResult... ar) {
        return new ParsedMessage(new ParsedMessage.Address(null, address), List.of(), List.of(), List.of(), List.of(), "s", null, null,
                List.of(), List.of(), null, false, null, null, "t", false, null, List.of(), List.of(ar));
    }

    private static ParsedMessage.AuthResult ar(String id, String dmarc, String from) {
        return new ParsedMessage.AuthResult(id, "pass", "pass", dmarc, from);
    }

    @Test
    void aTransportsPassCountsOnlyForTheFromsDomain() {
        Courier.Verdicts aligned = Courier.Verdicts.resolve(new Courier.Verdicts(false, false, "pass", "pass", "pass", "Example.com.", null),
                from("dana@example.com"), "email");
        assertThat(aligned.dmarcPassed()).isTrue();
        Courier.Verdicts other = Courier.Verdicts.resolve(new Courier.Verdicts(false, false, "pass", "pass", "pass", "bank.example", null),
                from("dana@example.com"), "email");
        assertThat(other.dmarcPassed()).isFalse();
        assertThat(other.dmarc()).isEqualTo("unaligned");
        // No domain said: not confirmed.
        assertThat(Courier.Verdicts.resolve(new Courier.Verdicts(false, false, "pass", "pass", "pass"), from("dana@example.com"), "email")
                .dmarcPassed()).isFalse();
        // A subdomain isn't the domain (DMARC's own relaxed alignment is the verifier's to apply, by organizational domain).
        assertThat(Courier.Verdicts.resolve(new Courier.Verdicts(false, false, null, null, "pass", "example.com", null),
                from("dana@mail.example.com"), "email").dmarcPassed()).isFalse();
        // Internationalized: compared in punycode.
        assertThat(Courier.Verdicts.resolve(new Courier.Verdicts(false, false, null, null, "pass", "xn--bcher-kva.example", null),
                from("dana@bücher.example"), "email").dmarcPassed()).isTrue();
        // No From at all: nothing to be aligned with.
        assertThat(Courier.Verdicts.resolve(new Courier.Verdicts(false, false, null, null, "pass", "example.com", null), null, "email")
                .dmarcPassed()).isFalse();
    }

    @Test
    void aProvidersResultComesOnlyFromItsOwnLeadingFields() {
        Courier.Verdicts gmail = Courier.Verdicts.provider(false, "mx.google.com");
        assertThat(Courier.Verdicts.resolve(gmail, from("a@example.com", ar("mx.google.com", "pass", "example.com")), "email").dmarcPassed())
                .isTrue();
        // A field the sender wrote sits below the provider's: the provider's own result stands.
        assertThat(Courier.Verdicts.resolve(gmail, from("a@bank.example", ar("mx.google.com", "fail", "bank.example"),
                ar("mx.google.com", "pass", "bank.example")), "email").dmarcPassed()).isFalse();
        // The topmost field isn't the provider's (it added none): nothing below it is read.
        assertThat(Courier.Verdicts.resolve(gmail, from("a@bank.example", ar("relay.example", "none", null),
                ar("mx.google.com", "pass", "bank.example")), "email").dmarcPassed()).isFalse();
        // No authserv-id at all.
        assertThat(Courier.Verdicts.resolve(gmail, from("a@bank.example", ar(null, "pass", "bank.example")), "email").dmarcPassed()).isFalse();
        // A provider with no known authserv-id confirms nothing.
        assertThat(Courier.Verdicts.resolve(Courier.Verdicts.provider(false, null),
                from("a@example.com", ar("mx.google.com", "pass", "example.com")), "email").dmarcPassed()).isFalse();
        // The provider's pass, for another domain than the From's.
        assertThat(Courier.Verdicts.resolve(gmail, from("a@bank.example", ar("mx.google.com", "pass", "attacker.example")), "email")
                .dmarc()).isEqualTo("unaligned");
        // The provider's own field says nothing of DMARC, and a field the sender wrote with the provider's id sits below it
        // with a pass: never read, never merged (Security's CI-M2).
        assertThat(Courier.Verdicts.resolve(gmail, from("a@bank.example", new ParsedMessage.AuthResult("mx.google.com", "pass", null, null, null),
                ar("mx.google.com", "pass", "bank.example")), "email").dmarcPassed()).isFalse();
        Courier.Verdicts merged = Courier.Verdicts.resolve(gmail, from("a@bank.example",
                new ParsedMessage.AuthResult("mx.google.com", null, null, null, null), ar("mx.google.com", "pass", "bank.example")), "email");
        assertThat(merged.dkim()).isNull();
        assertThat(merged.spf()).isNull();
        assertThat(merged.dmarc()).isNull();
        // Only the topmost field counts, even where a provider writes one per method: a rule for such a provider comes with its id.
        Courier.Verdicts icloud = Courier.Verdicts.provider(false, "*.icloud.com");
        assertThat(Courier.Verdicts.resolve(icloud, from("a@example.com", new ParsedMessage.AuthResult("bimi.icloud.com", null, null, null, null),
                ar("dmarc.icloud.com", "pass", "example.com")), "email").dmarcPassed()).isFalse();
        assertThat(Courier.Verdicts.resolve(icloud, from("a@example.com", ar("dmarc.icloud.com", "pass", "example.com")), "email")
                .dmarcPassed()).isTrue();
    }

    @Test
    void authservPatterns() {
        assertThat(Courier.Verdicts.authServMatches("*.icloud.com", "dmarc.icloud.com")).isTrue();
        assertThat(Courier.Verdicts.authServMatches("*.icloud.com", "icloud.com")).isFalse();
        assertThat(Courier.Verdicts.authServMatches("*.icloud.com", "evilicloud.com")).isFalse();
        assertThat(Courier.Verdicts.authServMatches("*.icloud.com", "icloud.com.evil.example")).isFalse();
        assertThat(Courier.Verdicts.authServMatches("mx.google.com", "MX.Google.com.")).isTrue();
        assertThat(Courier.Verdicts.authServMatches("mx.google.com", "mx.google.com.evil.example")).isFalse();
    }

    private static byte[] raw(String from, String... arFields) {
        StringBuilder b = new StringBuilder();
        for (String a : arFields) {
            b.append("Authentication-Results: ").append(a).append("\r\n");
        }
        b.append("From: ").append(from).append("\r\nTo: dana@example.com\r\nSubject: Re: Plans\r\nMessage-ID: <").append(from.hashCode())
                .append(arFields.length).append("@x>\r\n\r\nhello\r\n");
        return b.toString().getBytes(StandardCharsets.UTF_8);
    }

    @Test
    void theMembersOwnAddressIsTheirsOnlyWithTheirDomainsPassFromTheProvidersField(@TempDir Path dir) throws Exception {
        try (StoreRig rig = new StoreRig(dir)) {
            Courier.Verdicts gmail = Courier.Verdicts.provider(false, "mx.google.com");
            // A pass the provider gave for another domain: a stranger who wrote the member's address.
            byte[] forged = raw("Me <me@gmail.example>", "mx.google.com; dmarc=pass header.from=attacker.example");
            Courier.Accepted a = rig.store.accept(Courier.Inbound.email(StoreRig.GMAIL, ExternalIds.email(StoreRig.GMAIL, null, forged), forged,
                    Courier.Origin.LIVE).withVerdicts(gmail));
            assertThat(rig.facts(a.messageId()).get("direction")).isEqualTo("in");
            assertThat(((Map<?, ?>) rig.facts(a.messageId()).get("auth")).get("senderConfirmed")).isEqualTo(false);
            // A forged field below the provider's own fail.
            byte[] below = raw("Me <me@gmail.example>", "mx.google.com; dmarc=fail header.from=gmail.example",
                    "mx.google.com; dmarc=pass header.from=gmail.example");
            Courier.Accepted b = rig.store.accept(Courier.Inbound.email(StoreRig.GMAIL, ExternalIds.email(StoreRig.GMAIL, null, below), below,
                    Courier.Origin.LIVE).withVerdicts(gmail));
            assertThat(rig.facts(b.messageId()).get("direction")).isEqualTo("in");
            // A forged pass below the provider's own field, which says nothing of DMARC (CI-M2): still a stranger.
            byte[] silent = raw("Me <me@gmail.example>", "mx.google.com; spf=pass smtp.mailfrom=gmail.example",
                    "mx.google.com; dmarc=pass header.from=gmail.example");
            Courier.Accepted s = rig.store.accept(Courier.Inbound.email(StoreRig.GMAIL, ExternalIds.email(StoreRig.GMAIL, null, silent), silent,
                    Courier.Origin.LIVE).withVerdicts(gmail));
            assertThat(rig.facts(s.messageId()).get("direction")).isEqualTo("in");
            // No DMARC result at all: "Couldn't confirm" (API.md §21), never confirmed.
            assertThat(((Map<?, ?>) rig.facts(s.messageId()).get("auth")).get("senderConfirmed")).isNotEqualTo(true);
            // The provider's own pass for the member's domain: their own mail.
            byte[] own = raw("Me <me@gmail.example>", "mx.google.com; dmarc=pass header.from=gmail.example");
            Courier.Accepted c = rig.store.accept(Courier.Inbound.email(StoreRig.GMAIL, ExternalIds.email(StoreRig.GMAIL, null, own), own,
                    Courier.Origin.LIVE).withVerdicts(gmail));
            assertThat(rig.facts(c.messageId()).get("direction")).isEqualTo("out");
        }
    }

    @Test
    void aMessageThatWaitedForTheParserIsResolvedWhenRead(@TempDir Path dir) throws Exception {
        AtomicBoolean up = new AtomicBoolean(false);
        CourierParser flaky = raw -> {
            if (!up.get()) {
                throw new CourierParser.Unavailable("down");
            }
            return TestMime.PARSER.parse(raw);
        };
        try (StoreRig rig = new StoreRig(dir, flaky)) {
            byte[] r = raw("Dana <dana@example.com>", "mx.google.com; dmarc=pass header.from=example.com");
            Courier.Accepted a = rig.store.accept(Courier.Inbound.email(StoreRig.GMAIL, ExternalIds.email(StoreRig.GMAIL, null, r), r,
                    Courier.Origin.LIVE).withVerdicts(Courier.Verdicts.provider(false, "mx.google.com")));
            assertThat(a.kind()).isEqualTo(Courier.Accepted.Kind.PENDING);
            up.set(true);
            assertThat(rig.store.reparsePending(10)).isEqualTo(1);
            String id = Invariants.read(rig.store, c -> {
                try (var st = c.createStatement(); var rs = st.executeQuery("SELECT id FROM messages WHERE lane <> 'pending'")) {
                    return rs.next() ? rs.getString(1) : null;
                }
            });
            assertThat(((Map<?, ?>) rig.facts(id).get("auth")).get("senderConfirmed")).isEqualTo(true);
        }
    }
}
