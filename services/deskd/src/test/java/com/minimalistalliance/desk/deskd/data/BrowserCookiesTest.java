package com.minimalistalliance.desk.deskd.data;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.testing.FakeCdp;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;

/** data.browser.cookies against a fake Chromium: digests out, and never a cookie, in a reply or the log. */
@ExtendWith(OutputCaptureExtension.class)
class BrowserCookiesTest {

    private static final String SECRET = "s3cr3t-session-value-0123456789";
    private static final String OTHER = "another-cookie-value-abcdef";

    @TempDir
    Path dir;

    private FakeCdp cdp;
    private DataRig rig;

    @AfterEach
    void tearDown() throws Exception {
        if (rig != null) {
            rig.close();
        }
        if (cdp != null) {
            cdp.close();
        }
    }

    /** Computed here, apart from the code under test. */
    private static String hex16(String text) throws Exception {
        byte[] hash = MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8));
        return HexFormat.of().formatHex(hash).substring(0, 16);
    }

    private static Map<String, Object> cookie(String domain, String name, String path, String value) {
        Map<String, Object> cookie = new LinkedHashMap<>();
        cookie.put("name", name);
        cookie.put("value", value);
        cookie.put("domain", domain);
        cookie.put("path", path);
        cookie.put("expires", 1.9e9 + 0.75);
        cookie.put("size", name.length() + value.length());
        cookie.put("httpOnly", true);
        cookie.put("secure", true);
        cookie.put("session", false);
        cookie.put("sameSite", "Lax");
        cookie.put("priority", "Medium");
        return cookie;
    }

    @Test
    void theAnswerIsDigestsOfEachCookieAndItsValueAndNothingElse(CapturedOutput output) throws Exception {
        cdp = new FakeCdp();
        cdp.addPage("T1", "https://example.com/", "Example");
        Map<String, Object> session = cookie("accounts.example.org", "pref", "/app", OTHER);
        session.put("session", true);
        session.put("expires", -1);
        cdp.cookies(List.of(cookie(".example.com", "sid", "/", SECRET), session));
        rig = new DataRig(dir, cdp.port(), true, DataRig.FAST);
        TestClient client = rig.export("cs-1");

        Map<String, Object> reply = rig.call(client, "data.browser.cookies", Map.of());
        assertThat(reply).containsEntry("_kind", "RES").containsEntry("count", 2);
        assertThat(DataRig.list(reply.get("items"))).containsExactlyInAnyOrder(
                Map.of("k", hex16(".example.com\tsid\t/"), "v", hex16(SECRET), "e", 1_900_000_000),
                Map.of("k", hex16("accounts.example.org\tpref\t/app"), "v", hex16(OTHER), "e", -1));
        assertThat(new String(Json.bytes(reply), StandardCharsets.UTF_8)).doesNotContain(SECRET).doesNotContain(OTHER).doesNotContain("sid");
        assertThat(cdp.commands("Storage.getCookies")).hasSize(1);
        assertThat(cdp.commands("Storage.getCookies").get(0).sessionId()).as("asked of the browser itself").isNull();
        assertThat(output.getAll()).doesNotContain(SECRET).doesNotContain(OTHER);
    }

    @Test
    void theSameCookiesInAnotherOrderGiveTheSameAnswer() throws Exception {
        cdp = new FakeCdp();
        cdp.addPage("T1", "https://example.com/", "Example");
        Map<String, Object> a = cookie(".example.com", "a", "/", "1");
        Map<String, Object> b = cookie(".example.com", "b", "/", "2");
        cdp.cookies(List.of(a, b));
        rig = new DataRig(dir, cdp.port(), true, DataRig.FAST);
        TestClient client = rig.owner("cs-1");
        Object first = rig.call(client, "data.browser.cookies", Map.of()).get("items");
        cdp.cookies(List.of(b, a));
        Object second = rig.call(client, "data.browser.cookies", Map.of()).get("items");
        assertThat(second).isEqualTo(first);
    }

    @Test
    void withNoChromiumItsUnavailableWithReasonChromium() throws Exception {
        rig = new DataRig(dir, 9, true, DataRig.FAST);
        TestClient client = rig.export("cs-1");
        Map<String, Object> reply = rig.call(client, "data.browser.cookies", Map.of());
        assertThat(reply).containsEntry("code", "unavailable");
        assertThat(Json.object(reply, "details")).isEqualTo(Map.of("reason", "chromium"));
    }
}
