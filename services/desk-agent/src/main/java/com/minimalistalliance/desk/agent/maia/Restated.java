package com.minimalistalliance.desk.agent.maia;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Desk Maia's restatement guard: what a later step of her run writes, less what she has already said in that run.
 *
 * <p><b>Why.</b> A run of hers is several model calls when she uses a tool. Each call's words are added to her one reply, so a
 * call after a tool that writes her whole answer again shows it twice (the owner's first real use, Nov 15: two welcomes in
 * one reply, the turn's and the step's). Her instructions ask her not to, and her choices end the run outright
 * ({@code MaiaProfile}'s {@code endsRun}); this is the code backstop for every other tool.
 *
 * <p><b>The rule.</b> Words are compared as lowercase word stems of three or more letters, less a few very common words.
 * Each sentence of the step that she already said word for word, or that is almost entirely ({@link #SENTENCE} or more,
 * three stems at least) made of her earlier words, is dropped. If what's left is still mostly ({@link #WHOLE} or more)
 * her earlier words, a paraphrase of what she said, it's dropped too; otherwise it's kept as written. Only ever words she wrote herself are compared, never the
 * member's, and nothing is kept.
 */
public final class Restated {

    /** A step this much made of earlier words is dropped whole. */
    static final double WHOLE = 0.6;
    /** A sentence this much made of earlier words is dropped. */
    static final double SENTENCE = 0.85;
    /**
     * Fewer stems than this and what's left is never dropped as a paraphrase: a short line after a tool, or one changed
     * figure, is news; the paraphrase rule is for a reply written again.
     */
    static final int MIN_WHOLE = 8;
    static final int MIN_SENTENCE = 3;

    private static final Pattern WORD = Pattern.compile("[\\p{L}\\p{N}][\\p{L}\\p{N}'’-]*");
    private static final Pattern SENTENCE_END = Pattern.compile("(?<=[.!?…])\\s+|\\n+");
    private static final Set<String> COMMON = Set.of("the", "and", "for", "but", "are", "was", "were", "with", "that",
            "this", "you", "your", "yours", "have", "has", "can", "will", "its", "from", "into", "our", "they", "them",
            "then", "than", "there", "here", "i'm", "i'll", "i've", "you're", "you'll", "it's", "all", "any");
    /** Short words that change what a sentence says: always compared (Security's MV-L1). */
    private static final Set<String> MEANING = Set.of("no", "not", "nor", "yes", "up", "off", "on", "in", "out");

    private Restated() {}

    /**
     * What's new in {@code next} after {@code earlier} (her words so far in this run): {@code next} unchanged when it says
     * something new, empty when it says it all again, or {@code next} less its sentences she has already said.
     */
    public static String fresh(String earlier, String next) {
        if (next == null || next.isBlank() || earlier == null || earlier.isBlank()) {
            return next == null ? "" : next;
        }
        Set<String> said = stems(earlier);
        Set<String> saidSentences = new java.util.HashSet<>();
        for (String sentence : SENTENCE_END.split(earlier.strip())) {
            String n = normal(sentence);
            if (!n.isEmpty()) {
                saidSentences.add(n);
            }
        }
        // Sentence by sentence: one she said word for word, or one made almost entirely of her earlier words, goes.
        List<String> kept = new ArrayList<>();
        boolean dropped = false;
        for (String sentence : SENTENCE_END.split(next.strip())) {
            Set<String> s = stems(sentence);
            if (saidSentences.contains(normal(sentence))
                    || s.size() >= MIN_SENTENCE && share(s, said) >= SENTENCE) {
                dropped = true;
                continue;
            }
            if (!sentence.isBlank()) {
                kept.add(sentence.strip());
            }
        }
        String rest = dropped ? String.join(" ", kept).strip() : next;
        // What's left, taken whole: mostly her earlier words in other order or other words (a paraphrase) says nothing new.
        Set<String> left = stems(rest);
        if (left.size() >= MIN_WHOLE && share(left, said) >= WHOLE) {
            return "";
        }
        return rest;
    }

    /**
     * The line that starts her longer part (the owner, Nov 15: a short reply, and only rarely a longer part that stays
     * folded until the member opens it). The room shows what's before it and folds what's after it under "More".
     */
    public static final String MORE = "<more>";
    private static final String MORE_END = "</more>";

    /**
     * Her reply with its longer part, if any, kept to what's new: the longer part continues from the short reply and
     * never says it again, so its sentences the short reply already said go (and a longer part with nothing new goes
     * whole, marker and all). Text with no marker comes back unchanged.
     */
    public static String withMore(String text) {
        if (text == null) {
            return "";
        }
        int at = text.indexOf(MORE);
        if (at < 0) {
            return text;
        }
        String brief = text.substring(0, at).strip();
        String more = text.substring(at + MORE.length()).replace(MORE_END, "").replace(MORE, "").strip();
        String fresh = brief.isEmpty() ? more : fresh(brief, more);
        if (brief.isEmpty()) {
            // Nothing short to unfold from: the longer part is the reply.
            return fresh;
        }
        return fresh.isBlank() ? brief : brief + "\n\n" + MORE + "\n" + fresh;
    }

    /** A sentence for comparing word for word: lowercase letters and digits only, single spaces. */
    static String normal(String sentence) {
        return sentence.toLowerCase(Locale.ROOT).replace('’', '\'').replaceAll("[^\\p{L}\\p{N}']+", " ").strip();
    }

    /** The share of {@code words} already in {@code said}. */
    static double share(Set<String> words, Set<String> said) {
        if (words.isEmpty()) {
            return 0;
        }
        int in = 0;
        for (String w : words) {
            if (said.contains(w)) {
                in++;
            }
        }
        return (double) in / words.size();
    }

    /** The distinct stems of a text's words of three letters or more, less the most common ones. */
    static Set<String> stems(String text) {
        Set<String> out = new LinkedHashSet<>();
        Matcher m = WORD.matcher(text.toLowerCase(Locale.ROOT).replace('’', '\''));
        while (m.find()) {
            String w = m.group();
            // A number of any length, and a short word that changes the meaning, count (Security's MV-L1): "2 left" and
            // "no laptops" aren't what "12 left" and "laptops" said.
            boolean kept = w.chars().anyMatch(Character::isDigit) || MEANING.contains(w);
            if (!kept && (w.length() < 3 || COMMON.contains(w))) {
                continue;
            }
            out.add(stem(w));
        }
        return out;
    }

    /** A rough stem: a possessive and a few endings off, so "switched" and "switch", "desks" and "desk" match. */
    static String stem(String w) {
        String s = w.endsWith("'s") ? w.substring(0, w.length() - 2) : w;
        for (String end : new String[] {"ing", "ed", "es", "s"}) {
            if (s.length() - end.length() >= 3 && s.endsWith(end)) {
                return s.substring(0, s.length() - end.length());
            }
        }
        return s;
    }
}
