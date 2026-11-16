package com.minimalistalliance.desk.agent.maia;

import com.minimalistalliance.desk.agent.json.Json;
import com.minimalistalliance.desk.agent.manager.ManagerAgent;
import com.minimalistalliance.desk.agent.provider.ToolCall;
import com.minimalistalliance.desk.agent.provider.ToolResult;
import com.minimalistalliance.desk.agent.provider.ToolSpec;
import com.minimalistalliance.desk.agent.store.MessageRow;
import com.minimalistalliance.desk.agent.tool.AgentTools;
import com.minimalistalliance.desk.agent.tool.HostedGuard;
import com.minimalistalliance.desk.agent.tool.Risk;
import com.minimalistalliance.desk.agent.tool.RunContext;
import com.minimalistalliance.desk.agent.tool.ToolRegistry;
import java.nio.charset.StandardCharsets;
import java.sql.SQLException;
import java.time.Instant;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Function;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Desk Maia's profile in desk-agent (the concept's §4 and §8; deskd {@code API.md} §23): her runs' context (the choice
 * rule, her desks and grants; her Maia Mode instructions are the Platform's, on Minimalist Alliance's AI service) and
 * note (the time, her choice weight, briefs left, the member's Maia credits or allowance: never money), her own tools
 * ({@link MaiaTools}), and her guard on
 * {@code desk_message}, the one tool that reaches another desk: a live grant with {@code brief} for that desk, her caps,
 * and "keeps to itself".
 *
 * <p><b>Context and note.</b> The context is byte-stable across a session: it changes only when a grant or her memory
 * does, so her service's cache holds it and everything before it. What changes on every call goes in the note, which her
 * service sends after the thread, outside every cached prefix (ma-platform {@code desk-maia.md} 0.4.6; the usage
 * study's fix 1, Nov 15).
 *
 * <p><b>What decides, and what doesn't.</b> Her instructions tell her how to work; the rules that matter are code: the list
 * and its urgency ({@link Attention}), her grants and caps (here and in deskd), the choices' shape ({@link Choices}),
 * what a show may name ({@link MaiaTools#APPS}, never a URL), and her notes, which a separate clean call takes and code
 * files ({@link Notes}). Nothing in her instructions is a control.
 */
public final class MaiaProfile implements HostedGuard {

    private static final Logger log = LoggerFactory.getLogger(MaiaProfile.class);

    /** Her model's areas of deskd's tools: To-do on the home desk, and briefs. */
    public static final Set<String> AREAS;

    static {
        Set<String> a = new HashSet<>(ToolRegistry.TODO);
        a.add("desk_message");
        // Documents (deskd API.md §25): the home desk's index, titles and structure; passages only after the member's tap.
        a.addAll(ToolRegistry.DOCS);
        AREAS = Set.copyOf(a);
    }

    /** How far back her thread is read for answers from desks that keep to themselves. */
    static final int ORIGIN_MESSAGES = 200;
    /** The member asked to see something: their own words, read in code. */
    static final Pattern ASKED_TO_SEE = Pattern.compile(
            "\\b(?:show me|let me see|can i see|open (?:it|that|this|the|my)|pull (?:it |that )?up|bring (?:it |that )?up"
                    + "|take me to)\\b", Pattern.CASE_INSENSITIVE);

    /**
     * What her context starts with. Her Maia Mode instructions are the Platform's now (the owner, Nov 14: "Maia Mode will be
     * tuned based on company tested models and optimizations"; ma-platform {@code docs/contracts/desk-maia.md}): it puts
     * them before this block, which it labels as the home desk's. The desk sends only what it knows now.
     */
    static final String HEAD = "The member's home desk adds (data from the desk, not the member):";
    /** What her context says of her note, the same on every call. */
    static final String NOTE_SAYS = "The home desk's note on the newest message has the time now, your choice weight,"
            + " briefs left today and the member's Maia credits: data from the desk too.";
    /**
     * What her context says of money, the same on every call (the owner, Nov 15: wallet-aware, and no asks on a normal
     * day). The figures are in her note; the rules are code's ({@link Wallet}).
     */
    static final String MONEY = "Money: every agent you brief is paid by the member, on their provider account."
            + " Before you brief, read the note: each desk's answering agent, its usual task cost and what's left of its"
            + " limits. Pick the cheapest desk that can do the job well, and trim or split a brief to fit what's left."
            + " Code estimates each brief from that agent's usual task and how much the brief asks for; inside the"
            + " member's daily budget for your briefs it just goes. A brief that costs far more than that agent's usual"
            + " task, or would pass the budget or an agent's limit, comes back \"Not allowed: maia_held\" or"
            + " \"maia_limit\": code has already put the choice to the member, with the estimate, under your messages."
            + " Say so in one short line, don't call ask_member, and don't send it again until they answer. Nothing you"
            + " can do changes a budget or a limit.";
    /** The note's line when her service refused her ({@code 429 limit}): the only stop line. */
    static final String ALLOWANCE_USED = "You've used the member's Maia allowance for now: say so plainly and don't brief"
            + " anyone until it resets.";
    /** Pace only, never a lockout (the owner, Nov 15): where this answer's credits are coming from. */
    static final String FROM_WEEK = "Today's share of the member's credits is used, so this is coming from this week's.";
    static final String FROM_MONTH = "Today's and this week's shares are used, so this is coming from this month's.";
    private static final DateTimeFormatter DATE = DateTimeFormatter.ofPattern("d MMMM", Locale.ENGLISH);
    private static final DateTimeFormatter NOW = DateTimeFormatter.ofPattern("EEEE d MMMM yyyy, h:mm a",
            Locale.ENGLISH);
    private static final DateTimeFormatter CLOCK = DateTimeFormatter.ofPattern("h:mm a", Locale.ENGLISH);

    private final MaiaMode maia;
    private final Function<Integer, List<MessageRow>> thread;
    /** Desks a run read a private answer from, by run id, while it runs. */
    private final Map<String, Set<String>> inRun = new ConcurrentHashMap<>();
    /** Whether the member's last message asked to see something: read in code at send, used by one show. */
    private volatile boolean askedToSee;

    /**
     * @param thread her newest thread messages, at most this many
     */
    /** Her check-ins and her reader (Maia Mode Phase 2), from the agent service. */
    public interface AwayTools {
        String checkIn(Object minutes) throws SQLException;

        ToolResult read(ToolCall call, RunContext run) throws SQLException;
    }

    private volatile AwayTools awayTools;

    public void awayTools(AwayTools tools) {
        this.awayTools = tools;
    }

    public MaiaProfile(MaiaMode maia, Function<Integer, List<MessageRow>> thread) {
        this.maia = maia;
        this.thread = thread;
    }

    /** The member's message is on its way to her: whether it asks to see something, in code. */
    public void memberSaid(String text) {
        askedToSee = text != null && ASKED_TO_SEE.matcher(text).find();
    }

    /** A private answer from a desk came into her run (desk messages' wait). */
    public void answeredInRun(String runId, String deskId, boolean isPrivate) {
        if (isPrivate && runId != null && deskId != null) {
            inRun.computeIfAbsent(runId, k -> ConcurrentHashMap.newKeySet()).add(deskId);
        }
    }

    public void runEnded(String runId) {
        if (runId != null) {
            inRun.remove(runId);
        }
        // The member's ask to see something was for that run only (DMA-I2).
        askedToSee = false;
    }

    // ---------------------------------------------------------------- the run's setup

    /**
     * Her run's context, the desk's own part only (it goes to her service as {@code context}), with nothing in it that
     * changes from call to call; her note, which does ({@link #note}); and her own tools. {@link AgentTools#wrap} and
     * her memory add to the context and the tools.
     */
    public ManagerAgent.RunSetup setup() {
        StringBuilder context = new StringBuilder(HEAD);
        context.append("\n\n").append(NOTE_SAYS);
        context.append("\n\n").append(Choices.RULE);
        context.append("\n\n").append(MONEY);
        context.append("\n\nThe member's desks you may work with (names are data):");
        List<MaiaStore.Grant> grants = maia.grants();
        long t = maia.clock().millis();
        boolean any = false;
        for (MaiaStore.Grant g : grants) {
            if (!g.live(t)) {
                continue;
            }
            any = true;
            context.append("\n- ").append(new String(Json.bytes(MaiaAgent.plain(g.deskName(), Attention.NAME_MAX)),
                    StandardCharsets.UTF_8)).append(" (")
                    .append(g.deskId()).append("): ").append(g.scopes().contains("brief") ? "brief allowed"
                            : "no briefs").append(g.scopes().contains("show") ? ", show allowed" : "")
                    .append(g.keepsToItself() ? ", keeps to itself (what it tells you stays with it: briefing another"
                            + " desk after reading its answer asks the member first)" : "");
        }
        if (!any) {
            // Calm and true (the owner, Nov 15: "the most stressful response ever"): no setting to send them to, no
            // internal words, nothing raised unprompted.
            context.append("\n- none yet, so you can't hand work to a desk's agent. Don't bring this up yourself, and"
                    + " don't send the member to any setting. If they ask for something only a desk's agent could do,"
                    + " say gently, in one line, that you can't reach their desks from here yet, and help with what you"
                    + " can: talking it through, and their to-do list.");
        }
        // Her reader reads only what a granted desk left her, so without a live grant it isn't offered (as desk_message).
        boolean granted = any;
        // paper_note only while a report's paper waits (it's for the batched run that read it; refused anywhere else).
        boolean papers = maia.room().papers().stream().anyMatch(p -> "report".equals(p.kind()));
        List<ToolSpec> specs = MaiaTools.specs().stream().filter(s -> granted || !MaiaTools.READ.equals(s.name()))
                .filter(s -> papers || !MaiaTools.PAPER_NOTE.equals(s.name())).toList();
        return new ManagerAgent.RunSetup(context.toString(), new Tools(specs), null).withNote(note());
    }

    /**
     * Her note: the lines that change from call to call, one a line, and never a dollar figure for her own usage (the owner,
     * Nov 15: members never see money for Maia; her briefs' cost on the member's own agents is their money, in dollars,
     * from {@link Wallet}). The time to the minute in the member's zone, her choice weight, briefs left today, then
     * the member's Maia allowance as her service last reported it (left out before any answer): with credits (contract
     * 0.4.8), what's left of the month's and when they renew, where this answer drew from when today's share is used
     * (pace only, never a stop), top-up credits, and the lighter model when the month's credits and top-ups are used up
     * (she says so once and keeps helping); without (a tier that shares its allowance, or an older Platform), the share
     * left. Then where she stands against the member's own day cap in credits, when they set one, and a stop line only
     * when her service refused her ({@code limit}).
     */
    String note() {
        StringBuilder note = new StringBuilder();
        long millis = maia.clock().millis();
        ZonedDateTime now = ZonedDateTime.ofInstant(Instant.ofEpochMilli(millis), maia.zone());
        note.append("Now: ").append(now.format(NOW)).append(" in the member's time zone.");
        note.append('\n').append(Choices.weightLine(maia.weight()));
        int left = maia.briefsPerDay() - briefsToday();
        note.append("\nBriefs left today: ").append(Math.max(0, left)).append('.');
        MaiaMode.Allowance allowance = maia.allowance();
        if (allowance != null) {
            // A tier with no monthly part may have no renewal (the one wallet, 0.4.10).
            ZonedDateTime at = allowance.resetsAt() == null ? null
                    : ZonedDateTime.ofInstant(allowance.resetsAt(), maia.zone());
            String renewsOn = at == null ? null : renews(now, at);
            MaiaMode.Credits credits = allowance.credits();
            if (credits != null && credits.wallet()) {
                note.append('\n').append(walletLine(credits, renewsOn));
                String pace = pace(credits);
                if (pace != null && !allowance.lighter()) {
                    note.append('\n').append(pace);
                }
            } else if (credits != null) {
                note.append("\nMaia credits: ").append(Attention.whole(credits.monthLeft())).append(" of ")
                        .append(Attention.whole(credits.month())).append(" left this month (renews ")
                        .append(renewsOn).append(").");
                String pace = pace(credits);
                if (pace != null && !allowance.lighter()) {
                    note.append('\n').append(pace);
                }
            } else {
                long permille = Math.max(0, Math.min(1000, Math.round(allowance.fraction() * 1000)));
                note.append("\nMaia allowance left: ").append(allowance.usedUp() ? 0 : permille / 10)
                        .append(at == null ? "%." : "% (resets " + resets(now, at) + ").");
            }
            if (allowance.lighter() && !allowance.usedUp()) {
                note.append('\n').append(credits != null && credits.wallet()
                        ? walletLighter(renewsOn, credits.lighterLeft()) : lighter(renewsOn));
            }
        }
        Long cap = maia.capCredits();
        if (cap != null) {
            note.append("\nCredits today on this desk: ").append(Attention.creditsText(maia.creditsTodayCenti()))
                    .append(" of the member's own day cap of ").append(Attention.whole(cap)).append('.');
        }
        if (allowance != null && allowance.usedUp()) {
            note.append('\n').append(ALLOWANCE_USED);
        }
        // The focus shield: a hold the member asked for, and how much they like her to write (never focus itself).
        try {
            String hold = maia.shield().holdNote(millis);
            if (hold != null) {
                note.append('\n').append(hold);
            }
            String detail = maia.shield().settings(millis).detail();
            if ("line".equals(detail)) {
                note.append("\nThe member likes one line from you unless they ask for more.");
            } else if ("full".equals(detail)) {
                note.append("\nThe member likes the full picture from you.");
            }
        } catch (RuntimeException e) {
            log.warn("her note's shield lines weren't made: {}", e.getClass().getSimpleName());
        }
        // Her briefs' spend, each desk's answering agent and what's left, and a held brief (Wallet).
        try {
            String money = maia.wallet().noteLines();
            if (!money.isEmpty()) {
                note.append('\n').append(money);
            }
        } catch (RuntimeException e) {
            log.warn("her note's money lines weren't made: {}", e.getClass().getSimpleName());
        }
        String papers = paperLine(maia.room().papers());
        if (!papers.isEmpty()) {
            note.append('\n').append(papers);
        }
        return note.toString();
    }

    /**
     * The decision tray, in her note: ids and kinds only, never a title or anyone's words (code decides what reaches the
     * member; she only points at it). The room draws each paper from the home desk's own when her reply names it.
     */
    static String paperLine(List<Tray.Paper> papers) {
        StringBuilder b = new StringBuilder();
        int n = 0;
        for (Tray.Paper p : papers) {
            if (n == 5) {
                break;
            }
            String kind = switch (p.kind()) {
                case "approval" -> "an approval";
                case "report" -> "a report's decision";
                case "doc" -> "a document";
                case "reply" -> "someone waiting on a reply";
                default -> "a to-do from someone";
            };
            b.append(n == 0 ? "" : ", ").append("[paper:").append(p.paperId()).append("] ").append(kind);
            n++;
        }
        if (n == 0) {
            return "";
        }
        return "Waiting for the member's decision: " + b + (papers.size() > n ? " and " + (papers.size() - n)
                + " more" : "") + ". When they ask what needs them, put those tokens in your reply and the room shows"
                + " each one for them to answer. You never answer or approve one for them.";
    }

    /** Where this answer drew from, when today's share is used: one plain line, or null within today's share. */
    static String pace(MaiaMode.Credits credits) {
        String from = credits.drawingFrom();
        if (from == null) {
            return null;
        }
        return switch (from) {
            case "week" -> FROM_WEEK;
            case "month" -> FROM_MONTH;
            case "starting" -> "This month's credits are used; this is coming from the starting credits: "
                    + Attention.whole(credits.starting()) + " left.";
            case "none" -> "The member's credits are used up, and their plan has no lighter model: say so plainly, once;"
                    + " a top-up keeps you and their agents going.";
            case "topUp" -> credits.wallet()
                    ? "This month's and the starting credits are used; this is coming from top-up credits: "
                            + Attention.whole(credits.topUpLeft()) + " left."
                    : "The month's credits are used; this is coming from top-up credits: "
                            + Attention.whole(credits.topUpLeft()) + " left.";
            default -> null;
        };
    }

    /**
     * The member's one wallet (contract 0.4.10, the coordinator's decision of Nov 15), shared with their agents on MA's
     * credits: "Credits: 1,760 left (1,550 of this month's 2,500, 210 starting), shared with the member's agents; this month's
     * renew 1 December." Whole credits, never money.
     */
    static String walletLine(MaiaMode.Credits c, String renews) {
        List<String> parts = new ArrayList<>();
        if (c.month() > 0) {
            parts.add(Attention.whole(c.monthLeft()) + " of this month's " + Attention.whole(c.month()));
        }
        if (c.starting() > 0) {
            parts.add(Attention.whole(c.starting()) + " starting");
        }
        if (c.topUpLeft() > 0) {
            parts.add(Attention.whole(c.topUpLeft()) + " top-up");
        }
        return "Credits: " + Attention.whole(c.left()) + " left" + (parts.isEmpty() ? "" : " (" + String.join(", ", parts)
                + ")") + ", shared with the member's agents" + (c.month() > 0 && renews != null ? "; this month's renew "
                        + renews : "") + ".";
    }

    /** On the lighter model past the whole wallet: say so plainly once and keep helping, never stop. */
    static String walletLighter(String renews, Long lighterLeft) {
        return "The member's credits are used up, so you're on a lighter model" + (lighterLeft == null ? ""
                : " (today's lighter share: " + Attention.whole(lighterLeft) + " left)") + (renews == null
                        ? " until the member tops up" : " until this month's renew (" + renews + ") or the member tops up")
                + ": say so plainly once, keep helping, and never stop because of it.";
    }

    /** She's on the lighter model: say so plainly once and keep helping, never stop. */
    static String lighter(String renews) {
        return "The member's Maia credits for this month are used up, so you're on a lighter model until they renew ("
                + renews + ") or the member tops up: say so plainly once, keep helping, and never stop because of it.";
    }

    /** When the month's credits renew, in the member's zone: a date ("1 December"), never a countdown. */
    static String renews(ZonedDateTime now, ZonedDateTime at) {
        if (!at.toLocalDate().isAfter(now.toLocalDate())) {
            return "today " + at.format(CLOCK).toLowerCase(Locale.ROOT);
        }
        return at.format(DATE);
    }

    /** When her allowance resets, in the member's zone: "5:00 pm", "tomorrow 5:00 pm", "Tuesday 5:00 pm", "1 December". */
    static String resets(ZonedDateTime now, ZonedDateTime at) {
        String clock = at.format(CLOCK).toLowerCase(Locale.ROOT);
        long days = java.time.temporal.ChronoUnit.DAYS.between(now.toLocalDate(), at.toLocalDate());
        if (days <= 0) {
            return clock;
        }
        if (days == 1) {
            return "tomorrow " + clock;
        }
        if (days < 7) {
            return at.getDayOfWeek().getDisplayName(java.time.format.TextStyle.FULL, Locale.ENGLISH) + " " + clock;
        }
        return at.format(DateTimeFormatter.ofPattern("d MMMM", Locale.ENGLISH));
    }

    int briefsToday() {
        try {
            return maia.store().count(maia.today(), "brief", "all");
        } catch (SQLException e) {
            return Integer.MAX_VALUE / 2;
        }
    }

    /** Her own tools in a run. */
    private final class Tools implements ManagerAgent.Tools {
        private final List<ToolSpec> specs;

        Tools(List<ToolSpec> specs) {
            this.specs = specs;
        }

        @Override
        public List<ToolSpec> specs() {
            return specs;
        }

        @Override
        public ToolResult call(ToolCall call, String runId) {
            return new ToolResult(call.id(), "Refused: gate.", true);
        }

        @Override
        public ToolResult call(ToolCall call, RunContext run,
                com.minimalistalliance.desk.agent.approval.Verdict verdict) {
            try {
                return switch (call.name()) {
                    case MaiaTools.DESKS -> ok(call, AgentTools.fenced("the office's view of the member's desks",
                            desksJson()));
                    case MaiaTools.DESK_STATUS -> status(call);
                    case MaiaTools.SHOW -> show(call, run);
                    case MaiaTools.FOCUS_SET -> focusSet(call, run);
                    case MaiaTools.PAPER_NOTE -> paperNote(call, run);
                    case MaiaTools.CHECK_IN -> {
                        AwayTools a = awayTools;
                        if (a == null) {
                            yield new ToolResult(call.id(), "Refused: unavailable.", true);
                        }
                        String said = a.checkIn(call.input().get("minutes"));
                        yield new ToolResult(call.id(), said, said.startsWith("Refused"));
                    }
                    case MaiaTools.READ -> {
                        AwayTools a = awayTools;
                        yield a == null ? new ToolResult(call.id(), "Refused: unavailable.", true) : a.read(call, run);
                    }
                    case MaiaTools.ASK -> {
                        if (run.messageId() == null) {
                            yield new ToolResult(call.id(), "Refused: no_reply.", true);
                        }
                        String said = maia.offer(run.messageId(), call.input());
                        yield new ToolResult(call.id(), said, said.startsWith("Refused"));
                    }
                    default -> new ToolResult(call.id(), "Unknown tool.", true);
                };
            } catch (SQLException e) {
                log.warn("a tool of hers failed: {} {}", call.name(), e.getClass().getSimpleName());
                return new ToolResult(call.id(), "Failed: storage.", true);
            }
        }

        @Override
        public String chip(ToolCall call, ToolResult result) {
            if (MaiaTools.SHOW.equals(call.name())) {
                String said = result.content() == null ? "" : result.content();
                return result.error() ? "Couldn't show you that" : said.startsWith("Offered")
                        ? "Offered to show you a desk" : "Showed you a desk";
            }
            String words = switch (call.name()) {
                case MaiaTools.DESKS -> "Looked at your desks";
                case MaiaTools.DESK_STATUS -> "Looked at a desk";
                case MaiaTools.ASK -> "Asked you";
                case MaiaTools.FOCUS_SET -> "Noted what you’re working on";
                case MaiaTools.PAPER_NOTE -> "Summed up a decision for you";
                case MaiaTools.CHECK_IN -> "Will check in later";
                case MaiaTools.READ -> "Read what an agent left";
                default -> call.name();
            };
            return result.error() ? words + " (refused)" : words;
        }

        /**
         * Her choices, once shown, close her reply: the run ends there with no second model call, which only ever said
         * her reply again (the owner's doubled welcome, Nov 15). A reply with no words of its own shows her question.
         * Refused choices don't end it, so she can put them right.
         */
        @Override
        public String endsRun(ToolCall call, ToolResult result) {
            if (!MaiaTools.ASK.equals(call.name()) || result.error()) {
                return null;
            }
            return MaiaAgent.plain(call.input().get("question"), Choices.MAX_QUESTION);
        }
    }

    private static ToolResult ok(ToolCall call, String content) {
        return new ToolResult(call.id(), content, false);
    }

    /** The desks as data: ids, names (cut and cleaned), states, agents and counts. */
    String desksJson() {
        List<Map<String, Object>> out = new ArrayList<>();
        for (Attention.Desk d : maia.room().desks()) {
            Map<String, Object> v = new LinkedHashMap<>();
            v.put("deskId", d.deskId());
            v.put("name", d.name());
            v.put("state", d.state());
            v.put("connected", d.linkOpen());
            MaiaStore.Grant g = maia.grantFor(d.deskId(), "brief");
            v.put("briefAllowed", g != null);
            List<Map<String, Object>> agents = new ArrayList<>();
            for (Attention.Agent a : d.agents()) {
                Map<String, Object> av = new LinkedHashMap<>();
                av.put("agentId", a.agentId());
                av.put("name", a.name());
                av.put("status", a.statusDetail() != null ? a.statusDetail() : a.status());
                putCosts(av, a.headroom());
                agents.add(av);
            }
            v.put("agents", agents);
            v.put("approvalsWaiting", d.approvals().size());
            v.put("newTodos", d.todosNew());
            out.add(v);
        }
        Map<String, Object> wrapped = new LinkedHashMap<>();
        wrapped.put("desks", out);
        wrapped.put("connected", !maia.room().desks().isEmpty());
        return new String(Json.bytes(wrapped), StandardCharsets.UTF_8);
    }

    /** An agent's costs as data, dollars: its usual task, and what's left of its limits (counts and dollars only). */
    static void putCosts(Map<String, Object> av, Wallet.Headroom h) {
        if (h == null) {
            return;
        }
        Long usual = h.usual();
        if (usual != null) {
            av.put("usualTaskUsd", Wallet.usd(usual));
        }
        if (h.dayLeft() != null) {
            av.put("leftTodayUsd", Wallet.usd(Math.max(0, h.dayLeft())));
        }
        if (h.monthLeft() != null) {
            av.put("leftThisMonthUsd", Wallet.usd(Math.max(0, h.monthLeft())));
        }
        if (h.briefMax() != null) {
            av.put("oneBriefMaxUsd", Wallet.usd(Math.max(0, h.briefMax())));
        }
    }

    private ToolResult status(ToolCall call) {
        Object id = call.input().get("deskId");
        Attention.Desk d = id instanceof String s ? maia.room().desk(s) : null;
        if (d == null) {
            return new ToolResult(call.id(), "Refused: not_found. Use an id office_desks lists.", true);
        }
        Map<String, Object> v = new LinkedHashMap<>();
        v.put("deskId", d.deskId());
        v.put("name", d.name());
        v.put("state", d.state());
        List<Map<String, Object>> agents = new ArrayList<>();
        for (Attention.Agent a : d.agents()) {
            Map<String, Object> av = new LinkedHashMap<>();
            av.put("agentId", a.agentId());
            av.put("name", a.name());
            av.put("status", a.status());
            av.put("waiting", a.statusDetail());
            av.put("approvalsPending", a.approvalsPending());
            putCosts(av, a.headroom());
            agents.add(av);
        }
        v.put("agents", agents);
        List<Map<String, Object>> approvals = new ArrayList<>();
        for (Attention.Approval a : d.approvals()) {
            approvals.add(Map.of("approvalId", a.approvalId(), "agentId", a.agentId(), "expiresAt",
                    Instant.ofEpochMilli(a.expiresAt()).toString()));
        }
        v.put("approvalsWaiting", approvals);
        List<Map<String, Object>> stopped = new ArrayList<>();
        for (Attention.Stopped s : d.stopped()) {
            stopped.add(Map.of("agentId", s.agentId(), "reason", s.reason()));
        }
        v.put("stopped", stopped);
        v.put("newTodos", d.todosNew());
        return ok(call, AgentTools.fenced("the office's view of one of the member's desks",
                new String(Json.bytes(v), StandardCharsets.UTF_8)));
    }

    /**
     * Her handover (deskd API.md §25 {@code docs_handover}): the card goes under her reply as {@code doc}, and the room
     * draws it from the desk itself (title, reason, her summary line), so nothing of the document rides her message.
     */
    private void handedOver(RunContext run, Map<String, Object> args) {
        String home = maia.mode().get("homeDeskId") instanceof String h ? h : null;
        if (home == null || run.messageId() == null || !(args.get("docId") instanceof String docId)
                || !docId.matches("d_[0-9A-HJKMNP-TV-Z]{26}")) {
            return;
        }
        Map<String, Object> doc = new LinkedHashMap<>();
        doc.put("deskId", home);
        doc.put("docId", docId);
        try {
            maia.putDoc(run.messageId(), doc);
        } catch (SQLException e) {
            log.warn("her handover card wasn't kept: {}", e.getClass().getSimpleName());
        }
    }

    /**
     * {@code working_on}: only in a run the member's own message started (a report, a check-in or another desk's run
     * can't make its own item "close"); code picks the refs from what the member dwelt on, so she never sees an id.
     */
    /**
     * {@code paper_note {paperId, line, answers?, pick?}}: her line and answers on a report's paper (the decision tray),
     * only in the batched run that read that report (Phase 2's), only for a paper code named in it. The line is plain,
     * at most 140; the answers go through {@link Tray#labels} (a link, an address, an @ or a long number drops them
     * all, and the paper keeps code's). It changes no kind, deadline, level or where the answer goes, and it answers
     * nothing.
     */
    private ToolResult paperNote(ToolCall call, RunContext run) {
        Map<String, Object> in = call.input();
        String paperId = in.get("paperId") instanceof String p ? p.strip() : null;
        Away a = maia.away();
        if (paperId == null || !Tray.paperIdOk(paperId) || a == null || !a.paperInBatch(run.origin(), paperId)) {
            return new ToolResult(call.id(), "Refused: paper. Only for a paper named in this turn's reports.", true);
        }
        String line = MaiaAgent.plain(in.get("line"), Tray.LINE_MAX);
        if (line.isEmpty()) {
            return new ToolResult(call.id(), "Refused: line.", true);
        }
        List<String> answers = in.get("answers") == null ? List.of() : Tray.labels(in.get("answers"));
        boolean dropped = in.get("answers") instanceof List<?> l && !l.isEmpty() && answers.isEmpty();
        int pick = in.get("pick") instanceof Number n ? Math.max(0, Math.min(Math.max(0, answers.size() - 1),
                n.intValue())) : 0;
        long now = maia.clock().millis();
        Tray.State st = maia.trayStore().state(paperId);
        maia.trayStore().note(st != null ? st : Tray.State.fresh(paperId, "report", "report", null, now),
                new Tray.Note(line, answers, pick, now), now);
        maia.room().rebuild();
        return new ToolResult(call.id(), dropped ? "Noted the line. The answers weren't usable (keep them short and"
                + " plain), so the paper keeps its own." : "Noted on the paper.", false);
    }

    private ToolResult focusSet(ToolCall call, RunContext run) {
        if (!"member".equals(run.origin().get("kind"))) {
            return new ToolResult(call.id(), "Refused: origin. Only when the member tells you in their own message.",
                    true);
        }
        if (!(call.input().get("label") instanceof String label) || label.isBlank()) {
            return new ToolResult(call.id(), "Refused: label.", true);
        }
        try {
            Map<String, Object> r = maia.shield().focusSet(label, maia.clock().millis());
            maia.room().rebuild();
            return new ToolResult(call.id(), "Noted: " + r.get("label") + ".", false);
        } catch (com.minimalistalliance.desk.agent.service.RpcError e) {
            return new ToolResult(call.id(), "Refused: label.", true);
        }
    }

    private ToolResult show(ToolCall call, RunContext run) throws SQLException {
        Map<String, Object> in = call.input();
        if (!(in.get("deskId") instanceof String deskId) || !Room.deskId(deskId)) {
            return new ToolResult(call.id(), "Refused: desk.", true);
        }
        if (!(in.get("app") instanceof String app) || !MaiaTools.APPS.contains(app)) {
            return new ToolResult(call.id(), "Refused: app.", true);
        }
        String ref = in.get("ref") instanceof String r ? r.strip() : "";
        if (!refOk(ref) || !refFits(app, ref)) {
            return new ToolResult(call.id(), "Refused: ref. Name an id the app knows, never a web address.", true);
        }
        String home = maia.mode().get("homeDeskId") instanceof String h ? h : null;
        if (!deskId.equals(home) && maia.grantFor(deskId, "show") == null) {
            return new ToolResult(call.id(), "Refused: maia_grant. The member hasn't let you show things on that"
                    + " desk.", true);
        }
        boolean asked = askedToSee;
        askedToSee = false;
        boolean open = maia.room().show(deskId, app, ref, asked);
        Map<String, Object> show = new LinkedHashMap<>();
        show.put("deskId", deskId);
        show.put("app", app);
        show.put("ref", ref);
        show.put("open", open);
        if (run.messageId() != null) {
            maia.putShow(run.messageId(), show);
        }
        maia.audit("agent:maia", "maia.show", "desk:" + deskId + " app:" + app, open ? "open" : "button");
        return ok(call, open ? "Shown in the viewport." : "Offered as a Show me button under your reply.");
    }

    /**
     * The shape of an id each app knows (Security's DMA-I1): a page, tab, agent, message or tab id, a Files path, the
     * To-do views, approval ids. Empty is the app's start.
     */
    static boolean refFits(String app, String ref) {
        if (ref.isEmpty()) {
            return true;
        }
        return switch (app) {
            // Ids only: no dot, so no domain or address of any ending (DMA-I1's confirmation).
            case "notebook", "agent", "browser", "courier" -> ref.matches("[A-Za-z0-9_:-]{1,100}");
            case "files" -> !ref.startsWith("/") && !ref.contains("..") && !ref.contains("?") && !ref.contains("#")
                    && ref.matches("[^\\p{Cntrl}]{1,200}");
            case "todo" -> ref.matches("needs_you|all|today|upcoming|done|trash|courier|agents|[0-9a-f-]{36}");
            case "approvals" -> ref.matches("ap-[a-z2-7]{20}(?:,ap-[a-z2-7]{20}){0,19}");
            // A document's id, and a page to open at (deskd API.md §25).
            case "documents" -> ref.matches("d_[0-9A-HJKMNP-TV-Z]{26}(?:#p[1-9][0-9]{0,2})?");
            default -> false;
        };
    }

    /** An id an app knows: no scheme, no address, no line breaks, at most 200 characters. */
    static boolean refOk(String ref) {
        if (ref.length() > 200 || ref.chars().anyMatch(c -> c < 0x20 || c == 0x7f)) {
            return false;
        }
        String l = ref.toLowerCase(Locale.ROOT);
        return !(l.contains("://") || l.startsWith("//") || l.startsWith("javascript:") || l.startsWith("data:")
                || l.startsWith("http") || l.startsWith("www.") || l.contains("\\"));
    }

    // ---------------------------------------------------------------- the guard on her briefs

    @Override
    public String refusal(RunContext run, String tool, Map<String, Object> args) {
        if (!MaiaAgent.is(run.agentId()) || !"desk_message".equals(tool)) {
            return null;
        }
        if (!maia.active()) {
            return "maia_off";
        }
        String deskId = args.get("desk") instanceof String d ? d : null;
        if (deskId == null || maia.grantFor(deskId, "brief") == null) {
            return "maia_grant";
        }
        if (briefsToday() >= maia.briefsPerDay() || maia.capReached()) {
            return "maia_cap";
        }
        // The routing rule (Maia Mode Phase 2): reading or pulling facts out of a write-up that exists is her reader's,
        // not an agent's turn on the member's key. A brief naming one goes only as new work about it.
        if (args.get("text") instanceof String text && !text.startsWith(Reports.READ_HEAD)
                && Reports.WRITEUP_ID.matcher(text).find() && !briefNewWork(args)) {
            return "use_maia_read";
        }
        // Her reader's request starts no agent there: nothing for the member's wallet to weigh.
        if (args.get("text") instanceof String text && text.startsWith(Reports.READ_HEAD)) {
            return null;
        }
        // The member's wallet: an agent's own limits, the day's budget for her briefs, an unusual cost (Wallet).
        return maia.wallet().check(run, deskId, args.get("text"));
    }

    private static boolean briefNewWork(Map<String, Object> args) {
        return (args.get("expect") instanceof Map<?, ?> e && Boolean.TRUE.equals(e.get("newWork")))
                || (args.get("text") instanceof String t && t.contains(Reports.NEW_WORK));
    }

    @Override
    public Risk floor(RunContext run, String tool, Map<String, Object> args) {
        if (!MaiaAgent.is(run.agentId()) || !"desk_message".equals(tool)) {
            return Risk.READ;
        }
        String to = args.get("desk") instanceof String d ? d : null;
        for (String from : origins(run)) {
            if (from.equals(to)) {
                continue;
            }
            MaiaStore.Grant g = grantAny(from);
            if (g == null || g.keepsToItself()) {
                // What a desk that keeps to itself told her doesn't go to another desk without the member's tap. A
                // desk she has no grant for any more is treated the same way.
                return Risk.SEND;
            }
        }
        return Risk.READ;
    }

    @Override
    public List<String> flags(RunContext run) {
        if (!MaiaAgent.is(run.agentId())) {
            return List.of();
        }
        List<String> out = new ArrayList<>();
        for (String desk : origins(run)) {
            out.add("D:" + desk);
        }
        out.sort(null);
        return out;
    }

    @Override
    public void ran(RunContext run, String tool, Map<String, Object> args, boolean ok) {
        if (MaiaAgent.is(run.agentId()) && "docs_handover".equals(tool) && ok) {
            handedOver(run, args);
            return;
        }
        if (!MaiaAgent.is(run.agentId()) || !"desk_message".equals(tool)) {
            return;
        }
        String deskId = args.get("desk") instanceof String d ? d : "unknown";
        if (!ok) {
            maia.wallet().notSent(run, deskId, args.get("text"));
            return;
        }
        try {
            maia.store().take(maia.today(), "brief", "all", Integer.MAX_VALUE);
            maia.store().take(maia.today(), "brief", deskId, Integer.MAX_VALUE);
        } catch (SQLException e) {
            log.warn("a brief wasn't counted: {}", e.getClass().getSimpleName());
        }
        maia.wallet().sent(run, deskId, args.get("text"));
        maia.briefSent(deskId);
    }

    /**
     * The desks whose private answers this run holds: those that came into it, and those in her thread it reads (the
     * newest {@link #ORIGIN_MESSAGES} messages, more than any run's window), so a later run carries them too.
     */
    Set<String> origins(RunContext run) {
        Set<String> out = new HashSet<>(inRun.getOrDefault(run.runId(), Set.of()));
        try {
            List<MessageRow> rows = thread.apply(ORIGIN_MESSAGES);
            // Answers taken in a run's wait, kept on her replies (DMA-L1): as far back as the rows read here.
            long since = rows.isEmpty() ? maia.clock().millis() : rows.get(0).at();
            out.addAll(maia.store().replyOrigins(since));
            for (MessageRow row : rows) {
                if (row.origin() == null) {
                    continue;
                }
                Map<String, Object> origin = MaiaStore.parse(row.origin());
                if ("desk".equals(origin.get("kind")) && "answer".equals(origin.get("role"))
                        && Boolean.TRUE.equals(origin.get("private")) && origin.get("deskId") instanceof String d) {
                    out.add(d);
                }
            }
        } catch (SQLException | RuntimeException e) {
            // Unknown is the strictest: every brief from this run asks.
            out.add("unknown");
        }
        return out;
    }

    /** The most answers one of her calls names to deskd: the newest, as deskd takes them (its {@code MAIA_ANSWERS}). */
    static final int ANSWERS_NAMED = 32;
    /** An envelope's id as deskd makes it. */
    private static final Pattern ENVELOPE_ID = Pattern.compile("env-[a-z2-7]{26}");

    /**
     * Her run's sources for deskd (Maia Mode Phase 2): the answers in her thread (a report that came back after her wait,
     * while the member was away or not), oldest first, by her own rows' origins, so a to-do she files from one names it
     * as {@code desk {}} and deskd, which gives only what it opened for her, marks the item untrusted. Null with none, or
     * for any other agent's run.
     */
    @Override
    public Map<String, Object> origin(RunContext run) {
        if (run == null || !MaiaAgent.is(run.agentId())) {
            return null;
        }
        List<String> answers = new ArrayList<>();
        try {
            for (MessageRow row : thread.apply(ORIGIN_MESSAGES)) {
                if (row.origin() == null) {
                    continue;
                }
                Map<String, Object> origin = MaiaStore.parse(row.origin());
                if ("desk".equals(origin.get("kind")) && "answer".equals(origin.get("role"))
                        && origin.get("envelopeId") instanceof String id && ENVELOPE_ID.matcher(id).matches()
                        && !answers.contains(id)) {
                    answers.add(id);
                }
            }
        } catch (RuntimeException e) {
            return null;
        }
        if (answers.isEmpty()) {
            return null;
        }
        List<String> newest = answers.subList(Math.max(0, answers.size() - ANSWERS_NAMED), answers.size());
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("kind", "maia");
        out.put("answers", List.copyOf(newest));
        return out;
    }

    private MaiaStore.Grant grantAny(String deskId) {
        for (MaiaStore.Grant g : maia.grants()) {
            if (g.deskId().equals(deskId)) {
                return g;
            }
        }
        return null;
    }
}
