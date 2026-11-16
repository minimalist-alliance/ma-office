package com.minimalistalliance.desk.deskd.desks;

import com.minimalistalliance.desk.deskd.tools.HostedCall;
import com.minimalistalliance.desk.deskd.tools.HostedTool;
import com.minimalistalliance.desk.deskd.tools.RunLedger;
import com.minimalistalliance.desk.deskd.tools.ToolFailure;
import com.minimalistalliance.desk.deskd.tools.ToolRisk;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.Function;

/**
 * The area {@code desks} of the tools deskd runs for desk-agent (draft ADR "the Agent's tools and approvals", §14):
 * {@code desk_message}, agent X's message to an agent on another of the member's desks, and {@code desk_answer}, agent
 * Y's answer back, which desk-agent's run loop calls with Y's reply, never the model ({@code failed}, a word, in place
 * of the text when Y's run couldn't answer). Each makes one sealed envelope, which desk-agent puts in its outbox.
 *
 * <p><b>The class is deskd's own:</b> {@code own} from a run deskd's ledger holds no {@code S} for, {@code send} from
 * one it does, and {@link com.minimalistalliance.desk.deskd.tools.ToolHost} then runs a {@code send} only against the
 * member's relayed approval, redeemed once. So an agent asks before anything it read on one desk goes to another, both
 * ways, whatever desk-agent says. The grant is deskd's own record's ({@link DeskGrants}), checked at the look (refused
 * {@code no_grant} or {@code rate} before anyone is asked) and again as the envelope is made.
 *
 * <p><b>Desk Maia</b> (Maia Mode, API.md §23) briefs only desks deskd's own record of her grants allows
 * ({@link MaiaGrants}: Maia Mode on, a live grant with {@code brief}; else {@code maia_grant}, at the look and the run),
 * and under that grant her brief is {@code own} even from a run holding {@code S}: the member's own private desks,
 * the concept's {@code delegate}. It's {@code send} again, and asks, when her run holds {@code S} and has read an answer
 * from another desk that keeps to itself or that she has no live grant for ({@link RunLedger.Run#deskOrigins}: the
 * desks deskd gave the run as sources, and the {@code D:} flags desk-agent sends, which only ever add).
 */
public final class DeskTools implements HostedTool {

    /** Desk Maia's fixed agent id (Maia Mode, API.md §23): her briefs go by her grants as well as W6's half. */
    public static final String MAIA = "maia";

    /**
     * Desk Maia's grants as deskd's own record holds them (API.md §23, {@code agent/MaiaRecord}): recorded only from
     * the member's relayed calls, cut to what desk-agent's answer holds.
     */
    public interface MaiaGrants {
        /** Nothing recorded: every brief of hers is refused. */
        MaiaGrants NONE = new MaiaGrants() {
            @Override
            public boolean mayBrief(String deskId) {
                return false;
            }

            @Override
            public boolean keepsToItself(String deskId) {
                return true;
            }
        };

        /** Maia Mode on, and a live grant for that desk with {@code brief}. */
        boolean mayBrief(String deskId);

        /** What that desk told her stays with it: it's marked so, or she has no live grant for it at all. */
        boolean keepsToItself(String deskId);
    }

    private final DeskMessaging messaging;
    /** An agent's name as the desk shows it, for the other desk's words; null when not known. */
    private final Function<String, String> names;
    private volatile MaiaGrants maia = MaiaGrants.NONE;

    public DeskTools(DeskMessaging messaging, Function<String, String> names) {
        this.messaging = messaging;
        this.names = names == null ? id -> null : names;
    }

    /** Desk Maia's grants, deskd's own record of them. */
    public DeskTools maia(MaiaGrants grants) {
        this.maia = grants == null ? MaiaGrants.NONE : grants;
        return this;
    }

    /**
     * The class of a {@code desk_message}. Every agent but Desk Maia: {@code own} from a run holding no {@code S},
     * {@code send} from one that does (W6). Desk Maia under her grant (the concept's {@code delegate}): {@code own},
     * unless her run holds {@code S} and has read an answer from another desk that keeps to itself, or one she has no
     * live grant for: then {@code send}, which asks.
     */
    ToolRisk risk(HostedCall call, RunLedger.Run run, String target) {
        if (!MAIA.equals(call.agentId())) {
            return run.privateData() ? ToolRisk.SEND : ToolRisk.OWN;
        }
        if (!run.privateData()) {
            return ToolRisk.OWN;
        }
        MaiaGrants grants = maia;
        for (String origin : run.deskOrigins()) {
            if (!origin.equals(target) && grants.keepsToItself(origin)) {
                return ToolRisk.SEND;
            }
        }
        return ToolRisk.OWN;
    }

