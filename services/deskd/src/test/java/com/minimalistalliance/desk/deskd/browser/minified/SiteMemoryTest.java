package com.minimalistalliance.desk.deskd.browser.minified;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.deskd.testing.MutableClock;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Duration;
import java.time.Instant;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** Per-site memory on the desk (Security T47-9): small, atomic, capped, and no longer than Chromium's history. */
class SiteMemoryTest {

    @TempDir
    Path dir;

    private final MutableClock clock = new MutableClock(Instant.parse("2026-11-07T12:00:00Z"));

    private final java.util.List<SiteMemory> made = new java.util.ArrayList<>();

    private SiteMemory memory() {
        SiteMemory memory = new SiteMemory(dir, clock);
        made.add(memory);
        return memory;
    }

    /** Each writer is done before the directory goes. */
    @org.junit.jupiter.api.AfterEach
    void allWritten() throws InterruptedException {
        for (SiteMemory memory : made) {
            written(memory);
        }
    }

    private static void written(SiteMemory memory) throws InterruptedException {
        assertThat(memory.awaitWritten(Duration.ofSeconds(5))).isTrue();
    }

    @Test
    void aChoiceOutlivesARestartInAFileOnlyTheDeskReads() throws Exception {
        SiteMemory memory = memory();
        memory.set("news.example", true, SiteMemory.View.STREAM, null);
        memory.set("bank.example", false, null, true);
        written(memory);

        Path file = dir.resolve(SiteMemory.FILE);
        assertThat(PosixFilePermissions.toString(Files.getPosixFilePermissions(file))).isEqualTo("rw-------");
        assertThat(dir.resolve(SiteMemory.FILE + ".tmp")).doesNotExist();
        SiteMemory again = memory();
        assertThat(again.get("news.example").view()).isEqualTo(SiteMemory.View.STREAM);
        assertThat(again.get("bank.example").sensitive()).isTrue();
        assertThat(again.get("other.example").isDefault()).isTrue();
    }

    /** Review 9: an entry past 90 days went only once touched, so it stayed in the file. Now the load drops it too. */
    @Test
    void aSitePastChromiumsHistoryGoesAtLoad() throws Exception {
        SiteMemory memory = memory();
        memory.set("old.example", true, SiteMemory.View.STREAM, null);
        clock.advance(Duration.ofDays(60));
        memory.set("new.example", true, SiteMemory.View.STREAM, null);
        written(memory);
        clock.advance(Duration.ofDays(31));
        SiteMemory again = memory();
        assertThat(again.list()).extracting(SiteMemory.Site::host).containsExactly("new.example");
        written(again);
        assertThat(Files.readString(dir.resolve(SiteMemory.FILE))).doesNotContain("old.example").contains("new.example");
    }

    /**
     * Review 9: long hosts could take the file past what a load reads, and the load then started empty, the member's
     * sensitive marks with it. The file stays under the limit, and the sensitive marks are the last to go.
     */
    @Test
    void theFileStaysReadableAndSensitiveMarksStay() throws Exception {
        int limit = 256 * 1024;
        SiteMemory memory = new SiteMemory(dir, clock, limit);
        made.add(memory);
        String tail = "." + "t".repeat(60);
        for (int i = 0; i < SiteMemory.MAX_SITES; i++) {
            String host = String.format("h%05d", i) + "x".repeat(56) + tail;
            if (i % 10 == 0) {
                memory.set(host, false, null, true);
            }
            memory.set(host, true, SiteMemory.View.SIMPLIFIED, null);
            memory.noteFallback(host, Fallback.LOW_CONFIDENCE);
            clock.advance(Duration.ofSeconds(1));
        }
        written(memory);
        assertThat(Files.size(dir.resolve(SiteMemory.FILE))).isLessThanOrEqualTo(limit);
        SiteMemory again = new SiteMemory(dir, clock, limit);
        made.add(again);
        assertThat(again.list()).hasSizeGreaterThan(SiteMemory.MAX_SITES / 3);
        for (int i = 0; i < SiteMemory.MAX_SITES; i += 10) {
            assertThat(again.get(String.format("h%05d", i) + "x".repeat(56) + tail).sensitive()).isTrue();
        }
        // What went was the oldest of the rest.
        assertThat(again.get(String.format("h%05d", 1) + "x".repeat(56) + tail).isDefault()).isTrue();
        assertThat(again.get(String.format("h%05d", SiteMemory.MAX_SITES - 1) + "x".repeat(56) + tail).isDefault()).isFalse();
    }

    /** Settled with UI/UX: a site is its registrable domain, whatever host the client names, and deskd maps it. */
    @Test
    void aSiteIsItsRegistrableDomainWhateverHostIsNamed() {
        SiteMemory memory = memory();
        assertThat(memory.set("www.example.co.uk", true, SiteMemory.View.STREAM, null).host()).isEqualTo("example.co.uk");
        assertThat(memory.get("news.example.co.uk").view()).isEqualTo(SiteMemory.View.STREAM);
        assertThat(memory.get("news.example.co.uk").host()).isEqualTo("example.co.uk");
        memory.noteFallback("a.shop.example.com", Fallback.LOW_CONFIDENCE);
        memory.noteFallback("b.example.com", Fallback.LOW_CONFIDENCE);
        assertThat(memory.remembered("example.com")).isEqualTo(Fallback.LOW_CONFIDENCE);
        assertThat(memory.list()).extracting(SiteMemory.Site::host).containsExactly("example.co.uk", "example.com");
    }

