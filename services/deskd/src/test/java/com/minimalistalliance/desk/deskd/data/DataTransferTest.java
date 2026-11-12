package com.minimalistalliance.desk.deskd.data;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.Frame;
import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.rpc.RpcPrincipal;
import com.minimalistalliance.desk.deskd.rtc.RtcClient;
import com.minimalistalliance.desk.deskd.testing.FakeDataHelper;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;
import java.util.Random;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** data.parts.list, data.manifest and data.read, from a client's frames through to a fake desk-data and back on bulk. */
class DataTransferTest {

    private static final int MIB = 1024 * 1024;

    @TempDir
    Path dir;

    private DataRig rig;

    @BeforeEach
    void setUp() throws Exception {
        rig = new DataRig(dir);
        rig.helper.part("browser", "Browser");
        rig.helper.part("files", "Files");
    }

    @AfterEach
    void tearDown() throws Exception {
        rig.close();
    }

    private static byte[] file(int size, long seed) {
        byte[] bytes = new byte[size];
        new Random(seed).nextBytes(bytes);
        return bytes;
    }

    private long startRead(TestClient client, String part, String path, long offset) throws Exception {
        Map<String, Object> reply = rig.call(client, "data.read", Map.of("part", part, "path", path, "offset", offset));
        assertThat(reply).containsEntry("_kind", "RES");
        return ((Number) reply.get("transferId")).longValue();
    }

    private static long sum(List<Frame> frames) {
        return frames.stream().mapToLong(frame -> frame.payload().length).sum();
    }

    /** Frames until this many bytes of the file have come. */
    private static List<Frame> take(TestClient client, long bytes) throws Exception {
        List<Frame> frames = new ArrayList<>();
        while (sum(frames) < bytes) {
            Frame frame = client.next(Channels.BULK);
            assertThat(frame.flags() & Frame.END).isZero();
            frames.add(frame);
        }
        return frames;
    }

    @Test
    void partsAndTheManifestPassThroughFromTheHelper() throws Exception {
        rig.helper.file("browser", "profile/Default/Cookies", new byte[] {1, 2, 3});
        rig.helper.file("files", "notes.txt", "hello".getBytes(StandardCharsets.UTF_8));
        TestClient client = rig.owner("cs-1");

        Map<String, Object> parts = rig.call(client, "data.parts.list", Map.of());
        assertThat(parts).containsEntry("_kind", "RES").containsEntry("helperVersion", "fake-1");
        assertThat(DataRig.list(parts.get("parts"))).containsExactly(
                Map.of("part", "browser", "label", "Browser", "files", 1, "bytes", 3),
                Map.of("part", "files", "label", "Files", "files", 1, "bytes", 5));

        Map<String, Object> page = rig.call(client, "data.manifest", Map.of("part", "files"));
        assertThat(page).containsEntry("_kind", "RES").containsEntry("next", null);
        assertThat(DataRig.list(page.get("entries"))).containsExactly(
                Map.of("path", "notes.txt", "type", "file", "size", 5, "mtimeMs", 1_762_400_000_000L, "mode", 0600));
        List<Map<String, Object>> requests = rig.helper.requests();
        assertThat(requests.get(0)).isEqualTo(Map.of("v", 1, "op", "parts"));
        assertThat(requests.get(1)).containsEntry("v", 1).containsEntry("op", "manifest").containsEntry("part", "files")
                .containsEntry("limit", 2000).containsKey("cursor");
        assertThat(requests.get(1).get("cursor")).isNull();
    }

    @Test
    void theManifestPagesWithTheHelpersCursor() throws Exception {
        for (int i = 0; i < 2001; i++) {
            rig.helper.file("files", String.format("f%05d", i), new byte[0]);
        }
        TestClient client = rig.owner("cs-1");
        Map<String, Object> first = rig.call(client, "data.manifest", Map.of("part", "files"));
        assertThat(DataRig.list(first.get("entries"))).hasSize(2000);
        assertThat(first).containsEntry("next", "f01999");
        Map<String, Object> second = rig.call(client, "data.manifest", Map.of("part", "files", "cursor", "f01999"));
        assertThat(DataRig.list(second.get("entries"))).hasSize(1);
        assertThat(second).containsEntry("next", null);
    }

