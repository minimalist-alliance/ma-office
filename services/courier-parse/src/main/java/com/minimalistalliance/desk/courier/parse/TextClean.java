package com.minimalistalliance.desk.courier.parse;

/**
 * Text with nothing hidden in it, as deskd's {@code Norm.clean} keeps it (Security CS-L2): no C0 or C1 controls but the
 * newline and tab, no format characters (bidi controls, zero-width characters, the tag characters, the byte order mark),
 * no line or paragraph separators, no Hangul fillers and no lone surrogates. The zero-width joiner and non-joiner stay in
 * running text, which Persian, the Indic scripts and emoji need. deskd cleans again; this keeps the sandbox's own output
 * honest (an agent's model and the member's eye see the same text).
 */
final class TextClean {

    private TextClean() {}

    static String clean(String s, boolean multiline) {
        if (s == null) {
            return null;
        }
        StringBuilder out = null;
        int n = s.length();
        for (int i = 0; i < n; ) {
            int c = s.codePointAt(i);
            int len = Character.charCount(c);
            boolean drop = hidden(c, multiline) || len == 1 && Character.isSurrogate((char) c);
            if (drop && out == null) {
                out = new StringBuilder(n);
                out.append(s, 0, i);
            }
            if (!drop && out != null) {
                out.appendCodePoint(c);
            }
            i += len;
        }
        return out == null ? s : out.toString();
    }

    static boolean hidden(int c, boolean multiline) {
        if (c == '\n' || c == '\t') {
            return !multiline && c == '\n';
        }
        if (c == '\r') {
            return true;
        }
        if (c < 0x20 || c == 0x7F || c >= 0x80 && c < 0xA0) {
            return true;
        }
        if (c == 0x200C || c == 0x200D) {
            return !multiline;
        }
        if (c == 0x115F || c == 0x1160 || c == 0x3164 || c == 0xFFA0) {
            return true;
        }
        int type = Character.getType(c);
        return type == Character.FORMAT || type == Character.LINE_SEPARATOR || type == Character.PARAGRAPH_SEPARATOR;
    }
}
