package com.minimalistalliance.desk.deskd.courier.linked;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.courier.CourierModule;
import com.minimalistalliance.desk.deskd.courier.TestMime;
import com.minimalistalliance.desk.deskd.courier.store.Courier;
import com.minimalistalliance.desk.deskd.courier.store.CourierStore;
import com.minimalistalliance.desk.deskd.courier.vault.SignIn;
import com.minimalistalliance.desk.deskd.events.EventHub;
import com.minimalistalliance.desk.deskd.events.TopicRegistry;
import com.minimalistalliance.desk.deskd.platform.AgeBand;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.rpc.RpcDispatcher;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;
import java.time.Clock;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.junit.jupiter.api.io.TempDir;

/**
 * Linked mailboxes against a real provider (the launch plan §7: "Real providers: Gmail, Outlook.com, iCloud Mail, Fastmail
 * and Yahoo on staging test accounts. Send, receive, flags, moves and deletes both ways"). Skipped unless
 * {@code scripts/courier-real-provider.sh} runs it: it asks a person for two staging test accounts' app passwords at hidden
 * prompts and hands them to this run only through its environment. <b>Never the owner's mail, or any member's: staging
 * test accounts only.</b> It refuses to run without {@code COURIER_RP_TEST_ACCOUNTS=staging-test-accounts-only}.
 *
 * <p>Two accounts: the one linked (A, on the provider under test) and a peer (B, on any provider) that sends A mail and
 * receives A's, so every message crosses real delivery and carries the provider's real {@code Authentication-Results}.
 * The run uses {@link Net#strict()}: the desk's own TLS checks and address rules. It prints a JSON report
 * ({@code COURIER-RP}) with the timings and what the provider showed (its capabilities, its folders' special uses, the
 * authserv-ids on A's received mail, for {@code Providers}' table), and leaves nothing behind in A or B but the messages
 * it marks {@code [courier-rp <run>]}, which it deletes at the end.
 */
@EnabledIfEnvironmentVariable(named = "COURIER_RP_TEST_ACCOUNTS", matches = "staging-test-accounts-only")
class RealProviderIT {

    @TempDir
    Path dir;

    private static String env(String name) {
        String v = System.getenv(name);
        if (v == null || v.isBlank()) {
            throw new IllegalStateException(name + " isn't set");
        }
        return v;
    }

