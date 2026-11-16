package com.minimalistalliance.desk.courier.testkit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.courier.testkit.FakeImapServer.Capability;
import com.minimalistalliance.desk.courier.testkit.FakeImapServer.Options;
import com.minimalistalliance.desk.courier.testkit.RawImap.Reply;
import java.io.IOException;
import java.net.ConnectException;
import java.net.InetAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Set;
import java.util.SplittableRandom;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;

/** {@link FakeImapServer} driven over raw sockets, as a client would. */
class FakeImapServerTest {

    static final String USER = "alice@example.com";
    static final String PW = "pw-alice";

    static byte[] msg(String id, String subject, String body) {
        return ("Message-ID: <" + id + "@example.com>\r\nFrom: Bob <bob@example.com>\r\nTo: " + USER + "\r\nSubject: " + subject
            + "\r\n\r\n" + body + "\r\n").getBytes(StandardCharsets.UTF_8);
    }

    static FakeImapServer server(Options o) {
        FakeImapServer s = FakeImapServer.start(o);
        s.addUser(USER, PW);
        return s;
    }

    static RawImap login(FakeImapServer s) throws IOException {
        return RawImap.login(s.port(), "\"" + USER + "\"", PW);
    }

    static long number(String line, String key) {
        Matcher m = Pattern.compile(Pattern.quote(key) + " \\(?(\\d+)").matcher(line);
        if (!m.find()) {
            throw new AssertionError("no " + key + " in " + line);
        }
        return Long.parseLong(m.group(1));
    }

    static String find(Reply r, String contains) {
        return r.lines().stream().filter(l -> l.contains(contains)).findFirst().orElseThrow(() -> new AssertionError("no '" + contains + "' in " + r.lines()));
    }

    // ---- login and capabilities ----

    @Test
    void greetsAndLogsInEveryWay() throws Exception {
        try (FakeImapServer s = server(Options.defaults())) {
            try (RawImap c = RawImap.connect(s.port())) {
                assertThat(c.greeting).startsWith("* OK [CAPABILITY IMAP4rev1 ").contains(" AUTH=PLAIN", " SASL-IR", " LITERAL+", " QRESYNC")
                    .doesNotContain("LOGINDISABLED").doesNotContain("X-GM-EXT-1");
                assertThat(c.cmd("LOGIN \"" + USER + "\" wrong").tagged()).endsWith("NO [AUTHENTICATIONFAILED] Authentication failed.");
                Reply ok = c.cmd("LOGIN \"" + USER + "\" \"" + PW + "\"");
                assertThat(ok.tagged()).contains("OK [CAPABILITY IMAP4rev1").contains("CONDSTORE").doesNotContain("AUTH=PLAIN");
                assertThat(c.cmd("CAPABILITY").lines().get(0)).startsWith("* CAPABILITY IMAP4rev1").doesNotContain("SASL-IR");
                assertThat(c.cmd("FROB").tagged()).contains("BAD");
            }
            try (RawImap c = RawImap.connect(s.port())) {
                byte[] user = USER.getBytes(StandardCharsets.UTF_8);
                c.send("s1 LOGIN {" + user.length + "}\r\n");
                assertThat(c.readLine()).startsWith("+ ");
                c.send(USER + " {" + PW.length() + "}\r\n");
                assertThat(c.readLine()).startsWith("+ ");
                c.send(PW + "\r\n");
                assertThat(c.readTagged("s1").ok()).isTrue();
            }
            try (RawImap c = RawImap.connect(s.port())) {
                c.send("p1 LOGIN {" + USER.length() + "+}\r\n" + USER + " {" + PW.length() + "+}\r\n" + PW + "\r\n");
                assertThat(c.readTagged("p1").ok()).isTrue();
            }
            String plain = Base64.getEncoder().encodeToString(("\0" + USER + "\0" + PW).getBytes(StandardCharsets.UTF_8));
            try (RawImap c = RawImap.connect(s.port())) {
                assertThat(c.cmd("AUTHENTICATE PLAIN " + plain).ok()).isTrue();
            }
            try (RawImap c = RawImap.connect(s.port())) {
                c.send("x1 AUTHENTICATE PLAIN\r\n");
                assertThat(c.readLine()).isEqualTo("+ ");
                c.send(plain + "\r\n");
                assertThat(c.readTagged("x1").ok()).isTrue();
            }
            assertThat(s.logins()).isEqualTo(5);
            assertThat(s.commandCount("LOGIN")).isEqualTo(4);
            assertThat(s.commandCount("AUTHENTICATE")).isEqualTo(2);
        }
    }

    @Test
    void eachCapabilityCanBeTurnedOff() throws Exception {
        Options o = Options.defaults().without(Capability.IDLE, Capability.MOVE, Capability.CONDSTORE, Capability.QRESYNC, Capability.ESEARCH,
            Capability.LITERAL_PLUS, Capability.SASL_IR, Capability.SPECIAL_USE, Capability.UIDPLUS, Capability.ENABLE, Capability.ID,
            Capability.NAMESPACE).with(Capability.LOGINDISABLED);
        try (FakeImapServer s = server(o)) {
            s.deliver(USER, msg("m1", "one", "x"));
            try (RawImap c = RawImap.connect(s.port())) {
                assertThat(c.greeting).isEqualTo("* OK [CAPABILITY IMAP4rev1 UNSELECT CHILDREN AUTH=PLAIN LOGINDISABLED] FakeImapServer ready.");
                assertThat(c.cmd("LOGIN \"" + USER + "\" " + PW).tagged()).endsWith("NO [PRIVACYREQUIRED] LOGIN is disabled.");
                String plain = Base64.getEncoder().encodeToString(("\0" + USER + "\0" + PW).getBytes(StandardCharsets.UTF_8));
                assertThat(c.cmd("AUTHENTICATE PLAIN " + plain).tagged()).contains("BAD");
                c.send("x1 AUTHENTICATE PLAIN\r\n");
                assertThat(c.readLine()).isEqualTo("+ ");
                c.send(plain + "\r\n");
                assertThat(c.readTagged("x1").ok()).isTrue();
                for (String cmd : List.of("IDLE", "ENABLE CONDSTORE", "ID NIL", "NAMESPACE", "SELECT INBOX (CONDSTORE)")) {
                    assertThat(c.cmd(cmd).tagged()).as(cmd).contains(" BAD ");
                }
                Reply sel = c.cmd("SELECT INBOX");
                assertThat(sel.ok()).isTrue();
                assertThat(sel.lines()).noneMatch(l -> l.contains("HIGHESTMODSEQ"));
                for (String cmd : List.of("UID MOVE 1 Archive", "UID EXPUNGE 1", "UID FETCH 1 (MODSEQ)", "UID SEARCH RETURN (ALL) ALL",
                    "UID FETCH 1 (FLAGS) (CHANGEDSINCE 1)")) {
                    assertThat(c.cmd(cmd).tagged()).as(cmd).contains(" BAD ");
                }
            }
            try (RawImap c = RawImap.connect(s.port())) {
                String plain = Base64.getEncoder().encodeToString(("\0" + USER + "\0" + PW).getBytes(StandardCharsets.UTF_8));
                c.send("x1 AUTHENTICATE PLAIN\r\n");
                c.readLine();
                c.send(plain + "\r\n");
                c.readTagged("x1");
                c.cmd("SELECT INBOX");
                Reply copy = c.cmd("UID COPY 1 Archive");
                assertThat(copy.tagged()).endsWith("OK Copy completed.");
                assertThat(c.cmd("LIST \"\" \"*\"").lines()).contains("* LIST (\\HasNoChildren) \"/\" Sent").noneMatch(l -> l.contains("\\Sent)"));
                assertThat(c.cmd("LIST (SPECIAL-USE) \"\" \"*\"").tagged()).contains(" BAD ");
                c.send("n1 APPEND INBOX {3+}\r\nabc\r\n");
                assertThat(c.readTagged("n1").tagged()).isEqualTo("n1 BAD Non-synchronizing literals aren't supported");
                assertThat(c.cmd("NOOP").ok()).isTrue();
            }
        }
    }

