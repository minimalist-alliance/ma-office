package com.minimalistalliance.desk.courier.parse;

import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.Charset;
import java.nio.charset.CharsetDecoder;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Text from bytes in whatever charset a message claims, as mail clients read it: the label through WHATWG-style aliases
 * (ISO-8859-1 and US-ASCII read as windows-1252, GB2312 as GBK, Shift_JIS as windows-31j, KS C 5601 as windows-949), UTF-7
 * by hand (the JDK has none), and a label that's missing or unknown sniffed: a byte order mark, valid UTF-8, then
 * windows-1252, which maps every byte. Bad sequences become U+FFFD; nothing throws.
 */
final class Charsets {

    private Charsets() {}

    static final Charset WINDOWS_1252 = Charset.forName("windows-1252");

    private static final Map<String, String> ALIASES = Map.ofEntries(
            Map.entry("us-ascii", "windows-1252"), Map.entry("ascii", "windows-1252"), Map.entry("ansi_x3.4-1968", "windows-1252"),
            Map.entry("iso-8859-1", "windows-1252"), Map.entry("iso8859-1", "windows-1252"), Map.entry("latin1", "windows-1252"),
            Map.entry("l1", "windows-1252"), Map.entry("cp1252", "windows-1252"), Map.entry("x-user-defined", "windows-1252"),
            Map.entry("utf8", "UTF-8"), Map.entry("unicode-1-1-utf-8", "UTF-8"),
            Map.entry("gb2312", "GBK"), Map.entry("x-gbk", "GBK"), Map.entry("cn-gb", "GBK"), Map.entry("euc-cn", "GBK"),
            Map.entry("shift_jis", "windows-31j"), Map.entry("shift-jis", "windows-31j"), Map.entry("sjis", "windows-31j"),
            Map.entry("x-sjis", "windows-31j"), Map.entry("ms_kanji", "windows-31j"),
            Map.entry("ks_c_5601-1987", "x-windows-949"), Map.entry("ks_c_5601", "x-windows-949"), Map.entry("euc-kr", "x-windows-949"),
            Map.entry("iso-8859-9", "windows-1254"), Map.entry("iso-8859-11", "x-windows-874"), Map.entry("tis-620", "x-windows-874"),
            Map.entry("big5-hkscs", "Big5-HKSCS"), Map.entry("x-mac-roman", "x-MacRoman"), Map.entry("macintosh", "x-MacRoman"),
            Map.entry("unicode", "UTF-16LE"));

    /** The charset a label names, or null for a missing, unknown or unsupported one (UTF-7 is handled in {@link #decode}). */
    static Charset forLabel(String label) {
        if (label == null) {
            return null;
        }
        String l = label.trim().toLowerCase(Locale.ROOT);
        if (l.length() >= 2 && l.charAt(0) == '"' && l.charAt(l.length() - 1) == '"') {
            l = l.substring(1, l.length() - 1).trim();
        }
        if (l.isEmpty() || l.length() > 40) {
            return null;
        }
        String name = ALIASES.getOrDefault(l, l);
        try {
            return Charset.forName(name);
        } catch (RuntimeException e) {
            return null;
        }
    }

    static boolean isUtf7(String label) {
        if (label == null) {
            return false;
        }
        String l = label.trim().toLowerCase(Locale.ROOT).replace("\"", "");
        return l.equals("utf-7") || l.equals("utf7") || l.equals("unicode-1-1-utf-7") || l.equals("x-unicode-2-0-utf-7");
    }

    /** {@code bytes[0..length)} as text in the labelled charset, or sniffed when the label is no use. */
    static String decode(byte[] bytes, int length, String label) {
        if (isUtf7(label)) {
            return Utf7.decode(bytes, length);
        }
        Charset bom = bom(bytes, length);
        if (bom != null) {
            int skip = bom == StandardCharsets.UTF_8 ? 3 : 2;
            return decode(bom, bytes, skip, length - skip);
        }
        Charset c = forLabel(label);
        if (c == null) {
            c = sniff(bytes, length);
        } else if (c.equals(WINDOWS_1252) && validUtf8(bytes, 0, length) && hasHighBytes(bytes, length)) {
            // Labelled ASCII or Latin-1 that is valid UTF-8 with bytes over 0x7F: a mislabel, almost always.
            c = StandardCharsets.UTF_8;
        }
        return decode(c, bytes, 0, length);
    }

