package com.minimalistalliance.desk.deskd.browser.minified;

/**
 * Text from a page made safe to pass on, as the Browser's TabText makes titles (Security T47-6, point 3): bounded, with
 * no control characters and no bidi controls that could make text read as something else, and a lone surrogate, which
 * JSON can't carry, as U+FFFD. Code and field values keep their newlines and tabs.
 */
final class Text {

    private Text() {}

    /** A string, or "" for anything else. */
    static String clean(Object raw, int maxChars) {
        return raw instanceof String s ? clean(s, maxChars, false) : "";
    }

    /** As {@link #clean(Object, int)}, keeping newlines and tabs. */
    static String keepLines(Object raw, int maxChars) {
        return raw instanceof String s ? clean(s, maxChars, true) : "";
    }

    private static String clean(String raw, int maxChars, boolean lines) {
        StringBuilder out = new StringBuilder(Math.min(raw.length(), maxChars));
        for (int i = 0; i < raw.length() && out.length() < maxChars; i++) {
            char c = raw.charAt(i);
            if (Character.isHighSurrogate(c) && i + 1 < raw.length() && Character.isLowSurrogate(raw.charAt(i + 1))) {
                if (out.length() + 2 > maxChars) {
                    break;
                }
                out.append(c).append(raw.charAt(++i));
            } else if (Character.isSurrogate(c)) {
                out.append('�');
            } else if (lines && (c == '\n' || c == '\t')) {
                out.append(c);
            } else if (c == '\r' && lines) {
                // A CRLF is one newline, and a lone CR becomes one.
                if (i + 1 >= raw.length() || raw.charAt(i + 1) != '\n') {
                    out.append('\n');
                }
            } else if (!Character.isISOControl(c) && !isBidiControl(c) && c != ' ' && c != ' ') {
                out.append(c);
            }
        }
        return out.toString();
    }

    /** What the member typed, for Input.insertText: only what JSON can't carry changes. */
    static String insertable(String raw) {
        StringBuilder out = new StringBuilder(raw.length());
        for (int i = 0; i < raw.length(); i++) {
            char c = raw.charAt(i);
            if (Character.isHighSurrogate(c) && i + 1 < raw.length() && Character.isLowSurrogate(raw.charAt(i + 1))) {
                out.append(c).append(raw.charAt(++i));
            } else {
                out.append(Character.isSurrogate(c) ? '\ufffd' : c);
            }
        }
        return out.toString();
    }

    private static boolean isBidiControl(char c) {
        return c == '؜' || c == '‎' || c == '‏' || (c >= '‪' && c <= '‮') || (c >= '⁦' && c <= '⁩');
    }
}
