package com.minimalistalliance.desk.deskd.guild;

import com.minimalistalliance.desk.deskd.rpc.Caller;
import com.minimalistalliance.desk.deskd.rpc.RpcContext;
import com.minimalistalliance.desk.deskd.rpc.RpcDispatcher;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import com.minimalistalliance.desk.deskd.rpc.RpcPrincipal;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Supplier;

/**
 * A guild desk's own methods (API.md section 14), for guild members only: {@code guild.hello}, who the caller is here
 * and which apps they have; and {@code guild.settings.get} and {@code set}, the agents' limits, which any member may read
 * and only the Founder or an Officer with {@code manage_agents} may set; its {@code notebook} block, the Notebook's edit
 * budget, needs the Founder or {@code manage_spaces}. {@code guild.usage.get} is the Agent relay's.
 */
public final class GuildMethods {

    static final Set<String> MEMBERS = Set.of(RpcPrincipal.GUILD_MEMBER);
    /** A guild desk's apps (task 48's plan, section 2): Commons, Notebook and Agent. No Browser, no Chat of its own. */
    static final List<String> APPS = List.of("commons", "notebook", "agent");

    private final GuildSettings settings;
    private final Supplier<String> guildId;

    public GuildMethods(GuildSettings settings, Supplier<String> guildId) {
        this.settings = settings;
        this.guildId = guildId;
    }

    public void register(RpcDispatcher dispatcher) {
        dispatcher.register("guild.hello", MEMBERS, (context, params) -> hello(context));
        dispatcher.register("guild.settings.get", MEMBERS, (context, params) -> {
            member(context);
            return settings.view();
        });
        dispatcher.registerMutation("guild.settings.set", MEMBERS, (context, params) -> {
            requireManager(context, params);
            return settings.set(params, context.principal().caller(), () -> {
                context.beginEffect();
                // Read again at the point of no return: a refresh can have taken the grant away meanwhile.
                requireManager(context, params);
            });
        });
    }

    private Map<String, Object> hello(RpcContext context) throws RpcException {
        Caller caller = member(context);
        List<String> apps = new ArrayList<>(APPS);
        if (caller.teen()) {
            apps.remove("agent");
        }
        Map<String, Object> hello = new LinkedHashMap<>();
        hello.put("guildId", guildId.get());
        hello.put("memberId", caller.memberId());
        hello.put("role", caller.role());
        hello.put("grants", caller.grants());
        hello.put("name", caller.name());
        hello.put("apps", apps);
        return hello;
    }

    private static Caller member(RpcContext context) throws RpcException {
        Caller caller = context.principal().caller();
        if (!caller.isGuildMember()) {
            throw new RpcException(RpcException.FORBIDDEN, "The token's scope doesn't allow this", Map.of("reason", "scope"));
        }
        return caller;
    }

    /**
     * Each block a set carries has its own grant: {@code agents} needs {@code manage_agents}, {@code notebook} needs
     * {@code manage_spaces} (a lead has both). A set with both needs both, and one with neither is judged as {@code agents}.
     */
    private static void requireManager(RpcContext context, Map<String, Object> params) throws RpcException {
        Caller caller = member(context);
        boolean notebook = params.containsKey("notebook");
        boolean agents = params.containsKey("agents") || !notebook;
        if (agents && !caller.has(Caller.MANAGE_AGENTS) || notebook && !caller.has(Caller.MANAGE_SPACES)) {
            throw new RpcException(RpcException.FORBIDDEN, "The member's role doesn't allow this", Map.of("reason", "grant"));
        }
    }
}
