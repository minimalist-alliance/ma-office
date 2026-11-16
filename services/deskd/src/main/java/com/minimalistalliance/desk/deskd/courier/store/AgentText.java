package com.minimalistalliance.desk.deskd.courier.store;

import java.net.IDN;
import java.net.URI;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * A message's text as an agent gets it (agent tools draft §12): plain text, each link as {@code [link: example.com]} (its
 * domain only, in ASCII, so a lookalike shows as punycode), and quoted earlier messages folded to one line
 * ({@code Earlier messages: 3}). The text is already plain: the sandbox turned any HTML into it.
 */
public final class AgentText {

    private AgentText() {}

    private static final Pattern LINK = Pattern.compile("(?i)\\b(?:(?:https?|ftp)://|www\\.)[^\\s<>\"'()\\[\\]{}]+");
    private static final Pattern ATTRIBUTION = Pattern.compile(
            "(?i)^\\s*(?:on .{1,200}(?:wrote|writes)|am .{1,200}schrieb|le .{1,200}a écrit|el .{1,200}escribió|il .{1,200}ha scritto)\\s*:?\\s*$");
    private static final Pattern ORIGINAL = Pattern.compile(
            "(?i)^\\s*(?:-{2,}\\s*(?:original message|ursprüngliche nachricht|message d'origine|mensaje original)\\s*-{2,}|_{10,})\\s*$");

    public static String shape(String text) {
        if (text == null || text.isEmpty()) {
            return "";
        }
        String[] lines = text.split("\n", -1);
        StringBuilder out = new StringBuilder(Math.min(text.length(), 1 << 20));
        int i = 0;
        while (i < lines.length) {
            String line = lines[i];
            if (ORIGINAL.matcher(line).matches()) {
                // Outlook's reply: everything after the marker is earlier mail.
                int depth = 1;
                for (int j = i + 1; j < lines.length; j++) {
                    if (ORIGINAL.matcher(lines[j]).matches()) {
                        depth++;
                    }
                }
                append(out, "Earlier messages: " + depth);
                break;
            }
            if (isQuoted(line) || (ATTRIBUTION.matcher(line).matches() && i + 1 < lines.length && nextQuoted(lines, i + 1))) {
                int depth = 0;
                int j = i;
                if (!isQuoted(lines[j])) {
                    j++;
                }
                while (j < lines.length && (isQuoted(lines[j]) || lines[j].isBlank() && j + 1 < lines.length && isQuoted(lines[j + 1]))) {
                    depth = Math.max(depth, quoteDepth(lines[j]));
                    j++;
                }
                append(out, "Earlier messages: " + Math.max(1, depth));
                i = j;
                continue;
            }
            append(out, links(line));
            i++;
        }
        return out.toString();
    }

    private static boolean nextQuoted(String[] lines, int from) {
        for (int j = from; j < lines.length && j < from + 2; j++) {
            if (isQuoted(lines[j])) {
                return true;
            }
            if (!lines[j].isBlank()) {
                return false;
            }
        }
        return false;
    }

    private static void append(StringBuilder out, String line) {
        if (!out.isEmpty()) {
            out.append('\n');
        }
        out.append(line);
    }

    private static boolean isQuoted(String line) {
        return line.stripLeading().startsWith(">");
    }

    private static int quoteDepth(String line) {
        int depth = 0;
        for (int k = 0; k < line.length(); k++) {
            char c = line.charAt(k);
            if (c == '>') {
                depth++;
            } else if (c != ' ' && c != '\t') {
                break;
            }
        }
        return depth;
    }

    /** Each link in a line as its domain. */
    static String links(String line) {
        Matcher m = LINK.matcher(line);
        if (!m.find()) {
            return line;
        }
        StringBuilder out = new StringBuilder();
        int last = 0;
        do {
            String url = m.group();
            int end = m.end();
            // A sentence's own punctuation after a link isn't part of it.
            while (!url.isEmpty() && ".,;:!?".indexOf(url.charAt(url.length() - 1)) >= 0) {
                url = url.substring(0, url.length() - 1);
                end--;
            }
            out.append(line, last, m.start());
            out.append("[link: ").append(domain(url)).append(']');
            last = end;
        } while (m.find());
        out.append(line.substring(last));
        return out.toString();
    }

    static String domain(String url) {
        String u = url.toLowerCase(Locale.ROOT).startsWith("www.") ? "http://" + url : url;
        String host = null;
        try {
            host = URI.create(u.replace(" ", "%20")).getHost();
        } catch (IllegalArgumentException e) {
            // by hand below
        }
        if (host == null) {
            String rest = u.substring(u.indexOf("://") + 3);
            int end = 0;
            while (end < rest.length() && "/?#:@".indexOf(rest.charAt(end)) < 0) {
                end++;
            }
            host = rest.substring(0, end);
        }
        host = host.toLowerCase(Locale.ROOT);
        try {
            host = IDN.toASCII(host, IDN.ALLOW_UNASSIGNED);
        } catch (IllegalArgumentException e) {
            // kept as it is
        }
        if (host.startsWith("www.")) {
            host = host.substring(4);
        }
        return host.isEmpty() ? "unknown" : host;
    }
}
