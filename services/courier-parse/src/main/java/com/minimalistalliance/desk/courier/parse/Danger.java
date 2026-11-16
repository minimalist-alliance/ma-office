package com.minimalistalliance.desk.courier.parse;

import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/**
 * The types that can't be previewed and are named as such (the launch plan §2.8 and §3.3): nothing on a desk opens or runs
 * an attachment, and the member is told plainly what a dangerous one is. Decided by the name's real extension (with
 * hidden characters, trailing dots and spaces removed, as Windows reads it) and by the bytes themselves, never by the
 * type the sender claimed alone. The words, most dangerous first:
 * <ul>
 * <li>{@code program}: Windows, Linux and Mac executables, installers, Java and Android packages;</li>
 * <li>{@code script}: anything an interpreter runs (JavaScript, VBScript, PowerShell, batch, shell, HTA);</li>
 * <li>{@code macros}: an Office file that carries macros;</li>
 * <li>{@code shortcut}: a shortcut or link file that runs or opens something else;</li>
 * <li>{@code disk_image}: a disk image, which mounts and can hold programs past the warnings above;</li>
 * <li>{@code archive_programs}: an archive that contains any of the above, read without unpacking;</li>
 * <li>{@code html}: a web page or SVG, which runs scripts where it's opened;</li>
 * <li>{@code archive_unread}: an archive whose list couldn't be read (RAR, 7-Zip, compressed tar, a ZIP too large to
 *     list), so nobody can say it holds no program.</li>
 * </ul>
 */
final class Danger {

    private Danger() {}

    static final String PROGRAM = "program";
    static final String SCRIPT = "script";
    static final String MACROS = "macros";
    static final String SHORTCUT = "shortcut";
    static final String DISK_IMAGE = "disk_image";
    static final String ARCHIVE_PROGRAMS = "archive_programs";
    static final String HTML = "html";
    static final String ARCHIVE_UNREAD = "archive_unread";

    private static final String[] ORDER = {PROGRAM, SCRIPT, MACROS, SHORTCUT, DISK_IMAGE, ARCHIVE_PROGRAMS, HTML, ARCHIVE_UNREAD};

    private static final Map<String, String> EXTENSIONS = extensions();

    private static Map<String, String> extensions() {
        java.util.HashMap<String, String> m = new java.util.HashMap<>();
        for (String e : ("exe com scr pif msi msp mst msix msixbundle appx appxbundle dll cpl sys drv ocx gadget xll xla "
                + "application jar apk aab xapk ipa deb rpm run bin elf so dylib app pkg mpkg command action workflow vbe "
                + "msc ade adp mde accde accdr cer crt der reg inf scf chm hlp lib one onepkg jnlp appinstaller xbap "
                + "msh msh1 msh2 mshxml msh1xml msh2xml").split(" ")) {
            m.put(e, PROGRAM);
        }
        for (String e : ("js jse mjs cjs vbs vb wsf wsh ws wsc ps1 psm1 psd1 ps1xml ps2 ps2xml psc1 psc2 bat cmd sh bash zsh "
                + "csh ksh fish py pyw pyc pyo pl pm rb php phar hta applescript scpt scptd lua tcl jsx sct").split(" ")) {
            m.put(e, SCRIPT);
        }
        for (String e : "docm dotm xlsm xltm xlam pptm potm ppam ppsm sldm xlsb iqy slk xla xlm".split(" ")) {
            m.put(e, MACROS);
        }
        for (String e : ("lnk url website webloc inetloc fileloc desktop library-ms searchconnector-ms settingcontent-ms "
                + "appref-ms glk theme themepack").split(" ")) {
            m.put(e, SHORTCUT);
        }
        for (String e : "iso img vhd vhdx vmdk dmg udf toast sparseimage sparsebundle cue nrg".split(" ")) {
            m.put(e, DISK_IMAGE);
        }
        for (String e : "html htm xhtml xht shtml mht mhtml svg svgz xml xsl xslt".split(" ")) {
            m.put(e, HTML);
        }
        for (String e : "rar 7z cab ace arj lzh lha gz tgz bz2 tbz tbz2 xz txz zst tzst z lz lzma sit sitx zipx".split(" ")) {
            m.put(e, ARCHIVE_UNREAD);
        }
        return Map.copyOf(m);
    }