    @Test
    void settingOneThingLeavesTheOtherAndDefaultsArentKept() throws Exception {
        SiteMemory memory = memory();
        memory.set("a.example", true, SiteMemory.View.STREAM, null);
        memory.set("a.example", false, null, true);
        assertThat(memory.get("a.example").view()).isEqualTo(SiteMemory.View.STREAM);
        memory.set("a.example", true, null, false);
        assertThat(memory.list()).isEmpty();
        written(memory);
        assertThat(Files.readString(dir.resolve(SiteMemory.FILE))).doesNotContain("a.example");
    }

    @Test
    void automaticFallbacksAreRememberedAfterTwoAndForgottenAfterAWeek() {
        SiteMemory memory = memory();
        memory.noteFallback("maps.example", Fallback.CANVAS_APP);
        assertThat(memory.remembered("maps.example")).isNull();
        memory.noteFallback("maps.example", Fallback.CANVAS_APP);
        assertThat(memory.remembered("maps.example")).isEqualTo(Fallback.CANVAS_APP);
        // Not every reason says anything about the site.
        memory.noteFallback("x.example", Fallback.DIALOG);
        memory.noteFallback("x.example", Fallback.DIALOG);
        assertThat(memory.remembered("x.example")).isNull();

        clock.advance(SiteMemory.FALLBACK_KEEP.plusMinutes(1));
        assertThat(memory.remembered("maps.example")).isNull();
        assertThat(memory.list()).isEmpty();
    }

    @Test
    void choosingTheSimplifiedViewAnswersAnAutomaticFallback() {
        SiteMemory memory = memory();
        memory.noteFallback("maps.example", Fallback.LOW_CONFIDENCE);
        memory.noteFallback("maps.example", Fallback.LOW_CONFIDENCE);
        memory.set("maps.example", true, SiteMemory.View.SIMPLIFIED, null);
        assertThat(memory.remembered("maps.example")).isNull();
        memory.noteFallback("maps.example", Fallback.LOW_CONFIDENCE);
        assertThat(memory.get("maps.example").fallback()).isNull();
    }

    @Test
    void nothingIsKeptLongerThanChromiumsHistory() {
        SiteMemory memory = memory();
        memory.set("old.example", true, SiteMemory.View.STREAM, null);
        clock.advance(SiteMemory.KEEP.plusMinutes(1));
        assertThat(memory.get("old.example").isDefault()).isTrue();
        assertThat(memory.list()).isEmpty();
    }

    @Test
    void itsCappedAndTheOldestGoFirst() {
        SiteMemory memory = memory();
        for (int i = 0; i < SiteMemory.MAX_SITES + 5; i++) {
            memory.set("s" + i + ".example", true, SiteMemory.View.STREAM, null);
            clock.advance(Duration.ofSeconds(1));
        }
        assertThat(memory.list()).hasSize(SiteMemory.MAX_SITES);
        assertThat(memory.get("s0.example").isDefault()).isTrue();
        assertThat(memory.get("s" + (SiteMemory.MAX_SITES + 4) + ".example").view()).isEqualTo(SiteMemory.View.STREAM);
    }

    @Test
    void clearForgetsEverySiteOnDiskToo() throws Exception {
        SiteMemory memory = memory();
        memory.set("a.example", true, SiteMemory.View.STREAM, null);
        written(memory);
        memory.clear();
        written(memory);
        assertThat(Files.readString(dir.resolve(SiteMemory.FILE))).doesNotContain("a.example");
        assertThat(memory().list()).isEmpty();
    }

    @Test
    void whatsOnDiskIsntBelievedUnlessItsPlainAndSmall() throws Exception {
        Path file = dir.resolve(SiteMemory.FILE);
        Files.writeString(file, "{not json");
        assertThat(memory().list()).isEmpty();

        Files.writeString(file, "{\"v\":1,\"sites\":[{\"host\":\"ok.example\",\"view\":\"stream\",\"at\":1},"
                + "{\"host\":\"Bad Host\",\"view\":\"stream\",\"at\":1},{\"host\":\"x.example\",\"view\":\"weird\",\"at\":1}]}");
        MutableClock early = new MutableClock(Instant.ofEpochMilli(2));
        assertThat(new SiteMemory(dir, early).list()).extracting(SiteMemory.Site::host).containsExactly("ok.example");

        Files.delete(file);
        Path elsewhere = dir.resolve("elsewhere.json");
        Files.writeString(elsewhere, "{\"v\":1,\"sites\":[{\"host\":\"ok.example\",\"view\":\"stream\",\"at\":1}]}");
        Files.createSymbolicLink(file, elsewhere);
        assertThat(new SiteMemory(dir, early).list()).isEmpty();

        Files.delete(file);
        Files.writeString(file, " ".repeat(SiteMemory.MAX_BYTES + 1));
        assertThat(memory().list()).isEmpty();
    }

    @Test
    void hostsAreCheckedAndTakenFromUrls() {
        assertThat(SiteMemory.isHost("news.example.co.uk")).isTrue();
        assertThat(SiteMemory.isHost("[::1]")).isTrue();
        assertThat(SiteMemory.isHost("Upper.example")).isFalse();
        assertThat(SiteMemory.isHost("a..b")).isFalse();
        assertThat(SiteMemory.hostOf("https://News.Example.com:8443/a?b")).isEqualTo("news.example.com");
        assertThat(SiteMemory.hostOf("https://bücher.example/")).isEqualTo("xn--bcher-kva.example");
        assertThat(SiteMemory.hostOf("about:blank")).isNull();
        assertThat(SiteMemory.hostOf("chrome://newtab/")).isNull();
    }
}