    // ---- folders ----

    @Test
    void listsFoldersWithSpecialUseHierarchyAndModifiedUtf7() throws Exception {
        try (FakeImapServer s = server(Options.defaults())) {
            s.addFolder(USER, "Projects/2026/Réunions");
            s.deliver(USER, "Archive", msg("a1", "kept", "x"), Set.of("\\Seen"), null);
            try (RawImap c = login(s)) {
                Reply all = c.cmd("LIST \"\" \"*\"");
                assertThat(all.untagged()).containsExactly(
                    "* LIST (\\HasNoChildren) \"/\" INBOX",
                    "* LIST (\\HasNoChildren \\Archive) \"/\" Archive",
                    "* LIST (\\HasNoChildren \\Drafts) \"/\" Drafts",
                    "* LIST (\\HasNoChildren \\Junk) \"/\" Junk",
                    "* LIST (\\HasChildren \\Noselect) \"/\" Projects",
                    "* LIST (\\HasChildren \\Noselect) \"/\" Projects/2026",
                    "* LIST (\\HasNoChildren) \"/\" Projects/2026/R&AOk-unions",
                    "* LIST (\\HasNoChildren \\Sent) \"/\" Sent",
                    "* LIST (\\HasNoChildren \\Trash) \"/\" Trash");
                assertThat(c.cmd("LIST \"\" %").untagged()).hasSize(7).noneMatch(l -> l.contains("Projects/"));
                assertThat(c.cmd("LIST \"\" Projects/%").untagged()).containsExactly("* LIST (\\HasChildren \\Noselect) \"/\" Projects/2026");
                assertThat(c.cmd("LIST (SPECIAL-USE) \"\" \"*\"").untagged()).hasSize(5).allMatch(l -> l.matches(".*\\\\(Archive|Drafts|Junk|Sent|Trash)\\).*"));
                assertThat(c.cmd("LIST \"\" \"*\" RETURN (SPECIAL-USE)").untagged()).hasSize(9);
                assertThat(c.cmd("LIST \"\" \"\"").untagged()).containsExactly("* LIST (\\Noselect) \"/\" \"\"");
                assertThat(c.cmd("LIST \"\" inbox").untagged()).containsExactly("* LIST (\\HasNoChildren) \"/\" INBOX");
                assertThat(c.cmd("SELECT \"Projects/2026/R&AOk-unions\"").ok()).isTrue();
                assertThat(c.cmd("SELECT Projects").tagged()).contains("NO [NONEXISTENT]");
                Reply status = c.cmd("STATUS Archive (MESSAGES UIDNEXT UIDVALIDITY UNSEEN HIGHESTMODSEQ)");
                FakeImapServer.Folder f = s.folder(USER, "Archive");
                assertThat(status.lines().get(0)).isEqualTo("* STATUS Archive (MESSAGES 1 UIDNEXT 2 UIDVALIDITY " + f.uidValidity() + " UNSEEN 0 HIGHESTMODSEQ "
                    + f.highestModSeq() + ")");
                assertThat(c.cmd("CREATE \"Caf&AOk-\"").ok()).isTrue();
                assertThat(c.cmd("CREATE Archive").tagged()).contains("NO [ALREADYEXISTS]");
                assertThat(s.folders(USER)).extracting(FakeImapServer.Folder::name).contains("Café");
                assertThat(c.cmd("DELETE \"Caf&AOk-\"").ok()).isTrue();
                assertThat(c.cmd("LSUB \"\" Sent").untagged()).containsExactly("* LSUB (\\HasNoChildren \\Sent) \"/\" Sent");
                assertThat(c.cmd("NAMESPACE").lines().get(0)).isEqualTo("* NAMESPACE ((\"\" \"/\")) NIL NIL");
                assertThat(c.cmd("ID (\"name\" \"test\")").lines().get(0)).startsWith("* ID (\"name\" \"FakeImapServer\"");
            }
        }
    }

    // ---- CONDSTORE and QRESYNC ----

    @Test
    void condstoreSelectStoreAndChangedSince() throws Exception {
        try (FakeImapServer s = server(Options.defaults())) {
            for (int i = 1; i <= 5; i++) {
                s.deliver(USER, msg("m" + i, "n" + i, "x"));
            }
            try (RawImap c = login(s)) {
                Reply sel = c.cmd("SELECT INBOX (CONDSTORE)");
                long h = number(find(sel, "HIGHESTMODSEQ"), "HIGHESTMODSEQ");
                assertThat(h).isEqualTo(s.folder(USER, "INBOX").highestModSeq());
                assertThat(sel.lines()).contains("* 5 EXISTS", "* OK [UIDNEXT 6] Predicted next UID");
                assertThat(sel.tagged()).endsWith("OK [READ-WRITE] SELECT completed.");
                Reply st = c.cmd("STORE 2 +FLAGS (\\Seen)");
                assertThat(st.untagged()).containsExactly("* 2 FETCH (FLAGS (\\Seen) MODSEQ (" + (h + 1) + "))");
                Reply again = c.cmd("STORE 2 +FLAGS (\\Seen)");
                assertThat(again.untagged()).containsExactly("* 2 FETCH (FLAGS (\\Seen) MODSEQ (" + (h + 1) + "))");
                Reply since = c.cmd("UID FETCH 1:* (FLAGS) (CHANGEDSINCE " + h + ")");
                assertThat(since.untagged()).containsExactly("* 2 FETCH (UID 2 FLAGS (\\Seen) MODSEQ (" + (h + 1) + "))");
                Reply cond = c.cmd("UID STORE 3,4 (UNCHANGEDSINCE " + h + ") +FLAGS (\\Flagged)");
                assertThat(cond.tagged()).endsWith("OK Store completed.");
                assertThat(cond.untagged()).hasSize(2);
                Reply failed = c.cmd("UID STORE 3,5 (UNCHANGEDSINCE " + h + ") -FLAGS (\\Flagged)");
                assertThat(failed.tagged()).endsWith("OK [MODIFIED 3] Conditional STORE failed.");
                assertThat(failed.untagged()).containsExactly("* 5 FETCH (UID 5 FLAGS () MODSEQ (" + s.messages(USER, "INBOX").get(4).modSeq() + "))");
                Reply silent = c.cmd("UID STORE 1 +FLAGS.SILENT (\\Answered)");
                long m1 = s.messages(USER, "INBOX").get(0).modSeq();
                assertThat(silent.untagged()).containsExactly("* 1 FETCH (UID 1 MODSEQ (" + m1 + "))");
                Reply ms = c.cmd("FETCH 1:2 (MODSEQ)");
                assertThat(ms.untagged()).containsExactly("* 1 FETCH (MODSEQ (" + m1 + "))", "* 2 FETCH (MODSEQ (" + (h + 1) + "))");
                assertThat(c.cmd("UID SEARCH MODSEQ " + (h + 1)).lines().get(0)).isEqualTo("* SEARCH 1 2 3 4 (MODSEQ " + m1 + ")");
            }
        }
    }

