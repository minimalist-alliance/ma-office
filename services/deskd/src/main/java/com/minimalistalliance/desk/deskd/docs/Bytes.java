package com.minimalistalliance.desk.deskd.docs;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Locale;

/** Small helpers on bytes: SHA-256, the type a document's bytes say it is (never its name), and the sandbox's kind. */
final class Bytes {

    private Bytes() {}

    static String sha256(byte[] b) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(b));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /** {@code pdf image docx xlsx pptx text other}, from the bytes; the name only splits Office's three zip kinds. */
    static String type(byte[] head, String name) {
        if (head == null || head.length == 0) {
            return "other";
        }
        if (starts(head, "%PDF-")) {
            return "pdf";
        }
        if (starts(head, new byte[] {(byte) 0x89, 'P', 'N', 'G'}) || starts(head, new byte[] {(byte) 0xFF, (byte) 0xD8, (byte) 0xFF})
                || starts(head, "GIF87a") || starts(head, "GIF89a") || starts(head, "BM")) {
            return head.length > 2 && head[0] == 'B' && head[1] == 'M' && head.length < 26 ? "other" : "image";
        }
        if (executable(head)) {
            return "other";
        }
        if (starts(head, new byte[] {'P', 'K', 3, 4})) {
            String n = name == null ? "" : name.toLowerCase(Locale.ROOT);
            String body = new String(head, 0, Math.min(head.length, 8192), StandardCharsets.ISO_8859_1);
            if (n.endsWith(".docx") || body.contains("word/")) {
                return n.endsWith(".docm") ? "other" : "docx";
            }
            if (n.endsWith(".xlsx") || body.contains("xl/")) {
                return n.endsWith(".xlsm") ? "other" : "xlsx";
            }
            if (n.endsWith(".pptx") || body.contains("ppt/")) {
                return n.endsWith(".pptm") ? "other" : "pptx";
            }
            return "other";
        }
        return text(head) ? "text" : "other";
    }

    /** What deskd's executable sniff calls a program: ELF, PE, Mach-O, a script's #!. */
    static boolean executable(byte[] h) {
        return starts(h, new byte[] {0x7F, 'E', 'L', 'F'}) || starts(h, "MZ") || starts(h, "#!")
                || starts(h, new byte[] {(byte) 0xCF, (byte) 0xFA, (byte) 0xED, (byte) 0xFE})
                || starts(h, new byte[] {(byte) 0xFE, (byte) 0xED, (byte) 0xFA, (byte) 0xCF})
                || starts(h, new byte[] {(byte) 0xCA, (byte) 0xFE, (byte) 0xBA, (byte) 0xBE});
    }

    /** UTF-8 with no NUL and few controls in the head: text, Markdown, CSV. HTML and SVG are a danger, never text. */
    static boolean text(byte[] h) {
        int n = Math.min(h.length, 8192);
        int controls = 0;
        for (int i = 0; i < n; i++) {
            int b = h[i] & 0xFF;
            if (b == 0) {
                return false;
            }
            if (b < 0x20 && b != '\n' && b != '\r' && b != '\t' && b != 0x0C) {
                controls++;
            }
        }
        if (controls > n / 50) {
            return false;
        }
        String s = new String(h, 0, n, StandardCharsets.UTF_8).toLowerCase(Locale.ROOT).stripLeading();
        return !(s.startsWith("<!doctype html") || s.startsWith("<html") || s.startsWith("<svg") || s.startsWith("<?xml")
                && s.contains("<svg") || s.contains("<script"));
    }

    /** A danger word deskd gives a file in Files by its bytes and name, as Courier's words; null for none. */
    static String danger(byte[] head, String name) {
        if (head != null && executable(head)) {
            return head.length > 1 && head[0] == '#' && head[1] == '!' ? "script" : "program";
        }
        String n = name == null ? "" : name.toLowerCase(Locale.ROOT).replaceAll("[\\s.]+$", "");
        String ext = n.contains(".") ? n.substring(n.lastIndexOf('.') + 1) : "";
        return switch (ext) {
            case "exe", "msi", "dll", "com", "scr", "apk", "jar", "app", "pkg", "deb", "rpm", "elf", "bin", "run" -> "program";
            case "sh", "bash", "zsh", "ps1", "psm1", "bat", "cmd", "vbs", "vbe", "js", "jse", "wsf", "py", "pl", "rb", "php", "command" -> "script";
            case "docm", "xlsm", "pptm", "dotm", "xltm", "potm", "xlam" -> "macros";
            case "lnk", "url", "webloc", "desktop", "scf" -> "shortcut";
            case "iso", "img", "dmg", "vhd", "vhdx", "vmdk" -> "disk_image";
            case "html", "htm", "xhtml", "svg", "svgz", "mht", "mhtml", "hta" -> "html";
            case "rar", "7z", "cab", "tgz", "tbz2", "txz" -> "archive_unread";
            default -> null;
        };
    }

    private static boolean starts(byte[] h, String s) {
        return starts(h, s.getBytes(StandardCharsets.ISO_8859_1));
    }

    private static boolean starts(byte[] h, byte[] p) {
        if (h.length < p.length) {
            return false;
        }
        for (int i = 0; i < p.length; i++) {
            if (h[i] != p[i]) {
                return false;
            }
        }
        return true;
    }
}
