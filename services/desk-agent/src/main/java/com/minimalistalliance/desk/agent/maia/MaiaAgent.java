package com.minimalistalliance.desk.agent.maia;

import com.minimalistalliance.desk.agent.team.TextChecks;
import java.text.Normalizer;

/**
 * Desk Maia's fixed identity on the member's home desk (Maia Mode, deskd {@code API.md} §23): the agent id
 * {@code maia}, which matches her product name, and the one place that says whether an id is hers.
 *
 * <p>She is an agent row in {@code agent.db} with role {@code staff} and this id, made when the member turns Maia Mode
 * on, so her thread, her limits, her approvals and her audit are every agent's. Her binding is the desk's own, never a
 * member's key: Minimalist Alliance's AI service ({@code KeyRing.COMPANY}, provider {@code ma}, task {@code turn}), which
 * no one can change (the owner, Nov 14: "Maia ALWAYS runs on the company account"). She isn't a team
 * agent: the team's lists, the lead's tools and {@code message_agent} never see her ({@code AgentService},
 * {@code Team}).
 */
public final class MaiaAgent {

    /** Her agent id: the product's name, as the owner's rule asks ("internal ids match product names"). */
    public static final String ID = "maia";
    /** Her name in her thread and in her cards. */
    public static final String NAME = "Maia";

    private MaiaAgent() {}

    /** @return whether this agent id is Desk Maia's */
    public static boolean is(String agentId) {
        return ID.equals(agentId);
    }

    /**
     * Another desk's text as the room shows it and her tools give it (an agent's name, a desk's name, a to-do's title):
     * one line, NFC, with control, format (bidi, zero-width) and other hidden characters removed, cut to {@code max}
     * code points. Plain text: never a link or Markdown, which the room never renders anyway.
     */
    public static String plain(Object raw, int max) {
        if (!(raw instanceof String s)) {
            return "";
        }
        String text = Normalizer.normalize(s, Normalizer.Form.NFC);
        StringBuilder out = new StringBuilder();
        int kept = 0;
        for (int i = 0; i < text.length() && kept < max; ) {
            int cp = text.codePointAt(i);
            i += Character.charCount(cp);
            if (Character.isWhitespace(cp) || Character.isSpaceChar(cp)) {
                if (out.length() > 0 && out.charAt(out.length() - 1) != ' ') {
                    out.append(' ');
                    kept++;
                }
                continue;
            }
            int type = Character.getType(cp);
            if (Character.isISOControl(cp) || type == Character.FORMAT || type == Character.PRIVATE_USE
                    || type == Character.UNASSIGNED || type == Character.SURROGATE
                    || TextChecks.hidden(new String(Character.toChars(cp)))) {
                continue;
            }
            out.appendCodePoint(cp);
            kept++;
        }
        return out.toString().strip();
    }
}
