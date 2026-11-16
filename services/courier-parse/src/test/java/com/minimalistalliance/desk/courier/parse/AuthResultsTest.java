package com.minimalistalliance.desk.courier.parse;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * The sandbox's reading of {@code Authentication-Results} (RFC 8601) in the forms providers write: deskd decides which to
 * believe (by the provider's authserv-id), this only has to read them right, comments, quoting and all.
 */
class AuthResultsTest {

    @Test
    void gmailsField() {
        Map<String, Object> m = AuthResults.one("mx.google.com; dkim=pass header.i=@example.com header.s=s1 header.b=abc;"
                + " spf=pass (google.com: domain of a@example.com designates 192.0.2.1 as permitted sender) smtp.mailfrom=a@example.com;"
                + " dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=example.com");
        assertThat(m).containsEntry("authServ", "mx.google.com").containsEntry("spf", "pass").containsEntry("dkim", "pass")
                .containsEntry("dmarc", "pass").containsEntry("dmarcFrom", "example.com");
    }

    @Test
    void aFieldWithNoAuthservIdHasNone() {
        // One provider writes its field so: it can't be told from one a sender wrote.
        Map<String, Object> m = AuthResults.one("spf=pass (sender IP is 192.0.2.1) smtp.mailfrom=example.com; dkim=pass (signature was verified)"
                + " header.d=example.com;dmarc=pass action=none header.from=example.com;compauth=pass reason=100");
        assertThat(m.get("authServ")).isNull();
        assertThat(m).containsEntry("dmarc", "pass").containsEntry("dmarcFrom", "example.com");
    }

    @Test
    void commentsQuotesVersionsAndAddresses() {
        assertThat(AuthResults.one("atlas112.mail.ne1.yahoo.com; dkim=pass header.i=@example.com; dmarc=pass(p=REJECT) header.from=example.com;"))
                .containsEntry("dmarc", "pass").containsEntry("dmarcFrom", "example.com");
        assertThat(AuthResults.one("mx3.messagingengine.com 1; dmarc=pass policy.published-domain-policy=reject header.from=\"Example.COM\""))
                .containsEntry("authServ", "mx3.messagingengine.com").containsEntry("dmarcFrom", "example.com");
        assertThat(AuthResults.one("mx.example.org; dmarc=fail (p=reject; sp=x=y) header.from=a@bad.example"))
                .containsEntry("dmarc", "fail").containsEntry("dmarcFrom", "bad.example");
        assertThat(AuthResults.one("\"quoted.example\"; dmarc=none")).containsEntry("authServ", "quoted.example").containsEntry("dmarc", "none");
        assertThat(AuthResults.one("example.org; none")).containsEntry("authServ", "example.org").doesNotContainKey("dmarc");
        // The first result of a method counts: a later one in the same field doesn't change it.
        assertThat(AuthResults.one("mx.example.org; dmarc=fail header.from=x.example; dmarc=pass header.from=x.example"))
                .containsEntry("dmarc", "fail");
    }

    @Test
    void fieldsKeepTheirOrderAndAreCapped() {
        List<Map<String, Object>> list = AuthResults.read(java.util.Collections.nCopies(20, "a.example; dmarc=pass header.from=b.example"));
        assertThat(list).hasSize(AuthResults.MAX);
    }

    @Test
    void theWholeParseListsThemTopmostFirst() throws Exception {
        byte[] raw = ("Authentication-Results: mx.google.com;\r\n dmarc=pass header.from=example.com\r\n"
                + "Authentication-Results: forged.example; dmarc=pass header.from=bank.example\r\n"
                + "From: a@example.com\r\nSubject: x\r\n\r\nbody\r\n").getBytes(java.nio.charset.StandardCharsets.US_ASCII);
        Map<String, Object> m = Mime.message(new java.io.ByteArrayInputStream(raw), new Mime.Deadline(5_000));
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> ar = (List<Map<String, Object>>) m.get("authResults");
        assertThat(ar).hasSize(2);
        assertThat(ar.get(0)).containsEntry("authServ", "mx.google.com").containsEntry("dmarcFrom", "example.com");
        assertThat(ar.get(1)).containsEntry("authServ", "forged.example");
    }
}
