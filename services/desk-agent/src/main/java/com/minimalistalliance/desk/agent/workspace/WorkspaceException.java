package com.minimalistalliance.desk.agent.workspace;

import java.util.Locale;

/** A workspace call that was refused. Carries a reason and never a path or any file content. */
public final class WorkspaceException extends Exception {

    private static final long serialVersionUID = 1L;

    public enum Reason {
        /** The path breaks the rules, or leads through or onto a link, or the agent id is not valid. */
        PATH,
        /** Nothing there. */
        NOT_FOUND,
        /** The write would take the workspace over its quota. */
        QUOTA,
        /** The file is not UTF-8 text (or the text to write has a NUL or a lone surrogate). */
        NOT_TEXT,
        /** One write is over 1 MiB. */
        TOO_LARGE,
        /** The disk is short of free space. */
        DISK_FULL,
        /** The workspace already has 10,000 files. */
        TOO_MANY_FILES,
        /** The workspace already has 2,000 folders. */
        TOO_MANY_FOLDERS;

        /** The word the wire uses, such as {@code not_found}. */
        public String wireName() {
            return name().toLowerCase(Locale.ROOT);
        }
    }

    private final Reason reason;

    public WorkspaceException(Reason reason) {
        super(reason.wireName(), null, false, false);
        this.reason = reason;
    }

    public Reason reason() {
        return reason;
    }
}
