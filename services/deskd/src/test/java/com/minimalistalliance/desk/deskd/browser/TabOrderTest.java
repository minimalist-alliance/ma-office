package com.minimalistalliance.desk.deskd.browser;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Set;
import java.util.concurrent.atomic.AtomicLong;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** The kept tab order (LS-36): what's on disk, a restore by address, and the window it has. */
class TabOrderTest {

    @TempDir
    Path dir;

    private final AtomicLong now = new AtomicLong(1_000_000_000L);

    private static final String A = "https://example.com/a";
    private static final String B = "https://example.com/b";
    private static final String C = "https://example.com/c";
    private static final String NEW_TAB = "chrome://newtab/";

    private TabOrder order() {
        return new TabOrder(dir.resolve(TabOrder.FILE), Duration.ofSeconds(60), now::get);
    }

    private static TabOrder.Entry entry(String id, String url) {
        return new TabOrder.Entry(id, TabOrder.key(url));
    }

    /** As a desk had it before a stop: a, b and c, in that order. */
    private void keptBeforeTheStop() {
        TabOrder before = order();
        before.connected();
        List<TabOrder.Entry> entries = before.adopt(List.of(entry("A1", A), entry("B1", B), entry("C1", C)));
        before.write(entries);
    }

    @Test
    void whatsKeptIsIdsAndHashesAndNoAddress() throws Exception {
        keptBeforeTheStop();
        String text = Files.readString(dir.resolve(TabOrder.FILE), StandardCharsets.UTF_8);
        assertThat(text).contains("\"A1\"", "\"B1\"", "\"C1\"").doesNotContain("example", "http");
        assertThat(TabOrder.key(A)).hasSize(16).matches("[0-9a-f]+").isNotEqualTo(TabOrder.key(B));
    }

    @Test
    void aWakeGivesTheOrderBackByAddressWhateverOrderChromiumListsThemIn() {
        keptBeforeTheStop();
        TabOrder after = order();
        after.connected();
        Set<String> live = Set.of("C2", "A2", "B2");
        assertThat(after.place("C2", C, live)).isEqualTo(2);
        assertThat(after.holding()).isTrue();
        assertThat(after.place("A2", A, live)).isEqualTo(0);
        assertThat(after.place("B2", B, live)).isEqualTo(1);
        assertThat(after.holding()).isFalse();
        assertThat(after.rank("A2")).isZero();
    }

    @Test
    void aRestartOfDeskdAloneFindsEachTabByItsId() {
        keptBeforeTheStop();
        TabOrder after = order();
        after.connected();
        // The address has moved on since: the id is what counts while Chromium runs.
        assertThat(after.place("B1", "https://example.com/elsewhere", Set.of("A1", "B1", "C1"))).isEqualTo(1);
    }

    @Test
    void aTabNotYetPlacedKeepsItsOwnEntryFromAnotherWithTheSameAddress() {
        TabOrder before = order();
        before.connected();
        before.write(before.adopt(List.of(entry("N1", NEW_TAB), entry("N2", NEW_TAB))));
        TabOrder after = order();
        after.connected();
        // N2 is still running and comes later in the same read: the new tab mustn't take its place.
        assertThat(after.place("X", NEW_TAB, Set.of("X", "N2"))).isEqualTo(0);
        assertThat(after.place("N2", NEW_TAB, Set.of("X", "N2"))).isEqualTo(1);
    }

    @Test
    void twoTabsWithOneAddressTakeTheirPlacesInOrder() {
        TabOrder before = order();
        before.connected();
        before.write(before.adopt(List.of(entry("N1", NEW_TAB), entry("A1", A), entry("N2", NEW_TAB))));
        TabOrder after = order();
        after.connected();
        Set<String> live = Set.of("x", "y", "z");
        assertThat(after.place("x", NEW_TAB, live)).isEqualTo(0);
        assertThat(after.place("y", NEW_TAB, live)).isEqualTo(2);
        assertThat(after.place("z", NEW_TAB, live)).isNull();
    }

    @Test
    void pastTheWindowANewTabGoesAtTheEndAndNothingIsHeld() {
        keptBeforeTheStop();
        TabOrder after = order();
        after.connected();
        assertThat(after.place("A2", A, Set.of("A2"))).isZero();
        assertThat(after.holding()).isTrue();
        now.addAndGet(Duration.ofSeconds(61).toNanos());
        assertThat(after.holding()).isFalse();
        assertThat(after.place("B2", B, Set.of("A2", "B2"))).isNull();
    }

