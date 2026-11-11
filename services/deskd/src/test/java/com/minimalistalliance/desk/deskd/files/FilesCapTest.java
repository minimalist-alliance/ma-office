package com.minimalistalliance.desk.deskd.files;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.platform.TierLimits;
import com.minimalistalliance.desk.deskd.protocol.Channels;
import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * A free desk's Files cap (ADR 0090, section 7): the tree, the trash and every unfinished upload's whole size held to the
 * cap, on top of the floor; past it a new upload is refused with its own reason; {@code files.usage} says so; uploads
 * racing for the last bytes can't both have them; over the cap nothing is touched; and the tier's limits set it live.
 */
class FilesCapTest {

    @TempDir
    Path dir;

    private FilesRig rig;
    private TestClient owner;
    private final AtomicLong cap = new AtomicLong(-1);

    @BeforeEach
    void setUp() throws Exception {
        rig = new FilesRig(dir, false, true, Quota.FLOOR_BYTES, Duration.ofMillis(400));
        rig.files.quota().capFrom(cap::get);
        owner = rig.owner("s-1");
    }

    @AfterEach
    void tearDown() throws Exception {
        rig.close();
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> m(Object value) {
        return (Map<String, Object>) value;
    }

    private static long number(Map<String, Object> map, String key) {
        return ((Number) map.get(key)).longValue();
    }

    private void put(String path, int size) throws Exception {
        assertThat(rig.upload(owner, path, FilesRig.bytes(size, size + path.length()))).containsEntry("_kind", "RES");
    }

    @Test
    void anUploadPastTheCapIsRefusedWithItsOwnReasonAndTheNumbers() throws Exception {
        cap.set(10_000);
        put("a.bin", 6000);
        Map<String, Object> reply = rig.err(owner, "no_space", "files.upload.begin", "path", "b.bin", "size", 5000L);
        Map<String, Object> details = m(reply.get("details"));
        assertThat(details).containsEntry("reason", "cap");
        assertThat(number(details, "capBytes")).isEqualTo(10_000);
        assertThat(number(details, "capUsedBytes")).isEqualTo(6000);
        assertThat(number(details, "needBytes")).isEqualTo(5000);
        assertThat(rig.ok(owner, "files.upload.begin", "path", "c.bin", "size", 4000L)).containsKey("uploadId");
    }

    @Test
    void usageReportsTheCapWhatItCountsAndTheSmallerRoom() throws Exception {
        Map<String, Object> none = rig.ok(owner, "files.usage");
        assertThat(none).containsEntry("capBytes", null).containsEntry("capUsedBytes", null);

        cap.set(10_000);
        put("a.bin", 3000);
        Map<String, Object> usage = rig.ok(owner, "files.usage");
        assertThat(number(usage, "capBytes")).isEqualTo(10_000);
        assertThat(number(usage, "capUsedBytes")).isEqualTo(3000);
        assertThat(number(usage, "uploadableBytes")).isEqualTo(7000);
        assertThat(number(m(usage.get("files")), "bytes")).isEqualTo(3000);

        // The floor's room is still the smaller when the drive is nearly full.
        rig.freeBytes.set(Quota.FLOOR_BYTES + 500);
        assertThat(number(rig.ok(owner, "files.usage"), "uploadableBytes")).isEqualTo(500);
        Map<String, Object> floor = rig.err(owner, "no_space", "files.upload.begin", "path", "big", "size", 600L);
        assertThat(m(floor.get("details"))).doesNotContainKey("reason").containsKey("floorBytes");
    }

    @Test
    void aRunOfUploadsCountsEachWithoutWalkingAgain() throws Exception {
        cap.set(10_000);
        for (int i = 0; i < 4; i++) {
            put("f" + i + ".bin", 2000);
        }
        // Each finish went into the kept walk: the fifth fits exactly, a sixth byte doesn't.
        rig.err(owner, "no_space", "files.upload.begin", "path", "g.bin", "size", 2001L);
        put("g.bin", 2000);
        Map<String, Object> usage = rig.ok(owner, "files.usage");
        assertThat(number(usage, "capUsedBytes")).isEqualTo(10_000);
        assertThat(number(usage, "uploadableBytes")).isZero();
    }

    @Test
    void uploadsRacingForTheLastBytesCantBothHaveThem() throws Exception {
        cap.set(10_000);
        TestClient other = rig.owner("s-2");
        for (int round = 0; round < 8; round++) {
            CountDownLatch go = new CountDownLatch(1);
            List<Map<String, Object>> replies = java.util.Collections.synchronizedList(new ArrayList<>());
            List<Thread> threads = new ArrayList<>();
            for (TestClient client : List.of(owner, other)) {
                String path = "race-" + round + "-" + client.handle() + ".bin";
                threads.add(Thread.ofVirtual().start(() -> {
                    try {
                        go.await();
                        replies.add(rig.call(client, "files.upload.begin", "path", path, "size", 6000L));
                    } catch (Exception e) {
                        throw new IllegalStateException(e);
                    }
                }));
            }
            go.countDown();
            for (Thread thread : threads) {
                thread.join(Duration.ofSeconds(10));
            }
            List<Map<String, Object>> won = replies.stream().filter(r -> "RES".equals(r.get("_kind"))).toList();
            List<Map<String, Object>> lost = replies.stream().filter(r -> "ERR".equals(r.get("_kind"))).toList();
            assertThat(won).hasSize(1);
            assertThat(lost).hasSize(1);
            assertThat(lost.get(0)).containsEntry("code", "no_space");
            assertThat(m(lost.get(0).get("details"))).containsEntry("reason", "cap");
            // The winner's upload goes, so the next round starts from nothing again. Both sessions are the same member's.
            rig.ok(owner, "files.upload.abort", "uploadId", won.get(0).get("uploadId"));
        }
    }

    @Test
    void anAgentsWriteWaitsOnTheLastBytesLockAnUploadsBeginHolds() throws Exception {
        cap.set(10_000);
        AgentFiles agent = rig.files.agentAccess();
        byte[] text = AgentFiles.encode("x".repeat(6000));
        Quota quota = rig.files.quota();
        java.util.concurrent.atomic.AtomicReference<String> outcome = new java.util.concurrent.atomic.AtomicReference<>();
        Thread writer;
        // As an upload's begin holds it: past its check of the room, before its partial and sidecar exist.
        quota.room.lock();
        try {
            writer = Thread.ofVirtual().start(() -> {
                try {
                    agent.write("agent.txt", text, false, null);
                    outcome.set("written");
                } catch (AgentFiles.Refusal e) {
                    outcome.set(e.word() + e.extra());
                }
            });
            await().atMost(Duration.ofSeconds(5)).until(quota.room::hasQueuedThreads);
            assertThat(rig.root.resolve("agent.txt")).doesNotExist();
            // The begin's sidecar lands, reserving its whole size, and only then lets go.
            String id = Ids.next(System.currentTimeMillis());
            Files.write(rig.root.resolve(PathRules.UPLOADS).resolve(id + ".json"), com.minimalistalliance.desk.deskd.protocol.Json.bytes(
                    Map.of("uploadId", id, "path", "upload.bin", "size", 6000, "member", "user-1", "createdAt", System.currentTimeMillis())));
        } finally {
            quota.room.unlock();
        }
        writer.join(Duration.ofSeconds(10));

        // The write saw the upload's 6000 and was refused: the two can't both have the last bytes.
        assertThat(outcome.get()).isEqualTo("no_space{cap=true}");
        assertThat(rig.root.resolve("agent.txt")).doesNotExist();
    }

    @Test
    void anAgentsWriteAndAnUploadRacingForTheLastBytesCantBothHaveThem() throws Exception {
        AgentFiles agent = rig.files.agentAccess();
        byte[] text = AgentFiles.encode("y".repeat(6000));
        for (int round = 0; round < 8; round++) {
            // Room for one of the two each round, whatever earlier rounds left.
            cap.set(rig.files.quota().capUsed() + 10_000);
            CountDownLatch go = new CountDownLatch(1);
            java.util.concurrent.atomic.AtomicReference<Map<String, Object>> upload = new java.util.concurrent.atomic.AtomicReference<>();
            java.util.concurrent.atomic.AtomicReference<String> write = new java.util.concurrent.atomic.AtomicReference<>();
            String path = "agent-" + round + ".txt";
            Thread uploader = Thread.ofVirtual().start(() -> {
                try {
                    go.await();
                    upload.set(rig.call(owner, "files.upload.begin", "path", "upload-" + path, "size", 6000L));
                } catch (Exception e) {
                    throw new IllegalStateException(e);
                }
            });
            Thread writer = Thread.ofVirtual().start(() -> {
                try {
                    go.await();
                    agent.write(path, text, false, null);
                    write.set("written");
                } catch (AgentFiles.Refusal e) {
                    write.set(e.word());
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            });
            go.countDown();
            uploader.join(Duration.ofSeconds(10));
            writer.join(Duration.ofSeconds(10));
            boolean uploadWon = "RES".equals(upload.get().get("_kind"));
            boolean writeWon = "written".equals(write.get());
            assertThat(uploadWon ^ writeWon).as("round %d: upload %s, write %s", round, upload.get(), write.get()).isTrue();
            if (uploadWon) {
                rig.ok(owner, "files.upload.abort", "uploadId", upload.get().get("uploadId"));
            } else {
                assertThat(upload.get()).containsEntry("code", "no_space");
            }
        }
    }

    @Test
    void aParkedUploadHoldsItsWholeSize() throws Exception {
        cap.set(10_000);
        Map<String, Object> parked = rig.ok(owner, "files.upload.begin", "path", "big.bin", "size", 8000L);
        // deskd restarts: the upload is parked, its sidecar on disk and no writer for it.
        rig.close();
        rig = new FilesRig(dir, false, true, Quota.FLOOR_BYTES, Duration.ofMillis(400));
        rig.files.quota().capFrom(cap::get);
        owner = rig.owner("s-2");
        Map<String, Object> reply = rig.err(owner, "no_space", "files.upload.begin", "path", "small.bin", "size", 3000L);
        assertThat(number(m(reply.get("details")), "capUsedBytes")).isEqualTo(8000);
        rig.ok(owner, "files.upload.abort", "uploadId", parked.get("uploadId"));
        assertThat(rig.ok(owner, "files.upload.begin", "path", "small.bin", "size", 3000L)).containsKey("uploadId");
    }

    @Test
    void overTheCapNothingIsTouchedAndOnlyNewBytesAreRefused() throws Exception {
        put("one.bin", 4000);
        put("two.bin", 4000);
        put("three.bin", 4000);
        // A downgrade, or a lowered dial: the desk is over its cap.
        cap.set(10_000);
        Map<String, Object> list = rig.ok(owner, "files.list", "path", "");
        assertThat((List<?>) list.get("entries")).hasSize(3);
        assertThat(rig.ok(owner, "files.stat", "path", "one.bin")).containsKey("entry");
        rig.ok(owner, "files.rename", "from", "one.bin", "to", "uno.bin");
        rig.err(owner, "no_space", "files.upload.begin", "path", "x", "size", 1L);
        assertThat(Files.size(rig.root.resolve("uno.bin"))).isEqualTo(4000);

        // To the trash: still counted, as anything kept there could be.
        Map<String, Object> deleted = rig.ok(owner, "files.delete", "paths", List.of("two.bin"));
        assertThat(m(((List<?>) deleted.get("results")).get(0))).containsEntry("ok", true);
        rig.err(owner, "no_space", "files.upload.begin", "path", "x", "size", 1000L);
        // Emptied, there's room again.
        rig.ok(owner, "files.trash.empty");
        assertThat(number(rig.ok(owner, "files.usage"), "capUsedBytes")).isEqualTo(8000);
        assertThat(rig.ok(owner, "files.upload.begin", "path", "x", "size", 2000L)).containsKey("uploadId");
    }

    @Test
    void theTiersLimitsSetTheCapInGibAndAChangeTellsTheFilesApp() throws Exception {
        rig.files.quota().capFrom(() -> -1);
        TierLimits limits = new TierLimits();
        rig.files.followTierLimits(limits);
        assertThat(rig.ok(owner, "files.usage")).containsEntry("capBytes", null);

        owner.sendJson(Channels.RPC, FrameKind.SUB, 900, Map.of("topic", "files.changes", "params", Map.of()));
        assertThat(owner.nextReply()).containsEntry("_kind", "RES");
        Map<String, Object> config = new LinkedHashMap<>();
        config.put("configVersion", 12);
        config.put("tierLimits", Map.of("tier", "free", "browserMinutesPerDay", 45, "filesGb", 2, "idleStopMinutes", 30));
        limits.fromConfig(config);
        assertThat(number(rig.ok(owner, "files.usage"), "capBytes")).isEqualTo(2L * 1024 * 1024 * 1024);
        await().atMost(Duration.ofSeconds(5)).until(() -> {
            var frame = owner.next(Channels.EVENTS);
            return frame.kind() == FrameKind.EVT && new String(frame.payload(), StandardCharsets.UTF_8).contains("\"usage\":true");
        });

        // The upgrade: no cap, at once.
        config.remove("tierLimits");
        config.put("configVersion", 13);
        limits.fromConfig(config);
        assertThat(rig.ok(owner, "files.usage")).containsEntry("capBytes", null).containsEntry("capUsedBytes", null);
    }
}
