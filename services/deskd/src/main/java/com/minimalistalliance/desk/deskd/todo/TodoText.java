package com.minimalistalliance.desk.deskd.todo;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.text.Normalizer;
import java.util.HexFormat;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Set;

/**
 * To-do's text rules (API.md §22, "An item"): what a title, a note, a reason and a source's label may hold, and the
 * normalised title the dedupe compares. Everything an agent or a page wrote is attacker text: control, format (bidi,
 * zero-width, tag), private-use, unassigned and surrogate characters go, as the draft ADR's card rule 5 has it, so a title
 * can't reorder itself on screen or hide words. Nothing is ever rendered as Markdown or a link.
 */
public final class TodoText {

    public static final int TITLE_MAX = 200;
    public static final int NOTE_MAX = 2_000;
    public static final int REASON_MAX = 140;
    public static final int LABEL_MAX = 80;

    /**
     * Words the normalised title leaves out: articles, linking words and the words that only say "this is a to-do"
     * ({@code please}, {@code reminder}, {@code follow up}), so a reminder's title reads as the task it repeats.
     */
    static final Set<String> STOP = Set.of("a", "an", "the", "and", "or", "to", "of", "for", "in", "on", "at", "by",
            "with", "from", "your", "you", "my", "me", "our", "we", "us", "is", "are", "be", "am", "please", "pls",
            "reminder", "remember", "dont", "don", "forget", "follow", "up", "followup", "just", "quick", "note", "asap",
            "re", "fw", "fwd", "it", "its", "that", "this", "these", "those", "still", "need", "needs", "make", "sure");

    private TodoText() {}

    /** A title: one line, cleaned, 1 to {@value #TITLE_MAX} characters; null if nothing is left or it's longer. */
    public static String title(String raw) {
        if (raw == null) {
            return null;
        }
        String s = clean(raw, false).strip();
        int length = s.codePointCount(0, s.length());
        return length == 0 || length > TITLE_MAX ? null : s;
    }

    /** A note: lines kept, cleaned, at most {@value #NOTE_MAX}; empty is null. Throws for one that's too long. */
    public static String note(String raw) {
        if (raw == null) {
            return null;
        }
        String s = clean(raw, true).strip();
        if (s.codePointCount(0, s.length()) > NOTE_MAX) {
            throw new IllegalArgumentException("note");
        }
        return s.isEmpty() ? null : s;
    }

    /** A suggestion's reason: one line, cleaned, cut to {@value #REASON_MAX}. */
    public static String reason(String raw) {
        return cut(raw == null ? "" : clean(raw, false).strip(), REASON_MAX);
    }

    /** A source's label: one line, cleaned, cut to {@value #LABEL_MAX} with an ellipsis. */
    public static String label(String raw) {
        return cut(raw == null ? "" : clean(raw, false).strip(), LABEL_MAX);
    }

    /** One line: newlines and tabs become spaces, runs of spaces one, and the rest of {@link #hidden} goes. */
    static String clean(String raw, boolean keepLines) {
        StringBuilder out = new StringBuilder(raw.length());
        raw.codePoints().forEach(cp -> {
            if (cp == '\n' || cp == '\r' || cp == '\t' || cp == 0x2028 || cp == 0x2029 || cp == 0x0085) {
                if (keepLines && cp == '\n') {
                    out.append('\n');
                } else if (keepLines && (cp == 0x2028 || cp == 0x2029)) {
                    out.append('\n');
                } else if (cp != '\r' || !keepLines) {
                    out.append(' ');
                }
                return;
            }
            if (hidden(cp)) {
                return;
            }
            out.appendCodePoint(Character.isSpaceChar(cp) ? ' ' : cp);
        });
        String s = out.toString();
        s = keepLines ? s.replaceAll("[ ]{2,}", " ").replaceAll("\n{3,}", "\n\n") : s.replaceAll(" {2,}", " ");
        return s;
    }

    /** Controls, format characters (bidi, zero-width, tags), private use, unassigned, surrogates and noncharacters. */
    static boolean hidden(int cp) {
        int type = Character.getType(cp);
        return type == Character.CONTROL || type == Character.FORMAT || type == Character.PRIVATE_USE
                || type == Character.UNASSIGNED || type == Character.SURROGATE
                || (cp >= 0xFDD0 && cp <= 0xFDEF) || (cp & 0xFFFE) == 0xFFFE
                || cp == 0x115F || cp == 0x1160 || cp == 0x3164 || cp == 0xFFA0;
    }

    static String cut(String s, int max) {
        if (s.codePointCount(0, s.length()) <= max) {
            return s;
        }
        return s.substring(0, s.offsetByCodePoints(0, max - 1)).strip() + "…";
    }

    /**
     * The normalised title (VISION §1): NFKC, lower case, punctuation and stop words out, words in order, one space
     * apart. A word with a digit keeps its digits and letters ({@code #1043} is {@code 1043}, {@code $1,850} is
     * {@code 1850}), so different invoices and amounts never read the same.
     */
    public static String normalised(String title) {
        return String.join(" ", words(title));
    }

    /** The normalised title's words, in order, without repeats. */
    public static Set<String> words(String title) {
        Set<String> out = new LinkedHashSet<>();
        if (title == null) {
            return out;
        }
        String s = Normalizer.normalize(title, Normalizer.Form.NFKC).toLowerCase(Locale.ROOT);
        s = s.replaceAll("[’']s\\b", "");
        for (String raw : s.split("[^\\p{L}\\p{N}$#.,'’-]+")) {
            String w = raw.replaceAll("[^\\p{L}\\p{N}]", "");
            if (w.isEmpty() || STOP.contains(w)) {
                continue;
            }
            out.add(w);
        }
        return out;
    }

    /** Token Jaccard of two normalised titles' words: 1 for two empty ones. */
    public static double jaccard(Set<String> a, Set<String> b) {
        if (a.isEmpty() && b.isEmpty()) {
            return 1;
        }
        int both = 0;
        for (String w : a) {
            if (b.contains(w)) {
                both++;
            }
        }
        return (double) both / (a.size() + b.size() - both);
    }

    /** Hex SHA-256 of UTF-8 text. */
    public static String sha256(String text) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
