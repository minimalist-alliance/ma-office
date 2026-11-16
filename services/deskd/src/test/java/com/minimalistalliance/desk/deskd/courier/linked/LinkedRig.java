package com.minimalistalliance.desk.deskd.courier.linked;

import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.courier.testkit.FakeImapServer;
import com.minimalistalliance.desk.courier.testkit.FakeSmtpServer;
import com.minimalistalliance.desk.courier.testkit.FakeTls;
import com.minimalistalliance.desk.deskd.courier.CourierModule;
import com.minimalistalliance.desk.deskd.courier.TestMime;
import com.minimalistalliance.desk.deskd.courier.parse.CourierParser;
import com.minimalistalliance.desk.deskd.courier.store.Courier;
import com.minimalistalliance.desk.deskd.courier.store.CourierStore;
import com.minimalistalliance.desk.deskd.courier.vault.SignIn;
import com.minimalistalliance.desk.deskd.events.EventHub;
import com.minimalistalliance.desk.deskd.events.TopicRegistry;
import com.minimalistalliance.desk.deskd.platform.AgeBand;
import com.minimalistalliance.desk.deskd.rpc.RpcDispatcher;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Linked mailboxes as deskd wires them, against the kit's fake provider: a real Courier module and store in a temporary
 * directory (the stand-in parser, or the real one), the vault, the transport with test timings, one linked account signed
 * in to a {@link FakeImapServer} and a {@link FakeSmtpServer}, and an oracle that reads {@code courier.db} on its own
 * connection. Restarting the transport is a deskd that slept and woke; reopening the module is a deskd restart.
 */
final class LinkedRig implements AutoCloseable {

    static final String LOGIN = "owner@example.com";
    static final String PASS = "app-password-123";
    static final MailboxSync.Settings FAST = new MailboxSync.Settings(Duration.ofMillis(800), Duration.ofSeconds(2), Duration.ofSeconds(2),
            Duration.ofSeconds(2), 20, 1024 * 1024, 1L << 40, Duration.ofDays(365), Duration.ofHours(24), Duration.ofSeconds(2),
            new ImapClient.Settings(Duration.ofSeconds(20), 1024 * 1024, 64 * 1024 * 1024));

    final Path dir;
    final FakeImapServer imap;
    final FakeSmtpServer smtp;
    final CourierParser parser;
    MailboxSync.Settings settings = FAST;
    CourierModule module;
    LinkedMailboxes transport;
    String accountId;

    LinkedRig(Path dir, FakeImapServer.Options imapOptions) throws Exception {
        this(dir, imapOptions, TestMime.PARSER);
    }

    LinkedRig(Path dir, FakeImapServer.Options imapOptions, CourierParser parser) throws Exception {
        this.dir = dir;
        this.parser = parser;
        Files.createDirectories(dir.resolve("desk"));
        imap = FakeImapServer.start(imapOptions.tls(true));
        imap.addUser(LOGIN, PASS);
        smtp = FakeSmtpServer.start(FakeSmtpServer.Options.implicitTls());
        smtp.addUser(LOGIN, PASS);
        openModule();
    }

    void openModule() {
        // Undo send in 200 ms, so a send goes at once in a test.
        CourierModule.Settings s = new CourierModule.Settings(dir.resolve("courier"), dir.resolve("desk"), true, Duration.ofDays(3650),
                new CourierStore.Settings(Duration.ofDays(30), Duration.ofDays(90), Duration.ofMillis(200), Duration.ofDays(4), 2));
        module = new CourierModule(new RpcDispatcher(), new EventHub(new TopicRegistry()), s, parser, () -> false,
                () -> AgeBand.Band.ADULT, Clock.systemUTC());
    }

    Net net() {
        return Net.forTests(FakeTls.clientContext());
    }

    LinkedMailboxes startTransport() {
        transport = new LinkedMailboxes(module, net(), Clock.systemUTC(),
                new LinkedMailboxes.Settings(settings, 4L * 1024 * 1024, Duration.ofSeconds(20), Duration.ofMillis(300))).start();
        return transport;
    }

    String server() {
        return "{\"imapHost\":\"127.0.0.1\",\"imapPort\":" + imap.port() + ",\"smtpHost\":\"127.0.0.1\",\"smtpPort\":" + smtp.port()
                + ",\"security\":\"tls\"}";
    }

