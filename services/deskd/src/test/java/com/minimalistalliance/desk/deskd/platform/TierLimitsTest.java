package com.minimalistalliance.desk.deskd.platform;

import static org.assertj.core.api.Assertions.assertThat;

import com.minimalistalliance.desk.deskd.protocol.Json;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * The free tier's limits as the config says them (agent.md {@code tierLimits}, ADR 0090 section 1): absent on a complete
 * config is none, a failed or unfinished read changes nothing, a malformed field keeps what's held, and what's held stands
 * through a restart.
 */
class TierLimitsTest {

    private static final Map<String, Object> FREE = Map.of("tier", "free", "browserMinutesPerDay", 45, "filesGb", 2, "idleStopMinutes", 30);

    @TempDir
    Path dir;

    private static Map<String, Object> config(long version, Object tierLimits) {
        Map<String, Object> config = new LinkedHashMap<>();
        config.put("configVersion", version);
        config.put("endpoints", Map.of("issuer", "x", "gateway", "wss://gw.example/v1"));
        if (tierLimits != NONE) {
            config.put("tierLimits", tierLimits);
        }
        return config;
    }

    private static final Object NONE = new Object();

    private TierLimits kept(List<TierLimits.Limits> heard) {
        TierLimits limits = new TierLimits();
        limits.keepIn(dir.resolve(TierLimits.FILE));
        limits.onChange(heard::add);
        return limits;
    }

    private Map<String, Object> file() throws Exception {
        return Json.parseObject(Files.readAllBytes(dir.resolve(TierLimits.FILE)));
    }

    @Test
    void aFreeDesksLimitsAreHeldAndKeptAndAnUpgradeLiftsThem() throws Exception {
        List<TierLimits.Limits> heard = new ArrayList<>();
        TierLimits limits = kept(heard);
        assertThat(limits.current()).isNull();

        limits.fromConfig(config(12, FREE));
        assertThat(limits.current()).isEqualTo(new TierLimits.Limits("free", 45, 2, 30));
        assertThat(limits.current().filesCapBytes()).isEqualTo(2L * 1024 * 1024 * 1024);
        assertThat(limits.current().browserMillisPerDay()).isEqualTo(45 * 60_000L);
        assertThat(file()).containsKey("limits");

        // The same again: nothing heard, nothing written.
        limits.fromConfig(config(12, FREE));
        assertThat(heard).hasSize(1);

        // The upgrade in place: the field is gone at a new configVersion.
        limits.fromConfig(config(13, NONE));
        assertThat(limits.current()).isNull();
        assertThat(heard).containsExactly(new TierLimits.Limits("free", 45, 2, 30), null);
        assertThat(file()).containsEntry("limits", null);

        TierLimits again = kept(new ArrayList<>());
        assertThat(again.current()).isNull();
    }

    @Test
    void whatsHeldStandsThroughARestartBeforeAnyConfig() throws Exception {
        kept(new ArrayList<>()).fromConfig(config(12, Map.of("tier", "free", "browserMinutesPerDay", 50, "filesGb", 3, "idleStopMinutes", 20)));
        TierLimits restarted = kept(new ArrayList<>());
        assertThat(restarted.current()).isEqualTo(new TierLimits.Limits("free", 50, 3, 20));
    }

    @Test
    void aConfigThePlatformCouldntFinishChangesNothingHeld() throws Exception {
        List<TierLimits.Limits> heard = new ArrayList<>();
        TierLimits limits = kept(heard);
        limits.fromConfig(config(12, FREE));
        // Hello's copy with configVersion 0: no field isn't an upgrade, and other values aren't taken.
        limits.fromConfig(config(0, NONE));
        limits.fromConfig(config(0, Map.of("tier", "free", "browserMinutesPerDay", 60, "filesGb", 2, "idleStopMinutes", 30)));
        assertThat(limits.current()).isEqualTo(new TierLimits.Limits("free", 45, 2, 30));
        assertThat(heard).hasSize(1);
    }

    @Test
    void anUnfinishedConfigIsTakenByADeskThatHoldsNothingButNotKept() throws Exception {
        TierLimits limits = kept(new ArrayList<>());
        limits.fromConfig(config(0, FREE));
        assertThat(limits.current()).isEqualTo(TierLimits.FREE_DEFAULTS);
        assertThat(dir.resolve(TierLimits.FILE)).doesNotExist();
        // The complete one is kept.
        limits.fromConfig(config(14, FREE));
        assertThat(dir.resolve(TierLimits.FILE)).exists();
    }

