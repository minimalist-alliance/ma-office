package com.minimalistalliance.desk.deskd.courier;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.courier.testkit.MimeCorpus;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermission;
import java.time.Instant;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * Attachments (Wave 3.1) over the wire: Save to Files, Download, an image's preview, an archive's list and the raw
 * message, with the dangerous-type rules, every byte cut out by the real Courier mode.
 */
class AttachmentsTest {

    private static byte[] sample(String name) {
        return MimeCorpus.handWritten().stream().filter(x -> x.name().equals(name)).findFirst().orElseThrow().raw();
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> attachments(AttachmentsRig rig, String id) throws Exception {
        return (List<Map<String, Object>>) rig.store().queries().message(id, 0).get("attachments");
    }

    private static Map<String, Object> named(AttachmentsRig rig, String id, String name) throws Exception {
        return attachments(rig, id).stream().filter(a -> name.equals(a.get("name"))).findFirst().orElseThrow();
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> details(Map<String, Object> reply) {
        return (Map<String, Object>) reply.get("details");
    }

    private static byte[] trailer(byte[] whole) {
        ByteBuffer out = ByteBuffer.allocate(40);
        out.put(HexFormat.of().parseHex(CourierAttachments.sha256(whole)));
        out.putLong(whole.length);
        return out.array();
    }

    @Test
    void saveToFilesPutsItInCourierByDayAndSubjectAndNeverReplacesAnything(@TempDir Path dir) throws Exception {
        try (AttachmentsRig rig = new AttachmentsRig(dir)) {
            TestClient owner = rig.owner("s-1");
            String id = rig.deliver(sample("alternative-with-pdf"), "pdf");
            Map<String, Object> pdf = named(rig, id, "minutes.pdf");
            assertThat(pdf.get("danger")).isNull();
            Map<String, Object> saved = rig.ok(owner, "courier.attachment.save", "messageId", id, "part", pdf.get("part"), "zone", "America/Denver");
            String path = (String) saved.get("path");
            assertThat(path).startsWith("Courier/").endsWith(" Minutes of the November meeting/minutes.pdf");
            assertThat(saved).containsEntry("already", false).containsEntry("name", "minutes.pdf");
            Path onDisk = rig.filesRoot.resolve(path);
            byte[] bytes = Files.readAllBytes(onDisk);
            assertThat(bytes).hasSize(((Number) saved.get("bytes")).intValue());
            assertThat(new String(bytes, 0, 5, StandardCharsets.US_ASCII)).isEqualTo("%PDF-");
            assertThat(CourierAttachments.sha256(bytes)).isEqualTo(saved.get("sha256"));
            // Never executable: Files' own mode.
            Set<PosixFilePermission> mode = Files.getPosixFilePermissions(onDisk);
            assertThat(mode).doesNotContain(PosixFilePermission.OWNER_EXECUTE, PosixFilePermission.GROUP_EXECUTE, PosixFilePermission.OTHERS_EXECUTE);
            // The same again is that file.
            assertThat(rig.ok(owner, "courier.attachment.save", "messageId", id, "part", pdf.get("part"), "zone", "America/Denver"))
                    .containsEntry("already", true).containsEntry("path", path);
            // Other bytes under the name: a second name, never a replacement.
            Files.write(onDisk, "the member changed it".getBytes(StandardCharsets.UTF_8));
            Map<String, Object> again = rig.ok(owner, "courier.attachment.save", "messageId", id, "part", pdf.get("part"), "zone", "America/Denver");
            assertThat((String) again.get("path")).endsWith("/minutes (2).pdf");
            assertThat(Files.readString(onDisk)).isEqualTo("the member changed it");
        }
    }

    @Test
    void dangerousTypesNeedTheSecondPressAndAreNeverPreviewed(@TempDir Path dir) throws Exception {
        try (AttachmentsRig rig = new AttachmentsRig(dir)) {
            TestClient owner = rig.owner("s-1");
            String id = rig.deliver(sample("dangerous-programs"), "prog");
            Map<String, Object> exe = named(rig, id, "setup.exe");
            assertThat(exe.get("danger")).isEqualTo("program");
            Map<String, Object> refused = rig.err(owner, "forbidden", "courier.attachment.save", "messageId", id, "part", exe.get("part"));
            assertThat(details(refused)).containsEntry("reason", "danger").containsEntry("danger", "program");
            rig.err(owner, "forbidden", "courier.attachment.read", "messageId", id, "part", exe.get("part"));
            rig.err(owner, "forbidden", "courier.attachment.image", "messageId", id, "part", exe.get("part"));
            assertThat(Files.exists(rig.filesRoot.resolve("Courier"))).isFalse();
            // The raw message holds the same bytes: it needs the second press too (Security CR3-I3).
            rig.err(owner, "forbidden", "courier.message.raw", "messageId", id);
            Map<String, Object> rawOk = rig.ok(owner, "courier.message.raw", "messageId", id, "allowDanger", true);
            rig.receive(owner, ((Number) rawOk.get("transferId")).longValue());
            // A Download with it says only "bytes", never the type the sender claimed.
            Map<String, Object> dl = rig.ok(owner, "courier.attachment.read", "messageId", id, "part", exe.get("part"), "allowDanger", true);
            assertThat(dl).containsEntry("type", "application/octet-stream").containsEntry("danger", "program");
            rig.receive(owner, ((Number) dl.get("transferId")).longValue());
            // With the second press: saved, its real extension kept, and the answer says what it is.
            Map<String, Object> saved = rig.ok(owner, "courier.attachment.save", "messageId", id, "part", exe.get("part"), "allowDanger", true);
            assertThat((String) saved.get("path")).endsWith("/setup.exe");
            assertThat(saved).containsEntry("danger", "program");
            for (Map<String, Object> a : attachments(rig, id)) {
                assertThat(a.get("danger")).as((String) a.get("name")).isNotNull();
            }
            String other = rig.deliver(sample("dangerous-shortcuts-images"), "lnk");
            for (Map<String, Object> a : attachments(rig, other)) {
                assertThat(a.get("danger")).as((String) a.get("name")).isIn("shortcut", "disk_image", "html", "program");
                rig.err(owner, "forbidden", "courier.attachment.image", "messageId", other, "part", a.get("part"));
            }
        }
    }

    @Test
    void aFileThatStartsLikeAProgramIsOneWhateverItsName(@TempDir Path dir) throws Exception {
        try (AttachmentsRig rig = new AttachmentsRig(dir)) {
            TestClient owner = rig.owner("s-1");
            String raw = "From: Pat <pat@example.com>\r\nTo: me@desk.example\r\nSubject: notes\r\nMessage-ID: <mz@x>\r\nMIME-Version: 1.0\r\n"
                    + "Content-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nsee attached\r\n--b\r\n"
                    + "Content-Type: text/plain; name=\"notes.txt\"\r\nContent-Disposition: attachment; filename=\"notes.txt\"\r\n"
                    + "Content-Transfer-Encoding: base64\r\n\r\n" + java.util.Base64.getEncoder().encodeToString("MZ\u0090\u0000this is a program".getBytes(StandardCharsets.ISO_8859_1))
                    + "\r\n--b--\r\n";
            String id = rig.deliver(raw.getBytes(StandardCharsets.US_ASCII), "mz");
            Map<String, Object> a = named(rig, id, "notes.txt");
            Map<String, Object> refused = rig.err(owner, "forbidden", "courier.attachment.save", "messageId", id, "part", a.get("part"));
            assertThat(details(refused)).containsEntry("reason", "danger");
        }
    }

    @Test
    void downloadPreviewArchiveAndRawGoOverBulkAsFilesReadSendsAFile(@TempDir Path dir) throws Exception {
        try (AttachmentsRig rig = new AttachmentsRig(dir)) {
            TestClient owner = rig.owner("s-1");
            byte[] pdfRaw = sample("alternative-with-pdf");
            String id = rig.deliver(pdfRaw, "pdf");
            Map<String, Object> pdf = named(rig, id, "minutes.pdf");
            Map<String, Object> reply = rig.ok(owner, "courier.attachment.read", "messageId", id, "part", pdf.get("part"));
            assertThat(reply).containsEntry("name", "minutes.pdf").containsEntry("type", "application/pdf");
            AttachmentsRig.Received got = rig.receive(owner, ((Number) reply.get("transferId")).longValue());
            assertThat(got.bytes()).hasSize(((Number) reply.get("size")).intValue());
            assertThat(got.end()).isEqualTo(trailer(got.bytes()));
            assertThat(new String(got.bytes(), 0, 5, StandardCharsets.US_ASCII)).isEqualTo("%PDF-");
            // The staged copy was unlinked as soon as it was written.
            try (Stream<Path> staged = Files.list(rig.store().partsDir())) {
                assertThat(staged).isEmpty();
            }

            // A preview: drawn again from its pixels, PNG or JPEG.
            String png = rig.deliver(sample("related-cid-png"), "png");
            Map<String, Object> logo = named(rig, png, "logo.png");
            Map<String, Object> image = rig.ok(owner, "courier.attachment.image", "messageId", png, "part", logo.get("part"));
            assertThat(image.get("format")).isIn("png", "jpeg");
            assertThat(((Number) image.get("width")).intValue()).isPositive();
            AttachmentsRig.Received drawn = rig.receive(owner, ((Number) image.get("transferId")).longValue());
            assertThat(drawn.bytes()[1]).isIn((byte) 'P', (byte) 0xD8);
            rig.err(owner, "bad_request", "courier.attachment.image", "messageId", id, "part", pdf.get("part"));

            // An archive's list, read without unpacking it.
            String zip = rig.deliver(sample("zip-with-exe"), "zip");
            Map<String, Object> archive = attachments(rig, zip).get(0);
            Map<String, Object> listing = rig.ok(owner, "courier.attachment.archive", "messageId", zip, "part", archive.get("part"));
            assertThat(listing).containsEntry("format", "zip").containsEntry("danger", "archive_programs");
            @SuppressWarnings("unchecked")
            List<Map<String, Object>> entries = (List<Map<String, Object>>) listing.get("entries");
            assertThat(entries).anySatisfy(e -> assertThat(e.get("danger")).isEqualTo("program"));

            // The raw message, exactly as it came.
            Map<String, Object> raw = rig.ok(owner, "courier.message.raw", "messageId", id);
            assertThat((String) raw.get("name")).endsWith("Minutes of the November meeting.eml");
            assertThat(rig.receive(owner, ((Number) raw.get("transferId")).longValue()).bytes()).isEqualTo(pdfRaw);

            // Bad params, and parts that aren't there.
            rig.err(owner, "bad_request", "courier.attachment.read", "messageId", id, "part", "../1");
            rig.err(owner, "not_found", "courier.attachment.read", "messageId", id, "part", "9.9");
        }
    }

    /**
     * Security's CF-L1: a message the sandbox refused to read has no attachment rows, so nothing says what it holds; its raw
     * download asks first (`danger: unread`), as one holding a program does.
     */
    @Test
    void aMessageThatCouldntBeReadAsksBeforeItsRawDownload(@TempDir Path dir) throws Exception {
        try (AttachmentsRig rig = new AttachmentsRig(dir)) {
            TestClient owner = rig.owner("s-1");
            StringBuilder head = new StringBuilder("From: Parcels <notice@parcels.example>\r\nTo: me@desk.example\r\nSubject: Your parcel\r\n"
                    + "Message-ID: <deep@parcels.example>\r\nMIME-Version: 1.0\r\n");
            StringBuilder body = new StringBuilder();
            int depth = 40;
            for (int i = 0; i < depth; i++) {
                (i == 0 ? head : body).append("Content-Type: multipart/mixed; boundary=\"b").append(i).append("\"\r\n\r\n");
                body.append("--b").append(i).append("\r\n");
            }
            // A harmless part at the bottom: nothing the store records says danger, yet its raw download still asks.
            body.append("Content-Type: text/plain\r\n\r\nYour parcel is on its way.\r\n");
            for (int i = depth - 1; i >= 0; i--) {
                body.append("--b").append(i).append("--\r\n");
            }
            byte[] raw = (head + body.toString()).getBytes(StandardCharsets.US_ASCII);
            String id = rig.deliver(raw, "deep");
            Map<String, Object> m = rig.ok(owner, "courier.message", "messageId", id);
            assertThat(m.get("parse")).isInstanceOfSatisfying(Map.class, p -> assertThat(p.get("state")).isEqualTo("refused"));
            assertThat((List<?>) m.get("attachments")).isEmpty();
            Map<String, Object> refused = rig.err(owner, "forbidden", "courier.message.raw", "messageId", id);
            assertThat(details(refused)).containsEntry("reason", "danger").containsEntry("danger", "unread");
            Map<String, Object> ok = rig.ok(owner, "courier.message.raw", "messageId", id, "allowDanger", true);
            assertThat(rig.receive(owner, ((Number) ok.get("transferId")).longValue()).bytes()).isEqualTo(raw);
        }
    }

    @Test
    void theBandwidthPauseRefusesANewDownloadButNotSaveToFiles(@TempDir Path dir) throws Exception {
        try (AttachmentsRig rig = new AttachmentsRig(dir)) {
            TestClient owner = rig.owner("s-1");
            String id = rig.deliver(sample("alternative-with-pdf"), "pdf");
            Map<String, Object> pdf = named(rig, id, "minutes.pdf");
            rig.pausedUntil.set(Instant.parse("2026-11-13T00:00:00Z"));
            Map<String, Object> refused = rig.err(owner, "unavailable", "courier.attachment.read", "messageId", id, "part", pdf.get("part"));
            assertThat(details(refused)).containsEntry("reason", "bandwidth_limit").containsEntry("resumesAt", "2026-11-13T00:00:00Z");
            rig.err(owner, "unavailable", "courier.message.raw", "messageId", id);
            rig.ok(owner, "courier.attachment.save", "messageId", id, "part", pdf.get("part"));
        }
    }

    @Test
    void aDownloadIsntStagedWhenItWouldEatTheVolumesFloor(@TempDir Path dir) throws Exception {
        try (AttachmentsRig rig = new AttachmentsRig(dir)) {
            TestClient owner = rig.owner("s-1");
            String id = rig.deliver(sample("alternative-with-pdf"), "pdf");
            Map<String, Object> pdf = named(rig, id, "minutes.pdf");
            rig.module.attachments().usableBytes(() -> CourierAttachments.FLOOR_BYTES + 10);
            // Each refusal gives its place in the session's transfers back: past eight, it's still no_space, never too_many.
            for (int i = 0; i < 10; i++) {
                Map<String, Object> refused = rig.err(owner, "no_space", "courier.attachment.read", "messageId", id, "part", pdf.get("part"));
                assertThat(details(refused)).containsEntry("reason", "floor");
            }
            rig.module.attachments().usableBytes(null);
            Map<String, Object> ok = rig.ok(owner, "courier.attachment.read", "messageId", id, "part", pdf.get("part"));
            rig.receive(owner, ((Number) ok.get("transferId")).longValue());
        }
    }

    // ---- names

    @Test
    void namesAreMadeSafeForFilesAndKeepTheirRealExtension() {
        assertThat(CourierAttachments.fileName("invoice\u202efdp.exe", "application/octet-stream", "2")).isEqualTo("invoicefdp.exe");
        assertThat(CourierAttachments.fileName("../../etc/passwd", null, "2")).isEqualTo("-..-etc-passwd");
        assertThat(CourierAttachments.fileName(".hidden.sh", null, "2")).isEqualTo("hidden.sh");
        assertThat(CourierAttachments.fileName("report.pdf.   ", null, "2")).isEqualTo("report.pdf");
        assertThat(CourierAttachments.fileName("a\u200bb\u0000c:d*e?.txt", null, "2")).isEqualTo("abc-d-e-.txt");
        assertThat(CourierAttachments.fileName(null, "application/pdf", "1.2")).isEqualTo("Attachment 1-2.pdf");
        assertThat(CourierAttachments.fileName("...", null, "3")).isEqualTo("Attachment 3");
        String longName = "x".repeat(400) + ".docx";
        String cut = CourierAttachments.fileName(longName, null, "2");
        assertThat(cut).endsWith(".docx");
        assertThat(cut.getBytes(StandardCharsets.UTF_8).length).isLessThanOrEqualTo(200);
        assertThat(CourierAttachments.folderName(Instant.parse("2026-11-14T03:00:00Z").toEpochMilli(), "Re: Q4 / plan", java.time.ZoneId.of("America/Denver")))
                .isEqualTo("2026-11-13 Re- Q4 - plan");
        assertThat(CourierAttachments.folderName(0, null, null)).isEqualTo("1970-01-01 No subject");
        assertThat(CourierAttachments.numbered("a.pdf", 3)).isEqualTo("a (3).pdf");
        assertThat(CourierAttachments.looksLikeProgram("MZ\u0090".getBytes(StandardCharsets.ISO_8859_1))).isTrue();
        assertThat(CourierAttachments.looksLikeProgram(new byte[] {0x7F, 'E', 'L', 'F'})).isTrue();
        assertThat(CourierAttachments.looksLikeProgram("%PDF-1.7".getBytes(StandardCharsets.US_ASCII))).isFalse();
    }

    @Test
    void anArchiveListingIsCappedAndCleanedBeforeTheOfficeSeesIt() {
        java.util.List<Object> entries = new java.util.ArrayList<>();
        for (int i = 0; i < 700; i++) {
            entries.add(Map.of("name", "file\u202e" + i + ".txt", "bytes", 10, "danger", i == 0 ? "program" : "made-up"));
        }
        Map<String, Object> clean = CourierAttachments.cleanListing(Map.of("v", 1, "format", "zip", "entries", entries, "total", 700,
                "truncated", false, "danger", "archive_programs"));
        @SuppressWarnings("unchecked")
        List<Map<String, Object>> kept = (List<Map<String, Object>>) clean.get("entries");
        assertThat(kept).hasSize(500);
        assertThat(kept.get(0)).containsEntry("name", "file0.txt").containsEntry("danger", "program");
        assertThat(kept.get(1).get("danger")).isNull();
        assertThat(clean).containsEntry("truncated", true).containsEntry("total", 700L).containsEntry("danger", "archive_programs");
        assertThat(CourierAttachments.cleanListing(Map.of("format", "rar<script>"))).containsEntry("format", null);
    }
}