    /** Links the account as courier.accounts.add does: checked with the provider, sealed, the row, then its sync. */
    String link() throws Exception {
        if (transport == null) {
            startTransport();
        }
        accountId = "imap-test" + Long.toHexString(System.nanoTime());
        Courier.Account a = new Courier.Account(accountId, "imap", "Mailbox", LOGIN, "ok");
        module.linkedAccounts().add(a, List.<String[]>of(new String[] {"email", LOGIN}),
                new SignIn(SignIn.APP_PASSWORD, LOGIN, PASS.getBytes(StandardCharsets.UTF_8), null, 0, server()));
        transport.added(accountId);
        return accountId;
    }

    CourierStore store() {
        return module.store();
    }

    /** Courier's switch file: {@code null} removes it. Read at most once a second. */
    void switchTo(String words) throws Exception {
        Path f = dir.resolve("desk").resolve("courier-switch");
        if (words == null) {
            Files.deleteIfExists(f);
        } else {
            Files.writeString(f, words);
        }
        Thread.sleep(1_100);
    }

    /** A deskd that slept: the transport stops, then a new one starts on the same store. */
    void sleep() {
        transport.close();
        transport = null;
    }

    void wake() {
        startTransport();
    }

    /** A deskd restart: the transport and the module close, and both open again on the same directory. */
    void restartDeskd() {
        if (transport != null) {
            transport.close();
            transport = null;
        }
        module.close();
        openModule();
        startTransport();
    }

    MailboxSync.Status status() {
        Map<String, Object> m = transport.status(accountId);
        return m == null ? null : new MailboxSync.Status((String) m.get("state"), (String) m.get("reason"), 0, 0,
                Boolean.TRUE.equals(((Map<?, ?>) m.get("firstSync")).get("done")), ((Number) ((Map<?, ?>) m.get("firstSync")).get("messages")).longValue(),
                null, ((Number) m.get("changesOwed")).longValue());
    }

    /** Waits for the sync to be live with every first sync done and nothing owed to the provider. */
    void awaitLive(Duration within) {
        await().atMost(within).pollInterval(Duration.ofMillis(100)).until(() -> {
            MailboxSync.Status s = status();
            return s != null && "live".equals(s.state()) && s.firstSyncDone() && s.opsOwed() == 0;
        });
    }

    // ---- the oracle, on its own connection

    Connection db() throws Exception {
        return DriverManager.getConnection("jdbc:sqlite:" + dir.resolve("courier").resolve("courier.db"));
    }

    /** A desk message as the oracle sees it. */
    record DeskMessage(String id, String blob, String lane, boolean read, String direction, String origin, String labels, String auth) {}

    List<DeskMessage> deskMessages() throws Exception {
        List<DeskMessage> out = new ArrayList<>();
        try (Connection c = db(); Statement s = c.createStatement();
                ResultSet r = s.executeQuery("SELECT id, blob, lane, read, direction, origin, labels, auth FROM messages WHERE account_id = '"
                        + accountId + "'")) {
            while (r.next()) {
                out.add(new DeskMessage(r.getString(1), r.getString(2), r.getString(3), r.getInt(4) == 1, r.getString(5), r.getString(6),
                        r.getString(7), r.getString(8)));
            }
        }
        return out;
    }

    /** The desk message whose raw bytes are these, or null. */
    DeskMessage desk(byte[] raw) throws Exception {
        String sha = sha(raw);
        for (DeskMessage m : deskMessages()) {
            if (sha.equals(m.blob())) {
                return m;
            }
        }
        return null;
    }

