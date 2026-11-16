package com.minimalistalliance.desk.deskd.courier.linked;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Random;
import org.junit.jupiter.api.Test;

/** The response reader against what servers send, and against what a hostile one could. */
class ImapReaderTest {

    private static ImapReader reader(String s) {
        return new ImapReader(new ByteArrayInputStream(s.getBytes(StandardCharsets.ISO_8859_1)), 1 << 20, 1 << 20);
    }

    private static ImapReader reader(byte[] b, int maxLine, int maxLiteral) {
        return new ImapReader(new ByteArrayInputStream(b), maxLine, maxLiteral);
    }

    @Test
    void statusResponsesKeepTheirCodeAndArguments() throws Exception {
        ImapReader r = reader("* OK [UIDVALIDITY 3857529045] UIDs valid\r\n* OK [PERMANENTFLAGS (\\Deleted \\Seen \\*)] Limited\r\n"
                + "A1 OK [COPYUID 38505 304,319:320 3956:3958] Done\r\n* NO [ALERT] Application-specific password required\r\n");
        ImapReader.Response a = r.read();
        assertThat(a.status()).isEqualTo("OK");
        assertThat(a.code()).isEqualTo("UIDVALIDITY");
        assertThat(a.codeArgs()).containsExactly("3857529045");
        ImapReader.Response b = r.read();
        assertThat(b.code()).isEqualTo("PERMANENTFLAGS");
        assertThat(b.codeArgs().get(0)).isEqualTo(List.of("\\Deleted", "\\Seen", "\\*"));
        ImapReader.Response c = r.read();
        assertThat(c.tag()).isEqualTo("A1");
        assertThat(c.codeArgs()).containsExactly("38505", "304,319:320", "3956:3958");
        ImapReader.Response d = r.read();
        assertThat(d.status()).isEqualTo("NO");
        assertThat(d.code()).isEqualTo("ALERT");
    }

    @Test
    void fetchWithLiteralsSectionsAndGmailAttributes() throws Exception {
        String body = "Message-ID: <a@b>\r\n\r\n";
        String s = "* 12 FETCH (UID 4827313 FLAGS (\\Seen $Forwarded) MODSEQ (624140003) RFC822.SIZE 44827 INTERNALDATE \" 7-Feb-2026 21:52:25 -0800\""
                + " BODY[HEADER.FIELDS (MESSAGE-ID)] {" + body.length() + "}\r\n" + body
                + " X-GM-MSGID 1278455344230334865 X-GM-LABELS (\\Inbox \"Work/2026\" \\Sent))\r\n";
        ImapClient.FetchData f = ImapClient.fetchData(reader(s).read());
        assertThat(f.seq()).isEqualTo(12);
        assertThat(f.uid()).isEqualTo(4827313);
        assertThat(f.seen()).isTrue();
        assertThat(f.modseq()).isEqualTo(624140003);
        assertThat(f.size()).isEqualTo(44827);
        assertThat(f.internalDate()).isEqualTo(java.time.Instant.parse("2026-02-08T05:52:25Z").toEpochMilli());
        assertThat(new String(f.header(), StandardCharsets.US_ASCII)).isEqualTo(body);
        assertThat(MailboxSync.headerValue(f.header())).isEqualTo("<a@b>");
        assertThat(f.gmMsgId()).isEqualTo("1278455344230334865");
        assertThat(f.gmLabels()).containsExactly("\\Inbox", "Work/2026", "\\Sent");
    }

    @Test
    void vanishedEsearchListAndNil() throws Exception {
        ImapReader r = reader("* VANISHED (EARLIER) 41,43:116,118\r\n* ESEARCH (TAG \"C5\") UID ALL 1:3,7\r\n"
                + "* LIST (\\HasNoChildren \\Junk) \"/\" \"Junk\"\r\n* LIST (\\Noselect) NIL \"[Gmail]\"\r\n");
        ImapReader.Response v = r.read();
        assertThat(v.kind()).isEqualTo("VANISHED");
        assertThat((long[]) v.items().get(2)).hasSize(1 + 74 + 1).startsWith(41, 43, 44).endsWith(116, 118);
        ImapReader.Response e = r.read();
        assertThat(e.kind()).isEqualTo("ESEARCH");
        assertThat((long[]) e.items().get(4)).containsExactly(1, 2, 3, 7);
        ImapReader.Response l = r.read();
        assertThat(ImapReader.text(l.items().get(3))).isEqualTo("Junk");
        assertThat(r.read().items().get(2)).isSameAs(ImapReader.NIL);
    }

