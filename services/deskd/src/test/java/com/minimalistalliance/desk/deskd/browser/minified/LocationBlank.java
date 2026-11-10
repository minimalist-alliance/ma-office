package com.minimalistalliance.desk.deskd.browser.minified;

import java.util.regex.Pattern;

/**
 * Blanks where the machine running the harness is, as real sites show it: a store or delivery town, a "Town, ST", a ZIP.
 * The real-site harnesses write their outputs through this, so no output, and nothing copied from one into git, carries
 * a location. A generic rule, never a list of places: such a list would itself say where the machine is. It blanks more
 * than it must (any "Town, ST" in an article goes too), which the scores don't notice.
 */
public final class LocationBlank {

    private static final String BLOCK = "▇▇▇";
    private static final String STATES = "A[LKZR]|C[AOT]|D[EC]|FL|GA|HI|I[DLNA]|K[SY]|LA|M[EDAINSOT]|N[EVHJMYCD]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[TA]|W[AVIY]";
    /** Whatever follows a phrase that says where the visitor is: "Delivering to …", "In stock in …". */
    private static final Pattern LED = Pattern.compile("((?i:deliver(?:ing)? to|ship(?:ping|s)? to|your (?:location|store|zip)|my store"
            + "|(?:in|out of) stock (?:in|at)|not sold (?:in|at)|available (?:in|at|near)|pick ?up (?:in|at)|stores? near|near you in"
            + "|weather (?:in|for)|forecast for)) ([A-Z0-9][\\w.'-]*(?:,? [A-Z0-9][\\w.'-]*){0,3})");
    /** Whatever a site says it took from where the visitor is: "… - From your IP address". */
    private static final Pattern FROM_IP = Pattern.compile("[^\"\\\\]{0,80}(?i:from your (?:ip address|ip|location))");
    /** A town and its state, with or without a ZIP, and the area before them: "Area, Town, ST". */
    private static final Pattern PLACE = Pattern.compile("\\b(?:[A-Z][a-z]+(?: [A-Z][a-z]+){0,3}, ){0,2}[A-Z][a-z]+(?: [A-Z][a-z]+){0,2}, (?:"
            + STATES + ")(?: \\d{5}(?:-\\d{4})?)?\\b");
    /** A ZIP after a word. */
    private static final Pattern ZIP = Pattern.compile("\\b[A-Z][a-z]+ \\d{5}(?:-\\d{4})?\\b");
    /** A ZIP on its own, as a label or a run: a JSON string that is five digits and nothing else. */
    private static final Pattern BARE_ZIP = Pattern.compile("\"\\d{5}(?:-\\d{4})?\"");

    private LocationBlank() {}

    /** The text with every place blanked. Safe on JSON text: nothing it writes is a quote or a backslash. */
    public static String blank(String text) {
        String out = LED.matcher(text).replaceAll("$1 " + BLOCK);
        out = FROM_IP.matcher(out).replaceAll(BLOCK + " - from the visitor's location");
        out = PLACE.matcher(out).replaceAll(BLOCK + ", ▇▇");
        out = BARE_ZIP.matcher(out).replaceAll("\"" + BLOCK + "▇▇\"");
        return ZIP.matcher(out).replaceAll(BLOCK + " " + BLOCK + "▇▇");
    }

    /** JSON bytes with every place blanked. */
    public static byte[] blank(byte[] json) {
        return blank(new String(json, java.nio.charset.StandardCharsets.UTF_8)).getBytes(java.nio.charset.StandardCharsets.UTF_8);
    }

    /** Blanks the outputs already written: {@code LocationBlank <dir>...}, each JSON file rewritten in place. */
    public static void main(String[] args) throws java.io.IOException {
        for (String dir : args) {
            try (var files = java.nio.file.Files.list(java.nio.file.Path.of(dir))) {
                for (java.nio.file.Path file : files.filter(f -> f.toString().endsWith(".json")).toList()) {
                    byte[] before = java.nio.file.Files.readAllBytes(file);
                    byte[] after = blank(before);
                    if (!java.util.Arrays.equals(before, after)) {
                        java.nio.file.Files.write(file, after);
                    }
                }
            }
        }
    }
}