    static String sha(byte[] raw) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(raw));
    }

    long count(String sql) throws Exception {
        try (Connection c = db(); Statement s = c.createStatement(); ResultSet r = s.executeQuery(sql)) {
            return r.next() ? r.getLong(1) : 0;
        }
    }

    /** The folders the transport syncs for this provider, by the fake's names. */
    List<String> syncedFolders() {
        List<String> out = new ArrayList<>();
        for (FakeImapServer.Folder f : imap.folders(LOGIN)) {
            if (f.attributes().contains("\\Noselect")) {
                continue;
            }
            if (imap.gmail()) {
                if (f.attributes().contains("\\All") || f.attributes().contains("\\Sent") || f.attributes().contains("\\Junk")
                        || f.attributes().contains("\\Trash")) {
                    out.add(f.name());
                }
            } else if (!f.attributes().contains("\\Drafts") && !f.attributes().contains("\\All")) {
                out.add(f.name());
            }
        }
        return out;
    }

    /**
     * The bar's oracle: every message the provider has in a synced folder is on the desk exactly once (by its bytes), and
     * nothing on the desk is a second copy of anything; read and the lane follow the provider for what's still there.
     * Returns what it found wrong, empty when right.
     */
    List<String> check() throws Exception {
        List<String> wrong = new ArrayList<>();
        Map<String, Integer> deskByBlob = new HashMap<>();
        Map<String, DeskMessage> desk = new HashMap<>();
        for (DeskMessage m : deskMessages()) {
            if (m.blob() == null) {
                continue;
            }
            deskByBlob.merge(m.blob(), 1, Integer::sum);
            desk.put(m.blob(), m);
        }
        for (Map.Entry<String, Integer> e : deskByBlob.entrySet()) {
            if (e.getValue() > 1) {
                wrong.add("duplicate " + e.getKey().substring(0, 8) + " x" + e.getValue());
            }
        }
        Map<String, List<String>> where = new HashMap<>();
        Map<String, Boolean> seen = new HashMap<>();
        for (String folder : syncedFolders()) {
            for (FakeImapServer.Message m : imap.messages(LOGIN, folder)) {
                if (imap.gmail() && m.labels().stream().anyMatch(l -> l.equalsIgnoreCase("\\Draft"))) {
                    continue;
                }
                String sha = sha(m.bytes());
                where.computeIfAbsent(sha, k -> new ArrayList<>()).add(role(folder));
                seen.merge(sha, m.flags().contains("\\Seen"), Boolean::logicalOr);
            }
        }
        for (Map.Entry<String, List<String>> e : where.entrySet()) {
            DeskMessage m = desk.get(e.getKey());
            if (m == null) {
                wrong.add("missing " + e.getKey().substring(0, 8) + " in " + e.getValue());
                continue;
            }
            Set<String> roles = Set.copyOf(e.getValue());
            boolean normal = roles.stream().anyMatch(r -> !r.equals("junk") && !r.equals("trash"));
            if (normal && (m.lane().equals("trash") || m.lane().equals("spam") && !roles.contains("junk"))) {
                wrong.add("lane " + m.lane() + " for a message in " + roles);
            }
            if (!normal && roles.contains("trash") && !roles.contains("junk") && !m.lane().equals("trash")) {
                wrong.add("lane " + m.lane() + " for a message only in Trash");
            }
            if (!normal && roles.contains("junk") && !roles.contains("trash") && !m.lane().equals("spam")) {
                wrong.add("lane " + m.lane() + " for a message only in Junk; places " + places(m.id()));
            }
            if ("in".equals(m.direction()) && m.read() != seen.get(e.getKey())) {
                wrong.add("read " + m.read() + " but \\Seen " + seen.get(e.getKey()) + " in " + roles + "; places " + places(m.id()));
            }
        }
        for (Map.Entry<String, DeskMessage> e : desk.entrySet()) {
            if (!where.containsKey(e.getKey()) && !e.getValue().lane().equals("trash")) {
                wrong.add("on the desk, gone at the provider, not in Trash: lane " + e.getValue().lane());
            }
        }
        return wrong;
    }

    /** The desk's places for a message: folder, UID, \Seen. */
    String places(String messageId) throws Exception {
        List<String> out = new ArrayList<>();
        try (Connection c = db(); Statement s = c.createStatement(); ResultSet r = s.executeQuery(
                "SELECT f.name, l.uid, l.seen FROM linked_locations l JOIN linked_folders f ON f.id = l.folder_id WHERE l.message_id = '"
                        + messageId + "'")) {
            while (r.next()) {
                out.add(r.getString(1) + ":" + r.getLong(2) + (r.getInt(3) == 1 ? "s" : ""));
            }
        }
        try (Connection c = db(); Statement s = c.createStatement(); ResultSet r = s.executeQuery(
                "SELECT lane_before FROM messages WHERE id = '" + messageId + "'")) {
            if (r.next()) {
                out.add("before=" + r.getString(1));
            }
        }
        return out.toString();
    }

    String role(String folder) {
        for (FakeImapServer.Folder f : imap.folders(LOGIN)) {
            if (f.name().equals(folder)) {
                if (f.attributes().contains("\\Junk")) {
                    return "junk";
                }
                if (f.attributes().contains("\\Trash")) {
                    return "trash";
                }
                if (f.attributes().contains("\\Sent")) {
                    return "sent";
                }
            }
        }
        return "normal";
    }

    @Override
    public void close() {
        if (transport != null) {
            transport.close();
        }
        if (module != null) {
            module.close();
        }
        imap.close();
        smtp.close();
    }
}
