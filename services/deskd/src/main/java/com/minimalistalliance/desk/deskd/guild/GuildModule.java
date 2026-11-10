package com.minimalistalliance.desk.deskd.guild;

import com.minimalistalliance.desk.deskd.agent.AgentModule;
import com.minimalistalliance.desk.deskd.auth.DeskTokenVerifier;
import com.minimalistalliance.desk.deskd.gateway.GatewayLink;
import com.minimalistalliance.desk.deskd.platform.AgentClient;
import com.minimalistalliance.desk.deskd.platform.DeskState;
import com.minimalistalliance.desk.deskd.platform.EditBudget;
import com.minimalistalliance.desk.deskd.platform.PlatformConfig;
import com.minimalistalliance.desk.deskd.platform.HeartbeatLoop;
import com.minimalistalliance.desk.deskd.rpc.Caller;
import com.minimalistalliance.desk.deskd.rpc.RpcDispatcher;
import com.minimalistalliance.desk.deskd.rtc.RtcClient;
import com.minimalistalliance.desk.deskd.session.SessionManager;
import java.nio.file.Path;
import java.time.Clock;
import java.util.Collection;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.List;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Wires a guild desk's parts (API.md section 14): the roster, which the token verifier and the sessions answer to; the
 * agents' settings, pushed to desk-agent; the {@code guild.*} methods; and the heartbeat's {@code guild} block. On any
 * other desk it's all here and inert: the verifier never sees a member, the roster is never read, nothing is pushed, and
 * the heartbeat's {@code guild} stays null. Whether this is a guild desk is known once IMDS has been read, which is
 * before any config, session or heartbeat.
 */
public final class GuildModule {

    private final GuildSettings settings;
    private final GuildRoster roster;
    private final GuildSessionLog log;
    private final DeskState state;
    private final AgentModule agent;
    private final AtomicBoolean pushed = new AtomicBoolean();
    private final List<Runnable> budgetListeners = new CopyOnWriteArrayList<>();

    public GuildModule(
            Path directory,
            DeskState state,
            SessionManager sessions,
            RpcDispatcher dispatcher,
            DeskTokenVerifier verifier,
            AgentClient platform,
            AgentModule agent,
            Clock clock,
            GuildRoster.Timing timing,
            GuildSessionLog.Commons commons) {
        this.state = state;
        this.agent = agent;
        this.settings = new GuildSettings(directory, clock);
        this.roster = new GuildRoster(directory, platform::guildRoster, state::guildId, new GuildRoster.Sessions() {
            @Override
            public Collection<Caller> callers() {
                return sessions.memberCallers();
            }

            @Override
            public void closeMember(String memberId) {
                sessions.closeMember(memberId);
            }
        }, timing);
        agent.memberNames(id -> {
            GuildRoster.Member member = roster.member(id);
            if (member != null && member.name() != null) {
                return member.name();
            }
            for (Caller caller : sessions.memberCallers()) {
                if (id.equals(caller.memberId()) && caller.name() != null) {
                    return caller.name();
                }
            }
            return null;
        });
        this.log = new GuildSessionLog(sessions, state::guildDesk, commons);
        new GuildMethods(settings, state::guildId).register(dispatcher);
        verifier.checkMembers(roster);
        settings.onChange(this::push);
        settings.onEditBudgetChange(this::budgetChanged);
        state.onConfig(config -> {
            if (!state.guildDesk() || config.guildId() == null) {
                return;
            }
            // The Platform's value may have changed with this config; desk-notebook is told only if what applies did.
            budgetChanged();
            roster.loadKept();
            if (config.rosterVersion() >= 0) {
                roster.versionIs(config.rosterVersion());
            }
            if (!roster.known()) {
                roster.read();
            }
            if (pushed.compareAndSet(false, true)) {
                push();
            }
        });
    }

    /** The Platform's word that the roster changed. */
    public void follow(GatewayLink link, HeartbeatLoop heartbeat, RtcClient rtc) {
        link.onGuildRoster(this::rosterIs);
        heartbeat.onGuildVersion(this::rosterIs);
        heartbeat.reportGuild(log::block);
        // desk-rtc 0.4.0's final counts: closed sessions wait for them, and their rows in stats are acknowledged.
        // Both do nothing until a configured carries credit, which an older desk-rtc never sends.
        log.finalCountsFrom(rtc::deskRtcHasFinalCounts);
        rtc.closedRows(log);
    }

    private void rosterIs(long version) {
        if (state.guildDesk()) {
            roster.versionIs(version);
        }
    }

    /**
     * The Notebook edit budget in force: the guild's own, else the Platform's {@code guild.notebookEditBudget}, else 500
     * characters in 10 minutes. Null on a desk that isn't a guild's, which sends desk-notebook nothing.
     */
    public EditBudget effectiveEditBudget() {
        if (!state.guildDesk()) {
            return null;
        }
        PlatformConfig config = state.config();
        return EditBudget.effective(settings.editBudget(), config == null ? null : config.notebookEditBudget());
    }

    /** Runs when the budget in force may have changed. Must not block. */
    public void onEditBudgetChange(Runnable listener) {
        budgetListeners.add(listener);
    }

    private void budgetChanged() {
        for (Runnable listener : budgetListeners) {
            listener.run();
        }
    }

    private void push() {
        if (state.guildDesk()) {
            agent.guildSettings(settings.current());
        }
    }

    public void stop() {
        roster.stop();
    }

    /** For tests. */
    public GuildRoster roster() {
        return roster;
    }

    /** For tests. */
    public GuildSettings settings() {
        return settings;
    }
}