    @Test
    void sendReceiveFlagsMovesAndDeletesBothWays() throws Exception {
        String provider = env("COURIER_RP_PROVIDER");
        String address = env("COURIER_RP_ADDRESS");
        String peer = env("COURIER_RP_PEER_ADDRESS");
        String peerProvider = env("COURIER_RP_PEER_PROVIDER");
        byte[] secret = env("COURIER_RP_SECRET").getBytes(StandardCharsets.UTF_8);
        byte[] peerSecret = env("COURIER_RP_PEER_SECRET").getBytes(StandardCharsets.UTF_8);
        String run = UUID.randomUUID().toString().substring(0, 8);
        Map<String, Object> report = new LinkedHashMap<>();
        report.put("provider", provider);
        report.put("run", run);
        Providers.Provider p = Providers.byId(provider);
        Providers.Provider pp = Providers.byId(peerProvider);
        assertThat(p).as("provider").isNotNull();
        assertThat(pp).as("peer provider").isNotNull();
        if (p.oauth()) {
            System.out.println("COURIER-RP " + provider + ": needs its own sign-in (Wave 2.2); this run checks the refusal only");
        }
        Net net = Net.strict();
        CourierModule module = new CourierModule(new RpcDispatcher(), new EventHub(new TopicRegistry()),
                new CourierModule.Settings(dir.resolve("courier"), dir, true, Duration.ofDays(3650), new CourierStore.Settings(
                        Duration.ofDays(30), Duration.ofDays(90), Duration.ofMillis(200), Duration.ofDays(4), 2)),
                TestMime.PARSER, () -> false, () -> AgeBand.Band.ADULT, Clock.systemUTC());
        LinkedMailboxes transport = new LinkedMailboxes(module, net, Clock.systemUTC(), LinkedMailboxes.Settings.DEFAULT).start();
        String server = server(p);
        try {
            // Linking: checked against the real IMAP and SMTP.
            long t = System.nanoTime();
            Courier.Account account = new Courier.Account("imap-rp" + run, "imap", p.label(), address, "ok");
            if (p.oauth()) {
                try {
                    module.linkedAccounts().add(account, List.<String[]>of(new String[] {"email", address}),
                            new SignIn(SignIn.APP_PASSWORD, address, secret.clone(), null, 0, server));
                    throw new AssertionError("a provider that needs its own sign-in was linked with a password");
                } catch (com.minimalistalliance.desk.deskd.courier.vault.LinkedAccounts.Rejected e) {
                    assertThat(e.reason()).isEqualTo("oauth");
                    return;
                }
            }
            module.linkedAccounts().add(account, List.<String[]>of(new String[] {"email", address}),
                    new SignIn(SignIn.APP_PASSWORD, address, secret.clone(), null, 0, server));
            transport.added(account.id());
            report.put("linkMs", (System.nanoTime() - t) / 1_000_000);
            ImapClient look = ImapClient.open(net, p.imapHost(), p.imapPort(), ImapClient.Settings.DEFAULT);
            look.login(address, secret);
            report.put("capabilities", capabilities(look));
            report.put("folders", look.list().stream().map(l -> l.name() + " " + l.attributes()).toList());
            look.logout();
            t = System.nanoTime();
            await().atMost(Duration.ofHours(2)).pollInterval(Duration.ofSeconds(5)).until(() -> {
                Map<String, Object> st = transport.status(account.id());
                return st != null && "live".equals(st.get("state"));
            });
            report.put("firstSyncSeconds", (System.nanoTime() - t) / 1_000_000_000);
            report.put("firstSyncMessages", count(dir, "SELECT count(*) FROM messages"));

            // Receiving: B sends A a marked message; it arrives (IDLE), with the provider's own results.
            String subject = "[courier-rp " + run + "] in";
            t = System.nanoTime();
            sendFrom(net, pp, peer, peerSecret, address, subject);
            await().atMost(Duration.ofMinutes(5)).pollInterval(Duration.ofSeconds(1))
                    .until(() -> count(dir, "SELECT count(*) FROM messages WHERE subject = '" + subject + "'") == 1);
            report.put("receiveMs", (System.nanoTime() - t) / 1_000_000);
            report.put("receivedAuth", one(dir, "SELECT auth FROM messages WHERE subject = '" + subject + "'"));
            String messageId = one(dir, "SELECT id FROM messages WHERE subject = '" + subject + "'");
            report.put("authservIds", authservIds(module.store().raw(messageId)));

            // Flags and moves, desk to provider and back.
            module.store().actions().setRead(List.of(messageId), null, null, true);
            await().atMost(Duration.ofMinutes(2)).until(() -> seenAt(net, p, address, secret, subject));
            module.store().actions().delete(List.of(messageId), false);
            await().atMost(Duration.ofMinutes(2)).until(() -> inRole(net, p, address, secret, subject, "\\trash"));
            module.store().actions().move(List.of(messageId), null, null, "restore");
            await().atMost(Duration.ofMinutes(2)).until(() -> !inRole(net, p, address, secret, subject, "\\trash"));
            // The provider changes it (unread), and the desk follows.
            unseeAt(net, p, address, secret, subject);
            await().atMost(Duration.ofMinutes(6)).until(() -> "0".equals(one(dir, "SELECT read FROM messages WHERE id = '" + messageId + "'")));

            // Sending: A to B, once, with A's Sent holding it once.
            String out = "[courier-rp " + run + "] out";
            Object[] draft = module.store().actions().saveDraft(null, null, "email", account.id(), List.of(peer), out, "From the desk.", null,
                    null);
            t = System.nanoTime();
            module.store().outbox().send((String) draft[0]);
            await().atMost(Duration.ofMinutes(5)).until(() -> countAt(net, pp, peer, peerSecret, out) == 1);
            report.put("sendToPeerMs", (System.nanoTime() - t) / 1_000_000);
            await().atMost(Duration.ofMinutes(5)).until(() -> inRole(net, p, address, secret, out, "\\sent"));
            report.put("sentCopies", countIn(net, p, address, secret, out, "\\sent"));

            // Deleting for good, from Trash.
            module.store().actions().delete(List.of(messageId), false);
            await().atMost(Duration.ofMinutes(2)).until(() -> inRole(net, p, address, secret, subject, "\\trash"));
            module.store().actions().delete(List.of(messageId), true);
            await().atMost(Duration.ofMinutes(2)).until(() -> !inRole(net, p, address, secret, subject, "\\trash"));
            report.put("ok", true);
        } finally {
            System.out.println("COURIER-RP " + new String(Json.bytes(report), StandardCharsets.UTF_8));
            Files.writeString(Path.of("target", "courier-rp-" + provider + ".json"), new String(Json.bytes(report), StandardCharsets.UTF_8));
            transport.close();
            module.close();
            java.util.Arrays.fill(secret, (byte) 0);
            java.util.Arrays.fill(peerSecret, (byte) 0);
        }
    }

