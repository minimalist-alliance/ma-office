package com.minimalistalliance.desk.deskd.platform;

import com.minimalistalliance.desk.deskd.protocol.Json;
import java.net.URI;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * The parts of GET /v1/agent/config that deskd uses so far (agent.md). Everything else in it is
 * ignored, as unknown fields must be.
 *
 * @param gatewayId what to sign as x-ma-gateway-id
 * @param guildId {@code guild.guildId}, on a guild desk the guild it serves, which its members' tokens must name; null
 *     when the config has none, or one that isn't {@code gu-} and lowercase letters and digits
 * @param rosterVersion {@code guild.rosterVersion} on a guild desk (desks.md, "What a Guild Desk hears"), or -1
 * @param notebookEditBudget {@code guild.notebookEditBudget}, the platform-wide Notebook edit budget, or null when the
 *     config has none or one that is malformed or out of bounds
 * @param autoStopMinutes {@code autoStop.autoStopMinutes}, the desk's idle-stop time, or null when the config has none, says
 *     null (never stop) or has one that is not a whole number from 1 to a year of minutes
 */
public record PlatformConfig(
        long configVersion, String issuer, String jwksUrl, String gatewayUrl, String gatewayId, String guildId, long rosterVersion,
        EditBudget notebookEditBudget, Integer autoStopMinutes) {

    /** The same shape as a member's id: auth.md's examples are {@code gu-} and 12 of these. */
    public static final Pattern GUILD_ID = Pattern.compile("gu-[a-z0-9]{4,40}");

    public PlatformConfig(long configVersion, String issuer, String jwksUrl, String gatewayUrl, String gatewayId) {
        this(configVersion, issuer, jwksUrl, gatewayUrl, gatewayId, null, -1, null, null);
    }

    public PlatformConfig(
            long configVersion, String issuer, String jwksUrl, String gatewayUrl, String gatewayId, String guildId, long rosterVersion) {
        this(configVersion, issuer, jwksUrl, gatewayUrl, gatewayId, guildId, rosterVersion, null, null);
    }

    /** @throws IllegalArgumentException if a field deskd can't work without is missing */
    public static PlatformConfig parse(Map<String, Object> config) {
        Map<String, Object> endpoints = Json.object(config, "endpoints");
        String issuer = endpoints == null ? null : Json.string(endpoints, "issuer");
        String gateway = endpoints == null ? null : Json.string(endpoints, "gateway");
        if (issuer == null || gateway == null) {
            throw new IllegalArgumentException("config has no issuer or gateway");
        }
        String gatewayId = Json.string(endpoints, "gatewayId");
        if (gatewayId == null) {
            gatewayId = URI.create(gateway).getHost();
        }
        long version = config.get("configVersion") instanceof Number number ? number.longValue() : 0;
        Map<String, Object> guild = config.get("guild") instanceof Map<?, ?> ? Json.object(config, "guild") : null;
        long roster = guild != null && guild.get("rosterVersion") instanceof Number number ? number.longValue() : -1;
        EditBudget budget = guild == null ? null : EditBudget.parse(guild.get("notebookEditBudget"));
        return new PlatformConfig(version, issuer, Json.string(endpoints, "jwks"), gateway, gatewayId, guildId(config), roster, budget, autoStopMinutes(config));
    }

    private static final int MAX_AUTO_STOP_MINUTES = 366 * 24 * 60;

    private static Integer autoStopMinutes(Map<String, Object> config) {
        Map<String, Object> autoStop = config.get("autoStop") instanceof Map<?, ?> ? Json.object(config, "autoStop") : null;
        if (autoStop != null && autoStop.get("autoStopMinutes") instanceof Number number) {
            double value = number.doubleValue();
            if (value >= 1 && value <= MAX_AUTO_STOP_MINUTES && value == Math.rint(value)) {
                return (int) value;
            }
        }
        return null;
    }

    private static String guildId(Map<String, Object> config) {
        Map<String, Object> guild = config.get("guild") instanceof Map<?, ?> ? Json.object(config, "guild") : null;
        String id = guild == null ? null : Json.string(guild, "guildId");
        return id != null && GUILD_ID.matcher(id).matches() ? id : null;
    }
}