    private static final Set<String> PROGRAM_TYPES = Set.of("application/x-msdownload", "application/x-msdos-program",
            "application/x-dosexec", "application/x-executable", "application/x-sharedlib", "application/x-mach-binary",
            "application/vnd.microsoft.portable-executable", "application/java-archive", "application/x-java-archive",
            "application/vnd.android.package-archive", "application/x-ms-installer", "application/x-msi",
            "application/x-ms-shortcut");
    private static final Set<String> SCRIPT_TYPES = Set.of("application/javascript", "text/javascript", "application/x-javascript",
            "application/ecmascript", "text/vbscript", "application/hta", "application/x-sh", "application/x-shellscript",
            "application/x-bat", "application/x-powershell");
    private static final Set<String> HTML_TYPES = Set.of("text/html", "application/xhtml+xml", "image/svg+xml", "text/xml",
            "application/xml");

    /** The extension Windows would act on: hidden characters, trailing dots and spaces gone, lowercase; "" if none. */
    static String extension(String name) {
        if (name == null) {
            return "";
        }
        StringBuilder clean = new StringBuilder(name.length());
        name.codePoints().filter(c -> Character.getType(c) != Character.FORMAT && !Character.isISOControl(c))
                .forEach(clean::appendCodePoint);
        String n = clean.toString();
        int slash = Math.max(n.lastIndexOf('/'), n.lastIndexOf('\\'));
        n = n.substring(slash + 1).replaceAll("[. ]+$", "");
        int dot = n.lastIndexOf('.');
        return dot < 0 ? "" : n.substring(dot + 1).toLowerCase(Locale.ROOT);
    }

    /** The danger a name alone implies, or null. */
    static String byName(String name) {
        return EXTENSIONS.get(extension(name));
    }

    static String worst(String a, String b) {
        if (a == null) {
            return b;
        }
        if (b == null) {
            return a;
        }
        for (String d : ORDER) {
            if (d.equals(a) || d.equals(b)) {
                return d;
            }
        }
        return a;
    }

    private static final byte[] VBA = "_VBA_PROJECT".getBytes(StandardCharsets.UTF_16LE);
    private static final byte[] VBA_ZIP = "vbaProject.bin".getBytes(StandardCharsets.US_ASCII);

    /**
     * Reads an attachment's decoded bytes as they stream past, holding its first 64 KiB and last 1 MiB, and says what
     * it is at the end. One per attachment; nothing it holds outlives it.
     */
    static final class Sniffer {
        private static final int HEAD = 64 * 1024;

        private final byte[] head = new byte[HEAD];
        private int headFilled;
        private byte[] tail;
        private int tailAt;
        private long size;
        private boolean vba;
        private final byte[] carry = new byte[VBA.length - 1];
        private int carryFilled;
        private Archives.Tar tar;
        private boolean tarDecided;
        private long tarFed;
        private final boolean listing;

        /** @param listing whether the tail is kept for a ZIP's list even when the head doesn't say ZIP yet */
        Sniffer(boolean listing) {
            this.listing = listing;
        }

        void write(byte[] b, int off, int len) {
            if (len <= 0) {
                return;
            }
            if (headFilled < HEAD) {
                int n = Math.min(len, HEAD - headFilled);
                System.arraycopy(b, off, head, headFilled, n);
                headFilled += n;
            }
            if (!tarDecided && headFilled >= 512) {
                tarDecided = true;
                if (Archives.Tar.looksLike(head)) {
                    tar = new Archives.Tar();
                    tar.write(head, 0, headFilled);
                    tarFed = headFilled;
                }
            }
            if (tar != null && size + len > tarFed) {
                int skip = (int) (tarFed - size);
                tar.write(b, off + skip, len - skip);
                tarFed = size + len;
            }
            keepTail(b, off, len);
            size += len;
            scanVba(b, off, len);
        }

        private boolean zipHead() {
            return headFilled >= 2 && head[0] == 'P' && head[1] == 'K';
        }

        /** The last bytes: 1 MiB for a ZIP (its list is at its end), 1 KiB otherwise (a DMG's or VHD's footer). */
        private void keepTail(byte[] b, int off, int len) {
            int want = zipHead() || listing ? Limits.ARCHIVE_TAIL : 1024;
            if (tail == null || tail.length < want) {
                byte[] kept = tail();
                tail = new byte[want];
                System.arraycopy(kept, 0, tail, 0, kept.length);
                tailAt = kept.length % want;
            }
            if (len >= tail.length) {
                System.arraycopy(b, off + len - tail.length, tail, 0, tail.length);
                tailAt = 0;
                return;
            }
            int first = Math.min(len, tail.length - tailAt);
            System.arraycopy(b, off, tail, tailAt, first);
            System.arraycopy(b, off + first, tail, 0, len - first);
            tailAt = (tailAt + len) % tail.length;
        }