    /** Desk Maia's brief needs her grant for that desk too, with {@code brief}: else {@code maia_grant}. */
    String maiaRefusal(HostedCall call, String desk) {
        return MAIA.equals(call.agentId()) && !maia.mayBrief(desk) ? "maia_grant" : null;
    }

    @Override
    public Look look(HostedCall call, RunLedger.Run run) throws ToolFailure {
        ToolRisk risk = run.privateData() ? ToolRisk.SEND : ToolRisk.OWN;
        Map<String, Object> args = call.args();
        switch (call.tool()) {
            case "desk_message" -> {
                String desk = string(args, "desk");
                String text = string(args, "text");
                if (args.size() != 2 || desk == null || !DeskKeys.DESK_ID.matcher(desk).matches()) {
                    throw ToolFailure.badArgs("desk");
                }
                Map<String, Object> payload = new LinkedHashMap<>();
                payload.put("desk", desk);
                payload.put("text", text);
                Map<String, Object> target = new LinkedHashMap<>();
                target.put("kind", "desk");
                target.put("deskId", desk);
                String refusal = text == null || text.isBlank() || text.length() > DeskMessaging.MAX_TEXT ? "input"
                        : maiaRefusal(call, desk);
                if (refusal == null) {
                    refusal = messaging.messageRefusal(call.agentId(), desk);
                }
                return new Look(risk(call, run, desk), "agent", target, payload, null, refusal);
            }
            case "desk_answer" -> {
                if (MAIA.equals(call.agentId())) {
                    // Desk Maia briefs; she never answers another desk's message.
                    throw ToolFailure.forbidden("maia_grant");
                }
                String grantId = string(args, "grantId");
                String replyTo = string(args, "replyTo");
                String text = string(args, "text");
                String failed = string(args, "failed");
                if (args.size() != 3 || grantId == null || replyTo == null || (text == null) == (failed == null)) {
                    throw ToolFailure.badArgs("grantId");
                }
                Map<String, Object> payload = new LinkedHashMap<>();
                payload.put("grantId", grantId);
                payload.put("replyTo", replyTo);
                payload.put(failed == null ? "text" : "failed", failed == null ? text : failed);
                Map<String, Object> target = new LinkedHashMap<>();
                target.put("kind", "desk");
                DeskGrants.Half half = messaging.grants().half(grantId);
                target.put("deskId", half == null ? null : half.peerDeskId());
                target.put("agentId", half == null ? null : half.peerAgentId());
                String refusal = failed == null && (text.isBlank() || text.length() > DeskMessaging.MAX_TEXT) ? "input"
                        : messaging.answerRefusal(call.agentId(), grantId);
                if (half != null && !run.toolPrivate()
                        && messaging.sources().answersPrivateBrief(replyTo, run.runId(), half.peerDeskId())) {
                    // Desk Maia's private brief gave this run S; her own desk gets its answer back as own (DMA-M1),
                    // unless a tool here gave it this desk's private data too: then W6's card (DMA-L5).
                    risk = ToolRisk.OWN;
                }
                return new Look(risk, "agent", target, payload, null, refusal);
            }
            default -> throw ToolFailure.notFound("tool");
        }
    }

    @Override
    public Result run(HostedCall call, RunLedger.Run run) throws ToolFailure {
        Map<String, Object> args = call.args();
        String maiaRefused = "desk_message".equals(call.tool()) ? maiaRefusal(call, string(args, "desk"))
                : MAIA.equals(call.agentId()) ? "maia_grant" : null;
        if (maiaRefused != null) {
            // Again as it runs: a grant revoked or expired since the look stops it.
            throw ToolFailure.forbidden(maiaRefused);
        }
        try {
            DeskMessaging.Made made = switch (call.tool()) {
                case "desk_message" -> messaging.message(call.agentId(), names.apply(call.agentId()),
                        string(args, "desk"), string(args, "text"), MAIA.equals(call.agentId()) && run.privateData());
                case "desk_answer" -> messaging.answer(call.agentId(), names.apply(call.agentId()),
                        string(args, "grantId"), string(args, "replyTo"), string(args, "text"),
                        string(args, "failed"), run.privateData());
                default -> throw ToolFailure.notFound("tool");
            };
            if ("desk_message".equals(call.tool())) {
                // Which run sent it, so an answer the waiting call takes is this run's source (To-do's kind desk).
                messaging.sources().sent(made.id(), run.runId());
            }
            Map<String, Object> chip = new LinkedHashMap<>();
            chip.put("target", Map.of("kind", "desk", "deskId", made.toDeskId()));
            return new Result(made.toJson(), java.util.Set.of(), chip);
        } catch (DeskMessaging.Refused e) {
            throw "unavailable".equals(e.reason()) ? ToolFailure.unavailable("desks") : ToolFailure.forbidden(e.reason());
        }
    }

    private static String string(Map<String, Object> args, String key) {
        return args.get(key) instanceof String s ? s : null;
    }
}
