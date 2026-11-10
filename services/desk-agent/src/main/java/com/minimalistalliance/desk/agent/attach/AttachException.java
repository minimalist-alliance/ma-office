package com.minimalistalliance.desk.agent.attach;

/**
 * Why a file can't be attached or read. {@code reason} is a word the client turns into a sentence; {@code name} is the
 * file's (already cleaned) name, or null when it's about the whole message. Carries no file content.
 */
public final class AttachException extends Exception {

    private static final long serialVersionUID = 1L;

    private final String reason;
    private final String name;
    private final Long limit;

    public AttachException(String reason, String name, Long limit) {
        super(reason, null, false, false);
        this.reason = reason;
        this.name = name;
        this.limit = limit;
    }

    public AttachException(String reason, String name) {
        this(reason, name, null);
    }

    /**
     * One of: {@code too_many}, {@code too_large}, {@code total_too_large}, {@code unsupported_type},
     * {@code legacy_office}, {@code binary}, {@code empty}, {@code encrypted}, {@code no_text}, {@code unreadable},
     * {@code too_complex}, {@code timeout}, {@code busy}, {@code image_too_big}, {@code no_vision}, {@code missing},
     * {@code bad_upload}, {@code staging_full}.
     */
    public String reason() {
        return reason;
    }

    public String name() {
        return name;
    }

    /** The cap that was passed, in bytes, characters or files, when there is one. */
    public Long limit() {
        return limit;
    }
}