        private void scanVba(byte[] b, int off, int len) {
            if (vba || headFilled < 8 || !(head[0] == (byte) 0xD0 && head[1] == (byte) 0xCF && head[2] == 0x11 && head[3] == (byte) 0xE0)) {
                return;
            }
            byte[] window = new byte[carryFilled + len];
            System.arraycopy(carry, 0, window, 0, carryFilled);
            System.arraycopy(b, off, window, carryFilled, len);
            if (indexOf(window, VBA) >= 0) {
                vba = true;
                return;
            }
            int keep = Math.min(carry.length, window.length);
            System.arraycopy(window, window.length - keep, carry, 0, keep);
            carryFilled = keep;
        }

        long size() {
            return size;
        }

        byte[] head() {
            return java.util.Arrays.copyOf(head, headFilled);
        }

        /** The last bytes, in order. */
        byte[] tail() {
            if (tail == null) {
                return new byte[0];
            }
            int n = (int) Math.min(size, tail.length);
            byte[] out = new byte[n];
            int start = (int) ((tailAt - n + (long) tail.length * 2) % tail.length);
            for (int i = 0; i < n; i++) {
                out[i] = tail[(start + i) % tail.length];
            }
            return out;
        }

        /** Its file list, if it's an archive this reads; null otherwise. */
        Archives.Listing listing() {
            if (tar != null) {
                return tar.listing();
            }
            if (headFilled >= 4 && head[0] == 'P' && head[1] == 'K' && (head[2] == 3 || head[2] == 5 || head[2] == 7)) {
                return Archives.zip(tail(), size);
            }
            return null;
        }

        /** What it is, from its name, its claimed type and its bytes; null when it's none of the dangerous kinds. */
        String danger(String name, String type) {
            String d = byName(name);
            String t = type == null ? "" : type.toLowerCase(Locale.ROOT);
            if (PROGRAM_TYPES.contains(t)) {
                d = worst(d, PROGRAM);
            } else if (SCRIPT_TYPES.contains(t)) {
                d = worst(d, SCRIPT);
            } else if (HTML_TYPES.contains(t) && d == null) {
                d = HTML;
            }
            d = worst(d, byBytes());
            Archives.Listing list = listing();
            if (list != null) {
                d = worst(d, byListing(list, name));
            } else if (isZip() || ARCHIVE_UNREAD.equals(byName(name)) && byBytes() == null) {
                d = worst(d, ARCHIVE_UNREAD);
            }
            return d;
        }

        private boolean isZip() {
            return headFilled >= 4 && head[0] == 'P' && head[1] == 'K' && head[2] == 3 && head[3] == 4;
        }

