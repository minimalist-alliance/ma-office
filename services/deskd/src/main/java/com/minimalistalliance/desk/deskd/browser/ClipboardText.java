package com.minimalistalliance.desk.deskd.browser;

import java.nio.charset.StandardCharsets;

/**
 * What the clipboard's text may be, both ways (API.md section 10, "The clipboard"). Text to the desk is whole
 * characters, measured as the client sent it, and loses its NULs. Text from the desk is whatever a page put there:
 * bytes that aren't UTF-8 become U+FFFD and NULs go. Nothing here keeps or logs any of it.
 */
final class ClipboardText {

    /** Bytes of UTF-8, both ways. */
    static final int MAX_BYTES = 1_000_000;

    private ClipboardText() {}

    /**
     * @param utf8Bytes the text's length in UTF-8, NULs included, or -1 if it has half a surrogate pair
     * @param nulChars how many NULs it holds
     */
    record Measure(long utf8Bytes, int nulChars) {
        boolean wholeCharacters() {
            return utf8Bytes >= 0;
        }

        /** Nothing left once the NULs are gone. */
        boolean emptyWithoutNul() {
            return utf8Bytes == nulChars;
        }
    }

    static Measure measure(String text) {
        long bytes = 0;
        int nul = 0;
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (c < 0x80) {
                bytes++;
                if (c == 0) {
                    nul++;
                }
            } else if (c < 0x800) {
                bytes += 2;
            } else if (Character.isHighSurrogate(c) && i + 1 < text.length() && Character.isLowSurrogate(text.charAt(i + 1))) {
                bytes += 4;
                i++;
            } else if (Character.isSurrogate(c)) {
                return new Measure(-1, nul);
            } else {
                bytes += 3;
            }
        }
        return new Measure(bytes, nul);
    }

    /** The text as UTF-8 without its NULs, for text {@link #measure} found to be whole characters. */
    static byte[] toDesk(String text, Measure measure) {
        byte[] out = new byte[Math.toIntExact(measure.utf8Bytes() - measure.nulChars())];
        int at = 0;
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (c < 0x80) {
                if (c != 0) {
                    out[at++] = (byte) c;
                }
            } else if (c < 0x800) {
                out[at++] = (byte) (0xC0 | c >> 6);
                out[at++] = (byte) (0x80 | c & 0x3F);
            } else if (Character.isHighSurrogate(c)) {
                int point = Character.toCodePoint(c, text.charAt(++i));
                out[at++] = (byte) (0xF0 | point >> 18);
                out[at++] = (byte) (0x80 | point >> 12 & 0x3F);
                out[at++] = (byte) (0x80 | point >> 6 & 0x3F);
                out[at++] = (byte) (0x80 | point & 0x3F);
            } else {
                out[at++] = (byte) (0xE0 | c >> 12);
                out[at++] = (byte) (0x80 | c >> 6 & 0x3F);
                out[at++] = (byte) (0x80 | c & 0x3F);
            }
        }
        return out;
    }

    /**
     * The desk's bytes as a client may have them: U+FFFD for anything that isn't UTF-8, the JDK's way, which takes
     * the longest broken prefix of a sequence as one. NULs removed.
     *
     * @return the text, or null if nothing is left
     */
    static String fromDesk(byte[] raw) {
        String text = new String(raw, StandardCharsets.UTF_8);
        if (text.indexOf('\0') >= 0) {
            text = text.replace("\0", "");
        }
        return text.isEmpty() ? null : text;
    }

    /** UTF-8 length of text with no half surrogate pairs, as {@link #fromDesk} gives. */
    static long utf8Length(String text) {
        return measure(text).utf8Bytes();
    }

    /**
     * What {@code {"text":"..."}} takes as deskd's JSON writes it, so a reply that won't fit a RES is refused before
     * it's built. Quote and backslash take 2 bytes, as do backspace, tab, newline, form feed and carriage return; any
     * other control character takes 6 ({@code \}{@code u00XX}). Everything else is its UTF-8.
     */
    static long replyJsonBytes(String text) {
        long bytes = "{\"text\":\"\"}".length();
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (c == '"' || c == '\\' || c == '\b' || c == '\t' || c == '\n' || c == '\f' || c == '\r') {
                bytes += 2;
            } else if (c < 0x20) {
                bytes += 6;
            } else if (c < 0x80) {
                bytes++;
            } else if (c < 0x800) {
                bytes += 2;
            } else if (Character.isHighSurrogate(c) && i + 1 < text.length() && Character.isLowSurrogate(text.charAt(i + 1))) {
                bytes += 4;
                i++;
            } else {
                bytes += 3;
            }
        }
        return bytes;
    }
}
