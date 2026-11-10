package com.minimalistalliance.desk.agent.limits;

/**
 * Every scope of design 9.9 that applies to one call. Members change these and agents can't: nothing an agent
 * proposes reaches them, as the tools RPC will have no method for it.
 *
 * @param agentDay the agent's spend in the current day
 * @param agentWeek in the current week, from Monday
 * @param agentMonth in the current month
 * @param deskDay every agent on the desk, in the member's current day
 * @param deskMonth every agent on the desk, this month
 * @param keyMonth everything on this key on this desk, this month (Platform adds up the account, ADR 0020)
 * @param run one run's spend
 * @param runMaxSteps model calls in one run, which stops a runaway loop
 */
public record LimitPolicy(
        Limit agentDay,
        Limit agentWeek,
        Limit agentMonth,
        Limit deskDay,
        Limit deskMonth,
        Limit keyMonth,
        Limit run,
        int runMaxSteps) {

    /** Design 9.9's defaults: agent $5 a day, desk $20 a month, run $2 or 50 steps. No cap on the desk's day. */
    public static final LimitPolicy DEFAULTS = new LimitPolicy(
            Limit.usd("5"), Limit.NONE, Limit.NONE, Limit.NONE, Limit.usd("20"), Limit.NONE, Limit.usd("2"), 50);

    public LimitPolicy {
        if (runMaxSteps < 1) {
            throw new IllegalArgumentException("runMaxSteps must be positive");
        }
    }

    /** With no cap on the desk's day. */
    public LimitPolicy(
            Limit agentDay,
            Limit agentWeek,
            Limit agentMonth,
            Limit deskMonth,
            Limit keyMonth,
            Limit run,
            int runMaxSteps) {
        this(agentDay, agentWeek, agentMonth, Limit.NONE, deskMonth, keyMonth, run, runMaxSteps);
    }
}
