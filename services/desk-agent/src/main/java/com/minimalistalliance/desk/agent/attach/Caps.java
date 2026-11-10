package com.minimalistalliance.desk.agent.attach;

import com.minimalistalliance.desk.agent.json.Json;
import com.minimalistalliance.desk.agent.json.JsonFormatException;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * The limits on attaching files, a desk setting the owner can change within fixed ceilings (ADR 0049). The defaults
 * are sized for desk-agent's small heap: a file is held in memory from the upload to the end of the run.
 *
 * @param maxFiles files on one message
 * @param maxFileBytes one file, any kind but a picture
 * @param maxImageBytes one picture, which is what every provider takes
 * @param maxTotalBytes all the files of one message
 * @param maxFileChars the text read from one file; the rest is cut and the member is told
 * @param maxTotalChars the text read from all the files of one message
 * @param maxPdfPages the pages of a PDF that are read
 */
public record Caps(int maxFiles, long maxFileBytes, long maxImageBytes, long maxTotalBytes, int maxFileChars,
        int maxTotalChars, int maxPdfPages) {

    /** What the owner can raise each limit to. */
    private static final int MAX_FILES = 10;
    private static final long MAX_FILE_BYTES = 20L << 20;
    private static final long MAX_IMAGE_BYTES = 5L << 20;
    private static final long MAX_TOTAL_BYTES = 30L << 20;
    private static final int MAX_FILE_CHARS = 400_000;
    private static final int MAX_TOTAL_CHARS = 800_000;
    private static final int MAX_PDF_PAGES = 400;

    public static final Caps DEFAULT = new Caps(5, 8L << 20, 5L << 20, 12L << 20, 100_000, 200_000, 100);
    public static final Caps CEILING = new Caps(MAX_FILES, MAX_FILE_BYTES, MAX_IMAGE_BYTES, MAX_TOTAL_BYTES,
            MAX_FILE_CHARS, MAX_TOTAL_CHARS, MAX_PDF_PAGES);
    public static final String SETTING = "attach.caps";

    public Caps {
        if (maxFiles < 1 || maxFileBytes < 1024 || maxImageBytes < 1024 || maxTotalBytes < 1024 || maxFileChars < 1000
                || maxTotalChars < 1000 || maxPdfPages < 1) {
            throw new IllegalArgumentException("caps too small");
        }
        if (maxFiles > MAX_FILES || maxFileBytes > MAX_FILE_BYTES || maxImageBytes > MAX_IMAGE_BYTES
                || maxTotalBytes > MAX_TOTAL_BYTES || maxFileChars > MAX_FILE_CHARS || maxTotalChars > MAX_TOTAL_CHARS
                || maxPdfPages > MAX_PDF_PAGES) {
            throw new IllegalArgumentException("caps too large");
        }
    }

    /** The caps from stored JSON, or the defaults for nothing or anything unusable. */
    public static Caps parse(String json) {
        if (json == null) {
            return DEFAULT;
        }
        try {
            return from(Json.parseObject(json.getBytes(StandardCharsets.UTF_8)), DEFAULT);
        } catch (JsonFormatException | IllegalArgumentException e) {
            return DEFAULT;
        }
    }

    /**
     * {@code base} with the fields of {@code p} that it names.
     *
     * @throws IllegalArgumentException if a field isn't a whole number in range
     */
    public static Caps from(Map<String, Object> p, Caps base) {
        return new Caps(
                (int) number(p, "maxFiles", base.maxFiles()),
                number(p, "maxFileBytes", base.maxFileBytes()),
                number(p, "maxImageBytes", base.maxImageBytes()),
                number(p, "maxTotalBytes", base.maxTotalBytes()),
                (int) number(p, "maxFileChars", base.maxFileChars()),
                (int) number(p, "maxTotalChars", base.maxTotalChars()),
                (int) number(p, "maxPdfPages", base.maxPdfPages()));
    }

    private static long number(Map<String, Object> p, String name, long fallback) {
        Object value = p.get(name);
        if (value == null) {
            return fallback;
        }
        if (value instanceof Number n && n.doubleValue() == Math.rint(n.doubleValue())
                && Math.abs(n.doubleValue()) < 1e12) {
            return n.longValue();
        }
        throw new IllegalArgumentException(name);
    }

    public Map<String, Object> toMap() {
        Map<String, Object> map = new LinkedHashMap<>();
        map.put("maxFiles", maxFiles);
        map.put("maxFileBytes", maxFileBytes);
        map.put("maxImageBytes", maxImageBytes);
        map.put("maxTotalBytes", maxTotalBytes);
        map.put("maxFileChars", maxFileChars);
        map.put("maxTotalChars", maxTotalChars);
        map.put("maxPdfPages", maxPdfPages);
        return map;
    }
}
