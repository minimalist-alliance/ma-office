package com.minimalistalliance.desk.agent.tool;

/**
 * What a tool's result adds to its run (draft ADR, section 6). A run's flags are set by the declarations' {@code taints}
 * and never cleared while it runs.
 */
public enum Taint {
    /** Untrusted content read: a page, a file from Files, an attachment, another agent's message, guild Notebook text. */
    U,
    /** The member's private data read: Files, Notebook, the member's signed-in pages. */
    S
}
