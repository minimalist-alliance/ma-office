package com.minimalistalliance.desk.deskd.agent;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.deskd.protocol.Json;
import com.minimalistalliance.desk.deskd.testing.MutableClock;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * deskd's own record of Maia Mode and Desk Maia's grants (API.md §23): recorded only from the member's relayed calls,
 * only what desk-agent's answer also holds, narrowing first, kept under deskd's own MAC, and read back as nothing at all
 * when it doesn't verify.
 */
class MaiaRecordTest {

    @TempDir
    Path dir;

    private final MutableClock clock = new MutableClock(Instant.parse("2026-11-14T10:00:00Z"));

    private static Map<String, Object> m(Object... pairs) {
        Map<String, Object> map = new LinkedHashMap<>();
        for (int i = 0; i < pairs.length; i += 2) {
            map.put((String) pairs[i], pairs[i + 1]);
        }
        return map;
    }

    private MaiaRecord kept() {
        MaiaRecord record = new MaiaRecord(clock);
        record.keepIn(dir);
        return record;
    }

    private static void on(MaiaRecord record) {
        record.recordAnswer(MaiaRecord.SET, m("on", true, "disclosure", "maia-mode-v2"), m("maia", m("on", true)));
    }

    private long days(int n) {
        return clock.millis() + Duration.ofDays(n).toMillis();
    }

    private static Map<String, Object> grantParams(String deskId, List<String> scopes, Boolean keeps) {
        Map<String, Object> p = m("deskId", deskId, "deskName", "Work", "scopes", scopes);
        if (keeps != null) {
            p.put("keepsToItself", keeps);
        }
        return p;
    }

    private static Map<String, Object> grantAnswer(String deskId, List<String> scopes, boolean keeps, long expires) {
        return m("grant", m("deskId", deskId, "deskName", "Work", "scopes", scopes, "keepsToItself", keeps,
                "expiresAt", expires));
    }

    @Test
    void nothingIsRecordedUntilTheMembersCallAndDeskAgentBothSaySo() {
        MaiaRecord record = kept();
        assertThat(record.on()).isFalse();
        assertThat(record.mayBrief("d-work")).isFalse();
        assertThat(record.keepsToItself("d-work")).isTrue();
        // desk-agent's answer alone (a settings change with no `on`) turns nothing on.
        record.recordAnswer(MaiaRecord.SET, m("attention", m("visible", 3)), m("maia", m("on", true)));
        assertThat(record.on()).isFalse();
        // The member asked, and desk-agent holds it off (the kill switch, say): off.
        record.recordAnswer(MaiaRecord.SET, m("on", true), m("maia", m("on", false)));
        assertThat(record.on()).isFalse();
        on(record);
        assertThat(record.on()).isTrue();
    }

    @Test
    void aGrantIsTheMembersScopesCutToWhatDeskAgentHoldsAndItsExpiryAtMostThirtyDays() {
        MaiaRecord record = kept();
        on(record);
        record.recordAnswer(MaiaRecord.GRANT_SET, grantParams("d-work", List.of("brief", "show"), false),
                grantAnswer("d-work", List.of("brief"), false, days(400)));
        MaiaRecord.Grant g = record.grant("d-work");
        assertThat(g.scopes()).containsExactly("brief");
        // No days from the member: 7, whatever desk-agent's answer says (Security's DMA-L4).
        assertThat(g.expiresAt()).isEqualTo(days(7));
        Map<String, Object> thirty = grantParams("d-work", List.of("brief"), false);
        thirty.put("days", 30);
        record.recordAnswer(MaiaRecord.GRANT_SET, thirty, grantAnswer("d-work", List.of("brief"), false, days(400)));
        assertThat(record.grant("d-work").expiresAt()).isEqualTo(days(30));
        Map<String, Object> one = grantParams("d-work", List.of("brief"), false);
        one.put("days", 1);
        record.recordAnswer(MaiaRecord.GRANT_SET, one, grantAnswer("d-work", List.of("brief"), false, days(30)));
        assertThat(record.grant("d-work").expiresAt()).isEqualTo(days(1));
        assertThat(record.mayBrief("d-work")).isTrue();
        assertThat(record.keepsToItself("d-work")).isFalse();
        // desk-agent's answer can't add a scope the member didn't ask for.
        record.recordAnswer(MaiaRecord.GRANT_SET, grantParams("d-home", List.of("show"), false),
                grantAnswer("d-home", List.of("brief", "show"), false, days(7)));
        assertThat(record.grant("d-home").scopes()).containsExactly("show");
        assertThat(record.mayBrief("d-home")).isFalse();
        // An answer for another desk than the member named records nothing.
        record.recordAnswer(MaiaRecord.GRANT_SET, grantParams("d-play", List.of("brief"), false),
                grantAnswer("d-other", List.of("brief"), false, days(7)));
        assertThat(record.grant("d-play")).isNull();
        assertThat(record.grant("d-other")).isNull();
    }

