package com.minimalistalliance.desk.deskd.tools;

import java.util.Locale;

/**
 * A tool call's class, as desk-agent's {@code tool/Risk} has it (draft ADR "the Agent's tools and approvals", section 1):
 * deskd's own copy, as the two are separate processes. A declaration's class is the floor for every call; a call's class
 * can rise, never fall. The order is the order of {@link #atLeast}.
 */
public enum ToolRisk {
    READ,
    OWN,
    WRITE,
    DELETE,
    SEND,
    SPEND,
    EGRESS;

    public String wireName() {
        return name().toLowerCase(Locale.ROOT);
    }

    /** The higher of the two. */
    public ToolRisk atLeast(ToolRisk floor) {
        return floor != null && floor.ordinal() > ordinal() ? floor : this;
    }

    /** Whether every call of this class needs the member's approval, whatever the run holds. */
    public boolean asks() {
        return ordinal() >= WRITE.ordinal();
    }

    /** @return the class, or null for a name that isn't one */
    public static ToolRisk fromWire(String name) {
        if (name == null) {
            return null;
        }
        for (ToolRisk risk : values()) {
            if (risk.wireName().equals(name)) {
                return risk;
            }
        }
        return null;
    }
}