    private static String server(Providers.Provider p) {
        return "{\"imapHost\":\"" + p.imapHost() + "\",\"imapPort\":" + p.imapPort() + ",\"smtpHost\":\"" + p.smtpHost()
                + "\",\"smtpPort\":" + p.smtpPort() + ",\"security\":\"" + (p.smtpTls() ? "tls" : "starttls") + "\"}";
    }

    private static List<String> capabilities(ImapClient c) {
        return List.of("IDLE", "CONDSTORE", "QRESYNC", "MOVE", "UIDPLUS", "SPECIAL-USE", "ESEARCH", "X-GM-EXT-1", "LITERAL+")
                .stream().filter(c::has).toList();
    }

    private static long count(Path dir, String sql) throws Exception {
        try (Connection c = DriverManager.getConnection("jdbc:sqlite:" + dir.resolve("courier/courier.db"));
                Statement s = c.createStatement(); ResultSet r = s.executeQuery(sql)) {
            return r.next() ? r.getLong(1) : 0;
        }
    }

    private static String one(Path dir, String sql) throws Exception {
        try (Connection c = DriverManager.getConnection("jdbc:sqlite:" + dir.resolve("courier/courier.db"));
                Statement s = c.createStatement(); ResultSet r = s.executeQuery(sql)) {
            return r.next() ? r.getString(1) : null;
        }
    }

    /** The authserv-ids of the message's Authentication-Results fields, topmost first: what Providers' table needs. */
    private static List<String> authservIds(byte[] raw) {
        java.util.List<String> out = new java.util.ArrayList<>();
        for (java.util.Map<String, Object> m : com.minimalistalliance.desk.courier.parse.AuthResults.read(
                headerFields(raw, "authentication-results"))) {
            out.add(String.valueOf(m.get("authServ")));
        }
        return out;
    }

    private static List<String> headerFields(byte[] raw, String name) {
        TestMimeHeaders h = new TestMimeHeaders(raw);
        return h.all(name);
    }