    @Test
    void qresyncSelectAfterExpungesAndFlagChanges() throws Exception {
        try (FakeImapServer s = server(Options.defaults())) {
            for (int i = 1; i <= 6; i++) {
                s.deliver(USER, msg("m" + i, "n" + i, "x"));
            }
            long v;
            long h;
            try (RawImap c = login(s)) {
                assertThat(c.cmd("SELECT INBOX (QRESYNC (1 1))").tagged()).contains(" BAD ");
                assertThat(c.cmd("ENABLE QRESYNC").lines().get(0)).isEqualTo("* ENABLED QRESYNC");
                Reply sel = c.cmd("SELECT INBOX");
                v = number(find(sel, "UIDVALIDITY"), "UIDVALIDITY");
                h = number(find(sel, "HIGHESTMODSEQ"), "HIGHESTMODSEQ");
                c.cmd("LOGOUT");
            }
            s.expunge(USER, "INBOX", 2);
            s.expunge(USER, "INBOX", 4);
            s.setFlags(USER, "INBOX", 5, Set.of("\\Seen", "$Important"));
            long uid7 = s.deliver(USER, msg("m7", "n7", "x"));
            assertThat(uid7).isEqualTo(7);
            List<FakeImapServer.Message> now = s.messages(USER, "INBOX");
            try (RawImap c = login(s)) {
                c.cmd("ENABLE QRESYNC");
                Reply sel = c.cmd("SELECT INBOX (QRESYNC (" + v + " " + h + " 1:6))");
                assertThat(sel.lines()).contains("* 5 EXISTS", "* VANISHED (EARLIER) 2,4",
                    "* 3 FETCH (UID 5 FLAGS (\\Seen $Important) MODSEQ (" + now.get(2).modSeq() + "))",
                    "* 5 FETCH (UID 7 FLAGS () MODSEQ (" + now.get(4).modSeq() + "))");
                assertThat(sel.lines().indexOf("* VANISHED (EARLIER) 2,4")).isLessThan(sel.lines().indexOf("* 5 FETCH (UID 7 FLAGS () MODSEQ (" + now.get(4).modSeq() + "))"));
                Reply known = c.cmd("SELECT INBOX (QRESYNC (" + v + " " + h + " 1:3))");
                assertThat(known.lines().get(0)).isEqualTo("* OK [CLOSED] Previous mailbox closed.");
                assertThat(known.lines()).contains("* VANISHED (EARLIER) 2").noneMatch(l -> l.contains("2,4"));
                Reply other = c.cmd("SELECT INBOX (QRESYNC (" + (v + 99) + " " + h + "))");
                assertThat(other.lines()).noneMatch(l -> l.contains("VANISHED") || l.contains("FETCH"));
                Reply changed = c.cmd("UID FETCH 1:* (FLAGS) (CHANGEDSINCE " + h + " VANISHED)");
                assertThat(changed.untagged()).containsExactly("* VANISHED (EARLIER) 2,4",
                    "* 3 FETCH (UID 5 FLAGS (\\Seen $Important) MODSEQ (" + now.get(2).modSeq() + "))",
                    "* 5 FETCH (UID 7 FLAGS () MODSEQ (" + now.get(4).modSeq() + "))");
                assertThat(c.cmd("FETCH 1:* (FLAGS) (CHANGEDSINCE " + h + " VANISHED)").tagged()).contains(" BAD ");
                c.cmd("UID STORE 1 +FLAGS.SILENT (\\Deleted)");
                Reply ex = c.cmd("UID EXPUNGE 1");
                assertThat(ex.untagged()).containsExactly("* VANISHED 1");
                assertThat(ex.tagged()).contains("OK [HIGHESTMODSEQ " + s.folder(USER, "INBOX").highestModSeq() + "] Expunge completed.");
            }
        }
    }

    @Test
    void jakartaMailAgreesOnCondstoreAndQresync() throws Exception {
        try (FakeImapServer s = server(Options.defaults())) {
            for (int i = 1; i <= 4; i++) {
                s.deliver(USER, msg("j" + i, "n" + i, "body " + i));
            }
            java.util.Properties p = new java.util.Properties();
            p.put("mail.imap.peek", "true");
            jakarta.mail.Session session = jakarta.mail.Session.getInstance(p);
            try (org.eclipse.angus.mail.imap.IMAPStore store = (org.eclipse.angus.mail.imap.IMAPStore) session.getStore("imap")) {
                store.connect("127.0.0.1", s.port(), USER, PW);
                assertThat(store.hasCapability("QRESYNC")).isTrue();
                org.eclipse.angus.mail.imap.IMAPFolder f = (org.eclipse.angus.mail.imap.IMAPFolder) store.getFolder("INBOX");
                f.open(jakarta.mail.Folder.READ_WRITE);
                long v = f.getUIDValidity();
                long h = f.getHighestModSeq();
                assertThat(h).isEqualTo(s.folder(USER, "INBOX").highestModSeq());
                jakarta.mail.Message m3 = f.getMessageByUID(3);
                java.io.ByteArrayOutputStream raw = new java.io.ByteArrayOutputStream();
                m3.writeTo(raw);
                assertThat(raw.toByteArray()).isEqualTo(msg("j3", "n3", "body 3"));
                f.close(false);

                s.setFlags(USER, "INBOX", 2, Set.of("\\Flagged"));
                s.expunge(USER, "INBOX", 1);
                f.open(jakarta.mail.Folder.READ_WRITE);
                jakarta.mail.Message[] changed = f.getMessagesByUIDChangedSince(1, org.eclipse.angus.mail.imap.IMAPFolder.LASTUID, h);
                assertThat(changed).hasSize(1);
                assertThat(f.getUID(changed[0])).isEqualTo(2);
                assertThat(changed[0].getFlags().contains(jakarta.mail.Flags.Flag.FLAGGED)).isTrue();
                f.close(false);

                List<jakarta.mail.event.MailEvent> events = f.open(jakarta.mail.Folder.READ_WRITE, new org.eclipse.angus.mail.imap.ResyncData(v, h));
                List<Long> vanished = new ArrayList<>();
                List<Long> flagged = new ArrayList<>();
                for (jakarta.mail.event.MailEvent e : events) {
                    if (e instanceof org.eclipse.angus.mail.imap.MessageVanishedEvent mv) {
                        for (long u : mv.getUIDs()) {
                            vanished.add(u);
                        }
                    } else if (e instanceof jakarta.mail.event.MessageChangedEvent mc) {
                        flagged.add(f.getUID(mc.getMessage()));
                    }
                }
                assertThat(vanished).containsExactly(1L);
                assertThat(flagged).containsExactly(2L);
                f.close(false);
            }
        }
    }

