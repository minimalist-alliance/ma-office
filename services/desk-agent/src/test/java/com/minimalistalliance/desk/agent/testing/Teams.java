package com.minimalistalliance.desk.agent.testing;

import com.minimalistalliance.desk.agent.audit.AuditLog;
import com.minimalistalliance.desk.agent.limits.LimitSettings;
import com.minimalistalliance.desk.agent.store.AgentStore;
import com.minimalistalliance.desk.agent.store.TeamStore;
import com.minimalistalliance.desk.agent.team.Team;
import com.minimalistalliance.desk.agent.workspace.Workspaces;
import java.nio.file.Path;
import java.time.Clock;
import java.util.function.LongSupplier;

/** A {@link Team} as the configuration wires it, its workspaces and icons under {@code dir}. */
public final class Teams {

    private Teams() {}

    public static Team team(AgentStore store, LimitSettings limits, AuditLog audit, Path dir, Clock clock) {
        return team(store, limits, audit, dir, clock, () -> Long.MAX_VALUE / 4);
    }

    /** With the volume's size set by the test ({@code totalBytes}); its free space is unlimited. */
    public static Team team(AgentStore store, LimitSettings limits, AuditLog audit, Path dir, Clock clock,
            LongSupplier totalBytes) {
        return new Team(store, new TeamStore(store), limits, audit,
                new Workspaces(dir.resolve("workspaces"), 0, () -> Long.MAX_VALUE, totalBytes), dir.resolve("icons"),
                clock);
    }
}
