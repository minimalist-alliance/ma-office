package com.minimalistalliance.desk.deskd.events;

import com.minimalistalliance.desk.deskd.rpc.RpcException;
import com.minimalistalliance.desk.deskd.rpc.RpcPrincipal;
import java.util.Map;

/**
 * One subscription topic, or a family of them such as {@code agent.run:<id>}. Topics are registered
 * by name in code, in {@link TopicRegistry}.
 */
public interface Topic {

    /**
     * What {@link #snapshot} returns when there's no state to send yet. The subscription stays open
     * with nothing sent, and its first event is whatever the topic publishes next, so publish a whole
     * snapshot then.
     */
    Object NO_SNAPSHOT = new Object();

    /**
     * True if a fresh snapshot can stand in for any deltas the client missed (summary, lists, trees).
     * False for streams where every event matters (agent runs, chat): those get {@code resync}, and
     * the client replays from history.
     */
    boolean coalescible();

    /**
     * The topic's current state. Runs on its own virtual thread, so it may block.
     *
     * @param topicKey the full topic string, including any {@code :<id>}
     * @return a Map, List, String, Number, Boolean or null, or {@link #NO_SNAPSHOT}
     */
    Object snapshot(String topicKey, Map<String, Object> params) throws Exception;

    /**
     * True if this topic publishes whether or not anyone is attached, so that a client back with the
     * {@code seq} it last saw has missed nothing. A coalescible topic that only keeps up while someone is
     * subscribed says false, and then every SUB gets a snapshot.
     */
    default boolean publishesWithNoSubscriber() {
        return true;
    }

    /**
     * Runs with the session's subscription state locked, so it must not block: at SUB, and again when a
     * token refresh changes what the session may do.
     *
     * @throws RpcException to refuse the subscription, usually with forbidden
     */
    default void authorize(RpcPrincipal principal, String topicKey, Map<String, Object> params)
            throws RpcException {}

    /**
     * Who is subscribed to this topic may have just changed: a SUB, an UNSUB, a session detaching or ending, or a
     * refresh ending a subscription. {@link EventHub#hasSubscribers} has the answer. It runs on the thread that made
     * the change, outside the session's lock, and must not block: a topic that has work to do starts a thread.
     */
    default void subscribersChanged() {}

    /**
     * True if a guild member may subscribe (API.md section 14). Every other topic is the owner's: a guild member's SUB
     * gets {@code forbidden} with {@code reason: scope} before {@link #authorize}, as an export session's does.
     */
    default boolean forGuildMembers() {
        return false;
    }

    /**
     * The key the subscription is kept, published and snapshotted under. A topic whose events differ by who's asking, as
     * a guild member's agents do, gives each caller its own key, which no client ever sees: it has only its {@code subId}.
     * It must not change for a principal across a refresh, which keeps the person. The default is the client's key.
     */
    default String keyFor(RpcPrincipal principal, String topicKey) {
        return topicKey;
    }
}
