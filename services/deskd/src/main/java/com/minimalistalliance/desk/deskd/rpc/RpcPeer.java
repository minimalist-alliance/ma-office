package com.minimalistalliance.desk.deskd.rpc;

import com.minimalistalliance.desk.deskd.protocol.FrameKind;

/** One session, as the RPC layer sees it. */
public interface RpcPeer {

    /** True once HELLO is done. Requests before that are refused. */
    boolean ready();

    RpcPrincipal principal();

    /** SUB and UNSUB go here. */
    SubscriptionService subscriptions();

    /**
     * Sends one message on the rpc channel, fragmented as needed, parking while the channel is out
     * of credit.
     *
     * @throws PeerGoneException if the session has ended
     */
    void send(FrameKind kind, long id, byte[] payload) throws InterruptedException, PeerGoneException;

    /** The client keeps ignoring rate_limited, so the session closes with 4429. */
    void closeRateLimited();

    /** The session ended while a reply was on its way. */
    final class PeerGoneException extends Exception {
        private static final long serialVersionUID = 1L;

        public PeerGoneException() {
            super("session gone", null, false, false);
        }
    }
}
