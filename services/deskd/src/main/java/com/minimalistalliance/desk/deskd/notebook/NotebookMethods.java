package com.minimalistalliance.desk.deskd.notebook;

import com.minimalistalliance.desk.deskd.rpc.RpcContext;
import com.minimalistalliance.desk.deskd.rpc.RpcDispatcher;
import com.minimalistalliance.desk.deskd.rpc.RpcException;
import com.minimalistalliance.desk.deskd.rpc.Caller;
import com.minimalistalliance.desk.deskd.rpc.RpcPrincipal;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The client's {@code notebook.*} methods (API.md section 13), each relayed one to one to desk-notebook on the
 * session's own connection: {@code req} with the same method and params, and its {@code res} or {@code err} back
 * unchanged. deskd checks the session, {@code idem} and the rate limit as for any RPC, and only owner tokens may call.
 *
 * <p>A mutation's point of no return is the moment its bytes go, which only the link's writer knows, so
 * {@link RpcContext#beginEffect} runs there. One that never got that far has no {@code mayHaveApplied}, whatever
 * happened to it, and one that did has it unless desk-notebook answers.
 */
final class NotebookMethods {

    static final List<String> READS = List.of(
            "notebook.tree", "notebook.page.content", "notebook.version.list", "notebook.version.get",
            "notebook.version.asOf", "notebook.activity", "notebook.activity.days", "notebook.search");
    static final List<String> MUTATIONS = List.of(
            "notebook.notebook.create", "notebook.notebook.rename", "notebook.tab.create", "notebook.tab.rename",
            "notebook.tab.recolor", "notebook.tab.addAtPage", "notebook.page.create", "notebook.page.move",
            "notebook.page.trash", "notebook.page.restore", "notebook.version.save", "notebook.version.restore",
            "notebook.settings.set",
            // ADR 0091: a page's label, a copy of a page, and a page from a notebook file. Anyone who may make or move a
            // page may do these, so the guild's rules for them are desk-notebook's, as for the rest.
            "notebook.page.label", "notebook.page.duplicate", "notebook.page.import");

    private final NotebookLinks links;

    NotebookMethods(NotebookLinks links) {
        this.links = links;
    }

    /** The owner's, and a guild member's on a guild desk (API.md section 14), whom desk-notebook knows by the hello's caller. */
    static final Set<String> SCOPES = Set.of(RpcPrincipal.OWNER, RpcPrincipal.GUILD_MEMBER);
    /** The desk's time zone, for every member's Temporal view: the Founder's, or an Officer's with manage_spaces. */
    static final String SETTINGS_SET = "notebook.settings.set";
    /** The space structure, notebooks and tabs: the same rule (guild design call 3). Pages stay open to every member. */
    static final Set<String> SPACE_STRUCTURE = Set.of(
            SETTINGS_SET, "notebook.notebook.create", "notebook.notebook.rename", "notebook.tab.create",
            "notebook.tab.rename", "notebook.tab.recolor", "notebook.tab.addAtPage");

    void register(RpcDispatcher dispatcher) {
        for (String method : READS) {
            dispatcher.register(method, SCOPES, (context, params) -> {
                requireCaller(context, method);
                return links.forSession(context.principal().sessionId()).call(method, params, null);
            });
        }
        for (String method : MUTATIONS) {
            dispatcher.registerMutation(method, SCOPES, (context, params) -> {
                requireCaller(context, method);
                return links.forSession(context.principal().sessionId()).call(method, params, () -> {
                    context.beginEffect();
                    requireCaller(context, method);
                });
            });
        }
    }

    /**
     * Read live: a refresh can change the session's token while a call runs. Everything else a guild member may or may not
     * do here, such as trashing another member's page, is desk-notebook's to decide, by the caller in its hello.
     */
    private static void requireCaller(RpcContext context, String method) throws RpcException {
        RpcPrincipal principal = context.principal();
        if (principal.isGuildMember()) {
            if (SPACE_STRUCTURE.contains(method) && !principal.caller().has(Caller.MANAGE_SPACES)) {
                throw new RpcException(RpcException.FORBIDDEN, "The member's role doesn't allow this", Map.of("reason", "grant"));
            }
            return;
        }
        if (!RpcPrincipal.OWNER.equals(principal.scope())) {
            throw forbidden();
        }
    }

    static RpcException forbidden() {
        return new RpcException(RpcException.FORBIDDEN, "The token doesn't allow this", Map.of("reason", "permission"));
    }
}
