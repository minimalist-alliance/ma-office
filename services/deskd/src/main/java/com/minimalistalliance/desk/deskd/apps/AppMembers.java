package com.minimalistalliance.desk.deskd.apps;

import java.util.Set;

/**
 * A guild desk's members as its apps may keep data for them (API.md section 19, "Members leaving"; ADR 0080 decision 12).
 * The guild's roster answers, through the same guard as the purge of a removed member's agent conversations
 * ({@code guild.GuildPurges}), so a roster that's wrong never costs a member their data in an app either.
 */
public interface AppMembers {

    /**
     * The member ids whose data every app keeps now: those the roster lists, and those whose purge is owed but still in its
     * grace. Null when the roster mustn't be trusted with a deletion: none known, closed, no Founder, an entry whose id
     * can't be read, or any member's purge held. Must not block for long.
     */
    Set<String> retained();

    /** When {@link #retained} next changes by itself (an owed purge's grace ends), in epoch millis, or {@link Long#MAX_VALUE}. */
    long nextChangeAtMillis();

    /** Runs when {@link #retained} may have changed: a roster applied, or a purge's state. Called outside the roster's locks. */
    void onChange(Runnable wake);
}
