package com.minimalistalliance.desk.courier.testkit;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.courier.testkit.MimeCorpus.Sample;
import jakarta.mail.Folder;
import jakarta.mail.Message;
import jakarta.mail.Session;
import jakarta.mail.Store;
import jakarta.mail.Transport;
import jakarta.mail.UIDFolder;
import jakarta.mail.internet.InternetAddress;
import jakarta.mail.internet.MimeMessage;
import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Properties;
import org.junit.jupiter.api.Test;

/** The fake provider round trips: SMTP in, IMAP out, corpus samples byte for byte, two users, folders, TLS, UIDVALIDITY. */
class FakeMailServerTest {

    @Test
    void mailSentThroughSmtpIsReadThroughImap() throws Exception {
        try (FakeMailServer server = FakeMailServer.start()) {
            server.addUser("alice@example.com", "alice", "pw-alice");
            Session session = Session.getInstance(props(server));
            MimeMessage m = new MimeMessage(session);
            m.setFrom(new InternetAddress("sender@example.org"));
            m.setRecipient(Message.RecipientType.TO, new InternetAddress("alice@example.com"));
            m.setSubject("Over SMTP", "UTF-8");
            m.setText("The words went through.", "UTF-8");
            Transport.send(m, "alice", "pw-alice");

            try (Store store = session.getStore("imap")) {
                store.connect("127.0.0.1", server.imapPort(), "alice", "pw-alice");
                Folder inbox = store.getFolder("INBOX");
                inbox.open(Folder.READ_ONLY);
                assertThat(inbox.getMessageCount()).isEqualTo(1);
                assertThat(inbox.getMessage(1).getSubject()).isEqualTo("Over SMTP");
                inbox.close(false);
            }
            List<byte[]> received = server.received("alice@example.com");
            assertThat(received).hasSize(1);
            String text = new String(received.get(0), StandardCharsets.UTF_8);
            assertThat(text).contains("Subject: Over SMTP").contains("The words went through.");
            System.out.println("greenmail: SMTP's first header line: " + text.substring(0, text.indexOf("\r\n")));
        }
    }

    @Test
    void everyHandWrittenSampleComesBackAsStored() throws Exception {
        try (FakeMailServer server = FakeMailServer.start()) {
            server.addUser("bob@example.com", "bob", "pw-bob");
            List<Sample> samples = MimeCorpus.handWritten();
            for (Sample s : samples) {
                server.deliver("bob@example.com", s.raw());
            }
            List<byte[]> received = server.received("bob@example.com");
            assertThat(received).hasSize(samples.size());
            List<byte[]> fetched = fetchAll(server, "bob", "pw-bob", "INBOX");
            assertThat(fetched).hasSize(samples.size());
            int exact = 0;
            List<String> changed = new ArrayList<>();
            for (int i = 0; i < samples.size(); i++) {
                Sample s = samples.get(i);
                byte[] stored = FakeMailServer.stored(s.raw());
                assertThat(received.get(i)).as(s.name() + " received").isEqualTo(stored);
                assertThat(fetched.get(i)).as(s.name() + " over IMAP").isEqualTo(stored);
                if (Arrays.equals(stored, s.raw())) {
                    exact++;
                } else {
                    changed.add(s.name());
                }
                if (canonicalHead(s.raw())) {
                    assertThat(stored).as(s.name() + " byte for byte").isEqualTo(s.raw());
                }
            }
            System.out.println("greenmail: " + exact + " of " + samples.size() + " hand-written samples byte for byte; changed: " + changed);
        }
    }

    @Test
    void generatedSamplesComeBackByteForByte() throws Exception {
        try (FakeMailServer server = FakeMailServer.start()) {
            List<Sample> samples = MimeCorpus.generated(MimeCorpus.DEFAULT_SEED, 300).filter(s -> !s.family().equals("mutation")).toList();
            for (Sample s : samples) {
                server.deliver("carol@example.net", s.raw());
            }
            List<byte[]> fetched = fetchAll(server, "carol@example.net", "carol@example.net", "INBOX");
            for (int i = 0; i < samples.size(); i++) {
                Sample s = samples.get(i);
                if (canonicalHead(s.raw())) {
                    assertThat(fetched.get(i)).as(s.name()).isEqualTo(s.raw());
                } else {
                    assertThat(fetched.get(i)).as(s.name()).isEqualTo(FakeMailServer.stored(s.raw()));
                }
            }
        }
    }

