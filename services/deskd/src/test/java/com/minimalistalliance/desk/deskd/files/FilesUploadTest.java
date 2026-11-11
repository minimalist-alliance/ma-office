package com.minimalistalliance.desk.deskd.files;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.files.FilesRig.Sending;
import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.Frame;
import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class FilesUploadTest {

    @TempDir
    Path dir;

    FilesRig rig;
    TestClient owner;

    @BeforeEach
    void setUp() throws Exception {
        rig = new FilesRig(dir, false, true, Quota.FLOOR_BYTES, Duration.ofMillis(400));
        owner = rig.owner("s-1");
    }

    @AfterEach
    void tearDown() throws Exception {
        UploadWriter.slowWriteMs = 0;
        rig.close();
    }

    private static Map<String, Object> m(Object o) {
        @SuppressWarnings("unchecked")
        Map<String, Object> map = (Map<String, Object>) o;
        return map;
    }

    private Sending begin(TestClient client, String path, byte[] data, Object... more) throws Exception {
        Map<String, Object> p = FilesRig.params("path", path, "size", (long) data.length);
        for (int i = 0; i < more.length; i += 2) {
            p.put((String) more[i], more[i + 1]);
        }
        return rig.begun(rig.callWith(client, "files.upload.begin", UUID.randomUUID().toString(), p), 0);
    }

    private Map<String, Object> finish(TestClient client, Sending s, byte[] data) throws Exception {
        return rig.call(client, "files.upload.finish", "uploadId", s.uploadId, "sha256", FilesRig.sha(data), "size", (long) data.length);
    }

    // ---- the path of one upload

    @Test
    void anUploadIsInvisibleUntilFinishAndThenExactlyTheBytesSent() throws Exception {
        byte[] data = FilesRig.bytes(300_000, 1);
        Map<String, Object> reply = rig.callWith(owner, "files.upload.begin", UUID.randomUUID().toString(),
                FilesRig.params("path", "Photos/2026/a.dat", "size", (long) data.length, "mtimeMs", 1_762_560_000_000L));
        assertThat(reply).containsEntry("_kind", "RES").containsEntry("offset", 0).containsEntry("window", 1048576).containsEntry("size", 300_000);
        assertThat((String) reply.get("uploadId")).matches("[0-9A-Za-z]{26}");
        assertThat(reply.get("transferId")).isEqualTo(1);
        assertThat(java.time.Instant.parse((String) reply.get("expiresAt"))).isEqualTo(java.time.Instant.parse("2026-11-09T12:00:00Z"));
        Sending s = rig.begun(reply, 0);
        assertThat(rig.partials()).hasSize(2).anyMatch(n -> n.endsWith(".part")).anyMatch(n -> n.endsWith(".json"));

        rig.sendBytes(owner, s, data, data.length);
        rig.drain(owner, s, data.length);
        assertThat(s.committed).isEqualTo(300_000);
        // Not in the tree yet.
        assertThat(Files.exists(rig.root.resolve("Photos"))).isFalse();
        assertThat(((List<?>) rig.ok(owner, "files.list", "path", "").get("entries"))).isEmpty();

        Map<String, Object> done = finish(owner, s, data);
        assertThat(done).containsEntry("_kind", "RES").containsEntry("path", "Photos/2026/a.dat").containsEntry("size", 300_000)
                .containsEntry("sha256", FilesRig.sha(data)).containsEntry("replaced", null).containsEntry("mtimeMs", 1_762_560_000_000L);
        assertThat(Files.readAllBytes(rig.root.resolve("Photos/2026/a.dat"))).isEqualTo(data);
        assertThat(Files.getLastModifiedTime(rig.root.resolve("Photos/2026/a.dat")).toMillis()).isEqualTo(1_762_560_000_000L);
        assertThat(rig.partials()).isEmpty();
        assertThat(Files.getPosixFilePermissions(rig.root.resolve("Photos"))).hasSize(3);
        assertThat(rig.sessions.lastInputAt()).isNotNull();
    }

    @Test
    void aLargeUploadFlowsThroughTheCreditWindowAndAcknowledgesAsItGoes() throws Exception {
        byte[] data = FilesRig.bytes(5 * 1024 * 1024 + 123, 2);
        Sending s = begin(owner, "big.bin", data);
        int credits = 0;
        long lastCommitted = 0;
        while (s.sent < data.length || s.committed < data.length) {
            if (s.sent < data.length && s.credit > 0) {
                rig.sendBytes(owner, s, data, Math.min(data.length, s.sent + s.credit));
            } else {
                rig.readCredit(owner, s);
                credits++;
                assertThat(s.committed).isGreaterThanOrEqualTo(lastCommitted);
                lastCommitted = s.committed;
            }
        }
        assertThat(credits).isGreaterThan(5);
        // The credit never lets more than the 1 MiB window be outstanding.
        assertThat(finish(owner, s, data)).containsEntry("_kind", "RES");
        assertThat(Files.readAllBytes(rig.root.resolve("big.bin"))).isEqualTo(data);
    }

    @Test
    void theWriterMakesItselfDurableEvery64MiBAndRecordsItInTheSidecar() throws Exception {
        long size = 100L * 1024 * 1024;
        Map<String, Object> reply = rig.callWith(owner, "files.upload.begin", UUID.randomUUID().toString(), FilesRig.params("path", "long.bin", "size", size));
        Sending s = rig.begun(reply, 0);
        byte[] block = FilesRig.bytes(1024 * 1024, 20);
        byte[] data = new byte[(int) size];
        for (int i = 0; i < 100; i++) {
            System.arraycopy(block, 0, data, i * block.length, block.length);
        }
        rig.sendBytes(owner, s, data, 66L * 1024 * 1024);
        while (s.committed < 66L * 1024 * 1024) {
            rig.readCredit(owner, s);
        }
        Path sidecar = rig.root.resolve(".uploads").resolve(s.uploadId + ".json");
        Map<String, Object> side = com.minimalistalliance.desk.deskd.protocol.Json.parseObject(Files.readAllBytes(sidecar));
        long durable = ((Number) side.get("durable")).longValue();
        assertThat(durable).isBetween(64L * 1024 * 1024, 66L * 1024 * 1024 - 1);
        rig.ok(owner, "files.upload.abort", "uploadId", s.uploadId);
    }

    @Test
    void aZeroByteFileNeedsNoFrames() throws Exception {
        byte[] data = new byte[0];
        Sending s = begin(owner, "empty.txt", data);
        assertThat(finish(owner, s, data)).containsEntry("_kind", "RES").containsEntry("size", 0);
        assertThat(Files.size(rig.root.resolve("empty.txt"))).isZero();
    }

    @Test
    void missingFoldersAreMadeAtFinishAndAFileInTheWayIsRefusedAtBegin() throws Exception {
        rig.upload(owner, "a/b/c.txt", "x".getBytes(StandardCharsets.UTF_8));
        assertThat(Files.isRegularFile(rig.root.resolve("a/b/c.txt"))).isTrue();
        Map<String, Object> reply = rig.err(owner, "invalid", "files.upload.begin", "path", "a/b/c.txt/d", "size", 1L);
        assertThat(m(reply.get("details"))).containsEntry("reason", "not_a_folder");
    }

    @Test
    void anExistingNameIsRefusedUnlessReplaceAndThenTheOldFileGoesToTheTrash() throws Exception {
        rig.file("a.txt", "old".getBytes(StandardCharsets.UTF_8));
        rig.file("folder/x", new byte[1]);
        Map<String, Object> file = rig.err(owner, "exists", "files.upload.begin", "path", "a.txt", "size", 1L);
        assertThat(m(file.get("details"))).containsEntry("kind", "file");
        Map<String, Object> dirTaken = rig.err(owner, "exists", "files.upload.begin", "path", "folder", "size", 1L, "replace", true);
        assertThat(m(dirTaken.get("details"))).containsEntry("kind", "dir");
        byte[] data = "new contents".getBytes(StandardCharsets.UTF_8);
        Map<String, Object> done = rig.upload(owner, "a.txt", data, "replace", true);
        assertThat(done).containsEntry("_kind", "RES");
        assertThat(done.get("replaced")).isInstanceOf(String.class);
        assertThat(Files.readString(rig.root.resolve("a.txt"))).isEqualTo("new contents");
        Map<String, Object> bin = rig.ok(owner, "files.trash.list");
        assertThat(((List<?>) bin.get("items"))).hasSize(1);
        assertThat(m(((List<?>) bin.get("items")).get(0))).containsEntry("originalPath", "a.txt").containsEntry("bytes", 3);
    }

    @Test
    void aNameTakenWhileTheBytesWereComingIsCaughtAtFinish() throws Exception {
        byte[] data = FilesRig.bytes(1000, 3);
        Sending s = begin(owner, "race.txt", data);
        rig.sendBytes(owner, s, data, data.length);
        rig.drain(owner, s, data.length);
        rig.file("race.txt", "someone else".getBytes(StandardCharsets.UTF_8));
        Map<String, Object> reply = finish(owner, s, data);
        assertThat(reply).containsEntry("_kind", "ERR").containsEntry("code", "exists");
        assertThat(Files.readString(rig.root.resolve("race.txt"))).isEqualTo("someone else");
        // The partial is kept: the member can rename and finish again.
        assertThat(rig.partials()).isNotEmpty();
        Files.delete(rig.root.resolve("race.txt"));
        assertThat(finish(owner, s, data)).containsEntry("_kind", "RES");
    }

    @Test
    void aWrongHashDeletesThePartial() throws Exception {
        byte[] data = FilesRig.bytes(5000, 4);
        Sending s = begin(owner, "bad.bin", data);
        rig.sendBytes(owner, s, data, data.length);
        rig.drain(owner, s, data.length);
        Map<String, Object> reply = rig.call(owner, "files.upload.finish", "uploadId", s.uploadId, "sha256", "0".repeat(64), "size", 5000L);
        assertThat(reply).containsEntry("_kind", "ERR").containsEntry("code", "hash_mismatch");
        assertThat(m(reply.get("details"))).containsEntry("committed", 0);
        assertThat(rig.partials()).isEmpty();
        assertThat(Files.exists(rig.root.resolve("bad.bin"))).isFalse();
        rig.err(owner, "not_found", "files.upload.status", "uploadId", s.uploadId);
    }

    @Test
    void finishBeforeEveryByteHasArrivedIsAConflictThatSaysHowFar() throws Exception {
        byte[] data = FilesRig.bytes(100_000, 5);
        Sending s = begin(owner, "short.bin", data);
        rig.sendBytes(owner, s, data, 40_000);
        Map<String, Object> reply = finish(owner, s, data);
        assertThat(reply).containsEntry("_kind", "ERR").containsEntry("code", "conflict");
        assertThat(m(reply.get("details"))).containsEntry("reason", "incomplete");
        assertThat(((Number) m(reply.get("details")).get("committed")).longValue()).isLessThanOrEqualTo(40_000);
        // The rest arrives and it works.
        rig.sendBytes(owner, s, data, data.length);
        rig.drain(owner, s, data.length);
        assertThat(finish(owner, s, data)).containsEntry("_kind", "RES");
    }

    @Test
    void finishWaitsForBytesStillOnTheirWayOnTheOtherChannel() throws Exception {
        byte[] data = FilesRig.bytes(200_000, 6);
        Sending s = begin(owner, "late.bin", data);
        UploadWriter.slowWriteMs = 30;
        rig.sendBytes(owner, s, data, data.length);
        // finish goes out at once; the writer is still working through the queue.
        Map<String, Object> reply = finish(owner, s, data);
        assertThat(reply).containsEntry("_kind", "RES");
        assertThat(Files.readAllBytes(rig.root.resolve("late.bin"))).isEqualTo(data);
    }

    // ---- rules of the frames

    @Test
    void aFramePastTheCreditEndsOnlyThatTransferAndKeepsThePartial() throws Exception {
        byte[] data = FilesRig.bytes(3 * 1024 * 1024, 7);
        Sending s = begin(owner, "greedy.bin", data);
        // A slow disk, so no credit is granted before the overshoot arrives. 1 MiB window; ignore it and send 1 MiB + 1.
        UploadWriter.slowWriteMs = 150;
        long sent = 0;
        long seq = 0;
        while (sent < 1024 * 1024 + 1) {
            int n = (int) Math.min(Frame.MAX_PAYLOAD_BYTES, 1024 * 1024 + 1 - sent);
            owner.sendFrame(Channels.BULK, FrameKind.CHUNK, Frame.BIN, s.transferId, seq++, java.util.Arrays.copyOfRange(data, (int) sent, (int) sent + n));
            sent += n;
        }
        s.credit = 0;
        s.sent = sent;
        while (s.error == null) {
            rig.readCredit(owner, s);
        }
        UploadWriter.slowWriteMs = 0;
        assertThat(s.error).isEqualTo("credit_violation");
        assertThat(s.committed).isGreaterThan(0).isLessThanOrEqualTo(1024 * 1024);
        // The session is fine: a call still works, and the upload resumes.
        Map<String, Object> status = rig.ok(owner, "files.upload.status", "uploadId", s.uploadId);
        assertThat(((Number) status.get("committed")).longValue()).isEqualTo(s.committed);
        Sending again = new Sending(s.uploadId, ((Number) status.get("transferId")).longValue(), ((Number) status.get("window")).longValue(), s.committed);
        rig.sendBytes(owner, again, data, data.length);
        rig.drain(owner, again, data.length);
        assertThat(finish(owner, again, data)).containsEntry("_kind", "RES");
        assertThat(Files.readAllBytes(rig.root.resolve("greedy.bin"))).isEqualTo(data);
    }

    @Test
    void aFrameOutOfSequenceEndsTheTransfer() throws Exception {
        byte[] data = FilesRig.bytes(50_000, 8);
        Sending s = begin(owner, "seq.bin", data);
        owner.sendFrame(Channels.BULK, FrameKind.CHUNK, Frame.BIN, s.transferId, 0, java.util.Arrays.copyOfRange(data, 0, 1000));
        owner.sendFrame(Channels.BULK, FrameKind.CHUNK, Frame.BIN, s.transferId, 2, java.util.Arrays.copyOfRange(data, 1000, 2000));
        s.credit = 0;
        while (s.error == null) {
            rig.readCredit(owner, s);
        }
        assertThat(s.error).isEqualTo("seq");
        assertThat(s.committed).isEqualTo(1000);
        assertThat(rig.ok(owner, "files.list", "path", "")).containsEntry("skipped", 0);
    }

    @Test
    void framesForAnUnknownTransferAreIgnoredSilently() throws Exception {
        owner.sendFrame(Channels.BULK, FrameKind.CHUNK, Frame.BIN, 99, 0, new byte[100]);
        assertThat(rig.ok(owner, "files.usage")).containsKey("drive");
    }

    // ---- resume

    @Test
    void anUploadResumesAfterTheSessionIsLost() throws Exception {
        byte[] data = FilesRig.bytes(2 * 1024 * 1024 + 7, 9);
        Sending s = begin(owner, "resume.bin", data);
        rig.sendBytes(owner, s, data, 700_000);
        await().until(() -> rig.partials().size() == 2);
        rig.sessions.close("s-1", 1000, "closed_by_desk");
        await().until(() -> !rig.sessions.isLive("s-1"));
        await().until(() -> rig.files.uploads().runningCount() == 0);

        TestClient second = rig.owner("s-2");
        Map<String, Object> status = rig.ok(second, "files.upload.status", "uploadId", s.uploadId);
        long committed = ((Number) status.get("committed")).longValue();
        assertThat(committed).isEqualTo(700_000);
        assertThat(status).containsEntry("path", "resume.bin").containsEntry("size", data.length);
        Sending again = new Sending(s.uploadId, ((Number) status.get("transferId")).longValue(), ((Number) status.get("window")).longValue(), committed);
        // seq starts again at 0 for the new attachment.
        rig.sendBytes(second, again, data, data.length);
        rig.drain(second, again, data.length);
        Map<String, Object> done = finish(second, again, data);
        assertThat(done).containsEntry("_kind", "RES");
        assertThat(Files.readAllBytes(rig.root.resolve("resume.bin"))).isEqualTo(data);
    }

    @Test
    void afterADeskdRestartAStatusTruncatesToTheDurableLengthAndTheDigestStillCoversTheFile() throws Exception {
        byte[] data = FilesRig.bytes(1_500_000, 10);
        Sending s = begin(owner, "crash.bin", data);
        rig.sendBytes(owner, s, data, 900_000);
        rig.sessions.close("s-1", 1000, "closed_by_desk");
        await().until(() -> rig.files.uploads().runningCount() == 0);
        // Pretend the power went: the sidecar says 400,000 bytes were durable, and a torn tail of junk follows them.
        Path sidecar = rig.root.resolve(".uploads").resolve(s.uploadId + ".json");
        Map<String, Object> side = com.minimalistalliance.desk.deskd.protocol.Json.parseObject(Files.readAllBytes(sidecar));
        side.put("durable", 400_000L);
        Files.write(sidecar, com.minimalistalliance.desk.deskd.protocol.Json.bytes(side));
        byte[] junk = new byte[500_000];
        java.util.Arrays.fill(junk, (byte) 0x55);
        try (var torn = java.nio.channels.FileChannel.open(rig.root.resolve(".uploads").resolve(s.uploadId + ".part"), java.nio.file.StandardOpenOption.WRITE)) {
            torn.write(java.nio.ByteBuffer.wrap(junk), 400_000);
        }
        rig.close();
        rig = new FilesRig(dir, false, true, Quota.FLOOR_BYTES, Duration.ofMillis(400));
        FilesRig restarted = rig;
        TestClient fresh = restarted.owner("s-9");
        Map<String, Object> status = restarted.ok(fresh, "files.upload.status", "uploadId", s.uploadId);
        assertThat(status).containsEntry("committed", 400_000);
        assertThat(Files.size(restarted.root.resolve(".uploads").resolve(s.uploadId + ".part"))).isEqualTo(400_000);
        Sending again = new Sending(s.uploadId, ((Number) status.get("transferId")).longValue(), ((Number) status.get("window")).longValue(), 400_000);
        restarted.sendBytes(fresh, again, data, data.length);
        restarted.drain(fresh, again, data.length);
        Map<String, Object> done = restarted.call(fresh, "files.upload.finish", "uploadId", s.uploadId, "sha256", FilesRig.sha(data), "size", (long) data.length);
        assertThat(done).as(done.toString()).containsEntry("_kind", "RES");
        assertThat(Files.readAllBytes(restarted.root.resolve("crash.bin"))).isEqualTo(data);
    }

    @Test
    void aNewerSessionSupersedesAnOlderOne() throws Exception {
        byte[] data = FilesRig.bytes(600_000, 11);
        Sending s = begin(owner, "twice.bin", data);
        rig.sendBytes(owner, s, data, 200_000);
        TestClient second = rig.owner("s-2");
        Map<String, Object> status = rig.ok(second, "files.upload.status", "uploadId", s.uploadId);
        // The first session's transfer ends with the terminal credit.
        while (s.error == null) {
            rig.readCredit(owner, s);
        }
        assertThat(s.error).isEqualTo("superseded");
        Sending again = new Sending(s.uploadId, ((Number) status.get("transferId")).longValue(), ((Number) status.get("window")).longValue(),
                ((Number) status.get("committed")).longValue());
        // The old session can no longer finish it.
        Map<String, Object> old = rig.call(owner, "files.upload.finish", "uploadId", s.uploadId, "sha256", FilesRig.sha(data), "size", (long) data.length);
        assertThat(old).containsEntry("code", "conflict");
        assertThat(m(old.get("details"))).containsEntry("reason", "attached");
        rig.sendBytes(second, again, data, data.length);
        rig.drain(second, again, data.length);
        assertThat(finish(second, again, data)).containsEntry("_kind", "RES");
        assertThat(Files.readAllBytes(rig.root.resolve("twice.bin"))).isEqualTo(data);
    }

    @Test
    void abortDeletesThePartialAndIsIdempotent() throws Exception {
        byte[] data = FilesRig.bytes(10_000, 12);
        Sending s = begin(owner, "gone.bin", data);
        rig.sendBytes(owner, s, data, 5000);
        assertThat(rig.ok(owner, "files.upload.abort", "uploadId", s.uploadId)).isNotNull();
        assertThat(rig.partials()).isEmpty();
        rig.ok(owner, "files.upload.abort", "uploadId", s.uploadId);
        rig.ok(owner, "files.upload.abort", "uploadId", "0".repeat(26));
        rig.err(owner, "not_found", "files.upload.status", "uploadId", s.uploadId);
        rig.err(owner, "bad_request", "files.upload.abort", "uploadId", "nope");
    }

    @Test
    void anotherMemberNeverSeesOrTouchesAnUpload() throws Exception {
        byte[] data = FilesRig.bytes(1000, 13);
        Sending s = begin(owner, "mine.bin", data);
        TestClient stranger = rig.other("s-x", "user-2");
        rig.err(stranger, "not_found", "files.upload.status", "uploadId", s.uploadId);
        rig.ok(stranger, "files.upload.abort", "uploadId", s.uploadId);
        assertThat(rig.partials()).hasSize(2);
        rig.sendBytes(owner, s, data, data.length);
        rig.drain(owner, s, data.length);
        rig.err(stranger, "not_found", "files.upload.finish", "uploadId", s.uploadId, "sha256", FilesRig.sha(data), "size", 1000L);
        assertThat(finish(owner, s, data)).containsEntry("_kind", "RES");
    }

    // ---- room

    @Test
    void beginRefusesWhatWouldTakeTheFloorAndSaysTheNumbers() throws Exception {
        rig.freeBytes.set(Quota.FLOOR_BYTES + 1000);
        Map<String, Object> reply = rig.err(owner, "no_space", "files.upload.begin", "path", "big", "size", 1001L);
        assertThat(m(reply.get("details"))).containsEntry("floorBytes", 2147483648L).containsEntry("needBytes", 1001)
                .containsEntry("freeBytes", 2147483648L + 1000);
        assertThat(rig.ok(owner, "files.upload.begin", "path", "just-fits", "size", 1000L)).containsKey("uploadId");
        assertThat(rig.partials()).hasSize(2);
    }

    @Test
    void twoUploadsCantBothTakeTheLastGigabyte() throws Exception {
        long gib = 1024L * 1024 * 1024;
        rig.freeBytes.set(Quota.FLOOR_BYTES + gib + gib / 2);
        rig.ok(owner, "files.upload.begin", "path", "one", "size", gib);
        Map<String, Object> second = rig.err(owner, "no_space", "files.upload.begin", "path", "two", "size", gib);
        assertThat(((Number) m(second.get("details")).get("needBytes")).longValue()).isEqualTo(gib);
        Map<String, Object> usage = rig.ok(owner, "files.usage");
        assertThat(((Number) usage.get("uploadableBytes")).longValue()).isEqualTo(gib / 2);
    }

    @Test
    void theDriveFillingUpMidUploadEndsItWithNoSpaceAndKeepsThePartial() throws Exception {
        byte[] data = FilesRig.bytes(12 * 1024 * 1024, 14);
        Sending s = begin(owner, "grows.bin", data);
        // Another app fills the drive: leave less than what is still to come.
        rig.freeBytes.set(Quota.FLOOR_BYTES + 1024 * 1024);
        while (s.error == null && s.sent < data.length) {
            if (s.credit > 0) {
                rig.sendBytes(owner, s, data, Math.min(data.length, s.sent + s.credit));
            } else {
                rig.readCredit(owner, s);
            }
        }
        while (s.error == null) {
            rig.readCredit(owner, s);
        }
        assertThat(s.error).isEqualTo("no_space");
        assertThat(rig.partials()).hasSize(2);
        assertThat(s.committed).isBetween(1L, (long) data.length - 1);
    }

    // ---- limits and sweeps

    @Test
    void theNinthTransferInASessionIsTooMany() throws Exception {
        for (int i = 0; i < 8; i++) {
            rig.ok(owner, "files.upload.begin", "path", "f" + i, "size", 10L);
        }
        Map<String, Object> reply = rig.err(owner, "too_many", "files.upload.begin", "path", "f9", "size", 10L);
        assertThat(m(reply.get("details"))).containsEntry("limit", 8).containsEntry("reason", "session");
    }

    @Test
    void downloadsAndUploadsShareTheOneTable() throws Exception {
        rig.file("src.bin", FilesRig.bytes(3 * 1024 * 1024, 15));
        for (int i = 0; i < 4; i++) {
            rig.ok(owner, "files.read", "path", "src.bin");
        }
        for (int i = 0; i < 4; i++) {
            rig.ok(owner, "files.upload.begin", "path", "u" + i, "size", 10L);
        }
        rig.err(owner, "too_many", "files.upload.begin", "path", "u9", "size", 10L);
        rig.err(owner, "too_many", "files.read", "path", "src.bin");
    }

    @Test
    void thirteenTransfersOnADeskAreTooMany() throws Exception {
        List<TestClient> sessions = new ArrayList<>();
        sessions.add(owner);
        for (int i = 0; i < 3; i++) {
            sessions.add(rig.owner("m-" + i));
        }
        int made = 0;
        for (int i = 0; i < 12; i++) {
            rig.ok(sessions.get(i / 3), "files.upload.begin", "path", "d" + i, "size", 10L);
            made++;
        }
        Map<String, Object> reply = rig.err(sessions.get(3), "too_many", "files.upload.begin", "path", "d13", "size", 10L);
        assertThat(m(reply.get("details"))).containsEntry("limit", 12).containsEntry("reason", "desk");
        assertThat(made).isEqualTo(12);
    }

    @Test
    void partialsWithNoProgressForADayAreSweptAndRecentOnesStay() throws Exception {
        Sending old = begin(owner, "old.bin", new byte[100]);
        rig.sessions.close("s-1", 1000, "closed_by_desk");
        await().until(() -> rig.files.uploads().runningCount() == 0);
        TestClient second = rig.owner("s-2");
        Sending recent = begin(second, "recent.bin", new byte[100]);
        // Age the old one: its files and its sidecar's own clock.
        Path uploads = rig.root.resolve(".uploads");
        Path sidecar = uploads.resolve(old.uploadId + ".json");
        Map<String, Object> side = com.minimalistalliance.desk.deskd.protocol.Json.parseObject(Files.readAllBytes(sidecar));
        side.put("lastProgressAt", rig.clock.millis() - Duration.ofHours(25).toMillis());
        Files.write(sidecar, com.minimalistalliance.desk.deskd.protocol.Json.bytes(side));
        // File times come from the test clock, not the wall clock: the sweep compares them with the clock under test.
        long past = rig.clock.millis() - Duration.ofDays(3).toMillis();
        Files.setLastModifiedTime(uploads.resolve(old.uploadId + ".part"), java.nio.file.attribute.FileTime.fromMillis(past));
        Files.setLastModifiedTime(sidecar, java.nio.file.attribute.FileTime.fromMillis(past));
        rig.clock.advance(Duration.ofSeconds(1));
        rig.files.sweep();
        assertThat(Files.exists(uploads.resolve(recent.uploadId + ".part"))).isTrue();
        assertThat(Files.exists(uploads.resolve(old.uploadId + ".part")) && Files.exists(sidecar)).isFalse();
    }

    // ---- the lane never waits for the disk

    @Test
    void aSlowDiskDoesNotHoldUpADownloadOnTheSameSession() throws Exception {
        byte[] src = FilesRig.bytes(400_000, 16);
        rig.file("down.bin", src);
        byte[] data = FilesRig.bytes(1024 * 1024, 17);
        Sending s = begin(owner, "slow.bin", data);
        UploadWriter.slowWriteMs = 200;
        rig.sendBytes(owner, s, data, 1024 * 1024);
        // The disk is crawling, but the lane returned at once; a download on the same session runs now.
        Map<String, Object> read = rig.ok(owner, "files.read", "path", "down.bin");
        long id = ((Number) read.get("transferId")).longValue();
        long got = 0;
        while (true) {
            Frame frame = owner.next(Channels.BULK);
            if (frame.kind() == FrameKind.CHUNK && frame.id() == id) {
                if ((frame.flags() & Frame.END) != 0) {
                    break;
                }
                got += frame.payload().length;
            }
        }
        assertThat(got).isEqualTo(400_000);
        assertThat(rig.files.uploads().runningCount()).isEqualTo(1);
        UploadWriter.slowWriteMs = 0;
    }
}
