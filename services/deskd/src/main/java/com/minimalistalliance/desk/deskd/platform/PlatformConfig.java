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
 * @param maiaUrl {@code endpoints.maia}, Desk Maia's service (ma-platform contract 0.4.4, {@code desk-maia.md}): an https URL
 *     with a host and no query, user info or fragment, or null when the config has none or anything else
 * @param maiaId {@code endpoints.maiaId}, what deskd signs as {@code x-ma-maia-id} to that service ({@code maia.} and 3 to 200
 *     of {@code [a-z0-9.-]}), or null when the config has none or anything else
 */
public record PlatformConfig(
        long configVersion, String issuer, String jwksUrl, String gatewayUrl, String gatewayId, String guildId, long rosterVersion,
        EditBudget notebookEditBudget, Integer autoStopMinutes, String maiaUrl, String maiaId) {

    /** What {@code endpoints.maiaId} must look like (desk-maia.md, "Where"). */
    public static final Pattern MAIA_ID = Pattern.compile("maia\\.[a-z0-9.-]{3,200}");

    /** The same shape as a member's id: auth.md's examples are {@code gu-} and 12 of these. */
    public static final Pattern GUILD_ID = Pattern.compile("gu-[a-z0-9]{4,40}");

    public PlatformConfig(long configVersion, String issuer, String jwksUrl, String gatewayUrl, String gatewayId) {
        this(configVersion, issuer, jwksUrl, gatewayUrl, gatewayId, null, -1, null, null, null, null);
    }

    public PlatformConfig(
            long configVersion, String issuer, String jwksUrl, String gatewayUrl, String gatewayId, String guildId, long rosterVersion) {
        this(configVersion, issuer, jwksUrl, gatewayUrl, gatewayId, guildId, rosterVersion, null, null, null, null);
    }

    public PlatformConfig(
            long configVersion, String issuer, String jwksUrl, String gatewayUrl, String gatewayId, String guildId, long rosterVersion,
            EditBudget notebookEditBudget, Integer autoStopMinutes) {
        this(configVersion, issuer, jwksUrl, gatewayUrl, gatewayId, guildId, rosterVersion, notebookEditBudget, autoStopMinutes,
                null, null);
    }

    /** Whether Desk Maia's service is configured here: both {@code endpoints.maia} and {@code endpoints.maiaId}. */
    public boolean maiaService() {
        return maiaUrl != null && maiaId != null;
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
        return new PlatformConfig(version, issuer, Json.string(endpoints, "jwks"), gateway, gatewayId, guildId(config), roster, budget,
                autoStopMinutes(config), maiaUrl(endpoints), maiaId(endpoints));
    }

    /** {@code endpoints.maia}: https with a host, no user info, query or fragment, at most 512 characters; else absent. */
    static String maiaUrl(Map<String, Object> endpoints) {
        String raw = endpoints.get("maia") instanceof String s ? s : null;
        if (raw == null || raw.length() > 512) {
            return null;
        }
        try {
            URI uri = new URI(raw);
            if (!"https".equals(uri.getScheme()) || uri.getHost() == null || uri.getHost().isEmpty()
                    || uri.getRawUserInfo() != null || uri.getRawQuery() != null || uri.getRawFragment() != null) {
                return null;
            }
            // The route is added to it: one trailing slash is dropped, so the call's path has none doubled.
            return raw.endsWith("/") ? raw.substring(0, raw.length() - 1) : raw;
        } catch (java.net.URISyntaxException e) {
            return null;
        }
    }

    /** {@code endpoints.maiaId}, if it has the shape {@link #MAIA_ID}; else absent. */
    static String maiaId(Map<String, Object> endpoints) {
        String raw = endpoints.get("maiaId") instanceof String s ? s : null;
        return raw != null && MAIA_ID.matcher(raw).matches() ? raw : null;
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