    @Test
    void twoUsersSeeOnlyTheirOwnMail() throws Exception {
        try (FakeMailServer server = FakeMailServer.start()) {
            server.addUser("alice@example.com", "alice", "pw-a");
            server.addUser("bob@example.com", "bob", "pw-b");
            List<Sample> hand = MimeCorpus.handWritten();
            server.deliver("alice@example.com", hand.get(0).raw());
            server.deliver("bob@example.com", hand.get(1).raw());
            server.deliver("bob@example.com", hand.get(2).raw());
            assertThat(fetchAll(server, "alice", "pw-a", "INBOX")).hasSize(1);
            assertThat(fetchAll(server, "bob", "pw-b", "INBOX")).hasSize(2);
            assertThat(server.received("alice@example.com")).hasSize(1);
            assertThat(server.received("bob@example.com")).hasSize(2);
            assertThat(server.received("nobody@example.com")).isEmpty();
        }
    }

    @Test
    void deliveryMakesTheFolderAndImapListsIt() throws Exception {
        try (FakeMailServer server = FakeMailServer.start()) {
            server.addUser("alice@example.com", "alice", "pw-a");
            Sample s = MimeCorpus.handWritten().get(0);
            server.deliver("alice@example.com", "Archive", s.raw());
            server.deliver("alice@example.com", s.raw());
            try (Store store = Session.getInstance(props(server)).getStore("imap")) {
                store.connect("127.0.0.1", server.imapPort(), "alice", "pw-a");
                List<String> names = new ArrayList<>();
                for (Folder f : store.getDefaultFolder().list("*")) {
                    names.add(f.getFullName());
                }
                assertThat(names).contains("INBOX", "Archive");
            }
            assertThat(fetchAll(server, "alice", "pw-a", "Archive")).singleElement().isEqualTo(FakeMailServer.stored(s.raw()));
            assertThat(server.received("alice@example.com")).hasSize(2);
        }
    }

    @Test
    void imapsWorksWithGreenMailsOwnCertificate() throws Exception {
        try (FakeMailServer server = FakeMailServer.start()) {
            server.addUser("alice@example.com", "alice", "pw-a");
            server.deliver("alice@example.com", MimeCorpus.handWritten().get(0).raw());
            Properties p = props(server);
            p.setProperty("mail.imaps.ssl.trust", "*");
            p.setProperty("mail.imaps.ssl.checkserveridentity", "false");
            try (Store store = Session.getInstance(p).getStore("imaps")) {
                store.connect("127.0.0.1", server.imapsPort(), "alice", "pw-a");
                Folder inbox = store.getFolder("INBOX");
                inbox.open(Folder.READ_ONLY);
                assertThat(inbox.getMessageCount()).isEqualTo(1);
                inbox.close(false);
            }
            assertThat(server.smtpsPort()).isPositive().isNotEqualTo(server.smtpPort());
        }
    }

    @Test
    void uidValidityCanBeReset() throws Exception {
        try (FakeMailServer server = FakeMailServer.start()) {
            server.addUser("alice@example.com", "alice", "pw-a");
            List<Sample> hand = MimeCorpus.handWritten();
            server.deliver("alice@example.com", hand.get(0).raw());
            server.deliver("alice@example.com", "Archive", hand.get(1).raw());
            long inboxBefore = uidValidity(server, "INBOX");
            long archiveBefore = uidValidity(server, "Archive");
            long archiveAfter = server.resetUidValidity("alice@example.com", "Archive");
            assertThat(archiveAfter).isGreaterThan(archiveBefore).isEqualTo(uidValidity(server, "Archive"));
            assertThat(uidValidity(server, "INBOX")).isEqualTo(inboxBefore);
            long inboxAfter = server.resetUidValidity("alice@example.com", "INBOX");
            assertThat(inboxAfter).isGreaterThan(inboxBefore).isEqualTo(uidValidity(server, "INBOX"));
            assertThat(fetchAll(server, "alice", "pw-a", "INBOX")).singleElement().isEqualTo(FakeMailServer.stored(hand.get(0).raw()));
            assertThat(fetchAll(server, "alice", "pw-a", "Archive")).singleElement().isEqualTo(FakeMailServer.stored(hand.get(1).raw()));
        }
    }

