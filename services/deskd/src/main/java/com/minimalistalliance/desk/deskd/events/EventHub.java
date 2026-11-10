package com.minimalistalliance.desk.deskd.events;

import com.minimalistalliance.desk.deskd.protocol.FrameKind;
import com.minimalistalliance.desk.deskd.protocol.Json;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.function.Predicate;

/**
 * Publishes events to every subscribed session (design 4.2.8: deskd fans events out to all of a
 * desk's sessions). The payload is encoded once, however many sessions take it. Publishing never
 * blocks: slow sessions fall behind on their own.
 */
public final class EventHub {

    private final TopicRegistry topics;
    private final List<SessionEvents> sessions = new CopyOnWriteArrayList<>();

    public EventHub(TopicRegistry topics) {
        this.topics = topics;
    }

    public TopicRegistry topics() {
        return topics;
    }

    /**
     * @param type the event's type, such as patch; snapshot and resync are deskd's own
     * @param data a Map, List, String, Number, Boolean or null
     * @throws IllegalArgumentException if the event is over 64 KiB, which is a bug in the publisher
     */
    public void publish(String topicKey, String type, Object data) {
        byte[] payload = encode(type, data);
        if (payload.length > FrameKind.EVT.maxMessageBytes()) {
            throw new IllegalArgumentException("event over 64 KiB");
        }
        for (SessionEvents session : sessions) {
            session.deliver(topicKey, payload);
        }
    }

    /**
     * True if any attached session is subscribed to this topic now. A subscription kept for a resume
     * doesn't count until the client asks for it again.
     */
    public boolean hasSubscribers(String topicKey) {
        for (SessionEvents session : sessions) {
            if (session.isSubscribed(topicKey)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Ends every session's subscriptions to these topics, each with an {@code error} event carrying this code, for a reason
     * that isn't one session's token. A topic's {@link Topic#authorize} must already refuse them, so none comes back.
     */
    public void endTopics(Predicate<String> topicKey, String code) {
        for (SessionEvents session : sessions) {
            session.endTopics(topicKey, code);
        }
    }

    /** The subscription state of a new session. {@link #release} ends it. */
    public SessionEvents newSession() {
        SessionEvents session = new SessionEvents(topics);
        sessions.add(session);
        return session;
    }

    public void release(SessionEvents session) {
        sessions.remove(session);
        session.close();
    }

    static byte[] encode(String type, Object data) {
        Map<String, Object> event = new LinkedHashMap<>();
        event.put("type", type);
        event.put("data", data);
        return Json.bytes(event);
    }
}