    @Test
    void aFieldThatIsntAnObjectKeepsWhatsHeldNoneIncluded() throws Exception {
        TierLimits free = kept(new ArrayList<>());
        free.fromConfig(config(12, Map.of("tier", "free", "browserMinutesPerDay", 50, "filesGb", 2, "idleStopMinutes", 30)));
        free.fromConfig(config(13, "free"));
        free.fromConfig(config(14, null));
        assertThat(free.current().browserMinutesPerDay()).isEqualTo(50);

        Files.delete(dir.resolve(TierLimits.FILE));
        TierLimits paid = kept(new ArrayList<>());
        paid.fromConfig(config(12, NONE));
        paid.fromConfig(config(13, List.of(1, 2)));
        assertThat(paid.current()).isNull();
        // Saying nothing malformed didn't write either.
        assertThat(file()).containsEntry("limits", null);
    }

    @Test
    void aMalformedFieldOnADeskThatHoldsNothingIsTheTiersOwnValues() {
        TierLimits limits = kept(new ArrayList<>());
        limits.fromConfig(config(12, 45));
        assertThat(limits.current()).isEqualTo(TierLimits.FREE_DEFAULTS);
        assertThat(dir.resolve(TierLimits.FILE)).doesNotExist();
    }

    @Test
    void aBadFieldInsideAGoodObjectKeepsThatFieldsHeldValue() {
        TierLimits limits = kept(new ArrayList<>());
        limits.fromConfig(config(12, Map.of("tier", "free", "browserMinutesPerDay", 55, "filesGb", 4, "idleStopMinutes", 30)));
        Map<String, Object> bad = new LinkedHashMap<>();
        bad.put("tier", "free");
        bad.put("browserMinutesPerDay", -5);
        bad.put("filesGb", 2.5);
        bad.put("idleStopMinutes", 25);
        limits.fromConfig(config(13, bad));
        assertThat(limits.current()).isEqualTo(new TierLimits.Limits("free", 55, 4, 25));

        // On a desk that held nothing, a bad field is the tier's own value.
        TierLimits fresh = new TierLimits();
        fresh.fromConfig(config(12, Map.of("tier", "free", "browserMinutesPerDay", "lots", "filesGb", 0, "idleStopMinutes", 30)));
        assertThat(fresh.current()).isEqualTo(new TierLimits.Limits("free", 45, 2, 30));
    }

    @Test
    void wholeNumbersInAnyFormTheParserGivesAreTakenInWideBounds() {
        TierLimits limits = new TierLimits();
        limits.fromConfig(config(12, Map.of("tier", "free", "browserMinutesPerDay", 90L, "filesGb", 32.0, "idleStopMinutes", 240)));
        assertThat(limits.current()).isEqualTo(new TierLimits.Limits("free", 90, 32, 240));
        limits.fromConfig(config(13, Map.of("tier", "free", "browserMinutesPerDay", 1441, "filesGb", 1025, "idleStopMinutes", 30)));
        assertThat(limits.current()).isEqualTo(new TierLimits.Limits("free", 90, 32, 30));
    }

    @Test
    void aJunkFileHoldsTheTiersOwnValuesUntilAConfigSays() throws Exception {
        Files.writeString(dir.resolve(TierLimits.FILE), "{\"limits\": {\"tier\": \"free\"", StandardCharsets.UTF_8);
        TierLimits limits = kept(new ArrayList<>());
        assertThat(limits.current()).isEqualTo(TierLimits.FREE_DEFAULTS);
        limits.fromConfig(config(12, NONE));
        assertThat(limits.current()).isNull();
        assertThat(file()).containsEntry("limits", null);
    }

    @Test
    void aFileLeftByAnotherWriterThatIsntGoodIsJunkToo() throws Exception {
        Files.writeString(dir.resolve(TierLimits.FILE), "{\"limits\": {\"tier\": \"free\", \"browserMinutesPerDay\": 0, \"filesGb\": 2, \"idleStopMinutes\": 30}}");
        assertThat(kept(new ArrayList<>()).current()).isEqualTo(TierLimits.FREE_DEFAULTS);
        Files.writeString(dir.resolve(TierLimits.FILE), "{}");
        assertThat(kept(new ArrayList<>()).current()).isEqualTo(TierLimits.FREE_DEFAULTS);
    }
}