    @Test
    void aPageTooLargeForOneReplyIsAskedForSmaller() throws Exception {
        for (int i = 0; i < 2001; i++) {
            rig.helper.file("files", String.format("f%05d", i), new byte[0]);
        }
        // About 700 bytes an entry: 2,000 of them are past 1 MiB, and 500 aren't.
        rig.helper.padManifestEntries(600);
        TestClient client = rig.owner("cs-1");
        Map<String, Object> page = rig.call(client, "data.manifest", Map.of("part", "files"));
        assertThat(page).containsEntry("_kind", "RES").containsEntry("next", "f00499");
        assertThat(DataRig.list(page.get("entries"))).hasSize(500);
        assertThat(rig.helper.requests()).extracting(request -> request.get("limit")).containsExactly(2000, 500);
    }

    @Test
    void aReadStopsAtTheFirstMebibyteUntilCreditComesAndEndsWithTheHelpersTrailer() throws Exception {
        byte[] bytes = file(3 * MIB + 12_345, 1);
        rig.helper.file("files", "video.mp4", bytes);
        TestClient client = rig.export("cs-1");
        Map<String, Object> reply = rig.call(client, "data.read", Map.of("part", "files", "path", "video.mp4", "offset", 0));
        assertThat(reply).containsEntry("_kind", "RES").containsEntry("size", bytes.length).containsEntry("mtimeMs", 1_762_400_000_000L);
        long id = ((Number) reply.get("transferId")).longValue();
        assertThat(id).isEqualTo(1);

        List<Frame> first = take(client, MIB);
        assertThat(sum(first)).isEqualTo(MIB);
        // Full frames, then the last of the window: credit is used exactly.
        assertThat(first.subList(0, first.size() - 1)).allSatisfy(frame -> assertThat(frame.payload()).hasSize(Frame.MAX_PAYLOAD_BYTES));
        assertThat(rig.fake.pollFrame(client.handle(), Channels.BULK, 300)).as("nothing past the window").isNull();

        rig.credit(client, id, 256 * 1024);
        List<Frame> more = take(client, 256 * 1024);
        assertThat(sum(more)).isEqualTo(256 * 1024);
        assertThat(rig.fake.pollFrame(client.handle(), Channels.BULK, 200)).isNull();

        rig.credit(client, id, 4L * MIB);
        DataRig.Received rest = DataRig.receive(client, id, 0, rig, first.size() + more.size());
        byte[] all = concat(first, more, rest.bytes());
        assertThat(all).isEqualTo(bytes);
        assertThat(rest.end()).isEqualTo(FakeDataHelper.trailer(bytes));
        assertThat(first.get(0).seq()).isZero();
        await().until(() -> rig.helper.openConnections() == 0 && rig.data.transfers().count("cs-1") == 0);
    }

    @Test
    void framesFillAcrossTheHelpersChunksAndEveryFrameByteCountsAsFree() throws Exception {
        rig.helper.chunkBytes(1000);
        byte[] bytes = file(100_000, 2);
        rig.helper.file("files", "a.bin", bytes);
        TestClient client = rig.export("cs-1");
        long id = startRead(client, "files", "a.bin", 0);
        DataRig.Received got = DataRig.receive(client, id, 0, rig);
        assertThat(got.bytes()).isEqualTo(bytes);
        // 6 full frames, one of the 1,768 left, and END.
        assertThat(got.frames()).isEqualTo(8);
        assertThat(got.frameBytes()).isEqualTo(100_000 + 8 * Frame.HEADER_BYTES + 40);
        await().until(() -> rig.data.freeBytesSent() == got.frameBytes());
        // And the file desk-egress reads, within the 100 ms the rig writes it at.
        await().atMost(Duration.ofSeconds(5)).until(() -> Files.exists(dir.resolve("free-bytes"))
                && Files.readString(dir.resolve("free-bytes")).equals("boot-1 " + got.frameBytes() + "\n"));
    }

