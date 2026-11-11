package com.minimalistalliance.desk.agent.team;

import com.minimalistalliance.desk.agent.service.RpcError;
import java.text.Normalizer;
import java.util.Locale;
import java.util.Map;

/**
 * Two checks on text the member or an agent writes ({@code docs/multi-agent.md}, the task 49 fix pass): characters a
 * card can't show, and the key that makes two agent names the same name.
 */
public final class TextChecks {

    private TextChecks() {}

    /**
     * Whether the text holds a character a card shows as nothing, or that turns the text around it: Unicode format
     * characters ({@code Cf}: zero-width spaces and joiners, bidi embeddings, overrides and isolates, tag characters,
     * the soft hyphen), and the Hangul fillers, which are letters that draw nothing. A zero-width joiner between two
     * pictographs is an emoji's own glue, so it stays.
     */
    public static boolean hidden(String text) {
        for (int i = 0; i < text.length(); ) {
            int cp = text.codePointAt(i);
            if (cp == 0x200D ? !joinsEmoji(text, i) : hiddenCodePoint(cp)) {
                return true;
            }
            i += Character.charCount(cp);
        }
        return false;
    }

    private static boolean hiddenCodePoint(int cp) {
        if (Character.getType(cp) == Character.FORMAT) {
            return true;
        }
        return switch (Character.getDirectionality(cp)) {
            case Character.DIRECTIONALITY_LEFT_TO_RIGHT_EMBEDDING, Character.DIRECTIONALITY_RIGHT_TO_LEFT_EMBEDDING,
                    Character.DIRECTIONALITY_LEFT_TO_RIGHT_OVERRIDE, Character.DIRECTIONALITY_RIGHT_TO_LEFT_OVERRIDE,
                    Character.DIRECTIONALITY_POP_DIRECTIONAL_FORMAT, Character.DIRECTIONALITY_LEFT_TO_RIGHT_ISOLATE,
                    Character.DIRECTIONALITY_RIGHT_TO_LEFT_ISOLATE, Character.DIRECTIONALITY_FIRST_STRONG_ISOLATE,
                    Character.DIRECTIONALITY_POP_DIRECTIONAL_ISOLATE -> true;
            default -> cp == 0x115F || cp == 0x1160 || cp == 0x3164 || cp == 0xFFA0;
        };
    }

    /** A joiner at {@code at} with a pictograph before it (a variation selector or skin tone between) and after it. */
    private static boolean joinsEmoji(String text, int at) {
        int before = at;
        int cp = -1;
        while (before > 0) {
            cp = text.codePointBefore(before);
            before -= Character.charCount(cp);
            if (cp != 0xFE0F && !(cp >= 0x1F3FB && cp <= 0x1F3FF)) {
                break;
            }
            cp = -1;
        }
        int after = at + 1;
        return cp >= 0 && Character.isExtendedPictographic(cp) && after < text.length()
                && Character.isExtendedPictographic(text.codePointAt(after));
    }

    /** Refuses hidden characters as {@code bad_request} with this field and {@code reason: "hidden_chars"}. */
    public static void refuseHidden(String text, String field) throws RpcError {
        if (text != null && hidden(text)) {
            throw RpcError.of("bad_request", "detail", field, "reason", "hidden_chars");
        }
    }

    /**
     * Common Cyrillic and Greek letters that read as Latin ones, each case to the Latin letter it reads as, before case
     * folding: Greek capital Nu reads as N, though its small letter reads as v.
     */
    private static final Map<Integer, Character> LOOK_ALIKES = lookAlikes(
            "\u0410A\u0412B\u0415E\u041aK\u041cM\u041dH\u041eO\u0420P\u0421C\u0422T\u0423Y\u0425X\u0406I"
                    + "\u0408J\u0405S\u04c0I\u0430a\u0435e\u0451e\u043eo\u0440p\u0441c\u0443y\u0445x\u0456i"
                    + "\u0457i\u0458j\u0455s\u04bbh\u0501d\u04cfl\u051bq\u051dw\u0391A\u0392B\u0395E\u0396Z"
                    + "\u0397H\u0399I\u039aK\u039cM\u039dN\u039fO\u03a1P\u03a4T\u03a5Y\u03a7X\u03b1a\u03b9i"
                    + "\u03bak\u03bfo\u03c1p\u03c5u\u03c7x\u03bdv\u03c9w");

    private static Map<Integer, Character> lookAlikes(String pairs) {
        Map<Integer, Character> map = new java.util.HashMap<>();
        for (int i = 0; i + 1 < pairs.length(); i += 2) {
            map.put((int) pairs.charAt(i), pairs.charAt(i + 1));
        }
        return Map.copyOf(map);
    }

    /**
     * What makes two names one name: NFKC, format characters removed, Cyrillic and Greek look-alikes as the Latin
     * letters they read as, case folded, runs of spaces as one, trimmed. "Notes", "NOTES", "Nоtes" (a Cyrillic о),
     * "Νotes" (a Greek Nu) and "Ｎotes" all have the key "notes".
     */
    static String nameKey(String name) {
        String text = Normalizer.normalize(name, Normalizer.Form.NFKC);
        StringBuilder latin = new StringBuilder(text.length());
        text.codePoints().filter(cp -> !hiddenCodePoint(cp)).forEach(cp -> {
            Character look = LOOK_ALIKES.get(cp);
            if (look != null) {
                latin.append(look.charValue());
            } else {
                latin.appendCodePoint(cp);
            }
        });
        String folded = latin.toString().toUpperCase(Locale.ROOT).toLowerCase(Locale.ROOT);
        StringBuilder key = new StringBuilder(folded.length());
        boolean space = false;
        for (int i = 0; i < folded.length(); ) {
            int cp = folded.codePointAt(i);
            i += Character.charCount(cp);
            if (Character.isWhitespace(cp) || Character.isSpaceChar(cp)) {
                space = true;
                continue;
            }
            if (space && !key.isEmpty()) {
                key.append(' ');
            }
            space = false;
            key.appendCodePoint(cp);
        }
        return key.toString();
    }
}