    // ---- pushed changes ----

    @Test
    void idleSeesOtherSessionsAndTheTestApiAtOnce() throws Exception {
        try (FakeImapServer s = server(Options.defaults())) {
            for (int i = 1; i <= 3; i++) {
                s.deliver(USER, msg("m" + i, "n" + i, "x"));
            }
            try (RawImap a = login(s); RawImap b = login(s)) {
                a.cmd("SELECT INBOX");
                b.cmd("SELECT INBOX");
                a.send("i1 IDLE\r\n");
                assertThat(a.readLine()).isEqualTo("+ idling");

                assertThat(b.cmd("STORE 1 +FLAGS (\\Flagged)").untagged()).containsExactly("* 1 FETCH (FLAGS (\\Flagged))");
                assertThat(a.readLine()).isEqualTo("* 1 FETCH (UID 1 FLAGS (\\Flagged))");

                byte[] m = msg("m4", "n4", "appended");
                b.send("b9 APPEND INBOX {" + m.length + "+}\r\n");
                b.send(m);
                b.send("\r\n");
                Reply app = b.readTagged("b9");
                assertThat(app.lines()).contains("* 4 EXISTS");
                assertThat(a.readLine()).isEqualTo("* 4 EXISTS");

                b.cmd("STORE 2 +FLAGS.SILENT (\\Deleted)");
                assertThat(a.readLine()).isEqualTo("* 2 FETCH (UID 2 FLAGS (\\Deleted))");
                assertThat(b.cmd("EXPUNGE").untagged()).containsExactly("* 2 EXPUNGE");
                assertThat(a.readLine()).isEqualTo("* 2 EXPUNGE");

                s.deliver(USER, msg("m5", "n5", "x"));
                assertThat(a.readLine()).isEqualTo("* 4 EXISTS");
                s.expunge(USER, "INBOX", 1);
                assertThat(a.readLine()).isEqualTo("* 1 EXPUNGE");
                s.setFlags(USER, "INBOX", 3, Set.of("\\Seen"));
                assertThat(a.readLine()).isEqualTo("* 1 FETCH (UID 3 FLAGS (\\Seen))");

                a.send("DONE\r\n");
                assertThat(a.readTagged("i1").tagged()).isEqualTo("i1 OK Idle completed.");

                // b, not idling, hears of them with its next command; EXPUNGE waits past a FETCH by number.
                s.setFlags(USER, "INBOX", 4, Set.of("\\Answered"));
                s.expunge(USER, "INBOX", 5);
                Reply fetch = b.cmd("FETCH 1 (FLAGS)");
                // b knows UIDs 1, 3, 4 and now 5; 1 and 5 are gone, which it hears only at the NOOP. Message 1, expunged and
                // not yet told, is left out of the FETCH (RFC 2180 section 4.1).
                assertThat(fetch.untagged()).containsExactly("* 4 EXISTS", "* 2 FETCH (UID 3 FLAGS (\\Seen))", "* 3 FETCH (UID 4 FLAGS (\\Answered))");
                Reply noop = b.cmd("NOOP");
                assertThat(noop.untagged()).containsExactly("* 1 EXPUNGE", "* 3 EXPUNGE");
            }
            try (RawImap q = login(s); RawImap b = login(s)) {
                q.cmd("ENABLE QRESYNC");
                q.cmd("SELECT INBOX");
                q.send("i2 IDLE\r\n");
                q.readLine();
                List<FakeImapServer.Message> left = s.messages(USER, "INBOX");
                long uid = left.get(0).uid();
                s.expunge(USER, "INBOX", uid);
                assertThat(q.readLine()).isEqualTo("* VANISHED " + uid);
                b.cmd("SELECT INBOX");
                b.cmd("UID STORE " + left.get(1).uid() + " +FLAGS (\\Seen)");
                assertThat(q.readLine()).matches("\\* 1 FETCH \\(UID " + left.get(1).uid() + " FLAGS \\(\\\\Answered \\\\Seen\\) MODSEQ \\(\\d+\\)\\)");
                q.send("DONE\r\n");
                assertThat(q.readTagged("i2").ok()).isTrue();
            }
        }
    }

    // ---- MOVE, COPY, APPEND ----

    @Test
    void moveAndCopyAnswerCopyuid() throws Exception {
        try (FakeImapServer s = server(Options.defaults())) {
            for (int i = 1; i <= 4; i++) {
                s.deliver(USER, msg("m" + i, "n" + i, "x"));
            }
            long archive = s.folder(USER, "Archive").uidValidity();
            try (RawImap c = login(s)) {
                c.cmd("SELECT INBOX");
                Reply mv = c.cmd("UID MOVE 1:2 Archive");
                assertThat(mv.untagged()).containsExactly("* OK [COPYUID " + archive + " 1:2 1:2] Moved UIDs.", "* 1 EXPUNGE", "* 1 EXPUNGE");
                assertThat(mv.tagged()).endsWith("OK Move completed.");
                Reply cp = c.cmd("UID COPY 3 Archive");
                assertThat(cp.tagged()).endsWith("OK [COPYUID " + archive + " 3 3] Copy completed.");
                assertThat(c.cmd("UID MOVE 4 Nowhere").tagged()).contains("NO [TRYCREATE]");
                assertThat(c.cmd("MOVE 2 Trash").untagged()).containsExactly("* OK [COPYUID " + s.folder(USER, "Trash").uidValidity() + " 4 1] Moved UIDs.",
                    "* 2 EXPUNGE");
                c.cmd("ENABLE QRESYNC");
                Reply q = c.cmd("UID MOVE 3 Trash");
                assertThat(q.untagged()).containsExactly("* OK [COPYUID " + s.folder(USER, "Trash").uidValidity() + " 3 2] Moved UIDs.", "* VANISHED 3");
                assertThat(q.tagged()).contains("OK [HIGHESTMODSEQ ");
            }
            assertThat(s.messages(USER, "Archive")).extracting(m -> new String(m.bytes(), StandardCharsets.UTF_8))
                .containsExactly(new String(msg("m1", "n1", "x"), StandardCharsets.UTF_8), new String(msg("m2", "n2", "x"), StandardCharsets.UTF_8),
                    new String(msg("m3", "n3", "x"), StandardCharsets.UTF_8));
            assertThat(s.messages(USER, "INBOX")).isEmpty();
        }
    }

