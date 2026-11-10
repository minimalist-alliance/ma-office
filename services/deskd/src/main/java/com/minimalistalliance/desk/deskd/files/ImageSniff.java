package com.minimalistalliance.desk.deskd.files;

import java.nio.charset.StandardCharsets;

/**
 * Whether a file is an image, decided by its first bytes and never by its name (files.md sections 2 and 6): the
 * formats are jpeg, png, gif, webp, heic, heif, avif, bmp, tiff and svg. Archives and documents (a PDF with pictures
 * inside) are "other" and pass the gate unchecked.
 */
final class ImageSniff {

    /** How much of a file is looked at. */
    static final int HEAD_BYTES = 4096;

    private ImageSniff() {}

    /** @return the format name, or null for anything that is not an image */
    static String format(byte[] head, int length) {
        int n = Math.min(length, head.length);
        if (n >= 3 && u(head, 0) == 0xFF && u(head, 1) == 0xD8 && u(head, 2) == 0xFF) {
            return "jpeg";
        }
        if (n >= 8 && u(head, 0) == 0x89 && head[1] == 'P' && head[2] == 'N' && head[3] == 'G'
                && u(head, 4) == 0x0D && u(head, 5) == 0x0A && u(head, 6) == 0x1A && u(head, 7) == 0x0A) {
            return "png";
        }
        if (n >= 6 && head[0] == 'G' && head[1] == 'I' && head[2] == 'F' && head[3] == '8'
                && (head[4] == '7' || head[4] == '9') && head[5] == 'a') {
            return "gif";
        }
        if (n >= 12 && head[0] == 'R' && head[1] == 'I' && head[2] == 'F' && head[3] == 'F'
                && head[8] == 'W' && head[9] == 'E' && head[10] == 'B' && head[11] == 'P') {
            return "webp";
        }
        if (n >= 4 && ((head[0] == 'I' && head[1] == 'I' && head[2] == 0x2A && head[3] == 0)
                || (head[0] == 'M' && head[1] == 'M' && head[2] == 0 && head[3] == 0x2A)
                || (head[0] == 'I' && head[1] == 'I' && head[2] == 0x2B && head[3] == 0)
                || (head[0] == 'M' && head[1] == 'M' && head[2] == 0 && head[3] == 0x2B))) {
            return "tiff";
        }
        if (isBmp(head, n)) {
            return "bmp";
        }
        String isobmff = isoBase(head, n);
        if (isobmff != null) {
            return isobmff;
        }
        return isSvg(head, n) ? "svg" : null;
    }

    private static int u(byte[] b, int i) {
        return b[i] & 0xFF;
    }

    /** "BM", the two reserved fields zero, and a DIB header size that is one of the real ones. */
    private static boolean isBmp(byte[] b, int n) {
        if (n < 18 || b[0] != 'B' || b[1] != 'M' || b[6] != 0 || b[7] != 0 || b[8] != 0 || b[9] != 0) {
            return false;
        }
        long dib = (u(b, 14)) | (u(b, 15) << 8) | (u(b, 16) << 16) | ((long) u(b, 17) << 24);
        return dib == 12 || dib == 40 || dib == 52 || dib == 56 || dib == 64 || dib == 108 || dib == 124;
    }

    /** An ISO base media file: the {@code ftyp} box, whose brands say heic, heif or avif. */
    private static String isoBase(byte[] b, int n) {
        if (n < 12 || b[4] != 'f' || b[5] != 't' || b[6] != 'y' || b[7] != 'p') {
            return null;
        }
        long boxSize = ((long) u(b, 0) << 24) | (u(b, 1) << 16) | (u(b, 2) << 8) | u(b, 3);
        int end = (int) Math.min(n, boxSize < 16 ? n : boxSize);
        String major = new String(b, 8, 4, StandardCharsets.ISO_8859_1);
        String kind = brand(major);
        // The major brand may be the generic mif1 or msf1; the compatible brands then tell which.
        for (int i = 16; kind == null || kind.equals("heif") ? i + 4 <= end : false; i += 4) {
            String found = brand(new String(b, i, 4, StandardCharsets.ISO_8859_1));
            if (found != null && !found.equals("heif")) {
                return found;
            }
        }
        return kind;
    }

    private static String brand(String brand) {
        return switch (brand) {
            case "avif", "avis" -> "avif";
            case "heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs" -> "heic";
            case "mif1", "msf1" -> "heif";
            default -> null;
        };
    }

    /** The root element is {@code svg} (or {@code x:svg}), after a BOM, whitespace, an XML prolog, comments and a doctype. */
    private static boolean isSvg(byte[] b, int n) {
        String s = new String(b, 0, n, StandardCharsets.UTF_8);
        int i = 0;
        if (!s.isEmpty() && s.charAt(0) == '﻿') {
            i = 1;
        }
        while (i < s.length()) {
            while (i < s.length() && Character.isWhitespace(s.charAt(i))) {
                i++;
            }
            if (s.startsWith("<?", i)) {
                int close = s.indexOf("?>", i + 2);
                if (close < 0) {
                    return false;
                }
                i = close + 2;
            } else if (s.startsWith("<!--", i)) {
                int close = s.indexOf("-->", i + 4);
                if (close < 0) {
                    return false;
                }
                i = close + 3;
            } else if (s.startsWith("<!DOCTYPE", i) || s.startsWith("<!doctype", i)) {
                i = endOfDoctype(s, i);
                if (i < 0) {
                    return false;
                }
            } else if (s.startsWith("<", i)) {
                int j = i + 1;
                int start = j;
                while (j < s.length() && (Character.isLetterOrDigit(s.charAt(j)) || ":_-.".indexOf(s.charAt(j)) >= 0)) {
                    j++;
                }
                String name = s.substring(start, j);
                boolean ends = j < s.length() && (Character.isWhitespace(s.charAt(j)) || s.charAt(j) == '>' || s.charAt(j) == '/');
                return ends && (name.equals("svg") || name.endsWith(":svg"));
            } else {
                return false;
            }
        }
        return false;
    }

    /** Past a DOCTYPE, with its internal subset in brackets if it has one. -1 if it runs off the head. */
    private static int endOfDoctype(String s, int from) {
        int depth = 0;
        for (int i = from; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '[') {
                depth++;
            } else if (c == ']') {
                depth--;
            } else if (c == '>' && depth <= 0) {
                return i + 1;
            }
        }
        return -1;
    }
}
