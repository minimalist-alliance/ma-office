package com.minimalistalliance.desk.deskd.tools;

import com.minimalistalliance.desk.deskd.docs.DocsModule;
import com.minimalistalliance.desk.deskd.docs.MaiaDocs;
import java.util.Map;
import java.util.Set;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;

/**
 * Desk Maia's document tools (API.md §25 "Desk Maia's document tools"; the draft ADR "Documents" decision 7):
 * {@code docs_find}, {@code docs_handover}, {@code docs_ask} and {@code docs_offer_rule}, on this desk's own index, for
 * agent {@code maia} only and only while deskd's own record has Maia Mode on. Never a team agent's. Titles are the desks'
 * text (untrusted); passages come only within 10 minutes of the member's own "Ask Maia about this". None of them changes a
 * place, makes a rule, hides, deletes, renames or stacks anything: each of those takes the member's tap.
 */
public final class DocsTools implements HostedTool {

    static final String MAIA = "maia";
    static final Set<String> TOOLS = Set.of("docs_find", "docs_handover", "docs_ask", "docs_offer_rule");

    private final Supplier<DocsModule> module;
    private final BooleanSupplier maiaOn;
    private final Supplier<String> deskId;

    public DocsTools(Supplier<DocsModule> module, BooleanSupplier maiaOn, Supplier<String> deskId) {
        this.module = module;
        this.maiaOn = maiaOn;
        this.deskId = deskId;
    }

    @Override
    public boolean available() {
        DocsModule m = module.get();
        return m != null && m.docs() != null;
    }

    private MaiaDocs docs() throws ToolFailure {
        DocsModule m = module.get();
        if (m == null || m.docs() == null) {
            throw ToolFailure.unavailable("docs");
        }
        return new MaiaDocs(m, deskId.get());
    }

    private void check(HostedCall call) throws ToolFailure {
        if (!MAIA.equals(call.agentId())) {
            // A team agent never has the index's tools (the draft ADR's decision 7).
            throw ToolFailure.forbidden("maia_only");
        }
        if (!maiaOn.getAsBoolean()) {
            throw ToolFailure.forbidden("maia_off");
        }
        if (!TOOLS.contains(call.tool())) {
            throw ToolFailure.notFound("tool");
        }
    }

    @Override
    public Look look(HostedCall call, RunLedger.Run run) throws ToolFailure {
        check(call);
        try {
            MaiaDocs.check(call.tool(), call.args());
        } catch (IllegalArgumentException e) {
            throw ToolFailure.badArgs(e.getMessage() == null || !e.getMessage().matches("[a-zA-Z_]{1,32}") ? "args" : e.getMessage());
        }
        return Look.plain(call.args(), Map.of("kind", "documents"));
    }

    @Override
    public Result run(HostedCall call, RunLedger.Run run) throws ToolFailure {
        check(call);
        Map<String, Object> a = call.args();
        try {
            MaiaDocs.check(call.tool(), a);
            Map<String, Object> out = switch (call.tool()) {
                case "docs_find" -> docs().find(a);
                case "docs_handover" -> docs().handover(a);
                case "docs_ask" -> docs().ask(a);
                case "docs_offer_rule" -> docs().offerRule(a);
                default -> throw ToolFailure.notFound("tool");
            };
            if (out.get("refused") instanceof String word) {
                throw ToolFailure.refused(word);
            }
            // Titles, names and passages are this desk's private data, and the documents' own text is untrusted.
            return new Result(out, Set.of("U", "S"), Map.of());
        } catch (ToolFailure e) {
            throw e;
        } catch (IllegalArgumentException e) {
            throw ToolFailure.badArgs(e.getMessage() == null || !e.getMessage().matches("[a-z_]{1,32}") ? "args" : e.getMessage());
        } catch (Exception e) {
            throw ToolFailure.unavailable("docs");
        }
    }
}