        private String byBytes() {
            byte[] h = head;
            int n = headFilled;
            if (n >= 2 && h[0] == 'M' && h[1] == 'Z') {
                return PROGRAM;
            }
            if (n >= 4 && (h[0] & 0xFF) == 0x7F && h[1] == 'E' && h[2] == 'L' && h[3] == 'F') {
                return PROGRAM;
            }
            if (n >= 4) {
                int m = (h[0] & 0xFF) << 24 | (h[1] & 0xFF) << 16 | (h[2] & 0xFF) << 8 | (h[3] & 0xFF);
                if (m == 0xFEEDFACE || m == 0xFEEDFACF || m == 0xCEFAEDFE || m == 0xCFFAEDFE || m == 0xCAFEBABE) {
                    return PROGRAM;
                }
            }
            if (n >= 2 && h[0] == '#' && h[1] == '!') {
                return SCRIPT;
            }
            if (n >= 8 && h[0] == 0x4C && h[1] == 0 && h[2] == 0 && h[3] == 0 && h[4] == 1 && h[5] == 0x14 && h[6] == 2 && h[7] == 0) {
                return SHORTCUT;
            }
            String start = startText(h, n);
            if (start.startsWith("[internetshortcut]") || start.startsWith("[desktop entry]")) {
                return SHORTCUT;
            }
            if (vba) {
                return MACROS;
            }
            if (n >= 32774 && h[32769] == 'C' && h[32770] == 'D' && h[32771] == '0' && h[32772] == '0' && h[32773] == '1') {
                return DISK_IMAGE;
            }
            if (n >= 8 && (startsWith(h, "conectix") || startsWith(h, "vhdxfile") || startsWith(h, "KDMV"))) {
                return DISK_IMAGE;
            }
            byte[] t = tail();
            if (t.length >= 512) {
                int f = t.length - 512;
                if (t[f] == 'k' && t[f + 1] == 'o' && t[f + 2] == 'l' && t[f + 3] == 'y'
                        || new String(t, f, 8, StandardCharsets.ISO_8859_1).equals("conectix")) {
                    return DISK_IMAGE;
                }
            }
            if (start.startsWith("<!doctype html") || start.startsWith("<html") || start.startsWith("<script")
                    || start.startsWith("<svg") || start.startsWith("<body") || start.startsWith("<head") || start.startsWith("<iframe")
                    || start.startsWith("<?xml") && start.contains("<svg")) {
                return HTML;
            }
            if (n >= 6 && (startsWith(h, "Rar!") || (h[0] & 0xFF) == 0x37 && (h[1] & 0xFF) == 0x7A && (h[2] & 0xFF) == 0xBC
                    && (h[3] & 0xFF) == 0xAF || startsWith(h, "MSCF") || (h[0] & 0xFF) == 0x1F && (h[1] & 0xFF) == 0x8B
                    || startsWith(h, "BZh") || (h[0] & 0xFF) == 0xFD && h[1] == '7' && h[2] == 'z' && h[3] == 'X'
                    || (h[0] & 0xFF) == 0x28 && (h[1] & 0xFF) == 0xB5 && (h[2] & 0xFF) == 0x2F && (h[3] & 0xFF) == 0xFD)) {
                return ARCHIVE_UNREAD;
            }
            return null;
        }

        private static boolean startsWith(byte[] h, String s) {
            if (h.length < s.length()) {
                return false;
            }
            for (int i = 0; i < s.length(); i++) {
                if (h[i] != s.charAt(i)) {
                    return false;
                }
            }
            return true;
        }

        private static String startText(byte[] h, int n) {
            int i = 0;
            if (n >= 3 && (h[0] & 0xFF) == 0xEF && (h[1] & 0xFF) == 0xBB && (h[2] & 0xFF) == 0xBF) {
                i = 3;
            }
            while (i < n && i < 1024 && (h[i] == ' ' || h[i] == '\t' || h[i] == '\r' || h[i] == '\n')) {
                i++;
            }
            return new String(h, i, Math.max(0, Math.min(n - i, 256)), StandardCharsets.ISO_8859_1).toLowerCase(Locale.ROOT);
        }
    }

    /** What an archive's list says: programs inside, macros (an Office file's own parts), or a Java or Android package. */
    static String byListing(Archives.Listing list, String archiveName) {
        boolean manifest = false;
        boolean classes = false;
        boolean androidManifest = false;
        boolean dex = false;
        String found = null;
        for (Archives.Entry e : list.entries()) {
            String n = e.name();
            String lower = n.toLowerCase(Locale.ROOT);
            if (lower.endsWith("vbaproject.bin")) {
                found = worst(found, MACROS);
            }
            manifest |= lower.equals("meta-inf/manifest.mf");
            classes |= lower.endsWith(".class");
            androidManifest |= lower.equals("androidmanifest.xml");
            dex |= lower.endsWith(".dex");
            String inner = byName(n);
            if (PROGRAM.equals(inner) || SCRIPT.equals(inner) || SHORTCUT.equals(inner) || DISK_IMAGE.equals(inner)) {
                found = worst(found, ARCHIVE_PROGRAMS);
            }
        }
        if (manifest && classes || androidManifest && dex) {
            found = worst(found, PROGRAM);
        }
        if (list.truncated() && found == null) {
            found = ARCHIVE_UNREAD;
        }
        return found;
    }

    static int indexOf(byte[] hay, byte[] needle) {
        outer:
        for (int i = 0; i + needle.length <= hay.length; i++) {
            for (int j = 0; j < needle.length; j++) {
                if (hay[i + j] != needle[j]) {
                    continue outer;
                }
            }
            return i;
        }
        return -1;
    }

    static boolean containsVbaName(byte[] bytes) {
        return indexOf(bytes, VBA_ZIP) >= 0;
    }
}
