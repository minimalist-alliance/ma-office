package com.minimalistalliance.desk.agent.tool;

import com.minimalistalliance.desk.agent.provider.ToolResult;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * What a restart, or a lost link to deskd, does to a call of a tool that had started and not come back (draft ADR "the
 * Agent's tools and approvals", §3, "Restarts"; durable runs, Design 1's seam). Every {@link ToolDecl} says one.
 * Nothing that may have changed something is ever run a second time without its key proving it didn't happen.
 */
public enum Restart {
    /**
     * deskd runs it under the call's key and keeps the result 10 minutes. After a lost link desk-agent asks again with
     * the same key and gets the real result; if deskd no longer holds it (deskd restarted, or 10 minutes passed), the
     * call ends {@code interrupted} and isn't run again. A desk-agent restart ends it {@code interrupted} too until
     * runs resume.
     */
    RETRY_BY_KEY,
    /** Runs in desk-agent, with no key to confirm it: left running at a kill, it ends {@code interrupted}, never re-run. */
    INTERRUPT,
    /** Changes nothing a second run would change again (a read, the plan): it ends {@code failed} and may simply be asked again. */
    SAFE;

    /** The wire and record name: {@code retry_by_key}, {@code interrupt}, {@code safe}. */
    public String wireName() {
        return name().toLowerCase(Locale.ROOT);
    }

    /** What a declaration that names none gets: never {@link #SAFE}, which a declaration must say itself. */
    public static Restart defaultFor(ToolDecl.Host host) {
        return host == ToolDecl.Host.DESKD ? RETRY_BY_KEY : INTERRUPT;
    }

    /**
     * The rule for one call: the declaration's, except that a call whose class rose to one that asks (a click that
     * submits a form) is never {@link #SAFE}.
     */
    public Restart forCall(Risk risk, ToolDecl.Host host) {
        return this == SAFE && risk != null && risk.alwaysAsks() ? defaultFor(host) : this;
    }

    /** What an interrupted call's result starts with: the model reads it, and the approval and the record end so. */
    public static final String INTERRUPTED = "Interrupted: ";

    /** Whether a tool's result says it may or may not have happened ({@link #INTERRUPTED}). */
    public static boolean interrupted(ToolResult result) {
        return result != null && result.error() && result.content() != null
                && result.content().startsWith(INTERRUPTED);
    }

    private static final Pattern WORD = Pattern.compile("(?:Refused|Failed|Interrupted): ([a-z][a-z0-9_]{0,31})\\.");

    /** The one word a failed tool's text starts with ("Refused: changed.", "Interrupted: lost."), or {@code failed}. */
    public static String word(ToolResult result) {
        Matcher m = WORD.matcher(result.content() == null ? "" : result.content());
        return m.lookingAt() ? m.group(1) : "failed";
    }
}