    @Test
    void appendAnswersAppenduidAndIsRecorded() throws Exception {
        try (FakeImapServer s = server(Options.defaults())) {
            long drafts = s.folder(USER, "Drafts").uidValidity();
            byte[] d1 = msg("d1", "draft one", "first");
            byte[] d2 = msg("d2", "draft two", "second");
            try (RawImap c = login(s)) {
                c.send("p1 APPEND Drafts (\\Draft \\Seen) \"14-Nov-2026 10:00:00 -0700\" {" + d1.length + "}\r\n");
                assertThat(c.readLine()).startsWith("+ ");
                c.send(d1);
                c.send("\r\n");
                assertThat(c.readTagged("p1").tagged()).isEqualTo("p1 OK [APPENDUID " + drafts + " 1] Append completed.");
                c.send("p2 APPEND Drafts {" + d2.length + "+}\r\n");
                c.send(d2);
                c.send("\r\n");
                assertThat(c.readTagged("p2").tagged()).isEqualTo("p2 OK [APPENDUID " + drafts + " 2] Append completed.");
                assertThat(c.cmd("APPEND Nope {1+}\r\nx").tagged()).contains("NO [TRYCREATE]");
                c.cmd("SELECT Drafts");
                Reply f = c.cmd("UID FETCH 1 (FLAGS INTERNALDATE RFC822.SIZE)");
                assertThat(f.untagged()).containsExactly("* 1 FETCH (UID 1 FLAGS (\\Seen \\Draft) INTERNALDATE \"14-Nov-2026 10:00:00 -0700\" RFC822.SIZE " + d1.length + ")");
                c.send("p3 APPEND Drafts {3}\r\n");
                c.readLine();
                c.send("abc\r\n");
                assertThat(c.readTagged("p3").lines()).contains("* 3 EXISTS");
                c.send("big APPEND Drafts {70000000}\r\n");
                assertThat(c.readTagged("big").tagged()).isEqualTo("big NO [TOOBIG] Literal too large");
                assertThat(c.cmd("NOOP").ok()).isTrue();
            }
            List<FakeImapServer.Appended> seen = s.appended(USER);
            assertThat(seen).hasSize(3);
            assertThat(seen.get(0).folder()).isEqualTo("Drafts");
            assertThat(seen.get(0).uid()).isEqualTo(1);
            assertThat(seen.get(0).flags()).containsExactly("\\Seen", "\\Draft");
            assertThat(seen.get(0).internalDate()).isEqualTo(Instant.parse("2026-11-14T17:00:00Z"));
            assertThat(seen.get(0).bytes()).isEqualTo(d1);
            assertThat(seen.get(1).bytes()).isEqualTo(d2);
        }
    }

    // ---- FETCH ----

    @Test
    void fetchServesExactBytesSectionsAndSequenceSets() throws Exception {
        try (FakeImapServer s = server(Options.defaults())) {
            byte[] m = ("Received: from x\r\nMessage-ID: <f1@example.com>\r\nSubject: a long\r\n subject\r\nX-Note: n\r\n\r\nbody line\r\n.\r\n")
                .getBytes(StandardCharsets.UTF_8);
            s.deliver(USER, "INBOX", m, Set.of(), Instant.parse("2026-11-03T04:05:06Z"));
            for (int i = 2; i <= 5; i++) {
                s.deliver(USER, msg("f" + i, "n" + i, "x"));
            }
            try (RawImap c = login(s)) {
                c.cmd("SELECT INBOX (CONDSTORE)");
                assertThat(c.cmd("UID FETCH 1 (UID RFC822.SIZE INTERNALDATE FLAGS)").untagged())
                    .containsExactly("* 1 FETCH (UID 1 RFC822.SIZE " + m.length + " INTERNALDATE \"03-Nov-2026 04:05:06 +0000\" FLAGS () MODSEQ ("
                        + s.messages(USER, "INBOX").get(0).modSeq() + "))");
                String ids = c.cmd("UID FETCH 1 (BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)])").lines().get(0);
                assertThat(RawImap.literal(ids, "BODY[HEADER.FIELDS (MESSAGE-ID)]")).isEqualTo("Message-ID: <f1@example.com>\r\n\r\n".getBytes(StandardCharsets.UTF_8));
                String subj = c.cmd("UID FETCH 1 (BODY.PEEK[HEADER.FIELDS (Subject X-Note)])").lines().get(0);
                assertThat(new String(RawImap.literal(subj, "BODY[HEADER.FIELDS (Subject X-Note)]"), StandardCharsets.UTF_8))
                    .isEqualTo("Subject: a long\r\n subject\r\nX-Note: n\r\n\r\n");
                String not = c.cmd("UID FETCH 1 (BODY.PEEK[HEADER.FIELDS.NOT (Received Subject)])").lines().get(0);
                assertThat(new String(RawImap.literal(not, "BODY[HEADER.FIELDS.NOT (Received Subject)]"), StandardCharsets.UTF_8))
                    .isEqualTo("Message-ID: <f1@example.com>\r\nX-Note: n\r\n\r\n");
                String all = c.cmd("UID FETCH 1 BODY.PEEK[]").lines().get(0);
                assertThat(RawImap.literal(all, "BODY[]")).isEqualTo(m);
                String header = c.cmd("UID FETCH 1 BODY.PEEK[HEADER]").lines().get(0);
                assertThat(new String(RawImap.literal(header, "BODY[HEADER]"), StandardCharsets.UTF_8)).endsWith("X-Note: n\r\n\r\n").startsWith("Received:");
                String text = c.cmd("UID FETCH 1 BODY.PEEK[TEXT]").lines().get(0);
                assertThat(new String(RawImap.literal(text, "BODY[TEXT]"), StandardCharsets.UTF_8)).isEqualTo("body line\r\n.\r\n");
                String part = c.cmd("UID FETCH 1 BODY.PEEK[]<10.4>").lines().get(0);
                assertThat(new String(RawImap.literal(part, "BODY[]<10>"), StandardCharsets.UTF_8)).isEqualTo("from");
                String past = c.cmd("UID FETCH 1 BODY.PEEK[]<100000.4>").lines().get(0);
                assertThat(RawImap.literal(past, "BODY[]<100000>")).isEmpty();
                assertThat(s.messages(USER, "INBOX").get(0).flags()).isEmpty();
                long before = s.messages(USER, "INBOX").get(0).modSeq();
                String seen = c.cmd("FETCH 1 BODY[]").lines().get(0);
                long after = s.messages(USER, "INBOX").get(0).modSeq();
                assertThat(after).isGreaterThan(before);
                assertThat(seen).endsWith(" FLAGS (\\Seen) MODSEQ (" + after + "))");
                assertThat(RawImap.literal(seen, "BODY[]")).isEqualTo(m);

                assertThat(c.cmd("FETCH 3:1 (UID)").untagged()).containsExactly("* 1 FETCH (UID 1)", "* 2 FETCH (UID 2)", "* 3 FETCH (UID 3)");
                assertThat(c.cmd("FETCH 2,4:* (UID)").untagged()).containsExactly("* 2 FETCH (UID 2)", "* 4 FETCH (UID 4)", "* 5 FETCH (UID 5)");
                assertThat(c.cmd("UID FETCH 100:* (FLAGS)").untagged()).hasSize(1).allMatch(l -> l.startsWith("* 5 FETCH (UID 5 "));
                assertThat(c.cmd("FETCH 9 (UID)").tagged()).contains(" BAD ");
                assertThat(c.cmd("FETCH 1 (ENVELOPE)").tagged()).contains(" BAD ");
                assertThat(c.cmd("FETCH 1 (BODY.PEEK[1])").tagged()).contains(" BAD ");
                assertThat(c.cmd("EXAMINE INBOX").tagged()).endsWith("OK [READ-ONLY] EXAMINE completed.");
                assertThat(c.cmd("STORE 1 +FLAGS (\\Flagged)").tagged()).contains("NO [READ-ONLY]");
                c.cmd("FETCH 2 BODY[]");
                assertThat(s.messages(USER, "INBOX").get(1).flags()).isEmpty();
            }
        }
    }

