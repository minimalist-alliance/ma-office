package com.minimalistalliance.desk.deskd.session;

import com.minimalistalliance.desk.deskd.protocol.Message;

/**
 * Takes the messages of a channel whose content deskd's core doesn't read: collab, mdoc and bulk.
 * Calls for one (session, channel) come one at a time, on that channel's own virtual thread. A slow
 * handler holds up only that channel, and only for that session; its credit isn't granted until it
 * returns, so the sender slows down.
 */
@FunctionalInterface
public interface ChannelHandler {

    void onMessage(Session session, Message message) throws InterruptedException;
}
