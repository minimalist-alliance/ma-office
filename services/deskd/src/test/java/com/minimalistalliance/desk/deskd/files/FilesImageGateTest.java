package com.minimalistalliance.desk.deskd.files;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.deskd.testing.TestClient;
import com.minimalistalliance.desk.deskd.testing.TestTokens;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** The image gate at finish (files.md section 6): an image lands only with a token for exactly its original bytes. */
class FilesImageGateTest {

    @TempDir
    Path dir;

    FilesRig rig;
    TestClient owner;

    /** A jpeg-looking original of any size: the gate looks at the first bytes only. */
    static byte[] image(int size, long seed) {
        byte[] b = FilesRig.bytes(size, seed);
        b[0] = (byte) 0xFF;
        b[1] = (byte) 0xD8;
        b[2] = (byte) 0xFF;
        b[3] = (byte) 0xE0;
        return b;
    }

    @BeforeEach
    void setUp() throws Exception {
        rig = new FilesRig(dir);
        owner = rig.owner("s-1");
    }

    @AfterEach
    void tearDown() throws Exception {
        rig.close();
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> details(Map<String, Object> reply) {
        return (Map<String, Object>) reply.get("details");
    }

    private Map<String, Object> put(String path, byte[] data, String token) throws Exception {
        return token == null ? rig.upload(owner, path, data) : rig.upload(owner, path, data, "token", token);
    }

    private String reason(Map<String, Object> reply) {
        assertThat(reply).as(reply.toString()).containsEntry("_kind", "ERR").containsEntry("code", "check_invalid");
        return (String) details(reply).get("reason");
    }

    @Test
    void anImageWithAValidTokenForTheOriginalLandsByteForByte() throws Exception {
        byte[] original = image(70_000, 1);
        Map<String, Object> done = put("holiday.jpg", original, rig.verdict(original, "ok"));
        assertThat(done).as(done.toString()).containsEntry("_kind", "RES");
        assertThat(Files.readAllBytes(rig.root.resolve("holiday.jpg"))).isEqualTo(original);
    }

    @Test
    void anImageOfAnySizeAndAnyTypePassesWithItsToken() throws Exception {
        byte[] big = image(12 * 1024 * 1024, 2);
        assertThat(put("huge.jpg", big, rig.verdict(big, "ok"))).containsEntry("_kind", "RES");
        byte[] heic = new byte[40_000];
        byte[] ftyp = "\0\0\0\u0018ftypheic\0\0\0\0mif1heic".getBytes(StandardCharsets.ISO_8859_1);
        System.arraycopy(ftyp, 0, heic, 0, ftyp.length);
        assertThat(put("iphone.heic", heic, rig.verdict(heic, "ok"))).containsEntry("_kind", "RES");
        byte[] svg = "<svg xmlns='http://www.w3.org/2000/svg'><rect/></svg>".getBytes(StandardCharsets.UTF_8);
        assertThat(put("logo.svg", svg, rig.verdict(svg, "ok"))).containsEntry("_kind", "RES");
        byte[] gif = ("GIF89a" + "x".repeat(500)).getBytes(StandardCharsets.ISO_8859_1);
        assertThat(put("anim.gif", gif, rig.verdict(gif, "ok"))).containsEntry("_kind", "RES");
    }

    @Test
    void uncheckedPassesAsOkBecauseTheOwnerSaysSo() throws Exception {
        byte[] original = image(1000, 3);
        assertThat(put("offline.jpg", original, rig.verdict(original, "unchecked"))).containsEntry("_kind", "RES");
    }

    @Test
    void noTokenIsCheckRequiredAndTheNameDecidesNothing() throws Exception {
        byte[] original = image(1000, 4);
        Map<String, Object> reply = put("sneaky.dat", original, null);
        assertThat(reply).containsEntry("code", "check_required");
        assertThat(details(reply)).containsEntry("format", "jpeg");
        assertThat(Files.exists(rig.root.resolve("sneaky.dat"))).isFalse();
        // The partial is kept, and the same upload finishes once it has a token.
        assertThat(rig.partials()).hasSize(2);
    }

    @Test
    void aTokenForOtherBytesOrAnotherSizeIsRefusedAndNothingLands() throws Exception {
        byte[] original = image(5000, 5);
        byte[] other = image(5000, 6);
        assertThat(reason(put("a.jpg", original, rig.verdict(other, "ok")))).isEqualTo("hash");
        String wrongSize = rig.verdictFor(FilesRig.sha(original), 4999, "ok", FilesRig.MEMBER, FilesRig.DESK, TestTokens.ISSUER,
                Instant.parse("2026-11-08T12:00:00Z"), 600);
        assertThat(reason(put("b.jpg", original, wrongSize))).isEqualTo("size");
        assertThat(Files.exists(rig.root.resolve("a.jpg"))).isFalse();
        assertThat(Files.exists(rig.root.resolve("b.jpg"))).isFalse();
    }

    @Test
    void aTokenForAnotherDeskOrMemberOrThatHasExpiredIsRefused() throws Exception {
        byte[] original = image(3000, 7);
        String sha = FilesRig.sha(original);
        Instant now = Instant.parse("2026-11-08T12:00:00Z");
        assertThat(reason(put("c.jpg", original, rig.verdictFor(sha, 3000, "ok", FilesRig.MEMBER, "d-another", TestTokens.ISSUER, now, 600)))).isEqualTo("desk");
        assertThat(reason(put("d.jpg", original, rig.verdictFor(sha, 3000, "ok", "user-2", FilesRig.DESK, TestTokens.ISSUER, now, 600)))).isEqualTo("member");
        assertThat(reason(put("e.jpg", original, rig.verdictFor(sha, 3000, "ok", FilesRig.MEMBER, FilesRig.DESK, TestTokens.ISSUER, now.minus(Duration.ofHours(2)), 600)))).isEqualTo("expired");
        assertThat(reason(put("f.jpg", original, "garbage"))).isEqualTo("signature");
        assertThat(reason(put("g.jpg", original, rig.tokens.mint("cd".repeat(32), now)))).isEqualTo("signature");
    }

    @Test
    void anUncheckedTokenIsRefusedWhenTheSwitchIsOff() throws Exception {
        rig.close();
        rig = new FilesRig(dir, false, false, Quota.FLOOR_BYTES, Duration.ofSeconds(1));
        owner = rig.owner("s-1");
        byte[] original = image(500, 8);
        assertThat(reason(put("x.jpg", original, rig.verdict(original, "unchecked")))).isEqualTo("state");
        assertThat(put("y.jpg", original, rig.verdict(original, "ok"))).containsEntry("_kind", "RES");
    }

    @Test
    void aTokenOnAFileThatIsNotAnImageIsRefusedWithKind() throws Exception {
        byte[] text = "plain words".getBytes(StandardCharsets.UTF_8);
        assertThat(reason(put("words.txt", text, rig.verdict(text, "ok")))).isEqualTo("kind");
        assertThat(put("words2.txt", text, null)).containsEntry("_kind", "RES");
    }

    @Test
    void anImageInsideAZipOrAPdfNeedsNoToken() throws Exception {
        ByteArrayOutputStream zip = new ByteArrayOutputStream();
        try (ZipOutputStream out = new ZipOutputStream(zip)) {
            out.putNextEntry(new ZipEntry("photo.jpg"));
            out.write(image(2000, 9));
            out.closeEntry();
        }
        assertThat(put("photos.zip", zip.toByteArray(), null)).containsEntry("_kind", "RES");
        byte[] pdf = ("%PDF-1.7\n" + "x".repeat(300)).getBytes(StandardCharsets.ISO_8859_1);
        assertThat(put("doc.pdf", pdf, null)).containsEntry("_kind", "RES");
        byte[] sevenZ = new byte[]{'7', 'z', (byte) 0xBC, (byte) 0xAF, 0x27, 0x1C, 0, 4};
        assertThat(put("a.7z", sevenZ, null)).containsEntry("_kind", "RES");
    }

    @Test
    void aTokenGivenAtBeginIsCheckedEarlyAgainstWhatIsKnownThen() throws Exception {
        byte[] original = image(4000, 10);
        String good = rig.verdict(original, "ok");
        assertThat(rig.call(owner, "files.upload.begin", "path", "early.jpg", "size", 4000L, "sha256", FilesRig.sha(original), "token", good))
                .containsEntry("_kind", "RES");
        Map<String, Object> bad = rig.call(owner, "files.upload.begin", "path", "early2.jpg", "size", 4000L,
                "sha256", FilesRig.sha(image(4000, 11)), "token", good);
        assertThat(reason(bad)).isEqualTo("hash");
        Map<String, Object> junk = rig.call(owner, "files.upload.begin", "path", "early3.jpg", "size", 4000L, "token", "junk");
        assertThat(reason(junk)).isEqualTo("signature");
        // Nothing was started for the refused ones.
        assertThat(rig.partials()).hasSize(2);
    }

    @Test
    void theStubTokenWorksOnlyWhereTheEnvironmentSwitchIsSet() throws Exception {
        byte[] original = image(800, 12);
        assertThat(reason(put("stub-off.jpg", original, "stub." + FilesRig.sha(original)))).isEqualTo("signature");
        rig.close();
        rig = new FilesRig(dir, true, true, Quota.FLOOR_BYTES, Duration.ofSeconds(1));
        owner = rig.owner("s-1");
        assertThat(put("stub-on.jpg", original, "stub." + FilesRig.sha(original))).containsEntry("_kind", "RES");
        byte[] other = image(800, 13);
        assertThat(reason(put("stub-wrong.jpg", other, "stub." + FilesRig.sha(original)))).isEqualTo("hash");
    }

    @Test
    void aRetryOfFinishGetsTheSameReply() throws Exception {
        byte[] original = image(900, 14);
        Map<String, Object> begin = rig.callWith(owner, "files.upload.begin", UUID.randomUUID().toString(), FilesRig.params("path", "r.jpg", "size", 900L));
        FilesRig.Sending s = rig.begun(begin, 0);
        rig.sendBytes(owner, s, original, 900);
        rig.drain(owner, s, 900);
        Map<String, Object> p = FilesRig.params("uploadId", s.uploadId, "sha256", FilesRig.sha(original), "size", 900L, "token", rig.verdict(original, "ok"));
        String key = UUID.randomUUID().toString();
        Map<String, Object> first = rig.callWith(owner, "files.upload.finish", key, p);
        Map<String, Object> again = rig.callWith(owner, "files.upload.finish", key, p);
        assertThat(first).containsEntry("_kind", "RES");
        assertThat(again.get("sha256")).isEqualTo(first.get("sha256"));
        // A new key after the file landed finds no upload.
        assertThat(rig.callWith(owner, "files.upload.finish", UUID.randomUUID().toString(), p)).containsEntry("code", "not_found");
    }
}