    @Test
    void searchNumbersComeAsOneArray() throws Exception {
        ImapReader r = reader("* SEARCH 4 9 12 (MODSEQ 917162500)\r\n* SEARCH\r\n");
        ImapReader.Response a = r.read();
        assertThat(a.kind()).isEqualTo("SEARCH");
        assertThat((long[]) a.items().get(1)).containsExactly(4, 9, 12);
        assertThat(a.items().get(2)).isEqualTo(List.of("MODSEQ", "917162500"));
        assertThat((long[]) r.read().items().get(1)).isEmpty();
        // ESEARCH's MODSEQ is a 63-bit number, read as an item, not a UID (Security's CI-I5).
        ImapReader.Response m = reader("* ESEARCH (TAG \"A1\") UID ALL 1:3 MODSEQ 9223372036854775000\r\n").read();
        assertThat((long[]) m.items().get(4)).containsExactly(1, 2, 3);
        assertThat(m.items().get(6)).isEqualTo("9223372036854775000");
        // A UID line may run past an ordinary line's bound: 300,000 UIDs one by one, about 2 MB, against a 1 MiB line.
        StringBuilder b = new StringBuilder("* SEARCH");
        for (int i = 1; i <= 300_000; i++) {
            b.append(' ').append(i);
        }
        ImapReader big = reader((b + "\r\n").getBytes(StandardCharsets.US_ASCII), 1 << 20, 1 << 20);
        big.allow(64L << 20);
        assertThat((long[]) big.read().items().get(1)).hasSize(300_000);
    }

    /** Security's CI-M1: answers inside every byte limit that would still have made millions of objects. */
    @Test
    void aServersAnswersCantOutgrowTheirBudgetsInObjects() throws Exception {
        // ESEARCH and VANISHED sets: every UID they name counts against the command's 2 million, across lines.
        StringBuilder sets = new StringBuilder();
        for (int i = 0; i < 10; i++) {
            sets.append("* ESEARCH ALL 1:400000\r\n");
        }
        ImapReader es = reader(sets.toString().getBytes(StandardCharsets.US_ASCII), 1 << 20, 1 << 20);
        es.allow(1 << 20);
        for (int i = 0; i < 5; i++) {
            assertThat((long[]) es.read().items().get(2)).hasSize(400_000);
        }
        assertThatThrownBy(es::read).isInstanceOf(ImapException.TooLarge.class);
        ImapReader vanished = reader("* VANISHED 1:4294967295\r\n".getBytes(StandardCharsets.US_ASCII), 1 << 20, 1 << 20);
        vanished.allow(1 << 20);
        assertThatThrownBy(vanished::read).isInstanceOf(ImapException.TooLarge.class);
        // The next command starts a fresh budget.
        ImapReader again = reader("* ESEARCH ALL 1:2000000\r\n* ESEARCH ALL 1:2000000\r\n".getBytes(StandardCharsets.US_ASCII), 1 << 20, 1 << 20);
        again.allow(1 << 20);
        assertThat((long[]) again.read().items().get(2)).hasSize(2_000_000);
        again.allow(1 << 20);
        assertThat((long[]) again.read().items().get(2)).hasSize(2_000_000);
        // A literal is held as its bytes arrive: a header naming 60 MB that sends 10 bytes ends at the stream's end, holding 64 KiB.
        ImapReader lit = reader("* 1 FETCH (BODY[] {60000000}\r\n0123456789".getBytes(StandardCharsets.US_ASCII), 1 << 20, 64 << 20);
        lit.allow(64L << 20);
        lit.allowLiterals(64L << 20);
        assertThatThrownBy(lit::read).isInstanceOf(java.io.EOFException.class);
        // A command that asks for no message takes no literal past 1 MiB, whatever its allowance.
        ImapReader flags = reader("* 1 FETCH (UID 1 BODY[] {2000000}\r\n".getBytes(StandardCharsets.US_ASCII), 1 << 20, 64 << 20);
        flags.allow(64L << 20);
        assertThatThrownBy(flags::read).isInstanceOf(ImapException.TooLarge.class);
        // Items on one line: past 100,000, even inside the line's bytes.
        ImapReader items = reader(("* 1 FETCH (" + "a ".repeat(150_000) + ")\r\n").getBytes(StandardCharsets.US_ASCII), 1 << 20, 1 << 20);
        items.allow(64L << 20);
        assertThatThrownBy(items::read).isInstanceOf(ImapException.TooLarge.class);
        ImapReader empties = reader(("* 1 FETCH (" + "()".repeat(120_000) + ")\r\n").getBytes(StandardCharsets.US_ASCII), 1 << 20, 1 << 20);
        empties.allow(64L << 20);
        assertThatThrownBy(empties::read).isInstanceOf(ImapException.TooLarge.class);
        // An ordinary line past 1 MiB.
        ImapReader line = reader(("* 1 FETCH (X " + "y".repeat(2 << 20) + ")\r\n").getBytes(StandardCharsets.US_ASCII), 1 << 20, 1 << 20);
        line.allow(64L << 20);
        assertThatThrownBy(line::read).isInstanceOf(ImapException.TooLarge.class);
        // FETCH responses a command keeps: 100,000, and 16 MiB of them as estimated (CI-M1b).
        ImapReader kept = reader("".getBytes(StandardCharsets.US_ASCII), 1 << 20, 1 << 20);
        kept.allow(1);
        for (int i = 0; i < ImapReader.MAX_FETCHES; i++) {
            kept.chargeFetch(0);
        }
        assertThatThrownBy(() -> kept.chargeFetch(0)).isInstanceOf(ImapException.TooLarge.class);
        kept.allow(1);
        kept.chargeFetch(ImapReader.MAX_KEPT_BYTES);
        assertThatThrownBy(() -> kept.chargeFetch(1)).isInstanceOf(ImapException.TooLarge.class);
        // COPYUID's sets count too.
        assertThatThrownBy(() -> UidSet.parseOrdered("1:3000000", 2_000_000)).isInstanceOf(ImapException.class);
        assertThatThrownBy(() -> UidSet.parseOrdered("1:1000", 999)).isInstanceOf(ImapException.TooLarge.class);
    }