    /** The header fields of a raw message, by name, unfolded (test only: deskd itself never reads a header). */
    private record TestMimeHeaders(byte[] raw) {
        List<String> all(String name) {
            String text = new String(raw, StandardCharsets.ISO_8859_1);
            int end = text.indexOf("\r\n\r\n");
            String head = end < 0 ? text : text.substring(0, end);
            java.util.List<String> out = new java.util.ArrayList<>();
            StringBuilder cur = null;
            for (String line : head.split("\r\n")) {
                if (!line.isEmpty() && (line.charAt(0) == ' ' || line.charAt(0) == '\t') && cur != null) {
                    cur.append(' ').append(line.strip());
                    continue;
                }
                if (cur != null) {
                    out.add(cur.toString());
                    cur = null;
                }
                int colon = line.indexOf(':');
                if (colon > 0 && line.substring(0, colon).strip().equalsIgnoreCase(name)) {
                    cur = new StringBuilder(line.substring(colon + 1).strip());
                }
            }
            if (cur != null) {
                out.add(cur.toString());
            }
            return out;
        }
    }

    private static void sendFrom(Net net, Providers.Provider pp, String from, byte[] secret, String to, String subject) throws Exception {
        SmtpClient s = SmtpClient.open(net, pp.smtpHost(), pp.smtpPort(), pp.smtpTls(), Duration.ofMinutes(2));
        try {
            s.auth(from, secret);
            byte[] m = ("From: " + from + "\r\nTo: " + to + "\r\nSubject: " + subject + "\r\nMessage-ID: <" + UUID.randomUUID() + "@"
                    + from.substring(from.indexOf('@') + 1) + ">\r\nDate: " + java.time.format.DateTimeFormatter.RFC_1123_DATE_TIME.format(
                    java.time.ZonedDateTime.now(java.time.ZoneOffset.UTC)) + "\r\n\r\nA test of linked mailboxes.\r\n")
                    .getBytes(StandardCharsets.US_ASCII);
            assertThat(s.send(from, List.of(to), m).kind()).isEqualTo(SmtpClient.Outcome.Kind.SENT);
            s.quit();
        } finally {
            s.close();
        }
    }

    private static String folderWith(ImapClient c, String role) throws Exception {
        for (ImapClient.Listed l : c.list()) {
            if (l.attributes().contains(role) || role.equals("\\inbox") && l.name().equalsIgnoreCase("INBOX")) {
                return l.name();
            }
        }
        return null;
    }

    private static long countIn(Net net, Providers.Provider p, String address, byte[] secret, String subject, String role) throws Exception {
        ImapClient c = ImapClient.open(net, p.imapHost(), p.imapPort(), ImapClient.Settings.DEFAULT);
        try {
            c.login(address, secret);
            String f = folderWith(c, role);
            if (f == null) {
                return 0;
            }
            c.select(f, 0, 0, null);
            return c.search("SUBJECT \"" + subject + "\"").length;
        } finally {
            c.logout();
        }
    }

    private static boolean inRole(Net net, Providers.Provider p, String address, byte[] secret, String subject, String role) throws Exception {
        return countIn(net, p, address, secret, subject, role) > 0;
    }

    private static long countAt(Net net, Providers.Provider p, String address, byte[] secret, String subject) throws Exception {
        return countIn(net, p, address, secret, subject, "\\inbox");
    }

    private static boolean seenAt(Net net, Providers.Provider p, String address, byte[] secret, String subject) throws Exception {
        ImapClient c = ImapClient.open(net, p.imapHost(), p.imapPort(), ImapClient.Settings.DEFAULT);
        try {
            c.login(address, secret);
            c.select("INBOX", 0, 0, null);
            return c.search("SUBJECT \"" + subject + "\" SEEN").length > 0;
        } finally {
            c.logout();
        }
    }

    private static void unseeAt(Net net, Providers.Provider p, String address, byte[] secret, String subject) throws Exception {
        ImapClient c = ImapClient.open(net, p.imapHost(), p.imapPort(), ImapClient.Settings.DEFAULT);
        try {
            c.login(address, secret);
            c.select("INBOX", 0, 0, null);
            long[] u = c.search("SUBJECT \"" + subject + "\"");
            if (u.length > 0) {
                c.store(UidSet.of(u), "-FLAGS.SILENT", "\\Seen");
            }
        } finally {
            c.logout();
        }
    }
}