    @Test
    void keepsToItselfOnlyEverNarrowsEitherSideSayingSoIsEnough() {
        MaiaRecord record = kept();
        on(record);
        record.recordAnswer(MaiaRecord.GRANT_SET, grantParams("d-work", List.of("brief"), false),
                grantAnswer("d-work", List.of("brief"), true, days(7)));
        assertThat(record.keepsToItself("d-work")).isTrue();
        // An extension that doesn't name it keeps it.
        record.recordAnswer(MaiaRecord.GRANT_SET, grantParams("d-work", List.of("brief"), null),
                grantAnswer("d-work", List.of("brief"), false, days(7)));
        assertThat(record.keepsToItself("d-work")).isTrue();
        // The member's own false, with desk-agent's false, lifts it.
        record.recordAnswer(MaiaRecord.GRANT_SET, grantParams("d-work", List.of("brief"), false),
                grantAnswer("d-work", List.of("brief"), false, days(7)));
        assertThat(record.keepsToItself("d-work")).isFalse();
    }

    @Test
    void whatTheMemberTakesAwayHoldsBeforeDeskAgentHearsAndARefusalRecordsNothingMore() {
        MaiaRecord record = kept();
        on(record);
        record.recordAnswer(MaiaRecord.GRANT_SET, grantParams("d-work", List.of("brief", "show"), false),
                grantAnswer("d-work", List.of("brief", "show"), false, days(7)));
        record.recordAnswer(MaiaRecord.GRANT_SET, grantParams("d-home", List.of("brief"), false),
                grantAnswer("d-home", List.of("brief"), false, days(7)));
        // A narrowing set: show only, and keeps to itself, before the call goes.
        record.recordNarrowing(MaiaRecord.GRANT_SET, grantParams("d-work", List.of("show"), true));
        assertThat(record.grant("d-work").scopes()).containsExactly("show");
        assertThat(record.keepsToItself("d-work")).isTrue();
        // desk-agent refused it (no answer is recorded): it stays narrowed.
        record.recordAnswer(MaiaRecord.GRANT_SET, grantParams("d-work", List.of("show"), true), null);
        assertThat(record.mayBrief("d-work")).isFalse();
        // A revoke goes at once.
        record.recordNarrowing(MaiaRecord.GRANT_REVOKE, m("deskId", "d-home"));
        assertThat(record.grant("d-home")).isNull();
        // Off: before desk-agent hears, every grant goes with it.
        record.recordNarrowing(MaiaRecord.SET, m("on", false));
        assertThat(record.on()).isFalse();
        assertThat(record.grant("d-work")).isNull();
        // Turning it on again brings back no grant.
        on(record);
        assertThat(record.grant("d-work")).isNull();
    }

