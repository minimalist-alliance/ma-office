package com.minimalistalliance.desk.agent.provider;

import java.security.SecureRandom;
import java.util.Arrays;
import java.util.Objects;

/**
 * One file the member attached to a message, ready for a model call (ADR 0049). A file is either read to text on the
 * desk (documents, code, spreadsheets) or kept as image bytes for a model that takes images.
 *
 * <p>It lives in memory for the length of one run, never in the thread, the store, the audit log or a log line: the
 * member's rule is that a file is removed as soon as the model has processed it. {@link #wipe} is that removal: it
 * zeroes the image bytes and drops the text, and the run calls it on every way out, success, failure or stop.
 *
 * <p>Its content is the member's file, so it's data and never an instruction: adapters put it only inside a delimited
 * block that the standing notice in {@link ChatRequest} explains.
 */
public final class Attachment {

    /** What the model gets: the file read to text, or the picture itself. */
    public enum Kind { TEXT, IMAGE }

    private static final SecureRandom RANDOM = new SecureRandom();

    private final Kind kind;
    private final String name;
    private final String type;
    private final String mime;
    private final long size;
    private final String note;
    private final String fence;
    private final long imageTokens;
    private volatile String text;
    private volatile byte[] image;

    private Attachment(Kind kind, String name, String type, String mime, long size, String note, String text,
            byte[] image, long imageTokens) {
        this.kind = Objects.requireNonNull(kind);
        this.name = Objects.requireNonNull(name);
        this.type = Objects.requireNonNull(type);
        this.mime = mime;
        this.size = size;
        this.note = note;
        this.text = text;
        this.image = image;
        this.imageTokens = imageTokens;
        // A boundary the file can't have known, so it can't close its own block and carry on as the member's words.
        byte[] random = new byte[8];
        RANDOM.nextBytes(random);
        StringBuilder hex = new StringBuilder();
        for (byte b : random) {
            hex.append(String.format("%02x", b));
        }
        this.fence = hex.toString();
    }

    /** A file read to text. {@code note} is for the member ("cut at 120000 characters"), or null. */
    public static Attachment text(String name, String type, long size, String text, String note) {
        return new Attachment(Kind.TEXT, name, type, null, size, note, text, null, 0);
    }

    /** A picture, sent as image input. {@code imageTokens} is the reserve against the limits. */
    public static Attachment image(String name, String type, String mime, long size, byte[] bytes, long imageTokens) {
        return new Attachment(Kind.IMAGE, name, type, mime, size, null, null, bytes, imageTokens);
    }

    public Kind kind() {
        return kind;
    }

    public String name() {
        return name;
    }

    /** A word for the member: {@code PDF}, {@code Word}, {@code PNG}. */
    public String type() {
        return type;
    }

    public String mime() {
        return mime;
    }

    /** The file's size in bytes, as the member attached it. */
    public long size() {
        return size;
    }

    public String note() {
        return note;
    }

    /** The random boundary of this file's block. */
    public String fence() {
        return fence;
    }

    public long imageTokens() {
        return imageTokens;
    }

    /** The text, or null once wiped. */
    public String text() {
        return text;
    }

    /** The image bytes, or null once wiped. Not a copy: callers must not keep it. */
    public byte[] image() {
        return image;
    }

    public boolean wiped() {
        return text == null && image == null;
    }

    /** The bytes the model call carries for this file, for the input estimate. */
    public long contentBytes() {
        String t = text;
        return t == null ? 0 : t.getBytes(java.nio.charset.StandardCharsets.UTF_8).length;
    }

    /** Removes the file's content from memory, as far as the JVM lets. Safe to call again. */
    public void wipe() {
        byte[] bytes = image;
        image = null;
        text = null;
        if (bytes != null) {
            Arrays.fill(bytes, (byte) 0);
        }
    }

    /** The line the saved thread keeps in place of the file: {@code attached: report.pdf (PDF, 120 KB)}. */
    public String line() {
        return "attached: " + name + " (" + type + ", " + sizeLabel(size) + ")";
    }

    public static String sizeLabel(long bytes) {
        if (bytes < 1024) {
            return bytes + " B";
        }
        if (bytes < 1024 * 1024) {
            return Math.round(bytes / 1024.0) + " KB";
        }
        return String.format(java.util.Locale.ROOT, "%.1f MB", bytes / 1048576.0);
    }

    /** No content in logs or exceptions. */
    @Override
    public String toString() {
        return "Attachment[" + kind + ", " + size + " bytes]";
    }
}
