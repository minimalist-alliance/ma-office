package com.minimalistalliance.desk.deskd.courier.store;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.deskd.courier.parse.CourierParser;
import java.nio.file.Path;
import java.time.Clock;
import java.time.ZoneOffset;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * No search sorts its matches: each reads them newest first from an index and stops at a page (draft ADR §6). A sort
 * would read every match first, which at 100,000 messages is seconds for a common word. Plans are fixed by the schema,
 * as the store never runs ANALYZE, so the plan here is the plan on a desk.
 */
class SearchPlanTest {

    private static final String SORT = "USE TEMP B-TREE FOR ORDER BY";

    @Test
    void searchesWithWordsReadTheIndexNewestFirstAndCheckEachMatchFromAnIndex(@TempDir Path dir) throws Exception {
        try (CourierStore store = CourierStore.open(dir, CourierParser.NONE, Clock.systemUTC(), CourierStore.Settings.DEFAULT)) {
            String channel = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
            Queries.Cursor cursor = new Queries.Cursor(123_456_789L << 20, "01ARZ3NDEKTSV4RRFFQ69G5FAV");
            Object[][] cases = {
                {"noodle", Lanes.DEFAULT_VISIBLE, null, null, null},
                {"noodle in:spam", Lanes.ALL, null, null, null},
                {"noodle has:attachment is:unread", Lanes.DEFAULT_VISIBLE, null, null, null},
                {"noodle", Lanes.DEFAULT_VISIBLE, channel, null, null},
                {"noodle after:2026-01-01 before:2026-02-01", Lanes.DEFAULT_VISIBLE, null, null, null},
                {"noodle", Lanes.DEFAULT_VISIBLE, null, cursor, null},
                {"from:dana \"next week\"", Lanes.AGENT_VISIBLE_STRICT, null, null, new long[] {0, 1_800_000_000_000L}},
                {"in:sent noodle", Lanes.DEFAULT_VISIBLE, null, null, null},
            };
            for (Object[] k : cases) {
                List<String> plan = plan(store, k);
                assertThat(plan).as(k[0] + " " + plan).noneMatch(l -> l.contains(SORT));
                assertThat(plan.get(0)).as(k[0] + " " + plan).contains("messages_fts VIRTUAL TABLE");
                assertThat(String.join(" | ", plan)).as(k[0] + " " + plan).contains("USING INDEX messages_key (sort_key=?");
            }
        }
    }

    @Test
    void searchesWithNoWordsWalkAnIndexInOrder(@TempDir Path dir) throws Exception {
        try (CourierStore store = CourierStore.open(dir, CourierParser.NONE, Clock.systemUTC(), CourierStore.Settings.DEFAULT)) {
            Object[][] cases = {
                {"has:attachment", Lanes.DEFAULT_VISIBLE, null, null, null, "messages_key"},
                {"is:unread after:2026-01-01", Lanes.DEFAULT_VISIBLE, null, null, null, "messages_key"},
                {"in:spam", Lanes.ALL, null, null, null, "messages_lane"},
                {"in:sent", Lanes.DEFAULT_VISIBLE, null, null, null, "messages_key"},
            };
            for (Object[] k : cases) {
                List<String> plan = plan(store, k);
                assertThat(plan).as(k[0] + " " + plan).noneMatch(l -> l.contains(SORT));
                assertThat(String.join(" | ", plan)).as(k[0] + " " + plan).contains("INDEX " + k[5]);
            }
            // In one channel, its own index, and the sort is of that channel's messages only.
            List<String> plan = plan(store, new Object[] {"is:unread", Lanes.DEFAULT_VISIBLE, "01ARZ3NDEKTSV4RRFFQ69G5FAV", null, null});
            assertThat(String.join(" | ", plan)).contains("INDEX messages_channel");
        }
    }

    @SuppressWarnings("unchecked")
    private static List<String> plan(CourierStore store, Object[] k) throws Exception {
        return store.db().read(c -> store.queries().searchPlan(c, SearchQuery.parse((String) k[0]), (List<String>) k[1], (String) k[2],
                (Queries.Cursor) k[3], ZoneOffset.UTC, (long[]) k[4]));
    }
}
