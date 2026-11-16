package com.minimalistalliance.desk.deskd.docs;

import java.text.Normalizer;
import java.time.ZoneId;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * A document's clean title, code's template {@code {date} · {who} · {what}} (deskd {@code API.md} §25): at most 60
 * characters, plain text, computed from the record every time (never appended to, so a rename applied twice gives the
 * same name). The original file name stays one tap away.
 */
final class Titles {

    static final int MAX = 60;
    private static final Pattern HIDDEN = Pattern.compile("[\\p{Cc}\\p{Cf}\\p{Co}\\p{Cn}\\u2028\\u2029]");
    private static final Pattern NOISE = Pattern.compile(
            "(?i)(?:[ _.-]*(?:\\(\\d{1,3}\\)|(?:copy(?: of)?|final|v\\d{1,3}|rev\\d{1,3}|draft|new|edited|scan(?:ned)?)\\b))+$");
    private static final Pattern LEADING_COPY = Pattern.compile("(?i)^copy of\\s+");
    private static final Pattern SEPARATORS = Pattern.compile("[_]+|\\s{2,}|(?<=\\w)[.-](?=\\w{2,})");

    private Titles() {}

    /** The title: the day, who it came from, what it is. */
    static String title(long arrivedAt, ZoneId zone, String who, String what) {
        String day = Words.day(arrivedAt, zone);
        String w = clean(who == null || who.isBlank() ? "You" : who, 24);
        String head = day + " · " + w + " · ";
        String rest = clean(what == null || what.isBlank() ? "Document" : what, MAX - head.length());
        return head + rest;
    }

    /** The file name's stem made readable: hidden and look-alike characters out, the extension and copy noise trimmed. */
    static String stem(String name) {
        if (name == null) {
            return "Document";
        }
        String s = Normalizer.normalize(name, Normalizer.Form.NFKC);
        s = HIDDEN.matcher(s).replaceAll("");
        int slash = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
        if (slash >= 0) {
            s = s.substring(slash + 1);
        }
        int dot = s.lastIndexOf('.');
        if (dot >= 0 && s.length() - dot <= 6) {
            s = s.substring(0, dot);
        }
        s = LEADING_COPY.matcher(s).replaceAll("");
        for (int i = 0; i < 3; i++) {
            String t = NOISE.matcher(s).replaceAll("").strip();
            if (t.equals(s) || t.isEmpty()) {
                break;
            }
            s = t;
        }
        s = SEPARATORS.matcher(s).replaceAll(" ").strip();
        if (s.isEmpty()) {
            return "Document";
        }
        // Lower-case words get a capital first letter; anything with its own capitals stays as it was.
        if (s.equals(s.toLowerCase(Locale.ROOT))) {
            s = Character.toUpperCase(s.charAt(0)) + s.substring(1);
        }
        return s;
    }

    /** Plain, one line, at most {@code max} characters (cut on a word with an ellipsis). */
    static String clean(String text, int max) {
        String s = HIDDEN.matcher(Normalizer.normalize(text, Normalizer.Form.NFKC)).replaceAll("").replaceAll("\\s+", " ").strip();
        if (max < 2) {
            return "";
        }
        if (s.length() <= max) {
            return s;
        }
        int cut = s.lastIndexOf(' ', max - 1);
        return (cut > max / 2 ? s.substring(0, cut) : s.substring(0, max - 1)) + "…";
    }

    /** A file name for "Rename it to match?": the title with characters no file system takes replaced. */
    static String fileName(String title, String origName) {
        String ext = "";
        int dot = origName == null ? -1 : origName.lastIndexOf('.');
        if (dot > 0 && origName.length() - dot <= 6) {
            ext = origName.substring(dot);
        }
        String base = title.replace(" · ", " - ").replaceAll("[/\\\\:*?\"<>|\\p{Cc}]", " ").replaceAll("\\s+", " ").strip();
        return base + ext;
    }

    /** The domain of an address, lower case, or null. */
    static String domain(String address) {
        if (address == null) {
            return null;
        }
        int at = address.lastIndexOf('@');
        return at > 0 && at < address.length() - 1 ? address.substring(at + 1).toLowerCase(Locale.ROOT) : null;
    }
}
