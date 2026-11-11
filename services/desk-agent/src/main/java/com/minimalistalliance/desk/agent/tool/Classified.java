package com.minimalistalliance.desk.agent.tool;

import com.minimalistalliance.desk.agent.provider.ToolCall;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * One call as {@link ToolPolicy} classified it (draft ADR, sections 1 and 3).
 *
 * @param call the model's call
 * @param decl its declaration
 * @param risk this call's class: the declaration's or higher
 * @param context {@code agent} (the agent's own Browser context, or no Browser) or {@code member:<site>}
 * @param target what it acts on, as {@code API.md} section 18's {@code target}: {@code {kind: "file", path}}, …; empty
 *     for none
 * @param payload the exact arguments the tool will run with, which an approval hashes and the card shows
 * @param before what the change replaces, read now, not hashed; null for nothing
 * @param refusal a reason the policy refuses this call before asking ({@code sensitive}, …), so no card is made and
 *     the gate answers {@code Refused(refusal)}; null for none. The tool's own refusal at run time stays as a backstop
 */
public record Classified(ToolCall call, ToolDecl decl, Risk risk, String context, Map<String, Object> target,
        Map<String, Object> payload, Map<String, Object> before, String refusal) {

    /** A call the policy doesn't refuse. */
    public Classified(ToolCall call, ToolDecl decl, Risk risk, String context, Map<String, Object> target,
            Map<String, Object> payload, Map<String, Object> before) {
        this(call, decl, risk, context, target, payload, before, null);
    }

    /** The same call at {@code floor} or its own class, whichever is higher. */
    public Classified atLeast(Risk floor) {
        return new Classified(call, decl, risk.atLeast(floor), context, target, payload, before, refusal);
    }

    /** The member's signed-in session for one site: never asked for from a run the member didn't start (Security, S-14). */
    static final String SESSION_GRANT = "browser_use_my_session";

    /** {@link #backstopped(boolean, boolean, boolean)} with the run's own flags and origin. */
    public Classified backstopped(RunContext run) {
        return backstopped(run.untrusted(), run.privateData(), run.unattended());
    }

    /**
     * The run loop's backstop over any policy (draft ADR, sections 5 and 6, Security's rule on the protocol). Browse
     * actions only ({@link ToolRegistry#BROWSE_ACTIONS}: {@code browser_open}, {@code _click}, {@code _type},
     * {@code _press}, {@code _back}): in a run holding both {@code U} and {@code S} each is {@code egress}; in the
     * member's signed-in session each is at least {@code write}, and a navigation there ({@code browser_open},
     * {@code browser_back}) {@code egress}, whatever the taint. {@code browser_read}, {@code _tabs} and {@code _close}
     * stay what they are, reads that never ask; reading a session tab still sets {@code S}, from its declared result. A
     * {@code spend} stays {@code spend}, which asks one at a time and never unattended. And the session grant
     * ({@code browser_use_my_session}) is refused {@code origin} in a run a timer or another agent started (Security's
     * S-14 rule): only a run the member started may ask for it, as {@code egress}.
     *
     * @param unattended the run wasn't started by the member: a timer's, or another agent's message's
     */
    public Classified backstopped(boolean untrusted, boolean privateData, boolean unattended) {
        if (SESSION_GRANT.equals(decl.name()) && unattended) {
            return refusal != null ? this : refused("origin");
        }
        if (!ToolRegistry.BROWSE_ACTIONS.contains(decl.name()) || risk == Risk.SPEND) {
            return this;
        }
        boolean member = context.startsWith("member:");
        boolean navigation = "browser_open".equals(decl.name()) || "browser_back".equals(decl.name());
        if ((untrusted && privateData) || (member && navigation)) {
            return atLeast(Risk.EGRESS);
        }
        return member ? atLeast(Risk.WRITE) : this;
    }

    /** The same call, refused before asking with {@code reason}. */
    public Classified refused(String reason) {
        return new Classified(call, decl, risk, context, target, payload, before, Objects.requireNonNull(reason));
    }

    private static final Pattern HOLE = Pattern.compile("\\{([A-Za-z0-9_]+)}");
    private static final int TITLE_PART = 120;

    public Classified {
        Objects.requireNonNull(call, "call");
        Objects.requireNonNull(decl, "decl");
        Objects.requireNonNull(risk, "risk");
        risk = risk.atLeast(decl.risk());
        context = context == null ? "agent" : context;
        target = target == null ? Map.of() : Collections.unmodifiableMap(new LinkedHashMap<>(target));
        payload = payload == null ? Map.of() : Collections.unmodifiableMap(new LinkedHashMap<>(payload));
        before = before == null ? null : Collections.unmodifiableMap(new LinkedHashMap<>(before));
    }

    /**
     * The card's title: the declaration's {@code words}, each {@code {name}} filled from {@code target}, else from
     * {@code payload}, as plain text in curly quotes, cut, with hidden and bidi characters removed. Never the model's
     * prose; only the values it passed, quoted.
     */
    public String title() {
        Matcher m = HOLE.matcher(decl.words());
        StringBuilder out = new StringBuilder();
        while (m.find()) {
            Object value = target.containsKey(m.group(1)) ? target.get(m.group(1)) : payload.get(m.group(1));
            String text = value == null ? "" : "“" + plain(String.valueOf(value)) + "”";
            m.appendReplacement(out, Matcher.quoteReplacement(text));
        }
        m.appendTail(out);
        return out.toString();
    }

    /** Hidden, control and bidi characters out; cut to {@value #TITLE_PART} characters. */
    static String plain(String text) {
        StringBuilder out = new StringBuilder();
        text.codePoints().forEach(cp -> {
            int type = Character.getType(cp);
            if (type == Character.CONTROL || type == Character.FORMAT || type == Character.UNASSIGNED
                    || type == Character.PRIVATE_USE || type == Character.SURROGATE
                    || type == Character.LINE_SEPARATOR || type == Character.PARAGRAPH_SEPARATOR) {
                return;
            }
            out.appendCodePoint(cp);
        });
        String s = out.toString().strip();
        if (s.codePointCount(0, s.length()) > TITLE_PART) {
            s = s.substring(0, s.offsetByCodePoints(0, TITLE_PART)) + "…";
        }
        return s;
    }

    /** No content in logs. */
    @Override
    public String toString() {
        return "Classified[" + decl.name() + ", " + risk.wireName() + ", " + context
                + (refusal == null ? "" : ", refused " + refusal) + "]";
    }
}
