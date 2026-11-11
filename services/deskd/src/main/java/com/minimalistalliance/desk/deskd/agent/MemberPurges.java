package com.minimalistalliance.desk.deskd.agent;

import java.util.List;
import java.util.Map;

/**
 * What deskd owes desk-agent on a guild desk: removed members whose agent conversations are to be deleted (ADR 0080
 * decision 12 and its addendum of 2026-11-10). The guild's roster decides who ({@code guild.GuildPurges}); the agent
 * relay sends each one as {@code desk.member.purge} ({@link AgentPurges}) and says when it's done.
 */
public interface MemberPurges {

    /** Members whose purge is due now, oldest first. Must not block. */
    List<String> due();

    /** When the next owed purge is due, in the clock's millis, or {@link Long#MAX_VALUE} for none. */
    long nextDueAtMillis();

    /** desk-agent answered: nothing of the member is left there. */
    void done(String memberId, Map<String, Object> answer);

    /** Runs when the list may have changed. Called outside any lock of the list's. */
    void onChange(Runnable wake);

    /** What {@code /health} adds, with no member named: empty off a guild desk. */
    Map<String, Object> health();
}