    // ---- SEARCH ----

    @Test
    void searchAndEsearch() throws Exception {
        try (FakeImapServer s = server(Options.defaults())) {
            for (int i = 1; i <= 5; i++) {
                Set<String> flags = i == 2 ? Set.of("\\Seen") : i == 3 ? Set.of("\\Deleted") : Set.of();
                s.deliver(USER, "INBOX", msg("m" + i, "subject " + i, "body " + i), flags, Instant.parse("2026-11-" + (9 + i) + "T12:00:00Z"));
            }
            try (RawImap c = login(s)) {
                c.cmd("SELECT INBOX");
                assertThat(c.cmd("UID SEARCH SINCE 12-Nov-2026").lines().get(0)).isEqualTo("* SEARCH 3 4 5");
                assertThat(c.cmd("UID SEARCH BEFORE \"12-Nov-2026\"").lines().get(0)).isEqualTo("* SEARCH 1 2");
                assertThat(c.cmd("UID SEARCH HEADER Message-ID \"<m4@example.com>\"").lines().get(0)).isEqualTo("* SEARCH 4");
                assertThat(c.cmd("UID SEARCH NOT DELETED UNSEEN").lines().get(0)).isEqualTo("* SEARCH 1 4 5");
                assertThat(c.cmd("UID SEARCH UID 2:4 NOT DELETED").lines().get(0)).isEqualTo("* SEARCH 2 4");
                assertThat(c.cmd("SEARCH OR SEEN DELETED").lines().get(0)).isEqualTo("* SEARCH 2 3");
                assertThat(c.cmd("SEARCH CHARSET UTF-8 SUBJECT \"subject 5\"").lines().get(0)).isEqualTo("* SEARCH 5");
                assertThat(c.cmd("SEARCH 2:3 (UNSEEN)").lines().get(0)).isEqualTo("* SEARCH 3");
                Reply es = c.cmd("UID SEARCH RETURN (ALL MIN MAX COUNT) NOT DELETED");
                assertThat(es.lines().get(0)).isEqualTo("* ESEARCH (TAG \"" + es.tag() + "\") UID ALL 1:2,4:5 MIN 1 MAX 5 COUNT 4");
                Reply count = c.cmd("SEARCH RETURN (COUNT) DELETED");
                assertThat(count.lines().get(0)).isEqualTo("* ESEARCH (TAG \"" + count.tag() + "\") COUNT 1");
                Reply none = c.cmd("UID SEARCH RETURN () SINCE 1-Jan-2030");
                assertThat(none.lines().get(0)).isEqualTo("* ESEARCH (TAG \"" + none.tag() + "\") UID");
                assertThat(c.cmd("SEARCH CHARSET KOI8-R ALL").tagged()).contains("NO [BADCHARSET");
                assertThat(c.cmd("SEARCH FOO").tagged()).contains(" BAD ");
            }
        }
    }

    // ---- UIDVALIDITY ----

    @Test
    void aUidValidityResetRenumbersAndSaysBye() throws Exception {
        try (FakeImapServer s = server(Options.defaults())) {
            for (int i = 1; i <= 3; i++) {
                s.deliver(USER, msg("u" + i, "n" + i, "x"));
            }
            s.expunge(USER, "INBOX", 1);
            long old = s.folder(USER, "INBOX").uidValidity();
            try (RawImap a = login(s)) {
                a.cmd("SELECT INBOX");
                long fresh = s.resetUidValidity(USER, "INBOX");
                assertThat(fresh).isNotEqualTo(old);
                assertThat(a.readLine()).isEqualTo("* BYE Mailbox UIDVALIDITY changed");
                assertThat(a.closedByServer()).isTrue();
                try (RawImap b = login(s)) {
                    Reply sel = b.cmd("SELECT INBOX");
                    assertThat(sel.lines()).contains("* OK [UIDVALIDITY " + fresh + "] UIDs valid", "* OK [UIDNEXT 3] Predicted next UID", "* 2 EXISTS");
                    List<String> lines = b.cmd("UID FETCH 1:* (BODY.PEEK[])").untagged();
                    assertThat(lines).hasSize(2);
                    assertThat(RawImap.literal(lines.get(0), "BODY[]")).isEqualTo(msg("u2", "n2", "x"));
                    assertThat(lines.get(1)).startsWith("* 2 FETCH (UID 2 ");
                }
            }
        }
    }

    // ---- Gmail ----

