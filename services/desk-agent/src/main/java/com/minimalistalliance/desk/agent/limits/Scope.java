package com.minimalistalliance.desk.agent.limits;

/** Which limit refused a call. The lowercase name is what the audit log, logs and a client see. */
public enum Scope {
    AGENT_DAY,
    AGENT_WEEK,
    AGENT_MONTH,
    DESK_DAY,
    DESK_MONTH,
    KEY_MONTH,
    RUN,
    RUN_STEPS;

    public String wireName() {
        return name().toLowerCase(java.util.Locale.ROOT);
    }
}