    @Test
    void quotedStringsUnescape() throws Exception {
        ImapReader.Response r = reader("* LIST () \"/\" \"a \\\"quoted\\\" \\\\name\"\r\n").read();
        assertThat(ImapReader.text(r.items().get(3))).isEqualTo("a \"quoted\" \\name");
    }

    @Test
    void sizesAreBoundedBeforeAnythingIsAllocated() {
        // A literal larger than allowed.
        assertThatThrownBy(() -> reader("* 1 FETCH (BODY[] {999999999}\r\n".getBytes(StandardCharsets.US_ASCII), 1 << 20, 1 << 20).read())
                .isInstanceOf(ImapException.TooLarge.class);
        // A literal within the cap but past what this command may bring.
        ImapReader r = reader("* 1 FETCH (BODY[] {5000}\r\n".getBytes(StandardCharsets.US_ASCII), 1 << 20, 1 << 20);
        r.allow(1000);
        assertThatThrownBy(r::read).isInstanceOf(ImapException.TooLarge.class);
        // A line past the bound.
        assertThatThrownBy(() -> reader(("* OK " + "x".repeat(5000) + "\r\n").getBytes(StandardCharsets.US_ASCII), 1024, 1024).read())
                .isInstanceOf(ImapException.TooLarge.class);
        // Lists nested past the bound.
        assertThatThrownBy(() -> reader("* 1 FETCH " + "(".repeat(40) + "\r\n").read()).isInstanceOf(ImapException.Protocol.class);
        // A digit run that isn't a size.
        assertThatThrownBy(() -> reader("* 1 FETCH (BODY[] {99999999999999999999}\r\n").read()).isInstanceOf(ImapException.class);
    }

    @Test
    void randomBytesNeverGetPastAsAnythingButAnExceptionOrAResponse() {
        Random rnd = new Random(20261114);
        String[] seeds = {"* 3 FETCH (UID 9 FLAGS (\\Seen) BODY[] {4}\r\nabcd)\r\n", "* OK [HIGHESTMODSEQ 99] ok\r\n",
                "* VANISHED (EARLIER) 1:5\r\n", "A1 NO [AUTHENTICATIONFAILED] no\r\n", "* LIST (\\Sent) \"/\" {4}\r\nSent\r\n"};
        for (int i = 0; i < 20_000; i++) {
            byte[] b = seeds[rnd.nextInt(seeds.length)].getBytes(StandardCharsets.ISO_8859_1);
            int flips = 1 + rnd.nextInt(4);
            for (int k = 0; k < flips; k++) {
                b[rnd.nextInt(b.length)] = (byte) rnd.nextInt(256);
            }
            ImapReader r = reader(b, 4096, 4096);
            r.allow(8192);
            try {
                ImapReader.Response resp = r.read();
                if ("FETCH".equals(resp.kind())) {
                    ImapClient.fetchData(resp);
                }
            } catch (java.io.IOException expected) {
                // refused: fine
            }
        }
    }
}