    @Test
    void gmailModeHasLabelsAndMoveKeepsTheMessageId() throws Exception {
        try (FakeImapServer s = server(Options.gmail())) {
            long uid = s.deliver(USER, "[Gmail]/All Mail", msg("g1", "hello", "x"), Set.of(), null);
            assertThat(uid).isEqualTo(1);
            FakeImapServer.Message m = s.messages(USER, "[Gmail]/All Mail").get(0);
            assertThat(m.labels()).containsExactly("\\Inbox");
            assertThat(s.messages(USER, "INBOX")).hasSize(1);
            try (RawImap c = login(s)) {
                assertThat(c.greeting).contains("X-GM-EXT-1");
                assertThat(c.cmd("LIST \"\" \"*\"").untagged()).containsExactly(
                    "* LIST (\\HasNoChildren) \"/\" INBOX",
                    "* LIST (\\HasChildren \\Noselect) \"/\" \"[Gmail]\"",
                    "* LIST (\\HasNoChildren \\All) \"/\" \"[Gmail]/All Mail\"",
                    "* LIST (\\HasNoChildren \\Drafts) \"/\" \"[Gmail]/Drafts\"",
                    "* LIST (\\HasNoChildren \\Important) \"/\" \"[Gmail]/Important\"",
                    "* LIST (\\HasNoChildren \\Sent) \"/\" \"[Gmail]/Sent Mail\"",
                    "* LIST (\\HasNoChildren \\Junk) \"/\" \"[Gmail]/Spam\"",
                    "* LIST (\\HasNoChildren \\Flagged) \"/\" \"[Gmail]/Starred\"",
                    "* LIST (\\HasNoChildren \\Trash) \"/\" \"[Gmail]/Trash\"");
                c.cmd("ENABLE QRESYNC");
                c.cmd("SELECT \"[Gmail]/All Mail\"");
                assertThat(c.cmd("UID FETCH 1 (X-GM-MSGID X-GM-THRID X-GM-LABELS)").untagged())
                    .containsExactly("* 1 FETCH (UID 1 X-GM-MSGID " + m.gmMsgId() + " X-GM-THRID " + m.gmMsgId() + " X-GM-LABELS (\"\\\\Inbox\"))");
                Reply add = c.cmd("UID STORE 1 +X-GM-LABELS (Work \"My Label\")");
                long ms = s.messages(USER, "[Gmail]/All Mail").get(0).modSeq();
                assertThat(ms).isGreaterThan(m.modSeq());
                assertThat(add.untagged()).containsExactly("* 1 FETCH (UID 1 X-GM-LABELS (\"\\\\Inbox\" Work \"My Label\") MODSEQ (" + ms + "))");
                assertThat(s.folders(USER)).extracting(FakeImapServer.Folder::name).contains("Work", "My Label");
                assertThat(s.messages(USER, "Work")).hasSize(1);
                c.cmd("UID STORE 1 -X-GM-LABELS (\\Inbox)");
                assertThat(s.messages(USER, "INBOX")).isEmpty();
                assertThat(c.cmd("UID SEARCH X-GM-LABELS Work").lines().get(0)).isEqualTo("* SEARCH 1");
                assertThat(c.cmd("UID SEARCH X-GM-MSGID " + m.gmMsgId()).lines().get(0)).isEqualTo("* SEARCH 1");
                long trash = s.folder(USER, "[Gmail]/Trash").uidValidity();
                Reply mv = c.cmd("UID MOVE 1 \"[Gmail]/Trash\"");
                assertThat(mv.untagged()).containsExactly("* OK [COPYUID " + trash + " 1 1] Moved UIDs.", "* VANISHED 1");
                assertThat(s.messages(USER, "[Gmail]/All Mail")).isEmpty();
                assertThat(s.messages(USER, "Work")).isEmpty();
                FakeImapServer.Message inTrash = s.messages(USER, "[Gmail]/Trash").get(0);
                assertThat(inTrash.gmMsgId()).isEqualTo(m.gmMsgId());
                assertThat(inTrash.labels()).containsExactly("Work", "My Label");
                c.cmd("SELECT \"[Gmail]/Trash\"");
                assertThat(c.cmd("UID FETCH 1 (X-GM-MSGID)").untagged()).containsExactly("* 1 FETCH (UID 1 X-GM-MSGID " + m.gmMsgId() + ")");
            }
            long back = s.move(USER, "[Gmail]/Trash", 1, "[Gmail]/All Mail");
            assertThat(back).isEqualTo(2);
            assertThat(s.messages(USER, "[Gmail]/All Mail").get(0).gmMsgId()).isEqualTo(m.gmMsgId());
            assertThat(s.messages(USER, "Work")).hasSize(1);
            s.labels(USER, back, "\\Important");
            assertThat(s.messages(USER, "[Gmail]/Important")).hasSize(1);
            assertThat(s.messages(USER, "Work")).isEmpty();
            s.setFlags(USER, "[Gmail]/All Mail", back, Set.of("\\Flagged", "\\Seen"));
            assertThat(s.messages(USER, "[Gmail]/All Mail").get(0).labels()).containsExactlyInAnyOrder("\\Important", "\\Starred");
            assertThat(s.messages(USER, "[Gmail]/Starred")).hasSize(1);
            long spam = s.deliver(USER, "[Gmail]/Spam", msg("g2", "buy", "x"), Set.of(), null);
            assertThat(spam).isEqualTo(1);
            assertThat(s.messages(USER, "[Gmail]/All Mail")).hasSize(1);
            assertThat(s.messages(USER, "[Gmail]/Spam").get(0).gmMsgId()).isNotEqualTo(m.gmMsgId());
            s.expunge(USER, "[Gmail]/Spam", 1);
            assertThat(s.messages(USER, "[Gmail]/Spam")).isEmpty();
        }
    }

    // ---- faults ----

    @Test
    void dropAndByeEndConnections() throws Exception {
        try (FakeImapServer s = server(Options.defaults())) {
            try (RawImap a = login(s); RawImap b = login(s)) {
                s.dropConnections();
                assertThat(a.closedByServer()).isTrue();
                assertThat(b.closedByServer()).isTrue();
            }
            try (RawImap a = login(s)) {
                a.cmd("SELECT INBOX");
                s.byeConnections("[UNAVAILABLE] Maintenance");
                assertThat(a.readLine()).isEqualTo("* BYE [UNAVAILABLE] Maintenance");
                assertThat(a.closedByServer()).isTrue();
            }
            assertThat(s.connectionsOpened()).isEqualTo(3);
        }
    }

    @Test
    void failNextAndFailLogin() throws Exception {
        try (FakeImapServer s = server(Options.defaults())) {
            s.deliver(USER, msg("m1", "n", "x"));
            s.failLogin("NO [ALERT] Application-specific password required");
            try (RawImap a = RawImap.connect(s.port())) {
                assertThat(a.cmd("LOGIN \"" + USER + "\" " + PW).tagged()).endsWith("NO [ALERT] Application-specific password required");
                s.failLogin("NO [AUTHENTICATIONFAILED] Invalid credentials", 1);
                assertThat(a.cmd("LOGIN \"" + USER + "\" " + PW).tagged()).endsWith("NO [AUTHENTICATIONFAILED] Invalid credentials");
                assertThat(a.cmd("LOGIN \"" + USER + "\" " + PW).ok()).isTrue();
                a.cmd("SELECT INBOX");
                s.failNext("UID FETCH", 2, "NO [THROTTLED] slow down");
                s.failNext("NOOP", 1, "BAD");
                assertThat(a.cmd("UID FETCH 1 (FLAGS)").tagged()).endsWith("NO [THROTTLED] slow down");
                assertThat(a.cmd("UID FETCH 1 (FLAGS)").tagged()).endsWith("NO [THROTTLED] slow down");
                assertThat(a.cmd("UID FETCH 1 (FLAGS)").ok()).isTrue();
                assertThat(a.cmd("NOOP").tagged()).endsWith(" BAD");
                assertThat(a.cmd("NOOP").ok()).isTrue();
                s.failNext("SELECT", 1, "NO [LIMIT] Too many");
                assertThat(a.cmd("SELECT INBOX").tagged()).endsWith("NO [LIMIT] Too many");
            }
            assertThat(s.commandCount("UID FETCH")).isEqualTo(3);
        }
    }

