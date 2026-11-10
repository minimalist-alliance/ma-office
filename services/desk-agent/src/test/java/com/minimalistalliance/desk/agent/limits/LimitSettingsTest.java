package com.minimalistalliance.desk.agent.limits;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.minimalistalliance.desk.agent.json.Json;
import java.nio.charset.StandardCharsets;
import java.time.ZoneId;
import java.time.ZoneOffset;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * Task 07's ask 2: the desk's scopes are shared, and every agent's view shows them. ADR 0043: three of them layer desk,
 * then account, then default, with "nothing set" and "no limit, set here" kept apart.
 */
class LimitSettingsTest {

    @Test
    void theDesksScopesAreSharedAndTheAgentsAreTheirOwn() {
        LimitSettings settings = new LimitSettings();
        assertThat(settings.policyFor("manager")).isEqualTo(LimitPolicy.DEFAULTS);

        settings.set("manager", new LimitPolicy(Limit.usd("1"), Limit.usd("3"), Limit.NONE, Limit.usd("50"),
                Limit.tokens(1_000_000), Limit.usd("0.5"), 10));

        LimitPolicy manager = settings.policyFor("manager");
        assertThat(manager.agentDay()).isEqualTo(Limit.usd("1"));
        assertThat(manager.agentWeek()).isEqualTo(Limit.usd("3"));
        assertThat(manager.runMaxSteps()).isEqualTo(10);

        LimitPolicy writer = settings.policyFor("writer");
        assertThat(writer.agentDay()).isEqualTo(LimitPolicy.DEFAULTS.agentDay());
        assertThat(writer.runMaxSteps()).isEqualTo(50);
        assertThat(writer.deskMonth()).isEqualTo(Limit.usd("50"));
        assertThat(writer.keyMonth()).isEqualTo(Limit.tokens(1_000_000));
        assertThat(settings.desk().keyMonth()).isEqualTo(Limit.tokens(1_000_000));
        assertThat(settings.desk().own().deskMonth()).isEqualTo(Limit.usd("50"));
    }

    @Test
    void nothingSetIsTheDefaults() {
        LimitSettings settings = new LimitSettings();
        assertThat(settings.desk().own()).isEqualTo(LimitSettings.Layer.EMPTY);
        assertThat(settings.account()).isEqualTo(LimitSettings.Layer.EMPTY);
        assertThat(settings.policyFor("manager").deskDay()).isEqualTo(Limit.NONE);
        assertThat(settings.policyFor("manager").deskMonth()).isEqualTo(Limit.usd("20"));
        assertThat(settings.timeZone()).isNull();
        assertThat(settings.zone()).isEqualTo(ZoneOffset.UTC);
    }

    @Test
    void theAccountAppliesWhereTheDeskHasNothingAndTheDeskOverridesIt() {
        LimitSettings settings = new LimitSettings();
        assertThat(settings.setAccount(new LimitSettings.Layer(Limit.usd("1"), Limit.usd("100"), "America/Denver"))).isTrue();
        assertThat(settings.policyFor("manager").deskDay()).isEqualTo(Limit.usd("1"));
        assertThat(settings.policyFor("manager").deskMonth()).isEqualTo(Limit.usd("100"));
        assertThat(settings.zone()).isEqualTo(ZoneId.of("America/Denver"));

        settings.setDesk(new LimitSettings.DeskLimits(new LimitSettings.Layer(null, Limit.usd("7"), "Pacific/Auckland"), Limit.NONE));
        assertThat(settings.policyFor("manager").deskDay()).isEqualTo(Limit.usd("1"));
        assertThat(settings.policyFor("manager").deskMonth()).isEqualTo(Limit.usd("7"));
        assertThat(settings.timeZone()).isEqualTo("Pacific/Auckland");

        settings.setDesk(new LimitSettings.DeskLimits(LimitSettings.Layer.EMPTY, Limit.NONE));
        assertThat(settings.policyFor("manager").deskMonth()).isEqualTo(Limit.usd("100"));
        assertThat(settings.timeZone()).isEqualTo("America/Denver");

        assertThat(settings.setAccount(LimitSettings.Layer.EMPTY)).isTrue();
        assertThat(settings.setAccount(LimitSettings.Layer.EMPTY)).isFalse();
        assertThat(settings.policyFor("manager").deskMonth()).isEqualTo(Limit.usd("20"));
        assertThat(settings.zone()).isEqualTo(ZoneOffset.UTC);
    }

    /** "No limit, set here" is a value: it beats the layers under it, where "nothing set" doesn't. */
    @Test
    void noLimitSetOnTheDeskIsApartFromNothingSet() {
        LimitSettings settings = new LimitSettings();
        settings.setAccount(new LimitSettings.Layer(Limit.usd("1"), Limit.usd("100"), null));
        settings.setDesk(new LimitSettings.DeskLimits(new LimitSettings.Layer(Limit.NONE, Limit.NONE, null), Limit.NONE));
        assertThat(settings.policyFor("manager").deskDay()).isEqualTo(Limit.NONE);
        assertThat(settings.policyFor("manager").deskMonth()).isEqualTo(Limit.NONE);
        assertThat(settings.desk().own().toMap().get("deskMonth")).isNotNull();

        settings.setDesk(new LimitSettings.DeskLimits(LimitSettings.Layer.EMPTY, Limit.NONE));
        assertThat(settings.policyFor("manager").deskMonth()).isEqualTo(Limit.usd("100"));
        assertThat(settings.desk().own().toMap().get("deskMonth")).isNull();

        settings.setAccount(new LimitSettings.Layer(null, Limit.NONE, null));
        assertThat(settings.policyFor("manager").deskMonth()).as("no limit, set on the account").isEqualTo(Limit.NONE);
    }

