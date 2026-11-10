package com.minimalistalliance.desk.agent.attach;

/**
 * How many bytes of pictures may be with model calls at once, across every agent on the desk (ADR 0049). A picture
 * costs about four times its size in desk-agent's heap while its request is built (base64, then JSON, then the send), so
 * without this two members' messages that each fit the caps could still end the process with an out-of-memory error.
 * The limit is a constant, not a setting: it is a fact about the heap, and the owner's caps can't raise it.
 */
public final class ImageBudget {

    /** The most picture bytes in one message, and in all messages at once. */
    public static final long LIMIT = 12L << 20;

    private long held;

    /** Takes {@code bytes} if they fit alongside what's held. */
    public synchronized boolean tryClaim(long bytes) {
        if (bytes < 0 || held + bytes > LIMIT) {
            return false;
        }
        held += bytes;
        return true;
    }

    public synchronized void release(long bytes) {
        held = Math.max(0, held - bytes);
    }

    public synchronized long held() {
        return held;
    }
}
