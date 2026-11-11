package com.minimalistalliance.desk.deskd.notebook;

import static org.assertj.core.api.Assertions.assertThat;
import static org.awaitility.Awaitility.await;

import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.testing.TestClient;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.junit.jupiter.api.io.TempDir;

/**
 * {@code notebook.activity} past what one RES holds, through the relay to the real desk-notebook: 30,000 rows written into
 * its database while it's stopped, by {@code DESK_NOTEBOOK_SEED_CMD} ({@code notebook/tests/helpers/seed-activity.mjs}),
 * then read a page at a time by the owner and by guild members. {@code verify} skips it unless both commands are set:
 *
 * <pre>
 * DESK_NOTEBOOK_CMD="exec node $PWD/notebook/dist/desk-notebook.mjs" \
 * DESK_NOTEBOOK_SEED_CMD="exec node $PWD/notebook/tests/helpers/seed-activity.mjs" \
 *   ./mvnw -q -pl deskd verify -Dtest=none -Dsurefire.failIfNoSpecifiedTests=false -Dit.test=RealDeskNotebookActivityIT
 * </pre>
 */
@EnabledIfEnvironmentVariable(named = RealNotebookService.CMD, matches = ".+")
@EnabledIfEnvironmentVariable(named = RealDeskNotebookActivityIT.SEED, matches = ".+")
class RealDeskNotebookActivityIT {

    static final String SEED = "DESK_NOTEBOOK_SEED_CMD";
    private static final int PAGES = 3000;
    private static final int DAYS = 10;
    private static final int TRASH_EVERY = 20;

    @TempDir
    Path dir;

    private RealNotebookService service;
    private NotebookRig rig;

    @BeforeEach
    void setUp() throws Exception {
        service = new RealNotebookService(dir);
        rig = new NotebookRig(dir, service.socket());
    }

    @AfterEach
    void tearDown() throws Exception {
        rig.close();
        service.close();
    }

    private static String seedPageId(int i) {
        return String.format("%08x-5eed-4000-8000-%012x", i, i);
    }

    /** One notebook made through deskd, then the seed's pages in its tab. Returns the seed's counts. */
    @SuppressWarnings("unchecked")
    private Map<String, Object> seeded(TestClient owner) throws Exception {
        Map<String, Object> created = rig.call(owner, "notebook.notebook.create", Map.of("title", "Years of notes"));
        assertThat(created).containsEntry("_kind", "RES");
        String tabId = (String) ((Map<String, Object>) created.get("tab")).get("id");
        Map<String, Object> options = new LinkedHashMap<>();
        options.put("tabId", tabId);
        options.put("pages", PAGES);
        options.put("days", DAYS);
        options.put("trashEvery", TRASH_EVERY);
        options.put("trashedBy", "gm-mo000003");
        options.put("actors", List.of("gm-ana00001", "gm-bo000002"));
        options.put("members", Map.of("gm-ana00001", "Ana", "gm-bo000002", "Bo"));
        String out = service.whileStopped(System.getenv(SEED), new String(Json.bytes(options), java.nio.charset.StandardCharsets.UTF_8));
        Map<String, Object> counts = Json.parseObject(out.trim().getBytes(java.nio.charset.StandardCharsets.UTF_8));
        // Back once the link has found the new process.
        await().atMost(Duration.ofSeconds(30)).until(() -> "RES".equals(rig.call(owner, "notebook.activity.days", Map.of()).get("_kind")));
        return counts;
    }

    /** One whole read through deskd, following next: rows in order, and each RES's size and time. */
    private record Read(List<Map<String, Object>> rows, List<Integer> sizes, List<Long> millis) {}

    @SuppressWarnings("unchecked")
    private Read readAll(TestClient client) throws Exception {
        List<Map<String, Object>> rows = new ArrayList<>();
        List<Integer> sizes = new ArrayList<>();
        List<Long> millis = new ArrayList<>();
        Object cursor = null;
        do {
            Map<String, Object> params = new LinkedHashMap<>();
            params.put("fromDay", "0000-01-01");
            params.put("toDay", "9999-12-31");
            if (cursor != null) {
                params.put("cursor", cursor);
            }
            long t0 = System.nanoTime();
            Map<String, Object> reply = rig.call(client, "notebook.activity", params);
            millis.add((System.nanoTime() - t0) / 1_000_000);
            assertThat(reply).containsEntry("_kind", "RES").containsOnlyKeys("_kind", "_id", "rows", "next");
            Map<String, Object> result = new LinkedHashMap<>(reply);
            result.remove("_kind");
            result.remove("_id");
            sizes.add(Json.bytes(result).length);
            rows.addAll((List<Map<String, Object>>) reply.get("rows"));
            cursor = reply.get("next");
            assertThat(sizes).hasSizeLessThan(100);
        } while (cursor != null);
        return new Read(rows, sizes, millis);
    }

