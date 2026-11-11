package com.minimalistalliance.desk.deskd.browser;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.deskd.rpc.RpcException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/** Passwords files as browsers and password managers export them. Every password here is an obviously fake one. */
class PasswordCsvTest {

    private static PasswordCsv.Parsed parse(String text) throws RpcException {
        return PasswordCsv.parse(text.getBytes(StandardCharsets.UTF_8));
    }

    private static void assertFormat(byte[] bytes) {
        assertThatThrownBy(() -> PasswordCsv.parse(bytes))
                .isInstanceOfSatisfying(RpcException.class, e -> {
                    assertThat(e.code()).isEqualTo(RpcException.BAD_REQUEST);
                    assertThat(e.details()).isEqualTo(Map.of("reason", "format"));
                });
    }

    @Test
    void chromesExportReads() throws Exception {
        PasswordCsv.Parsed parsed = parse("name,url,username,password,note\r\n"
                + "one.example,https://one.example/login,fake-user,fake-password-1,a note\r\n");
        assertThat(parsed.rows()).containsExactly(new PasswordCsv.Row("https://one.example/login", "fake-user", "fake-password-1", "a note"));
        assertThat(parsed.refused()).isEmpty();
    }

    @Test
    void firefoxsSafarisAndBitwardensColumnsRead() throws Exception {
        assertThat(parse("\"url\",\"username\",\"password\",\"httpRealm\",\"formActionOrigin\",\"guid\"\n"
                        + "\"https://ff.example\",\"fake-user\",\"fake-password-2\",,\"\",\"{x}\"\n").rows())
                .containsExactly(new PasswordCsv.Row("https://ff.example", "fake-user", "fake-password-2", ""));
        assertThat(parse("Title,URL,Username,Password,Notes,OTPAuth\nS,https://s.example/,fake-user,fake-password-3,n,\n").rows())
                .containsExactly(new PasswordCsv.Row("https://s.example/", "fake-user", "fake-password-3", "n"));
        assertThat(parse("folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n"
                        + ",,login,B,,,0,https://b.example/,fake-user,fake-password-4,\n").rows())
                .containsExactly(new PasswordCsv.Row("https://b.example/", "fake-user", "fake-password-4", ""));
    }

    @Test
    void quotedFieldsKeepCommasQuotesAndNewlines() throws Exception {
        PasswordCsv.Parsed parsed = parse("url,username,password,note\n"
                + "https://q.example/,\"fake, user\",\"fake \"\"quoted\"\" password\",\"line one\r\nline two\"\n");
        assertThat(parsed.rows()).containsExactly(
                new PasswordCsv.Row("https://q.example/", "fake, user", "fake \"quoted\" password", "line one\r\nline two"));
    }

    @Test
    void aByteOrderMarkAndBlankLinesAreNothing() throws Exception {
        byte[] bom = {(byte) 0xEF, (byte) 0xBB, (byte) 0xBF};
        byte[] body = "url,password\n\nhttps://a.example/,fake-password-5\n\n".getBytes(StandardCharsets.UTF_8);
        byte[] all = new byte[bom.length + body.length];
        System.arraycopy(bom, 0, all, 0, 3);
        System.arraycopy(body, 0, all, 3, body.length);
        PasswordCsv.Parsed parsed = PasswordCsv.parse(all);
        assertThat(parsed.rows()).containsExactly(new PasswordCsv.Row("https://a.example/", "", "fake-password-5", ""));
        assertThat(parsed.total()).isEqualTo(1);
    }

    @Test
    void rowsChromiumWouldRefuseStayOutWithAReasonAndTheirSite() throws Exception {
        String longField = "x".repeat(PasswordCsv.MAX_FIELD_CHARS + 1);
        PasswordCsv.Parsed parsed = parse("url,username,password,note\n"
                + "android://abc@com.example.app/,fake-user,fake-password-6,\n"
                + "ftp://files.example/,fake-user,fake-password-7,\n"
                + "https://empty.example/,fake-user,,\n"
                + "https://long.example:8443/x,fake-user," + longField + ",\n"
                + "https://note.example/,fake-user,fake-password-8," + longField + "\n"
                + "https://good.example:8080/path,fake-user,fake-password-9,\n");
        assertThat(parsed.refused()).containsExactly(
                new PasswordCsv.Refused("com.example.app", "fake-user", "url"),
                new PasswordCsv.Refused("files.example", "fake-user", "url"),
                new PasswordCsv.Refused("empty.example", "fake-user", "password"),
                new PasswordCsv.Refused("long.example", "fake-user", "too_long"),
                new PasswordCsv.Refused("note.example", "fake-user", "too_long"));
        assertThat(parsed.rows()).extracting(PasswordCsv.Row::url).containsExactly("https://good.example:8080/path");
        assertThat(PasswordCsv.siteOf("https://u:p@good.example:8080/path")).isEqualTo("good.example");
        assertThat(PasswordCsv.siteOf("https://[::1]:8080/")).isEqualTo("[::1]");
        assertThat(PasswordCsv.siteOf("not a url")).isNull();
    }

    @Test
    void aSiteOrUsernameIsCleanedAndCutAsTitlesAre() throws Exception {
        PasswordCsv.Parsed parsed = parse("url,username,password\njavascript://evil\u202e.example/,fake\u202euser" + "u".repeat(100) + ",fake-password-10\n");
        PasswordCsv.Refused refused = parsed.refused().get(0);
        assertThat(refused.site()).isEqualTo("evil.example");
        assertThat(refused.username()).hasSize(64).startsWith("fakeuser");
    }

    @Test
    void whatIsntAPasswordsFileSaysFormatAndNothingElse() {
        assertFormat(new byte[0]);
        assertFormat("title,body\nhello,world\n".getBytes(StandardCharsets.UTF_8));
        assertFormat("url,username\nhttps://a.example/,fake-user\n".getBytes(StandardCharsets.UTF_8));
        assertFormat("url,password\nhttps://a.example/,\"never closed\n".getBytes(StandardCharsets.UTF_8));
        assertFormat(new byte[] {'u', 'r', 'l', ',', 'p', 'a', 's', 's', 'w', 'o', 'r', 'd', '\n', (byte) 0xC3, (byte) 0x28});
        assertFormat(("url,password\nhttps://a.example/," + "y".repeat(70_000) + "\n").getBytes(StandardCharsets.UTF_8));
    }

    @Test
    void moreRowsThanTheLimitIsTooLarge() {
        StringBuilder csv = new StringBuilder("url,password\n");
        for (int i = 0; i <= PasswordCsv.MAX_ROWS; i++) {
            csv.append("https://s").append(i).append(".example/,fake-password\n");
        }
        assertThatThrownBy(() -> parse(csv.toString()))
                .isInstanceOfSatisfying(RpcException.class, e -> {
                    assertThat(e.code()).isEqualTo(RpcException.TOO_LARGE);
                    assertThat(e.details()).isEqualTo(Map.of("limit", PasswordCsv.MAX_ROWS, "reason", "rows"));
                });
    }

    @Test
    void recordsSplitAsRfc4180Says() throws Exception {
        assertThat(PasswordCsv.records("a,b\r\nc,\"d\ne\"\nf")).containsExactly(List.of("a", "b"), List.of("c", "d\ne"), List.of("f"));
        assertThat(PasswordCsv.records("a,\"\"\n")).containsExactly(List.of("a", ""));
        assertThat(PasswordCsv.records("x\"y,z\n")).containsExactly(List.of("x\"y", "z"));
    }
}