    @Test
    void whatsStoredComesBackTheSameInAllThreeStates() {
        for (LimitSettings.Layer own : new LimitSettings.Layer[] {
            LimitSettings.Layer.EMPTY,
            new LimitSettings.Layer(Limit.NONE, Limit.NONE, "UTC"),
            new LimitSettings.Layer(Limit.usd("1"), new Limit(5L, 6L), "America/Denver"),
        }) {
            LimitSettings.DeskLimits desk = new LimitSettings.DeskLimits(own, Limit.tokens(9));
            assertThat(LimitSettings.DeskLimits.fromJson(desk.toJson(Limit.usd("20")))).isEqualTo(desk);
        }
    }

    /** As desks hold it today: what an older desk-agent wrote counts as this desk's own, and a missing deskDay is unset. */
    @Test
    void aRowFromAnOlderDeskAgentStillLoads() {
        LimitSettings.DeskLimits desk = LimitSettings.DeskLimits.fromJson(
                "{\"deskMonth\":{\"maxMicroUsd\":20000000,\"maxTokens\":null},\"keyMonth\":{\"maxMicroUsd\":null,\"maxTokens\":7}}");
        assertThat(desk.own()).isEqualTo(new LimitSettings.Layer(null, Limit.usd("20"), null));
        assertThat(desk.keyMonth()).isEqualTo(Limit.tokens(7));

        LimitSettings settings = new LimitSettings();
        settings.setDesk(desk);
        settings.setAccount(new LimitSettings.Layer(Limit.usd("1"), Limit.usd("100"), "America/Denver"));
        assertThat(settings.policyFor("manager").deskMonth()).as("the desk's own beats the account").isEqualTo(Limit.usd("20"));
        assertThat(settings.policyFor("manager").deskDay()).isEqualTo(Limit.usd("1"));
        assertThat(settings.timeZone()).isEqualTo("America/Denver");
    }

    /**
     * A rollback: {@code LimitSettings.DeskLimits.fromJson} as the release before ADR 0043 has it, which fails desk-agent's
     * start on a row without both objects. So they're always there, whatever this desk has cleared.
     */
    @Test
    void anOlderDeskAgentCanReadWhatsStored() throws Exception {
        LimitSettings.DeskLimits cleared = new LimitSettings.DeskLimits(LimitSettings.Layer.EMPTY, Limit.NONE);
        String stored = cleared.toJson(Limit.usd("100"));
        Map<String, Object> asRead = Json.parseObject(stored.getBytes(StandardCharsets.UTF_8));
        assertThat(Json.object(asRead, "deskMonth")).containsEntry("maxMicroUsd", 100_000_000);
        assertThat(Json.object(asRead, "keyMonth")).containsEntry("maxMicroUsd", null).containsEntry("maxTokens", null);

        // After a rollback the older one rewrites the row with only its two objects: its deskMonth is then this desk's.
        LimitSettings.DeskLimits rewritten = LimitSettings.DeskLimits.fromJson(
                "{\"deskMonth\":{\"maxMicroUsd\":100000000,\"maxTokens\":null},\"keyMonth\":{\"maxMicroUsd\":null,\"maxTokens\":null}}");
        assertThat(rewritten.own().deskMonth()).isEqualTo(Limit.usd("100"));
    }

    @Test
    void aStoredZoneTheJdkDoesntKnowIsAsGoodAsNone() {
        LimitSettings.DeskLimits desk = LimitSettings.DeskLimits.fromJson("""
                {"deskMonth": {"maxMicroUsd": 1, "maxTokens": null}, "keyMonth": {"maxMicroUsd": null, "maxTokens": null},
                 "own": {"deskDay": null, "deskMonth": null, "timeZone": "Mars/Olympus"}}""");
        assertThat(desk.own()).isEqualTo(LimitSettings.Layer.EMPTY);
    }

    @Test
    void aRowThatCantBeReadIsStillAnError() {
        assertThatThrownBy(() -> LimitSettings.DeskLimits.fromJson("{\"keyMonth\": 1}"))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void onlyRegionsAndUtcAreZones() {
        for (String good : new String[] {"UTC", "America/Denver", "Pacific/Auckland", "Asia/Kolkata", "Europe/Kyiv"}) {
            assertThat(LimitSettings.knownZone(good)).as(good).isTrue();
        }
        for (String bad : new String[] {
            "+05:00", "-07:00", "Z", "UTC+5", "UTC+05:00", "GMT+5", "Etc/GMT+5", "Etc/UTC", "GMT", "Zulu",
            "Mars/Olympus", "america/denver", "", " UTC",
        }) {
            assertThat(LimitSettings.knownZone(bad)).as(bad).isFalse();
        }
    }
}