    private static String key(Map<String, Object> row) {
        return row.get("day") + " " + row.get("pageId");
    }

    private static void inOrderAndOnce(List<Map<String, Object>> rows) {
        Set<String> seen = new HashSet<>();
        for (int i = 0; i < rows.size(); i++) {
            assertThat(seen.add(key(rows.get(i)))).as("row %d once", i).isTrue();
            if (i > 0) {
                String prev = key(rows.get(i - 1));
                // Days and ids are fixed-width, so the string order is the order: newest day first, then the highest id.
                assertThat(prev.compareTo(key(rows.get(i)))).as("row %d after %d", i, i - 1).isPositive();
            }
        }
    }

    @Test
    void thirtyThousandRowsComeAPageAtATimeEachOnceAndEveryResFits() throws Exception {
        TestClient owner = rig.connect("a");
        Map<String, Object> counts = seeded(owner);
        assertThat(counts).containsEntry("rows", PAGES * DAYS);

        Read read = readAll(owner);
        int liveRows = ((Number) counts.get("liveRows")).intValue();
        // The seed's live rows, and the notebook's first page's own "created" row, today.
        assertThat(read.rows()).hasSize(liveRows + 1);
        inOrderAndOnce(read.rows());
        assertThat(read.sizes()).hasSizeGreaterThan(4).allSatisfy(size -> assertThat(size).isLessThanOrEqualTo(FrameKind.RES.maxMessageBytes()));
        // Whole, it would be several RES: what was too_large past about 7,000 rows.
        assertThat(Json.bytes(Map.of("rows", read.rows())).length).isGreaterThan(4 * FrameKind.RES.maxMessageBytes());
        // An owner's rows carry no names, as before.
        assertThat(read.rows()).noneMatch(row -> row.containsKey("actorNames"));
        System.out.printf("activity through deskd: %d rows in %d replies, %s ms%n", read.rows().size(), read.sizes().size(), read.millis());
    }

    @Test
    void onAGuildDeskAPlainMemberPagesThroughLivePagesWithNamesAndNothingFromTrash() throws Exception {
        TestClient owner = rig.connect("a");
        Map<String, Object> counts = seeded(owner);
        TestClient moderator = rig.connect("mo", rig.member("gm-mo000003", "officer", List.of("moderate"), false));
        TestClient plain = rig.connect("cal", rig.member("gm-cal00005", "member", List.of(), false));
        // A moderator trashes one more page, through deskd.
        assertThat(rig.call(moderator, "notebook.page.trash", Map.of("pageId", seedPageId(0)))).containsEntry("_kind", "RES");

        Read read = readAll(plain);
        Set<String> trashed = new HashSet<>();
        trashed.add(seedPageId(0));
        for (int i = TRASH_EVERY - 1; i < PAGES; i += TRASH_EVERY) {
            trashed.add(seedPageId(i));
        }
        int liveRows = ((Number) counts.get("liveRows")).intValue();
        assertThat(read.rows()).hasSize(liveRows - DAYS + 1);
        assertThat(read.rows()).noneMatch(row -> trashed.contains(row.get("pageId")));
        inOrderAndOnce(read.rows());
        assertThat(read.sizes()).hasSizeGreaterThan(4).allSatisfy(size -> assertThat(size).isLessThanOrEqualTo(FrameKind.RES.maxMessageBytes()));
        // Names come inside the same budget.
        assertThat(read.rows().stream().filter(row -> ((String) row.get("pageId")).contains("-5eed-")))
                .allSatisfy(row -> assertThat(row.get("actorNames")).isEqualTo(List.of("Ana", "Bo")));
        // The moderator sees exactly the same: Trash is nobody's in the Temporal view.
        assertThat(readAll(moderator).rows()).isEqualTo(read.rows());
        System.out.printf("activity through deskd, a guild member: %d rows in %d replies, %s ms%n", read.rows().size(), read.sizes().size(), read.millis());
    }
}