    @Test
    void aReadResumesFromAnOffsetAndTheTrailerStillCoversTheWholeFile() throws Exception {
        byte[] bytes = file(200_000, 3);
        rig.helper.file("files", "a.bin", bytes);
        TestClient client = rig.owner("cs-1");
        long id = startRead(client, "files", "a.bin", 150_001);
        DataRig.Received got = DataRig.receive(client, id, 0, rig);
        assertThat(got.bytes()).isEqualTo(Arrays.copyOfRange(bytes, 150_001, bytes.length));
        assertThat(got.end()).isEqualTo(FakeDataHelper.trailer(bytes));
        assertThat(rig.helper.requests()).last()
                .isEqualTo(Map.of("v", 1, "op", "read", "part", "files", "path", "a.bin", "offset", 150_001));
    }

    @Test
    void aBigFileWithTheReaderGrantingAsItWritesArrivesWhole() throws Exception {
        byte[] bytes = file(5 * MIB + 7, 4);
        rig.helper.file("files", "big.bin", bytes);
        TestClient client = rig.export("cs-1");
        long id = startRead(client, "files", "big.bin", 0);
        DataRig.Received got = DataRig.receive(client, id, 256 * 1024, rig);
        assertThat(got.bytes()).isEqualTo(bytes);
        assertThat(got.end()).isEqualTo(FakeDataHelper.trailer(bytes));
    }

    @Test
    void anEmptyFileIsJustItsTrailer() throws Exception {
        rig.helper.file("files", "empty", new byte[0]);
        TestClient client = rig.owner("cs-1");
        long id = startRead(client, "files", "empty", 0);
        DataRig.Received got = DataRig.receive(client, id, 0, rig);
        assertThat(got.frames()).isEqualTo(1);
        assertThat(got.end()).isEqualTo(FakeDataHelper.trailer(new byte[0]));
    }

    @Test
    void aNinthTransferIsTooManyUntilOneEnds() throws Exception {
        rig.helper.file("files", "big.bin", file(4 * MIB, 5));
        TestClient client = rig.owner("cs-1");
        List<Long> ids = new ArrayList<>();
        for (int i = 0; i < 8; i++) {
            ids.add(startRead(client, "files", "big.bin", 0));
        }
        assertThat(ids).containsExactly(1L, 2L, 3L, 4L, 5L, 6L, 7L, 8L);
        int before = rig.helper.connectionsAccepted();
        Map<String, Object> ninth = rig.call(client, "data.read", Map.of("part", "files", "path", "big.bin", "offset", 0));
        assertThat(ninth).containsEntry("_kind", "ERR").containsEntry("code", "too_many");
        assertThat(Json.object(ninth, "details")).isEqualTo(Map.of("limit", 8, "reason", "session"));
        assertThat(rig.helper.connectionsAccepted()).as("the helper wasn't asked").isEqualTo(before);

        assertThat(rig.call(client, "data.read.stop", Map.of("transferId", 3))).containsEntry("_kind", "RES");
        await().until(() -> rig.data.transfers().count("cs-1") == 7);
        // Ids aren't reused within a session.
        assertThat(startRead(client, "files", "big.bin", 0)).isEqualTo(9);
    }

