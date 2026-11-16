package com.minimalistalliance.desk.courier.parse;

/**
 * {@code format=flowed} text (RFC 3676) unwrapped: a line ending in a space continues on the next, unless it's the
 * signature separator; with {@code delsp=yes} that space goes too. Space-stuffing is undone and quote depth is kept.
 */
final class Flowed {

    private Flowed() {}

    static String unwrap(String text, boolean delsp) {
        String[] lines = text.split("\r\n|\n|\r", -1);
        StringBuilder out = new StringBuilder(text.length());
        StringBuilder paragraph = null;
        int paragraphDepth = 0;
        for (String raw : lines) {
            int depth = 0;
            while (depth < raw.length() && raw.charAt(depth) == '>') {
                depth++;
            }
            String line = raw.substring(depth);
            if (line.startsWith(" ")) {
                line = line.substring(1);
            }
            boolean signature = line.equals("-- ");
            boolean soft = !signature && line.endsWith(" ");
            if (paragraph != null && depth != paragraphDepth) {
                emit(out, paragraph, paragraphDepth);
                paragraph = null;
            }
            if (paragraph == null) {
                paragraph = new StringBuilder();
                paragraphDepth = depth;
            }
            paragraph.append(soft && delsp ? line.substring(0, line.length() - 1) : line);
            if (!soft) {
                emit(out, paragraph, paragraphDepth);
                paragraph = null;
            }
        }
        if (paragraph != null) {
            emit(out, paragraph, paragraphDepth);
        }
        if (out.length() > 0) {
            out.setLength(out.length() - 1);
        }
        return out.toString();
    }

    private static void emit(StringBuilder out, CharSequence paragraph, int depth) {
        out.append(">".repeat(depth));
        if (depth > 0 && paragraph.length() > 0) {
            out.append(' ');
        }
        out.append(paragraph).append('\n');
    }
}
