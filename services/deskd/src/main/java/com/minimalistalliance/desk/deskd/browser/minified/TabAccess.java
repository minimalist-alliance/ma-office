package com.minimalistalliance.desk.deskd.browser.minified;

import com.minimalistalliance.desk.deskd.rpc.RpcException;
import java.time.Duration;
import java.util.Map;
import java.util.function.BooleanSupplier;

/**
 * What the simplified view may do with the Browser's tabs: the Browser module gives it this and nothing more. A command
 * goes only to a tab the Browser lists, on deskd's own session to it, or to a frame's session that Chromium attached
 * under one of those. Every script it carries is one of {@link Scripts}' constants.
 */
public interface TabAccess {

    /**
     * The member's tab, with a session to it.
     *
     * @param tabId null for the tab on screen, which is never a guess
     * @throws RpcException not_found or unavailable, as the Browser's own methods say them (API.md section 10)
     */
    TabRef resolve(String tabId) throws RpcException, InterruptedException;

    /** One command on the tab's session. A session that went is replaced once, which takes deskd's scripts with it. */
    Map<String, Object> call(TabRef tab, String method, Map<String, Object> params, Duration timeout)
            throws CdpFailure, InterruptedException;

    /**
     * As {@link #call}, for a reply with one long string in it, such as an image's bytes: up to
     * {@code maxStringChars} in place of the usual cut.
     */
    Map<String, Object> callLong(TabRef tab, String method, Map<String, Object> params, Duration timeout)
            throws CdpFailure, InterruptedException;

    /** One command on a frame's session that Chromium attached under one of the member's tabs. */
    Map<String, Object> callSession(String sessionId, String method, Map<String, Object> params, Duration timeout)
            throws CdpFailure, InterruptedException;

    /** Whether this tab was the one on screen when last looked. */
    boolean isActive(String tabId);

    /**
     * Starts telling these of events. Call once, before anything can happen.
     *
     * @param wanted while true, the Browser keeps its connection to Chromium up, as it does for a subscriber of its own
     */
    void listen(TabEvents events, BooleanSupplier wanted);

    /** The connection may be wanted now: never blocks. */
    void wake();

    /**
     * Work on Chromium, from here until it's closed: a client's call, or an action. Holds off a freeze of Chromium (ADR
     * 0045) and thaws one first. A watcher's parked wait for a change isn't work, and never comes through here.
     */
    AutoCloseable use() throws InterruptedException;

    /** Chromium is frozen, or may be (ADR 0045): nothing is to ask it anything, or ask for a thaw. */
    boolean frozen();

    /**
     * A frame in a process of its own was attached under a tab, held at its start: what the tab's owner must do first,
     * before deskd's guard goes in and the frame runs. The Agent's tabs stop the frame's document requests there, as
     * their own (S-14). Must not throw for a frame that's gone.
     *
     * @return whether the frame may run: false leaves it held at its start, never let go, so it never loads
     */
    default boolean frameAttached(String sessionId) throws InterruptedException {
        return true;
    }

    /**
     * Whether a tab keeps its frames' attach when the view leaves it: the Agent's do, so a frame born later is still held
     * and its requests stopped (S-14). The member's don't, so their stream is as it was.
     */
    default boolean keepsFrameAttach() {
        return false;
    }
}
