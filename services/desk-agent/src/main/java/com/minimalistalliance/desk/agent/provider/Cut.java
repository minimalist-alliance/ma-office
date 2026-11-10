package com.minimalistalliance.desk.agent.provider;

/** Cuts text to a length without splitting a surrogate pair, which would leave a lone half in the next request. */
public final class Cut {

    private Cut() {}

    /** At most {@code max} chars of {@code text}: one fewer when the cut would fall inside a pair. */
    public static String chars(String text, int max) {
        if (text.length() <= max) {
            return text;
        }
        int end = max;
        if (end > 0 && Character.isHighSurrogate(text.charAt(end - 1))) {
            end--;
        }
        return text.substring(0, end);
    }
}