    @Test
    void aSlowReaderHoldsLittleInDeskd() throws Exception {
        // desk-rtc gives no credit back, so only its first 256 KiB on bulk goes out and the rest waits in deskd.
        rig.fake.autoCredit(false);
        rig.helper.file("files", "big.bin", file(4 * MIB, 6));
        TestClient client = rig.owner("cs-1");
        for (int i = 0; i < 8; i++) {
            startRead(client, "files", "big.bin", 0);
        }
        long internal = (1L << 32) | client.handle();
        await().until(() -> rig.fake.bytesFromDeskd(client.handle(), Channels.BULK) > RtcClient.INITIAL_CREDIT - 16 * 1024);
        Thread.sleep(300);
        long queued = rig.rtc.queuedBytes(internal, Channels.BULK);
        assertThat(queued).isPositive().isLessThan(8L * MIB).isLessThanOrEqualTo(8L * (64 + 16) * 1024);
        assertThat(rig.fake.bytesFromDeskd(client.handle(), Channels.BULK)).isLessThanOrEqualTo(RtcClient.INITIAL_CREDIT);
        // And ctl isn't held up behind it.
        client.send(Channels.CTL, FrameKind.PING, 77, 0, new byte[0]);
        assertThat(client.next(Channels.CTL).kind()).isEqualTo(FrameKind.PONG);
    }

    @Test
    void aStopEndsTheTransferAndClosesItsHelperConnection() throws Exception {
        rig.helper.file("files", "big.bin", file(8 * MIB, 7));
        TestClient client = rig.owner("cs-1");
        long id = startRead(client, "files", "big.bin", 0);
        take(client, MIB);
        assertThat(rig.helper.openConnections()).isEqualTo(1);
        assertThat(rig.call(client, "data.read.stop", Map.of("transferId", id))).containsEntry("_kind", "RES");
        await().until(() -> rig.helper.openConnections() == 0);
        rig.credit(client, id, 4L * MIB);
        assertThat(rig.fake.pollFrame(client.handle(), Channels.BULK, 300)).as("nothing more, not even END").isNull();
        // Stopping again, or what never was, is fine.
        assertThat(rig.call(client, "data.read.stop", Map.of("transferId", id))).containsEntry("_kind", "RES");
        assertThat(rig.call(client, "data.read.stop", Map.of("transferId", 999))).containsEntry("_kind", "RES");
    }

    @Test
    void aSessionsEndEndsItsTransfersAndClosesTheirHelperConnections() throws Exception {
        rig.helper.file("files", "big.bin", file(8 * MIB, 8));
        TestClient client = rig.export("cs-1");
        TestClient other = rig.owner("cs-2");
        startRead(client, "files", "big.bin", 0);
        startRead(client, "files", "big.bin", 0);
        long kept = startRead(other, "files", "big.bin", 0);
        take(client, 2L * MIB);
        await().until(() -> rig.helper.openConnections() == 3);
        client.sendJson(Channels.CTL, FrameKind.CLOSE, 0, Map.of("code", 1000, "reason", "done"));
        await().until(() -> rig.helper.openConnections() == 1 && rig.data.transfers().count("cs-1") == 0);
        // The other session's goes on.
        rig.credit(other, kept, 16L * MIB);
        DataRig.Received got = DataRig.receive(other, kept, 0, rig);
        assertThat(got.bytes()).hasSize(8 * MIB);
    }

    @Test
    void aHelperThatDiesMidFileEndsTheTransferWithAnEmptyEnd() throws Exception {
        byte[] bytes = file(300_000, 9);
        rig.helper.file("files", "a.bin", bytes);
        rig.helper.cutAfter(100_000);
        TestClient client = rig.owner("cs-1");
        long id = startRead(client, "files", "a.bin", 0);
        DataRig.Received got = DataRig.receive(client, id, 0, rig);
        // What came before the cut is the file's, and a frame's worth of it may not have gone.
        assertThat(got.bytes().length).isBetween(100_000 - Frame.MAX_PAYLOAD_BYTES, 100_000);
        assertThat(got.bytes()).isEqualTo(Arrays.copyOf(bytes, got.bytes().length));
        assertThat(got.end()).isEmpty();
        await().until(() -> rig.data.transfers().count("cs-1") == 0);
    }

