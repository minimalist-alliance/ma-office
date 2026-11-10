package com.minimalistalliance.desk.deskd.browser;

/**
 * Makes text from web content safe to pass on: bounded, with no control characters, and no bidi controls
 * that could make a title or URL read as something else. A lone surrogate, which a page can put in a
 * title and which JSON can't carry, becomes U+FFFD.
 */
final class TabText {

    private TabText() {}

    static String clean(String raw, int maxChars) {
        if (raw == null) {
            return "";
        }
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
            } else if (!Character.isISOControl(c) && !isBidiControl(c) && c != ' ' && c != ' ') {
                out.append(c);
            }
        }
        return out.toString();
    }

    /** Text the member typed, for Input.insertText: only what JSON can't carry changes. */
    static String insertable(String raw) {
        StringBuilder out = null;
        for (int i = 0; i < raw.length(); i++) {
            char c = raw.charAt(i);
            if (Character.isHighSurrogate(c) && i + 1 < raw.length() && Character.isLowSurrogate(raw.charAt(i + 1))) {
                i++;
            } else if (Character.isSurrogate(c)) {
                if (out == null) {
                    out = new StringBuilder(raw);
                }
                out.setCharAt(i, '�');
            }
        }
        return out == null ? raw : out.toString();
    }

    private static boolean isBidiControl(char c) {
        return c == '\u061c' || c == '‎' || c == '‏' || (c >= '‪' && c <= '‮') || (c >= '⁦' && c <= '⁩');
    }
}