    static Charset sniff(byte[] bytes, int length) {
        Charset bom = bom(bytes, length);
        if (bom != null) {
            return bom;
        }
        return validUtf8(bytes, 0, length) ? StandardCharsets.UTF_8 : WINDOWS_1252;
    }

    private static final Pattern META = Pattern.compile(
            "(?i)<meta[^>]{0,200}?charset\\s*=\\s*[\"']?\\s*([A-Za-z0-9._:-]{1,40})");

    /** HTML's own charset, from a {@code <meta>} in its first 2 KiB, or null. */
    static String htmlMeta(byte[] bytes, int length) {
        String head = new String(bytes, 0, Math.min(length, 2048), StandardCharsets.ISO_8859_1);
        Matcher m = META.matcher(head);
        return m.find() ? m.group(1) : null;
    }

    private static Charset bom(byte[] b, int n) {
        if (n >= 3 && (b[0] & 0xFF) == 0xEF && (b[1] & 0xFF) == 0xBB && (b[2] & 0xFF) == 0xBF) {
            return StandardCharsets.UTF_8;
        }
        if (n >= 2 && (b[0] & 0xFF) == 0xFE && (b[1] & 0xFF) == 0xFF) {
            return StandardCharsets.UTF_16BE;
        }
        if (n >= 2 && (b[0] & 0xFF) == 0xFF && (b[1] & 0xFF) == 0xFE) {
            return StandardCharsets.UTF_16LE;
        }
        return null;
    }

    private static boolean hasHighBytes(byte[] b, int n) {
        for (int i = 0; i < n; i++) {
            if (b[i] < 0) {
                return true;
            }
        }
        return false;
    }

    static boolean validUtf8(byte[] b, int from, int length) {
        CharsetDecoder d = StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT);
        try {
            d.decode(ByteBuffer.wrap(b, from, length));
            return true;
        } catch (CharacterCodingException e) {
            return false;
        }
    }

    static String decode(Charset c, byte[] b, int from, int length) {
        CharsetDecoder d = c.newDecoder()
                .onMalformedInput(CodingErrorAction.REPLACE).onUnmappableCharacter(CodingErrorAction.REPLACE);
        try {
            CharBuffer out = d.decode(ByteBuffer.wrap(b, from, length));
            return out.toString();
        } catch (CharacterCodingException | RuntimeException e) {
            return new String(b, from, length, WINDOWS_1252);
        }
    }

    /** UTF-7 (RFC 2152), which the JDK lacks. Malformed shifts end where they break; nothing throws. */
    static final class Utf7 {
        private Utf7() {}

        private static final String B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

        static String decode(byte[] b, int length) {
            StringBuilder out = new StringBuilder(length);
            int i = 0;
            while (i < length) {
                int c = b[i] & 0xFF;
                if (c != '+') {
                    out.append(c < 0x80 ? (char) c : '\uFFFD');
                    i++;
                    continue;
                }
                i++;
                if (i < length && b[i] == '-') {
                    out.append('+');
                    i++;
                    continue;
                }
                int bits = 0;
                int nbits = 0;
                char high = 0;
                while (i < length) {
                    int v = B64.indexOf(b[i] & 0xFF);
                    if ((b[i] & 0xFF) >= 0x80 || v < 0) {
                        break;
                    }
                    bits = (bits << 6) | v;
                    nbits += 6;
                    if (nbits >= 16) {
                        nbits -= 16;
                        char ch = (char) ((bits >> nbits) & 0xFFFF);
                        if (Character.isHighSurrogate(ch)) {
                            high = ch;
                        } else if (Character.isLowSurrogate(ch) && high != 0) {
                            out.append(high).append(ch);
                            high = 0;
                        } else {
                            out.append(ch);
                            high = 0;
                        }
                    }
                    i++;
                }
                if (i < length && b[i] == '-') {
                    i++;
                }
            }
            return out.toString();
        }
    }
}
