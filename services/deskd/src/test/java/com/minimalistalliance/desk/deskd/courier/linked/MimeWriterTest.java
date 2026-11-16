package com.minimalistalliance.desk.deskd.courier.linked;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.deskd.courier.TestMime;
import com.minimalistalliance.desk.deskd.courier.parse.CourierParser;
import com.minimalistalliance.desk.deskd.courier.parse.ParsedMessage;
import com.minimalistalliance.desk.deskd.courier.store.Outbox;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;
import org.junit.jupiter.api.Test;

/** The member's message as bytes: nothing a subject or a name holds becomes a header, and it reads back as written. */
class MimeWriterTest {

    private static Outbox.Outgoing out(String subject, String text, String name, String to, List<String> refs) {
        return new Outbox.Outgoing("o", "m", "email", "a", 1, false, "01abc@example.com", refs.isEmpty() ? null : refs.get(refs.size() - 1),
                refs, subject, text, List.of(new Outbox.Recipient("e", "email", to, name, "to")));
    }

    private static ParsedMessage parse(byte[] b) throws Exception {
        return ((CourierParser.Parsed) TestMime.PARSER.parse(b)).message();
    }

    @Test
    void aSubjectOrNameCantAddAHeader() throws Exception {
        byte[] b = MimeWriter.write("me@example.com", out("Hi\r\nBcc: evil@example.net", "x", "Dana\r\nBcc: evil@example.net",
                "dana@example.com", List.of()), Instant.EPOCH);
        String s = new String(b, StandardCharsets.UTF_8);
        assertThat(s.lines().filter(l -> l.startsWith("Bcc:"))).isEmpty();
        ParsedMessage m = parse(b);
        assertThat(m.bcc()).isEmpty();
        assertThat(m.to()).extracting(ParsedMessage.Address::address).containsExactly("dana@example.com");
    }

    @Test
    void textNamesAndSubjectsInAnyScriptReadBack() throws Exception {
        String subject = "Встреча в пятницу — 会議 🙂 " + "long words ".repeat(12);
        String text = "Привет!\nLine two with = and trailing space \n.dot first\n\n" + "x".repeat(300) + "\nend";
        byte[] b = MimeWriter.write("me@example.com", out(subject, text, "Дана Смит", "dana@example.com", List.of("<r1@x>", "<r2@x>")),
                Instant.parse("2026-11-14T10:00:00Z"));
        String s = new String(b, StandardCharsets.US_ASCII);
        assertThat(s.lines()).allMatch(l -> l.length() <= 998);
        assertThat(s.chars()).allMatch(c -> c < 0x80);
        ParsedMessage m = parse(b);
        assertThat(m.subject()).isEqualTo(subject.strip());
        assertThat(m.text()).contains("Привет!").contains(".dot first").contains("x".repeat(300)).contains("end");
        assertThat(m.to().get(0).name()).isEqualTo("Дана Смит");
        assertThat(m.messageId()).isEqualTo("01abc@example.com");
        assertThat(m.inReplyTo()).containsExactly("r2@x");
        assertThat(m.references()).containsExactly("r1@x", "r2@x");
        assertThat(s).contains("Date: Sat, 14 Nov 2026 10:00:00 +0000");
    }

    @Test
    void anAddressThatIsntOneIsNeverWritten() {
        assertThat(MimeWriter.address("a b@example.com")).isNull();
        assertThat(MimeWriter.address("a\"@example.com")).isNull();
        assertThat(MimeWriter.address("<a@example.com>\r\nRCPT TO:<b@x>")).isNull();
        assertThat(MimeWriter.address("dana@bücher.example")).isEqualTo("dana@xn--bcher-kva.example");
    }
}