    @Test
    void creditDeskdCantReadOrForNoTransferIsDropped() throws Exception {
        rig.helper.file("files", "a.bin", file(2 * MIB, 10));
        TestClient client = rig.owner("cs-1");
        long id = startRead(client, "files", "a.bin", 0);
        take(client, MIB);
        rig.credit(client, 42, MIB);
        client.sendJson(Channels.BULK, FrameKind.CREDIT, id, Map.of("bytes", -5));
        client.sendJson(Channels.BULK, FrameKind.CREDIT, id, Map.of("bytes", "lots"));
        client.send(Channels.BULK, FrameKind.CREDIT, id, 0, "not json".getBytes(StandardCharsets.UTF_8));
        client.send(Channels.BULK, FrameKind.DATA, id, 0, new byte[10]);
        assertThat(rig.fake.pollFrame(client.handle(), Channels.BULK, 300)).isNull();
        // The session is still fine, and real credit still works.
        assertThat(rig.call(client, "desk.status.get", Map.of())).containsEntry("_kind", "RES");
        rig.credit(client, id, MIB);
        take(client, MIB);
        Frame end = client.next(Channels.BULK);
        assertThat(end.flags() & Frame.END).isEqualTo(Frame.END);
        assertThat(end.payload()).hasSize(40);
    }

    @Test
    void theHelpersRefusalsBecomeTheClientsCodes() throws Exception {
        TestClient client = rig.owner("cs-1");
        Map<String, Object> missing = rig.call(client, "data.read", Map.of("part", "files", "path", "nope", "offset", 0));
        assertThat(missing).containsEntry("_kind", "ERR").containsEntry("code", "not_found");
        Map<String, Object> noPart = rig.call(client, "data.manifest", Map.of("part", "nope"));
        assertThat(noPart).containsEntry("code", "not_found");
        rig.helper.refuse("read", "invalid");
        assertThat(rig.call(client, "data.read", Map.of("part", "files", "path", "link", "offset", 0))).containsEntry("code", "invalid");
        rig.helper.refuse("parts", "failed");
        Map<String, Object> failed = rig.call(client, "data.parts.list", Map.of());
        assertThat(failed).containsEntry("code", "unavailable");
        assertThat(Json.object(failed, "details")).containsEntry("reason", "helper");
        rig.helper.refuse("parts", "denied");
        assertThat(Json.object(rig.call(client, "data.parts.list", Map.of()), "details")).containsEntry("reason", "helper");
        // A refused read leaves its place free.
        assertThat(rig.data.transfers().count("cs-1")).isZero();
    }

    @Test
    void pathsThatEscapeAreRefusedBeforeTheHelperHearsOfThem() throws Exception {
        TestClient client = rig.owner("cs-1");
        for (String path : List.of("../desk/x", "/etc/passwd", "a//b", "a/./b", "a/", "", "a\0b")) {
            Map<String, Object> reply = rig.call(client, "data.read", Map.of("part", "files", "path", path, "offset", 0));
            assertThat(reply).as(path).containsEntry("code", "invalid");
        }
        for (String part : List.of("..", ".", "a/b", "")) {
            assertThat(rig.call(client, "data.manifest", Map.of("part", part))).as(part).containsEntry("code", "invalid");
        }
        // Past the helper's 16 KiB line.
        String longPath = "d/".repeat(8200) + "f";
        Map<String, Object> tooLong = rig.call(client, "data.read", Map.of("part", "files", "path", longPath, "offset", 0));
        assertThat(tooLong).containsEntry("code", "invalid");
        assertThat(Json.object(tooLong, "details")).containsEntry("reason", "length");
        assertThat(rig.call(client, "data.read", Map.of("part", "files", "path", "a", "offset", -1))).containsEntry("code", "bad_request");
        assertThat(rig.call(client, "data.read", Map.of("part", 7, "path", "a"))).containsEntry("code", "bad_request");
        assertThat(rig.helper.requests()).isEmpty();
    }