    @Test
    void anExpiredGrantIsNoGrantAndCountsAsKeepingToItself() {
        MaiaRecord record = kept();
        on(record);
        record.recordAnswer(MaiaRecord.GRANT_SET, grantParams("d-work", List.of("brief"), false),
                grantAnswer("d-work", List.of("brief"), false, days(7)));
        assertThat(record.mayBrief("d-work")).isTrue();
        clock.advance(Duration.ofDays(7));
        assertThat(record.mayBrief("d-work")).isFalse();
        assertThat(record.keepsToItself("d-work")).isTrue();
        // A grant answered already expired, or with no scopes, isn't kept.
        record.recordAnswer(MaiaRecord.GRANT_SET, grantParams("d-home", List.of("brief"), false),
                grantAnswer("d-home", List.of("brief"), false, clock.millis()));
        assertThat(record.grant("d-home")).isNull();
    }

    @Test
    void aRestartReadsTheRecordBackFromItsOwnFile() throws Exception {
        MaiaRecord record = kept();
        on(record);
        record.recordAnswer(MaiaRecord.GRANT_SET, grantParams("d-work", List.of("brief"), true),
                grantAnswer("d-work", List.of("brief"), true, days(7)));
        assertThat(Files.getPosixFilePermissions(dir.resolve(MaiaRecord.FILE)))
                .isEqualTo(PosixFilePermissions.fromString("rw-------"));
        assertThat(Files.getPosixFilePermissions(dir.resolve(MaiaRecord.KEY)))
                .isEqualTo(PosixFilePermissions.fromString("rw-------"));
        String text = Files.readString(dir.resolve(MaiaRecord.FILE), StandardCharsets.UTF_8);
        assertThat(text).doesNotContain("Work");
        MaiaRecord again = kept();
        assertThat(again.on()).isTrue();
        assertThat(again.mayBrief("d-work")).isTrue();
        assertThat(again.keepsToItself("d-work")).isTrue();
    }

    @Test
    void aFileThatDoesntVerifyIsSetAsideAndNothingIsRecorded() throws Exception {
        MaiaRecord record = kept();
        on(record);
        record.recordAnswer(MaiaRecord.GRANT_SET, grantParams("d-work", List.of("brief"), false),
                grantAnswer("d-work", List.of("brief"), false, days(7)));
        // A hand edit: a second desk added, the MAC left as it was.
        Map<String, Object> file = new LinkedHashMap<>(Json.parseObject(Files.readAllBytes(dir.resolve(MaiaRecord.FILE))));
        @SuppressWarnings("unchecked")
        Map<String, Object> grants = new LinkedHashMap<>((Map<String, Object>) file.get("grants"));
        grants.put("d-evil", m("scopes", List.of("brief"), "keepsToItself", false, "expiresAt", days(7)));
        file.put("grants", grants);
        Files.write(dir.resolve(MaiaRecord.FILE), Json.bytes(file));
        MaiaRecord again = kept();
        assertThat(again.on()).isFalse();
        assertThat(again.mayBrief("d-work")).isFalse();
        assertThat(again.mayBrief("d-evil")).isFalse();
        assertThat(dir.resolve(MaiaRecord.FILE + ".bad")).exists();
        assertThat(dir.resolve(MaiaRecord.FILE)).doesNotExist();
        // Another desk's key: the same.
        on(again);
        Files.write(dir.resolve(MaiaRecord.KEY), new byte[32]);
        assertThat(kept().on()).isFalse();
        // A link in its place is never followed.
        MaiaRecord third = kept();
        on(third);
        Path target = dir.resolve("elsewhere.json");
        Files.move(dir.resolve(MaiaRecord.FILE), target);
        Files.createSymbolicLink(dir.resolve(MaiaRecord.FILE), target);
        assertThat(kept().on()).isFalse();
    }

    @Test
    void aWriteThatFailsSetsTheLastFileAsideSoARestartRecordsNothing() throws Exception {
        MaiaRecord record = kept();
        on(record);
        record.recordAnswer(MaiaRecord.GRANT_SET, grantParams("d-work", List.of("brief"), false),
                grantAnswer("d-work", List.of("brief"), false, days(7)));
        record.writerForTest((file, bytes) -> {
            throw new java.io.IOException("disk full");
        });
        // The revoke holds in memory at once...
        record.recordNarrowing(MaiaRecord.GRANT_REVOKE, m("deskId", "d-work"));
        assertThat(record.mayBrief("d-work")).isFalse();
        // ...and the last file, which still holds the grant, isn't read back.
        assertThat(dir.resolve(MaiaRecord.FILE + ".unsaved")).exists();
        MaiaRecord again = kept();
        assertThat(again.on()).isFalse();
        assertThat(again.mayBrief("d-work")).isFalse();
    }

