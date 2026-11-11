package com.minimalistalliance.desk.agent.tool;

import java.util.Locale;

/**
 * A tool call's class (draft ADR "the Agent's tools and approvals", section 1). A declaration's risk is the floor for
 * every call of that tool; {@link ToolPolicy} may raise it for one call, never lower it. The order is the order of
 * {@link #atLeast}: a higher class never asks less than a lower one.
 */
public enum Risk {
    /** Looks; changes nothing. Never asks. */
    READ,
    /** The agent's own things: its workspace, plan, memory, messages to linked agents. Never asks, except a memory under U. */
    OWN,
    /** Changes the member's things. Always asks. */
    WRITE,
    /** Moves the member's things to a trash. Always asks. */
    DELETE,
    /** Delivers something to someone else. Always asks. */
    SEND,
    /** May cost the member money. Always asks, each on its own card, never from an unattended run. */
    SPEND,
    /** The member's data may reach a site, or the run gets the member's signed-in session. Always asks. */
    EGRESS;

    /** The wire name: {@code read}, {@code own}, … */
    public String wireName() {
        return name().toLowerCase(Locale.ROOT);
    }

    /** The higher of the two: a call's class can rise, never fall. */
    public Risk atLeast(Risk floor) {
        return floor != null && floor.ordinal() > ordinal() ? floor : this;
    }

    /** Whether every call of this class asks the member, whatever the run holds. */
    public boolean alwaysAsks() {
        return ordinal() >= WRITE.ordinal();
    }

    public static Risk fromWire(String name) {
        return valueOf(name.toUpperCase(Locale.ROOT));
    }
}