    @Test
    void aPathOfManyKibibytesStillFitsTheHelpersLine() throws Exception {
        String path = "deep/".repeat(2000) + "f.txt";
        byte[] bytes = "far down".getBytes(StandardCharsets.UTF_8);
        rig.helper.file("files", path, bytes);
        TestClient client = rig.owner("cs-1");
        long id = startRead(client, "files", path, 0);
        assertThat(DataRig.receive(client, id, 0, rig).bytes()).isEqualTo(bytes);
        assertThat(rig.helper.requests().get(0).get("path")).isEqualTo(path);
    }

    @Test
    void theMachinesOwnDirectoriesAreNeverListedOrRead() throws Exception {
        rig.helper.part("rtc", "rtc");
        rig.helper.part("selfhost", "selfhost");
        rig.helper.file("selfhost", "key", "secret key".getBytes(StandardCharsets.UTF_8));
        rig.helper.file("rtc", "key.pem", "dtls key".getBytes(StandardCharsets.UTF_8));
        TestClient client = rig.export("cs-1");
        Map<String, Object> parts = rig.call(client, "data.parts.list", Map.of());
        List<Object> names = DataRig.list(parts.get("parts")).stream().map(part -> (Object) ((Map<?, ?>) part).get("part")).toList();
        assertThat(names).containsExactly("browser", "files");
        int asked = rig.helper.requests().size();
        for (String part : List.of("selfhost", "rtc", "desk-egress", "lost+found", ".ma-move", ".ma-export-tmp")) {
            assertThat(rig.call(client, "data.manifest", Map.of("part", part))).as(part).containsEntry("code", "not_found");
            assertThat(rig.call(client, "data.read", Map.of("part", part, "path", "key", "offset", 0))).as(part)
                    .containsEntry("code", "not_found");
        }
        assertThat(rig.helper.requests()).hasSize(asked);
    }

    @Test
    void aBundledAppsDataGoesButItsRegistryAndCacheNever() throws Exception {
        byte[] marks = "{\"marks\":[]}".getBytes(StandardCharsets.UTF_8);
        rig.helper.file("desk", "apps/registry.json", "{\"memberKey\":\"k\"}".getBytes(StandardCharsets.UTF_8));
        rig.helper.file("desk", "apps/.registry.json.tmp", "{}".getBytes(StandardCharsets.UTF_8));
        rig.helper.file("desk", "apps/com.example.reader/cache/index.bin", "rebuildable".getBytes(StandardCharsets.UTF_8));
        rig.helper.file("desk", "apps/com.example.reader/member.key", "{\"key\":\"k\"}".getBytes(StandardCharsets.UTF_8));
        rig.helper.file("apps", "org.example.tally/member.key", "{\"key\":\"k\"}".getBytes(StandardCharsets.UTF_8));
        rig.helper.file("apps", "org.example.tally/data/tally.json", "{}".getBytes(StandardCharsets.UTF_8));
        rig.helper.file("desk", "apps/com.example.reader/data/marks.json", marks);
        rig.helper.file("desk", "apps/com.example.reader/summary.json", "{}".getBytes(StandardCharsets.UTF_8));
        rig.helper.file("desk", "settings.json", "{}".getBytes(StandardCharsets.UTF_8));
        TestClient client = rig.export("cs-1");
        Map<String, Object> page = rig.call(client, "data.manifest", Map.of("part", "desk"));
        List<Object> paths = DataRig.list(page.get("entries")).stream().map(e -> (Object) ((Map<?, ?>) e).get("path")).toList();
        assertThat(paths).contains("apps/com.example.reader/data/marks.json", "apps/com.example.reader/summary.json", "settings.json")
                .doesNotContain("apps/registry.json", "apps/.registry.json.tmp", "apps/com.example.reader/cache/index.bin",
                        "apps/com.example.reader/member.key");
        Map<String, Object> apps = rig.call(client, "data.manifest", Map.of("part", "apps"));
        List<Object> appPaths = DataRig.list(apps.get("entries")).stream().map(e -> (Object) ((Map<?, ?>) e).get("path")).toList();
        assertThat(appPaths).contains("org.example.tally/data/tally.json").doesNotContain("org.example.tally/member.key");
        int asked = rig.helper.requests().size();
        for (String path : List.of("apps/registry.json", "apps/.registry.json.tmp", "apps/com.example.reader/cache/index.bin",
                "apps/com.example.reader/member.key")) {
            assertThat(rig.call(client, "data.read", Map.of("part", "desk", "path", path, "offset", 0))).as(path)
                    .containsEntry("code", "not_found");
        }
        assertThat(rig.call(client, "data.read", Map.of("part", "apps", "path", "org.example.tally/member.key", "offset", 0)))
                .containsEntry("code", "not_found");
        assertThat(rig.helper.requests()).as("refused before the helper hears of it").hasSize(asked);
        long id = startRead(client, "desk", "apps/com.example.reader/data/marks.json", 0);
        assertThat(DataRig.receive(client, id, 0, rig).bytes()).isEqualTo(marks);
    }

