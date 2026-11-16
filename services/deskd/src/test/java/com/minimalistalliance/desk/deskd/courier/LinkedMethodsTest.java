package com.minimalistalliance.desk.deskd.courier;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.courier.testkit.FakeImapServer;
import com.minimalistalliance.desk.courier.testkit.FakeSmtpServer;
import com.minimalistalliance.desk.courier.testkit.FakeTls;
import com.minimalistalliance.desk.deskd.courier.linked.LinkedMailboxes;
import com.minimalistalliance.desk.deskd.courier.linked.Net;
import com.minimalistalliance.desk.deskd.rpc.RpcPrincipal;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * {@code courier.accounts.*} for linked mailboxes through deskd's real RPC layer, with the transport attached and the
 * kit's fake provider: the providers the setup screen offers, add (checked with the provider, write-only), list (with the
 * sync's state), sign in again, remove; and the secret in no answer.
 */
class LinkedMethodsTest {

    private static final String PASS = "the-app-password-0";

    @Test
    void addListSignInAgainAndRemove(@TempDir Path dir) throws Exception {
        try (CourierRig rig = new CourierRig(dir);
                FakeImapServer imap = FakeImapServer.start(FakeImapServer.Options.defaults().tls(true));
                FakeSmtpServer smtp = FakeSmtpServer.start(FakeSmtpServer.Options.implicitTls())) {
            imap.addUser("dana@example.com", PASS);
            smtp.addUser("dana@example.com", PASS);
            imap.deliver("dana@example.com", "INBOX", "From: a@b.example\r\nSubject: hi\r\nMessage-ID: <1@b.example>\r\n\r\nhello\r\n"
                    .getBytes(), Set.of(), Instant.now());
            new LinkedMailboxes(rig.module, Net.forTests(FakeTls.clientContext()), Clock.systemUTC(), LinkedMailboxes.Settings.DEFAULT).start();
            TestClient c = rig.owner("s1");
            Map<String, Object> server = Map.of("imapHost", "127.0.0.1", "imapPort", imap.port(), "smtpHost", "127.0.0.1", "smtpPort",
                    smtp.port(), "security", "tls");

            Map<String, Object> providers = rig.ok(c, "courier.accounts.providers");
            assertThat(providers.toString()).contains("provider=gmail").contains("provider=icloud").contains("provider=other");
            // Outlook takes Microsoft sign-in only (Wave 2.2): refused, nothing kept.
            Map<String, Object> outlook = rig.err(c, "unavailable", "courier.accounts.add", "kind", "imap", "provider", "outlook",
                    "address", "dana@outlook.example", "auth", "app_password", "secret", PASS);
            assertThat(outlook.toString()).contains("reason=oauth");
            // The office sends no provider and no servers for its named tiles: the address says which, Outlook's too.
            assertThat(rig.err(c, "unavailable", "courier.accounts.add", "kind", "imap", "address", "dana@hotmail.com", "auth",
                    "app_password", "secret", PASS).toString()).contains("reason=oauth");
            // A wrong password: the provider says no, and nothing is kept.
            Map<String, Object> wrong = rig.err(c, "forbidden", "courier.accounts.add", "kind", "imap", "address", "dana@example.com",
                    "auth", "app_password", "secret", "not-it", "server", server);
            assertThat(wrong.toString()).contains("reason=sign_in").contains("cause=auth").doesNotContain("provider=");
            assertThat(rig.store().accounts()).noneMatch(a -> a.kind().equals("imap"));

            Map<String, Object> added = rig.ok(c, "courier.accounts.add", "kind", "imap", "address", "dana@example.com", "label", "Work",
                    "auth", "app_password", "secret", PASS, "server", server);
            String accountId = (String) added.get("accountId");
            await().atMost(Duration.ofSeconds(60)).until(() -> rig.ok(c, "courier.accounts.list").toString().contains("state=live"));
            Map<String, Object> list = rig.ok(c, "courier.accounts.list");
            assertThat(list.toString()).contains("signedIn=true").contains("label=Work").contains("done=true").contains("messages=1")
                    .contains("provider=other").doesNotContain(PASS);
            assertThat(rig.store().queries().list("other", null, null, 50, false).toString()).contains("hi");

            // The provider stops taking it: "needs_you"; signing in again resumes.
            imap.failLogin("NO [AUTHENTICATIONFAILED] Invalid credentials");
            imap.dropConnections();
            await().atMost(Duration.ofSeconds(30)).until(() -> rig.ok(c, "courier.accounts.list").toString().contains("state=needs_you"));
            assertThat(rig.ok(c, "courier.accounts.list").toString()).contains("signedIn=false");
            imap.clearFaults();
            Map<String, Object> again = rig.ok(c, "courier.accounts.signin", "accountId", accountId, "secret", PASS);
            assertThat(again.toString()).doesNotContain(PASS);
            await().atMost(Duration.ofSeconds(30)).until(() -> rig.ok(c, "courier.accounts.list").toString().contains("state=live"));
            assertThat(rig.ok(c, "courier.accounts.list").toString()).contains("signedIn=true");

            // The office's "Sign in again" is its add form again: the same mailbox, needing a sign-in, takes it under its own id;
            // while it's fine, adding it again is a conflict, never a second copy of its mail.
            rig.err(c, "conflict", "courier.accounts.add", "kind", "imap", "address", "Dana@Example.com", "auth", "app_password",
                    "secret", PASS, "server", server);
            imap.failLogin("NO [AUTHENTICATIONFAILED] Invalid credentials");
            imap.dropConnections();
            await().atMost(Duration.ofSeconds(30)).until(() -> rig.ok(c, "courier.accounts.list").toString().contains("signedIn=false"));
            imap.clearFaults();
            Map<String, Object> readded = rig.ok(c, "courier.accounts.add", "kind", "imap", "address", "dana@example.com", "auth",
                    "app_password", "secret", PASS, "server", server);
            assertThat(readded.get("accountId")).isEqualTo(accountId);
            await().atMost(Duration.ofSeconds(30)).until(() -> rig.ok(c, "courier.accounts.list").toString().contains("state=live"));
            assertThat(rig.store().accounts().stream().filter(a -> a.kind().equals("imap")).count()).isEqualTo(1);

            // Removed: its sync stops and its connection closes.
            rig.ok(c, "courier.accounts.remove", "accountId", accountId, "keepMail", false);
            await().atMost(Duration.ofSeconds(10)).until(() -> imap.connectionsOpen() == 0);
            assertThat(rig.store().accounts()).noneMatch(a -> a.id().equals(accountId));
            assertThat(rig.ok(c, "courier.accounts.list").toString()).doesNotContain(accountId);
        }
    }

    @Test
    void onlyTheOwnersSessionCanAddASignIn(@TempDir Path dir) throws Exception {
        try (CourierRig rig = new CourierRig(dir)) {
            TestClient export = rig.connect("e1", RpcPrincipal.EXPORT);
            Map<String, Object> r = rig.err(export, "forbidden", "courier.accounts.add", "kind", "imap", "address", "dana@example.com",
                    "auth", "app_password", "secret", PASS);
            assertThat(r.toString()).contains("reason=scope");
            rig.err(export, "forbidden", "courier.accounts.signin", "accountId", "imap-x", "secret", PASS);
        }
    }
}
