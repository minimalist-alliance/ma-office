package com.minimalistalliance.desk.deskd.browser.minified;

import java.util.List;
import java.util.regex.Pattern;

/**
 * What a wall drawn by another site's frame is, from its words and its buttons' names: the prototype kit's
 * {@code classify_wall} (server.py, the same rules as the distiller's wallScan), so deskd and the prototype agree.
 */
final class WallText {

    /** A clearly offered necessary-only choice: a cookie banner. */
    private static final Pattern REJECT = Pattern.compile("^\\s*(reject( all)?( cookies)?|reject (all )?(non-?essential|optional|additional)( cookies)?|"
            + "decline( all)?( cookies)?|refuse( all)?|deny( all)?|i do not accept|do not accept|disagree|necessary (cookies )?only|"
            + "only (necessary|essential|required)( cookies)?|(use|allow|accept) (only )?(necessary|essential|required|"
            + "strictly necessary)( cookies)?( only)?|continue without (accepting|agreeing|consent)|reject and close)\\s*[.!]?\\s*$",
            Pattern.CASE_INSENSITIVE);
    private static final Pattern AGREE = Pattern.compile("^\\s*((i )?(agree|accept)( all)?( cookies)?( (and|&) (continue|close|proceed))?|ok(ay)?|got it|"
            + "i understand|continue|yes,? i agree)\\s*[.!]?\\s*$", Pattern.CASE_INSENSITIVE);
    private static final Pattern DISMISS = Pattern.compile("^\\s*(close( (dialog|modal|this|window|pop-?up|banner|message))?|dismiss.{0,30}|×|✕|✖|x|"
            + "no,? thanks.{0,30}|not now|maybe later|skip.{0,20}|continue (reading|to (the )?(site|article|story))( for free)?)\\s*$",
            Pattern.CASE_INSENSITIVE);
    private static final Pattern MANAGE = Pattern.compile("\\b(manage|settings|preferences|options|customi[sz]e|choices|more options|configure|purposes|vendors)\\b",
            Pattern.CASE_INSENSITIVE);
    private static final Pattern TERMS_WORDS = Pattern.compile("\\b(terms|agree|consent|cookies?|privacy)\\b", Pattern.CASE_INSENSITIVE);

    private WallText() {}

    /** @return {@code consent}, {@code terms} (only an agree-type way out), {@code nag} or {@code other} */
    static String classify(String text, List<String> buttons) {
        if (buttons.stream().anyMatch(b -> REJECT.matcher(b).matches())) {
            return "consent";
        }
        if (TERMS_WORDS.matcher(text).find() && buttons.stream().anyMatch(b -> AGREE.matcher(b).matches())
                && buttons.stream().noneMatch(b -> DISMISS.matcher(b).matches() || MANAGE.matcher(b).find())) {
            return "terms";
        }
        if (buttons.stream().anyMatch(b -> DISMISS.matcher(b).matches())) {
            return "nag";
        }
        return "other";
    }
}
