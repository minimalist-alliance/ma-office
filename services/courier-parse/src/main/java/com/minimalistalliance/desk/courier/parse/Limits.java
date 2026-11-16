package com.minimalistalliance.desk.courier.parse;

/**
 * The Courier mode's limits (the launch plan §3.1, draft ADR "Courier's store" §4). Over any of them a message is refused
 * with a reason, never half read: the member sees "This message couldn't be read safely", with the raw download.
 */
public final class Limits {

    private Limits() {}

    /** The raw message: 40 MiB. */
    public static final int MAX_BYTES = 40 << 20;
    /** MIME entities: the message, each multipart and each leaf. */
    public static final int MAX_PARTS = 2000;
    /** Multiparts inside one another, the message's own counted as the first. */
    public static final int MAX_DEPTH = 20;
    /** A parse, from the worker's start to its answer. */
    public static final long PARSE_MILLIS = 10_000;

    /** The text the store keeps ({@code ParsedMessage.MAX_TEXT}); past it the answer says {@code textTruncated}. */
    public static final int MAX_TEXT_CHARS = 2 * 1024 * 1024;
    /** Decoded bytes of one text body read before its charset is applied; past it the rest is counted, not kept. */
    public static final int MAX_TEXT_BYTES = 6 << 20;
    /** HTML read into a tree: past it the HTML is left out (the text stays). The tree costs about ten times its size. */
    public static final int MAX_HTML_IN_CHARS = 2 * 1024 * 1024;
    /** Sanitized HTML handed over ({@code ParsedMessage.MAX_HTML}). */
    public static final int MAX_HTML_OUT_CHARS = 4 * 1024 * 1024;
    /** Elements the sanitizer keeps; past it the HTML is left out. */
    public static final int MAX_ELEMENTS = 100_000;
    /** How deep the sanitized tree goes; deeper elements are unwrapped into their parent. */
    public static final int MAX_HTML_DEPTH = 100;
    /** Addresses in one list ({@code ParsedMessage.MAX_ADDRESSES}). */
    public static final int MAX_ADDRESSES = 500;
    /** Characters of one header's text kept (References can be long; deskd keeps the root and the newest). */
    public static final int MAX_HEADER_CHARS = 64 * 1024;

    /** A part handed back whole ({@code courier1 part}): the member downloads the raw message past it. */
    public static final int MAX_PART_BYTES = 25 << 20;
    /** An image to re-encode, as bytes. */
    public static final int MAX_IMAGE_BYTES = 20 << 20;
    /** An image's own size, before any pixel is decoded. */
    public static final int MAX_IMAGE_SIDE = 30_000;
    public static final long MAX_IMAGE_PIXELS = 50_000_000L;
    /** A progressive JPEG holds every coefficient in native memory while it decodes. */
    public static final long MAX_PROGRESSIVE_PIXELS = 12_000_000L;
    /** The longest side a re-encoded image has. */
    public static final int PREVIEW_SIDE = 2048;
    /** A re-encoded image's bytes. */
    public static final int MAX_IMAGE_OUT = 8 << 20;
    /** A data: image inside HTML: its bytes, and all of a message's together. */
    public static final int MAX_INLINE_IMAGE_BYTES = 2 << 20;
    public static final int MAX_INLINE_IMAGES_BYTES = 6 << 20;
    public static final int INLINE_IMAGE_SIDE = 1600;

    /** The end of a part kept for an archive's central directory. */
    public static final int ARCHIVE_TAIL = 1 << 20;
    /** Entries listed for one archive. */
    public static final int MAX_ARCHIVE_ENTRIES = 10_000;
}
