package com.minimalistalliance.desk.deskd.data;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.Frame;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.testing.FakeDataHelper;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.Random;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * What of a data.read costs nothing, and what the Platform's bandwidth pause refuses, from a client's frames: only an
 * {@code export} session's bytes are free, only up to the budget, and a paused member can always take their data away,
 * past the budget too, with those bytes on the meter (Security's NE-1).
 */
class DataMeterTest {

    private static final int KIB = 1024;
    private static final int MIB = 1024 * KIB;
    private static final long LARGE_VOLUME = 1L << 40;
    private static final Duration NEVER = Duration.ofHours(1);

    @TempDir
    Path dir;

    private DataRig rig;

    @AfterEach
    void tearDown() throws Exception {
        if (rig != null) {
            rig.close();
        }
    }

    private void rig(long volumeBytes) throws Exception {
        rig(volumeBytes, NEVER);
    }

    private void rig(long volumeBytes, Duration budgetEvery) throws Exception {
        rig = new DataRig(dir, 9, true, DataRig.FAST, volumeBytes, budgetEvery);
        rig.helper.part("files", "Files");
    }

    private byte[] file(String path, int size) {
        byte[] bytes = new byte[size];
        new Random(size).nextBytes(bytes);
        rig.helper.file("files", path, bytes);
        return bytes;
    }

    private Map<String, Object> read(TestClient client, String path) throws Exception {
        return rig.call(client, "data.read", Map.of("part", "files", "path", path));
    }

    /** A read from its reply to its END, which has been checked against the file, and the place given back. */
    private DataRig.Received readAll(TestClient client, String path, byte[] bytes) throws Exception {
        Map<String, Object> reply = read(client, path);
        assertThat(reply).containsEntry("_kind", "RES");
        return finish(client, ((Number) reply.get("transferId")).longValue(), bytes);
    }

    private DataRig.Received finish(TestClient client, long id, byte[] bytes) throws Exception {
        DataRig.Received got = DataRig.receive(client, id, 256 * KIB, rig);
        assertThat(got.bytes()).isEqualTo(bytes);
        assertThat(got.end()).isEqualTo(FakeDataHelper.trailer(bytes));
        // Its last frame has been counted once its place is back.
        await().atMost(Duration.ofSeconds(5)).until(() -> rig.data.transfers().running() == 0);
        return got;
    }

    private static Map<String, Object> paused(Instant resumesAt) {
        Map<String, Object> streaming = new HashMap<>();
        streaming.put("streamProfile", "paused");
        streaming.put("resumesAt", resumesAt == null ? null : resumesAt.toString());
        return streaming;
    }

    private Instant inThreeDays() {
        return rig.clock.instant().plus(Duration.ofDays(3));
    }

    private static void assertPausedRefusal(Map<String, Object> reply, Instant resumesAt) {
        assertThat(reply).containsEntry("_kind", "ERR").containsEntry("code", "unavailable");
        assertThat(Json.object(reply, "details")).containsEntry("reason", "bandwidth_limit").containsEntry("resumesAt", resumesAt.toString());
    }

    private long readsAskedOfTheHelper() {
        return rig.helper.requests().stream().filter(request -> "read".equals(request.get("op"))).count();
    }

    // What's free.

    @Test
    void anOwnersReadAddsNothing() throws Exception {
        rig(LARGE_VOLUME);
        byte[] bytes = file("a.bin", 100_000);
        readAll(rig.owner("cs-1"), "a.bin", bytes);
        assertThat(rig.data.freeBytesSent()).isZero();
        assertThat(rig.data.budget().usedBytes()).isZero();
        rig.data.close();
        assertThat(dir.resolve(DataModule.FREE_BYTES_FILE)).hasContent("boot-1 0");
        assertThat(dir.resolve(FreeBudget.NAME)).doesNotExist();
    }

    @Test
    void anExportsReadAddsItsFrameBytesOnBothCounts() throws Exception {
        rig(LARGE_VOLUME);
        byte[] bytes = file("a.bin", 100_000);
        DataRig.Received got = readAll(rig.export("cs-1"), "a.bin", bytes);
        // The END frame and every header too.
        assertThat(got.frameBytes()).isEqualTo(100_000 + got.frames() * Frame.HEADER_BYTES + 40);
        assertThat(rig.data.freeBytesSent()).isEqualTo(got.frameBytes());
        assertThat(rig.data.budget().usedBytes()).isEqualTo(got.frameBytes());
    }

    @Test
    void aReadCrossingTheCapIsFreeUpToItAndArrivesWhole() throws Exception {
        rig(20_000);
        byte[] bytes = file("a.bin", 100_000);
        DataRig.Received got = readAll(rig.export("cs-1"), "a.bin", bytes);
        assertThat(got.frameBytes()).isGreaterThan(60_000);
        assertThat(rig.data.freeBytesSent()).as("exactly the cap, part of a frame included").isEqualTo(60_000);
        assertThat(rig.data.budget().hasRoom()).isFalse();
    }

    @Test
    void pastTheCapEveryByteIsMeteredUntilTheWindowEnds() throws Exception {
        rig(20_000);
        byte[] bytes = file("a.bin", 100_000);
        TestClient client = rig.export("cs-1");
        readAll(client, "a.bin", bytes);
        readAll(client, "a.bin", bytes);
        assertThat(rig.data.freeBytesSent()).isEqualTo(60_000);

        rig.clock.advance(FreeBudget.WINDOW);
        readAll(client, "a.bin", bytes);
        assertThat(rig.data.freeBytesSent()).isEqualTo(120_000);
    }

    @Test
    void aLoopCantReachPastTheCapWithManySessionsOrFiles() throws Exception {
        rig(100_000);
        byte[] small = file("small.bin", 40_000);
        byte[] other = file("other.bin", 41_000);
        TestClient first = rig.export("cs-1");
        TestClient second = rig.export("cs-2");
        for (int i = 0; i < 6; i++) {
            readAll(first, "small.bin", small);
            readAll(second, "other.bin", other);
        }
        assertThat(rig.data.freeBytesSent()).isEqualTo(300_000);
    }

    @Test
    void theBudgetsFileHasTheCountOnTheWayOutAndANewProcessBelievesIt() throws Exception {
        rig(LARGE_VOLUME);
        byte[] bytes = file("a.bin", 100_000);
        DataRig.Received got = readAll(rig.export("cs-1"), "a.bin", bytes);
        rig.data.close();
        Map<String, Object> saved = Json.parseObject(Files.readAllBytes(dir.resolve(FreeBudget.NAME)));
        assertThat(saved).containsEntry("startedAt", rig.clock.instant().toString());
        assertThat(((Number) saved.get("usedBytes")).longValue()).isEqualTo(got.frameBytes());

        FreeBudget next = new FreeBudget(dir.resolve(FreeBudget.NAME), () -> LARGE_VOLUME, rig.clock, NEVER);
        assertThat(next.usedBytes()).isEqualTo(got.frameBytes());
    }

    @Test
    void aSaveThatFailsNeverStopsATransfer() throws Exception {
        // A rename can't replace a directory, so every write fails. The rig writes every 20 ms.
        Files.createDirectory(dir.resolve(FreeBudget.NAME));
        rig(LARGE_VOLUME, Duration.ofMillis(20));
        byte[] bytes = file("a.bin", 3 * MIB);
        DataRig.Received got = readAll(rig.export("cs-1"), "a.bin", bytes);
        assertThat(rig.data.freeBytesSent()).isEqualTo(got.frameBytes());
        rig.data.close();
        assertThat(dir.resolve(FreeBudget.NAME)).isDirectory();
    }

    // The bandwidth pause.

    @Test
    void whilePausedAnOwnersReadIsRefusedWithWhenItEndsAndNothingIsOpened() throws Exception {
        rig(LARGE_VOLUME);
        file("a.bin", 1000);
        TestClient client = rig.owner("cs-1");
        Instant resumesAt = inThreeDays();
        rig.pause.apply(paused(resumesAt));
        assertPausedRefusal(read(client, "a.bin"), resumesAt);
        assertThat(readsAskedOfTheHelper()).isZero();
        assertThat(rig.data.transfers().count("cs-1")).isZero();
        assertThat(rig.data.transfers().running()).isZero();
    }

    @Test
    void aPauseWithNoEndSaysSo() throws Exception {
        rig(LARGE_VOLUME);
        file("a.bin", 1000);
        TestClient client = rig.owner("cs-1");
        rig.pause.apply(paused(null));
        Map<String, Object> reply = read(client, "a.bin");
        assertThat(reply).containsEntry("code", "unavailable");
        assertThat(Json.object(reply, "details")).containsEntry("reason", "bandwidth_limit").containsEntry("resumesAt", null);
    }

    @Test
    void aBadRequestWhilePausedIsStillABadRequest() throws Exception {
        rig(LARGE_VOLUME);
        TestClient client = rig.owner("cs-1");
        rig.pause.apply(paused(inThreeDays()));
        assertThat(rig.call(client, "data.read", Map.of("path", "a.bin"))).containsEntry("code", "bad_request");
        assertThat(rig.call(client, "data.read", Map.of("part", "rtc", "path", "a.bin"))).containsEntry("code", "not_found");
    }

    @Test
    void anExportWithinTheBudgetIsNeverRefusedForAPause() throws Exception {
        rig(LARGE_VOLUME);
        byte[] bytes = file("a.bin", 100_000);
        rig.pause.apply(paused(inThreeDays()));
        DataRig.Received got = readAll(rig.export("cs-1"), "a.bin", bytes);
        assertThat(rig.data.freeBytesSent()).isEqualTo(got.frameBytes());
    }

    /**
     * NE-1: past the budget and paused, an export's data.read was refused with {@code bandwidth_limit}, and the Desk app's
     * copier, after its tries, skipped each file it hadn't reached as "The desk couldn't read it" and ended done. It's
     * read now, and its bytes reach the meter: none of them is free.
     */
    @Test
    void anExportPastTheBudgetIsNeverRefusedForAPauseAndItsBytesAreMetered() throws Exception {
        rig(20_000);
        byte[] bytes = file("a.bin", 100_000);
        TestClient client = rig.export("cs-1");
        readAll(client, "a.bin", bytes);
        assertThat(rig.data.budget().hasRoom()).isFalse();

        // A pause that outlasts the window.
        rig.pause.apply(paused(rig.clock.instant().plus(Duration.ofDays(60))));
        long asked = readsAskedOfTheHelper();
        DataRig.Received got = readAll(client, "a.bin", bytes);
        assertThat(got.frameBytes()).isGreaterThan(100_000);
        assertThat(readsAskedOfTheHelper()).isEqualTo(asked + 1);
        assertThat(rig.data.freeBytesSent()).as("every byte past the budget is metered").isEqualTo(60_000);

        // A new window makes them free again, pause or not.
        rig.clock.advance(FreeBudget.WINDOW);
        readAll(client, "a.bin", bytes);
        assertThat(rig.data.freeBytesSent()).isEqualTo(120_000);
    }

    /** NE-1 as the Desk app's copier meets it: a whole part, file after file, past the budget and paused. */
    @Test
    void aPausedMemberPastTheBudgetExportsEveryFileWhole() throws Exception {
        rig(20_000);
        TestClient client = rig.export("cs-1");
        byte[] first = file("first.bin", 70_000);
        readAll(client, "first.bin", first);
        assertThat(rig.data.budget().hasRoom()).isFalse();
        Map<String, byte[]> files = new HashMap<>();
        for (int i = 0; i < 12; i++) {
            files.put("f" + i + ".bin", file("f" + i + ".bin", 10_000 + i * 997));
        }
        rig.pause.apply(paused(inThreeDays()));

        long frameBytes = 0;
        for (Map.Entry<String, byte[]> entry : files.entrySet()) {
            Map<String, Object> reply = read(client, entry.getKey());
            assertThat(reply).as(entry.getKey()).containsEntry("_kind", "RES");
            frameBytes += finish(client, ((Number) reply.get("transferId")).longValue(), entry.getValue()).frameBytes();
        }
        assertThat(frameBytes).isGreaterThan(files.values().stream().mapToLong(b -> b.length).sum());
        assertThat(rig.data.freeBytesSent()).isEqualTo(60_000);
    }

    @Test
    void aTransferAlreadyRunningFinishesWhenAPauseBegins() throws Exception {
        rig(LARGE_VOLUME);
        byte[] bytes = file("a.bin", 2 * MIB);
        TestClient owner = rig.owner("cs-1");
        TestClient export = rig.export("cs-2");
        long ownersRead = ((Number) read(owner, "a.bin").get("transferId")).longValue();
        long exportsRead = ((Number) read(export, "a.bin").get("transferId")).longValue();
        Instant resumesAt = inThreeDays();
        rig.pause.apply(paused(resumesAt));
        assertPausedRefusal(read(owner, "a.bin"), resumesAt);

        rig.credit(owner, ownersRead, 2L * MIB);
        rig.credit(export, exportsRead, 2L * MIB);
        finish(owner, ownersRead, bytes);
        finish(export, exportsRead, bytes);
    }

    @Test
    void anExportThatCrossesTheCapWhilePausedFinishesAndTheNextIsReadOnTheMeter() throws Exception {
        rig(20_000);
        byte[] bytes = file("a.bin", 100_000);
        TestClient client = rig.export("cs-1");
        rig.pause.apply(paused(inThreeDays()));
        readAll(client, "a.bin", bytes);
        assertThat(rig.data.freeBytesSent()).isEqualTo(60_000);
        readAll(client, "a.bin", bytes);
        assertThat(rig.data.freeBytesSent()).isEqualTo(60_000);
    }

    @Test
    void metadataAndHoldsAreNeverRefusedForAPause() throws Exception {
        rig(20_000);
        byte[] bytes = file("a.bin", 100_000);
        TestClient export = rig.export("cs-1");
        TestClient owner = rig.owner("cs-2");
        readAll(export, "a.bin", bytes);
        rig.pause.apply(paused(inThreeDays()));
        assertThat(rig.data.budget().hasRoom()).isFalse();

        for (TestClient client : new TestClient[] {owner, export}) {
            assertThat(rig.call(client, "data.parts.list", Map.of())).containsEntry("_kind", "RES");
            assertThat(rig.call(client, "data.manifest", Map.of("part", "files"))).containsEntry("_kind", "RES");
            assertThat(rig.call(client, "data.read.stop", Map.of("transferId", 99))).containsEntry("_kind", "RES");
            assertThat(rig.call(client, "data.browser.hold", Map.of())).containsEntry("held", true);
            assertThat(rig.call(client, "data.browser.release", Map.of())).containsEntry("_kind", "RES");
            // Chromium is down here, which is a reason of its own, not the pause's.
            assertThat(Json.object(rig.call(client, "data.browser.cookies", Map.of()), "details")).containsEntry("reason", "chromium");
            assertThat(rig.call(client, "desk.status.get", Map.of())).containsEntry("_kind", "RES");
        }
    }

    @Test
    void readsComeBackAtResumesAtWithNoWordFromThePlatform() throws Exception {
        rig(LARGE_VOLUME);
        byte[] bytes = file("a.bin", 1000);
        TestClient client = rig.owner("cs-1");
        Instant resumesAt = inThreeDays();
        rig.pause.apply(paused(resumesAt));
        assertPausedRefusal(read(client, "a.bin"), resumesAt);
        rig.clock.advance(Duration.ofDays(3).minusSeconds(1));
        assertPausedRefusal(read(client, "a.bin"), resumesAt);
        rig.clock.advance(Duration.ofSeconds(1));
        readAll(client, "a.bin", bytes);
    }

    @Test
    void readsComeBackWhenThePlatformLiftsThePause() throws Exception {
        rig(20_000);
        byte[] bytes = file("a.bin", 100_000);
        TestClient export = rig.export("cs-1");
        TestClient owner = rig.owner("cs-2");
        readAll(export, "a.bin", bytes);
        Instant resumesAt = inThreeDays();
        rig.pause.apply(paused(resumesAt));
        assertPausedRefusal(read(owner, "a.bin"), resumesAt);
        // An export past the budget goes on through the pause, metered.
        readAll(export, "a.bin", bytes);

        rig.pause.apply(Map.of("streamProfile", "normal"));
        readAll(owner, "a.bin", bytes);
        readAll(export, "a.bin", bytes);
        // Allowed, not free again.
        assertThat(rig.data.freeBytesSent()).isEqualTo(60_000);
    }

    // A self-hosted desk.

    /**
     * The Platform never counts a self-hosted desk and never holds it (contract selfhost.md; bandwidth.ts counts() is
     * false for {@code hosting: "self"}), so it never hears a pause. What's left is a budget that runs out with nobody
     * reading the count, on whatever volume the member has, and neither may change a thing.
     */
    @Test
    void aDeskThatHearsNoPauseRefusesNothingPastTheBudget() throws Exception {
        rig(20_000);
        byte[] bytes = file("a.bin", 100_000);
        TestClient owner = rig.owner("cs-1");
        TestClient export = rig.export("cs-2");
        readAll(export, "a.bin", bytes);
        readAll(export, "a.bin", bytes);
        readAll(owner, "a.bin", bytes);
        assertThat(rig.data.budget().hasRoom()).isFalse();
        rig.pause.apply(null);
        readAll(export, "a.bin", bytes);
        readAll(owner, "a.bin", bytes);
    }

    @Test
    void aVolumeThatCantSayStillExports() throws Exception {
        rig(0);
        byte[] bytes = file("a.bin", 100_000);
        rig.pause.apply(paused(inThreeDays()));
        DataRig.Received got = readAll(rig.export("cs-1"), "a.bin", bytes);
        assertThat(rig.data.freeBytesSent()).isEqualTo(got.frameBytes());
        assertThat(rig.data.budget().capBytes()).isEqualTo(3 * FreeBudget.DEFAULT_VOLUME_BYTES);
    }

    @Test
    void aReadPastTheCapStillWaitsForItsCredit() throws Exception {
        // A budget of 3 bytes, gone in the first frame. It's still only the first 1 MiB until the reader grants more.
        rig(1);
        file("a.bin", 2 * MIB);
        TestClient client = rig.export("cs-1");
        read(client, "a.bin");
        long got = 0;
        while (got < MIB) {
            got += client.next(Channels.BULK).payload().length;
        }
        assertThat(got).isEqualTo(MIB);
        assertThat(rig.fake.pollFrame(client.handle(), Channels.BULK, 200)).isNull();
        assertThat(rig.data.freeBytesSent()).isEqualTo(3);
    }
}