    @Test
    void delayCutIdleByeRefuseAndConnectionLimit() throws Exception {
        try (FakeImapServer s = server(Options.defaults())) {
            byte[] big = new byte[100_000];
            new SplittableRandom(7).nextBytes(big);
            for (int i = 0; i < big.length; i++) {
                big[i] = (byte) ('a' + Math.floorMod(big[i], 26));
            }
            s.deliver(USER, "INBOX", ("Subject: big\r\n\r\n" + new String(big, StandardCharsets.US_ASCII)).getBytes(StandardCharsets.US_ASCII), Set.of(), null);
            try (RawImap a = login(s)) {
                a.cmd("SELECT INBOX");
                s.delayResponses(Duration.ofMillis(300));
                long t0 = System.nanoTime();
                a.cmd("NOOP");
                assertThat(Duration.ofNanos(System.nanoTime() - t0)).isGreaterThanOrEqualTo(Duration.ofMillis(300));
                s.delayResponses(null);

                long served = s.bytesServed();
                s.cutAfterBytes(5_000);
                a.send("c1 UID FETCH 1 BODY.PEEK[]\r\n");
                byte[] got = a.readUntilClosed();
                assertThat(new String(got, StandardCharsets.US_ASCII)).startsWith("* 1 FETCH (UID 1 BODY[] {100016}\r\nSubject: big\r\n");
                assertThat(got).hasSize(5_000);
                assertThat(s.bytesServed() - served).isEqualTo(5_000);
            }
            try (RawImap a = login(s)) {
                s.idleByeAfter(Duration.ofMillis(200));
                a.send("i1 IDLE\r\n");
                assertThat(a.readLine()).isEqualTo("+ idling");
                assertThat(a.readLine()).isEqualTo("* BYE IDLE timed out");
                assertThat(a.closedByServer()).isTrue();
                s.idleByeAfter(null);
            }
            s.refuseConnections(Duration.ofSeconds(30));
            assertThatThrownBy(() -> new Socket(InetAddress.getLoopbackAddress(), s.port()).close()).isInstanceOf(ConnectException.class);
            s.acceptConnections();
            try (RawImap a = login(s)) {
                assertThat(a.cmd("NOOP").ok()).isTrue();
            }
            s.refuseConnections(Duration.ofMillis(200));
            assertThatThrownBy(() -> new Socket(InetAddress.getLoopbackAddress(), s.port()).close()).isInstanceOf(ConnectException.class);
            RawImap back = null;
            for (int i = 0; i < 100 && back == null; i++) {
                try {
                    back = login(s);
                } catch (ConnectException e) {
                    Thread.sleep(50);
                }
            }
            assertThat(back).isNotNull();
            back.close();

            s.maxConnectionsPerUser(1);
            try (RawImap a = login(s); RawImap b = RawImap.connect(s.port())) {
                b.send("l1 LOGIN \"" + USER + "\" " + PW + "\r\n");
                assertThat(b.readLine()).isEqualTo("* BYE Too many simultaneous connections");
                assertThat(b.closedByServer()).isTrue();
                assertThat(a.cmd("NOOP").ok()).isTrue();
            }
            s.clearFaults();
            try (RawImap a = login(s); RawImap b = login(s)) {
                assertThat(b.cmd("NOOP").ok()).isTrue();
            }
        }
    }

    @Test
    void closeExpungesQuietlyUnselectDoesntAndLongLinesEndTheConnection() throws Exception {
        try (FakeImapServer s = server(Options.defaults().maxLineLength(1_000))) {
            for (int i = 1; i <= 3; i++) {
                s.deliver(USER, "INBOX", msg("c" + i, "n" + i, "x"), Set.of("\\Deleted"), null);
            }
            try (RawImap c = login(s)) {
                c.cmd("SELECT INBOX");
                c.cmd("STORE 1 -FLAGS (\\Deleted)");
                Reply unselect = c.cmd("UNSELECT");
                assertThat(unselect.lines()).containsExactly(unselect.tag() + " OK Unselect completed.");
                assertThat(s.messages(USER, "INBOX")).hasSize(3);
                c.cmd("EXAMINE INBOX");
                c.cmd("CLOSE");
                assertThat(s.messages(USER, "INBOX")).hasSize(3);
                c.cmd("SELECT INBOX");
                Reply close = c.cmd("CLOSE");
                assertThat(close.lines()).containsExactly(close.tag() + " OK Close completed.");
                assertThat(s.messages(USER, "INBOX")).extracting(FakeImapServer.Message::uid).containsExactly(1L);
                assertThat(c.cmd("FETCH 1 (UID)").tagged()).contains("BAD No mailbox selected");
                c.send("a99 NOOP " + "x".repeat(2_000) + "\r\n");
                assertThat(c.readLine()).isEqualTo("* BYE Command line too long");
                assertThat(c.closedByServer()).isTrue();
            }
        }
    }

    @Test
    void servesOverImplicitTls() throws Exception {
        try (FakeImapServer s = server(Options.defaults().tls(true))) {
            s.deliver(USER, msg("t1", "secure", "x"));
            try (RawImap c = RawImap.connectTls(s.port())) {
                assertThat(c.greeting).startsWith("* OK [CAPABILITY");
                assertThat(c.cmd("LOGIN \"" + USER + "\" " + PW).ok()).isTrue();
                c.cmd("SELECT INBOX");
                assertThat(RawImap.literal(c.cmd("UID FETCH 1 BODY.PEEK[]").lines().get(0), "BODY[]")).isEqualTo(msg("t1", "secure", "x"));
            }
        }
    }

    // ---- a large lazy mailbox ----

    static byte[] lazyBytes(int i, int size) {
        byte[] head = ("Message-ID: <lazy" + i + "@example.com>\r\nSubject: lazy " + i + "\r\n\r\n").getBytes(StandardCharsets.US_ASCII);
        byte[] b = new byte[size];
        System.arraycopy(head, 0, b, 0, head.length);
        SplittableRandom r = new SplittableRandom(20261114L + i);
        for (int k = head.length; k < size; k++) {
            b[k] = (byte) ('a' + r.nextInt(26));
        }
        return b;
    }

    @Test
    void fiftyThousandLazyMessagesListFastInLittleHeap() throws Exception {
        int n = 50_000;
        int size = 20_000;
        try (FakeImapServer s = server(Options.defaults())) {
            AtomicInteger reads = new AtomicInteger();
            Instant when = Instant.parse("2026-11-01T00:00:00Z");
            long heapBefore = usedHeap();
            for (int i = 1; i <= n; i++) {
                int k = i;
                s.deliver(USER, "INBOX", size, () -> {
                    reads.incrementAndGet();
                    return lazyBytes(k, size);
                }, Set.of(), when);
            }
            long heapAfter = usedHeap();
            long grew = heapAfter - heapBefore;
            System.out.println("fake-imap: 50,000 lazy messages (" + (long) n * size / 1_000_000 + " MB of content) took " + grew / 1024 + " KiB of heap");
            assertThat(grew).isLessThan(64L * 1024 * 1024);
            try (RawImap c = login(s)) {
                assertThat(c.cmd("SELECT INBOX").lines()).contains("* " + n + " EXISTS");
                long t0 = System.nanoTime();
                Reply all = c.cmd("UID FETCH 1:* (UID RFC822.SIZE)");
                long ms = (System.nanoTime() - t0) / 1_000_000;
                System.out.println("fake-imap: UID FETCH 1:* (UID RFC822.SIZE) over 50,000 took " + ms + " ms");
                assertThat(all.untagged()).hasSize(n);
                assertThat(all.untagged().get(n - 1)).isEqualTo("* " + n + " FETCH (UID " + n + " RFC822.SIZE " + size + ")");
                assertThat(ms).isLessThan(30_000);
                assertThat(reads.get()).isZero();
                String one = c.cmd("UID FETCH 49999 BODY.PEEK[]").lines().get(0);
                assertThat(RawImap.literal(one, "BODY[]")).isEqualTo(lazyBytes(49_999, size));
                assertThat(reads.get()).isEqualTo(1);
                assertThat(c.cmd("UID SEARCH UID 49990:* NOT DELETED").lines().get(0)).startsWith("* SEARCH 49990 ");
            }
        }
    }

    private static long usedHeap() throws InterruptedException {
        Runtime rt = Runtime.getRuntime();
        for (int i = 0; i < 3; i++) {
            System.gc();
            Thread.sleep(50);
        }
        return rt.totalMemory() - rt.freeMemory();
    }
}
