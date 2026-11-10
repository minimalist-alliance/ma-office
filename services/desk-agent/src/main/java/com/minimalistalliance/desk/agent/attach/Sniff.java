package com.minimalistalliance.desk.agent.attach;

import java.util.Locale;
import java.util.Set;

/** What a file is, from its first bytes first and its name second. Never decodes anything. */
public final class Sniff {

    /** What the reader should do with a file. */
    public enum Format {
        IMAGE, PDF, DOCX, XLSX, PPTX, TEXT, LEGACY_OFFICE, OTHER
    }

    /** A recognised file: its format, a word for the member, and for pictures the media type and pixel size. */
    public record Kind(Format format, String label, String mime, int width, int height) {}

    private static final Set<String> TEXT = Set.of(
            "txt", "text", "md", "markdown", "csv", "tsv", "json", "jsonl", "ndjson", "xml", "html", "htm", "css",
            "scss", "yaml", "yml", "toml", "ini", "cfg", "conf", "log", "sql", "sh", "bash", "zsh", "py", "js", "mjs",
            "cjs", "ts", "tsx", "jsx", "java", "kt", "kts", "go", "rs", "c", "h", "cc", "cpp", "hpp", "cs", "rb",
            "php", "swift", "m", "r", "lua", "pl", "scala", "dart", "vue", "svelte", "tex", "rst", "org", "env",
            "gradle", "properties", "diff", "patch", "svg", "tf", "dockerfile", "makefile", "srt", "vtt");

    private Sniff() {}

    /** @return the file's kind, or {@code OTHER} when it is none we read; never null */
    public static Kind of(String name, byte[] bytes) {
        String extension = extension(name);
        if (bytes.length >= 8 && (bytes[0] & 0xFF) == 0x89 && bytes[1] == 'P' && bytes[2] == 'N' && bytes[3] == 'G') {
            return image("PNG", "image/png", bytes);
        }
        if (bytes.length >= 4 && (bytes[0] & 0xFF) == 0xFF && (bytes[1] & 0xFF) == 0xD8 && (bytes[2] & 0xFF) == 0xFF) {
            return image("JPEG", "image/jpeg", bytes);
        }
        if (bytes.length >= 10 && bytes[0] == 'G' && bytes[1] == 'I' && bytes[2] == 'F' && bytes[3] == '8') {
            return image("GIF", "image/gif", bytes);
        }
        if (bytes.length >= 16 && bytes[0] == 'R' && bytes[1] == 'I' && bytes[2] == 'F' && bytes[3] == 'F'
                && bytes[8] == 'W' && bytes[9] == 'E' && bytes[10] == 'B' && bytes[11] == 'P') {
            return image("WebP", "image/webp", bytes);
        }
        if (startsWith(bytes, "%PDF-", 1024)) {
            return new Kind(Format.PDF, "PDF", null, 0, 0);
        }
        if (bytes.length >= 4 && bytes[0] == 'P' && bytes[1] == 'K' && bytes[2] == 3 && bytes[3] == 4) {
            return switch (extension) {
                case "docx" -> new Kind(Format.DOCX, "Word", null, 0, 0);
                case "xlsx" -> new Kind(Format.XLSX, "Excel", null, 0, 0);
                case "pptx" -> new Kind(Format.PPTX, "PowerPoint", null, 0, 0);
                default -> new Kind(Format.OTHER, extension.isEmpty() ? "ZIP" : extension.toUpperCase(Locale.ROOT),
                        null, 0, 0);
            };
        }
        if (bytes.length >= 8 && (bytes[0] & 0xFF) == 0xD0 && (bytes[1] & 0xFF) == 0xCF && (bytes[2] & 0xFF) == 0x11
                && (bytes[3] & 0xFF) == 0xE0) {
            return new Kind(Format.LEGACY_OFFICE, extension.isEmpty() ? "Office" : extension.toUpperCase(Locale.ROOT),
                    null, 0, 0);
        }
        String label = textLabel(extension);
        if (TEXT.contains(extension) || extension.isEmpty() && looksLikeText(bytes)) {
            return new Kind(Format.TEXT, label, null, 0, 0);
        }
        // An unknown extension on a file that reads as plain text is still text.
        if (looksLikeText(bytes)) {
            return new Kind(Format.TEXT, label, null, 0, 0);
        }
        return new Kind(Format.OTHER, extension.isEmpty() ? "file" : extension.toUpperCase(Locale.ROOT), null, 0, 0);
    }

    private static String textLabel(String extension) {
        return switch (extension) {
            case "md", "markdown" -> "Markdown";
            case "csv" -> "CSV";
            case "tsv" -> "TSV";
            case "json", "jsonl", "ndjson" -> "JSON";
            case "txt", "text", "" -> "Text";
            default -> extension.length() <= 10 ? extension.toUpperCase(Locale.ROOT) : "Text";
        };
    }

    static String extension(String name) {
        int dot = name.lastIndexOf('.');
        if (dot < 0 || dot == name.length() - 1) {
            String lower = name.toLowerCase(Locale.ROOT);
            return lower.equals("dockerfile") || lower.equals("makefile") ? lower : "";
        }
        return name.substring(dot + 1).toLowerCase(Locale.ROOT);
    }

