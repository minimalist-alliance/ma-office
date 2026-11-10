package com.minimalistalliance.desk.deskd.browser;

/**
 * Gathers one JSON message from pieces, keeping memory bounded whatever arrives. Web content decides
 * how long a title or a URL is, and a URL can legally reach 2 MB, so a string past its limit loses the
 * rest of its characters here, before any parsing, and what comes out is still valid JSON. Past the
 * limit on the whole, the message is dropped.
 *
 * <p>This looks at no more of the JSON than where strings start and end.
 */
final class BoundedJsonText {

    private final int maxStringChars;
    private final int maxChars;
    private final StringBuilder text = new StringBuilder(256);
    private boolean inString;
    private boolean escaping;
    private int hexLeft;
    private int stringChars;
    private boolean keeping;
    private boolean cut;
    private boolean overflowed;

    BoundedJsonText(int maxStringChars, int maxChars) {
        this.maxStringChars = maxStringChars;
        this.maxChars = maxChars;
    }

    void append(CharSequence piece) {
        int length = piece.length();
        for (int i = 0; i < length && !overflowed; i++) {
            append(piece.charAt(i));
        }
    }

    void append(char c) {
        if (overflowed) {
            return;
        }
        if (text.length() >= maxChars) {
            overflowed = true;
            text.setLength(0);
            text.trimToSize();
            return;
        }
        if (!inString) {
            text.append(c);
            if (c == '"') {
                inString = true;
                stringChars = 0;
            }
            return;
        }
        // An escape stays whole: it's kept or dropped as one, so a string can't end halfway through one.
        if (escaping) {
            escaping = false;
            hexLeft = c == 'u' ? 4 : 0;
            appendIfKeeping(c);
            return;
        }
        if (hexLeft > 0) {
            hexLeft--;
            appendIfKeeping(c);
            return;
        }
        if (c == '"') {
            inString = false;
            text.append(c);
            return;
        }
        keeping = stringChars < maxStringChars;
        cut |= !keeping;
        stringChars++;
        escaping = c == '\\';
        appendIfKeeping(c);
    }

    private void appendIfKeeping(char c) {
        if (keeping) {
            text.append(c);
        }
    }

    boolean overflowed() {
        return overflowed;
    }

    /** Whether any string lost characters at its limit. */
    boolean cut() {
        return cut;
    }

    String text() {
        return text.toString();
    }
}