    @Test
    void nothingIsWrittenWhileARestoreMayStillBeUnderWay() throws Exception {
        keptBeforeTheStop();
        byte[] kept = Files.readAllBytes(dir.resolve(TabOrder.FILE));
        TabOrder after = order();
        after.connected();
        after.place("A2", A, Set.of("A2"));
        // Only one tab is back so far: writing now would lose b and c's places if the desk stopped again.
        assertThat(after.adopt(List.of(entry("A2", A)))).isNull();
        assertThat(Files.readAllBytes(dir.resolve(TabOrder.FILE))).isEqualTo(kept);
        now.addAndGet(Duration.ofSeconds(61).toNanos());
        List<TabOrder.Entry> next = after.adopt(List.of(entry("A2", A)));
        assertThat(next).containsExactly(entry("A2", A));
        after.write(next);
        assertThat(Files.readString(dir.resolve(TabOrder.FILE))).contains("A2").doesNotContain("B1");
    }

    @Test
    void anUnchangedOrderIsntWrittenAgain() throws Exception {
        keptBeforeTheStop();
        TabOrder after = order();
        after.connected();
        Set<String> live = Set.of("A1", "B1", "C1");
        after.place("A1", A, live);
        after.place("B1", B, live);
        after.place("C1", C, live);
        assertThat(after.adopt(List.of(entry("A1", A), entry("B1", B), entry("C1", C)))).isNull();
        assertThat(after.adopt(List.of(entry("B1", B), entry("A1", A), entry("C1", C)))).isNotNull();
    }

    @Test
    void aNewTabAfterTheOrderIsAdoptedHasNoPlaceUntilTheNextAdopt() {
        TabOrder order = order();
        order.connected();
        order.write(order.adopt(List.of(entry("A1", A))));
        assertThat(order.place("B1", B, Set.of("A1", "B1"))).isNull();
        order.adopt(List.of(entry("A1", A), entry("B1", B)));
        assertThat(order.rank("B1")).isEqualTo(1);
    }

    @Test
    void anythingButTheFileAsWrittenStartsWithNoOrder() throws Exception {
        Path file = dir.resolve(TabOrder.FILE);
        for (String text : List.of(
                "not json",
                "{\"v\":2,\"tabs\":[{\"id\":\"A1\",\"key\":\"" + TabOrder.key(A) + "\"}]}",
                "{\"v\":1,\"tabs\":[{\"id\":\"../x\",\"key\":\"" + TabOrder.key(A) + "\"}]}",
                "{\"v\":1,\"tabs\":[{\"id\":\"A1\",\"key\":\"https://example.com/a\"}]}")) {
            Files.writeString(file, text);
            TabOrder order = order();
            order.connected();
            assertThat(order.place("A2", A, Set.of("A2"))).as(text).isNull();
            assertThat(order.rank("A1")).as(text).isNull();
        }
        Files.delete(file);
        Path elsewhere = dir.resolve("elsewhere.json");
        keptBeforeTheStopIn(elsewhere);
        Files.createSymbolicLink(file, elsewhere);
        TabOrder linked = order();
        linked.connected();
        assertThat(linked.rank("A1")).isNull();
    }

    private void keptBeforeTheStopIn(Path file) {
        TabOrder before = new TabOrder(file, Duration.ofSeconds(60), now::get);
        before.connected();
        before.write(before.adopt(List.of(entry("A1", A))));
    }

    @Test
    void aVolumeThatCantBeWrittenCostsOnlyTheOrder() throws Exception {
        TabOrder order = new TabOrder(dir.resolve("missing").resolve(TabOrder.FILE), Duration.ofSeconds(60), now::get);
        order.connected();
        order.write(order.adopt(List.of(entry("A1", A))));
        assertThat(order.rank("A1")).isZero();
        assertThat(Files.exists(dir.resolve("missing"))).isFalse();
    }

    @Test
    void inMemoryOnlyStillOrders() {
        TabOrder order = new TabOrder(null, Duration.ofSeconds(60), now::get);
        order.connected();
        order.write(order.adopt(List.of(entry("A1", A), entry("B1", B))));
        order.connected();
        assertThat(order.place("B1", B, Set.of("A1", "B1"))).isEqualTo(1);
    }
}