    private static boolean startsWith(byte[] bytes, String marker, int within) {
        int last = Math.min(bytes.length, within) - marker.length();
        outer:
        for (int i = 0; i <= last; i++) {
            for (int j = 0; j < marker.length(); j++) {
                if (bytes[i + j] != marker.charAt(j)) {
                    continue outer;
                }
            }
            return true;
        }
        return false;
    }

    /** No NUL in the first 8 KiB (or a UTF-16 mark), and mostly printable. A guess that the reader then checks. */
    static boolean looksLikeText(byte[] bytes) {
        if (bytes.length == 0) {
            return false;
        }
        if (bytes.length >= 2 && ((bytes[0] & 0xFF) == 0xFF && (bytes[1] & 0xFF) == 0xFE
                || (bytes[0] & 0xFF) == 0xFE && (bytes[1] & 0xFF) == 0xFF)) {
            return true;
        }
        int look = Math.min(bytes.length, 8192);
        int odd = 0;
        for (int i = 0; i < look; i++) {
            int b = bytes[i] & 0xFF;
            if (b == 0) {
                return false;
            }
            if (b < 9 || b > 13 && b < 32) {
                odd++;
            }
        }
        return odd * 50 < look;
    }

    // -------------------------------------------------------------- images

    private static Kind image(String label, String mime, byte[] bytes) {
        int[] size = switch (label) {
            case "PNG" -> png(bytes);
            case "JPEG" -> jpeg(bytes);
            case "GIF" -> new int[] {u16le(bytes, 6), u16le(bytes, 8)};
            default -> webp(bytes);
        };
        return new Kind(Format.IMAGE, label, mime, size == null ? 0 : size[0], size == null ? 0 : size[1]);
    }

    private static int[] png(byte[] b) {
        if (b.length < 24 || b[12] != 'I' || b[13] != 'H' || b[14] != 'D' || b[15] != 'R') {
            return null;
        }
        return new int[] {u32be(b, 16), u32be(b, 20)};
    }

    private static int[] jpeg(byte[] b) {
        int i = 2;
        while (i + 9 < b.length) {
            if ((b[i] & 0xFF) != 0xFF) {
                return null;
            }
            int marker = b[i + 1] & 0xFF;
            if (marker == 0xFF) {
                i++;
                continue;
            }
            if (marker == 0xD8 || marker == 0x01 || marker >= 0xD0 && marker <= 0xD7) {
                i += 2;
                continue;
            }
            int length = ((b[i + 2] & 0xFF) << 8) | (b[i + 3] & 0xFF);
            if (marker >= 0xC0 && marker <= 0xCF && marker != 0xC4 && marker != 0xC8 && marker != 0xCC) {
                return new int[] {((b[i + 7] & 0xFF) << 8) | (b[i + 8] & 0xFF), ((b[i + 5] & 0xFF) << 8) | (b[i + 6] & 0xFF)};
            }
            if (length < 2) {
                return null;
            }
            i += 2 + length;
        }
        return null;
    }

    private static int[] webp(byte[] b) {
        if (b.length < 30) {
            return null;
        }
        String chunk = new String(b, 12, 4, java.nio.charset.StandardCharsets.ISO_8859_1);
        switch (chunk) {
            case "VP8 " -> {
                if ((b[23] & 0xFF) != 0x9D || (b[24] & 0xFF) != 0x01 || (b[25] & 0xFF) != 0x2A) {
                    return null;
                }
                return new int[] {u16le(b, 26) & 0x3FFF, u16le(b, 28) & 0x3FFF};
            }
            case "VP8L" -> {
                if ((b[20] & 0xFF) != 0x2F) {
                    return null;
                }
                int bits = (b[21] & 0xFF) | ((b[22] & 0xFF) << 8) | ((b[23] & 0xFF) << 16) | ((b[24] & 0xFF) << 24);
                return new int[] {(bits & 0x3FFF) + 1, ((bits >>> 14) & 0x3FFF) + 1};
            }
            case "VP8X" -> {
                int w = 1 + ((b[24] & 0xFF) | ((b[25] & 0xFF) << 8) | ((b[26] & 0xFF) << 16));
                int h = 1 + ((b[27] & 0xFF) | ((b[28] & 0xFF) << 8) | ((b[29] & 0xFF) << 16));
                return new int[] {w, h};
            }
            default -> {
                return null;
            }
        }
    }

    private static int u16le(byte[] b, int at) {
        return (b[at] & 0xFF) | ((b[at + 1] & 0xFF) << 8);
    }

    private static int u32be(byte[] b, int at) {
        long v = ((long) (b[at] & 0xFF) << 24) | ((b[at + 1] & 0xFF) << 16) | ((b[at + 2] & 0xFF) << 8) | (b[at + 3] & 0xFF);
        return v > Integer.MAX_VALUE ? Integer.MAX_VALUE : (int) v;
    }
}
