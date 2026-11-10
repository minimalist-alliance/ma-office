package com.minimalistalliance.desk.agent.service;

import com.minimalistalliance.desk.agent.limits.Limit;
import com.minimalistalliance.desk.agent.limits.LimitPolicy;
import java.math.BigDecimal;
import java.util.Map;

/**
 * A guild desk's limits on members' agents, from deskd's {@code desk.guild.set} (the guild's settings, draft section 7).
 * A member's agent is bound by both their own caps and the guild's: as each member has one agent, theirs are its
 * agent day and month, and the guild's is the desk's month, since every agent on a guild desk is a member's.
 *
 * @param memberDay a member's dollars a day
 * @param memberMonth a member's dollars a month
 * @param runsPerDay a member's runs a day, or null for no cap
 * @param guildMonth the guild's dollars a month, across members
 * @param runsAtOnce members' runs going at once, across the guild
 */
public record GuildLimits(Limit memberDay, Limit memberMonth, Integer runsPerDay, Limit guildMonth, int runsAtOnce) {

    /** The draft's defaults, until deskd says: $1 a day, $10 a month and 20 runs a member; $50 a month and 2 at once. */
    public static final GuildLimits DEFAULTS = new GuildLimits(Limit.usd("1"), Limit.usd("10"), 20, Limit.usd("50"), 2);

    /** The policy a member's agent's calls reserve against, with the run's own caps from the desk's defaults. */
    public LimitPolicy policy(LimitPolicy defaults) {
        return new LimitPolicy(memberDay, Limit.NONE, memberMonth, Limit.NONE, guildMonth, Limit.NONE,
                defaults.run(), defaults.runMaxSteps());
    }

    /**
     * {@code {agents: {perMember: {runsPerDay, usdPerDay, usdPerMonth}, perGuild: {usdPerMonth, runsAtOnce}, …}}}, as
     * deskd checked it. Anything off is refused whole.
     *
     * @throws RpcError {@code bad_request} with {@code detail: settings}
     */
    static GuildLimits parse(Map<String, Object> params) throws RpcError {
        try {
            Map<?, ?> agents = (Map<?, ?>) params.get("agents");
            Map<?, ?> member = (Map<?, ?>) agents.get("perMember");
            Map<?, ?> guild = (Map<?, ?>) agents.get("perGuild");
            Object runs = member.get("runsPerDay");
            Object atOnce = guild.get("runsAtOnce");
            if (!(atOnce instanceof Number n) || n.longValue() < 1 || n.longValue() > 8
                    || (runs != null && !(runs instanceof Integer || runs instanceof Long))) {
                throw RpcError.badRequest("settings");
            }
            return new GuildLimits(usd(member.get("usdPerDay")), usd(member.get("usdPerMonth")),
                    runs == null ? null : ((Number) runs).intValue(), usd(guild.get("usdPerMonth")), n.intValue());
        } catch (ClassCastException | NullPointerException | ArithmeticException | IllegalArgumentException e) {
            throw RpcError.badRequest("settings");
        }
    }

    private static Limit usd(Object dollars) {
        if (dollars == null) {
            return Limit.NONE;
        }
        BigDecimal amount = dollars instanceof Double || dollars instanceof Float
                ? BigDecimal.valueOf(((Number) dollars).doubleValue())
                : dollars instanceof BigDecimal big ? big : BigDecimal.valueOf(((Number) dollars).longValue());
        return new Limit(amount.movePointRight(6).longValueExact(), null);
    }
}