    @Test
    void twelveTransfersAtOnceOnTheWholeDeskAndNoMore() throws Exception {
        rig.helper.file("files", "big.bin", file(2 * MIB, 11));
        TestClient first = rig.owner("cs-1");
        TestClient second = rig.export("cs-2");
        for (int i = 0; i < 8; i++) {
            startRead(first, "files", "big.bin", 0);
        }
        for (int i = 0; i < 4; i++) {
            startRead(second, "files", "big.bin", 0);
        }
        assertThat(rig.data.transfers().running()).isEqualTo(12);
        int before = rig.helper.connectionsAccepted();
        Map<String, Object> thirteenth = rig.call(second, "data.read", Map.of("part", "files", "path", "big.bin", "offset", 0));
        assertThat(thirteenth).containsEntry("code", "too_many");
        assertThat(Json.object(thirteenth, "details")).isEqualTo(Map.of("limit", 12, "reason", "desk"));
        assertThat(rig.helper.connectionsAccepted()).isEqualTo(before);
        // One of the other session's ends, and this one has a place again.
        rig.call(first, "data.read.stop", Map.of("transferId", 1));
        await().until(() -> rig.data.transfers().running() == 11);
        assertThat(startRead(second, "files", "big.bin", 0)).isEqualTo(5);
        // A session that ends gives its places back once its transfers are done.
        first.sendJson(Channels.CTL, FrameKind.CLOSE, 0, Map.of("code", 1000, "reason", "done"));
        await().until(() -> rig.data.transfers().running() == 5);
    }

    @Test
    void ownerAndExportSessionsBothReachData() throws Exception {
        TestClient owner = rig.connect("cs-1", RpcPrincipal.OWNER);
        TestClient export = rig.connect("cs-2", RpcPrincipal.EXPORT);
        assertThat(rig.call(owner, "data.parts.list", Map.of())).containsEntry("_kind", "RES");
        assertThat(rig.call(export, "data.parts.list", Map.of())).containsEntry("_kind", "RES");
    }

    private static byte[] concat(List<Frame> a, List<Frame> b, byte[] rest) {
        byte[] out = new byte[(int) (sum(a) + sum(b)) + rest.length];
        int at = 0;
        for (Frame frame : a) {
            System.arraycopy(frame.payload(), 0, out, at, frame.payload().length);
            at += frame.payload().length;
        }
        for (Frame frame : b) {
            System.arraycopy(frame.payload(), 0, out, at, frame.payload().length);
            at += frame.payload().length;
        }
        System.arraycopy(rest, 0, out, at, rest.length);
        return out;
    }
}