    /**
     * What GreenMail's IMAP says it does, and doesn't: no CONDSTORE or QRESYNC in CAPABILITY, ENABLE refused, and a SELECT
     * asking for CONDSTORE gets no HIGHESTMODSEQ. The README quotes what this prints.
     */
    @Test
    void noCondstoreOrQresync() throws Exception {
        try (FakeMailServer server = FakeMailServer.start()) {
            server.addUser("alice@example.com", "alice", "pw-a");
            server.deliver("alice@example.com", MimeCorpus.handWritten().get(0).raw());
            try (Socket socket = new Socket("127.0.0.1", server.imapPort())) {
                socket.setSoTimeout(10_000);
                BufferedReader in = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.ISO_8859_1));
                OutputStream out = socket.getOutputStream();
                String greeting = in.readLine();
                List<String> capability = command(in, out, "a1 CAPABILITY");
                List<String> login = command(in, out, "a2 LOGIN alice pw-a");
                List<String> enable = command(in, out, "a3 ENABLE CONDSTORE QRESYNC");
                List<String> select = command(in, out, "a4 SELECT INBOX (CONDSTORE)");
                List<String> plainSelect = command(in, out, "a5 SELECT INBOX");
                List<String> modseq = command(in, out, "a6 FETCH 1 (UID MODSEQ)");
                List<String> changedSince = command(in, out, "a7 UID FETCH 1:* (FLAGS) (CHANGEDSINCE 1)");
                command(in, out, "a8 LOGOUT");
                System.out.println("greenmail: greeting " + greeting);
                for (List<String> r : List.of(capability, login, enable, select, plainSelect, modseq, changedSince)) {
                    System.out.println("greenmail: " + r);
                }
                String caps = String.join(" ", capability).toUpperCase();
                assertThat(caps).contains("IMAP4REV1").doesNotContain("CONDSTORE").doesNotContain("QRESYNC").doesNotContain("ENABLE");
                assertThat(last(login)).startsWith("a2 OK");
                assertThat(last(enable)).doesNotStartWith("a3 OK");
                assertThat(String.join(" ", select).toUpperCase()).doesNotContain("HIGHESTMODSEQ");
                assertThat(String.join(" ", plainSelect).toUpperCase()).doesNotContain("HIGHESTMODSEQ").contains("UIDVALIDITY");
                assertThat(String.join(" ", modseq).toUpperCase()).doesNotContain("MODSEQ (");
                assertThat(last(changedSince)).doesNotStartWith("a7 OK");
            }
        }
    }

    private static List<String> command(BufferedReader in, OutputStream out, String line) throws Exception {
        out.write((line + "\r\n").getBytes(StandardCharsets.US_ASCII));
        out.flush();
        String tag = line.substring(0, line.indexOf(' '));
        List<String> lines = new ArrayList<>();
        for (String l = in.readLine(); l != null; l = in.readLine()) {
            lines.add(l);
            if (l.startsWith(tag + " ")) {
                break;
            }
        }
        return lines;
    }

    private static String last(List<String> lines) {
        return lines.get(lines.size() - 1);
    }

    private static long uidValidity(FakeMailServer server, String folder) throws Exception {
        try (Store store = Session.getInstance(props(server)).getStore("imap")) {
            store.connect("127.0.0.1", server.imapPort(), "alice", "pw-a");
            Folder f = store.getFolder(folder);
            f.open(Folder.READ_ONLY);
            long v = ((UIDFolder) f).getUIDValidity();
            f.close(false);
            return v;
        }
    }

    /** Every message's raw bytes as IMAP serves them (BODY.PEEK[]), in UID order. */
    static List<byte[]> fetchAll(FakeMailServer server, String login, String password, String folder) throws Exception {
        try (Store store = Session.getInstance(props(server)).getStore("imap")) {
            store.connect("127.0.0.1", server.imapPort(), login, password);
            Folder f = store.getFolder(folder);
            f.open(Folder.READ_ONLY);
            List<byte[]> out = new ArrayList<>();
            for (Message m : f.getMessages()) {
                ByteArrayOutputStream b = new ByteArrayOutputStream();
                m.writeTo(b);
                out.add(b.toByteArray());
            }
            f.close(false);
            return out;
        }
    }

    static Properties props(FakeMailServer server) {
        Properties p = new Properties();
        p.setProperty("mail.smtp.host", "127.0.0.1");
        p.setProperty("mail.smtp.port", Integer.toString(server.smtpPort()));
        p.setProperty("mail.smtp.auth", "true");
        p.setProperty("mail.imap.connectiontimeout", "10000");
        p.setProperty("mail.imap.timeout", "10000");
        p.setProperty("mail.imap.partialfetch", "false");
        p.setProperty("mail.imap.peek", "true");
        return p;
    }

    /** A head with CRLF line ends only and a blank line after it: what GreenMail keeps byte for byte. */
    static boolean canonicalHead(byte[] raw) {
        String s = new String(raw, StandardCharsets.ISO_8859_1);
        int end = s.indexOf("\r\n\r\n");
        if (end < 0) {
            return false;
        }
        String head = s.substring(0, end + 2);
        return head.replace("\r\n", "").indexOf('\r') < 0 && head.replace("\r\n", "").indexOf('\n') < 0;
    }
}
