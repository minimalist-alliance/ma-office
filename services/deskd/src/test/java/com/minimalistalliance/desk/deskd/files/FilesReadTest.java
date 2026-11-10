package com.minimalistalliance.desk.deskd.files;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.deskd.platform.StreamingPause;
import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.Frame;
import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class FilesReadTest {

    @TempDir
    Path dir;

    FilesRig rig;
    TestClient owner;

    @BeforeEach
    void setUp() throws Exception {
        rig = new FilesRig(dir);
        owner = rig.owner("s-1");
    }

    @AfterEach
    void tearDown() throws Exception {
        rig.close();
    }

    private record Received(byte[] bytes, byte[] end, long firstSeq) {}

    private Received receive(long transferId, long expectSeq) throws Exception {
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        long sinceGrant = 0;
        long first = expectSeq;
        while (true) {
            Frame frame = owner.next(Channels.BULK);
            assertThat(frame.kind()).isEqualTo(FrameKind.CHUNK);
            assertThat(frame.id()).isEqualTo(transferId);
            assertThat(frame.seq()).isEqualTo(expectSeq++);
            assertThat(frame.flags() & Frame.BIN).isEqualTo(Frame.BIN);
            if ((frame.flags() & Frame.END) != 0) {
                return new Received(bytes.toByteArray(), frame.payload(), first);
            }
            bytes.write(frame.payload());
            sinceGrant += frame.payload().length;
            if (sinceGrant >= 256 * 1024) {
                owner.sendJson(Channels.BULK, FrameKind.CREDIT, transferId, Map.of("bytes", sinceGrant));
                sinceGrant = 0;
            }
        }
    }

    private static byte[] trailer(byte[] whole) {
        ByteBuffer out = ByteBuffer.allocate(40);
        out.put(java.util.HexFormat.of().parseHex(FilesRig.sha(whole)));
        out.putLong(whole.length);
        return out.array();
    }

    @Test
    void aReadSendsTheBytesThenTheHashAndSizeOfTheWholeFile() throws Exception {
        byte[] data = FilesRig.bytes(3 * 1024 * 1024 + 99, 1);
        rig.file("movie.bin", data);
        Map<String, Object> reply = rig.ok(owner, "files.read", "path", "movie.bin");
        assertThat(reply).containsEntry("size", data.length);
        assertThat(((Number) reply.get("mtimeMs")).longValue()).isPositive();
        Received r = receive(((Number) reply.get("transferId")).longValue(), 0);
        assertThat(r.bytes()).isEqualTo(data);
        assertThat(r.end()).isEqualTo(trailer(data));
    }

    @Test
    void aReadFromAnOffsetStillHashesTheWholeFile() throws Exception {
        byte[] data = FilesRig.bytes(1_000_000, 2);
        rig.file("a.bin", data);
        Map<String, Object> reply = rig.ok(owner, "files.read", "path", "a.bin", "offset", 400_000L);
        Received r = receive(((Number) reply.get("transferId")).longValue(), 0);
        assertThat(r.bytes()).isEqualTo(Arrays.copyOfRange(data, 400_000, data.length));
        assertThat(r.end()).isEqualTo(trailer(data));
        rig.err(owner, "bad_request", "files.read", "path", "a.bin", "offset", 1_000_001L);
        Map<String, Object> atEnd = rig.ok(owner, "files.read", "path", "a.bin", "offset", 1_000_000L);
        assertThat(receive(((Number) atEnd.get("transferId")).longValue(), 0).bytes()).isEmpty();
    }

    @Test
    void anEmptyFileIsJustTheTrailer() throws Exception {
        rig.file("e", new byte[0]);
        Map<String, Object> reply = rig.ok(owner, "files.read", "path", "e");
        Received r = receive(((Number) reply.get("transferId")).longValue(), 0);
        assertThat(r.bytes()).isEmpty();
        assertThat(r.end()).isEqualTo(trailer(new byte[0]));
    }

    @Test
    void aRenameOrDeleteDuringTheReadChangesNothingThatIsSent() throws Exception {
        byte[] data = FilesRig.bytes(2 * 1024 * 1024, 3);
        rig.file("stay.bin", data);
        Map<String, Object> reply = rig.ok(owner, "files.read", "path", "stay.bin");
        long id = ((Number) reply.get("transferId")).longValue();
        // The first window (1 MiB) is in flight; the file is removed and a different one takes the name.
        rig.ok(owner, "files.delete", "paths", java.util.List.of("stay.bin"));
        Files.write(rig.root.resolve("stay.bin"), new byte[10]);
        Received r = receive(id, 0);
        assertThat(r.bytes()).isEqualTo(data);
        assertThat(r.end()).isEqualTo(trailer(data));
    }

    @Test
    void whatIsNotAFileIsNotRead() throws Exception {
        rig.file("d/x", new byte[3]);
        Files.createSymbolicLink(rig.root.resolve("lnk"), Path.of("d/x"));
        Files.createLink(rig.root.resolve("hard"), rig.root.resolve("d/x"));
        Map<String, Object> folder = rig.err(owner, "invalid", "files.read", "path", "d");
        assertThat((Map<String, Object>) folder.get("details")).containsEntry("reason", "is_a_folder");
        rig.err(owner, "not_found", "files.read", "path", "lnk");
        rig.err(owner, "not_found", "files.read", "path", "hard");
        rig.err(owner, "not_found", "files.read", "path", "ghost");
        rig.err(owner, "invalid", "files.read", "path", "../etc/passwd");
        rig.err(owner, "invalid", "files.read", "path", ".trash/x");
    }

    @Test
    void theBandwidthPauseRefusesANewReadButNotTheRest() throws Exception {
        rig.file("a.bin", new byte[100]);
        StreamingPause pause = new StreamingPause(rig.clock);
        rig.files.followStreamingPause(pause);
        pause.apply(Map.of("streamProfile", "paused", "resumesAt", "2026-11-08T13:00:00Z"));
        Map<String, Object> reply = rig.err(owner, "unavailable", "files.read", "path", "a.bin");
        assertThat((Map<String, Object>) reply.get("details")).containsEntry("reason", "bandwidth_limit").containsEntry("resumesAt", "2026-11-08T13:00:00Z");
        rig.ok(owner, "files.list", "path", "");
        rig.ok(owner, "files.upload.begin", "path", "up", "size", 5L);
    }

    @Test
    void readStopEndsOneTransferAndFreesItsPlace() throws Exception {
        rig.file("big.bin", FilesRig.bytes(5 * 1024 * 1024, 4));
        Map<String, Object> reply = rig.ok(owner, "files.read", "path", "big.bin");
        long id = ((Number) reply.get("transferId")).longValue();
        rig.ok(owner, "files.read.stop", "transferId", id);
        rig.ok(owner, "files.read.stop", "transferId", id);
        org.awaitility.Awaitility.await().until(() -> rig.transfers.count("s-1") == 0);
    }

    @Test
    void ownerBytesNoteActivityForTheIdleRule() throws Exception {
        rig.file("a.bin", FilesRig.bytes(50_000, 5));
        assertThat(rig.sessions.lastInputAt()).isNull();
        Map<String, Object> reply = rig.ok(owner, "files.read", "path", "a.bin");
        receive(((Number) reply.get("transferId")).longValue(), 0);
        assertThat(rig.sessions.lastInputAt()).isNotNull();
    }
}