    @Test
    void malformedParamsWidenNothing() {
        MaiaRecord record = kept();
        on(record);
        record.recordAnswer(MaiaRecord.GRANT_SET, grantParams("not-a-desk", List.of("brief"), false),
                grantAnswer("not-a-desk", List.of("brief"), false, days(7)));
        record.recordAnswer(MaiaRecord.GRANT_SET, grantParams("d-work", List.of("brief", "spend"), false),
                grantAnswer("d-work", List.of("brief", "spend"), false, days(7)));
        record.recordAnswer(MaiaRecord.GRANT_SET, m("deskId", "d-home", "scopes", "brief"),
                grantAnswer("d-home", List.of("brief"), false, days(7)));
        assertThat(record.grant("not-a-desk")).isNull();
        assertThat(record.grant("d-work")).isNull();
        assertThat(record.grant("d-home")).isNull();
        // agent.maia.forget changes nothing here.
        record.recordAnswer("agent.maia.forget", m(), m("maia", m("on", true)));
        assertThat(record.on()).isTrue();
    }

    @Test
    void aGrantAnsweredAfterARevokeOrOffBeganNeverComesBack() {
        MaiaRecord record = kept();
        on(record);
        long began = record.generation();
        // The member revokes it while a grant.set for the same desk is with desk-agent.
        record.recordNarrowing(MaiaRecord.GRANT_REVOKE, m("deskId", "d-work"));
        record.recordAnswer(MaiaRecord.GRANT_SET, grantParams("d-work", List.of("brief"), false),
                grantAnswer("d-work", List.of("brief"), false, days(7)), began);
        assertThat(record.grant("d-work")).isNull();
        // Turning Maia Mode off the same.
        long again = record.generation();
        record.recordNarrowing(MaiaRecord.SET, m("on", false));
        record.recordAnswer(MaiaRecord.GRANT_SET, grantParams("d-home", List.of("brief"), false),
                grantAnswer("d-home", List.of("brief"), false, days(7)), again);
        assertThat(record.grant("d-home")).isNull();
        // With nothing taken away in between, it's recorded.
        on(record);
        long now = record.generation();
        record.recordAnswer(MaiaRecord.GRANT_SET, grantParams("d-home", List.of("brief"), false),
                grantAnswer("d-home", List.of("brief"), false, days(7)), now);
        assertThat(record.grant("d-home")).isNotNull();
        // A narrower grant.set the same: a wider one answered after it began doesn't put "show" back.
        record.recordAnswer(MaiaRecord.GRANT_SET, grantParams("d-home", List.of("brief", "show"), false),
                grantAnswer("d-home", List.of("brief", "show"), false, days(7)), record.generation());
        long wide = record.generation();
        record.recordNarrowing(MaiaRecord.GRANT_SET, grantParams("d-home", List.of("brief"), false));
        long narrow = record.generation();
        assertThat(narrow).isNotEqualTo(wide);
        record.recordAnswer(MaiaRecord.GRANT_SET, grantParams("d-home", List.of("brief", "show"), false),
                grantAnswer("d-home", List.of("brief", "show"), false, days(7)), wide);
        assertThat(record.grant("d-home").scopes()).containsExactly("brief");
        // The narrowing call's own answer is recorded.
        record.recordAnswer(MaiaRecord.GRANT_SET, grantParams("d-home", List.of("brief"), false),
                grantAnswer("d-home", List.of("brief"), false, days(7)), narrow);
        assertThat(record.grant("d-home").scopes()).containsExactly("brief");
    }
}
